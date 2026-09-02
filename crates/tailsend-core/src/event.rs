use serde::{Deserialize, Serialize};
use tailsend_platform_api::ReceivedItem;
use crate::state::SessionState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AppEvent {
    StateChanged(SessionState),
    TextReceived {
        text: String,
    },
    FilesReceived {
        items: Vec<ReceivedItem>,
    },
    TransferProgress {
        transfer_id: [u8; 16],
        bytes_done: u64,
        bytes_total: u64,
    },
    TransferCompleted {
        transfer_id: [u8; 16],
    },
    TransferCancelled {
        transfer_id: [u8; 16],
        reason: String,
    },
    ErrorOccurred {
        code: u32,
        message: String,
    },
}
