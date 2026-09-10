//! One FFI declaration point for the native Tailcat bridge.
//!
//! The Go archive/shared library owns the implementation.  This crate only
//! describes the stable C ABI and keeps the small status/handle types shared
//! by Android, iOS, and the future Tauri adapter.  Payload buffers are borrowed
//! for the duration of each call; the bridge must not retain their pointers.

use std::fmt;

pub type TcHandle = u64;

pub const TC_OK: i32 = 0;
pub const TC_EOF: i32 = 1;
pub const TC_TIMEOUT: i32 = 2;
pub const TC_CANCELLED: i32 = 3;
pub const TC_INVALID_ARGUMENT: i32 = 10;
pub const TC_INVALID_HANDLE_ERROR: i32 = 11;
pub const TC_ALREADY_CLOSED: i32 = 12;
pub const TC_BUFFER_TOO_SMALL: i32 = 13;
pub const TC_NETWORK_ERROR: i32 = 20;
pub const TC_PROTOCOL_ERROR: i32 = 21;
pub const TC_INTERNAL_ERROR: i32 = 255;

pub const TC_EVENT_NONE: u32 = 0;
pub const TC_EVENT_INCOMING_STREAM: u32 = 1;
pub const TC_EVENT_LISTENER_ERROR: u32 = 2;
pub const TC_EVENT_STREAM_ERROR: u32 = 3;
pub const TC_EVENT_LOG: u32 = 4;

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct TcEvent {
    pub struct_size: u32,
    pub event_type: u32,
    pub owner_handle: TcHandle,
    pub object_handle: TcHandle,
    pub port: u16,
    pub reserved: u16,
    pub status_code: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TcError(pub i32);

impl TcError {
    pub const fn code(self) -> i32 {
        self.0
    }
}

impl fmt::Display for TcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Tailcat bridge error {}", self.0)
    }
}

impl std::error::Error for TcError {}

/// Convert a C ABI status into a Rust result.  Calls that also return a
/// byte count use this only after consuming the count, so partial progress is
/// never hidden by the status conversion.
pub fn status(code: i32) -> Result<(), TcError> {
    if code == TC_OK {
        Ok(())
    } else {
        Err(TcError(code))
    }
}

extern "C" {
    pub fn tc_init() -> i32;
    pub fn tc_shutdown() -> i32;
    pub fn tc_listener_create(
        derp_map_url: *const u8,
        derp_map_url_len: usize,
        verbose: u8,
        out_listener: *mut TcHandle,
    ) -> i32;
    pub fn tc_listener_address(
        listener: TcHandle,
        buffer: *mut u8,
        capacity: usize,
        out_length: *mut usize,
    ) -> i32;
    pub fn tc_listener_close(listener: TcHandle) -> i32;
    pub fn tc_wait_event(timeout_ms: u32, out_event: *mut TcEvent) -> i32;
    pub fn tc_stream_dial(
        address: *const u8,
        address_len: usize,
        derp_map_url: *const u8,
        derp_map_url_len: usize,
        port: u16,
        timeout_ms: u32,
        out_stream: *mut TcHandle,
    ) -> i32;
    pub fn tc_stream_dial_start(
        address: *const u8,
        address_len: usize,
        derp_map_url: *const u8,
        derp_map_url_len: usize,
        port: u16,
        timeout_ms: u32,
        out_operation: *mut TcHandle,
    ) -> i32;
    pub fn tc_stream_dial_wait(
        operation: TcHandle,
        timeout_ms: u32,
        out_stream: *mut TcHandle,
    ) -> i32;
    pub fn tc_stream_read(
        stream: TcHandle,
        buffer: *mut u8,
        capacity: usize,
        out_read: *mut usize,
        timeout_ms: u32,
    ) -> i32;
    pub fn tc_stream_write(
        stream: TcHandle,
        buffer: *const u8,
        length: usize,
        out_written: *mut usize,
        timeout_ms: u32,
    ) -> i32;
    pub fn tc_stream_write_all(
        stream: TcHandle,
        buffer: *const u8,
        length: usize,
        timeout_ms: u32,
    ) -> i32;
    pub fn tc_stream_close_write(stream: TcHandle) -> i32;
    pub fn tc_stream_close(stream: TcHandle) -> i32;
    pub fn tc_cancel(handle: TcHandle) -> i32;
    pub fn tc_last_error(buffer: *mut u8, capacity: usize, out_length: *mut usize) -> i32;
    pub fn tc_bridge_version(buffer: *mut u8, capacity: usize, out_length: *mut usize) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_keeps_nonzero_code() {
        assert_eq!(status(TC_OK), Ok(()));
        assert_eq!(status(TC_TIMEOUT), Err(TcError(TC_TIMEOUT)));
    }

    #[test]
    fn event_layout_matches_c_header() {
        assert_eq!(std::mem::size_of::<TcEvent>(), 32);
        assert_eq!(std::mem::align_of::<TcEvent>(), 8);
    }
}
