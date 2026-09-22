use serde::{Deserialize, Serialize};

pub const DERP_MAP_URL: &str = "https://tailcat.dev/derpmap.json";
pub const INVITE_BASE_URL: &str = "https://ponlet.mat2uken.app";
pub const QUEUE_LIMIT: usize = 32;
pub const SHARED_QUEUE_LIMIT: usize = QUEUE_LIMIT;
pub const SHARED_TEXT_MAX_BYTES: u64 = tailsend_protocol::limits::MAX_TEXT_PAYLOAD_SIZE;

pub use tailsend_core::{UiEvent, UiQrBitmap, UiReceivedItem, UiSnapshot};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRequest {
    pub name: String,
    pub size: u64,
    pub mime: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedPendingItem {
    pub kind: String,
    pub name: String,
    pub size: u64,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedImportSummary {
    pub imported: usize,
    pub pending_items: Vec<SharedPendingItem>,
    pub queued: usize,
    pub sent: usize,
}

pub fn new_id() -> [u8; 16] {
    use rand::RngCore;
    let mut id = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut id);
    id
}

pub use tailsend_core::format_transfer_id as id_string;
pub use tailsend_core::format_transfer_id as hex_id;

pub fn parse_id(value: &str) -> Result<[u8; 16], String> {
    tailsend_core::parse_transfer_id(value).ok_or_else(|| "Invalid transfer id".to_string())
}
