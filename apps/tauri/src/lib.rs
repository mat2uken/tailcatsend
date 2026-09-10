//! Tauri application service for the WebView UI.
//!
//! The WebView only exchanges metadata with this module.  Tailcat streams and
//! file handles stay in the native process, while the shared Rust transfer
//! engine owns framing, byte counts, cancellation and save completion.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

use tailsend_core::{
    run_host_handshake, run_joiner_handshake, AppEvent, BackendService, SessionState,
};
use tailsend_native_transport::NativeTailcatTransport;
use tailsend_platform_api::{
    FileMetadata, FileSource, IncomingFileSink, ReceivedItem, StorageError,
};
use tailsend_protocol::control::{Capabilities, PeerInfo, PlatformKind};
use tailsend_protocol::invitation::InvitationV1;
use tailsend_protocol::limits::{FILE_PORT, TEXT_PORT};
use tailsend_transfer::{
    receive_live_text_stream, receive_named_file_stream_with_factory, send_live_text_stream,
    send_named_file_stream, ProgressCallback, ProgressUpdate, TransferError,
};
use tailsend_transport_api::{DuplexStream, ListenOptions, Listener, TailcatTransport};

const APP_EVENT: &str = "ponlet:event";
const DERP_MAP_URL: &str = "https://tailcat.dev/derpmap.json";
const INVITE_BASE_URL: &str = "https://ponlet.pages.dev";
const INVITE_LIFETIME_SECS: u64 = 600;
const QUEUE_LIMIT: usize = 64;

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
    Terminal {
        sequence: u64,
        id: String,
        status: &'static str,
        message: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRequest {
    pub name: String,
    pub size: u64,
    pub mime: Option<String>,
    pub path: String,
}

struct PeerSession {
    listener: Arc<Box<dyn Listener>>,
    peer_address: Mutex<String>,
    cancel: Arc<AtomicBool>,
}

struct RuntimeState {
    session: Option<Arc<PeerSession>>,
    active_transfer: Option<[u8; 16]>,
}

pub struct TauriRuntime {
    backend: BackendService,
    transport: Arc<NativeTailcatTransport>,
    state: Mutex<RuntimeState>,
    downloads_dir: PathBuf,
}

impl TauriRuntime {
    fn new() -> Result<Self, String> {
        let transport = NativeTailcatTransport::new().map_err(|error| error.to_string())?;
        Ok(Self {
            backend: BackendService::new(QUEUE_LIMIT),
            transport: Arc::new(transport),
            state: Mutex::new(RuntimeState {
                session: None,
                active_transfer: None,
            }),
            downloads_dir: default_downloads_dir(),
        })
    }

    fn snapshot(&self) -> UiSnapshot {
        let snapshot = self.backend.snapshot();
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
                SessionState::Disconnected { reason } => (
                    "error",
                    app.peer_display_name,
                    None,
                    0,
                    false,
                    false,
                    None,
                    Some(reason),
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
        }
    }

    fn emit_snapshot(&self, app: &AppHandle, sequence: u64) {
        let snapshot = self.snapshot();
        let _ = app.emit(APP_EVENT, UiEvent::Snapshot { sequence, snapshot });
    }

    fn publish(&self, app: &AppHandle, event: AppEvent) {
        let ordered = self.backend.emit(event.clone());
        match event {
            AppEvent::TransferProgress {
                transfer_id,
                bytes_done,
                bytes_total,
            } => {
                let _ = app.emit(
                    APP_EVENT,
                    UiEvent::Progress {
                        sequence: ordered.sequence,
                        id: id_string(transfer_id),
                        done: bytes_done,
                        total: bytes_total,
                    },
                );
            }
            AppEvent::TextReceived { text } => {
                let _ = app.emit(
                    APP_EVENT,
                    UiEvent::Text {
                        sequence: ordered.sequence,
                        text,
                        incoming: true,
                    },
                );
            }
            AppEvent::TransferCompleted { transfer_id } => {
                let _ = app.emit(
                    APP_EVENT,
                    UiEvent::Terminal {
                        sequence: ordered.sequence,
                        id: id_string(transfer_id),
                        status: "completed",
                        message: None,
                    },
                );
            }
            AppEvent::TransferCancelled {
                transfer_id,
                reason,
            } => {
                let _ = app.emit(
                    APP_EVENT,
                    UiEvent::Terminal {
                        sequence: ordered.sequence,
                        id: id_string(transfer_id),
                        status: "cancelled",
                        message: Some(reason),
                    },
                );
            }
            AppEvent::ErrorOccurred { code, message } => {
                self.emit_snapshot(app, ordered.sequence);
                let _ = app.emit(
                    APP_EVENT,
                    UiEvent::Terminal {
                        sequence: ordered.sequence,
                        id: String::new(),
                        status: "failed",
                        message: Some(format!("{code}: {message}")),
                    },
                );
            }
            AppEvent::StateChanged(_) | AppEvent::FilesReceived { .. } => {
                self.emit_snapshot(app, ordered.sequence);
            }
        }
    }

    fn set_state(&self, app: &AppHandle, state: SessionState) {
        let event = self.backend.set_state(state);
        self.emit_snapshot(app, event.sequence);
    }

    fn register_transfer(&self, transfer_id: [u8; 16]) -> Arc<AtomicBool> {
        let mut state = self.state.lock().expect("runtime state mutex poisoned");
        state.active_transfer = Some(transfer_id);
        self.backend.register_transfer(transfer_id)
    }

    fn finish_transfer(&self, transfer_id: [u8; 16]) {
        let mut state = self.state.lock().expect("runtime state mutex poisoned");
        if state.active_transfer == Some(transfer_id) {
            state.active_transfer = None;
        }
        self.backend.finish_transfer(transfer_id);
    }

    fn session(&self) -> Result<Arc<PeerSession>, String> {
        self.state
            .lock()
            .expect("runtime state mutex poisoned")
            .session
            .clone()
            .ok_or_else(|| "No connected peer".to_string())
    }

    fn set_session(&self, session: Arc<PeerSession>) {
        self.state
            .lock()
            .expect("runtime state mutex poisoned")
            .session = Some(session);
    }

    fn take_session(&self) -> Option<Arc<PeerSession>> {
        self.state
            .lock()
            .expect("runtime state mutex poisoned")
            .session
            .take()
    }
}

async fn ponlet_snapshot_impl(runtime: State<'_, TauriRuntime>) -> Result<UiSnapshot, String> {
    Ok(runtime.snapshot())
}

async fn ponlet_create_invite_impl(
    app: AppHandle,
    runtime: State<'_, TauriRuntime>,
) -> Result<(), String> {
    runtime.disconnect_internal(&app).await?;
    runtime.set_state(&app, SessionState::Booting);
    let listener = runtime
        .transport
        .listen(listen_options())
        .await
        .map_err(|error| error.to_string())?;
    let listener = Arc::new(listener);
    let host_address = listener.local_address().to_string();
    let mut session_id = [0u8; 16];
    let mut invite_secret = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut session_id);
    rand::thread_rng().fill_bytes(&mut invite_secret);
    let now = unix_seconds();
    let invitation = InvitationV1::new(
        host_address.clone(),
        session_id,
        invite_secret,
        now,
        INVITE_LIFETIME_SECS,
    );
    let invite_url = invitation
        .to_qr_url(&invite_base_url())
        .map_err(|error| error.to_string())?;
    let session = Arc::new(PeerSession {
        listener: listener.clone(),
        peer_address: Mutex::new(String::new()),
        cancel: Arc::new(AtomicBool::new(false)),
    });
    runtime.set_session(session.clone());
    runtime.set_state(
        &app,
        SessionState::AwaitingPeer {
            invite_url,
            expires_at: now + INVITE_LIFETIME_SECS,
            host_address,
        },
    );

    let backend = runtime.clone_state();
    let host_info = local_peer_info();
    let host_caps = Capabilities::default();
    tokio::spawn(async move {
        let result = run_host_handshake(
            &session.listener,
            session_id,
            invite_secret,
            &host_info,
            &host_caps,
        )
        .await;
        match result {
            Ok(handshake) => {
                if session.cancel.load(Ordering::Acquire) {
                    let _ = session.listener.close().await;
                    return;
                }
                *session.peer_address.lock().expect("session mutex poisoned") =
                    handshake.peer_address.clone();
                backend.set_state(
                    &app,
                    SessionState::ConnectedIdle {
                        peer_info: handshake.peer_info,
                        peer_capabilities: handshake.peer_capabilities,
                        peer_address: handshake.peer_address,
                    },
                );
                accept_loop(backend, app, session).await;
            }
            Err(error) => {
                backend.set_state(
                    &app,
                    SessionState::Error {
                        code: 1001,
                        message: error,
                    },
                );
            }
        }
    });
    Ok(())
}

