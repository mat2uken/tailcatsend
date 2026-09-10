use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tailsend_platform_api::{
    FileSource, IncomingFileSink, ReceivedItem, StorageError, MAX_FILE_NAME_HEADER_BYTES,
};
use tailsend_protocol::filename::sanitize_filename;
use tailsend_protocol::limits::{CHUNK_SIZE_BYTES, MAX_FILENAME_BYTES, MAX_TEXT_PAYLOAD_SIZE};
use tailsend_transport_api::DuplexStream;

use crate::io::{check_cancelled, read_checked, write_fully, write_sink_fully};
use crate::{ProgressCallback, ProgressUpdate, TransferError};

/// The live file stream used by the existing mobile and browser clients.
pub const FILE_NAME_HEADER_PREFIX: &[u8] = b"NAME:";

/// A parsed `NAME:<filename>:<size>\n` header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamedFileHeader {
    pub name: String,
    pub size: u64,
}

/// Result of a live file receive.  The header is kept alongside the platform
/// result so callers can display the sender's name while still using the
/// platform-selected unique destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceivedNamedFile {
    pub header: NamedFileHeader,
    pub item: ReceivedItem,
}

/// Parse one complete live file header.  The last colon separates the name
/// and size because colons are valid in names on some of the sending
/// platforms.  The resulting name is sanitized before it is exposed to a
/// platform sink.
pub fn parse_name_header(bytes: &[u8]) -> Result<NamedFileHeader, TransferError> {
    if bytes.len() > MAX_FILE_NAME_HEADER_BYTES {
        return Err(TransferError::NameHeaderTooLarge);
    }

    let line = bytes
        .strip_suffix(b"\n")
        .ok_or_else(|| TransferError::InvalidNameHeader("missing newline".to_string()))?;
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let line = std::str::from_utf8(line)
        .map_err(|_| TransferError::InvalidNameHeader("header is not UTF-8".to_string()))?;
    let rest = line
        .strip_prefix("NAME:")
        .ok_or_else(|| TransferError::InvalidNameHeader("missing NAME prefix".to_string()))?;
    let (raw_name, raw_size) = rest
        .rsplit_once(':')
        .ok_or_else(|| TransferError::InvalidNameHeader("missing file size".to_string()))?;
    let size = raw_size
        .parse::<u64>()
        .map_err(|_| TransferError::InvalidNameHeader("invalid file size".to_string()))?;
    let name = sanitize_filename(raw_name)
        .map_err(|error| TransferError::InvalidNameHeader(error.to_string()))?;
    if name.as_bytes().len() > MAX_FILENAME_BYTES {
        return Err(TransferError::InvalidNameHeader(
            "sanitized filename is too long".to_string(),
        ));
    }

    Ok(NamedFileHeader { name, size })
}

/// Encode the live file header used by the already released clients.
pub fn encode_name_header(
    metadata: &tailsend_platform_api::FileMetadata,
) -> Result<Vec<u8>, TransferError> {
    let name = sanitize_filename(&metadata.name)
        .map_err(|error| TransferError::InvalidNameHeader(error.to_string()))?;
    let header = format!("NAME:{}:{}\n", name, metadata.size);
    if header.as_bytes().len() > MAX_FILE_NAME_HEADER_BYTES {
        return Err(TransferError::NameHeaderTooLarge);
    }
    Ok(header.into_bytes())
}

/// Decoder for the persistent text stream on port 101.  A caller can feed it
/// whatever chunks its transport returns; newline-delimited messages are
/// emitted immediately and a final unterminated message is emitted by
/// `finish`.
#[derive(Debug, Default)]
pub struct TextMessageDecoder {
    pending: Vec<u8>,
}

impl TextMessageDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, TransferError> {
        let mut messages = Vec::new();
        // Scan the input once and enforce the limit before allocating. The
        // old split_off loop copied the entire remainder for every newline.
        for part in bytes.split_inclusive(|byte| *byte == b'\n') {
            let complete = part.last() == Some(&b'\n');
            let content = if complete {
                &part[..part.len() - 1]
            } else {
                part
            };
            if content.len() > MAX_TEXT_PAYLOAD_SIZE as usize - self.pending.len() {
                self.pending.clear();
                return Err(TransferError::TextTooLarge);
            }
            self.pending.extend_from_slice(content);
            if complete {
                if self.pending.last() == Some(&b'\r') {
                    self.pending.pop();
                }
                messages.push(
                    String::from_utf8(std::mem::take(&mut self.pending))
                        .map_err(|_| TransferError::InvalidUtf8)?,
                );
            }
        }
        Ok(messages)
    }

    pub fn finish(&mut self) -> Result<Vec<String>, TransferError> {
        if self.pending.is_empty() {
            return Ok(Vec::new());
        }
        if self.pending.len() > MAX_TEXT_PAYLOAD_SIZE as usize {
            return Err(TransferError::TextTooLarge);
        }
        let line = std::mem::take(&mut self.pending);
        let line = line.strip_suffix(b"\r").unwrap_or(&line);
        Ok(vec![
            String::from_utf8(line.to_vec()).map_err(|_| TransferError::InvalidUtf8)?
        ])
    }
}

