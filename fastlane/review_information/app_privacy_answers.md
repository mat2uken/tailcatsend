# App プライバシー 設問への回答案（Ponlet 1.0.14）

2026-09-24 の 1.0.14 提出時の回答案・調査記録です。現在の 1.0.17 の回答ではありません。Remote Config と旧 HTML の行番号は当時のものです。§8⑩の当時の公開ページとの差分は提出チェックリストに記載した更新より前の確認結果です。

対象: App Store Connect の「App プライバシー」設問
参考: https://developer.apple.com/support/app-privacy-on-the-app-store/ （2026-09-23 確認）
位置付け: fastlane deliver が直接読み込まない補助資料。App Store Connect への回答案であり、保存済みの回答を確認した記録ではない。
IPA の確認対象: `target/ios-appstore/Ponlet-current.ipa`（2026-09-24 に確認）。

## 0. 全体の設問への回答

| 設問 | 回答 |
| --- | --- |
| このアプリはユーザーデータを収集しますか | はい、収集します（テレメトリが有効な場合に Firebase へ送信されるデータがあるため。既定で有効・オプトアウト式） |
| このアプリはトラッキングを行いますか | いいえ、トラッキングは行いません |
| Privacy Policy URL（必須） | 日本語: https://ponlet.mat2uken.app/privacy_ja.html / 英語: https://ponlet.mat2uken.app/privacy_en.html |
| User Privacy Choices URL（任意） | 未設定で可。テレメトリの ON/OFF はアプリ内設定で行えるため、プライバシーポリシー側にその旨を記載するのが望ましい |

注: テレメトリはオプトアウト式で既定は有効（実装と公開中のプライバシーポリシーに一致。2026-09-23 判断: 実装に合わせて記載を統一）。設定画面からいつでも無効化できる。継続的に収集するデータは開示が必要なため「収集する」として開示する。

## 1. データ種別ごとの回答一覧

凡例: 収集＝収集する／収集しない、紐付け＝ユーザーの識別情報への紐付け（Linked to You / Not Linked to You）、トラッキング＝トラッキングへの使用、オプトアウト＝ユーザーが拒否できるか。

| App Store Connect のデータ種別 | 収集 | 紐付け | トラッキング | 利用目的 | オプトアウト | 根拠・備考 |
| --- | --- | --- | --- | --- | --- | --- |
| Contact Info（名前 / メール / 電話 / 住所 / その他連絡先） | 収集しない | — | — | — | — | 問い合わせは GitHub Issues（アプリ外）で受ける |
| Health & Fitness（ヘルス / フィットネス） | 収集しない | — | — | — | — | 該当機能なし |
| Financial Info（支払い / 信用 / その他財務） | 収集しない | — | — | — | — | アプリ内課金はなく、ストア購入の決済情報は開発者が収集しない |
| Location: Precise Location（正確な位置情報） | 収集しない | — | — | — | — | 位置情報 API を使用しない |
| Location: Coarse Location（おおよその位置情報） | 収集しない（決定済み） | — | — | — | — | Firebase への通信で IP アドレスが Google のサーバーに到達するが、位置情報としては利用・開示しない方針で確定（2026-09-23）。PrivacyInfo.xcprivacy にも記載しない |
| Sensitive Info（センシティブな情報） | 収集しない | — | — | — | — | 該当機能なし |
| Contacts（連絡先リスト） | 収集しない | — | — | — | — | アドレス帳へのアクセスなし |
| User Content: Emails or Text Messages | 収集しない（決定済み） | — | — | — | — | 1 対 1 の端末間テキスト転送。ユーザー同士のやり取りであり、開発者・第三者が収集・保持しない（E2E 暗号化で開発者は閲覧不可）。2026-09-23 判断 |
| User Content: Photos or Videos | 収集しない（決定済み） | — | — | — | — | 送受信ファイルに写真・動画が含まれうるが、端末間の直接転送で開発者・第三者は中身にアクセス・保持しない。2026-09-23 判断 |
| User Content: Other User Content | 収集しない（決定済み） | — | — | — | — | 汎用ファイル・自由記述テキストも同上。2026-09-23 判断 |
| User Content: Audio Data / Gameplay Content / Customer Support | 収集しない | — | — | — | — | 音声録音・ゲーム・サポート機能なし |
| Browsing History | 収集しない | — | — | — | — | 外部リンクは Safari で開き、アプリは履歴を取得しない |
| Search History | 収集しない | — | — | — | — | 検索機能なし |
| Identifiers: User ID | 収集しない | — | — | — | — | アカウントが存在しない |
| Identifiers: Device ID | 収集する（テレメトリ有効時・既定 ON） | Not Linked（決定済み） | なし | Analytics / App Functionality | 可（テレメトリ OFF） | インストール単位の疑似 ID。IPA の申告も Not Linked（§3・§8 ⑥） |
| Purchases: Purchase History | 収集しない | — | — | — | — | アプリ内購入機能なし。ストア購入履歴をアプリから収集しない |
| Usage Data: Product Interaction | 収集する（テレメトリ有効時・既定 ON） | Not Linked（IPA の申告に整合） | なし | Analytics | 可（テレメトリ OFF） | アプリの起動 / 終了など。App Store Connect の現行回答は未確認（§8 ⑧） |
| Usage Data: Advertising Data | 収集しない | — | — | — | — | 広告なし |
| Usage Data: Other Usage Data | 収集する（テレメトリ有効時・既定 ON） | Not Linked（IPA の申告に整合） | なし | Analytics | 可（テレメトリ OFF） | 転送量・所要時間・経路等の集計値。保存済み回答は未確認（§8 ⑧） |
| Diagnostics: Crash Data | 収集する（テレメトリ有効時・既定 ON） | Not Linked（IPA の申告に整合） | なし | App Functionality | 可（テレメトリ OFF） | Crashlytics のクラッシュログ。実データは未検証（§8 ⑤・⑧） |
| Diagnostics: Performance Data | 収集しない（現行の構成） | — | — | — | — | Performance Monitoring SDK は不使用。IPA に申告なし（§8 ④） |
| Diagnostics: Other Diagnostic Data | 収集する（テレメトリ有効時・既定 ON） | Not Linked（IPA の申告に整合） | なし | App Functionality / Analytics | 可（テレメトリ OFF） | エラーの分類など。App Store Connect の現行回答は未確認（§8 ⑧） |
| Surroundings / Body / Other Data | 収集しない | — | — | — | — | 該当機能なし |

