# SlintからWebViewへの移行と機能復旧

調査日: 2026-09-12 (JST)。調査開始時は `main` / `7df5349695118e6d4fedcde307a09eee620fd631`。
修正作業: `feature/slint-parity-recovery`。Web、macOS、Windows、Linux、iOS、Androidを対象とする。

## 比較元

- 共通Slint画面: `f3ee894^:ui/app-window.slint`。
- デスクトップ: `784ffde^:apps/desktop/src/main.rs`。
- Web: `988f1a8^:apps/web/src/lib.rs` と当時の `dist/index.html`。
- モバイル: `f3ee894^:apps/ios/src/lib.rs`、`apps/android/src/lib.rs`、各OSの設定。
- 比較先: 現在の共通VanJS UI、Rust Web Worker、Tauri、配布workflow。

画面に表示されていただけの操作と、OSのAPIや実データ処理まで存在した操作を区別した。
過去の実機記録を今回の修正コードの成功証拠には使用していない。

## 同等性が崩れた時点

| コミット | 時刻 (JST) | 変更と影響 |
| --- | --- | --- |
| `3d6400a` | 9/10 22:47 | 共通Web UIの初期実装を追加。言語・履歴・招待期限などのSlint機能は未移植だった。移行文書も機能一致を未完了と記載。 |
| `90e2c91` | 9/10 23:18 | native受信処理で存在確認後にrenameする保存処理を導入。同時受信が同じ名前を選ぶと上書きされ得た。`7547b39` (9/11 05:18) の連番改善後も残った。 |
| `988f1a8` | 9/10 23:40 | Web配信を新UIへ切替。未移植機能が公開Webから失われた。 |
| `784ffde` | 9/11 00:08 | macOS/Windows/Linuxの入口をTauriへ切替。旧Desktopの設定・履歴・clipboard操作等が製品経路から外れた。 |
| `373322f` | 9/11 01:37 | QR描画・カメラUIを追加。BarcodeDetector限定で、カメラ画面の取消Promiseも完了しない実装だった。 |
| `f3ee894` | 9/11 01:57 | iOS/Androidの旧入口、native scanner、Firebase起動処理と権限設定を削除しTauriへ統合。 |
| `154e42a` | 9/11 02:10 | native受信ファイルを開く操作を追加。mobileで有効なファイル表示・書き出し処理になっていなかった。 |
| `a12b873` | 9/11 09:30 | 取消を成功戻り値に変更。複数ファイル送信側のループが取消後も次のファイルへ進むようになった。 |
| `0904c5c` | 9/12 | Go/Rustの読み取りAPIをreadIntoへ変更。Workerの中継部分が旧APIのまま残った。 |
| `c0393b6` | 9/12 09:17 | 新着順の履歴に最下部へのスクロールを追加し、新着と反対側へ移動するようになった。 |

初期の不足を各製品入口への切替前に解消できていなかったことと、後続変更で非同期処理や呼出し側まで確認が届かなかったことをコードと履歴で確認した。
従来のUI mockによるテストやコンパイルだけでは、実際のGo/Rust/Worker間の不整合、nativeカメラ、ファイル表示まで検出できなかった。

## 復旧・修正内容

