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

### 2. 実機（iPhone）向けビルド

```bash
./scripts/build_ios.sh device
```
> `target/aarch64-apple-ios/release/libtailsend_ios.a` がビルドされます。

### 3. Xcode プロジェクトの生成 & 開く

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
