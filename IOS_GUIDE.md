# 📱 TailSend iOS Native App Guide

TailSend iOS アプリは、Rust (Slint UI + Tokio) および Swift (UIKit / Metal) を統合したネイティブ iOS アプリケーションです。

---

## 🏗️ アーキテクチャ

- **UI レイヤー**: Slint (Metal / UIKit ネイティブレンダリング)
- **非同期ランタイム**: Tokio (マルチスレッドバックグラウンド通信)
- **転送エンジン**: 64 KiB チャンクストリーミング + Cloudflare Edge Relay & Tailcat Mesh
- **パッケージング**: Swift / XcodeGen (`apps/ios/TailSend.xcodeproj`) & `scripts/build_ios.sh`

---

## 🚀 ビルド & 実行方法

### 1. iOS Simulator でのビルド & 起動 (ワンライナー)

```bash
./scripts/build_ios.sh sim
```
> ※ iPhone 16 シミュレータへのビルド、署名、インストール、および自動起動までを一発で実行します。

### 2. 実機（iPhone Air 等）へのビルド・インストール・起動 (ワンライナー)

```bash
./scripts/build_ios.sh device-install
```
> ※ 接続中の iPhone（iPhone Air）向けに Rust ライブラリのビルド、コード署名、実機へのアプリインストールと自動起動までを一発で実行します。

### 3. 実機向けライブラリビルドのみ

```bash
./scripts/build_ios.sh device
```
> `target/aarch64-apple-ios/release/libtailsend_ios.a` がビルドされます。

### 4. Xcode プロジェクトの生成 & 開く

```bash
./scripts/build_ios.sh xcode
open apps/ios/TailSend.xcodeproj
```
> Xcode から実機へのインストールやデバッグが可能です。

---

## 🧪 E2E 転送テスト（Mac ↔ iOS Simulator）

iOS シミュレータ上で TailSend を起動後、Mac 側から以下を実行してテキストと 5MB ファイルの転送を検証できます：

```bash
node scripts/test_ios_e2e.js
```

---

## ✈️ TestFlight への自動デプロイ (GitHub Actions)

TailSend は GitHub Actions (`.github/workflows/testflight.yml`) を利用して、TestFlight への自動ビルド・アップロードに対応しています。

### 1. App Store Connect & Apple Developer での準備
1. **App Store Connect**:
   - `jp.yasagure.ponlet` の新規 App を登録。
   - 「ユーザーとアクセス」→「統合」→「App Store Connect API」で API キーを新規作成（役割: App Manager または Developer）。
2. **Apple Developer ポータル**:
   - `jp.yasagure.ponlet` 向けの **App Store 配布用プロファイル (Distribution Profile)** をダウンロード。

### 2. GitHub Secrets の登録
以下のシークレットを GitHub リポジトリ（Settings > Secrets and variables > Actions）に登録します：

| Secret 名 | 内容 | 取得方法 |
|---|---|---|
| `BUILD_CERTIFICATE_BASE64` | 配布用証明書 (`.p12`) の base64 | `./scripts/prepare_testflight_secrets.sh` を実行 |
| `P12_PASSWORD` | `.p12` のエクスポートパスワード | 上記スクリプトで入力した値 |
| `BUILD_PROVISION_PROFILE_BASE64` | 配布用プロファイル (`.mobileprovision`) の base64 | 上記スクリプトで入力した値 |
| `APP_STORE_CONNECT_KEY_ID` | API キーの Key ID | App Store Connect API キー作成画面 |
| `APP_STORE_CONNECT_ISSUER_ID` | Issuer ID (UUID) | App Store Connect API キー作成画面 |
| `APP_STORE_CONNECT_PRIVATE_KEY` | `.p8` 秘密鍵の中身全文 | ダウンロードした `AuthKey_XXXX.p8` のテキスト |

### 3. デプロイ実行
GitHub の「Actions」タブから **「iOS TestFlight Deployment」** を選択し、**「Run workflow」** をクリックするだけでビルド・アーカイブ・TestFlight アップロードが自動完了します。

