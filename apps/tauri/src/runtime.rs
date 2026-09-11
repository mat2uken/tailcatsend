use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use futures::channel::{mpsc::Receiver, oneshot};
use rand::RngCore;
use tauri::AppHandle;

use tailsend_core::{
    run_host_handshake, run_joiner_handshake, AppEvent, BackendService, SessionState,
};
use tailsend_native_transport::NativeTailcatTransport;
use tailsend_platform_api::{FileSource, IncomingFileSink, ReceivedItem};
use tailsend_protocol::control::{Capabilities, PeerInfo, PlatformKind};
use tailsend_protocol::invitation::InvitationV1;
use tailsend_protocol::limits::{FILE_PORT, TEXT_PORT};
use tailsend_transfer::{
    receive_live_text_stream, receive_named_file_stream_with_factory, send_live_text_stream,
    send_named_file_stream, ProgressCallback, ProgressUpdate, TransferError,
};
use tailsend_transport_api::{
    DuplexStream, ListenOptions, Listener, TailcatTransport, TransportPath,
};

use crate::model::{
    id_string, new_id, parse_id, FileRequest, UiQrBitmap, UiReceivedItem, UiSnapshot, UiTransfer,
    DERP_MAP_URL, INVITE_BASE_URL, INVITE_LIFETIME_SECS, QUEUE_LIMIT,
};
use crate::storage::{
    app_storage_dir, default_downloads_dir, pick_file_requests, NativeFileSink, NativeFileSource,
};

pub struct PeerSession {
    pub listener: Arc<Box<dyn Listener>>,
    pub peer_address: Mutex<String>,
    pub cancel: Arc<AtomicBool>,
    pub transport_path: Mutex<TransportPath>,
}

pub struct RuntimeState {
    pub session: Option<Arc<PeerSession>>,
    pub active_transfer: Option<[u8; 16]>,
}

pub struct Subscription {
    pub receiver: Receiver<tailsend_core::BackendEvent>,
    pub cancelled: oneshot::Receiver<()>,
}

pub struct TauriRuntime {
    pub backend: BackendService,
    pub transport: Arc<NativeTailcatTransport>,
    pub state: Mutex<RuntimeState>,
    pub downloads_dir: Mutex<PathBuf>,
    pub received: Arc<Mutex<Vec<UiReceivedItem>>>,
    pub subscriptions: Mutex<HashMap<String, Subscription>>,
    pub subscription_cancellers: Mutex<HashMap<String, oneshot::Sender<()>>>,
    pub closed_subscriptions: Mutex<HashSet<String>>,
}

impl TauriRuntime {
    pub fn new() -> Result<Self, String> {
        let transport = NativeTailcatTransport::new().map_err(|error| error.to_string())?;
        Ok(Self {
            backend: BackendService::new(QUEUE_LIMIT),
            transport: Arc::new(transport),
            state: Mutex::new(RuntimeState {
                session: None,
                active_transfer: None,
            }),
            downloads_dir: Mutex::new(default_downloads_dir()),
            received: Arc::new(Mutex::new(Vec::new())),
            subscriptions: Mutex::new(HashMap::new()),
            subscription_cancellers: Mutex::new(HashMap::new()),
            closed_subscriptions: Mutex::new(HashSet::new()),
        })
    }

