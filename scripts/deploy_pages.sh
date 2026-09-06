#!/bin/bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR/.."

echo "========================================================"
echo "   Deploying TailSend Web Client to Cloudflare Pages    "
echo "========================================================"

if [ ! -f "dist/index.html" ]; then
    echo "Error: dist/index.html not found!"
    exit 1
fi

echo "Deploying dist/ directory to project 'mktailcatsend'..."
mkdir -p target
mv -f dist/pkg/tailsend_web_bg.wasm target/tailsend_web_bg.wasm 2>/dev/null || true
mv -f dist/assets/tailcat.wasm target/tailcat.wasm 2>/dev/null || true

cleanup() {
    mv -f target/tailsend_web_bg.wasm dist/pkg/tailsend_web_bg.wasm 2>/dev/null || true
    mv -f target/tailcat.wasm dist/assets/tailcat.wasm 2>/dev/null || true
}
trap cleanup EXIT

npx wrangler pages deploy dist --project-name mktailcatsend --commit-dirty=true

echo ""
echo "✅ Cloudflare Pages Deployment Complete!"
echo "Live URL: https://mktailcatsend.pages.dev"
echo "========================================================"
