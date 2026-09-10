# WebView / Tauri / WASM 移行の実装状態

共通Rust転送基盤とvanjslitetemplate準拠のWeb UIツールチェーンはコミット済みである。Tauriデスクトップ向けの実通信adapterと、ブラウザ向けのGo Tailcat WASM＋Rust WASM service adapterまで接続した。`apps/desktop` の製品入口はTauri WebViewへ切り替え、TauriのiOS/Android shellも生成して、共通Rust・Go bridge・VanJS bundleを各モバイル形式へリンクできる状態にした。モバイルのファイル選択・保存はTauriのDialog/FSをRust側から使い、本文をWebViewへ渡さない経路へ接続した。`apps/ios` と `apps/android` の旧Slint製品入口は引き続き残している。製品全体のUI置換、Dedicated Workerへの分離、起動時の更新取得は完了していない。

元の要件は、機能・動作・操作感を保った共通Web UIと、TauriまたはWASMによるbackendである。画面をビルドできることと、同じ使い味で送受信できることは分けて確認する。

## 現在の構成

| 部分 | 実装と役割 | 未実装部分 |
| --- | --- | --- |
| Web UI | `web-ui/src/main.ts` のVanJS画面。Vite 8/esbuild/Oxlint/Oxfmt/Vitestを使用 | QR表示・読取、設定、受信ファイル操作などの機能一致 |
| Application API | `web-ui/src/api/` の型と版確認 | Rustデータとの変換、未移植操作の追加 |
| 表示状態 | `web-ui/src/session.ts` のイベント順序・購読・終了処理。接続時は`direct-udp`、`webrtc`、`derp`、`unknown`を表示 | 実adapterからの再接続通知と履歴復元 |
| backend選択 | `web-ui/src/backends/{browser,tauri}.ts` をVite modeで選択。BrowserはGo bridgeとRust WASMを起動、Tauriはcommand/eventを使用 | Dedicated Workerへの分離、再作成時の操作無効化 |
| Native shell | `apps/desktop` は `tailsend-tauri` を起動し、`apps/tauri` のVanJS WebView・共通Rust service・Go C archiveを使う | デスクトップの2端末実転送、実機での再起動・終了・送受信 |
| Mobile shell | `apps/tauri/gen/apple` と `apps/tauri/gen/android` をTauri initから生成。`scripts/build_tauri_mobile.sh`がiOS 17 arm64 archive、Android API 31/arm64 shared library、UI bundleをまとめてビルドする。Dialog/FSでfile picker・保存をRustのファイルハンドルへ接続 | Slint製品入口の置換、実機送受信、ストア署名設定 |
| Rust状態管理 | `tailsend-core::BackendService` のsnapshot・イベント・取消トークン | OS/Webの操作を含む製品全体への接続 |
| 共通転送 | `tailsend-transfer/src/live.rs` の現行NAME/改行形式、`lib.rs` の既存バイナリ形式、`io.rs` の部分I/O。`TransportPath`をstreamからsnapshotまで伝える | iOS/Androidを含む各OSのfile/stream adapter |
| Native bridge | GoのC ABI、`tailsend-native-bridge` のRust宣言、`tailsend-native-transport` のstream/listener adapter | 各OSの実転送確認、配布物への組込み |
| Browser保存 | Rust WASMがOPFSの途中保存・サイズ検査・確定・取消を実行。`web-ui/src/opfs.ts` はWorker向けの同等adapter | Workerへの移設、保存済みファイルの利用、起動時の途中ファイル回収 |
| 更新検証 | `tailsend-updates` の署名・互換性・ファイル検査 | 配信manifest生成、ダウンロード、展開、切替、起動失敗時の復元 |

`pentang` の `packages/api` と `packages/backends` にある、UIから独立したAPI、backendごとの初期化、購読と終了の整理を参照した。pentangのデモ用C++処理やTauri commandsをPonletの転送機能として接続した状態ではない。

## 今回のレビューで修正した点

