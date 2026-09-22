#!/usr/bin/env bash
set -euo pipefail

test -n "$BUILD_CERTIFICATE_BASE64"
test -n "$BUILD_PROVISION_PROFILE_BASE64"
test -n "$BUILD_PROVISION_PROFILE_SHARE_BASE64"
KEYCHAIN_PATH=$RUNNER_TEMP/build.keychain
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
echo "$BUILD_CERTIFICATE_BASE64" | base64 --decode > "$RUNNER_TEMP/certificate.p12"
security import "$RUNNER_TEMP/certificate.p12" -k "$KEYCHAIN_PATH" -P "$P12_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH" > /dev/null
security list-keychains -d user -s "$KEYCHAIN_PATH"
mkdir -p "$HOME/Library/MobileDevice/Provisioning Profiles"
echo "$BUILD_PROVISION_PROFILE_BASE64" | base64 --decode > "$RUNNER_TEMP/profile.mobileprovision"
APP_UUID=$(security cms -D -i "$RUNNER_TEMP/profile.mobileprovision" | plutil -extract UUID raw -)
APP_TEAM_ID=$(security cms -D -i "$RUNNER_TEMP/profile.mobileprovision" | plutil -extract TeamIdentifier.0 raw -)
APP_PROFILE_NAME=$(security cms -D -i "$RUNNER_TEMP/profile.mobileprovision" | plutil -extract Name raw -)
cp "$RUNNER_TEMP/profile.mobileprovision" "$HOME/Library/MobileDevice/Provisioning Profiles/${APP_UUID}.mobileprovision"
echo "$BUILD_PROVISION_PROFILE_SHARE_BASE64" | base64 --decode > "$RUNNER_TEMP/share-profile.mobileprovision"
SHARE_UUID=$(security cms -D -i "$RUNNER_TEMP/share-profile.mobileprovision" | plutil -extract UUID raw -)
SHARE_TEAM_ID=$(security cms -D -i "$RUNNER_TEMP/share-profile.mobileprovision" | plutil -extract TeamIdentifier.0 raw -)
SHARE_PROFILE_NAME=$(security cms -D -i "$RUNNER_TEMP/share-profile.mobileprovision" | plutil -extract Name raw -)
test "$APP_TEAM_ID" = "$SHARE_TEAM_ID"
cp "$RUNNER_TEMP/share-profile.mobileprovision" "$HOME/Library/MobileDevice/Provisioning Profiles/${SHARE_UUID}.mobileprovision"
echo "APPLE_DEVELOPMENT_TEAM=$APP_TEAM_ID" >> "$GITHUB_ENV"
echo "DEVELOPMENT_TEAM=$APP_TEAM_ID" >> "$GITHUB_ENV"
echo "CODE_SIGN_STYLE=Manual" >> "$GITHUB_ENV"
echo "CODE_SIGN_IDENTITY=Apple Distribution" >> "$GITHUB_ENV"
echo "PROVISIONING_PROFILE_SPECIFIER=$APP_PROFILE_NAME" >> "$GITHUB_ENV"
echo "PROVISIONING_PROFILE_SPECIFIER_SHARE=$SHARE_PROFILE_NAME" >> "$GITHUB_ENV"
# build_tauri_mobile.sh supplies both app and extension export profiles.
# Tauri's IOS_* signing variables replace that map with the app alone.
