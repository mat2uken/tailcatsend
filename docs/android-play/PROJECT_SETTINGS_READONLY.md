# Firebase／Analyticsの実設定読み取り

2026-10-03 18:30 UTC前後。既存Mac Chromeの認証済みセッションで読み取り。ログイン、Google設定変更、SDK構成ファイルdownload、鍵・service account・本番credentialの読取はしていない。別Firebase projectや別GA propertyは調べていない。

## 対象の照合

Git管理下の公開client設定 `apps/tauri/gen/apple/tailsend-tauri_iOS/GoogleService-Info.plist` から `PROJECT_ID=ponlet-599c4`、`BUNDLE_ID=jp.yasagure.ponlet` だけを読み取った。apikey等は出力していない。Webの `dist/assets/firebase-config.js` はPLACEHOLDERのままであり、Webから実projectを特定した結果ではない。

[Firebase全般](https://console.firebase.google.com/u/0/project/ponlet-599c4/settings/general/android:jp.yasagure.ponlet) は同じproject ID／名称ponletで、Android登録 `ponlet-android / jp.yasagure.ponlet` とiOS・Web登録を表示した。対象packageはローカル新AABと一致する。このread-only確認時点では署名候補の構成照合は未完だった。後続の新署名候補c7408ea0はCI／Macでcompiled Firebase project構成一致を確認済み（[最新検証](MENU_FIX_RESULTS.md)）。既存Play配布版の同一性やSDK実payloadの受領はこの静的結果から保証しない。

[Firebase Analytics統合](https://console.firebase.google.com/u/0/project/ponlet-599c4/settings/integrations/analytics) により、GA account `1119752`／property `553139030`（名称ponlet-599c4）、Android stream `15740481045` へリンクしていることを確認した。GA側の確認は、この表示済みリンクからだけ進めた。

## 確認した設定値

| 設定 | 読み取り結果 | 意味・制約 |
| --- | --- | --- |
| GAイベントデータ保持 | 2か月 | [保持設定](https://analytics.google.com/analytics/web/?authuser=0&hl=ja#/a1119752p553139030/admin/datapolicies/dataretention) の現在値。すべての集計reportを2か月で消す保証ではない |
| GAユーザーデータ保持 | 14か月 | 同じ画面の現在値。cookie／IDと関連するuser-levelデータの設定 |
| 新しいユーザー活動ごとのリセット | ON | 活動によりuser-level保持期限を延長し得るため、最初の収集から14か月という最大期間ではない |
| Google Signals | 未有効 | [収集設定](https://analytics.google.com/analytics/web/?authuser=0&hl=ja#/a1119752p553139030/admin/datapolicies/datacollection) に「Googleシグナルを有効にする」ボタンを表示。押していない |
| 地域・端末の詳細データ収集 | ON | 位置権限がないことを、IP等から処理される概略位置や端末情報の不収集と説明しない |
| プロパティ広告パーソナライズ | 307/307地域で許可 | 上記画面と地域選択の現在値。編集・適用していない。Android新候補の `google_analytics_default_allow_ad_personalization_signals=false` はSDK側の別設定で、プロパティ全体をOFFにした結果ではない |
| Google Adsリンク | なし | [GA一覧](https://analytics.google.com/analytics/web/?authuser=0&hl=ja#/a1119752p553139030/admin/integrations/google-ads) は「リンクはまだありません」、0/0。新規linkを作らない |
| BigQueryリンク | なし | [GA一覧](https://analytics.google.com/analytics/web/?authuser=0&hl=ja#/a1119752p553139030/admin/integrations/big-query) は「リンクはまだありません」。既存exportがあると仮定しないが、他の外部コピーの不存在保証にはしない |
| GAデータ削除リクエストUI | 履歴なし、0/0 | [一覧](https://analytics.google.com/analytics/web/?authuser=0&hl=ja#/a1119752p553139030/admin/piidatadeletion/table) だけを確認。「スケジュール設定」は押していない。SDK/API経由を含むあらゆる削除履歴の不存在とは判定しない |
| Firebase Service Data利用 | 許可ON | [Firebase privacy設定](https://console.firebase.google.com/u/0/project/ponlet-599c4/settings/privacy)。サービス管理・プロビジョニングから生じるService Dataであり、顧客Analytics／Crashlyticsの保持設定とは別 |
| Android Crashlytics | アプリ検出済み・クラッシュ待機表示 | [対象Android画面](https://console.firebase.google.com/u/0/project/ponlet-599c4/crashlytics/app/android:jp.yasagure.ponlet/issues) の表示。Crash Insights設定や保持期間編集は表示されず未確認。収集無効・クラッシュゼロ・新候補が初期化成功という証拠にはしない |

[GA account詳細](https://analytics.google.com/analytics/web/?authuser=0&hl=ja#/a1119752p553139030/admin/account/settings) の共有設定は以下。これはリンク元account共通の設定で、他projectを個別に調査した結果ではない。保存していない。

| 共有設定 | 現在値 |
| --- | --- |
| Googleのプロダクトとサービス | OFF |
| モデリングのためのデータ提供とビジネス分析情報 | ON |
| テクニカルサポート | ON |
| ビジネスの最適化案 | ON |

Firebase統合一覧はGoogle Analytics有効、Google Ads／BigQuery／Google Play／Cloud Loggingが「リンク」ボタン状態。Ads／BigQueryはGA側でも未連携を照合した。その他すべてのサービスやexportを網羅したという意味ではない。private利用者の個別イベント、識別子、crash本文やファイル内容は報告に転載していない。

## 公開申告へ反映できる範囲

実設定と[公式SDK・削除調査](SDK_RETENTION_AND_DELETION.md)を組み合わせる。現在の数値を、すべてのplatform／SDKデータが同じ期限で完全削除されるという文へ変えない。Google Signals未有効やAds未連携でも、Analytics・Crashlytics・ML Kitの診断収集はなくならない。既存配布物のSDK設定と新候補の広告ID無効化を混同しない。

Google側の広告パーソナライズ全体を無効にするか、共有・保持期間を変えるかは、複数platformを含むproject／accountへの影響を所有者が確認してから別途決める。本調査では変更しない。18歳以上は対象ユーザーの提案であり、確定済みの決定や年齢制限ではない。Android受信cloud除外とD2D既存対象維持は別の承認済み方針として保持する。

## なお未確定の項目

- 新署名候補c7408ea0のcompiled Firebase project構成一致は後続CI／Macで確認済み（[最新検証](MENU_FIX_RESULTS.md)）。既存Play配布版の同一性と、OFF／再ON・初回起動のSDK payloadは未確定。
- individual deletionを実際に受け付ける手順、本人データに結び付ける識別方法、Googleでの完了確認。現行アプリには診断データ削除機能がない。
- ML Kit診断の正確な保持期間・個別削除手段、OS／OEM／旧cloud backupのコピー削除。
- data sharingのGoogle Play上の分類／service-provider例外の最終評価。共有設定ONから直ちにすべての収集をPlayの「共有あり」と機械的に決めない。

ローカル日英HTML・Data safetyはレビュー用で `publication_ready=false`。確認済みの現在値を内部草案へ残し、未確認の数値・削除保証は公開用HTMLへ追加しない。
