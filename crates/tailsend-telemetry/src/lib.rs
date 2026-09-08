//! Common telemetry foundation shared by all platforms.
//!
//! Platform integrations implement [`TelemetryBackend`] and register it via
//! [`init`]. The global layer only keeps the enabled state in memory
//! (opt-out: default is enabled); persistence is each platform backend's
//! responsibility (see [`TelemetryBackend::set_collection_enabled`]).
//!
//! # Guardrails
//!
//! Never send the following data in events: file names, file paths, transfer
//! contents (text bodies / file bytes), session secrets (keys, tokens,
//! addresses), or personal information. Only coarse counters and enumerated
//! strings defined in [`events`] are allowed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

pub trait TelemetryBackend: Send + Sync {
    /// イベント送信。params は (キー, 値) のペア。値はすべて文字列
    fn log_event(&self, name: &str, params: &[(String, String)]);
    /// ユーザープロパティ設定 (例: Firebase setUserProperty)
    fn set_user_property(&self, _name: &str, _value: &str) {}
    /// SDKレベルの収集有効/無効制御 (例: Firebase setAnalyticsCollectionEnabled)
    fn set_collection_enabled(&self, enabled: bool);
    /// Remote Config 相当の文字列取得 (未設定時は None)
    fn remote_config_string(&self, _key: &str) -> Option<String> {
        None
    }
}

static BACKEND: Mutex<Option<Box<dyn TelemetryBackend>>> = Mutex::new(None);
static ENABLED: AtomicBool = AtomicBool::new(true);

/// Registers the platform backend and applies the persisted enabled state.
pub fn init(backend: Box<dyn TelemetryBackend>, initial_enabled: bool) {
    ENABLED.store(initial_enabled, Ordering::SeqCst);
    if let Ok(mut guard) = BACKEND.lock() {
        *guard = Some(backend);
    }
}

/// Logs an event. No-op before `init` or while collection is disabled.
pub fn log_event(name: &str, params: &[(&str, &str)]) {
    if !is_enabled() {
        return;
    }
    let converted: Vec<(String, String)> =
        params.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    if let Ok(guard) = BACKEND.lock() {
        if let Some(backend) = guard.as_ref() {
            backend.log_event(name, &converted);
        }
    }
}

/// Updates the enabled flag and notifies the backend (e.g. so it can persist
/// the choice and disable SDK-level collection).
pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
    if let Ok(guard) = BACKEND.lock() {
        if let Some(backend) = guard.as_ref() {
            backend.set_collection_enabled(enabled);
        }
    }
}

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Sets a user property. No-op while collection is disabled.
pub fn set_user_property(name: &str, value: &str) {
    if !is_enabled() {
        return;
    }
    if let Ok(guard) = BACKEND.lock() {
        if let Some(backend) = guard.as_ref() {
            backend.set_user_property(name, value);
        }
    }
}

/// Logs the standard `error` event. `category` is an enumerated string; never
/// include error message bodies (they may contain paths or peer addresses).
pub fn record_error(category: &str) {
    log_event("error", &[("category", category)]);
}

/// Remote Config equivalent. Returns `default_value` when disabled or before
/// `init`.
pub fn remote_string(key: &str, default_value: &str) -> String {
    if !is_enabled() {
        return default_value.to_string();
    }
    if let Ok(guard) = BACKEND.lock() {
        if let Some(backend) = guard.as_ref() {
            return backend.remote_config_string(key).unwrap_or_else(|| default_value.to_string());
        }
    }
    default_value.to_string()
}

/// Buckets free-form text lengths so raw sizes (and never contents) are sent.
pub fn length_bucket(chars: usize) -> &'static str {
    match chars {
        0..=20 => "xs",
        21..=100 => "s",
        101..=500 => "m",
        501..=2000 => "l",
        _ => "xl",
    }
}

/// Standard events. Parameter values are plain strings; numeric values are
/// formatted here.
///
/// # Guardrails
///
/// - No file names or paths (only counts and byte sizes)
/// - No transfer contents (text bodies, file bytes, previews)
/// - No session secrets (keys, tokens, tailcat addresses)
/// - No personal information
pub mod events {
    use super::log_event;

    pub fn app_start(platform: &str, os_version: &str, app_version: &str, language: &str) {
        log_event(
            "app_start",
            &[
                ("platform", platform),
                ("os_version", os_version),
                ("app_version", app_version),
                ("language", language),
            ],
        );
    }

    /// Best-effort; not sent when the process is killed.
    pub fn app_end(session_duration_ms: u128) {
        log_event("app_end", &[("session_duration_ms", &session_duration_ms.to_string())]);
    }

    pub fn session_created(transport: &str) {
        log_event("session_created", &[("transport", transport)]);
    }

    pub fn peer_connected(transport: &str) {
        log_event("peer_connected", &[("transport", transport)]);
    }

