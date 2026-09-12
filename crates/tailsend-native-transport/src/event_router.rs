//! The Go event queue is process-wide, so exactly one thread may drain it.
//! Listener queues contain handles only; payload I/O remains in NativeStream.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

use tailsend_native_bridge::{
    TcEvent, TcHandle, TC_EVENT_INCOMING_STREAM, TC_EVENT_LISTENER_ERROR, TC_EVENT_STREAM_ERROR,
    TC_OK, TC_TIMEOUT,
};
use tailsend_transport_api::TransportError;
use tokio::sync::Notify;

// Same limit as tailcat/bridge/native/bridge.go's process-wide event channel.
const MAX_QUEUED_EVENTS: usize = 1024;
type CloseStream = dyn Fn(TcHandle) + Send + Sync;
static ROUTER: OnceLock<Result<Arc<EventRouter>, String>> = OnceLock::new();

pub(super) fn shared_router() -> Result<Arc<EventRouter>, TransportError> {
    ROUTER
        .get_or_init(|| {
            let router = EventRouter::new(Arc::new(|handle| unsafe {
                let _ = tailsend_native_bridge::tc_stream_close(handle);
            }));
            let worker = router.clone();
            std::thread::Builder::new()
                .name("ponlet-native-events".into())
                .spawn(move || worker.poll_events())
                .map_err(|error| format!("cannot start native event reader: {error}"))?;
            Ok(router)
        })
        .clone()
        .map_err(TransportError::Internal)
}

pub(super) fn close_all_listeners() {
    if let Some(Ok(router)) = ROUTER.get() {
        router.close_all();
    }
}

struct Mailbox {
    notify: Arc<Notify>,
    events: VecDeque<TcEvent>,
    failure: Option<i32>,
}

#[derive(Default)]
struct State {
    listeners: HashMap<TcHandle, Mailbox>,
    creating: usize,
    // A Go listener can emit before tc_listener_create returns its handle.
    registering: VecDeque<TcEvent>,
    queued: usize,
    revision: u64,
}

pub(super) struct EventRouter {
    state: Mutex<State>,
    changed: Condvar,
    close_stream: Arc<CloseStream>,
}

