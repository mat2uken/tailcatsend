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

status_patch="${repo_dir}/tailcat/patches/0003-tailcat-status-peer-report.patch"
if [[ -f "${status_patch}" ]]; then
  if git -C "${repo_dir}/tailcat/pkg/tailcat" apply --check --unidiff-zero "${status_patch}" >/dev/null 2>&1; then
    git -C "${repo_dir}/tailcat/pkg/tailcat" apply --unidiff-zero "${status_patch}"
  fi
fi

mobile_target=""
lib_dir=""
lib_name="tailcat"

if [[ "${platform}" == "ios" || "${platform}" == "ios-sim" ]]; then
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
  mkdir -p "${repo_dir}/apps/tauri/gen/apple/Externals/arm64/${configuration}"
  cp "${archive_dir}/libtailcat.a" \
    "${repo_dir}/apps/tauri/gen/apple/Externals/arm64/${configuration}/libtailcat.a"
else
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
  (cd "${repo_dir}/apps/tauri" && cargo tauri android build "${tauri_args[@]}" --target aarch64 "--${android_artifact}")
else
  if ! command -v xcodegen >/dev/null 2>&1; then
    echo "xcodegen is required to regenerate the Tauri iOS project" >&2
    exit 1
  fi
  # The Tauri CLI moves the archive's app into this directory. Remove only
  # the previous generated product so a repeated build is deterministic.
  if [[ "${mobile_target}" == "aarch64-sim" ]]; then
    rm -rf "${repo_dir}/apps/tauri/gen/apple/build/arm64-sim"
  else
    rm -rf "${repo_dir}/apps/tauri/gen/apple/build/arm64"
  fi
  (cd "${repo_dir}/apps/tauri/gen/apple" && xcodegen generate)
  (cd "${repo_dir}/apps/tauri" && cargo tauri ios build "${tauri_args[@]}" --target "${mobile_target}")
fi
