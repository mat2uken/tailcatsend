use crate::TransferError;
use std::sync::atomic::{AtomicBool, Ordering};
use tailsend_platform_api::IncomingFileSink;
use tailsend_transport_api::DuplexStream;

pub(crate) fn check_cancelled(cancel: &AtomicBool) -> Result<(), TransferError> {
    if cancel.load(Ordering::Acquire) {
        Err(TransferError::Cancelled)
    } else {
        Ok(())
    }
}

pub(crate) async fn read_checked(
    stream: &mut Box<dyn DuplexStream>,
    buffer: &mut [u8],
) -> Result<usize, TransferError> {
    let count = stream.read(buffer).await?;
    if count > buffer.len() {
        return Err(TransferError::ReadOverrun {
            requested: buffer.len(),
            actual: count,
        });
    }
    Ok(count)
}

pub(crate) async fn write_fully(
    stream: &mut Box<dyn DuplexStream>,
    bytes: &[u8],
    cancel: &AtomicBool,
) -> Result<(), TransferError> {
    let mut offset = 0;
    while offset < bytes.len() {
        check_cancelled(cancel)?;
        let remaining = &bytes[offset..];
        let written = stream.write(remaining).await?;
        if written == 0 {
            return Err(TransferError::WriteZero);
        }
        if written > remaining.len() {
            return Err(TransferError::WriteOverrun {
                requested: remaining.len(),
                actual: written,
            });
        }
        offset += written;
    }
    check_cancelled(cancel)
}

pub(crate) async fn write_sink_fully(
    sink: &mut Box<dyn IncomingFileSink>,
    bytes: &[u8],
    cancel: &AtomicBool,
) -> Result<(), TransferError> {
    let mut offset = 0;
    while offset < bytes.len() {
        check_cancelled(cancel)?;
        let remaining = &bytes[offset..];
        let written = sink.write_chunk(remaining).await?;
        if written == 0 {
            return Err(TransferError::WriteZero);
        }
        if written > remaining.len() {
            return Err(TransferError::SinkWriteOverrun {
                requested: remaining.len(),
                actual: written,
            });
        }
        offset += written;
    }
    check_cancelled(cancel)
}
