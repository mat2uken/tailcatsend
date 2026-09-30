#!/usr/bin/env bash
# A completion: run by the owner on their Mac with existing signing identities.
# No keychain changes, p12/p8 import, provisioning updates, or Apple upload.
set -euo pipefail
set +x
umask 077
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
[[ $# == 4 ]] || { echo 'Usage: script artifact-dir reviewed-commit archive-sha256 output-dir' >&2; exit 2; }
input=$(cd "$1" && pwd)
export EXPECTED_SOURCE_COMMIT="$2" EXPECTED_ARCHIVE_SHA256="$3"
output="$4"
[[ "${PONLET_CONFIRM_EXISTING_MANAGED_SIGNING:-}" == yes ]] || { echo 'Owner must confirm use of existing Mac account/Managed signing; no certificate creation or rotation is authorized.' >&2; exit 2; }
[[ "$(git rev-parse HEAD)" == "$EXPECTED_SOURCE_COMMIT" && -z "$(git status --porcelain)" ]] || { echo 'Checkout must be clean at the reviewed archive commit.' >&2; exit 2; }
python3 scripts/verify_macos_managed_input.py "$input"
[[ ! -e "$output" ]] || { echo 'Refusing to overwrite output.' >&2; exit 2; }
main_profile="${PONLET_MAC_MAIN_PROFILE:?Specify existing main macOS Store profile}"
share_profile="${PONLET_MAC_SHARE_PROFILE:?Specify existing share macOS Store profile}"
identity=$(security find-identity -v -p codesigning | sed -nE 's/.* ([A-F0-9]{40}) "Apple Distribution:.*\(K7VNGA9K78\)"/\1/p')
[[ "$identity" =~ ^[A-F0-9]{40}$ ]] || { echo 'One existing Apple Distribution identity for K7VNGA9K78 is required.' >&2; exit 2; }
work=$(mktemp -d "${TMPDIR:-/tmp}/ponlet-mac-export.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
for kind in main share; do
  if [[ "$kind" == main ]]; then profile="$main_profile"; bundle=jp.yasagure.ponlet; else profile="$share_profile"; bundle=jp.yasagure.ponlet.share; fi
  security cms -D -i "$profile" -o "$work/$kind.plist" 2>/dev/null
  python3 scripts/macos_store_metadata.py profile "$work/$kind.plist" "$bundle" "$identity" >/dev/null
done
ditto -x -k "$input/Ponlet-preflight.xcarchive.zip" "$work"
archive="$work/Ponlet-preflight.xcarchive"
app="$archive/Products/Applications/Ponlet.app"
extension="$app/Contents/PlugIns/PonletShareExtensionMac.appex"
version=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$input/build-input.json")
number=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["build"])' "$input/build-input.json")
python3 scripts/macos_store_metadata.py bundle "$app" "$version" "$number" >/dev/null
python3 scripts/macos_store_metadata.py hash-code "$app" "$work" > "$work/input-code.json"
cmp "$input/executable-code-sha256.json" "$work/input-code.json"
ditto "$main_profile" "$app/Contents/embedded.provisionprofile"
ditto "$share_profile" "$extension/Contents/embedded.provisionprofile"
export MAC_EXPORT_WORK="$work"
python3 - <<'PY'
import os,pathlib,plistlib
root=pathlib.Path(os.environ['MAC_EXPORT_WORK'])
for name,bundle,source in [('main','jp.yasagure.ponlet','MacApp/Ponlet.entitlements'),('share','jp.yasagure.ponlet.share','ShareExtensionMac/PonletShareExtension.entitlements')]:
 e=plistlib.loads((pathlib.Path('apps/tauri/gen/apple')/source).read_bytes());e.update({'com.apple.application-identifier':'K7VNGA9K78.'+bundle,'com.apple.developer.team-identifier':'K7VNGA9K78'});(root/(name+'.entitlements')).write_bytes(plistlib.dumps(e))
(root/'ExportOptions.plist').write_bytes(plistlib.dumps(dict(method='app-store-connect',destination='export',teamID='K7VNGA9K78',signingStyle='automatic',manageAppVersionAndBuildNumber=False)))
PY
codesign --force --sign "$identity" --options runtime --timestamp=none --entitlements "$work/share.entitlements" "$extension" 2> "$work/signing.log"
codesign --force --sign "$identity" --options runtime --timestamp=none --entitlements "$work/main.entitlements" "$app" 2>> "$work/signing.log"
/usr/libexec/PlistBuddy -c "Set :ApplicationProperties:SigningIdentity $identity" "$archive/Info.plist"
# Same automatic export mode as the successful Mac export. Existing Xcode account
# supplies Managed Installer signing; API keys / allowProvisioningUpdates absent.
if ! xcodebuild -exportArchive -archivePath "$archive" -exportPath "$work/export" -exportOptionsPlist "$work/ExportOptions.plist" > "$work/export.log" 2>&1; then
  echo 'Mac Managed export failed; private logs will not be published. Do not create certificates to bypass this failure.' >&2; exit 1
fi
pkg="$work/export/Ponlet.pkg"
pkgutil --check-signature "$pkg" > "$work/pkg-signature.txt"
grep -Eq '3rd Party Mac Developer Installer:.*\(K7VNGA9K78\)' "$work/pkg-signature.txt"
grep -Fq 'Status: signed by a developer certificate issued by Apple' "$work/pkg-signature.txt"
pkgutil --expand-full "$pkg" "$work/expanded"
exported="$work/expanded/jp.yasagure.ponlet.pkg/Payload/Ponlet.app"
python3 scripts/macos_store_metadata.py bundle "$exported" "$version" "$number" --fingerprint "$identity" > "$work/store-validation.json"
python3 scripts/macos_store_metadata.py hash-code "$exported" "$work" > "$work/export-code.json"
cmp "$input/executable-code-sha256.json" "$work/export-code.json"
mkdir -p "$output"
cp "$pkg" "$output/Ponlet.pkg"
cp "$work/store-validation.json" "$work/pkg-signature.txt" "$input/build-input.json" "$input/executable-code-sha256.json" "$output/"
python3 - "$output" <<'PY'
import pathlib,hashlib,json,sys
root=pathlib.Path(sys.argv[1]);(root/'SHA256.json').write_text(json.dumps({p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir() if p.is_file()},indent=2,sort_keys=True)+'\n')
PY
echo 'Mac Managed pkg verified against CI input. Nothing uploaded to Apple.'
