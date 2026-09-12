#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
config="${repo_dir}/apps/tauri/gen/apple/tailsend-tauri_iOS/GoogleService-Info.plist"
if [[ ! -f "${config}" ]]; then
  echo "Firebase client configuration is absent; symbol upload skipped."
  exit 0
fi
# Swift package checkouts belong to the current Cargo build output. Do not
# silently upload symbols from another checkout or an older Xcode archive.
uploader="$(find "${repo_dir}/target" -type f -path '*/firebase-ios-sdk/Crashlytics/upload-symbols' -print -quit)"
archive="$(find "${repo_dir}/apps/tauri/gen/apple/build" -type d -name '*.xcarchive' -print -quit)"
if [[ -z "${uploader}" || -z "${archive}" || ! -d "${archive}/dSYMs" ]]; then
  echo "Crashlytics uploader or current archive symbols were not produced" >&2
  exit 1
fi
"${uploader}" -gsp "${config}" -p ios "${archive}/dSYMs"