    pub fn snapshot(&self) -> UiSnapshot {
        let snapshot = self.backend.snapshot();
        let received = self
            .received
            .lock()
            .expect("received item mutex poisoned")
            .clone();
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
            received,
        }
    }

    pub fn publish(&self, event: AppEvent) {
        self.backend.emit(event);
    }

    pub fn set_state(&self, state: SessionState) {
        self.backend.set_state(state);
    }

    pub fn register_transfer(&self, transfer_id: [u8; 16]) -> Arc<AtomicBool> {
        let mut state = self.state.lock().expect("runtime state mutex poisoned");
        state.active_transfer = Some(transfer_id);
        self.backend.register_transfer(transfer_id)
    }

    pub fn finish_transfer(&self, transfer_id: [u8; 16]) {
        let mut state = self.state.lock().expect("runtime state mutex poisoned");
        if state.active_transfer == Some(transfer_id) {
            state.active_transfer = None;
        }
        self.backend.finish_transfer(transfer_id);
    }

    pub fn session(&self) -> Result<Arc<PeerSession>, String> {
        self.state
            .lock()
            .expect("runtime state mutex poisoned")
            .session
            .clone()
            .ok_or_else(|| "No connected peer".to_string())
    }

    pub fn set_session(&self, session: Arc<PeerSession>) {
        self.state
            .lock()
            .expect("runtime state mutex poisoned")
            .session = Some(session);
    }

    pub fn take_session(&self) -> Option<Arc<PeerSession>> {
        self.state
            .lock()
            .expect("runtime state mutex poisoned")
            .session
            .take()
    }

    pub fn session_is_current(&self, session: &Arc<PeerSession>) -> bool {
        self.state
            .lock()
            .expect("runtime state mutex poisoned")
            .session
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, session))
    }

    pub fn take_session_if_current(&self, session: &Arc<PeerSession>) -> bool {
        let mut state = self.state.lock().expect("runtime state mutex poisoned");
        if state
            .session
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            state.session = None;
            true
        } else {
            false
        }
    }

    pub async fn disconnect_internal(&self) -> Result<(), String> {
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
        self.set_state(SessionState::Disconnected {
            reason: "ready".to_string(),
        });
        Ok(())
    }

    pub fn clone_state(&self) -> Arc<TauriState> {
        Arc::new(TauriState {
            backend: self.backend.clone(),
            downloads_dir: self
                .downloads_dir
                .lock()
                .expect("downloads directory mutex poisoned")
                .clone(),
            received: self.received.clone(),
        })
    }

    pub fn configure_storage(&self, app: &AppHandle) {
        let directory = app_storage_dir(app);
        *self
            .downloads_dir
            .lock()
            .expect("downloads directory mutex poisoned") = directory;
    }

    pub fn take_subscription(&self, id: &str) -> Option<Subscription> {
        self.subscriptions
            .lock()
            .expect("subscription mutex poisoned")
            .remove(id)
    }

    pub fn has_subscription(&self, id: &str) -> bool {
        self.subscriptions
            .lock()
            .expect("subscription mutex poisoned")
            .contains_key(id)
    }

    pub fn ensure_subscription(&self, id: &str) -> Result<UiSnapshot, String> {
        if id.is_empty() {
            return Err("IPC subscription id is required".to_string());
        }
        if self.is_subscription_closed(id) {
            return Err("IPC subscription is closed".to_string());
        }
        if !self.has_subscription(id) {
            let (_snapshot, receiver) = self.backend.subscribe_with_snapshot();
            let (cancel_tx, cancel_rx) = oneshot::channel();
            self.subscription_cancellers
                .lock()
                .expect("subscription cancellation mutex poisoned")
                .insert(id.to_string(), cancel_tx);
            self.store_subscription(
                id.to_string(),
                Subscription {
                    receiver,
                    cancelled: cancel_rx,
                },
            );
        }
        Ok(self.snapshot())
    }

    pub fn store_subscription(&self, id: String, subscription: Subscription) {
        if self.is_subscription_closed(&id) {
            return;
        }
        self.subscriptions
            .lock()
            .expect("subscription mutex poisoned")
            .insert(id, subscription);
    }

    pub fn drop_subscription(&self, id: &str) {
        self.subscriptions
            .lock()
            .expect("subscription mutex poisoned")
            .remove(id);
        if let Some(cancel) = self
            .subscription_cancellers
            .lock()
            .expect("subscription cancellation mutex poisoned")
            .remove(id)
        {
            let _ = cancel.send(());
        }
    }

    pub fn replace_subscription(&self, id: &str) -> Result<UiSnapshot, String> {
        if self.is_subscription_closed(id) {
            return Err("IPC subscription is closed".to_string());
        }
        self.drop_subscription(id);
        self.ensure_subscription(id)
    }

    pub fn remove_subscription(&self, id: &str) {
        self.drop_subscription(id);
        self.closed_subscriptions
            .lock()
            .expect("closed subscription mutex poisoned")
            .insert(id.to_string());
    }

    pub fn is_subscription_closed(&self, id: &str) -> bool {
        self.closed_subscriptions
            .lock()
            .expect("closed subscription mutex poisoned")
            .contains(id)
    }

    pub fn received(&self) -> &Arc<Mutex<Vec<UiReceivedItem>>> {
        &self.received
    }
}

pub struct TauriState {
    pub backend: BackendService,
    pub downloads_dir: PathBuf,
    pub received: Arc<Mutex<Vec<UiReceivedItem>>>,
}

impl TauriState {
    pub fn set_state(&self, state: SessionState) {
        self.backend.set_state(state);
    }

