//! Platform independent backend state and event fan-out.
//!
//! The service deliberately contains no transport or file I/O.  A native
//! adapter and the Web Worker both run the transfer engine and publish only
//! metadata here.  Keeping this lock limited to state updates prevents a
//! slow file operation from blocking cancellation or UI resubscription.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use web_time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::channel::mpsc::{channel, Receiver, Sender};
use serde::{Deserialize, Serialize};

use crate::{AppEvent, AppSnapshot, SessionState};
use tailsend_transport_api::TransportPath;

const DEFAULT_EVENT_QUEUE: usize = 64;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

/// Metadata delivered to a UI or another platform adapter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendSnapshot {
    pub api_version: u16,
    pub sequence: u64,
    pub app: AppSnapshot,
}

impl Default for BackendSnapshot {
    fn default() -> Self {
        Self {
            api_version: 1,
            sequence: 0,
            app: AppSnapshot::default(),
        }
    }
}

/// An ordered event.  A subscriber can discard events up to the sequence
/// contained in its last snapshot and then apply only newer events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendEvent {
    pub sequence: u64,
    pub event: AppEvent,
}

/// A cursor outside the retained window must be replaced by a new snapshot.
#[derive(Debug, Clone)]
pub struct EventHistoryGap {
    pub snapshot: BackendSnapshot,
}

#[derive(Debug, Clone)]
struct QueuedProgress {
    event: AppEvent,
    last_published: Instant,
}

struct ServiceState {
    snapshot: BackendSnapshot,
    subscribers: Vec<Sender<BackendEvent>>,
    progress: HashMap<[u8; 16], QueuedProgress>,
    cancellation: HashMap<[u8; 16], Arc<AtomicBool>>,
    /// Retain terminal events for a short resubscription window.  The queue
    /// is metadata only and is intentionally bounded.
    recent: VecDeque<BackendEvent>,
}

/// Thread-safe state/event service shared by native and WASM adapters.
#[derive(Clone)]
pub struct BackendService {
    inner: Arc<Mutex<ServiceState>>,
    queue_limit: usize,
}

/// Public name used by the Tauri and Web Worker adapters.  Keeping the
/// implementation in `BackendService` makes it possible to construct the
/// same service in native and WASM builds without adding a second state
/// machine.
pub type PonletBackend = BackendService;

impl Default for BackendService {
    fn default() -> Self {
        Self::new(DEFAULT_EVENT_QUEUE)
    }
}

impl BackendService {
    pub fn new(queue_limit: usize) -> Self {
        let queue_limit = queue_limit.max(1);
        Self {
            inner: Arc::new(Mutex::new(ServiceState {
                snapshot: BackendSnapshot::default(),
                subscribers: Vec::new(),
                progress: HashMap::new(),
                cancellation: HashMap::new(),
                recent: VecDeque::with_capacity(queue_limit),
            })),
            queue_limit,
        }
    }

    /// Return a consistent snapshot without waiting for any I/O operation.
    pub fn snapshot(&self) -> BackendSnapshot {
        let mut inner = self.inner.lock().expect("backend state mutex poisoned");
        refresh_invite_expiry(&mut inner.snapshot.app);
        inner.snapshot.clone()
    }

    /// Subscribe before taking a snapshot, then ignore events up to its
    /// sequence. Prefer `subscribe_with_snapshot` to perform both atomically.
    pub fn subscribe(&self) -> Receiver<BackendEvent> {
        let (tx, rx) = channel(self.queue_limit);
        self.inner
            .lock()
            .expect("backend state mutex poisoned")
            .subscribers
            .push(tx);
        rx
    }

    pub fn subscribe_with_snapshot(&self) -> (BackendSnapshot, Receiver<BackendEvent>) {
        let (tx, rx) = channel(self.queue_limit);
        let mut inner = self.inner.lock().expect("backend state mutex poisoned");
        inner.subscribers.push(tx);
        refresh_invite_expiry(&mut inner.snapshot.app);
        (inner.snapshot.clone(), rx)
    }

    /// Apply a state transition and publish it immediately.
    pub fn set_state(&self, state: SessionState) -> BackendEvent {
        self.emit(AppEvent::StateChanged(state))
    }

