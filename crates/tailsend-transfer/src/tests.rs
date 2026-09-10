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
        send_text_stream(
            &mut sender_stream,
            session_id,
            transfer_id,
            &text_to_send,
            s_cancel,
        )
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
        send_text_stream(
            &mut sender_stream,
            session_id,
            transfer_id,
            "Hello",
            s_cancel,
        )
        .await
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

#[test]
fn test_live_name_header_uses_last_colon_and_sanitizes_name() {
    let header = parse_name_header(b"NAME:archive:2026.txt:42\n").unwrap();
    assert_eq!(header.name, "archive_2026.txt");
    assert_eq!(header.size, 42);

    let encoded = encode_name_header(&FileMetadata {
        name: "folder/file.txt".to_string(),
        size: 42,
        mime: None,
        modified_unix_ms: None,
    })
    .unwrap();
    assert_eq!(encoded, b"NAME:file.txt:42\n");
}

#[test]
fn test_live_name_header_rejects_unbounded_input() {
    let mut oversized = b"NAME:".to_vec();
    oversized.extend(std::iter::repeat(b'a').take(MAX_FILE_NAME_HEADER_BYTES));
    assert!(matches!(
        parse_name_header(&oversized),
        Err(TransferError::NameHeaderTooLarge)
    ));
    assert!(matches!(
        parse_name_header(b"NAME:missing-size\n"),
        Err(TransferError::InvalidNameHeader(_))
    ));
}

#[test]
fn test_text_message_decoder_handles_fragmented_lines_and_limit() {
    let mut decoder = TextMessageDecoder::new();
    assert!(decoder
        .push(b"first\nsec")
        .unwrap()
        .contains(&"first".to_string()));
    assert_eq!(decoder.push(b"ond\n").unwrap(), vec!["second"]);
    assert_eq!(decoder.finish().unwrap(), Vec::<String>::new());

    let oversized = vec![b'x'; MAX_TEXT_PAYLOAD_SIZE as usize + 1];
    assert!(matches!(
        decoder.push(&oversized),
        Err(TransferError::TextTooLarge)
    ));
}

#[tokio::test]
async fn test_live_file_stream_commits_and_preserves_header() {
    let (mut sender_stream, mut receiver_stream) = InMemDuplex::pair();
    let data = (0..150_000)
        .map(|value| (value % 251) as u8)
        .collect::<Vec<_>>();
    let data_len = data.len() as u64;
    let mut source: Box<dyn FileSource> = Box::new(InMemSource {
        data: data.clone(),
        name: "folder:payload.bin".to_string(),
    });
    let sink_data = Arc::new(Mutex::new(Vec::new()));
    let committed = Arc::new(Mutex::new(false));
    let sink: Box<dyn IncomingFileSink> = Box::new(InMemSink {
        data: sink_data.clone(),
        committed: committed.clone(),
        name: "payload.bin".to_string(),
    });
    let cancel = Arc::new(AtomicBool::new(false));
    let transfer_id = [8u8; 16];

    let send_cancel = cancel.clone();
    let send_task = tokio::spawn(async move {
        send_named_file_stream(
            &mut sender_stream,
            &mut source,
            transfer_id,
            send_cancel,
            None,
        )
        .await
    });
    let receive_cancel = cancel.clone();
    let receive_task = tokio::spawn(async move {
        receive_named_file_stream(
            &mut receiver_stream,
            sink,
            transfer_id,
            Some(data_len),
            receive_cancel,
            None,
        )
        .await
    });

    assert_eq!(send_task.await.unwrap().unwrap(), data_len);
    let received = receive_task.await.unwrap().unwrap();
    assert_eq!(received.header.name, "folder_payload.bin");
    assert_eq!(received.header.size, data.len() as u64);
    assert_eq!(received.item.size, data.len() as u64);
    assert!(*committed.lock().unwrap());
    assert_eq!(*sink_data.lock().unwrap(), data);
}

#[tokio::test]
async fn test_live_file_stream_aborts_sink_on_short_body() {
    let (mut sender_stream, mut receiver_stream) = InMemDuplex::pair();
    sender_stream
        .write_all(b"NAME:short.bin:5\n")
        .await
        .unwrap();
    sender_stream.write_all(b"12").await.unwrap();
    sender_stream.close_write().await.unwrap();

    let sink_data = Arc::new(Mutex::new(Vec::new()));
    let committed = Arc::new(Mutex::new(false));
    let sink: Box<dyn IncomingFileSink> = Box::new(InMemSink {
        data: sink_data.clone(),
        committed: committed.clone(),
        name: "short.bin".to_string(),
    });
    let result = receive_named_file_stream(
        &mut receiver_stream,
        sink,
        [9u8; 16],
        Some(5),
        Arc::new(AtomicBool::new(false)),
        None,
    )
    .await;

    assert!(matches!(result, Err(TransferError::UnexpectedEof)));
    assert!(!*committed.lock().unwrap());
    assert!(sink_data.lock().unwrap().is_empty());
}

