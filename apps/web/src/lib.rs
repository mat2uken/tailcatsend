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

struct I18nWeb;

impl I18nWeb {
    pub fn boot_status(is_ja: bool) -> &'static str {
        if is_ja { "安全な通信の準備中…" } else { "Preparing secure P2P network…" }
    }
    pub fn scan_qr_status(is_ja: bool) -> &'static str {
        if is_ja { "QRコードをスキャンして接続" } else { "Scan QR Code to Connect" }
    }
    pub fn waiting_for_peer(is_ja: bool) -> &'static str {
        if is_ja { "相手端末の接続待機中…" } else { "Waiting for Peer..." }
    }
    pub fn connected_peer(is_ja: bool) -> &'static str {
        if is_ja { "接続された相手端末" } else { "Connected Peer" }
    }
    pub fn connecting_pc(is_ja: bool) -> &'static str {
        if is_ja { "PCと安全なP2Pで接続中…" } else { "Connecting to PC via secure P2P..." }
    }
    pub fn connecting_peer(is_ja: bool) -> &'static str {
        if is_ja { "相手端末に接続中…" } else { "Connecting to Peer Device..." }
    }
    pub fn direct_connected(is_ja: bool) -> &'static str {
        if is_ja { "直接暗号化P2Pで接続しました！" } else { "Connected via Direct Encrypted P2P!" }
    }
    pub fn msg_received(is_ja: bool) -> &'static str {
        if is_ja { "メッセージを受信しました！" } else { "Received text message!" }
    }
    pub fn file_download_done(is_ja: bool, fname: &str, size_mb: f64) -> String {
        if is_ja { format!("{} ({:.1} MB) を保存しました", fname, size_mb) } else { format!("Downloaded {} ({:.1} MB) successfully!", fname, size_mb) }
    }
    pub fn download_completed_badge(is_ja: bool) -> &'static str {
        if is_ja { "ダウンロードが完了しました！" } else { "Download Complete!" }
    }
    pub fn securely_connected(is_ja: bool) -> &'static str {
        if is_ja { "相手端末と直接安全に接続されています" } else { "Securely connected to Peer" }
    }
    pub fn ready_for_transfer(is_ja: bool) -> &'static str {
        if is_ja { "ファイル転送の準備完了" } else { "Ready for Transfer" }
    }
    pub fn qr_regenerated(is_ja: bool) -> &'static str {
        if is_ja { "新しいQRコードを生成しました！" } else { "New QR Code generated! Scan to connect." }
    }
    pub fn disconnected(is_ja: bool) -> &'static str {
        if is_ja { "切断しました。新しいQRコードをスキャンしてください。" } else { "Disconnected. Please scan new QR code." }
    }
    pub fn invite_copied(is_ja: bool) -> &'static str {
        if is_ja { "招待リンクをコピーしました！" } else { "Invite link copied to clipboard!" }
    }
    pub fn text_copied(is_ja: bool) -> &'static str {
        if is_ja { "テキストをクリップボードにコピーしました！" } else { "Text copied to clipboard!" }
    }
    pub fn path_copied(is_ja: bool) -> &'static str {
        if is_ja { "ファイルパスをクリップボードにコピーしました！" } else { "File path copied to clipboard!" }
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
    pub fn transfer_cancelled(is_ja: bool) -> &'static str {
        if is_ja { "転送をキャンセルしました" } else { "Transfer cancelled" }
    }
    pub fn invite_expired(is_ja: bool) -> &'static str {
        if is_ja { "招待の有効期限が切れました。再生成してください。" } else { "Invite expired. Please click Regenerate." }
    }
    pub fn camera_unsupported(is_ja: bool) -> &'static str {
        if is_ja {
            "カメラスキャンはモバイルネイティブ版でご利用いただけます。「貼付して接続」をご利用ください。"
        } else {
            "Camera scanning is available in mobile native app. Please use 'Paste & Join' instead."
        }
    }
}