async fn ponlet_join_impl(
    app: AppHandle,
    runtime: State<'_, TauriRuntime>,
    invite: String,
) -> Result<(), String> {
    runtime.disconnect_internal(&app).await?;
    let invitation =
        InvitationV1::from_url(&invite, unix_seconds()).map_err(|error| error.to_string())?;
    runtime.set_state(
        &app,
        SessionState::DialingHost {
            host_address: invitation.host_address.clone(),
        },
    );
    let listener = Arc::new(
        runtime
            .transport
            .listen(listen_options())
            .await
            .map_err(|error| error.to_string())?,
    );
    let session = Arc::new(PeerSession {
        listener: listener.clone(),
        peer_address: Mutex::new(invitation.host_address.clone()),
        cancel: Arc::new(AtomicBool::new(false)),
    });
    runtime.set_session(session.clone());
    let transport: Arc<dyn TailcatTransport> = runtime.transport.clone();
    let joiner_info = local_peer_info();
    let joiner_caps = Capabilities::default();
    runtime.set_state(&app, SessionState::Authenticating);
    match run_joiner_handshake(
        &transport,
        &session.listener,
        &invitation,
        &joiner_info,
        &joiner_caps,
    )
    .await
    {
        Ok(handshake) => {
            runtime.set_state(
                &app,
                SessionState::ConnectedIdle {
                    peer_info: handshake.peer_info,
                    peer_capabilities: handshake.peer_capabilities,
                    peer_address: handshake.peer_address,
                },
            );
            let backend = runtime.clone_state();
            tokio::spawn(async move { accept_loop(backend, app, session).await });
            Ok(())
        }
        Err(error) => {
            let _ = session.listener.close().await;
            runtime.take_session();
            runtime.set_state(
                &app,
                SessionState::Error {
                    code: 1002,
                    message: error.clone(),
                },
            );
            Err(error)
        }
    }
}

