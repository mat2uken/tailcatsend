//! Platform independent backend state and event fan-out.
//!
//! The service deliberately contains no transport or file I/O.  A native
//! adapter and the Web Worker both run the transfer engine and publish state,
//! transfer metadata and text history here. Keeping this lock limited to state updates prevents a
//! slow file operation from blocking cancellation or UI resubscription.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use web_time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::channel::mpsc::{channel, Receiver, Sender};
use serde::{Deserialize, Serialize};

use crate::{AppEvent, AppSnapshot, SessionState};
use tailsend_transport_api::{CancellationCallback, TransportPath};

const DEFAULT_EVENT_QUEUE: usize = 32;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

/// Metadata delivered to a UI or another platform adapter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendSnapshot {
    pub api_version: u16,
    pub sequence: u64,
    pub app: AppSnapshot,
    #[serde(default)]
    pub received_messages: Vec<ReceivedMessage>,
    #[serde(default)]
    pub last_transfer: Option<TransferOutcome>,
}

impl Default for BackendSnapshot {
    fn default() -> Self {
        Self {
            api_version: 2,
            sequence: 0,
            app: AppSnapshot::default(),
            received_messages: Vec::new(),
            last_transfer: None,
        }
    }
}

/// Retained text lets a slow or resumed UI recover after an event queue gap.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceivedMessage {
    pub sequence: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferOutcome {
    pub id: String,
    pub name: String,
    pub done: u64,
    pub total: u64,
    pub incoming: bool,
    pub status: String,
    pub message: Option<String>,
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
    pub snapshot: Box<BackendSnapshot>,
}

#[derive(Debug, Clone)]
struct QueuedProgress {
    event: AppEvent,
    last_published: Instant,
}

