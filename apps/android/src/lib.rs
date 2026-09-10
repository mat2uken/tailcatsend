use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use jni::objects::{Global, JClass, JObject, JString, JValueOwned};
use jni::refs::Reference as _;
use jni::{jni_sig, jni_str, Env, JavaVM};
use log::{error, info, warn};
use rand::RngCore;
use slint::{Image, SharedPixelBuffer};
use tailsend_protocol::filename::{generate_unique_filename, sanitize_filename};
use tailsend_protocol::invitation::InvitationV1;
use tailsend_qr::generate_qr_rgba;
use tokio::sync::mpsc;

mod telemetry;

slint::include_modules!();

// C-ABI Types & Bindings from tailcat_bridge.h
type TcHandle = u64;

#[repr(C)]
struct TcEvent {
    struct_size: u32,
    event_type: u32,
    owner_handle: TcHandle,
    object_handle: TcHandle,
    port: u16,
    reserved: u16,
    status_code: i32,
}

extern "C" {
    fn tc_init() -> i32;
    fn tc_listener_create(
        derp_map_url: *const u8,
        derp_map_url_len: usize,
        verbose: u8,
        out_listener: *mut TcHandle,
    ) -> i32;
    fn tc_listener_address(
        listener: TcHandle,
        buffer: *mut u8,
        capacity: usize,
        out_length: *mut usize,
    ) -> i32;
    fn tc_listener_close(listener: TcHandle) -> i32;
    fn tc_wait_event(timeout_ms: u32, out_event: *mut TcEvent) -> i32;
    fn tc_stream_dial(
        address: *const u8,
        address_len: usize,
        derp_map_url: *const u8,
        derp_map_url_len: usize,
        port: u16,
        timeout_ms: u32,
        out_stream: *mut TcHandle,
    ) -> i32;
    fn tc_stream_read(
        stream: TcHandle,
        buffer: *mut u8,
        capacity: usize,
        out_read: *mut usize,
        timeout_ms: u32,
    ) -> i32;
    fn tc_stream_write_all(
        stream: TcHandle,
        buffer: *const u8,
        length: usize,
        timeout_ms: u32,
    ) -> i32;
    fn tc_stream_close(stream: TcHandle) -> i32;
    fn tc_stream_close_write(stream: TcHandle) -> i32;
    fn tc_last_error(buffer: *mut u8, capacity: usize, out_length: *mut usize) -> i32;
}

// Global channel for external join session triggers (e.g. from ADB / Intent)
static GLOBAL_JOIN_TX: std::sync::OnceLock<mpsc::UnboundedSender<String>> = std::sync::OnceLock::new();

// JNI handles for the Kotlin bridges (FilePickerBridge.kt / QRScannerBridge.kt)
static BRIDGE_JVM: OnceLock<JavaVM> = OnceLock::new();
static PICKER_CLASS: OnceLock<Global<JClass<'static>>> = OnceLock::new();
static SCANNER_CLASS: OnceLock<Global<JClass<'static>>> = OnceLock::new();

// Set while a scanner poll thread is waiting for the camera result, so a
// second tap cannot start a competing poll loop that would steal the result.
static SCANNER_ACTIVE: AtomicBool = AtomicBool::new(false);

// Resolves a `jp.yasagure.ponlet.*` bridge class through the activity's
// classloader (the system classloader cannot see APK classes from a native
// thread) and returns a global reference for later calls.
fn resolve_bridge_class(
    vm: &JavaVM,
    activity_raw: jni::sys::jobject,
    class_name: &str,
) -> Result<Global<JClass<'static>>, jni::errors::Error> {
    vm.attach_current_thread(
        |env: &mut Env| -> jni::errors::Result<Global<JClass<'static>>> {
            let activity = unsafe { JObject::from_raw(env, activity_raw) };
            let loader_obj = env
                .call_method(
                    activity,
                    jni_str!("getClassLoader"),
                    jni_sig!("()Ljava/lang/ClassLoader;"),
                    &[],
                )?
                .l()?;
            let loader = unsafe { jni::objects::JClassLoader::from_raw(env, loader_obj.as_raw()) };
            let name = env.new_string(class_name)?;
            let class: JClass = JClass::for_name_with_loader(env, name, true, &loader)?;
            env.new_global_ref(class)
        },
    )
}

fn init_bridge_class(
    app: &android_activity::AndroidApp,
    slot: &OnceLock<Global<JClass<'static>>>,
    class_name: &str,
    tag: &str,
) -> bool {
    if BRIDGE_JVM.get().is_none() {
        // Safety: `vm_as_ptr` is a valid JavaVM pointer for the process lifetime.
        let vm = unsafe { JavaVM::from_raw(app.vm_as_ptr().cast()) };
        let _ = BRIDGE_JVM.set(vm);
    }
    if slot.get().is_some() {
        return true;
    }
    let Some(vm) = BRIDGE_JVM.get() else { return false };
    let activity_raw = app.activity_as_ptr() as jni::sys::jobject;
    match resolve_bridge_class(vm, activity_raw, class_name) {
        Ok(global) => {
            let _ = slot.set(global);
            true
        }
        Err(e) => {
            // Clear any pending Java exception (e.g. ClassNotFoundException)
            // so later JNI calls on this thread are not poisoned.
            let _ = vm.attach_current_thread(|env: &mut Env| -> jni::errors::Result<()> {
                if env.exception_check() {
                    env.exception_describe();
                    env.exception_clear();
                }
                Ok(())
            });
            log::warn!("[{}] {} class lookup failed: {}", tag, class_name, e);
            false
        }
    }
}

// Caches the JavaVM + FilePickerBridge class for later pick/poll calls.
fn init_picker_jni(app: &android_activity::AndroidApp) -> bool {
    init_bridge_class(app, &PICKER_CLASS, "jp.yasagure.ponlet.FilePickerBridge", "Picker")
}

// Caches the JavaVM + QRScannerBridge class for later start/poll calls.
fn init_scanner_jni(app: &android_activity::AndroidApp) -> bool {
    init_bridge_class(app, &SCANNER_CLASS, "jp.yasagure.ponlet.QRScannerBridge", "Scanner")
}

// Asks Kotlin to launch the ACTION_GET_CONTENT picker. Ok(true) means the
// picker was launched, Ok(false) means no activity/class was available.
fn picker_pick() -> Result<bool, String> {
    let vm = BRIDGE_JVM.get().ok_or_else(|| "JVM unavailable".to_string())?;
    let class = PICKER_CLASS
        .get()
        .ok_or_else(|| "FilePickerBridge unavailable".to_string())?;
    vm.attach_current_thread(|env: &mut Env| -> jni::errors::Result<bool> {
        let ret = env.call_static_method(
            class,
            jni_str!("pick"),
            jni_sig!("()Z"),
            &[],
        )?;
        ret.z()
    })
    .map_err(|e| e.to_string())
}

