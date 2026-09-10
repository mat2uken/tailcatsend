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
- ブラウザ側にも署名対象の manifest bytes、P-256 ECDSA `r || s`、ファイルサイズ／SHA-256、配布先・API・revision の検査を追加し、native の `tailsend-updates` と同じ拒否条件を unit test で確認する。設定が注入された Web では 1.5 秒以内の取得・検証と Cache Storage への保留保存を行い、次回ナビゲーションで Service Worker が有効化する。Tauri では更新処理を無効にする。
- BrowserではGo Tailcat WASMをWindowに置き、Rust service WASMとOPFSをDedicated Workerへ置く。Workerとのstream I/OはMessagePortで中継し、本文バッファはTransferableなArrayBufferを使う。Workerを使えないWebViewには同一Window adapterの切替を残す。
- ブラウザのFileSourceは再利用バッファへ直接読み出す`read_into`を使い、64 KiBごとの一時`Bytes`割当を追加しない。
- Tailcat の状態取得では peer 情報を要求し、受信側のデータ stream でも WebRTC／WireGuard UDP／DERP の表示を接続後に更新する。修正は `tailcat/patches/0003-tailcat-status-peer-report.patch` としてビルド時に適用する。
- `d1c3473` で受信保存の衝突候補をディレクトリ全走査から上限付き存在確認へ変更し、宣言サイズを受け取った後に遅延する half-close を待たず保存を確定する。iCloud／Files provider での待機と、100%表示後に止まる受信を避ける。
- `adb7b65` で取消時に native／Web の stream を実際に閉じる callback を共通 service へ登録した。callback は状態 mutex の外で一度だけ呼び出し、Go の read/write 待ちも close で解除する。
- 最新の native adapter では、multi-thread Tokio の read/write を `block_in_place` で実行し、Go C ABIへRustのチャンクバッファを呼出し中だけ借用する。チャンクごとの `spawn_blocking` と一時 `Vec` を使わず、current-thread runtimeでは同期呼出しへ切り替える。
- ネイティブ bridge は起動時の `PONLET_TRANSPORT=auto|direct-udp|webrtc|derp` を試験用に受け付け、Tailcatの経路優先／DERP強制を `tc_init` 前に一度だけ適用する。通常起動では未設定のまま自動選択を使う。

## ローカルで通過させる確認

```bash
cargo test --workspace
cargo check -p tailsend-web --target wasm32-unknown-unknown
cargo check -p tailsend-tauri -p tailsend-desktop
(cd web-ui && npm ci && npm run lint && npm run typecheck && npm test && npm run build -- --mode web && npm run build -- --mode tauri)
```

現在の unit test は Rust workspace 55件（core 14、transfer 17を含む）と Web UI 28件を対象にし、ヘッダー分割、本文同時受信、部分 I/O、取消、保存失敗、イベント順序、QR、受信一覧、Tauri picker forwarding、署名付き更新 manifest、更新版の検証保存を含める。

Chrome 2 タブの実通信では、日本語テキスト、131,089 byte ファイル、OPFSからの開く操作、SHA-256一致、両端の `webrtc` 表示を確認した。再現コマンドは `cd web-ui && npm run test:e2e:real`。

2026-09-11 の `e1113a6` では、実機 Sony XQ-DQ44 (Android 15) と Chromium の間を `DERP relay` で接続し、Android の Documents picker から `android-real.bin` (131,071 bytes) を選択して Web 側の受信一覧へ表示できることを確認した。Android の `content://` URI に含まれる provider ID ではなく、Tauri の Android `ContentResolver` から表示名を取得する。

同じSHAで `./scripts/build_tauri.sh` をmacOS arm64上で実行し、Go C archive (`target/native/tailcat/libtailcat.a`) をリンクしたRelease Tauri binary (`target/release/tailsend`)を生成した。起動後のmacOSアクセシビリティ名は `Ponlet — Direct P2P Transfer` で、製品入口がWebView UIになっていることを確認した。

2026-09-11 に Sony XQ-DQ44 (Android 15) と Chromium の実機を再接続し、WebRTC DataChannel で双方向テキストとブラウザ→Android のファイル送信を確認した。`browser-to-android-日本語.bin` は 131,071 bytes、Android の `received/` に確定し、端末上の `sha256sum` は `e62687a569033a3798c1f1f3a1d6a70c2d7d7cff347b3e708cd30d3de42dac19` だった。再現入口は `PONLET_ANDROID_SERIAL=<serial> npm run test:e2e:android` で、接続後の両端に `webrtc` が表示されることも検査する。

