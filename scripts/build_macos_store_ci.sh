#!/usr/bin/env bash
# CI-only: build/export without contacting App Store Connect. Never enable tracing.
set -euo pipefail
set +x
umask 077
cd "$(dirname "$0")/.."
required=(MACOS_DISTRIBUTION_CERTIFICATE_BASE64 MACOS_DISTRIBUTION_P12_PASSWORD MACOS_INSTALLER_CERTIFICATE_BASE64 MACOS_INSTALLER_P12_PASSWORD MACOS_STORE_PROFILE_BASE64 MACOS_STORE_SHARE_PROFILE_BASE64 KEYCHAIN_PASSWORD)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then printf 'Required secret is missing: %s\n' "$name" >&2; exit 2; fi
done
if [[ "${1:-}" == --check-secrets ]]; then exit 0; fi
[[ "${GITHUB_ACTIONS:-}" == true && "$(uname -m)" == arm64 ]] || { echo 'Requires a clean arm64 GitHub-hosted macOS runner.' >&2; exit 2; }
[[ -z "$(git status --porcelain)" ]] || { echo 'Checkout must be clean.' >&2; exit 2; }
# Expand the inner command only within each submodule.
# shellcheck disable=SC2016
git submodule foreach --recursive 'test -z "$(git status --porcelain)"' >/dev/null
if git submodule status --recursive | grep -Eq '^[+U-]'; then echo 'Submodule must match initialized committed input.' >&2; exit 2; fi
number="$(python3 scripts/macos_store_metadata.py number "$GITHUB_RUN_NUMBER" "$GITHUB_RUN_ATTEMPT" --override "${STORE_BUILD_NUMBER:-}")"
python3 scripts/macos_store_metadata.py compare "$number" "${PREVIOUS_STORE_BUILD:?Latest ASC build must be supplied}"
version="$(python3 -c 'import json; print(json.load(open("apps/tauri/tauri.conf.json"))["version"])')"
work="$(mktemp -d "${RUNNER_TEMP}/ponlet-store.XXXXXX")"
keychain="$work/signing.keychain-db"
created_profiles=()
keychain_created=0
# Snapshot before mutation; cleanup runs in this same process, including failures.
security list-keychains -d user > "$work/search-list"
security default-keychain -d user > "$work/default-keychain"
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if ! python3 - "$work" <<'PY'
import pathlib, shlex, subprocess, sys
root = pathlib.Path(sys.argv[1])
results = [subprocess.run(['security', 'list-keychains', '-d', 'user', '-s', *shlex.split((root/'search-list').read_text())], capture_output=True), subprocess.run(['security', 'default-keychain', '-d', 'user', '-s', *shlex.split((root/'default-keychain').read_text())], capture_output=True)]
raise SystemExit(int(any(r.returncode for r in results)))
PY
  then
    echo 'Failed to restore keychain settings during cleanup.' >&2
    status=1
  fi
  for profile in "${created_profiles[@]}"; do
    if ! rm -f -- "$profile"; then echo 'Failed to remove temporary profile.' >&2; status=1; fi
  done
  if [[ "$keychain_created" == 1 ]] && ! security delete-keychain "$keychain" >/dev/null 2>&1; then
    echo 'Failed to delete temporary keychain during cleanup.' >&2
    status=1
  fi
  if ! rm -rf -- "$work"; then echo 'Failed to remove private signing scratch directory.' >&2; status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# A hard runner termination is cleaned by ephemeral hosted-runner destruction.
python3 - "$work" <<'PY'
import base64, os, pathlib, sys
root = pathlib.Path(sys.argv[1])
for name, filename in [('MACOS_DISTRIBUTION_CERTIFICATE_BASE64','distribution.p12'),('MACOS_INSTALLER_CERTIFICATE_BASE64','installer.p12'),('MACOS_STORE_PROFILE_BASE64','main.provisionprofile'),('MACOS_STORE_SHARE_PROFILE_BASE64','share.provisionprofile')]:
    (root/filename).write_bytes(base64.b64decode(os.environ[name], validate=True))