## 2. 利用目的（Data use）の選択

| 目的 | 使用 | 内容 |
| --- | --- | --- |
| Third-Party Advertising（第三者の広告） | いいえ | 広告 SDK も広告配信もない |
| Developer's Advertising or Marketing（開発者の広告・マーケティング） | いいえ | 広告・宣伝に利用しない |
| Analytics（分析） | はい | 利用状況の集計（テレメトリ有効時・既定 ON） |
| Product Personalization（パーソナライズ） | いいえ | 推奨・履歴連動機能はない |
| App Functionality（アプリ機能） | はい | クラッシュ修正（Crashlytics）、Remote Config による設定配信 |
| Other Purposes（その他） | いいえ | — |

## 3. 識別情報への紐付け（Linked to You）の回答案

- アカウント・名前・メールアドレス等の直接識別子は保持しない。
- Firebase Installation ID は端末 / インストール単位の疑似 ID で、実名等の実世界の識別子とは結び付けていない。
- Device ID は Not Linked to You と決定済み（§8 ②）。ほかの 4 種類も提出用 IPA のアプリ側 `PrivacyInfo.xcprivacy` では `NSPrivacyCollectedDataTypeLinked=false`。対象は Product Interaction、Other Usage Data、Crash Data、Other Diagnostic Data。回答案の表はこの申告と揃える。
- これは IPA に含まれる申告の確認であり、App Store Connect 上の現在の回答や Firebase SDK の実通信を確認した結果ではない（§8 ⑥・⑧）。

## 4. トラッキングと IDFA / ATT について

- 「トラッキング」（自社外の Third-Party Data との突合による広告・広告測定、またはデータブローカーへの提供）に該当する処理は一切行わない。
- IDFA（広告識別子）を取得しない。App Tracking Transparency（ATT）の許可ダイアログも表示しない。
- 広告 SDK を含まない。Firebase のデータを広告目的で第三者と共有しない。
- → 設問「トラッキングを行いますか」は「いいえ」で確定してよい。

## 5. 第三者（Firebase / Google）との共有

- テレメトリ有効時（既定 ON・オプトアウト式）、以下を Google（Firebase）へ送信する: 集計イベント、アプリ / OS / 言語の情報、端末の疑似 ID、クラッシュ情報、Remote Config の取得。
- 広告目的の提供はない。データブローカーへの提供はない。サービス提供（分析・クラッシュ解析）のための委託先という位置付け。
- Google 側での取扱いは Firebase のデータ処理条件および Google のプライバシーポリシーに従う。

## 6. IP アドレスについて

