# WebView 移行レビュー

対象は `feature/common-rust-transfer-engine`。VanJS UI、共通 Rust 転送、Go Tailcat bridge、Tauri desktop/mobile shell を統合し、旧 Slint 製品入口を削除した。

## 判断

UI と転送処理の責務は分かれ、ファイル本文を UI の JSON、Base64、Tauri invoke に載せない構成になっている。現行の通信形式は維持し、`tailsend-transfer` がヘッダー解析、部分 I/O、進捗、取消、保存確定を共通に実行する。Web は `wasm32` 用に `Send + Sync` を要求せず、native は専用 I/O 実行枠で安全に stream を扱い、read/writeのチャンクバッファをC ABI呼出し中だけ借用する。

`web-ui` は `vanjslitetemplate` と同じ Vite 8、Vitest、Oxlint、Oxfmt、`@nkzw/oxlint-config` を基礎にし、Tauri と Web の bundle だけを mode で切り替える。旧 UI、旧 mobile shell、Slint 依存は workspace から除去した。

## ローカル確認

| 確認 | 状態 |
| --- | --- |
| `cargo test --workspace` | Slint 削除後の全 crate、55 Rust tests を実行 |
| `cargo check -p tailsend-web --target wasm32-unknown-unknown` | Browser service の compile |
| Tauri/Desktop check | Go bridge と WebView adapter の link |
| Web UI lint/typecheck/unit/build | web/tauri 両 mode、Vitest 30件、Oxlint/Oxfmt |
| Browser smoke | 2 タブ WebRTC／DERP の招待、テキスト、ファイル、SHA-256 |
| Android実機 smoke | Sony XQ-DQ44 と Chromium の WebRTC／DERP 双方向転送 |
| native bridge 改修後の Android 再検証 | `a4d2143` で再生成した APK、WebRTC／DERP 双方向転送、131,071 byte と SHA-256一致 |
| 最新HEADの Android 再検証 | `48f0c35` で再生成・再インストールした APK、WebRTC／DERP 双方向転送、131,071 byte と SHA-256一致 |
| 最新HEADの Browser 再検証 | WebRTC／DERP 双方向転送、131,089／98,321 byte と SHA-256一致 |
| `a12b873` Browser 再検証 | 通常経路は両端 `webrtc`、DERP固定は両端 `derp`。双方向転送とSHA-256一致 |
| Tauri実機 smoke | macOS bundle と Sony XQ-DQ44 の direct-udp 表示、DERP転送、取消 |
| `eb8b543` macOS bundle | update config の埋め込み先を含む Release bundle を再生成・起動し、WebViewの「接続待機中」を確認 |
| `1f4030f` iOS Simulator | iPhone 16 simulator で最新UIを起動し、招待作成後の「相手を待機中」遷移を画面確認 |
| `a12b873` macOS bundle | arm64 bundleを再生成し、WebView起動と招待作成後の「相手を待機中」遷移を確認 |
| `a12b873` iOS Simulator | iPhone 16 simulator bundleを再生成し、起動と招待作成後の「相手を待機中」遷移を確認 |
| `a12b873` Android Emulator | arm64 release APKを再生成・一時署名してインストールし、招待待機への遷移を確認 |
| Android/iOS bundle | Android APK と iOS 18.5 iPhone 16 simulator bundle を最新コードで再生成・起動 |
| 招待の連続再生成 | macOS WebViewで取消済みaccept処理が新しい待機状態を上書きしないことを確認 |

## 未完了の受入項目

- Tauri 2端末の共有先選択、取消後の再転送。開く、保存先コピー、テキストのコピー／保存、取消自体と通常転送は macOS↔Android で確認済み。
- iOS 実機起動と実機ファイル操作。
- WireGuard UDP、WebRTC、DERP を `PONLET_TRANSPORT` の起動固定または再現条件で分けた全 OS 組み合わせ。固定入口は実装済みだが、組み合わせの転送結果は未完了。
- Cloudflare Pages 実デプロイ、署名付き更新、失敗版隔離と復帰。
- 速度中央値、入力応答 p95、Go heap、WebView を含む総メモリ、bundle サイズの同一条件比較。
- iOS実機は Bundle ID `jp.yasagure.ponlet` の Provisioning Profile 不足、Linux cross check は aarch64 sysroot／`pkg-config` 不足、Windows実機は検証環境不在で未完了。

これらはビルドや静的検査だけでは完了扱いにしない。実機の commit と通信経路を固定し、送受信 hash と保存物を確認してから完了にする。
