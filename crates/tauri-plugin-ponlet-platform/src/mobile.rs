use serde::{de::DeserializeOwned, Deserialize};
use tailsend_telemetry::TelemetryBackend;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ponlet_platform);

pub struct PonletPlatform<R: Runtime>(PluginHandle<R>);

pub trait PonletPlatformExt<R: Runtime> {
    fn ponlet_platform(&self) -> &PonletPlatform<R>;
}
impl<R: Runtime, T: Manager<R>> PonletPlatformExt<R> for T {
    fn ponlet_platform(&self) -> &PonletPlatform<R> {
        self.state::<PonletPlatform<R>>().inner()
    }
}

pub(crate) fn install<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "android")]
    let handle =
        api.register_android_plugin("jp.yasagure.ponlet.platform", "PonletPlatformPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_ponlet_platform)?;
    app.manage(PonletPlatform(handle));
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySettings {
    pub enabled: bool,
    pub language: String,
    pub os_version: String,
}

#[cfg(target_os = "ios")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedItem {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub mime: Option<String>,
    pub path: String,
}

impl<R: Runtime> PonletPlatform<R> {
    #[cfg(target_os = "android")]
    pub fn diagnostics_call(&self, command: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
        match command {
            "diagnosticsCapabilities" | "diagnosticsStatus" | "diagnosticsRequest" |
            "diagnosticsRetry" | "diagnosticsContinueAfterRestart" => self.0
                .run_mobile_plugin(command, args)
                .map_err(|_| "native_privacy_unavailable".to_string()),
            _ => Err("invalid_native_command".to_string()),
        }
    }
    #[cfg(target_os = "android")]
    pub fn begin_telemetry_intent(&self) -> Result<String, String> {
        #[derive(Deserialize)]
        struct Intent { intent: String }
        let result: Intent = self.0.run_mobile_plugin("telemetryBeginIntent", serde_json::json!({}))
            .map_err(|_| "native_setting_unavailable".to_string())?;
        Ok(result.intent)
    }
    #[cfg(target_os = "android")]
    pub fn get_telemetry_enabled_checked(&self) -> Result<bool, String> {
        #[derive(Deserialize)]
        struct Setting { enabled: bool }
        let result: Setting = self.0.run_mobile_plugin("telemetryGetEnabled", serde_json::json!({}))
            .map_err(|_| "telemetry_setting_read_failed".to_string())?;
        Ok(result.enabled)
    }
    #[cfg(target_os = "android")]
    pub fn set_telemetry_checked(&self, enabled: bool, intent: String) -> Result<(), String> {
        self.0.run_mobile_plugin("telemetrySetEnabled", serde_json::json!({"enabled": enabled, "intent": intent}))
            // A rejected operation may already have persisted the choice before an SDK failure.
            .map_err(|_| "telemetry_setting_operation_failed".to_string())
    }
    pub fn open_received(&self, path: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin("openReceived", serde_json::json!({"path": path}))
            .map_err(|error| error.to_string())
    }
    #[cfg(target_os = "ios")]
    pub fn share_received(&self, path: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin("shareReceived", serde_json::json!({"path": path}))
            .map_err(|error| error.to_string())
    }
    pub fn share_text(&self, text: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin("shareText", serde_json::json!({"text": text}))
            .map_err(|error| error.to_string())
    }
    #[cfg(target_os = "ios")]
    pub fn read_shared_items(&self) -> Result<Vec<SharedItem>, String> {
        self.0
            .run_mobile_plugin("readSharedItems", serde_json::json!({}))
            .map_err(|error| error.to_string())
    }
    #[cfg(target_os = "ios")]
    pub fn acknowledge_shared_item(&self, id: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin("acknowledgeSharedItem", serde_json::json!({"id": id}))
            .map_err(|error| error.to_string())
    }
    #[cfg(target_os = "ios")]
    pub fn save_text(&self, text: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin("saveText", serde_json::json!({"text": text}))
            .map_err(|error| error.to_string())
    }
    pub fn initialize_telemetry(&self, opt_out: bool) -> Result<TelemetrySettings, String> {
        let settings: TelemetrySettings = self
            .0
            .run_mobile_plugin("telemetryInit", serde_json::json!({"optOut": opt_out}))
            .map_err(|error| error.to_string())?;
        tailsend_telemetry::init(Box::new(MobileTelemetry(self.0.clone())), settings.enabled);
        Ok(settings)
    }
}

struct MobileTelemetry<R: Runtime>(PluginHandle<R>);
impl<R: Runtime> TelemetryBackend for MobileTelemetry<R> {
    fn log_event(&self, name: &str, params: &[(String, String)]) {
        let params: std::collections::BTreeMap<_, _> = params.iter().cloned().collect();
        let _: Result<(), _> = self.0.run_mobile_plugin(
            "telemetryEvent",
            serde_json::json!({"name": name, "params": params}),
        );
    }
    fn set_user_property(&self, name: &str, value: &str) {
        let _: Result<(), _> = self.0.run_mobile_plugin(
            "telemetryProperty",
            serde_json::json!({"name": name, "value": value}),
        );
    }
    fn set_collection_enabled(&self, enabled: bool) {
        #[cfg(target_os = "android")]
        {
            #[derive(Deserialize)]
            struct Intent { intent: String }
            let started: Result<Intent, _> = self.0.run_mobile_plugin("telemetryBeginIntent", serde_json::json!({}));
            if let Ok(started) = started {
                let _: Result<(), _> = self.0.run_mobile_plugin("telemetrySetEnabled",
                    serde_json::json!({"enabled": enabled, "intent": started.intent}));
            }
        }
        #[cfg(target_os = "ios")]
        {
            let _: Result<(), _> = self.0.run_mobile_plugin(
                "telemetrySetEnabled", serde_json::json!({"enabled": enabled}));
        }
    }
}