    pub fn publish_progress(&self, update: ProgressUpdate) {
        let _ = self.backend.progress(
            update.transfer_id,
            update.bytes_transferred,
            update.total_bytes,
        );
    }

    pub fn set_transport_path(&self, path: TransportPath) {
        self.backend.set_transport_path(path);
    }

    pub fn add_received(&self, item: ReceivedItem) -> UiReceivedItem {
        let item = UiReceivedItem {
            name: item.name,
            size: item.size,
            local_path_or_handle: item.local_path_or_handle,
        };
        self.received
            .lock()
            .expect("received item mutex poisoned")
            .push(item.clone());
        item
    }
}

pub async fn accept_loop(runtime: Arc<TauriState>, session: Arc<PeerSession>) {
    loop {
        if session.cancel.load(Ordering::Acquire) {
            return;
        }
        let incoming = match session.listener.accept().await {
            Ok(incoming) => incoming,
            Err(error) => {
                if !session.cancel.load(Ordering::Acquire) {
                    runtime.set_state(SessionState::Error {
                        code: 1100,
                        message: error.to_string(),
                    });
                }
                return;
            }
        };
        runtime.set_transport_path(incoming.stream.transport_path());
        let runtime_for_stream = runtime.clone();
        tokio::spawn(async move {
            match incoming.port {
                TEXT_PORT => receive_text(runtime_for_stream, incoming.stream).await,
                FILE_PORT => receive_file(runtime_for_stream, incoming.stream).await,
                _ => {
                    let mut stream = incoming.stream;
                    let _ = stream.close().await;
                }
            }
        });
    }
}

pub async fn receive_text(runtime: Arc<TauriState>, mut stream: Box<dyn DuplexStream>) {
    let transfer_id = new_id();
    let cancel_token = runtime.backend.register_transfer(transfer_id);
    if let Some(callback) = stream.cancellation_callback() {
        runtime
            .backend
            .set_cancellation_callback(transfer_id, callback);
    }
    let result = receive_live_text_stream(&mut stream, cancel_token, |text| {
        runtime.backend.emit(AppEvent::TextReceived { text });
    })
    .await;
    runtime.set_transport_path(stream.transport_path());
    let _ = stream.close().await;
    if let Err(error) = result {
        let cancelled = runtime.backend.is_cancelled(transfer_id);
        let reason = if cancelled {
            "Transfer cancelled by user".to_string()
        } else {
            error.to_string()
        };
        runtime.backend.emit(AppEvent::TransferCancelled {
            transfer_id,
            reason: reason.clone(),
        });
    }
    runtime.backend.finish_transfer(transfer_id);
    set_idle_from_backend(&runtime.backend);
}

