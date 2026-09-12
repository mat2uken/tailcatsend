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
| `90e2c91` | 9/10 23:18 | nativeで全listenerが1つの通知列を取り合い、別listener宛のstreamを閉じる実装を導入。QR再生成後の最初の受信を壊し得た。保存も存在確認後のrenameとなり、同時受信が同名を選ぶと上書きされ得た。`7547b39` (9/11 05:18) の連番改善後も残った。 |
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
| OPFSを使えないブラウザでの受信 | Web | `988f1a8` で失われたBlob保存を復旧。OPFSの準備段階で利用できなければWorker内に保存し、完成したURLだけをUIへ渡す。詳細とメモリ上の制約は [WEB_RECEIVE_STORAGE.md](WEB_RECEIVE_STORAGE.md)。 |
| 古い接続処理の遅延完了 | 全OS | 接続を世代で管理し、切断/作り直し後の状態・進捗・テキスト更新を拒否。切断は同時受信も取消。peer情報を保持して転送後に戻す。 |
| 複数ファイルの取消 | 全OS | 現在の転送を取り消した後に次のファイルへ進めない。取り消したテキストの入力は残す。 |
| 画面更新の遅延による履歴喪失 | 全OS | 最新snapshotに受信テキストを保持し、通知の抜けを復元。重複と、消去済み履歴の再表示を防ぐ。保持は128件/通常4MiB以内。 |
| 起動/画面状態 | 共通UI | backend二重作成を解消。hidden属性と転送中の表示を修正。 |
| JSON fallbackの通知停止 | Nativeの旧環境 | 読取通知の失敗からsnapshotと再購読で復帰。接続・送信の操作は再実行しない。停止時は購読と再試行timerを終了。 |

nativeの通知変換では現在のsnapshotに過去のsequenceを付けていた箇所も修正した。
現在のsequenceと復元情報を一緒に渡し、遅れた通知が新しい状態を上書きしない。binary frameのsequenceもpayloadと一致させ、以前の接続エラーを新しいsnapshotに付けない。

## 追加検証で見つかった問題

- 旧Slint Webの `988f1a8^:dist/index.html:1023–1025` は本文と末尾改行をまとめて送信し、`closeWrite` の完了後にstreamを閉じていた。`3d6400a` で追加した共通Rustのテキスト送信は本文/改行を別々に書き、半切断を行わず、Web接続を切り替えた `988f1a8` からこの差が実送信に入った。共通処理を改行終端の一括送信、取消検査、半切断の順に戻し、送信順序・半切断失敗・最後の書込後の取消をunitで検査する。gVisorの通常の`Close`自体も送信キューへFINを追加するため、この差だけをAndroidの初回テキスト欠落の全原因とは断定しない。受信EOF待ちや新しい応答メッセージは追加しない。
- QR再生成後の初回メッセージが届かないnativeの競合を確認した。`90e2c91`で追加した`NativeListener::accept`は全待受で1つの`tc_wait_event`を取り合い、別ownerの通知を取得するとそのstreamを閉じていた。終了前に待機へ入った旧listenerが新listenerの最初の通知を取り出すと、新接続を閉じてしまう。修正前実機では送信側が`completed / 56 of 56 bytes`なのにAndroidの受信履歴が空になることを記録した（`baseline16-7.log`）。通知を一度だけ取り出してownerごとの待受へ配送し、listener終了時は自分の待機と保留通知だけを終了する。
- Webの連続再生成で応答が止まる現象を再現した。Goのlistener/streamのcloseが同期JavaScript callback内でネットワーク終了を待つ実装だった。終了をPromise内のgoroutineへ移し、二重終了も防ぐ。該当実装は移行前の `87bfff7` にも存在しており、移行で新たに入った不具合とは断定しない。
- native scannerに採用した公式plugin 2.4.4にも取消処理の不具合があった。Androidはcamera providerの準備後に取消済み画面が再開し、scanのPromiseが終了しない可能性があった。iOSもqueued startとmetadata通知に対して終了したscanを拒否する検査を追加した。修正版を `vendor/tauri-plugin-barcode-scanner` に置き、出所・ライセンス・変更理由を保持した。
- macOSではcamera用途説明をTauriのInfo.plist、単独実行ファイルの埋込plist、手動で作る.appのplistに揃えた。
- 復元したAndroid Firebase依存がKotlin 2.2のmetadataを含むため、旧Kotlin 1.9.25ではコンパイルできなかった。既存AGP/Gradleの対応範囲内でKotlin 2.2.21へ更新した。
- iOSのビルド手順に、既存のmanual配布署名に加え、team指定のみで行う実機開発署名を追加した。署名情報は一時project specだけに適用する。
- Kotlin 2.2ではWebViewのJava APIに付いた非null指定も検査されるため、Androidのbinary IPC callbackの引数型をAPIの宣言に揃えた。
- iOSのFirebase復旧に伴い、SwiftPMがiOS用のXCFrameworkを選ぶように修正し、選択したframeworkとbundleをアプリの最終リンク・梱包に渡す。Tauriの設定にも最低iOS 17を明示し、CLIの既定値14との不一致を解消する。修正した `swift-rs` の出所と変更内容は `vendor/swift-rs/PONLET_PATCH.md` に記載する。
- 複数のstreamを使う通信で、一方のstreamが返した未判定の経路情報によって、別streamで確認済みの経路表示が消える問題を修正した。同じ接続世代で最後に確認した経路を保持し、新しい接続ではリセットする。
- Android実機の既存テストは、nativeの接続完了直後に未有効化の送信ボタンを強制clickしていた。UIが操作可能になるまで待つ実操作へ変更し、QR再生成も実際のボタンと招待内容の変化で検査する。
- 復旧後のAndroid実機で、長い受信ファイル名を表示した際に379pxの画面に対してカード右端が450pxまで広がることを確認した。Gridの列の最小幅を0にして画面内へ収め、360px幅で長い名前・メッセージ・送信操作を検証する。Gridの導入自体は `0cc621c` (9/10 22:53) で、今回の再現条件をその時点の実機成功/失敗とは扱わない。
- 今回の同名保存保護で追加したhard linkが、macOS実機のDownloadsで93バイトの保存確定に152秒かかることを確認した。待機中のprocess sampleは`linkat`内で停止していた。Apple系では`renamex_np(RENAME_EXCL)`で既存ファイルを置換しない移動を行い、未対応の保存先だけ排他的コピーを使う。通常の上書きrenameへ戻さない。これは今回の修正中に見つけた遅延で、旧移行由来とはしていない。

