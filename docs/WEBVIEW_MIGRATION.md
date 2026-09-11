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
- `web-ui/src/update/` に native と同じ manifest／署名／ファイルハッシュ検査を追加した。更新設定がある Web では検証済みファイルを専用 Cache Storage に保存し、`web-ui/web-public/ponlet-sw.js` が次回ナビゲーションで保留版を切り替える。Pages workflow は `scripts/write_web_update_config.mjs` で公開鍵を設定し、`scripts/write_web_update_manifest.mjs` でdistのファイル一覧とP-256署名を生成する。Go WASMの非圧縮版はPagesの25 MiB単一ファイル制限を超えるためworkflowから除外し、圧縮版を標準経路にする。秘密鍵がない場合は更新設定と署名を無効にする。実Pagesのsecret設定・配信・切替は未検証である。
- 旧 Slint workspace crate、font/icon、winit patch、NativeActivity/UIKit shell、旧生成 Pages entry を削除した。
- `d1c3473` で保存先の確認を上限付き存在確認へ変更し、宣言サイズを受信した時点で保存を確定するようにした。遅延する half-close を待たないため、Files provider と大きなファイルでの停止を避ける。
- `adb7b65` で共通 Rust service から native／Web の stream close を呼ぶ取消 callback を追加した。callback は状態 mutex の外で一度だけ実行し、I/O 待ちを解除する。
- native read/write は `block_in_place` 内でC ABIへ入力バッファを直接渡し、チャンクごとの `spawn_blocking` と一時 `Vec` をなくした。buffer pointerは各呼出しの終了前にGo側が使い終える前提を保つ。

## 経路別試験の起動設定

ネイティブ bridge は起動時だけ `PONLET_TRANSPORT` を読み、試験用にTailcatの経路選択を固定できる。未設定または `auto` は通常の自動選択、`direct-udp` は WebRTC を抑止して WireGuard UDP を優先、`webrtc` は直接UDPを抑止して WebRTC DataChannel を優先、`derp` は DERP relay を強制する。Tailcatが指定方式を利用できない相手では下位の経路へフォールバックする。設定は `tc_init` の前に適用され、接続中には変更しない。

```sh
PONLET_TRANSPORT=direct-udp ./target/release/tailsend
PONLET_TRANSPORT=webrtc ./target/release/tailsend
PONLET_TRANSPORT=derp ./target/release/tailsend
```

これは経路を指定した再現試験の入口であり、各端末・各通信方式の転送成功を自動的に保証するものではない。受入時は表示された経路、送受信 byte 数、SHA-256、保存物を同じ実行で記録する。

