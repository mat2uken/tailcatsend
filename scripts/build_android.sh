#!/usr/bin/env bash
set -euo pipefail

# Android product builds use the same Tauri WebView shell as desktop and iOS.
# The optional mode is debug by default so a connected device can be used
# without requiring a signing key.
mode="${1:-debug}"
exec "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/build_tauri_mobile.sh" android "${mode}"
