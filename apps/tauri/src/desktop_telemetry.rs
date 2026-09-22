use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use log::debug;
use tailsend_telemetry::TelemetryBackend;

use crate::model::{hex_id, new_id};

const COLLECT_URL: &str = "https://www.google-analytics.com/mp/collect";
const STORE_FILE: &str = "telemetry.json";

/// Persistent client identity: client_id + session_id + opt-out flag.
/// session_id is a random value combined with the startup date, as GA4 does
/// not require a specific format for Measurement Protocol sessions.
#[derive(serde::Serialize, serde::Deserialize)]
struct ClientStore {
    client_id: String,
    #[serde(default)]
    session_id: String,
    #[serde(default = "default_enabled")]
    enabled: bool,
}

fn default_enabled() -> bool {
    true
}

/// GA4 Measurement Protocol backend. Requires GA4_MEASUREMENT_ID and
/// GA4_API_SECRET; otherwise a no-op backend is installed instead (nothing is
/// sent, but the opt-out flag is still persisted so the choice survives).
struct Ga4Backend {
    client_id: String,
    session_id: String,
    measurement_id: String,
    api_secret: String,
    user_properties: std::sync::Mutex<Vec<(String, String)>>,
}

struct NoopBackend;

/// Installs the telemetry backend and restores the persisted enabled state.
pub fn init(language: &str) {
    let store = load_or_create_store();

    let backend: Box<dyn TelemetryBackend> = match (
        std::env::var("GA4_MEASUREMENT_ID"),
        std::env::var("GA4_API_SECRET"),
    ) {
        (Ok(id), Ok(secret)) if !id.is_empty() && !secret.is_empty() => Box::new(Ga4Backend {
            client_id: store.client_id.clone(),
            session_id: store.session_id.clone(),
            measurement_id: id,
            api_secret: secret,
            user_properties: std::sync::Mutex::new(vec![
                ("platform".to_string(), "desktop".to_string()),
                (
                    "app_version".to_string(),
                    env!("CARGO_PKG_VERSION").to_string(),
                ),
                ("os_version".to_string(), std::env::consts::OS.to_string()),
                ("language".to_string(), language.to_string()),
            ]),
        }),
        _ => Box::new(NoopBackend),
    };

    tailsend_telemetry::init(backend, store.enabled);
}

impl TelemetryBackend for Ga4Backend {
    fn log_event(&self, name: &str, params: &[(String, String)]) {
        let mut params_json = serde_json::Map::new();
        params_json.insert("session_id".to_string(), serde_json::json!(self.session_id));
        params_json.insert("engagement_time_msec".to_string(), serde_json::json!("100"));
        for (key, value) in params {
            params_json.insert(key.clone(), serde_json::json!(value));
        }

        let mut user_properties = serde_json::Map::new();
        if let Ok(props) = self.user_properties.lock() {
            for (key, value) in props.iter() {
                user_properties.insert(key.clone(), serde_json::json!({ "value": value }));
            }
        }

        let timestamp_micros = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_micros() as u64)
            .unwrap_or(0);

        let body = serde_json::json!({
            "client_id": self.client_id,
            "timestamp_micros": timestamp_micros,
            "user_properties": user_properties,
            "events": [{ "name": name, "params": params_json }],
        })
        .to_string();

        let url = format!(
            "{}?measurement_id={}&api_secret={}",
            COLLECT_URL, self.measurement_id, self.api_secret
        );
        let event_name = name.to_string();

        // Fire-and-forget so the UI is never blocked; failures are logged and
        // never retried.
        std::thread::spawn(move || {
            if let Err(e) = ureq::post(&url)
                .set("Content-Type", "application/json")
                .send(body.as_bytes())
            {
                debug!("GA4 event {} not sent: {}", event_name, e);
            }
        });
    }

    fn set_user_property(&self, name: &str, value: &str) {
        if let Ok(mut props) = self.user_properties.lock() {
            if let Some(entry) = props.iter_mut().find(|(k, _)| k == name) {
                entry.1 = value.to_string();
            } else {
                props.push((name.to_string(), value.to_string()));
            }
        }
    }

    fn set_collection_enabled(&self, enabled: bool) {
        persist_enabled(enabled);
    }
}

impl TelemetryBackend for NoopBackend {
    fn log_event(&self, _name: &str, _params: &[(String, String)]) {}
    fn set_user_property(&self, _name: &str, _value: &str) {}
    fn set_collection_enabled(&self, enabled: bool) {
        persist_enabled(enabled);
    }
}

fn config_dir() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".config").join("tailcatsend")
    } else {
        PathBuf::from(".tailcatsend")
    }
}

fn store_path() -> PathBuf {
    config_dir().join(STORE_FILE)
}

fn load_or_create_store() -> ClientStore {
    let path = store_path();
    let existing = fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str::<ClientStore>(&content).ok());
    let enabled = match existing {
        Some(store) if !store.client_id.is_empty() => return store,
        // Preserve an existing opt-out when only the identity needs repair.
        Some(store) => store.enabled,
        None => true,
    };

    let session_date = chrono_date_today();
    let store = ClientStore {
        client_id: new_uuid_v4(),
        session_id: format!("{}-{}", hex_id(new_id()), session_date),
        enabled,
    };
    save_store(&store);
    store
}

fn persist_enabled(enabled: bool) {
    let path = store_path();
    let mut store = fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str::<ClientStore>(&c).ok())
        .unwrap_or_else(|| ClientStore {
            client_id: new_uuid_v4(),
            session_id: format!("{}-{}", hex_id(new_id()), chrono_date_today()),
            enabled,
        });
    store.enabled = enabled;
    save_store(&store);
}

fn save_store(store: &ClientStore) {
    let path = store_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(store) {
        let _ = fs::write(&path, json);
    }
}

fn chrono_date_today() -> String {
    // Days since epoch converted to YYYYMMDD without external crates.
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let (y, m, d) = civil_from_days(days as i64);
    format!("{:04}{:02}{:02}", y, m, d)
}

/// Howard Hinnant's civil_from_days algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn new_uuid_v4() -> String {
    let mut bytes = new_id();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex_id(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_uuid_v4_format() {
        let id = new_uuid_v4();
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 5);
        assert_eq!(
            parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12]
        );
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        assert_eq!(&id[14..15], "4");
        assert!(matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    }

    #[test]
    fn test_civil_from_days() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
    }
}
