//! Shared metadata exposed by the native and browser backends.

use crate::{format_transfer_id, BackendSnapshot, SessionState};
use serde::Serialize;
use tailsend_transport_api::TransportPath;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSnapshot {
    pub api_version: u16,
    pub sequence: u64,
    pub state: &'static str,
    pub peer_name: String,
    pub invite_url: Option<String>,
    pub invite_expires_in_secs: u64,
    pub can_send: bool,
    pub can_disconnect: bool,
    pub transfer: Option<UiTransfer>,
    pub error: Option<String>,
    pub transport: TransportPath,
    pub received: Vec<UiReceivedItem>,
    pub received_messages: Vec<crate::ReceivedMessage>,
    pub last_transfer: Option<crate::TransferOutcome>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiTransfer {
    pub id: String,
    pub name: String,
    pub done: u64,
    pub total: u64,
    pub incoming: bool,
    pub status: &'static str,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiReceivedItem {
    pub name: String,
    pub size: u64,
    pub local_path_or_handle: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiQrBitmap {
    pub width: u32,
    pub height: u32,
    pub rgba_pixels: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum UiEvent {
    Snapshot {
        sequence: u64,
        snapshot: UiSnapshot,
    },
    Progress {
        sequence: u64,
        id: String,
        done: u64,
        total: u64,
    },
    Text {
        sequence: u64,
        text: String,
        incoming: bool,
    },
    Files {
        sequence: u64,
        items: Vec<UiReceivedItem>,
    },
    Terminal {
        sequence: u64,
        id: String,
        status: &'static str,
        message: Option<String>,
    },
}

impl UiSnapshot {
    pub fn from_backend(snapshot: BackendSnapshot, received: Vec<UiReceivedItem>) -> Self {
        let app = snapshot.app;
        let mut ui = Self {
            api_version: snapshot.api_version,
            sequence: snapshot.sequence,
            state: "booting",
            peer_name: app.peer_display_name,
            invite_url: None,
            invite_expires_in_secs: 0,
            can_send: false,
            can_disconnect: app.can_disconnect,
            transfer: None,
            error: None,
            transport: app.transport_path,
            received,
            received_messages: snapshot.received_messages,
            last_transfer: snapshot.last_transfer,
        };
        match app.state {
            SessionState::Booting => ui.can_disconnect = false,
            SessionState::AwaitingPeer { invite_url, .. } => {
                ui.state = "awaiting-peer";
                ui.invite_url = Some(invite_url);
                ui.invite_expires_in_secs = app.invite_expires_in_secs;
            }
            SessionState::ConnectedIdle { .. } => {
                ui.state = "connected";
                ui.can_send = app.can_send;
            }
            SessionState::Transferring {
                transfer_id,
                is_incoming,
                bytes_done,
                bytes_total,
                current_item_name,
                ..
            } => {
                ui.state = "transferring";
                ui.transfer = Some(UiTransfer {
                    id: format_transfer_id(transfer_id),
                    name: current_item_name,
                    done: bytes_done,
                    total: bytes_total,
                    incoming: is_incoming,
                    status: "transferring",
                });
            }
            SessionState::Error { message, .. } => {
                ui.state = "error";
                ui.error = Some(message);
            }
            SessionState::Disconnected { .. } => {
                ui.state = "ready";
                ui.can_disconnect = false;
            }
            SessionState::DialingHost { .. } | SessionState::Authenticating => {}
        }
        ui
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from the pre-consolidation browser types and conversion in
    // work/cleanup-20260922/ui-fixture-generator, before removing unused states.
    // Both adapters used the same fields and conversion at capture time.
    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../tests/fixtures/ui-v2.json")).unwrap()
    }

    #[test]
    fn snapshots_preserve_existing_ui_json() {
        for case in fixture()["snapshots"].as_array().unwrap() {
            let snapshot = serde_json::from_value(case["input"].clone()).unwrap();
            let received = serde_json::from_value(case["received"].clone()).unwrap();
            let actual = UiSnapshot::from_backend(snapshot, received);
            assert_eq!(
                serde_json::to_value(&actual).unwrap(),
                case["expected"],
                "{}",
                case["name"]
            );
            assert_eq!(
                serde_json::to_value(UiEvent::Snapshot {
                    sequence: actual.sequence,
                    snapshot: actual,
                })
                .unwrap(),
                serde_json::json!({
                    "type": "snapshot",
                    "sequence": 19,
                    "snapshot": case["expected"],
                })
            );
        }
    }

    #[test]
    fn notifications_preserve_existing_ui_json() {
        let id = "01010101010101010101010101010101";
        let events = vec![
            UiEvent::Progress {
                sequence: 20,
                id: id.into(),
                done: 65537,
                total: 150000,
            },
            UiEvent::Text {
                sequence: 21,
                text: "hello".into(),
                incoming: true,
            },
            UiEvent::Files {
                sequence: 22,
                items: vec![UiReceivedItem {
                    name: "saved.txt".into(),
                    size: 123,
                    local_path_or_handle: "/saved/file".into(),
                }],
            },
            UiEvent::Terminal {
                sequence: 23,
                id: id.into(),
                status: "completed",
                message: None,
            },
            UiEvent::Terminal {
                sequence: 24,
                id: id.into(),
                status: "cancelled",
                message: Some("stop reason".into()),
            },
            UiEvent::Terminal {
                sequence: 25,
                id: id.into(),
                status: "failed",
                message: Some("stop reason".into()),
            },
        ];
        assert_eq!(serde_json::to_value(events).unwrap(), fixture()["events"]);
    }
}
