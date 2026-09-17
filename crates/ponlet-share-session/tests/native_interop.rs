//! Native end-to-end coverage for the Share Extension sender.
//!
//! This test intentionally uses the real Go Tailcat bridge on macOS.  It is
//! not a loopback mock: the receiver runs the same native listener,
//! handshake, and live transfer decoders used by the desktop/mobile peers.
//!
//! Run with a macOS Go archive in target/native/tailcat:
//! RUSTFLAGS='-L native=target/native/tailcat' cargo test -p ponlet-share-session \
//!   --features native-interop-tests --test native_interop

#![cfg(target_os = "macos")]

use std::ffi::{CStr, CString};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use rand::RngCore;
use serde_json::{json, Value};
use tailsend_core::{run_host_handshake, run_joiner_handshake};
use tailsend_native_transport::NativeTailcatTransport;
use tailsend_platform_api::{IncomingFileSink, ReceivedItem, StorageError};
use tailsend_protocol::control::{Capabilities, PeerInfo, PlatformKind};
use tailsend_protocol::invitation::InvitationV1;
use tailsend_protocol::limits::{FILE_PORT, TEXT_PORT};
use tailsend_transfer::{receive_live_text_stream, receive_named_file_stream};
use tailsend_transport_api::{ListenOptions, TailcatTransport};

