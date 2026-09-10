#!/usr/bin/env bash
# ==============================================================================
# TailSend Automated Upstream Tailcat Updater & Builder (macOS / Linux / Bash)
# Usage:
#   ./scripts/update_tailcat.sh              (defaults to upstream 'main' HEAD)
#   ./scripts/update_tailcat.sh main
#   ./scripts/update_tailcat.sh 7465d56
# ==============================================================================
set -euo pipefail

TARGET="${1:-main}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAILCAT_DIR="$PROJECT_ROOT/tailcat"

echo -e "\033[0;36m==========================================================\033[0m"
echo -e "\033[0;36m         Tailcat Upstream Synchronizer & Builder          \033[0m"
echo -e "\033[0;36m==========================================================\033[0m"
echo -e "\033[0;33mTarget: github.com/tailscale/tailcat@${TARGET}\033[0m"

# 1. Update Tailcat Git Submodule & Apply Patches
echo -e "\n\033[0;33m[1/5] Updating Tailcat git submodule...\033[0m"
SUBMODULE_DIR="$TAILCAT_DIR/pkg/tailcat"

git submodule sync --quiet
git submodule update --init --recursive --quiet

cd "$SUBMODULE_DIR"
git fetch origin --tags --quiet
git checkout --force "${TARGET}"
if [ "${TARGET}" = "main" ]; then
    git pull --ff-only origin main
fi
git reset --hard HEAD

COMMIT_HASH=$(git rev-parse --short=7 HEAD | tr -d '[:space:]')
FULL_COMMIT=$(git rev-parse HEAD | tr -d '[:space:]')
echo -e "\033[0;32m✓ Checked out submodule commit: ${COMMIT_HASH}\033[0m"

"$PROJECT_ROOT/scripts/apply_tailcat_patches.sh"

# 2. Update Go Module and Metadata
echo -e "\n\033[0;33m[2/5] Updating Go module dependencies and metadata...\033[0m"
cd "$TAILCAT_DIR"
go mod tidy

# Update bridgeVersion in bridge/web/main.go
BRIDGE_MAIN="$TAILCAT_DIR/bridge/web/main.go"
if [[ -f "$BRIDGE_MAIN" ]]; then
    sed -i.bak -E "s/\"bridgeVersion\":[[:space:]]*\"[^\"]*\"/\"bridgeVersion\": \"1.0.0-tailcat-${COMMIT_HASH}\"/" "$BRIDGE_MAIN"
    rm -f "${BRIDGE_MAIN}.bak"
    echo -e "\033[0;32m✓ Updated bridgeVersion to: 1.0.0-tailcat-${COMMIT_HASH}\033[0m"
fi

# Update upstream.lock
LOCK_FILE="$TAILCAT_DIR/upstream.lock"
if [[ -f "$LOCK_FILE" ]]; then
    sed -i.bak -E "s/commit=[0-9a-f]+/commit=${FULL_COMMIT}/" "$LOCK_FILE"
    rm -f "${LOCK_FILE}.bak"
    echo -e "\033[0;32m✓ Updated upstream.lock to commit: ${COMMIT_HASH}\033[0m"
fi

# 3. Build Native Daemon
echo -e "\n\033[0;33m[3/5] Compiling native tailcat daemon...\033[0m"
mkdir -p "$PROJECT_ROOT/target/release"
OUT_DAEMON="$PROJECT_ROOT/target/release/tailcat_daemon"
go build -tags tailcat_daemon -ldflags "-s -w" -o "$OUT_DAEMON" ./bridge/native
echo -e "\033[0;32m✓ Built native tailcat_daemon\033[0m"

# 4. Build Web WASM Bridge, Optimize with wasm-opt, and Gzip
echo -e "\n\033[0;33m[4/5] Compiling tailcat WebAssembly bridge...\033[0m"
OUT_WASM="$PROJECT_ROOT/dist/assets/tailcat.wasm"
OUT_WASM_GZ="$PROJECT_ROOT/dist/assets/tailcat.wasm.gz"

