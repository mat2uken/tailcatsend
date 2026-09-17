# Ponlet Share session

Standalone native sender for the iOS Share Extension. Build with
`cargo build -p ponlet-share-session --target aarch64-apple-ios --release`.
The Swift target links `libponlet_share_session.a` and its selected `libtailcat`
archive. This crate does not initialize Tauri, WebView or Firebase.

The C interface is in `include/ponlet_share_session.h`. `start` copies JSON and
the invite before returning. File checks, connection and transfer execute on a
small background Tokio runtime. Poll `snapshot` and free each returned string.
Cancel and release return without waiting for network cleanup. A maximum of two
unreleased handles prevents accidental unbounded sessions.

Items are an array of `{id, kind, name, size, path, mime?}`. `kind` is `file` or
`text`; paths must be absolute regular files. Empty/duplicate IDs, oversized
text (over 1 MiB), changed file sizes and symlinks are rejected. Files are read
in 64 KiB chunks; text is read with a strict 1 MiB bound. The Swift caller owns
staging files and must keep unsent files available through cancellation and
retry. A new handle must receive only the remaining items when retrying.

Snapshot fields are `state`, `inviteUrl?`, `peerName?`, `currentName?`, `done`,
`total`, `completedIds`, and `error?`. Byte counts cover the entire queue.
States are `preparing`, `waiting`, `connecting`, `sending`, `completed`,
`cancelled`, or `error`. `completedIds` retains earlier successful sends after
cancellation or error and never includes the interrupted item.

The live transfer protocol is the same as existing Ponlet peers. Success means
the sender completed payload writes and stream closure; this protocol has no
application-level acknowledgement of receiver persistence. Do not present
these IDs as proof of a remote disk commit. This extension is an outgoing-only
session and does not handle incoming files or text.