## 喪失として数えなかった項目

- 旧Desktop/Webのカメラは未対応案内だけだった。今回のportable decoderは対応範囲を増やす。
- 旧iOSの共有・テキスト保存・コピー・パスコピーは、一部が成功らしい文言を出すだけだった。
- 旧Androidの共有・テキスト保存・履歴クリア等には対応callbackがなかったものがある。
- テーマ変更、端末名編集、OSからの招待URL起動登録は旧版にも存在しなかった。
- 保存先変更は既存ファイルの削除と同じではない。既存保存物は削除しない。

## 再発防止と検証記録

- UIテストをmockの表示確認だけで終えず、実backendに合わせた送信応答、再試行、言語、期限、履歴、scanner終了を検証する。
- coreでは接続の作り直し、全streamの取消、遅延イベント、peer情報保持、snapshot履歴/終了結果の復元を検証する。
- native通知は旧待受終了後の配送、複数待受、登録前通知、待機取消、終了時の全待機解除と保留stream解放を8件の決定的テストで検証する。Release workflowでもcore/transfer/native通知のunitを実行する。
- Pages配信前に、同じ実行で生成したGo WASM・Rust WASM・UIを組み合わせて実通信する。標準経路とDERPで双方向テキスト/ファイルの保存内容を照合する。
- Chromiumに加えてFirefox/WebKitでも実backendを動かし、ブラウザの保存API差を検出する。
- 実通信テストは不正招待、待受の連続更新、自分の送信履歴、バッチ取消、切断後の待受も確認する。
- `PONLET_TEST_DIST` / `PONLET_TEST_UI_DIST` により検証用の生成先を明示でき、古いignored distを誤って使わない。
- build、実機操作、通信経路、保存内容、公開/ストア状態は別々に記録する。

## 検証結果

