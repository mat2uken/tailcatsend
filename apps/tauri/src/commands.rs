use tauri::{AppHandle, State};

use crate::model::{FileRequest, UiQrBitmap, UiSnapshot};
use crate::runtime::TauriRuntime;

pub fn ponlet_qr_code_impl(url: String) -> Result<UiQrBitmap, String> {
    let image = tailsend_qr::generate_qr_rgba(&url, 256).map_err(|error| error.to_string())?;
    Ok(UiQrBitmap {
        width: image.width,
        height: image.height,
        rgba_pixels: image.rgba_pixels,
    })
}

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
pub async fn ponlet_join(
    runtime: State<'_, TauriRuntime>,
    invite: String,
) -> Result<(), String> {
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
pub fn ponlet_open_received(
    app: AppHandle,
    runtime: State<'_, TauriRuntime>,
    local_path_or_handle: String,
) -> Result<(), String> {
    crate::storage::ponlet_open_received_impl(&app, &runtime, &local_path_or_handle)
}
