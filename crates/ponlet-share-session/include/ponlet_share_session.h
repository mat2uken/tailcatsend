#ifndef PONLET_SHARE_SESSION_H
#define PONLET_SHARE_SESSION_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// UTF-8, NUL-terminated arguments are copied before returning. An empty invite
// hosts a session; a nonempty invite joins it. Invalid JSON returns 0; file and
// network errors appear in snapshot.error. Files remain owned by the caller.
uint64_t ponlet_share_start(const char *items_json, const char *invite_url);
// Returns an owned UTF-8 JSON string, or NULL for an unknown/released handle.
char *ponlet_share_snapshot(uint64_t handle);
// Nonblocking, idempotent. Previously completed IDs are retained on cancel.
void ponlet_share_cancel(uint64_t handle);
void ponlet_share_release(uint64_t handle);
void ponlet_share_string_free(char *value);
#ifdef __cplusplus
}
#endif
#endif
