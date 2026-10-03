# 日英privacy／support修正草案

内部レビュー用。`dist/` は変更していない。以下の文面には未確定欄があり、**そのまま公開しない**。テレメトリ既定ONを維持する前提。広告IDの扱いは提出候補AABに合わせて一方の文案を選び、両方を公開文へ残さない。

公開ページの読み取り確認は2026-10-03 UTC。次の4ページはHTTP 200。公開メールはCloudflareによる難読化表示だが、リポジトリの宛先は `app-support@mat2uken.app`。

- [日本語privacy](https://ponlet.mat2uken.app/privacy_ja.html)
- [英語privacy](https://ponlet.mat2uken.app/privacy_en.html)
- [日本語support](https://ponlet.mat2uken.app/support_ja.html)
- [英語support](https://ponlet.mat2uken.app/support_en.html)

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

AndroidのOSバックアップや端末移行が有効な場合、受信ファイルや保存設定がクラウドのバックアップまたは移行先端末へコピーされ、再インストール時などに復元される可能性があります。現行のバックアップ設定はOS既定に従うため、実際の対象・実行は端末の設定、OS、メーカーの動作に依存します。これはPonletが運営する転送用保存サーバーとは別の経路で、テレメトリ設定をOFFにしても止まるとは限りません。［提出releaseのバックアップ・復元・削除範囲を確認後に公開］。

### 利用状況とクラッシュ報告

Ponletのテレメトリは品質改善と安定性向上のために既定で有効です。設定の「テレメトリを許可」からFirebase AnalyticsとCrashlyticsの収集をOFFにできます。この選択はAndroidのアプリ設定へ保存します。

Ponletが独自に送るイベントは、アプリの起動、接続作成・接続完了、転送の開始・完了・取消、テキストの送受信、分類済みのエラーです。パラメータはプラットフォーム、OSとアプリのバージョン、言語、通信経路、送受信の方向、ファイル数、テキスト長の区分、取消理由・エラーの分類です。

これに加えてFirebase Analyticsは、アプリインスタンスの識別子、アプリの利用イベント、IPアドレスから導かれる概略位置などを扱います。Crashlyticsはクラッシュ時のスタックトレース、端末・アプリの状態、インストールに関する識別子等を扱います。SDKの推移的な依存が扱う識別子やセッション情報も含め、使用SDKと設定に応じた情報がGoogleへ送られます。氏名やアカウントを設定しなくても、これらの識別子は存在します。

広告IDの記載は次のいずれかを選ぶ。

- **既存1.0.18の構成を維持する場合の草案**：Android版には広告識別関連権限が含まれ、Firebase Analyticsは利用可能なAndroid Advertising IDを取得する場合があります。広告表示機能はありません。広告への利用目的やGoogle側の連携設定は［確認・記載が必要］です。
- **広告ID取得を無効化した新候補向け草案**：Android版ではFirebase AnalyticsのAdvertising ID取得と広告パーソナライズを無効にし、広告識別関連権限を取り除いています。広告表示機能はありません。アプリインスタンス識別子、IP由来の概略位置、クラッシュ・ML Kit診断の取得は、この変更によって無くなるものではありません。［提出AABと実通信で検証後に採用］。

テレメトリをOFFにすると、PonletがFirebase AnalyticsとCrashlyticsへ設定する収集が無効になります。OFF時の未送信情報の保持・後日の再ONでの送信は［試験結果に合わせて記載］です。ML KitのQR読取に伴うSDK診断はこのスイッチとは別です。このスイッチをOFFにしても、ユーザーが開始する端末間の転送や、接続のための通信は行われます。

### 送信先・保存期間・削除

解析・診断データの送信先はGoogle LLCです。通信にはTLS／HTTPSを利用します。Googleでの取扱いについては [Googleプライバシーポリシー](https://policies.google.com/privacy?hl=ja) もご確認ください。Google側のサービス設定、保存期間、削除手順は［確認した内容を記載］します。転送ファイルの不保持と、解析・診断データの保存を同じものとして説明しません。

Androidのデータ削除・アンインストールは、現在の端末のアプリ内部ファイルや設定を削除する操作です。OSバックアップ、移行先端末、別アプリや外部保存先のコピーまで同時に消す保証はありません。OSのバックアップから再インストール時などに復元される場合もあるため、バックアップ側の保存・削除方法は利用端末とバックアップサービスの設定から別途確認してください。解析・診断データの開示・削除に関するお問い合わせは `app-support@mat2uken.app` へご連絡ください。［実行可能な削除方法、必要な情報、対応範囲を確認してここに記載］。お問い合わせにファイル本文、パスワード、招待QR・URLを送る必要はありません。

子ども対象の記載は［Google Playの対象年齢と実際の対象者、SDK条件を確定後に作成］します。「全ユーザーから識別可能情報を収集しない」「COPPA等に完全準拠」の保証文は、識別子と診断の実態を確認せず再掲載しません。

## English privacy replacement draft

### The app and transferred content

Ponlet transfers files and text to a peer chosen by the user. Normal use does not require registration or login. Ponlet does not provide a developer-operated file storage server that retains transferred files or message contents. Peer communications are encrypted; when a direct connection is unavailable, encrypted packets may pass through a DERP relay.

Firebase analytics and crash diagnostics, and ML Kit diagnostics used for QR scanning, are separate from transferred content and may be sent to Google. Ponlet does not pass file names, file contents, message bodies, session keys, or invitation URLs as parameters to its custom analytics events.

### Camera, files, and local storage on Android

The camera is used to read an invitation QR code when you select “Scan with camera.” Camera permission is requested at that time. ML Kit processes camera images and scanning results on the device; it does not send those images or results to Google servers. ML Kit may send device and app information, installation-related identifiers, performance metrics, and API usage diagnostics to Google.

For file sending, Ponlet reads files you choose through Android’s document picker. Received files are stored in Ponlet’s internal app storage. When you choose to open a received file in another app, that app receives permission to read the selected file. Clipboard and text sharing operations are performed in response to your actions.

If OS backup or device migration is enabled, received files and saved preferences may be copied to a cloud backup or another device and restored on reinstallation. The current configuration follows OS defaults; actual backup depends on device settings, OS, and manufacturer behavior. This is separate from a Ponlet-operated transfer storage server. Turning telemetry off does not necessarily disable OS backup. [Verify backup, restore, and deletion on the final release before publishing.]

### Usage analytics and crash reporting

Telemetry is enabled by default for quality and stability improvements. “Allow telemetry” in Settings controls Firebase Analytics and Crashlytics collection. Your choice is stored in Android app preferences.

Ponlet’s custom events cover app startup, session creation and peer connection, transfer start/completion/cancellation, text sending/receiving, and categorized errors. Their parameters include platform, OS and app version, language, transport path, transfer direction, file count, text length buckets, and cancellation/error categories.

Firebase Analytics also handles app-instance identifiers, app lifecycle events, and coarse location derived from IP addresses. Crashlytics handles crash stack traces, device and app state, and installation-related identifiers. Identifiers and session information handled by dependent SDKs also need to be considered. These identifiers can exist without a named account.

Choose one advertising identifier paragraph:

- **If retaining the existing 1.0.18 configuration:** The Android app includes advertising identifier permissions. Firebase Analytics may collect an available Android Advertising ID. The app does not display ads. Advertising purposes and Google-side integrations are [to be verified and described].
- **For a verified new candidate with advertising identifiers disabled:** Advertising ID collection and ad personalization are disabled, and advertising identifier permissions have been removed from the Android app. The app does not display ads. This does not remove app-instance identifiers, IP-derived coarse location, or Crashlytics and ML Kit diagnostics. [Use only after final AAB and network verification.]

Turning telemetry off disables the collection settings that Ponlet applies to Firebase Analytics and Crashlytics. Retention of pending reports and transmission after telemetry is re-enabled are [to be described after testing]. ML Kit diagnostics associated with QR scanning are separate from this switch. Peer transfers and connection-related networking can still occur when you use the app with telemetry off.

### Recipients, retention, and deletion

Analytics and diagnostics are sent to Google LLC using TLS/HTTPS. See the [Google Privacy Policy](https://policies.google.com/privacy). Service configuration, retention periods, and available deletion procedures are [to be verified and described]. The absence of a file-content storage server does not mean that analytics and diagnostic services retain no data.

Clearing app data or uninstalling removes current local app data. It does not guarantee deletion of OS backups or copies on other devices, apps, or external storage; a backup may later restore data. Check backup retention and deletion separately through the applicable device or service settings. For questions about access to or deletion of analytics and diagnostic data, contact `app-support@mat2uken.app`. [Describe the verified deletion procedure, required information, and limitations.] Do not send private file contents, passwords, or invitation QR codes/URLs in a support request.

The children’s privacy section remains [pending the target audience decision and SDK review]. Do not publish an unconditional “no identifiers from any users” or legal compliance guarantee without verifying the actual SDK behavior.

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

1. 広告ID案の選択と提出AABの検証。
2. Google側の保存期間、削除手順、共有・広告連携設定の実確認。OSバックアップ、端末移行と復元の範囲も、[Android公式資料](https://developer.android.com/identity/data/autobackup)と実機で確認する。バックアップを無効化する判断はこの草案で行わない。
3. OFF後／再ON後のAnalytics・Crashlyticsと、OFF中QRの通信確認。
4. 課金・配布地域・対象年齢の決定、必要な同意／表示のレビュー。既定ONからopt-inへの変更はこの草案だけで決めない。
5. 日英の意味の一致、Android保存操作の実機確認、未確定欄の解消。
6. 内容レビュー後に別途公開承認を得る。公開後は両言語URL、app内リンク、Console登録URLを再取得して確認する。
