# Data safety回答草案

内部レビュー用。Consoleに入力・保存していない。基準コードと既存AABは [README](README.md) を参照。Apple向け `fastlane/review_information/app_privacy_answers.md` の分類や過去の「概略位置を申告しない」判断をGoogle Playへ転用しない。

## 収集と送信の実装

| 経路 | 確認できた事実 | 根拠 |
| --- | --- | --- |
| Firebase Analytics | 既定ON。アプリ起動、接続、転送、本文長区分、分類済みエラー等を送る。SDKの自動収集もある | `crates/tauri-plugin-ponlet-platform/android/build.gradle.kts:22–25`、`TelemetryBridge.kt:49–57,102–105`、`apps/tauri/src/telemetry.rs:38–46`、`crates/tailsend-core/src/service.rs:398–460` |
| Firebase Crashlytics / NDK | Java／nativeのクラッシュ報告。SDKはinstallation UUID、端末・アプリ状態等を扱う。推移的なInstallations／Sessionsも開示検討対象 | 同Gradleと [Firebase公式開示資料](https://firebase.google.com/docs/android/play-data-disclosure) |
| ML Kit barcode scanning | QR画像と読取結果は端末内で処理。SDKの機種・アプリ・識別子・性能・使用状況等の診断送信は別に存在する | `vendor/tauri-plugin-barcode-scanner/android/build.gradle.kts:35–42`、`BarcodeScannerPlugin.kt:231–305`、[ML Kit開示資料](https://developers.google.com/ml-kit/android-data-disclosure) |
| テキスト・ファイル転送 | ユーザー指定の相手への暗号化転送。独自Analytics引数に本文・ファイル名・パス・鍵・招待URLを渡さない | `crates/tailsend-telemetry/src/lib.rs:8–13,95–100`、`service.rs:398–460`、`apps/tauri/src/storage.rs:305–338` |
| ネットワーク | DERP map取得、暗号化パケットのリレー、Firebase／ML Kitへの通信。各運用者のアクセスログやConsole設定は未検証 | `apps/tauri/src/model.rs:3–4`、`tailcat/bridge/native/bridge.go:444–474,652–665` |
| Android OSバックアップ／端末移行 | 新候補AABにもバックアップ指定なし。受信内部ファイルと保存設定がOSのクラウドバックアップ／端末移行の対象になり得る。実行は端末設定・条件・OEM挙動に依存し、実際の転送・復元は未確認 | `apps/tauri/gen/android/app/src/main/AndroidManifest.xml` のapplication、`storage.rs:416–426`、`TelemetryBridge.kt:79–85`、[Android Auto Backup資料](https://developer.android.com/identity/data/autobackup) |

Androidの初期manifestはAnalytics／Crashlyticsを無効にするが、Ponletの初期化時に既定ONの保存値を反映する。これは初回opt-inではない。OFF操作はAnalytics／Crashlyticsに適用され、SharedPreferencesに保存される。ML Kitを同じスイッチで止める処理は確認されていない。

Androidは `allowBackup` 未指定時に既定でバックアップへ参加し、通常はfilesDirとSharedPreferencesを対象にする。新候補には `fullBackupContent`／`dataExtractionRules` の指定もない。OSバックアップ経路のData safety分類、OSによる処理への除外の適用可否、受信ファイル・保存設定の範囲は未評価である。E2EE転送の例外だけでバックアップまで申告不要とは判定しない。SDKテレメトリOFFもOSバックアップ停止を意味しない。バックアップ無効化・対象除外は製品判断であり、今回決定していない。

現行の独自イベントは `app_start`, `session_created`, `peer_connected`, `transfer_started`, `transfer_completed`, `transfer_cancelled`, `text_message_sent`, `text_message_received`, `error`。独自パラメータはplatform、OS version、app version、language、transport、direction、file_count、length_bucket、reason、category。旧ポリシーの `app_end`, `transfer_failed`、転送時間・合計バイト数は、このコードの送信箇所では確認できない。SDK自動イベントをこの一覧だけで網羅したと扱わない。

## 設問ごとの候補

| 設問／データ種別 | 現行AABについての回答候補 | 提出前の確認 |
| --- | --- | --- |
| データを収集／共有するか | **はい（少なくとも収集あり）** | Firebase／ML Kitを含める。ログインがないことは「収集なし」の根拠にならない |
| アプリの操作・利用状況 | 収集あり、Analytics目的。SDK診断の用途はAnalyticsとアプリ機能を検討 | 独自イベント＋自動イベント、ML Kit使用状況。Consoleの実際の分類名に合わせる |
| クラッシュログ | 収集あり、Analytics／品質改善 | Java／nativeレポート、自動生成項目、OFF後の未送信レポート挙動 |
| 診断／その他のアプリ性能 | 収集あり、Analytics／品質改善 | Crashlytics Sessions、ML Kit latency・機種・エラー等 |
| 端末またはその他のID | 収集あり | app-instance ID、Crashlytics UUID、Firebase installation ID、ML Kit識別子。広告IDは下の現行AAB欄を参照 |
| おおよその現在地 | AnalyticsのIP由来概略位置を含めて収集ありを検討 | GPS権限がなくても自動収集があり得る。GA property・配布地域の設定とSDKの挙動を確認 |
| 氏名・メール・電話・アカウント情報 | アプリ内の通常利用で収集する実装は見つからない | サポートメールで本人が送る情報と、アプリの自動送信を分ける |
| 写真／動画／ファイル／メッセージ | 開発者が読めないE2EE転送に対する開示の例外を検討。OSバックアップ経路は未評価 | [Playの定義](https://support.google.com/googleplay/android-developer/answer/10787469)でE2EE、ユーザー開始の共有、OSバックアップ、第三者サービス提供者の扱いを確認。転送本文をAnalyticsへ送らない事実だけで全設問を決めない |
| 保存期間／一時的処理 | SDKの解析・診断を「一時的処理のみ」とは申告しない | 各サービスの保存期間を確認。接続メモリ、受信内部保存、クラウド診断データを区別する |
| 収集が任意か必須か | Analytics／CrashlyticsはOFF可能。全SDK一括で「任意」とは断定しない | ML Kit診断はFirebaseスイッチと別。各データ種別・機能ごとにConsoleの任意／必須の定義と照合する |
| データの共有 | Googleへの送信あり。ただしConsole上の「共有」は提供者の役割と設定で判断 | サービス提供者の除外を適用できるか、Google Signals／Adsリンク／data sharing設定／その他第三者を確認。自動的に「共有なし」としない |
| 転送中の暗号化 | はいを候補とする | SDKはTLS／HTTPS、転送はE2EE。全通信経路と新候補の通信観測で確認 |
| 削除を要求できるか | **要確認、未回答** | サーバー個人データなしという旧文言を根拠に「不要」としない。診断・識別子の保存、OSバックアップの別コピーと復元、実行可能な削除手順を確認 |

Google資料は最新SDKの一般説明であり、特定AABの実通信を証明しない。[Analytics開示資料](https://support.google.com/analytics/answer/11582702)はapp-instance ID、Advertising ID、IP由来概略位置、lifecycle events等を列挙する。IAP自動イベントは該当購入がない限り、SDKの機能だけを理由に購入履歴収集ありとしない。

## 広告IDの現状・選択肢

既存内部テスト版 `1.0.18 (2026093037)` について、Consoleは次の11配布権限を表示する。元のCI AAB実体は10権限で、`com.android.vending.CHECK_LICENSE` は含まれない。表示と元AABを分けて記録し、新候補の最終manifestで再検査する。

```text
android.permission.ACCESS_ADSERVICES_AD_ID
android.permission.ACCESS_ADSERVICES_ATTRIBUTION
android.permission.ACCESS_NETWORK_STATE
android.permission.CAMERA
android.permission.INTERNET
android.permission.VIBRATE
android.permission.WAKE_LOCK
com.android.vending.CHECK_LICENSE
com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE
com.google.android.gms.permission.AD_ID
jp.yasagure.ponlet.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION
```

広告表示SDK・広告UIは確認できないが、現行AABには広告識別関連権限があり、基準コードには広告ID無効設定がない。Consoleの広告表示申告とAdvertising ID申告は分ける。広告を表示しないことを理由に、現行AABで広告IDを使わないと申告しない。

| 選択肢 | 効果 | 副作用／残る確認 |
| --- | --- | --- |
| 現行設定を維持 | 広告ID関連能力を保つ | 使用実態・目的・Google側設定を確認しData safety／Advertising ID／policyに反映。広告を使わない製品説明との整合をレビューする |
| 広告IDと広告用途だけ明示無効化 | `google_analytics_adid_collection_enabled=false`、広告パーソナライズ無効設定、必要な広告関連権限のmerged manifest除去を検討。品質改善のAnalytics／Crashlyticsを維持できる | 広告アトリビューション・広告連携等に影響。app-instance ID、IP由来概略位置、Crashlytics／ML KitのIDや診断は消えない。SDK要求と通常の解析・QRが正常なことを新AABで確認 |
| Analyticsを廃止 | Analytics由来の収集経路を減らせる | 起動・利用集計が失われる。Crashlytics／ML Kitは別評価。**今回未決定・未実施** |
| 初回opt-inへ変更 | 明示同意後にAnalytics／Crashlyticsを開始する設計候補 | UI・初期化順・既存保存値の移行・非同意時の挙動が変わる。ML Kitまで止められるとは限らない。**今回未決定・未実施** |

広告ID無効化の公式案内：[Analytics Android設定](https://firebase.google.com/docs/analytics/android/configure-data-collection)。metadataだけと権限除去だけの効果を混同せず、最終manifestと通信を検査する。新候補から広告IDを外しても、既存公開／テスト版での収集とConsole全体の回答範囲は提出時に確認する。

## 提出前に確定する記録

- 新候補のsource SHA、versionCode、AAB SHA-256、merged permissions、resolved SDK一覧。
- Firebase／GAの保存期間、Google Signals、Adsリンク、data sharing、export設定。秘密の値はこの文書へ記載しない。
- ON／OFF／再起動／QR／クラッシュ／再ONごとの通信結果とSDK診断の内容。ファイル名・本文・招待情報を送信データに含めない確認。
- OSバックアップ有効／無効、クラウド／端末移行、データ削除／アンインストール後の復元について、内部受信ファイル・設定と削除範囲を確認。機種・OEM・OS設定ごとの差を記録。
- [privacy草案](PRIVACY_SUPPORT_DRAFTS.md)の未確定欄を埋めた内容と、日英公開ページの最終取得記録。
- Console保存後の表示と、新AABとの一致。現在の未完フォームを完了済みとして記録しない。
