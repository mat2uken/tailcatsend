use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use arboard::Clipboard;
use base64::prelude::*;
use futures::{SinkExt, StreamExt};
use log::{error, info};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use slint::{Image, SharedPixelBuffer};
use tailsend_protocol::invitation::InvitationV1;
use tailsend_qr::generate_qr_rgba;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

slint::include_modules!();

#[derive(Debug, Serialize, Deserialize)]
struct DaemonEvent {
    event: String,
    address: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct RelayPayload {
    #[serde(rename = "type")]
    msg_type: String,
    channel: Option<u16>,
    text: Option<String>,
    #[serde(rename = "fileId")]
    file_id: Option<String>,
    filename: Option<String>,
    #[serde(rename = "totalBytes")]
    total_bytes: Option<usize>,
    #[serde(rename = "totalChunks")]
    total_chunks: Option<usize>,
    #[serde(rename = "chunkIndex")]
    chunk_index: Option<usize>,
    data: Option<String>,
    timestamp: Option<u64>,
}

struct IncomingFileState {
    file_path: PathBuf,
    filename: String,
    file_handle: File,
    total_bytes: usize,
    received_bytes: usize,
    start_time: Instant,
}

const CHUNK_SIZE: usize = 64 * 1024; // 64 KiB chunks

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    env_logger::init();
    info!("Starting TailSend Desktop Native Application...");

    let args: Vec<String> = std::env::args().collect();
    let base_url = if args.len() > 1 {
        args[1].clone()
    } else {
        "https://tailsend-poc.mat2uken.workers.dev".to_string()
    };

    info!("Using Cloudflare Hosting Base URL: {}", base_url);

    let app = AppWindow::new()?;
    let (relay_tx, mut relay_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let incoming_files: Arc<Mutex<HashMap<String, IncomingFileState>>> = Arc::new(Mutex::new(HashMap::new()));

    // Spawn native Tailcat Go engine daemon and generate QR code asynchronously
    let app_weak_boot = app.as_weak();
    let base_url_clone = base_url.clone();

    tokio::spawn(async move {
        let mut session_id = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut session_id);
        let mut invite_secret = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut invite_secret);

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let daemon_bin_name = if cfg!(windows) {
            "tailcat_daemon.exe"
        } else {
            "tailcat_daemon"
        };

        let daemon_path = if std::path::Path::new(&format!("target/debug/{}", daemon_bin_name)).exists() {
            format!("target/debug/{}", daemon_bin_name)
        } else if std::path::Path::new(&format!("target/release/{}", daemon_bin_name)).exists() {
            format!("target/release/{}", daemon_bin_name)
        } else if std::path::Path::new(daemon_bin_name).exists() {
            daemon_bin_name.to_string()
        } else {
            daemon_bin_name.to_string()
        };

        info!("Spawning Tailcat daemon from path: {}", daemon_path);

        let mut child = Command::new(&daemon_path)
            .arg("-derp=https://tailcat.dev/derpmap.json")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap_or_else(|e| panic!("Failed to spawn Tailcat native daemon at {}: {}", daemon_path, e));

        let stdout = child.stdout.take().expect("Failed to get stdout of daemon");
        let mut reader = BufReader::new(stdout).lines();

        let mut real_host_address = String::new();
        while let Ok(Some(line)) = reader.next_line().await {
            info!("[tailcat-daemon] {}", line);
            if let Ok(ev) = serde_json::from_str::<DaemonEvent>(&line) {
                if ev.event == "ready" {
                    if let Some(addr) = ev.address {
                        real_host_address = addr;
                        break;
                    }
                }
            }
        }

        if real_host_address.is_empty() {
            real_host_address = "tc-fallback-ephemeral-address".to_string();
        }

        info!("Acquired Real Tailcat ConnBlob Address: {}", real_host_address);

        // Generate TailSend Invitation with Real Tailcat Address & Cloudflare URL
        let invitation = InvitationV1::new(real_host_address.clone(), session_id, invite_secret, now, 600);
        let invite_url = invitation.to_qr_url(&base_url_clone).unwrap_or_default();
        let session_token = invitation.to_base64url().unwrap_or_default();
        let short_session_id = if session_token.len() >= 32 { &session_token[..32] } else { &session_token };

        info!("Generated Cloudflare QR Invitation URL: {}", invite_url);

        // Generate High-DPI QR Code RGBA Buffer
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

            let invite_url_copy = invite_url.clone();
            let app_weak_clone = app_weak_boot.clone();
            let _ = slint::invoke_from_event_loop(move || {
                if let Some(app) = app_weak_clone.upgrade() {
                    let slint_qr_img = Image::from_rgba8(pixel_buffer);
                    app.set_qr_code_image(slint_qr_img);
                    app.set_has_qr_image(true);
                    app.set_invite_url(invite_url_copy.into());
                    app.set_screen_index(1);
                    app.set_status_text("Scan QR Code with Phone Camera".into());
                    app.set_expires_secs(600);
                    app.set_can_disconnect(true);
                    app.set_can_send(true);
                }
            });
        }

