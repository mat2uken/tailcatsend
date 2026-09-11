#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
out_dir="${repo_dir}/target/native/tailcat"
"${repo_dir}/scripts/apply_tailcat_patches.sh"
mkdir -p "${out_dir}"

host_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
host_arch="$(go env GOARCH)"
build_mode=c-archive
windows_native=false
case "${host_os}" in
  darwin)
    export CGO_ENABLED=1 GOOS=darwin GOARCH="${host_arch}"
    go_output="${out_dir}/libtailcat.a"
    ;;
  linux)
    export CGO_ENABLED=1 GOOS=linux GOARCH="${host_arch}"
    go_output="${out_dir}/libtailcat.a"
    ;;
  msys*|mingw*|cygwin*|windows_nt)
    export CGO_ENABLED=1 GOOS=windows GOARCH="${host_arch}"
    go_output="${out_dir}/tailcat.dll"
    build_mode=c-shared
    windows_native=true
    ;;
  *)
    echo "Unsupported host OS: ${host_os}" >&2
    exit 2
    ;;
esac

(cd "${repo_dir}/tailcat" && go build -trimpath -buildmode="${build_mode}" -o "${go_output}" ./bridge/native)

if [[ "${windows_native}" == true ]]; then
  # Go emits the Windows DLL and C header, while the MSVC linker used by the
  # Rust target needs an import library. Build the import library from the
  # exported C ABI so the DLL remains a separate runtime file.
  header="${out_dir}/tailcat.h"
  def_file="${out_dir}/tailcat.def"
  test -f "${header}"
  {
    printf 'LIBRARY tailcat.dll\nEXPORTS\n'
    sed -nE 's/^extern [^ ]+ (tc_[A-Za-z0-9_]+)\(.*/\1/p' "${header}" | sort -u
  } > "${def_file}"
  lib_tool="$(command -v lib.exe || true)"
  if [[ -z "${lib_tool}" ]]; then
    lib_tool="$(find '/c/Program Files/Microsoft Visual Studio' -type f -iname 'lib.exe' -print -quit 2>/dev/null || true)"
  fi
  if [[ -z "${lib_tool}" ]]; then
    echo 'MSVC lib.exe is required to create tailcat.lib' >&2
    exit 1
  fi
  case "${host_arch}" in
    amd64) machine=X64 ;;
    arm64) machine=ARM64 ;;
    386) machine=X86 ;;
    *) echo "Unsupported Windows architecture: ${host_arch}" >&2; exit 2 ;;
  esac
  def_file_win="$(cygpath -w "${def_file}")"
  lib_file="${out_dir}/tailcat.lib"
  lib_file_win="$(cygpath -w "${lib_file}")"
  MSYS_NO_PATHCONV=1 "${lib_tool}" \
    "/def:${def_file_win}" \
    "/machine:${machine}" \
    "/out:${lib_file_win}"
  test -f "${lib_file}"
fi

export PONLET_TAILCAT_LIB_DIR="${out_dir}"
export PONLET_TAILCAT_LIB_NAME=tailcat

"${repo_dir}/scripts/build_web_ui.sh"

# `cargo build` compiles the Tauri runner but does not apply the frontend
# asset embedding performed by the Tauri CLI.  Use the product build path so a
# directly launched desktop binary cannot open a blank WebView.
(cd "${repo_dir}/apps/tauri" && \
  cargo tauri build --no-bundle --ci --no-sign)

tauri_binary="${repo_dir}/target/release/tailsend-tauri"
if [[ -x "${tauri_binary}" ]]; then
  cp "${tauri_binary}" "${repo_dir}/target/release/tailsend"
elif [[ -x "${tauri_binary}.exe" ]]; then
  cp "${tauri_binary}.exe" "${repo_dir}/target/release/tailsend.exe"
  if [[ "${windows_native}" == true ]]; then
    cp "${out_dir}/tailcat.dll" "${repo_dir}/target/release/tailcat.dll"
  fi
else
  echo "Tauri CLI did not produce ${tauri_binary}" >&2
  exit 1
fi

echo "Tauri desktop shell built with Go bridge from ${go_output}"
