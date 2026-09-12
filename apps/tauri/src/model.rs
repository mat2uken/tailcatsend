use serde::{Deserialize, Serialize};
use tailsend_transport_api::TransportPath;

pub const DERP_MAP_URL: &str = "https://tailcat.dev/derpmap.json";
pub const INVITE_BASE_URL: &str = "https://ponlet.mat2uken.app";
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
    pub received_messages: Vec<tailsend_core::ReceivedMessage>,
    pub last_transfer: Option<tailsend_core::TransferOutcome>,
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

pub fn new_id() -> [u8; 16] {
    use rand::RngCore;
    let mut id = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut id);
    id
}

pub fn id_string(id: [u8; 16]) -> String {
    hex_id(id)
}

pub fn hex_id(id: [u8; 16]) -> String {
    id.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn parse_id(value: &str) -> Result<[u8; 16], String> {
    if value.len() != 32 {
        return Err("Invalid transfer id".to_string());
    }
    let mut id = [0u8; 16];
    for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
        let text = std::str::from_utf8(chunk).map_err(|_| "Invalid transfer id".to_string())?;
        id[index] = u8::from_str_radix(text, 16).map_err(|_| "Invalid transfer id".to_string())?;
    }
    Ok(id)
}