struct ServiceState {
    snapshot: BackendSnapshot,
    generation: u64,
    connected_state: Option<SessionState>,
    subscribers: Vec<Sender<BackendEvent>>,
    progress: HashMap<[u8; 16], QueuedProgress>,
    cancellation: HashMap<[u8; 16], Arc<AtomicBool>>,
    cancellation_callbacks: HashMap<[u8; 16], CancellationCallback>,
    /// Retain state, terminal and text events for a bounded resubscription window.
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
                generation: 0,
                connected_state: None,
                subscribers: Vec::new(),
                progress: HashMap::new(),
                cancellation: HashMap::new(),
                cancellation_callbacks: HashMap::new(),
                recent: VecDeque::with_capacity(queue_limit),
            })),
            queue_limit,
        }
    }

    /// Invalidate every task from the previous connection, including all
    /// simultaneous incoming streams. Socket wake-ups run outside the lock.
    pub fn begin_session(&self) -> BackendSession {
        let (generation, callbacks) = {
            let mut inner = self.inner.lock().expect("backend state mutex poisoned");
            inner.generation = inner.generation.wrapping_add(1);
            inner.connected_state = None;
            for token in inner.cancellation.values() {
                token.store(true, Ordering::Release);
            }
            let callbacks = inner
                .cancellation_callbacks
                .drain()
                .map(|(_, callback)| callback)
                .collect::<Vec<_>>();
            inner.cancellation.clear();
            inner.progress.clear();
            (inner.generation, callbacks)
        };
        for callback in callbacks {
            callback();
        }
        BackendSession {
            service: self.clone(),
            generation,
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

    /// Record the path selected for the current data stream.  Tailcat can
    /// choose a different path for a transfer than it used for the control
    /// handshake, so adapters call this after every dial/accept.
    pub fn set_transport_path(&self, path: TransportPath) -> BackendEvent {
        self.emit(AppEvent::TransportChanged(path))
    }

    /// Publish a non-progress event.  Terminal events are never coalesced.
    pub fn emit(&self, event: AppEvent) -> BackendEvent {
        let mut inner = self.inner.lock().expect("backend state mutex poisoned");
        let telemetry = observe_telemetry(&inner, &event);
        let ordered = emit_locked(&mut inner, self.queue_limit, event);
        drop(inner);
        record_telemetry(telemetry);
        ordered
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
        progress_locked(
            &mut inner,
            self.queue_limit,
            transfer_id,
            bytes_done,
            bytes_total,
        )
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
        let callback = {
            let inner = self.inner.lock().expect("backend state mutex poisoned");
            let Some(token) = inner.cancellation.get(&transfer_id) else {
                return false;
            };
            if token.swap(true, Ordering::AcqRel) {
                return true;
            }
            inner.cancellation_callbacks.get(&transfer_id).cloned()
        };
        // The callback may close a socket or call into JavaScript. Never hold
        // the state mutex while doing that work, otherwise a terminal event
        // could deadlock waiting for the same lock.
        if let Some(callback) = callback {
            callback();
        }
        true
    }

    /// Attach the transport-specific wake-up hook after a stream is created.
    /// If cancellation raced with stream setup, invoke the hook immediately.
    pub fn set_cancellation_callback(
        &self,
        transfer_id: [u8; 16],
        callback: CancellationCallback,
    ) -> bool {
        let should_cancel = {
            let mut inner = self.inner.lock().expect("backend state mutex poisoned");
            let Some(token) = inner.cancellation.get(&transfer_id) else {
                return false;
            };
            let should_cancel = token.load(Ordering::Acquire);
            inner
                .cancellation_callbacks
                .insert(transfer_id, callback.clone());
            should_cancel
        };
        if should_cancel {
            callback();
        }
        true
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
        inner.cancellation_callbacks.remove(&transfer_id);
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
                snapshot: Box::new(inner.snapshot.clone()),
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

/// A connection's asynchronous work can only change its own live session.
/// Checking the generation and updating the service use the same mutex.
#[derive(Clone)]
pub struct BackendSession {
    service: BackendService,
    generation: u64,
}

impl BackendSession {
    pub fn is_current(&self) -> bool {
        self.service
            .inner
            .lock()
            .expect("backend state mutex poisoned")
            .generation
            == self.generation
    }

    pub fn has_peer(&self) -> bool {
        let inner = self
            .service
            .inner
            .lock()
            .expect("backend state mutex poisoned");
        inner.generation == self.generation && inner.connected_state.is_some()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn emit(&self, event: AppEvent) -> Option<BackendEvent> {
        let mut inner = self
            .service
            .inner
            .lock()
            .expect("backend state mutex poisoned");
        if inner.generation != self.generation {
            return None;
        }
        let telemetry = observe_telemetry(&inner, &event);
        let ordered = emit_locked(&mut inner, self.service.queue_limit, event);
        drop(inner);
        record_telemetry(telemetry);
        Some(ordered)
    }

    pub fn set_state(&self, state: SessionState) -> Option<BackendEvent> {
        self.emit(AppEvent::StateChanged(state))
    }

    pub fn set_transport_path(&self, path: TransportPath) -> Option<BackendEvent> {
        self.emit(AppEvent::TransportChanged(path))
    }

    pub fn progress(&self, id: [u8; 16], done: u64, total: u64) -> Option<BackendEvent> {
        let mut inner = self
            .service
            .inner
            .lock()
            .expect("backend state mutex poisoned");
        if inner.generation != self.generation {
            return None;
        }
        progress_locked(&mut inner, self.service.queue_limit, id, done, total)
    }

    pub fn register_transfer(&self, id: [u8; 16]) -> Arc<AtomicBool> {
        let mut inner = self
            .service
            .inner
            .lock()
            .expect("backend state mutex poisoned");
        if inner.generation != self.generation {
            return Arc::new(AtomicBool::new(true));
        }
        inner
            .cancellation
            .entry(id)
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    pub fn set_cancellation_callback(&self, id: [u8; 16], callback: CancellationCallback) {
        if !self.service.set_cancellation_callback(id, callback.clone()) {
            // The session may have been replaced while dial/accept was pending.
            callback();
        }
    }

    pub fn is_cancelled(&self, id: [u8; 16]) -> bool {
        !self.is_current() || self.service.is_cancelled(id)
    }

    pub fn finish_transfer(&self, id: [u8; 16]) {
        self.service.finish_transfer(id);
    }

    pub fn restore_connected_idle(&self, id: [u8; 16]) -> Option<BackendEvent> {
        let mut inner = self
            .service
            .inner
            .lock()
            .expect("backend state mutex poisoned");
        if inner.generation != self.generation {
            return None;
        }
        if !matches!(inner.snapshot.app.state, SessionState::Transferring { transfer_id, .. } if transfer_id == id)
        {
            return None;
        }
        let mut connected = inner.connected_state.clone()?;
        if let SessionState::ConnectedIdle { transport_path, .. } = &mut connected {
            *transport_path = inner.snapshot.app.transport_path;
        }
        Some(emit_locked(
            &mut inner,
            self.service.queue_limit,
            AppEvent::StateChanged(connected),
        ))
    }
}

// Observations contain only fixed event names and coarse values, never the
// peer address, text body, file name/path, invitation, or transport error.
fn observe_telemetry(
    inner: &ServiceState,
    event: &AppEvent,
) -> Option<(&'static str, Vec<(&'static str, String)>)> {
    #[cfg(target_arch = "wasm32")]
    {
        let _ = (inner, event);
        return None;
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let transport = match inner.snapshot.app.transport_path {
            TransportPath::DirectUdp => "direct-udp",
            TransportPath::WebRtc => "webrtc",
            TransportPath::Derp => "derp",
            TransportPath::Unknown => "unknown",
        };
        match event {
            AppEvent::StateChanged(SessionState::AwaitingPeer { .. }) => {
                Some(("session_created", vec![("transport", transport.into())]))
            }
            AppEvent::StateChanged(SessionState::ConnectedIdle { .. })
                if inner.connected_state.is_none() =>
            {
                Some(("peer_connected", vec![("transport", transport.into())]))
            }
            AppEvent::StateChanged(SessionState::Transferring {
                is_incoming,
                is_files,
                ..
            }) => Some((
                "transfer_started",
                vec![
                    ("transport", transport.into()),
                    (
                        "direction",
                        if *is_incoming { "receive" } else { "send" }.into(),
                    ),
                    ("file_count", if *is_files { "1" } else { "0" }.into()),
                ],
            )),
            AppEvent::TextReceived { text } => Some((
                "text_message_received",
                vec![(
                    "length_bucket",
                    tailsend_telemetry::length_bucket(text.chars().count()).into(),
                )],
            )),
            AppEvent::TransferCompleted { .. } => {
                Some(("transfer_completed", vec![("transport", transport.into())]))
            }
            AppEvent::TransferCancelled { reason, .. } => Some((
                "transfer_cancelled",
                vec![(
                    "reason",
                    if reason == "Transfer cancelled by user" {
                        "user"
                    } else {
                        "error"
                    }
                    .into(),
                )],
            )),
            AppEvent::ErrorOccurred { .. } | AppEvent::StateChanged(SessionState::Error { .. }) => {
                Some(("error", vec![("category", "transport".into())]))
            }
            _ => None,
        }
    }
}

fn record_telemetry(observation: Option<(&'static str, Vec<(&'static str, String)>)>) {
    if let Some((name, params)) = observation {
        let params = params
            .iter()
            .map(|(name, value)| (*name, value.as_str()))
            .collect::<Vec<_>>();
        tailsend_telemetry::log_event(name, &params);
    }
}

fn emit_locked(inner: &mut ServiceState, queue_limit: usize, event: AppEvent) -> BackendEvent {
    if let AppEvent::TransferCompleted { transfer_id }
    | AppEvent::TransferCancelled { transfer_id, .. } = &event
    {
        if let SessionState::Transferring {
            transfer_id: active_id,
            current_item_name,
            bytes_done,
            bytes_total,
            is_incoming,
            ..
        } = &inner.snapshot.app.state
        {
            if active_id == transfer_id {
                let (status, message) = match &event {
                    AppEvent::TransferCancelled { reason, .. } => (
                        if reason == "Transfer cancelled by user" {
                            "cancelled"
                        } else {
                            "failed"
                        },
                        Some(reason.clone()),
                    ),
                    _ => ("completed", None),
                };
                inner.snapshot.last_transfer = Some(TransferOutcome {
                    id: transfer_id
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect(),
                    name: current_item_name.clone(),
                    done: if status == "completed" {
                        *bytes_total
                    } else {
                        *bytes_done
                    },
                    total: *bytes_total,
                    incoming: *is_incoming,
                    status: status.into(),
                    message,
                });
            }
        }
        // Flush under the same lock so no progress can interleave between
        // the last byte count and the terminal event.
        if let Some(queued) = inner.progress.remove(transfer_id) {
            publish_locked(inner, queue_limit, queued.event);
        }
        inner.cancellation.remove(transfer_id);
        inner.cancellation_callbacks.remove(transfer_id);
    }
    publish_locked(inner, queue_limit, event)
}

fn progress_locked(
    inner: &mut ServiceState,
    queue_limit: usize,
    transfer_id: [u8; 16],
    bytes_done: u64,
    bytes_total: u64,
) -> Option<BackendEvent> {
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
    Some(publish_locked(inner, queue_limit, event))
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
            match state {
                SessionState::ConnectedIdle { .. } => inner.connected_state = Some(state.clone()),
                SessionState::Booting
                | SessionState::Disconnected { .. }
                | SessionState::AwaitingPeer { .. }
                | SessionState::DialingHost { .. }
                | SessionState::Error { .. } => inner.connected_state = None,
                _ => {}
            }
            inner.snapshot.app.state = state.clone();
            refresh_capabilities(&mut inner.snapshot.app, state);
        }
        AppEvent::TransportChanged(path) => {
            inner.snapshot.app.transport_path = *path;
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
    if let AppEvent::TextReceived { text } = &event {
        inner.snapshot.received_messages.push(ReceivedMessage {
            sequence: inner.snapshot.sequence,
            text: text.clone(),
        });
        // Keep recovery bounded independently of high-frequency progress.
        let messages = &mut inner.snapshot.received_messages;
        let mut bytes: usize = messages.iter().map(|message| message.text.len()).sum();
        while messages.len() > 128 || (bytes > 4 * 1024 * 1024 && messages.len() > 1) {
            bytes -= messages.remove(0).text.len();
        }
    }

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
    fn replacing_session_cancels_all_streams_and_rejects_late_updates() {
        let service = BackendService::default();
        let previous = service.begin_session();
        let incoming = previous.register_transfer([1; 16]);
        let outgoing = previous.register_transfer([2; 16]);
        let current = service.begin_session();
        current.set_state(SessionState::AwaitingPeer {
            invite_url: "new".into(),
            expires_at: 0,
            host_address: "new".into(),
        });
        let sequence = service.snapshot().sequence;
        assert!(incoming.load(Ordering::Acquire));
        assert!(outgoing.load(Ordering::Acquire));
        assert!(previous.register_transfer([3; 16]).load(Ordering::Acquire));
        assert!(previous
            .emit(AppEvent::TextReceived {
                text: "stale".into()
            })
            .is_none());
        assert!(previous
            .set_state(SessionState::Error {
                code: 1,
                message: "late close".into()
            })
            .is_none());
        assert!(previous.progress([1; 16], 10, 10).is_none());
        assert!(previous.restore_connected_idle([1; 16]).is_none());
        assert_eq!(service.snapshot().sequence, sequence);
        assert!(service.snapshot().received_messages.is_empty());
        assert_eq!(service.snapshot().app.invite_qr_url.as_deref(), Some("new"));
    }

    #[test]
    fn finishing_one_transfer_preserves_peer_metadata_and_other_active_transfer() {
        use tailsend_protocol::control::{Capabilities, PeerInfo, PlatformKind};
        let service = BackendService::default();
        let scope = service.begin_session();
        let connected = SessionState::ConnectedIdle {
            peer_info: PeerInfo::new_native("Phone".into(), PlatformKind::IOS, "test".into()),
            peer_capabilities: Capabilities::default(),
            peer_address: "peer-address".into(),
            transport_path: TransportPath::Derp,
        };
        scope.set_state(connected.clone());
        scope.set_state(SessionState::Transferring {
            transfer_id: [2; 16],
            is_incoming: true,
            is_files: true,
            bytes_done: 0,
            bytes_total: 10,
            current_item_name: "file".into(),
        });
        assert!(scope.restore_connected_idle([1; 16]).is_none());
        assert!(matches!(
            service.snapshot().app.state,
            SessionState::Transferring { .. }
        ));
        assert!(scope.restore_connected_idle([2; 16]).is_some());
        assert_eq!(service.snapshot().app.state, connected);
        let disconnected = service.begin_session();
        disconnected.set_state(SessionState::Disconnected {
            reason: "done".into(),
        });
        assert!(scope.restore_connected_idle([2; 16]).is_none());
        assert!(!service.snapshot().app.can_send);
    }

    #[test]
    fn completed_transfer_survives_snapshot_resynchronization() {
        let service = BackendService::new(2);
        let scope = service.begin_session();
        scope.set_state(SessionState::Transferring {
            transfer_id: [4; 16],
            is_incoming: false,
            is_files: true,
            bytes_done: 0,
            bytes_total: 100,
            current_item_name: "example".into(),
        });
        scope.emit(AppEvent::TransferCompleted {
            transfer_id: [4; 16],
        });
        scope.set_state(SessionState::Disconnected {
            reason: "done".into(),
        });
        let snapshot = service.snapshot();
        let outcome = snapshot.last_transfer.unwrap();
        assert_eq!(outcome.status, "completed");
        assert_eq!(outcome.done, 100);
        assert!(!outcome.incoming);
        assert_eq!(outcome.name, "example");
    }

    #[test]
    fn snapshot_retains_received_text_after_progress_exhausts_event_replay() {
        let service = BackendService::new(2);
        service.emit(AppEvent::TextReceived {
            text: "keep this message".into(),
        });
        for index in 0..5 {
            service.emit(AppEvent::TransportChanged(if index % 2 == 0 {
                TransportPath::Derp
            } else {
                TransportPath::WebRtc
            }));
        }
        assert!(service.events_since(0).is_err());
        let snapshot = service.snapshot();
        assert_eq!(snapshot.received_messages.len(), 1);
        assert_eq!(snapshot.received_messages[0].sequence, 1);
        assert_eq!(snapshot.received_messages[0].text, "keep this message");
        for _ in 0..150 {
            service.emit(AppEvent::TextReceived {
                text: "bounded".into(),
            });
        }
        assert_eq!(service.snapshot().received_messages.len(), 128);
    }

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
    fn transport_event_updates_the_path_during_a_transfer() {
        let service = BackendService::default();
        let event = service.set_transport_path(TransportPath::Derp);
        let snapshot = service.snapshot();
        assert!(matches!(
            event.event,
            AppEvent::TransportChanged(TransportPath::Derp)
        ));
        assert_eq!(snapshot.app.transport_path, TransportPath::Derp);
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

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn cancellation_callback_runs_once_and_outside_state_lock() {
        let service = BackendService::default();
        let transfer_id = [8u8; 16];
        service.register_transfer(transfer_id);
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls_for_callback = calls.clone();
        let service_for_callback = service.clone();
        service.set_cancellation_callback(
            transfer_id,
            Arc::new(move || {
                let _ = service_for_callback.snapshot();
                calls_for_callback.fetch_add(1, Ordering::AcqRel);
            }),
        );

        assert!(service.cancel(transfer_id));
        assert!(service.cancel(transfer_id));
        assert_eq!(calls.load(Ordering::Acquire), 1);
        service.finish_transfer(transfer_id);
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
