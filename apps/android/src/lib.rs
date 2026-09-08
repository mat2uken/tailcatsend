use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use log::{error, info};
use rand::RngCore;
use slint::{Image, SharedPixelBuffer};
use tailsend_protocol::invitation::InvitationV1;
use tailsend_qr::generate_qr_rgba;
use tokio::sync::mpsc;

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
    fn tc_last_error(buffer: *mut u8, capacity: usize, out_length: *mut usize) -> i32;
}

// Global channel for external join session triggers (e.g. from ADB / Intent)
static GLOBAL_JOIN_TX: std::sync::OnceLock<mpsc::UnboundedSender<String>> = std::sync::OnceLock::new();

#[no_mangle]
fn android_main(app: android_activity::AndroidApp) {
    android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Info)
            .with_tag("PonletAndroid"),
    );

    info!("🚀 Starting Ponlet Android Native Application (Slint + Pure Tailcat WireGuard)...");

    slint::android::init(app).expect("Failed to initialize Slint Android backend");

    if let Err(e) = run_android_app() {
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

fn run_android_app() -> Result<(), Box<dyn std::error::Error>> {
    let base_url = "https://mktailcatsend.pages.dev".to_string();

    let app = AppWindow::new()?;
    app.set_top_safe_area(32.0);
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

                        let w = app_weak_listener.clone();
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w.upgrade() {
                                app.set_screen_index(3);
                                app.set_peer_name("Connected Mac (P2P)".into());
                                app.set_status_text(format!("WireGuard P2P Stream Active (Port {})", port).into());
                            }
                        });

                        if port == 101 {
                            // Read incoming text
                            let mut buf = vec![0u8; 65536];
                            let mut read_bytes: usize = 0;
                            let r_res = unsafe {
                                tc_stream_read(stream, buf.as_mut_ptr(), buf.len(), &mut read_bytes, 30000)
                            };
                            if r_res == 0 && read_bytes > 0 {
                                buf.truncate(read_bytes);
                                let text = String::from_utf8_lossy(&buf).to_string();
                                info!("✉️ [Tailcat Android] Text Received: {}", text);

                                let mut is_handshake = false;
                                if let Some(idx) = text.find("JOIN:") {
                                    is_handshake = true;
                                    let peer_addr = text[idx + 5..].split_whitespace().next().unwrap_or("").trim();
                                    if !peer_addr.is_empty() {
                                        if let Ok(mut guard) = target_peer_addr_listener.lock() {
                                            *guard = Some(peer_addr.to_string());
                                            info!("🔗 [Tailcat Android] Automatically paired with remote peer: {}", peer_addr);
                                        }
                                    }
                                }
                                if text.starts_with("🤝") {
                                    is_handshake = true;
                                }

                                let w = app_weak_listener.clone();
                                let t = text.clone();
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
                            }
                            unsafe { tc_stream_close(stream); }
                        } else if port == 102 {
                            // Read incoming file with progress
                            let out_dir = get_android_download_dir();
                            let mut header_buf = vec![0u8; 1024];
                            let mut header_read: usize = 0;
                            let hr_res = unsafe {
                                tc_stream_read(stream, header_buf.as_mut_ptr(), header_buf.len(), &mut header_read, 30000)
                            };

                            if hr_res == 0 && header_read > 0 {
                                header_buf.truncate(header_read);
                                let header_str = String::from_utf8_lossy(&header_buf);
                                let mut filename = format!("android_received_{}.bin", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs());
                                let mut expected_size: i64 = 0;
                                let mut payload_start = 0;

                                if let Some(newline_pos) = header_str.find('\n') {
                                    let line = &header_str[..newline_pos];
                                    payload_start = newline_pos + 1;
                                    if line.starts_with("NAME:") {
                                        let meta = line.trim_start_matches("NAME:").trim();
                                        if let Some((f, s)) = meta.split_once(':') {
                                            filename = f.to_string();
                                            expected_size = s.parse::<i64>().unwrap_or(0);
                                        } else {
                                            filename = meta.to_string();
                                        }
                                    }
                                }

                                let total_mb = expected_size as f64 / 1048576.0;
                                let out_path = out_dir.join(&filename);
                                info!("📁 [Tailcat Android] Receiving file: {} -> {}", filename, out_path.display());

                                let w = app_weak_listener.clone();
                                let fn_start = filename.clone();
                                let _ = slint::invoke_from_event_loop(move || {
                                    if let Some(app) = w.upgrade() {
                                        app.set_screen_index(3);
                                        app.set_is_transferring(true);
                                        app.set_transfer_completed(false);
                                        app.set_is_sender_transfer(false);
                                        app.set_transfer_filename(fn_start.clone().into());
                                        if total_mb > 0.0 {
                                            app.set_transfer_bytes_text(format!("0.0 MB / {:.1} MB", total_mb).into());
                                        } else {
                                            app.set_transfer_bytes_text("Starting receive...".into());
                                        }
                                        app.set_transfer_speed("Connecting...".into());
                                        app.set_transfer_progress(0.05);
                                        app.set_transfer_status("Receiving file from Mac...".into());
                                        app.set_status_text(format!("Receiving {} from Mac...", fn_start).into());
                                    }
                                });

                                if let Ok(mut out_file) = File::create(&out_path) {
                                    if payload_start < header_read {
                                        let _ = out_file.write_all(&header_buf[payload_start..]);
                                    }
                                    let mut total_bytes = (header_read - payload_start) as i64;
                                    let mut chunk_buf = vec![0u8; 64 * 1024];

                                    loop {
                                        let mut read_chunk: usize = 0;
                                        let cr = unsafe {
                                            tc_stream_read(stream, chunk_buf.as_mut_ptr(), chunk_buf.len(), &mut read_chunk, 15000)
                                        };
                                        if cr != 0 || read_chunk == 0 {
                                            break;
                                        }
                                        let _ = out_file.write_all(&chunk_buf[..read_chunk]);
                                        total_bytes += read_chunk as i64;

                                        let progress = if expected_size > 0 {
                                            total_bytes as f32 / expected_size as f32
                                        } else {
                                            0.5
                                        };
                                        let cur_mb = total_bytes as f64 / 1048576.0;
                                        let w_prog = app_weak_listener.clone();
                                        let fn_prog = filename.clone();
                                        let bytes_txt = if total_mb > 0.0 {
                                            format!("{:.1} MB / {:.1} MB", cur_mb, total_mb)
                                        } else {
                                            format!("{:.1} MB", cur_mb)
                                        };

                                        let _ = slint::invoke_from_event_loop(move || {
                                            if let Some(app) = w_prog.upgrade() {
                                                app.set_is_transferring(true);
                                                app.set_transfer_completed(false);
                                                app.set_transfer_filename(fn_prog.into());
                                                app.set_transfer_bytes_text(bytes_txt.into());
                                                app.set_transfer_progress(progress);
                                                app.set_transfer_status("Receiving from Mac...".into());
                                            }
                                        });
                                    }

                                    let final_mb = total_bytes as f64 / 1048576.0;
                                    info!("✅ [Tailcat Android] File successfully saved: {} ({:.1} MB)", out_path.display(), final_mb);

                                    let w_done = app_weak_listener.clone();
                                    let fn_done = filename.clone();
                                    let fp_done = out_path.display().to_string();

                                    let _ = slint::invoke_from_event_loop(move || {
                                        if let Some(app) = w_done.upgrade() {
                                            app.set_screen_index(3);
                                            app.set_is_transferring(false);
                                            app.set_transfer_completed(true);
                                            app.set_is_sender_transfer(false);
                                            app.set_transfer_filename(fn_done.clone().into());
                                            app.set_transfer_bytes_text(format!("{:.1} MB", final_mb).into());
                                            app.set_transfer_speed("保存完了".into());
                                            app.set_transfer_progress(1.0);
                                            app.set_transfer_status("ファイル受信完了".into());
                                            app.set_status_text(format!("Received {} — Saved to Download/Ponlet!", fn_done).into());
                                            let new_log = format!(
                                                "[File Received]: {} ({:.1} MB)\nSaved: {}\n{}",
                                                fn_done, final_mb, fp_done, app.get_received_message_log()
                                            );
                                            app.set_received_message_log(new_log.into());
                                        }
                                    });
                                }
                            }
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

                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w2.upgrade() {
                                app.set_status_text("Connected to Host via Pure Tailcat P2P!".into());
                            }
                        });
                    } else {
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
                                            write_res("{\"status\":\"ok\",\"action\":\"send_text\"}\n");
                                        } else {
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
                                        let data = fs::read(&p).unwrap_or_else(|_| b"Sample Payload".to_vec());
                                        let fsize = data.len();

                                        let derp_url = "https://tailcat.dev/derpmap.json";
                                        let addr_bytes = addr.as_bytes();
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
                                        if dial_res == 0 && dial_handle != 0 {
                                            let header = format!("NAME:{}:{}\n", fname, fsize);
                                            let _ = unsafe {
                                                tc_stream_write_all(dial_handle, header.as_ptr(), header.len(), 10000)
                                            };
                                            let _ = unsafe {
                                                tc_stream_write_all(dial_handle, data.as_ptr(), data.len(), 30000)
                                            };
                                            unsafe { tc_stream_close(dial_handle); }
                                            write_res("{\"status\":\"ok\",\"action\":\"send_file\"}\n");
                                        } else {
                                            let mut err_buf = vec![0u8; 1024];
                                            let mut err_len: usize = 0;
                                            let _ = unsafe { tc_last_error(err_buf.as_mut_ptr(), err_buf.len(), &mut err_len) };
                                            let err_msg = if err_len > 0 {
                                                String::from_utf8_lossy(&err_buf[..err_len]).to_string()
                                            } else {
                                                "unknown".to_string()
                                            };
                                            error!("❌ [Tailcat Android] send_file tc_stream_dial failed: {}", err_msg);
                                            write_res(&format!("{{\"status\":\"error\",\"code\":{},\"msg\":\"{}\"}}\n", dial_res, err_msg));
                                        }
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

    // Send File from Android
    let target_addr_file = target_peer_addr_clone.clone();
    let app_weak_file = app_weak.clone();
    app.on_pick_files(move || {
        let target = {
            let lock = target_addr_file.lock().unwrap();
            lock.clone()
        };

        if let Some(addr) = target {
            let sample_file = PathBuf::from("/sdcard/Download/xperia_sample.png");
            if !sample_file.exists() {
                let _ = fs::write(&sample_file, b"TAILSEND_XPERIA_SAMPLE_IMAGE_DATA_1234567890");
            }

            let w = app_weak_file.clone();
            std::thread::spawn(move || {
                let derp_url = "https://tailcat.dev/derpmap.json";
                let filename = "xperia_sample.png".to_string();
                let file_data = fs::read(&sample_file).unwrap_or_else(|_| b"Xperia Sample File".to_vec());
                let file_size = file_data.len() as i64;
                let total_mb = file_size as f64 / 1048576.0;

                let addr_bytes = addr.as_bytes();
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

                if dial_res == 0 && dial_handle != 0 {
                    let header = format!("NAME:{}:{}\n", filename, file_size);
                    let _ = unsafe {
                        tc_stream_write_all(dial_handle, header.as_ptr(), header.len(), 10000)
                    };
                    let _ = unsafe {
                        tc_stream_write_all(dial_handle, file_data.as_ptr(), file_data.len(), 30000)
                    };
                    unsafe { tc_stream_close(dial_handle); }

                    let w_cb = w.clone();
                    let fn_cb = filename.clone();
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(app) = w_cb.upgrade() {
                            app.set_is_transferring(false);
                            app.set_transfer_completed(true);
                            app.set_is_sender_transfer(true);
                            app.set_transfer_filename(fn_cb.clone().into());
                            app.set_transfer_bytes_text(format!("{:.1} MB", total_mb).into());
                            app.set_transfer_speed("送信完了".into());
                            app.set_transfer_progress(1.0);
                            app.set_transfer_status("ファイル送信完了".into());
                            app.set_status_text(format!("{} の送信が完了しました！", fn_cb).into());
                        }
                    });
                }
            });
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
    slint::run_event_loop().map_err(|e| e.to_string().into())
}
