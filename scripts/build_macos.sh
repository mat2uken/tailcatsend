#!/usr/bin/env bash
# ==============================================================================
# TailSend — macOS Native Build & Launch Script
# Supports: Apple Silicon (M1/M2/M3/M4) and Intel (x86_64) Macs
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

echo ""
echo "========================================================"
echo "  ⚡ Building TailSend Native Application for macOS     "
echo "========================================================"

# 1. Check prerequisites
if ! command -v go &> /dev/null; then
    echo "❌ Error: 'go' is not installed or not in PATH."
    echo "👉 Please install Go via: brew install go"
    exit 1
fi

if ! command -v cargo &> /dev/null; then
    echo "❌ Error: 'cargo' is not installed or not in PATH."
    echo "👉 Please install Rust via: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi

# 2. Build Go Tailcat Native Engine
echo ""
echo "[1/2] Building Go Tailcat WireGuard Daemon..."
cd "$ROOT_DIR/tailcat"
go build -o "$ROOT_DIR/tailcat_daemon" ./bridge/native/daemon.go
cd "$ROOT_DIR"
chmod +x "$ROOT_DIR/tailcat_daemon"
echo "✓ Tailcat daemon built successfully at ./tailcat_daemon"

# 3. Build Rust Slint Native Desktop App
echo ""
echo "[2/2] Building Rust Slint Desktop Application..."
cargo build -p tailsend-desktop --release
echo "✓ TailSend binary built successfully at ./target/release/tailsend"

echo ""
echo "========================================================"
echo "  ✅ Build Complete! Launching TailSend on macOS...    "
echo "========================================================"
echo ""

# Run the app (uses https://mktailcatsend.pages.dev by default)
./target/release/tailsend ${1:-}
