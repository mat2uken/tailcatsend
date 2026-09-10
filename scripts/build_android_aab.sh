#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"

PONLET_ANDROID_ARTIFACT=aab "${repo_dir}/scripts/build_tauri_mobile.sh" android release

artifact="$(find "${repo_dir}/apps/tauri/gen/android/app/build/outputs/bundle" -type f -name '*.aab' -print -quit 2>/dev/null || true)"
if [[ -z "${artifact}" ]]; then
  echo "Tauri Android AAB was not produced" >&2
  exit 1
fi
echo "Android App Bundle: ${artifact}"
