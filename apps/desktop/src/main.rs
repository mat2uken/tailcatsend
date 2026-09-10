use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use arboard::Clipboard;
use log::{info, warn};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use slint::{Image, SharedPixelBuffer};
use tailsend_protocol::invitation::InvitationV1;
use tailsend_qr::generate_qr_rgba;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::mpsc;

mod telemetry;

slint::include_modules!();

#[derive(Debug, Serialize, Deserialize)]
struct DaemonEvent {
    event: String,
    address: Option<String>,
    port: Option<u16>,
    handle: Option<u64>,
    text: Option<String>,
    filename: Option<String>,
    size: Option<i64>,
    bytes: Option<i64>,
    progress: Option<f64>,
    speed: Option<String>,
    path: Option<String>,
    error: Option<String>,
    is_derp: Option<bool>,
    transport_type: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DaemonCommand {
    action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    handle: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

fn get_download_dir() -> PathBuf {
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        PathBuf::from(home).join("Downloads").join("TailSend")
    } else {
        PathBuf::from("TailSend_Downloads")
    }
}

#[cfg(windows)]
extern "system" {
    fn GetUserDefaultUILanguage() -> u16;
}

fn detect_system_language() -> &'static str {
    #[cfg(windows)]
    unsafe {
        let lang_id = GetUserDefaultUILanguage();
        // Primary language ID 0x11 is Japanese (0x0411)
        if (lang_id & 0x3ff) == 0x11 {
            return "ja";
        }
    }
    for var in &["LANG", "LC_ALL", "LANGUAGE", "UI_LANG"] {
        if let Ok(val) = std::env::var(var) {
            let lower = val.to_lowercase();
            if lower.starts_with("ja") {
                return "ja";
            }
        }
    }
    "en"
}

struct I18n;

