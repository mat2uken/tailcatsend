# WebView 移行の実装状態

この記録は `feature/common-rust-transfer-engine` の現在状態を示す。UI、共通 Rust 転送、Go Tailcat bridge、Tauri shell を別々に確認し、ビルド成功だけで実通信成功とは判定しない。

## 現在の構成

| 部分 | 実装 |
| --- | --- |
| UI | `web-ui/` の VanJS + TypeScript + 標準 HTML/CSS。Vite mode `web` と `tauri` で同じソースを出力 |
| Rust service | `tailsend-core`、`tailsend-transfer`、platform/transport API。招待、進捗、取消、保存完了を共通化 |
| Browser | `apps/web` の Rust WASM と OPFS を Dedicated Workerへ配置し、Window 側 Go Tailcat WASMを MessagePort で中継。File 読み出し、WebRTC bridge を接続 |
| Native | `apps/tauri` の Tauri command/event、Go c-archive/c-shared、native file handle。`apps/desktop` は Tauri 起動のみ |
| Mobile | `apps/tauri/gen/apple` と `apps/tauri/gen/android`。旧 `apps/ios`、`apps/android`、Slint UI は削除済み |
| 配布 | Pages workflow が UI、Go WASM、Rust service WASM を release build から配置。更新検証 crate は署名とファイル検査まで実装 |

## 直近の変更

- `NAME` ヘッダーの分割受信、ヘッダーと本文の同時受信、部分 read/write、0 byte、早期 EOF、取消、保存確定を共通 Rust へ移した。
- Tauri の送信 picker、受信保存、QR bitmap、受信一覧を Rust command/event と VanJS に接続した。ファイル本文は invoke JSON に載せない。
- Browser adapter は Go bridge の接続後に Rust WASM service を起動し、snapshot/event/API version を検証してから UI に渡す。
- Browser adapter は Go bridge を Window に残し、Rust WASM service と OPFS を Dedicated Workerで起動する。WorkerとのI/Oは MessagePortを使い、stream本文は TransferableなArrayBufferで受け渡す。Workerを作成できないWebViewだけは同一Window adapterへ切り替える。
- Webの送信FileSourceは共通Rustの再利用バッファへ直接読み出す`read_into`を実装し、本文チャンクの一時`Bytes`割当を避ける。
- Go bridge の server status は peer 情報を明示的に取得する。接続通知時の値だけでなく、Rust stream がデータ開始時に再取得するため、受信側も実際の経路へ追随する。
- `vanjslitetemplate` の Vite 8、Vitest、Oxlint、Oxfmt、`@nkzw/oxlint-config`、`vanjs-core` 構成を採用した。mode ごとの outDir と ES2018 target は維持する。
- 旧 Slint workspace crate、font/icon、winit patch、NativeActivity/UIKit shell、旧生成 Pages entry を削除した。
- `d1c3473` で保存先の確認を上限付き存在確認へ変更し、宣言サイズを受信した時点で保存を確定するようにした。遅延する half-close を待たないため、Files provider と大きなファイルでの停止を避ける。
- `adb7b65` で共通 Rust service から native／Web の stream close を呼ぶ取消 callback を追加した。callback は状態 mutex の外で一度だけ実行し、I/O 待ちを解除する。

## 確認済み

