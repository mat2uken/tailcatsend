#!/bin/bash
set -e

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_NDK_ROOT="${ANDROID_NDK_ROOT:-$ANDROID_HOME/ndk/28.2.13676358}"
export NDK_HOME="$ANDROID_NDK_ROOT"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Ensure submodule is initialized
if [ ! -f "$PROJECT_ROOT/tailcat/pkg/tailcat/go.mod" ]; then
    echo "Initializing Tailcat submodule..."
    git -C "$PROJECT_ROOT" submodule update --init --recursive --quiet
    if [ -f "$PROJECT_ROOT/tailcat/patches/0001-android-selinux-netmon-fallback.patch" ]; then
        git -C "$PROJECT_ROOT/tailcat/pkg/tailcat" apply "$PROJECT_ROOT/tailcat/patches/0001-android-selinux-netmon-fallback.patch" || true
    fi
fi

echo "=== 1. Building Tailcat Go C-ABI for Android arm64 ==="
export CC=$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android33-clang
export CXX=$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android33-clang++
(cd tailcat/bridge/native && CGO_ENABLED=1 GOOS=android GOARCH=arm64 go build -buildmode=c-shared -o ../../../target/libtailcat_android.so bridge.go)
mkdir -p target/aarch64-linux-android/debug
cp -f target/libtailcat_android.so target/aarch64-linux-android/debug/libtailcat_android.so

echo "=== 2. Building Android APK via cargo-apk ==="
touch apps/android/src/lib.rs
cargo apk build -p tailsend-android --target aarch64-linux-android --lib

echo "✅ Android Build Complete!"
