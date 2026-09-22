//! Standalone Share Extension sender. The native shell links libtailcat once.
//! No Tauri/WebView or analytics initialization is performed here.

use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, CStr, CString};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use tailsend_core::{run_host_handshake_stream, run_joiner_handshake};
use tailsend_native_transport::NativeTailcatTransport;
use tailsend_platform_api::{FileMetadata, FileSource, StorageError};
use tailsend_protocol::control::{Capabilities, PeerInfo, PlatformKind};
use tailsend_protocol::invitation::InvitationV1;
use tailsend_protocol::limits::{
    CONTROL_PORT, DEFAULT_INVITE_LIFETIME_SECS, FILE_PORT, MAX_TEXT_PAYLOAD_SIZE, TEXT_PORT,
};
use tailsend_transfer::{send_live_text_stream, send_named_file_stream, ProgressCallback};
use tailsend_transport_api::{
    CancellationCallback, DuplexStream, ListenOptions, Listener, TailcatTransport, TransportError,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const CANCELLED: &str = "Operation cancelled";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    File,
    Text,
}

#[derive(Clone, Debug, Deserialize)]
struct Item {
    id: String,
    kind: Kind,
    name: String,
    size: u64,
    path: PathBuf,
    // Keep validating the optional MIME field supplied by the Share Extension.
    #[allow(dead_code)]
    mime: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    invite_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    peer_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_name: Option<String>,
    done: u64,
    total: u64,
    completed_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct Session {
    snapshot: Mutex<Snapshot>,
    cancel: Arc<AtomicBool>,
    wake: tokio::sync::Notify,
    stream_cancel: Mutex<Option<CancellationCallback>>,
}

impl Session {
    fn new(total: u64) -> Self {
        Self {
            snapshot: Mutex::new(Snapshot {
                state: "preparing",
                total,
                ..Snapshot::default()
            }),
            cancel: Arc::new(AtomicBool::new(false)),
            wake: tokio::sync::Notify::new(),
            stream_cancel: Mutex::new(None),
        }
    }

    fn update(&self, f: impl FnOnce(&mut Snapshot)) {
        let mut snapshot = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        if !self.cancel.load(Ordering::Acquire) {
            f(&mut snapshot);
        }
    }

    fn request_cancel(&self) {
        let mut snapshot = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(snapshot.state, "completed" | "error" | "cancelled") {
            return;
        }
        self.cancel.store(true, Ordering::Release);
        snapshot.state = "cancelled";
        drop(snapshot);
        self.wake.notify_one();
        if let Some(callback) = self
            .stream_cancel
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            // Native cancellation can enter Go: never execute it on UIKit's thread.
            if let Some(runtime) = runtime() {
                runtime.spawn_blocking(move || callback());
            }
        }
    }

    async fn cancelled(&self) {
        let notified = self.wake.notified();
        if !self.cancel.load(Ordering::Acquire) {
            notified.await;
        }
    }

    fn track_stream(&self, stream: &dyn DuplexStream) {
        let callback = stream.cancellation_callback();
        *self.stream_cancel.lock().unwrap_or_else(|e| e.into_inner()) = callback.clone();
        // Registration can race cancellation. This runs on a worker, not UIKit.
        if self.cancel.load(Ordering::Acquire) {
            if let Some(callback) = callback {
                callback();
            }
        }
    }

    fn completed(&self, item: &Item) {
        self.update(|snapshot| {
            snapshot.completed_ids.push(item.id.clone());
            snapshot.done = snapshot.done.saturating_add(item.size).min(snapshot.total);
        });
    }
}

fn runtime() -> Option<&'static tokio::runtime::Runtime> {
    static RUNTIME: OnceLock<Option<tokio::runtime::Runtime>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .max_blocking_threads(8)
                .thread_name("ponlet-share")
                .enable_all()
                .build()
                .ok()
        })
        .as_ref()
}

fn sessions() -> &'static Mutex<HashMap<u64, Arc<Session>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<u64, Arc<Session>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lookup(handle: u64) -> Option<Arc<Session>> {
    sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&handle)
        .cloned()
}