同じ端末で以前に Android picker から Chromium へ送った `android-real.bin` は DERP relay として確定しているため、Android／Web の実機では WebRTC と DERP の二つの経路を別実行で確認した。macOS上のTailcat低レベル probe では WireGuard UDP の直接経路 (`Endpoint=192.168.31.151:59013`) も観測したが、これは製品UIを介した2端末転送の証明には使わない。

正式な macOS Tauri bundle (`target/release/bundle/macos/Ponlet.app`) と Sony XQ-DQ44 (Android 15) を同じ実行で接続した。招待直後の状態取得は `transport=direct-udp`、データ送受信後は両端の表示が `derp` へ更新された。macOS Tauri から Android へ `tauri-to-android-日本語.bin` (131,071 bytes) を送信し、Android の `received/` に保存されたファイルの SHA-256 `db7a7ca4ee279909ee4b75b9286e3ad86491667a7a43697a23dec03bf79118a0` が送信元と一致した。テキストは `macOS Tauri→Android 実通信 ✅` と `Android→macOS Tauri 実通信 ↔ 日本語` の双方向を確認した。これは Tauri 2端末の実通信と、同一接続での直接経路からDERPへの経路表示更新を確認する証拠である。

`f27d9ad` の後、`PONLET_TRANSPORT=derp` で起動したmacOS bundleとSony XQ-DQ44を接続し、両端の表示が `derp` のまま双方向テキストを受信できることを確認した。`PONLET_TRANSPORT=direct-udp` では接続直後に両端が `direct-udp` となり、同じLANでのデータ転送後にTailcatが `derp` へ切り替えた。後者は直接UDPの初期選択とフォールバック動作の確認であり、データ転送全体を直接UDPで完了した証明にはしない。

Web 2タブの実通信E2Eには `npm run test:e2e:real:derp` を追加した。ローカル試験ページだけ WebRTC API を無効にして DERPへフォールバックさせ、両端の `derp` 表示、双方向テキスト、131,089／98,321 byte のファイル、SHA-256一致を確認する。受信開始時に未確定だった経路は、最初のデータ後に再取得して接続後の表示へ反映する。

Worker化後も `npm run test:e2e:real` と `npm run test:e2e:real:derp` が同じ入力とSHA-256で通過した。Sony XQ-DQ44 (Android 15) とWorker化した Chromiumの実機E2Eも `npm run test:e2e:android` (WebRTC) と `npm run test:e2e:android:derp` (DERP) で通過し、131,071 byteのファイル保存と端末上のSHA-256を確認した。

`ec2d3ee` では実通信E2Eが終端の経路表示を検査するようにし、現行のブラウザ2タブを再実行した。通常実行は両端 `webrtc`、DERP強制実行は両端 `derp` で、双方向テキスト、131,089／98,321 byte のファイル、既存のSHA-256一致を確認した。自動経路では端点ごとに `webrtc` と `derp` が分かれる場合も成功とし、`unknown` は失敗にする。

`adb7b65` 後に同じ Android APK を再インストールして、上記 Android／Chromium E2E を再実行した。WebRTC と DERP の両方で接続後の両端表示、双方向テキスト、`browser-to-android-日本語.bin` (131,071 bytes)、SHA-256 `e62687a569033a3798c1f1f3a1d6a70c2d7d7cff347b3e708cd30d3de42dac19` が一致した。Browser 2タブも同じ commit で WebRTC／DERP の各実行を再確認した。

`a4d2143` の native bridge 改修後に Android debug APK を再生成して Sony XQ-DQ44 へ再インストールし、同じ Android／Chromium E2E を再実行した。WebRTC と DERP の両方で両端の `connected` と経路表示、双方向テキスト、`browser-to-android-日本語.bin` (131,071 bytes)、SHA-256 `e62687a569033a3798c1f1f3a1d6a70c2d7d7cff347b3e708cd30d3de42dac19` が一致した。APK は `apps/tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk` に生成され、Rust 側のチャンク一時割当削減後も実機転送が維持されることを確認した。

`48f0c35` の Tauri状態保護と `f27d9ad` の経路試験入口を含む最新HEADで Android debug APKを再生成・再インストールし、`PONLET_ANDROID_SERIAL=QV770139JG npm run test:e2e:android` と `npm run test:e2e:android:derp` を再実行した。WebRTC／DERPともに両端の経路表示、双方向テキスト、`browser-to-android-日本語.bin` (131,071 bytes)、SHA-256 `e62687a569033a3798c1f1f3a1d6a70c2d7d7cff347b3e708cd30d3de42dac19` の一致を確認した。続けて `npm run test:e2e:real` と `npm run test:e2e:real:derp` も実行し、WebRTC／DERPの双方向テキスト、131,089／98,321 byteファイル、既存のSHA-256一致を再確認した。

