#!/usr/bin/env bash
set -euo pipefail

echo "=========================================="
echo " TailSend iOS Build & Package Script"
echo "=========================================="

MODE="${1:-sim}" # "sim" or "device" or "xcode"
SIM_ID="${2:-75B31423-51DF-4BC0-95B5-E12E073A9409}" # default to iPhone 16 sim

if [ "$MODE" = "sim" ]; then
    echo "🔨 [1/4] Compiling Rust library for iOS Simulator (aarch64-apple-ios-sim)..."
    cargo build -p tailsend-ios --target aarch64-apple-ios-sim --release

    echo "📦 [2/4] Compiling Swift app & linking frameworks..."
    SDK_PATH=$(xcrun --sdk iphonesimulator --show-sdk-path)
    TARGET="arm64-apple-ios18.0-simulator"
    mkdir -p build/ios_sim/TailSend.app

    xcrun swiftc \
      -parse-as-library \
      -target "$TARGET" \
      -sdk "$SDK_PATH" \
      -import-objc-header apps/ios/TailSend/TailSend-Bridging-Header.h \
      apps/ios/TailSend/main.swift \
      apps/ios/TailSend/QRScannerViewController.swift \
      -L target/aarch64-apple-ios-sim/release \
      -ltailsend_ios \
      -framework UIKit \
      -framework AVFoundation \
      -framework Metal \
      -framework QuartzCore \
      -framework CoreGraphics \
      -framework CoreText \
      -framework Security \
      -framework Foundation \
      -framework MobileCoreServices \
      -lresolv \
      -lc++ \
      -o build/ios_sim/TailSend.app/TailSend

    cp apps/ios/TailSend/Info.plist build/ios_sim/TailSend.app/Info.plist

    echo "✍️  [3/4] Ad-hoc codesigning iOS App..."
    codesign -s - --force build/ios_sim/TailSend.app

    echo "📲 [4/4] Installing to iOS Simulator ($SIM_ID)..."
    xcrun simctl boot "$SIM_ID" 2>/dev/null || true
    xcrun simctl install "$SIM_ID" build/ios_sim/TailSend.app
    echo "🚀 Launching TailSend on Simulator..."
    xcrun simctl launch "$SIM_ID" dev.tailsend.app
    echo "✅ Successfully deployed TailSend iOS on Simulator!"

elif [ "$MODE" = "device" ]; then
    echo "🔨 Compiling Rust library for physical iOS Device (aarch64-apple-ios)..."
    cargo build -p tailsend-ios --target aarch64-apple-ios --release
    echo "✅ Built: target/aarch64-apple-ios/release/libtailsend_ios.a"
    echo "💡 Open apps/ios/TailSend.xcodeproj in Xcode to deploy to your connected iPhone."

elif [ "$MODE" = "device-install" ]; then
    DEVICE_ID="${2:-79CEEFC2-B7BF-5006-87DD-BA66C4CF38F7}"
    echo "🔨 [1/4] Compiling Go Tailcat library for physical iOS Device..."
    (cd tailcat && CGO_ENABLED=1 CC="$(xcrun --sdk iphoneos --find clang) -isysroot $(xcrun --sdk iphoneos --show-sdk-path) -arch arm64 -miphoneos-version-min=17.0" GOOS=ios GOARCH=arm64 go build -buildmode=c-archive -o ../libtailcat_ios.a bridge/native/bridge.go)

    echo "🔨 [2/4] Compiling Rust library for physical iOS Device (aarch64-apple-ios)..."
    cargo build -p tailsend-ios --target aarch64-apple-ios --release

    echo "⚙️  [3/4] Building Xcode Project for physical device ($DEVICE_ID)..."
    cd apps/ios && xcodegen generate
    xcodebuild -project TailSend.xcodeproj -scheme TailSend -destination "id=$DEVICE_ID" -allowProvisioningUpdates build
    cd ../..

    echo "📲 [4/4] Installing and launching on iPhone ($DEVICE_ID)..."
    xcrun devicectl device install app --device "$DEVICE_ID" apps/ios/DerivedData/TailSend/Build/Products/Debug-iphoneos/TailSend.app
    xcrun devicectl device process launch --device "$DEVICE_ID" jp.co.roland.tailsend
    echo "✅ Successfully deployed and launched TailSend iOS on physical iPhone!"

elif [ "$MODE" = "xcode" ]; then
    echo "⚙️  Generating Xcode Project via XcodeGen..."
    cd apps/ios && xcodegen generate
    echo "✅ Generated: apps/ios/TailSend.xcodeproj"
fi