- 通信未接続時にローカルで接続成功・送信完了を作る仮処理を除去した。backendがない場合は送受信不可と表示する。
- Application API、bridge接続、表示状態を分離した。classのprototypeにあるbridgeメソッドも元のインスタンスで呼ぶ。初期snapshotより先に届いたイベントを巻き戻さず、重複テキストや別転送の完了通知を誤反映しない。
- 送信可否・処理中状態によるUI制御とエラー表示を追加した。クリップボード失敗時にコピー成功を表示しない。同じファイルを再選択でき、送信待ち中に入力した次の文章も残す。履歴は旧Slintと同じ新着順に表示する。
- OPFSの書き込み・確定・取消を直列化した。作成、容量不足、close、move、サイズ不一致、確定中の取消で途中保存の削除を試みる。保存用の名前はUUIDから作り、長い表示名がファイル名の上限に影響しない。
- 共通転送では、ヘッダー解析前に用意した保存先も失敗時にabortする。空ファイルや最後の進捗通知直後の取消を確認し、部分writeの繰り返し中も取消を確認する。
- NAME形式は宣言サイズだけでなくsenderのhalf-closeまで確認する。余剰データが別パケットに分かれても保存を確定しない。現行Web/iOS/Android/daemonのsenderにある`closeWrite`経路を参照した。
- `receive_live_text_stream` は接続が閉じるまで全メッセージを貯める形式から、受信したメッセージを順にcallbackへ渡す形式に変更した。`TextMessageDecoder` も入力全体を何度もコピーせず、上限検査を確保前に行う。
- Rustのsnapshotと購読を一度に取得するAPI、履歴の欠落検出、終端通知前の進捗flushを追加した。時刻処理はWASMでも動く`web-time`に替えた。
- Goでは再初期化と終了を直列化し、旧generationの接続を新しい状態へ登録しない。完了済みdialの取消では未引渡しstreamを閉じ、listener取消では子streamも閉じる。最後の通常streamを閉じる際は、TCPのFIN/ACK送信を最大3秒待ってからclientを終了する。
- Unixのinterface flagsには各OSの`IFF_*`定数を使う。Linuxの値をiOS/macOSへ当てはめない。
- 更新manifestではURLとWindowsで別の意味になるパス、大小文字だけの重複、file/directoryの衝突を拒否する。署名検証とは別に、配布種別・対象OS・API版・新しいrevisionかを確認するAPIを追加した。
- 共通転送のテストを通常の`cargo test`でも実行する設定にした。Web UIのビルドスクリプトでもテストと両modeのビルドを実行する。
- `apps/tauri` を追加し、`ponlet_*` command、Tauri event、Go C ABI、共通handshake/NAME転送へ接続した。Tauriへのinvoke payloadはファイル本文ではなく、ファイル名・サイズ・パスだけを渡す。
- Tauriのnative buildでは、`scripts/build_tauri.sh` が対象OS用Go bridgeを生成してからRustとVanJS bundleをビルドする。ローカルのTauri実行はこのbridge生成を通した成果物で確認する。
- `apps/desktop` の旧Slint入口と専用daemon IPCを削除し、既存の製品名を保ったまま `tailsend-tauri::run` を呼ぶ薄い起動処理へ切り替えた。デスクトップのReleaseリンクは確認済みだが、2端末実転送は未確認である。
- TauriのiOS/Android shellを`cargo tauri ios/android init`で生成した。iOSはdeployment target 17.0、AndroidはminSdk 31・targetSdk 36・arm64-v8aに合わせ、XcodeGenのlink設定へターゲット別Go archiveを追加した。署名チームは`APPLE_DEVELOPMENT_TEAM`で実行時に渡し、設定ファイルへ固定しない。
- `scripts/build_tauri_mobile.sh`を追加した。`android debug/release`、`ios-sim debug`、`ios debug/release`を同じUIビルドから実行し、Androidの`-checklinkname=0`とiOSのsimulator/device archiveを明示する。iOSはXcodeGenを再実行してからTauri工程をビルドする。
- Tauriのファイル操作を追加した。`ponlet_pick_and_send_files`はDialogの複数選択結果をFSで開き、Androidの`content://`、iOSの`file://`を含む入力を共通Rust `FileSource`へ渡す。`ponlet_save_text`は保存先DialogとFSの逐次書込みを使う。ファイル本文をIPC JSONやJavaScriptへ載せない。モバイル受信先はapp dataの`received`へ分離し、DesktopはDownloads/Ponletへ保存する。Dialog/FSのschemaはTauri生成物へ反映した。
- `scripts/build_tauri_mobile.sh`はiOSの既存生成物を削除してから再ビルドするため、同じtargetを繰り返してもarchive移動が衝突しない。
- `apps/web` の旧Slintエントリを共通Rust転送serviceへ置き換えた。ブラウザ側はGo WASM bridgeを起動してからRust WASMを読み込み、`window.__ponletBackend`へsnapshot・購読・招待・送受信・取消・切断を公開する。
- 共通transport APIに経路コードを追加した。`0`はWireGuard UDP、`1`はWebRTC DataChannel、`2`はDERP relay、`255`は判定不能で、Go bridge・native adapter・browser adapter・UI snapshotで同じ値を使う。ブラウザのread要求長をGo bridgeへ渡し、Rust側の小さいバッファへ過剰に返さないようにした。
- Pages workflowは、Viteの`web-ui/dist/web`、Go Tailcat WASM、`wasm-bindgen`で生成したRust service WASMを一つの配布物へ配置する構成へ変更した。旧Slint WASMを配信対象にしない。

