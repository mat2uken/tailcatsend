#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
mode="${1:-sim}"

case "${mode}" in
  sim)
    exec "${repo_dir}/scripts/build_tauri_mobile.sh" ios-sim release
    ;;
  device)
    exec "${repo_dir}/scripts/build_tauri_mobile.sh" ios release
    ;;
  device-install)
    device_id="${2:-}"
    if [[ -z "${device_id}" ]]; then
      echo "usage: $0 device-install <DEVICE_UUID>" >&2
      exit 2
    fi
    "${repo_dir}/scripts/build_tauri_mobile.sh" ios debug
    xcrun devicectl device install app --device "${device_id}" \
      "${repo_dir}/apps/tauri/gen/apple/build/arm64/Ponlet.ipa"
    xcrun devicectl device process launch --device "${device_id}" \
      --terminate-existing jp.yasagure.ponlet
    ;;
  xcode)
    (cd "${repo_dir}/apps/tauri/gen/apple" && xcodegen generate)
    ;;
  *)
    echo "usage: $0 sim|device|device-install|xcode [DEVICE_UUID]" >&2
    exit 2
    ;;
esac