async fn ponlet_send_text_impl(
    app: AppHandle,
    runtime: State<'_, TauriRuntime>,
    text: String,
) -> Result<(), String> {
    let session = runtime.session()?;
    let transfer_id = new_id();
    let cancel = runtime.register_transfer(transfer_id);
    runtime.set_state(
        &app,
        SessionState::Transferring {
            transfer_id,
            is_incoming: false,
            is_files: false,
            bytes_done: 0,
            bytes_total: text.len() as u64,
            current_item_name: "Message".to_string(),
        },
    );
    let peer_address = session
        .peer_address
        .lock()
        .expect("session mutex poisoned")
        .clone();
    let mut stream = match runtime
        .transport
        .dial_cancellable(&peer_address, TEXT_PORT, listen_options(), cancel.clone())
        .await
    {
        Ok(stream) => stream,
        Err(error) => {
            return finish_outgoing(
                &runtime,
                &app,
                transfer_id,
                Err(TransferError::Transport(error)),
                cancel,
            )
        }
    };
    let result = send_live_text_stream(&mut stream, &text, cancel.clone()).await;
    let _ = stream.close().await;
    finish_outgoing(&runtime, &app, transfer_id, result.map(|_| ()), cancel)
}

async fn ponlet_send_files_impl(
    app: AppHandle,
    runtime: State<'_, TauriRuntime>,
    files: Vec<FileRequest>,
) -> Result<(), String> {
    if files.is_empty() {
        return Err("No files selected".to_string());
    }
    let session = runtime.session()?;
    for request in files {
        let source = NativeFileSource::open(request).await?;
        let transfer_id = new_id();
        let cancel = runtime.register_transfer(transfer_id);
        let metadata = source.metadata();
        runtime.set_state(
            &app,
            SessionState::Transferring {
                transfer_id,
                is_incoming: false,
                is_files: true,
                bytes_done: 0,
                bytes_total: metadata.size,
                current_item_name: metadata.name.clone(),
            },
        );
        let mut source: Box<dyn FileSource> = Box::new(source);
        let peer_address = session
            .peer_address
            .lock()
            .expect("session mutex poisoned")
            .clone();
        let mut stream = match runtime
            .transport
            .dial_cancellable(&peer_address, FILE_PORT, listen_options(), cancel.clone())
            .await
        {
            Ok(stream) => stream,
            Err(error) => {
                return finish_outgoing(
                    &runtime,
                    &app,
                    transfer_id,
                    Err(TransferError::Transport(error)),
                    cancel,
                );
            }
        };
        let app_for_progress = app.clone();
        let backend_for_progress = runtime.clone_state();
        let callback: ProgressCallback = Box::new(move |update| {
            backend_for_progress.publish_progress(&app_for_progress, update);
        });
        let result = send_named_file_stream(
            &mut stream,
            &mut source,
            transfer_id,
            cancel.clone(),
            Some(&callback),
        )
        .await;
        source.close().await;
        let _ = stream.close().await;
        finish_outgoing(&runtime, &app, transfer_id, result.map(|_| ()), cancel)?;
    }
    Ok(())
}

