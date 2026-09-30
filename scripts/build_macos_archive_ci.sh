#!/usr/bin/env bash
# A: no Developer account, API key, keychain mutation, or Store certificates.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "${GITHUB_ACTIONS:-}" == true && "$(uname -m)" == arm64 ]] || { echo 'Requires an arm64 GitHub-hosted runner.' >&2; exit 2; }
[[ -z "$(git status --porcelain)" && ! -e store-artifacts ]] || { echo 'Clean checkout and absent output directory required.' >&2; exit 2; }
# shellcheck disable=SC2016
git submodule foreach --recursive 'test -z "$(git status --porcelain)"' >/dev/null
if git submodule status --recursive | grep -Eq '^[+U-]'; then echo 'Uninitialized or changed submodule.' >&2; exit 2; fi
number=$(python3 scripts/macos_store_metadata.py number "$GITHUB_RUN_NUMBER" "$GITHUB_RUN_ATTEMPT" --override "${STORE_BUILD_NUMBER:-}")
python3 scripts/macos_store_metadata.py compare "$number" "${PREVIOUS_STORE_BUILD:?Confirm latest ASC build before running}"
work=$(mktemp -d "$RUNNER_TEMP/ponlet-archive.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
mkdir store-artifacts
export STORE_BUILD="$number"
python3 - <<'PY'
import json,os,pathlib,subprocess
commands={'commit':['git','rev-parse','HEAD'],'submodules':['git','submodule','status','--recursive'],'xcode':['xcodebuild','-version'],'sdk':['xcrun','--sdk','macosx','--show-sdk-version'],'go':['go','version'],'rust':['rustc','-Vv'],'node':['node','--version'],'tauri':['cargo','tauri','--version'],'xcodegen':['xcodegen','--version']}
data={k:subprocess.check_output(v,text=True).strip() for k,v in commands.items()}
data.update(version=json.loads(pathlib.Path('apps/tauri/tauri.conf.json').read_text())['version'],build=os.environ['STORE_BUILD'],input_dirty=False,archive_signing='ad-hoc sandbox staging; no Store certificates',run_url=f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}",run_attempt=os.environ['GITHUB_RUN_ATTEMPT'])
pathlib.Path('store-artifacts/build-input.json').write_text(json.dumps(data,indent=2)+'\n')
PY
version=$(python3 -c 'import json;print(json.load(open("store-artifacts/build-input.json"))["version"])')
python3 scripts/macos_store_metadata.py set-number "$number"
PONLET_MACOS_DERIVED_DATA="$work/build" PONLET_MACOS_SIGNING_IDENTITY=- bash scripts/build_apple_macos.sh
local_app="$work/build/Build/Products/release/Ponlet.app"
archive="$work/build/Ponlet-preflight.xcarchive"
python3 scripts/macos_store_metadata.py bundle "$local_app" "$version" "$number" > store-artifacts/local-validation.json
# Xcode archive may rebuild native wrapper differently. Stage the exact verified
# validation app into the archive, as in the successful local Store export.
rm -rf "$archive/Products/Applications/Ponlet.app"
ditto "$local_app" "$archive/Products/Applications/Ponlet.app"
python3 - "$archive/Info.plist" "$number" "$version" <<'PY'
import pathlib,plistlib,sys
p=pathlib.Path(sys.argv[1]);v=plistlib.loads(p.read_bytes());a=v['ApplicationProperties'];a.update(CFBundleVersion=sys.argv[2],CFBundleShortVersionString=sys.argv[3],SigningIdentity='-',Team='K7VNGA9K78');p.write_bytes(plistlib.dumps(v))
PY
python3 scripts/macos_store_metadata.py bundle "$archive/Products/Applications/Ponlet.app" "$version" "$number" > store-artifacts/archive-validation.json
python3 scripts/macos_store_metadata.py hash-code "$local_app" "$work" > store-artifacts/executable-code-sha256.json
python3 scripts/macos_store_metadata.py hash-code "$archive/Products/Applications/Ponlet.app" "$work" > "$work/archive-code.json"
cmp store-artifacts/executable-code-sha256.json "$work/archive-code.json"
# Discard archive-action symbols after replacing its rebuilt app. Include only
# build-action dSYMs whose UUIDs match the staged executables.
rm -rf "$archive/dSYMs"
python3 - "$work/build/Build/Products/release" "$archive" <<'PYDSYM'
import pathlib,re,shutil,subprocess,sys
products,archive=map(pathlib.Path,sys.argv[1:])
def uuids(path):
 text=subprocess.check_output(['dwarfdump','--uuid',str(path)],text=True)
 values=set(re.findall(r'UUID: ([A-Fa-f0-9-]+) \(([^)]+)\)',text))
 assert values, 'No dSYM/executable UUIDs'
 return values
for name,binary in [('Ponlet.app.dSYM','Contents/MacOS/Ponlet'),('PonletShareExtensionMac.appex.dSYM','Contents/PlugIns/PonletShareExtensionMac.appex/Contents/MacOS/PonletShareExtensionMac')]:
 source=products/name
 if source.exists():
  assert uuids(source)==uuids(archive/'Products/Applications/Ponlet.app'/binary), 'dSYM UUID mismatch'
  (archive/'dSYMs').mkdir(exist_ok=True)
  shutil.copytree(source,archive/'dSYMs'/name)
PYDSYM
ditto -c -k --sequesterRsrc --keepParent "$archive" store-artifacts/Ponlet-preflight.xcarchive.zip
ditto -c -k --sequesterRsrc --keepParent "$local_app" store-artifacts/Ponlet-local-sandbox.zip
# Symbols correspond to the staged build product, not a separately rebuilt wrapper.
if [[ -d "$work/build/Build/Products/release/Ponlet.app.dSYM" ]]; then
  ditto -c -k --sequesterRsrc --keepParent "$work/build/Build/Products/release/Ponlet.app.dSYM" store-artifacts/Ponlet.app.dSYM.zip
fi
python3 - <<'PY'
import hashlib,json,pathlib
root=pathlib.Path('store-artifacts');ui=pathlib.Path('web-ui/dist')
files={str(p.relative_to(ui)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(ui.rglob('*')) if p.is_file()};assert files
(root/'frontend-sha256.json').write_text(json.dumps(files,indent=2,sort_keys=True)+'\n')
hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir() if p.is_file()}
(root/'SHA256.json').write_text(json.dumps(hashes,indent=2,sort_keys=True)+'\n')
PY
printf 'A archive prepared: version %s build %s. No Apple credentials or upload.\n' "$version" "$number"
