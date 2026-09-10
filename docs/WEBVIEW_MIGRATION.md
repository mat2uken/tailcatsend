# WebView 移行の実装状態

この記録は `feature/common-rust-transfer-engine` の現在状態を示す。UI、共通 Rust 転送、Go Tailcat bridge、Tauri shell を別々に確認し、ビルド成功だけで実通信成功とは判定しない。

## 現在の構成

| 部分 | 実装 |
| --- | --- |
| UI | `web-ui/` の VanJS + TypeScript + 標準 HTML/CSS。Vite mode `web` と `tauri` で同じソースを出力 |
| Rust service | `tailsend-core`、`tailsend-transfer`、platform/transport API。招待、進捗、取消、保存完了を共通化 |
| Browser | `apps/web` の Rust WASM と Window 側 Go Tailcat WASM。OPFS 保存、File 読み出し、WebRTC bridge を接続 |
| Native | `apps/tauri` の Tauri command/event、Go c-archive/c-shared、native file handle。`apps/desktop` は Tauri 起動のみ |
| Mobile | `apps/tauri/gen/apple` と `apps/tauri/gen/android`。旧 `apps/ios`、`apps/android`、Slint UI は削除済み |
| 配布 | Pages workflow が UI、Go WASM、Rust service WASM を release build から配置。更新検証 crate は署名とファイル検査まで実装 |

## 直近の変更

- `NAME` ヘッダーの分割受信、ヘッダーと本文の同時受信、部分 read/write、0 byte、早期 EOF、取消、保存確定を共通 Rust へ移した。
- Tauri の送信 picker、受信保存、QR bitmap、受信一覧を Rust command/event と VanJS に接続した。ファイル本文は invoke JSON に載せない。
- Browser adapter は Go bridge の接続後に Rust WASM service を起動し、snapshot/event/API version を検証してから UI に渡す。
- `vanjslitetemplate` の Vite 8、Vitest、Oxlint、Oxfmt、`@nkzw/oxlint-config`、`vanjs-core` 構成を採用した。mode ごとの outDir と ES2018 target は維持する。
- 旧 Slint workspace crate、font/icon、winit patch、NativeActivity/UIKit shell、旧生成 Pages entry を削除した。

## 確認済み

- Rust workspace unit test、Tauri desktop check、`tailsend-web` の `wasm32-unknown-unknown` check。
- Web UI の lint、typecheck、unit test、web/tauri Vite build。
- Tauri Android debug/release、iOS Simulator/device bundle の生成。
- Android debug APK の実機起動と招待待受画面。
- Chrome 2 タブの招待、WebRTC DataChannel 接続、テキスト送受信。

## 残っている検証

1. Tauri 2端末のテキスト・ファイル双方向転送、保存物の SHA-256、取消と再転送。
2. iOS 実機のロック解除後起動、picker、保存、share/open。
3. Windows、macOS、Linux、iOS、Android、Web の組み合わせを、Direct UDP、WebRTC、DERP に分けた同一入力で実行する。
4. Go bridge の path report が接続後に安定すること、経路別の速度・CPU・総メモリを測る。`unknown` の表示だけでは経路試験を通過としない。
5. Pages 実デプロイ、署名付き UI/WASM の取得・検証・切替、起動失敗時の復元。
6. 100回の接続・転送・取消・切断後に stream、Go client、JS callback、購読、timer が残らないこと。

## 再現コマンド

```sh
cargo test --workspace
cargo check -p tailsend-web --target wasm32-unknown-unknown
cargo check -p tailsend-tauri -p tailsend-desktop
(cd web-ui && npm ci && npm run lint && npm run typecheck && npm test && npm run build -- --mode web && npm run build -- --mode tauri)
```

実機の判定には、commit、端末、OS、経路、入力ファイル、送受信 byte 数、受信ハッシュ、保存先、所要時間を記録する。過去のビルドやブラウザ smoke の結果を、現在の実機転送の証拠として再利用しない。