async fn ponlet_cancel_transfer_impl(
    _app: AppHandle,
    runtime: State<'_, TauriRuntime>,
    id: String,
) -> Result<(), String> {
    let transfer_id = parse_id(&id)?;
    if !runtime.backend.cancel(transfer_id) {
        return Err("Transfer is no longer active".to_string());
    }
    Ok(())
}

async fn ponlet_disconnect_impl(
    app: AppHandle,
    runtime: State<'_, TauriRuntime>,
) -> Result<(), String> {
    runtime.disconnect_internal(&app).await
}

impl TauriRuntime {
    async fn disconnect_internal(&self, app: &AppHandle) -> Result<(), String> {
        let active_transfer = self
            .state
            .lock()
            .expect("runtime state mutex poisoned")
            .active_transfer;
        if let Some(transfer_id) = active_transfer {
            let _ = self.backend.cancel(transfer_id);
        }
        if let Some(session) = self.take_session() {
            session.cancel.store(true, Ordering::Release);
            session
                .listener
                .close()
                .await
                .map_err(|error| error.to_string())?;
        }
        self.set_state(
            app,
            SessionState::Disconnected {
                reason: "disconnected".to_string(),
            },
        );
        Ok(())
    }

    fn clone_state(&self) -> Arc<TauriState> {
        Arc::new(TauriState {
            backend: self.backend.clone(),
            downloads_dir: self.downloads_dir.clone(),
        })
    }
}

struct TauriState {
    backend: BackendService,
    downloads_dir: PathBuf,
}

impl TauriState {
    fn set_state(&self, app: &AppHandle, state: SessionState) {
        let event = self.backend.set_state(state);
        let snapshot = snapshot_from_backend(&self.backend);
        let _ = app.emit(
            APP_EVENT,
            UiEvent::Snapshot {
                sequence: event.sequence,
                snapshot,
            },
        );
    }

