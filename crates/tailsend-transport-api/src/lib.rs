use async_trait::async_trait;
use thiserror::Error;

/// Native streams can cross I/O threads.  Browser streams stay inside one
/// Worker and intentionally do not require `Send + Sync`.
#[cfg(target_arch = "wasm32")]
pub trait TransportThreadSafety {}

#[cfg(target_arch = "wasm32")]
impl<T: ?Sized> TransportThreadSafety for T {}

#[cfg(not(target_arch = "wasm32"))]
pub trait TransportThreadSafety: Send + Sync {}

#[cfg(not(target_arch = "wasm32"))]
impl<T: Send + Sync + ?Sized> TransportThreadSafety for T {}

#[derive(Debug, Error)]
pub enum TransportError {
    #[error("I/O error: {0}")]
    Io(String),
    #[error("partial write after {written} bytes: {message}")]
    PartialWrite { written: usize, message: String },
    #[error("Connection closed")]
    Closed,
    #[error("Connection timed out")]
    Timeout,
    #[error("Operation cancelled")]
    Cancelled,
    #[error("Peer unreachable: {0}")]
    Unreachable(String),
    #[error("Protocol error: {0}")]
    Protocol(String),
    #[error("Listener already closed")]
    ListenerClosed,
    #[error("Internal transport error: {0}")]
    Internal(String),
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait DuplexStream: TransportThreadSafety {
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, TransportError>;
    async fn write_all(&mut self, buf: &[u8]) -> Result<(), TransportError>;

    /// Write a portion of a buffer and return the number of bytes accepted.
    ///
    /// Existing transports only expose `write_all`, so the compatibility
    /// default reports the complete buffer after that operation succeeds.
    /// Native and browser adapters may override this method to preserve
    /// partial-write information without another allocation.
    async fn write(&mut self, buf: &[u8]) -> Result<usize, TransportError> {
        if buf.is_empty() {
            return Ok(0);
        }
        self.write_all(buf).await?;
        Ok(buf.len())
    }

    async fn close_write(&mut self) -> Result<(), TransportError>;
    async fn close(&mut self) -> Result<(), TransportError>;
}

pub struct IncomingStream {
    pub stream: Box<dyn DuplexStream>,
    pub port: u16,
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait Listener: TransportThreadSafety {
    fn local_address(&self) -> &str;
    async fn accept(&self) -> Result<IncomingStream, TransportError>;
    async fn close(&self) -> Result<(), TransportError>;
}

#[derive(Debug, Clone)]
pub struct ListenOptions {
    pub derp_map_url: String,
    pub verbose: bool,
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait TailcatTransport: TransportThreadSafety {
    async fn listen(&self, options: ListenOptions) -> Result<Box<dyn Listener>, TransportError>;
    async fn dial(
        &self,
        address: &str,
        port: u16,
        options: ListenOptions,
    ) -> Result<Box<dyn DuplexStream>, TransportError>;
}
