# Android審査員手順とテスト計画

内部レビュー用。審査員へ送信していない。現在の手順は基準コードを読んで作成したもので、提出releaseの実機で再現した後に確定する。iOS／macOSの実績はAndroidでの成功記録として扱わない。

2026-10-03 17:59 UTCにユーザーが承認：Play本体無料、子ども向けを意図しない一般向け、Android受信ファイルのクラウドバックアップ除外、広告ID無効化。Analytics／Crashlyticsは既定ONとOFF操作を維持する。具体的なPlay年齢区分とConsole選択は未実施、D2D移行の対象範囲は拡張しない。


新候補の未署名AAB `versionCode=2030000102` は親担当の最終artifact validatorで確認済み。compiled manifestの広告ID取得・広告personalization flagsは両方false、3広告関連権限は不在。compiled resourcesからbackup XMLを解決し、API31+のcloudでは `received/` だけを除外、SharedPreferencesと隣接ファイルを保持、空のD2D規則は既存の対象を保持することを確認した。これはOS復元試験・実通信・署名・Play配布の成功を意味しない。詳細は [承認後の方針検証](POLICY_VALIDATION_RESULTS.md) を参照。

## 審査員向け日本語案内

Ponletは、ユーザーが選んだ相手へファイルとテキストを送るアプリです。ログイン・demo accountは必要ありません。二つの端末、またはAndroid端末と、別の端末のWebブラウザを使って確認できます。Web版は `https://ponlet.mat2uken.app/` です。インターネット接続を用意してください。

1. AndroidでPonletを開きます。もう一方の端末でもPonletまたはWeb版を開きます。
2. 一方で招待を作成します。相手側で「カメラで読取」を選び、カメラ権限を許可して招待QRを読み取ります。カメラを使わない場合は、招待URLをコピーして相手の招待URL欄へ貼り付け、「接続」を選びます。
3. 双方が「接続済み」になったことを確認します。期限切れの場合は招待を再生成し、新しいURL／QRを使います。
4. 「メッセージ」で短いテキストを入力して送信し、相手の履歴に同じ本文が表示されることを確認します。逆方向も送信できます。
5. 「転送」の「ファイルを選択」で小さい画像やPDFを選びます。転送の完了と、相手の受信一覧を確認します。
6. Androidの受信ファイルはアプリ内部に保存されます。受信一覧の「開く」で対応アプリを起動できます。公開Downloadフォルダへ自動保存するものではありません。テキストはコピー・保存・共有の操作で利用できます。
7. 「切断」後に再接続できます。設定で表示言語と「テレメトリを許可」を変更できます。Firebaseの利用状況／クラッシュ収集は既定ONです。QR読取SDKの診断はこの設定とは別なので、プライバシーポリシーをご確認ください。

専用アクセサリ、USB接続、音声入力は不要です。転送に使う招待URLとQRは、その相手だけに渡してください。操作に問題がある場合は `app-support@mat2uken.app` へOS、アプリバージョン、再現手順をお知らせください。秘密の招待情報やファイル本文を送る必要はありません。

提出時に追記：`versionName=[ ]`、`versionCode=[ ]`、実機で手順確認した端末・OS `[ ]`。本体無料は承認済み。配布地域によるストア取得条件は別途確定する。

## Reviewer instructions in English

Ponlet transfers files and text to a peer selected by the user. No login or demo account is required. Use two devices, or an Android device and a web browser on another device. The web client is available at `https://ponlet.mat2uken.app/`. An internet connection is required.

1. Open Ponlet on Android. Open Ponlet or the web client on the other device.
2. Create an invitation on one side. On the other side, choose “Scan with camera,” grant camera permission, and scan the invitation QR. To connect without a camera, copy the invitation URL, paste it into the invitation field on the other side, and choose “Connect.”
3. Confirm that both sides show “Connected.” If the invitation has expired, generate a new invitation and use its new QR or URL.
4. Send a short message from Messages and confirm that the same text appears in the peer’s history. Repeat in the opposite direction.
5. Choose a small image or PDF through “Choose file” in Transfer. Confirm transfer completion and the entry in the peer’s received list.
6. On Android, received files are stored in internal app storage. “Open” launches a compatible app. Files are not automatically saved to the public Downloads folder. Text can be copied, saved, or shared.
7. Disconnect and reconnect. Settings allow changing the display language and “Allow telemetry.” Firebase usage analytics and crash collection are enabled by default. QR scanning SDK diagnostics are separate from this setting; see the Privacy Policy.

