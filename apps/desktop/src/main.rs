//! Desktop product entry point.
//!
//! The desktop target uses the same Tauri WebView service as the other native
//! shells. Keeping this tiny package name preserves existing launcher commands
//! while removing the legacy Slint/daemon UI path.

fn main() {
    tailsend_tauri_lib::run();
}
