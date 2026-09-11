//! Thin native `TailcatTransport` adapter over the shared Go C ABI.
//!
//! The adapter owns no protocol state. It only turns the handle based C API
//! into the async stream/listener traits consumed by the common Rust session
//! and transfer code. Read/write payloads are borrowed only for the duration
//! of the C ABI call; lifecycle operations still use a blocking task because
//! they do not carry a caller buffer.

use std::sync::atomic::AtomicU8;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::runtime::{Handle, RuntimeFlavor};

use tailsend_native_bridge::{
    status, TcEvent, TcHandle, TC_BUFFER_TOO_SMALL, TC_CANCELLED, TC_EOF, TC_EVENT_INCOMING_STREAM,
    TC_EVENT_LISTENER_ERROR, TC_EVENT_STREAM_ERROR, TC_INVALID_HANDLE_ERROR, TC_NETWORK_ERROR,
    TC_OK, TC_PROTOCOL_ERROR, TC_TIMEOUT,
};
use tailsend_transport_api::{
    CancellationCallback, DuplexStream, IncomingStream, ListenOptions, Listener, TailcatTransport,
    TransportError, TransportPath,
};

const IO_TIMEOUT_MS: u32 = 30_000;

fn transport_error(code: i32) -> TransportError {
    match code {
        TC_EOF | TC_INVALID_HANDLE_ERROR => TransportError::Closed,
        TC_TIMEOUT => TransportError::Timeout,
        TC_CANCELLED => TransportError::Cancelled,
        TC_NETWORK_ERROR => TransportError::Unreachable(format!("Tailcat bridge status {code}")),
        TC_PROTOCOL_ERROR => TransportError::Protocol(format!("Tailcat bridge status {code}")),
        _ => TransportError::Internal(format!("Tailcat bridge status {code}")),
    }
}

fn copy_listener_address(handle: TcHandle) -> Result<String, TransportError> {
    let mut length = 0usize;
    let first = unsafe {
        tailsend_native_bridge::tc_listener_address(handle, std::ptr::null_mut(), 0, &mut length)
    };
    if first != TC_BUFFER_TOO_SMALL && first != TC_OK {
        return Err(transport_error(first));
    }
    let mut bytes = vec![0u8; length];
    let code = unsafe {
        tailsend_native_bridge::tc_listener_address(
            handle,
            bytes.as_mut_ptr(),
            bytes.len(),
            &mut length,
        )
    };
    if code != TC_OK {
        return Err(transport_error(code));
    }
    bytes.truncate(length);
    String::from_utf8(bytes)
        .map_err(|error| TransportError::Protocol(format!("invalid Tailcat address: {error}")))
}

fn stream_transport_path(handle: TcHandle) -> TransportPath {
    let mut code = tailsend_native_bridge::TC_TRANSPORT_UNKNOWN;
    let status = unsafe { tailsend_native_bridge::tc_stream_transport(handle, &mut code) };
    if status == TC_OK {
        TransportPath::from_code(code)
    } else {
        TransportPath::Unknown
    }
}

/// Run one short native bridge call while the borrowed caller buffer is still
/// valid.  The Tauri runtime is multi-threaded, so `block_in_place` yields its
/// worker to the blocking pool without allocating a task for every chunk.
/// A current-thread runtime cannot yield a worker; keep the same call inline
/// there so tests and embedders retain correct behavior.
fn call_native<F, R>(call: F) -> R
where
    F: FnOnce() -> R,
{
    match Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(call)
        }
        _ => call(),
    }
}

/// A process-wide Go bridge owner. Calling `tc_shutdown` from an arbitrary
/// WebView teardown can interrupt another window, so shutdown remains an
/// explicit application-level operation instead of a `Drop` side effect.
#[derive(Clone, Default)]
pub struct NativeTailcatTransport;

