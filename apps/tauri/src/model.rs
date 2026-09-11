use serde::{Deserialize, Serialize};
use tailsend_transport_api::TransportPath;

pub const DERP_MAP_URL: &str = "https://tailcat.dev/derpmap.json";
pub const INVITE_BASE_URL: &str = "https://ponlet.pages.dev";
pub const INVITE_LIFETIME_SECS: u64 = 600;
pub const QUEUE_LIMIT: usize = 32;

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

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRequest {
    pub name: String,
    pub size: u64,
    pub mime: Option<String>,
    pub path: String,
}
