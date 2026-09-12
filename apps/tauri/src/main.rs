#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Tauri embeds Info.plist in development. Release also ships as a standalone
// executable, so it needs the camera purpose string outside an .app bundle.
#[cfg(all(target_os = "macos", not(dev)))]
tauri::embed_plist::embed_info_plist!("Info.plist");

fn main() {
    tailsend_tauri_lib::run();
}
