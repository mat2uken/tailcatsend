mod io;
mod live;
pub use live::*;

use thiserror::Error;

use tailsend_platform_api::{StorageError, MAX_FILE_NAME_HEADER_BYTES};
use tailsend_protocol::limits::MAX_TEXT_PAYLOAD_SIZE;
use tailsend_transport_api::TransportError;

#[derive(Debug, Error)]
pub enum TransferError {
    #[error("Transport error: {0}")]
    Transport(#[from] TransportError),
    #[error("Storage error: {0}")]
    Storage(#[from] StorageError),
    #[error("Transfer cancelled by user")]
    Cancelled,
    #[error("Invalid UTF-8 payload in text transfer")]
    InvalidUtf8,
    #[error("Data size mismatch: expected {expected}, actual {actual}")]
    SizeMismatch { expected: u64, actual: u64 },
    #[error("Unexpected EOF received")]
    UnexpectedEof,
    #[error("File NAME header is invalid: {0}")]
    InvalidNameHeader(String),
    #[error("File NAME header exceeds {MAX_FILE_NAME_HEADER_BYTES} bytes")]
    NameHeaderTooLarge,
    #[error("Text message exceeds {MAX_TEXT_PAYLOAD_SIZE} bytes")]
    TextTooLarge,
    #[error("Read returned more bytes than requested: requested {requested}, actual {actual}")]
    ReadOverrun { requested: usize, actual: usize },
    #[error("Write returned zero bytes")]
    WriteZero,
    #[error("Write returned more bytes than requested: requested {requested}, actual {actual}")]
    WriteOverrun { requested: usize, actual: usize },
}

impl TransferError {
    /// Whether the transport reported that the peer cancelled this transfer.
    /// `TransferError::Cancelled` is reserved for the local cancellation flag
    /// and therefore is intentionally not included here.
    pub fn is_peer_cancelled(&self) -> bool {
        matches!(self, Self::Transport(error) if error.is_cancelled())
    }
}

pub struct ProgressUpdate {
    pub transfer_id: [u8; 16],
    pub bytes_transferred: u64,
    pub total_bytes: u64,
}

#[cfg(target_arch = "wasm32")]
pub type ProgressCallback = Box<dyn Fn(ProgressUpdate)>;

#[cfg(not(target_arch = "wasm32"))]
pub type ProgressCallback = Box<dyn Fn(ProgressUpdate) + Send + Sync>;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