- Rust workspace unit test、Tauri desktop check、`tailsend-web` の `wasm32-unknown-unknown` check。
- Web UI の lint、typecheck、unit test、web/tauri Vite build。
- Tauri Android debug/release、iOS Simulator/device bundle の生成。
- macOS arm64 の Go C archive＋Tauri Release binary と、起動後の `Ponlet — Direct P2P Transfer` accessibility 名。
- Android debug APK の実機起動と招待待受画面。
- Chrome 2 タブの招待、WebRTC DataChannel 接続、テキスト送受信。
- Sony XQ-DQ44 の Android Tauri WebView と Chromium の接続、`DERP relay` の経路表示、Android picker から `android-real.bin` (131,071 bytes) を Web 側へ送信する実機確認。
- Sony XQ-DQ44 と Chromium を新しいホストへ接続し、`WebRTC DataChannel` で双方向テキスト、ブラウザから Android への `browser-to-android-日本語.bin` (131,071 bytes) を送信し、Android `received/` の SHA-256 (`e62687a569033a3798c1f1f3a1d6a70c2d7d7cff347b3e708cd30d3de42dac19`) を確認する `tests/e2e/test_android_browser_real.mjs`。
- 正式な macOS Tauri bundle (`target/release/bundle/macos/Ponlet.app`) と Sony XQ-DQ44 (Android 15) を接続し、招待直後の `direct-udp`、データ転送後の `derp`、双方向テキスト、macOS Tauri から Android への `tauri-to-android-日本語.bin` (131,071 bytes) 保存を確認した。Android の SHA-256 は `db7a7ca4ee279909ee4b75b9286e3ad86491667a7a43697a23dec03bf79118a0` で、送信元と一致した。
- `cd web-ui && npm run test:e2e:real` で、招待、接続、テキスト、131,089 byte ファイル、OPFSからの開く操作、SHA-256、両端の経路表示を一括確認する。
- `cd web-ui && npm run test:e2e:real:derp` ではローカル試験ページの WebRTC API を無効にして、同じ転送を DERP relay で再実行する。両端の経路表示が `derp` になることを含めて検査する。
- `cd web-ui && PONLET_ANDROID_SERIAL=<serial> npm run test:e2e:android` では Sony XQ-DQ44 の Android Tauri WebView とWorker化した Chromiumを WebRTCで接続し、双方向テキストと131,071 byteファイルのSHA-256一致を確認する。`PONLET_TEST_TRANSPORT=derp` を付けた `npm run test:e2e:android:derp` では同じ入力を DERP relayで再実行する。
- `adb7b65` 後にも Android APK を再ビルドして上記2コマンドを実行し、WebRTC／DERP ともに両端の経路表示、双方向テキスト、131,071 byteファイル、SHA-256 `e62687a569033a3798c1f1f3a1d6a70c2d7d7cff347b3e708cd30d3de42dac19` の一致を確認した。
- 同じ commit の macOS Tauri bundle と Android を DERP relay で接続し、64 MiB の送信側取消と受信側取消を実行した。どちらも接続待機へ戻り、保存先に確定ファイルや `.part` が残らなかった。通常の Android→macOS 転送では 4,096 byte と 98,321 byte のファイルを SHA-256 一致で保存し、日本語名の衝突時に `(1)` を付けることも確認した。

## 残っている検証

1. Tauri 2端末での保存後の開く／共有、取消後の再転送（取消自体は macOS↔Android の両方向で確認済み）。
2. iOS 実機のロック解除後起動、picker、保存、share/open。
3. Windows、macOS、Linux、iOS、Android、Web の組み合わせを、Direct UDP、WebRTC、DERP に分けた同一入力で実行する。
4. 各データ stream の Go bridge path report が接続後に安定すること、経路別の速度・CPU・総メモリを測る。`unknown` の表示だけでは経路試験を通過としない。
5. Pages 実デプロイ、署名付き UI/WASM の取得・検証・切替、起動失敗時の復元。
6. 100回の接続・転送・取消・切断後に stream、Go client、JS callback、購読、timer が残らないこと。

iOS 実機は Bundle ID `jp.yasagure.ponlet` の署名・Provisioning Profile が開発チームに存在せず、2026-09-11 の debug build が Xcode signing で停止した。iOS Simulator の build 成功とは分けて扱う。

Linux cross check は aarch64 用 sysroot と `pkg-config` の `libdbus` 設定不足で停止し、Windows target と Windows／Linux／iOS の実機はこの環境にない。Pages の実デプロイ、署名付き更新の起動切替、性能と総メモリの測定も未実施である。

## 再現コマンド

```sh
cargo test --workspace
cargo check -p tailsend-web --target wasm32-unknown-unknown
cargo check -p tailsend-tauri -p tailsend-desktop
(cd web-ui && npm ci && npm run lint && npm run typecheck && npm test && npm run build -- --mode web && npm run build -- --mode tauri)
# 接続中の Android 実機と adb が必要
cd web-ui && PONLET_ANDROID_SERIAL=<serial> npm run test:e2e:android
```

実機の判定には、commit、端末、OS、経路、入力ファイル、送受信 byte 数、受信ハッシュ、保存先、所要時間を記録する。過去のビルドやブラウザ smoke の結果を、現在の実機転送の証拠として再利用しない。