- Firebase への通信では IP アドレスが Google のサーバーに到達する。Apple ガイダンスでは「IP アドレスを収集する場合は用途に応じて Precise/Coarse Location、Device ID、Diagnostics を宣言する」とされる。Coarse Location は宣言しない方針で確定（2026-09-23）、Device ID は Not Linked で開示する。
- 自前のサーバー（招待 URL の配信元 https://ponlet.mat2uken.app/ 、GitHub）側でアクセスログ・解析を取る処理はコードに無いことを確認済み。ただし Cloudflare / GitHub のアカウント側設定はコード外のため残余 → §8 ⑦。

## 7. テレメトリで送信する項目（製品仕様・確認済み）

- アプリが送信するイベント: 起動 / 終了、接続経路、転送の回数・バイト数・所要時間・経路、テキストの長さの区分、エラーの分類、アプリ / OS / 言語の情報。Firebase SDK は端末・インストール単位の疑似 ID やクラッシュレポートも扱う（表および §8 ⑤・⑥）。
- アプリがイベントのパラメータとして渡さない: ファイル名、ファイルパス、転送内容、メッセージ本文、エラーメッセージ。裏付け: `crates/tailsend-telemetry/src/lib.rs` の送信禁止項目と `crates/tailsend-core/src/service.rs` がエラーの `message` を捨てて `category` のみ送信する処理。Crashlytics 側も custom key / log / 非例外 error の渡しが無い（§8 ⑤）。SDK が自動生成するクラッシュレポートの全項目は実機未検証。
- オプトアウト式で既定は有効。ユーザーは設定画面のテレメトリ許可トグルでいつでも無効化できる（`PonletPlatformPlugin.swift` 238 行の `?? true` が既定値）。表の「オプトアウト」は「可（テレメトリ OFF）」としている。（2026-09-23 判断: 実装・公開ポリシーに合わせて「既定で有効・オプトアウト式」に統一）

## 8. 確認済み事項と残る確認事項

1. ~~Coarse Location の宣言要否~~（決定済み: 収集しない・宣言しない。2026-09-23）
2. ~~Device ID（Firebase Installation ID / IDFV）の「Linked to You」区分~~（決定済み: Not Linked。2026-09-23）
3. ~~User Content（Emails or Text Messages / Photos or Videos / Other User Content）の開示範囲~~（決定済み: ユーザー同士のやり取りであり収集ではないとして「収集しない」で開示しない。2026-09-23）
4. ~~Firebase Performance Monitoring SDK の有無~~（現行構成では不使用）。`crates/tauri-plugin-ponlet-platform/ios/Package.swift` の依存は FirebaseAnalytics / FirebaseCrashlytics / FirebaseRemoteConfig の 3 つのみ。提出用 IPA のアプリ側 `PrivacyInfo.xcprivacy` に Performance Data の申告はない。回答案は「収集しない」。実通信は未検証。
5. **Crashlytics のクラッシュレポートに含まれる実データの最終確認**（アプリから SDK への明示的な入力はコードで確認済み。自動生成される項目は実機未検証）。
   - 事実（Crashlytics への渡し物）: Crashlytics API の呼び出しは収集 ON/OFF の制御のみ。`setCustomKeys` / `log` / `record(error:)` を呼ぶ箇所は iOS のアプリコード（`crates/tauri-plugin-ponlet-platform/ios/Sources/`、`apps/tauri/gen/apple/`）に存在せず、`crates/tauri-plugin-ponlet-platform/ios/Sources/PonletPlatformPlugin.swift` の Crashlytics 呼び出しは 244 行・260 行の `setCrashlyticsCollectionEnabled` だけ。非例外（non-fatal）エラーの送信経路は無い。ShareExtension（`apps/tauri/gen/apple/ShareExtension/ShareViewController.swift` / `ShareSession.swift`）は Firebase を参照しない。
   - 事実（エラー分類）: カテゴリ名だけ。`crates/tailsend-core/src/service.rs` 517-520 行は `AppEvent::ErrorOccurred { .. }` の `message` を捨てて `("category", "transport")` のみ送る。`crates/tailsend-telemetry/src/lib.rs` 85-89 行・206-210 行も category のみで、コメントにエラーメッセージ本文の禁止（パスやピアのアドレスを含みうるため）を明記。カテゴリは "transport" / "storage" / "camera" / "daemon" / "other" の列挙値。
   - 事実（Rust/Go のエラー伝達経路）: Go（tailcat）側の失敗はステータスコードで受け、`crates/tailsend-native-transport/src/lib.rs` 30 行 `transport_error(code)` が `TransportError` に変換する（`crates/tailsend-transport-api/src/lib.rs` 32-44 行。`Unreachable(String)` 等メッセージを含む型もある）。メッセージは UI 表示とピアへの制御フレーム（`apps/tauri/src/runtime.rs` 735 行・773-780 行の `write_control_error`）にだけ届き、テレメトリ経路には入らない。`apps/tauri/src/telemetry.rs` 38-46 行が送るのも `app_start` と platform / app_version / language のユーザープロパティのみ。
   - 結論: アプリが Analytics に渡すイベントは計数・区分値・列挙値のみで、ファイル名・パス・転送内容・エラーメッセージ本文を引数に渡していない（`crates/tailsend-telemetry/src/lib.rs`、`web-ui/src/telemetry.ts`）。SDK が生成するクラッシュレポートの内容は次の残余を参照。
   - 残余: クラッシュレポートには OS / UIKit が生成する例外 reason・終了理由とスタックトレース（開発者側のソースファイル名を含む）が自動的に入りうる。これはコード読み取りでは排除できず、実機でのクラッシュ送信テストは未実施（実機・シミュレータは別作業が使用中）。
