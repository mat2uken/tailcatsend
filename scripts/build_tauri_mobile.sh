#!/usr/bin/env bash
set -euo pipefail

# Build the Tauri mobile shell with the same Go Tailcat bridge and VanJS
# bundle used by the desktop shell. The generated native projects live below
# apps/tauri/gen and are created with `cargo tauri ios/android init`.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
platform="${1:-}"
mode="${2:-debug}"
android_artifact="${PONLET_ANDROID_ARTIFACT:-apk}"

if [[ "${platform}" != "ios" && "${platform}" != "ios-sim" && "${platform}" != "android" ]]; then
  echo "usage: $0 ios|ios-sim|android [debug|release]" >&2
  exit 2
fi
if [[ "${mode}" != "debug" && "${mode}" != "release" ]]; then
  echo "mode must be debug or release" >&2
  exit 2
fi
if [[ "${android_artifact}" != "apk" && "${android_artifact}" != "aab" ]]; then
  echo "PONLET_ANDROID_ARTIFACT must be apk or aab" >&2
  exit 2
fi

"${repo_dir}/scripts/build_web_ui.sh"

"${repo_dir}/scripts/apply_tailcat_patches.sh"

mobile_target=""
lib_dir=""
lib_name="tailcat"

if [[ "${platform}" == "ios" || "${platform}" == "ios-sim" ]]; then
  # Swift package dependencies must use the same deployment target as the app.
  export IPHONEOS_DEPLOYMENT_TARGET=17.0
  if [[ "${platform}" == "ios" ]]; then
    sdk="iphoneos"
    min_flag="-miphoneos-version-min=17.0"
    mobile_target="aarch64"
    archive_dir="${repo_dir}/target/native/tailcat/ios"
  else
    sdk="iphonesimulator"
    min_flag="-mios-simulator-version-min=17.0"
    mobile_target="aarch64-sim"
    archive_dir="${repo_dir}/target/native/tailcat/ios-sim"
  fi
  mkdir -p "${archive_dir}"
  sdk_path="$(xcrun --sdk "${sdk}" --show-sdk-path)"
  clang="$(xcrun --sdk "${sdk}" --find clang)"
  export CGO_ENABLED=1
  (cd "${repo_dir}/tailcat" && \
    CC="${clang} -isysroot ${sdk_path} -arch arm64 ${min_flag}" \
    GOOS=ios GOARCH=arm64 \
    go build -trimpath -buildmode=c-archive \
      -o "${archive_dir}/libtailcat.a" ./bridge/native)
  lib_dir="${archive_dir}"
  configuration="${mode}"
  externals_dir="${repo_dir}/apps/tauri/gen/apple/Externals"
  # XcodeGen treats every file below Externals as a resource. Keep only the
  # current configuration so a debug build followed by release cannot add two
  # resources with the same libtailcat.a basename.
  rm -rf "${externals_dir}/arm64/debug" "${externals_dir}/arm64/release"
  rm -rf "${externals_dir}/x86_64/debug" "${externals_dir}/x86_64/release"
  mkdir -p "${externals_dir}/arm64/${configuration}"
  cp "${archive_dir}/libtailcat.a" \
    "${externals_dir}/arm64/${configuration}/libtailcat.a"
else
  android_properties="${repo_dir}/apps/tauri/gen/android/app/tauri.properties"
  app_version="$(python3 - "${repo_dir}/apps/tauri/tauri.conf.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    print(json.load(source)["version"])
PY
)"
  if [[ -n "${PONLET_ANDROID_VERSION_CODE:-}" ]]; then
    android_version_code="${PONLET_ANDROID_VERSION_CODE}"
  else
    android_version_code="$(python3 - "${app_version}" <<'PY'
import sys

