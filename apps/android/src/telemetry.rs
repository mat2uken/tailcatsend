//! Firebase-backed telemetry for Android.
//!
//! All calls go through `jp.yasagure.ponlet.TelemetryBridge` static methods
//! (see app/src/main/java/jp/yasagure/ponlet/TelemetryBridge.kt). The bridge
//! guards Firebase initialization, so every JNI failure (missing JVM, missing
//! class, Firebase not configured, pending exception) degrades to a no-op and
//! the app keeps working without Firebase configuration.

use std::sync::OnceLock;

use jni::objects::{Global, JClass, JObject, JString, JValue, JValueOwned};
use jni::{jni_sig, jni_str, Env, JavaVM};
use tailsend_telemetry::TelemetryBackend;

static JVM: OnceLock<JavaVM> = OnceLock::new();
static BRIDGE_CLASS: OnceLock<Global<JClass>> = OnceLock::new();

/// Finds `TelemetryBridge` through the APK classloader. A plain `FindClass`
/// from a native thread resolves against the system classloader, which cannot
/// see APK classes on a real device, so the class is loaded once through the
/// activity's loader (`LoaderContext::FromObject`) and cached as a global ref.
fn find_bridge_class<'local>(
    env: &mut Env<'local>,
    loader_obj: Option<&JObject<'local>>,
) -> jni::errors::Result<&'static Global<JClass<'static>>> {
    if let Some(class) = BRIDGE_CLASS.get() {
        return Ok(class);
    }
    let class: JClass<'local> = match loader_obj {
        Some(obj) => {
            // Context.getClassLoader() returns the APK's PathClassLoader.
            // Class.getClassLoader() on the NativeActivity object would give
            // the framework's BootClassLoader, which cannot see APK classes.
            use jni::refs::Reference as _;
            let loader_obj = env
                .call_method(
                    obj,
                    jni_str!("getClassLoader"),
                    jni_sig!("()Ljava/lang/ClassLoader;"),
                    &[],
                )?
                .l()?;
            let loader = unsafe { jni::objects::JClassLoader::from_raw(env, loader_obj.as_raw()) };
            let name = env.new_string("jp.yasagure.ponlet.TelemetryBridge")?;
            match JClass::for_name_with_loader(env, name, true, &loader) {
                Ok(class) => class,
                Err(_) => {
                    // Surface the Java-side exception (ClassNotFoundException,
                    // NoClassDefFoundError, LinkageError, ...) to logcat.
                    env.exception_describe();
                    env.exception_clear();
                    return Err(jni::errors::Error::NoClassDefFound {
                        requested: "jp.yasagure.ponlet.TelemetryBridge".to_string(),
                        cause: None,
                    });
                }
            }
        }
        None => env.load_class(jni_str!("jp.yasagure.ponlet.TelemetryBridge"))?,
    };
    let global = env.new_global_ref(class)?;
    let _ = BRIDGE_CLASS.set(global);
    Ok(BRIDGE_CLASS.get().unwrap())
}

pub struct AndroidTelemetryBackend;

/// Captures the JavaVM and bootstraps Firebase via
/// `TelemetryBridge.initAndEnabled(context)`. Returns the persisted opt-in
/// state (false when the JVM or bridge is unavailable).
pub fn init(app: &android_activity::AndroidApp) -> bool {
    if JVM.get().is_none() {
        // Safety: `vm_as_ptr` is a valid JavaVM pointer for the process lifetime.
        let vm = unsafe { JavaVM::from_raw(app.vm_as_ptr().cast()) };
        let _ = JVM.set(vm);
    }
    let Some(vm) = JVM.get() else { return false };

    let activity_raw = app.activity_as_ptr() as jni::sys::jobject;
    let result: Result<bool, jni::errors::Error> = vm.attach_current_thread(
        |env: &mut Env| -> jni::errors::Result<bool> {
            let activity = unsafe { JObject::from_raw(env, activity_raw) };
            let class = find_bridge_class(env, Some(&activity))?;
            let ret = env.call_static_method(
                class,
                jni_str!("initAndEnabled"),
                jni_sig!("(Landroid/content/Context;)Z"),
                &[JValue::Object(&activity)],
            )?;
            Ok(ret.z().unwrap_or(false))
        },
    );
    match result {
        Ok(enabled) => enabled,
        Err(e) => {
            log::warn!("[Telemetry] initAndEnabled failed, telemetry disabled: {}", e);
            false
        }
    }
}

fn json_params(params: &[(String, String)]) -> String {
    let mut obj = serde_json::Map::new();
    for (key, value) in params {
        obj.insert(key.clone(), serde_json::Value::String(value.clone()));
    }
    serde_json::Value::Object(obj).to_string()
}

impl AndroidTelemetryBackend {
    fn os_version(&self) -> Option<String> {
        let vm = JVM.get()?;
        let result: Result<Option<String>, jni::errors::Error> =
            vm.attach_current_thread(|env: &mut Env| -> jni::errors::Result<Option<String>> {
                let class = find_bridge_class(env, None)?;
                let ret = env.call_static_method(
                    class,
                    jni_str!("osVersion"),
                    jni_sig!("()Ljava/lang/String;"),
                    &[],
                )?;
                Ok(jstring_from_value(env, ret))
            });
        result.ok().flatten()
    }