struct BufferedStream<'a> {
    stream: &'a mut Box<dyn DuplexStream>,
    pending: Vec<u8>,
    pending_offset: usize,
}

impl<'a> BufferedStream<'a> {
    fn new(stream: &'a mut Box<dyn DuplexStream>) -> Self {
        Self {
            stream,
            pending: Vec::new(),
            pending_offset: 0,
        }
    }

    fn pending_len(&self) -> usize {
        self.pending.len().saturating_sub(self.pending_offset)
    }

    async fn read(&mut self, destination: &mut [u8]) -> Result<usize, TransferError> {
        if destination.is_empty() {
            return Ok(0);
        }
        let available = self.pending.len().saturating_sub(self.pending_offset);
        if available > 0 {
            let count = available.min(destination.len());
            destination[..count]
                .copy_from_slice(&self.pending[self.pending_offset..self.pending_offset + count]);
            self.pending_offset += count;
            if self.pending_offset == self.pending.len() {
                self.pending.clear();
                self.pending_offset = 0;
            }
            return Ok(count);
        }
        read_checked(self.stream, destination).await
    }

    async fn read_name_header(
        &mut self,
        cancel_flag: &AtomicBool,
    ) -> Result<NamedFileHeader, TransferError> {
        let mut header = Vec::with_capacity(128);
        let mut buffer = [0u8; CHUNK_SIZE_BYTES];
        loop {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err(TransferError::Cancelled);
            }
            let count = self.read(&mut buffer).await?;
            if count == 0 {
                return Err(TransferError::UnexpectedEof);
            }
            let newline = buffer[..count].iter().position(|byte| *byte == b'\n');
            match newline {
                Some(position) => {
                    header.extend_from_slice(&buffer[..=position]);
                    self.pending.extend_from_slice(&buffer[position + 1..count]);
                    self.pending_offset = 0;
                    return parse_name_header(&header);
                }
                None => {
                    header.extend_from_slice(&buffer[..count]);
                    if header.len() >= MAX_FILE_NAME_HEADER_BYTES {
                        return Err(TransferError::NameHeaderTooLarge);
                    }
                }
            }
        }
    }
}

async fn receive_named_body(
    reader: &mut BufferedStream<'_>,
    header: &NamedFileHeader,
    sink: &mut Box<dyn IncomingFileSink>,
    cancel_flag: &AtomicBool,
    transfer_id: [u8; 16],
    on_progress: Option<&ProgressCallback>,
) -> Result<u64, TransferError> {
    let mut total = 0u64;
    let mut buffer = [0u8; CHUNK_SIZE_BYTES];
    while total < header.size {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(TransferError::Cancelled);
        }
        let needed = (header.size - total).min(buffer.len() as u64) as usize;
        let count = reader.read(&mut buffer[..needed]).await?;
        if count == 0 {
            return Err(TransferError::UnexpectedEof);
        }
        if count > needed {
            return Err(TransferError::ReadOverrun {
                requested: needed,
                actual: count,
            });
        }

        write_sink_fully(sink, &buffer[..count], cancel_flag).await?;
        total += count as u64;
        if let Some(callback) = on_progress {
            callback(ProgressUpdate {
                transfer_id,
                item_id: None,
                bytes_transferred: total,
                total_bytes: header.size,
            });
        }
    }
    check_cancelled(cancel_flag)?;
    Ok(total)
}

/// Send one live file using `NAME:<filename>:<size>\n` followed by the body.
/// The source's `read_into` hook lets native adapters fill the reusable
/// transfer buffer directly while retaining compatibility with old sources.
/// The returned count confirms transport writes, not the receiver's save.
pub async fn send_named_file_stream(
    stream: &mut Box<dyn DuplexStream>,
    source: &mut Box<dyn FileSource>,
    transfer_id: [u8; 16],
    cancel_flag: Arc<AtomicBool>,
    on_progress: Option<&ProgressCallback>,
) -> Result<u64, TransferError> {
    check_cancelled(&cancel_flag)?;
    let metadata = source.metadata();
    let header = encode_name_header(&metadata)?;
    write_fully(stream, &header, &cancel_flag).await?;

    let mut offset = 0u64;
    let mut buffer = [0u8; CHUNK_SIZE_BYTES];
    while offset < metadata.size {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(TransferError::Cancelled);
        }
        let needed = (metadata.size - offset).min(buffer.len() as u64) as usize;
        let count = source.read_into(offset, &mut buffer[..needed]).await?;
        if count == 0 {
            return Err(TransferError::UnexpectedEof);
        }
        if count > needed {
            return Err(TransferError::ReadOverrun {
                requested: needed,
                actual: count,
            });
        }
        write_fully(stream, &buffer[..count], &cancel_flag).await?;
        offset += count as u64;
        if let Some(callback) = on_progress {
            callback(ProgressUpdate {
                transfer_id,
                item_id: None,
                bytes_transferred: offset,
                total_bytes: metadata.size,
            });
        }
    }
    check_cancelled(&cancel_flag)?;
    stream.close_write().await?;
    Ok(offset)
}

