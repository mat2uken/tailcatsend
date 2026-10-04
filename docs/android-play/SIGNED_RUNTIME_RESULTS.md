# 署名候補のCI・移送・16KB実行・後始末記録

2026-10-04 UTC。ユーザーが承認した [最小手順](MINIMAL_RUNTIME_PLAN.md) に従い、署名済み候補の再生成・静的検査、APKだけの短期Actions保存、Macへの取得・再検証、当該artifactの削除まで完了した。専用16KB AVDでの最小runtime試験と後始末も完了した。基本操作は確認できたが、初回画像転送の失敗、操作メニューの切れ、SDK通信観測の不足が残り、提出可とは判断しない。

この記録はsource734d9590当時の結果である。後続c7408ea0のmenu修正、署名候補追試と後始末は [個別menu修正・追試](MENU_FIX_RESULTS.md) を参照。

## 対象とCI結果

| 項目 | 記録 |
| --- | --- |
| repository / branch | `mat2uken/tailcatsend` / `feature/android-play-readiness` |
| 成功run | [37168887780](https://github.com/mat2uken/tailcatsend/actions/runs/37168887780) |
| source SHA | `734d9590ad960d347beaec2222345dcafb2842e9` |
| workflow入力 | `mode=runtime`、`confirm_deploy=false`、完全source SHA。request検査5分・署名検証job90分の上限を維持 |
| release metadata | `jp.yasagure.ponlet` / `1.0.18` / versionCode `2030000102` / minSDK 31 / targetSDK 36 |
| CI状態 | request検査、署名・Firebase buildと静的検証、APK artifact保存、always cleanupがsuccess。Play配布jobはskipped |
| ローカル回帰検査 | ローカルでscript tests 111件とactionlint成功を確認。これにはfixtureの安全性検査を含み、実runtimeの合格件数として数えない |
| AAB SHA256 | `3a11fc62e1cc6f9b51fb6e5daab6cdfb41b3863cdab884ae49c86835ffe2aad4` |
| APK SHA256 | `cb4715becf06e3a61fb156c6e0db40feb0ada9895d3a7d2ae89efa1cd2d595a0` |
| 公開署名証明書 SHA256 | `d8dea3cfe16327293fa7fc7510859fd546ebfe50ca622dd87622fbb05f8539f5` |

CIはAABのJAR署名とAPKのapksigner署名を検証し、signer 1件・両公開証明書の一致を確認した。runnerで選ばれたapksignerのbuild-tools versionは `37.0.0`。camera optional、広告ID権限なし、受信領域のcloud backup除外、compiled Firebase project一致・google app ID存在・Crashlytics build ID存在の静的検査も成功した。Firebase client設定の生値はこの記録に転記しない。

AAB/APKともarm64-v8aのnative libraryは9本で、全LOAD segmentの16KB配置を確認した。AABは16KB bundle設定、APKはnative ZIPの16KB配置を確認した。9本すべてのnative hashもAAB/APK間で一致した。`libdatastore_shared_counter.so` と `libsurface_util_jni.so` のRELROガイド警告は各1件、計2件残る。警告だけで起動失敗を断定せず、runtime観測とは分けて保持する。

先行の配布なし署名CI [37165522441](https://github.com/mat2uken/tailcatsend/actions/runs/37165522441) / source `2573f6f4d7a673a955c749e8d17055caad27fb45` は [別記録](SIGNED_CI_VALIDATION_RESULTS.md) にある。今回のAPKは今回再生成した実体であり、versionCodeが同じでも先行runの実体とは呼ばない。

## APKの限定監査とCIの後始末

静的・署名検査の成功後、APK全体のbytesと全ZIP entryの展開内容をrunner内で監査し、検証済みAPKのSHA256とexport copyのSHA256を照合した。既知の署名keystore binary、署名・Firebase base64入力の原文と通常の空白を除いた全文、元Firebase JSON全文、effective passwordの全長literal、16 bytes以上のalias literalを内部照合した。元client JSONの構造は改名・整形・BOM・UTF16/UTF32も対象とし、大きなJSON候補や解析不能・暗号化・破損・重複ZIPは停止する。禁止入力ファイル名、署名env/configの指定形式、完全なprivate-key PEM blockも検査対象とした。

CIのsafe reportはこの監査のPASSを記録している。16 bytes未満のaliasは一般的なapp文字列との衝突を避けるためliteral照合を行わず、その制限を `short_alias_literal_scan=not-performed` と明示した。passwordの短値を省略するfallbackはない。compiled Firebase client文字列と公開署名証明書はAPKに含まれ得る。これは指定した既知入力・形式に対する検査結果であり、あらゆる秘密や変換表現の不存在を保証するものではない。

既存4署名入力とFirebase構成は単一のopaque build stepで使用し、署名helperの導出envは私有ファイルへ隔離した。生base64入力はbuild子processのenvから除き、必要な導出署名設定だけを渡した。検査済みAPKのexport後、私有keystore・env・元Firebase JSON・生成設定・私有build logはhelperの後始末対象となり、upload stepに渡すのは固定export pathのAPK1本だけとした。AAB、report、私有log、元config、所有markerはartifactへ含めない。

Crashlytics pluginとbuild IDを保持し、外部Gradle initでmapping/native uploadをfalse、upload taskを無効化した。dry-runと本buildのtask graphで有効な禁止taskを拒否する制御を維持した。GitHub Release・cache upload・Play uploadは実施していない。run metadataではartifact保存後の `always()` 所有確認付きcleanupもsuccessだった。後始末例外でも他の私有入力削除とumask復元を継続する回帰fixtureを含む。成功表示から、runner filesystemの全ファイルを独立検査したとは扱わない。

## Mac取得・独立再検証・artifact削除

| 項目 | 記録 |
| --- | --- |
| artifact | `Ponlet-Runtime-APK` / ID `11290649629`、APK1本 |
| 作成 | `2026-10-04T02:00:34Z` |
| 指定保持期間 | 1日。APIのexpires_atは `2026-10-05T02:00:32Z`、作成から86,398秒 |
| Macでの照合 | 取得APKのSHA256がCI記録と一致。公開証明書・署名検証も一致 |
| 独立再検証 | 署名・metadata・manifest・native hash/配置・compiled Firebaseの静的再検証がPASS、CIとの比較項目すべてtrue |
| 削除確認 | APIで当該artifactを削除し、`2026-10-04T02:02:52.085565+00:00` 時点で当該runの残存artifact 0件を確認 |

独立再検証はCIの私有入力を読まずに行った。既知入力literalの不在は、同じAPK hashに結び付いたCI監査に依拠し、Macで秘密を再取得して比較したものではない。artifact archiveのdigestとAPK単体のSHA256は異なる対象なので混同しない。

公開repositoryのActions artifactへAPKを一時保存する範囲はユーザー承認に含まれる。APIでの削除確認はその時点の当該runの残存0件を示し、保存中の第三者downloadや既取得copyの不存在を示さない。Macの試験用APKはruntime用に保持し、GitHub上の短期artifact削除とは分けて扱う。

## 取消した先行runtime run

[37168060834](https://github.com/mat2uken/tailcatsend/actions/runs/37168060834) / source `90501c82818c34bf7e32230486e160906e292a6c` は、追加レビューで見つかった後始末の例外処理と大JSON文字コード判定のP1/P2修正前に親作業が取消した。artifact uploadはskipped、artifact 0件、cleanup successを確認した。実APKに秘密が混入したという検出ではなく、監査・後始末の穴を補強して新SHAで再実行した経緯である。この取消runの結果を成功runへ付け替えない。

## 根拠の保存先

以下はローカルのignored作業領域に保持した安全な記録で、APK artifactへ含めていない。

- `work/signed-runtime/private/ci-safe-summary.json`：成功runのsource SHA、署名・静的検査・限定export監査のsafe summary。
- `work/signed-runtime/private/ci-final-metadata.json`：成功・配布job skipped・artifact保存とcleanup step success。
- `work/signed-runtime/private/local-apk-safe-report.json`：Macで取得したAPKの署名・静的検査。
- `work/signed-runtime/independent-apk-verification.json`、`independent-apk-signature.json`：独立再検証とCIのhash・公開証明書・各検査項目の比較。
- `work/signed-runtime/private/ci-artifacts-before.json`：作成時刻・expires_at・対象artifact ID。
- `work/signed-runtime/private/artifact-deletion-confirmation.json`：削除対象ID・確認時刻・残存0件。

静的なcompiled設定の存在はSDK実通信の完了を示さない。この記録からPlay App Signingとの署名一致、Play版upgrade、Play配布・審査、iOS実績によるAndroidの保証を導かない。

## runtime結果

今回のAPKを空の専用AVD `ponlet-runtime-16k` にfresh installした。API35 / arm64-v8a / 実測PAGE_SIZE 16384。snapshot・既存AVDデータは使わず、cameraなし・audioなし・専用loopback接続で操作した。Web相手も今回だけの隔離sessionとし、既存公開版 `https://ponlet.mat2uken.app/` を使った。Web版が候補source SHAと同じrevisionである保証はない。

| 確認 | 結果と限定 |
| --- | --- |
| install・起動 | PASS。新規install後にUIが表示され、own-PIDでFirebase初期化・Crashlytics初期化を確認。採取したown-PID log内にFATAL EXCEPTIONなし。全期間・全OSのcrash不存在を示さない |
| telemetry操作 | 既定ON → OFF → アプリ終了・再起動後OFF維持 → 再ONを画面で確認。HTML checkboxのAX `checked` は状態を反映しなかったためPNGも保存。SDKの実送信状態は下節の限定を伴う |
| URL接続 | PASS。Webの試験用招待URLで接続し、AndroidにDERP relay経路が表示された。実カメラ／QRは使っていない |
| Web → Android日本語 | 日本語の文字・内容を表示、履歴保存でも確認。元入力48 bytesには末尾改行があるが、保存履歴では区切り改行と区別できず完全なbyte保持は未保証 |
| Android → Webテキスト | PASS。ASCII dummy 41 bytes、受信UI本文のSHA256 `063be11579c0025eacfbc07c09c87935c733eb1415e8126cc4b606f5c3baa1b9` が元入力と一致 |
| Android → Web画像 | PASS。Android OS文書pickerでdummy PNGを選択。Web受信後の「開く」操作で保存した97 bytesが元SHA256 `9b1dd1e812425b88dce4b8bd1594f3c6b76f8c97f0c2de135e1acbdd3b0ca1fb` と一致 |
| Web → Android画像 | 初回FAIL、下節の原因確認後の1回の再試行はPASS。99 bytes、SHA256 `be95da8b3f09406cc671b23e14e692948c5be2fc96d7dfc5eed7eade0c4b7f37` が元と一致。受信一覧の「開く」で既存Photosに赤いdummy PNGを表示 |
| テキストSAF保存 | 履歴全体の操作メニューからSave → Android文書保存picker → Downloads保存はPASS。UTF-8 103 bytes、SHA256 `83f7fcdbce4886ffb79fdacf1c28514b2fc0d0c8a6c8097c8a72d72d16682c71`。日本語内容とASCII内容を含む。メッセージ単位Saveは下記UI問題で直接確認できなかった |

画像照合は、Web側はUI download、Android側は既存debug AVDの `su 0` を使った今回の受信dummy PNGだけのread-only byte数・hash確認で行った。新しいOS permission／loginは追加していない。初回Web送信失敗を成功結果で置き換えない。両方向画像の成功は各1例であり、一般的な通信安定性を保証しない。

### 初回ファイル転送タイムアウト

Web → Androidの最初の99-byte PNG送信は `DialTCPPort: context deadline exceeded` で失敗し、Androidの受信一覧には現れなかった。`apps/web/src/lib.rs:1059` はFILE_PORT 102へのdialが完了してから `:1078` の送信処理へ進む。`crates/tailsend-transfer/src/live.rs:185–187,197,207` のheader書込・file読み取り・本文書込へ進む前の失敗なので、画像内容・SAF保存の失敗とは判定しない。Native側は `apps/tauri/src/runtime.rs:586–587` でTEXT_PORT 101とFILE_PORT 102を受け分ける。テキスト成功だけからファイル用接続の成功を推定しない。

`tailcat/bridge/web/main.go:157,182` では既存clientを再利用し、60秒dial失敗時にcache削除・client closeを行う。これを確認したうえで同じ小画像を一度だけ再送し、受信・hash一致・Openを確認した。fresh clientが関係する可能性はあるが、DERP／WebRTC／経路切替のどれが主因かは未特定。修正根拠なく通信コードを書き換えたり、成功するまで連続送信したりしていない。

次はfresh接続とclient再利用の両条件で、TEXT_PORT 101とFILE_PORT 102の接続・端末受信・失敗時間を同じ手順で比較する。再現する場合はdial開始／完了・client世代・経路状態だけの安全な診断を追加し、本文・ファイル名・招待情報をlogへ出さず原因を絞る。

### P2：メッセージ単位メニューが切れる

受信メッセージの操作メニューでCopyは見えるがShareが一部だけ、Saveは履歴領域外になった。画面証拠ではSaveのAX boundsが履歴下端より下にあり、表示外の座標は入力欄に当たる。SAF API失敗の証拠ではない。履歴全体メニューのSaveからは同じAndroid文書保存機能が動いた。

`web-ui/src/style.css:456–459` は履歴を `overflow-y: auto; overflow-x: hidden` にし、`:1166–1168` は行をrelative、`:1133–1136,1205–1207` はmenuをabsoluteで下側へ配置する。`web-ui/src/main.ts:778–799` はそのmenuを行の子に置き、開閉時の上側配置・高さ補正を行わない。修正案は利用可能な上下高さを測って上側へ切り替え、上下とも不足する場合は画面内へ収まる別配置にすること。履歴のoverflowを一律visibleへ変えると入力欄へ重なるので避ける。最下行・複数行・キーボード表示時で再確認する。本調査では製品CSS／UIコードを変更していない。

## SDK通信：確認できたことと未確認

ON、OFF、OFF再起動、再ONのidle windowをそれぞれ約45秒で揃えた。初回と再起動後の2世代でFirebase初期化・Crashlytics初期化を確認した。初回のAnalytics logに「manifestでmeasurement無効」、再起動後に「measurement無効」があるが、後続の収集API呼出しで変わり得るため最終ON状態が無効のままとは断定しない。Sessionsの無効／送信なし起動記録も、queue不存在・削除・backend受領の証拠にはならない。

idle時のPonlet UID netstatsは全snapshotでrows 0のため比較不能であり、通信量0ではない。UID socketは観測したがDNSとの対応が取れずGoogle SDK用途を特定できなかった。転送後にはUID累積rx/txの行が現れたが、before側に行がないため転送だけ／SDKだけの差分と呼べない。OS／GmsCore／WebView側の通信をPonlet収集として数えていない。

Web相手では公開siteと `https://tailcat.dev/derpmap.json` のGET応答、`https://tc301a.ipn.dev/derp` のHEAD 200を観測し、Androidのown-PIDにもDERP接続記録がある。これはWebのasset／relay probeとAndroidのrelay使用の証拠であり、Android Firebaseの送信先・TLS payloadの証明には使わない。

最終pcapは1,374 bytes / 9 recordsで、選択したUDP/53 DNS回答は0件。emulatorの `-tcpdump` がmynet経路を対象としWiFi側を十分捕捉できない可能性がある。終了後もpartial tailはなく、単なるstdio flush不足とは断定しない。DNSサービスdumpも使えなかった。完全なSDK宛先、TLS送信内容、未送信queue、再ON送信、server受領・保持・削除は未確認。故意crash、実カメラ／ML Kit QR、cloud復元、Play upgradeは未実施。

次はSDK収集APIの適用・保存状態を安全なbooleanで確認する方法と、試験AVDの実ネットワーク経路を捕捉できる方法を選び、同じidle条件で測る。ID、生payload、証明書の差し替え、SDK設定変更を当然の前提にしない。現状の公開草案には「OFFで全Google通信停止」「全SDKデータ削除」等の保証を追加しない。[SDK保持・削除調査](SDK_RETENTION_AND_DELETION.md)の未確定項目を残す。

## runtime証拠と後始末

生招待URL・端末識別子・packet等を含み得る原本はprivate local領域に置き、この文書・artifactへ添付しない。安全な結果とdummyのhashを対応付ける。

- `work/signed-runtime/private/android-to-web-text-proof.json`：ASCII受信内容の照合。
- `work/signed-runtime/private/android-to-web-file-proof.json`、`web-to-android-file-proof.json`：画像のbyte数・hash・Open。
- `work/signed-runtime/private/saf-save-proof.json`：保存103 bytesと改行保持の限定。
- `work/signed-runtime/private/settings-default-on.png`、`settings-off.png`、`off-restart-settings.png`、`settings-reon.png`：設定UI。
- `work/signed-runtime/private/received-message-actions.png`：menu切れ、`global-save-saf-picker.png`：履歴全体の保存picker。
- `work/signed-runtime/sdk-network-interpretation-idle.json`、`sdk-network-interpretation-transfer.json`：SDK／OS／relayの区別と観測限界。
- `work/signed-runtime/private/runtime-cleanup.json`：所有確認と終了、最終pcap集計。

2026-10-04 `02:41:57.245644+00:00` に今回の専用AVDと隔離Web相手の終了を確認した。emulatorは記録済みPID／process group／AVD名／起動引数を照合して終了し、他のADB server・AVD・物理端末・USB・AuraGauge・音声は操作していない。今回のWeb出力はignoredのprivate領域へ移した。独立レビューで結果・hash・後始末・記述の限定を照合し、新たな重大指摘なし。根拠の行番号1件を修正した。試験APK・dummy・ローカル証拠は調査記録として残し、Gitへ追加しない。

Play配布、審査提出、公開privacy／support差し替え、mainへの反映、実機・cloud復元は行っていない。`publication_ready=false` を維持する。基本runtimeの未実施は解消したが、上記失敗・UI不具合・SDK観測の限定、Console設定とclosed test条件は残る。
