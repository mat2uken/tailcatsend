use tauri::AppHandle;

#[cfg(target_os = "android")]
pub(crate) static SETTINGS_SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(target_os = "android")]
pub(crate) async fn begin_android_intent(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_ponlet_platform::PonletPlatformExt;
    tokio::task::spawn_blocking(move || app.ponlet_platform().begin_telemetry_intent())
        .await.map_err(|_| "native_setting_unavailable".to_string())?
}

static INITIALIZED: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();

/// Restore the existing native preference before the first invitation or event.
/// Mobile calls run away from the UI thread, since plugin replies use that thread.
pub async fn initialize(app: AppHandle, opt_out: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    let stop_intent = if opt_out { Some(begin_android_intent(app.clone()).await?) } else { None };
    #[cfg(target_os = "android")]
    let stop_app = app.clone();
    INITIALIZED
        .get_or_try_init(|| async {
            tokio::task::spawn_blocking(move || initialize_sync(app, opt_out))
                .await
                .map_err(|error| error.to_string())?
        })
        .await?;
    #[cfg(target_os = "android")]
    if let Some(intent) = stop_intent {
        use tauri_plugin_ponlet_platform::PonletPlatformExt;
        let _settings = SETTINGS_SERIAL.lock().await;
        tokio::task::spawn_blocking(move || stop_app.ponlet_platform().set_telemetry_checked(false, intent))
            .await.map_err(|_| "native_setting_unavailable".to_string())??;
        tailsend_telemetry::reflect_native_enabled(false);
    }
    #[cfg(not(target_os = "android"))]
    if opt_out { tailsend_telemetry::set_enabled(false); }
    Ok(())
}

fn initialize_sync(_app: AppHandle, opt_out: bool) -> Result<(), String> {
    #[cfg(mobile)]
    let (language, os_version) = {
        use tauri_plugin_ponlet_platform::PonletPlatformExt;
        let settings = _app.ponlet_platform().initialize_telemetry(opt_out)?;
        (settings.language, settings.os_version)
    };
    #[cfg(desktop)]
    let (language, os_version) = {
        let language = std::env::var("LANG").unwrap_or_else(|_| "en".to_string());
        crate::desktop_telemetry::init(&language);
        if opt_out {
            tailsend_telemetry::set_enabled(false);
        }
        (language, std::env::consts::OS.to_string())
    };
    tailsend_telemetry::events::app_start(
        std::env::consts::OS,
        &os_version,
        env!("CARGO_PKG_VERSION"),
        &language,
    );
    tailsend_telemetry::set_user_property("platform", std::env::consts::OS);
    tailsend_telemetry::set_user_property("app_version", env!("CARGO_PKG_VERSION"));
    tailsend_telemetry::set_user_property("language", &language);
    Ok(())
}
