use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// A synchronous hook used to wake an in-flight native or browser I/O call.
///
/// The common state service invokes this hook after setting the transfer
/// cancellation flag.  Native streams call the Tailcat C ABI and browser
/// streams close their JavaScript connection; adapters that cannot interrupt
/// an operation leave it unset and retain the flag-only behavior.
#[cfg(target_arch = "wasm32")]
pub type CancellationCallback = std::rc::Rc<dyn Fn()>;

#[cfg(not(target_arch = "wasm32"))]
pub type CancellationCallback = std::sync::Arc<dyn Fn() + Send + Sync>;

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

/// The path currently carrying a Tailcat stream.
///
/// The numeric values are kept aligned with the existing daemon telemetry:
/// direct UDP is `0`, WebRTC DataChannel is `1`, and DERP is `2`.  Unknown is
/// represented by `255` so an adapter can keep working when an older bridge
/// does not expose path information.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransportPath {
    DirectUdp = 0,
    #[serde(rename = "webrtc")]
    WebRtc = 1,
    Derp = 2,
    #[serde(other)]
    Unknown = 255,
}

impl Default for TransportPath {
    fn default() -> Self {
        Self::Unknown
    }
}

impl TransportPath {
    pub const fn from_code(code: u8) -> Self {
        match code {
            0 => Self::DirectUdp,
            1 => Self::WebRtc,
            2 => Self::Derp,
            _ => Self::Unknown,
        }
    }

    pub const fn code(self) -> u8 {
        self as u8
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait DuplexStream: TransportThreadSafety {
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, TransportError>;
    async fn write_all(&mut self, buf: &[u8]) -> Result<(), TransportError>;

    /// Return a cheap, idempotent hook that interrupts a pending read/write.
    /// The hook is deliberately synchronous so cancellation does not depend
    /// on another async task getting scheduled while the I/O is blocked.
    fn cancellation_callback(&self) -> Option<CancellationCallback> {
        None
    }

    /// Report the path selected by the underlying Tailcat stack.  Adapters
    /// that predate path reporting return `Unknown` without affecting I/O.
    fn transport_path(&self) -> TransportPath {
        TransportPath::Unknown
    }

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

#[cfg(test)]
mod tests {
    use super::TransportPath;

    #[test]
    fn transport_codes_are_stable() {
        assert_eq!(TransportPath::from_code(0), TransportPath::DirectUdp);
        assert_eq!(TransportPath::from_code(1), TransportPath::WebRtc);
        assert_eq!(TransportPath::from_code(2), TransportPath::Derp);
        assert_eq!(TransportPath::from_code(200), TransportPath::Unknown);
        assert_eq!(TransportPath::Unknown.code(), 255);
    }

    #[test]
    fn transport_path_json_names_are_small_and_stable() {
        assert_eq!(serde_json::to_string(&TransportPath::DirectUdp).unwrap(), "\"direct-udp\"");
        assert_eq!(serde_json::to_string(&TransportPath::WebRtc).unwrap(), "\"webrtc\"");
        assert_eq!(serde_json::from_str::<TransportPath>("\"future-path\"").unwrap(), TransportPath::Unknown);
    }
}
