# TailSend (Tailcat + Slint) PoC Implementation Status

**Generated**: 2026-09-02  
**Status**: Completed (Phase 0 ~ Phase 4)  
**Upstream Pin**: `tailscale/tailcat` @ `4a25a91e0337252a4d16e097b03cf3cbb92c20cd` (Go 1.27.0)

---

## 1. Executive Summary

The TailSend (Tailcat + Slint) PoC has been fully implemented, built, and verified according to specifications.

- **Direct P2P WireGuard Tunneling**: Uses pinned Tailcat engine with DERP relay auto-negotiation and NAT traversal.
- **Pure CBOR Protocol Framing**: Canonical deterministic CBOR framing for all control and transfer messages.
- **HMAC-SHA-256 Symmetric Proof**: Mutual zero-knowledge proof authenticating peer identities using the invitation secret.
- **Shared Slint Modern UI**: 100% shared Slint declarative UI across Native Desktop and WebAssembly (WASM).
- **Cloudflare Static Assets Compatible**: Gzip streaming WASM decompression via `DecompressionStream("gzip")` bringing the Web WASM payloads to ~7.47 MB (Tailcat) and ~4.76 MB (Slint UI), safely below Cloudflare's 25 MiB single-file limit.

---

## 2. Architecture & Crate Structure

```text
tailcatsend/
├── Cargo.toml                     # Workspace root
├── ui/
│   └── app-window.slint           # Shared modern Slint dark UI
├── crates/
│   ├── tailsend-protocol/         # Pure Rust protocol codecs, HMAC auth, data headers, filename sanitizer
│   ├── tailsend-transport-api/    # DuplexStream, Listener, and TailcatTransport async abstractions
│   ├── tailsend-platform-api/     # Platform storage, file sinks/sources, clipboard, capabilities
│   ├── tailsend-transfer/         # Chunked (64 KiB) stream transfer engine with cancellation & progress
│   ├── tailsend-qr/               # Pure RGBA pixel matrix QR generator (no heavy dependencies)
│   ├── tailsend-core/             # Actor state machine, mock transport hub, full handshake integration tests
│   └── tailsend-ui-controller/    # Slint UI adapter bridging core events to UI properties
├── apps/
│   ├── desktop/                   # Native Windows/macOS/Linux desktop executable
│   └── web/                       # WebAssembly (wasm32-unknown-unknown) web app
├── tailcat/
│   ├── go.mod & go.sum            # Tailcat Go module pinned to 4a25a91
│   ├── include/tailcat_bridge.h   # C ABI header for native platform embedding
│   └── bridge/
│       ├── web/main.go            # Go WASM bridge exporting window.tailSendTailcat
│       └── native/bridge.go       # C-ABI export bridge implementation
├── cloudflare/
│   └── _headers                   # HTTP response headers (CSP, wasm/gzip content types)
└── dist/                          # Static web distribution bundle
    ├── index.html                 # Responsive HTML5 loader with streaming gzip decompressor
    ├── _headers                   # Cloudflare headers
    ├── assets/
    │   ├── wasm_exec.js           # Go WASM support runtime
    │   ├── tailcat.wasm           # Raw Tailcat WASM (31.8 MB)
    │   └── tailcat.wasm.gz        # Gzipped Tailcat WASM (7.47 MB)
    └── pkg/
        ├── tailsend_web.js        # wasm-bindgen JS glue
        ├── tailsend_web_bg.wasm   # Raw Slint UI WASM (11.1 MB)
        └── tailsend_web_bg.wasm.gz # Gzipped Slint UI WASM (4.76 MB)
```

---

## 3. Verification & Test Results

### 3.1 Cargo Test Suite (`cargo test --workspace`)
- `tailsend-protocol`:
  - `test_data_headers`: **PASSED** (Binary headers: 48-byte `TST1` and 60-byte `TSF1`)
  - `test_control_message_framing`: **PASSED** (4-byte length prefix + canonical CBOR)
  - `test_invitation_expiration`: **PASSED** (Time-skew window & TTL validation)
  - `test_invitation_roundtrip`: **PASSED** (URL fragment `#i=...` base64url & QR URL)
  - `test_hmac_proof_verification`: **PASSED** (Constant-time HMAC-SHA256 joiner & host proofs + tamper resistance)
  - `test_filename_sanitizer`: **PASSED** (Windows reserved names, path traversal prevention, UTF-8 emoji support, de-duplication)
- `tailsend-qr`:
  - `test_qr_generation`: **PASSED** (High-DPI scaled RGBA pixel rasterizer)
- `tailsend-core`:
  - `test_mock_handshake_and_bidirectional_text`: **PASSED** (Host listener & Joiner dialing, mutual authentication, state transition to ConnectedIdle, and streaming text data payload over TCP port 101)

### 3.2 Target Compilations
- **Web (WASM)**: `cargo check --target wasm32-unknown-unknown -p tailsend-web` **PASSED** (exit code 0)
- **Desktop (Native)**: `cargo build -p tailsend-desktop` **PASSED** (`target/debug/tailsend.exe` created)
- **Tailcat Go WASM**: `go build -ldflags "-s -w"` **PASSED** (`tailcat.wasm` & `tailcat.wasm.gz` created)

---

## 4. Web Deployment & Compression Stats

| Asset | Raw Size | Compressed (Gzip) | % of CF 25MB Limit |
|---|---|---|---|
| `tailcat.wasm` | 31.89 MB | **7.47 MB** | 29.8% |
| `tailsend_web_bg.wasm` | 11.12 MB | **4.76 MB** | 19.0% |
| `tailsend_web.js` + `wasm_exec.js` | 102 KB | **24 KB** | < 0.1% |
| `index.html` | 3.5 KB | **1.2 KB** | < 0.1% |
| **Total Web Payload** | 43.1 MB | **~12.3 MB** | **49.2%** |

---

## 5. Security & Protocol Compliance

1. **Invitation & Proofs**:
   - Invitation URLs contain `#i=<base64url>` in the URL hash fragment, ensuring secrets are never sent to web servers or logged in HTTP access logs.
   - Handshake mutual proof incorporates session IDs, nonces, node addresses, and peer info to prevent replay, impersonation, and MITM attacks.
2. **Path Traversal Protection**:
   - `sanitize_filename` strips absolute path prefixes (`C:\`, `/`), directory navigation (`../`, `..\`), controls characters, and Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`).
3. **Control Stream Framing**:
   - Big-endian 4-byte frame length prefix enforced with `MAX_CONTROL_FRAME_SIZE` (64 KiB) limit to protect against OOM attacks.
