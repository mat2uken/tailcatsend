use js_sys::{Array, Function, Object, Reflect};
use tailsend_telemetry::TelemetryBackend;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

/// Registers the web telemetry backend and returns the persisted opt-in
/// state (default: enabled). `window.__tailcatTelemetry` (telemetry.js) may
/// not be ready or may be a no-op stub; every call degrades gracefully.
pub fn init() -> bool {
    let initial_enabled = read_initial_enabled();
    tailsend_telemetry::init(Box::new(WebTelemetryBackend), initial_enabled);
    initial_enabled
}

fn read_initial_enabled() -> bool {
    match telemetry_fn("isEnabled").and_then(|f| f.call0(&JsValue::NULL).ok()) {
        Some(v) => v.is_truthy(),
        None => true,
    }
}

fn telemetry_fn(name: &str) -> Option<Function> {
    let window = web_sys::window()?;
    let telemetry = Reflect::get(&window, &JsValue::from_str("__tailcatTelemetry")).ok()?;
    if telemetry.is_undefined() || telemetry.is_null() {
        return None;
    }
    let f = Reflect::get(&telemetry, &JsValue::from_str(name)).ok()?;
    f.dyn_into::<Function>().ok()
}

/// Backend that forwards to the JS bridge (`window.__tailcatTelemetry`).
/// When the JS side is missing (script blocked, placeholders not replaced)
/// every call is a no-op, so the app keeps working unchanged.
pub struct WebTelemetryBackend;

impl TelemetryBackend for WebTelemetryBackend {
    fn log_event(&self, name: &str, params: &[(String, String)]) {
        let Some(f) = telemetry_fn("logEvent") else {
            return;
        };
        let obj = Object::new();
        for (key, value) in params {
            let _ = Reflect::set(
                &obj,
                &JsValue::from_str(key),
                &JsValue::from_str(value),
            );
        }
        let _ = f.call2(&JsValue::NULL, &JsValue::from_str(name), &obj.into());
    }

    fn set_user_property(&self, name: &str, value: &str) {
        if let Some(f) = telemetry_fn("setUserProperty") {
            let _ = f.call2(&JsValue::NULL, &JsValue::from_str(name), &JsValue::from_str(value));
        }
    }

    fn set_collection_enabled(&self, enabled: bool) {
        if let Some(f) = telemetry_fn("setEnabled") {
            let _ = f.call1(&JsValue::NULL, &JsValue::from_bool(enabled));
        }
    }

    fn remote_config_string(&self, key: &str) -> Option<String> {
        let value = telemetry_fn("remoteString")
            .and_then(|f| f.call1(&JsValue::NULL, &JsValue::from_str(key)).ok());
        match value {
            Some(v) if v.is_string() => v.as_string(),
            _ => None,
        }
    }
}

/// JS entry point for events that originate in index.html (file transfer
/// streams, app_end, ...). `params_json` is a JSON object of string /
/// number / bool values; malformed input is logged without params.
#[wasm_bindgen]
pub fn telemetry_log_event(name: String, params_json: String) {
    let mut owned: Vec<(String, String)> = Vec::new();
    if let Ok(parsed) = js_sys::JSON::parse(&params_json) {
        if let Ok(obj) = parsed.dyn_into::<Object>() {
            let entries = Object::entries(&obj);
            for i in 0..entries.length() {
                let pair = Array::from(&entries.get(i));
                let Some(key) = pair.get(0).as_string() else {
                    continue;
                };
                let raw = pair.get(1);
                let value = if let Some(s) = raw.as_string() {
                    s
                } else if let Some(n) = raw.as_f64() {
                    if n.fract() == 0.0 {
                        format!("{}", n as i64)
                    } else {
                        format!("{}", n)
                    }
                } else if let Some(b) = raw.as_bool() {
                    b.to_string()
                } else {
                    continue;
                };
                owned.push((key, value));
            }
        }
    }
    let params: Vec<(&str, &str)> = owned
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    tailsend_telemetry::log_event(&name, &params);
}

/// Coarse OS family from the user agent. No versions, no device details.
pub fn detect_os_version(user_agent: &str) -> &'static str {
    let ua = user_agent.to_lowercase();
    if ua.contains("android") {
        "android"
    } else if ua.contains("iphone") || ua.contains("ipad") || ua.contains("ipod") {
        "ios"
    } else if ua.contains("mac os x") || ua.contains("macintosh") {
        "macos"
    } else if ua.contains("windows") {
        "windows"
    } else if ua.contains("linux") {
        "linux"
    } else {
        "unknown"
    }
}
