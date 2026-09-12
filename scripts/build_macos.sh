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

# Ensure submodule is initialized
if [ ! -f "$ROOT_DIR/tailcat/pkg/tailcat/go.mod" ]; then
    echo "Initializing Tailcat submodule..."
    git -C "$ROOT_DIR" submodule update --init --recursive --quiet
fi

# Submodule working trees may already contain the local patches. The helper
# distinguishes that case from a real apply failure and covers all three
# patched checkouts used by the Go bridge.
"$ROOT_DIR/scripts/apply_tailcat_patches.sh"

# 2. Build the Go C archive, VanJS UI, and Tauri shell
echo ""
echo "[1/1] Building Tauri desktop application..."
scripts/build_tauri.sh
echo "✓ Ponlet binary built successfully at ./target/release/tailsend"

# 2. Package macOS App Bundle (.app) with AppIcon
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
    <key>NSCameraUsageDescription</key>
    <string>Ponlet uses the camera to scan invitation QR codes and connect to another device.</string>
    <key>NSLocalNetworkUsageDescription</key>
    <string>Ponlet uses the local network for direct device connections and file transfers.</string>
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

# Run the app (uses https://ponlet.mat2uken.app by default)
if [[ $# -gt 0 ]]; then
    ./target/release/tailsend "$1"
else
    ./target/release/tailsend
fi