fn parse_items(json: &str) -> Result<(Vec<Item>, u64), String> {
    if json.len() > 1024 * 1024 {
        return Err("Item list is too large".into());
    }
    let items: Vec<Item> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if items.is_empty() || items.len() > 100 {
        return Err("Expected 1 to 100 shared items".into());
    }
    let mut ids = HashSet::new();
    let mut total = 0u64;
    for item in &items {
        if item.id.is_empty()
            || !ids.insert(&item.id)
            || item.name.is_empty()
            || !item.path.is_absolute()
        {
            return Err("Invalid shared item identity, name or path".into());
        }
        if matches!(item.kind, Kind::Text) && item.size > MAX_TEXT_PAYLOAD_SIZE {
            return Err("Shared text exceeds 1 MiB".into());
        }
        total = total.checked_add(item.size).ok_or("Shared size overflow")?;
    }
    Ok((items, total))
}

async fn open_item(item: &Item) -> Result<tokio::fs::File, String> {
    let metadata = tokio::fs::symlink_metadata(&item.path)
        .await
        .map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() != item.size {
        return Err(format!("Shared file changed: {}", item.name));
    }
    let file = tokio::fs::File::open(&item.path)
        .await
        .map_err(|e| e.to_string())?;
    let metadata = file.metadata().await.map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() != item.size {
        return Err(format!("Shared file changed: {}", item.name));
    }
    Ok(file)
}

