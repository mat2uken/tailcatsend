#!/usr/bin/env bash
# ==============================================================================
# Ponlet — macOS Native Build & Launch Script
# Supports: Apple Silicon (M1/M2/M3/M4) and Intel (x86_64) Macs
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

echo ""
echo "========================================================"
echo "  ⚡ Building Ponlet Native Application for macOS        "
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
echo "✓ Ponlet binary built successfully at ./target/release/tailsend"

# 4. Package macOS App Bundle (.app) with AppIcon
echo ""
echo "📦 Packaging Ponlet.app with custom icon..."
APP_BUNDLE="$ROOT_DIR/build/macos/Ponlet.app"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"
cp "$ROOT_DIR/target/release/tailsend" "$APP_BUNDLE/Contents/MacOS/Ponlet"
if [ -f "$ROOT_DIR/apps/desktop/AppIcon.icns" ]; then
    cp "$ROOT_DIR/apps/desktop/AppIcon.icns" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
fi

cat << 'PLIST' > "$APP_BUNDLE/Contents/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>Ponlet</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIdentifier</key>
    <string>jp.yasagure.ponlet</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>Ponlet</string>
    <key>CFBundleDisplayName</key>
    <string>Ponlet</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

codesign -s - --force "$APP_BUNDLE" 2>/dev/null || true
echo "✓ Ponlet.app packaged successfully at ./build/macos/Ponlet.app"

echo ""
echo "========================================================"
echo "  ✅ Build Complete! Launching Ponlet on macOS...       "
echo "========================================================"
echo ""

# Run the app (uses https://mktailcatsend.pages.dev by default)
./target/release/tailsend ${1:-}
