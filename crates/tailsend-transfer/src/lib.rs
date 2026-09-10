mod io;
mod live;
use io::{check_cancelled, read_checked, write_fully, write_sink_fully};
pub use live::*;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use thiserror::Error;

use tailsend_platform_api::{
    FileSource, IncomingFileSink, StorageError, MAX_FILE_NAME_HEADER_BYTES,
};
use tailsend_protocol::data_header::{
    DataHeaderError, FileDataHeader, TextDataHeader, FILE_HEADER_LEN, TEXT_HEADER_LEN,
};
use tailsend_protocol::limits::{CHUNK_SIZE_BYTES, MAX_TEXT_PAYLOAD_SIZE};
use tailsend_transport_api::{DuplexStream, TransportError};

#[derive(Debug, Error)]
pub enum TransferError {
    #[error("Transport error: {0}")]
    Transport(#[from] TransportError),
    #[error("Storage error: {0}")]
    Storage(#[from] StorageError),
    #[error("Data header error: {0}")]
    Header(#[from] DataHeaderError),
    #[error("Transfer cancelled by user")]
    Cancelled,
    #[error("Invalid UTF-8 payload in text transfer")]
    InvalidUtf8,
    #[error("Data size mismatch: expected {expected}, actual {actual}")]
    SizeMismatch { expected: u64, actual: u64 },
    #[error("Unexpected EOF received")]
    UnexpectedEof,
    #[error("Session ID mismatch")]
    SessionMismatch,
    #[error("Transfer ID mismatch")]
    TransferMismatch,
    #[error("Item ID mismatch: expected {expected}, got {actual}")]
    ItemMismatch { expected: u32, actual: u32 },
    #[error("File NAME header is invalid: {0}")]
    InvalidNameHeader(String),
    #[error("File NAME header exceeds {MAX_FILE_NAME_HEADER_BYTES} bytes")]
    NameHeaderTooLarge,
    #[error("Text message exceeds {MAX_TEXT_PAYLOAD_SIZE} bytes")]
    TextTooLarge,
    #[error("Read returned zero bytes before the transfer completed")]
    ReadZero,
    #[error("Read returned more bytes than requested: requested {requested}, actual {actual}")]
    ReadOverrun { requested: usize, actual: usize },
    #[error("Write returned zero bytes")]
    WriteZero,
    #[error("Write returned more bytes than requested: requested {requested}, actual {actual}")]
    WriteOverrun { requested: usize, actual: usize },
    #[error(
        "Storage sink accepted more bytes than requested: requested {requested}, actual {actual}"
    )]
    SinkWriteOverrun { requested: usize, actual: usize },
}

pub struct ProgressUpdate {
    pub transfer_id: [u8; 16],
    pub item_id: Option<u32>,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
}

#[cfg(target_arch = "wasm32")]
pub type ProgressCallback = Box<dyn Fn(ProgressUpdate)>;

#[cfg(not(target_arch = "wasm32"))]
pub type ProgressCallback = Box<dyn Fn(ProgressUpdate) + Send + Sync>;

pub async fn send_text_stream(
    stream: &mut Box<dyn DuplexStream>,
    session_id: [u8; 16],
    transfer_id: [u8; 16],
    text: &str,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), TransferError> {
    let bytes = text.as_bytes();
    let header = TextDataHeader::new(session_id, transfer_id, bytes.len() as u64)?;
    let header_bytes = header.encode();

    write_fully(stream, &header_bytes, &cancel_flag).await?;

    // Send payload
    let mut offset = 0;
    while offset < bytes.len() {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(TransferError::Cancelled);
        }
        let chunk_end = (offset + CHUNK_SIZE_BYTES).min(bytes.len());
        let chunk = &bytes[offset..chunk_end];
        write_fully(stream, chunk, &cancel_flag).await?;
        offset = chunk_end;
    }

    check_cancelled(&cancel_flag)?;
    stream.close_write().await?;
    Ok(())
}