    fn publish_progress(&self, app: &AppHandle, update: ProgressUpdate) {
        if let Some(event) = self.backend.progress(
            update.transfer_id,
            update.bytes_transferred,
            update.total_bytes,
        ) {
            let _ = app.emit(
                APP_EVENT,
                UiEvent::Progress {
                    sequence: event.sequence,
                    id: id_string(update.transfer_id),
                    done: update.bytes_transferred,
                    total: update.total_bytes,
                },
            );
        }
    }
}

async fn accept_loop(runtime: Arc<TauriState>, app: AppHandle, session: Arc<PeerSession>) {
    loop {
        if session.cancel.load(Ordering::Acquire) {
            return;
        }
        let incoming = match session.listener.accept().await {
            Ok(incoming) => incoming,
            Err(error) => {
                if !session.cancel.load(Ordering::Acquire) {
                    runtime.set_state(
                        &app,
                        SessionState::Error {
                            code: 1100,
                            message: error.to_string(),
                        },
                    );
                }
                return;
            }
        };
        let runtime_for_stream = runtime.clone();
        let app_for_stream = app.clone();
        tokio::spawn(async move {
            match incoming.port {
                TEXT_PORT => {
                    receive_text(runtime_for_stream, app_for_stream, incoming.stream).await
                }
                FILE_PORT => {
                    receive_file(runtime_for_stream, app_for_stream, incoming.stream).await
                }
                _ => {
                    let mut stream = incoming.stream;
                    let _ = stream.close().await;
                }
            }
        });
    }
}

async fn receive_text(runtime: Arc<TauriState>, app: AppHandle, mut stream: Box<dyn DuplexStream>) {
    let transfer_id = new_id();
    let cancel_token = runtime.backend.register_transfer(transfer_id);
    let result = receive_live_text_stream(&mut stream, cancel_token, |text| {
        let event = runtime
            .backend
            .emit(AppEvent::TextReceived { text: text.clone() });
        let _ = app.emit(
            APP_EVENT,
            UiEvent::Text {
                sequence: event.sequence,
                text,
                incoming: true,
            },
        );
    })
    .await;
    let _ = stream.close().await;
    runtime.backend.finish_transfer(transfer_id);
    if let Err(error) = result {
        let ordered = runtime.backend.emit(AppEvent::TransferCancelled {
            transfer_id,
            reason: error.to_string(),
        });
        let _ = app.emit(
            APP_EVENT,
            UiEvent::Terminal {
                sequence: ordered.sequence,
                id: id_string(transfer_id),
                status: "failed",
                message: Some(error.to_string()),
            },
        );
    }
    set_idle_from_backend(&runtime.backend, &app);
}

async fn receive_file(runtime: Arc<TauriState>, app: AppHandle, mut stream: Box<dyn DuplexStream>) {
    let transfer_id = new_id();
    let cancel_token = runtime.backend.register_transfer(transfer_id);
    let backend_for_progress = runtime.clone();
    let app_for_progress = app.clone();
    let callback: ProgressCallback = Box::new(move |update| {
        backend_for_progress.publish_progress(&app_for_progress, update);
    });
    let result = receive_named_file_stream_with_factory(
        &mut stream,
        |header| {
            let path = runtime.downloads_dir.clone();
            let name = header.name.clone();
            runtime.set_state(
                &app,
                SessionState::Transferring {
                    transfer_id,
                    is_incoming: true,
                    is_files: true,
                    bytes_done: 0,
                    bytes_total: header.size,
                    current_item_name: name.clone(),
                },
            );
            async move {
                NativeFileSink::prepare(&path, &name)
                    .await
                    .map(|sink| Box::new(sink) as Box<dyn IncomingFileSink>)
            }
        },
        transfer_id,
        None,
        cancel_token,
        Some(&callback),
    )
    .await;
    let _ = stream.close().await;
    match result {
        Ok(received) => {
            let ordered = runtime.backend.emit(AppEvent::FilesReceived {
                items: vec![received.item],
            });
            let _ = app.emit(
                APP_EVENT,
                UiEvent::Terminal {
                    sequence: ordered.sequence,
                    id: id_string(transfer_id),
                    status: "completed",
                    message: None,
                },
            );
        }
        Err(error) => {
            let ordered = runtime.backend.emit(AppEvent::TransferCancelled {
                transfer_id,
                reason: error.to_string(),
            });
            let _ = app.emit(
                APP_EVENT,
                UiEvent::Terminal {
                    sequence: ordered.sequence,
                    id: id_string(transfer_id),
                    status: "failed",
                    message: Some(error.to_string()),
                },
            );
        }
    }
    runtime.backend.finish_transfer(transfer_id);
    set_idle_from_backend(&runtime.backend, &app);
}

