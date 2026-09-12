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

impl<R: Runtime> PonletPlatform<R> {
    pub fn open_received(&self, path: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin("openReceived", serde_json::json!({"path": path}))
            .map_err(|error| error.to_string())
    }
    pub fn share_text(&self, text: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin("shareText", serde_json::json!({"text": text}))
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
        let _: Result<(), _> = self.0.run_mobile_plugin(
            "telemetrySetEnabled",
            serde_json::json!({"enabled": enabled}),
        );
    }
    fn remote_config_string(&self, key: &str) -> Option<String> {
        #[derive(Deserialize)]
        struct Reply {
            value: Option<String>,
        }
        self.0
            .run_mobile_plugin::<Reply>("telemetryRemoteString", serde_json::json!({"key": key}))
            .ok()
            .and_then(|reply| reply.value)
    }
}
