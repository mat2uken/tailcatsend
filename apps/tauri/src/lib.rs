//! Tauri application service for the WebView UI.
//!
//! The WebView only exchanges metadata with this module. Tailcat streams and
//! file handles stay in the native process, while the shared Rust transfer
//! engine owns framing, byte counts, cancellation and save completion.

use tauri::{Manager, RunEvent};

use tailsend_core::SessionState;
use tailsend_native_transport::NativeTailcatTransport;

#[cfg(target_os = "android")]
mod android;
pub mod commands;
mod ipc;
pub mod model;
pub mod runtime;
mod scheme;
pub mod storage;

pub use commands::*;
pub use model::*;
pub use runtime::*;
pub use storage::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime = TauriRuntime::new().expect("Tailcat bridge initialization failed");
    let app = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("ponletbin", scheme::handle)
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(runtime)
        .invoke_handler(tauri::generate_handler![
            commands::ponlet_snapshot,
            commands::ponlet_subscribe,
            commands::ponlet_wait_event,
            commands::ponlet_unsubscribe,
            commands::ponlet_create_invite,
            commands::ponlet_join,
            commands::ponlet_send_text,
            commands::ponlet_send_files,
            commands::ponlet_pick_and_send_files,
            commands::ponlet_save_text,
            commands::ponlet_qr_code,
            commands::ponlet_cancel_transfer,
            commands::ponlet_disconnect,
            commands::ponlet_open_received,
        ])
        .setup(|app| {
            let state = app.state::<TauriRuntime>();
            state.configure_storage(app.handle());
            state.set_state(SessionState::Disconnected {
                reason: "ready".to_string(),
            });
            #[cfg(target_os = "android")]
            android::install(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Ponlet");
    app.run(|_app, event| {
        if matches!(event, RunEvent::Exit) {
            let _ = NativeTailcatTransport::shutdown();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use tailsend_core::BackendService;
    use tailsend_native_transport::NativeTailcatTransport;
    use tailsend_transport_api::{ListenOptions, TailcatTransport, TransportPath};
    use tauri_plugin_fs::FilePath;

    #[test]
    fn picker_file_name_keeps_paths_and_has_a_fallback() {
        let path = "/tmp/report.txt"
            .parse::<FilePath>()
            .expect("FilePath parsing is infallible");
        assert_eq!(picker_file_name(&path, 0, None), "report.txt");
        assert_eq!(
            picker_file_name(&path, 0, Some("android-real.bin")),
            "android-real.bin"
        );

        let uri = "content://com.example.documents/document/primary%3Areport.txt"
            .parse::<FilePath>()
            .expect("FilePath parsing is infallible");
        assert_eq!(picker_file_name(&uri, 1, None), "report.txt");

        let raw = "raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2Fandroid-real.bin"
            .parse::<FilePath>()
            .expect("FilePath parsing is infallible");
        assert_eq!(picker_file_name(&raw, 2, None), "android-real.bin");

        let opaque = "content://picker/"
            .parse::<FilePath>()
            .expect("FilePath parsing is infallible");
        assert_eq!(picker_file_name(&opaque, 3, None), "selected-file-4");
    }

    #[test]
    fn qr_bitmap_has_rgba_pixels_for_invitation() {
        let image = ponlet_qr_code_impl("https://ponlet.example/#i=test".to_string())
            .expect("QR should encode");
        assert!(image.width >= 256);
        assert_eq!(image.width, image.height);
        assert_eq!(
            image.rgba_pixels.len(),
            (image.width * image.height * 4) as usize
        );
    }

    #[test]
    fn received_open_rejects_paths_not_reported_by_the_service() {
        let items = vec![UiReceivedItem {
            name: "report.txt".to_string(),
            size: 12,
            local_path_or_handle: "/tmp/ponlet/report.txt".to_string(),
        }];
        assert!(received_path_allowed(&items, "/tmp/ponlet/report.txt"));
        assert!(!received_path_allowed(&items, "/etc/passwd"));
    }

    #[test]
    fn received_name_skips_all_existing_collision_suffixes() {
        let existing = [
            "report.txt".to_string(),
            "report (1).txt".to_string(),
            "report (2).txt".to_string(),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            unique_received_name(&existing, "report.txt"),
            "report (3).txt"
        );
    }

    #[tokio::test]
    async fn stale_session_cannot_replace_or_clear_current_session() {
        let hub = tailsend_core::MockNetworkHub::new();
        let listener = hub
            .listen(ListenOptions {
                derp_map_url: String::new(),
                verbose: false,
            })
            .await
            .expect("mock listener");
        let runtime = TauriRuntime {
            backend: BackendService::default(),
            transport: Arc::new(NativeTailcatTransport),
            state: Mutex::new(RuntimeState {
                session: None,
                active_transfer: None,
            }),
            downloads_dir: Mutex::new(PathBuf::from("/tmp/ponlet-test")),
            received: Arc::new(Mutex::new(Vec::new())),
            subscriptions: Mutex::new(HashMap::new()),
            subscription_cancellers: Mutex::new(HashMap::new()),
            closed_subscriptions: Mutex::new(HashSet::new()),
        };
        let current = Arc::new(PeerSession {
            listener: Arc::new(listener),
            peer_address: Mutex::new(String::new()),
            cancel: Arc::new(AtomicBool::new(false)),
            transport_path: Mutex::new(TransportPath::Unknown),
        });
        let stale = Arc::new(PeerSession {
            listener: current.listener.clone(),
            peer_address: Mutex::new(String::new()),
            cancel: Arc::new(AtomicBool::new(true)),
            transport_path: Mutex::new(TransportPath::Unknown),
        });
        runtime.set_session(current.clone());

        assert!(!runtime.session_is_current(&stale));
        assert!(!runtime.take_session_if_current(&stale));
        assert!(runtime.session_is_current(&current));
        assert!(runtime.take_session_if_current(&current));
        assert!(!runtime.session_is_current(&current));
    }
}
