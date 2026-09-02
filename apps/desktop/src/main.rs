use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use arboard::Clipboard;
use log::info;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use slint::{Image, SharedPixelBuffer};
use tailsend_protocol::invitation::InvitationV1;
use tailsend_qr::generate_qr_rgba;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::mpsc;

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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    info!("Starting TailSend Desktop Native Application (Pure Tailcat P2P)...");
    println!("\n🚀 TailSend Desktop Native App is starting (Pure Tailcat WireGuard/DERP Mesh)...");

    let args: Vec<String> = std::env::args().collect();
    let base_url = if args.len() > 1 {
        args[1].clone()
    } else {
        std::env::var("TAILSEND_WEB_URL").unwrap_or_else(|_| "https://tailsend.pages.dev".to_string())
    };

    let app = AppWindow::new()?;
    let app_weak = app.as_weak();

    // Show window immediately so user sees UI instantly
    app.set_screen_index(0);
    app.set_status_text("Starting Tailcat WireGuard Mesh (Tokyo Region 304)...".into());
    app.show()?;

    // Store target peer Tailcat address for outgoing P2P transfers
    let target_peer_addr: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let _target_peer_addr_clone = target_peer_addr.clone();

    // Store host address for invite regeneration
    let host_addr_shared = Arc::new(Mutex::new(String::new()));
    let host_addr_shared_init = host_addr_shared.clone();

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

        let mut child = Command::new(&daemon_path)
            .arg("-derp=https://tailcat.dev/derpmap.json")
            .arg("-ipc-port=49152")
            .arg("-v")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap_or_else(|e| panic!("Failed to spawn Tailcat daemon at {}: {}", daemon_path.display(), e));

        let stdout = child.stdout.take().expect("Failed to get stdout of daemon");
        let mut reader = BufReader::new(stdout).lines();

        // Read initial ready event from daemon
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
                    let slint_qr_img = Image::from_rgba8(pixel_buffer);
                    app.set_qr_code_image(slint_qr_img);
                    app.set_has_qr_image(true);
                    app.set_invite_url(inv_u.into());
                    app.set_screen_index(1);
                    app.set_status_text("Scan QR with Phone to Connect (Direct P2P)".into());
                    app.set_expires_secs(600);
                    app.set_can_disconnect(true);
                    app.set_can_send(true);
                    app.set_peer_name("Waiting for Peer...".into());
                    app.set_derp_info("tailcat.dev (WireGuard P2P)".into());
                    app.set_edge_relay_info("Pure Tailcat Mesh (No Relay)".into());
                    let display_sess = if sess_t.len() >= 12 {
                        format!("{}...", &sess_t[..12])
                    } else {
                        sess_t.clone()
                    };
                    app.set_session_info(display_sess.into());
                }
            });
        }

        // Connect to Daemon IPC Port
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            if let Ok(mut stream) = TcpStream::connect("127.0.0.1:49152").await {
                info!("Connected to Tailcat daemon local IPC");
                while let Some(cmd) = ipc_rx.recv().await {
                    if let Ok(data) = serde_json::to_vec(&cmd) {
                        let _ = stream.write_all(&data).await;
                        let _ = stream.write_all(b"\n").await;
                    }
                }
            }
        });

        // Listen for incoming Tailcat events from Daemon stdout
        let app_weak_daemon = app_weak_boot.clone();
        while let Ok(Some(line)) = reader.next_line().await {
            info!("[tailcat-event] {}", line);
            if let Ok(ev) = serde_json::from_str::<DaemonEvent>(&line) {
                match ev.event.as_str() {
                    "incoming_stream" => {
                        let w = app_weak_daemon.clone();
                        let port = ev.port.unwrap_or(0);
                        if let Some(ref addr) = ev.address {
                            if let Ok(mut guard) = target_peer_addr_daemon.lock() {
                                *guard = Some(addr.clone());
                            }
                        }
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w.upgrade() {
                                app.set_screen_index(3);
                                app.set_peer_name("Connected Peer (WireGuard P2P)".into());
                                app.set_status_text(format!("Direct P2P Stream Active (Port {})", port).into());
                            }
                        });
                    }
                    "incoming_text" => {
                        if let Some(text) = ev.text {
                            println!("✉️ [P2P Direct Text Received]: {}", text);
                            if let Some(idx) = text.find("JOIN:") {
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
                            let w = app_weak_daemon.clone();
                            let t = text.clone();
                            let _ = slint::invoke_from_event_loop(move || {
                                if let Some(app) = w.upgrade() {
                                    app.set_screen_index(3);
                                    app.set_peer_name("Connected Peer (WireGuard P2P)".into());
                                    let new_log = format!("[Peer]: {}\n{}", t, app.get_received_message_log());
                                    app.set_received_message_log(new_log.into());
                                    app.set_last_received_text(t.into());
                                    app.set_status_text("Received text message via Tailcat P2P!".into());
                                }
                            });
                        }
                    }
                    "incoming_file_start" => {
                        let fname = ev.filename.unwrap_or_else(|| "file.bin".to_string());
                        let total_mb = ev.size.unwrap_or(0) as f64 / 1048576.0;
                        let w = app_weak_daemon.clone();
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w.upgrade() {
                                app.set_screen_index(3);
                                app.set_peer_name("Connected Peer (WireGuard P2P)".into());
                                app.set_is_transferring(true);
                                app.set_transfer_completed(false);
                                app.set_transfer_filename(fname.clone().into());
                                if total_mb > 0.0 {
                                    app.set_transfer_bytes_text(format!("0.0 MB / {:.1} MB", total_mb).into());
                                } else {
                                    app.set_transfer_bytes_text("Starting download...".into());
                                }
                                app.set_transfer_speed("Connecting...".into());
                                app.set_transfer_progress(0.05);
                                app.set_transfer_status("Receiving file from Peer...".into());
                                app.set_status_text(format!("Receiving {} from Peer...", fname).into());
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
                            format!("{:.1} MB received", bytes_mb)
                        };
                        let w = app_weak_daemon.clone();
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w.upgrade() {
                                app.set_is_transferring(true);
                                app.set_transfer_completed(false);
                                app.set_transfer_filename(fname.clone().into());
                                app.set_transfer_bytes_text(bytes_text.into());
                                app.set_transfer_speed(speed.into());
                                app.set_transfer_progress(progress as f32);
                                app.set_transfer_status("Receiving from Peer...".into());
                            }
                        });
                    }
                    "incoming_file" => {
                        let fname = ev.filename.unwrap_or_else(|| "file.bin".to_string());
                        let fsize = ev.size.unwrap_or(0) as f64 / 1048576.0;
                        let fpath = ev.path.unwrap_or_default();
                        println!("📁 [P2P Direct File Received]: {} ({:.1} MB) -> {}", fname, fsize, fpath);

                        let w = app_weak_daemon.clone();
                        let _ = slint::invoke_from_event_loop(move || {
                            if let Some(app) = w.upgrade() {
                                app.set_screen_index(3);
                                app.set_is_transferring(false);
                                app.set_transfer_completed(true);
                                app.set_transfer_filename(fname.clone().into());
                                app.set_transfer_bytes_text(format!("{:.1} MB", fsize).into());
                                app.set_transfer_speed("Saved".into());
                                app.set_transfer_progress(1.0);
                                app.set_transfer_status("[Completed] File Transfer Successful!".into());
                                app.set_status_text(format!("Received {} ({:.1} MB) — Saved to Downloads/TailSend!", fname, fsize).into());
                                let new_log = format!(
                                    "[File Received]: {} ({:.1} MB)\nSaved: {}\n{}",
                                    fname, fsize, fpath, app.get_received_message_log()
                                );
                                app.set_received_message_log(new_log.into());
                            }
                        });
                    }
                    _ => {}
                }
            }
        }
    });

    // Clipboard Copy Handler
    let app_weak_copy = app_weak.clone();
    app.on_copy_invite(move || {
        if let Some(app) = app_weak_copy.upgrade() {
            let copy_url = app.get_invite_url().to_string();
            if let Ok(mut clipboard) = Clipboard::new() {
                let _ = clipboard.set_text(&copy_url);
                app.set_status_text("Invite URL copied to clipboard!".into());
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
                app.set_status_text("New QR Code generated! Scan with phone.".into());
            }
        }
    });

    // Disconnect Handler
    let app_weak_disc = app_weak.clone();
    app.on_disconnect(move || {
        if let Some(app) = app_weak_disc.upgrade() {
            app.set_screen_index(1);
            app.set_status_text("Disconnected. Please scan new QR code.".into());
        }
    });

    // Join Session Handler (Manual Connect to Peer ConnBlob)
    let app_weak_join = app_weak.clone();
    let target_addr_join = target_peer_addr.clone();
    let ipc_tx_join = ipc_tx_clone.clone();
    app.on_join_session(move |input_text| {
        let text = input_text.to_string();
        if !text.is_empty() {
            let addr = parse_tailcat_address(&text);
            if let Ok(mut guard) = target_addr_join.lock() {
                *guard = Some(addr.clone());
            }
            if let Some(app) = app_weak_join.upgrade() {
                app.set_screen_index(3);
                app.set_peer_name("Remote iPhone (P2P)".into());
                app.set_status_text("Connected via Tailcat WireGuard P2P!".into());
            }
            // Send test handshake ping over Tailcat
            let _ = ipc_tx_join.send(DaemonCommand {
                action: "send_text".to_string(),
                address: Some(addr),
                port: Some(101),
                handle: None,
                text: Some("🤝 [Connected] TailSend Mac Native connected via Tailcat WireGuard Mesh!".to_string()),
                filename: None,
                path: None,
            });
        }
    });

    // Compose Text Message Handler (Direct P2P via Tailcat Port 101)
    let app_weak_text = app_weak.clone();
    let ipc_tx_text = ipc_tx_clone.clone();
    let target_addr_text = target_peer_addr.clone();
    app.on_compose_text(move |msg| {
        if let Some(app) = app_weak_text.upgrade() {
            let msg_str = msg.to_string();
            if msg_str.trim().is_empty() {
                return;
            }

            let log_text = format!("[Me]: {}\n{}", msg_str, app.get_received_message_log());
            app.set_received_message_log(log_text.into());
            app.set_message_input("".into());

            if let Ok(guard) = target_addr_text.lock() {
                if let Some(target) = guard.as_ref() {
                    info!("Sending Tailcat P2P message to {}: {}", target, msg_str);
                    let _ = ipc_tx_text.send(DaemonCommand {
                        action: "send_text".to_string(),
                        address: Some(target.clone()),
                        port: Some(101),
                        handle: None,
                        text: Some(msg_str),
                        filename: None,
                        path: None,
                    });
                }
            }
        }
    });

    // Pick File Handler (Direct P2P via Tailcat Port 102)
    let app_weak_pick = app_weak.clone();
    let ipc_tx_file = ipc_tx_clone.clone();
    let target_addr_file = target_peer_addr.clone();
    app.on_pick_files(move || {
        if let Some(path) = rfd::FileDialog::new().pick_file() {
            let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let path_str = path.to_string_lossy().to_string();

            if let Some(app) = app_weak_pick.upgrade() {
                app.set_is_transferring(true);
                app.set_transfer_completed(false);
                app.set_transfer_filename(file_name.clone().into());
                app.set_transfer_status("Sending via Tailcat P2P...".into());
                app.set_transfer_progress(0.5);

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
                    }
                }
            }
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

    // Save Text as File
    let app_weak_save = app_weak.clone();
    app.on_save_received_text(move || {
        if let Some(app) = app_weak_save.upgrade() {
            let text = app.get_last_received_text().to_string();
            if !text.is_empty() {
                let download_dir = get_download_dir();
                let _ = std::fs::create_dir_all(&download_dir);
                let now_str = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
                let txt_path = download_dir.join(format!("received_text_{}.txt", now_str));
                let _ = std::fs::write(&txt_path, text);
                app.set_status_text(format!("Text saved to {}", txt_path.display()).into());
            }
        }
    });

    // Copy Received Text to Clipboard
    let app_weak_copy_text = app_weak.clone();
    app.on_copy_received_text(move || {
        if let Some(app) = app_weak_copy_text.upgrade() {
            let text = app.get_last_received_text().to_string();
            if !text.is_empty() {
                if let Ok(mut clipboard) = Clipboard::new() {
                    let _ = clipboard.set_text(&text);
                    app.set_status_text("Text copied to clipboard!".into());
                }
            }
        }
    });

    app.show()?;
    slint::run_event_loop()?;
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
