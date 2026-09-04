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

# 1. Update Go Module
echo -e "\n\033[0;33m[1/5] Fetching upstream tailcat module...\033[0m"
cd "$TAILCAT_DIR"
go get "github.com/tailscale/tailcat@${TARGET}"
go mod tidy

VERSION=$(go list -m -json github.com/tailscale/tailcat | grep '"Version":' | sed -E 's/.*"Version": "([^"]+)".*/\1/')
echo -e "\033[0;32m✓ Resolved Tailcat version: ${VERSION}\033[0m"

# Extract short commit hash
COMMIT_HASH="${TARGET}"
if [[ "$VERSION" =~ -([0-9a-f]{12})$ ]]; then
    COMMIT_HASH="${BASH_REMATCH[1]:0:7}"
elif [[ "$VERSION" =~ ^v?([0-9a-f]{7,40}) ]]; then
    COMMIT_HASH="${BASH_REMATCH[1]:0:7}"
fi

# Update bridgeVersion in bridge/web/main.go
BRIDGE_MAIN="$TAILCAT_DIR/bridge/web/main.go"
if [[ -f "$BRIDGE_MAIN" ]]; then
    sed -i.bak -E "s/\"bridgeVersion\":[[:space:]]*\"[^\"]*\"/\"bridgeVersion\": \"1.0.0-tailcat-${COMMIT_HASH}\"/" "$BRIDGE_MAIN"
    rm -f "${BRIDGE_MAIN}.bak"
    echo -e "\033[0;32m✓ Updated bridgeVersion to: 1.0.0-tailcat-${COMMIT_HASH}\033[0m"
fi

# 2. Update local source mirror in tailcat/pkg/tailcat
echo -e "\n\033[0;33m[2/5] Updating local source mirror in tailcat/pkg/tailcat...\033[0m"
MIRROR_DIR="$TAILCAT_DIR/pkg/tailcat"
TEMP_CLONE=$(mktemp -d 2>/dev/null || mktemp -d -t 'tailcat_sync')

if git clone --depth 1 "https://github.com/tailscale/tailcat.git" "$TEMP_CLONE" 2>/dev/null; then
    mkdir -p "$MIRROR_DIR"
    rsync -a --exclude='.git' "$TEMP_CLONE/" "$MIRROR_DIR/" || cp -R "$TEMP_CLONE"/* "$MIRROR_DIR/"
    echo -e "\033[0;32m✓ Updated tailcat/pkg/tailcat mirror\033[0m"
else
    echo -e "\033[0;33m⚠ Local mirror git clone skipped. Go module is still fully updated.\033[0m"
fi
rm -rf "$TEMP_CLONE"

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
echo -e "\033[0;32m🎉 Tailcat successfully updated to: ${VERSION}\033[0m"
echo -e "\033[0;32m   Commit: ${COMMIT_HASH}\033[0m"
echo -e "\033[0;32m   Native Daemon: ${OUT_DAEMON}\033[0m"
echo -e "\033[0;32m   WASM Asset:    ${OUT_WASM_GZ}\033[0m"
echo -e "\033[0;36m==========================================================\033[0m"