No dedicated accessory, USB connection, or voice input is needed. Share invitation URLs and QR codes only with the intended peer. For help, email `app-support@mat2uken.app` with the OS, app version, and reproduction steps. Do not include secret invitations or private file contents.

Before submission, fill in the verified `versionName=[ ]`, `versionCode=[ ]`, device and OS `[ ]`. The Android app is approved to be offered free; regional availability remains to be decided.

## release検証の前提

提出AABのSHA、source SHA、versionCode、署名確認結果を記録する。新しいsourceから作ったdebug APKの成功だけで既存／新AABの成功としない。最終releaseで縮小されたJavaコード、ML Kitのモデル取得、FileProvider、SDK初期化、非debuggable WebViewの動作を確認する。

現在の作業では端末・USB・音声にアクセスしない。以下は将来、対象端末と試験を明示的に許可した実行で使う計画である。別アプリの検証端末を勝手に再起動・インストール・削除しない。

## 試験一覧

| ID | 試験 | 合格条件・証拠 |
| --- | --- | --- |
| B01 | AAB識別・署名・バージョン | packageがConsoleと一致、versionCodeがアップロード対象より新しい、release署名が正しい。AAB hash／source SHA／検査ログを記録 |
| B02 | 16 KB native／ZIP整列 | libtailcatとRust、Crashlyticsを含む全 `.so` のELF segmentと最終生成APKの整列を検査。16 KB環境で起動・転送・QRを確認。Consoleで新AABも対応表示される |
| B03 | merged manifest | 広告関連権限の有無、CAMERA、VIBRATE、INTERNET等を実物で確認。camera任意を意図するなら `required=false`。ソースだけの確認にしない |
| B04 | Android対応範囲 | minSdk31以上のarm64端末、最新target相当OS、16 KB端末／emulator。カメラなし対応はmanifest修正後に別確認。TVを対象に残す場合は操作・配布条件も確認 |
| U01 | fresh install起動 | releaseがクラッシュせず、招待・設定へ進める。OFF保存済みのupgradeとfresh installを区別 |
| U02 | レイアウト・言語 | 日英切替、画面回転、文字拡大、キーボード、画面端でボタンが押せる。releaseのスクリーンショットを記録 |
| C01 | QR権限拒否／再許可 | 読取操作時だけ要求。拒否後もURL貼付が使える。設定から許可した後に再読取できる |
| C02 | QR取消・再開 | prompt中に閉じる、読取画面を閉じる、再開、バックグラウンド往復。取消後に遅れたQRで接続せずカメラを解放 |
| C03 | ML Kit初回モデル | Play servicesモデル未取得・offline等で読取不能時に固まらず案内する。オンラインでの再試行と取得後offline読取を記録 |
| F01 | OS文書選択 | 画像、動画、PDF、日本語名、空ファイル、複数選択、取消、端末内／クラウド提供元で成功。APIへpathを直接渡すE2Eだけで合格にしない |
| F02 | 受信保存 | 内部保存、同名2回、容量不足、転送取消・一時ファイル、再起動後の残存を確認。送受信SHA-256／byte数を照合 |
| F03 | 開く・書き出し | ACTION_VIEW対応アプリ、対応なし時のchooser、権限拒否／アプリなし、未知MIME。supportに記載する外部保存の実際の手順を確認 |
| F04 | テキスト操作 | Copy／Paste、招待URL貼付、Saveの文書保存画面、Share、履歴消去が成功。clipboard内容を無断送信しない |
| F05 | OSバックアップ・復元・端末移行 | 許可された試験専用端末・アカウントで、backup有効／無効、cloud／端末移行、clear-data／アンインストール後の再導入を分ける。API31+のcloudでは受信 `files/received` が除外され、D2Dは既存範囲から拡張されていないことを検査。telemetry OFF／言語設定、SDK識別子等の復元対象と挙動、旧版由来の残るコピー・削除範囲も確認。OFF選択が復元後に維持されるかを記録し、device／OS／OEM／backup設定を明記。私的データを試験に使わない |
| N01 | 双方向接続・転送 | Android↔Android、Android↔Webで日本語テキストと小／大ファイル。UDP／WebRTC／DERPの各観測値と両端の保存内容を記録 |
| N02 | 中断・復帰 | 転送取消、切断、招待期限切れ・再生成、ネットワーク切替、offline→復帰、バックグラウンドで状態と保存内容を確認。未実装のbackground継続を保証しない |
| T01 | 初回ON | initial SDK設定、送信先、自動イベント／ID／概略位置を確認。転送内容・ファイル名・鍵・招待情報が解析へ送られない |
| T02 | OFF直後／再起動 | UI値、SharedPreferences、SDK収集状態が一致。切替時・次起動・network復帰の通信を観測。単なるUIスイッチ成功としない |
| T03 | OFF中QR | ML KitのGoogle通信・診断をFirebaseと分けて記録。policyがOFFの適用範囲を正しく説明している |
| T04 | crashと再ON | 別のテスト用配布で許可してJava／native crashを作る。OFF中crash→再起動、OFF→ON、ON中crash→起動前OFF等の未送信reportを検証。productionで故意にcrashしない |
| T05 | 広告ID変更 | 新候補のmetadata／manifest／観測を一致させる。広告ID無効でも通常のAnalytics、Crashlytics、QRが正常。識別子が全消滅したとは判定しない |
| P01 | 日英policy・appリンク | 未確定欄がなく、公開日英URLが200。appから正しい言語を開く。本文とData safety／AAB構成が一致 |
| R01 | Play導入・pre-launch | Play内部／closed testから最終候補を導入し基本手順を再現。pre-launchのcrash／ANR／権限・画面指摘を確認し、network依存の未実行を区別 |

