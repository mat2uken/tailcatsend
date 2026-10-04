# 次段のAndroid runtime最小手順（未実行）

2026-10-04 UTC。署名CI [37165522441](https://github.com/mat2uken/tailcatsend/actions/runs/37165522441) / source `2573f6f4d7a673a955c749e8d17055caad27fb45` は署名・証明書一致・16KB・manifest・compiled Firebase検査PASS。CIのAAB/APKを保存していないので、次段には再buildと検査済みAPKの移送が必要。現時点で新しいupload・移送・Firebase実通信・端末操作を行っていない。

## まず一括承認できる限定範囲

1. 専用branchに明示的なruntime候補出力modeを追加し、既存署名入力とFirebase構成で同じrelease AAB/APKを再buildする。90分上限、Play credentialなし、Crashlytics mapping/native upload抑止、秘密入力cleanupを維持する。静的検査PASS後のAPKと安全な検査reportだけをActions artifactへ保存する案とする。保存期間1日、既存gh認証でMacへdownload・hash照合後に当該artifactを削除する。鍵、password、元Firebase構成、私有build logは保存・移送しない。GitHub Release・Playへのuploadは含めない。
2. 既存API35 arm64/16KB system imageと専用AVD `ponlet-pilot-16k` の方式を再利用する。前回専用AVDは終了済み、現時点の稼働状況は未再確認。ユーザーの既存AVDデータを使わず、空の試験領域・snapshotなし・cameraなし・audioなし・loopbackの対象emulatorだけを使う。物理端末・USB・別AuraGaugeには触れない。
3. Ponletをfresh installし、既定ONで一度起動、OFF→再起動→再ONの保存とSDK初期化を確認する。PonletのFirebase／ML KitとOS由来通信をPID等で分け、送信先と必要最小限の証拠を記録する。故意のcrashや診断queueの大量生成は行わない。DNS／接続情報だけでTLS内の送信内容を完全に証明したとは扱わない。
4. MacのPonlet Web版を試験相手とし、招待URLで接続、日本語テキストと小さいdummy画像またはPDFを双方向転送する。AndroidのOS文書選択、受信一覧→開く、テキストのSave→SAF文書保存先選択を操作し、byte数／hashを照合する。試験データだけを使い、招待tokenや識別子の生値は共有証拠へ残さない。終了後は今回起動したAVDだけを終了する。

**artifactの公開範囲も承認対象。** このrepositoryは公開で、Actions artifactはGitHubへログインしrepo read権限を持つ人がdownloadできる。[GitHub公式説明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)。1日保存やdownload直後の削除は、期間中の第三者downloadを防ぐ保証ではない。上記はAPKをこの範囲へ置くことを含む一括承認案であり、現時点の承認ではない。署名秘密は移送しない。別の非公開保管先を選ぶ場合、その場所と既存の利用可否を先に確定する。

APKにはcompiled Firebase client設定が含まれ、download者が解析できる。保存・移送から除外するのは元JSONファイル、署名秘密と私有logであり、APK内のclient設定が読めなくなるという意味ではない。

## 本番通信で生じるデータと宛先

| 経路 | 許可する最小試験で生じ得る情報 | 宛先・限定 |
| --- | --- | --- |
| Firebase Analytics／Installations／Sessions | 起動・利用・接続・転送イベント、本文長などの分類値、app-instance／installation等のID、端末・OS・アプリ情報、IP由来の概略位置 | Google LLC、確認済みproject `ponlet-599c4`、リンク先GA property `553139030`／Android stream `15740481045`。compiled project一致はCIで確認、実際のSDK接続先は次段で観測 |
| Crashlytics／NDK | installation関連ID、session、端末・アプリ情報。偶発crash時はstack trace／診断 | 同じGoogle Firebase project。故意のcrash、native/mapping build upload、Google設定変更は承認案に含めない。OFFは次起動反映、再ONは既存未送信reportを送る場合がある |
| ML Kit／Play services | QR利用時の機種・OS・アプリ・識別子・性能／API利用状況、モデル取得等 | GoogleのSDKサービス。画像・QR読取結果は端末内処理という実装・SDK仕様と、独立した診断通信を分ける。Firebase OFFで一括停止するとは説明しない |
| 接続・転送 | dummy本文／ファイルの暗号化転送、接続metadata、IP | 指定した試験相手、`https://tailcat.dev/derpmap.json` とそのmapが列挙するrelay、Web相手 `https://ponlet.mat2uken.app/`。relayの実宛先は試験時に観測し、固定host一覧を推測しない |

広告ID取得・広告personalizationは新候補で無効化済み。転送本文・ファイル名・path・鍵・招待URLを独自Analyticsに渡す処理はないが、SDKの自動収集とOSの通信は別に扱う。全ての実host名・送信payloadを現時点で観測済みとはしない。[Firebase開示](https://firebase.google.com/docs/android/play-data-disclosure)、[ML Kit開示](https://developers.google.com/ml-kit/android-data-disclosure)、[SDK調査](SDK_RETENTION_AND_DELETION.md)を参照。

## ユーザー操作が必要な追加確認

| 項目 | 最小操作と条件 | 次の一括承認案との関係 |
| --- | --- | --- |
| SAF／受信 | 試験AVDのOS文書pickerでdummy入力と保存先を選び、受信ファイルを対応アプリで開く。これは写真／動画library全体のアクセス許可とは別 | 上記AVD基本試験に含める。未提供のcloud storageや私的ファイルは使わない |
| 実カメラQR | 指定されたAndroid試験端末でユーザーがカメラ許可／拒否を選び、Mac表示のdummy招待QRを読む。AVDはcameraなしなので代用不可 | 使用できる実機・OS・PAGE_SIZEは既知情報なし。ユーザー自身の操作または指定端末への限定許可を別途必要とする。USB接続は必須にしない |
| cloud backup／復元 | 試験専用端末・Googleアカウントとbackup transportを指定。dummy受信ファイル・OFF設定→backup→試験対象だけを復元し、cloudで受信が戻らず設定がどう復元されるかを確認 | clear-data／uninstall／復元は破壊を伴うためAVD基本試験に含めない。D2Dは別経路。既存backup削除やユーザー端末resetを行わない |
| Play版upgrade | 既存内部テスト版でOFFを保存→新候補が許可を得てPlayに反映された後、同じ端末で通常更新し保存値を確認 | Play App SigningとCI APKの署名は同一と仮定しない。ローカルAPKでPlay版を強制置換しない。新候補のPlay upload・tester操作は別承認 |

## 審査要件と品質確認の区別

提出に必要なのは、配布candidateの技術要件と、正確なData safety／privacy、contact・listing・target audience等のConsole設定を満たすこと。内部テストのみはData safety免除だがclosed／open／productionは対象である。[Play Data safety](https://support.google.com/googleplay/android-developer/answer/10787469)。本件Consoleに表示されたclosed testの12人・連続14日と本番アクセス申請は、適用されるアカウントの配信条件であり、AVD試験で代用できない。[Google公式条件](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en)。16KB対応は対象アプリの配布要件であり、最新候補の静的成功後もPlay側表示は配布段階で確認する。[Android公式説明](https://developer.android.com/guide/practices/page-sizes)。

起動・転送・SAF・OFFの最小試験は、機能と申告の整合を確かめる優先確認。OS／OEMを網羅する復元、巨大ファイル、全ネットワーク条件、故意のcrash、全SDKの異常系を、Googleが指定する提出必須チェック表として扱わない。実カメラQRは主要機能の品質確認として優先し、広い端末matrixやD2D／cloud復元はclosed test中の追加確認にもできる。正確に説明できない挙動は未確認と記録し、未検証の保証を公開文へ書かない。

一括承認案の要約：**検査済みrelease APKだけの短期Actions保存・Mac download後削除、専用16KB AVDへのinstall、実Google／relay通信を伴うdummy転送・SAF・telemetry試験**。実機QR・cloud復元・Play upload／upgrade・公開・審査提出は別段階。現在は計画のみ。
