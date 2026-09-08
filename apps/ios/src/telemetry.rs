use std::ffi::CString;
use std::os::raw::{c_char, c_int};

use tailsend_telemetry::TelemetryBackend;

extern "C" {
    fn tailsend_telemetry_ios_init() -> c_int;
    fn tailsend_telemetry_ios_log_event(name: *const c_char, json_params: *const c_char);
    fn tailsend_telemetry_ios_set_user_property(name: *const c_char, value: *const c_char);
    fn tailsend_telemetry_ios_set_enabled(enabled: c_int);
    fn tailsend_telemetry_ios_remote_string(
        key: *const c_char,
        out_buf: *mut c_char,
        buf_len: c_int,
    ) -> c_int;
    fn tailsend_telemetry_ios_locale_language(out_buf: *mut c_char, buf_len: c_int) -> c_int;
}

pub struct IosTelemetryBackend;

pub fn init() -> bool {
    let enabled = unsafe { tailsend_telemetry_ios_init() } != 0;
    let language = system_language();

    tailsend_telemetry::init(Box::new(IosTelemetryBackend), enabled);
    tailsend_telemetry::events::app_start(
        "ios",
        std::env::consts::OS,
        env!("CARGO_PKG_VERSION"),
        &language,
    );
    tailsend_telemetry::set_user_property("platform", "ios");
    tailsend_telemetry::set_user_property("app_version", env!("CARGO_PKG_VERSION"));
    tailsend_telemetry::set_user_property("os_version", std::env::consts::OS);
    tailsend_telemetry::set_user_property("language", &language);
    enabled
}

fn system_language() -> String {
    let mut buf = [0 as c_char; 16];
    let n = unsafe { tailsend_telemetry_ios_locale_language(buf.as_mut_ptr(), 16) };
    if n <= 0 {
        return "en".to_string();
    }
    let bytes: Vec<u8> = buf[..n as usize].iter().map(|c| *c as u8).collect();
    String::from_utf8(bytes).unwrap_or_else(|_| "en".to_string())
}

impl TelemetryBackend for IosTelemetryBackend {
    fn log_event(&self, name: &str, params: &[(String, String)]) {
        let mut obj = serde_json::Map::new();
        for (key, value) in params {
            obj.insert(key.clone(), serde_json::json!(value));
        }
        let json = serde_json::Value::Object(obj).to_string();
        if let (Ok(name), Ok(json)) = (CString::new(name), CString::new(json)) {
            unsafe { tailsend_telemetry_ios_log_event(name.as_ptr(), json.as_ptr()) };
        }
    }

    fn set_user_property(&self, name: &str, value: &str) {
        if let (Ok(name), Ok(value)) = (CString::new(name), CString::new(value)) {
            unsafe { tailsend_telemetry_ios_set_user_property(name.as_ptr(), value.as_ptr()) };
        }
    }

    fn set_collection_enabled(&self, enabled: bool) {
        unsafe { tailsend_telemetry_ios_set_enabled(enabled as c_int) };
    }

    fn remote_config_string(&self, key: &str) -> Option<String> {
        let Ok(key) = CString::new(key) else {
            return None;
        };
        let mut buf = vec![0 as c_char; 1024];
        let n = unsafe {
            tailsend_telemetry_ios_remote_string(key.as_ptr(), buf.as_mut_ptr(), 1024)
        };
        if n <= 0 {
            return None;
        }
        let bytes: Vec<u8> = buf[..n as usize].iter().map(|c| *c as u8).collect();
        String::from_utf8(bytes).ok()
    }
}
