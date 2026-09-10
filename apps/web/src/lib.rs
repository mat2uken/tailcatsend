#![cfg(target_arch = "wasm32")]

//! Browser backend for the VanJS application.
//!
//! Go owns Tailcat/WebRTC/DERP sockets; Rust owns invitation state, framing,
//! progress, cancellation and OPFS commit ordering.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use futures::channel::mpsc::{unbounded, UnboundedReceiver, UnboundedSender};
use futures::StreamExt;
use js_sys::{Function, Object, Promise, Reflect, Uint8Array};
use serde::Serialize;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::{future_to_promise, JsFuture};

use tailsend_core::{
    run_host_handshake, run_joiner_handshake, AppEvent, BackendService, SessionState,
};
use tailsend_platform_api::{
    FileMetadata, FileSource, IncomingFileSink, ReceivedItem, StorageError,
};
use tailsend_qr::generate_qr_rgba;
use tailsend_protocol::control::{BrowserFamily, Capabilities, PeerInfo, PlatformKind};
use tailsend_protocol::filename::sanitize_filename;
use tailsend_protocol::invitation::InvitationV1;
use tailsend_protocol::limits::{FILE_PORT, TEXT_PORT};
use tailsend_transfer::{
    receive_live_text_stream, receive_named_file_stream_with_factory, send_live_text_stream,
    send_named_file_stream, ProgressCallback, ProgressUpdate, TransferError,
};
use tailsend_transport_api::{
    DuplexStream, IncomingStream, ListenOptions, Listener, TailcatTransport, TransportError,
    TransportPath,
};