impl EventRouter {
    fn new(close_stream: Arc<CloseStream>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            close_stream,
        })
    }

    pub(super) fn begin_create(self: &Arc<Self>) -> CreatingListener {
        let mut state = self.state.lock().unwrap();
        state.creating += 1;
        state.revision += 1;
        self.changed.notify_one();
        CreatingListener {
            router: self.clone(),
        }
    }

    fn register(self: &Arc<Self>, owner: TcHandle) -> Result<EventReceiver, TransportError> {
        let notify = Arc::new(Notify::new());
        let mut state = self.state.lock().unwrap();
        if state.listeners.contains_key(&owner) {
            return Err(TransportError::Internal(
                "listener handle is already registered".into(),
            ));
        }
        let mut events = VecDeque::new();
        state.registering.retain(|event| {
            if event.owner_handle == owner {
                events.push_back(*event);
                false
            } else {
                true
            }
        });
        state.listeners.insert(
            owner,
            Mailbox {
                notify: notify.clone(),
                events,
                failure: None,
            },
        );
        state.revision += 1;
        self.changed.notify_one();
        Ok(EventReceiver {
            router: self.clone(),
            owner,
            notify,
        })
    }

    fn discard(&self, events: impl IntoIterator<Item = TcEvent>) {
        // Never call Go while holding the router mutex. Closing a connection
        // can wait for the native network stack and may itself produce events.
        for event in events {
            if event.event_type == TC_EVENT_INCOMING_STREAM && event.object_handle != 0 {
                (self.close_stream)(event.object_handle);
            }
        }
    }

    fn route(&self, event: TcEvent) {
        if !matches!(
            event.event_type,
            TC_EVENT_INCOMING_STREAM | TC_EVENT_LISTENER_ERROR | TC_EVENT_STREAM_ERROR
        ) {
            return;
        }
        let mut state = self.state.lock().unwrap();
        if state.queued < MAX_QUEUED_EVENTS {
            if let Some(mailbox) = state.listeners.get_mut(&event.owner_handle) {
                if mailbox.failure.is_none() {
                    mailbox.events.push_back(event);
                    mailbox.notify.notify_one();
                    state.queued += 1;
                    return;
                }
            } else if state.creating > 0 {
                state.registering.push_back(event);
                state.queued += 1;
                return;
            }
        }
        drop(state);
        // Only an unregistered/failed owner or an overflowing queue reaches
        // here. One live listener never discards another listener's event.
        self.discard([event]);
    }

    fn close(&self, owner: TcHandle, notify: &Arc<Notify>) {
        let mut state = self.state.lock().unwrap();
        if !state
            .listeners
            .get(&owner)
            .is_some_and(|entry| Arc::ptr_eq(&entry.notify, notify))
        {
            return;
        }
        let mailbox = state.listeners.remove(&owner).unwrap();
        state.queued -= mailbox.events.len();
        state.revision += 1;
        mailbox.notify.notify_waiters();
        self.changed.notify_one();
        drop(state);
        self.discard(mailbox.events);
    }

    fn close_all(&self) {
        let mut state = self.state.lock().unwrap();
        let mut events = std::mem::take(&mut state.registering);
        for (_, mailbox) in state.listeners.drain() {
            mailbox.notify.notify_waiters();
            events.extend(mailbox.events);
        }
        state.queued = 0;
        state.revision += 1;
        self.changed.notify_one();
        drop(state);
        self.discard(events);
    }

    fn poll_events(&self) {
        loop {
            let mut state = self.state.lock().unwrap();
            // The single process reader sleeps when no listener needs it.
            // It is independent of any window's Tokio runtime or accept future.
            while state.creating == 0
                && state
                    .listeners
                    .values()
                    .all(|entry| entry.failure.is_some())
            {
                state = self.changed.wait(state).unwrap();
            }
            let owners: Vec<_> = state
                .listeners
                .iter()
                .filter(|(_, entry)| entry.failure.is_none())
                .map(|(&owner, entry)| (owner, entry.notify.clone()))
                .collect();
            let revision = state.revision;
            drop(state);
            let mut event = TcEvent::default();
            let code = unsafe { tailsend_native_bridge::tc_wait_event(1_000, &mut event) };
            match code {
                TC_OK => self.route(event),
                TC_TIMEOUT => {}
                _ => {
                    let mut state = self.state.lock().unwrap();
                    let changed_during_poll = state.revision != revision;
                    let mut discarded = VecDeque::new();
                    for (owner, notify) in owners {
                        if let Some(entry) = state.listeners.get_mut(&owner) {
                            // A shutdown error from an old poll must not fail
                            // listeners created while that call was blocked.
                            if Arc::ptr_eq(&entry.notify, &notify) {
                                entry.failure = Some(code);
                                discarded.extend(std::mem::take(&mut entry.events));
                                notify.notify_waiters();
                            }
                        }
                    }
                    state.queued -= discarded.len();
                    let failed_revision = state.revision;
                    drop(state);
                    self.discard(discarded);
                    if !changed_during_poll {
                        // A persistent bridge error must not busy-loop while
                        // an in-flight listener creation is still finishing.
                        let mut state = self.state.lock().unwrap();
                        while state.revision == failed_revision {
                            state = self.changed.wait(state).unwrap();
                        }
                    }
                }
            }
        }
    }
}

pub(super) struct CreatingListener {
    router: Arc<EventRouter>,
}

impl CreatingListener {
    pub(super) fn register(&self, owner: TcHandle) -> Result<EventReceiver, TransportError> {
        self.router.register(owner)
    }
}

impl Drop for CreatingListener {
    fn drop(&mut self) {
        let mut state = self.router.state.lock().unwrap();
        state.creating -= 1;
        let discarded = if state.creating == 0 {
            std::mem::take(&mut state.registering)
        } else {
            VecDeque::new()
        };
        state.queued -= discarded.len();
        state.revision += 1;
        self.router.changed.notify_one();
        drop(state);
        self.router.discard(discarded);
    }
}

pub(super) struct EventReceiver {
    router: Arc<EventRouter>,
    owner: TcHandle,
    notify: Arc<Notify>,
}