fn finish_outgoing(
    runtime: &TauriRuntime,
    app: &AppHandle,
    transfer_id: [u8; 16],
    result: Result<(), TransferError>,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let event = match result {
        Ok(()) => AppEvent::TransferCompleted { transfer_id },
        Err(TransferError::Cancelled) if cancel.load(Ordering::Acquire) => {
            AppEvent::TransferCancelled {
                transfer_id,
                reason: "cancelled by user".to_string(),
            }
        }
        Err(error) => AppEvent::TransferCancelled {
            transfer_id,
            reason: error.to_string(),
        },
    };
    let failed = !matches!(&event, AppEvent::TransferCompleted { .. });
    runtime.publish(app, event);
    runtime.finish_transfer(transfer_id);
    set_idle_from_backend(&runtime.backend, app);
    if failed {
        Err("Transfer failed".to_string())
    } else {
        Ok(())
    }
}

fn set_idle_from_backend(backend: &BackendService, app: &AppHandle) {
    let name = backend.snapshot().app.peer_display_name;
    if name.is_empty() {
        return;
    }
    let event = backend.set_state(SessionState::ConnectedIdle {
        peer_info: PeerInfo::new_native(
            name,
            PlatformKind::Unknown,
            env!("CARGO_PKG_VERSION").to_string(),
        ),
        peer_capabilities: Capabilities::default(),
        peer_address: String::new(),
    });
    let _ = app.emit(
        APP_EVENT,
        UiEvent::Snapshot {
            sequence: event.sequence,
            snapshot: snapshot_from_backend(backend),
        },
    );
}

#[async_trait]
impl FileSource for NativeFileSource {
    fn metadata(&self) -> FileMetadata {
        self.metadata.clone()
    }

    async fn read_at(&mut self, offset: u64, max_len: usize) -> Result<bytes::Bytes, StorageError> {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        self.file
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|error| StorageError::Io(error.to_string()))?;
        let mut bytes = vec![0u8; max_len];
        let count = self
            .file
            .read(&mut bytes)
            .await
            .map_err(|error| StorageError::Io(error.to_string()))?;
        bytes.truncate(count);
        Ok(bytes::Bytes::from(bytes))
    }

    async fn read_into(
        &mut self,
        offset: u64,
        destination: &mut [u8],
    ) -> Result<usize, StorageError> {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        self.file
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|error| StorageError::Io(error.to_string()))?;
        self.file
            .read(destination)
            .await
            .map_err(|error| StorageError::Io(error.to_string()))
    }

    async fn close(&mut self) {}
}

struct NativeFileSource {
    file: tokio::fs::File,
    metadata: FileMetadata,
}

impl NativeFileSource {
    async fn open(request: FileRequest) -> Result<Self, String> {
        let file = tokio::fs::File::open(&request.path)
            .await
            .map_err(|error| error.to_string())?;
        let actual = file.metadata().await.map_err(|error| error.to_string())?;
        if actual.len() != request.size {
            return Err(format!(
                "file size changed: {} != {}",
                actual.len(),
                request.size
            ));
        }
        Ok(Self {
            file,
            metadata: FileMetadata {
                name: request.name,
                size: request.size,
                mime: request.mime,
                modified_unix_ms: None,
            },
        })
    }
}

