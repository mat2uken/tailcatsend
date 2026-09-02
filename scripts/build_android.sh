#!/bin/bash
set -e

export ANDROID_HOME=/Users/mat2uken/Library/Android/sdk
export ANDROID_NDK_ROOT=/Users/mat2uken/Library/Android/sdk/ndk/28.2.13676358
export NDK_HOME=$ANDROID_NDK_ROOT
export PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH

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