// Polls Kotlin for a bridge outcome (picker result / QR scan result). The
// Kotlin side stores a JSON string once the activity result arrived.
fn bridge_poll(class: Option<&'static Global<JClass<'static>>>) -> Option<String> {
    let vm = BRIDGE_JVM.get()?;
    let class = class?;
    let result: Result<Option<String>, jni::errors::Error> =
        vm.attach_current_thread(|env: &mut Env| -> jni::errors::Result<Option<String>> {
            let ret = env.call_static_method(
                class,
                jni_str!("pollResult"),
                jni_sig!("()Ljava/lang/String;"),
                &[],
            )?;
            Ok(jstring_from_value(env, ret))
        });
    result.ok().flatten()
}

// Polls Kotlin for the picker outcome. Kotlin stores a JSON string such as
// {"status":"ok","path":"...","name":"..."} once onActivityResult ran.
fn picker_poll() -> Option<String> {
    bridge_poll(PICKER_CLASS.get())
}

// Polls Kotlin for the QR scan outcome. JSON such as
// {"status":"ok","text":"..."} once the camera activity finished.
fn scanner_poll() -> Option<String> {
    bridge_poll(SCANNER_CLASS.get())
}

// Asks Kotlin to launch the camera QR scanner (zxing CaptureActivity).
// Ok(true) means the scanner was launched, Ok(false) means no activity/class
// was available.
fn scanner_start() -> Result<bool, String> {
    let vm = BRIDGE_JVM.get().ok_or_else(|| "JVM unavailable".to_string())?;
    let class = SCANNER_CLASS
        .get()
        .ok_or_else(|| "QRScannerBridge unavailable".to_string())?;
    vm.attach_current_thread(|env: &mut Env| -> jni::errors::Result<bool> {
        let ret = env.call_static_method(
            class,
            jni_str!("startScan"),
            jni_sig!("()Z"),
            &[],
        )?;
        ret.z()
    })
    .map_err(|e| e.to_string())
}

// Updates the status text from a non-UI thread through the Slint event loop.
fn set_status_from_thread(app_weak: &slint::Weak<AppWindow>, text: String) {
    let w = app_weak.clone();
    let _ = slint::invoke_from_event_loop(move || {
        if let Some(app) = w.upgrade() {
            app.set_status_text(text.into());
        }
    });
}

fn jstring_from_value(env: &mut Env<'_>, value: JValueOwned<'_>) -> Option<String> {
    match value {
        JValueOwned::Object(obj) if !obj.is_null() => {
            let jstr = unsafe { JString::from_raw(env, obj.into_raw()) };
            jstr.try_to_string(env).ok()
        }
        _ => None,
    }
}

#[no_mangle]
fn android_main(app: android_activity::AndroidApp) {
    android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Info)
            .with_tag("PonletAndroid"),
    );

    info!("🚀 Starting Ponlet Android Native Application (Slint + Pure Tailcat WireGuard)...");

    // Telemetry: install the Firebase-backed backend (no-op without Firebase config)
    let telemetry_initial = telemetry::startup(&app);

    // SAF file picker bridge: cache the JavaVM + FilePickerBridge class once
    init_picker_jni(&app);
    // QR camera scanner bridge: cache the JavaVM + QRScannerBridge class once
    init_scanner_jni(&app);

    slint::android::init(app).expect("Failed to initialize Slint Android backend");

    if let Err(e) = run_android_app(telemetry_initial) {
        error!("Ponlet Android run error: {:?}", e);
    }
}

fn parse_tailcat_address(input: &str) -> String {
    let trimmed = input.trim();
    if let Some(pos) = trimmed.find("#i=") {
        let after = &trimmed[pos + 3..];
        let token = after.split('&').next().unwrap_or(after);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        if let Ok(inv) = tailsend_protocol::InvitationV1::from_base64url(token, now) {
            info!("🔑 Decoded Invitation host address: {}", inv.host_address);
            return inv.host_address;
        }
        token.to_string()
    } else if let Some(pos) = trimmed.find("addr=") {
        let after = &trimmed[pos + 5..];
        let token = after.split('&').next().unwrap_or(after);
        token.to_string()
    } else {
        trimmed.to_string()
    }
}

fn get_android_download_dir() -> PathBuf {
    let candidates = [
        PathBuf::from("/data/data/jp.yasagure.ponlet/files/Download"),
        PathBuf::from("/data/data/dev.tailcat.tailsend/files/Download"),
        PathBuf::from("/sdcard/Download/Ponlet"),
        PathBuf::from("/storage/emulated/0/Download/Ponlet"),
        PathBuf::from("/sdcard/Ponlet"),
    ];
    for dir in &candidates {
        if fs::create_dir_all(dir).is_ok() {
            return dir.clone();
        }
    }
    PathBuf::from("/data/data/jp.yasagure.ponlet/files")
}

// parse_file_header parses the wire header sent by the web sender:
// `NAME:<filename>:<size>\n`. The filename may contain colons, so the
// size is split off at the last colon.
fn parse_file_header(line: &str) -> Option<(String, u64)> {
    let rest = line.strip_prefix("NAME:")?;
    let (name, size_str) = rest.rsplit_once(':')?;
    let size = size_str.trim().parse::<u64>().ok()?;
    let name = sanitize_filename(name).ok()?;
    Some((name, size))
}

fn unique_download_path(dir: &PathBuf, name: &str) -> PathBuf {
    let existing: HashSet<String> = fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    let unique_name = generate_unique_filename(&existing, name);
    dir.join(unique_name)
}

