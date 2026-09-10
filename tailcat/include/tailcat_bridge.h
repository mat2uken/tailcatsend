#ifndef TAILSEND_TAILCAT_BRIDGE_H
#define TAILSEND_TAILCAT_BRIDGE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef uint64_t tc_handle_t;

#define TC_INVALID_HANDLE ((tc_handle_t)0)

typedef enum tc_result {
    TC_OK = 0,
    TC_EOF = 1,
    TC_TIMEOUT = 2,
    TC_CANCELLED = 3,
    TC_INVALID_ARGUMENT = 10,
    TC_INVALID_HANDLE_ERROR = 11,
    TC_ALREADY_CLOSED = 12,
    TC_BUFFER_TOO_SMALL = 13,
    TC_NETWORK_ERROR = 20,
    TC_PROTOCOL_ERROR = 21,
    TC_INTERNAL_ERROR = 255
} tc_result_t;

typedef enum tc_event_type {
    TC_EVENT_NONE = 0,
    TC_EVENT_INCOMING_STREAM = 1,
    TC_EVENT_LISTENER_ERROR = 2,
    TC_EVENT_STREAM_ERROR = 3,
    TC_EVENT_LOG = 4
} tc_event_type_t;

typedef enum tc_transport_type {
    TC_TRANSPORT_DIRECT_UDP = 0,
    TC_TRANSPORT_WEBRTC = 1,
    TC_TRANSPORT_DERP = 2,
    TC_TRANSPORT_UNKNOWN = 255
} tc_transport_type_t;

typedef struct tc_event {
    uint32_t struct_size;
    uint32_t event_type;
    tc_handle_t owner_handle;
    tc_handle_t object_handle;
    uint16_t port;
    uint16_t reserved;
    int32_t status_code;
} tc_event_t;

/* Initialize bridge-global resources. Idempotent; may follow tc_shutdown. */
tc_result_t tc_init(void);

/* Close all handles and stop bridge resources. Intended for process teardown. */
tc_result_t tc_shutdown(void);

/*
 * Create and start an ephemeral listener.
 * derp_map_url is UTF-8 and not NUL-terminated.
 */
tc_result_t tc_listener_create(
    const uint8_t *derp_map_url,
    size_t derp_map_url_len,
    uint8_t verbose,
    tc_handle_t *out_listener);

/*
 * Copy listener address. With buffer=NULL/capacity=0, required length is
 * returned through out_length and TC_BUFFER_TOO_SMALL is expected.
 */
tc_result_t tc_listener_address(
    tc_handle_t listener,
    uint8_t *buffer,
    size_t capacity,
    size_t *out_length);

tc_result_t tc_listener_close(tc_handle_t listener);

/*
 * Wait for one bridge event. timeout_ms=UINT32_MAX means infinite.
 * Incoming stream ownership transfers to the caller through object_handle.
 */
tc_result_t tc_wait_event(uint32_t timeout_ms, tc_event_t *out_event);

/* Dial a Tailcat address and port. Address and DERP URL are UTF-8 slices. */
tc_result_t tc_stream_dial(
    const uint8_t *address,
    size_t address_len,
    const uint8_t *derp_map_url,
    size_t derp_map_url_len,
    uint16_t port,
    uint32_t timeout_ms,
    tc_handle_t *out_stream);

/*
 * Start a cancellable dial and wait for its result separately. After cancel,
 * wait again to consume the terminal result. One waiter consumes a result;
 * further waits return TC_INVALID_HANDLE_ERROR. A timeout does not consume it.
 */
tc_result_t tc_stream_dial_start(
    const uint8_t *address,
    size_t address_len,
    const uint8_t *derp_map_url,
    size_t derp_map_url_len,
    uint16_t port,
    uint32_t timeout_ms,
    tc_handle_t *out_operation);

tc_result_t tc_stream_dial_wait(
    tc_handle_t operation,
    uint32_t timeout_ms,
    tc_handle_t *out_stream);

/*
 * Read up to capacity bytes. out_read is valid for every returned status.
 * When out_read>0 and the status is TC_EOF or another error, consume those
 * bytes first and handle the status on the following read. TC_EOF with zero
 * bytes means an orderly peer half-close. Only one concurrent read per stream.
 */
tc_result_t tc_stream_read(
    tc_handle_t stream,
    uint8_t *buffer,
    size_t capacity,
    size_t *out_read,
    uint32_t timeout_ms);

/* Write one buffer and preserve partial progress on an error. */
tc_result_t tc_stream_write(
    tc_handle_t stream,
    const uint8_t *buffer,
    size_t length,
    size_t *out_written,
    uint32_t timeout_ms);

/* Compatibility wrapper that writes the complete buffer or returns an error. */
tc_result_t tc_stream_write_all(
    tc_handle_t stream,
    const uint8_t *buffer,
    size_t length,
    uint32_t timeout_ms);

tc_result_t tc_stream_close_write(tc_handle_t stream);
tc_result_t tc_stream_close(tc_handle_t stream);

/* Return the currently selected path for an established stream. */
tc_result_t tc_stream_transport(tc_handle_t stream, uint8_t *out_transport);

/*
 * Best-effort cancellation for a blocking operation on a handle.
 */
tc_result_t tc_cancel(tc_handle_t handle);

/*
 * Copy the most recent user-safe bridge diagnostic. Must never contain keys,
 * full ConnBlob, or payload data.
 */
tc_result_t tc_last_error(
    uint8_t *buffer,
    size_t capacity,
    size_t *out_length);

/* Version/commit metadata for diagnostics and compatibility reports. */
tc_result_t tc_bridge_version(
    uint8_t *buffer,
    size_t capacity,
    size_t *out_length);

#ifdef __cplusplus
}
#endif

#endif /* TAILSEND_TAILCAT_BRIDGE_H */
