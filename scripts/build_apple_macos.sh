#!/usr/bin/env bash
# Generate, build and locally sign the native macOS Xcode target.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
project_dir="${repo_dir}/apps/tauri/gen/apple"
derived_data="${PONLET_MACOS_DERIVED_DATA:-${repo_dir}/target/macos-xcode}"
configuration="${PONLET_MACOS_CONFIGURATION:-release}"
archs="${PONLET_MACOS_ARCHS:-arm64 x86_64}"

# XcodeGen also rewrites these iOS plists when generating the shared project.
# Preserve any local iOS edits; this invocation builds only the macOS scheme.
saved_plists="$(mktemp -d)"
restore_ios_plists() {
  cp -p "${saved_plists}/Info.plist" "${project_dir}/tailsend-tauri_iOS/Info.plist"
  cp -p "${saved_plists}/ShareInfo.plist" "${project_dir}/ShareExtension/Info.plist"
  rm -rf "${saved_plists}"
}
trap restore_ios_plists EXIT
cp -p "${project_dir}/tailsend-tauri_iOS/Info.plist" "${saved_plists}/Info.plist"
cp -p "${project_dir}/ShareExtension/Info.plist" "${saved_plists}/ShareInfo.plist"
(cd "${project_dir}" && xcodegen generate --spec project.yml)
restore_ios_plists
trap - EXIT

xcodebuild -project "${project_dir}/tailsend-tauri.xcodeproj" \
  -scheme tailsend-tauri_macOS -configuration "${configuration}" \
  -derivedDataPath "${derived_data}" -destination 'generic/platform=macOS' \
  "ARCHS=${archs}" CODE_SIGNING_ALLOWED=NO build

app="${derived_data}/Build/Products/${configuration}/Ponlet.app"
extension="${app}/Contents/PlugIns/PonletShareExtensionMac.appex"
test -x "${app}/Contents/MacOS/Ponlet"
test -d "${extension}"
for arch in ${archs}; do
  for binary in "${app}/Contents/MacOS/Ponlet" "${extension}/Contents/MacOS/PonletShareExtensionMac"; do
    if ! lipo -archs "${binary}" | tr ' ' '\n' | grep -Fxq "${arch}"; then
      echo "Missing ${arch} in ${binary}" >&2
      exit 1
    fi
  done
done

# The extension must be signed before the containing app. For local validation
# use an ad-hoc signature with the same Sandbox permissions as distribution.
identity="${PONLET_MACOS_SIGNING_IDENTITY:--}"
codesign --force --sign "${identity}" --options runtime --timestamp=none \
  --entitlements "${project_dir}/ShareExtensionMac/PonletShareExtension.entitlements" "${extension}"
codesign --force --sign "${identity}" --options runtime --timestamp=none \
  --entitlements "${project_dir}/MacApp/Ponlet.entitlements" "${app}"
codesign --verify --deep --strict "${app}"
printf 'macOS app architectures: %s\n' "$(lipo -archs "${app}/Contents/MacOS/Ponlet")"
printf 'macOS extension architectures: %s\n' "$(lipo -archs "${extension}/Contents/MacOS/PonletShareExtensionMac")"
printf 'Signed macOS app: %s\n' "${app}"