const DERP_MAP_URL: &str = "https://tailcat.dev/derpmap.json";
const INVITE_BASE_URL: &str = "https://ponlet.mat2uken.app";
const INVITE_LIFETIME_SECS: u64 = 600;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiSnapshot {
    api_version: u16,
    sequence: u64,
    state: &'static str,
    peer_name: String,
    invite_url: Option<String>,
    invite_expires_in_secs: u64,
    can_send: bool,
    can_disconnect: bool,
    transfer: Option<UiTransfer>,
    error: Option<String>,
    transport: TransportPath,
    received: Vec<UiReceivedItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiTransfer {
    id: String,
    name: String,
    done: u64,
    total: u64,
    incoming: bool,
    status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiReceivedItem {
    name: String,
    size: u64,
    local_path_or_handle: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiQrBitmap {
    width: u32,
    height: u32,
    rgba_pixels: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum UiEvent {
    Snapshot {
        sequence: u64,
        snapshot: UiSnapshot,
    },
    Progress {
        sequence: u64,
        id: String,
        done: u64,
        total: u64,
    },
    Text {
        sequence: u64,
        text: String,
        incoming: bool,
    },
    Files {
        sequence: u64,
        items: Vec<UiReceivedItem>,
    },
    Terminal {
        sequence: u64,
        id: String,
        status: &'static str,
        message: Option<String>,
    },
}

fn js_error(value: JsValue) -> TransportError {
    TransportError::Io(value.as_string().unwrap_or_else(|| format!("{value:?}")))
}

fn property(target: &JsValue, name: &str) -> Result<JsValue, TransportError> {
    Reflect::get(target, &JsValue::from_str(name)).map_err(js_error)
}

fn function(target: &JsValue, name: &str) -> Result<Function, TransportError> {
    property(target, name)?
        .dyn_into::<Function>()
        .map_err(|_| TransportError::Internal(format!("Tailcat method {name} is unavailable")))
}

async fn promise(value: JsValue) -> Result<JsValue, TransportError> {
    JsFuture::from(Promise::resolve(&value))
        .await
        .map_err(js_error)
}

fn tailcat_bridge() -> Result<JsValue, TransportError> {
    let global = js_sys::global();
    let value = Reflect::get(&global, &JsValue::from_str("tailSendTailcat")).map_err(js_error)?;
    if value.is_undefined() || value.is_null() {
        return Err(TransportError::Internal(
            "Tailcat WebAssembly bridge is not ready".to_string(),
        ));
    }
    Ok(value)
}

#[derive(Clone)]
struct WebTransport;

struct WebStream {
    connection: JsValue,
    closed: bool,
    transport_path: TransportPath,
}

impl WebStream {
    fn current_transport_path(&self) -> TransportPath {
        let Ok(get_transport) = function(&self.connection, "getTransport") else {
            return self.transport_path;
        };
        let Ok(value) = get_transport.call0(&self.connection) else {
            return self.transport_path;
        };
        value
            .as_f64()
            .map(|code| TransportPath::from_code(code as u8))
            .filter(|path| *path != TransportPath::Unknown)
            .unwrap_or(self.transport_path)
    }
}

#[async_trait(?Send)]
impl DuplexStream for WebStream {
    fn transport_path(&self) -> TransportPath {
        self.current_transport_path()
    }

    async fn read(&mut self, buffer: &mut [u8]) -> Result<usize, TransportError> {
        if self.closed {
            return Err(TransportError::Closed);
        }
        let read = function(&self.connection, "read")?
            .call1(
                &self.connection,
                &JsValue::from_f64(buffer.len() as f64),
            )
            .map_err(js_error)?;
        let value = promise(read).await?;
        if value.is_null() || value.is_undefined() {
            return Ok(0);
        }
        let bytes = Uint8Array::new(&value);
        let count = bytes.length() as usize;
        if count > buffer.len() {
            return Err(TransportError::Internal(format!(
                "Tailcat read overrun: {count} > {}",
                buffer.len()
            )));
        }
        bytes.copy_to(&mut buffer[..count]);
        Ok(count)
    }

    async fn write_all(&mut self, buffer: &[u8]) -> Result<(), TransportError> {
        let _ = self.write(buffer).await?;
        Ok(())
    }

    async fn write(&mut self, buffer: &[u8]) -> Result<usize, TransportError> {
        if self.closed {
            return Err(TransportError::Closed);
        }
        let bytes = Uint8Array::new_with_length(buffer.len() as u32);
        bytes.copy_from(buffer);
        let write = function(&self.connection, "write")?
            .call1(&self.connection, &bytes)
            .map_err(js_error)?;
        promise(write).await?;
        Ok(buffer.len())
    }

    async fn close_write(&mut self) -> Result<(), TransportError> {
        if self.closed {
            return Ok(());
        }
        let close = function(&self.connection, "closeWrite")?
            .call0(&self.connection)
            .map_err(js_error)?;
        promise(close).await?;
        Ok(())
    }

    async fn close(&mut self) -> Result<(), TransportError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        let close = function(&self.connection, "close")?
            .call0(&self.connection)
            .map_err(js_error)?;
        promise(close).await?;
        Ok(())
    }
}

struct WebListener {
    address: String,
    close: JsValue,
    incoming: RefCell<UnboundedReceiver<JsValue>>,
    _callback: Closure<dyn FnMut(JsValue)>,
}

#[async_trait(?Send)]
impl Listener for WebListener {
    fn local_address(&self) -> &str {
        &self.address
    }

    async fn accept(&self) -> Result<IncomingStream, TransportError> {
        let value = self
            .incoming
            .borrow_mut()
            .next()
            .await
            .ok_or(TransportError::ListenerClosed)?;
        let port = property(&value, "port")?
            .as_f64()
            .ok_or_else(|| TransportError::Protocol("incoming stream has no port".into()))?
            as u16;
        let transport_path = property(&value, "transportType")
            .ok()
            .and_then(|value| value.as_f64())
            .map(|code| TransportPath::from_code(code as u8))
            .unwrap_or_default();
        Ok(IncomingStream {
            stream: Box::new(WebStream {
                connection: value,
                closed: false,
                transport_path,
            }),
            port,
        })
    }

    async fn close(&self) -> Result<(), TransportError> {
        if let Ok(close) = self.close.clone().dyn_into::<Function>() {
            let result = close.call0(&JsValue::UNDEFINED).map_err(js_error)?;
            promise(result).await?;
        }
        Ok(())
    }
}

#[async_trait(?Send)]
impl TailcatTransport for WebTransport {
    async fn listen(&self, options: ListenOptions) -> Result<Box<dyn Listener>, TransportError> {
        let bridge = tailcat_bridge()?;
        let (sender, receiver): (UnboundedSender<JsValue>, UnboundedReceiver<JsValue>) =
            unbounded();
        let callback = Closure::wrap(Box::new(move |connection: JsValue| {
            let _ = sender.unbounded_send(connection);
        }) as Box<dyn FnMut(JsValue)>);
        let opts = Object::new();
        Reflect::set(
            &opts,
            &JsValue::from_str("derpMapURL"),
            &JsValue::from_str(&options.derp_map_url),
        )
        .map_err(js_error)?;
        Reflect::set(
            &opts,
            &JsValue::from_str("verbose"),
            &JsValue::from_bool(options.verbose),
        )
        .map_err(js_error)?;
        Reflect::set(
            &opts,
            &JsValue::from_str("onConnection"),
            callback.as_ref().unchecked_ref(),
        )
        .map_err(js_error)?;
        let listen = function(&bridge, "listen")?
            .call1(&bridge, &opts)
            .map_err(js_error)?;
        let listener = promise(listen).await?;
        let address = property(&listener, "addr")?
            .as_string()
            .or_else(|| property(&listener, "address").ok()?.as_string())
            .ok_or_else(|| TransportError::Protocol("Tailcat listener has no address".into()))?;
        let close = property(&listener, "close")?;
        Ok(Box::new(WebListener {
            address,
            close,
            incoming: RefCell::new(receiver),
            _callback: callback,
        }))
    }

    async fn dial(
        &self,
        address: &str,
        port: u16,
        options: ListenOptions,
    ) -> Result<Box<dyn DuplexStream>, TransportError> {
        let bridge = tailcat_bridge()?;
        let opts = Object::new();
        for (key, value) in [
            ("addr", JsValue::from_str(address)),
            ("derpMapURL", JsValue::from_str(&options.derp_map_url)),
            ("port", JsValue::from_f64(port as f64)),
            ("verbose", JsValue::from_bool(options.verbose)),
        ] {
            Reflect::set(&opts, &JsValue::from_str(key), &value).map_err(js_error)?;
        }
        let dial = function(&bridge, "dial")?
            .call1(&bridge, &opts)
            .map_err(js_error)?;
        let connection = promise(dial).await?;
        let transport_path = property(&connection, "transportType")
            .ok()
            .and_then(|value| value.as_f64())
            .map(|code| TransportPath::from_code(code as u8))
            .unwrap_or_default();
        Ok(Box::new(WebStream {
            connection,
            closed: false,
            transport_path,
        }))
    }
}

struct WebFileSource {
    file: JsValue,
    metadata: FileMetadata,
}

#[async_trait(?Send)]
impl FileSource for WebFileSource {
    fn metadata(&self) -> FileMetadata {
        self.metadata.clone()
    }

    async fn read_into(
        &mut self,
        offset: u64,
        destination: &mut [u8],
    ) -> Result<usize, StorageError> {
        if destination.is_empty() {
            return Ok(0);
        }
        let end = offset.saturating_add(destination.len() as u64);
        let slice = function(&self.file, "slice")
            .map_err(|error| StorageError::Io(error.to_string()))?
            .call2(
                &self.file,
                &JsValue::from_f64(offset as f64),
                &JsValue::from_f64(end as f64),
            )
            .map_err(|error| StorageError::Io(format!("{error:?}")))?;
        let buffer = function(&slice, "arrayBuffer")
            .map_err(|error| StorageError::Io(error.to_string()))?
            .call0(&slice)
            .map_err(|error| StorageError::Io(format!("{error:?}")))?;
        let buffer = promise(buffer)
            .await
            .map_err(|error| StorageError::Io(error.to_string()))?;
        let bytes = Uint8Array::new(&buffer);
        let count = bytes.length() as usize;
        if count > destination.len() {
            return Err(StorageError::Io(format!(
                "file source returned {count} bytes for a {} byte buffer",
                destination.len()
            )));
        }
        bytes.copy_to(&mut destination[..count]);
        Ok(count)
    }

    async fn read_at(&mut self, offset: u64, max_len: usize) -> Result<Bytes, StorageError> {
        let end = offset.saturating_add(max_len as u64);
        let slice = function(&self.file, "slice")
            .map_err(|error| StorageError::Io(error.to_string()))?
            .call2(
                &self.file,
                &JsValue::from_f64(offset as f64),
                &JsValue::from_f64(end as f64),
            )
            .map_err(|error| StorageError::Io(format!("{error:?}")))?;
        let buffer = function(&slice, "arrayBuffer")
            .map_err(|error| StorageError::Io(error.to_string()))?
            .call0(&slice)
            .map_err(|error| StorageError::Io(format!("{error:?}")))?;
        let buffer = promise(buffer)
            .await
            .map_err(|error| StorageError::Io(error.to_string()))?;
        let bytes = Uint8Array::new(&buffer);
        Ok(Bytes::from(bytes.to_vec()))
    }

    async fn close(&mut self) {}
}

struct WebFileSink {
    directory: JsValue,
    file: JsValue,
    writable: JsValue,
    temporary_name: String,
    final_name: String,
    size: u64,
}

impl WebFileSink {
    async fn prepare(name: &str) -> Result<Self, StorageError> {
        let safe = sanitize_filename(name).map_err(|error| StorageError::Io(error.to_string()))?;
        let global = js_sys::global();
        let navigator = Reflect::get(&global, &JsValue::from_str("navigator"))
            .map_err(|error| StorageError::Io(format!("{error:?}")))?;
        let storage = Reflect::get(&navigator, &JsValue::from_str("storage"))
            .map_err(|error| StorageError::Io(format!("{error:?}")))?;
        let root = promise(
            function(&storage, "getDirectory")
                .map_err(|error| StorageError::Io(error.to_string()))?
                .call0(&storage)
                .map_err(|error| StorageError::Io(format!("{error:?}")))?,
        )
        .await
        .map_err(|error| StorageError::Io(error.to_string()))?;
        let options = Object::new();
        Reflect::set(&options, &JsValue::from_str("create"), &JsValue::TRUE)
            .map_err(|error| StorageError::Io(format!("{error:?}")))?;
        let directory = promise(
            function(&root, "getDirectoryHandle")
                .map_err(|error| StorageError::Io(error.to_string()))?
                .call2(&root, &JsValue::from_str("Ponlet"), &options)
                .map_err(|error| StorageError::Io(format!("{error:?}")))?,
        )
        .await
        .map_err(|error| StorageError::Io(error.to_string()))?;
        let temporary_name = format!(".{safe}.{}.part", id_string(new_id()));
        let file = promise(
            function(&directory, "getFileHandle")
                .map_err(|error| StorageError::Io(error.to_string()))?
                .call2(&directory, &JsValue::from_str(&temporary_name), &options)
                .map_err(|error| StorageError::Io(format!("{error:?}")))?,
        )
        .await
        .map_err(|error| StorageError::Io(error.to_string()))?;
        let writable = promise(
            function(&file, "createWritable")
                .map_err(|error| StorageError::Io(error.to_string()))?
                .call0(&file)
                .map_err(|error| StorageError::Io(format!("{error:?}")))?,
        )
        .await
        .map_err(|error| StorageError::Io(error.to_string()))?;
        Ok(Self {
            directory,
            file,
            writable,
            temporary_name,
            final_name: safe,
            size: 0,
        })
    }
}

#[async_trait(?Send)]
impl IncomingFileSink for WebFileSink {
    async fn write(&mut self, chunk: &[u8]) -> Result<(), StorageError> {
        let bytes = Uint8Array::new_with_length(chunk.len() as u32);
        bytes.copy_from(chunk);
        let write = function(&self.writable, "write")
            .map_err(|error| StorageError::Io(error.to_string()))?
            .call1(&self.writable, &bytes)
            .map_err(|error| StorageError::Io(format!("{error:?}")))?;
        promise(write)
            .await
            .map_err(|error| StorageError::Io(error.to_string()))?;
        self.size = self.size.saturating_add(chunk.len() as u64);
        Ok(())
    }

    async fn commit(mut self: Box<Self>) -> Result<ReceivedItem, StorageError> {
        let result = async {
            let close = function(&self.writable, "close")
                .map_err(|error| StorageError::Io(error.to_string()))?
                .call0(&self.writable)
                .map_err(|error| StorageError::Io(format!("{error:?}")))?;
            promise(close)
                .await
                .map_err(|error| StorageError::Io(error.to_string()))?;
            let move_method = function(&self.file, "move")
                .map_err(|_| StorageError::Unsupported("OPFS move is unavailable".into()))?;
            let moved = move_method
                .call1(&self.file, &JsValue::from_str(&self.final_name))
                .map_err(|error| StorageError::Io(format!("{error:?}")))?;
            promise(moved)
                .await
                .map_err(|error| StorageError::Io(error.to_string()))?;
            Ok(ReceivedItem {
                name: self.final_name.clone(),
                size: self.size,
                local_path_or_handle: format!("opfs:/Ponlet/{}", self.final_name),
            })
        }
        .await;
        if result.is_err() {
            let _ = self.abort().await;
        }
        result
    }

    async fn abort(mut self: Box<Self>) -> Result<(), StorageError> {
        if let Ok(abort) = function(&self.writable, "abort") {
            if let Ok(result) = abort.call0(&self.writable) {
                let _ = promise(result).await;
            }
        }
        if let Ok(remove) = function(&self.directory, "removeEntry") {
            if let Ok(result) =
                remove.call1(&self.directory, &JsValue::from_str(&self.temporary_name))
            {
                let _ = promise(result).await;
            }
        }
        Ok(())
    }
}

struct WebSession {
    listener: Rc<Box<dyn Listener>>,
    peer_address: RefCell<String>,
    peer_info: RefCell<Option<PeerInfo>>,
    peer_capabilities: RefCell<Option<Capabilities>>,
    transport_path: RefCell<TransportPath>,
    cancel: Arc<AtomicBool>,
}

struct WebBackend {
    service: BackendService,
    transport: Arc<WebTransport>,
    session: RefCell<Option<Rc<WebSession>>>,
    subscribers: RefCell<Vec<Function>>,
    received: RefCell<Vec<UiReceivedItem>>,
}

impl WebBackend {
    fn new() -> Rc<Self> {
        let service = BackendService::default();
        service.set_state(SessionState::Disconnected {
            reason: "ready".into(),
        });
        Rc::new(Self {
            service,
            transport: Arc::new(WebTransport),
            session: RefCell::new(None),
            subscribers: RefCell::new(Vec::new()),
            received: RefCell::new(Vec::new()),
        })
    }

    fn snapshot(&self) -> UiSnapshot {
        snapshot_from_service(&self.service, &self.received.borrow())
    }

    fn notify(&self, event: UiEvent) {
        let Ok(value) = serde_wasm_bindgen::to_value(&event) else {
            return;
        };
        self.subscribers
            .borrow_mut()
            .retain(|subscriber| subscriber.call1(&JsValue::UNDEFINED, &value).is_ok());
    }

    fn state(&self, state: SessionState) {
        let event = self.service.set_state(state);
        self.notify(UiEvent::Snapshot {
            sequence: event.sequence,
            snapshot: self.snapshot(),
        });
    }

    fn event(&self, event: AppEvent) {
        let ordered = self.service.emit(event.clone());
        match event {
            AppEvent::StateChanged(_) => {
                self.notify(UiEvent::Snapshot {
                    sequence: ordered.sequence,
                    snapshot: self.snapshot(),
                })
            }
            AppEvent::TransportChanged(_) => self.notify(UiEvent::Snapshot {
                sequence: ordered.sequence,
                snapshot: self.snapshot(),
            }),
            AppEvent::FilesReceived { items } => {
                let items = items
                    .into_iter()
                    .map(|item| UiReceivedItem {
                        name: item.name,
                        size: item.size,
                        local_path_or_handle: item.local_path_or_handle,
                    })
                    .collect::<Vec<_>>();
                self.received.borrow_mut().extend(items.clone());
                self.notify(UiEvent::Files {
                    sequence: ordered.sequence,
                    items,
                });
            }
            AppEvent::TextReceived { text } => self.notify(UiEvent::Text {
                sequence: ordered.sequence,
                text,
                incoming: true,
            }),
            AppEvent::TransferCompleted { transfer_id } => self.notify(UiEvent::Terminal {
                sequence: ordered.sequence,
                id: id_string(transfer_id),
                status: "completed",
                message: None,
            }),
            AppEvent::TransferCancelled {
                transfer_id,
                reason,
            } => self.notify(UiEvent::Terminal {
                sequence: ordered.sequence,
                id: id_string(transfer_id),
                status: if reason == "Transfer cancelled by user" {
                    "cancelled"
                } else {
                    "failed"
                },
                message: Some(reason),
            }),
            AppEvent::TransferProgress {
                transfer_id,
                bytes_done,
                bytes_total,
            } => self.notify(UiEvent::Progress {
                sequence: ordered.sequence,
                id: id_string(transfer_id),
                done: bytes_done,
                total: bytes_total,
            }),
            AppEvent::ErrorOccurred { code, message } => self.notify(UiEvent::Snapshot {
                sequence: ordered.sequence,
                snapshot: UiSnapshot {
                    error: Some(format!("{code}: {message}")),
                    ..self.snapshot()
                },
            }),
        }
    }

    fn progress(&self, update: ProgressUpdate) {
        if let Some(event) = self.service.progress(
            update.transfer_id,
            update.bytes_transferred,
            update.total_bytes,
        ) {
            self.notify(UiEvent::Progress {
                sequence: event.sequence,
                id: id_string(update.transfer_id),
                done: update.bytes_transferred,
                total: update.total_bytes,
            });
        }
    }

    async fn create_invite(self: Rc<Self>) -> Result<(), JsValue> {
        self.disconnect().await?;
        let listener: Rc<Box<dyn Listener>> = Rc::new(
            self.transport
                .listen(listen_options())
                .await
                .map_err(to_js)?,
        );
        let host_address = listener.local_address().to_string();
        let session_id = new_id();
        let invite_secret = new_secret();
        let now = unix_seconds();
        let invitation = InvitationV1::new(
            host_address.clone(),
            session_id,
            invite_secret,
            now,
            INVITE_LIFETIME_SECS,
        );
        let invite_url = invitation
            .to_qr_url(INVITE_BASE_URL)
            .map_err(|error| to_js(error))?;
        let session = Rc::new(WebSession {
            listener,
            peer_address: RefCell::new(String::new()),
            peer_info: RefCell::new(None),
            peer_capabilities: RefCell::new(None),
            transport_path: RefCell::new(TransportPath::Unknown),
            cancel: Arc::new(AtomicBool::new(false)),
        });
        *self.session.borrow_mut() = Some(session.clone());
        self.state(SessionState::AwaitingPeer {
            invite_url,
            expires_at: now + INVITE_LIFETIME_SECS,
            host_address,
        });
        let backend = self.clone();
        spawn_local(async move {
            let info = local_peer_info();
            let result = run_host_handshake(
                &session.listener,
                session_id,
                invite_secret,
                &info,
                &Capabilities::default(),
            )
            .await;
            match result {
                Ok(handshake) => {
                    *session.peer_address.borrow_mut() = handshake.peer_address.clone();
                    *session.peer_info.borrow_mut() = Some(handshake.peer_info.clone());
                    *session.peer_capabilities.borrow_mut() =
                        Some(handshake.peer_capabilities.clone());
                    *session.transport_path.borrow_mut() = handshake.transport_path;
                    backend.state(SessionState::ConnectedIdle {
                        peer_info: handshake.peer_info,
                        peer_capabilities: handshake.peer_capabilities,
                        peer_address: handshake.peer_address,
                        transport_path: handshake.transport_path,
                    });
                    accept_loop(backend, session).await;
                }
                Err(error) => backend.state(SessionState::Error {
                    code: 1001,
                    message: error,
                }),
            }
        });
        Ok(())
    }

    async fn join(self: Rc<Self>, invite: String) -> Result<(), JsValue> {
        self.disconnect().await?;
        let invitation =
            InvitationV1::from_url(&invite, unix_seconds()).map_err(|error| to_js(error))?;
        self.state(SessionState::DialingHost {
            host_address: invitation.host_address.clone(),
        });
        let listener: Rc<Box<dyn Listener>> = Rc::new(
            self.transport
                .listen(listen_options())
                .await
                .map_err(to_js)?,
        );
        let session = Rc::new(WebSession {
            listener,
            peer_address: RefCell::new(invitation.host_address.clone()),
            peer_info: RefCell::new(None),
            peer_capabilities: RefCell::new(None),
            transport_path: RefCell::new(TransportPath::Unknown),
            cancel: Arc::new(AtomicBool::new(false)),
        });
        *self.session.borrow_mut() = Some(session.clone());
        self.state(SessionState::Authenticating);
        let transport: Arc<dyn TailcatTransport> = self.transport.clone();
        let result = run_joiner_handshake(
            &transport,
            &session.listener,
            &invitation,
            &local_peer_info(),
            &Capabilities::default(),
        )
        .await;
        match result {
            Ok(handshake) => {
                *session.peer_info.borrow_mut() = Some(handshake.peer_info.clone());
                *session.peer_capabilities.borrow_mut() = Some(handshake.peer_capabilities.clone());
                *session.peer_address.borrow_mut() = handshake.peer_address.clone();
                *session.transport_path.borrow_mut() = handshake.transport_path;
                self.state(SessionState::ConnectedIdle {
                    peer_info: handshake.peer_info,
                    peer_capabilities: handshake.peer_capabilities,
                    peer_address: handshake.peer_address,
                    transport_path: handshake.transport_path,
                });
                let backend = self.clone();
                spawn_local(async move { accept_loop(backend, session).await });
                Ok(())
            }
            Err(error) => {
                let _ = session.listener.close().await;
                *self.session.borrow_mut() = None;
                self.state(SessionState::Error {
                    code: 1002,
                    message: error.clone(),
                });
                Err(JsValue::from_str(&error))
            }
        }
    }

    async fn send_text(self: Rc<Self>, text: String) -> Result<(), JsValue> {
        let session = self
            .session
            .borrow()
            .clone()
            .ok_or_else(|| JsValue::from_str("No connected peer"))?;
        let id = new_id();
        let cancel = self.service.register_transfer(id);
        self.state(SessionState::Transferring {
            transfer_id: id,
            is_incoming: false,
            is_files: false,
            bytes_done: 0,
            bytes_total: text.len() as u64,
            current_item_name: "Message".into(),
        });
        let address = session.peer_address.borrow().clone();
        let mut stream = match self
            .transport
            .dial(&address, TEXT_PORT, listen_options())
            .await
        {
            Ok(stream) => stream,
            Err(error) => {
                return self.finish(id, Err(TransferError::Transport(error)));
            }
        };
        self.event(AppEvent::TransportChanged(stream.transport_path()));
        let result = send_live_text_stream(&mut stream, &text, cancel).await;
        let _ = stream.close().await;
        self.finish(id, result.map(|_| ()))
    }

    async fn send_files(self: Rc<Self>, files: JsValue) -> Result<(), JsValue> {
        let session = self
            .session
            .borrow()
            .clone()
            .ok_or_else(|| JsValue::from_str("No connected peer"))?;
        let files = js_sys::Array::from(&files);
        for file in files.iter() {
            let name = property(&file, "name")
                .map_err(to_js)?
                .as_string()
                .ok_or_else(|| JsValue::from_str("File has no name"))?;
            let size = property(&file, "size")
                .map_err(to_js)?
                .as_f64()
                .ok_or_else(|| JsValue::from_str("File has no size"))?
                as u64;
            let mime = property(&file, "type").map_err(to_js)?.as_string();
            let source = WebFileSource {
                file,
                metadata: FileMetadata {
                    name: name.clone(),
                    size,
                    mime,
                    modified_unix_ms: None,
                },
            };
            let id = new_id();
            let cancel = self.service.register_transfer(id);
            self.state(SessionState::Transferring {
                transfer_id: id,
                is_incoming: false,
                is_files: true,
                bytes_done: 0,
                bytes_total: size,
                current_item_name: name,
            });
            let mut source: Box<dyn FileSource> = Box::new(source);
            let address = session.peer_address.borrow().clone();
            let mut stream = match self
                .transport
                .dial(&address, FILE_PORT, listen_options())
                .await
            {
                Ok(stream) => stream,
                Err(error) => {
                    return self.finish(id, Err(TransferError::Transport(error)));
                }
            };
            self.event(AppEvent::TransportChanged(stream.transport_path()));
            let backend = self.clone();
            let callback: ProgressCallback = Box::new(move |update| backend.progress(update));
            let result =
                send_named_file_stream(&mut stream, &mut source, id, cancel, Some(&callback)).await;
            source.close().await;
            let _ = stream.close().await;
            self.finish(id, result.map(|_| ()))?;
        }
        Ok(())
    }

    fn finish(&self, id: [u8; 16], result: Result<(), TransferError>) -> Result<(), JsValue> {
        let cancelled =
            matches!(&result, Err(TransferError::Cancelled)) && self.service.is_cancelled(id);
        let failed = result.is_err() && !cancelled;
        if let Err(error) = result {
            self.event(AppEvent::TransferCancelled {
                transfer_id: id,
                reason: error.to_string(),
            });
        } else {
            self.event(AppEvent::TransferCompleted { transfer_id: id });
        }
        self.service.finish_transfer(id);
        self.restore_connected_idle();
        if failed {
            Err(JsValue::from_str("Transfer failed"))
        } else {
            Ok(())
        }
    }

    async fn disconnect(&self) -> Result<(), JsValue> {
        if let SessionState::Transferring { transfer_id, .. } = self.service.snapshot().app.state {
            let _ = self.service.cancel(transfer_id);
        }
        if let Some(session) = self.session.borrow_mut().take() {
            session.cancel.store(true, Ordering::Release);
            let _ = session.listener.close().await;
        }
        self.state(SessionState::Disconnected {
            reason: "disconnected".into(),
        });
        Ok(())
    }

    fn restore_connected_idle(&self) {
        let Some(session) = self.session.borrow().clone() else {
            return;
        };
        let (Some(peer_info), Some(peer_capabilities)) = (
            session.peer_info.borrow().clone(),
            session.peer_capabilities.borrow().clone(),
        ) else {
            return;
        };
        let peer_address = session.peer_address.borrow().clone();
        let transport_path = *session.transport_path.borrow();
        self.state(SessionState::ConnectedIdle {
            peer_info,
            peer_capabilities,
            peer_address,
            transport_path,
        });
    }
}

async fn accept_loop(backend: Rc<WebBackend>, session: Rc<WebSession>) {
    loop {
        if session.cancel.load(Ordering::Acquire) {
            return;
        }
        let incoming = match session.listener.accept().await {
            Ok(value) => value,
            Err(_) => return,
        };
        backend.event(AppEvent::TransportChanged(incoming.stream.transport_path()));
        let backend_for_stream = backend.clone();
        let session_for_stream = session.clone();
        spawn_local(async move {
            match incoming.port {
                TEXT_PORT => {
                    receive_text(backend_for_stream, session_for_stream, incoming.stream).await
                }
                FILE_PORT => {
                    receive_file(backend_for_stream, session_for_stream, incoming.stream).await
                }
                _ => {
                    let mut stream = incoming.stream;
                    let _ = stream.close().await;
                }
            }
        });
    }
}

async fn receive_text(
    backend: Rc<WebBackend>,
    session: Rc<WebSession>,
    mut stream: Box<dyn DuplexStream>,
) {
    let id = new_id();
    let cancel = backend.service.register_transfer(id);
    let result = receive_live_text_stream(&mut stream, cancel, |text| {
        backend.event(AppEvent::TextReceived { text })
    })
    .await;
    let transport_path = stream.transport_path();
    *session.transport_path.borrow_mut() = transport_path;
    backend.event(AppEvent::TransportChanged(transport_path));
    let _ = stream.close().await;
    if let Err(error) = result {
        backend.event(AppEvent::TransferCancelled {
            transfer_id: id,
            reason: error.to_string(),
        });
    }
    backend.service.finish_transfer(id);
    backend.restore_connected_idle();
}

async fn receive_file(
    backend: Rc<WebBackend>,
    session: Rc<WebSession>,
    mut stream: Box<dyn DuplexStream>,
) {
    let id = new_id();
    let cancel = backend.service.register_transfer(id);
    let progress_backend = backend.clone();
    let callback: ProgressCallback = Box::new(move |update| progress_backend.progress(update));
    let result = receive_named_file_stream_with_factory(
        &mut stream,
        |header| {
            backend.state(SessionState::Transferring {
                transfer_id: id,
                is_incoming: true,
                is_files: true,
                bytes_done: 0,
                bytes_total: header.size,
                current_item_name: header.name.clone(),
            });
            let name = header.name.clone();
            async move {
                WebFileSink::prepare(&name)
                    .await
                    .map(|sink| Box::new(sink) as Box<dyn IncomingFileSink>)
            }
        },
        id,
        None,
        cancel,
        Some(&callback),
    )
    .await;
    let transport_path = stream.transport_path();
    *session.transport_path.borrow_mut() = transport_path;
    backend.event(AppEvent::TransportChanged(transport_path));
    let _ = stream.close().await;
    match result {
        Ok(received) => backend.event(AppEvent::FilesReceived {
            items: vec![received.item],
        }),
        Err(error) => backend.event(AppEvent::TransferCancelled {
            transfer_id: id,
            reason: error.to_string(),
        }),
    }
    backend.service.finish_transfer(id);
    backend.restore_connected_idle();
}

fn install_function(object: &Object, name: &str, function: &Function) -> Result<(), JsValue> {
    Reflect::set(object, &JsValue::from_str(name), function).map(|_| ())
}

fn make_promise<F>(future: F) -> Promise
where
    F: std::future::Future<Output = Result<(), JsValue>> + 'static,
{
    future_to_promise(async move { future.await.map(|_| JsValue::UNDEFINED) })
}

fn qr_bitmap(url: String) -> Result<JsValue, JsValue> {
    let image = generate_qr_rgba(&url, 256).map_err(to_js)?;
    serde_wasm_bindgen::to_value(&UiQrBitmap {
        width: image.width,
        height: image.height,
        rgba_pixels: image.rgba_pixels,
    })
    .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub fn install_backend() -> Result<(), JsValue> {
    console_error_panic_hook::set_once();
    let backend = WebBackend::new();
    let object = Object::new();
    let snapshot = {
        let backend = backend.clone();
        Closure::wrap(Box::new(move || {
            let value = serde_wasm_bindgen::to_value(&backend.snapshot()).unwrap_or(JsValue::NULL);
            future_to_promise(async move { Ok(value) })
        }) as Box<dyn FnMut() -> Promise>)
    };
    install_function(&object, "snapshot", snapshot.as_ref().unchecked_ref())?;
    snapshot.forget();

    let subscribe = {
        let backend = backend.clone();
        Closure::wrap(Box::new(move |callback: Function| {
            backend.subscribers.borrow_mut().push(callback.clone());
            let subscribers = backend.subscribers.clone();
            Closure::wrap(Box::new(move || {
                subscribers.borrow_mut().retain(|item| item != &callback);
            }) as Box<dyn FnMut()>)
            .into_js_value()
        }) as Box<dyn FnMut(Function) -> JsValue>)
    };
    install_function(&object, "subscribe", subscribe.as_ref().unchecked_ref())?;
    subscribe.forget();

    let create_invite = {
        let backend = backend.clone();
        Closure::wrap(
            Box::new(move || make_promise(backend.clone().create_invite()))
                as Box<dyn FnMut() -> Promise>,
        )
    };
    install_function(
        &object,
        "createInvite",
        create_invite.as_ref().unchecked_ref(),
    )?;
    create_invite.forget();
    let join = {
        let backend = backend.clone();
        Closure::wrap(
            Box::new(move |invite: String| make_promise(backend.clone().join(invite)))
                as Box<dyn FnMut(String) -> Promise>,
        )
    };
    install_function(&object, "join", join.as_ref().unchecked_ref())?;
    join.forget();
    let send_text = {
        let backend = backend.clone();
        Closure::wrap(
            Box::new(move |text: String| make_promise(backend.clone().send_text(text)))
                as Box<dyn FnMut(String) -> Promise>,
        )
    };
    install_function(&object, "sendText", send_text.as_ref().unchecked_ref())?;
    send_text.forget();
    let send_files = {
        let backend = backend.clone();
        Closure::wrap(Box::new(move |files: JsValue| {
            make_promise(backend.clone().send_files(files))
        }) as Box<dyn FnMut(JsValue) -> Promise>)
    };
    install_function(&object, "sendFiles", send_files.as_ref().unchecked_ref())?;
    send_files.forget();
    let qr_code = Closure::wrap(Box::new(move |url: String| {
        let result = qr_bitmap(url);
        future_to_promise(async move { result })
    }) as Box<dyn FnMut(String) -> Promise>);
    install_function(&object, "qrCode", qr_code.as_ref().unchecked_ref())?;
    qr_code.forget();
    let cancel = {
        let backend = backend.clone();
        Closure::wrap(Box::new(move |id: String| {
            let backend = backend.clone();
            make_promise(async move {
                let transfer_id = parse_id(&id)?;
                if !backend.service.cancel(transfer_id) {
                    return Err(JsValue::from_str("Transfer is no longer active"));
                }
                Ok(())
            })
        }) as Box<dyn FnMut(String) -> Promise>)
    };
    install_function(&object, "cancelTransfer", cancel.as_ref().unchecked_ref())?;
    cancel.forget();
    let disconnect = {
        let backend = backend.clone();
        Closure::wrap(Box::new(move || {
            let backend = backend.clone();
            make_promise(async move { backend.disconnect().await })
        }) as Box<dyn FnMut() -> Promise>)
    };
    install_function(&object, "disconnect", disconnect.as_ref().unchecked_ref())?;
    disconnect.forget();
    let dispose = {
        let backend = backend.clone();
        Closure::wrap(Box::new(move || {
            let backend = backend.clone();
            make_promise(async move { backend.disconnect().await })
        }) as Box<dyn FnMut() -> Promise>)
    };
    install_function(&object, "dispose", dispose.as_ref().unchecked_ref())?;
    dispose.forget();

    let global = js_sys::global();
    Reflect::set(&global, &JsValue::from_str("__ponletBackend"), &object).map(|_| ())
}

fn snapshot_from_service(
    service: &BackendService,
    received: &[UiReceivedItem],
) -> UiSnapshot {
    let snapshot = service.snapshot();
    let app = snapshot.app;
    let (state, peer_name, invite_url, expires, can_send, can_disconnect, transfer, error) =
        match app.state {
            SessionState::Booting => (
                "booting",
                app.peer_display_name,
                None,
                0,
                false,
                false,
                None,
                None,
            ),
            SessionState::AwaitingPeer { invite_url, .. } => (
                "awaiting-peer",
                app.peer_display_name,
                Some(invite_url),
                app.invite_expires_in_secs,
                false,
                app.can_disconnect,
                None,
                None,
            ),
            SessionState::ConnectedIdle { .. } => (
                "connected",
                app.peer_display_name,
                None,
                0,
                app.can_send,
                app.can_disconnect,
                None,
                None,
            ),
            SessionState::Transferring {
                transfer_id,
                is_incoming,
                bytes_done,
                bytes_total,
                current_item_name,
                ..
            } => (
                "transferring",
                app.peer_display_name,
                None,
                0,
                false,
                app.can_disconnect,
                Some(UiTransfer {
                    id: id_string(transfer_id),
                    name: current_item_name,
                    done: bytes_done,
                    total: bytes_total,
                    incoming: is_incoming,
                    status: "transferring",
                }),
                None,
            ),
            SessionState::Error { message, .. } => (
                "error",
                app.peer_display_name,
                None,
                0,
                false,
                app.can_disconnect,
                None,
                Some(message),
            ),
            SessionState::Disconnected { .. } => (
                "ready",
                app.peer_display_name,
                None,
                0,
                false,
                false,
                None,
                None,
            ),
            SessionState::DialingHost { .. }
            | SessionState::Authenticating
            | SessionState::AwaitingAcceptance { .. }
            | SessionState::AwaitingUserDecision { .. } => (
                "booting",
                app.peer_display_name,
                None,
                0,
                false,
                app.can_disconnect,
                None,
                None,
            ),
        };
    UiSnapshot {
        api_version: snapshot.api_version,
        sequence: snapshot.sequence,
        state,
        peer_name,
        invite_url,
        invite_expires_in_secs: expires,
        can_send,
        can_disconnect,
        transfer,
        error,
        transport: app.transport_path,
        received: received.to_vec(),
    }
}

fn listen_options() -> ListenOptions {
    ListenOptions {
        derp_map_url: DERP_MAP_URL.to_string(),
        verbose: false,
    }
}
fn local_peer_info() -> PeerInfo {
    PeerInfo::new_browser(
        "Ponlet Web".into(),
        PlatformKind::Web,
        env!("CARGO_PKG_VERSION").into(),
        BrowserFamily::Other,
    )
}
fn to_js(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}
fn spawn_local<F>(future: F)
where
    F: std::future::Future<Output = ()> + 'static,
{
    wasm_bindgen_futures::spawn_local(future);
}
fn unix_seconds() -> u64 {
    (js_sys::Date::now() / 1_000.0).max(0.0) as u64
}
fn new_id() -> [u8; 16] {
    let mut id = [0; 16];
    getrandom::getrandom(&mut id).expect("browser random source");
    id
}
fn new_secret() -> [u8; 32] {
    let mut secret = [0; 32];
    getrandom::getrandom(&mut secret).expect("browser random source");
    secret
}
fn id_string(id: [u8; 16]) -> String {
    id.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn parse_id(value: &str) -> Result<[u8; 16], JsValue> {
    if value.len() != 32 {
        return Err(JsValue::from_str("Invalid transfer id"));
    }
    let mut id = [0; 16];
    for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
        let text =
            std::str::from_utf8(chunk).map_err(|_| JsValue::from_str("Invalid transfer id"))?;
        id[index] =
            u8::from_str_radix(text, 16).map_err(|_| JsValue::from_str("Invalid transfer id"))?;
    }
    Ok(id)
}