## 接続時に守る順序

Native shellまたはBrowser adapterは初期化を完了してから、UIへbackendを渡す。Tauri modeの`@backend`は`@tauri-apps/api`の`invoke`/`listen`を使って`apps/tauri`へ接続する。Browser modeはGo bridgeとRust WASMが揃わない場合だけ送受信不可を表示する。Dedicated Workerへの移設後も、この起動順序とAPIを維持する。

Rustの`BackendSnapshot`は`{ api_version, sequence, app }`、TypeScript側は`{ apiVersion, sequence, state, ... }`で、JSON形式は同じではない。`SessionState`、転送ID、イベント形式も異なる。adapterは変換を実装してテストし、Rustのserde結果をそのまま渡さない。`apiVersion = 1`だけで互換と判断しない。

`BackendService::subscribe_with_snapshot`で初期状態と購読を取得し、そのsequence以下のイベントを除外する。遅い購読者はキューが満杯になると切断されるため、adapterはReceiverの終了を検出し、履歴を再取得する。`events_since`が`EventHistoryGap`を返した場合はsnapshotから復元する。転送終了後の接続状態はadapterが`set_state`で更新し、UI側で接続済みと推測しない。

I/O中の取消では、Rustのフラグ設定に加えて該当stream/dialの停止も行う。フラグ単独では、transportの`read`やOS書き込みで待機中のfutureを起こせない。`IncomingFileSink::commit`はsinkを消費するので、失敗時の途中保存の回収を各sink実装で行う。

## 起動時の更新取得へ接続する順序

1. 内蔵公開鍵で、受け取ったmanifestのバイト列そのものを`verify_manifest`へ渡す。
2. `check_compatibility`で配布種別・対象・API版・現在のrevisionを確認する。
3. 同じreleaseのファイルを途中保存先へ取得し、`verify_files`で全ファイルのサイズ・SHA-256・不足・重複を確認する。
4. 検証済みファイルだけを同一releaseとして切り替える。途中取得や起動失敗に備えて、内蔵版と直前の動作確認済み版へ戻せるようにする。

この1〜3の検査関数はあるが、取得・展開・切替の実装と製品からの呼び出しはまだない。現在のmanifestはUTF-8 JSONへのP-256 ECDSA/SHA-256署名（64-byte `r || s`）を想定する。Pages上のページに直接Tauri権限を渡す実装もない。

## 再現用コマンド

```sh
cargo test -p tailsend-transfer -p tailsend-core -p tailsend-updates -p tailsend-native-bridge
cargo check -p tailsend-core -p tailsend-transfer -p tailsend-updates --target wasm32-unknown-unknown
(cd tailcat && go test -race ./bridge/native)
./scripts/build_web_ui.sh
```

ブラウザ用は`web-ui/dist/web`、Tauri用は`web-ui/dist/native`に出力する。Cloudflare Pages workflowは新しいVanJS index、Go Tailcat bridge、Rust service WASMを生成して配置する。ローカルChromeの2タブではWebRTC DataChannel接続とテキスト送受信まで確認した。Android実機ではdebug APKのインストール、起動、招待作成と待受画面を確認した。iOSでは署名済みIPAをiPhone 12 Proへインストールしたが、端末ロック中のため起動できていない。Cloudflare Pagesへの実デプロイ、Tauriの2端末実転送、Dedicated Worker、WireGuard UDPとDERPを強制した経路、全platform組合せは未確認である。iOS/AndroidのSlint削除、モバイルのfile picker・保存先・共有を実機で確認する作業は残っており、旧アプリを削除する段階にはまだ進めない。

今回の検証結果と移行前に必要な比較は[レビュー記録](WEBVIEW_REVIEW.md)を参照。