    fn language(&self) -> Option<String> {
        let vm = JVM.get()?;
        let result: Result<Option<String>, jni::errors::Error> =
            vm.attach_current_thread(|env: &mut Env| -> jni::errors::Result<Option<String>> {
                let class = find_bridge_class(env, None)?;
                let ret = env.call_static_method(
                    class,
                    jni_str!("language"),
                    jni_sig!("()Ljava/lang/String;"),
                    &[],
                )?;
                Ok(jstring_from_value(env, ret))
            });
        result.ok().flatten()
    }
}

fn jstring_from_value(env: &mut Env<'_>, value: JValueOwned<'_>) -> Option<String> {
    match value {
        JValueOwned::Object(obj) if !obj.is_null() => {
            let jstr = unsafe { JString::from_raw(env, obj.into_raw()) };
            jstr.try_to_string(env).ok()
        }
        _ => None,
    }
}

impl TelemetryBackend for AndroidTelemetryBackend {
    fn log_event(&self, name: &str, params: &[(String, String)]) {
        let Some(vm) = JVM.get() else { return };
        let name = name.to_string();
        let json = json_params(params);
        let result: Result<(), jni::errors::Error> =
            vm.attach_current_thread(|env: &mut Env| -> jni::errors::Result<()> {
                let jname = env.new_string(&name)?;
                let jjson = env.new_string(&json)?;
                let class = find_bridge_class(env, None)?;
                env.call_static_method(
                class,
                    jni_str!("logEvent"),
                    jni_sig!("(Ljava/lang/String;Ljava/lang/String;)V"),
                    &[JValue::Object(&jname), JValue::Object(&jjson)],
                )?;
                Ok(())
            });
        if let Err(e) = result {
            log::debug!("[Telemetry] logEvent({}) failed: {}", name, e);
        }
    }

    fn set_user_property(&self, name: &str, value: &str) {
        let Some(vm) = JVM.get() else { return };
        let name = name.to_string();
        let value = value.to_string();
        let result: Result<(), jni::errors::Error> =
            vm.attach_current_thread(|env: &mut Env| -> jni::errors::Result<()> {
                let jname = env.new_string(&name)?;
                let jvalue = env.new_string(&value)?;
                let class = find_bridge_class(env, None)?;
                env.call_static_method(
                class,
                    jni_str!("setUserProperty"),
                    jni_sig!("(Ljava/lang/String;Ljava/lang/String;)V"),
                    &[JValue::Object(&jname), JValue::Object(&jvalue)],
                )?;
                Ok(())
            });
        if let Err(e) = result {
            log::debug!("[Telemetry] setUserProperty({}) failed: {}", name, e);
        }
    }

    fn set_collection_enabled(&self, enabled: bool) {
        let Some(vm) = JVM.get() else { return };
        let result: Result<(), jni::errors::Error> =
            vm.attach_current_thread(|env: &mut Env| -> jni::errors::Result<()> {
                let class = find_bridge_class(env, None)?;
                env.call_static_method(
                class,
                    jni_str!("setEnabled"),
                    jni_sig!("(Z)V"),
                    &[JValue::Bool(enabled)],
                )?;
                Ok(())
            });
        if let Err(e) = result {
            log::debug!("[Telemetry] setEnabled({}) failed: {}", enabled, e);
        }
    }

    fn remote_config_string(&self, key: &str) -> Option<String> {
        let vm = JVM.get()?;
        let key = key.to_string();
        let result: Result<Option<String>, jni::errors::Error> =
            vm.attach_current_thread(|env: &mut Env| -> jni::errors::Result<Option<String>> {
                let jkey = env.new_string(&key)?;
                let class = find_bridge_class(env, None)?;
                let ret = env.call_static_method(
                    class,
                    jni_str!("remoteString"),
                    jni_sig!("(Ljava/lang/String;)Ljava/lang/String;"),
                    &[JValue::Object(&jkey)],
                )?;
                Ok(jstring_from_value(env, ret))
            });
        result.ok().flatten()
    }
}

/// Installs the Android telemetry backend and emits the standard startup
/// events / user properties. Returns the initial enabled state.
pub fn startup(app: &android_activity::AndroidApp) -> bool {
    let initial_enabled = init(app);
    tailsend_telemetry::init(Box::new(AndroidTelemetryBackend), initial_enabled);

    let backend = AndroidTelemetryBackend;
    let os_version = backend.os_version().unwrap_or_default();
    let language = backend.language().unwrap_or_else(|| "en".to_string());

    tailsend_telemetry::events::app_start(
        "android",
        &os_version,
        env!("CARGO_PKG_VERSION"),
        &language,
    );
    tailsend_telemetry::set_user_property("platform", "android");
    tailsend_telemetry::set_user_property("app_version", env!("CARGO_PKG_VERSION"));
    tailsend_telemetry::set_user_property("os_version", &os_version);
    tailsend_telemetry::set_user_property("language", &language);
    initial_enabled
}
