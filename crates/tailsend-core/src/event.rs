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

/// Stable lowercase transfer identifier used in snapshots and UI events.
pub fn format_transfer_id(id: [u8; 16]) -> String {
    use std::fmt::Write;
    let mut output = String::with_capacity(32);
    for byte in id {
        write!(output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

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

#[cfg(test)]
mod tests {
    #[test]
    fn transfer_identifier_preserves_padding_and_lowercase() {
        assert_eq!(
            super::format_transfer_id([
                0x00, 0x01, 0x0a, 0x10, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb,
                0xcc, 0xff,
            ]),
            "00010a102233445566778899aabbccff",
        );
    }
}
