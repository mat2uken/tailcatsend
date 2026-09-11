//! Android WebMessageListener entry point for the shared binary dispatcher.

#![cfg(target_os = "android")]

use std::sync::OnceLock;

use jni::{
    objects::{JByteArray, JObject},
    sys::jbyteArray,
    JNIEnv,
};
use tailsend_ipc::Frame;
use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();

pub(crate) fn install(app: AppHandle) {
    let _ = APP.set(app);
}

/// Dispatch an ArrayBuffer received by `PonletPort` and return the encoded
/// response. Kotlin calls this from a worker thread so a long-running join or
/// transfer never blocks the WebView main thread or a concurrent cancel.
#[unsafe(no_mangle)]
pub extern "C" fn Java_jp_yasagure_ponlet_PonletPort_handleBatch(
    env: JNIEnv<'_>,
    _this: JObject<'_>,
    input: JByteArray<'_>,
) -> jbyteArray {
    let result = (|| {
        let bytes = env.convert_byte_array(&input).ok()?;
        let request = Frame::decode(&bytes).ok()?;
        let app = APP.get()?.clone();
        let response = tauri::async_runtime::block_on(crate::ipc::dispatch(app, request));
        response.encode().ok()
    })();
    match result {
        Some(bytes) => env
            .byte_array_from_slice(&bytes)
            .map(|array| array.into_raw())
            .unwrap_or(std::ptr::null_mut()),
        None => std::ptr::null_mut(),
    }
}