    /// Publish a non-progress event.  Terminal events are never coalesced.
    pub fn emit(&self, event: AppEvent) -> BackendEvent {
        let mut inner = self.inner.lock().expect("backend state mutex poisoned");
        if let AppEvent::TransferCompleted { transfer_id }
        | AppEvent::TransferCancelled { transfer_id, .. } = &event
        {
            // Flush under the same lock so no progress can interleave between
            // the last byte count and the terminal event.
            if let Some(queued) = inner.progress.remove(transfer_id) {
                publish_locked(&mut inner, self.queue_limit, queued.event);
            }
            inner.cancellation.remove(transfer_id);
        }
        publish_locked(&mut inner, self.queue_limit, event)
    }

    /// Publish progress at most every 200 ms for each transfer.  The latest
    /// value is retained and can be flushed at a transfer boundary.
    pub fn progress(
        &self,
        transfer_id: [u8; 16],
        bytes_done: u64,
        bytes_total: u64,
    ) -> Option<BackendEvent> {
        let mut inner = self.inner.lock().expect("backend state mutex poisoned");
        let now = Instant::now();
        let event = AppEvent::TransferProgress {
            transfer_id,
            bytes_done,
            bytes_total,
        };
        update_snapshot_progress(&mut inner.snapshot, transfer_id, bytes_done);
        let entry = inner
            .progress
            .entry(transfer_id)
            .or_insert_with(|| QueuedProgress {
                event: event.clone(),
                last_published: now.checked_sub(PROGRESS_INTERVAL).unwrap_or(now),
            });
        entry.event = event;
        if now.duration_since(entry.last_published) < PROGRESS_INTERVAL {
            return None;
        }
        entry.last_published = now;
        let event = entry.event.clone();
        Some(publish_locked(&mut inner, self.queue_limit, event))
    }

    /// Publish the latest progress value before a terminal event.
    pub fn flush_progress(&self, transfer_id: [u8; 16]) -> Option<BackendEvent> {
        let mut inner = self.inner.lock().expect("backend state mutex poisoned");
        let queued = inner.progress.remove(&transfer_id)?;
        if let AppEvent::TransferProgress { bytes_done, .. } = &queued.event {
            update_snapshot_progress(&mut inner.snapshot, transfer_id, *bytes_done);
        }
        Some(publish_locked(&mut inner, self.queue_limit, queued.event))
    }

