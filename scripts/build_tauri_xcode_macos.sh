#!/usr/bin/env bash
# Build both macOS slices of the Tauri runner and Share Extension libraries.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
configuration="${CONFIGURATION:-release}"
archs="${PONLET_MACOS_ARCHS:-${ARCHS:-arm64 x86_64}}"
macos_min="${PONLET_MACOS_DEPLOYMENT_TARGET:-${MACOSX_DEPLOYMENT_TARGET:-13.0}}"
export MACOSX_DEPLOYMENT_TARGET="${macos_min}"
# Xcode's deployment target is not applied to Go's cgo objects by default.
# Pass the minimum explicitly so every object matches the app target.
export CGO_CFLAGS="${CGO_CFLAGS:+${CGO_CFLAGS} }-mmacosx-version-min=${macos_min}"
export CGO_LDFLAGS="${CGO_LDFLAGS:+${CGO_LDFLAGS} }-mmacosx-version-min=${macos_min}"
out_dir="${repo_dir}/target/native/tailcat"
mkdir -p "${out_dir}/macos-universal"

# The archive action builds the same sources a second time. Reuse only slices
# verified during the preceding build, so archive creation does not rerun Go,
# Cargo, and the web frontend.
if [[ "${PONLET_MACOS_PREBUILT:-0}" == 1 ]]; then
  for arch in ${archs}; do
    for library in libtailcat.a libponlet_share_session.a; do
      path="${repo_dir}/apps/tauri/gen/apple/Externals/${arch}/${configuration}/${library}"
      test "$(lipo -archs "${path}")" = "${arch}"
    done
    lipo -archs "${out_dir}/macos-universal/tailsend-tauri" | tr ' ' '\n' | grep -Fxq "${arch}"
  done
  exit 0
fi

build_arm64() {
  # The existing native desktop build embeds the web frontend in the arm64 binary.
  rm -f "${out_dir}/libtailcat.a"
  GOARCH=arm64 "${repo_dir}/scripts/build_tauri.sh"
  local externals="${repo_dir}/apps/tauri/gen/apple/Externals/arm64/${configuration}"
  mkdir -p "${externals}"
  cp "${out_dir}/libtailcat.a" "${externals}/libtailcat.a"
  (cd "${repo_dir}" && cargo build -p ponlet-share-session --target aarch64-apple-darwin --release)
  cp "${repo_dir}/target/aarch64-apple-darwin/release/libponlet_share_session.a" \
     "${externals}/libponlet_share_session.a"
  test "$(lipo -archs "${externals}/libtailcat.a")" = arm64
  test "$(lipo -archs "${externals}/libponlet_share_session.a")" = arm64
  test "$(lipo -archs "${repo_dir}/target/release/tailsend-tauri")" = arm64
  cp "${repo_dir}/target/release/tailsend-tauri" "${out_dir}/macos-universal/tailsend-tauri-arm64"
}

build_x86_64() {
  local native="${out_dir}/macos-x86_64"
  local externals="${repo_dir}/apps/tauri/gen/apple/Externals/x86_64/${configuration}"
  mkdir -p "${native}" "${externals}"
  # Keep this archive away from the arm64 archive used by the native build.
  (cd "${repo_dir}/tailcat" && GOOS=darwin GOARCH=amd64 CGO_ENABLED=1 \
    CC="clang -arch x86_64" go build -trimpath -buildmode=c-archive \
    -o "${native}/libtailcat.a" ./bridge/native)
  cp "${native}/libtailcat.a" "${externals}/libtailcat.a"
  (cd "${repo_dir}" && cargo build -p ponlet-share-session --target x86_64-apple-darwin --release)
  cp "${repo_dir}/target/x86_64-apple-darwin/release/libponlet_share_session.a" \
     "${externals}/libponlet_share_session.a"
  test "$(lipo -archs "${externals}/libtailcat.a")" = x86_64
  test "$(lipo -archs "${externals}/libponlet_share_session.a")" = x86_64
  (cd "${repo_dir}/apps/tauri" && PONLET_TAILCAT_LIB_DIR="${native}" \
    PONLET_TAILCAT_LIB_NAME=tailcat \
    cargo tauri build --target x86_64-apple-darwin --no-bundle --ci --no-sign)
  local binary="${repo_dir}/target/x86_64-apple-darwin/release/tailsend-tauri"
  test "$(lipo -archs "${binary}")" = x86_64
  cp "${binary}" "${out_dir}/macos-universal/tailsend-tauri-x86_64"
}

selected=()
for arch in ${archs}; do
  case "${arch}" in
    arm64) build_arm64 ;;
    x86_64) build_x86_64 ;;
    *) echo "Unsupported macOS architecture: ${arch}" >&2; exit 2 ;;
  esac
  selected+=("${out_dir}/macos-universal/tailsend-tauri-${arch}")
done
if [[ ${#selected[@]} -eq 0 ]]; then
  echo 'No macOS architectures selected' >&2
  exit 2
fi
if [[ ${#selected[@]} -eq 1 ]]; then
  cp "${selected[0]}" "${out_dir}/macos-universal/tailsend-tauri"
else
  lipo -create "${selected[@]}" -output "${out_dir}/macos-universal/tailsend-tauri"
fi
echo "macOS Tauri architectures: $(lipo -archs "${out_dir}/macos-universal/tailsend-tauri")"