#[wasm_bindgen]
pub fn run_app() -> Result<(), JsValue> {
    console_error_panic_hook::set_once();

    let app = AppWindow::new().map_err(|e| JsValue::from_str(&e.to_string()))?;

    let window = web_sys::window().ok_or_else(|| JsValue::from_str("No window object"))?;

    // Auto-detect language from browser environment
    let nav_lang = window.navigator().language().unwrap_or_default().to_lowercase();
    let initial_lang = if nav_lang.starts_with("ja") { "ja" } else { "en" };
    app.set_current_language(initial_lang.into());

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

                let is_ja = app.get_current_language() == "ja";
                app.set_screen_index(3); // Screen 3: Connected Home
                app.set_peer_name(I18nWeb::connected_peer(is_ja).into());
                app.set_derp_info(if is_ja { "暗号化メッシュ".into() } else { "Encrypted Mesh".into() });
                app.set_edge_relay_info(if is_ja { "DERPリレー".into() } else { "DERP Relay".into() });
                app.set_session_info(short_tok.into());
                app.set_status_text(I18nWeb::connecting_pc(is_ja).into());
                app.set_can_disconnect(true);
                app.set_can_send(true);
                app.set_is_derp_relay(true);
            }
            Err(e) => {
                let is_ja = app.get_current_language() == "ja";
                app.set_screen_index(2); // Screen 2: Error / Joining
                app.set_status_text(if is_ja { format!("招待コードエラー: {}", e).into() } else { format!("Invitation error: {}", e).into() });
            }
        }
    } else {
        let is_ja = app.get_current_language() == "ja";
        app.set_screen_index(1);
        app.set_status_text(I18nWeb::boot_status(is_ja).into());
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
                let is_ja = app.get_current_language() == "ja";
                app.set_status_text(I18nWeb::scan_qr_status(is_ja).into());
            }
        }
    }) as Box<dyn FnMut(String)>);
    let _ = js_sys::Reflect::set(&window, &JsValue::from_str("onTailcatHostAddressReady"), on_host_addr.as_ref().unchecked_ref());
    on_host_addr.forget();

    // Callback when remote peer connects via WireGuard
    let app_weak_peer = app.as_weak();
    let on_peer_connected = Closure::wrap(Box::new(move |peer_name: String| {
        if let Some(app) = app_weak_peer.upgrade() {
            let is_ja = app.get_current_language() == "ja";
            app.set_screen_index(3); // Screen 3: Connected Home
            app.set_peer_name(peer_name.into());
            app.set_derp_info(if is_ja { "暗号化メッシュ".into() } else { "Encrypted Mesh".into() });
            app.set_edge_relay_info(if is_ja { "DERPリレー".into() } else { "DERP Relay".into() });
            app.set_status_text(I18nWeb::direct_connected(is_ja).into());
            app.set_can_disconnect(true);
            app.set_can_send(true);
            app.set_is_derp_relay(true);
        }
    }) as Box<dyn FnMut(String)>);
    let _ = js_sys::Reflect::set(&window, &JsValue::from_str("onPeerConnectedSlint"), on_peer_connected.as_ref().unchecked_ref());
    on_peer_connected.forget();

    let app_weak_derp = app.as_weak();
    let set_derp_relay = Closure::wrap(Box::new(move |is_derp: bool| {
        if let Some(app) = app_weak_derp.upgrade() {
            app.set_is_derp_relay(is_derp);
        }
    }) as Box<dyn FnMut(bool)>);
    let _ = js_sys::Reflect::set(&window, &JsValue::from_str("setSlintDerpRelay"), set_derp_relay.as_ref().unchecked_ref());
    set_derp_relay.forget();

    // Set up JS bridge callbacks for UI updates from incoming streams
    let app_weak_msg = app.as_weak();
    let on_incoming_text = Closure::wrap(Box::new(move |text: String| {
        if let Some(app) = app_weak_msg.upgrade() {
            let is_ja = app.get_current_language() == "ja";
            let peer_label = I18nWeb::label_peer(is_ja);
            let new_log = format!("{}: {}\n{}", peer_label, text, app.get_received_message_log());
            app.set_received_message_log(new_log.into());
            app.set_last_received_text(text.into());
            app.set_status_text(I18nWeb::msg_received(is_ja).into());
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
            let is_ja = app.get_current_language() == "ja";
            let me_label = I18nWeb::label_me(is_ja);
            let log_text = format!("{}: {}\n{}", me_label, text, app.get_received_message_log());
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
            let is_ja = app.get_current_language() == "ja";
            let mb = size / 1048576.0;
            let recv_label = I18nWeb::label_file_recv(is_ja);
            let new_log = format!("{}: {} ({:.1} MB)\n{}", recv_label, filename, mb, app.get_received_message_log());
            app.set_received_message_log(new_log.into());
            app.set_is_transferring(false);
            app.set_transfer_completed(true);
            app.set_transfer_status(I18nWeb::download_completed_badge(is_ja).into());
            app.set_status_text(I18nWeb::file_download_done(is_ja, &filename, mb).into());
            app.set_saved_file_path(filename.into());
            app.set_path_copied_feedback(false);
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
                let is_ja = app.get_current_language() == "ja";
                let me_label = I18nWeb::label_me(is_ja);
                let log_text = format!("{}: {}\n{}", me_label, text_to_send, app.get_received_message_log());
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
            let is_ja = app.get_current_language() == "ja";
            app.set_status_text(I18nWeb::text_copied(is_ja).into());
            app.set_text_copied_feedback(true);
            let w_timer = app_weak_copy.clone();
            wasm_bindgen_futures::spawn_local(async move {
                let promise = js_sys::Promise::new(&mut |resolve, _| {
                    let window = web_sys::window().unwrap();
                    let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, 3000);
                });
                let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
                if let Some(app) = w_timer.upgrade() {
                    app.set_text_copied_feedback(false);
                }
            });
        }
    });

    let app_weak_copy_path = app.as_weak();
    app.on_copy_file_path(move || {
        if let Some(app) = app_weak_copy_path.upgrade() {
            let path = app.get_saved_file_path();
            if !path.is_empty() {
                trigger_copy_text(&path);
                let is_ja = app.get_current_language() == "ja";
                app.set_status_text(I18nWeb::path_copied(is_ja).into());
                app.set_path_copied_feedback(true);
                let w_timer = app_weak_copy_path.clone();
                wasm_bindgen_futures::spawn_local(async move {
                    let promise = js_sys::Promise::new(&mut |resolve, _| {
                        let window = web_sys::window().unwrap();
                        let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, 3000);
                    });
                    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
                    if let Some(app) = w_timer.upgrade() {
                        app.set_path_copied_feedback(false);
                    }
                });
            }
        }
    });

    let app_weak_file = app.as_weak();
    app.on_pick_files(move || {
        if let Some(_) = app_weak_file.upgrade() {
            trigger_file_picker();
        }
    });

    let app_weak_lang = app.as_weak();
    app.on_switch_language(move |lang| {
        if let Some(app) = app_weak_lang.upgrade() {
            let l_str = lang.to_string();
            app.set_current_language(l_str.clone().into());
            let is_ja = l_str == "ja";
            match app.get_screen_index() {
                0 => app.set_status_text(I18nWeb::boot_status(is_ja).into()),
                1 => {
                    app.set_status_text(I18nWeb::scan_qr_status(is_ja).into());
                    app.set_peer_name(I18nWeb::waiting_for_peer(is_ja).into());
                },
                2 => app.set_status_text(I18nWeb::connecting_peer(is_ja).into()),
                3 => {
                    app.set_peer_name(I18nWeb::connected_peer(is_ja).into());
                    if !app.get_is_transferring() && !app.get_transfer_completed() {
                        app.set_status_text(I18nWeb::securely_connected(is_ja).into());
                        app.set_transfer_status(I18nWeb::ready_for_transfer(is_ja).into());
                    }
                },
                _ => {}
            }
        }
    });

    let app_weak_copy_inv = app.as_weak();
    app.on_copy_invite(move || {
        if let Some(app) = app_weak_copy_inv.upgrade() {
            let url = app.get_invite_url();
            trigger_copy_text(&url);
            app.set_copy_feedback_active(true);
            let is_ja = app.get_current_language() == "ja";
            app.set_status_text(I18nWeb::invite_copied(is_ja).into());

            let w_timer = app_weak_copy_inv.clone();
            wasm_bindgen_futures::spawn_local(async move {
                // Wait 3 seconds then reset copy feedback
                let promise = js_sys::Promise::new(&mut |resolve, _| {
                    let window = web_sys::window().unwrap();
                    let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, 3000);
                });
                let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
                if let Some(app) = w_timer.upgrade() {
                    app.set_copy_feedback_active(false);
                }
            });
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
                            let is_ja = app.get_current_language() == "ja";
                            app.set_status_text(I18nWeb::qr_regenerated(is_ja).into());
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
                        let is_ja = app.get_current_language() == "ja";
                        app.set_screen_index(3);
                        app.set_peer_name(I18nWeb::connected_peer(is_ja).into());
                        app.set_session_info(short_tok.into());
                        app.set_status_text(I18nWeb::direct_connected(is_ja).into());
                        app.set_can_disconnect(true);
                        app.set_can_send(true);
                        app.set_is_derp_relay(true);
                    }

                    if let Ok(func) = js_sys::Reflect::get(&window, &JsValue::from_str("connectToPeerFromInput")) {
                        if let Some(f) = func.dyn_ref::<js_sys::Function>() {
                            let _ = f.call1(&JsValue::NULL, &JsValue::from_str(&inv.host_address));
                        }
                    }
                }
                Err(e) => {
                    if let Some(app) = app_weak_join.upgrade() {
                        let is_ja = app.get_current_language() == "ja";
                        app.set_status_text(if is_ja { format!("招待コードエラー: {}", e).into() } else { format!("Invalid invite code: {}", e).into() });
                    }
                }
            }
        }
    });

    app.on_paste_and_join(move || {
        trigger_paste_and_send();
    });

    // Cancel Transfer Callback
    let app_weak_cancel = app.as_weak();
    app.on_cancel_transfer(move || {
        if let Some(app) = app_weak_cancel.upgrade() {
            let is_ja = app.get_current_language() == "ja";
            app.set_is_transferring(false);
            app.set_transfer_progress(0.0);
            app.set_transfer_status(I18nWeb::transfer_cancelled(is_ja).into());
        }
    });

    // Scan QR Camera Callback
    let app_weak_cam = app.as_weak();
    app.on_scan_qr_camera(move || {
        if let Some(app) = app_weak_cam.upgrade() {
            let is_ja = app.get_current_language() == "ja";
            app.set_status_text(I18nWeb::camera_unsupported(is_ja).into());
        }
    });

    let app_weak_disc = app.as_weak();
    app.on_disconnect(move || {
        if let Some(app) = app_weak_disc.upgrade() {
            let is_ja = app.get_current_language() == "ja";
            app.set_screen_index(1);
            app.set_peer_name(I18nWeb::waiting_for_peer(is_ja).into());
            app.set_status_text(I18nWeb::disconnected(is_ja).into());
            app.set_is_transferring(false);
            app.set_transfer_completed(false);
            app.set_saved_file_path("".into());
            app.set_path_copied_feedback(false);
        }
    });

    // Active Countdown Timer for QR Expiration
    let _countdown_timer = slint::Timer::default();
    let app_weak_countdown = app.as_weak();
    _countdown_timer.start(slint::TimerMode::Repeated, std::time::Duration::from_secs(1), move || {
        if let Some(app) = app_weak_countdown.upgrade() {
            if app.get_screen_index() == 1 {
                let cur = app.get_expires_secs();
                if cur > 0 {
                    app.set_expires_secs(cur - 1);
                } else {
                    let is_ja = app.get_current_language() == "ja";
                    app.set_status_text(I18nWeb::invite_expired(is_ja).into());
                }
            }
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
