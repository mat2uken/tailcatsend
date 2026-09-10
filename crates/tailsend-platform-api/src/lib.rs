use async_trait::async_trait;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use tailsend_protocol::control::FileOffer;

/// Native adapters must be safe to move between the dedicated I/O threads.
/// WASM adapters stay on their Worker and therefore do not need these bounds.
#[cfg(target_arch = "wasm32")]
pub trait PlatformThreadSafety {}

#[cfg(target_arch = "wasm32")]
impl<T: ?Sized> PlatformThreadSafety for T {}

#[cfg(not(target_arch = "wasm32"))]
pub trait PlatformThreadSafety: Send + Sync {}

#[cfg(not(target_arch = "wasm32"))]
impl<T: Send + Sync + ?Sized> PlatformThreadSafety for T {}

/// Maximum number of bytes accepted for the live `NAME:<name>:<size>\n`
/// file header.  The value is shared by every platform adapter so a sender
/// cannot make one receiver allocate an unbounded header buffer.
pub const MAX_FILE_NAME_HEADER_BYTES: usize = 8 * 1024;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("File not found: {0}")]
    NotFound(String),
    #[error("Permission denied: {0}")]
    PermissionDenied(String),
    #[error("Storage full / insufficient space")]
    StorageFull,
    #[error("partial write after {written} bytes: {message}")]
    PartialWrite { written: usize, message: String },
    #[error("I/O error: {0}")]
    Io(String),
    #[error("Operation cancelled")]
    Cancelled,
    #[error("Unsupported on this platform: {0}")]
    Unsupported(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMetadata {
    pub name: String,
    pub size: u64,
    pub mime: Option<String>,
    pub modified_unix_ms: Option<i64>,
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait FileSource: PlatformThreadSafety {
    fn metadata(&self) -> FileMetadata;
    async fn read_at(&mut self, offset: u64, max_len: usize) -> Result<Bytes, StorageError>;

    /// Read directly into a caller-owned buffer when the platform can do so.
    ///
    /// The compatibility implementation is deliberately expressed in terms
    /// of `read_at`, so existing platform implementations keep compiling.
    /// Native adapters can override this method to avoid allocating a
    /// temporary `Bytes` value for every chunk.
    async fn read_into(
        &mut self,
        offset: u64,
        destination: &mut [u8],
    ) -> Result<usize, StorageError> {
        if destination.is_empty() {
            return Ok(0);
        }
        let chunk = self.read_at(offset, destination.len()).await?;
        if chunk.len() > destination.len() {
            return Err(StorageError::Io(format!(
                "file source returned {} bytes for a {} byte buffer",
                chunk.len(),
                destination.len()
            )));
        }
        destination[..chunk.len()].copy_from_slice(&chunk);
        Ok(chunk.len())
    }

    async fn close(&mut self);
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceivedItem {
    pub name: String,
    pub size: u64,
    pub local_path_or_handle: String,
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait IncomingFileSink: PlatformThreadSafety {
    async fn write(&mut self, chunk: &[u8]) -> Result<(), StorageError>;

    /// Write as much of a chunk as the platform accepts and return the number
    /// of bytes consumed.  The default preserves the old all-or-error API;
    /// streaming sinks can override it when their underlying API performs
    /// partial writes.
    async fn write_chunk(&mut self, chunk: &[u8]) -> Result<usize, StorageError> {
        if chunk.is_empty() {
            return Ok(0);
        }
        self.write(chunk).await?;
        Ok(chunk.len())
    }

    /// Commit consumes the sink. Implementations must remove partial output
    /// on failure because callers can no longer call `abort` afterwards.
    async fn commit(mut self: Box<Self>) -> Result<ReceivedItem, StorageError>;
    async fn abort(mut self: Box<Self>) -> Result<(), StorageError>;
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait IncomingFileSinkFactory: PlatformThreadSafety {
    async fn prepare(
        &self,
        offer: &FileOffer,
    ) -> Result<Vec<Box<dyn IncomingFileSink>>, StorageError>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformCapabilities {
    pub can_pick_multiple_files: bool,
    pub can_stream_save: bool,
    pub can_choose_save_location: bool,
    pub can_copy_text: bool,
    pub can_open_received_item: bool,
    pub can_receive_share_intent: bool,
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait Clipboard: PlatformThreadSafety {
    async fn set_text(&self, text: &str) -> Result<(), StorageError>;
    async fn get_text(&self) -> Result<Option<String>, StorageError>;
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait FilePicker: PlatformThreadSafety {
    async fn pick_files(&self) -> Result<Vec<Box<dyn FileSource>>, StorageError>;
}