6. **Firebase Analytics の自動収集項目（IDFV 等）の実通信**（SDK 設定と既定 ON・オプトアウト式の実装は確認済み、送信項目とタイミングの実通信は未検証。2026-09-23、コードベース確認）。
   - 事実（SDK 設定）: `apps/tauri/gen/apple/tailsend-tauri_iOS/GoogleService-Info.plist` 19-20 行の `IS_ANALYTICS_ENABLED=false` は SDK に読まれない古いキー（firebase-ios-sdk 12.19.1 の `docs/FirebaseOptionsPerProduct.md` 42-50 行が未使用キーとして列挙）。実際に効くのは `tailsend-tauri_iOS/Info.plist` 34-36 行の `FIREBASE_ANALYTICS_COLLECTION_ENABLED: false` と `FirebaseCrashlyticsCollectionEnabled: false`（`apps/tauri/gen/apple/project.yml` 49-50 行に生成元あり）。前者はメイン Info.plist の値が GoogleService-Info より優先して `isAnalyticsCollectionEnabled == NO` になる（`.build/checkouts/firebase-ios-sdk/FirebaseCore/Sources/FIROptions.m` 33-35 行・371-388 行・449-455 行）。後者は Crashlytics が認識するキーそのもので、`FIRCLSDataCollectionArbiter.m` 32-40 行・93-105 行が `NSBundle.mainBundle.infoDictionary`（`FIRCrashlytics.m` 255 行）から読み、無効を既定にする。依存は firebase-ios-sdk 12.19.1 固定で Analytics / Crashlytics / Remote Config の 3 プロダクトのみ（`crates/tauri-plugin-ponlet-platform/ios/Package.swift` 9 行・13-15 行、`Package.resolved` 27 行）。
   - 事実（タイミング）: `FirebaseApp.configure` は `telemetryInit` の中でのみ呼ばれる（`PonletPlatformPlugin.swift` 239-241 行）。直後の 243-244 行で `Analytics.setAnalyticsCollectionEnabled(enabled)` と `Crashlytics.crashlytics().setCrashlyticsCollectionEnabled(enabled)` を呼ぶ。つまり configure 時点の自動収集は上の 2 キーで既定無効となり、収集の開始はこの明示的な呼び出しで決まる。Remote Config の `fetchAndActivate` は `enabled` のときだけ（250 行）。トグル変更時は 255-263 行で同じ 2 API を呼ぶ。なお `setCrashlyticsCollectionEnabled` の結果は `com.crashlytics.data_collection`（`FIRCLSDataCollectionArbiter.m` 36 行）に残り Info.plist より優先する（93-105 行・112-127 行）が、本アプリは毎起動で `telemetryInit` から設定し直す。
   - 結論（決定済み: 2026-09-23 に実装・公開ポリシーの「既定で有効・オプトアウト式」に記載を統一）: 「ユーザーが opt-in するまで一切送信されない」は現状の実装では成立しない。`enabled` の既定値は true で（`PonletPlatformPlugin.swift` の `?? true`。`optOut` 引数で false にされる）、フロント側は明示的な opt-out 設定があるときだけ `optOut: true` を渡す。初回起動の `telemetryInit` で Analytics / Crashlytics が有効化され `app_start` の送信処理が呼ばれる。共通部分・Web 版も同じ設計（`crates/tailsend-telemetry/src/lib.rs` の「opt-out: default is enabled」、`web-ui/src/telemetry.ts`、`web-ui/src/backends/browser.ts`）。本回答案 §0・§7 と日英の審査メモは公開中のプライバシーポリシー（`dist/privacy_ja.html`、`dist/privacy_en.html`）に合わせて既定 ON・オプトアウト式で記載している。実通信の確認は⑥の残余。
   - Device ID の整合: configure 時点の自動収集は無効だが、初回起動時に収集が有効化されるため、表の Device ID は「収集する・Not Linked」の回答案とした。提出用 IPA のアプリ側 `PrivacyInfo.xcprivacy` も Not Linked。アプリが設定するユーザープロパティは platform / app_version / language のみ（`apps/tauri/src/telemetry.rs`）。Firebase Installation ID / アプリインスタンス ID / IDFV 由来の実際の送信項目はコードと IPA の申告だけでは確定できない → 残余。
   - 残余: 実機の通信で Firebase 送信の有無・送信項目（app instance ID / IDFV 由来など）と Firebase Installations の FID 取得がいつ走るかを確認できていない（実機・シミュレータは別作業が使用中）。
