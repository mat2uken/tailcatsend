# 日英privacy／support修正草案

内部レビュー用。2026-10-03 17:59 UTCに本体無料、子ども向けを意図しない一般向け、Android受信ファイルのcloud backup除外、広告ID無効化とAnalytics／Crashlytics既定ON維持が承認された。日英privacy／supportの `dist/` ローカルHTMLも修正する。**公開していない、`publication_ready=false`**。保存期間・削除の一般仕様と一部GA実設定は確認済み。配布Androidとの接続先照合、個別削除手順、ML Kit保持期間とSDK実通信は未確認。未確定欄はこのdocsだけに保持し、HTMLへplaceholderを混入しない。未署名候補の広告IDflags／3権限除去とcloud ruleは検査済みで、ローカルHTMLへ「この改訂」として反映した。既存配布版1.0.18へ適用する説明ではない。

公開ページの読み取り確認は2026-10-03 UTC。次の4ページはHTTP 200。公開メールはCloudflareによる難読化表示だが、リポジトリの宛先は `app-support@mat2uken.app`。

- [日本語privacy](https://ponlet.mat2uken.app/privacy_ja.html)
- [英語privacy](https://ponlet.mat2uken.app/privacy_en.html)
- [日本語support](https://ponlet.mat2uken.app/support_ja.html)
- [英語support](https://ponlet.mat2uken.app/support_en.html)


新候補の未署名AAB `versionCode=2030000102` は親担当の最終artifact validatorで確認済み。compiled manifestの広告ID取得・広告personalization flagsは両方false、3広告関連権限は不在。compiled resourcesからbackup XMLを解決し、API31+のcloudでは `received/` だけを除外、SharedPreferencesと隣接ファイルを保持、空のD2D規則は既存の対象を保持することを確認した。これはOS復元試験・実通信・署名・Play配布の成功を意味しない。詳細は [承認後の方針検証](POLICY_VALIDATION_RESULTS.md) を参照。

## 修正対象

| 現行箇所 | 修正の目的 |
| --- | --- |
| `dist/privacy_ja.html:105–130`（英語も同位置） | 転送本文のサーバー保存を行わない設計と、SDK解析・診断データの収集を分ける |
| 同 `:175` | Androidの保存先がアプリ内部 `files/received` であることを説明する |
| 同 `:188–225` | 独自イベントとSDK自動収集、IP由来概略位置・識別子、ML Kit診断、OFFの適用範囲を説明する |
| 同 `:240–259` | 全第三者・全個人データの不保持や削除不要を保証する文を、実際の保存・削除方針に置き換える |
| 同 `:123,160–175,259` | OSバックアップで内部受信ファイル・保存設定が端末外へ複製・復元される可能性を説明し、削除範囲の断定を修正する |
| `dist/support_ja.html:94–102` | Androidのファイル選択・内部保存・開く操作を案内する。iPhoneの共有画面をAndroidにも保証しない |

根拠は [Data safety草案](DATA_SAFETY_DRAFT.md) と [検証計画](REVIEW_AND_TEST_PLAN.md)。既存HTMLの見た目・言語切替・問い合わせ先を保って反映することを想定する。

## 日本語privacy差し替え候補

### アプリと転送データ

Ponletは、ユーザーが選んだ相手へファイルとテキストを送るアプリです。Ponletの通常利用にアカウント登録やログインは必要ありません。送受信するファイルやメッセージの内容を開発者のファイル保存サーバーへ蓄積する仕組みはありません。端末間の通信は暗号化され、直接接続が難しい場合は暗号化されたパケットをDERPリレーで中継します。

品質改善のために利用するFirebaseや、QR読取に利用するML Kitの解析・診断データは、転送内容とは別にGoogleへ送信されます。以下で、その種類と設定について説明します。ファイル名、ファイルの内容、メッセージ本文、セッション鍵、招待URLを、Ponletの独自解析イベントへ渡す処理はありません。

### Androidのカメラ・ファイル・端末内保存

カメラは、ユーザーが「カメラで読取」を選んだときに招待QRを読むために使います。カメラ権限は読取時に要求します。カメラ画像とQRの読取結果はML Kitで端末内処理され、画像や読取結果をGoogleのサーバーへ送るためには使いません。ML Kitは、機種、OS、アプリ情報、インストールに関する識別子、性能やAPIの利用状況等の診断データをGoogleへ送る場合があります。

ファイル送信ではAndroidの文書選択画面からユーザーが選んだファイルを読み取ります。受信したファイルは、AndroidではPonletのアプリ内部保存領域に保存します。外部のアプリで開く操作を選んだ場合は、選んだアプリにそのファイルを読む権限を与えます。テキストのコピー・貼り付け・共有も、ユーザーの操作に応じて行います。

Androidのこの改訂では、API31以降のOSクラウドバックアップから受信 `files/received` を除外します。端末間移行（D2D）の既存の対象範囲は変えません。保存設定やD2Dでのコピー・復元は、端末の設定、OS、メーカーの動作に依存します。テレメトリをOFFにしてもOSバックアップ全体を止めるものではありません。既存1.0.18や方針変更前の候補には受信ファイルをcloudから除外する指定がなく、過去のbackupコピーはこの変更だけでは削除されません。［compiled ruleは検査済み。復元・削除範囲を確認後に公開］。

### 利用状況とクラッシュ報告

Ponletのテレメトリは品質改善と安定性向上のために既定で有効です。設定の「テレメトリを許可」からFirebase AnalyticsとCrashlyticsの収集をOFFにできます。この選択はAndroidのアプリ設定へ保存します。

Ponletが独自に送るイベントは、アプリの起動、接続作成・接続完了、転送の開始・完了・取消、テキストの送受信、分類済みのエラーです。パラメータはプラットフォーム、OSとアプリのバージョン、言語、通信経路、送受信の方向、ファイル数、テキスト長の区分、取消理由・エラーの分類です。

これに加えてFirebase Analyticsは、アプリインスタンスの識別子、アプリの利用イベント、IPアドレスから導かれる概略位置などを扱います。Crashlyticsはクラッシュ時のスタックトレース、端末・アプリの状態、インストールに関する識別子等を扱います。SDKの推移的な依存が扱う識別子やセッション情報も含め、使用SDKと設定に応じた情報がGoogleへ送られます。氏名やアカウントを設定しなくても、これらの識別子は存在します。

**承認済み新候補向け草案**：Android版ではFirebase AnalyticsのAdvertising ID取得と広告パーソナライズを無効にし、広告識別関連の3権限を取り除きます。広告表示機能はありません。アプリインスタンス識別子、IP由来の概略位置、クラッシュ・ML Kit診断の取得は、この変更によって無くなるものではありません。既存1.0.18のAABには広告ID関連権限が含まれます。［compiled flags／permissionsは検査済み。実通信を確認後に公開］。

AndroidではFirebaseの収集設定を変更します。CrashlyticsのOFFは次回アプリ起動から反映され、OFF中のクラッシュ情報は端末に保持されます。再ONすると未送信の情報も送信されます。OFFはGoogle側の過去データ削除や端末内レポートの破棄を行う操作ではありません。切替前のqueueや送信中データ等の実動作は［試験結果を追記］です。ML KitのQR読取に伴うSDK診断はこのスイッチとは別です。このスイッチをOFFにしても、ユーザーが開始する端末間の転送や、接続のための通信は行われます。

### 送信先・保存期間・削除

解析・診断データの送信先はGoogle LLCです。通信にはTLS／HTTPSを利用します。Googleでの取扱いについては [Googleプライバシーポリシー](https://policies.google.com/privacy?hl=ja) もご確認ください。Google側のサービス設定と保存期間の一部は、[SDKメモ](SDK_RETENTION_AND_DELETION.md)と[project読み取り](PROJECT_SETTINGS_READONLY.md)で確認しています。配布Androidとの接続先照合、対象別の実行可能な削除手順と残る保存期間は［確認後に公開文へ記載］します。転送ファイルの不保持と、解析・診断データの保存を同じものとして説明しません。

Androidのデータ削除・アンインストールは、現在の端末のアプリ内部ファイルや設定を削除する操作です。OSバックアップ、移行先端末、別アプリや外部保存先のコピーまで同時に消す保証はありません。OSのバックアップから再インストール時などに復元される場合もあるため、バックアップ側の保存・削除方法は利用端末とバックアップサービスの設定から別途確認してください。解析・診断データの開示・削除に関するお問い合わせは `app-support@mat2uken.app` へご連絡ください。［実行可能な削除方法、必要な情報、対応範囲を確認してここに記載］。お問い合わせにファイル本文、パスワード、招待QR・URLを送る必要はありません。

Ponlet Android版は一般利用者向けで、子ども向けを意図したアプリではありません。具体的なPlay年齢区分は実態に合わせた提案のみで、Consoleでは選択していません。「全ユーザーから識別可能情報を収集しない」「COPPA等に完全準拠」の保証はしません。

## English privacy replacement draft

### The app and transferred content

Ponlet transfers files and text to a peer chosen by the user. Normal use does not require registration or login. Ponlet does not provide a developer-operated file storage server that retains transferred files or message contents. Peer communications are encrypted; when a direct connection is unavailable, encrypted packets may pass through a DERP relay.

Firebase analytics and crash diagnostics, and ML Kit diagnostics used for QR scanning, are separate from transferred content and may be sent to Google. Ponlet does not pass file names, file contents, message bodies, session keys, or invitation URLs as parameters to its custom analytics events.

### Camera, files, and local storage on Android

The camera is used to read an invitation QR code when you select “Scan with camera.” Camera permission is requested at that time. ML Kit processes camera images and scanning results on the device; it does not send those images or results to Google servers. ML Kit may send device and app information, installation-related identifiers, performance metrics, and API usage diagnostics to Google.

For file sending, Ponlet reads files you choose through Android’s document picker. Received files are stored in Ponlet’s internal app storage. When you choose to open a received file in another app, that app receives permission to read the selected file. Clipboard and text sharing operations are performed in response to your actions.

This Android revision excludes received `files/received` from OS cloud backup on API31 and higher. It preserves the existing scope of device-to-device migration. Backup and restoration of settings, and D2D migration, depend on device settings, OS, and manufacturer behavior. Turning telemetry off does not disable all OS backup. Existing version 1.0.18 did not specify this cloud exclusion; this change does not delete previously stored backup copies. [Compiled candidate rules verified; verify restore and deletion before publishing.]

### Usage analytics and crash reporting

Telemetry is enabled by default for quality and stability improvements. “Allow telemetry” in Settings controls Firebase Analytics and Crashlytics collection. Your choice is stored in Android app preferences.

Ponlet’s custom events cover app startup, session creation and peer connection, transfer start/completion/cancellation, text sending/receiving, and categorized errors. Their parameters include platform, OS and app version, language, transport path, transfer direction, file count, text length buckets, and cancellation/error categories.

Firebase Analytics also handles app-instance identifiers, app lifecycle events, and coarse location derived from IP addresses. Crashlytics handles crash stack traces, device and app state, and installation-related identifiers. Identifiers and session information handled by dependent SDKs also need to be considered. These identifiers can exist without a named account.

**Approved candidate draft:** This Android revision disables Advertising ID collection and ad personalization and removes the three advertising identifier permissions. The app does not display ads. This does not remove app-instance identifiers, IP-derived coarse location, or Crashlytics and ML Kit diagnostics. Existing version 1.0.18 included advertising identifier permissions. [Compiled candidate flags/permissions verified; verify network behavior before publishing.]

On Android, turning telemetry off changes Firebase collection settings. Crashlytics applies OFF on the next app launch and keeps crash information locally while disabled. Turning it on again sends previously unsent reports. OFF does not delete past Google data or discard local reports. Behavior of queues created before OFF or data already in transit is [to be added after testing]. ML Kit diagnostics associated with QR scanning are separate from this switch. Peer transfers and connection-related networking can still occur when you use the app with telemetry off.

### Recipients, retention, and deletion

Analytics and diagnostics are sent to Google LLC using TLS/HTTPS. See the [Google Privacy Policy](https://policies.google.com/privacy). Some service settings and general retention/deletion specifications have been checked in the internal [SDK memo](SDK_RETENTION_AND_DELETION.md) and [project read-only record](PROJECT_SETTINGS_READONLY.md). Match these settings to the distributed Android configuration and verify individual deletion procedures and remaining retention periods [before adding them to public text]. The absence of a file-content storage server does not mean that analytics and diagnostic services retain no data.

Clearing app data or uninstalling removes current local app data. It does not guarantee deletion of OS backups or copies on other devices, apps, or external storage; a backup may later restore data. Check backup retention and deletion separately through the applicable device or service settings. For questions about access to or deletion of analytics and diagnostic data, contact `app-support@mat2uken.app`. [Describe the verified deletion procedure, required information, and limitations.] Do not send private file contents, passwords, or invitation QR codes/URLs in a support request.

Ponlet Android is intended for general users and is not designed as a child-directed app. The specific Play target age groups remain a proposal to be matched to the intended audience, with no Console selection made. Do not publish an unconditional “no identifiers from any users” or legal compliance guarantee.

## 日本語support追加候補

### Androidでファイルを送る・受け取る

「転送」の「ファイルを選択」から、Androidの文書選択画面で送るファイルを選びます。写真・動画・PDFなども、選択画面で利用できるファイルを選んで送れます。取消した場合は送信を始めません。

受信ファイルはPonletのアプリ内部へ保存されます。受信一覧の「開く」で、対応する別のアプリから開けます。保存や書き出しの方法は、開いたアプリにより異なります。対応アプリがない場合は共有先を選ぶ画面が表示されます。標準の「ダウンロード」へ自動保存されるものではないため、大切なファイルは対応アプリから別の場所へ保存し、内容を確認してください。

カメラは招待QRの読取に使います。カメラ権限を許可しない場合は、招待URLを貼り付けて接続できます。テレメトリは設定からOFFにできますが、QR読取SDKの診断送信は別に扱われます。詳しくはプライバシーポリシーをご確認ください。

Androidでは、他アプリの共有画面からPonletへ直接取り込む操作は現行版では利用できません。Ponlet内のファイル選択を使ってください。受信ファイルの操作、文書選択画面、保存先アプリの挙動は提出releaseで再確認後に公開します。

## English support addition draft

### Sending and receiving files on Android

Choose “Choose file” in Transfer and select files through Android’s document picker. Photos, videos, PDFs, and other files available through the picker can be selected. Canceling the picker does not start a transfer.

Received files are stored in Ponlet’s internal app storage. Choose “Open” in the received list to open a file in a compatible app. Saving or exporting from that app depends on the app you select. If no compatible app can open the file, a share chooser is shown. Received files are not automatically placed in Android’s public Downloads folder. For important files, save a copy through a compatible app and verify it.

Camera access is used to scan invitation QR codes. If you decline camera permission, paste the invitation URL to connect. You can turn telemetry off in Settings, but QR scanning SDK diagnostics are handled separately. See the Privacy Policy for details.

The current Android version does not import content directly from another app’s share sheet. Use the file picker inside Ponlet. Verify these instructions against the final release build before publishing them.

## 公開前に解決する項目

1. 承認済み広告ID無効化のcompiled flags／permissionsは検査済み。署名する提出AABで再検査し、実通信を検証する。
2. 一部GA実期間・Signals・共有設定はproject読み取りで確認済み。配布Androidとの接続先照合、個別削除、ML Kit保持と削除、Crash Insights等を確認する。OSバックアップ、端末移行と復元の範囲も、[Android公式資料](https://developer.android.com/identity/data/autobackup)と実機で確認する。受信ファイルcloud除外は承認済み。D2D既存範囲維持と設定復元を検証し、OS backup全体無効化へ拡張しない。
3. OFF後／再ON後のAnalytics・Crashlyticsと、OFF中QRの通信確認。
4. 本体無料・一般向けは承認済み。配布地域と具体的なPlay年齢帯の提案、必要な同意／表示は確認が必要。Consoleは選択しない。既定ON維持は承認済みで、opt-inへ変更しない。
5. 日英の意味の一致、Android保存操作の実機確認、未確定欄の解消。
6. 内容レビュー後に別途公開承認を得る。公開後は両言語URL、app内リンク、Console登録URLを再取得して確認する。

## ローカルHTMLへの反映記録

`dist/privacy_ja.html`、`privacy_en.html`、`support_ja.html`、`support_en.html` をローカル改訂。既存レイアウト、言語切替、サポート宛先、Apple固有の利用手順を維持した。解析・診断の全不保持、OFFで全通信停止、全コピー削除、位置／識別子の全不収集、未検証の法令／Play準拠保証を訂正した。広告ID・cloud規則は未署名改訂候補2030000102の検査を根拠に「この改訂」として記述し、既存内部テスト版1.0.18／2026093037を区別した。公開・Console更新はしていない。

親担当の検査報告：`work/android-policy-artifacts-verification.json`。未署名AAB SHA-256 `28f3bd088968fd33c5f0bf6608c363b9907d06924364908b98324154fa2661d8`、未署名APK SHA-256 `ae49dcfe40bfa62bc7ee6f789dbd12ba8fdba92bec4abadd6626c7b4cc643961`。APKでも同じflags／権限／backup規則の検査に合格。署名・実通信・SDK保存期間／削除・OS復元・Play配布はこの検査で証明されない。

正式公開準備は引き続き **`publication_ready=false`**。未確定の保存期間や削除手順は内部草案だけに保留し、公開用HTMLへ仮の値や未回答欄は挿入していない。

ローカル文書確認：4HTMLの構造（タグ、section、id）、内部参照、言語切替、stylesheet／scriptとリンク先を既存HEADと照合し維持を確認。未確定placeholderなし。内部Markdownのリンク・コード欄と `git diff --check` を確認した。表示ブラウザでの実画面確認・公開URLの再取得は未実施。

OFFの公式仕様を2026-10-03 UTCのSDK調査に基づき、日英ローカルprivacy／supportにも短く補足した。Crashlyticsは次回起動からOFF反映、OFF中の端末保持、再ON送信を明示する。保存期間の実設定数値は公開HTMLへ追加していない。