// receive_text_stream reads incoming Port 101 text. The desktop daemon keeps
// the connection open and sends "text\n" lines, so complete lines are handled
// as they arrive and any trailing data is flushed on EOF/timeout.
fn receive_text_stream(
    stream: TcHandle,
    app_weak: slint::Weak<AppWindow>,
    target_peer_addr: Arc<Mutex<Option<String>>>,
) {
    let handle_line = move |line: &str| {
        if line.is_empty() {
            return;
        }
        info!("✉️ [Tailcat Android] Text Received: {}", line);

        // Only messages sent by peers as handshakes start with the
        // handshake emoji; plain text containing "JOIN:" is a normal
        // message and must be displayed.
        let is_handshake = line.starts_with("🤝");
        if is_handshake {
            if let Some(idx) = line.find("JOIN:") {
                let peer_addr = line[idx + 5..].split_whitespace().next().unwrap_or("").trim();
                if !peer_addr.is_empty() {
                    if let Ok(mut guard) = target_peer_addr.lock() {
                        *guard = Some(peer_addr.to_string());
                        info!("🔗 [Tailcat Android] Automatically paired with remote peer: {}", peer_addr);
                    }
                }
            }
        }

        if !is_handshake {
            tailsend_telemetry::events::text_message_received(
                tailsend_telemetry::length_bucket(line.chars().count()),
            );
        }

        let w = app_weak.clone();
        let t = line.to_string();
        let _ = slint::invoke_from_event_loop(move || {
            if let Some(app) = w.upgrade() {
                app.set_screen_index(3);
                app.set_peer_name("Connected Peer (P2P)".into());
                if is_handshake {
                    app.set_status_text("Direct Encrypted P2P Connected!".into());
                } else {
                    let new_log = format!("[Peer]: {}\n{}", t, app.get_received_message_log());
                    app.set_received_message_log(new_log.into());
                    app.set_last_received_text(t.into());
                    app.set_status_text("Received text message via Tailcat P2P!".into());
                }
            }
        });
    };

    let mut buf = vec![0u8; 65536];
    let mut pending: Vec<u8> = Vec::new();
    let mut discarded = false;
    loop {
        let mut read_bytes: usize = 0;
        let r_res = unsafe {
            tc_stream_read(stream, buf.as_mut_ptr(), buf.len(), &mut read_bytes, 30000)
        };
        if r_res == 1 || r_res == 2 {
            // TC_EOF: sender closed. TC_TIMEOUT: persistent sender (daemon)
            // is still connected, stop reading instead of waiting forever.
            break;
        }
        if r_res != 0 {
            error!("❌ [Tailcat Android] Text stream read error (status {})", r_res);
            break;
        }
        if read_bytes == 0 {
            continue;
        }
        if pending.len() + read_bytes > 1024 * 1024 {
            discarded = true;
            break;
        }
        pending.extend_from_slice(&buf[..read_bytes]);
        while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(&pending[..pos]).to_string();
            pending.drain(..=pos);
            handle_line(&line);
        }
    }
    if !discarded && !pending.is_empty() {
        let rest = String::from_utf8_lossy(&pending).to_string();
        handle_line(&rest);
    }
    unsafe { tc_stream_close(stream); }
}

// receive_file_stream handles an incoming Port 102 file transfer: it reads
// the `NAME:<filename>:<size>\n` header, streams the body to the download
// directory, and reports progress / completion through the Slint UI.
fn receive_file_stream(stream: TcHandle, app_weak: slint::Weak<AppWindow>) {
    let start = Instant::now();
    let dir = get_android_download_dir();

    let mut header: Option<(String, u64)> = None;
    let mut file: Option<File> = None;
    let mut path = PathBuf::new();
    let mut pending: Vec<u8> = Vec::new();
    let mut received: u64 = 0;
    let mut total: u64 = 0;
    let mut last_ui_update = Instant::now();
    let mut failed: Option<String> = None;
    let mut buf = vec![0u8; 65536];

    let set_ui = |app_weak: slint::Weak<AppWindow>, transfer_status: &str, bytes_text: String, progress: f32, speed: String| {
        let status = transfer_status.to_string();
        let _ = slint::invoke_from_event_loop(move || {
            if let Some(app) = app_weak.upgrade() {
                app.set_is_transferring(true);
                app.set_transfer_completed(false);
                app.set_is_sender_transfer(false);
                app.set_transfer_status(status.into());
                app.set_transfer_bytes_text(bytes_text.into());
                app.set_transfer_progress(progress);
                app.set_transfer_speed(speed.into());
            }
        });
    };

    loop {
        let mut read_bytes: usize = 0;
        let res = unsafe {
            tc_stream_read(stream, buf.as_mut_ptr(), buf.len(), &mut read_bytes, 30000)
        };
        if res == 1 {
            break; // TC_EOF: sender finished
        }
        if res == 2 {
            failed = Some("Receive timed out".to_string());
            break;
        }
        if res != 0 {
            failed = Some(format!("Stream read error (status {})", res));
            break;
        }
        if read_bytes == 0 {
            continue;
        }
        pending.extend_from_slice(&buf[..read_bytes]);

        if header.is_none() {
            match pending.iter().position(|&b| b == b'\n') {
                Some(pos) => {
                    let header_str = String::from_utf8_lossy(&pending[..pos]).to_string();
                    pending.drain(..=pos);
                    match parse_file_header(&header_str) {
                        Some((name, size)) => {
                            total = size;
                            path = unique_download_path(&dir, &name);
                            match File::create(&path) {
                                Ok(f) => {
                                    file = Some(f);
                                    header = Some((name.clone(), size));
                                    info!(
                                        "📁 [Tailcat Android] Receiving file: {} ({} bytes) -> {}",
                                        name,
                                        size,
                                        path.display()
                                    );
                                    tailsend_telemetry::events::transfer_started(1, "direct", "receive");
                                    set_ui(
                                        app_weak.clone(),
                                        "Receiving file from Mac...",
                                        format!("0.0 MB / {:.1} MB", size as f64 / 1048576.0),
                                        0.0,
                                        "Receiving…".to_string(),
                                    );
                                }
                                Err(e) => {
                                    failed = Some(format!("Failed to create file: {}", e));
                                    break;
                                }
                            }
                        }
                        None => {
                            failed = Some(format!("Invalid file header: {}", header_str));
                            break;
                        }
                    }
                }
                None if pending.len() > 8192 => {
                    failed = Some("File header too large".to_string());
                    break;
                }
                None => continue,
            }
        }

        let f = match file.as_mut() {
            Some(f) => f,
            None => continue,
        };
        let chunk = std::mem::take(&mut pending);
        received += chunk.len() as u64;
        if let Err(e) = f.write_all(&chunk) {
            failed = Some(format!("Failed to write file: {}", e));
            break;
        }
        if total > 0 && received > total {
            failed = Some("Received more bytes than expected".to_string());
            break;
        }

        let now = Instant::now();
        if now.duration_since(last_ui_update).as_millis() >= 200 {
            last_ui_update = now;
            let elapsed = now.duration_since(start).as_secs_f64();
            let speed = if elapsed > 0.0 {
                format!("{:.1} MB/s", (received as f64 / 1048576.0) / elapsed)
            } else {
                "Calculating…".to_string()
            };
            set_ui(
                app_weak.clone(),
                "Receiving from Mac...",
                format!(
                    "{:.1} MB / {:.1} MB",
                    received as f64 / 1048576.0,
                    total as f64 / 1048576.0
                ),
                if total > 0 { received as f32 / total as f32 } else { 0.0 },
                speed,
            );
        }
    }

    let app_weak_done = app_weak.clone();
    match failed {
        None => {
            let complete = header.is_some() && (total == 0 || received == total);
            if let Some(mut f) = file.take() {
                let _ = f.flush();
            }
            let (name, size) = header.clone().unwrap_or_default();
            if complete {
                let mb = size as f64 / 1048576.0;
                let saved_path = path.display().to_string();
                info!(
                    "✅ [Tailcat Android] File received: {} ({:.1} MB) saved to {}",
                    name, mb, saved_path
                );
                tailsend_telemetry::events::transfer_completed(
                    1,
                    size,
                    start.elapsed().as_millis(),
                    "direct",
                    "receive",
                );
                let _ = slint::invoke_from_event_loop(move || {
                    if let Some(app) = app_weak_done.upgrade() {
                        app.set_screen_index(3);
                        app.set_is_transferring(false);
                        app.set_transfer_completed(true);
                        app.set_is_sender_transfer(false);
                        app.set_transfer_status("ファイル受信完了".into());
                        app.set_transfer_filename(name.clone().into());
                        app.set_transfer_bytes_text(format!("{:.1} MB", mb).into());
                        app.set_transfer_progress(1.0);
                        app.set_transfer_speed("保存完了".into());
                        app.set_status_text(format!("Received {} — Saved to Download/Ponlet!", name).into());
                        let new_log = format!(
                            "[File Received]: {} ({:.1} MB)\nSaved: {}\n{}",
                            name, mb, saved_path, app.get_received_message_log()
                        );
                        app.set_received_message_log(new_log.into());
                        app.set_saved_file_path(saved_path.into());
                    }
                });
            } else {
                let _ = fs::remove_file(&path);
                let _ = slint::invoke_from_event_loop(move || {
                    if let Some(app) = app_weak_done.upgrade() {
                        app.set_is_transferring(false);
                        app.set_transfer_status("Receive failed: transfer interrupted".into());
                        app.set_status_text("File transfer was interrupted".into());
                    }
                });
            }
        }
        Some(msg) => {
            let _ = fs::remove_file(&path);
            error!("❌ [Tailcat Android] File receive failed: {}", msg);
            tailsend_telemetry::events::error("transport");
            let _ = slint::invoke_from_event_loop(move || {
                if let Some(app) = app_weak_done.upgrade() {
                    app.set_is_transferring(false);
                    app.set_transfer_status(format!("Receive failed: {}", msg).into());
                    app.set_status_text("File receive failed".into());
                }
            });
        }
    }
}

