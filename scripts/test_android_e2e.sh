#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-${HOME}/Library/Android/sdk}"
export PATH="${PATH}:${ANDROID_HOME}/platform-tools"

device_id="${1:-}"
if ! command -v adb >/dev/null 2>&1; then
  echo "adb is required" >&2
  exit 2
fi
if [[ -z "${device_id}" ]]; then
  device_id="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
fi
if [[ -z "${device_id}" ]]; then
  echo "No Android device is connected" >&2
  exit 2
fi

"${repo_dir}/scripts/build_tauri_mobile.sh" android debug
apk="$(find "${repo_dir}/apps/tauri/gen/android/app/build/outputs/apk" -type f -name '*.apk' | sort | head -n 1)"
if [[ -z "${apk}" ]]; then
  echo "Tauri debug APK was not generated" >&2
  exit 1
fi

adb -s "${device_id}" install -r "${apk}"
adb -s "${device_id}" shell am force-stop jp.yasagure.ponlet
adb -s "${device_id}" shell am start -n jp.yasagure.ponlet/.MainActivity
sleep 3
adb -s "${device_id}" shell uiautomator dump /sdcard/ponlet-ui.xml >/dev/null
adb -s "${device_id}" shell cat /sdcard/ponlet-ui.xml > "${repo_dir}/target/ponlet-android-ui.xml"

if ! grep -q "Ponlet" "${repo_dir}/target/ponlet-android-ui.xml"; then
  echo "Ponlet WebView shell did not expose its title in the accessibility tree" >&2
  exit 1
fi

echo "Android Tauri WebView launched on ${device_id}."
echo "Manual follow-up required: invite, text, file, cancel, save/share, and each Tailcat path."
