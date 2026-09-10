#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"

apply_one() {
  local checkout="$1"
  local patch_file="$2"
  local label

  [[ -f "${patch_file}" ]] || return 0
  label="$(basename "${patch_file}")"

  if git -C "${checkout}" apply --check --unidiff-zero "${patch_file}" >/dev/null 2>&1; then
    git -C "${checkout}" apply --unidiff-zero "${patch_file}"
    printf 'Applied %s to %s\n' "${label}" "${checkout}"
    return 0
  fi

  if git -C "${checkout}" apply --reverse --check --unidiff-zero "${patch_file}" >/dev/null 2>&1; then
    printf 'Already applied %s to %s\n' "${label}" "${checkout}"
    return 0
  fi

  printf 'Cannot apply %s cleanly to %s\n' "${label}" "${checkout}" >&2
  return 1
}

tailcat_dir="${repo_dir}/tailcat"
apply_one "${tailcat_dir}/pkg/tailcat" \
  "${tailcat_dir}/patches/0001-android-selinux-netmon-fallback.patch"
apply_one "${tailcat_dir}/pkg/tailcat" \
  "${tailcat_dir}/patches/0003-tailcat-status-peer-report.patch"
apply_one "${tailcat_dir}/pkg/tailscale.com" \
  "${tailcat_dir}/patches/0002-tailscale-webrtc-transport.patch"
