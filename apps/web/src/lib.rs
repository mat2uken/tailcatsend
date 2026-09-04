use wasm_bindgen::prelude::*;
use tailsend_protocol::invitation::InvitationV1;

slint::include_modules!();

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = sendTailcatTextMessage)]
    fn send_tailcat_text_message(text: &str);

    #[wasm_bindgen(js_name = triggerFilePicker)]
    fn trigger_file_picker();

    #[wasm_bindgen(js_name = triggerOpenComposer)]
    fn trigger_open_composer(initial_text: &str);

    #[wasm_bindgen(js_name = triggerPasteAndSend)]
    fn trigger_paste_and_send();

    #[wasm_bindgen(js_name = triggerShareText)]
    fn trigger_share_text(text: &str);

    #[wasm_bindgen(js_name = triggerSaveText)]
    fn trigger_save_text(text: &str);

    #[wasm_bindgen(js_name = triggerCopyText)]
    fn trigger_copy_text(text: &str);
}

#[wasm_bindgen]
pub fn run_app() -> Result<(), JsValue> {
    console_error_panic_hook::set_once();

    let app = AppWindow::new().map_err(|e| JsValue::from_str(&e.to_string()))?;

    let window = web_sys::window().ok_or_else(|| JsValue::from_str("No window object"))?;
    let hash = window.location().hash().unwrap_or_default();

    if hash.starts_with("#i=") || hash.contains("i=") {
        let now = (js_sys::Date::now() / 1000.0) as u64;
        let url_to_parse = format!("https://tailsend.local/{}", hash);

        match InvitationV1::from_url(&url_to_parse, now) {
            Ok(inv) => {
                let _ = js_sys::Reflect::set(
                    &window,
                    &JsValue::from_str("hostTailcatAddress"),
                    &JsValue::from_str(&inv.host_address),
                );

                let token_str = inv.to_base64url().unwrap_or_default();
                let short_tok = if token_str.len() >= 12 { format!("{}...", &token_str[..12]) } else { token_str };

                app.set_screen_index(3); // Screen 3: Connected Home
                app.set_peer_name("macOS Host (P2P)".into());
                app.set_derp_info("tailcat.dev (WireGuard P2P)".into());
                app.set_edge_relay_info("Pure Tailcat Mesh (No Relay)".into());
                app.set_session_info(short_tok.into());
                app.set_status_text("Connecting to macOS Host via WireGuard P2P...".into());
                app.set_can_disconnect(true);
                app.set_can_send(true);
            }
            Err(e) => {
                app.set_screen_index(2); // Screen 2: Error / Joining
                app.set_status_text(format!("Invitation error: {}", e).into());
            }
        }
    } else {
        app.set_screen_index(1);
        app.set_status_text("Starting Tailcat WireGuard Mesh (Tokyo Region 304)...".into());
        app.set_expires_secs(600);
        app.set_can_disconnect(false);
    }

    // Callback when local browser Tailcat listener is ready with its WireGuard address
    let app_weak_addr = app.as_weak();
    let on_host_addr = Closure::wrap(Box::new(move |host_address: String| {
        if let Some(app) = app_weak_addr.upgrade() {
            let mut session_id = [0u8; 16];
            let _ = getrandom::getrandom(&mut session_id);
            let mut invite_secret = [0u8; 32];
            let _ = getrandom::getrandom(&mut invite_secret);
            let now = (js_sys::Date::now() / 1000.0) as u64;

            let invitation = InvitationV1::new(host_address, session_id, invite_secret, now, 600);
            let base_url = "https://mktailcatsend.pages.dev".to_string();
            let invite_url = invitation.to_qr_url(&base_url).unwrap_or_default();
            let session_token = invitation.to_base64url().unwrap_or_default();

            if let Ok(qr) = tailsend_qr::generate_qr_rgba(&invite_url, 236) {
                let pixel_buffer = slint::SharedPixelBuffer::<slint::Rgba8Pixel>::clone_from_slice(
                    &qr.rgba_pixels,
                    qr.width,
                    qr.height,
                );
                app.set_qr_code_image(slint::Image::from_rgba8(pixel_buffer));
                app.set_has_qr_image(true);
                app.set_invite_url(invite_url.into());
                let short_tok = if session_token.len() >= 12 { format!("{}...", &session_token[..12]) } else { session_token };
                app.set_session_info(short_tok.into());
                app.set_screen_index(1);
                app.set_status_text("Scan QR Code to Connect (Pure Tailcat P2P)".into());
            }
        }
    }) as Box<dyn FnMut(String)>);
    let _ = js_sys::Reflect::set(&window, &JsValue::from_str("onTailcatHostAddressReady"), on_host_addr.as_ref().unchecked_ref());
    on_host_addr.forget();

    // Callback when remote peer connects via WireGuard
    let app_weak_peer = app.as_weak();
    let on_peer_connected = Closure::wrap(Box::new(move |peer_name: String| {
        if let Some(app) = app_weak_peer.upgrade() {
            app.set_screen_index(3); // Screen 3: Connected Home
            app.set_peer_name(peer_name.into());
            app.set_derp_info("tailcat.dev (WireGuard P2P)".into());
            app.set_edge_relay_info("Pure Tailcat Mesh (No Relay)".into());
            app.set_status_text("Connected via Pure Tailcat WireGuard P2P!".into());
            app.set_can_disconnect(true);
            app.set_can_send(true);
        }
    }) as Box<dyn FnMut(String)>);
    let _ = js_sys::Reflect::set(&window, &JsValue::from_str("onPeerConnectedSlint"), on_peer_connected.as_ref().unchecked_ref());
    on_peer_connected.forget();

    // Set up JS bridge callbacks for UI updates from incoming streams
    let app_weak_msg = app.as_weak();
    let on_incoming_text = Closure::wrap(Box::new(move |text: String| {
        if let Some(app) = app_weak_msg.upgrade() {
            let new_log = format!("[macOS]: {}\n{}", text, app.get_received_message_log());
            app.set_received_message_log(new_log.into());
            app.set_last_received_text(text.into());
            app.set_status_text("Received message from macOS!".into());
        }
    }) as Box<dyn FnMut(String)>);
    let _ = js_sys::Reflect::set(&window, &JsValue::from_str("onIncomingTextMessageSlint"), on_incoming_text.as_ref().unchecked_ref());
    on_incoming_text.forget();

    let app_weak_status = app.as_weak();
    let update_status_cb = Closure::wrap(Box::new(move |status: String| {
        if let Some(app) = app_weak_status.upgrade() {
            app.set_status_text(status.into());
        }
    }) as Box<dyn FnMut(String)>);
    let _ = js_sys::Reflect::set(&window, &JsValue::from_str("updateSlintStatusText"), update_status_cb.as_ref().unchecked_ref());
    update_status_cb.forget();

    let app_weak_sent = app.as_weak();
    let on_text_sent = Closure::wrap(Box::new(move |text: String| {
        if let Some(app) = app_weak_sent.upgrade() {
            let log_text = format!("Sent: {}\n{}", text, app.get_received_message_log());
            app.set_received_message_log(log_text.into());
        }
    }) as Box<dyn FnMut(String)>);
    let _ = js_sys::Reflect::set(&window, &JsValue::from_str("onTextSentSlint"), on_text_sent.as_ref().unchecked_ref());
    on_text_sent.forget();

    let app_weak_progress = app.as_weak();
    let update_transfer_state = Closure::wrap(Box::new(move |is_transferring: bool, completed: bool, status: String, filename: String, bytes_text: String, progress: f64, speed: String| {
        if let Some(app) = app_weak_progress.upgrade() {
            app.set_is_transferring(is_transferring);
            app.set_transfer_completed(completed);
            app.set_transfer_status(status.into());
            app.set_transfer_filename(filename.into());
            app.set_transfer_bytes_text(bytes_text.into());
            app.set_transfer_progress(progress as f32);
            app.set_transfer_speed(speed.into());
        }
    }) as Box<dyn FnMut(bool, bool, String, String, String, f64, String)>);
    let _ = js_sys::Reflect::set(&window, &JsValue::from_str("updateSlintTransferState"), update_transfer_state.as_ref().unchecked_ref());
    update_transfer_state.forget();

    let app_weak_done = app.as_weak();
    let on_file_done = Closure::wrap(Box::new(move |filename: String, size: f64| {
        if let Some(app) = app_weak_done.upgrade() {
            let mb = size / 1048576.0;
            let new_log = format!("[Downloaded from PC]: {} ({:.1} MB)\n{}", filename, mb, app.get_received_message_log());
            app.set_received_message_log(new_log.into());
            app.set_is_transferring(false);
            app.set_transfer_completed(true);
            app.set_transfer_status("[Completed] Download Successful!".into());
        }
    }) as Box<dyn FnMut(String, f64)>);
    let _ = js_sys::Reflect::set(&window, &JsValue::from_str("onFileReceivedCompleteSlint"), on_file_done.as_ref().unchecked_ref());
    on_file_done.forget();

    // UI Action Handlers
    let app_weak_composer = app.as_weak();
    app.on_open_text_composer(move || {
        if let Some(app) = app_weak_composer.upgrade() {
            let current = app.get_message_input().to_string();
            trigger_open_composer(&current);
        }
    });

    let app_weak = app.as_weak();
    app.on_compose_text(move |msg| {
        if let Some(app) = app_weak.upgrade() {
            let text_to_send = msg.trim().to_string();
            if text_to_send.is_empty() {
                let current = app.get_message_input().to_string();
                trigger_open_composer(&current);
            } else {
                send_tailcat_text_message(&text_to_send);
                let log_text = format!("Sent: {}\n{}", text_to_send, app.get_received_message_log());
                app.set_received_message_log(log_text.into());
                app.set_message_input("".into());
            }
        }
    });

    app.on_paste_and_send(move || {
        trigger_paste_and_send();
    });

    let app_weak_share = app.as_weak();
    app.on_share_received_text(move || {
        if let Some(app) = app_weak_share.upgrade() {
            let text = app.get_last_received_text();
            trigger_share_text(&text);
        }
    });

    let app_weak_save = app.as_weak();
    app.on_save_received_text(move || {
        if let Some(app) = app_weak_save.upgrade() {
            let text = app.get_last_received_text();
            trigger_save_text(&text);
        }
    });

    let app_weak_copy = app.as_weak();
    app.on_copy_received_text(move || {
        if let Some(app) = app_weak_copy.upgrade() {
            let text = app.get_last_received_text();
            trigger_copy_text(&text);
        }
    });

    let app_weak_file = app.as_weak();
    app.on_pick_files(move || {
        if let Some(_) = app_weak_file.upgrade() {
            trigger_file_picker();
        }
    });

    let app_weak_copy_inv = app.as_weak();
    app.on_copy_invite(move || {
        if let Some(app) = app_weak_copy_inv.upgrade() {
            let url = app.get_invite_url();
            trigger_copy_text(&url);
            app.set_status_text("Invite link copied to clipboard!".into());
        }
    });

    let app_weak_regen = app.as_weak();
    app.on_regenerate_invite(move || {
        if let Some(app) = app_weak_regen.upgrade() {
            let window = web_sys::window().unwrap();
            if let Ok(addr_val) = js_sys::Reflect::get(&window, &JsValue::from_str("hostTailcatAddress")) {
                if let Some(host_address) = addr_val.as_string() {
                    if !host_address.is_empty() {
                        let mut session_id = [0u8; 16];
                        let _ = getrandom::getrandom(&mut session_id);
                        let mut invite_secret = [0u8; 32];
                        let _ = getrandom::getrandom(&mut invite_secret);
                        let now = (js_sys::Date::now() / 1000.0) as u64;

                        let invitation = InvitationV1::new(host_address, session_id, invite_secret, now, 600);
                        let base_url = "https://mktailcatsend.pages.dev".to_string();
                        let invite_url = invitation.to_qr_url(&base_url).unwrap_or_default();
                        let session_token = invitation.to_base64url().unwrap_or_default();

                        if let Ok(qr) = tailsend_qr::generate_qr_rgba(&invite_url, 236) {
                            let pixel_buffer = slint::SharedPixelBuffer::<slint::Rgba8Pixel>::clone_from_slice(
                                &qr.rgba_pixels,
                                qr.width,
                                qr.height,
                            );
                            app.set_qr_code_image(slint::Image::from_rgba8(pixel_buffer));
                            app.set_has_qr_image(true);
                            app.set_invite_url(invite_url.into());
                            let short_tok = if session_token.len() >= 12 { format!("{}...", &session_token[..12]) } else { session_token };
                            app.set_session_info(short_tok.into());
                            app.set_status_text("New QR Code generated! Scan to connect.".into());
                        }
                    }
                }
            }
        }
    });

    let app_weak_join = app.as_weak();
    app.on_join_session(move |input_text| {
        let text = input_text.to_string();
        if !text.is_empty() {
            let now = (js_sys::Date::now() / 1000.0) as u64;
            let url_to_parse = if text.starts_with("http") {
                text.clone()
            } else if text.starts_with("#i=") {
                format!("https://mktailcatsend.pages.dev/{}", text)
            } else if text.starts_with("i=") {
                format!("https://mktailcatsend.pages.dev/#{}", text)
            } else {
                format!("https://mktailcatsend.pages.dev/#i={}", text)
            };

            match InvitationV1::from_url(&url_to_parse, now) {
                Ok(inv) => {
                    let window = web_sys::window().unwrap();
                    let _ = js_sys::Reflect::set(
                        &window,
                        &JsValue::from_str("hostTailcatAddress"),
                        &JsValue::from_str(&inv.host_address),
                    );

                    let token_str = inv.to_base64url().unwrap_or_default();
                    let short_tok = if token_str.len() >= 12 { format!("{}...", &token_str[..12]) } else { token_str };

                    if let Some(app) = app_weak_join.upgrade() {
                        app.set_screen_index(3);
                        app.set_peer_name("Peer Host (P2P)".into());
                        app.set_session_info(short_tok.into());
                        app.set_status_text("Connecting to Peer via WireGuard P2P...".into());
                        app.set_can_disconnect(true);
                        app.set_can_send(true);
                    }

                    if let Ok(func) = js_sys::Reflect::get(&window, &JsValue::from_str("connectToPeerFromInput")) {
                        if let Some(f) = func.dyn_ref::<js_sys::Function>() {
                            let _ = f.call1(&JsValue::NULL, &JsValue::from_str(&inv.host_address));
                        }
                    }
                }
                Err(e) => {
                    if let Some(app) = app_weak_join.upgrade() {
                        app.set_status_text(format!("Invalid invite code: {}", e).into());
                    }
                }
            }
        }
    });

    app.on_paste_and_join(move || {
        trigger_paste_and_send();
    });

    let app_weak_disc = app.as_weak();
    app.on_disconnect(move || {
        if let Some(app) = app_weak_disc.upgrade() {
            app.set_screen_index(0);
            app.set_status_text("Disconnected".into());
        }
    });

    // 30fps Continuous Repaint Pump Timer for WebAssembly Canvas
    let _repaint_timer = slint::Timer::default();
    _repaint_timer.start(slint::TimerMode::Repeated, std::time::Duration::from_millis(33), move || {
        // Keeps WebAssembly canvas repainting smoothly during active stream transfers
    });

    app.run().map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(())
}
