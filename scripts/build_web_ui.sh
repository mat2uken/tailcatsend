#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
cd "${repo_dir}/web-ui"

# Keep the lockfile as the source of truth for the reproducible UI build.
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run build -- --mode web
npm run build -- --mode tauri

printf 'Web UI built at %s and %s\n' "${repo_dir}/web-ui/dist/web" "${repo_dir}/web-ui/dist/native"