    /// Create the cancellation token used by a transfer worker.
    pub fn register_transfer(&self, transfer_id: [u8; 16]) -> Arc<AtomicBool> {
        self.inner
            .lock()
            .expect("backend state mutex poisoned")
            .cancellation
            .entry(transfer_id)
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    /// Request cancellation without entering the transfer I/O lock.
    pub fn cancel(&self, transfer_id: [u8; 16]) -> bool {
        self.inner
            .lock()
            .expect("backend state mutex poisoned")
            .cancellation
            .get(&transfer_id)
            .map(|token| {
                token.store(true, Ordering::Release);
                true
            })
            .unwrap_or(false)
    }

    pub fn is_cancelled(&self, transfer_id: [u8; 16]) -> bool {
        self.inner
            .lock()
            .expect("backend state mutex poisoned")
            .cancellation
            .get(&transfer_id)
            .map(|token| token.load(Ordering::Acquire))
            .unwrap_or(false)
    }

    pub fn finish_transfer(&self, transfer_id: [u8; 16]) {
        let mut inner = self.inner.lock().expect("backend state mutex poisoned");
        inner.cancellation.remove(&transfer_id);
        inner.progress.remove(&transfer_id);
    }

    /// Return a contiguous replay, or explicitly require a snapshot refresh.
    pub fn events_since(&self, sequence: u64) -> Result<Vec<BackendEvent>, EventHistoryGap> {
        let mut inner = self.inner.lock().expect("backend state mutex poisoned");
        let oldest = inner
            .recent
            .front()
            .map(|event| event.sequence)
            .unwrap_or(1);
        if sequence > inner.snapshot.sequence || sequence < oldest.saturating_sub(1) {
            refresh_invite_expiry(&mut inner.snapshot.app);
            return Err(EventHistoryGap {
                snapshot: inner.snapshot.clone(),
            });
        }
        Ok(inner
            .recent
            .iter()
            .filter(|event| event.sequence > sequence)
            .cloned()
            .collect())
    }
}

fn refresh_capabilities(snapshot: &mut AppSnapshot, state: &SessionState) {
    let previous_transport_path = snapshot.transport_path;
    snapshot.can_send = false;
    snapshot.can_disconnect = false;
    snapshot.pending_offer = None;
    snapshot.invite_qr_url = None;
    snapshot.invite_expires_in_secs = 0;
    snapshot.transport_path = match state {
        SessionState::ConnectedIdle { transport_path, .. } => *transport_path,
        SessionState::Transferring { .. } => previous_transport_path,
        _ => TransportPath::Unknown,
    };
    match state {
        SessionState::AwaitingPeer { invite_url, .. } => {
            snapshot.invite_qr_url = Some(invite_url.clone());
            refresh_invite_expiry(snapshot);
            snapshot.can_disconnect = true;
            snapshot.can_send = false;
        }
        SessionState::ConnectedIdle { peer_info, .. } => {
            snapshot.peer_display_name = peer_info.display_name.clone();
            snapshot.can_disconnect = true;
            snapshot.can_send = true;
            snapshot.pending_offer = None;
            snapshot.invite_qr_url = None;
            snapshot.invite_expires_in_secs = 0;
        }
        SessionState::AwaitingUserDecision { offer, .. } => {
            snapshot.pending_offer = Some(offer.clone());
            snapshot.can_disconnect = true;
        }
        SessionState::DialingHost { .. }
        | SessionState::Authenticating
        | SessionState::AwaitingAcceptance { .. }
        | SessionState::Transferring { .. } => {
            snapshot.can_disconnect = true;
        }
        SessionState::Booting | SessionState::Disconnected { .. } | SessionState::Error { .. } => {
            snapshot.peer_display_name.clear();
        }
    }
}

fn refresh_invite_expiry(snapshot: &mut AppSnapshot) {
    if let SessionState::AwaitingPeer { expires_at, .. } = &snapshot.state {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        snapshot.invite_expires_in_secs = expires_at.saturating_sub(now);
    }
}

fn update_snapshot_progress(
    snapshot: &mut BackendSnapshot,
    transfer_id: [u8; 16],
    bytes_done: u64,
) {
    if let SessionState::Transferring {
        transfer_id: active_id,
        bytes_done: active_done,
        ..
    } = &mut snapshot.app.state
    {
        if *active_id == transfer_id {
            *active_done = bytes_done;
        }
    }
}

fn publish_locked(inner: &mut ServiceState, queue_limit: usize, event: AppEvent) -> BackendEvent {
    match &event {
        AppEvent::StateChanged(state) => {
            inner.snapshot.app.state = state.clone();
            refresh_capabilities(&mut inner.snapshot.app, state);
        }
        AppEvent::TransferProgress {
            transfer_id,
            bytes_done,
            ..
        } => {
            update_snapshot_progress(&mut inner.snapshot, *transfer_id, *bytes_done);
        }
        _ => {}
    }
    inner.snapshot.sequence = inner.snapshot.sequence.saturating_add(1);
    let ordered = BackendEvent {
        sequence: inner.snapshot.sequence,
        event,
    };

    inner.recent.push_back(ordered.clone());
    while inner.recent.len() > queue_limit {
        inner.recent.pop_front();
    }

    // A full subscriber is disconnected instead of growing an unbounded
    // queue.  The event remains in `recent`, so the UI can resubscribe from
    // its last sequence (or refresh the full snapshot when its cursor is too
    // old).
    inner
        .subscribers
        .retain_mut(|subscriber| subscriber.try_send(ordered.clone()).is_ok());
    ordered
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;

    #[test]
    fn state_event_has_monotonic_sequence_and_snapshot() {
        let service = BackendService::default();
        let _rx = service.subscribe();
        let state = SessionState::Disconnected {
            reason: "test".to_string(),
        };
        let event = service.set_state(state.clone());
        let snapshot = service.snapshot();
        assert_eq!(event.sequence, 1);
        assert_eq!(snapshot.sequence, 1);
        assert_eq!(snapshot.app.state, state);
    }

    #[test]
    fn cancellation_is_independent_from_event_delivery() {
        let service = BackendService::default();
        let transfer_id = [7u8; 16];
        let token = service.register_transfer(transfer_id);
        assert!(!token.load(Ordering::Acquire));
        assert!(service.cancel(transfer_id));
        assert!(token.load(Ordering::Acquire));
        service.finish_transfer(transfer_id);
        assert!(!service.is_cancelled(transfer_id));
    }

    #[test]
    fn terminal_events_are_retained_in_a_bounded_queue() {
        let service = BackendService::new(2);
        service.emit(AppEvent::ErrorOccurred {
            code: 1,
            message: "one".to_string(),
        });
        service.emit(AppEvent::ErrorOccurred {
            code: 2,
            message: "two".to_string(),
        });
        service.emit(AppEvent::ErrorOccurred {
            code: 3,
            message: "three".to_string(),
        });
        let guard = service.inner.lock().unwrap();
        assert_eq!(guard.recent.len(), 2);
        assert_eq!(guard.recent.front().unwrap().sequence, 2);
    }

    #[test]
    fn subscriber_receives_ordered_events() {
        futures::executor::block_on(async {
            let service = BackendService::default();
            let mut rx = service.subscribe();
            service.emit(AppEvent::ErrorOccurred {
                code: 9,
                message: "ordered".to_string(),
            });
            let event = rx.next().await.unwrap();
            assert_eq!(event.sequence, 1);
        });
    }

    #[test]
    fn subscription_snapshot_and_replay_report_gaps() {
        let service = BackendService::new(2);
        let (snapshot, mut receiver) = service.subscribe_with_snapshot();
        assert_eq!(snapshot.sequence, 0);
        for code in 1..=3 {
            service.emit(AppEvent::ErrorOccurred {
                code,
                message: "test".into(),
            });
        }
        assert_eq!(
            futures::executor::block_on(receiver.next())
                .unwrap()
                .sequence,
            1
        );
        let gap = service.events_since(0).unwrap_err();
        assert_eq!(gap.snapshot.sequence, 3);
        let events = service.events_since(1).unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert!(service.events_since(4).is_err());
        assert!(service.events_since(3).unwrap().is_empty());
    }

    #[test]
    fn repeated_registration_keeps_the_workers_cancellation_token() {
        let service = BackendService::default();
        let first = service.register_transfer([1; 16]);
        let second = service.register_transfer([1; 16]);
        assert!(Arc::ptr_eq(&first, &second));
        service.cancel([1; 16]);
        assert!(first.load(Ordering::Acquire));
    }

    #[test]
    fn terminal_event_flushes_final_progress_before_itself() {
        let service = BackendService::default();
        service.register_transfer([1; 16]);
        service.progress([1; 16], 1, 10);
        service.progress([1; 16], 10, 10);
        service.emit(AppEvent::TransferCompleted {
            transfer_id: [1; 16],
        });
        let events = service.events_since(0).unwrap();
        assert!(matches!(
            events[events.len() - 2].event,
            AppEvent::TransferProgress { bytes_done: 10, .. }
        ));
        assert!(matches!(
            events.last().unwrap().event,
            AppEvent::TransferCompleted { .. }
        ));
        assert!(!service.cancel([1; 16]));
        assert!(service.flush_progress([1; 16]).is_none());
    }

    #[test]
    fn emitted_state_updates_snapshot_and_clears_old_invitation() {
        let service = BackendService::default();
        service.emit(AppEvent::StateChanged(SessionState::AwaitingPeer {
            invite_url: "https://example.test/#i=test".into(),
            expires_at: 0,
            host_address: "test".into(),
        }));
        assert_eq!(service.snapshot().app.invite_expires_in_secs, 0);
        assert!(service.snapshot().app.can_disconnect);
        service.set_state(SessionState::Booting);
        assert!(service.snapshot().app.invite_qr_url.is_none());
        assert!(!service.snapshot().app.can_disconnect);
        service.set_state(SessionState::DialingHost {
            host_address: "test".into(),
        });
        assert!(service.snapshot().app.can_disconnect);
    }
}
