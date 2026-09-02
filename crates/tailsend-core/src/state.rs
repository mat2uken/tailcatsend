use serde::{Deserialize, Serialize};
use tailsend_protocol::control::{Capabilities, FileOffer, PeerInfo, TextOffer};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionState {
    Booting,
    AwaitingPeer {
        invite_url: String,
        expires_at: u64,
        host_address: String,
    },
    DialingHost {
        host_address: String,
    },
    Authenticating,
    ConnectedIdle {
        peer_info: PeerInfo,
        peer_capabilities: Capabilities,
        peer_address: String,
    },
    AwaitingAcceptance {
        transfer_id: [u8; 16],
        is_files: bool,
    },
    AwaitingUserDecision {
        transfer_id: [u8; 16],
        offer: PendingOffer,
    },
    Transferring {
        transfer_id: [u8; 16],
        is_incoming: bool,
        is_files: bool,
        bytes_done: u64,
        bytes_total: u64,
        current_item_name: String,
    },
    Disconnected {
        reason: String,
    },
    Error {
        code: u32,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PendingOffer {
    Text(TextOffer),
    Files(FileOffer),
}
