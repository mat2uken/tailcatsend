//! In-process AVFoundation QR reader. Frames are sent to the WebView through
//! Tauri events; capture stays in the same sandboxed process.

use std::ffi::{c_char, c_void, CStr};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

type ScanResult = Result<Option<String>, String>;

struct ScanContext {
    sender: oneshot::Sender<ScanResult>,
    app: AppHandle,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PreviewPayload<'a> {
    scan_id: u64,
    image: &'a str,
}

extern "C" {
    fn ponlet_macos_scan_qr(
        scan_id: u64,
        context: *mut c_void,
        completion: extern "C" fn(*mut c_void, *const c_char, *const c_char),
        preview_frame: extern "C" fn(*mut c_void, u64, *const c_char),
    );
    fn ponlet_macos_cancel_scan(scan_id: u64);
}

extern "C" fn completed(context: *mut c_void, value: *const c_char, error: *const c_char) {
    // The ObjC side calls this exactly once, with UTF-8 strings valid during
    // this call. Dropping the sender is safe if the WebView has gone away.
    let context = unsafe { Box::from_raw(context.cast::<ScanContext>()) };
    let result = if !error.is_null() {
        Err(unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned())
    } else if !value.is_null() {
        Ok(Some(
            unsafe { CStr::from_ptr(value) }
                .to_string_lossy()
                .into_owned(),
        ))
    } else {
        Ok(None)
    };
    let _ = context.sender.send(result);
}

extern "C" fn preview_frame(context: *mut c_void, scan_id: u64, image: *const c_char) {
    // Both callbacks run on AppKit's main queue. A stopped scanner cannot
    // issue a preview after `completed` has dropped this context.
    if image.is_null() {
        return;
    }
    let context = unsafe { &*context.cast::<ScanContext>() };
    if let Ok(image) = unsafe { CStr::from_ptr(image) }.to_str() {
        let _ = context
            .app
            .emit("ponlet-qr-preview", PreviewPayload { scan_id, image });
    }
}

pub async fn scan(app: AppHandle, scan_id: u64) -> ScanResult {
    let (sender, receiver) = oneshot::channel();
    let context = Box::into_raw(Box::new(ScanContext { sender, app })).cast::<c_void>();
    unsafe { ponlet_macos_scan_qr(scan_id, context, completed, preview_frame) };
    receiver
        .await
        .map_err(|_| "Camera scanner stopped unexpectedly".to_string())?
}

pub fn cancel(scan_id: u64) {
    unsafe { ponlet_macos_cancel_scan(scan_id) };
}