pub async fn receive_file(runtime: Arc<TauriState>, mut stream: Box<dyn DuplexStream>) {
    let transfer_id = new_id();
    let cancel_token = runtime.backend.register_transfer(transfer_id);
    if let Some(callback) = stream.cancellation_callback() {
        runtime
            .backend
            .set_cancellation_callback(transfer_id, callback);
    }
    let backend_for_progress = runtime.clone();
    let callback: ProgressCallback = Box::new(move |update| {
        backend_for_progress.publish_progress(update);
    });
    let result = receive_named_file_stream_with_factory(
        &mut stream,
        |header| {
            let path = runtime.downloads_dir.clone();
            let name = header.name.clone();
            runtime.set_state(SessionState::Transferring {
                transfer_id,
                is_incoming: true,
                is_files: true,
                bytes_done: 0,
                bytes_total: header.size,
                current_item_name: name.clone(),
            });
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
    runtime.set_transport_path(stream.transport_path());
    let _ = stream.close().await;
    match result {
        Ok(received) => {
            let _item = runtime.add_received(received.item.clone());
            runtime.backend.emit(AppEvent::FilesReceived {
                items: vec![received.item],
            });
            runtime
                .backend
                .emit(AppEvent::TransferCompleted { transfer_id });
        }
        Err(error) => {
            let cancelled = runtime.backend.is_cancelled(transfer_id);
            let reason = if cancelled {
                "Transfer cancelled by user".to_string()
            } else {
                error.to_string()
            };
            runtime.backend.emit(AppEvent::TransferCancelled {
                transfer_id,
                reason: reason.clone(),
            });
        }
    }
    runtime.backend.finish_transfer(transfer_id);
    set_idle_from_backend(&runtime.backend);
}

pub fn finish_outgoing(
    runtime: &TauriRuntime,
    transfer_id: [u8; 16],
    result: Result<(), TransferError>,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let (event, failed) = match result {
        Ok(()) => (AppEvent::TransferCompleted { transfer_id }, false),
        Err(_error) if cancel.load(Ordering::Acquire) => (
            AppEvent::TransferCancelled {
                transfer_id,
                reason: "Transfer cancelled by user".to_string(),
            },
            false,
        ),
        Err(error) => (
            AppEvent::TransferCancelled {
                transfer_id,
                reason: error.to_string(),
            },
            true,
        ),
    };
    runtime.publish(event);
    runtime.finish_transfer(transfer_id);
    set_idle_from_backend(&runtime.backend);
    if failed {
        Err("Transfer failed".to_string())
    } else {
        Ok(())
    }
}

pub fn set_idle_from_backend(backend: &BackendService) {
    let name = backend.snapshot().app.peer_display_name;
    if name.is_empty() {
        return;
    }
    backend.set_state(SessionState::ConnectedIdle {
        peer_info: PeerInfo::new_native(
            name,
            PlatformKind::Unknown,
            env!("CARGO_PKG_VERSION").to_string(),
        ),
        peer_capabilities: Capabilities::default(),
        peer_address: String::new(),
        transport_path: backend.snapshot().app.transport_path,
    });
}

pub fn local_peer_info() -> PeerInfo {
    PeerInfo::new_native(
        "Ponlet".to_string(),
        current_platform(),
        env!("CARGO_PKG_VERSION").to_string(),
    )
}

pub fn current_platform() -> PlatformKind {
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

pub fn listen_options() -> ListenOptions {
    ListenOptions {
        derp_map_url: std::env::var("PONLET_DERP_MAP_URL")
            .unwrap_or_else(|_| DERP_MAP_URL.to_string()),
        verbose: false,
    }
}

pub fn invite_base_url() -> String {
    std::env::var("PONLET_INVITE_BASE_URL").unwrap_or_else(|_| INVITE_BASE_URL.to_string())
}

pub fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn ponlet_qr_code_impl(url: String) -> Result<UiQrBitmap, String> {
    let image = tailsend_qr::generate_qr_rgba(&url, 256).map_err(|error| error.to_string())?;
    Ok(UiQrBitmap {
        width: image.width,
        height: image.height,
        rgba_pixels: image.rgba_pixels,
    })
}

pub async fn ponlet_snapshot_impl(runtime: &TauriRuntime) -> Result<UiSnapshot, String> {
    Ok(runtime.snapshot())
}

pub async fn ponlet_create_invite_impl(runtime: &TauriRuntime) -> Result<(), String> {
    runtime.disconnect_internal().await?;
    runtime.set_state(SessionState::Booting);
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
        transport_path: Mutex::new(TransportPath::Unknown),
    });
    runtime.set_session(session.clone());
    runtime.set_state(SessionState::AwaitingPeer {
        invite_url,
        expires_at: now + INVITE_LIFETIME_SECS,
        host_address,
    });

    let backend = runtime.clone_state();
    let host_info = local_peer_info();
    let host_caps = Capabilities::default();
    tokio::spawn(async move {
        let result = run_host_handshake(
            &**session.listener,
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
                *session
                    .transport_path
                    .lock()
                    .expect("session mutex poisoned") = handshake.transport_path;
                backend.set_state(SessionState::ConnectedIdle {
                    peer_info: handshake.peer_info,
                    peer_capabilities: handshake.peer_capabilities,
                    peer_address: handshake.peer_address,
                    transport_path: handshake.transport_path,
                });
                accept_loop(backend, session).await;
            }
            Err(error) => {
                // Closing a listener cancels an in-flight accept while a new
                // invitation is being created.  The old handshake task must
                // not overwrite the state of that replacement session with
                // its expected ListenerClosed error.
                if !session.cancel.load(Ordering::Acquire) {
                    backend.set_state(SessionState::Error {
                        code: 1001,
                        message: error,
                    });
                }
            }
        }
    });
    Ok(())
}

