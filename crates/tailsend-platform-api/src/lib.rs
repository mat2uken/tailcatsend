use async_trait::async_trait;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use tailsend_protocol::control::FileOffer;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("File not found: {0}")]
    NotFound(String),
    #[error("Permission denied: {0}")]
    PermissionDenied(String),
    #[error("Storage full / insufficient space")]
    StorageFull,
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

#[async_trait]
pub trait FileSource: Send + Sync {
    fn metadata(&self) -> FileMetadata;
    async fn read_at(&mut self, offset: u64, max_len: usize) -> Result<Bytes, StorageError>;
    async fn close(&mut self);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceivedItem {
    pub name: String,
    pub size: u64,
    pub local_path_or_handle: String,
}

#[async_trait]
pub trait IncomingFileSink: Send + Sync {
    async fn write(&mut self, chunk: &[u8]) -> Result<(), StorageError>;
    async fn commit(mut self: Box<Self>) -> Result<ReceivedItem, StorageError>;
    async fn abort(mut self: Box<Self>) -> Result<(), StorageError>;
}

#[async_trait]
pub trait IncomingFileSinkFactory: Send + Sync {
    async fn prepare(&self, offer: &FileOffer) -> Result<Vec<Box<dyn IncomingFileSink>>, StorageError>;
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

#[async_trait]
pub trait Clipboard: Send + Sync {
    async fn set_text(&self, text: &str) -> Result<(), StorageError>;
    async fn get_text(&self) -> Result<Option<String>, StorageError>;
}

#[async_trait]
pub trait FilePicker: Send + Sync {
    async fn pick_files(&self) -> Result<Vec<Box<dyn FileSource>>, StorageError>;
}