| 操作 | 対象 | 修正 |
| --- | --- | --- |
| 起動時のQR待受、非同期QR描画、Worker readInto | Web/共通UI | 先行修正 `83c4f78`、`7df5349`。今回も実通信回帰検証の対象とする。 |
| QR読取 | iOS/Android/Web | native scannerとカメラ権限を復元。ブラウザはBarcodeDetectorがなければjsQRを必要時に読み込む。 |
| カメラの取消・Escape・権限待ち・失敗 | 共通UI | 呼出しを必ず終了し、取得済み/遅延取得のstreamとnative overlayを終了。後から返る結果では接続しない。 |
| 表示言語、招待期限 | 全OS | 接続を作り直さずJP/ENを変更、選択を保存。招待の残り時間と期限切れを表示。 |
| 転送状況 | 全OS | 送受信方向・速度・完了/取消/失敗結果を表示。snapshot同期でも終了結果を復元。 |
| clipboardと履歴 | 全OS | 入力への貼付・貼付接続、履歴クリア、コピー/保存の履歴利用を復旧。native clipboard APIを使用。実送信成功も自分の履歴へ記録。 |
| 新着表示 | 全OS | 新着側へ合わせ、過去の履歴を読んでいる場合は位置を保つ。 |
| 受信フォルダ、Privacy/OSS | Desktop/共通UI | 受信フォルダ操作と公開情報ページの導線を復旧。 |
| ファイルを開く/保存/共有 | iOS/Android | FileProviderとread grant、Document Preview/Picker、OS共有画面を使用。iPadの表示位置指定も追加。 |
| Telemetry設定 | 全OS | 旧SDK処理と設定を再接続。旧native/Webと移行途中のWebView opt-outをSDK初期化前に尊重。設定ファイルがないnativeビルドは送信しない。 |
| iOS接続設定 | iOS | Local Network説明とBonjour設定を復元。 |
| 不正招待・再試行 | 全OS | 招待を検証してから現在の待受を終了。接続/待受エラーから再試行できるようにする。 |
| 同名ファイルの保持 | 全OS | Webは保存名の選択からmove完了までWeb Locksで排他。nativeは既存ファイルを置換しない排他的作成を使用し、並行受信でも内容と表示名を保持。 |
| ブラウザごとの保存API差 | Web | 旧版で不要だったmoveが必須になった差を修正。move非対応ならWorker内で64KiBずつコピーし、createWritable非対応なら同期書込APIを利用。ファイル全体をUIへ渡さない。 |
| 古い接続処理の遅延完了 | 全OS | 接続を世代で管理し、切断/作り直し後の状態・進捗・テキスト更新を拒否。切断は同時受信も取消。peer情報を保持して転送後に戻す。 |
| 複数ファイルの取消 | 全OS | 現在の転送を取り消した後に次のファイルへ進めない。取り消したテキストの入力は残す。 |
| 画面更新の遅延による履歴喪失 | 全OS | 最新snapshotに受信テキストを保持し、通知の抜けを復元。重複と、消去済み履歴の再表示を防ぐ。保持は128件/通常4MiB以内。 |
| 起動/画面状態 | 共通UI | backend二重作成を解消。hidden属性と転送中の表示を修正。 |
| JSON fallbackの通知停止 | Nativeの旧環境 | 読取通知の失敗からsnapshotと再購読で復帰。接続・送信の操作は再実行しない。停止時は購読と再試行timerを終了。 |

nativeの通知変換では現在のsnapshotに過去のsequenceを付けていた箇所も修正した。
現在のsequenceと復元情報を一緒に渡し、遅れた通知が新しい状態を上書きしない。binary frameのsequenceもpayloadと一致させ、以前の接続エラーを新しいsnapshotに付けない。

## 喪失として数えなかった項目

- 旧Desktop/Webのカメラは未対応案内だけだった。今回のportable decoderは対応範囲を増やす。
- 旧iOSの共有・テキスト保存・コピー・パスコピーは、一部が成功らしい文言を出すだけだった。
- 旧Androidの共有・テキスト保存・履歴クリア等には対応callbackがなかったものがある。
- テーマ変更、端末名編集、OSからの招待URL起動登録は旧版にも存在しなかった。
- 保存先変更は既存ファイルの削除と同じではない。既存保存物は削除しない。

## 再発防止と検証記録

- UIテストをmockの表示確認だけで終えず、実backendに合わせた送信応答、再試行、言語、期限、履歴、scanner終了を検証する。
- coreでは接続の作り直し、全streamの取消、遅延イベント、peer情報保持、snapshot履歴/終了結果の復元を検証する。
- Pages配信前に、同じ実行で生成したGo WASM・Rust WASM・UIを組み合わせて実通信する。標準経路とDERPで双方向テキスト/ファイルの保存内容を照合する。
- Chromiumに加えてFirefox/WebKitでも実backendを動かし、ブラウザの保存API差を検出する。
- 実通信テストは不正招待、待受の連続更新、自分の送信履歴、バッチ取消、切断後の待受も確認する。
- `PONLET_TEST_DIST` / `PONLET_TEST_UI_DIST` により検証用の生成先を明示でき、古いignored distを誤って使わない。
- build、実機操作、通信経路、保存内容、公開/ストア状態は別々に記録する。

最終結果は下記へ追記する。作業中のビルド成功を、全プラットフォームの実機成功として扱わない。

保存APIの実装には [WHATWG File System](https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle) と [WebKitのOPFS説明](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/) を参照した。