parts = [int(part) for part in sys.argv[1].split(".")[:3]]
parts += [0] * (3 - len(parts))
major, minor, patch = parts
print(major * 1_000_000 + minor * 1_000 + patch)
PY
    )"
  fi
  if [[ ! "${android_version_code}" =~ ^[1-9][0-9]*$ ]] || (( android_version_code > 2100000000 )); then
    echo "Invalid Android version code: ${android_version_code}" >&2
    exit 1
  fi
  if [[ -f "${android_properties}" ]]; then
    python3 - "${android_properties}" "${app_version}" "${android_version_code}" <<'PY'
from pathlib import Path
import sys

path, version_name, version_code = sys.argv[1:]
lines = []
seen_name = False
seen_code = False
for line in Path(path).read_text().splitlines():
    if line.startswith("tauri.android.versionName="):
        lines.append(f"tauri.android.versionName={version_name}")
        seen_name = True
    elif line.startswith("tauri.android.versionCode="):
        lines.append(f"tauri.android.versionCode={version_code}")
        seen_code = True
    else:
        lines.append(line)
if not seen_name:
    lines.append(f"tauri.android.versionName={version_name}")
if not seen_code:
    lines.append(f"tauri.android.versionCode={version_code}")
Path(path).write_text("\n".join(lines) + "\n")
PY
    echo "Android version ${app_version} (${android_version_code})"
  fi
  android_home="${ANDROID_HOME:-${HOME}/Library/Android/sdk}"
  ndk_root="${ANDROID_NDK_ROOT:-${android_home}/ndk/28.2.13676358}"
  toolchain_root="$(find "${ndk_root}/toolchains/llvm/prebuilt" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  if [[ -z "${toolchain_root}" ]]; then
    echo "Android NDK toolchain not found under ${ndk_root}" >&2
    exit 1
  fi
  mkdir -p "${repo_dir}/target/native/tailcat/android"
  export CGO_ENABLED=1
  export CC="${toolchain_root}/bin/aarch64-linux-android33-clang"
  export CXX="${toolchain_root}/bin/aarch64-linux-android33-clang++"
  (cd "${repo_dir}/tailcat" && \
    GOOS=android GOARCH=arm64 \
    go build -trimpath -ldflags="-checklinkname=0" -buildmode=c-shared \
      -o "${repo_dir}/target/native/tailcat/android/libtailcat.so" ./bridge/native)
  mkdir -p "${repo_dir}/apps/tauri/gen/android/app/src/main/jniLibs/arm64-v8a"
  cp "${repo_dir}/target/native/tailcat/android/libtailcat.so" \
    "${repo_dir}/apps/tauri/gen/android/app/src/main/jniLibs/arm64-v8a/"
  lib_dir="${repo_dir}/target/native/tailcat/android"
fi

export PONLET_TAILCAT_LIB_DIR="${lib_dir}"
export PONLET_TAILCAT_LIB_NAME="${lib_name}"

tauri_args=(--ci)
if [[ "${mode}" == "debug" ]]; then
  tauri_args+=(--debug)
fi

if [[ "${platform}" == "android" ]]; then
  if [[ -n "${PONLET_ANDROID_VERSION_CODE:-}" ]]; then
    tauri_args+=(--config "{\"bundle\":{\"android\":{\"versionCode\":${android_version_code}}}}")
  fi
  (cd "${repo_dir}/apps/tauri" && cargo tauri android build "${tauri_args[@]}" --target aarch64 "--${android_artifact}")
  if [[ -n "${PONLET_ANDROID_VERSION_CODE:-}" ]]; then
    test -f "${android_properties}"
    grep -Fx "tauri.android.versionCode=${android_version_code}" "${android_properties}"
  fi