impl NativeTailcatTransport {
    pub fn new() -> Result<Self, TransportError> {
        let code = unsafe { tailsend_native_bridge::tc_init() };
        if code == TC_OK {
            Ok(Self)
        } else {
            Err(transport_error(code))
        }
    }

    pub fn shutdown() -> Result<(), TransportError> {
        let code = unsafe { tailsend_native_bridge::tc_shutdown() };
        status(code).map_err(|error| transport_error(error.code()))
    }

    /// Start a dial operation that can be interrupted before the Tailcat
    /// connection is established. The regular trait method remains available
    /// for adapters that do not expose a cancellation token.
    pub async fn dial_cancellable(
        &self,
        address: &str,
        port: u16,
        options: ListenOptions,
        cancel: Arc<AtomicBool>,
    ) -> Result<Box<dyn DuplexStream>, TransportError> {
        let address = address.as_bytes().to_vec();
        let derp = options.derp_map_url.into_bytes();
        let result = tokio::task::spawn_blocking(move || {
            let mut operation = 0;
            let code = unsafe {
                tailsend_native_bridge::tc_stream_dial_start(
                    address.as_ptr(),
                    address.len(),
                    derp.as_ptr(),
                    derp.len(),
                    port,
                    IO_TIMEOUT_MS,
                    &mut operation,
                )
            };
            if code != TC_OK {
                return Err(transport_error(code));
            }
            loop {
                if cancel.load(Ordering::Acquire) {
                    let _ = unsafe { tailsend_native_bridge::tc_cancel(operation) };
                    return Err(TransportError::Cancelled);
                }
                let mut stream = 0;
                let code = unsafe {
                    tailsend_native_bridge::tc_stream_dial_wait(operation, 100, &mut stream)
                };
                match code {
                    TC_TIMEOUT => continue,
                    TC_OK => return Ok(NativeStream::new(stream)),
                    other => return Err(transport_error(other)),
                }
            }
        })
        .await
        .map_err(|error| {
            TransportError::Internal(format!("cancellable dial task failed: {error}"))
        })??;
        Ok(Box::new(result))
    }
}

#[async_trait::async_trait]
impl TailcatTransport for NativeTailcatTransport {
    async fn listen(&self, options: ListenOptions) -> Result<Box<dyn Listener>, TransportError> {
        let derp = options.derp_map_url.into_bytes();
        let verbose = u8::from(options.verbose);
        let result = tokio::task::spawn_blocking(move || {
            let mut handle = 0;
            let code = unsafe {
                tailsend_native_bridge::tc_listener_create(
                    derp.as_ptr(),
                    derp.len(),
                    verbose,
                    &mut handle,
                )
            };
            if code != TC_OK {
                return Err(transport_error(code));
            }
            let address = match copy_listener_address(handle) {
                Ok(address) => address,
                Err(error) => {
                    let _ = unsafe { tailsend_native_bridge::tc_listener_close(handle) };
                    return Err(error);
                }
            };
            Ok(NativeListener {
                handle,
                address,
                closed: Arc::new(AtomicBool::new(false)),
            })
        })
        .await
        .map_err(|error| TransportError::Internal(format!("listener task failed: {error}")))??;
        Ok(Box::new(result))
    }

    async fn dial(
        &self,
        address: &str,
        port: u16,
        options: ListenOptions,
    ) -> Result<Box<dyn DuplexStream>, TransportError> {
        let address = address.as_bytes().to_vec();
        let derp = options.derp_map_url.into_bytes();
        let result = tokio::task::spawn_blocking(move || {
            let mut handle = 0;
            let code = unsafe {
                tailsend_native_bridge::tc_stream_dial(
                    address.as_ptr(),
                    address.len(),
                    derp.as_ptr(),
                    derp.len(),
                    port,
                    IO_TIMEOUT_MS,
                    &mut handle,
                )
            };
            if code != TC_OK {
                return Err(transport_error(code));
            }
            Ok(NativeStream::new(handle))
        })
        .await
        .map_err(|error| TransportError::Internal(format!("dial task failed: {error}")))??;
        Ok(Box::new(result))
    }
}

