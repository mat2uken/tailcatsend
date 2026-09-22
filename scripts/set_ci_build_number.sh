#!/usr/bin/env bash
set -euo pipefail

run_slot=$((GITHUB_RUN_NUMBER % 100))
if [[ "$run_slot" -eq 0 ]]; then run_slot=1; fi
build_number="$(TZ='Asia/Tokyo' date +%Y%m%d)$(printf '%02d' "$run_slot")"
printf '%s=%s\n' "$1" "$build_number" >> "$GITHUB_ENV"
echo "Using $1=$build_number"