else
  if ! command -v xcodegen >/dev/null 2>&1; then
    echo "xcodegen is required to regenerate the Tauri iOS project" >&2
    exit 1
  fi
  if [[ -n "${PONLET_IOS_BUILD_NUMBER:-}" ]]; then
    tauri_args+=(--build-number "${PONLET_IOS_BUILD_NUMBER}")
  fi
  # The Tauri CLI moves the archive's app into this directory. Remove only
  # the previous generated product so a repeated build is deterministic.
  if [[ "${mobile_target}" == "aarch64-sim" ]]; then
    rm -rf "${repo_dir}/apps/tauri/gen/apple/build/arm64-sim"
  else
    rm -rf "${repo_dir}/apps/tauri/gen/apple/build/arm64"
  fi
  # XcodeGen validates every source path before writing the project. The
  # frontend asset directory is generated during a build and is empty in a
  # clean checkout, so create it before project generation.
  mkdir -p "${repo_dir}/apps/tauri/gen/apple/assets"
  apple_project_dir="${repo_dir}/apps/tauri/gen/apple"
  apple_project_spec="${apple_project_dir}/project.yml"
  if [[ "${platform}" == "ios" && -n "${DEVELOPMENT_TEAM:-}" && -n "${PROVISIONING_PROFILE_SPECIFIER:-}" ]]; then
    # The Tauri CLI imports the certificate/profile, but XcodeGen still needs
    # the manual signing settings in the generated project. Keep the checked
    # in spec portable and add the CI values only to this temporary spec.
    signed_project_spec="$(mktemp "${apple_project_dir}/project-signing.XXXXXX.yml")"
    trap 'rm -f -- "${signed_project_spec}"' EXIT
    python3 - "${apple_project_spec}" "${signed_project_spec}" \
      "${DEVELOPMENT_TEAM}" "${CODE_SIGN_STYLE:-Manual}" \
      "${CODE_SIGN_IDENTITY:-Apple Distribution}" "${PROVISIONING_PROFILE_SPECIFIER}" <<'PY'
from pathlib import Path
import json
import sys

source, target, team, style, identity, profile = sys.argv[1:]
text = Path(source).read_text()
needle = "      PRODUCT_BUNDLE_IDENTIFIER: jp.yasagure.ponlet\n"
if needle not in text:
    raise SystemExit("iOS project spec is missing the Ponlet bundle identifier")
settings = {
    "DEVELOPMENT_TEAM": team,
    "CODE_SIGN_STYLE": style,
    "CODE_SIGN_IDENTITY": identity,
    "PROVISIONING_PROFILE_SPECIFIER": profile,
}
overlay = "".join(f"      {key}: {json.dumps(value)}\n" for key, value in settings.items())
Path(target).write_text(text.replace(needle, needle + overlay, 1))
PY
    apple_project_spec="${signed_project_spec}"

    # Tauri's export option discovery does not reliably derive the profile
    # map from an XcodeGen-generated pbxproj. Supply the distribution profile
    # explicitly, then restore the checked-in development spec on exit.
    export_options_path="${apple_project_dir}/ExportOptions.plist"
    export_options_backup="$(mktemp "${apple_project_dir}/ExportOptions.backup.XXXXXX.plist")"
    cp "${export_options_path}" "${export_options_backup}"
    restore_ios_signing_files() {
      cp "${export_options_backup}" "${export_options_path}"
      rm -f -- "${export_options_backup}" "${signed_project_spec}"
    }
    trap restore_ios_signing_files EXIT
    python3 - "${export_options_path}" "${DEVELOPMENT_TEAM}" \
      "${CODE_SIGN_IDENTITY:-Apple Distribution}" "${PROVISIONING_PROFILE_SPECIFIER}" <<'PY'
from pathlib import Path
import plistlib
import sys

path, team, identity, profile = sys.argv[1:]
options = {
    "method": "app-store",
    "teamID": team,
    "uploadSymbols": True,
    "compileBitcode": False,
    "signingStyle": "manual",
    "signingCertificate": identity,
    "provisioningProfiles": {"jp.yasagure.ponlet": profile},
}
with Path(path).open("wb") as output:
    plistlib.dump(options, output, sort_keys=False)
PY
  fi
  (cd "${apple_project_dir}" && xcodegen generate --spec "$(basename "${apple_project_spec}")")
  (cd "${repo_dir}/apps/tauri" && cargo tauri ios build "${tauri_args[@]}" --target "${mobile_target}")
fi
