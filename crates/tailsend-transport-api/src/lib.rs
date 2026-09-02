use async_trait::async_trait;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TransportError {
    #[error("I/O error: {0}")]
    Io(String),
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

#[async_trait]
pub trait DuplexStream: Send + Sync {
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, TransportError>;
    async fn write_all(&mut self, buf: &[u8]) -> Result<(), TransportError>;
    async fn close_write(&mut self) -> Result<(), TransportError>;
    async fn close(&mut self) -> Result<(), TransportError>;
}

pub struct IncomingStream {
    pub stream: Box<dyn DuplexStream>,
    pub port: u16,
}

#[async_trait]
pub trait Listener: Send + Sync {
    fn local_address(&self) -> &str;
    async fn accept(&self) -> Result<IncomingStream, TransportError>;
    async fn close(&self) -> Result<(), TransportError>;
}

#[derive(Debug, Clone)]
pub struct ListenOptions {
    pub derp_map_url: String,
    pub verbose: bool,
}

#[async_trait]
pub trait TailcatTransport: Send + Sync {
    async fn listen(&self, options: ListenOptions) -> Result<Box<dyn Listener>, TransportError>;
    async fn dial(
        &self,
        address: &str,
        port: u16,
        options: ListenOptions,
    ) -> Result<Box<dyn DuplexStream>, TransportError>;
}