/// Receive a live file and let the caller create a platform sink after its
/// sanitized header is known.  The sink is committed only after exactly the
/// declared number of bytes and EOF have arrived. Receive failures abort the
/// prepared sink; a consuming `commit` must clean up its own storage errors.
pub async fn receive_named_file_stream_with_factory<Prepare, PrepareFuture>(
    stream: &mut Box<dyn DuplexStream>,
    prepare: Prepare,
    transfer_id: [u8; 16],
    expected_size: Option<u64>,
    cancel_flag: Arc<AtomicBool>,
    on_progress: Option<&ProgressCallback>,
) -> Result<ReceivedNamedFile, TransferError>
where
    Prepare: FnOnce(&NamedFileHeader) -> PrepareFuture,
    PrepareFuture: Future<Output = Result<Box<dyn IncomingFileSink>, StorageError>>,
{
    let mut reader = BufferedStream::new(stream);
    let header = reader.read_name_header(&cancel_flag).await?;
    if let Some(expected_size) = expected_size {
        if header.size != expected_size {
            return Err(TransferError::SizeMismatch {
                expected: expected_size,
                actual: header.size,
            });
        }
    }
    check_cancelled(&cancel_flag)?;
    let mut sink = prepare(&header).await.map_err(TransferError::Storage)?;
    let body_result = receive_named_body(
        &mut reader,
        &header,
        &mut sink,
        &cancel_flag,
        transfer_id,
        on_progress,
    )
    .await;
    match body_result {
        Ok(_) => {}
        Err(error) => {
            let _ = sink.abort().await;
            return Err(error);
        }
    }
    if reader.pending_len() != 0 {
        let actual = header.size.saturating_add(reader.pending_len() as u64);
        let _ = sink.abort().await;
        return Err(TransferError::SizeMismatch {
            expected: header.size,
            actual,
        });
    }
    // Do not wait for a separate EOF read here. Tailcat can delay propagating
    // the sender's half-close even after every declared byte has arrived, and
    // waiting would leave a successfully received file stuck in "transferring".
    // Excess bytes delivered with the body are already retained in
    // `reader.pending` and rejected above. A later stream read belongs to the
    // next protocol operation and is intentionally not consumed here.
    if let Err(error) = check_cancelled(&cancel_flag) {
        let _ = sink.abort().await;
        return Err(error);
    }
    match sink.commit().await {
        Ok(item) => Ok(ReceivedNamedFile { header, item }),
        Err(error) => Err(TransferError::Storage(error)),
    }
}

/// Convenience form for callers that already prepared a sink.
pub async fn receive_named_file_stream(
    stream: &mut Box<dyn DuplexStream>,
    sink: Box<dyn IncomingFileSink>,
    transfer_id: [u8; 16],
    expected_size: Option<u64>,
    cancel_flag: Arc<AtomicBool>,
    on_progress: Option<&ProgressCallback>,
) -> Result<ReceivedNamedFile, TransferError> {
    let mut prepared = Some(sink);
    let result = receive_named_file_stream_with_factory(
        stream,
        |_| std::future::ready(Ok(prepared.take().expect("prepare called once"))),
        transfer_id,
        expected_size,
        cancel_flag,
        on_progress,
    )
    .await;
    // A rejected header never reaches the factory, but the caller already
    // opened a destination which still needs explicit cleanup.
    if let Some(sink) = prepared {
        let _ = sink.abort().await;
    }
    result
}

/// Send one newline-terminated text message on the persistent text stream.
pub async fn send_live_text_stream(
    stream: &mut Box<dyn DuplexStream>,
    text: &str,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), TransferError> {
    if text.as_bytes().len() > MAX_TEXT_PAYLOAD_SIZE as usize {
        return Err(TransferError::TextTooLarge);
    }
    if cancel_flag.load(Ordering::Relaxed) {
        return Err(TransferError::Cancelled);
    }
    write_fully(stream, text.as_bytes(), &cancel_flag).await?;
    write_fully(stream, b"\n", &cancel_flag).await?;
    Ok(())
}

/// Deliver each newline-delimited message as soon as it arrives. Persistent
/// connections must not retain every message or wait for EOF to update the UI.
/// Adapters with transient read timeouts can drive `TextMessageDecoder` directly.
pub async fn receive_live_text_stream<OnMessage>(
    stream: &mut Box<dyn DuplexStream>,
    cancel_flag: Arc<AtomicBool>,
    mut on_message: OnMessage,
) -> Result<(), TransferError>
where
    OnMessage: FnMut(String),
{
    let mut decoder = TextMessageDecoder::new();
    let mut buffer = [0u8; CHUNK_SIZE_BYTES];
    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(TransferError::Cancelled);
        }
        let count = stream.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        if count > buffer.len() {
            return Err(TransferError::ReadOverrun {
                requested: buffer.len(),
                actual: count,
            });
        }
        for message in decoder.push(&buffer[..count])? {
            on_message(message);
        }
    }
    check_cancelled(&cancel_flag)?;
    for message in decoder.finish()? {
        on_message(message);
    }
    Ok(())
}