7. ~~自前サーバー（ponlet.mat2uken.app / GitHub）側のアクセスログの扱い~~（コードで確認できる範囲は確認済み、アカウント側の設定は残余。2026-09-23）。
   - 事実（配信とログ生成）: ponlet.mat2uken.app は Cloudflare Pages のプロジェクト `mktailcatsend` のカスタムドメインで、配信物は `dist/` の静的ファイルのみ（`.github/workflows/deploy_pages.yml` 185 行 `pages deploy dist --project-name=mktailcatsend`、`dist/_redirects` / `cloudflare/_redirects` の 301）。サーバー側処理は `functions/_middleware.js`（8 行）だけで、`mktailcatsend.pages.dev` を `ponlet.mat2uken.app` へ 301 で寄せるだけ。`console` 出力・ログ送信・保存の処理は `functions/`・`cloudflare/` のどこにも無い。
    - 事実（Web クライアントの送信処理）: 自前のサーバーへ解析データを送る経路は無い。`web-ui/src/telemetry.ts` の送信先は Firebase（`dist/assets/telemetry.js` が gstatic の firebase-js-sdk 12.3.0 を読み Google へ送る）で、無効ならスクリプト自体を読み込まない。独自の解析ビーコン等の埋め込みは確認されていない。CSP も外部接続先を Google の Firebase / Analytics 関連ドメインと tailcat 接続先に限定している。
   - 事実（招待 URL）: 招待情報は URL ハッシュ `#i=` に入る（`web-ui/src/main.ts` 321-326 行、`crates/tailsend-protocol/src/invitation.rs` 34 行）。フラグメントは HTTP リクエストに載らないため Pages のアクセスログに残らない。プライバシーポリシーの記載（`dist/privacy_ja.html` 641 行、`dist/privacy_en.html` 641 行）と一致。
   - 事実（ポリシーとの整合）: 「接続情報はアクセスログへ蓄積しない」（`dist/privacy_ja.html` 640 行）「IP アドレスに基づく追加情報を自前で収集しない」（701 行）は、上記のコードの状態と食い違っていない。
   - 結論: アプリ・Web クライアント・Cloudflare Pages 側のコードでアクセスログの取得や解析送信を行う処理は無い。
   - 残余: Cloudflare Pages のアカウント側設定（Cloudflare Analytics・リアルタイムログ・Logpush の有無と保持期間）と Cloudflare のネットワークログの取扱いはコードから確認できず、GitHub（リポジトリ・Issues）側のログも GitHub 社の運用でコード外。各社の方針依存として扱うか管理画面上で確認する必要がある。
8. **App Store Connect 上の「Linked to You」の現行回答の照合**。提出用 IPA のアプリ側 `PrivacyInfo.xcprivacy` は、§3 に示した 5 種類をすべて Not Linked と申告している。回答案をこれに揃えた。App Store Connect の保存済み回答は未確認。Firebase SDK の実際の自動収集項目も⑥のとおり未検証。
9. ~~要判断: テレメトリの opt-in / opt-out の記載と実装の不一致~~（決定済み: 実装・公開中のプライバシーポリシーの「オプトアウト制・既定 ON」に、本回答案・審査メモ・ストア説明文の記載を統一した。2026-09-23）
10. **公開中のポリシーとアプリの表示・機能の照合**（2026-09-24、公開 URL の日英両方を確認）。
    - どちらもテレメトリは既定 ON。OFF にする場所は「画面下部のフッター」と記すが、現行の `web-ui/src/components/settings-dialog.ts` は設定ダイアログ内にトグルを置く。
    - 公開ページは Firebase Remote Config に言及していない。現行の `dist/privacy_ja.html` / `dist/privacy_en.html` には記載があり、iOS の `PonletPlatformPlugin.swift` にも実装がある。
    - 公開ページの反映状況と案内の更新を確認する必要がある。