struct NativeFileSink {
    temp_path: PathBuf,
    final_path: PathBuf,
    file: Option<tokio::fs::File>,
    name: String,
    size: u64,
}

impl NativeFileSink {
    async fn prepare(dir: &Path, name: &str) -> Result<Self, StorageError> {
        std::fs::create_dir_all(dir).map_err(|error| StorageError::Io(error.to_string()))?;
        let safe = tailsend_protocol::filename::sanitize_filename(name)
            .map_err(|error| StorageError::Io(error.to_string()))?;
        let suffix = format!(".ponlet-{}.part", hex_id(new_id()));
        let final_path = dir.join(&safe);
        let temp_path = dir.join(format!(".{safe}{suffix}"));
        let file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .await
            .map_err(|error| StorageError::Io(error.to_string()))?;
        Ok(Self {
            temp_path,
            final_path,
            file: Some(file),
            name: safe,
            size: 0,
        })
    }
}

#[async_trait]
impl IncomingFileSink for NativeFileSink {
    async fn write(&mut self, chunk: &[u8]) -> Result<(), StorageError> {
        use tokio::io::AsyncWriteExt;
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| StorageError::Io("sink closed".into()))?;
        file.write_all(chunk)
            .await
            .map_err(|error| StorageError::Io(error.to_string()))?;
        self.size = self.size.saturating_add(chunk.len() as u64);
        Ok(())
    }

    async fn commit(mut self: Box<Self>) -> Result<ReceivedItem, StorageError> {
        use tokio::io::AsyncWriteExt;
        let result = async {
            if let Some(mut file) = self.file.take() {
                file.flush()
                    .await
                    .map_err(|error| StorageError::Io(error.to_string()))?;
                file.sync_all()
                    .await
                    .map_err(|error| StorageError::Io(error.to_string()))?;
            }
            if tokio::fs::try_exists(&self.final_path)
                .await
                .map_err(|error| StorageError::Io(error.to_string()))?
            {
                let stem = self
                    .final_path
                    .file_stem()
                    .and_then(|v| v.to_str())
                    .unwrap_or("received");
                let ext = self
                    .final_path
                    .extension()
                    .and_then(|v| v.to_str())
                    .unwrap_or("");
                let suffix = if ext.is_empty() {
                    String::new()
                } else {
                    format!(".{ext}")
                };
                self.final_path = self
                    .final_path
                    .with_file_name(format!("{stem} (1){suffix}"));
            }
            tokio::fs::rename(&self.temp_path, &self.final_path)
                .await
                .map_err(|error| StorageError::Io(error.to_string()))?;
            Ok(ReceivedItem {
                name: self.name.clone(),
                size: self.size,
                local_path_or_handle: self.final_path.to_string_lossy().into_owned(),
            })
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&self.temp_path).await;
        }
        result
    }

    async fn abort(mut self: Box<Self>) -> Result<(), StorageError> {
        self.file.take();
        let _ = tokio::fs::remove_file(&self.temp_path).await;
        Ok(())
    }
}

fn snapshot_from_backend(backend: &BackendService) -> UiSnapshot {
    let snapshot = backend.snapshot();
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
            SessionState::Disconnected { reason } => (
                "error",
                app.peer_display_name,
                None,
                0,
                false,
                false,
                None,
                Some(reason),
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
    }
}

fn listen_options() -> ListenOptions {
    ListenOptions {
        derp_map_url: std::env::var("PONLET_DERP_MAP_URL")
            .unwrap_or_else(|_| DERP_MAP_URL.to_string()),
        verbose: false,
    }
}

fn invite_base_url() -> String {
    std::env::var("PONLET_INVITE_BASE_URL").unwrap_or_else(|_| INVITE_BASE_URL.to_string())
}

fn default_downloads_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        return PathBuf::from(home).join("Downloads").join("Ponlet");
    }
    PathBuf::from("Downloads").join("Ponlet")
}

