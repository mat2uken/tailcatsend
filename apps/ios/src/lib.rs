use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use base64::prelude::*;
use futures::{SinkExt, StreamExt};
use log::{error, info};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use slint::{Image, SharedPixelBuffer};
use tailsend_protocol::invitation::InvitationV1;
use tailsend_qr::generate_qr_rgba;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

slint::include_modules!();

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
    filename: String,
    total_bytes: usize,
    received_bytes: usize,
    start_time: Instant,
    data: Vec<u8>,
}

#[allow(dead_code)]
const CHUNK_SIZE: usize = 64 * 1024; // 64 KiB chunks

#[no_mangle]
pub extern "C" fn tailsend_ios_main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    info!("Starting TailSend iOS Native Application on Main Thread...");

    if let Err(e) = run_ios_app() {
        error!("TailSend iOS run error: {:?}", e);
    }
}

fn generate_invitation_data(base_url: &str) -> (InvitationV1, String, String, SharedPixelBuffer<slint::Rgba8Pixel>) {
    let mut session_id = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut session_id);
    let mut invite_secret = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut invite_secret);

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let host_address = "tc-ios-native-wireguard-mesh".to_string();
    let invitation = InvitationV1::new(host_address, session_id, invite_secret, now, 600);
    let invite_url = invitation.to_qr_url(base_url).unwrap_or_default();
    let session_token = invitation.to_base64url().unwrap_or_default();
    let short_session_id = if session_token.len() >= 32 { session_token[..32].to_string() } else { session_token };

    let qr = generate_qr_rgba(&invite_url, 236).unwrap();
    let mut pixel_buffer = SharedPixelBuffer::new(qr.width, qr.height);
    pixel_buffer.make_mut_bytes().copy_from_slice(&qr.rgba_pixels);

    (invitation, invite_url, short_session_id, pixel_buffer)
}

