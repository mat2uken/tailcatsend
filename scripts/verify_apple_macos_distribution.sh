#!/usr/bin/env bash
# Usage: bash scripts/verify_apple_macos_distribution.sh [Ponlet.app] [Ponlet-preflight.xcarchive]
# Requires the local K7VNGA9K78 Xcode account, Apple Distribution signing identity,
# Mac App Store profiles for the app and share extension, and a Mac installer identity.
# Signs a COPY of the universal release app inside a COPY of the preflight archive,
# then exports and checks an App Store Connect .pkg in a new temporary directory.
# Xcode may replace the extension's embedded custom profile with a managed Store
# profile when automatically signing the exported package.
# PONLET_SIGNING_SCRATCH_ROOT may override the temporary parent directory.
# The original app/archive are untouched; nothing is uploaded or submitted.
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
project_dir="${repo_dir}/apps/tauri/gen/apple"
products="${repo_dir}/target/macos-xcode"
source_app="${1:-${products}/Build/Products/release/Ponlet.app}"
source_archive="${2:-${products}/Ponlet-preflight.xcarchive}"
identity="A398B39E64AAE7949466D015ABE1C7B7E8479519"
team="K7VNGA9K78"
scratch_root="${PONLET_SIGNING_SCRATCH_ROOT:-/private/var/folders/b_/l4tstdxd2y5fz82svbpvr9s40000gp/T/opencode}"

[[ -d "${source_app}" && -d "${source_archive}" ]] || {
  echo 'Existing .app and .xcarchive are required (optional arguments: app archive).' >&2
  exit 2
}
if ! security find-identity -v -p codesigning | grep -Fq "${identity}"; then
  echo 'Required Apple Distribution identity is unavailable.' >&2
  exit 2
fi

mkdir -p "${scratch_root}"
work_dir="$(mktemp -d "${scratch_root}/ponlet-distribution.XXXXXX")"
echo "Verification files: ${work_dir}"

# Only Mac App Store profiles for this team and the exact bundle ID may be embedded.
# The share extension's new custom-named profile must also match its group and signing identity.
# Xcode keeps downloaded profiles in either of these user directories.
find_store_profile() {
  local bundle_id="$1" profile decoded name profile_team app_id platform uuid group cert index
  for profile in \
    "${HOME}/Library/Developer/Xcode/UserData/Provisioning Profiles/"*.provisionprofile \
    "${HOME}/Library/Developer/Xcode/UserData/Provisioning Profiles/"*.mobileprovision \
    "${HOME}/Library/MobileDevice/Provisioning Profiles/"*.provisionprofile \
    "${HOME}/Library/MobileDevice/Provisioning Profiles/"*.mobileprovision; do
    [[ -f "${profile}" ]] || continue
    decoded="${work_dir}/profile-decoded.plist"
    security cms -D -i "${profile}" -o "${decoded}" 2>/dev/null || continue
    name="$(plutil -extract Name raw -o - "${decoded}" 2>/dev/null)" || continue
    profile_team="$(plutil -extract TeamIdentifier.0 raw -o - "${decoded}" 2>/dev/null)" || continue
    app_id="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:com.apple.application-identifier' "${decoded}" 2>/dev/null)" || continue
    platform="$(plutil -extract Platform.0 raw -o - "${decoded}" 2>/dev/null)" || continue
    if [[ "${bundle_id}" != jp.yasagure.ponlet.share && \
          "${name}" == "Mac Team Store Provisioning Profile: ${bundle_id}" && \
          "${profile_team}" == "${team}" && "${app_id}" == "${team}.${bundle_id}" && \
          "${platform}" == OSX ]]; then
      printf '%s\n' "${profile}"
      return 0
    fi
    if [[ "${bundle_id}" == jp.yasagure.ponlet.share && \
          "${name}" == 'Ponlet Share Extension MAC_APP_STORE App Group 20260924112905' && \
          "${profile_team}" == "${team}" && "${app_id}" == "${team}.${bundle_id}" && \
          "${platform}" == OSX ]]; then
      uuid="$(plutil -extract UUID raw -o - "${decoded}" 2>/dev/null)" || continue
      [[ "${uuid}" == b3437835-4f9d-4eba-a13e-9c774a42f85b ]] || continue
      group='group.jp.yasagure.ponlet.k7vnga9k78'
      index=0
      while /usr/libexec/PlistBuddy -c "Print :Entitlements:com.apple.security.application-groups:${index}" "${decoded}" >/dev/null 2>&1; do
        [[ "$(/usr/libexec/PlistBuddy -c "Print :Entitlements:com.apple.security.application-groups:${index}" "${decoded}")" == "${group}" ]] && break
        ((index+=1))
      done
      /usr/libexec/PlistBuddy -c "Print :Entitlements:com.apple.security.application-groups:${index}" "${decoded}" >/dev/null 2>&1 || continue
      index=0
      while cert="$(plutil -extract "DeveloperCertificates.${index}" raw -o - "${decoded}" 2>/dev/null)"; do
        if [[ "$(printf '%s' "${cert}" | base64 -D | openssl x509 -inform DER -fingerprint -sha1 -noout | sed 's/^.*=//; s/://g')" == "${identity}" ]]; then
          printf '%s\n' "${profile}"
          return 0
        fi
        ((index+=1))
      done
    fi
  done
  echo "Mac Team Store profile missing for ${bundle_id} (${team})." >&2
  return 2
}

