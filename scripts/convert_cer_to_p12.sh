#!/usr/bin/env bash
# ==============================================================================
# Converts Apple downloaded .cer and private key to .p12 & base64 for GitHub Secrets
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

CER_PATH="${1:-$HOME/Downloads/distribution.cer}"
KEY_PATH="$ROOT_DIR/build/certs/ios_distribution.key"

if [ ! -f "$CER_PATH" ]; then
    echo "❌ 証明書ファイルが見つかりません: $CER_PATH"
    echo "👉 Apple Developer からダウンロードした .cer ファイルのパスを指定してください："
    echo "   ./scripts/convert_cer_to_p12.sh ~/Downloads/distribution.cer"
    exit 1
fi

if [ ! -f "$KEY_PATH" ]; then
    echo "❌ 秘密鍵が見つかりません: $KEY_PATH"
    exit 1
fi

echo "========================================================"
echo " 🔐 Converting Apple .cer to .p12 (Distribution)        "
echo "========================================================"

echo "💡 .p12 に設定するパスワードを入力してください（CIの P12_PASSWORD に設定します）："
read -s -p "Enter password for .p12: " P12_PASS
echo ""

# 1. Convert DER .cer to PEM
PEM_PATH="$ROOT_DIR/build/certs/distribution.pem"
openssl x509 -inform DER -in "$CER_PATH" -out "$PEM_PATH"

# 2. Package into PKCS12 (.p12) with -legacy for macOS security command compatibility
P12_OUTPUT="$ROOT_DIR/build/certs/distribution.p12"
openssl pkcs12 -export -legacy \
  -inkey "$KEY_PATH" \
  -in "$PEM_PATH" \
  -out "$P12_OUTPUT" \
  -password "pass:$P12_PASS"

echo "✅ Generated: $P12_OUTPUT"

# 3. Generate base64 string
B64_TXT="$ROOT_DIR/build/certs/cert_base64.txt"
base64 < "$P12_OUTPUT" | tr -d '\n' > "$B64_TXT"

echo ""
echo "==================== [GitHub Secret 1] ===================="
echo "Name: BUILD_CERTIFICATE_BASE64"
echo "Value: (クリップボードにコピーしました！また $B64_TXT にも保存済み)"
cat "$B64_TXT" | pbcopy
echo "==========================================================="
echo ""
echo "==================== [GitHub Secret 2] ===================="
echo "Name: P12_PASSWORD"
echo "Value: $P12_PASS"
echo "==========================================================="
echo ""
echo "🎉 完了しました！GitHub の Secrets 画面に上記を貼り付けてください。"