最終アプリ実装 `09b31468b23b4d097f1536db868969e6302f6d06` を `main` にfast-forwardし、push後のremote HEAD一致を確認した。[全OSビルド](https://github.com/mat2uken/tailcatsend/actions/runs/34677234985) はWindows、Linux、macOS、iOS、Androidすべて成功。GitHub Release、TestFlight、Google Playへの公開は行っていない。

| 対象 | 今回確認した結果 | 未確認・補足 |
| --- | --- | --- |
| 共通UI | 最終Pages CIでunit 103件、UI E2E 6件成功。360px幅の長いファイル名と入力欄の表示を含む。 | 実backendの通信は次の行で確認。 |
| Web実通信 | 最終Pages CIでChromium標準/DERP・Firefox・WebKit通常/永続コンテキストの5条件が成功。双方向テキストとファイル保存内容を照合。 | ローカルの`final17-web-*.log`でも同じ5条件が成功。CIとローカルの生成物は別に識別する。 |
| 共通core/transfer/native通知 | 最終Linux CIでcore 20件、transfer 20件、native通知8件が成功。 | OS画面の成功を意味しない。 |
| Android実機 | 最終APK SHA-256 `d6eede2abca700411815a4ef50106f27058079d771b2cca29ee59c5023dd2cea`。各回の起動後にQR再生成2回を行い、WebRTC 10回・DERP 3回すべてで双方向テキスト、双方向131071バイトファイルとSHA-256一致を確認。64MiB送信取消後の再転送も成功。 | 転送取消は開始直後。Androidからのファイル送信は受信済みテストファイルのFileRequestをnative APIへ渡す方法。Document Pickerの操作自体は未検証。 |
| Androidカメラ・ファイル表示 | 先行APK `d7077d5…`で実カメラ映像、閉じる→再表示→閉じるを確認。受信ファイルのOpenが`ACTION_VIEW`とFileProvider URI/read grantを渡し、OSの選択画面を表示。 | 最終APKでこのOS画面操作は再実行していない。`.bin`の内容表示と光学的なQR読取は未検証。 |
| macOS実機 | 最終Release `.app`の起動、QR待受・再生成、本番Webとの双方向テキストを確認。同名の52/66バイトを即時保存して両方を保持。受信ファイルをTextEditで開いて日本語内容を確認。OSファイル選択から66バイトを本番Webへ返送し、ダウンロード内容もSHA-256一致。 | app executable SHA-256 `87b46f46be7a3957d30d6166bac37312f3384bc5d05bc1bc0a01542574c7b39d`。ad-hoc署名を検査。 |
| iOS | 最終コードでFirebaseを含むCI配布ビルドとローカル開発ビルド、IPA生成、codesign検査が成功。選択した19個のbundleを梱包。 | XSは当初ロック中。その後ロック解除不要になったが別作業の実機テスト使用中だったため、最終appのinstall/launchを行わなかった。12 Proはロック中。実機のカメラ・ファイル表示・通信は未検証。 |
| Windows/Linux | 上記CIで最終配布用ビルド成功。 | 実機UIとOS間通信は未検証。 |

Android最終検証は `/tmp/ponlet-parity-validation/final19-android-default-{1..10}.log`、`final19-android-derp-{1..3}.log`、`final19-android-cancel.log`。各実行でメッセージとファイル名を変え、過去の受信履歴を成功と誤認しない。画面とIMEの位置を測って実ADBタップし、ブラウザのファイル選択は有効なボタンから行う。双方向ファイルのSHA-256は全13回で`e62687a569033a3798c1f1f3a1d6a70c2d7d7cff347b3e708cd30d3de42dac19`。

修正前は`baseline16-7.log`で初回テキストの欠落が再現した。修正後の`final18`の2回目はCDP接続前に外部のADB force-stopが入り、実通信を評価できなかった。後続`final19`では各操作の時刻とlogcatを記録して全回を逐次実行し、13回の通信と取消試験が失敗なく完了した。

Apple保存修正時のnative unitは16件成功（Apple renameの3件、並行保存、既存ファイル・ディレクトリ・symlink保持を含む）。最終コードのローカルiOS IPA SHA-256は`84a883aa2492d0b2121406608cdded222c477551c0d2dafe8c15ef0a9bf583bf`。実機には未インストール。

macOS最終ファイル照合は`macos-production-roundtrip-09b3146.json`に記録。最初の52バイトは`6c891aac58cccef1a811ad49597b03d18271c53f95707662e60518a545ab9346`、同名の66バイトとWebへの返送結果はどちらも`5c32f2b72d7dc570fda1ee2bb6364951a87641a38a804384d029022e4392fa44`。

## 本番Webへの反映

2026-09-12 15:14 JST、[最終Pages CI](https://github.com/mat2uken/tailcatsend/actions/runs/34677336376) が成功し、[本番URL](https://ponlet.mat2uken.app/)へ配信した。固定配信先は`https://57b6d0fe.mktailcatsend.pages.dev`。本番と固定配信先のHTML、UI JS/CSS、Worker、Go WASM、wasm_exec.js、Rust WASMの7ファイルをSHA-256で照合して一致を確認した（`production-verification-09b3146.json`）。本番Rust WASMのSHA-256は`850ee7f1c6068c404d6c82298fa04d99cc2e5b8086ccbcac65ba5abe91e9cbc1`。

公開URLを開き直して起動時のQR待受、再生成前後の招待URLの相違、期限の更新、日本語への切替を確認。その本番Webと上記の最終macOSアプリで双方向通信と保存内容も確認した。署名付きWeb更新設定は今回の配信環境では無効のため、存在しない署名manifestを検証済みとはしていない。

保存APIの実装には [WHATWG File System](https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle) と [WebKitのOPFS説明](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/) を参照した。
