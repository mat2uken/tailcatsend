use serde::{Deserialize, Serialize};
use crate::state::{PendingOffer, SessionState};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSnapshot {
    pub state: SessionState,
    pub peer_display_name: String,
    pub invite_qr_url: Option<String>,
    pub invite_expires_in_secs: u64,
    pub can_disconnect: bool,
    pub can_send: bool,
    pub pending_offer: Option<PendingOffer>,
}

impl Default for AppSnapshot {
    fn default() -> Self {
        Self {
            state: SessionState::Booting,
            peer_display_name: String::new(),
            invite_qr_url: None,
            invite_expires_in_secs: 0,
            can_disconnect: false,
            can_send: false,
            pending_offer: None,
        }
    }
}