fn run_ios_app() -> Result<(), Box<dyn std::error::Error>> {
    let base_url = "https://tailsend-poc.mat2uken.workers.dev".to_string();
    
    // Create Slint AppWindow on Main Thread
    let app = AppWindow::new()?;
    app.set_top_safe_area(44.0);
    let incoming_files: Arc<Mutex<HashMap<String, IncomingFileState>>> = Arc::new(Mutex::new(HashMap::new()));

    // Channel for outgoing relay messages
    let (relay_tx, relay_rx) = mpsc::unbounded_channel::<String>();
    let relay_tx_shared = Arc::new(Mutex::new(relay_tx));
    let relay_rx_shared = Arc::new(Mutex::new(Some(relay_rx)));

    // Channel to trigger QR regeneration
    let (regen_tx, mut regen_rx) = mpsc::unbounded_channel::<()>();

    let app_weak_boot = app.as_weak();
    let base_url_clone = base_url.clone();
    let incoming_files_clone = incoming_files.clone();
    let relay_rx_clone = relay_rx_shared.clone();

    // Start background Tokio Runtime for networking and session handling
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("Failed to create background Tokio runtime for iOS");

        rt.block_on(async move {
            let mut current_abort_handle: Option<tokio::task::AbortHandle> = None;

            loop {
                // 1. Generate new invitation and QR
                let (_invitation, invite_url, short_session_id, pixel_buffer) = generate_invitation_data(&base_url_clone);
                info!("Generated iOS QR Invitation URL: {}", invite_url);

                let invite_url_copy = invite_url.clone();
                let short_sess_copy = short_session_id.clone();
                let app_weak_clone = app_weak_boot.clone();

                let _ = slint::invoke_from_event_loop(move || {
                    if let Some(app) = app_weak_clone.upgrade() {
                        let slint_qr_img = Image::from_rgba8(pixel_buffer);
                        app.set_qr_code_image(slint_qr_img);
                        app.set_has_qr_image(true);
                        app.set_invite_url(invite_url_copy.into());
                        app.set_screen_index(1);
                        app.set_status_text("Scan QR Code with Mac or Phone".into());
                        app.set_expires_secs(600);
                        app.set_can_disconnect(true);
                        app.set_can_send(true);
                        app.set_peer_name("Peer Device".into());
                        app.set_derp_info("tailcat.dev (Active Mesh)".into());
                        app.set_edge_relay_info("Cloudflare Workers (DO)".into());
                        let display_sess = if short_sess_copy.len() >= 12 {
                            format!("{}...", &short_sess_copy[..12])
                        } else {
                            short_sess_copy.clone()
                        };
                        app.set_session_info(display_sess.into());
                    }
                });

                // Abort previous WebSocket session if running
                if let Some(handle) = current_abort_handle.take() {
                    handle.abort();
                }

                // 2. Connect to Cloudflare Edge Relay
                let short_sess_for_relay = short_session_id.clone();
                let relay_ws_url = format!(
                    "wss://tailsend-poc.mat2uken.workers.dev/relay?session={}&role=host",
                    urlencoding_encode(&short_session_id)
                );

                info!("Connecting iOS Host to Edge Relay: {}", relay_ws_url);
                let app_weak_relay = app_weak_boot.clone();
                let inc_files = incoming_files_clone.clone();
                let r_rx_shared = relay_rx_clone.clone();

                let session_task = tokio::spawn(async move {
                    match connect_async(&relay_ws_url).await {
                        Ok((ws_stream, _)) => {
                            info!("iOS Host successfully connected to Edge Relay!");
                            let (mut ws_sender, mut ws_receiver) = ws_stream.split();

                            // Sender task
                            let mut rx_guard = r_rx_shared.lock().await;
                            if let Some(mut rx) = rx_guard.take() {
                                tokio::spawn(async move {
                                    while let Some(msg) = rx.recv().await {
                                        if let Err(e) = ws_sender.send(Message::Text(msg.into())).await {
                                            error!("Failed to send relay ws message from iOS: {}", e);
                                            break;
                                        }
                                    }
                                });
                            }

                            // Receiver loop
                            while let Some(msg_res) = ws_receiver.next().await {
                                if let Ok(Message::Text(text)) = msg_res {
                                    if let Ok(payload) = serde_json::from_str::<RelayPayload>(&text) {
                                        match payload.msg_type.as_str() {
                                            "text" => {
                                                if let Some(incoming_text) = payload.text {
                                                    let w = app_weak_relay.clone();
                                                    let inc_t = incoming_text.clone();
                                                    let s_id = short_sess_for_relay.clone();
                                                    let _ = slint::invoke_from_event_loop(move || {
                                                        if let Some(app) = w.upgrade() {
                                                            app.set_screen_index(3);
                                                            app.set_peer_name("Connected Peer".into());
                                                            app.set_derp_info("tailcat.dev (Active Mesh)".into());
                                                            app.set_edge_relay_info("Cloudflare Workers (DO)".into());
                                                            let display_sess = if s_id.len() >= 12 {
                                                                format!("{}...", &s_id[..12])
                                                            } else {
                                                                s_id.clone()
                                                            };
                                                            app.set_session_info(display_sess.into());
                                                            let new_log = format!("[Peer]: {}\n{}", inc_t, app.get_received_message_log());
                                                            app.set_received_message_log(new_log.into());
                                                            app.set_last_received_text(inc_t.into());
                                                            app.set_status_text("Received message from Peer!".into());
                                                        }
                                                    });
                                                }
                                            }
                                            "file_start" => {
                                                let file_id = payload.file_id.unwrap_or_default();
                                                let filename = payload.filename.unwrap_or_else(|| "received_file.bin".to_string());
                                                let total_bytes = payload.total_bytes.unwrap_or(0);

                                                let mut map = inc_files.lock().await;
                                                map.insert(file_id.clone(), IncomingFileState {
                                                    filename: filename.clone(),
                                                    total_bytes,
                                                    received_bytes: 0,
                                                    start_time: Instant::now(),
                                                    data: Vec::with_capacity(total_bytes),
                                                });

                                                let w = app_weak_relay.clone();
                                                let fn_clone = filename.clone();
                                                let s_id_f = short_sess_for_relay.clone();
                                                let _ = slint::invoke_from_event_loop(move || {
                                                    if let Some(app) = w.upgrade() {
                                                        app.set_screen_index(3);
                                                        app.set_peer_name("Connected Peer".into());
                                                        app.set_derp_info("tailcat.dev (Active Mesh)".into());
                                                        app.set_edge_relay_info("Cloudflare Workers (DO)".into());
                                                        let display_sess = if s_id_f.len() >= 12 {
                                                            format!("{}...", &s_id_f[..12])
                                                        } else {
                                                            s_id_f.clone()
                                                        };
                                                        app.set_session_info(display_sess.into());
                                                        app.set_is_transferring(true);
                                                        app.set_transfer_completed(false);
                                                        app.set_transfer_status("Receiving from Peer...".into());
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
                                                        let mut map = inc_files.lock().await;
                                                        if let Some(state) = map.get_mut(&file_id) {
                                                            state.data.extend_from_slice(&bytes);
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
                                                let mut map = inc_files.lock().await;
                                                if let Some(state) = map.remove(&file_id) {
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
                                                                "[File Received]: {} ({:.1} MB)\n{}",
                                                                fn_clone, size_mb, app.get_received_message_log()
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
                            error!("Failed to connect iOS host to Edge Relay: {}", e);
                        }
                    }
                });

                current_abort_handle = Some(session_task.abort_handle());

                // 3. Countdown timer loop (interruptible by regen signal)
                let app_weak_timer = app_weak_boot.clone();
                let mut expired = false;
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
                            info!("Regeneration signal received, creating new session...");
                            expired = true;
                            break;
                        }
                    }
                }

                if !expired {
                    let w = app_weak_boot.clone();
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(app) = w.upgrade() {
                            app.set_status_text("Invitation expired. Tap Regenerate to create a new QR code.".into());
                        }
                    });
                    // Wait for manual regeneration
                    let _ = regen_rx.recv().await;
                }
            }
        });
    });

    // Regenerate Invite Callback
    let regen_tx_clone = regen_tx.clone();
    let app_weak_regen = app.as_weak();
    app.on_regenerate_invite(move || {
        info!("Regenerate QR Code button tapped on iOS!");
        if let Some(app) = app_weak_regen.upgrade() {
            app.set_status_text("Regenerating new QR code...".into());
        }
        let _ = regen_tx_clone.send(());
    });

    // Copy Invite URL Callback
    let app_weak_copy = app.as_weak();
    app.on_copy_invite(move || {
        if let Some(app) = app_weak_copy.upgrade() {
            let copy_url = app.get_invite_url().to_string();
            app.set_status_text("Invite URL ready!".into());
            info!("Invite URL copied: {}", copy_url);
        }
    });

    // Disconnect Callback
    let app_weak_disc = app.as_weak();
    let regen_tx_disc = regen_tx.clone();
    app.on_disconnect(move || {
        if let Some(app) = app_weak_disc.upgrade() {
            app.set_screen_index(1);
            app.set_status_text("Disconnected. Generating new QR code...".into());
        }
        let _ = regen_tx_disc.send(());
    });

    // Compose Text Message Handler
    let app_weak_text = app.as_weak();
    let relay_tx_text = relay_tx_shared.clone();
    app.on_compose_text(move |msg| {
        if let Some(app) = app_weak_text.upgrade() {
            let log_text = format!("Sent: {}\n{}", msg, app.get_received_message_log());
            app.set_received_message_log(log_text.into());

            let payload = serde_json::json!({
                "type": "text",
                "channel": 101,
                "text": msg.as_str(),
                "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
            });
            let tx = relay_tx_text.clone();
            tokio::spawn(async move {
                let guard = tx.lock().await;
                let _ = guard.send(payload.to_string());
            });
        }
    });

    // Copy Received Text Callback
    let app_weak_copy_text = app.as_weak();
    app.on_copy_received_text(move || {
        if let Some(app) = app_weak_copy_text.upgrade() {
            let text = app.get_last_received_text().to_string();
            if !text.is_empty() {
                app.set_status_text("Text copied!".into());
            }
        }
    });

    app.show()?;
    slint::run_event_loop()?;
    Ok(())
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