struct NativeListener {
    handle: TcHandle,
    address: String,
    closed: Arc<AtomicBool>,
}

#[async_trait::async_trait]
impl Listener for NativeListener {
    fn local_address(&self) -> &str {
        &self.address
    }

    async fn accept(&self) -> Result<IncomingStream, TransportError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(TransportError::ListenerClosed);
        }
        let handle = self.handle;
        let closed = self.closed.clone();
        tokio::task::spawn_blocking(move || loop {
            if closed.load(Ordering::Acquire) {
                return Err(TransportError::ListenerClosed);
            }
            let mut event = TcEvent::default();
            let code = unsafe { tailsend_native_bridge::tc_wait_event(1_000, &mut event) };
            if code == TC_TIMEOUT {
                continue;
            }
            if code != TC_OK {
                return Err(transport_error(code));
            }
            if event.owner_handle != handle {
                if event.event_type == TC_EVENT_INCOMING_STREAM && event.object_handle != 0 {
                    let _ = unsafe { tailsend_native_bridge::tc_stream_close(event.object_handle) };
                }
                continue;
            }
            match event.event_type {
                TC_EVENT_INCOMING_STREAM => {
                    return Ok(IncomingStream {
                        stream: Box::new(NativeStream::new(event.object_handle)),
                        port: event.port,
                    });
                }
                TC_EVENT_LISTENER_ERROR | TC_EVENT_STREAM_ERROR => {
                    return Err(TransportError::Internal(format!(
                        "Tailcat listener event status {}",
                        event.status_code
                    )));
                }
                _ => {}
            }
        })
        .await
        .map_err(|error| TransportError::Internal(format!("accept task failed: {error}")))?
    }

    async fn close(&self) -> Result<(), TransportError> {
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let handle = self.handle;
        let code = tokio::task::spawn_blocking(move || unsafe {
            tailsend_native_bridge::tc_listener_close(handle)
        })
        .await
        .map_err(|error| TransportError::Internal(format!("listener close failed: {error}")))?;
        if code == TC_OK || code == TC_INVALID_HANDLE_ERROR {
            Ok(())
        } else {
            Err(transport_error(code))
        }
    }
}

impl Drop for NativeListener {
    fn drop(&mut self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            unsafe {
                let _ = tailsend_native_bridge::tc_listener_close(self.handle);
            }
        }
    }
}

struct NativeStream {
    handle: TcHandle,
    closed: Arc<AtomicBool>,
    transport_path: AtomicU8,
    /// A native Reader may return bytes together with a terminal status. Keep
    /// that status until the caller has consumed the bytes returned by the
    /// same read, then surface it on the next read.
    pending_read_status: Option<PendingReadStatus>,
}

enum PendingReadStatus {
    Eof,
    Error(TransportError),
}

impl NativeStream {
    fn new(handle: TcHandle) -> Self {
        Self {
            handle,
            closed: Arc::new(AtomicBool::new(false)),
            transport_path: AtomicU8::new(stream_transport_path(handle).code()),
            pending_read_status: None,
        }
    }
}

#[async_trait::async_trait]
impl DuplexStream for NativeStream {
    fn cancellation_callback(&self) -> Option<CancellationCallback> {
        let handle = self.handle;
        let closed = self.closed.clone();
        Some(Arc::new(move || {
            if !closed.load(Ordering::Acquire) {
                // tc_cancel closes the underlying net.Conn while retaining the
                // handle for the caller's normal tc_stream_close cleanup.
                unsafe {
                    let _ = tailsend_native_bridge::tc_cancel(handle);
                }
            }
        }))
    }

    fn transport_path(&self) -> TransportPath {
        let cached = TransportPath::from_code(self.transport_path.load(Ordering::Acquire));
        if cached != TransportPath::Unknown {
            return cached;
        }
        let refreshed = stream_transport_path(self.handle);
        if refreshed != TransportPath::Unknown {
            self.transport_path
                .store(refreshed.code(), Ordering::Release);
            return refreshed;
        }
        cached
    }