archive="${work_dir}/Ponlet.xcarchive"
ditto "${source_archive}" "${archive}"
app="${archive}/Products/Applications/Ponlet.app"
rm -rf -- "${app}"
ditto "${source_app}" "${app}"
extension="${app}/Contents/PlugIns/PonletShareExtensionMac.appex"
[[ -d "${extension}" ]] || { echo 'Share Extension is missing.' >&2; exit 2; }
app_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${app}/Contents/Info.plist")"
extension_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${extension}/Contents/Info.plist")"
[[ "${app_id}" == jp.yasagure.ponlet && "${extension_id}" == jp.yasagure.ponlet.share ]] || {
  echo 'Unexpected app or share extension bundle ID.' >&2
  exit 2
}
for binary in "${app}/Contents/MacOS/Ponlet" "${extension}/Contents/MacOS/PonletShareExtensionMac"; do
  archs="$(lipo -archs "${binary}")"
  [[ " ${archs} " == *' arm64 '* && " ${archs} " == *' x86_64 '* ]] || {
    echo "Expected universal arm64/x86_64 binary: ${binary}" >&2
    exit 2
  }
done

app_profile="$(find_store_profile "${app_id}")"
extension_profile="$(find_store_profile "${extension_id}")"
rm -f -- "${work_dir}/profile-decoded.plist"
ditto "${extension_profile}" "${extension}/Contents/embedded.provisionprofile"
ditto "${app_profile}" "${app}/Contents/embedded.provisionprofile"
codesign --force --sign "${identity}" --options runtime --timestamp=none \
  --entitlements "${project_dir}/ShareExtensionMac/PonletShareExtension.entitlements" "${extension}"
codesign --force --sign "${identity}" --options runtime --timestamp=none \
  --entitlements "${project_dir}/MacApp/Ponlet.entitlements" "${app}"
codesign --verify --deep --strict --verbose=2 "${app}"
[[ "$(codesign -dv "${app}" 2>&1 | sed -n 's/^TeamIdentifier=//p')" == "${team}" ]] || {
  echo 'Signed app has the wrong team.' >&2
  exit 2
}

# The copied archive must describe the signed app; the source archive is unchanged.
/usr/libexec/PlistBuddy -c "Set :ApplicationProperties:SigningIdentity Apple Distribution: Kenichi Matsumoto (${team})" "${archive}/Info.plist"
/usr/libexec/PlistBuddy -c "Set :ApplicationProperties:Team ${team}" "${archive}/Info.plist"
cat > "${work_dir}/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>destination</key><string>export</string>
<key>teamID</key><string>${team}</string>
<key>signingStyle</key><string>automatic</string>
</dict></plist>
EOF
if ! xcodebuild -exportArchive -archivePath "${archive}" \
  -exportPath "${work_dir}/export" -exportOptionsPlist "${work_dir}/ExportOptions.plist" \
  -allowProvisioningUpdates \
  > "${work_dir}/export.log" 2>&1; then
  echo "Xcode App Store export failed; see ${work_dir}/export.log" >&2
  grep -E '^(error:|\*\* EXPORT)' "${work_dir}/export.log" >&2 || true
  exit 1
fi

pkg="${work_dir}/export/Ponlet.pkg"
[[ -s "${pkg}" ]] || { echo 'Export produced no Ponlet.pkg.' >&2; exit 1; }
pkgutil --check-signature "${pkg}" > "${work_dir}/pkg-signature.txt"
grep -Fq "3rd Party Mac Developer Installer: Kenichi Matsumoto (${team})" "${work_dir}/pkg-signature.txt" || {
  echo 'Package has no matching Mac App Store installer signature.' >&2
  exit 1
}
pkgutil --expand-full "${pkg}" "${work_dir}/expanded"
exported_app="${work_dir}/expanded/${app_id}.pkg/Payload/Ponlet.app"
[[ -d "${exported_app}" ]] || { echo 'Package payload has no Ponlet.app.' >&2; exit 1; }
codesign --verify --deep --strict --verbose=2 "${exported_app}"
[[ "$(codesign -dv "${exported_app}" 2>&1 | sed -n 's/^TeamIdentifier=//p')" == "${team}" ]] || {
  echo 'Package payload has the wrong signing team.' >&2
  exit 1
}
[[ -f "${exported_app}/Contents/embedded.provisionprofile" && \
   -f "${exported_app}/Contents/PlugIns/PonletShareExtensionMac.appex/Contents/embedded.provisionprofile" ]] || {
  echo 'Package payload is missing a Mac Store profile.' >&2
  exit 1
}
echo "Verified App Store Mac package: ${pkg}"
