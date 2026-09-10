# WebView 移行レビュー

対象は `feature/common-rust-transfer-engine`。VanJS UI、共通 Rust 転送、Go Tailcat bridge、Tauri desktop/mobile shell を統合し、旧 Slint 製品入口を削除した。

## 判断

UI と転送処理の責務は分かれ、ファイル本文を UI の JSON、Base64、Tauri invoke に載せない構成になっている。現行の通信形式は維持し、`tailsend-transfer` がヘッダー解析、部分 I/O、進捗、取消、保存確定を共通に実行する。Web は `wasm32` 用に `Send + Sync` を要求せず、native は専用 I/O 実行枠で安全に stream を扱う。

`web-ui` は `vanjslitetemplate` と同じ Vite 8、Vitest、Oxlint、Oxfmt、`@nkzw/oxlint-config` を基礎にし、Tauri と Web の bundle だけを mode で切り替える。旧 UI、旧 mobile shell、Slint 依存は workspace から除去した。

## ローカル確認

| 確認 | 状態 |
| --- | --- |
| `cargo test --workspace` | Slint 削除後の全 crate を実行 |
| `cargo check -p tailsend-web --target wasm32-unknown-unknown` | Browser service の compile |
| Tauri/Desktop check | Go bridge と WebView adapter の link |
| Web UI lint/typecheck/unit/build | web/tauri 両 mode |
| Browser smoke | 2 タブ WebRTC DataChannel の招待とテキスト |
| Android/iOS bundle | Tauri mobile の生成 |

## 未完了の受入項目

- Tauri 2端末の実ファイル送受信、保存、share/open、取消。
- iOS 実機起動と実機ファイル操作。
- WireGuard UDP、WebRTC、DERP を強制または再現条件で分けた全 OS 組み合わせ。
- Cloudflare Pages 実デプロイ、署名付き更新、失敗版隔離と復帰。
- 速度中央値、入力応答 p95、Go heap、WebView を含む総メモリ、bundle サイズの同一条件比較。

これらはビルドや静的検査だけでは完了扱いにしない。実機の commit と通信経路を固定し、送受信 hash と保存物を確認してから完了にする。