#[link(name = "tailcat", kind = "static")]
extern "C" {
    fn tc_init() -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {}

#[link(name = "Security", kind = "framework")]
extern "C" {}

const DERP_MAP: &str = "https://tailcat.dev/derpmap.json";

#[derive(Debug)]
struct VecSink {
    data: Arc<Mutex<Vec<u8>>>,
    name: String,
}

#[async_trait]
impl IncomingFileSink for VecSink {
    async fn write(&mut self, chunk: &[u8]) -> Result<(), StorageError> {
        self.data.lock().unwrap().extend_from_slice(chunk);
        Ok(())
    }

    async fn commit(self: Box<Self>) -> Result<ReceivedItem, StorageError> {
        let size = self.data.lock().unwrap().len() as u64;
        Ok(ReceivedItem {
            name: self.name.clone(),
            size,
            local_path_or_handle: "native-interop-memory-sink".into(),
        })
    }

    async fn abort(self: Box<Self>) -> Result<(), StorageError> {
        Ok(())
    }
}

fn options() -> ListenOptions {
    ListenOptions {
        derp_map_url: DERP_MAP.into(),
        verbose: false,
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn snapshot(handle: u64) -> Value {
    let pointer = ponlet_share_session::ponlet_share_snapshot(handle);
    assert!(!pointer.is_null(), "share snapshot returned NULL");
    let string = unsafe { CStr::from_ptr(pointer) }
        .to_str()
        .expect("snapshot is UTF-8")
        .to_owned();
    unsafe { ponlet_share_session::ponlet_share_string_free(pointer) };
    serde_json::from_str(&string).expect("snapshot is JSON")
}

async fn wait_for_state(handle: u64, wanted: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let current = snapshot(handle);
            if current["state"] == wanted {
                return current;
            }
            if current["state"] == "error" {
                panic!("share session failed while waiting for {wanted}: {current}");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("share session did not reach {wanted}"))
}

fn start(items: &[Value], invite: &str) -> u64 {
    let item_json = CString::new(serde_json::to_string(items).unwrap()).unwrap();
    let invite = CString::new(invite).unwrap();
    let handle =
        unsafe { ponlet_share_session::ponlet_share_start(item_json.as_ptr(), invite.as_ptr()) };
    assert_ne!(handle, 0, "share session could not be created");
    handle
}

async fn receive_items(
    listener: &dyn tailsend_transport_api::Listener,
    expected_file: &[u8],
    expected_name: &str,
    expected_text: &str,
) {
    let mut file_incoming = listener.accept().await.expect("file stream accepted");
    assert_eq!(file_incoming.port, FILE_PORT);
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let result = receive_named_file_stream(
        &mut file_incoming.stream,
        Box::new(VecSink {
            data: bytes.clone(),
            name: expected_name.into(),
        }),
        [0; 16],
        Some(expected_file.len() as u64),
        Arc::new(AtomicBool::new(false)),
        None,
    )
    .await
    .expect("file payload received and committed");
    assert_eq!(result.header.name, expected_name);
    assert_eq!(result.item.size, expected_file.len() as u64);
    assert_eq!(&*bytes.lock().unwrap(), expected_file);

    let mut text_incoming = listener.accept().await.expect("text stream accepted");
    assert_eq!(text_incoming.port, TEXT_PORT);
    let messages = Arc::new(Mutex::new(Vec::new()));
    let received_messages = messages.clone();
    receive_live_text_stream(
        &mut text_incoming.stream,
        Arc::new(AtomicBool::new(false)),
        move |message| received_messages.lock().unwrap().push(message),
    )
    .await
    .expect("text payload received");
    assert_eq!(&*messages.lock().unwrap(), &[expected_text.to_owned()]);
}

fn item(path: &Path, id: &str, kind: &str, name: &str, size: u64) -> Value {
    json!({
        "id": id,
        "kind": kind,
        "name": name,
        "size": size,
        "path": path,
        "mime": "application/octet-stream"
    })
}

async fn host_mode_round_trip(root: &Path) {
    let file_bytes: Vec<u8> = (0..1_048_593).map(|index| (index % 251) as u8).collect();
    let text = "share host text: こんにちは 🚀";
    let file_path = root.join("host.bin");
    let text_path = root.join("host.txt");
    tokio::fs::write(&file_path, &file_bytes).await.unwrap();
    tokio::fs::write(&text_path, text.as_bytes()).await.unwrap();
    let handle = start(
        &[
            item(
                &file_path,
                "host-file",
                "file",
                "host.bin",
                file_bytes.len() as u64,
            ),
            item(
                &text_path,
                "host-text",
                "text",
                "host.txt",
                text.len() as u64,
            ),
        ],
        "",
    );

    let waiting = wait_for_state(handle, "waiting").await;
    let invite_url = waiting["inviteUrl"].as_str().unwrap().to_owned();
    let invitation = InvitationV1::from_url(&invite_url, now()).expect("host invitation parses");
    let receiver = NativeTailcatTransport::new().expect("receiver bridge initialized");
    let receiver_listener = receiver.listen(options()).await.expect("receiver listener");
    let receiver_transport: Arc<dyn TailcatTransport> = Arc::new(receiver.clone());
    let joiner_listener = receiver_listener;
    let joiner_task = tokio::spawn(async move {
        let result = run_joiner_handshake(
            &receiver_transport,
            &*joiner_listener,
            &invitation,
            &PeerInfo::new_native("Native receiver".into(), PlatformKind::MacOS, "test".into()),
            &Capabilities::default(),
        )
        .await;
        (result, joiner_listener)
    });
    let (joiner_result, receiver_listener) = joiner_task.await.expect("joiner task");
    let _handshake = joiner_result.expect("joiner handshake");
    receive_items(&*receiver_listener, &file_bytes, "host.bin", text).await;
    let completed = wait_for_state(handle, "completed").await;
    assert_eq!(completed["completedIds"], json!(["host-file", "host-text"]));
    ponlet_share_session::ponlet_share_release(handle);
    receiver_listener
        .close()
        .await
        .expect("close receiver listener");
}

async fn join_mode_round_trip(root: &Path) {
    let file_bytes = b"native share join file".to_vec();
    let text = "share join text";
    let file_path = root.join("join.bin");
    let text_path = root.join("join.txt");
    tokio::fs::write(&file_path, &file_bytes).await.unwrap();
    tokio::fs::write(&text_path, text.as_bytes()).await.unwrap();

    let receiver = NativeTailcatTransport::new().expect("receiver bridge initialized");
    let receiver_listener = receiver.listen(options()).await.expect("receiver listener");
    let mut session_id = [0u8; 16];
    let mut secret = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut session_id);
    rand::thread_rng().fill_bytes(&mut secret);
    let invitation = InvitationV1::new(
        receiver_listener.local_address().into(),
        session_id,
        secret,
        now(),
        600,
    );
    let invite_url = invitation
        .to_qr_url("https://ponlet.mat2uken.app")
        .expect("receiver invitation URL");
    let receiver_task_listener = receiver_listener;
    let host_task = tokio::spawn(async move {
        let result = run_host_handshake(
            &*receiver_task_listener,
            session_id,
            secret,
            &PeerInfo::new_native("Native host".into(), PlatformKind::MacOS, "test".into()),
            &Capabilities::default(),
        )
        .await;
        (result, receiver_task_listener)
    });
    let handle = start(
        &[
            item(
                &file_path,
                "join-file",
                "file",
                "join.bin",
                file_bytes.len() as u64,
            ),
            item(
                &text_path,
                "join-text",
                "text",
                "join.txt",
                text.len() as u64,
            ),
        ],
        &invite_url,
    );
    let (host_result, receiver_listener) = host_task.await.expect("host task");
    let _handshake = host_result.expect("host handshake");
    receive_items(&*receiver_listener, &file_bytes, "join.bin", text).await;
    let completed = wait_for_state(handle, "completed").await;
    assert_eq!(completed["completedIds"], json!(["join-file", "join-text"]));
    ponlet_share_session::ponlet_share_release(handle);
    receiver_listener
        .close()
        .await
        .expect("close data listener");
}

async fn cancellation_before_connection(root: &Path) {
    let path = root.join("cancel.bin");
    // Keep enough data that this would still be a meaningful in-flight item
    // if a future test starts cancellation after the connection is established.
    tokio::fs::write(&path, vec![0x5a; 2 * 1024 * 1024])
        .await
        .unwrap();
    let handle = start(
        &[item(
            &path,
            "cancel-file",
            "file",
            "cancel.bin",
            2 * 1024 * 1024,
        )],
        "",
    );
    wait_for_state(handle, "waiting").await;
    ponlet_share_session::ponlet_share_cancel(handle);
    let cancelled = wait_for_state(handle, "cancelled").await;
    assert_eq!(cancelled["completedIds"], json!([]));
    ponlet_share_session::ponlet_share_release(handle);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn share_sender_interoperates_with_native_receiver_in_both_directions() {
    assert_eq!(unsafe { tc_init() }, 0, "native bridge initialization");
    let root = tempfile::tempdir().unwrap();
    tokio::time::timeout(Duration::from_secs(120), async {
        host_mode_round_trip(root.path()).await;
        join_mode_round_trip(root.path()).await;
        cancellation_before_connection(root.path()).await;
    })
    .await
    .expect("native interoperability test timed out");
}