fn options() -> ListenOptions {
    ListenOptions {
        derp_map_url: "https://tailcat.dev/derpmap.json".into(),
        verbose: false,
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// Give the shared joiner handshake cancellable native dial and stream hooks.
struct SessionTransport {
    native: NativeTailcatTransport,
    session: Arc<Session>,
}

#[async_trait::async_trait]
impl TailcatTransport for SessionTransport {
    async fn listen(&self, options: ListenOptions) -> Result<Box<dyn Listener>, TransportError> {
        self.native.listen(options).await
    }
    async fn dial(
        &self,
        address: &str,
        port: u16,
        options: ListenOptions,
    ) -> Result<Box<dyn DuplexStream>, TransportError> {
        let stream = self
            .native
            .dial_cancellable(address, port, options, self.session.cancel.clone())
            .await?;
        self.session.track_stream(&*stream);
        Ok(stream)
    }
}

async fn run(session: Arc<Session>, items: Vec<Item>, invite: String) -> Result<(), String> {
    if !invite.is_empty() {
        InvitationV1::from_url(&invite, now()).map_err(|e| e.to_string())?;
    }
    for item in &items {
        drop(open_item(item).await?);
    }
    if session.cancel.load(Ordering::Acquire) {
        return Err(CANCELLED.into());
    }
    let transport = Arc::new(SessionTransport {
        native: NativeTailcatTransport::new().map_err(|e| e.to_string())?,
        session: session.clone(),
    });
    let listener = tokio::select! {
        biased;
        _ = session.cancelled() => return Err(CANCELLED.into()),
        result = transport.listen(options()) => result.map_err(|e| e.to_string())?,
    };
    let result = tokio::select! {
        biased;
        _ = session.cancelled() => Err(CANCELLED.into()),
        result = run_connected(&session, &transport, &*listener, items, invite) => result,
    };
    // This cleanup runs on the runtime even when Swift has released its handle.
    let _ = listener.close().await;
    *session
        .stream_cancel
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    result
}

async fn run_connected(
    session: &Arc<Session>,
    transport: &Arc<SessionTransport>,
    listener: &dyn Listener,
    items: Vec<Item>,
    invite: String,
) -> Result<(), String> {
    let peer = PeerInfo::new_native(
        "Ponlet Share".into(),
        PlatformKind::IOS,
        env!("CARGO_PKG_VERSION").into(),
    );
    let capabilities = Capabilities::default();
    let handshake = if invite.is_empty() {
        let mut id = [0u8; 16];
        let mut secret = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut id);
        rand::thread_rng().fill_bytes(&mut secret);
        let invitation = InvitationV1::new(
            listener.local_address().into(),
            id,
            secret,
            now(),
            DEFAULT_INVITE_LIFETIME_SECS,
        );
        let url = invitation
            .to_qr_url("https://ponlet.mat2uken.app")
            .map_err(|e| e.to_string())?;
        session.update(|snapshot| {
            snapshot.state = "waiting";
            snapshot.invite_url = Some(url);
        });
        let incoming = tokio::time::timeout(
            Duration::from_secs(DEFAULT_INVITE_LIFETIME_SECS),
            listener.accept(),
        )
        .await
        .map_err(|_| "Invitation expired".to_string())?
        .map_err(|e| e.to_string())?;
        let mut stream = incoming.stream;
        session.track_stream(&*stream);
        session.update(|snapshot| snapshot.state = "connecting");
        let result = if incoming.port == CONTROL_PORT {
            tokio::time::timeout(
                Duration::from_secs(30),
                run_host_handshake_stream(
                    &mut stream,
                    listener.local_address(),
                    id,
                    secret,
                    &peer,
                    &capabilities,
                ),
            )
            .await
            .map_err(|_| "Connection timed out".to_string())?
            .map_err(|e| e.to_string())
        } else {
            Err("Unexpected connection port".into())
        };
        let _ = stream.close().await;
        result?
    } else {
        let invitation = InvitationV1::from_url(&invite, now()).map_err(|e| e.to_string())?;
        session.update(|snapshot| snapshot.state = "connecting");
        let adapter: Arc<dyn TailcatTransport> = transport.clone();
        tokio::time::timeout(
            Duration::from_secs(60),
            run_joiner_handshake(&adapter, listener, &invitation, &peer, &capabilities),
        )
        .await
        .map_err(|_| "Connection timed out".to_string())??
    };
    session.update(|snapshot| snapshot.peer_name = Some(handshake.peer_info.display_name));
    let mut finished_bytes = 0;
    for item in items {
        if session.cancel.load(Ordering::Acquire) {
            return Err(CANCELLED.into());
        }
        let file = open_item(&item).await?;
        session.update(|snapshot| {
            snapshot.state = "sending";
            snapshot.current_name = Some(item.name.clone());
        });
        let port = if matches!(item.kind, Kind::Text) {
            TEXT_PORT
        } else {
            FILE_PORT
        };
        let mut stream = transport
            .dial(&handshake.peer_address, port, options())
            .await
            .map_err(|e| e.to_string())?;
        let result = match item.kind {
            Kind::Text => {
                let mut bytes = Vec::with_capacity(item.size as usize);
                file.take(MAX_TEXT_PAYLOAD_SIZE + 1)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(|e| e.to_string())?;
                if bytes.len() as u64 != item.size {
                    return Err("Shared text changed".into());
                }
                let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
                send_live_text_stream(&mut stream, &text, session.cancel.clone())
                    .await
                    .map(|_| ())
            }
            Kind::File => {
                let mut source: Box<dyn FileSource> = Box::new(Source {
                    file,
                    metadata: FileMetadata {
                        name: item.name.clone(),
                        size: item.size,
                    },
                });
                let progress_session = session.clone();
                let progress: ProgressCallback = Box::new(move |update| {
                    progress_session.update(|snapshot| {
                        snapshot.done = finished_bytes + update.bytes_transferred
                    })
                });
                send_named_file_stream(
                    &mut stream,
                    &mut source,
                    [0; 16],
                    session.cancel.clone(),
                    Some(&progress),
                )
                .await
                .map(|_| ())
            }
        };
        let close = stream.close().await;
        *session
            .stream_cancel
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        result.map_err(|e| e.to_string())?;
        close.map_err(|e| e.to_string())?;
        if session.cancel.load(Ordering::Acquire) {
            return Err(CANCELLED.into());
        }
        // Existing live protocol confirms sender-side write/half-close only,
        // without an application-level acknowledgement of remote disk commit.
        // Never remove an item on error, peer cancellation or local cancellation.
        session.update(|snapshot| snapshot.done = finished_bytes);
        session.completed(&item);
        finished_bytes += item.size;
    }
    session.update(|snapshot| {
        snapshot.state = "completed";
        snapshot.current_name = None;
    });
    Ok(())
}

struct Source {
    file: tokio::fs::File,
    metadata: FileMetadata,
}

#[async_trait::async_trait]
impl FileSource for Source {
    fn metadata(&self) -> FileMetadata {
        self.metadata.clone()
    }

    async fn read_into(
        &mut self,
        offset: u64,
        destination: &mut [u8],
    ) -> Result<usize, StorageError> {
        self.file
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| StorageError::Io(e.to_string()))?;
        self.file
            .read(destination)
            .await
            .map_err(|e| StorageError::Io(e.to_string()))
    }
}