// set_sender_transfer_ui pushes sender-side transfer progress to the Slint UI.
fn set_sender_transfer_ui(
    app_weak: slint::Weak<AppWindow>,
    status: &str,
    bytes_text: String,
    progress: f32,
    speed: &str,
) {
    let status = status.to_string();
    let speed = speed.to_string();
    let _ = slint::invoke_from_event_loop(move || {
        if let Some(app) = app_weak.upgrade() {
            app.set_is_transferring(true);
            app.set_transfer_completed(false);
            app.set_is_sender_transfer(true);
            app.set_transfer_status(status.into());
            app.set_transfer_bytes_text(bytes_text.into());
            app.set_transfer_progress(progress);
            app.set_transfer_speed(speed.into());
        }
    });
}

// sender_transfer_finished shows the terminal UI state for a sender transfer.
fn sender_transfer_finished(
    app_weak: slint::Weak<AppWindow>,
    success: bool,
    detail: String,
    name: String,
    bytes_text: String,
) {
    let _ = slint::invoke_from_event_loop(move || {
        if let Some(app) = app_weak.upgrade() {
            app.set_is_transferring(false);
            app.set_transfer_completed(success);
            app.set_is_sender_transfer(true);
            app.set_transfer_bytes_text(bytes_text.into());
            if success {
                app.set_transfer_filename(name.clone().into());
                app.set_transfer_progress(1.0);
                app.set_transfer_speed("送信完了".into());
                app.set_transfer_status("ファイル送信完了".into());
                app.set_status_text(format!("{} の送信が完了しました！", name).into());
            } else {
                app.set_transfer_progress(0.0);
                app.set_transfer_status(detail.clone().into());
                app.set_status_text(detail.into());
            }
        }
    });
}

// sender_transfer_failed is the shared failure path: reports telemetry + UI.
fn sender_transfer_failed(app_weak: slint::Weak<AppWindow>, msg: String) {
    error!("❌ [Tailcat Android] File send failed: {}", msg);
    tailsend_telemetry::events::error("transport");
    sender_transfer_finished(app_weak, false, format!("Send failed: {}", msg), String::new(), String::new());
}

