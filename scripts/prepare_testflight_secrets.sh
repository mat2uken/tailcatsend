#!/usr/bin/env bash
# ==============================================================================
# Helper Script to prepare GitHub Secrets for iOS TestFlight CI
# ==============================================================================
set -euo pipefail

echo "========================================================"
echo " 🍎 TailSend — TestFlight GitHub Secrets Setup Helper   "
echo "========================================================"
echo ""

mkdir -p build/certs

echo "1. Distribution Certificate (.p12)"
echo "--------------------------------------------------------"
echo "現在キーチェーンに登録されている署名証明書一覧："
security find-identity -v -p codesigning
echo ""
echo "💡 Apple Developer アカウントで作成した『Apple Distribution』証明書と秘密鍵を"
echo "   書き出した .p12 ファイルを用意してください。"
echo ""
echo "すでに .p12 ファイルがある場合はパスを入力してください（空欄の場合はキーチェーンから書き出しを試みます）："
read -p "Existing .p12 file path (or press Enter): " EXISTING_P12

P12_FILE="build/certs/Distribution.p12"
if [ -n "$EXISTING_P12" ] && [ -f "$EXISTING_P12" ]; then
    cp "$EXISTING_P12" "$P12_FILE"
    echo "💡 .p12 のパスワードを入力してください："
    read -s -p "Enter .p12 password: " P12_PASS
    echo ""
else
    echo "キーチェーンから書き出し用のパスワードを入力してください（CIに登録する P12_PASSWORD になります）："
    read -s -p "Enter password for export: " P12_PASS
    echo ""
    security export -k "$HOME/Library/Keychains/login.keychain-db" -t identities -f pkcs12 -P "$P12_PASS" -o "$P12_FILE" 2>/dev/null || {
        echo "⚠️ キーチェーンアクセス.app から手動で書き出してください。"
    }
fi

if [ -f "$P12_FILE" ]; then
    echo "✅ .p12 exported to $P12_FILE"
    CERT_B64=$(base64 < "$P12_FILE" | tr -d '\n')
    echo ""
    echo "==================== [GitHub Secret 1] ===================="
    echo "Name: BUILD_CERTIFICATE_BASE64"
    echo "Value (先頭80文字): ${CERT_B64:0:80}..."
    echo "(全文字列は build/certs/cert_base64.txt に保存しました)"
    echo "$CERT_B64" > build/certs/cert_base64.txt
    echo "==========================================================="
    echo ""
    echo "==================== [GitHub Secret 2] ===================="
    echo "Name: P12_PASSWORD"
    echo "Value: (上記で入力したパスワード)"
    echo "==========================================================="
else
    echo "❌ 自動エクスポートできませんでした。『キーチェーンアクセス』から"
    echo "   Apple Distribution 証明書を .p12 形式で書き出してください。"
fi

echo ""
echo "2. Provisioning Profile (.mobileprovision)"
echo "--------------------------------------------------------"
echo "Apple Developer ポータルからダウンロードした"
echo "『App Store 配布用プロビジョニングプロファイル』のパスを入力してください："
echo "（例: ~/Downloads/TailSend_AppStore.mobileprovision）"
read -p "Profile path: " PROF_PATH

if [ -f "$PROF_PATH" ]; then
    PROF_B64=$(base64 < "$PROF_PATH" | tr -d '\n')
    echo ""
    echo "==================== [GitHub Secret 3] ===================="
    echo "Name: BUILD_PROVISION_PROFILE_BASE64"
    echo "Value (先頭80文字): ${PROF_B64:0:80}..."
    echo "(全文字列は build/certs/profile_base64.txt に保存しました)"
    echo "$PROF_B64" > build/certs/profile_base64.txt
    echo "==========================================================="
else
    echo "⚠️ ファイルが見つかりませんでした。入手後に以下のコマンドで base64 化できます："
    echo "   base64 < <profile.mobileprovision> | tr -d '\n' | pbcopy"
fi

echo ""
echo "========================================================"
echo " 🔑 App Store Connect API Key (GitHub Secrets 4, 5, 6)  "
echo "========================================================"
echo "App Store Connect (ユーザーとアクセス > 統合 > APIキー) から取得したキー情報を設定してください："
echo "- APP_STORE_CONNECT_KEY_ID:     Key ID (例: D383X7XXXX)"
echo "- APP_STORE_CONNECT_ISSUER_ID:  Issuer ID (UUID)"
echo "- APP_STORE_CONNECT_PRIVATE_KEY: .p8 ファイルの中身全文 (-----BEGIN PRIVATE KEY----- ...)"
echo ""
echo "設定画面: https://github.com/<owner>/tailcatsend/settings/secrets/actions"
echo "========================================================"
