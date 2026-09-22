use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

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
    #[error("I/O error: {0}")]
    Io(String),
    #[error("Operation cancelled")]
    Cancelled,
    #[error("Unsupported on this platform: {0}")]
    Unsupported(String),
}

#[derive(Debug, Clone)]
pub struct FileMetadata {
    pub name: String,
    pub size: u64,
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait FileSource: PlatformThreadSafety {
    fn metadata(&self) -> FileMetadata;
    /// Fill the caller-owned buffer and return the number of bytes read.
    /// Implementations must never return a count larger than the buffer.
    async fn read_into(
        &mut self,
        offset: u64,
        destination: &mut [u8],
    ) -> Result<usize, StorageError>;
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
    /// Write the complete chunk or return an error. On failure the receiver
    /// aborts the sink, including any bytes written before the error.
    async fn write(&mut self, chunk: &[u8]) -> Result<(), StorageError>;

    /// Commit consumes the sink. Implementations must remove partial output
    /// on failure because callers can no longer call `abort` afterwards.
    async fn commit(mut self: Box<Self>) -> Result<ReceivedItem, StorageError>;
    async fn abort(mut self: Box<Self>) -> Result<(), StorageError>;
}