impl EventReceiver {
    pub(super) async fn recv(&self) -> Result<TcEvent, TransportError> {
        loop {
            // Register before checking the queue so close cannot be missed,
            // including when more than one accept is waiting for this owner.
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut state = self.router.state.lock().unwrap();
                let entry = state
                    .listeners
                    .get_mut(&self.owner)
                    .filter(|entry| Arc::ptr_eq(&entry.notify, &self.notify))
                    .ok_or(TransportError::ListenerClosed)?;
                if let Some(code) = entry.failure {
                    return Err(super::transport_error(code));
                }
                if let Some(event) = entry.events.pop_front() {
                    state.queued -= 1;
                    return Ok(event);
                }
            }
            notified.await;
        }
    }

    pub(super) fn close(&self) {
        self.router.close(self.owner, &self.notify);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::time::Duration;

    fn incoming(owner: TcHandle, stream: TcHandle) -> TcEvent {
        TcEvent {
            event_type: TC_EVENT_INCOMING_STREAM,
            owner_handle: owner,
            object_handle: stream,
            port: 1234,
            ..TcEvent::default()
        }
    }

    fn router() -> (Arc<EventRouter>, Arc<Mutex<Vec<TcHandle>>>) {
        let closed = Arc::new(Mutex::new(Vec::new()));
        let log = closed.clone();
        let router = EventRouter::new(Arc::new(move |handle| log.lock().unwrap().push(handle)));
        (router, closed)
    }

    async fn receive(receiver: &EventReceiver) -> Result<TcEvent, TransportError> {
        tokio::time::timeout(Duration::from_secs(2), receiver.recv())
            .await
            .expect("listener receiver did not wake")
    }

    #[tokio::test]
    async fn stale_poll_result_goes_to_new_owner_after_old_listener_closes() {
        let (router, closed) = router();
        let old = router.begin_create().register(1).unwrap();
        let waiting = old.recv();
        tokio::pin!(waiting);
        // Poll the old accept once so it is waiting before close/regeneration.
        assert!(
            std::future::poll_fn(|cx| {
                std::task::Poll::Ready(waiting.as_mut().poll(cx).is_pending())
            })
            .await
        );
        old.close();
        let new = router.begin_create().register(2).unwrap();
        // This is the result of the process-wide poll that began with owner 1.
        router.route(incoming(2, 200));
        assert!(matches!(waiting.await, Err(TransportError::ListenerClosed)));
        let event = receive(&new).await.unwrap();
        assert_eq!((event.owner_handle, event.object_handle), (2, 200));
        assert!(closed.lock().unwrap().is_empty());
        new.close();
    }

    #[tokio::test]
    async fn simultaneous_listeners_receive_only_their_own_streams() {
        let (router, closed) = router();
        let first = Arc::new(router.begin_create().register(1).unwrap());
        let second = Arc::new(router.begin_create().register(2).unwrap());
        let first_waiter = tokio::spawn({
            let first = first.clone();
            async move { receive(&first).await.unwrap() }
        });
        let second_waiter = tokio::spawn({
            let second = second.clone();
            async move { receive(&second).await.unwrap() }
        });
        router.route(incoming(2, 201));
        router.route(incoming(1, 101));
        router.route(incoming(2, 202));
        assert_eq!(first_waiter.await.unwrap().object_handle, 101);
        assert_eq!(second_waiter.await.unwrap().object_handle, 201);
        assert_eq!(receive(&second).await.unwrap().object_handle, 202);
        assert!(closed.lock().unwrap().is_empty());
        first.close();
        second.close();
    }

    #[tokio::test]
    async fn events_emitted_before_listener_registration_are_preserved() {
        let (router, closed) = router();
        let first = router.begin_create();
        let second = router.begin_create();
        router.route(incoming(10, 101));
        router.route(incoming(20, 201));
        router.route(incoming(99, 991));
        let owner20 = second.register(20).unwrap();
        drop(second);
        assert!(closed.lock().unwrap().is_empty());
        let owner10 = first.register(10).unwrap();
        drop(first);
        assert_eq!(*closed.lock().unwrap(), [991]);
        assert_eq!(receive(&owner10).await.unwrap().object_handle, 101);
        assert_eq!(receive(&owner20).await.unwrap().object_handle, 201);
        assert_eq!(router.state.lock().unwrap().queued, 0);
        owner10.close();
        owner20.close();
    }

    #[tokio::test]
    async fn close_discards_queued_and_late_streams_without_touching_other_owners() {
        let (router, closed) = router();
        let first = router.begin_create().register(1).unwrap();
        let second = router.begin_create().register(2).unwrap();
        router.route(incoming(1, 101));
        router.route(incoming(1, 102));
        router.route(incoming(2, 201));
        first.close();
        first.close();
        router.route(incoming(1, 103));
        assert_eq!(*closed.lock().unwrap(), [101, 102, 103]);
        assert!(matches!(
            receive(&first).await,
            Err(TransportError::ListenerClosed)
        ));
        assert_eq!(receive(&second).await.unwrap().object_handle, 201);
        assert_eq!(router.state.lock().unwrap().queued, 0);
        second.close();
    }

    #[tokio::test]
    async fn close_wakes_every_accept_and_never_holds_router_lock_during_cleanup() {
        let router_ref: Arc<Mutex<std::sync::Weak<EventRouter>>> =
            Arc::new(Mutex::new(std::sync::Weak::new()));
        let callback_ref = router_ref.clone();
        let router = EventRouter::new(Arc::new(move |_| {
            let router = callback_ref.lock().unwrap().upgrade().unwrap();
            assert!(
                router.state.try_lock().is_ok(),
                "cleanup was called under the router lock"
            );
        }));
        *router_ref.lock().unwrap() = Arc::downgrade(&router);
        let owner = router.begin_create().register(1).unwrap();
        let first = owner.recv();
        let second = owner.recv();
        tokio::pin!(first, second);
        assert!(
            std::future::poll_fn(|cx| {
                std::task::Poll::Ready(
                    first.as_mut().poll(cx).is_pending() && second.as_mut().poll(cx).is_pending(),
                )
            })
            .await
        );
        router.route(incoming(1, 101));
        owner.close();
        assert!(matches!(first.await, Err(TransportError::ListenerClosed)));
        assert!(matches!(second.await, Err(TransportError::ListenerClosed)));
    }

    #[tokio::test]
    async fn cancelling_accept_leaves_the_listener_queue_available_to_the_next_accept() {
        let (router, closed) = router();
        let owner = router.begin_create().register(1).unwrap();
        {
            let cancelled = owner.recv();
            tokio::pin!(cancelled);
            assert!(
                std::future::poll_fn(|cx| {
                    std::task::Poll::Ready(cancelled.as_mut().poll(cx).is_pending())
                })
                .await
            );
        }
        router.route(incoming(1, 101));
        assert_eq!(receive(&owner).await.unwrap().object_handle, 101);
        assert!(closed.lock().unwrap().is_empty());
        owner.close();
    }

    #[test]
    fn total_queue_limit_includes_all_owners_and_pending_registrations() {
        let (router, closed) = router();
        let first = router.begin_create().register(1).unwrap();
        let creating = router.begin_create();
        for index in 0..MAX_QUEUED_EVENTS {
            router.route(incoming(
                if index % 2 == 0 { 1 } else { 2 },
                index as u64 + 100,
            ));
        }
        router.route(incoming(1, 9000));
        router.route(incoming(2, 9001));
        assert_eq!(router.state.lock().unwrap().queued, MAX_QUEUED_EVENTS);
        assert_eq!(*closed.lock().unwrap(), [9000, 9001]);
        let second = creating.register(2).unwrap();
        drop(creating);
        first.close();
        second.close();
        assert_eq!(router.state.lock().unwrap().queued, 0);
        assert_eq!(closed.lock().unwrap().len(), MAX_QUEUED_EVENTS + 2);
    }

    #[tokio::test]
    async fn a_reused_handle_cannot_be_removed_by_an_old_receiver() {
        let (router, closed) = router();
        let old = router.begin_create().register(1).unwrap();
        old.close();
        let new = router.begin_create().register(1).unwrap();
        router.route(incoming(1, 102));
        old.close();
        assert!(matches!(
            receive(&old).await,
            Err(TransportError::ListenerClosed)
        ));
        assert_eq!(receive(&new).await.unwrap().object_handle, 102);
        assert!(closed.lock().unwrap().is_empty());
        new.close();
    }
}
