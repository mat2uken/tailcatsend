use wasm_bindgen::prelude::*;
use tailsend_protocol::invitation::InvitationV1;

slint::include_modules!();

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = sendTailcatTextMessage)]
    fn send_tailcat_text_message(text: &str);

    #[wasm_bindgen(js_name = triggerFilePicker)]
    fn trigger_file_picker();

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
                app.set_peer_name("macOS Host (Metal)".into());
                app.set_derp_info("tailcat.dev (Active Mesh)".into());
                app.set_edge_relay_info("Cloudflare Workers (DO)".into());
                app.set_session_info(short_tok.into());
                app.set_status_text("Connected to macOS Host over WireGuard P2P".into());
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
        app.set_status_text("Waiting for peer to scan QR...".into());
        app.set_expires_secs(600);
        app.set_can_disconnect(false);
    }

    // Set up JS bridge callbacks for UI updates from incoming streams
    let app_weak_msg = app.as_weak();
    let on_incoming_text = Closure::wrap(Box::new(move |text: String| {
        if let Some(app) = app_weak_msg.upgrade() {
            let new_log = format!("[PC Host]: {}\n{}", text, app.get_received_message_log());
            app.set_received_message_log(new_log.into());
            app.set_last_received_text(text.into());
            app.set_status_text("Received message from PC!".into());
        }
    }) as Box<dyn FnMut(String)>);
    let _ = js_sys::Reflect::set(&window, &JsValue::from_str("onIncomingTextMessageSlint"), on_incoming_text.as_ref().unchecked_ref());
    on_incoming_text.forget();

    let app_weak_sent = app.as_weak();
    let on_text_sent = Closure::wrap(Box::new(move |text: String| {
        if let Some(app) = app_weak_sent.upgrade() {
            let log_text = format!("Sent (Clipboard): {}\n{}", text, app.get_received_message_log());
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
    let app_weak = app.as_weak();
    app.on_compose_text(move |msg| {
        if let Some(app) = app_weak.upgrade() {
            send_tailcat_text_message(&msg);
            let log_text = format!("Sent: {}\n{}", msg, app.get_received_message_log());
            app.set_received_message_log(log_text.into());
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