PY
security create-keychain -p "$KEYCHAIN_PASSWORD" "$keychain" > "$work/security.log" 2>&1
keychain_created=1
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$keychain"
security import "$work/distribution.p12" -k "$keychain" -P "$MACOS_DISTRIBUTION_P12_PASSWORD" -T /usr/bin/codesign > "$work/import.log" 2>&1
security import "$work/installer.p12" -k "$keychain" -P "$MACOS_INSTALLER_P12_PASSWORD" -T /usr/bin/productbuild >> "$work/import.log" 2>&1
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$keychain" > "$work/partition.log" 2>&1
# Expose only the temporary keychain, not the runner/user login keychain.
security list-keychains -d user -s "$keychain"
security default-keychain -d user -s "$keychain"
identity="$(security find-identity -v -p codesigning "$keychain" | sed -nE 's/.* ([A-F0-9]{40}) "Apple Distribution:.*\(K7VNGA9K78\)"/\1/p')"
installer="$(security find-identity -v -p basic "$keychain" | sed -nE 's/.* ([A-F0-9]{40}) "3rd Party Mac Developer Installer:.*\(K7VNGA9K78\)"/\1/p')"
[[ "$identity" =~ ^[A-F0-9]{40}$ && "$installer" =~ ^[A-F0-9]{40}$ ]] || { echo 'Expected one valid Distribution and one Store Installer identity for K7VNGA9K78.' >&2; exit 2; }
installer_sha256="$(security find-certificate -c '3rd Party Mac Developer Installer' -p "$keychain" | openssl x509 -fingerprint -sha256 -noout | sed 's/^.*=//; s/://g')"
[[ "$installer_sha256" =~ ^[A-F0-9]{64}$ ]] || { echo "Installer certificate fingerprint is unavailable." >&2; exit 2; }
for kind in main share; do
  security cms -D -i "$work/$kind.provisionprofile" -o "$work/$kind.plist" 2>/dev/null
done
main_uuid="$(python3 scripts/macos_store_metadata.py profile "$work/main.plist" jp.yasagure.ponlet "$identity")"
share_uuid="$(python3 scripts/macos_store_metadata.py profile "$work/share.plist" jp.yasagure.ponlet.share "$identity")"
profiles_dir="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
mkdir -p "$profiles_dir"
for kind in main share; do
  if [[ "$kind" == main ]]; then uuid="$main_uuid"; else uuid="$share_uuid"; fi
  destination="$profiles_dir/$uuid.provisionprofile"
  [[ ! -e "$destination" ]] || { echo 'Refusing to overwrite an existing profile.' >&2; exit 2; }
  created_profiles+=("$destination")
  cp "$work/$kind.provisionprofile" "$destination"
done
# Existing scripts patch the Go submodule and generate plists: capture clean input first.
[[ ! -e store-artifacts ]] || { echo "Refusing stale artifact directory." >&2; exit 2; }
mkdir store-artifacts
export STORE_VERSION="$version" STORE_BUILD="$number"
python3 - <<'PY'
import json, os, pathlib, subprocess
commands = {'commit':['git','rev-parse','HEAD'], 'submodules':['git','submodule','status','--recursive'], 'xcode':['xcodebuild','-version'], 'sdk':['xcrun','--sdk','macosx','--show-sdk-version'], 'go':['go','version'], 'rust':['rustc','-Vv'], 'node':['node','--version'], 'tauri':['cargo','tauri','--version'], 'xcodegen':['xcodegen','--version']}
data = {k:subprocess.check_output(v,text=True).strip() for k,v in commands.items()}
data.update(version=os.environ['STORE_VERSION'],build=os.environ['STORE_BUILD'],input_dirty=False,run_url=f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}",run_attempt=os.environ['GITHUB_RUN_ATTEMPT'])
pathlib.Path('store-artifacts/build-input.json').write_text(json.dumps(data,indent=2)+'\n')
PY
python3 scripts/macos_store_metadata.py set-number "$number"
# Secrets are no longer inherited by compiler/package hooks or child build tools.
unset MACOS_DISTRIBUTION_CERTIFICATE_BASE64 MACOS_DISTRIBUTION_P12_PASSWORD MACOS_INSTALLER_CERTIFICATE_BASE64 MACOS_INSTALLER_P12_PASSWORD MACOS_STORE_PROFILE_BASE64 MACOS_STORE_SHARE_PROFILE_BASE64 KEYCHAIN_PASSWORD
PONLET_MACOS_DERIVED_DATA="$work/build" bash scripts/build_apple_macos.sh
local_app="$work/build/Build/Products/release/Ponlet.app"
python3 scripts/macos_store_metadata.py bundle "$local_app" "$version" "$number" > store-artifacts/local-validation.json
python3 scripts/macos_store_metadata.py hash-code "$local_app" "$work" > "$work/local-code.json"
archive="$work/Ponlet.xcarchive"
ditto "$work/build/Ponlet-preflight.xcarchive" "$archive"
app="$archive/Products/Applications/Ponlet.app"
rm -rf "$app"; ditto "$local_app" "$app"
export STORE_WORK="$work" STORE_IDENTITY="$identity" STORE_INSTALLER="$installer" STORE_MAIN_UUID="$main_uuid" STORE_SHARE_UUID="$share_uuid"
python3 - <<'PY'
import os, pathlib, plistlib
root=pathlib.Path(os.environ['STORE_WORK'])
for kind, bundle, source in [('main','jp.yasagure.ponlet','MacApp/Ponlet.entitlements'),('share','jp.yasagure.ponlet.share','ShareExtensionMac/PonletShareExtension.entitlements')]:
    e=plistlib.loads((pathlib.Path('apps/tauri/gen/apple')/source).read_bytes())
    e['com.apple.application-identifier']='K7VNGA9K78.'+bundle
    e['com.apple.developer.team-identifier']='K7VNGA9K78'
    (root/(kind+'-entitlements.plist')).write_bytes(plistlib.dumps(e))
