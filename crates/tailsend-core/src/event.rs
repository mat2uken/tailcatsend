use crate::state::SessionState;
use serde::{Deserialize, Serialize};
use tailsend_platform_api::ReceivedItem;
use tailsend_transport_api::TransportPath;

/// Stable reasons used when a transfer stops before completion.
///
/// Keeping these values in the shared event crate makes native, browser and
/// IPC adapters agree on the terminal status without treating an arbitrary
/// transport error as a cancellation.
pub const TRANSFER_CANCELLED_BY_USER: &str = "Transfer cancelled by user";
pub const TRANSFER_CANCELLED_BY_PEER: &str = "Transfer cancelled by peer";
pub const TRANSFER_CANCELLED_BY_TRANSPORT: &str = "Operation cancelled";

pub fn transfer_status_for_reason(reason: &str) -> &'static str {
    if matches!(
        reason,
        TRANSFER_CANCELLED_BY_USER | TRANSFER_CANCELLED_BY_PEER | TRANSFER_CANCELLED_BY_TRANSPORT
    ) {
        "cancelled"
    } else {
        "failed"
    }
}

pub fn transfer_telemetry_reason(reason: &str) -> &'static str {
    match reason {
        TRANSFER_CANCELLED_BY_USER => "user",
        TRANSFER_CANCELLED_BY_PEER | TRANSFER_CANCELLED_BY_TRANSPORT => "peer",
        _ => "error",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AppEvent {
    StateChanged(SessionState),
    /// The latest path observed by this endpoint's data stream.
    TransportChanged(TransportPath),
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
