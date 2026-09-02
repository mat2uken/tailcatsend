use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use futures::channel::mpsc::UnboundedSender;
use futures::lock::Mutex as AsyncMutex;

use tailsend_platform_api::PlatformCapabilities;
use tailsend_protocol::control::PeerInfo;
use tailsend_transport_api::TailcatTransport;

use crate::event::AppEvent;
use crate::snapshot::AppSnapshot;
use crate::state::SessionState;

#[allow(dead_code)]
pub struct SessionActor {
    transport: Arc<dyn TailcatTransport>,
    platform_caps: PlatformCapabilities,
    peer_info: PeerInfo,
    state: Arc<AsyncMutex<SessionState>>,
    snapshot: Arc<AsyncMutex<AppSnapshot>>,
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
            state: Arc::new(AsyncMutex::new(SessionState::Booting)),
            snapshot: Arc::new(AsyncMutex::new(AppSnapshot::default())),
            event_tx,
            active_cancel_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn get_snapshot(&self) -> AppSnapshot {
        self.snapshot.lock().await.clone()
    }

    pub async fn set_state(&self, new_state: SessionState) {
        let mut state_lock = self.state.lock().await;
        *state_lock = new_state.clone();

        let mut snap = self.snapshot.lock().await;
        snap.state = new_state.clone();

        match &new_state {
            SessionState::AwaitingPeer {
                invite_url,
                expires_at,
                ..
            } => {
                snap.invite_qr_url = Some(invite_url.clone());
                snap.invite_expires_in_secs = expires_at.saturating_sub(0);
                snap.can_disconnect = true;
                snap.can_send = false;
                snap.pending_offer = None;
            }
            SessionState::ConnectedIdle { peer_info, .. } => {
                snap.peer_display_name = peer_info.display_name.clone();
                snap.can_disconnect = true;
                snap.can_send = true;
                snap.pending_offer = None;
            }
            SessionState::AwaitingUserDecision { offer, .. } => {
                snap.pending_offer = Some(offer.clone());
            }
            _ => {
                snap.can_send = false;
            }
        }

        let _ = self.event_tx.unbounded_send(AppEvent::StateChanged(new_state));
    }
}