options=dict(method='app-store-connect',destination='export',teamID='K7VNGA9K78',signingStyle='manual',signingCertificate=os.environ['STORE_IDENTITY'],installerSigningCertificate=os.environ['STORE_INSTALLER'],manageAppVersionAndBuildNumber=False,provisioningProfiles={'jp.yasagure.ponlet':os.environ['STORE_MAIN_UUID'],'jp.yasagure.ponlet.share':os.environ['STORE_SHARE_UUID']})
(root/'ExportOptions.plist').write_bytes(plistlib.dumps(options))
PY
# Profiles are installed only in this ephemeral runner, tracked for cleanup.
extension="$app/Contents/PlugIns/PonletShareExtensionMac.appex"
ditto "$work/share.provisionprofile" "$extension/Contents/embedded.provisionprofile"
ditto "$work/main.provisionprofile" "$app/Contents/embedded.provisionprofile"
codesign --force --sign "$identity" --keychain "$keychain" --options runtime --timestamp=none --entitlements "$work/share-entitlements.plist" "$extension" 2> "$work/codesign.log"
codesign --force --sign "$identity" --keychain "$keychain" --options runtime --timestamp=none --entitlements "$work/main-entitlements.plist" "$app" 2>> "$work/codesign.log"
/usr/libexec/PlistBuddy -c "Set :ApplicationProperties:SigningIdentity $identity" "$archive/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :ApplicationProperties:Team K7VNGA9K78' "$archive/Info.plist"
# No -allowProvisioningUpdates, API keys, upload, or submit operations.
if ! xcodebuild -exportArchive -archivePath "$archive" -exportPath "$work/export" -exportOptionsPlist "$work/ExportOptions.plist" > "$work/export.log" 2>&1; then
  echo 'Manual Store export failed. Signing/export logs are private and deliberately not artifacts.' >&2; exit 1
fi
pkg="$work/export/Ponlet.pkg"
test -s "$pkg"
pkgutil --check-signature "$pkg" > "$work/pkg-signature.txt"
grep -Eq '3rd Party Mac Developer Installer:.*\(K7VNGA9K78\)' "$work/pkg-signature.txt"
python3 - "$work/pkg-signature.txt" "$installer_sha256" <<'PYPKG'
import pathlib,re,sys
text=pathlib.Path(sys.argv[1]).read_text()
assert 'Status: signed by a developer certificate issued by Apple' in text, 'Untrusted package signature'
first=text.split('SHA256 Fingerprint:',1)[1].split('---',1)[0]
actual=''.join(re.findall(r'\b[A-F0-9]{2}\b',first))
assert actual==sys.argv[2], 'Package Installer certificate mismatch'
PYPKG
pkgutil --expand-full "$pkg" "$work/expanded"
exported="$work/expanded/jp.yasagure.ponlet.pkg/Payload/Ponlet.app"
python3 scripts/macos_store_metadata.py bundle "$exported" "$version" "$number" --fingerprint "$identity" > store-artifacts/store-validation.json
python3 scripts/macos_store_metadata.py hash-code "$exported" "$work" > "$work/store-code.json"
cmp "$work/local-code.json" "$work/store-code.json"
cp "$work/store-code.json" store-artifacts/executable-code-sha256.json
python3 - <<'PYUI'
import hashlib,json,pathlib
root=pathlib.Path('web-ui/dist')
files={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file()}
assert files, 'No generated frontend files'
pathlib.Path('store-artifacts/frontend-sha256.json').write_text(json.dumps(files,indent=2,sort_keys=True)+'\n')
PYUI
cp "$pkg" store-artifacts/Ponlet.pkg
# Store packages necessarily include public profiles/certificates, never private keys.
ditto -c -k --sequesterRsrc --keepParent "$local_app" store-artifacts/Ponlet-local-sandbox.zip
python3 - <<'PY'
import hashlib,json,pathlib
root=pathlib.Path('store-artifacts')
files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir() if p.is_file()}
(root/'SHA256.json').write_text(json.dumps(files,indent=2,sort_keys=True)+'\n')
PY
printf 'Verified local sandbox app and Store package: version %s, build %s. Nothing uploaded to Apple.\n' "$version" "$number"
