#!/usr/bin/env bash
# ==============================================================================
# Build signed Android App Bundle (AAB) for Google Play
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_NDK_ROOT="${ANDROID_NDK_ROOT:-$ANDROID_HOME/ndk/28.2.13676358}"
export NDK_HOME="$ANDROID_NDK_ROOT"

echo "========================================================"
echo "  📦 Building Ponlet Android App Bundle (.aab)          "
echo "  Package: jp.yasagure.ponlet                           "
echo "========================================================"

# 1. Build Go Tailcat engine for Android
echo ""
echo "[1/4] Building Go Tailcat shared library..."
export CC="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android33-clang"
export CXX="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android33-clang++"
(cd tailcat && CGO_ENABLED=1 GOOS=android GOARCH=arm64 go build -buildmode=c-shared -o ../target/libtailcat_android.so ./bridge/native)

# 2. Build Rust native library
echo ""
echo "[2/4] Building Rust native library..."
cargo build -p tailsend-android --target aarch64-linux-android --lib --release

# 3. Copy shared libraries to jniLibs
echo ""
echo "[3/4] Packaging native libraries into jniLibs..."
JNI_DIR="apps/android/app/src/main/jniLibs/arm64-v8a"
mkdir -p "$JNI_DIR"
cp -f target/aarch64-linux-android/release/libtailsend_android.so "$JNI_DIR/"
cp -f target/libtailcat_android.so "$JNI_DIR/"

# 4. Check keystore
KEYSTORE_FILE="${KEYSTORE_FILE:-$ROOT_DIR/build/certs/ponlet-release.keystore}"
if [ ! -f "$KEYSTORE_FILE" ]; then
    echo "⚠️ Keystore not found at $KEYSTORE_FILE"
    echo "Using default build without custom keystore"
fi

echo "✅ Native libraries prepared in $JNI_DIR"
echo "💡 CI automatically bundles and signs the AAB via GitHub Actions (.github/workflows/google_play.yml)"
