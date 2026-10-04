use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsCapabilities {
    schema_version: u32,
    platform: String,
    feature_enabled: bool,
    configured: bool,
    signed_native_ready: bool,
    backend_available: bool,
    local_deletion_available: bool,
    remote_deletion_available: bool,
    policy_version: Option<String>,
    unavailable_reason: Option<String>,
}
#[derive(Deserialize, Serialize)]
pub struct ProviderAcceptance { analytics: bool, crashlytics: bool }
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousPrivacyRequest {
    request_id: String,
    server_accepted: bool,
    provider_accepted: ProviderAcceptance,
    restart_required: bool,
    state: String,
    remote_state: Option<String>,
    provider_states: Option<ProviderStates>,
    #[serde(default)]
    retention_expired: bool,
    #[serde(default)]
    key_cleanup_pending: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProviderState {
    state: String,
    error_code: Option<String>,
    additional_submission_required: bool,
}
#[derive(Deserialize, Serialize)]
pub struct ProviderStates { analytics: Option<RemoteProviderState>, crashlytics: Option<RemoteProviderState> }
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsStatus {
    schema_version: u32,
    state: String,
    request_id: Option<String>,
    server_accepted: bool,
    provider_accepted: ProviderAcceptance,
    restart_required: bool,
    partial_failures: Vec<String>,
    excluded_data: Vec<String>,
    analytics_local: String,
    crashlytics_local: String,
    future_telemetry: String,
    #[serde(default)]
    previous_requests: Vec<PreviousPrivacyRequest>,
    remote_state: Option<String>,
    provider_states: Option<ProviderStates>,
    #[serde(default)]
    retention_expired: bool,
    #[serde(default)]
    key_cleanup_pending: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeletionScope { Local, BoundRemote }
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeletionRequest { scope: DeletionScope, confirmed: bool }

async fn native<T: serde::de::DeserializeOwned>(
    app: AppHandle, command: &'static str, args: serde_json::Value,
) -> Result<T, String> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_ponlet_platform::PonletPlatformExt;
        let value = tokio::task::spawn_blocking(move || app.ponlet_platform().diagnostics_call(command, args))
            .await.map_err(|_| "native_privacy_unavailable".to_string())??;
        serde_json::from_value(value).map_err(|_| "invalid_native_privacy_response".to_string())
    }
    #[cfg(not(target_os = "android"))]
    { let _ = (app, command, args); Err("unsupported_platform".to_string()) }
}
#[tauri::command]
pub async fn ponlet_diagnostics_capabilities(app: AppHandle) -> Result<DiagnosticsCapabilities, String> {
    #[cfg(target_os = "android")]
    { native(app, "diagnosticsCapabilities", serde_json::json!({})).await }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(DiagnosticsCapabilities { schema_version: 1, platform: "unsupported".into(), feature_enabled: false,
            configured: false, signed_native_ready: false, backend_available: false, local_deletion_available: false,
            remote_deletion_available: false, policy_version: None, unavailable_reason: Some("unsupported_platform".into()) })
    }
}
#[tauri::command]
pub async fn ponlet_diagnostics_status(app: AppHandle) -> Result<DiagnosticsStatus, String> {
    native(app, "diagnosticsStatus", serde_json::json!({})).await
}
#[tauri::command]
pub async fn ponlet_diagnostics_request(app: AppHandle, request: DeletionRequest) -> Result<DiagnosticsStatus, String> {
    if !request.confirmed { return Err("confirmation_required".into()); }
    native(app, "diagnosticsRequest", serde_json::json!({"request": request})).await
}
#[tauri::command]
pub async fn ponlet_diagnostics_retry(app: AppHandle) -> Result<DiagnosticsStatus, String> {
    native(app, "diagnosticsRetry", serde_json::json!({})).await
}
#[tauri::command]
pub async fn ponlet_diagnostics_continue_after_restart(app: AppHandle) -> Result<DiagnosticsStatus, String> {
    native(app, "diagnosticsContinueAfterRestart", serde_json::json!({})).await
}
