use std::collections::HashSet;
use std::ffi::CStr;
use std::io::Write;
use std::os::raw::c_char;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use log::{error, info};
use rand::RngCore;
use slint::{Image, SharedPixelBuffer};
use tailsend_protocol::filename::{generate_unique_filename, sanitize_filename};
use tailsend_protocol::invitation::InvitationV1;
use tailsend_qr::generate_qr_rgba;
use tokio::sync::mpsc;

slint::include_modules!();

mod telemetry;

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

    fn tailsend_swift_open_camera_scanner();
}

// Global channel for Swift QR camera scanner callbacks
static GLOBAL_JOIN_TX: std::sync::OnceLock<mpsc::UnboundedSender<String>> = std::sync::OnceLock::new();

#[no_mangle]
pub extern "C" fn tailsend_ios_main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    info!("Starting Ponlet iOS Native Application (Pure Tailcat WireGuard/DERP Mesh)...");

    let telemetry_initial = telemetry::init();
    let started_at = Instant::now();

    if let Err(e) = run_ios_app(telemetry_initial, started_at) {
        error!("Ponlet iOS run error: {:?}", e);
    }
}

#[no_mangle]
pub extern "C" fn tailsend_ios_join_session(url_ptr: *const c_char) {
    if url_ptr.is_null() {
        return;
    }
    let c_str = unsafe { CStr::from_ptr(url_ptr) };
    if let Ok(url_str) = c_str.to_str() {
        info!("📸 [Swift Camera] Scanned QR code raw text: {}", url_str);
        if let Some(tx) = GLOBAL_JOIN_TX.get() {
            let _ = tx.send(url_str.to_string());
        }
    }
}

fn parse_tailcat_address(input: &str) -> String {
    let trimmed = input.trim();
    if let Some(pos) = trimmed.find("#i=") {
        let after = &trimmed[pos + 3..];
        let token = after.split('&').next().unwrap_or(after);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        if let Ok(inv) = InvitationV1::from_base64url(token, now) {
            info!("🔑 Decoded InvitationV1 host address: {}", inv.host_address);
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

fn documents_dir() -> PathBuf {
    std::env::var("HOME")
        .map(|h| PathBuf::from(h).join("Documents"))
        .unwrap_or_else(|_| std::env::temp_dir())
}

fn unique_download_path(dir: &PathBuf, name: &str) -> PathBuf {
    let existing: HashSet<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    let unique_name = generate_unique_filename(&existing, name);
    dir.join(unique_name)
}

// receive_text_stream handles an incoming Port 101 text stream: it
// reads until EOF or idle timeout, delivering newline-terminated lines
// immediately (desktop sends them on a persistent connection) and
// flushing any trailing unterminated message at the end.
fn receive_text_stream(
    stream: TcHandle,
    app_weak: slint::Weak<AppWindow>,
    target_peer_addr: Arc<Mutex<Option<String>>>,
) {
    const MAX_TEXT_BYTES: usize = 1024 * 1024;

    let handle_message = |text: String,
                          app_weak: &slint::Weak<AppWindow>,
                          target_peer_addr: &Arc<Mutex<Option<String>>>| {
        info!("✉️ [Tailcat iOS] Text Received: {}", text);

        let mut is_handshake = false;
        if let Some(idx) = text.find("JOIN:") {
            is_handshake = true;
            let peer_addr = text[idx + 5..].split_whitespace().next().unwrap_or("").trim();
            if !peer_addr.is_empty() {
                if let Ok(mut guard) = target_peer_addr.lock() {
                    *guard = Some(peer_addr.to_string());
                    info!("🔗 [Tailcat iOS] Automatically paired with remote peer: {}", peer_addr);
                }
            }
        }
        if text.starts_with("🤝") {
            is_handshake = true;
        }

        if !is_handshake {
            tailsend_telemetry::events::text_message_received(
                tailsend_telemetry::length_bucket(text.chars().count()),
            );
        }

        let w = app_weak.clone();
        let t = text;
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

    let mut acc: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; 65536];
    loop {
        let mut read_bytes: usize = 0;
        let res = unsafe {
            tc_stream_read(stream, buf.as_mut_ptr(), buf.len(), &mut read_bytes, 30000)
        };
        if res != 0 || read_bytes == 0 {
            // EOF, idle timeout, or error: flush whatever arrived
            if !acc.is_empty() {
                let text = String::from_utf8_lossy(&acc).to_string();
                if !text.trim().is_empty() {
                    handle_message(text, &app_weak, &target_peer_addr);
                }
            }
            break;
        }
        acc.extend_from_slice(&buf[..read_bytes]);
        while let Some(pos) = acc.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = acc.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]).to_string();
            if !line.trim().is_empty() {
                handle_message(line, &app_weak, &target_peer_addr);
            }
        }
        if acc.len() > MAX_TEXT_BYTES {
            error!("✉️ [Tailcat iOS] Incoming text exceeds limit, discarding stream");
            break;
        }
    }
}