releaseは通常CDP／run-asを使えないため、debug用E2Eと手動release試験を分ける。既存の `tests/e2e/test_android_browser_real.mjs` と `test_android_browser_cancel.mjs` はdebuggable対象での補助検証。`tests/e2e/SETTINGS_ROUTE_VALIDATION.md` の記録形式も併用できる。

## 記録様式

```text
date_utc=
test_id=
source_sha=
version_name=
version_code=
aab_sha256=
installed_from=local-debug / local-release / Play-internal / Play-closed
device_model=
android_version=
page_size=4096 / 16384
peer_device_os=
transport_android=
transport_peer=
input_name_size_sha256=
received_name_size_sha256=
telemetry_state_before_after=
os_backup_settings_and_transport=
backup_restore_scope_and_result=
observed_network_destinations=
result=PASS / FAIL / NOT_RUN
evidence_path=
remaining_issue=
```

招待トークン、セッション鍵、端末識別子の生値、秘密のFirebase設定、私的ファイル本文をログや共有スクリーンショットに残さない。通信検証には公開してよいテストデータを使う。

## 現在の実行状態

上記の新候補release実機試験は**すべて未実行**。この文書のチェック項目や操作案内の存在を合格証拠として扱わない。既存AABの16 KB非対応と広告関連権限は [README](README.md) と [Data safety](DATA_SAFETY_DRAFT.md) の確認済み事実である。親担当が後続で行うコード検査・ローカル検証は、そのsourceと対象を別の結果記録で追記する。

OSバックアップ・復元は未実行。17:59 UTCの承認後、新候補はAPI31+のcloud backupで受信 `files/received` のみ除外し、D2Dの既存範囲を維持する方針。最終AABのrulesとOS／OEMの実際の挙動を確認する。[Android Auto Backup資料](https://developer.android.com/identity/data/autobackup)に基づき、設定復元、旧版backup、削除範囲を分けて試験する。minSdk31ではlegacy older API規則の経路へ到達しない。
