use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use async_trait::async_trait;
use futures::channel::mpsc::{unbounded, UnboundedReceiver, UnboundedSender};
use futures::lock::Mutex as AsyncMutex;
use futures::StreamExt;
use tailsend_transport_api::{
    DuplexStream, IncomingStream, ListenOptions, Listener, TailcatTransport, TransportError,
};

pub struct MockStream {
    tx: UnboundedSender<Vec<u8>>,
    rx: UnboundedReceiver<Vec<u8>>,
    current_read_buf: Vec<u8>,
    is_closed: bool,
}

impl MockStream {
    pub fn pair() -> (Self, Self) {
        let (tx1, rx1) = unbounded();
        let (tx2, rx2) = unbounded();

        let s1 = Self {
            tx: tx2,
            rx: rx1,
            current_read_buf: Vec::new(),
            is_closed: false,
        };
        let s2 = Self {
            tx: tx1,
            rx: rx2,
            current_read_buf: Vec::new(),
            is_closed: false,
        };
        (s1, s2)
    }
}

#[async_trait]
impl DuplexStream for MockStream {
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, TransportError> {
        if self.is_closed {
            return Ok(0);
        }
        if !self.current_read_buf.is_empty() {
            let to_copy = buf.len().min(self.current_read_buf.len());
            buf[..to_copy].copy_from_slice(&self.current_read_buf[..to_copy]);
            self.current_read_buf.drain(..to_copy);
            return Ok(to_copy);
        }

        match self.rx.next().await {
            Some(data) => {
                let to_copy = buf.len().min(data.len());
                buf[..to_copy].copy_from_slice(&data[..to_copy]);
                if data.len() > to_copy {
                    self.current_read_buf.extend_from_slice(&data[to_copy..]);
                }
                Ok(to_copy)
            }
            None => Ok(0), // EOF
        }
    }

    async fn write_all(&mut self, buf: &[u8]) -> Result<(), TransportError> {
        if self.is_closed {
            return Err(TransportError::Closed);
        }
        self.tx
            .unbounded_send(buf.to_vec())
            .map_err(|_| TransportError::Closed)
    }

    async fn close_write(&mut self) -> Result<(), TransportError> {
        self.tx.close_channel();
        Ok(())
    }

    async fn close(&mut self) -> Result<(), TransportError> {
        self.is_closed = true;
        self.tx.close_channel();
        self.rx.close();
        Ok(())
    }
}

pub struct MockListener {
    address: String,
    incoming_rx: Arc<AsyncMutex<UnboundedReceiver<IncomingStream>>>,
    is_closed: Arc<AsyncMutex<bool>>,
}

#[async_trait]
impl Listener for MockListener {
    fn local_address(&self) -> &str {
        &self.address
    }

    async fn accept(&self) -> Result<IncomingStream, TransportError> {
        let mut rx = self.incoming_rx.lock().await;
        if *self.is_closed.lock().await {
            return Err(TransportError::ListenerClosed);
        }
        match rx.next().await {
            Some(stream) => Ok(stream),
            None => Err(TransportError::ListenerClosed),
        }
    }

    async fn close(&self) -> Result<(), TransportError> {
        *self.is_closed.lock().await = true;
        self.incoming_rx.lock().await.close();
        Ok(())
    }
}

#[derive(Clone, Default)]
pub struct MockNetworkHub {
    listeners: Arc<Mutex<HashMap<String, UnboundedSender<IncomingStream>>>>,
}

impl MockNetworkHub {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl TailcatTransport for MockNetworkHub {
    async fn listen(&self, _options: ListenOptions) -> Result<Box<dyn Listener>, TransportError> {
        let addr = format!("tc-mock-{}", rand::random::<u32>());
        let (tx, rx) = unbounded();

        self.listeners.lock().unwrap().insert(addr.clone(), tx);

        Ok(Box::new(MockListener {
            address: addr,
            incoming_rx: Arc::new(AsyncMutex::new(rx)),
            is_closed: Arc::new(AsyncMutex::new(false)),
        }))
    }

    async fn dial(
        &self,
        address: &str,
        port: u16,
        _options: ListenOptions,
    ) -> Result<Box<dyn DuplexStream>, TransportError> {
        let listener_tx = self
            .listeners
            .lock()
            .unwrap()
            .get(address)
            .cloned()
            .ok_or_else(|| TransportError::Unreachable(format!("address not found: {}", address)))?;

        let (client_stream, server_stream) = MockStream::pair();

        let incoming = IncomingStream {
            stream: Box::new(server_stream),
            port,
        };

        listener_tx
            .unbounded_send(incoming)
            .map_err(|_| TransportError::Unreachable("listener channel closed".to_string()))?;

        Ok(Box::new(client_stream))
    }
}
