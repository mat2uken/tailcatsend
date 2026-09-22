// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

#![cfg(mobile)]

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.tauri.barcodescanner";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_barcode_scanner);

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("barcode-scanner")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            api.register_android_plugin(PLUGIN_IDENTIFIER, "BarcodeScannerPlugin")?;
            #[cfg(target_os = "ios")]
            api.register_ios_plugin(init_plugin_barcode_scanner)?;
            Ok(())
        })
        .build()
}