        // Connect Desktop Host WebSocket to Edge Relay
        let relay_ws_url = format!(
            "wss://tailsend-poc.mat2uken.workers.dev/relay?session={}&role=host",
            urlencoding_encode(short_session_id)
        );

        info!("Connecting Desktop Host to Edge Relay: {}", relay_ws_url);
        let app_weak_relay = app_weak_boot.clone();
        let incoming_files_clone = incoming_files.clone();

        tokio::spawn(async move {
            match connect_async(&relay_ws_url).await {
                Ok((ws_stream, _)) => {
                    info!("Desktop Host successfully connected to Edge Relay!");
                    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

                    // Forward outgoing messages
                    tokio::spawn(async move {
                        while let Some(msg) = relay_rx.recv().await {
                            if let Err(e) = ws_sender.send(Message::Text(msg.into())).await {
                                error!("Failed to send relay ws message: {}", e);
                                break;
                            }
                        }
                    });

                    // Receive incoming stream from Mobile
                    while let Some(msg_res) = ws_receiver.next().await {
                        if let Ok(Message::Text(text)) = msg_res {
                            if let Ok(payload) = serde_json::from_str::<RelayPayload>(&text) {
                                match payload.msg_type.as_str() {
                                    "text" => {
                                        if let Some(incoming_text) = payload.text {
                                            let w = app_weak_relay.clone();
                                            let inc_t = incoming_text.clone();
                                            let _ = slint::invoke_from_event_loop(move || {
                                                if let Some(app) = w.upgrade() {
                                                    app.set_screen_index(3);
                                                    let new_log = format!("[Mobile]: {}\n{}", inc_t, app.get_received_message_log());
                                                    app.set_received_message_log(new_log.into());
                                                    app.set_last_received_text(inc_t.into());
                                                    app.set_status_text("Received message from Mobile!".into());
                                                }
                                            });
                                        }
                                    }
                                    "file_start" => {
                                        let file_id = payload.file_id.unwrap_or_default();
                                        let filename = payload.filename.unwrap_or_else(|| "received_file.bin".to_string());
                                        let total_bytes = payload.total_bytes.unwrap_or(0);

                                        let download_dir = dirs_next()
                                            .map(|p| p.join("Downloads").join("TailSend"))
                                            .unwrap_or_else(|| PathBuf::from("TailSend_Downloads"));
                                        let _ = std::fs::create_dir_all(&download_dir);
                                        let target_path = download_dir.join(&filename);

                                        if let Ok(file) = OpenOptions::new()
                                            .create(true)
                                            .write(true)
                                            .truncate(true)
                                            .open(&target_path)
                                        {
                                            let mut map = incoming_files_clone.lock().await;
                                            map.insert(file_id.clone(), IncomingFileState {
                                                file_path: target_path,
                                                filename: filename.clone(),
                                                file_handle: file,
                                                total_bytes,
                                                received_bytes: 0,
                                                start_time: Instant::now(),
                                            });
                                        }

                                        let w = app_weak_relay.clone();
                                        let fn_clone = filename.clone();
                                        let _ = slint::invoke_from_event_loop(move || {
                                            if let Some(app) = w.upgrade() {
                                                app.set_screen_index(3);
                                                app.set_is_transferring(true);
                                                app.set_transfer_completed(false);
                                                app.set_transfer_status("Receiving from Mobile...".into());
                                                app.set_transfer_filename(fn_clone.into());
                                                let total_mb = total_bytes as f64 / 1048576.0;
                                                app.set_transfer_bytes_text(format!("0.0 MB / {:.1} MB", total_mb).into());
                                                app.set_transfer_progress(0.0);
                                                app.set_transfer_speed("Starting...".into());
                                            }
                                        });
                                    }
                                    "file_chunk" => {
                                        let file_id = payload.file_id.unwrap_or_default();
                                        if let Some(b64) = payload.data {
                                            if let Ok(bytes) = BASE64_STANDARD.decode(&b64) {
                                                let mut map = incoming_files_clone.lock().await;
                                                if let Some(state) = map.get_mut(&file_id) {
                                                    let _ = state.file_handle.write_all(&bytes);
                                                    state.received_bytes += bytes.len();

                                                    let progress = if state.total_bytes > 0 {
                                                        (state.received_bytes as f32 / state.total_bytes as f32).clamp(0.0, 1.0)
                                                    } else { 0.0 };

                                                    let elapsed = state.start_time.elapsed().as_secs_f64();
                                                    let speed = if elapsed > 0.0 {
                                                        format!("{:.1} MB/s", (state.received_bytes as f64 / 1048576.0) / elapsed)
                                                    } else { "".into() };

                                                    let bytes_text = format!(
                                                        "{:.1} MB / {:.1} MB",
                                                        state.received_bytes as f64 / 1048576.0,
                                                        state.total_bytes as f64 / 1048576.0
                                                    );

                                                    let w = app_weak_relay.clone();
                                                    let fn_clone = state.filename.clone();
                                                    let _ = slint::invoke_from_event_loop(move || {
                                                        if let Some(app) = w.upgrade() {
                                                            app.set_is_transferring(true);
                                                            app.set_transfer_completed(false);
                                                            app.set_transfer_status("Receiving...".into());
                                                            app.set_transfer_filename(fn_clone.into());
                                                            app.set_transfer_bytes_text(bytes_text.into());
                                                            app.set_transfer_progress(progress);
                                                            app.set_transfer_speed(speed.into());
                                                        }
                                                    });
                                                }
                                            }
                                        }
                                    }
                                    "file_complete" => {
                                        let file_id = payload.file_id.unwrap_or_default();
                                        let mut map = incoming_files_clone.lock().await;
                                        if let Some(state) = map.remove(&file_id) {
                                            let path_str = state.file_path.to_string_lossy().to_string();
                                            info!("Chunked file received and saved: {}", path_str);

                                            let w = app_weak_relay.clone();
                                            let fn_clone = state.filename.clone();
                                            let size_mb = state.total_bytes as f64 / 1048576.0;
                                            let _ = slint::invoke_from_event_loop(move || {
                                                if let Some(app) = w.upgrade() {
                                                    app.set_is_transferring(false);
                                                    app.set_transfer_completed(true);
                                                    app.set_transfer_progress(1.0);
                                                    app.set_transfer_status("[Completed] Transfer Successful!".into());
                                                    let new_log = format!(
                                                        "[File Received]: {} ({:.1} MB)\nSaved: {}\n{}",
                                                        fn_clone, size_mb, path_str, app.get_received_message_log()
                                                    );
                                                    app.set_received_message_log(new_log.into());
                                                }
                                            });
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    error!("Failed to connect desktop host to Edge Relay: {}", e);
                }
            }
        });
    });

    // Clipboard Copy Handler
    let app_weak = app.as_weak();
    app.on_copy_invite(move || {
        if let Some(app) = app_weak.upgrade() {
            let copy_url = app.get_invite_url().to_string();
            if let Ok(mut clipboard) = Clipboard::new() {
                let _ = clipboard.set_text(&copy_url);
                app.set_status_text("Invite URL copied to clipboard!".into());
            }
        }
    });

    // Disconnect Handler
    let app_weak = app.as_weak();
    app.on_disconnect(move || {
        if let Some(app) = app_weak.upgrade() {
            app.set_screen_index(1);
            app.set_status_text("Disconnected. Please scan new QR code.".into());
        }
    });

    // Compose Text Message Handler
    let app_weak = app.as_weak();
    let relay_tx_text = relay_tx.clone();
    app.on_compose_text(move |msg| {
        if let Some(app) = app_weak.upgrade() {
            let log_text = format!("Sent: {}\n{}", msg, app.get_received_message_log());
            app.set_received_message_log(log_text.into());

            let payload = serde_json::json!({
                "type": "text",
                "channel": 101,
                "text": msg.as_str(),
                "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
            });
            let _ = relay_tx_text.send(payload.to_string());
        }
    });

    // Paste & Send from Clipboard Handler
    let app_weak = app.as_weak();
    let relay_tx_paste = relay_tx.clone();
    app.on_paste_and_send(move || {
        if let Ok(mut clipboard) = Clipboard::new() {
            if let Ok(text) = clipboard.get_text() {
                if !text.is_empty() {
                    if let Some(app) = app_weak.upgrade() {
                        let log_text = format!("Sent (Clipboard): {}\n{}", text, app.get_received_message_log());
                        app.set_received_message_log(log_text.into());

                        let payload = serde_json::json!({
                            "type": "text",
                            "channel": 101,
                            "text": text,
                            "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
                        });
                        let _ = relay_tx_paste.send(payload.to_string());
                    }
                }
            }
        }
    });

    // Share / Open Downloads Folder (Cross-Platform)
    app.on_share_received_text(move || {
        let download_dir = dirs_next()
            .map(|p| p.join("Downloads").join("TailSend"))
            .unwrap_or_else(|| PathBuf::from("TailSend_Downloads"));
        
        #[cfg(target_os = "windows")]
        let _ = std::process::Command::new("explorer").arg(&download_dir).spawn();
        
        #[cfg(target_os = "macos")]
        let _ = std::process::Command::new("open").arg(&download_dir).spawn();
        
        #[cfg(target_os = "linux")]
        let _ = std::process::Command::new("xdg-open").arg(&download_dir).spawn();
    });

    // Save Received Text as .txt File
    let app_weak_save = app.as_weak();
    app.on_save_received_text(move || {
        if let Some(app) = app_weak_save.upgrade() {
            let text = app.get_last_received_text().to_string();
            if !text.is_empty() {
                let download_dir = dirs_next()
                    .map(|p| p.join("Downloads").join("TailSend"))
                    .unwrap_or_else(|| PathBuf::from("TailSend_Downloads"));
                let _ = std::fs::create_dir_all(&download_dir);
                let now_str = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
                let txt_path = download_dir.join(format!("received_text_{}.txt", now_str));
                let _ = std::fs::write(&txt_path, text);
                app.set_status_text(format!("Text saved to {}", txt_path.display()).into());
            }
        }
    });

    // Copy Received Text to Clipboard
    let app_weak_copy = app.as_weak();
    app.on_copy_received_text(move || {
        if let Some(app) = app_weak_copy.upgrade() {
            let text = app.get_last_received_text().to_string();
            if !text.is_empty() {
                if let Ok(mut clipboard) = Clipboard::new() {
                    let _ = clipboard.set_text(&text);
                    app.set_status_text("Text copied to clipboard!".into());
                }
            }
        }
    });

    // Pick File Handler (PC ➔ Mobile in 64 KiB Chunks!)
    let app_weak = app.as_weak();
    let relay_tx_file = relay_tx.clone();
    app.on_pick_files(move || {
        if let Some(path) = rfd::FileDialog::new().pick_file() {
            let app_weak_send = app_weak.clone();
            let relay_tx_worker = relay_tx_file.clone();

            tokio::spawn(async move {
                let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                if let Ok(bytes) = std::fs::read(&path) {
                    let total_bytes = bytes.len();
                    let total_chunks = (total_bytes + CHUNK_SIZE - 1) / CHUNK_SIZE;
                    let file_id = format!("file-{}", rand::random::<u32>());

                    // Update UI: Transfer Start
                    let w = app_weak_send.clone();
                    let fn_clone = file_name.clone();
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(app) = w.upgrade() {
                            app.set_is_transferring(true);
                            app.set_transfer_completed(false);
                            app.set_transfer_status("Sending to Mobile...".into());
                            app.set_transfer_filename(fn_clone.into());
                            let total_mb = total_bytes as f64 / 1048576.0;
                            app.set_transfer_bytes_text(format!("0.0 MB / {:.1} MB", total_mb).into());
                            app.set_transfer_progress(0.0);
                            app.set_transfer_speed("Starting...".into());
                        }
                    });

                    // 1. Send file_start
                    let start_payload = serde_json::json!({
                        "type": "file_start",
                        "channel": 102,
                        "fileId": file_id,
                        "filename": file_name,
                        "totalBytes": total_bytes,
                        "totalChunks": total_chunks,
                        "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
                    });
                    let _ = relay_tx_worker.send(start_payload.to_string());

                    let start_time = Instant::now();

                    // 2. Send 64 KiB chunks
                    for (chunk_idx, chunk) in bytes.chunks(CHUNK_SIZE).enumerate() {
                        let b64 = BASE64_STANDARD.encode(chunk);
                        let chunk_payload = serde_json::json!({
                            "type": "file_chunk",
                            "channel": 102,
                            "fileId": file_id,
                            "chunkIndex": chunk_idx,
                            "data": b64
                        });
                        let _ = relay_tx_worker.send(chunk_payload.to_string());

                        let sent_bytes = std::cmp::min((chunk_idx + 1) * CHUNK_SIZE, total_bytes);
                        let progress = sent_bytes as f32 / total_bytes as f32;
                        let elapsed = start_time.elapsed().as_secs_f64();
                        let speed = if elapsed > 0.0 {
                            format!("{:.1} MB/s", (sent_bytes as f64 / 1048576.0) / elapsed)
                        } else { "".into() };
                        let bytes_text = format!("{:.1} MB / {:.1} MB", sent_bytes as f64 / 1048576.0, total_bytes as f64 / 1048576.0);

                        let w = app_weak_send.clone();
                        let fn_c = file_name.clone();
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w.upgrade() {
                                app.set_is_transferring(true);
                                app.set_transfer_completed(false);
                                app.set_transfer_status("Sending...".into());
                                app.set_transfer_filename(fn_c.into());
                                app.set_transfer_bytes_text(bytes_text.into());
                                app.set_transfer_progress(progress);
                                app.set_transfer_speed(speed.into());
                            }
                        });

                        if chunk_idx % 8 == 0 {
                            tokio::time::sleep(tokio::time::Duration::from_millis(1)).await;
                        }
                    }

                    // 3. Send file_complete
                    let complete_payload = serde_json::json!({
                        "type": "file_complete",
                        "channel": 102,
                        "fileId": file_id
                    });
                    let _ = relay_tx_worker.send(complete_payload.to_string());

                    // Update UI: Done
                    let w = app_weak_send.clone();
                    let fn_c = file_name.clone();
                    let size_mb = total_bytes as f64 / 1048576.0;
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(app) = w.upgrade() {
                            app.set_is_transferring(false);
                            app.set_transfer_completed(true);
                            app.set_transfer_progress(1.0);
                            app.set_transfer_status("[Completed] Transfer Successful!".into());
                            let new_log = format!(
                                "[Sent to Mobile]: {} ({:.1} MB)\n{}",
                                fn_c, size_mb, app.get_received_message_log()
                            );
                            app.set_received_message_log(new_log.into());
                        }
                    });
                }
            });
        }
    });

    // Countdown Timer in Background
    let app_weak_timer = app.as_weak();
    tokio::spawn(async move {
        for s in (0..=600).rev() {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            let w = app_weak_timer.clone();
            let _ = slint::invoke_from_event_loop(move || {
                if let Some(app) = w.upgrade() {
                    app.set_expires_secs(s);
                    if s == 0 {
                        app.set_status_text("Invitation expired. Please regenerate.".into());
                    }
                }
            });
        }
    });

    // Run Slint Event Loop on Main Thread
    slint::run_event_loop()?;
    Ok(())
}

fn dirs_next() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}