/// # Safety
/// Both pointers must address valid NUL-terminated UTF-8 strings for this call.
#[no_mangle]
pub unsafe extern "C" fn ponlet_share_start(
    items_json: *const c_char,
    invite_url: *const c_char,
) -> u64 {
    if items_json.is_null() || invite_url.is_null() {
        return 0;
    }
    let Ok(json) = CStr::from_ptr(items_json).to_str() else {
        return 0;
    };
    let Ok(invite) = CStr::from_ptr(invite_url).to_str() else {
        return 0;
    };
    if invite.len() > 16384 {
        return 0;
    }
    let Ok((items, total)) = parse_items(json) else {
        return 0;
    };
    let Some(runtime) = runtime() else {
        return 0;
    };
    let invite = invite.to_owned();
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let handle = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let session = Arc::new(Session::new(total));
    let mut registry = sessions().lock().unwrap_or_else(|e| e.into_inner());
    if registry.len() >= 2 {
        return 0;
    }
    registry.insert(handle, session.clone());
    drop(registry);
    runtime.spawn(async move {
        if let Err(error) = run(session.clone(), items, invite).await {
            session.update(|snapshot| {
                snapshot.state = "error";
                snapshot.error = Some(error);
            });
        }
    });
    handle
}

#[no_mangle]
pub extern "C" fn ponlet_share_snapshot(handle: u64) -> *mut c_char {
    let Some(session) = lookup(handle) else {
        return std::ptr::null_mut();
    };
    let snapshot = session.snapshot.lock().unwrap_or_else(|e| e.into_inner());
    serde_json::to_string(&*snapshot)
        .ok()
        .and_then(|json| CString::new(json).ok())
        .map(CString::into_raw)
        .unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn ponlet_share_cancel(handle: u64) {
    if let Some(session) = lookup(handle) {
        session.request_cancel();
    }
}

#[no_mangle]
pub extern "C" fn ponlet_share_release(handle: u64) {
    let session = sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&handle);
    if let Some(session) = session {
        session.request_cancel();
    }
}

/// # Safety
/// `value` must be NULL or an unreleased result of ponlet_share_snapshot.
#[no_mangle]
pub unsafe extern "C" fn ponlet_share_string_free(value: *mut c_char) {
    if !value.is_null() {
        drop(CString::from_raw(value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item() -> Item {
        Item {
            id: "one".into(),
            kind: Kind::File,
            name: "hello.txt".into(),
            size: 5,
            path: "/tmp/hello.txt".into(),
            mime: None,
        }
    }

    #[test]
    fn rejects_duplicate_ids_oversized_text_and_relative_paths() {
        for json in [
            r#"[]"#,
            r#"[{"id":"x","kind":"text","name":"text","size":1048577,"path":"/tmp/text"}]"#,
            r#"[{"id":"x","kind":"file","name":"file","size":0,"path":"relative"}]"#,
            r#"[{"id":"x","kind":"file","name":"a","size":0,"path":"/a"},{"id":"x","kind":"file","name":"b","size":0,"path":"/b"}]"#,
        ] {
            assert!(parse_items(json).is_err(), "{json}");
        }
    }

    #[test]
    fn cancellation_preserves_completed_items_but_cannot_complete_another() {
        let session = Session::new(10);
        session.completed(&item());
        session.request_cancel();
        let mut next = item();
        next.id = "two".into();
        session.completed(&next);
        session.update(|snapshot| snapshot.state = "completed");
        let snapshot = session.snapshot.lock().unwrap();
        assert_eq!(snapshot.state, "cancelled");
        assert_eq!(snapshot.completed_ids, ["one"]);
        assert_eq!(snapshot.done, 5);
    }

    #[tokio::test]
    async fn validates_actual_file_size_and_rejects_directories_and_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hello.txt");
        tokio::fs::write(&path, b"hello").await.unwrap();
        let mut candidate = item();
        candidate.path = path.clone();
        assert!(open_item(&candidate).await.is_ok());
        candidate.size = 4;
        assert!(open_item(&candidate).await.is_err());
        candidate.path = directory.path().into();
        assert!(open_item(&candidate).await.is_err());
        #[cfg(unix)]
        {
            let link = directory.path().join("link");
            std::os::unix::fs::symlink(path, &link).unwrap();
            candidate.path = link;
            candidate.size = 5;
            assert!(open_item(&candidate).await.is_err());
        }
    }
}
