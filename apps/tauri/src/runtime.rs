#[cfg(target_os = "ios")]
use std::collections::VecDeque;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use futures::channel::{mpsc::Receiver, oneshot};
use rand::RngCore;
use tauri::AppHandle;

use tailsend_core::{
    read_framed_control, run_host_handshake, run_host_handshake_stream, run_joiner_handshake,
    write_framed_control, AppEvent, BackendService, BackendSession, HostHandshakeError,
    SessionState, TRANSFER_CANCELLED_BY_PEER, TRANSFER_CANCELLED_BY_USER,
};
use tailsend_native_transport::NativeTailcatTransport;
use tailsend_platform_api::{FileSource, IncomingFileSink, ReceivedItem};
use tailsend_protocol::control::{
    Capabilities, ControlMessage, ErrorBody, MessageBody, MessageType, PeerInfo, PlatformKind,
};
use tailsend_protocol::invitation::InvitationV1;
use tailsend_protocol::limits::{CONTROL_PORT, DEFAULT_INVITE_LIFETIME_SECS, FILE_PORT, TEXT_PORT};
use tailsend_transfer::{
    receive_live_text_message_stream, receive_named_file_stream_with_factory,
    send_live_text_stream, send_named_file_stream, ProgressCallback, ProgressUpdate, TransferError,
};
use tailsend_transport_api::{
    DuplexStream, ListenOptions, Listener, TailcatTransport, TransportPath,
};

use crate::model::{
    new_id, parse_id, FileRequest, SharedImportSummary, UiQrBitmap, UiReceivedItem, UiSnapshot,
    DERP_MAP_URL, INVITE_BASE_URL, QUEUE_LIMIT,
};
#[cfg(target_os = "ios")]
use crate::model::{SharedPendingItem, SHARED_QUEUE_LIMIT, SHARED_TEXT_MAX_BYTES};
use crate::storage::{
    app_storage_dir, default_downloads_dir, pick_file_requests, NativeFileSink, NativeFileSource,
};

pub struct PeerSession {
    pub scope: BackendSession,
    pub listener: Arc<Box<dyn Listener>>,
    /// Retained by the host so a repeated join for the same invitation can be
    /// verified and replace the previous peer instead of failing with an EOF.
    pub invitation: Option<InvitationV1>,
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

#[cfg(target_os = "ios")]
pub(crate) enum PendingShare {
    Text { id: String, text: String },
    File { id: String, request: FileRequest },
}

#[cfg(target_os = "ios")]
impl PendingShare {
    fn id(&self) -> &str {
        match self {
            Self::Text { id, .. } | Self::File { id, .. } => id,
        }
    }

    fn ui_item(&self) -> SharedPendingItem {
        match self {
            Self::Text { text, .. } => {
                let mut chars = text.chars();
                let preview: String = chars.by_ref().take(120).collect();
                let preview = if preview.is_empty() {
                    None
                } else if chars.next().is_some() {
                    Some(format!("{preview}…"))
                } else {
                    Some(preview)
                };
                SharedPendingItem {
                    kind: "text".to_string(),
                    name: "shared-text.txt".to_string(),
                    size: text.len() as u64,
                    preview,
                }
            }
            Self::File { request, .. } => SharedPendingItem {
                kind: "file".to_string(),
                name: request.name.clone(),
                size: request.size,
                preview: None,
            },
        }
    }
}

#[cfg(target_os = "ios")]
#[derive(Default)]
pub(crate) struct PendingShareQueue {
    items: VecDeque<PendingShare>,
    ids: HashSet<String>,
    acknowledgement_pending: HashSet<String>,
    draining: bool,
}

#[cfg(target_os = "ios")]
impl PendingShareQueue {
    fn enqueue(&mut self, item: PendingShare) -> Result<bool, String> {
        let id = item.id().to_owned();
        if self.ids.contains(&id) || self.acknowledgement_pending.contains(&id) {
            return Ok(false);
        }
        if self.items.len() >= SHARED_QUEUE_LIMIT {
            return Err(format!(
                "Too many shared items are waiting (limit: {SHARED_QUEUE_LIMIT})"
            ));
        }
        self.ids.insert(id);
        self.items.push_back(item);
        Ok(true)
    }

