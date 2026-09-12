//! Native document actions and the existing mobile telemetry integration.
//! File bytes never pass through the WebView.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(mobile)]
mod mobile;
#[cfg(mobile)]
pub use mobile::*;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ponlet-platform")
        .setup(|_app, _api| {
            #[cfg(mobile)]
            mobile::install(_app, _api)?;
            Ok(())
        })
        .build()
}