pub async fn ponlet_join_impl(runtime: &TauriRuntime, invite: String) -> Result<(), String> {
    runtime.disconnect_internal().await?;
    let invitation =
        InvitationV1::from_url(&invite, unix_seconds()).map_err(|error| error.to_string())?;
    runtime.set_state(SessionState::DialingHost {
        host_address: invitation.host_address.clone(),
    });
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
        transport_path: Mutex::new(TransportPath::Unknown),
    });
    runtime.set_session(session.clone());
    let transport: Arc<dyn TailcatTransport> = runtime.transport.clone();
    let joiner_info = local_peer_info();
    let joiner_caps = Capabilities::default();
    runtime.set_state(SessionState::Authenticating);
    match run_joiner_handshake(
        &transport,
        &**session.listener,
        &invitation,
        &joiner_info,
        &joiner_caps,
    )
    .await
    {
        Ok(handshake) => {
            if session.cancel.load(Ordering::Acquire) || !runtime.session_is_current(&session) {
                let _ = session.listener.close().await;
                return Err("Operation cancelled".to_string());
            }
            *session
                .transport_path
                .lock()
                .expect("session mutex poisoned") = handshake.transport_path;
            runtime.set_state(SessionState::ConnectedIdle {
                peer_info: handshake.peer_info,
                peer_capabilities: handshake.peer_capabilities,
                peer_address: handshake.peer_address,
                transport_path: handshake.transport_path,
            });
            let backend = runtime.clone_state();
            tokio::spawn(async move { accept_loop(backend, session).await });
            Ok(())
        }
        Err(error) => {
            let _ = session.listener.close().await;
            if runtime.take_session_if_current(&session) {
                runtime.set_state(SessionState::Error {
                    code: 1002,
                    message: error.clone(),
                });
            }
            Err(error)
        }
    }
}

pub async fn ponlet_send_text_impl(runtime: &TauriRuntime, text: String) -> Result<(), String> {
    let session = runtime.session()?;
    let transfer_id = new_id();
    let cancel = runtime.register_transfer(transfer_id);
    runtime.set_state(SessionState::Transferring {
        transfer_id,
        is_incoming: false,
        is_files: false,
        bytes_done: 0,
        bytes_total: text.len() as u64,
        current_item_name: "Message".to_string(),
    });
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
                runtime,
                transfer_id,
                Err(TransferError::Transport(error)),
                cancel,
            )
        }
    };
    if let Some(callback) = stream.cancellation_callback() {
        runtime
            .backend
            .set_cancellation_callback(transfer_id, callback);
    }
    runtime.publish(AppEvent::TransportChanged(stream.transport_path()));
    let result = send_live_text_stream(&mut stream, &text, cancel.clone()).await;
    let _ = stream.close().await;
    finish_outgoing(runtime, transfer_id, result.map(|_| ()), cancel)
}

pub async fn ponlet_send_files_impl(
    app: AppHandle,
    runtime: &TauriRuntime,
    files: Vec<FileRequest>,
) -> Result<(), String> {
    if files.is_empty() {
        return Err("No files selected".to_string());
    }
    let session = runtime.session()?;
    for request in files {
        let source = NativeFileSource::open(&app, request).await?;
        let transfer_id = new_id();
        let cancel = runtime.register_transfer(transfer_id);
        let metadata = source.metadata();
        runtime.set_state(SessionState::Transferring {
            transfer_id,
            is_incoming: false,
            is_files: true,
            bytes_done: 0,
            bytes_total: metadata.size,
            current_item_name: metadata.name.clone(),
        });
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
                    runtime,
                    transfer_id,
                    Err(TransferError::Transport(error)),
                    cancel,
                );
            }
        };
        if let Some(callback) = stream.cancellation_callback() {
            runtime
                .backend
                .set_cancellation_callback(transfer_id, callback);
        }
        runtime.publish(AppEvent::TransportChanged(stream.transport_path()));
        let backend_for_progress = runtime.clone_state();
        let callback: ProgressCallback = Box::new(move |update| {
            backend_for_progress.publish_progress(update);
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
        finish_outgoing(runtime, transfer_id, result.map(|_| ()), cancel)?;
    }
    Ok(())
}

pub async fn ponlet_pick_and_send_files_impl(
    app: AppHandle,
    runtime: &TauriRuntime,
) -> Result<(), String> {
    let files = pick_file_requests(&app)?;
    if files.is_empty() {
        return Ok(());
    }
    ponlet_send_files_impl(app, runtime, files).await
}

pub async fn ponlet_cancel_transfer_impl(runtime: &TauriRuntime, id: String) -> Result<(), String> {
    let transfer_id = parse_id(&id)?;
    if !runtime.backend.cancel(transfer_id) {
        return Err("Transfer is no longer active".to_string());
    }
    Ok(())
}

pub async fn ponlet_disconnect_impl(runtime: &TauriRuntime) -> Result<(), String> {
    runtime.disconnect_internal().await
}