    fn take(&mut self) -> Option<PendingShare> {
        self.items.pop_front()
    }

    fn requeue_front(&mut self, item: PendingShare) {
        self.items.push_front(item);
    }

    fn complete(&mut self, id: &str) {
        self.ids.remove(id);
    }

    fn mark_acknowledgement_pending(&mut self, id: String) {
        self.acknowledgement_pending.insert(id);
    }

    fn clear_acknowledgement(&mut self, id: &str) {
        self.acknowledgement_pending.remove(id);
    }

    fn contains(&self, id: &str) -> bool {
        self.ids.contains(id) || self.acknowledgement_pending.contains(id)
    }

    fn acknowledgement_ids(&self) -> Vec<String> {
        self.acknowledgement_pending.iter().cloned().collect()
    }

    fn len(&self) -> usize {
        self.items.len()
    }

    fn ui_items(&self) -> Vec<SharedPendingItem> {
        self.items.iter().map(PendingShare::ui_item).collect()
    }
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
    #[cfg(target_os = "ios")]
    pub(crate) pending_shares: Mutex<PendingShareQueue>,
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
            #[cfg(target_os = "ios")]
            pending_shares: Mutex::new(PendingShareQueue::default()),
        })
    }

    pub fn snapshot(&self) -> UiSnapshot {
        let snapshot = self.backend.snapshot();
        let received = self
            .received
            .lock()
            .expect("received item mutex poisoned")
            .clone();
        UiSnapshot::from_backend(snapshot, received)
    }

    pub fn set_state(&self, state: SessionState) {
        self.backend.set_state(state);
    }

    pub fn register_transfer(
        &self,
        scope: &BackendSession,
        transfer_id: [u8; 16],
    ) -> Arc<AtomicBool> {
        let mut state = self.state.lock().expect("runtime state mutex poisoned");
        state.active_transfer = Some(transfer_id);
        scope.register_transfer(transfer_id)
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
            .filter(|session| session.scope.has_peer() && !session.cancel.load(Ordering::Acquire))
            .ok_or_else(|| "No connected peer".to_string())
    }

    pub fn set_session(&self, session: Arc<PeerSession>) {
        let mut state = self.state.lock().expect("runtime state mutex poisoned");
        if session.scope.is_current()
            && state
                .session
                .as_ref()
                .is_none_or(|current| current.scope.generation() <= session.scope.generation())
        {
            state.session = Some(session);
        }
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

    async fn close_session(&self) -> Result<(), String> {
        if let Some(session) = self.take_session() {
            session.cancel.store(true, Ordering::Release);
            session
                .listener
                .close()
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub async fn disconnect_internal(&self) -> Result<(), String> {
        let scope = self.backend.begin_session();
        // Invalidate callbacks and clear the UI before waiting for I/O to close.
        scope.set_state(SessionState::Disconnected {
            reason: "ready".to_string(),
        });
        self.close_session().await
    }

    pub fn clone_state(&self, scope: BackendSession) -> Arc<TauriState> {
        Arc::new(TauriState {
            backend: scope,
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

    #[cfg(target_os = "ios")]
    fn enqueue_pending_share(&self, item: PendingShare) -> Result<bool, String> {
        self.pending_shares
            .lock()
            .expect("pending share mutex poisoned")
            .enqueue(item)
    }

    #[cfg(target_os = "ios")]
    fn begin_pending_share_drain(&self) -> bool {
        let mut queue = self
            .pending_shares
            .lock()
            .expect("pending share mutex poisoned");
        if queue.draining || queue.items.is_empty() {
            return false;
        }
        queue.draining = true;
        true
    }

    #[cfg(target_os = "ios")]
    fn take_pending_share(&self) -> Option<PendingShare> {
        self.pending_shares
            .lock()
            .expect("pending share mutex poisoned")
            .take()
    }

    #[cfg(target_os = "ios")]
    fn requeue_pending_share(&self, item: PendingShare) {
        self.pending_shares
            .lock()
            .expect("pending share mutex poisoned")
            .requeue_front(item);
    }

    #[cfg(target_os = "ios")]
    fn complete_pending_share(&self, id: &str) {
        self.pending_shares
            .lock()
            .expect("pending share mutex poisoned")
            .complete(id);
    }

    #[cfg(target_os = "ios")]
    fn mark_pending_share_acknowledgement(&self, id: String) {
        self.pending_shares
            .lock()
            .expect("pending share mutex poisoned")
            .mark_acknowledgement_pending(id);
    }

    #[cfg(target_os = "ios")]
    fn clear_pending_share_acknowledgement(&self, id: &str) {
        self.pending_shares
            .lock()
            .expect("pending share mutex poisoned")
            .clear_acknowledgement(id);
    }

    #[cfg(target_os = "ios")]
    fn pending_share_contains(&self, id: &str) -> bool {
        self.pending_shares
            .lock()
            .expect("pending share mutex poisoned")
            .contains(id)
    }

    #[cfg(target_os = "ios")]
    fn pending_share_len(&self) -> usize {
        self.pending_shares
            .lock()
            .expect("pending share mutex poisoned")
            .len()
    }

    #[cfg(target_os = "ios")]
    fn pending_share_items(&self) -> Vec<SharedPendingItem> {
        self.pending_shares
            .lock()
            .expect("pending share mutex poisoned")
            .ui_items()
    }

    #[cfg(target_os = "ios")]
    fn pending_share_acknowledgements(&self) -> Vec<String> {
        self.pending_shares
            .lock()
            .expect("pending share mutex poisoned")
            .acknowledgement_ids()
    }

    #[cfg(target_os = "ios")]
    fn finish_pending_share_drain(&self) {
        self.pending_shares
            .lock()
            .expect("pending share mutex poisoned")
            .draining = false;
    }
}

pub struct TauriState {
    pub backend: BackendSession,
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
        if session.cancel.load(Ordering::Acquire) || !session.scope.is_current() {
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
        if !session.scope.is_current() {
            let mut stream = incoming.stream;
            let _ = stream.close().await;
            return;
        }
        runtime.set_transport_path(incoming.stream.transport_path());
        let runtime_for_stream = runtime.clone();
        let session_for_stream = session.clone();
        tokio::spawn(async move {
            match incoming.port {
                TEXT_PORT => receive_text(runtime_for_stream, incoming.stream).await,
                FILE_PORT => receive_file(runtime_for_stream, incoming.stream).await,
                CONTROL_PORT => {
                    accept_repeated_join(runtime_for_stream, session_for_stream, incoming.stream)
                        .await
                }
                _ => {
                    let mut stream = incoming.stream;
                    let _ = stream.close().await;
                }
            }
        });
    }
}

/// Handle a control connection that arrives after this session is connected.
///
/// A phone browser can load the invitation twice (a background preview that
/// the browser later restores or reloads) or reload while connected. Dropping
/// that connection leaves the visible page stuck before the connection while
/// the host still shows the previous peer. Instead, verify the retained
/// invitation again and replace the peer with the new connection.
async fn accept_repeated_join(
    runtime: Arc<TauriState>,
    session: Arc<PeerSession>,
    mut stream: Box<dyn DuplexStream>,
) {
    if session.cancel.load(Ordering::Acquire) || !session.scope.is_current() {
        let _ = stream.close().await;
        return;
    }
    let Some(invitation) = session.invitation.clone() else {
        let _ = stream.close().await;
        return;
    };
    if invitation.validate(unix_seconds()).is_err() {
        // Read the ClientHello first so the joiner can finish writing before
        // the rejection closes the stream.
        let _ = read_framed_control(&mut stream).await;
        write_control_error(
            &mut stream,
            &invitation.session_id,
            1004,
            "The invitation has expired",
        )
        .await;
        let _ = stream.close().await;
        return;
    }
    match run_host_handshake_stream(
        &mut stream,
        session.listener.local_address(),
        invitation.session_id,
        invitation.invite_secret,
        &local_peer_info(),
        &Capabilities::default(),
    )
    .await
    {
        Ok(handshake) => {
            if session.cancel.load(Ordering::Acquire) || !session.scope.is_current() {
                return;
            }
            *session.peer_address.lock().expect("session mutex poisoned") =
                handshake.peer_address.clone();
            *session
                .transport_path
                .lock()
                .expect("session mutex poisoned") = handshake.transport_path;
            runtime.backend.set_state(SessionState::ConnectedIdle {
                peer_info: handshake.peer_info,
                peer_capabilities: handshake.peer_capabilities,
                peer_address: handshake.peer_address,
                transport_path: handshake.transport_path,
            });
        }
        Err(HostHandshakeError::Rejected { code, detail }) => {
            write_control_error(&mut stream, &invitation.session_id, code, &detail).await;
        }
        Err(HostHandshakeError::Failed(_)) => {}
    }
    let _ = stream.close().await;
}

async fn write_control_error(
    stream: &mut Box<dyn DuplexStream>,
    session_id: &[u8; 16],
    code: u32,
    detail: &str,
) {
    let message = ControlMessage::new(
        MessageType::Error,
        session_id,
        1,
        None,
        Some(MessageBody::Error(ErrorBody {
            error_code: code,
            detail: Some(detail.to_string()),
        })),
    );
    let _ = write_framed_control(stream, &message).await;
}

pub async fn receive_text(runtime: Arc<TauriState>, mut stream: Box<dyn DuplexStream>) {
    if !runtime.backend.is_current() {
        let _ = stream.close().await;
        return;
    }
    let transfer_id = new_id();
    let cancel_token = runtime.backend.register_transfer(transfer_id);
    if let Some(callback) = stream.cancellation_callback() {
        runtime
            .backend
            .set_cancellation_callback(transfer_id, callback);
    }
    let result = receive_live_text_message_stream(&mut stream, cancel_token, |text| {
        runtime.backend.emit(AppEvent::TextReceived { text });
    })
    .await;
    runtime.set_transport_path(stream.transport_path());
    let _ = stream.close().await;
    if let Err(error) = result {
        let cancelled = runtime.backend.is_cancelled(transfer_id);
        let reason = if cancelled {
            TRANSFER_CANCELLED_BY_USER.to_string()
        } else if error.is_peer_cancelled() {
            TRANSFER_CANCELLED_BY_PEER.to_string()
        } else {
            error.to_string()
        };
        runtime.backend.emit(AppEvent::TransferCancelled {
            transfer_id,
            reason: reason.clone(),
        });
    }
    runtime.backend.finish_transfer(transfer_id);
    runtime.backend.restore_connected_idle(transfer_id);
}

pub async fn receive_file(runtime: Arc<TauriState>, mut stream: Box<dyn DuplexStream>) {
    if !runtime.backend.is_current() {
        let _ = stream.close().await;
        return;
    }
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
        Ok(received) if runtime.backend.is_current() => {
            let _item = runtime.add_received(received.item.clone());
            runtime.backend.emit(AppEvent::FilesReceived {
                items: vec![received.item],
            });
            runtime
                .backend
                .emit(AppEvent::TransferCompleted { transfer_id });
        }
        Ok(_) => {}
        Err(error) => {
            let cancelled = runtime.backend.is_cancelled(transfer_id);
            let reason = if cancelled {
                TRANSFER_CANCELLED_BY_USER.to_string()
            } else if error.is_peer_cancelled() {
                TRANSFER_CANCELLED_BY_PEER.to_string()
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
    runtime.backend.restore_connected_idle(transfer_id);
}

pub fn finish_outgoing(
    runtime: &TauriRuntime,
    scope: &BackendSession,
    transfer_id: [u8; 16],
    result: Result<(), TransferError>,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let locally_cancelled = cancel.load(Ordering::Acquire);
    let remotely_cancelled = matches!(&result, Err(error) if error.is_peer_cancelled());
    let (event, failed) = match result {
        Ok(()) => (AppEvent::TransferCompleted { transfer_id }, false),
        Err(_error) if locally_cancelled || remotely_cancelled => (
            AppEvent::TransferCancelled {
                transfer_id,
                reason: if locally_cancelled {
                    TRANSFER_CANCELLED_BY_USER.to_string()
                } else {
                    TRANSFER_CANCELLED_BY_PEER.to_string()
                },
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
    scope.emit(event);
    runtime.finish_transfer(transfer_id);
    scope.restore_connected_idle(transfer_id);
    if failed {
        Err("Transfer failed".to_string())
    } else {
        Ok(())
    }
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

pub async fn ponlet_create_invite_impl(runtime: &TauriRuntime) -> Result<(), String> {
    let scope = runtime.backend.begin_session();
    runtime.close_session().await?;
    if !scope.is_current() {
        return Err("Operation cancelled".into());
    }
    scope.set_state(SessionState::Booting);
    let listener = runtime
        .transport
        .listen(listen_options())
        .await
        .map_err(|error| {
            scope.set_state(SessionState::Error {
                code: 1000,
                message: error.to_string(),
            });
            error.to_string()
        })?;
    if !scope.is_current() {
        let _ = listener.close().await;
        return Err("Operation cancelled".into());
    }
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
        DEFAULT_INVITE_LIFETIME_SECS,
    );
    let invite_url = invitation
        .to_qr_url(&invite_base_url())
        .map_err(|error| error.to_string())?;
    if !scope.is_current() {
        let _ = listener.close().await;
        return Err("Operation cancelled".into());
    }
    let session = Arc::new(PeerSession {
        scope: scope.clone(),
        listener: listener.clone(),
        invitation: Some(invitation.clone()),
        peer_address: Mutex::new(String::new()),
        cancel: Arc::new(AtomicBool::new(false)),
        transport_path: Mutex::new(TransportPath::Unknown),
    });
    runtime.set_session(session.clone());
    scope.set_state(SessionState::AwaitingPeer {
        invite_url,
        expires_at: now + DEFAULT_INVITE_LIFETIME_SECS,
        host_address,
    });

    let backend = runtime.clone_state(scope.clone());
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
                if session.cancel.load(Ordering::Acquire) || !scope.is_current() {
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
    let invitation =
        InvitationV1::from_url(&invite, unix_seconds()).map_err(|error| error.to_string())?;
    let scope = runtime.backend.begin_session();
    runtime.close_session().await?;
    if !scope.is_current() {
        return Err("Operation cancelled".into());
    }
    scope.set_state(SessionState::DialingHost {
        host_address: invitation.host_address.clone(),
    });
    let listener = Arc::new(
        runtime
            .transport
            .listen(listen_options())
            .await
            .map_err(|error| {
                scope.set_state(SessionState::Error {
                    code: 1000,
                    message: error.to_string(),
                });
                error.to_string()
            })?,
    );
    if !scope.is_current() {
        let _ = listener.close().await;
        return Err("Operation cancelled".into());
    }
    let session = Arc::new(PeerSession {
        scope: scope.clone(),
        listener: listener.clone(),
        invitation: None,
        peer_address: Mutex::new(invitation.host_address.clone()),
        cancel: Arc::new(AtomicBool::new(false)),
        transport_path: Mutex::new(TransportPath::Unknown),
    });
    runtime.set_session(session.clone());
    let transport: Arc<dyn TailcatTransport> = runtime.transport.clone();
    let joiner_info = local_peer_info();
    let joiner_caps = Capabilities::default();
    scope.set_state(SessionState::Authenticating);
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
            scope.set_state(SessionState::ConnectedIdle {
                peer_info: handshake.peer_info,
                peer_capabilities: handshake.peer_capabilities,
                peer_address: handshake.peer_address,
                transport_path: handshake.transport_path,
            });
            let backend = runtime.clone_state(scope.clone());
            tokio::spawn(async move { accept_loop(backend, session).await });
            Ok(())
        }
        Err(error) => {
            let _ = session.listener.close().await;
            if runtime.take_session_if_current(&session) {
                scope.set_state(SessionState::Error {
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
    let scope = &session.scope;
    let transfer_id = new_id();
    let cancel = runtime.register_transfer(scope, transfer_id);
    scope.set_state(SessionState::Transferring {
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
                scope,
                transfer_id,
                Err(TransferError::Transport(error)),
                cancel.clone(),
            )
            .and_then(|()| {
                if cancel.load(Ordering::Acquire) {
                    Err("Transfer cancelled by user".into())
                } else {
                    Ok(())
                }
            })
        }
    };
    if let Some(callback) = stream.cancellation_callback() {
        scope.set_cancellation_callback(transfer_id, callback);
    }
    scope.emit(AppEvent::TransportChanged(stream.transport_path()));
    let result = send_live_text_stream(&mut stream, &text, cancel.clone()).await;
    let remotely_cancelled = matches!(&result, Err(error) if error.is_peer_cancelled());
    let _ = stream.close().await;
    finish_outgoing(
        runtime,
        scope,
        transfer_id,
        result.map(|_| ()),
        cancel.clone(),
    )?;
    if cancel.load(Ordering::Acquire) {
        return Err("Transfer cancelled by user".into());
    }
    if remotely_cancelled {
        return Ok(());
    }
    tailsend_telemetry::events::text_message_sent(tailsend_telemetry::length_bucket(
        text.chars().count(),
    ));
    Ok(())
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
    let scope = &session.scope;
    for request in files {
        if !scope.is_current() {
            return Ok(());
        }
        let source = NativeFileSource::open(&app, request).await?;
        if !scope.is_current() {
            return Ok(());
        }
        send_file_source_impl(runtime, session.clone(), Box::new(source)).await?;
        if !scope.is_current() {
            return Ok(());
        }
    }
    Ok(())
}

async fn send_file_source_impl(
    runtime: &TauriRuntime,
    session: Arc<PeerSession>,
    mut source: Box<dyn FileSource>,
) -> Result<(), String> {
    let scope = &session.scope;
    if !scope.is_current() {
        return Ok(());
    }
    let transfer_id = new_id();
    let cancel = runtime.register_transfer(scope, transfer_id);
    let metadata = source.metadata();
    scope.set_state(SessionState::Transferring {
        transfer_id,
        is_incoming: false,
        is_files: true,
        bytes_done: 0,
        bytes_total: metadata.size,
        current_item_name: metadata.name.clone(),
    });
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
                scope,
                transfer_id,
                Err(TransferError::Transport(error)),
                cancel,
            );
        }
    };
    if let Some(callback) = stream.cancellation_callback() {
        scope.set_cancellation_callback(transfer_id, callback);
    }
    scope.emit(AppEvent::TransportChanged(stream.transport_path()));
    let backend_for_progress = runtime.clone_state(scope.clone());
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
    let remotely_cancelled = matches!(&result, Err(error) if error.is_peer_cancelled());

    let _ = stream.close().await;
    finish_outgoing(
        runtime,
        scope,
        transfer_id,
        result.map(|_| ()),
        cancel.clone(),
    )?;
    if cancel.load(Ordering::Acquire) || remotely_cancelled || !scope.is_current() {
        return Ok(());
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

#[cfg(target_os = "ios")]
async fn pending_share_from_item(
    item: tauri_plugin_ponlet_platform::SharedItem,
) -> Result<PendingShare, String> {
    if item.id.is_empty()
        || item.id.len() > 128
        || !item
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Shared item identifier is invalid".to_string());
    }
    let path = PathBuf::from(&item.path);
    let metadata = tokio::fs::symlink_metadata(&path)
        .await
        .map_err(|error| format!("cannot inspect shared item: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err("Shared item payload is not a regular file".to_string());
    }
    if metadata.len() != item.size {
        return Err(format!(
            "shared item size changed: {} != {}",
            metadata.len(),
            item.size
        ));
    }
    match item.kind.as_str() {
        "text" => {
            if item.size > SHARED_TEXT_MAX_BYTES {
                return Err(format!(
                    "Shared text exceeds the {SHARED_TEXT_MAX_BYTES}-byte limit"
                ));
            }
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|error| format!("cannot read shared text: {error}"))?;
            let text = String::from_utf8(bytes)
                .map_err(|_| "Shared text is not valid UTF-8".to_string())?;
            Ok(PendingShare::Text { id: item.id, text })
        }
        "file" => {
            let name = tailsend_protocol::filename::sanitize_filename(&item.name)
                .map_err(|error| format!("invalid shared filename: {error}"))?;
            Ok(PendingShare::File {
                id: item.id,
                request: FileRequest {
                    name,
                    size: item.size,
                    mime: item.mime,
                    path: item.path,
                },
            })
        }
        _ => Err("Shared item type is unsupported".to_string()),
    }
}

#[cfg(target_os = "ios")]
async fn drain_pending_shares(app: &AppHandle, runtime: &TauriRuntime) -> usize {
    use tauri_plugin_ponlet_platform::PonletPlatformExt;

    if !runtime.begin_pending_share_drain() {
        return 0;
    }
    let mut sent = 0;
    loop {
        if !runtime.backend.snapshot().app.can_send {
            break;
        }
        let Some(item) = runtime.take_pending_share() else {
            break;
        };
        let id = item.id().to_string();
        let result = match &item {
            PendingShare::Text { text, .. } => ponlet_send_text_impl(runtime, text.clone()).await,
            PendingShare::File { request, .. } => {
                let request = request.clone();
                let source = match NativeFileSource::open_local(
                    PathBuf::from(&request.path),
                    request.name.clone(),
                    request.size,
                )
                .await
                {
                    Ok(source) => source,
                    Err(error) => {
                        runtime.requeue_pending_share(item);
                        log::warn!("cannot open shared file {id}: {error}");
                        break;
                    }
                };
                let session = match runtime.session() {
                    Ok(session) => session,
                    Err(error) => {
                        runtime.requeue_pending_share(item);
                        log::debug!("shared file waits for a peer: {error}");
                        break;
                    }
                };
                send_file_source_impl(runtime, session, Box::new(source)).await
            }
        };
        match result {
            Ok(()) => {
                if let Err(error) = app.ponlet_platform().acknowledge_shared_item(&id) {
                    runtime.mark_pending_share_acknowledgement(id.clone());
                    log::warn!("shared item sent but acknowledgement failed: {error}");
                }
                runtime.complete_pending_share(&id);
                sent += 1;
            }
            Err(error) => {
                runtime.requeue_pending_share(item);
                log::debug!("shared item waits for a later connection: {error}");
                break;
            }
        }
    }
    runtime.finish_pending_share_drain();
    sent
}

pub async fn ponlet_import_shared_impl(
    app: AppHandle,
    runtime: &TauriRuntime,
) -> Result<SharedImportSummary, String> {
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_ponlet_platform::PonletPlatformExt;

        for id in runtime.pending_share_acknowledgements() {
            if app.ponlet_platform().acknowledge_shared_item(&id).is_ok() {
                runtime.clear_pending_share_acknowledgement(&id);
            }
        }
        let mut imported = 0;
        let mut sent = 0;
        loop {
            let items = app.ponlet_platform().read_shared_items()?;
            let mut queue_full = false;
            for item in items {
                if runtime.pending_share_contains(&item.id) {
                    continue;
                }
                let id = item.id.clone();
                let pending = match pending_share_from_item(item).await {
                    Ok(pending) => pending,
                    Err(error) => {
                        // Keep malformed entries in the inbox for diagnosis,
                        // but do not prevent valid entries from being sent.
                        log::warn!("ignoring shared item {id}: {error}");
                        continue;
                    }
                };
                match runtime.enqueue_pending_share(pending) {
                    Ok(true) => imported += 1,
                    Ok(false) => {}
                    Err(error) => {
                        queue_full = true;
                        log::debug!("shared item waits in the inbox: {error}");
                        break;
                    }
                }
            }
            let batch_sent = drain_pending_shares(&app, runtime).await;
            sent += batch_sent;
            if !queue_full || batch_sent == 0 {
                break;
            }
        }
        return Ok(SharedImportSummary {
            imported,
            pending_items: runtime.pending_share_items(),
            queued: runtime.pending_share_len(),
            sent,
        });
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, runtime);
        Ok(SharedImportSummary {
            imported: 0,
            pending_items: Vec::new(),
            queued: 0,
            sent: 0,
        })
    }
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