fn local_peer_info() -> PeerInfo {
    PeerInfo::new_native(
        "Ponlet".to_string(),
        current_platform(),
        env!("CARGO_PKG_VERSION").to_string(),
    )
}

fn current_platform() -> PlatformKind {
    #[cfg(target_os = "macos")]
    return PlatformKind::MacOS;
    #[cfg(target_os = "windows")]
    return PlatformKind::Windows;
    #[cfg(target_os = "ios")]
    return PlatformKind::IOS;
    #[cfg(target_os = "android")]
    return PlatformKind::Android;
    #[cfg(target_os = "linux")]
    return PlatformKind::Linux;
    #[allow(unreachable_code)]
    PlatformKind::Unknown
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn new_id() -> [u8; 16] {
    let mut id = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut id);
    id
}

fn id_string(id: [u8; 16]) -> String {
    hex_id(id)
}

fn hex_id(id: [u8; 16]) -> String {
    id.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn parse_id(value: &str) -> Result<[u8; 16], String> {
    if value.len() != 32 {
        return Err("Invalid transfer id".to_string());
    }
    let mut id = [0u8; 16];
    for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
        let text = std::str::from_utf8(chunk).map_err(|_| "Invalid transfer id".to_string())?;
        id[index] = u8::from_str_radix(text, 16).map_err(|_| "Invalid transfer id".to_string())?;
    }
    Ok(id)
}

mod commands {
    use super::*;

    #[tauri::command]
    pub async fn ponlet_snapshot(runtime: State<'_, TauriRuntime>) -> Result<UiSnapshot, String> {
        super::ponlet_snapshot_impl(runtime).await
    }

    #[tauri::command]
    pub async fn ponlet_create_invite(
        app: AppHandle,
        runtime: State<'_, TauriRuntime>,
    ) -> Result<(), String> {
        super::ponlet_create_invite_impl(app, runtime).await
    }

    #[tauri::command]
    pub async fn ponlet_join(
        app: AppHandle,
        runtime: State<'_, TauriRuntime>,
        invite: String,
    ) -> Result<(), String> {
        super::ponlet_join_impl(app, runtime, invite).await
    }

    #[tauri::command]
    pub async fn ponlet_send_text(
        app: AppHandle,
        runtime: State<'_, TauriRuntime>,
        text: String,
    ) -> Result<(), String> {
        super::ponlet_send_text_impl(app, runtime, text).await
    }

    #[tauri::command]
    pub async fn ponlet_send_files(
        app: AppHandle,
        runtime: State<'_, TauriRuntime>,
        files: Vec<FileRequest>,
    ) -> Result<(), String> {
        super::ponlet_send_files_impl(app, runtime, files).await
    }

    #[tauri::command]
    pub async fn ponlet_cancel_transfer(
        app: AppHandle,
        runtime: State<'_, TauriRuntime>,
        id: String,
    ) -> Result<(), String> {
        super::ponlet_cancel_transfer_impl(app, runtime, id).await
    }

    #[tauri::command]
    pub async fn ponlet_disconnect(
        app: AppHandle,
        runtime: State<'_, TauriRuntime>,
    ) -> Result<(), String> {
        super::ponlet_disconnect_impl(app, runtime).await
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime = TauriRuntime::new().expect("Tailcat bridge initialization failed");
    let app = tauri::Builder::default()
        .manage(runtime)
        .invoke_handler(tauri::generate_handler![
            commands::ponlet_snapshot,
            commands::ponlet_create_invite,
            commands::ponlet_join,
            commands::ponlet_send_text,
            commands::ponlet_send_files,
            commands::ponlet_cancel_transfer,
            commands::ponlet_disconnect,
        ])
        .setup(|app| {
            let state = app.state::<TauriRuntime>();
            state.set_state(app.handle(), SessionState::Booting);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Ponlet");
    app.run(|_app, event| {
        if matches!(event, RunEvent::Exit) {
            let _ = NativeTailcatTransport::shutdown();
        }
    });
}