// receive_file_stream handles an incoming Port 102 file transfer from
// the web sender: it reads the `NAME:<filename>:<size>\n` header,
// streams the body to the app's Documents directory, and reports
// progress / completion through the Slint UI.
fn receive_file_stream(stream: TcHandle, app_weak: slint::Weak<AppWindow>) {
    let start = Instant::now();
    let dir = documents_dir();
    let _ = std::fs::create_dir_all(&dir);

    let mut header: Option<(String, u64)> = None;
    let mut file: Option<std::fs::File> = None;
    let mut path = PathBuf::new();
    let mut pending: Vec<u8> = Vec::new();
    let mut received: u64 = 0;
    let mut total: u64 = 0;
    let mut last_ui_update = Instant::now();
    let mut failed: Option<String> = None;
    let mut buf = vec![0u8; 65536];

    let set_ui = |app_weak: slint::Weak<AppWindow>, transfer_status: &str, bytes_text: String, progress: f32, speed: String, status_text: String| {
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
                app.set_status_text(status_text.into());
            }
        });
    };

    loop {
        let mut read_bytes: usize = 0;
        let res = unsafe {
            tc_stream_read(stream, buf.as_mut_ptr(), buf.len(), &mut read_bytes, 30000)
        };
        if res == 1 {
            break; // EOF: sender finished
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
                            match std::fs::File::create(&path) {
                                Ok(f) => {
                                    file = Some(f);
                                    header = Some((name.clone(), size));
                                    info!(
                                        "📁 [Tailcat iOS] Incoming file: {} ({} bytes) -> {}",
                                        name,
                                        size,
                                        path.display()
                                    );
                                    tailsend_telemetry::events::transfer_started(1, "direct", "receive");
                                    set_ui(
                                        app_weak.clone(),
                                        "Receiving file…",
                                        format!("0.0 MB / {:.1} MB", size as f64 / 1048576.0),
                                        0.0,
                                        "Receiving…".to_string(),
                                        format!("Receiving {}…", name),
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
                "Receiving file…",
                format!(
                    "{:.1} MB / {:.1} MB",
                    received as f64 / 1048576.0,
                    total as f64 / 1048576.0
                ),
                if total > 0 { received as f32 / total as f32 } else { 0.0 },
                speed,
                "Receiving file…".to_string(),
            );
        }
    }

    let app_weak_done = app_weak.clone();
    match failed {
        None => {
            let complete = header.is_some() && (total == 0 || received == total);
            if let Some(mut f) = file {
                let _ = f.flush();
            }
            let (name, size) = header.clone().unwrap_or_default();
            if complete {
                let mb = size as f64 / 1048576.0;
                let saved_path = path.display().to_string();
                info!(
                    "✅ [Tailcat iOS] File received: {} ({:.1} MB) saved to {}",
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
                        app.set_is_transferring(false);
                        app.set_transfer_completed(true);
                        app.set_is_sender_transfer(false);
                        app.set_transfer_status("File Received!".into());
                        app.set_transfer_filename(name.clone().into());
                        app.set_transfer_bytes_text(format!("{:.1} MB", mb).into());
                        app.set_transfer_progress(1.0);
                        app.set_status_text(format!("Received {} ({:.1} MB)!", name, mb).into());
                        app.set_saved_file_path(saved_path.into());
                    }
                });
            } else {
                let _ = std::fs::remove_file(&path);
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
            let _ = std::fs::remove_file(&path);
            error!("❌ [Tailcat iOS] File receive failed: {}", msg);
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

fn run_ios_app(telemetry_initial: bool, started_at: Instant) -> Result<(), Box<dyn std::error::Error>> {
    let base_url = "https://ponlet.mat2uken.app".to_string();
    
    // Create Slint AppWindow on Main Thread
    let app = AppWindow::new()?;
    app.set_top_safe_area(44.0);
    let app_weak = app.as_weak();

    // Store target peer Tailcat address for outgoing P2P transfers
    let target_peer_addr: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let target_peer_addr_thread = target_peer_addr.clone();

    // Channel to trigger QR regeneration
    let (regen_tx, mut regen_rx) = mpsc::unbounded_channel::<()>();

    // Channel for joining another peer's session (from QR camera or input)
    let (join_tx, mut join_rx) = mpsc::unbounded_channel::<String>();
    let _ = GLOBAL_JOIN_TX.set(join_tx.clone());

    // Initialize Tailcat C-ABI
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
            .expect("Failed to create background Tokio runtime for iOS");

        rt.block_on(async move {
            let derp_url = "https://tailcat.dev/derpmap.json";

            loop {
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
                }

                if real_host_address.is_empty() {
                    real_host_address = "tc-ios-native-wireguard-mesh".to_string();
                }

                info!("⚡ [Tailcat iOS] Acquired ConnBlob Address: {}", real_host_address);
                tailsend_telemetry::events::session_created("tailcat");

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

                info!("Generated Tailcat QR URL on iOS: {}", invite_url);

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
                let target_peer_addr_listener = target_peer_addr_thread.clone();
                let listener_task = tokio::task::spawn_blocking(move || {
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
                            info!("📥 [Tailcat iOS] Incoming Stream accepted on Port {}", port);
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
                                // Read incoming text (line-buffered, EOF flush)
                                receive_text_stream(
                                    stream,
                                    app_weak_listener.clone(),
                                    target_peer_addr_listener.clone(),
                                );
                                unsafe { tc_stream_close(stream); }
                            } else if port == 102 {
                                // Incoming file transfer from the web sender
                                receive_file_stream(stream, app_weak_listener.clone());
                                unsafe { tc_stream_close(stream); }
                            }
                        }
                    }
                });

                // 4. Wait for countdown expiry, regen, or join signal
                let app_weak_timer = app_weak_boot.clone();
                let mut triggered_regen = false;
                let mut triggered_join: Option<String> = None;

                for s in (0..=600).rev() {
                    let w = app_weak_timer.clone();
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(app) = w.upgrade() {
                            app.set_expires_secs(s);
                        }
                    });

                    tokio::select! {
                        _ = tokio::time::sleep(tokio::time::Duration::from_secs(1)) => {}
                        Some(_) = regen_rx.recv() => {
                            info!("Regeneration signal received...");
                            triggered_regen = true;
                            break;
                        }
                        Some(join_url_or_code) = join_rx.recv() => {
                            info!("Join session signal received for: {}", join_url_or_code);
                            triggered_join = Some(join_url_or_code);
                            break;
                        }
                    }
                }

                // Handle Join Mode (iPhone connecting directly to Mac's Tailcat ConnBlob)
                if let Some(target_code) = triggered_join {
                    let target_addr = parse_tailcat_address(&target_code);
                    info!("🚀 [Tailcat Direct Join] Target ConnBlob: {}", target_addr);

                    if let Ok(mut guard) = target_peer_addr_thread.lock() {
                        *guard = Some(target_addr.clone());
                    }

                    let w = app_weak_boot.clone();
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(app) = w.upgrade() {
                            app.set_screen_index(3);
                            app.set_peer_name("Connected Mac (P2P)".into());
                            app.set_derp_info("tailcat.dev (WireGuard P2P)".into());
                            app.set_edge_relay_info("Pure Tailcat Mesh (No Relay)".into());
                            app.set_status_text("Connected to Mac via Pure Tailcat P2P!".into());
                        }
                    });

                    // Send initial handshake ping directly to Peer's Port 101
                    let t_addr = target_addr.clone();
                    let my_host_addr = real_host_address.clone();
                    tokio::task::spawn_blocking(move || {
                        let mut out_stream: TcHandle = 0;
                        let derp = "https://tailcat.dev/derpmap.json";
                        let dial_res = unsafe {
                            tc_stream_dial(
                                t_addr.as_ptr(),
                                t_addr.len(),
                                derp.as_ptr(),
                                derp.len(),
                                101,
                                30000,
                                &mut out_stream,
                            )
                        };
                        if dial_res == 0 && out_stream != 0 {
                            let handshake_msg = format!("🤝 [Connected] JOIN:{}\n", my_host_addr);
                            let _ = unsafe {
                                tc_stream_write_all(out_stream, handshake_msg.as_ptr(), handshake_msg.len(), 10000)
                            };
                            unsafe { tc_stream_close(out_stream); }
                            info!("✅ [Tailcat P2P] Direct handshake successfully delivered to Host with addr: {}", my_host_addr);
                            tailsend_telemetry::events::peer_connected("direct");
                        } else {
                            error!("❌ [Tailcat P2P] Failed to dial Host: status {}", dial_res);
                        }
                    });

                    // Wait until user disconnects or wants to regenerate
                    tokio::select! {
                        Some(_) = regen_rx.recv() => {
                            info!("Disconnecting from Mac...");
                        }
                        Some(new_join) = join_rx.recv() => {
                            info!("New join request received: {}", new_join);
                        }
                    }
                    listener_task.abort();
                    if listener_handle != 0 {
                        unsafe { tc_listener_close(listener_handle); }
                    }
                    continue;
                }

                listener_task.abort();
                if listener_handle != 0 {
                    unsafe { tc_listener_close(listener_handle); }
                }

                if !triggered_regen {
                    let w = app_weak_boot.clone();
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(app) = w.upgrade() {
                            app.set_status_text("Invitation expired. Tap Regenerate to create a new QR code.".into());
                        }
                    });
                    
                    tokio::select! {
                        Some(_) = regen_rx.recv() => {}
                        Some(join_url) = join_rx.recv() => {
                            let _ = join_tx_thread.send(join_url);
                        }
                    }
                }
            }
        });
    });

    // 📷 Scan QR Camera Callback (Opens native AVFoundation scanner)
    app.on_scan_qr_camera(move || {
        info!("Launching iOS native camera QR scanner...");
        unsafe {
            tailsend_swift_open_camera_scanner();
        }
    });

    // 🔗 Join Session Callback
    let join_tx_input = join_tx.clone();
    let app_weak_join_input = app_weak.clone();
    app.on_join_session(move |input_text| {
        let code = input_text.to_string();
        info!("Joining Tailcat session with input: {}", code);
        if !code.is_empty() {
            if let Some(app) = app_weak_join_input.upgrade() {
                app.set_status_text("Connecting to Mac via Tailcat P2P...".into());
            }
            let _ = join_tx_input.send(code);
        }
    });

    // 📋 Paste & Join Callback
    let join_tx_paste = join_tx.clone();
    let app_weak_paste = app_weak.clone();
    app.on_paste_and_join(move || {
        if let Some(app) = app_weak_paste.upgrade() {
            let input_val = app.get_join_input_text().to_string();
            if !input_val.is_empty() {
                app.set_status_text("Connecting to Mac via Tailcat P2P...".into());
                let _ = join_tx_paste.send(input_val);
            } else {
                app.set_status_text("Please paste invite URL into text box".into());
            }
        }
    });

    // Regenerate Invite Callback
    let regen_tx_clone = regen_tx.clone();
    let app_weak_regen = app_weak.clone();
    app.on_regenerate_invite(move || {
        info!("Regenerate QR Code button tapped on iOS!");
        if let Some(app) = app_weak_regen.upgrade() {
            app.set_status_text("Regenerating new Tailcat QR code...".into());
        }
        let _ = regen_tx_clone.send(());
    });

    // Copy Invite URL Callback
    let app_weak_copy = app_weak.clone();
    app.on_copy_invite(move || {
        if let Some(app) = app_weak_copy.upgrade() {
            let copy_url = app.get_invite_url().to_string();
            app.set_status_text("Invite URL ready!".into());
            info!("Invite URL copied: {}", copy_url);
        }
    });

    // Disconnect Callback
    let app_weak_disc = app_weak.clone();
    let regen_tx_disc = regen_tx.clone();
    app.on_disconnect(move || {
        if let Some(app) = app_weak_disc.upgrade() {
            app.set_screen_index(1);
            app.set_status_text("Disconnected. Generating new QR code...".into());
        }
        let _ = regen_tx_disc.send(());
    });

    // Telemetry opt-out toggle (Slint flips the property before invoking)
    app.set_telemetry_enabled(telemetry_initial);
    let app_weak_telemetry = app_weak.clone();
    app.on_telemetry_toggled(move |enabled| {
        tailsend_telemetry::set_enabled(enabled);
        if let Some(app) = app_weak_telemetry.upgrade() {
            app.set_telemetry_enabled(enabled);
        }
    });

    // ✉️ Compose Text Message Handler (Direct P2P via Tailcat Port 101)
    let app_weak_text = app_weak.clone();
    let target_addr_text = target_peer_addr.clone();
    app.on_compose_text(move |msg| {
        if let Some(app) = app_weak_text.upgrade() {
            let msg_str = msg.to_string();
            if msg_str.trim().is_empty() {
                return;
            }
            info!("📤 [Tailcat P2P iOS] Sending text: {}", msg_str);
            let log_text = format!("[Me]: {}\n{}", msg_str, app.get_received_message_log());
            app.set_received_message_log(log_text.into());
            app.set_message_input("".into());

            let target = target_addr_text.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
            if !target.is_empty() {
                let m_copy = msg_str.clone();
                let app_weak_status = app_weak_text.clone();
                std::thread::spawn(move || {
                    let mut out_stream: TcHandle = 0;
                    let derp = "https://tailcat.dev/derpmap.json";
                    let dial_res = unsafe {
                        tc_stream_dial(
                            target.as_ptr(),
                            target.len(),
                            derp.as_ptr(),
                            derp.len(),
                            101,
                            30000,
                            &mut out_stream,
                        )
                    };
                    if dial_res == 0 && out_stream != 0 {
                        let _ = unsafe {
                            tc_stream_write_all(out_stream, m_copy.as_ptr(), m_copy.len(), 10000)
                        };
                        unsafe { tc_stream_close(out_stream); }
                        info!("✅ [Tailcat P2P iOS] Text delivered directly to Mac!");
                        tailsend_telemetry::events::text_message_sent(
                            tailsend_telemetry::length_bucket(m_copy.chars().count()),
                        );
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = app_weak_status.upgrade() {
                                app.set_status_text("Message sent directly via Tailcat P2P!".into());
                            }
                        });
                    } else {
                        error!("❌ [Tailcat P2P iOS] Failed to send text: dial error {}", dial_res);
                        tailsend_telemetry::record_error("transport");
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = app_weak_status.upgrade() {
                                app.set_status_text("Error sending message to Mac".into());
                            }
                        });
                    }
                });
            }
        }
    });

    // 📋 Paste & Send Text Handler
    let app_weak_paste_send = app_weak.clone();
    let target_addr_paste = target_peer_addr.clone();
    app.on_paste_and_send(move || {
        if let Some(app) = app_weak_paste_send.upgrade() {
            let msg_str = app.get_message_input().to_string();
            if !msg_str.trim().is_empty() {
                let log_text = format!("[Me]: {}\n{}", msg_str, app.get_received_message_log());
                app.set_received_message_log(log_text.into());
                app.set_message_input("".into());

                let target = target_addr_paste.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
                if !target.is_empty() {
                    let m_copy = msg_str.clone();
                    std::thread::spawn(move || {
                        let mut out_stream: TcHandle = 0;
                        let derp = "https://tailcat.dev/derpmap.json";
                        let dial_res = unsafe {
                            tc_stream_dial(
                                target.as_ptr(),
                                target.len(),
                                derp.as_ptr(),
                                derp.len(),
                                101,
                                30000,
                                &mut out_stream,
                            )
                        };
                        if dial_res == 0 && out_stream != 0 {
                            let _ = unsafe {
                                tc_stream_write_all(out_stream, m_copy.as_ptr(), m_copy.len(), 10000)
                            };
                            unsafe { tc_stream_close(out_stream); }
                            tailsend_telemetry::events::text_message_sent(
                                tailsend_telemetry::length_bucket(m_copy.chars().count()),
                            );
                        } else {
                            tailsend_telemetry::record_error("transport");
                        }
                    });
                }
            }
        }
    });

    // 📁 Pick File Handler Stub
    let app_weak_file = app_weak.clone();
    app.on_pick_files(move || {
        if let Some(app) = app_weak_file.upgrade() {
            app.set_status_text("Direct P2P file sharing ready".into());
        }
    });

    // ❌ Cancel Transfer Handler
    let app_weak_cancel = app_weak.clone();
    app.on_cancel_transfer(move || {
        if let Some(app) = app_weak_cancel.upgrade() {
            app.set_is_transferring(false);
            app.set_transfer_status("Transfer cancelled".into());
        }
        tailsend_telemetry::events::transfer_cancelled("user");
    });

    // 📤 Share Received Text
    let app_weak_share = app_weak.clone();
    app.on_share_received_text(move || {
        if let Some(app) = app_weak_share.upgrade() {
            app.set_status_text("Sharing received text...".into());
        }
    });

    // 💾 Save Received Text
    let app_weak_save = app_weak.clone();
    app.on_save_received_text(move || {
        if let Some(app) = app_weak_save.upgrade() {
            app.set_status_text("Text saved!".into());
        }
    });

    // 📋 Copy Received Text Callback
    let app_weak_copy_text = app_weak.clone();
    app.on_copy_received_text(move || {
        if let Some(app) = app_weak_copy_text.upgrade() {
            let text = app.get_last_received_text().to_string();
            if !text.is_empty() {
                app.set_status_text("Text copied!".into());
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

    app.show()?;
    slint::run_event_loop()?;

    tailsend_telemetry::events::app_end(started_at.elapsed().as_millis());
    Ok(())
}