    async fn read(&mut self, buffer: &mut [u8]) -> Result<usize, TransportError> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.closed.load(Ordering::Acquire) {
            return Err(TransportError::Closed);
        }
        if let Some(status) = self.pending_read_status.take() {
            return match status {
                PendingReadStatus::Eof => Ok(0),
                PendingReadStatus::Error(error) => Err(error),
            };
        }
        let handle = self.handle;
        let (code, read) = call_native(|| {
            let mut read = 0usize;
            let code = unsafe {
                tailsend_native_bridge::tc_stream_read(
                    handle,
                    buffer.as_mut_ptr(),
                    buffer.len(),
                    &mut read,
                    IO_TIMEOUT_MS,
                )
            };
            (code, read)
        });
        if read > buffer.len() {
            return Err(TransportError::Internal(format!(
                "Tailcat read overrun: {} > {}",
                read,
                buffer.len()
            )));
        }
        if code == TC_OK {
            Ok(read)
        } else if read > 0 {
            self.pending_read_status = Some(if code == TC_EOF {
                PendingReadStatus::Eof
            } else {
                PendingReadStatus::Error(transport_error(code))
            });
            Ok(read)
        } else if code == TC_EOF {
            Ok(0)
        } else {
            Err(transport_error(code))
        }
    }

    async fn write_all(&mut self, buffer: &[u8]) -> Result<(), TransportError> {
        let mut offset = 0usize;
        while offset < buffer.len() {
            let written = self.write(&buffer[offset..]).await?;
            if written == 0 {
                return Err(TransportError::Internal(
                    "Tailcat returned zero-byte write".into(),
                ));
            }
            offset += written;
        }
        Ok(())
    }

    async fn write(&mut self, buffer: &[u8]) -> Result<usize, TransportError> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.closed.load(Ordering::Acquire) {
            return Err(TransportError::Closed);
        }
        let handle = self.handle;
        let (code, written) = call_native(|| {
            let mut written = 0usize;
            let code = unsafe {
                tailsend_native_bridge::tc_stream_write(
                    handle,
                    buffer.as_ptr(),
                    buffer.len(),
                    &mut written,
                    IO_TIMEOUT_MS,
                )
            };
            (code, written)
        });
        if written > buffer.len() {
            return Err(TransportError::Internal(format!(
                "Tailcat write overrun: {} > {}",
                written,
                buffer.len()
            )));
        }
        if code == TC_OK {
            Ok(written)
        } else if written > 0 {
            Err(TransportError::PartialWrite {
                written,
                message: transport_error(code).to_string(),
            })
        } else {
            Err(transport_error(code))
        }
    }

    async fn close_write(&mut self) -> Result<(), TransportError> {
        if self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        let handle = self.handle;
        let code = tokio::task::spawn_blocking(move || unsafe {
            tailsend_native_bridge::tc_stream_close_write(handle)
        })
        .await
        .map_err(|error| TransportError::Internal(format!("half-close task failed: {error}")))?;
        if code == TC_OK {
            Ok(())
        } else {
            Err(transport_error(code))
        }
    }

    async fn close(&mut self) -> Result<(), TransportError> {
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let handle = self.handle;
        let code = tokio::task::spawn_blocking(move || unsafe {
            tailsend_native_bridge::tc_stream_close(handle)
        })
        .await
        .map_err(|error| TransportError::Internal(format!("stream close task failed: {error}")))?;
        if code == TC_OK || code == TC_INVALID_HANDLE_ERROR {
            Ok(())
        } else {
            Err(transport_error(code))
        }
    }
}

impl Drop for NativeStream {
    fn drop(&mut self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            unsafe {
                let _ = tailsend_native_bridge::tc_stream_close(self.handle);
            }
        }
    }
}