`ffb753c` 後に `./scripts/build_tauri_mobile.sh ios-sim debug` を実行して iOS 18.5 の iPhone 16 simulator 用 `apps/tauri/gen/apple/build/arm64-sim/Ponlet.app` を再生成し、`xcrun simctl install`／`launch` で起動待機画面を確認した。これは iOS WebView shell の起動確認であり、iOS 実機の署名・通信確認ではない。

`eb8b543` では update config の埋め込み先を含む macOS Tauri Release bundle を再生成し、`target/release/bundle/macos/Ponlet.app` を起動して「接続待機中」の WebView 画面を確認した。native用の update config は空設定で、Tauriからネットワーク更新確認を始めない。

`3597588` では、招待待機中に「招待を作成」を連続実行した際、取消された古いaccept処理の終端エラーが新しい招待の状態を上書きしないようにした。更新済みmacOS WebViewで再生成直後と待機処理の終了後に「相手を待機中」が維持されることを確認した。

`3dbdc6f` では、接続中に別の招待または切断が始まった場合、古いjoin処理の成功・失敗が現在の接続状態を上書きしないようにした。古いセッションだけを閉じ、現在のセッションを維持する。

正式な macOS bundle を `adb7b65` で再ビルドし、Sony XQ-DQ44 と接続した。64 MiB のファイルを使い、Android→macOS の送信側取消、macOS→Android の受信側取消を DERP relay 上でそれぞれ実行した。取消後は両端が接続待機へ戻り、受信先に確定ファイルも `.part` も残らないことを確認した。通常転送では Android から macOS へ 4,096 byte の `small.bin`（SHA-256 `2dba0b4d9372f74682a66cb4eb7edfb620d6b4b151ea25b68f115ff82979a3f0`）と 98,321 byte の日本語名ファイル（SHA-256 `2e1b363da4361f817a79751077a6930d34e0d7e4766e98b82522ab74900e8937`）を保存し、既存名との衝突時は `(1)` を付けることを確認した。

同じ接続で `open-test.txt` (27 bytes) を受信し、WebViewの「開く」からmacOS TextEditで本文を表示した。「保存先をコピー」は `/Users/kenichim/Downloads/Ponlet/open-test.txt` をクリップボードへ渡し、受信テキストの「コピー」と「保存」（`/tmp/ponlet-message.txt`）も確認した。共有はmacOS共有シートの起動と取消を確認したが、共有先を選択した完了判定は残している。

## まだ実機で証明していない項目

- Tauri の2端末間で、保存後の開く、共有先選択、取消後の再転送。開く、保存先コピー、テキストのコピー／保存、取消そのものは macOS↔Android で確認済み。
- iOS 実機のロック解除後起動とファイル操作。iOS Simulator の bundle 生成と、署名済み IPA のインストールは別に記録する。
- WireGuard UDP、WebRTC DataChannel、DERP relay をそれぞれ指定した同一条件の転送。UI は制御接続ではなく各データ stream の bridge 報告を表示するが、強制切替の成功を意味しない。
- Windows、macOS、Linux、iOS、Android、Web の全組み合わせ、低容量保存先、巨大ファイル、100回の接続・取消・切断後の参照解放。
- Cloudflare Pages の実デプロイ、manifest署名と公開設定の配布、失敗版の隔離・復元、速度・CPU・総メモリの受入値。ブラウザ側の検証済み版保存と次回切替処理は実装済みだが、Pagesの署名鍵・配布設定を使った実行は未実施。

2026-09-11 の iOS 実機試行は、接続済み iPhone 12 Pro に対して `APPLE_DEVELOPMENT_TEAM=4VSXQAQDT ./scripts/build_tauri_mobile.sh ios debug` を実行したが、`jp.yasagure.ponlet` の Bundle ID を登録できず、Provisioning Profile が見つからないため Xcode signing で停止した。署名設定を変更して通過扱いにはしていない。

`cargo check -p tailsend-tauri` は aarch64-apple-ios、aarch64-apple-ios-sim、x86_64-apple-ios、wasm32-unknown-unknown で通過した。aarch64-unknown-linux-gnu は Rust のエラーではなく、実行環境に cross sysroot と `pkg-config` の `libdbus` 設定がないため停止している。Windows target と各 OS の実機はこの環境にない。

最新の Android 再検証は Sony XQ-DQ44 が `adb` から切断され、接続中の `emulator-5554` も 327 MiB の debug APK を internal storage に展開できず停止した。過去の物理端末結果をこの状態の証拠として再利用していない。

上記はビルド成功やブラウザ2タブの WebRTC smoke だけでは完了扱いにしない。端末、commit、通信経路、入力ファイル、受信ハッシュ、保存物、所要時間を同じ記録へ残してから判定する。
