# TailSend 🚀

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Native UI](https://img.shields.io/badge/Native_UI-Tauri%20WebView-purple.svg)](https://tauri.app/)
[![Web Client](https://img.shields.io/badge/Web_Client-Cloudflare_Pages-orange.svg)](https://ponlet.mat2uken.app)

TailSend（製品名 Ponlet）は、Rust の共通転送エンジン、VanJS WebView UI、Go Tailcat を組み合わせた P2P ファイル・テキスト転送アプリです。Tailcat が WireGuard UDP、WebRTC DataChannel、DERP relay の接続を選び、Rust がプロトコル、進捗、取消、保存完了を一つの流れで処理します。

## 対応範囲

- Windows、macOS、Linux: Tauri WebView
- iOS、Android: Tauri mobile WebView
- Web: Rust WASM service と Go Tailcat WASM
- 招待 URL（`#i=...`）、QR、テキスト、複数ファイル、取消、進捗、受信結果表示

WebView の画面は [`web-ui/`](web-ui/) に集約しています。VanJS Core、標準 HTML/CSS、TypeScript、Vite 8、Rolldown、Vitest、Oxc/Oxlint/Oxfmt を使い、UI のランタイム依存を増やしません。

## 構成

```text
tailcatsend/
├── apps/
│   ├── desktop/              # 既存の製品コマンド名を保つ薄い Tauri 起動入口
│   ├── tauri/                # Tauri desktop/mobile shell と native adapter
│   └── web/                  # Rust WASM service
├── crates/
│   ├── tailsend-core/        # セッション状態、操作受付、イベント履歴
│   ├── tailsend-protocol/    # 招待、認証、現行データ形式、名前検証
│   ├── tailsend-transfer/    # 部分 read/write、進捗、取消、完了判定
│   ├── tailsend-platform-api/# ファイル source/sink と保存確定の型
│   ├── tailsend-transport-api# stream/listener と経路表示
│   ├── tailsend-qr/          # 軽量な RGBA QR 生成
│   ├── tailsend-updates/     # 署名付き更新の検証関数
│   └── tailsend-native-bridge# Go C ABI の宣言
├── tailcat/                  # Go Tailcat submodule と native/WASM bridge
├── web-ui/                   # 共通 VanJS UI と Vite/Oxlint/Vitest 構成
├── docs/                     # platform、移行、検証記録
└── scripts/                  # build、mobile、Pages、検証用スクリプト
```

## 開発

必要なものは Rust stable、Go 1.27 系、Node.js です。Tailcat submodule を含めて取得します。

```bash
git clone --recurse-submodules https://github.com/mat2uken/tailcatsend.git
cd tailcatsend

# UI の型検査、unit test、web/tauri の bundle
./scripts/build_web_ui.sh

# Go archive と Tauri desktop
./scripts/build_tauri.sh
./target/debug/tailsend

# Rust workspace の unit test
cargo test --workspace
```

Web 配布物は `scripts/build_web_ui.sh` で生成した `web-ui/dist/web` に、Go Tailcat WASM と Rust service WASM を加えて作ります。Cloudflare Pages workflow はリリースごとに WASM を生成し、サイズと配布構成を検査してから Pages へ送ります。

## モバイル

```bash
./scripts/build_tauri_mobile.sh android debug
./scripts/build_tauri_mobile.sh ios-sim debug
./scripts/build_tauri_mobile.sh ios release
```

Android の AAB は `PONLET_ANDROID_ARTIFACT=aab ./scripts/build_tauri_mobile.sh android release` で生成します。iOS の XcodeGen 入力は `apps/tauri/gen/apple`、Android の Gradle 入力は `apps/tauri/gen/android` です。詳しくは [`docs/ANDROID_GUIDE.md`](docs/ANDROID_GUIDE.md) と [`docs/IOS_GUIDE.md`](docs/IOS_GUIDE.md) を参照してください。

## 検証状態

共通 Rust unit test、Web UI unit test、Tauri desktop check、Rust WASM check、Android/iOS bundle 生成、Chrome 2 タブの WebRTC DataChannel テキスト送受信を確認済みです。実機の双方向ファイル転送・保存、iOS のロック解除後起動、WireGuard UDP と DERP を指定した経路試験、全 OS 組み合わせ、Pages の実配布と自動更新は継続検証中です。確認結果は [`docs/WEBVIEW_MIGRATION.md`](docs/WEBVIEW_MIGRATION.md) に更新します。

## ライセンス

本プロジェクトは MIT License です。Tailcat、Tailscale、Go modules、Rust crates などの表示は [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) にまとめています。
