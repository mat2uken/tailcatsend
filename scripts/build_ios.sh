#!/usr/bin/env bash
set -euo pipefail

echo "=========================================="
echo " TailSend iOS Build & Package Script"
echo "=========================================="

MODE="${1:-sim}" # "sim" or "device" or "xcode" or "device-install"
SIM_ID="${2:-booted}" # default to currently booted simulator

if [ "$MODE" = "sim" ]; then
    echo "🔨 [1/4] Compiling Rust library for iOS Simulator (aarch64-apple-ios-sim)..."
    cargo build -p tailsend-ios --target aarch64-apple-ios-sim --release

    echo "📦 [2/4] Compiling Swift app & linking frameworks..."
    SDK_PATH=$(xcrun --sdk iphonesimulator --show-sdk-path)
    TARGET="arm64-apple-ios18.0-simulator"
    mkdir -p build/ios_sim/TailSend.app

    xcrun swiftc \
      -target "$TARGET" \
      -sdk "$SDK_PATH" \
      -import-objc-header apps/ios/TailSend/TailSend-Bridging-Header.h \
      apps/ios/TailSend/main.swift \
      apps/ios/TailSend/QRScannerViewController.swift \
      -L target/aarch64-apple-ios-sim/release \
      -ltailsend_ios \
      -L . \
      -ltailcat_ios_sim \
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
    xcrun actool apps/ios/TailSend/Assets.xcassets \
      --compile build/ios_sim/TailSend.app \
      --platform iphonesimulator \
      --minimum-deployment-target 17.0 \
      --app-icon AppIcon \
      --output-partial-info-plist /tmp/actool_partial_info.plist >/dev/null 2>&1 || true

    echo "✍️  [3/4] Ad-hoc codesigning iOS App..."
    codesign -s - --force build/ios_sim/TailSend.app

    echo "📲 [4/4] Installing to iOS Simulator ($SIM_ID)..."
    xcrun simctl boot "$SIM_ID" 2>/dev/null || true
    xcrun simctl install "$SIM_ID" build/ios_sim/TailSend.app
    echo "🚀 Launching Ponlet on Simulator..."
    xcrun simctl launch "$SIM_ID" jp.yasagure.ponlet
    echo "✅ Successfully deployed Ponlet iOS on Simulator!"

elif [ "$MODE" = "device" ]; then
    echo "🔨 Compiling Rust library for physical iOS Device (aarch64-apple-ios)..."
    cargo build -p tailsend-ios --target aarch64-apple-ios --release
    echo "✅ Built: target/aarch64-apple-ios/release/libtailsend_ios.a"
    echo "💡 Open apps/ios/TailSend.xcodeproj in Xcode to deploy to your connected iPhone."

elif [ "$MODE" = "device-install" ]; then
    DEVICE_ID="${2:-}"
    if [ -z "$DEVICE_ID" ]; then
        echo "❌ Error: Please specify the target device UUID:"
        echo "   ./scripts/build_ios.sh device-install <DEVICE_UUID>"
        echo "💡 Run 'xcrun devicectl list devices' to find connected device UUIDs."
        exit 1
    fi
    echo "🔨 [1/4] Compiling Go Tailcat library for physical iOS Device..."
    (cd tailcat && CGO_ENABLED=1 CC="$(xcrun --sdk iphoneos --find clang) -isysroot $(xcrun --sdk iphoneos --show-sdk-path) -arch arm64 -miphoneos-version-min=17.0" GOOS=ios GOARCH=arm64 go build -buildmode=c-archive -o ../libtailcat_ios.a bridge/native/bridge.go)

    echo "🔨 [2/4] Compiling Rust library for physical iOS Device (aarch64-apple-ios)..."
    cargo build -p tailsend-ios --target aarch64-apple-ios --release

    echo "⚙️  [3/4] Building Xcode Project for physical device ($DEVICE_ID)..."
    cd apps/ios && xcodegen generate
    xcodebuild -project TailSend.xcodeproj -scheme TailSend -destination "generic/platform=iOS" -derivedDataPath DerivedData -allowProvisioningUpdates build
    cd ../..

    echo "📲 [4/4] Installing and launching on iPhone ($DEVICE_ID)..."
    xcrun devicectl device install app --device "$DEVICE_ID" apps/ios/DerivedData/TailSend/Build/Products/Debug-iphoneos/TailSend.app
    xcrun devicectl device process launch --device "$DEVICE_ID" jp.yasagure.ponlet
    echo "✅ Successfully deployed and launched Ponlet iOS on physical iPhone!"

elif [ "$MODE" = "xcode" ]; then
    echo "⚙️  Generating Xcode Project via XcodeGen..."
    cd apps/ios && xcodegen generate
    echo "✅ Generated: apps/ios/TailSend.xcodeproj"
fi
