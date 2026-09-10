# TailSend 実装状態

**更新日**: 2026-09-11
**対象**: `feature/common-rust-transfer-engine`
**通信エンジン**: Tailcat submodule と Go bridge

## 実装済み

- `tailsend-core` が招待、参加、状態遷移、操作受付、イベント sequence、取消を管理する。
- `tailsend-transfer` が現行の `NAME:<filename>:<size>\n` とテキスト形式、部分 read/write、サイズ検査、進捗、保存確定、途中保存の中止を共通処理する。
- `tailsend-platform-api` が native file handle、ブラウザ File、OPFS sink を同じ source/sink API へ接続する。
- Tauri desktop/mobile と browser WASM が同じ Rust service を利用する。Go は Tailcat の接続、stream read/write、終了処理を担当する。
- VanJS + TypeScript + Vite 8 + Vitest + Oxc/Oxlint/Oxfmt の UI を `web-ui/` に集約した。Web と Tauri は同じ画面を mode 切替で出力する。
- 招待 URL、QR 表示／カメラ読取、テキスト送受信、ファイル選択、受信結果、取消、経路表示、設定表示を UI に接続した。
- Slint の workspace crate、旧 mobile shell、旧 UI 定義、winit patch を削除し、製品入口を Tauri WebView に統一した。
- Pages workflow は Go Tailcat WASM と Rust service WASM を別ファイルとして生成し、Web UI bundle と合わせて配布する。
- Tailcat の状態取得では peer 情報を要求し、受信側のデータ stream でも WebRTC／WireGuard UDP／DERP の表示を接続後に更新する。修正は `tailcat/patches/0003-tailcat-status-peer-report.patch` としてビルド時に適用する。

## ローカルで通過させる確認

```bash
cargo test --workspace
cargo check -p tailsend-web --target wasm32-unknown-unknown
cargo check -p tailsend-tauri -p tailsend-desktop
(cd web-ui && npm ci && npm run lint && npm run typecheck && npm test && npm run build -- --mode web && npm run build -- --mode tauri)
```

現在の unit test は Rust workspace と Web UI の回帰ケースを対象にし、ヘッダー分割、本文同時受信、部分 I/O、取消、保存失敗、イベント順序、QR、受信一覧、Tauri picker forwarding を含める。

Chrome 2 タブの実通信では、日本語テキスト、131,089 byte ファイル、OPFSからの開く操作、SHA-256一致、両端の `webrtc` 表示を確認した。再現コマンドは `cd web-ui && npm run test:e2e:real`。

2026-09-11 の `e1113a6` では、実機 Sony XQ-DQ44 (Android 15) と Chromium の間を `DERP relay` で接続し、Android の Documents picker から `android-real.bin` (131,071 bytes) を選択して Web 側の受信一覧へ表示できることを確認した。Android の `content://` URI に含まれる provider ID ではなく、Tauri の Android `ContentResolver` から表示名を取得する。

## まだ実機で証明していない項目

- Tauri の2端末間での双方向テキスト・ファイル転送、SHA-256、保存後の開く／共有。
- iOS 実機のロック解除後起動とファイル操作。iOS Simulator の bundle 生成と、署名済み IPA のインストールは別に記録する。
- WireGuard UDP、WebRTC DataChannel、DERP relay をそれぞれ指定した同一条件の転送。UI は制御接続ではなく各データ stream の bridge 報告を表示するが、強制切替の成功を意味しない。
- Windows、macOS、Linux、iOS、Android、Web の全組み合わせ、低容量保存先、巨大ファイル、100回の接続・取消・切断後の参照解放。
- Cloudflare Pages の実デプロイ、署名付き UI/WASM 更新、起動失敗からの復元、速度・CPU・総メモリの受入値。

上記はビルド成功やブラウザ2タブの WebRTC smoke だけでは完了扱いにしない。端末、commit、通信経路、入力ファイル、受信ハッシュ、保存物、所要時間を同じ記録へ残してから判定する。
