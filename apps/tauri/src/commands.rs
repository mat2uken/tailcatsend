use tauri::{AppHandle, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::model::{FileRequest, UiQrBitmap, UiSnapshot};
use crate::runtime::TauriRuntime;

pub use crate::runtime::ponlet_qr_code_impl;

#[tauri::command]
pub async fn ponlet_snapshot(runtime: State<'_, TauriRuntime>) -> Result<UiSnapshot, String> {
    crate::runtime::ponlet_snapshot_impl(&runtime).await
}

#[tauri::command]
pub fn ponlet_subscribe(
    runtime: State<'_, TauriRuntime>,
    subscription_id: String,
) -> Result<UiSnapshot, String> {
    crate::ipc::subscribe_json(&runtime, subscription_id)
}

#[tauri::command]
pub async fn ponlet_wait_event(
    runtime: State<'_, TauriRuntime>,
    subscription_id: String,
    last_sequence: u64,
) -> Result<Option<serde_json::Value>, String> {
    crate::ipc::wait_event_json(&runtime, subscription_id, last_sequence).await
}

#[tauri::command]
pub fn ponlet_unsubscribe(runtime: State<'_, TauriRuntime>, subscription_id: String) {
    crate::ipc::unsubscribe_json(&runtime, &subscription_id);
}

#[tauri::command]
pub async fn ponlet_create_invite(runtime: State<'_, TauriRuntime>) -> Result<(), String> {
    crate::runtime::ponlet_create_invite_impl(&runtime).await
}

#[tauri::command]
pub async fn ponlet_join(runtime: State<'_, TauriRuntime>, invite: String) -> Result<(), String> {
    crate::runtime::ponlet_join_impl(&runtime, invite).await
}

#[tauri::command]
pub async fn ponlet_send_text(
    runtime: State<'_, TauriRuntime>,
    text: String,
) -> Result<(), String> {
    crate::runtime::ponlet_send_text_impl(&runtime, text).await
}

#[tauri::command]
pub async fn ponlet_send_files(
    app: AppHandle,
    runtime: State<'_, TauriRuntime>,
    files: Vec<FileRequest>,
) -> Result<(), String> {
    crate::runtime::ponlet_send_files_impl(app, &runtime, files).await
}

#[tauri::command]
pub async fn ponlet_pick_and_send_files(
    app: AppHandle,
    runtime: State<'_, TauriRuntime>,
) -> Result<(), String> {
    crate::runtime::ponlet_pick_and_send_files_impl(app, &runtime).await
}

#[tauri::command]
pub async fn ponlet_save_text(app: AppHandle, text: String) -> Result<(), String> {
    crate::storage::ponlet_save_text_impl(app, text).await
}

#[tauri::command]
pub fn ponlet_qr_code(url: String) -> Result<UiQrBitmap, String> {
    ponlet_qr_code_impl(url)
}

#[tauri::command]
pub async fn ponlet_cancel_transfer(
    runtime: State<'_, TauriRuntime>,
    id: String,
) -> Result<(), String> {
    crate::runtime::ponlet_cancel_transfer_impl(&runtime, id).await
}

#[tauri::command]
pub async fn ponlet_disconnect(runtime: State<'_, TauriRuntime>) -> Result<(), String> {
    crate::runtime::ponlet_disconnect_impl(&runtime).await
}

#[tauri::command]
pub async fn ponlet_open_received(
    app: AppHandle,
    runtime: State<'_, TauriRuntime>,
    local_path_or_handle: String,
) -> Result<(), String> {
    let received = runtime
        .received()
        .lock()
        .expect("received item mutex poisoned");
    crate::storage::ponlet_open_received_impl(&app, &received, &local_path_or_handle)
}

#[tauri::command]
pub async fn ponlet_initialize_platform(
    app: AppHandle,
    opt_out: Option<bool>,
) -> Result<&'static str, String> {
    crate::telemetry::initialize(app, opt_out.unwrap_or(false)).await?;
    Ok(std::env::consts::OS)
}

#[tauri::command]
pub async fn ponlet_copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard()
        .write_text(text)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ponlet_read_clipboard(app: AppHandle) -> Result<String, String> {
    app.clipboard()
        .read_text()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ponlet_share_text(app: AppHandle, text: String) -> Result<(), String> {
    #[cfg(mobile)]
    {
        use tauri_plugin_ponlet_platform::PonletPlatformExt;
        app.ponlet_platform().share_text(&text)
    }
    #[cfg(desktop)]
    app.clipboard()
        .write_text(text)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ponlet_open_downloads(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let directory = crate::storage::app_storage_dir(&app);
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        app.opener()
            .open_path(directory.to_string_lossy(), None::<String>)
            .map_err(|error| error.to_string())
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("The receive folder is available through each received file".to_string())
    }
}

#[tauri::command]
pub async fn ponlet_open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only public web links can be opened".to_string());
    }
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ponlet_get_telemetry_enabled(app: AppHandle) -> Result<bool, String> {
    crate::telemetry::initialize(app, false).await?;
    Ok(tailsend_telemetry::is_enabled())
}

#[tauri::command]
pub async fn ponlet_set_telemetry_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    crate::telemetry::initialize(app, false).await?;
    tailsend_telemetry::set_enabled(enabled);
    Ok(())
}