impl I18n {
    pub fn boot_status(is_ja: bool) -> &'static str {
        if is_ja { "安全なP2P通信を準備しています…" } else { "Starting secure P2P network…" }
    }
    pub fn scan_qr_status(is_ja: bool) -> &'static str {
        if is_ja { "スマホのカメラでQRコードをスキャンして接続" } else { "Scan QR with Phone to Connect" }
    }
    pub fn waiting_for_peer(is_ja: bool) -> &'static str {
        if is_ja { "相手端末の接続待機中…" } else { "Waiting for Peer..." }
    }
    pub fn connected_peer(is_ja: bool) -> &'static str {
        if is_ja { "接続された相手端末" } else { "Connected Peer" }
    }
    pub fn connecting_peer(is_ja: bool) -> &'static str {
        if is_ja { "相手端末に接続中…" } else { "Connecting to Peer Device..." }
    }
    pub fn direct_connected(is_ja: bool) -> &'static str {
        if is_ja { "直接暗号化P2Pで接続しました！" } else { "Connected via Direct Encrypted P2P!" }
    }
    pub fn stream_active(is_ja: bool) -> &'static str {
        if is_ja { "直接P2P通信が確立しました" } else { "Direct P2P Connection Active" }
    }
    pub fn msg_received(is_ja: bool) -> &'static str {
        if is_ja { "メッセージを受信しました！" } else { "Received text message!" }
    }
    pub fn file_recv_start(is_ja: bool, fname: &str) -> String {
        if is_ja { format!("{} を受信中…", fname) } else { format!("Receiving {} from Peer...", fname) }
    }
    pub fn file_recv_status(is_ja: bool) -> &'static str {
        if is_ja { "ファイルを受信中…" } else { "Receiving file from Peer..." }
    }
    pub fn file_recv_done(is_ja: bool, fname: &str, size_mb: f64) -> String {
        if is_ja {
            format!("{} ({:.1} MB) を保存しました", fname, size_mb)
        } else {
            format!("Received {} ({:.1} MB) — Saved!", fname, size_mb)
        }
    }
    pub fn file_recv_completed_badge(is_ja: bool) -> &'static str {
        if is_ja { "ファイル受信が完了しました！" } else { "File Transfer Complete!" }
    }
    pub fn file_sending(is_ja: bool) -> &'static str {
        if is_ja { "ファイル送信中…" } else { "Sending file via P2P..." }
    }
    pub fn ready_for_transfer(is_ja: bool) -> &'static str {
        if is_ja { "ファイル転送の準備完了" } else { "Ready for Transfer" }
    }
    pub fn securely_connected(is_ja: bool) -> &'static str {
        if is_ja { "相手端末と直接安全に接続されています" } else { "Securely connected to Peer" }
    }
    pub fn qr_regenerated(is_ja: bool) -> &'static str {
        if is_ja { "新しいQRコードを生成しました！" } else { "New QR Code generated! Scan with phone." }
    }
    pub fn disconnected(is_ja: bool) -> &'static str {
        if is_ja { "切断しました。新しいQRコードをスキャンしてください。" } else { "Disconnected. Please scan new QR code." }
    }
    pub fn invite_copied(is_ja: bool) -> &'static str {
        if is_ja { "招待URLをクリップボードにコピーしました！" } else { "Invite URL copied to clipboard!" }
    }
    pub fn text_copied(is_ja: bool) -> &'static str {
        if is_ja { "テキストをクリップボードにコピーしました！" } else { "Text copied to clipboard!" }
    }
    pub fn path_copied(is_ja: bool) -> &'static str {
        if is_ja { "ファイルパスをクリップボードにコピーしました！" } else { "File path copied to clipboard!" }
    }
    pub fn text_saved(is_ja: bool, path: &str) -> String {
        if is_ja { format!("テキストを保存しました: {}", path) } else { format!("Text saved to {}", path) }
    }
    pub fn label_me(is_ja: bool) -> &'static str {
        if is_ja { "[自分]" } else { "[Me]" }
    }
    pub fn label_peer(is_ja: bool) -> &'static str {
        if is_ja { "[相手]" } else { "[Peer]" }
    }
    pub fn label_file_recv(is_ja: bool) -> &'static str {
        if is_ja { "[ファイル受信]" } else { "[File Received]" }
    }
    pub fn label_saved(is_ja: bool) -> &'static str {
        if is_ja { "保存先" } else { "Saved" }
    }
    pub fn transfer_cancelled(is_ja: bool) -> &'static str {
        if is_ja { "転送をキャンセルしました" } else { "Transfer cancelled" }
    }
    pub fn invite_expired(is_ja: bool) -> &'static str {
        if is_ja { "招待の有効期限が切れました。再生成してください。" } else { "Invite expired. Please click Regenerate." }
    }
    pub fn camera_unsupported(is_ja: bool) -> &'static str {
        if is_ja {
            "カメラスキャンはモバイル端末のみ対応しています。「貼付して接続」をご利用ください。"
        } else {
            "Camera scanning is only available on mobile. Please use 'Paste & Join' instead."
        }
    }
    pub fn peer_not_connected(is_ja: bool) -> &'static str {
        if is_ja { "相手端末が接続されていません" } else { "No peer device connected" }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    info!("Starting Ponlet Desktop Native Application (Pure Tailcat P2P)...");
    println!("\n🚀 Ponlet Desktop Native App is starting (Pure Tailcat WireGuard/DERP Mesh)...");

    let started_at = Instant::now();

    let args: Vec<String> = std::env::args().collect();
    let base_url = if args.len() > 1 && !args[1].trim().is_empty() {
        args[1].trim().to_string()
    } else {
        std::env::var("TAILSEND_WEB_URL").unwrap_or_else(|_| "https://ponlet.mat2uken.app".to_string())
    };

    let app = AppWindow::new()?;
    let app_weak = app.as_weak();

    // Set detected language (ja/en)
    let initial_lang = detect_system_language();
    let is_ja_init = initial_lang == "ja";
    app.set_current_language(initial_lang.into());
    info!("Detected system language: {} (Auto-initialized)", initial_lang);

    // Telemetry: install the platform backend (no-op unless GA4 env vars are
    // set) and restore the persisted opt-out state.
    let telemetry_initial = telemetry::init(&initial_lang);
    tailsend_telemetry::events::app_start("desktop", std::env::consts::OS, env!("CARGO_PKG_VERSION"), initial_lang);
    tailsend_telemetry::set_user_property("platform", "desktop");
    tailsend_telemetry::set_user_property("app_version", env!("CARGO_PKG_VERSION"));
    tailsend_telemetry::set_user_property("os_version", std::env::consts::OS);
    tailsend_telemetry::set_user_property("language", initial_lang);

    // Show window immediately so user sees UI instantly
    app.set_screen_index(0);
    app.set_status_text(I18n::boot_status(is_ja_init).into());
    app.show()?;

    // Store target peer Tailcat address for outgoing P2P transfers
    let target_peer_addr: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let _target_peer_addr_clone = target_peer_addr.clone();

    // Store host address for invite regeneration
    let host_addr_shared = Arc::new(Mutex::new(String::new()));
    let host_addr_shared_init = host_addr_shared.clone();

    // Transfer start timestamp for duration telemetry
    let transfer_started_at: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
    let transfer_started_at_daemon = transfer_started_at.clone();

    // IPC channel to communicate with Tailcat daemon
    let (ipc_tx, mut ipc_rx) = mpsc::unbounded_channel::<DaemonCommand>();
    let ipc_tx_clone = ipc_tx.clone();

    // Find and spawn native Tailcat daemon in background
    let app_weak_boot = app_weak.clone();
    let base_url_boot = base_url.clone();
    let target_peer_addr_daemon = target_peer_addr.clone();

    tokio::spawn(async move {
        let daemon_bin_name = if cfg!(windows) {
            "tailcat_daemon.exe"
        } else {
            "tailcat_daemon"
        };

        let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf()));

        let candidates = [
            exe_dir.as_ref().map(|d| d.join(daemon_bin_name)),
            Some(current_dir.join(daemon_bin_name)),
            Some(current_dir.join("target").join("release").join(daemon_bin_name)),
            Some(current_dir.join("target").join("debug").join(daemon_bin_name)),
            Some(current_dir.join("tailcat").join(daemon_bin_name)),
            Some(PathBuf::from(format!("./{}", daemon_bin_name))),
        ];

        let daemon_path = candidates
            .into_iter()
            .flatten()
            .find(|p| p.is_file())
            .unwrap_or_else(|| PathBuf::from(daemon_bin_name));

        info!("Spawning Tailcat native daemon from path: {}", daemon_path.display());

        let child_res = Command::new(&daemon_path)
            .arg("-derp=https://tailcat.dev/derpmap.json")
            .arg("-ipc-port=49152")
            .arg("-v")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn();

        let mut real_host_address = String::new();
        let mut reader_opt = None;

        match child_res {
            Ok(mut child) => {
                if let Some(stdout) = child.stdout.take() {
                    let mut reader = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = reader.next_line().await {
                        info!("[tailcat-daemon] {}", line);
                        if let Ok(ev) = serde_json::from_str::<DaemonEvent>(&line) {
                            if ev.event == "ready" {
                                if let Some(addr) = ev.address {
                                    let transport = if addr.contains("derp") { "relay" } else { "direct" };
                                    tailsend_telemetry::events::session_created(transport);
                                    real_host_address = addr;
                                    break;
                                }
                            }
                        }
                    }
                    reader_opt = Some(reader);
                }
            }
            Err(e) => {
                warn!("Tailcat daemon could not be spawned ({}): {}. Using standalone mode.", daemon_path.display(), e);
            }
        }

        if real_host_address.is_empty() {
            real_host_address = "tc-fallback-ephemeral-address".to_string();
        }

        if let Ok(mut guard) = host_addr_shared_init.lock() {
            *guard = real_host_address.clone();
        }

        info!("⚡ Acquired Tailcat Native ConnBlob: {}", real_host_address);
        println!("⚡ Local Tailcat WireGuard Address: {}\n", real_host_address);

        // Generate Invitation and QR Code
        let mut session_id = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut session_id);
        let mut invite_secret = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut invite_secret);

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let invitation = InvitationV1::new(real_host_address.clone(), session_id, invite_secret, now, 600);
        let invite_url = invitation.to_qr_url(&base_url_boot).unwrap_or_default();
        let session_token = invitation.to_base64url().unwrap_or_default();

        info!("Generated Tailcat QR Invitation: {}", invite_url);

        if let Ok(qr) = generate_qr_rgba(&invite_url, 236) {
            let _ = image::save_buffer_with_format(
                "qr_code.png",
                &qr.rgba_pixels,
                qr.width,
                qr.height,
                image::ColorType::Rgba8,
                image::ImageFormat::Png,
            );

            let mut pixel_buffer = SharedPixelBuffer::new(qr.width, qr.height);
            pixel_buffer.make_mut_bytes().copy_from_slice(&qr.rgba_pixels);

            let w_init = app_weak_boot.clone();
            let inv_u = invite_url.clone();
            let sess_t = session_token.clone();

            let _ = slint::invoke_from_event_loop(move || {
                if let Some(app) = w_init.upgrade() {
                    let is_ja = app.get_current_language() == "ja";
                    let slint_qr_img = Image::from_rgba8(pixel_buffer);
                    app.set_qr_code_image(slint_qr_img);
                    app.set_has_qr_image(true);
                    app.set_invite_url(inv_u.into());
                    app.set_screen_index(1);
                    app.set_status_text(I18n::scan_qr_status(is_ja).into());
                    app.set_expires_secs(600);
                    app.set_can_disconnect(true);
                    app.set_can_send(true);
                    app.set_peer_name(I18n::waiting_for_peer(is_ja).into());
                    app.set_derp_info(if is_ja { "暗号化メッシュ" } else { "Encrypted Mesh" }.into());
                    app.set_edge_relay_info(if is_ja { "P2P直接通信" } else { "Direct P2P" }.into());
                    let display_sess = if sess_t.len() >= 12 {
                        format!("{}...", &sess_t[..12])
                    } else {
                        sess_t.clone()
                    };
                    app.set_session_info(display_sess.into());
                }
            });
        }

        // Connect to Daemon IPC Port with retry loop
        tokio::spawn(async move {
            let mut stream_opt = None;
            for _ in 0..10 {
                tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                if let Ok(stream) = TcpStream::connect("127.0.0.1:49152").await {
                    info!("Connected to Tailcat daemon local IPC");
                    stream_opt = Some(stream);
                    break;
                }
            }
            if let Some(mut stream) = stream_opt {
                while let Some(cmd) = ipc_rx.recv().await {
                    if let Ok(data) = serde_json::to_vec(&cmd) {
                        if stream.write_all(&data).await.is_err() || stream.write_all(b"\n").await.is_err() {
                            warn!("Failed to write command to daemon IPC stream");
                            break;
                        }
                    }
                }
            }
        });

        // Listen for incoming Tailcat events from Daemon stdout
        let app_weak_daemon = app_weak_boot.clone();
        if let Some(mut reader) = reader_opt {
            while let Ok(Some(line)) = reader.next_line().await {
            info!("[tailcat-event] {}", line);
            if let Ok(ev) = serde_json::from_str::<DaemonEvent>(&line) {
                match ev.event.as_str() {
                    "incoming_stream" => {
                        let w = app_weak_daemon.clone();
                        let _port = ev.port.unwrap_or(0);
                        let is_derp = ev.is_derp.unwrap_or_else(|| {
                            ev.address.as_ref().map(|a| a.contains("derp")).unwrap_or(false)
                        });
                        if let Some(ref addr) = ev.address {
                            if let Ok(mut guard) = target_peer_addr_daemon.lock() {
                                *guard = Some(addr.clone());
                            }
                        }
                        tailsend_telemetry::events::peer_connected(if is_derp { "relay" } else { "direct" });
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w.upgrade() {
                                let is_ja = app.get_current_language() == "ja";
                                app.set_screen_index(3);
                                app.set_peer_name(I18n::connected_peer(is_ja).into());
                                app.set_status_text(I18n::stream_active(is_ja).into());
                                app.set_is_derp_relay(is_derp);
                                app.set_transport_type(ev.transport_type.unwrap_or(if is_derp { 2 } else { 0 }));
                            }
                        });
                    }
                    "incoming_text" => {
                        if let Some(text) = ev.text {
                            println!("✉️ [P2P Direct Text Received]: {}", text);
                            let is_derp = ev.is_derp.unwrap_or_else(|| {
                                ev.address.as_ref().map(|a| a.contains("derp")).unwrap_or(false)
                            });
                            let mut is_handshake = false;
                            if let Some(idx) = text.find("JOIN:") {
                                is_handshake = true;
                                let peer_addr = text[idx + 5..].split_whitespace().next().unwrap_or("").trim();
                                if !peer_addr.is_empty() {
                                    if let Ok(mut guard) = target_peer_addr_daemon.lock() {
                                        *guard = Some(peer_addr.to_string());
                                        info!("🔗 Automatically paired with remote peer: {}", peer_addr);
                                    }
                                }
                            } else if let Some(ref addr) = ev.address {
                                if let Ok(mut guard) = target_peer_addr_daemon.lock() {
                                    *guard = Some(addr.clone());
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

                            let w = app_weak_daemon.clone();
                            let t = text.clone();
                            let t_type = ev.transport_type.unwrap_or(if is_derp { 2 } else { 0 });
                            let _ = slint::invoke_from_event_loop(move || {
                                if let Some(app) = w.upgrade() {
                                    let is_ja = app.get_current_language() == "ja";
                                    app.set_screen_index(3);
                                    app.set_peer_name(I18n::connected_peer(is_ja).into());
                                    app.set_is_derp_relay(is_derp);
                                    app.set_transport_type(t_type);
                                    if is_handshake {
                                        app.set_status_text(I18n::direct_connected(is_ja).into());
                                    } else {
                                        let peer_label = I18n::label_peer(is_ja);
                                        let new_log = format!("{}: {}\n{}", peer_label, t, app.get_received_message_log());
                                        app.set_received_message_log(new_log.into());
                                        app.set_last_received_text(t.into());
                                        app.set_status_text(I18n::msg_received(is_ja).into());
                                    }
                                }
                            });
                        }
                    }
                    "incoming_file_start" => {
                        let fname = ev.filename.unwrap_or_else(|| "file.bin".to_string());
                        let total_mb = ev.size.unwrap_or(0) as f64 / 1048576.0;
                        let is_derp = ev.is_derp.unwrap_or_else(|| {
                            ev.address.as_ref().map(|a| a.contains("derp")).unwrap_or(false)
                        });
                        tailsend_telemetry::events::transfer_started(
                            1,
                            if is_derp { "relay" } else { "direct" },
                            "receive",
                        );
                        if let Ok(mut guard) = transfer_started_at_daemon.lock() {
                            *guard = Some(Instant::now());
                        }
                        let w = app_weak_daemon.clone();
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w.upgrade() {
                                let is_ja = app.get_current_language() == "ja";
                                app.set_screen_index(3);
                                app.set_peer_name(I18n::connected_peer(is_ja).into());
                                app.set_is_transferring(true);
                                app.set_transfer_completed(false);
                                app.set_is_sender_transfer(false);
                                app.set_saved_file_path("".into());
                                app.set_path_copied_feedback(false);
                                app.set_transfer_filename(fname.clone().into());
                                if total_mb > 0.0 {
                                    app.set_transfer_bytes_text(format!("0.0 MB / {:.1} MB", total_mb).into());
                                } else {
                                    app.set_transfer_bytes_text(if is_ja { "受信を開始中…" } else { "Starting download..." }.into());
                                }
                                app.set_transfer_speed(if is_ja { "接続中…" } else { "Connecting..." }.into());
                                app.set_transfer_progress(0.05);
                                app.set_transfer_status(I18n::file_recv_status(is_ja).into());
                                app.set_status_text(I18n::file_recv_start(is_ja, &fname).into());
                                app.set_is_derp_relay(is_derp);
                                app.set_transport_type(ev.transport_type.unwrap_or(if is_derp { 2 } else { 0 }));
                            }
                        });
                    }
                    "incoming_file_progress" => {
                        let fname = ev.filename.unwrap_or_else(|| "file.bin".to_string());
                        let bytes_mb = ev.bytes.unwrap_or(0) as f64 / 1048576.0;
                        let total_mb = ev.size.unwrap_or(0) as f64 / 1048576.0;
                        let progress = if ev.progress.unwrap_or(0.0) > 0.0 {
                            ev.progress.unwrap_or(0.0)
                        } else {
                            0.5
                        };
                        let speed = ev.speed.unwrap_or_default();
                        let bytes_text = if total_mb > 0.0 {
                            format!("{:.1} MB / {:.1} MB", bytes_mb, total_mb)
                        } else {
                            format!("{:.1} MB", bytes_mb)
                        };
                        let w = app_weak_daemon.clone();
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w.upgrade() {
                                let is_ja = app.get_current_language() == "ja";
                                app.set_is_transferring(true);
                                app.set_transfer_completed(false);
                                app.set_is_sender_transfer(false);
                                app.set_transfer_filename(fname.clone().into());
                                app.set_transfer_bytes_text(bytes_text.into());
                                app.set_transfer_speed(speed.into());
                                app.set_transfer_progress(progress as f32);
                                app.set_transfer_status(I18n::file_recv_status(is_ja).into());
                            }
                        });
                    }
                    "incoming_file" => {
                        let fname = ev.filename.unwrap_or_else(|| "file.bin".to_string());
                        let fsize = ev.size.unwrap_or(0) as f64 / 1048576.0;
                        let total_bytes = ev.size.unwrap_or(0).max(0) as u64;
                        let fpath = ev.path.unwrap_or_default();
                        let saved_path = if !fpath.is_empty() {
                            fpath
                        } else {
                            get_download_dir().join(&fname).to_string_lossy().to_string()
                        };
                        println!("📁 [P2P Direct File Received]: {} ({:.1} MB) -> {}", fname, fsize, saved_path);

                        let is_derp = ev.is_derp.unwrap_or_else(|| {
                            ev.address.as_ref().map(|a| a.contains("derp")).unwrap_or(false)
                        });
                        let duration_ms = transfer_started_at_daemon
                            .lock()
                            .ok()
                            .and_then(|guard| *guard)
                            .map(|t| t.elapsed().as_millis())
                            .unwrap_or(0);
                        tailsend_telemetry::events::transfer_completed(
                            1,
                            total_bytes,
                            duration_ms,
                            if is_derp { "relay" } else { "direct" },
                            "receive",
                        );

                        let w = app_weak_daemon.clone();
                        let saved_path_clone = saved_path.clone();
                        let fname_clone = fname.clone();
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w.upgrade() {
                                let is_ja = app.get_current_language() == "ja";
                                app.set_screen_index(3);
                                app.set_is_transferring(false);
                                app.set_transfer_completed(true);
                                app.set_is_sender_transfer(false);
                                app.set_transfer_filename(fname_clone.clone().into());
                                app.set_transfer_bytes_text(format!("{:.1} MB", fsize).into());
                                app.set_transfer_speed(if is_ja { "保存完了" } else { "Saved" }.into());
                                app.set_transfer_progress(1.0);
                                app.set_transfer_status(I18n::file_recv_completed_badge(is_ja).into());
                                app.set_status_text(I18n::file_recv_done(is_ja, &fname_clone, fsize).into());
                                app.set_saved_file_path(saved_path_clone.clone().into());
                                app.set_path_copied_feedback(false);
                                let recv_label = I18n::label_file_recv(is_ja);
                                let saved_label = I18n::label_saved(is_ja);
                                let new_log = format!(
                                    "{}: {} ({:.1} MB)\n{}: {}\n{}",
                                    recv_label, fname_clone, fsize, saved_label, saved_path_clone, app.get_received_message_log()
                                );
                                app.set_received_message_log(new_log.into());
                            }
                        });
                    }
                    "send_file_success" => {
                        let fname = ev.filename.unwrap_or_else(|| "file.bin".to_string());
                        let total_mb = ev.size.unwrap_or(0) as f64 / 1048576.0;
                        let total_bytes = ev.size.unwrap_or(0).max(0) as u64;
                        let is_derp = ev.transport_type.unwrap_or(0) == 2;
                        let duration_ms = transfer_started_at_daemon
                            .lock()
                            .ok()
                            .and_then(|guard| *guard)
                            .map(|t| t.elapsed().as_millis())
                            .unwrap_or(0);
                        tailsend_telemetry::events::transfer_completed(
                            1,
                            total_bytes,
                            duration_ms,
                            if is_derp { "relay" } else { "direct" },
                            "send",
                        );
                        let w = app_weak_daemon.clone();
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w.upgrade() {
                                let is_ja = app.get_current_language() == "ja";
                                app.set_is_transferring(false);
                                app.set_transfer_completed(true);
                                app.set_is_sender_transfer(true);
                                app.set_transfer_filename(fname.clone().into());
                                app.set_transfer_bytes_text(format!("{:.1} MB", total_mb).into());
                                app.set_transfer_speed(if is_ja { "送信完了" } else { "Sent" }.into());
                                app.set_transfer_progress(1.0);
                                app.set_transfer_status(if is_ja { "ファイル送信完了" } else { "File Sent Successfully!" }.into());
                                app.set_status_text(if is_ja { format!("{} ({:.1} MB) を送信しました", fname, total_mb).into() } else { format!("Sent {} ({:.1} MB) successfully!", fname, total_mb).into() });
                            }
                        });
                    }
                    "send_text_success" => {
                        let w = app_weak_daemon.clone();
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w.upgrade() {
                                let is_ja = app.get_current_language() == "ja";
                                app.set_status_text(if is_ja { "送信完了 ✓" } else { "Message sent ✓" }.into());
                            }
                        });
                    }
                    "error" => {
                        let err_msg = ev.error.unwrap_or_else(|| "Unknown error".to_string());
                        warn!("Tailcat daemon error event: {}", err_msg);
                        tailsend_telemetry::events::error("transport");
                        let w = app_weak_daemon.clone();
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w.upgrade() {
                                let is_ja = app.get_current_language() == "ja";
                                app.set_is_transferring(false);
                                app.set_status_text(if is_ja { format!("送信エラー: {}", err_msg).into() } else { format!("Error: {}", err_msg).into() });
                            }
                        });
                    }
                    _ => {}
                }
            }
        }
        }
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

    // Language Switch Callback
    let app_weak_lang = app_weak.clone();
    app.on_switch_language(move |lang| {
        if let Some(app) = app_weak_lang.upgrade() {
            let l_str = lang.to_string();
            info!("User switched language to: {}", l_str);
            app.set_current_language(l_str.clone().into());
            let is_ja = l_str == "ja";
            match app.get_screen_index() {
                0 => app.set_status_text(I18n::boot_status(is_ja).into()),
                1 => {
                    app.set_status_text(I18n::scan_qr_status(is_ja).into());
                    app.set_peer_name(I18n::waiting_for_peer(is_ja).into());
                },
                2 => app.set_status_text(I18n::connecting_peer(is_ja).into()),
                3 => {
                    app.set_peer_name(I18n::connected_peer(is_ja).into());
                    if !app.get_is_transferring() && !app.get_transfer_completed() {
                        app.set_status_text(I18n::securely_connected(is_ja).into());
                        app.set_transfer_status(I18n::ready_for_transfer(is_ja).into());
                    }
                },
                _ => {}
            }
        }
    });

    // Clipboard Copy Handler with Automatic Feedback Reset Timer
    let app_weak_copy = app_weak.clone();
    app.on_copy_invite(move || {
        if let Some(app) = app_weak_copy.upgrade() {
            let copy_url = app.get_invite_url().to_string();
            if let Ok(mut clipboard) = Clipboard::new() {
                let _ = clipboard.set_text(&copy_url);
                let is_ja = app.get_current_language() == "ja";
                app.set_status_text(I18n::invite_copied(is_ja).into());
                app.set_copy_feedback_active(true);

                let w_timer = app_weak_copy.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(app) = w_timer.upgrade() {
                            app.set_copy_feedback_active(false);
                        }
                    });
                });
            }
        }
    });

    // Regenerate Invite Handler
    let app_weak_regen = app_weak.clone();
    let host_addr_for_regen = host_addr_shared.clone();
    let base_url_for_regen = base_url.clone();
    app.on_regenerate_invite(move || {
        if let Some(app) = app_weak_regen.upgrade() {
            let host_address = host_addr_for_regen.lock().unwrap().clone();
            if host_address.is_empty() {
                return;
            }
            let mut session_id = [0u8; 16];
            rand::thread_rng().fill_bytes(&mut session_id);
            let mut invite_secret = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut invite_secret);

            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs();

            let invitation = InvitationV1::new(host_address, session_id, invite_secret, now, 600);
            let invite_url = invitation.to_qr_url(&base_url_for_regen).unwrap_or_default();
            let session_token = invitation.to_base64url().unwrap_or_default();

            if let Ok(qr) = generate_qr_rgba(&invite_url, 236) {
                let _ = image::save_buffer_with_format(
                    "qr_code.png",
                    &qr.rgba_pixels,
                    qr.width,
                    qr.height,
                    image::ColorType::Rgba8,
                    image::ImageFormat::Png,
                );

                let mut pixel_buffer = SharedPixelBuffer::new(qr.width, qr.height);
                pixel_buffer.make_mut_bytes().copy_from_slice(&qr.rgba_pixels);

                let slint_qr_img = Image::from_rgba8(pixel_buffer);
                app.set_qr_code_image(slint_qr_img);
                app.set_has_qr_image(true);
                app.set_invite_url(invite_url.into());
                app.set_expires_secs(600);
                let display_sess = if session_token.len() >= 12 {
                    format!("{}...", &session_token[..12])
                } else {
                    session_token
                };
                app.set_session_info(display_sess.into());
                let is_ja = app.get_current_language() == "ja";
                app.set_status_text(I18n::qr_regenerated(is_ja).into());
            }
        }
    });

    // Disconnect Handler
    let app_weak_disc = app_weak.clone();
    let target_addr_disc = target_peer_addr.clone();
    app.on_disconnect(move || {
        if let Some(app) = app_weak_disc.upgrade() {
            if let Ok(mut guard) = target_addr_disc.lock() {
                *guard = None;
            }
            let is_ja = app.get_current_language() == "ja";
            app.set_screen_index(1);
            app.set_peer_name(I18n::waiting_for_peer(is_ja).into());
            app.set_status_text(I18n::disconnected(is_ja).into());
            app.set_is_transferring(false);
            app.set_transfer_completed(false);
            app.set_is_sender_transfer(false);
            app.set_saved_file_path("".into());
            app.set_path_copied_feedback(false);
        }
    });

    // Join Session Handler (Manual Connect to Peer ConnBlob)
    let app_weak_join = app_weak.clone();
    let target_addr_join = target_peer_addr.clone();
    let ipc_tx_join = ipc_tx_clone.clone();
    let host_addr_join = host_addr_shared.clone();
    app.on_join_session(move |input_text| {
        let text = input_text.to_string();
        if !text.is_empty() {
            let addr = parse_tailcat_address(&text);
            if let Ok(mut guard) = target_addr_join.lock() {
                *guard = Some(addr.clone());
            }
            let is_derp = addr.contains("derp");
            if let Some(app) = app_weak_join.upgrade() {
                let is_ja = app.get_current_language() == "ja";
                app.set_screen_index(3);
                app.set_peer_name(I18n::connected_peer(is_ja).into());
                app.set_status_text(I18n::direct_connected(is_ja).into());
                app.set_is_derp_relay(is_derp);
                app.set_transport_type(if is_derp { 2 } else { 0 });
            }
            // Send test handshake ping over Tailcat (includes JOIN: for peer address learning)
            let host_addr = host_addr_join.lock().unwrap().clone();
            let _ = ipc_tx_join.send(DaemonCommand {
                action: "send_text".to_string(),
                address: Some(addr),
                port: Some(101),
                handle: None,
                text: Some(format!(
                    "🤝 [Connected] Ponlet connected via Tailcat WireGuard Mesh! JOIN:{}",
                    host_addr
                )),
                filename: None,
                path: None,
            });
        }
    });

    // Paste & Join Handler (Read Invitation from Clipboard and Connect)
    let app_weak_paste_join = app_weak.clone();
    let target_addr_paste_join = target_peer_addr.clone();
    let ipc_tx_paste_join = ipc_tx_clone.clone();
    let host_addr_paste_join = host_addr_shared.clone();
    app.on_paste_and_join(move || {
        if let Some(app) = app_weak_paste_join.upgrade() {
            if let Ok(mut clipboard) = Clipboard::new() {
                if let Ok(text) = clipboard.get_text() {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        app.set_join_input_text(trimmed.into());
                        let addr = parse_tailcat_address(trimmed);
                        let is_derp = addr.contains("derp");
                        if let Ok(mut guard) = target_addr_paste_join.lock() {
                            *guard = Some(addr.clone());
                        }
                        let is_ja = app.get_current_language() == "ja";
                        app.set_screen_index(3);
                        app.set_peer_name(I18n::connected_peer(is_ja).into());
                        app.set_status_text(I18n::direct_connected(is_ja).into());
                        app.set_is_derp_relay(is_derp);
                        app.set_transport_type(if is_derp { 2 } else { 0 });

                        let host_addr = host_addr_paste_join.lock().unwrap().clone();
                        let _ = ipc_tx_paste_join.send(DaemonCommand {
                            action: "send_text".to_string(),
                            address: Some(addr),
                            port: Some(101),
                            handle: None,
                            text: Some(format!(
                                "🤝 [Connected] Ponlet connected via Tailcat WireGuard Mesh! JOIN:{}",
                                host_addr
                            )),
                            filename: None,
                            path: None,
                        });
                    }
                }
            }
        }
    });

    // QR Camera Scan Handler (Desktop guidance)
    let app_weak_cam = app_weak.clone();
    app.on_scan_qr_camera(move || {
        if let Some(app) = app_weak_cam.upgrade() {
            let is_ja = app.get_current_language() == "ja";
            app.set_status_text(I18n::camera_unsupported(is_ja).into());
        }
    });

    // Compose Text Message Handler (Direct P2P via Tailcat Port 101)
    let app_weak_text = app_weak.clone();
    let ipc_tx_text = ipc_tx_clone.clone();
    let target_addr_text = target_peer_addr.clone();
    app.on_compose_text(move |msg| {
        if let Some(app) = app_weak_text.upgrade() {
            let sanitized_str = sanitize_ime_input(&msg.to_string());
            let trimmed = sanitized_str.trim();
            if trimmed.is_empty() {
                return;
            }

            let is_ja = app.get_current_language() == "ja";
            let has_target = if let Ok(guard) = target_addr_text.lock() {
                guard.is_some()
            } else {
                false
            };

            if !has_target {
                app.set_status_text(I18n::peer_not_connected(is_ja).into());
                return;
            }

            // Zero-latency Optimistic UI update
            let me_label = I18n::label_me(is_ja);
            let log_text = format!("{}: {}\n{}", me_label, trimmed, app.get_received_message_log());
            app.set_received_message_log(log_text.into());
            app.set_message_input("".into());
            app.set_status_text(if is_ja { "送信中…" } else { "Sending…" }.into());

            if let Ok(guard) = target_addr_text.lock() {
                if let Some(target) = guard.as_ref() {
                    info!("Sending Tailcat P2P message to {}: {}", target, trimmed);
                    let _ = ipc_tx_text.send(DaemonCommand {
                        action: "send_text".to_string(),
                        address: Some(target.clone()),
                        port: Some(101),
                        handle: None,
                        text: Some(trimmed.to_string()),
                        filename: None,
                        path: None,
                    });
                    tailsend_telemetry::events::text_message_sent(
                        tailsend_telemetry::length_bucket(trimmed.chars().count()),
                    );
                }
            }
        }
    });

    // Clear Chat Log Callback
    let app_weak_clear_log = app_weak.clone();
    app.on_clear_chat_log(move || {
        if let Some(app) = app_weak_clear_log.upgrade() {
            let is_ja = app.get_current_language() == "ja";
            app.set_received_message_log("".into());
            app.set_status_text(if is_ja { "チャットログをクリアしました" } else { "Chat log cleared" }.into());
        }
    });

    // Open Text Composer Callback
    app.on_open_text_composer(move || {});

    // Paste & Send Callback
    let app_weak_paste_send = app_weak.clone();
    app.on_paste_and_send(move || {
        if let Some(app) = app_weak_paste_send.upgrade() {
            if let Ok(mut clipboard) = Clipboard::new() {
                if let Ok(text) = clipboard.get_text() {
                    let sanitized = sanitize_ime_input(&text);
                    app.set_message_input(sanitized.into());
                }
            }
        }
    });

    // Pick File Handler (Direct P2P via Tailcat Port 102)
    let app_weak_pick = app_weak.clone();
    let ipc_tx_file = ipc_tx_clone.clone();
    let target_addr_file = target_peer_addr.clone();
    let transfer_started_at_send = transfer_started_at.clone();
    app.on_pick_files(move || {
        if let Some(path) = rfd::FileDialog::new().pick_file() {
            let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let path_str = path.to_string_lossy().to_string();

            if let Some(app) = app_weak_pick.upgrade() {
                let is_ja = app.get_current_language() == "ja";
                let has_target = if let Ok(guard) = target_addr_file.lock() {
                    guard.is_some()
                } else {
                    false
                };

                if !has_target {
                    app.set_status_text(I18n::peer_not_connected(is_ja).into());
                    return;
                }

                app.set_is_transferring(true);
                app.set_transfer_completed(false);
                app.set_is_sender_transfer(true);
                app.set_transfer_filename(file_name.clone().into());
                app.set_transfer_status(I18n::file_sending(is_ja).into());
                app.set_transfer_progress(0.1);

                if let Ok(guard) = target_addr_file.lock() {
                    if let Some(target) = guard.as_ref() {
                        let _ = ipc_tx_file.send(DaemonCommand {
                            action: "send_file".to_string(),
                            address: Some(target.clone()),
                            port: Some(102),
                            handle: None,
                            text: None,
                            filename: Some(file_name),
                            path: Some(path_str),
                        });
                        tailsend_telemetry::events::transfer_started(
                            1,
                            if target.contains("derp") { "relay" } else { "direct" },
                            "send",
                        );
                        if let Ok(mut guard) = transfer_started_at_send.lock() {
                            *guard = Some(Instant::now());
                        }
                    }
                }
            }
        }
    });

    // Cancel Transfer Callback
    let app_weak_cancel = app_weak.clone();
    let ipc_tx_cancel = ipc_tx_clone.clone();
    app.on_cancel_transfer(move || {
        if let Some(app) = app_weak_cancel.upgrade() {
            let is_ja = app.get_current_language() == "ja";
            app.set_is_transferring(false);
            app.set_transfer_completed(false);
            app.set_saved_file_path("".into());
            app.set_path_copied_feedback(false);
            app.set_transfer_progress(0.0);
            app.set_transfer_status(I18n::transfer_cancelled(is_ja).into());
            let _ = ipc_tx_cancel.send(DaemonCommand {
                action: "cancel_transfer".to_string(),
                address: None,
                port: None,
                handle: None,
                text: None,
                filename: None,
                path: None,
            });
        }
    });

    app.on_share_received_text(move || {
        let download_dir = get_download_dir();
        #[cfg(target_os = "windows")]
        let _ = std::process::Command::new("explorer").arg(&download_dir).spawn();
        #[cfg(target_os = "macos")]
        let _ = std::process::Command::new("open").arg(&download_dir).spawn();
        #[cfg(target_os = "linux")]
        let _ = std::process::Command::new("xdg-open").arg(&download_dir).spawn();
    });

    // Save Text as File (Fall back to activity log if last received is empty)
    let app_weak_save = app_weak.clone();
    app.on_save_received_text(move || {
        if let Some(app) = app_weak_save.upgrade() {
            let mut text = app.get_last_received_text().to_string();
            if text.is_empty() {
                text = app.get_received_message_log().to_string();
            }
            if !text.is_empty() {
                let download_dir = get_download_dir();
                let _ = std::fs::create_dir_all(&download_dir);
                let now_str = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
                let txt_path = download_dir.join(format!("received_text_{}.txt", now_str));
                let _ = std::fs::write(&txt_path, text);
                let is_ja = app.get_current_language() == "ja";
                app.set_status_text(I18n::text_saved(is_ja, &txt_path.display().to_string()).into());
            }
        }
    });

    // Copy Received Text to Clipboard (Fall back to activity log if last received is empty)
    let app_weak_copy_text = app_weak.clone();
    app.on_copy_received_text(move || {
        if let Some(app) = app_weak_copy_text.upgrade() {
            let mut text = app.get_last_received_text().to_string();
            if text.is_empty() {
                text = app.get_received_message_log().to_string();
            }
            if !text.is_empty() {
                if let Ok(mut clipboard) = Clipboard::new() {
                    let _ = clipboard.set_text(&text);
                    let is_ja = app.get_current_language() == "ja";
                    app.set_status_text(I18n::text_copied(is_ja).into());
                    app.set_text_copied_feedback(true);
                    let w_timer = app_weak_copy_text.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w_timer.upgrade() {
                                app.set_text_copied_feedback(false);
                            }
                        });
                    });
                }
            }
        }
    });

    // Copy Saved File Path to Clipboard
    let app_weak_copy_path = app_weak.clone();
    app.on_copy_file_path(move || {
        if let Some(app) = app_weak_copy_path.upgrade() {
            let path = app.get_saved_file_path().to_string();
            if !path.is_empty() {
                if let Ok(mut clipboard) = Clipboard::new() {
                    let _ = clipboard.set_text(&path);
                    let is_ja = app.get_current_language() == "ja";
                    app.set_status_text(I18n::path_copied(is_ja).into());
                    app.set_path_copied_feedback(true);
                    let w_timer = app_weak_copy_path.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w_timer.upgrade() {
                                app.set_path_copied_feedback(false);
                            }
                        });
                    });
                }
            }
        }
    });

    // Open External Links (Privacy Policy / OSS Licenses) in the default browser
    app.on_open_url(move |url| {
        #[cfg(target_os = "windows")]
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url.as_str()])
            .spawn();
        #[cfg(target_os = "macos")]
        let _ = std::process::Command::new("open").arg(url.as_str()).spawn();
        #[cfg(target_os = "linux")]
        let _ = std::process::Command::new("xdg-open").arg(url.as_str()).spawn();
    });

    // Active Countdown Timer for QR Expiration
    let _countdown_timer = slint::Timer::default();
    let app_weak_countdown = app_weak.clone();
    _countdown_timer.start(slint::TimerMode::Repeated, std::time::Duration::from_secs(1), move || {
        if let Some(app) = app_weak_countdown.upgrade() {
            if app.get_screen_index() == 1 {
                let cur = app.get_expires_secs();
                if cur > 0 {
                    app.set_expires_secs(cur - 1);
                } else {
                    let is_ja = app.get_current_language() == "ja";
                    app.set_status_text(I18n::invite_expired(is_ja).into());
                }
            }
        }
    });

    app.show()?;
    slint::run_event_loop()?;

    // Best-effort session end event (not sent on SIGKILL)
    tailsend_telemetry::events::app_end(started_at.elapsed().as_millis());
    Ok(())
}