struct FragmentedStream {
    input: Vec<u8>,
    offset: usize,
    read_limit: usize,
    writes: Arc<Mutex<Vec<u8>>>,
    cancel_on_write: Option<Arc<AtomicBool>>,
    invalid_read: bool,
}

#[async_trait]
impl DuplexStream for FragmentedStream {
    async fn read(&mut self, buffer: &mut [u8]) -> Result<usize, TransportError> {
        if self.invalid_read {
            return Ok(buffer.len() + 1);
        }
        let count = buffer
            .len()
            .min(self.read_limit)
            .min(self.input.len() - self.offset);
        buffer[..count].copy_from_slice(&self.input[self.offset..self.offset + count]);
        self.offset += count;
        Ok(count)
    }
    async fn write_all(&mut self, _: &[u8]) -> Result<(), TransportError> {
        panic!("must use partial write")
    }
    async fn write(&mut self, bytes: &[u8]) -> Result<usize, TransportError> {
        let count = bytes.len().min(2);
        self.writes
            .lock()
            .unwrap()
            .extend_from_slice(&bytes[..count]);
        if let Some(cancel) = &self.cancel_on_write {
            cancel.store(true, Ordering::Release);
        }
        Ok(count)
    }
    async fn close_write(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
    async fn close(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}

fn scripted_stream(input: &[u8], read_limit: usize) -> Box<dyn DuplexStream> {
    Box::new(FragmentedStream {
        input: input.to_vec(),
        offset: 0,
        read_limit,
        writes: Arc::default(),
        cancel_on_write: None,
        invalid_read: false,
    })
}

#[tokio::test]
async fn receive_named_file_aborts_on_header_error_or_size_mismatch() {
    for input in [b"garbage\n".as_slice(), b"NAME:file:2\n", b""] {
        let data = Arc::new(Mutex::new(vec![99]));
        let committed = Arc::new(Mutex::new(false));
        let sink = Box::new(InMemSink {
            data: data.clone(),
            committed: committed.clone(),
            name: "file".into(),
        });
        let result = receive_named_file_stream(
            &mut scripted_stream(input, 1),
            sink,
            [1; 16],
            Some(3),
            Arc::new(AtomicBool::new(false)),
            None,
        )
        .await;
        assert!(result.is_err());
        assert!(
            data.lock().unwrap().is_empty(),
            "prepared sink must be aborted even before factory invocation"
        );
        assert!(!*committed.lock().unwrap());
    }
}

#[tokio::test]
async fn receive_named_file_cancellation_on_last_progress_aborts() {
    let cancel = Arc::new(AtomicBool::new(false));
    let token = cancel.clone();
    let on_progress: ProgressCallback = Box::new(move |_| token.store(true, Ordering::Release));
    let data = Arc::new(Mutex::new(Vec::new()));
    let committed = Arc::new(Mutex::new(false));
    let sink = Box::new(InMemSink {
        data: data.clone(),
        committed: committed.clone(),
        name: "file".into(),
    });
    let result = receive_named_file_stream(
        &mut scripted_stream(b"NAME:file:3\nabc", 64),
        sink,
        [1; 16],
        None,
        cancel,
        Some(&on_progress),
    )
    .await;
    assert!(matches!(result, Err(TransferError::Cancelled)));
    assert!(data.lock().unwrap().is_empty());
    assert!(!*committed.lock().unwrap());
}

#[tokio::test]
async fn receive_named_file_handles_split_and_coalesced_header() {
    for limit in [1, 2, 16, 64] {
        let data = Arc::new(Mutex::new(Vec::new()));
        let committed = Arc::new(Mutex::new(false));
        let sink = Box::new(InMemSink {
            data: data.clone(),
            committed: committed.clone(),
            name: "file".into(),
        });
        receive_named_file_stream(
            &mut scripted_stream(b"NAME:file:3\nabc", limit),
            sink,
            [1; 16],
            None,
            Arc::new(AtomicBool::new(false)),
            None,
        )
        .await
        .unwrap();
        assert_eq!(*data.lock().unwrap(), b"abc");
        assert!(*committed.lock().unwrap());
    }
}

#[tokio::test]
async fn cancelled_empty_file_never_sends_a_header() {
    let writes = Arc::new(Mutex::new(Vec::new()));
    let mut stream: Box<dyn DuplexStream> = Box::new(FragmentedStream {
        input: vec![],
        offset: 0,
        read_limit: 1,
        writes: writes.clone(),
        cancel_on_write: None,
        invalid_read: false,
    });
    let mut source: Box<dyn FileSource> = Box::new(InMemSource {
        data: vec![],
        name: "empty".into(),
    });
    let result = send_named_file_stream(
        &mut stream,
        &mut source,
        [1; 16],
        Arc::new(AtomicBool::new(true)),
        None,
    )
    .await;
    assert!(matches!(result, Err(TransferError::Cancelled)));
    assert!(writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn partial_write_checks_cancellation_before_retrying() {
    let cancel = Arc::new(AtomicBool::new(false));
    let writes = Arc::new(Mutex::new(Vec::new()));
    let mut stream: Box<dyn DuplexStream> = Box::new(FragmentedStream {
        input: vec![],
        offset: 0,
        read_limit: 1,
        writes: writes.clone(),
        cancel_on_write: Some(cancel.clone()),
        invalid_read: false,
    });
    let result = send_live_text_stream(&mut stream, "hello", cancel).await;
    assert!(matches!(result, Err(TransferError::Cancelled)));
    assert_eq!(*writes.lock().unwrap(), b"he");
}

#[tokio::test]
async fn named_header_rejects_invalid_adapter_count_without_panicking() {
    let mut stream: Box<dyn DuplexStream> = Box::new(FragmentedStream {
        input: vec![],
        offset: 0,
        read_limit: 1,
        writes: Arc::default(),
        cancel_on_write: None,
        invalid_read: true,
    });
    let result = receive_named_file_stream_with_factory(
        &mut stream,
        |_| async { panic!("invalid header must not open a sink") },
        [1; 16],
        None,
        Arc::new(AtomicBool::new(false)),
        None,
    )
    .await;
    assert!(matches!(result, Err(TransferError::ReadOverrun { .. })));
}

#[test]
fn decoder_rejects_large_fragment_before_retaining_it_and_handles_many_lines() {
    let mut decoder = TextMessageDecoder::new();
    let huge = vec![b'a'; MAX_TEXT_PAYLOAD_SIZE as usize + 1];
    assert!(matches!(
        decoder.push(&huge),
        Err(TransferError::TextTooLarge)
    ));
    assert!(decoder.finish().unwrap().is_empty());
    let many = b"ok\n".repeat(10_000);
    assert_eq!(decoder.push(&many).unwrap(), vec!["ok"; 10_000]);
}

#[tokio::test]
async fn oversized_body_is_rejected_independently_of_packet_splits() {
    // The excess bytes must be visible in the same transport read as the
    // declared body. A later read may block until the sender closes the
    // stream, so the live engine deliberately does not wait for it after the
    // declared size has been consumed.
    for limit in [64] {
        let data = Arc::new(Mutex::new(Vec::new()));
        let committed = Arc::new(Mutex::new(false));
        let sink = Box::new(InMemSink {
            data: data.clone(),
            committed: committed.clone(),
            name: "file".into(),
        });
        let result = receive_named_file_stream(
            &mut scripted_stream(b"NAME:file:3\nabcd", limit),
            sink,
            [1; 16],
            None,
            Arc::new(AtomicBool::new(false)),
            None,
        )
        .await;
        assert!(matches!(
            result,
            Err(TransferError::SizeMismatch { expected: 3, .. })
        ));
        assert!(data.lock().unwrap().is_empty());
        assert!(!*committed.lock().unwrap());
    }
}

#[tokio::test]
async fn live_text_is_delivered_before_the_connection_closes() {
    let (mut sender, mut receiver) = InMemDuplex::pair();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        receive_live_text_stream(&mut receiver, Arc::new(AtomicBool::new(false)), |message| {
            tx.send(message).unwrap();
        })
        .await
    });
    sender.write_all(b"first\n").await.unwrap();
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap(),
        "first"
    );
    sender.write_all(b"last").await.unwrap();
    sender.close_write().await.unwrap();
    task.await.unwrap().unwrap();
    assert_eq!(rx.recv().await.unwrap(), "last");
}
