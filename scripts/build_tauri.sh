#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
out_dir="${repo_dir}/target/native/tailcat"
mkdir -p "${out_dir}"

host_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
host_arch="$(go env GOARCH)"
build_mode=c-archive
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
    ;;
  *)
    echo "Unsupported host OS: ${host_os}" >&2
    exit 2
    ;;
esac

(cd "${repo_dir}/tailcat" && go build -trimpath -buildmode="${build_mode}" -o "${go_output}" ./bridge/native)

export PONLET_TAILCAT_LIB_DIR="${out_dir}"
export PONLET_TAILCAT_LIB_NAME=tailcat

"${repo_dir}/scripts/build_web_ui.sh"
(cd "${repo_dir}" && cargo build -p tailsend-tauri)

echo "Tauri shell built with Go bridge from ${go_output}"
