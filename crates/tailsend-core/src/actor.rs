use futures::channel::mpsc::UnboundedSender;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tailsend_platform_api::PlatformCapabilities;
use tailsend_protocol::control::PeerInfo;
use tailsend_transport_api::TailcatTransport;

use crate::event::AppEvent;
use crate::service::BackendService;
use crate::snapshot::AppSnapshot;
use crate::state::SessionState;

#[allow(dead_code)]
pub struct SessionActor {
    transport: Arc<dyn TailcatTransport>,
    platform_caps: PlatformCapabilities,
    peer_info: PeerInfo,
    service: BackendService,
    event_tx: UnboundedSender<AppEvent>,
    active_cancel_flag: Arc<AtomicBool>,
}

impl SessionActor {
    pub fn new(
        transport: Arc<dyn TailcatTransport>,
        platform_caps: PlatformCapabilities,
        peer_info: PeerInfo,
        event_tx: UnboundedSender<AppEvent>,
    ) -> Self {
        Self {
            transport,
            platform_caps,
            peer_info,
            service: BackendService::default(),
            event_tx,
            active_cancel_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn get_snapshot(&self) -> AppSnapshot {
        self.service.snapshot().app
    }

    pub async fn set_state(&self, new_state: SessionState) {
        self.service.set_state(new_state.clone());
        let _ = self
            .event_tx
            .unbounded_send(AppEvent::StateChanged(new_state));
    }

    /// Expose the same state/event service to a Tauri command or a Web Worker
    /// adapter without giving that adapter access to the actor's transport.
    pub fn backend(&self) -> BackendService {
        self.service.clone()
    }
}