fn parse_tailcat_address(input: &str) -> String {
    let trimmed = input.trim();
    if let Some(pos) = trimmed.find("#i=") {
        let after = &trimmed[pos + 3..];
        let token = after.split('&').next().unwrap_or(after);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        if let Ok(inv) = InvitationV1::from_base64url(token, now) {
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

/// Sanitizes text to remove premature IME commitment glitches (e.g., "aあ" -> "あ", "kこんにちは" -> "こんにちは").
pub fn sanitize_ime_input(input: &str) -> String {
    let trimmed = input.trim_start();
    let chars: Vec<char> = trimmed.chars().collect();
    let is_kana = |c: char| matches!(c, '\u{3040}'..='\u{309F}' | '\u{30A0}'..='\u{30FF}');

    // 1-letter premature leak before Japanese kana (e.g. "aあ", "kか")
    if chars.len() >= 2 && chars[0].is_ascii_alphabetic() && is_kana(chars[1]) {
        let is_vowel = matches!(
            (chars[0].to_ascii_lowercase(), chars[1]),
            ('a', 'あ' | 'ア')
                | ('i', 'い' | 'イ')
                | ('u', 'う' | 'ウ')
                | ('e', 'え' | 'エ')
                | ('o', 'お' | 'オ')
        );
        if is_vowel || chars[0].is_ascii_lowercase() {
            let leading_ws: String = input.chars().take_while(|c| c.is_whitespace()).collect();
            let sanitized: String = chars[1..].iter().collect();
            return format!("{}{}", leading_ws, sanitized);
        }
    }

    // 2-letter premature leak before Japanese kana (e.g. "kaか")
    if chars.len() >= 3 && chars[0].is_ascii_lowercase() && chars[1].is_ascii_lowercase() && is_kana(chars[2]) {
        let leading_ws: String = input.chars().take_while(|c| c.is_whitespace()).collect();
        let sanitized: String = chars[2..].iter().collect();
        return format!("{}{}", leading_ws, sanitized);
    }

    input.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_ime_glitches() {
        assert_eq!(sanitize_ime_input("aあ"), "あ");
        assert_eq!(sanitize_ime_input("aありがとう"), "ありがとう");
        assert_eq!(sanitize_ime_input("aア"), "ア");
        assert_eq!(sanitize_ime_input("iい"), "い");
        assert_eq!(sanitize_ime_input("uう"), "う");
        assert_eq!(sanitize_ime_input("eえ"), "え");
        assert_eq!(sanitize_ime_input("oお"), "お");
        assert_eq!(sanitize_ime_input("kこんにちは"), "こんにちは");
        assert_eq!(sanitize_ime_input("sすごい"), "すごい");
        assert_eq!(sanitize_ime_input("tテスト"), "テスト");
        assert_eq!(sanitize_ime_input("kaかんしゃ"), "かんしゃ");
    }

    #[test]
    fn test_sanitize_ime_preserves_valid_english_and_names() {
        assert_eq!(sanitize_ime_input("iPhone"), "iPhone");
        assert_eq!(sanitize_ime_input("AI技術"), "AI技術");
        assert_eq!(sanitize_ime_input("PCで作業"), "PCで作業");
        assert_eq!(sanitize_ime_input("Hello World"), "Hello World");
        assert_eq!(sanitize_ime_input("こんにちは"), "こんにちは");
        assert_eq!(sanitize_ime_input("123"), "123");
        assert_eq!(sanitize_ime_input(""), "");
    }
}