    /// Byte counts only; file names must never be sent.
    pub fn transfer_started(file_count: usize, transport: &str, direction: &str) {
        log_event(
            "transfer_started",
            &[
                ("file_count", &file_count.to_string()),
                ("transport", transport),
                ("direction", direction),
            ],
        );
    }

    pub fn transfer_completed(
        file_count: usize,
        total_bytes: u64,
        duration_ms: u128,
        transport: &str,
        direction: &str,
    ) {
        log_event(
            "transfer_completed",
            &[
                ("file_count", &file_count.to_string()),
                ("total_bytes", &total_bytes.to_string()),
                ("duration_ms", &duration_ms.to_string()),
                ("transport", transport),
                ("direction", direction),
            ],
        );
    }

    /// `reason` is an enumerated string such as "user"; no transfer details.
    pub fn transfer_cancelled(reason: &str) {
        log_event("transfer_cancelled", &[("reason", reason)]);
    }

    /// No parameters besides the length bucket; text contents must never be
    /// sent.
    pub fn text_message_sent(length_bucket: &str) {
        log_event("text_message_sent", &[("length_bucket", length_bucket)]);
    }

    /// No parameters besides the length bucket; text contents must never be
    /// sent.
    pub fn text_message_received(length_bucket: &str) {
        log_event("text_message_received", &[("length_bucket", length_bucket)]);
    }

    /// `category` is one of "transport" | "storage" | "camera" | "daemon" |
    /// "other". Never include error message bodies.
    pub fn error(category: &str) {
        log_event("error", &[("category", category)]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    static EVENT_COUNT: AtomicUsize = AtomicUsize::new(0);
    static PROPERTY_COUNT: AtomicUsize = AtomicUsize::new(0);
    static LAST_PARAMS: Mutex<Option<(String, Vec<(String, String)>)>> = Mutex::new(None);
    static REMOTE_VALUE: Mutex<Option<String>> = Mutex::new(None);

    struct CountingBackend;

    impl TelemetryBackend for CountingBackend {
        fn log_event(&self, name: &str, params: &[(String, String)]) {
            LAST_PARAMS
                .lock()
                .unwrap()
                .replace((name.to_string(), params.to_vec()));
            EVENT_COUNT.fetch_add(1, AtomicOrdering::SeqCst);
        }
        fn set_user_property(&self, _name: &str, _value: &str) {
            PROPERTY_COUNT.fetch_add(1, AtomicOrdering::SeqCst);
        }
        fn set_collection_enabled(&self, _enabled: bool) {}
        fn remote_config_string(&self, _key: &str) -> Option<String> {
            REMOTE_VALUE.lock().unwrap().clone()
        }
    }

    // The global state is process-wide, so everything is asserted in order
    // inside a single test.
    #[test]
    fn records_events_and_respects_disabled_state() {
        EVENT_COUNT.store(0, AtomicOrdering::SeqCst);
        PROPERTY_COUNT.store(0, AtomicOrdering::SeqCst);
        REMOTE_VALUE.lock().unwrap().take();

        // Before init: log_event is a no-op, remote_string returns default.
        log_event("app_start", &[("platform", "test")]);
        assert_eq!(remote_string("k", "fallback"), "fallback");

        init(Box::new(CountingBackend), true);
        log_event("app_start", &[("platform", "test")]);
        events::error("other");
        set_user_property("platform", "test");
        assert_eq!(2, EVENT_COUNT.load(AtomicOrdering::SeqCst));
        assert_eq!(1, PROPERTY_COUNT.load(AtomicOrdering::SeqCst));
        assert_eq!(
            Some(("error".to_string(), vec![("category".to_string(), "other".to_string())])),
            LAST_PARAMS.lock().unwrap().clone()
        );

        set_enabled(false);
        log_event("app_start", &[]);
        set_user_property("k", "v");
        assert_eq!(2, EVENT_COUNT.load(AtomicOrdering::SeqCst));
        assert_eq!(1, PROPERTY_COUNT.load(AtomicOrdering::SeqCst));
        assert_eq!(remote_string("k", "d"), "d");

        set_enabled(true);
        log_event("app_start", &[]);
        assert_eq!(3, EVENT_COUNT.load(AtomicOrdering::SeqCst));

        // Remote config passthrough.
        *REMOTE_VALUE.lock().unwrap() = Some("value".to_string());
        assert_eq!(remote_string("cfg", "d"), "value");
    }

    #[test]
    fn length_buckets_are_stable() {
        assert_eq!(length_bucket(0), "xs");
        assert_eq!(length_bucket(20), "xs");
        assert_eq!(length_bucket(100), "s");
        assert_eq!(length_bucket(500), "m");
        assert_eq!(length_bucket(2000), "l");
        assert_eq!(length_bucket(2001), "xl");
    }
}
