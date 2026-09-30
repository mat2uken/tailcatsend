#!/usr/bin/env bash
# Experimental cloud signing. Local export only: never upload or submit to Apple.
set -euo pipefail
set +x
umask 077
cd "$(dirname "$0")/.."
[[ "${AUTHORIZE_CLOUD_SIGNING:-}" == true ]] || { echo 'Explicit cloud-signing experiment authorization is required.' >&2; exit 2; }
for name in APP_STORE_CONNECT_PRIVATE_KEY APP_STORE_CONNECT_KEY_ID APP_STORE_CONNECT_ISSUER_ID; do
  [[ -n "${!name:-}" ]] || { printf 'Required secret is missing: %s\n' "$name" >&2; exit 2; }
done
[[ "${GITHUB_ACTIONS:-}" == true && "$(uname -m)" == arm64 ]] || { echo 'Requires an ephemeral arm64 GitHub-hosted macOS runner.' >&2; exit 2; }
input="${1:?Archive artifact directory is required}"
[[ ! -e managed-export-artifacts ]] || { echo 'Refusing a stale export artifact directory.' >&2; exit 2; }
python3 scripts/verify_macos_managed_input.py "$input"
work="$(mktemp -d "${RUNNER_TEMP}/ponlet-managed.XXXXXX")"
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if ! rm -rf -- "$work"; then echo 'Could not remove private cloud-export scratch directory.' >&2; status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Raw PEM p8 is provided by the user in an Actions Secret; never copied from a Mac.
python3 - "$work/AuthKey.p8" <<'PY'
import os,pathlib,sys
key=os.environ['APP_STORE_CONNECT_PRIVATE_KEY']
if not key.startswith('-----BEGIN PRIVATE KEY-----') or '-----END PRIVATE KEY-----' not in key:
    raise ValueError('APP_STORE_CONNECT_PRIVATE_KEY must contain raw PEM p8')
pathlib.Path(sys.argv[1]).write_text(key if key.endswith('\n') else key+'\n')
PY
key_id="$APP_STORE_CONNECT_KEY_ID"
issuer="$APP_STORE_CONNECT_ISSUER_ID"
unset APP_STORE_CONNECT_PRIVATE_KEY APP_STORE_CONNECT_KEY_ID APP_STORE_CONNECT_ISSUER_ID
# ZIP members and symlink targets were checked before extraction.
ditto -x -k "$input/Ponlet-preflight.xcarchive.zip" "$work"
ditto -x -k "$input/Ponlet-local-sandbox.zip" "$work/local"
archive="$work/Ponlet-preflight.xcarchive"
local_app="$work/local/Ponlet.app"
version="$(python3 - "$input/build-input.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['version'])
PY
)"
number="$(python3 - "$input/build-input.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['build'])
PY
)"
python3 scripts/macos_store_metadata.py bundle "$local_app" "$version" "$number" > "$work/local-validation.json"
python3 scripts/macos_store_metadata.py hash-code "$local_app" "$work" > "$work/local-code.json"
cmp "$work/local-code.json" "$input/executable-code-sha256.json"
# Validate the staged archive itself before any authenticated export.
python3 scripts/macos_store_metadata.py bundle "$archive/Products/Applications/Ponlet.app" "$version" "$number" > "$work/archive-validation.json"
python3 scripts/macos_store_metadata.py hash-code "$archive/Products/Applications/Ponlet.app" "$work" > "$work/archive-code.json"
cmp "$work/local-code.json" "$work/archive-code.json"
python3 - "$work/ExportOptions.plist" <<'PY'
import plistlib,pathlib,sys
pathlib.Path(sys.argv[1]).write_bytes(plistlib.dumps(dict(method='app-store-connect',destination='export',teamID='K7VNGA9K78',signingStyle='automatic',manageAppVersionAndBuildNumber=False)))
PY
# This permission can create/update profiles and cloud-managed signing certificates.
# There is no destination=upload, API upload call, notarytool, or submit operation.
if ! xcodebuild -exportArchive -archivePath "$archive" -exportPath "$work/export" \
  -exportOptionsPlist "$work/ExportOptions.plist" -allowProvisioningUpdates \
  -authenticationKeyPath "$work/AuthKey.p8" -authenticationKeyID "$key_id" -authenticationKeyIssuerID "$issuer" \
  > "$work/export.log" 2>&1; then
  echo 'Experimental managed export failed; API/cloud-signing access or archive compatibility may be unavailable. Private logs are not artifacts.' >&2
  exit 1
fi
pkg="$work/export/Ponlet.pkg"
test -s "$pkg"
pkgutil --check-signature "$pkg" > "$work/pkg-signature.txt"
grep -Eq '3rd Party Mac Developer Installer:.*\(K7VNGA9K78\)' "$work/pkg-signature.txt"
grep -Fq 'Status: signed by a developer certificate issued by Apple' "$work/pkg-signature.txt"
pkgutil --expand-full "$pkg" "$work/expanded"
exported="$work/expanded/jp.yasagure.ponlet.pkg/Payload/Ponlet.app"
# Read only the public certificate embedded in the exported app; no keychain access.
codesign -d --extract-certificates="$work/distribution-cert" "$exported" 2>/dev/null
identity="$(shasum "$work/distribution-cert0" | cut -d ' ' -f1 | tr '[:lower:]' '[:upper:]')"
python3 scripts/macos_store_metadata.py bundle "$exported" "$version" "$number" --fingerprint "$identity" > "$work/store-validation.json"
python3 scripts/macos_store_metadata.py hash-code "$exported" "$work" > "$work/store-code.json"
cmp "$work/local-code.json" "$work/store-code.json"
mkdir managed-export-artifacts
cp "$pkg" managed-export-artifacts/Ponlet.pkg
cp "$work/store-validation.json" managed-export-artifacts/store-validation.json
cp "$work/store-code.json" managed-export-artifacts/executable-code-sha256.json
cp "$input/build-input.json" managed-export-artifacts/archive-build-input.json
export MANAGED_EXPORT_ARCHIVE_SHA="$EXPECTED_ARCHIVE_SHA256"
python3 - <<'PY'
import hashlib,json,os,pathlib,subprocess
root=pathlib.Path('managed-export-artifacts')
data={'mode':'experimental-managed-cloud-export','apple_upload':False,'source_archive_sha256':os.environ['MANAGED_EXPORT_ARCHIVE_SHA'],'export_helper_commit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'xcode':subprocess.check_output(['xcodebuild','-version'],text=True).strip(),'run_url':f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"}
(root/'export-input.json').write_text(json.dumps(data,indent=2)+'\n')
files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir() if p.is_file()}
(root/'SHA256.json').write_text(json.dumps(files,indent=2,sort_keys=True)+'\n')
PY
printf 'Managed package verified against reviewed archive code. Nothing uploaded or submitted to Apple.\n'
