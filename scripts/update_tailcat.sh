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
PATCH_FILE="$TAILCAT_DIR/patches/0001-android-selinux-netmon-fallback.patch"

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

if [ -f "$PATCH_FILE" ]; then
    git apply "$PATCH_FILE"
    echo -e "\033[0;32m✓ Applied local patch: $(basename "$PATCH_FILE")\033[0m"
fi

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
go build -ldflags "-s -w" -o "$OUT_DAEMON" ./bridge/native/daemon.go
echo -e "\033[0;32m✓ Built native tailcat_daemon\033[0m"

# 4. Build Web WASM Bridge and Gzip
echo -e "\n\033[0;33m[4/5] Compiling tailcat WebAssembly bridge...\033[0m"
OUT_WASM="$PROJECT_ROOT/dist/assets/tailcat.wasm"
OUT_WASM_GZ="$PROJECT_ROOT/dist/assets/tailcat.wasm.gz"

GOOS=js GOARCH=wasm go build -ldflags "-s -w" -o "$OUT_WASM" ./bridge/web/main.go
gzip -9 -c "$OUT_WASM" > "$OUT_WASM_GZ"

WASM_SIZE=$(du -h "$OUT_WASM_GZ" | cut -f1)
echo -e "\033[0;32m✓ Built tailcat.wasm (Gzip: ${WASM_SIZE})\033[0m"

# 5. Run Integration Test
echo -e "\n\033[0;33m[5/5] Running Tailcat WireGuard + DERP verification test...\033[0m"
go test -v -timeout 120s ./bridge/web/bridge_test.go
echo -e "\033[0;32m✓ Integration test passed!\033[0m"

echo -e "\n\033[0;36m==========================================================\033[0m"
echo -e "\033[0;32m🎉 Tailcat successfully updated!\033[0m"
echo -e "\033[0;32m   Submodule Commit: ${COMMIT_HASH} (${FULL_COMMIT})\033[0m"
echo -e "\033[0;32m   Native Daemon:    ${OUT_DAEMON}\033[0m"
echo -e "\033[0;32m   WASM Asset:       ${OUT_WASM_GZ}\033[0m"
echo -e "\033[0;36m==========================================================\033[0m"
