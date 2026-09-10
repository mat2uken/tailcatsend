# TailSend 🚀

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Native UI](https://img.shields.io/badge/Native_UI-Slint-purple.svg)](https://slint.dev/)
[![Web Client](https://img.shields.io/badge/Web_Client-Cloudflare_Pages-orange.svg)](https://ponlet.mat2uken.app)

> **TailSend** is a modern, secure, cross-platform peer-to-peer (P2P) file transfer application built with **Rust**, **VanJS WebView UI**, and **Tailcat** (WireGuard mesh networking).

Transfer files, photos, videos, and clipboard text directly between devices without cloud intermediaries, file size limits, or complicated network setups.

---

## ✨ Key Features

- ⚡ **Zero-Configuration P2P Direct Transfer**  
  Establish direct, encrypted connections simply by scanning a QR code or opening a one-time invitation link.
- 🔒 **End-to-End Security & Mutual Authentication**  
  - Mutual proof of identity via **HMAC-SHA-256**.
  - Invitation tokens reside exclusively in the URL hash fragment (`#i=...`), ensuring keys never hit web servers or access logs.
- 🌐 **True Multi-Platform Support**  
  - **Desktop**: Windows (x86_64), macOS (Apple Silicon & Intel Universal), Linux
  - **Mobile**: iOS (UIKit / Metal), Android (arm64-v8a NativeActivity)
  - **Web**: WebAssembly (WASM) client hosted on Cloudflare Pages
- 🎨 **Lightweight Shared Web UI**
  The browser and Tauri shells share a small VanJS + TypeScript + standard HTML/CSS UI. Native mobile and desktop shells remain on Slint during the staged migration.
- 📦 **High-Throughput Chunked Streaming**  
  Transfers large files reliably using 64 KiB chunks with real-time transfer progress, live throughput calculation, and SHA-256 integrity verification.
- 📋 **Integrated Clipboard & File Sharing**  
  Send clipboard snippets (`Paste & Send`) or browse files (`Pick File`) seamlessly across platforms.

---

## 🌐 Live Web Client

Access the web client directly from any modern browser (desktop or mobile) without installation:

👉 **[https://ponlet.mat2uken.app](https://ponlet.mat2uken.app)**

*(Powered by WebAssembly + Cloudflare Pages static streaming decompression)*

---

## 🏗️ Architecture & Repository Structure

TailSend is organized as a Cargo workspace with a submoduled Go Tailcat engine:

```text
tailcatsend/
├── apps/
│   ├── desktop/              # Native Windows / macOS / Linux desktop application
│   ├── tauri/                # Tauri shell using the shared Rust service and Go C ABI
│   ├── web/                  # Rust WebAssembly transfer service
│   ├── ios/                  # iOS native target (UIKit / Metal)
│   └── android/              # Android native target (NativeActivity / JNI)
├── crates/
│   ├── tailsend-core/        # Central session state machine & actor runtime
│   ├── tailsend-protocol/    # Pure Rust protocol framing (CBOR, HMAC auth, sanitizers)
│   ├── tailsend-transfer/    # 64 KiB chunk stream engine with progress tracking
│   ├── tailsend-qr/          # Pure Rust RGBA pixel matrix QR generator
│   ├── tailsend-platform-api/# Platform abstraction layer (storage, clipboard, sinks)
│   ├── tailsend-transport-api# Transport abstractions (DuplexStream, Listener)
│   ├── tailsend-ui-controller# Slint UI adapter bridging core events to UI
│   └── tailsend-native-bridge# Shared Tailcat C ABI declarations and status types
├── tailcat/                  # Go Tailcat submodule (WireGuard / DERP mesh engine)
│   ├── pkg/tailcat           # Git submodule pointing to upstream tailscale/tailcat
│   └── bridge/               # C-ABI and WebAssembly bridge adapters
├── ui/
│   └── app-window.slint      # Shared declarative Slint UI definitions
├── web-ui/                   # VanJS + TypeScript WebView UI (Vite/Oxlint/Vitest)
├── docs/                     # Internal developer and platform guides
├── scripts/                  # Build, test, packaging, and deployment scripts
└── cloudflare/               # Cloudflare Pages configuration & headers
```

---

## 🚀 Getting Started

### Prerequisites
- **Rust** (stable, 1.80+): `rustup update`
- **Go** (1.22+ or 1.24+): required for building the Tailcat engine
- **Node.js** (optional, for local web serving and E2E testing)

### 1. Clone the Repository (with Submodules)
```bash
git clone --recurse-submodules https://github.com/mat2uken/tailcatsend.git
cd tailcatsend
```

### 2. Run Native Desktop App
```bash
# Build the Go Tailcat daemon
cd tailcat
go build -tags tailcat_daemon -o ../tailcat_daemon ./bridge/native
cd ..

# Run the Rust desktop application
cargo run -p tailsend-desktop
```

### 3. Build WebAssembly Web App
```bash
# Build Go Tailcat WASM
cd tailcat/bridge/web
GOOS=js GOARCH=wasm go build -ldflags "-s -w" -o ../../../dist/assets/tailcat.wasm main.go
gzip -9 -c ../../../dist/assets/tailcat.wasm > ../../../dist/assets/tailcat.wasm.gz
cd ../../..

# Build the Rust WebAssembly transfer service
cargo build -p tailsend-web --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir dist/wasm target/wasm32-unknown-unknown/release/tailsend_web.wasm
gzip -9 -c dist/wasm/tailsend_web_bg.wasm > dist/wasm/tailsend_web_bg.wasm.gz

# Build the lightweight UI in both shell modes
./scripts/build_web_ui.sh
cp -R web-ui/dist/web/. dist/

# Serve locally
npx serve dist -l 8788
```

### 4. WebView UI

VanJS UIの移行用ソースは [`web-ui/`](web-ui/) にある。ブラウザ用とTauri用を同じTypeScriptから生成する。

```bash
./scripts/build_web_ui.sh
```

Browser mode loads the Go Tailcat bridge followed by the Rust transfer service. Tauri mode uses the same UI through commands and events. Dedicated Worker isolation, mobile shells, and physical device/transport validation remain staged work; see [`docs/WEBVIEW_MIGRATION.md`](docs/WEBVIEW_MIGRATION.md).

---

## 📖 Developer & Platform Documentation

Detailed guides and implementation specifications are maintained under [`docs/`](docs/):

- 🤖 [**Android Build & Release Guide**](docs/ANDROID_GUIDE.md): Keystore management, Gradle build, and Google Play Console automated deployment.
- 📱 [**iOS Build & Release Guide**](docs/IOS_GUIDE.md): XcodeGen setup, certificates, provisioning profiles, and TestFlight CI.
- 🍎 [**macOS Platform Guide**](docs/MACOS_GUIDE.md): Native Metal / Cocoa integration, clipboard integration, and verification notes.
- 📋 [**Implementation Status & Specification**](docs/IMPLEMENTATION_STATUS.md): Protocol framing details, HMAC verification specs, and performance metrics.

---

## ⚖️ License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

Third-party dependencies and their respective licenses (including [Tailcat / Tailscale BSD-3-Clause](https://github.com/tailscale/tailcat) and [Slint GPLv3 / Commercial](https://slint.dev/)) are documented in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
