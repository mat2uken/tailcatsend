use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use thiserror::Error;

use tailsend_platform_api::{FileSource, IncomingFileSink, StorageError};
use tailsend_protocol::data_header::{
    DataHeaderError, FileDataHeader, TextDataHeader, FILE_HEADER_LEN, TEXT_HEADER_LEN,
};
use tailsend_protocol::limits::CHUNK_SIZE_BYTES;
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
}

pub struct ProgressUpdate {
    pub transfer_id: [u8; 16],
    pub item_id: Option<u32>,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
}

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

    stream.write_all(&header_bytes).await?;

    // Send payload
    let mut offset = 0;
    while offset < bytes.len() {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(TransferError::Cancelled);
        }
        let chunk_end = (offset + CHUNK_SIZE_BYTES).min(bytes.len());
        let chunk = &bytes[offset..chunk_end];
        stream.write_all(chunk).await?;
        offset = chunk_end;
    }

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
        let n = stream.read(&mut header_buf[read_header..]).await?;
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
        let n = stream.read(&mut buf[..needed]).await?;
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

    stream.write_all(&header_bytes).await?;

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
        stream.write_all(&chunk).await?;
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
        let n = stream.read(&mut header_buf[read_header..]).await?;
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
        let n = stream.read(&mut buf[..needed]).await?;
        if n == 0 {
            return Err(TransferError::UnexpectedEof);
        }
        sink.write(&buf[..n]).await?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use bytes::Bytes;
    use futures::channel::mpsc::{unbounded, UnboundedReceiver, UnboundedSender};
    use futures::StreamExt;
    use std::sync::Mutex;
    use tailsend_platform_api::{FileMetadata, ReceivedItem};

    struct InMemDuplex {
        tx: UnboundedSender<Vec<u8>>,
        rx: UnboundedReceiver<Vec<u8>>,
        buf: Vec<u8>,
    }

    impl InMemDuplex {
        fn pair() -> (Box<dyn DuplexStream>, Box<dyn DuplexStream>) {
            let (tx1, rx1) = unbounded();
            let (tx2, rx2) = unbounded();
            (
                Box::new(Self {
                    tx: tx2,
                    rx: rx1,
                    buf: Vec::new(),
                }),
                Box::new(Self {
                    tx: tx1,
                    rx: rx2,
                    buf: Vec::new(),
                }),
            )
        }
    }

    #[async_trait]
    impl DuplexStream for InMemDuplex {
        async fn read(&mut self, buf: &mut [u8]) -> Result<usize, TransportError> {
            if !self.buf.is_empty() {
                let to_copy = buf.len().min(self.buf.len());
                buf[..to_copy].copy_from_slice(&self.buf[..to_copy]);
                self.buf.drain(..to_copy);
                return Ok(to_copy);
            }
            match self.rx.next().await {
                Some(data) => {
                    let to_copy = buf.len().min(data.len());
                    buf[..to_copy].copy_from_slice(&data[..to_copy]);
                    if data.len() > to_copy {
                        self.buf.extend_from_slice(&data[to_copy..]);
                    }
                    Ok(to_copy)
                }
                None => Ok(0),
            }
        }

        async fn write_all(&mut self, buf: &[u8]) -> Result<(), TransportError> {
            self.tx
                .unbounded_send(buf.to_vec())
                .map_err(|_| TransportError::Closed)
        }

        async fn close_write(&mut self) -> Result<(), TransportError> {
            self.tx.close_channel();
            Ok(())
        }

        async fn close(&mut self) -> Result<(), TransportError> {
            self.tx.close_channel();
            self.rx.close();
            Ok(())
        }
    }

    struct InMemSource {
        data: Vec<u8>,
        name: String,
    }

    #[async_trait]
    impl FileSource for InMemSource {
        fn metadata(&self) -> FileMetadata {
            FileMetadata {
                name: self.name.clone(),
                size: self.data.len() as u64,
                mime: Some("application/octet-stream".to_string()),
                modified_unix_ms: None,
            }
        }

        async fn read_at(&mut self, offset: u64, max_len: usize) -> Result<Bytes, StorageError> {
            let start = offset as usize;
            if start >= self.data.len() {
                return Ok(Bytes::new());
            }
            let end = (start + max_len).min(self.data.len());
            Ok(Bytes::copy_from_slice(&self.data[start..end]))
        }

        async fn close(&mut self) {}
    }

    struct InMemSink {
        data: Arc<Mutex<Vec<u8>>>,
        committed: Arc<Mutex<bool>>,
        name: String,
    }

    #[async_trait]
    impl IncomingFileSink for InMemSink {
        async fn write(&mut self, buf: &[u8]) -> Result<(), StorageError> {
            self.data.lock().unwrap().extend_from_slice(buf);
            Ok(())
        }

        async fn commit(self: Box<Self>) -> Result<ReceivedItem, StorageError> {
            let len = self.data.lock().unwrap().len() as u64;
            *self.committed.lock().unwrap() = true;
            Ok(ReceivedItem {
                name: self.name.clone(),
                size: len,
                local_path_or_handle: format!("/in-mem/{}", self.name),
            })
        }

        async fn abort(self: Box<Self>) -> Result<(), StorageError> {
            self.data.lock().unwrap().clear();
            Ok(())
        }
    }

    #[tokio::test]
    async fn test_text_stream_large_multichunk() {
        let (mut sender_stream, mut receiver_stream) = InMemDuplex::pair();
        let session_id = [1u8; 16];
        let transfer_id = [2u8; 16];

        // 150 KiB text (exceeds 2 chunks of 64 KiB)
        let large_text = "TailSend-chunked-data-".repeat(7000);
        let cancel = Arc::new(AtomicBool::new(false));

        let text_to_send = large_text.clone();
        let s_cancel = cancel.clone();
        let send_task = tokio::spawn(async move {
            send_text_stream(&mut sender_stream, session_id, transfer_id, &text_to_send, s_cancel)
                .await
        });

        let r_cancel = cancel.clone();
        let recv_task = tokio::spawn(async move {
            receive_text_stream(&mut receiver_stream, session_id, transfer_id, r_cancel).await
        });

        let (send_res, recv_res) = tokio::join!(send_task, recv_task);
        send_res.unwrap().expect("send text");
        let received = recv_res.unwrap().expect("recv text");
        assert_eq!(received, large_text);
    }

    #[tokio::test]
    async fn test_text_stream_cancellation() {
        let (mut sender_stream, mut receiver_stream) = InMemDuplex::pair();
        let session_id = [1u8; 16];
        let transfer_id = [2u8; 16];

        let cancel = Arc::new(AtomicBool::new(true)); // Pre-cancelled

        let s_cancel = cancel.clone();
        let send_task = tokio::spawn(async move {
            send_text_stream(&mut sender_stream, session_id, transfer_id, "Hello", s_cancel).await
        });

        let r_cancel = cancel.clone();
        let recv_task = tokio::spawn(async move {
            receive_text_stream(&mut receiver_stream, session_id, transfer_id, r_cancel).await
        });

        let (send_res, recv_res) = tokio::join!(send_task, recv_task);
        let s_err = send_res.unwrap().unwrap_err();
        assert!(matches!(s_err, TransferError::Cancelled));

        let r_err = recv_res.unwrap().unwrap_err();
        assert!(matches!(r_err, TransferError::Cancelled));
    }

    #[tokio::test]
    async fn test_file_stream_various_sizes_and_progress() {
        let test_sizes = [0, 1, 1024, 65535, 65536, 65537, 150000];

        for size in test_sizes {
            let (mut sender_stream, mut receiver_stream) = InMemDuplex::pair();
            let session_id = [3u8; 16];
            let transfer_id = [4u8; 16];
            let item_id = 42;

            let test_data = (0..size).map(|i| (i % 256) as u8).collect::<Vec<u8>>();
            let mut source: Box<dyn FileSource> = Box::new(InMemSource {
                data: test_data.clone(),
                name: format!("file_{}.bin", size),
            });

            let sink_data = Arc::new(Mutex::new(Vec::new()));
            let sink_committed = Arc::new(Mutex::new(false));
            let mut sink: Box<dyn IncomingFileSink> = Box::new(InMemSink {
                data: sink_data.clone(),
                committed: sink_committed.clone(),
                name: format!("file_{}.bin", size),
            });

            let cancel = Arc::new(AtomicBool::new(false));
            let progress_bytes = Arc::new(Mutex::new(0u64));
            let p_bytes = progress_bytes.clone();
            let progress_cb: ProgressCallback = Box::new(move |p: ProgressUpdate| {
                *p_bytes.lock().unwrap() = p.bytes_transferred;
            });

            let s_cancel = cancel.clone();
            let send_task = tokio::spawn(async move {
                send_file_item_stream(
                    &mut sender_stream,
                    session_id,
                    transfer_id,
                    item_id,
                    &mut source,
                    s_cancel,
                    Some(&progress_cb),
                )
                .await
            });

            let r_cancel = cancel.clone();
            let recv_task = tokio::spawn(async move {
                receive_file_item_stream(
                    &mut receiver_stream,
                    session_id,
                    transfer_id,
                    item_id,
                    size as u64,
                    &mut sink,
                    r_cancel,
                    None,
                )
                .await
            });

            let (send_res, recv_res) = tokio::join!(send_task, recv_task);
            send_res.unwrap().expect("send file");
            let total_recv = recv_res.unwrap().expect("recv file");
            assert_eq!(total_recv, size as u64);
            assert_eq!(*sink_data.lock().unwrap(), test_data);
        }
    }
}