pub async fn receive_text_stream(
    stream: &mut Box<dyn DuplexStream>,
    expected_session_id: [u8; 16],
    expected_transfer_id: [u8; 16],
    cancel_flag: Arc<AtomicBool>,
) -> Result<String, TransferError> {
    let mut header_buf = [0u8; TEXT_HEADER_LEN];
    let mut read_header = 0;
    while read_header < TEXT_HEADER_LEN {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(TransferError::Cancelled);
        }
        let n = read_checked(stream, &mut header_buf[read_header..]).await?;
        if n == 0 {
            return Err(TransferError::UnexpectedEof);
        }
        read_header += n;
    }

    let header = TextDataHeader::decode(&header_buf)?;
    if header.session_id != expected_session_id {
        return Err(TransferError::SessionMismatch);
    }
    if header.transfer_id != expected_transfer_id {
        return Err(TransferError::TransferMismatch);
    }

    let mut payload = Vec::with_capacity(header.byte_length as usize);
    let mut buf = [0u8; CHUNK_SIZE_BYTES];
    let mut total_read = 0;

    while total_read < header.byte_length {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(TransferError::Cancelled);
        }
        let needed = (header.byte_length - total_read).min(CHUNK_SIZE_BYTES as u64) as usize;
        let n = read_checked(stream, &mut buf[..needed]).await?;
        if n == 0 {
            return Err(TransferError::UnexpectedEof);
        }
        payload.extend_from_slice(&buf[..n]);
        total_read += n as u64;
    }

    if total_read != header.byte_length {
        return Err(TransferError::SizeMismatch {
            expected: header.byte_length,
            actual: total_read,
        });
    }

    String::from_utf8(payload).map_err(|_| TransferError::InvalidUtf8)
}

pub async fn send_file_item_stream(
    stream: &mut Box<dyn DuplexStream>,
    session_id: [u8; 16],
    transfer_id: [u8; 16],
    item_id: u32,
    source: &mut Box<dyn FileSource>,
    cancel_flag: Arc<AtomicBool>,
    on_progress: Option<&ProgressCallback>,
) -> Result<u64, TransferError> {
    let meta = source.metadata();
    let header = FileDataHeader::new(session_id, transfer_id, item_id, 0, meta.size)?;
    let header_bytes = header.encode();

    write_fully(stream, &header_bytes, &cancel_flag).await?;

    let mut offset = 0;
    while offset < meta.size {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(TransferError::Cancelled);
        }
        let max_len = (meta.size - offset).min(CHUNK_SIZE_BYTES as u64) as usize;
        let chunk = source.read_at(offset, max_len).await?;
        if chunk.is_empty() {
            return Err(TransferError::UnexpectedEof);
        }
        if chunk.len() > max_len {
            return Err(TransferError::ReadOverrun {
                requested: max_len,
                actual: chunk.len(),
            });
        }
        write_fully(stream, &chunk, &cancel_flag).await?;
        offset += chunk.len() as u64;

        if let Some(ref cb) = on_progress {
            cb(ProgressUpdate {
                transfer_id,
                item_id: Some(item_id),
                bytes_transferred: offset,
                total_bytes: meta.size,
            });
        }
    }

    check_cancelled(&cancel_flag)?;
    stream.close_write().await?;
    Ok(offset)
}

pub async fn receive_file_item_stream(
    stream: &mut Box<dyn DuplexStream>,
    expected_session_id: [u8; 16],
    expected_transfer_id: [u8; 16],
    expected_item_id: u32,
    expected_size: u64,
    sink: &mut Box<dyn IncomingFileSink>,
    cancel_flag: Arc<AtomicBool>,
    on_progress: Option<&ProgressCallback>,
) -> Result<u64, TransferError> {
    let mut header_buf = [0u8; FILE_HEADER_LEN];
    let mut read_header = 0;
    while read_header < FILE_HEADER_LEN {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(TransferError::Cancelled);
        }
        let n = read_checked(stream, &mut header_buf[read_header..]).await?;
        if n == 0 {
            return Err(TransferError::UnexpectedEof);
        }
        read_header += n;
    }

    let header = FileDataHeader::decode(&header_buf)?;
    if header.session_id != expected_session_id {
        return Err(TransferError::SessionMismatch);
    }
    if header.transfer_id != expected_transfer_id {
        return Err(TransferError::TransferMismatch);
    }
    if header.item_id != expected_item_id {
        return Err(TransferError::ItemMismatch {
            expected: expected_item_id,
            actual: header.item_id,
        });
    }
    if header.payload_size != expected_size {
        return Err(TransferError::SizeMismatch {
            expected: expected_size,
            actual: header.payload_size,
        });
    }

    let mut total_read = 0;
    let mut buf = [0u8; CHUNK_SIZE_BYTES];

    while total_read < expected_size {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(TransferError::Cancelled);
        }
        let needed = (expected_size - total_read).min(CHUNK_SIZE_BYTES as u64) as usize;
        let n = read_checked(stream, &mut buf[..needed]).await?;
        if n == 0 {
            return Err(TransferError::UnexpectedEof);
        }
        write_sink_fully(sink, &buf[..n], &cancel_flag).await?;
        total_read += n as u64;

        if let Some(ref cb) = on_progress {
            cb(ProgressUpdate {
                transfer_id: expected_transfer_id,
                item_id: Some(expected_item_id),
                bytes_transferred: total_read,
                total_bytes: expected_size,
            });
        }
    }

    Ok(total_read)
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