# WasmTags derived from tailcat/pkg/tailcat/internal/buildtags.WasmTags()
WASM_TAGS="netgo,omitidna,omitpemdecrypt,osusergo,ts_omit_ace,ts_omit_acme,ts_omit_advertiseexitnode,ts_omit_advertiseroutes,ts_omit_appconnectors,ts_omit_aws,ts_omit_bakedroots,ts_omit_bird,ts_omit_c2n,ts_omit_cachenetmap,ts_omit_captiveportal,ts_omit_capture,ts_omit_cliconndiag,ts_omit_clientmetrics,ts_omit_clientupdate,ts_omit_cloud,ts_omit_colorable,ts_omit_completion,ts_omit_completion_scripts,ts_omit_conn25,ts_omit_dbus,ts_omit_debug,ts_omit_debugeventbus,ts_omit_debugportmapper,ts_omit_desktop_sessions,ts_omit_dns,ts_omit_doctor,ts_omit_drive,ts_omit_favorites,ts_omit_flashappliance,ts_omit_gro,ts_omit_health,ts_omit_hujsonconf,ts_omit_identityfederation,ts_omit_ipnbus,ts_omit_iptables,ts_omit_kube,ts_omit_linkspeed,ts_omit_linuxdnsfight,ts_omit_listenrawdisco,ts_omit_logtail,ts_omit_netlog,ts_omit_networkmanager,ts_omit_oauthkey,ts_omit_osrouter,ts_omit_outboundproxy,ts_omit_peerapiclient,ts_omit_peerapiserver,ts_omit_portlist,ts_omit_portmapper,ts_omit_posture,ts_omit_qrcodes,ts_omit_relayserver,ts_omit_remoteconfig,ts_omit_resolved,ts_omit_routecheck,ts_omit_runtimemetrics,ts_omit_sdnotify,ts_omit_serve,ts_omit_serviceclientprefs,ts_omit_ssh,ts_omit_synology,ts_omit_syslog,ts_omit_syspolicy,ts_omit_systray,ts_omit_taildrop,ts_omit_tailnetlock,ts_omit_tap,ts_omit_tpm,ts_omit_tundevstats,ts_omit_unixsocketidentity,ts_omit_useexitnode,ts_omit_useproxy,ts_omit_usermetrics,ts_omit_useroutes,ts_omit_wakeonlan,ts_omit_webbrowser,ts_omit_webclient"

GOOS=js GOARCH=wasm go build -trimpath -tags "$WASM_TAGS" -ldflags "-s -w" -o "$OUT_WASM" ./bridge/web/main.go

echo -e "\033[0;33mOptimizing WASM with wasm-opt -Oz...\033[0m"
npx wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext "$OUT_WASM" -o "$OUT_WASM"

gzip -9 -c "$OUT_WASM" > "$OUT_WASM_GZ"

WASM_RAW_SIZE=$(du -h "$OUT_WASM" | cut -f1)
WASM_GZ_SIZE=$(du -h "$OUT_WASM_GZ" | cut -f1)
echo -e "\033[0;32m✓ Built and optimized tailcat.wasm: ${WASM_RAW_SIZE} (Gzip: ${WASM_GZ_SIZE})\033[0m"

# 5. Run Integration Test
echo -e "\n\033[0;33m[5/5] Running Tailcat bridge verification tests...\033[0m"
go test -v -timeout 120s ./bridge/native ./bridge/transportpath
wasm_test="$(mktemp "${TMPDIR:-/tmp}/tailcat-bridge-test.XXXXXX.wasm")"
trap 'rm -f "$wasm_test"' EXIT
GOOS=js GOARCH=wasm go test -c -o "$wasm_test" ./bridge/web
echo -e "\033[0;32m✓ Integration test passed!\033[0m"

echo -e "\n\033[0;36m==========================================================\033[0m"
echo -e "\033[0;32m🎉 Tailcat successfully updated!\033[0m"
echo -e "\033[0;32m   Submodule Commit: ${COMMIT_HASH} (${FULL_COMMIT})\033[0m"
echo -e "\033[0;32m   Native Daemon:    ${OUT_DAEMON}\033[0m"
echo -e "\033[0;32m   WASM Asset:       ${OUT_WASM_GZ}\033[0m"
echo -e "\033[0;36m==========================================================\033[0m"
