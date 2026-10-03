#!/usr/bin/env bash
set -euo pipefail

# This entry point never installs signing material, uploads symbols/artifacts,
# invokes Play, or touches a device. Gradle also enforces the build-only flag.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export PONLET_ANDROID_BUILD_ONLY=1
unset PONLET_ANDROID_KEYSTORE ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD
unset PLAY_CONFIG_JSON GOOGLE_SERVICES_JSON_BASE64
export CARGO_PROFILE_RELEASE_STRIP=none

PONLET_ANDROID_ARTIFACT=aab "${script_dir}/build_tauri_mobile.sh" android release
PONLET_ANDROID_ARTIFACT=apk "${script_dir}/build_tauri_mobile.sh" android release