// send_file_streaming dials port 102 to the target peer and streams the file
// from disk in 64KiB chunks (never loading it fully into memory):
//   tc_stream_dial -> `NAME:<sanitized name>:<size>\n` -> chunks ->
//   tc_stream_close_write -> wait EOF (<=3s) -> tc_stream_close
// Progress is throttled to 200ms and pushed to the UI via
// invoke_from_event_loop. With delete_after the (picker temp) file is removed
// afterwards regardless of the outcome. Returns the number of bytes sent.
fn send_file_streaming(
    file_path: PathBuf,
    display_name: &str,
    target_addr: &str,
    app_weak: slint::Weak<AppWindow>,
    delete_after: bool,
) -> Result<u64, String> {
    let start = Instant::now();
    let mut file = File::open(&file_path).map_err(|e| format!("Failed to open file: {}", e))?;
    let size = file
        .metadata()
        .map_err(|e| format!("Failed to stat file: {}", e))?
        .len();
    // The receiver splits the header at the last ':', and sanitize_filename
    // additionally replaces ':' with '_' and strips control chars such as '\n'.
    let name = sanitize_filename(display_name).map_err(|e| format!("Invalid filename: {}", e))?;
    let transport = if target_addr.contains("derp") { "relay" } else { "direct" };
    tailsend_telemetry::events::transfer_started(1, transport, "send");

    set_sender_transfer_ui(
        app_weak.clone(),
        "Sending file…",
        format!("0.0 MB / {:.1} MB", size as f64 / 1048576.0),
        0.0,
        "Preparing…",
    );

    let derp_url = "https://tailcat.dev/derpmap.json";
    let addr_bytes = target_addr.as_bytes();
    let mut dial_handle: TcHandle = 0;
    let dial_res = unsafe {
        tc_stream_dial(
            addr_bytes.as_ptr(),
            addr_bytes.len(),
            derp_url.as_ptr(),
            derp_url.len(),
            102,
            30000,
            &mut dial_handle,
        )
    };
    if dial_res != 0 || dial_handle == 0 {
        let mut err_buf = vec![0u8; 1024];
        let mut err_len: usize = 0;
        let _ = unsafe { tc_last_error(err_buf.as_mut_ptr(), err_buf.len(), &mut err_len) };
        err_buf.truncate(err_len);
        let msg = format!(
            "tc_stream_dial failed (code {}): {}",
            dial_res,
            String::from_utf8_lossy(&err_buf)
        );
        if delete_after {
            let _ = fs::remove_file(&file_path);
        }
        sender_transfer_failed(app_weak, msg.clone());
        return Err(msg);
    }

    let result = (|| -> Result<(), String> {
        let header = format!("NAME:{}:{}\n", name, size);
        let wres = unsafe {
            tc_stream_write_all(dial_handle, header.as_ptr(), header.len(), 30000)
        };
        if wres != 0 {
            return Err(format!("Header write failed (status {})", wres));
        }

        let mut buf = vec![0u8; 65536];
        let mut sent: u64 = 0;
        let mut last_ui = Instant::now();
        loop {
            let n = file.read(&mut buf).map_err(|e| format!("File read failed: {}", e))?;
            if n == 0 {
                break;
            }
            let wres = unsafe {
                tc_stream_write_all(dial_handle, buf.as_ptr(), n, 30000)
            };
            if wres != 0 {
                return Err(format!("Chunk write failed (status {}) at {} bytes", wres, sent));
            }
            sent += n as u64;

            let now = Instant::now();
            if now.duration_since(last_ui) >= Duration::from_millis(200) {
                last_ui = now;
                let elapsed = now.duration_since(start).as_secs_f64();
                let speed = if elapsed > 0.0 {
                    format!("{:.1} MB/s", (sent as f64 / 1048576.0) / elapsed)
                } else {
                    "Calculating…".to_string()
                };
                set_sender_transfer_ui(
                    app_weak.clone(),
                    "Sending file…",
                    format!(
                        "{:.1} MB / {:.1} MB",
                        sent as f64 / 1048576.0,
                        size as f64 / 1048576.0
                    ),
                    if size > 0 { sent as f32 / size as f32 } else { 1.0 },
                    &speed,
                );
            }
        }

        // Half-close so the receiver sees EOF after the payload.
        let cw_res = unsafe { tc_stream_close_write(dial_handle) };
        if cw_res != 0 {
            warn!("⚠️ [Tailcat Android] tc_stream_close_write returned {}", cw_res);
        }

        // Give the receiver up to 3s to consume and observe EOF.
        let eof_deadline = Instant::now() + Duration::from_millis(3000);
        let mut rbuf = [0u8; 512];
        loop {
            let now = Instant::now();
            if now >= eof_deadline {
                break;
            }
            let mut rd: usize = 0;
            let remaining_ms = (eof_deadline - now).as_millis() as u32;
            let res = unsafe {
                tc_stream_read(dial_handle, rbuf.as_mut_ptr(), rbuf.len(), &mut rd, remaining_ms)
            };
            match res {
                1 | 2 => break, // TC_EOF (peer done) or TC_TIMEOUT (nothing pending)
                0 => continue,
                3 => break, // TC_CANCELLED
                other => {
                    warn!("⚠️ [Tailcat Android] EOF wait read status {}", other);
                    break;
                }
            }
        }
        Ok(())
    })();

    unsafe { tc_stream_close(dial_handle); }

    match result {
        Ok(()) => {
            tailsend_telemetry::events::transfer_completed(
                1,
                size,
                start.elapsed().as_millis(),
                transport,
                "send",
            );
            if delete_after {
                let _ = fs::remove_file(&file_path);
            }
            info!(
                "✅ [Tailcat Android] File sent: {} ({:.1} MB) in {} ms",
                name,
                size as f64 / 1048576.0,
                start.elapsed().as_millis()
            );
            sender_transfer_finished(
                app_weak.clone(),
                true,
                String::new(),
                name.clone(),
                format!("{:.1} MB", size as f64 / 1048576.0),
            );
            Ok(size)
        }
        Err(msg) => {
            if delete_after {
                let _ = fs::remove_file(&file_path);
            }
            sender_transfer_failed(app_weak, msg.clone());
            Err(msg)
        }
    }
}