macOS bundleとSony XQ-DQ44の実行では、`PONLET_TRANSPORT=derp` で双方向テキストが `derp` のまま完了した。2026-09-11 の `PONLET_TRANSPORT=direct-udp` 再実行では、macOS UI と Android snapshot が転送中も `direct-udp`（UI表示は `WireGuard UDP`）となり、`direct-udp-roundtrip-日本語.bin` (131,071 bytes) を macOS→Android と Android→macOS の両方向で保存した。両端の保存物 SHA-256 は `e62687a569033a3798c1f1f3a1d6a70c2d7d7cff347b3e708cd30d3de42dac19` で一致した。

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
- `ec2d3ee` から上記 E2E は終端の経路が `unknown` でないことを必須にし、DERP強制時は両端が `derp` であることも検査する。現行SHAの再実行では通常経路が両端 `webrtc`、DERP強制が両端 `derp` で通過した。
- `a12b873` の送信取消結果修正後にブラウザ2タブの実通信を現行HEADで再実行した。通常の自動選択は両端 `webrtc`、DERP固定実行は両端 `derp` となり、双方向テキスト、131,089／98,321 byte のファイル、SHA-256一致を再確認した。TauriとWASMの取消終端も同じユーザー取消表示へ揃えた。
- `b08d585` の更新署名鍵検査後にも同じブラウザ2タブE2Eを再実行し、通常経路は両端 `webrtc`、DERP固定は両端 `derp` のまま双方向転送とSHA-256一致を確認した。
- `c67683c` のPages配布用WASMサイズ対応と公開パスURL解決後にも同じブラウザ2タブE2Eを再実行し、通常経路は両端 `webrtc`、DERP固定は両端 `derp` のまま双方向転送とSHA-256一致を確認した。
- `274e66f` でTauriの直接bundle buildが生成済みGo archiveを参照するように修正し、macOS arm64 bundleの起動と招待待機への遷移を現行HEADで確認した。配布署名と実機転送は別の確認が必要である。
- `cd web-ui && PONLET_ANDROID_SERIAL=<serial> npm run test:e2e:android` では Sony XQ-DQ44 の Android Tauri WebView とWorker化した Chromiumを WebRTCで接続し、双方向テキストと131,071 byteファイルのSHA-256一致を確認する。`PONLET_TEST_TRANSPORT=derp` を付けた `npm run test:e2e:android:derp` では同じ入力を DERP relayで再実行する。
- `8c1ddc6` で Android debug APKを再生成し、Sony XQ-DQ44 (`QV770139JG`, Android 15) へ再インストールした。`test:e2e:android` は両端 `connected / webrtc`、`test:e2e:android:derp` は両端 `connected / derp` で通過し、いずれも双方向テキスト、`browser-to-android-日本語.bin` (131,071 bytes)、SHA-256 `e62687a569033a3798c1f1f3a1d6a70c2d7d7cff347b3e708cd30d3de42dac19` が一致した。
- `PONLET_TRANSPORT=direct-udp` で起動した macOS bundle と Sony XQ-DQ44 (`QV770139JG`) の両端が `direct-udp` のままファイル転送を完了した。`direct-udp-roundtrip-日本語.bin` (131,071 bytes) の macOS→Android／Android→macOS 双方向保存と SHA-256 `e62687a569033a3798c1f1f3a1d6a70c2d7d7cff347b3e708cd30d3de42dac19` の一致を確認した。
- `cd web-ui && PONLET_ANDROID_SERIAL=QV770139JG PONLET_ANDROID_CDP_PORT=9224 npm run test:e2e:android:cancel` で Chromium→Sony XQ-DQ44 の WebRTC 転送を途中取消した。64 MiB の取消対象は確定ファイルと `.part` を残さず、同じ接続で `cancel-retransfer-1789101354360-日本語.bin` (131,071 bytes) を再送して SHA-256 `104bfa7bbd07eb278be833f71ad3ce0a256e5893481497b64cc5abf324c830b6` の一致を確認した。
- `adb7b65` 後にも Android APK を再ビルドして上記2コマンドを実行し、WebRTC／DERP ともに両端の経路表示、双方向テキスト、131,071 byteファイル、SHA-256 `e62687a569033a3798c1f1f3a1d6a70c2d7d7cff347b3e708cd30d3de42dac19` の一致を確認した。
- `a4d2143` と `ffb753c` の後に Android debug APK を再生成・再インストールし、WebRTC／DERP の同じ E2E を再実行した。両経路で `connected`、双方向テキスト、131,071 byteファイル、SHA-256 `e62687a569033a3798c1f1f3a1d6a70c2d7d7cff347b3e708cd30d3de42dac19` の一致を確認した。`./scripts/build_tauri_mobile.sh ios-sim debug` で iOS 18.5 iPhone 16 simulator bundle も再生成し、起動待機画面を確認した。
- `a12b873` で Android arm64 release APKを再生成し、debug keystoreで一時署名して `emulator-5554` へインストールした。「Ready to connect」から「Waiting for peer」への招待待機遷移を確認した。これはAndroid EmulatorのUI確認であり、Sony実機の通信やストア署名の確認ではない。
- 同じ commit の macOS Tauri bundle と Android を DERP relay で接続し、64 MiB の送信側取消と受信側取消を実行した。どちらも接続待機へ戻り、保存先に確定ファイルや `.part` が残らなかった。通常の Android→macOS 転送では 4,096 byte と 98,321 byte のファイルを SHA-256 一致で保存し、日本語名の衝突時に `(1)` を付けることも確認した。
- 受信した `open-test.txt` をmacOS TextEditで開き、保存先コピー、受信テキストのコピーと `/tmp/ponlet-message.txt` への保存を確認した。共有シートは起動と取消までで、共有先を選んだ完了判定は未実施である。

## 残っている検証

1. Tauri 2端末での共有先選択、取消後の再転送（Chromium↔Android の取消後再転送は確認済み。開く、保存先コピー、テキストのコピー／保存、取消自体は macOS↔Android の両方向で確認済み）。
2. iOS 実機のロック解除後起動、picker、保存、share/open。
3. Windows、macOS、Linux、iOS、Android、Web の組み合わせを、Direct UDP、WebRTC、DERP に分けた同一入力で実行する。macOS↔Android の direct-udp と Android↔Web の WebRTC／DERP は確認済みだが、全組み合わせは未完了である。
4. 各データ stream の Go bridge path report が接続後に安定すること、経路別の速度・CPU・総メモリを測る。`unknown` の表示だけでは経路試験を通過としない。
5. Pages 実デプロイ、署名付き UI/WASM の取得・検証・切替、起動失敗時の復元。
6. 100回の接続・転送・取消・切断後に stream、Go client、JS callback、購読、timer が残らないこと。

iOS 実機は Bundle ID `jp.yasagure.ponlet` の署名・Provisioning Profile が開発チームに存在せず、2026-09-11 の debug build が Xcode signing で停止した。iOS Simulator の build 成功とは分けて扱う。

Linux cross check は aarch64 用 sysroot と `pkg-config` の `libdbus` 設定不足で停止し、Windows target と Windows／Linux／iOS の実機はこの環境にない。Pages の実デプロイ、署名鍵・公開設定を使った更新切替、起動失敗からの復元、性能と総メモリの測定は未実施である。

最新の Android 再検証では Sony XQ-DQ44 (`QV770139JG`) を再接続し、`8c1ddc6` の debug APKを再生成・再インストールした。WebRTC／DERPの両方で実通信E2Eを完了し、direct-udp では macOS↔Android の双方向ファイルを同一 SHA-256 で保存した。Chromium↔Android では取消後の再転送も確認した。Windows／Linux／iOS 実機を含む全組み合わせと、Tauri 2端末間での取消後再転送は未確認である。

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