fn run_android_app(telemetry_initial: bool) -> Result<(), Box<dyn std::error::Error>> {
    let started_at = Instant::now();
    let base_url = "https://ponlet.mat2uken.app".to_string();

    let app = AppWindow::new()?;
    app.set_top_safe_area(32.0);
    // Telemetry opt-out toggle (Slint flips the property before invoking)
    app.set_telemetry_enabled(telemetry_initial);
    let app_weak_telemetry = app.as_weak();
    app.on_telemetry_toggled(move |enabled| {
        tailsend_telemetry::set_enabled(enabled);
        if let Some(app) = app_weak_telemetry.upgrade() {
            app.set_telemetry_enabled(enabled);
        }
    });
    let app_weak = app.as_weak();

    let target_peer_addr: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let target_peer_addr_clone = target_peer_addr.clone();

    let (_regen_tx, _regen_rx) = mpsc::unbounded_channel::<()>();
    let (join_tx, mut join_rx) = mpsc::unbounded_channel::<String>();
    let _ = GLOBAL_JOIN_TX.set(join_tx.clone());

    unsafe {
        let _ = tc_init();
    }

    let app_weak_boot = app_weak.clone();
    let base_url_clone = base_url.clone();
    let join_tx_thread = join_tx.clone();

    // Start background Tokio Runtime for Tailcat networking
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("Failed to create background Tokio runtime for Android");

        rt.block_on(async move {
            let derp_url = "https://tailcat.dev/derpmap.json";

            // 1. Create Tailcat Listener
            let mut listener_handle: TcHandle = 0;
            let res = unsafe {
                tc_listener_create(
                    derp_url.as_ptr(),
                    derp_url.len(),
                    1,
                    &mut listener_handle,
                )
            };

            let mut real_host_address = String::new();
            if res == 0 && listener_handle != 0 {
                let mut addr_buf = vec![0u8; 1024];
                let mut addr_len: usize = 0;
                let addr_res = unsafe {
                    tc_listener_address(
                        listener_handle,
                        addr_buf.as_mut_ptr(),
                        addr_buf.len(),
                        &mut addr_len,
                    )
                };
                if addr_res == 0 && addr_len > 0 {
                    addr_buf.truncate(addr_len);
                    real_host_address = String::from_utf8_lossy(&addr_buf).to_string();
                }
            } else {
                let mut err_buf = vec![0u8; 1024];
                let mut err_len: usize = 0;
                let _ = unsafe { tc_last_error(err_buf.as_mut_ptr(), err_buf.len(), &mut err_len) };
                if err_len > 0 {
                    err_buf.truncate(err_len);
                    error!("❌ [Tailcat Android] tc_listener_create failed (code {}): {}", res, String::from_utf8_lossy(&err_buf));
                } else {
                    error!("❌ [Tailcat Android] tc_listener_create failed (code {})", res);
                }
            }

            if real_host_address.is_empty() {
                real_host_address = "tc-android-native-wireguard-mesh".to_string();
            }

            info!("⚡ [Tailcat Android] Acquired ConnBlob Address: {}", real_host_address);
            tailsend_telemetry::events::session_created("unknown");

            // 2. Generate QR Code with Tailcat ConnBlob
            let mut session_id = [0u8; 16];
            rand::thread_rng().fill_bytes(&mut session_id);
            let mut invite_secret = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut invite_secret);

            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs();

            let invitation = InvitationV1::new(real_host_address.clone(), session_id, invite_secret, now, 600);
            let invite_url = invitation.to_qr_url(&base_url_clone).unwrap_or_default();
            let session_token = invitation.to_base64url().unwrap_or_default();

            info!("Generated Tailcat QR URL on Android: {}", invite_url);

            if let Ok(qr) = generate_qr_rgba(&invite_url, 236) {
                let mut pixel_buffer = SharedPixelBuffer::new(qr.width, qr.height);
                pixel_buffer.make_mut_bytes().copy_from_slice(&qr.rgba_pixels);

                let invite_url_copy = invite_url.clone();
                let app_weak_clone = app_weak_boot.clone();
                let display_sess = if session_token.len() >= 12 {
                    format!("{}...", &session_token[..12])
                } else {
                    session_token.clone()
                };

                let _ = slint::invoke_from_event_loop(move || {
                    if let Some(app) = app_weak_clone.upgrade() {
                        let slint_qr_img = Image::from_rgba8(pixel_buffer);
                        app.set_qr_code_image(slint_qr_img);
                        app.set_has_qr_image(true);
                        app.set_invite_url(invite_url_copy.into());
                        app.set_screen_index(1);
                        app.set_status_text("Scan QR with Mac to Connect (Pure Tailcat P2P)".into());
                        app.set_expires_secs(600);
                        app.set_can_disconnect(true);
                        app.set_can_send(true);
                        app.set_peer_name("Waiting for Mac...".into());
                        app.set_derp_info("tailcat.dev (WireGuard P2P)".into());
                        app.set_edge_relay_info("Pure Tailcat Mesh (No Relay)".into());
                        app.set_session_info(display_sess.into());
                    }
                });
            }

            // 3. Start background incoming event loop for listener
            let app_weak_listener = app_weak_boot.clone();
            let target_peer_addr_listener = target_peer_addr.clone();
            tokio::task::spawn_blocking(move || {
                loop {
                    let mut event = TcEvent {
                        struct_size: std::mem::size_of::<TcEvent>() as u32,
                        event_type: 0,
                        owner_handle: 0,
                        object_handle: 0,
                        port: 0,
                        reserved: 0,
                        status_code: 0,
                    };

                    let wait_res = unsafe { tc_wait_event(500, &mut event) };
                    if wait_res == 0 && event.event_type == 1 { // TC_EVENT_INCOMING_STREAM
                        let stream = event.object_handle;
                        let port = event.port;
                        info!("📥 [Tailcat Android] Incoming Stream accepted on Port {}", port);
                        tailsend_telemetry::events::peer_connected("direct");

                        let w = app_weak_listener.clone();
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w.upgrade() {
                                app.set_screen_index(3);
                                app.set_peer_name("Connected Mac (P2P)".into());
                                app.set_status_text(format!("WireGuard P2P Stream Active (Port {})", port).into());
                            }
                        });

                        if port == 101 {
                            // Read incoming text until EOF/timeout, handling each line
                            receive_text_stream(
                                stream,
                                app_weak_listener.clone(),
                                target_peer_addr_listener.clone(),
                            );
                        } else if port == 102 {
                            // Incoming file transfer from the web sender
                            receive_file_stream(stream, app_weak_listener.clone());
                            unsafe { tc_stream_close(stream); }
                        }
                    }
                }
            });

            // 4. Background listener for Join session commands (from ADB / UI)
            while let Some(invite_input) = join_rx.recv().await {
                let target_addr = parse_tailcat_address(&invite_input);
                info!("🔗 [Tailcat Android] Joining host: {}", target_addr);

                {
                    let mut lock = target_peer_addr.lock().unwrap();
                    *lock = Some(target_addr.clone());
                }

                let w = app_weak_boot.clone();
                let short_addr = if target_addr.len() >= 12 { format!("{}...", &target_addr[..12]) } else { target_addr.clone() };

                let _ = slint::invoke_from_event_loop(move || {
                    if let Some(app) = w.upgrade() {
                        app.set_screen_index(3);
                        app.set_peer_name("macOS Host (P2P)".into());
                        app.set_derp_info("tailcat.dev (WireGuard P2P)".into());
                        app.set_edge_relay_info("Pure Tailcat Mesh (No Relay)".into());
                        app.set_session_info(short_addr.into());
                        app.set_status_text("Connecting to macOS Host via WireGuard P2P...".into());
                    }
                });

                let w2 = app_weak_boot.clone();
                let real_host_addr_join = real_host_address.clone();
                std::thread::spawn(move || {
                    let derp_url = "https://tailcat.dev/derpmap.json";
                    let addr_bytes = target_addr.as_bytes();
                    let mut dial_handle: TcHandle = 0;
                    info!("📡 [Tailcat Android] Starting tc_stream_dial to Port 101...");
                    let dial_res = unsafe {
                        tc_stream_dial(
                            addr_bytes.as_ptr(),
                            addr_bytes.len(),
                            derp_url.as_ptr(),
                            derp_url.len(),
                            101,
                            30000,
                            &mut dial_handle,
                        )
                    };
                    info!("📡 [Tailcat Android] tc_stream_dial to Port 101 result: {}, handle: {}", dial_res, dial_handle);

                    if dial_res == 0 && dial_handle != 0 {
                        let msg = format!("🤝 [Connected] JOIN:{}\n", real_host_addr_join);
                        let write_res = unsafe {
                            tc_stream_write_all(dial_handle, msg.as_ptr(), msg.len(), 10000)
                        };
                        info!("📡 [Tailcat Android] tc_stream_write_all handshake result: {}", write_res);
                        unsafe { tc_stream_close(dial_handle); }
                        info!("✅ [Tailcat Android] Direct P2P Handshake delivered to Host with addr: {}", real_host_addr_join);
                        tailsend_telemetry::events::peer_connected(if target_addr.contains("derp") { "relay" } else { "direct" });

                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w2.upgrade() {
                                app.set_status_text("Connected to Host via Pure Tailcat P2P!".into());
                            }
                        });
                    } else {
                        tailsend_telemetry::record_error("transport");
                        let mut err_buf = [0u8; 256];
                        let mut err_len: usize = 0;
                        unsafe { tc_last_error(err_buf.as_mut_ptr(), err_buf.len(), &mut err_len); }
                        let err_str = String::from_utf8_lossy(&err_buf[..err_len.min(err_buf.len())]);
                        error!("❌ [Tailcat Android] Handshake dial failed (code {}): {}", dial_res, err_str);
                    }
                });
            }
        });
    });

    // Local IPC Server on 127.0.0.1:49153 for automated ADB testing
    // File-based command loop on /data/local/tmp/tailsend_cmd.json for rock-solid ADB E2E automation
    let join_tx_file = join_tx_thread.clone();
    let target_addr_file = target_peer_addr_clone.clone();
    let app_weak_ipc = app_weak.clone();
    std::thread::spawn(move || {
        let cmd_candidates = [
            PathBuf::from("/data/data/jp.yasagure.ponlet/files/tailsend_cmd.json"),
            PathBuf::from("/data/data/dev.tailcat.tailsend/files/tailsend_cmd.json"),
            PathBuf::from("/data/local/tmp/tailsend_cmd.json"),
            PathBuf::from("/sdcard/Download/tailsend_cmd.json"),
        ];
        let res_candidates = [
            PathBuf::from("/data/data/jp.yasagure.ponlet/files/tailsend_res.json"),
            PathBuf::from("/data/data/dev.tailcat.tailsend/files/tailsend_res.json"),
            PathBuf::from("/data/local/tmp/tailsend_res.json"),
            PathBuf::from("/sdcard/Download/tailsend_res.json"),
        ];

        let write_res = |msg: &str| {
            for res_path in &res_candidates {
                let _ = fs::write(res_path, msg);
            }
        };

        loop {
            std::thread::sleep(std::time::Duration::from_millis(150));
            for cmd_path in &cmd_candidates {
                if cmd_path.exists() {
                    if let Ok(content) = fs::read_to_string(cmd_path) {
                        let trimmed = content.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let _ = fs::write(cmd_path, "");
                        let _ = fs::remove_file(cmd_path);
                        info!("🤖 [Android File IPC Command]: {}", trimmed);
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                            let action = val["action"].as_str().unwrap_or_default();
                            match action {
                                "join" => {
                                    if let Some(url) = val["url"].as_str() {
                                        let _ = join_tx_file.send(url.to_string());
                                        write_res("{\"status\":\"ok\",\"action\":\"join\"}\n");
                                    }
                                }
                            "send_text" => {
                                if let Some(text) = val["text"].as_str() {
                                    let target = {
                                        let lock = target_addr_file.lock().unwrap();
                                        lock.clone()
                                    };
                                    if let Some(addr) = target {
                                        let derp_url = "https://tailcat.dev/derpmap.json";
                                        let addr_bytes = addr.as_bytes();
                                        let mut dial_handle: TcHandle = 0;
                                        let dial_res = unsafe {
                                            tc_stream_dial(
                                                addr_bytes.as_ptr(),
                                                addr_bytes.len(),
                                                derp_url.as_ptr(),
                                                derp_url.len(),
                                                101,
                                                30000,
                                                &mut dial_handle,
                                            )
                                        };
                                        if dial_res == 0 && dial_handle != 0 {
                                            let _ = unsafe {
                                                tc_stream_write_all(dial_handle, text.as_ptr(), text.len(), 10000)
                                            };
                                            unsafe { tc_stream_close(dial_handle); }
                                            tailsend_telemetry::events::text_message_sent(
                                                tailsend_telemetry::length_bucket(text.chars().count()),
                                            );
                                            write_res("{\"status\":\"ok\",\"action\":\"send_text\"}\n");
                                        } else {
                                            tailsend_telemetry::record_error("transport");
                                            write_res(&format!("{{\"status\":\"error\",\"code\":{}}}\n", dial_res));
                                        }
                                    } else {
                                        write_res("{\"status\":\"error\",\"msg\":\"no_target\"}\n");
                                    }
                                }
                            }
                            "send_file" => {
                                if let Some(path_str) = val["path"].as_str() {
                                    let target = {
                                        let lock = target_addr_file.lock().unwrap();
                                        lock.clone()
                                    };
                                    if let Some(addr) = target {
                                        let p = PathBuf::from(path_str);
                                        let fname = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "sample.bin".to_string());
                                        // Streaming send (64KiB chunks), never a
                                        // full-memory read. IPC-provided paths are
                                        // not deleted afterwards.
                                        let res_json = match send_file_streaming(
                                            p,
                                            &fname,
                                            &addr,
                                            app_weak_ipc.clone(),
                                            false,
                                        ) {
                                            Ok(_) => "{\"status\":\"ok\",\"action\":\"send_file\"}\n".to_string(),
                                            Err(e) => serde_json::json!({
                                                "status": "error",
                                                "msg": e,
                                            })
                                            .to_string(),
                                        };
                                        write_res(&res_json);
                                    } else {
                                        write_res("{\"status\":\"error\",\"msg\":\"no_target\"}\n");
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }
});

    // UI Action Handlers
    let target_addr_compose = target_peer_addr_clone.clone();
    let app_weak_compose = app_weak.clone();
    app.on_compose_text(move |msg| {
        let text_to_send = if msg.trim().is_empty() {
            "Hello macOS from Android Xperia Native!".to_string()
        } else {
            msg.to_string()
        };

        let target = {
            let lock = target_addr_compose.lock().unwrap();
            lock.clone()
        };

        if let Some(addr) = target {
            let w = app_weak_compose.clone();
            let t = text_to_send.clone();
            std::thread::spawn(move || {
                let derp_url = "https://tailcat.dev/derpmap.json";
                let addr_bytes = addr.as_bytes();
                let mut dial_handle: TcHandle = 0;
                let dial_res = unsafe {
                    tc_stream_dial(
                        addr_bytes.as_ptr(),
                        addr_bytes.len(),
                        derp_url.as_ptr(),
                        derp_url.len(),
                        101,
                        30000,
                        &mut dial_handle,
                    )
                };

                if dial_res == 0 && dial_handle != 0 {
                    let _ = unsafe {
                        tc_stream_write_all(dial_handle, t.as_ptr(), t.len(), 10000)
                    };
                    unsafe { tc_stream_close(dial_handle); }
                    tailsend_telemetry::events::text_message_sent(
                        tailsend_telemetry::length_bucket(t.chars().count()),
                    );

                    let w_cb = w.clone();
                    let t_cb = t.clone();
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(app) = w_cb.upgrade() {
                            let log_text = format!("Sent: {}\n{}", t_cb, app.get_received_message_log());
                            app.set_received_message_log(log_text.into());
                            app.set_message_input("".into());
                            app.set_status_text("Text delivered to macOS!".into());
                        }
                    });
                }
            });
        }
    });

    // Send File from Android: SAF picker (Kotlin) -> temp copy in cacheDir ->
    // streaming send over the Tailcat C-ABI (see send_file_streaming).
    let target_addr_pick = target_peer_addr_clone.clone();
    let app_weak_pick = app_weak.clone();
    app.on_pick_files(move || {
        let target = {
            let lock = target_addr_pick.lock().unwrap();
            lock.clone()
        };

        let Some(addr) = target else {
            if let Some(app) = app_weak_pick.upgrade() {
                app.set_status_text("相手未接続 — 先にペアリング（QR スキャンまたは招待URL）してください".into());
                app.set_transfer_status("相手未接続".into());
            }
            return;
        };

        match picker_pick() {
            Ok(true) => {
                if let Some(app) = app_weak_pick.upgrade() {
                    app.set_status_text("Select a file to send...".into());
                    app.set_screen_index(3);
                }
            }
            Ok(false) => {
                if let Some(app) = app_weak_pick.upgrade() {
                    app.set_status_text("File picker unavailable (no activity)".into());
                }
                return;
            }
            Err(e) => {
                error!("❌ [Tailcat Android] picker launch failed: {}", e);
                if let Some(app) = app_weak_pick.upgrade() {
                    app.set_status_text(format!("File picker error: {}", e).into());
                }
                return;
            }
        }

        // Poll Kotlin for the picker result, then stream the picked file out.
        let w = app_weak_pick.clone();
        std::thread::spawn(move || {
            let poll_start = Instant::now();
            let raw = loop {
                if let Some(json) = picker_poll() {
                    break Some(json);
                }
                if poll_start.elapsed() > Duration::from_secs(900) {
                    break None;
                }
                std::thread::sleep(Duration::from_millis(300));
            };

            let Some(raw) = raw else {
                let w2 = w.clone();
                let _ = slint::invoke_from_event_loop(move || {
                    if let Some(app) = w2.upgrade() {
                        app.set_status_text("File selection timed out".into());
                    }
                });
                return;
            };

            let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
            let status = parsed["status"].as_str().unwrap_or("error").to_string();
            let path = parsed["path"].as_str().unwrap_or_default().to_string();
            let name = parsed["name"].as_str().unwrap_or_default().to_string();

            match status.as_str() {
                "ok" => {
                    if path.is_empty() {
                        sender_transfer_failed(w.clone(), "Picked file path is empty".to_string());
                        return;
                    }
                    let _ = send_file_streaming(PathBuf::from(path), &name, &addr, w, true);
                }
                "cancelled" => {
                    let w2 = w.clone();
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(app) = w2.upgrade() {
                            app.set_status_text("File selection cancelled".into());
                        }
                    });
                }
                other => {
                    let msg = parsed["msg"].as_str().unwrap_or(other).to_string();
                    sender_transfer_failed(w, format!("File pick failed: {}", msg));
                }
            }
        });
    });

    // 📷 Scan QR Camera Callback (Kotlin zxing CaptureActivity via JNI).
    // Mirrors the iOS flow: the scanned QR text is pushed into the join flow
    // (join_tx -> parse_tailcat_address -> tc_stream_dial handshake).
    let app_weak_scan = app_weak.clone();
    let join_tx_scan = join_tx_thread.clone();
    app.on_scan_qr_camera(move || {
        info!("📷 Launching Android native camera QR scanner...");
        // Ignore taps while a scan is already in flight so a stale poll thread
        // cannot steal the next scan's result.
        if SCANNER_ACTIVE.swap(true, Ordering::SeqCst) {
            set_status_from_thread(&app_weak_scan, "QR scanner is already running".into());
            return;
        }
        match scanner_start() {
            Ok(true) => {
                set_status_from_thread(
                    &app_weak_scan,
                    "Scan the QR code on the Mac with the camera...".into(),
                );

                // Poll Kotlin for the scan result, then feed it into the join flow.
                let w = app_weak_scan.clone();
                let tx = join_tx_scan.clone();
                std::thread::spawn(move || {
                    let poll_start = Instant::now();
                    let raw = loop {
                        if let Some(json) = scanner_poll() {
                            break Some(json);
                        }
                        if poll_start.elapsed() > Duration::from_secs(900) {
                            break None;
                        }
                        std::thread::sleep(Duration::from_millis(300));
                    };
                    SCANNER_ACTIVE.store(false, Ordering::SeqCst);

                    let Some(raw) = raw else {
                        set_status_from_thread(&w, "QR scan timed out".into());
                        return;
                    };

                    let parsed: serde_json::Value =
                        serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
                    match parsed["status"].as_str().unwrap_or_default() {
                        "ok" => {
                            let text = parsed["text"].as_str().unwrap_or_default().to_string();
                            if text.is_empty() {
                                set_status_from_thread(&w, "QR scan returned no data".into());
                            } else {
                                info!("📸 [Kotlin Camera] Scanned QR code raw text: {}", text);
                                let _ = tx.send(text);
                            }
                        }
                        "cancelled" => {
                            set_status_from_thread(&w, "QR scan cancelled".into());
                        }
                        other => {
                            let msg = parsed["msg"].as_str().unwrap_or(other).to_string();
                            error!("❌ [Tailcat Android] QR scanner failed: {}", msg);
                            set_status_from_thread(&w, format!("QR scan failed: {}", msg));
                        }
                    }
                });
            }
            Ok(false) => {
                warn!("📷 scanner_start returned false (no activity/class)");
                SCANNER_ACTIVE.store(false, Ordering::SeqCst);
                set_status_from_thread(&app_weak_scan, "QR scanner unavailable (no activity)".into());
            }
            Err(e) => {
                SCANNER_ACTIVE.store(false, Ordering::SeqCst);
                error!("❌ [Tailcat Android] camera scanner launch failed: {}", e);
                set_status_from_thread(&app_weak_scan, format!("Camera scanner error: {}", e));
            }
        }
    });

    // 📋 Copy File Path Callback
    let app_weak_copy_path = app_weak.clone();
    app.on_copy_file_path(move || {
        if let Some(app) = app_weak_copy_path.upgrade() {
            let path = app.get_saved_file_path().to_string();
            if !path.is_empty() {
                app.set_status_text("File path copied!".into());
                app.set_path_copied_feedback(true);
            }
        }
    });

    let _repaint_timer = slint::Timer::default();
    _repaint_timer.start(slint::TimerMode::Repeated, std::time::Duration::from_millis(33), move || {
        // Continuous repaint pump for mobile screen
    });

    app.show()?;
    let loop_result = slint::run_event_loop();

    // Best-effort session end event (not sent when the process is killed)
    tailsend_telemetry::events::app_end(started_at.elapsed().as_millis());

    loop_result.map_err(|e| e.to_string().into())
}
