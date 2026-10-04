# SDKの保存期間・削除・OFF操作の調査メモ

内部レビュー用、公式資料の読み取り確認日：2026-10-03 UTC。対象worktreeの確認時HEADは `5e0125797c2466918772a6722302d84219a1792a`。以下はFirebase／Google Analytics／ML Kitの一般仕様であり、Ponletの配布AABが送信したデータや特定プロジェクトの設定値を観測した結果ではない。SDKの起動、Google設定の変更、削除API実行、メール送信は行っていない。

本体無料、子ども向けを意図しない一般向け、受信ファイルのcloud backup除外、広告ID無効化とAnalytics／Crashlytics既定ON維持という承認は変えない。D2D既存範囲も維持する。Play年齢帯は18歳以上を最初の候補とした[製品判断](PRODUCT_DECISIONS.md)の提案を維持し、Consoleは未選択。

## 結論と残る不確実さ

- 「すべて最大90日」「すべて最大14か月」とする説明は成立しない。GAの設定対象と集計レポート、Crashlyticsの削除開始時期、ML Kit診断を分ける必要がある。
- CrashlyticsをOFFにするAPIのfalseは次回起動から適用される。OFF中もクラッシュ情報は端末に残り、再ONすると送信される。OFFやアンインストールはGoogle側の削除要求と同じ操作ではない。
- `resetAnalyticsData()` は端末内Analyticsデータとapp-instance IDのリセット。`deleteUnsentReports()` はCrashlyticsの未送信レポートを削除する別API。現行Ponletにはどちらの呼出しもない。
- ML Kitの診断はFirebaseスイッチとは独立する。調べた現行公式資料から、barcode SDKの診断を完全停止する公開API、固定保存期間、個別データの削除完了日数は確認できなかった。「停止できない」との断定にもせず、Googleへ確認する事項とする。

## 保存期間：一般仕様・既定値・実設定を区別

| 対象 | 公式資料で確認できた範囲 | 既定値・変更可能性 | Ponletに適用する前の確認 |
| --- | --- | --- | --- |
| GAのユーザー単位／イベント単位データ | ユーザーデータは2／14か月、イベントは2／14か月。360のイベントに限り26／38／50か月も選択可能 | 今回読んだHelp／Admin APIは新規propertyの既定値を明記していないため、「既定2か月」を実設定として採用しない | 正しいpropertyの `userDataRetention`、`eventDataRetention`、standard／360の区分を読み取る |
| GAのユーザー識別子 | `Reset on new activity` がONなら新イベントのたびに期限が延長される | ON／OFFを確認。利用継続中の識別子に固定の総保存上限を約束しない | propertyの `resetUserDataOnNewActivity` と運用を確認 |
| GAの標準集計レポート | 上記retention設定の対象外。探索／funnel等と同じ期限ではない | 今回の資料で集計レポート全体の固定最大保存期間を確認していない | 長期集計を含めた説明と削除対象を分ける |
| Google Signals等 | Signals／Google signed-in dataの最大26か月、signed-in dataの一般既定26か月。retentionが短ければ短い期間。年齢／性別／興味データは設定にかかわらず2か月 | 機能が存在することと、Ponletで機能を有効にしていることは別 | Signals・地域設定等の実状態を確認。広告ID無効だけで機能状態を推定しない |
| Crashlytics | crash stack、抽出minidump情報、関連IDを90日保持後、live／backupの削除処理を開始。元のNDK minidumpは処理用の一時保持 | 90日は完全消去の期限ではない。この資料は削除処理の完了までの上限やretention変更UIを示していない | SDK仕様として説明可能だが、追加exportや実プロジェクトの設定を別確認 |
| Firebase installations削除時 | FIDに結び付いた対象サービスのlive／backupデータは、FID削除から180日以内に除去と説明 | これは削除API後の期間であり、通常保存期間ではない。Analyticsには別IDがありFID削除ではAnalyticsデータは消えない | Crashlytics UUID、GA app-instance ID、ML Kit IDを同一とみなさず、対象を照合 |
| ML Kitの診断／使用状況 | 性能・利用metrics、端末／アプリ・識別子等の取得を説明。画像／読取結果の端末内処理とは別 | 調査したTerms／Android開示／barcodeガイドに、診断の固定保存期間・最大期間・retention設定は見つからない | Googleの回答が必要。Firebase MLのCloud画像保持時間を、このbarcode SDKへ転用しない |

GAの期間・月次削除・集計対象外・activity reset：[Data retention](https://support.google.com/analytics/answer/7667196?hl=en)。期限到達時の削除は月次で行われ、retention変更は24時間後に反映されるため、「Nか月の同日同時刻に全コピー消去」とは書かない。設定項目の定義：[DataRetentionSettings](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/DataRetentionSettings)。読み取り手段の公式案内：[getDataRetentionSettings](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties/getDataRetentionSettings)。今回APIは呼んでいない。

Crashlyticsの90日と一時minidump：[Firebase Privacy and Security](https://firebase.google.com/support/privacy)。FIDの180日とAnalytics除外：[Manage Firebase installations](https://firebase.google.com/docs/projects/manage-installations)。ML Kitの固定期間が未確認という判断は、[Terms & Privacy](https://developers.google.com/ml-kit/terms)、[Android data disclosure](https://developers.google.com/ml-kit/android-data-disclosure)、[barcode Android guide](https://developers.google.com/ml-kit/vision/barcode-scanning/android)を確認した範囲に限る。

## 削除手段と対象・日数

| 操作／手段 | 対象と公式の説明 | 取り違えない点 |
| --- | --- | --- |
| Analytics `resetAnalyticsData()` | このアプリの端末内Analyticsデータを消し、app-instance IDをリセットする | Googleサーバーの履歴削除やCrashlytics／ML Kitの削除APIではない。現行コードには未実装 |
| GA User explorerからユーザーデータ削除 | Editor以上で対象のEffective user IDを選び削除要求。探索では24時間以内に見えなくなり、その後63日以内に永久削除と説明 | ログインのないappではapp-instance ID等との照合が必要。一般のイベントパラメータ削除とは別。現行サポートで本人とIDを安全に照合する手順は未確認 |
| GA Admin API `properties.submitUserDeletion` | `appInstanceId`／`userId`／`clientId`等を指定して要求。返却 `deletionRequestTime` より前の対象データを削除する要求 | 応答は削除要求の受付を示し、全処理完了の証明ではない。APIページに処理完了日数の記載なし。UAのlegacy v3 `upsert` は廃止、現行v1alphaへ移行した案内を使う |
| GA Data-deletion request | 主にイベントパラメータ／user propertyのテキスト。7日間は取消可能、処理は7〜63日、データは12日超経過が必要と説明 | eventの集計回数は残る。数値等は対象外。ユーザー全体やすべての端末IDをこのフォームで消せると説明しない |
| Crashlytics `deleteUnsentReports()` | 自動収集がdisabledなら端末の未送信レポートを削除するqueueを作る。自動収集ON時はno-op | 送信済みサーバーデータの削除ではない。公式APIには完了までの固定日数なし。現行コードには未実装 |
| Crashlyticsの既存user IDレコード | `setUserId("")` は既存レコードを消さない。該当user IDの既存レコード削除はFirebase Supportへ連絡との案内 | Ponletはカスタム `setUserId` を使っていない。UUID／FIDでの本人照合・削除対応が同じ手順で可能かはSupportへ確認。空user ID設定を全削除策として追加しない |
| Firebase installation削除 | clientの `FirebaseInstallations.delete()`／serverの削除。FIDに結び付いた対象データは180日以内 | server削除では1〜2日かけ新規データの受付停止。生成サービスが残れば数日で新FIDができる。AnalyticsやML Kit全履歴の削除保証にはならない |
| Androidアプリデータ削除／アンインストール | 現端末のアプリ内部データを削除するOS操作 | Googleへ削除要求を送る手段ではない。D2D、別アプリ・外部保存先、旧版cloudコピーの扱いを別にする |

各手段の根拠：[FirebaseAnalytics API](https://firebase.google.com/docs/reference/android/com/google/firebase/analytics/FirebaseAnalytics)、[GA User explorer](https://support.google.com/analytics/answer/9283607)、[SubmitUserDeletion](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1alpha/properties/submitUserDeletion)、[legacy移行](https://developers.google.com/analytics/devguides/config/userdeletion/migration)、[GA Data-deletion requests](https://support.google.com/analytics/answer/9940393?hl=en)、[FirebaseCrashlytics API](https://firebase.google.com/docs/reference/android/com/google/firebase/crashlytics/FirebaseCrashlytics)、[Android crash reportsのuser ID節](https://firebase.google.com/docs/crashlytics/android/customize-crash-reports)、[Firebase installation削除](https://firebase.google.com/docs/projects/manage-installations)。

GAの63日は各資料の対象操作についての説明であり、Firebase・ML Kit・export済みデータ・OS backupを含む「すべて63日以内」の保証ではない。本人のメールアドレスだけではapp-instance IDやCrashlytics UUIDを特定できるとは限らない。削除窓口には、対象の特定方法、権限、受付・完了確認、追加コピーの対応範囲を準備する必要がある。

## OFF・端末queue・再ONの動作

| 対象 | 公式仕様 | Ponletで確認する点 |
| --- | --- | --- |
| Analyticsの収集OFF | `setAnalyticsCollectionEnabled(false)` は収集を停止し、設定は次回セッションへ永続化。既定はenabled。恒久無効metadataは別の設定 | 端末内データ削除の約束はない。切替前queue、送信中データ、再ON後の処理や最長queue保持時間は今回のガイド／APIでは明記を確認できず、対象SDKの試験が必要 |
| CrashlyticsのOFF | falseは次回アプリ起動から適用し、overrideは後続起動に保存。disabledでもcrash情報を端末保存する | OFF直後に停止完了と表示しない。OFF中のJava／NDK crash→再起動、送信前の操作順を確認 |
| Crashlyticsの再ON | disabled中に端末保存されたcrash情報も送信される | 現行OFFは「データ破棄」の選択ではない。再ON時の説明と、未送信レポートを破棄する別操作の必要性を検討する。無断で動作を変更しない |
| 未送信レポートの明示処理 | `checkForUnsentReports()` で確認し、`sendUnsentReports()`／`deleteUnsentReports()` を選ぶAPIがある | 現行コードには呼出しなし。新たな削除UIや自動破棄の導入は別の実装判断。ON時のdelete no-opと非同期queueを考慮 |
| ML KitのQR診断 | on-device画像処理と独立してGoogleへ性能・使用状況metrics送信。モデル更新等のGoogle通信もある | 現行OFFはFirebaseの2SDKだけを切替。barcode SDKの公開無効化／削除APIは未確認。thinからbundledへ変えても診断ゼロになるとは開示資料から言えない |

AnalyticsのOFFと広告設定は [Android configure-data-collection](https://firebase.google.com/docs/analytics/android/configure-data-collection)、[FirebaseAnalytics API](https://firebase.google.com/docs/reference/android/com/google/firebase/analytics/FirebaseAnalytics)。Crashlyticsの次起動適用・端末保存・再ON送信は [Android opt-in reporting節](https://firebase.google.com/docs/crashlytics/android/customize-crash-reports#enable-opt-in-reporting)、未送信処理は [FirebaseCrashlytics API](https://firebase.google.com/docs/reference/android/com/google/firebase/crashlytics/FirebaseCrashlytics)。ML Kitの診断とon-device入力は [Terms & Privacy](https://developers.google.com/ml-kit/terms)、thin／bundledのID等は [Android disclosure](https://developers.google.com/ml-kit/android-data-disclosure)。

ここでopt-in reporting節を参照するのはSDK動作の裏付けであり、Ponletを初回opt-inへ変更する指示ではない。既定ON維持の承認に従う。ad ID／personalization falseでも、Analytics app-instance IDや他のSDK診断は残る。

## 現行コードと実プロジェクトを結び付ける条件

`crates/tauri-plugin-ponlet-platform/android/src/main/java/TelemetryBridge.kt:49–57,79–85,102–105` は既定true、保存値の読出し、収集切替と保存を実装している。今回の読み取りでは `resetAnalyticsData`、`deleteUnsentReports`、`sendUnsentReports`、`FirebaseInstallations.delete`、カスタム `setUserId` の呼出しは見つからない。barcode依存は `vendor/tauri-plugin-barcode-scanner/android/build.gradle.kts:42` のplay-services版18.1.0。最新版向け公式開示を、この版の実通信を観測した記録に置き換えない。

親担当は既存認証の読み取りで、公開追跡中のiOS設定に記載されたFirebase projectにAndroid package `jp.yasagure.ponlet` が登録され、GA連携が有効なことを確認した。Ads／BigQuery／Play／Cloud Loggingはリンク操作ボタン表示で未接続と報告された。この読み取り時点では署名Android成果物との照合は未完だった。後続の署名候補c7408ea0では、CIとMac検査でcompiled Firebase project構成一致・google app ID存在・Crashlytics build ID存在を確認済み（[最新検証](MENU_FIX_RESULTS.md)）。既存Play配布版2026093037の同一性やSDK payload／backend受領を確認した結果ではない。署名秘密や元Firebase JSONの値は文書へ転記しない。

親担当の読み取りで、GA account1119752／property553139030（ponlet-599c4）の以下の状態を確認した。根拠画面・時刻は [プロジェクト設定の読み取り記録](PROJECT_SETTINGS_READONLY.md) を参照。これは観測値であり、一般既定値ではない。新署名候補のproject構成一致は後続検査済み。ただし既存Play配布版、全platform／全SDKの最大保持期間へ一括適用しない。

| 読み取り対象 | そのproject／accountの観測値 | 適用上の注意 |
| --- | --- | --- |
| GA propertyのretention | event2か月、user14か月、new activityでのreset ON | userの期限更新と集計レポート対象外により「全履歴14か月以内」ではない |
| Google Signals | 「有効にする」表示で未有効 | Signals由来の一般26か月をPonletの実保持期間として採用しない |
| 地域／デバイス詳細収集 | ON | IP由来概略位置と端末情報を不収集と説明しない |
| 広告personalizationの地域設定 | 307／307地域で許可、現在ON | 新Android SDK flag falseとprojectの設定を区別する。旧版や他platformのデータの状態を同時にOFFと説明しない |
| Google Ads／BigQueryリンク | どちらも「リンクはまだありません」 | 確認したpropertyの現在のリンク状態。過去のexport／コピー不在や他propertyの状態の保証ではない |
| Firebase Service Data使用許可 | ON | Firebaseのサービス運用データの設定で、GA accountの共有項目と同じスイッチではない |
| GA accountデータ共有 | GoogleのプロダクトとサービスOFF。モデリングのためのデータ提供とビジネス分析情報／テクニカルサポート／ビジネス最適化案はON | account共通であり、他propertyは調査していない。Google送信を一括で「共有なし」とする根拠には使わない |

Crash Insights、個別削除の手順・対象、ML Kit診断の保持と削除、過去export／追加コピーは未確認。このメモの一般値を未確認欄へ埋めない。GAが標準集計を保持し続けることと、ML Kit診断の上限未確認により、SDK全体の一つの最大保存期間は現在算出できない。

## 公開文と次の確認

OFFについて短く明示できる日英案：

> AndroidではFirebaseの収集設定を変更します。CrashlyticsのOFFは次回起動から反映され、OFF中のクラッシュ情報は端末に保持されます。再ONすると未送信の情報が送られます。OFFは過去データの削除ではなく、ML Kitの診断も停止しません。

> On Android, this changes Firebase collection settings. Crashlytics applies OFF on the next app launch and keeps crash information locally while disabled. Turning it on again sends previously unsent reports. OFF does not delete past data or stop ML Kit diagnostics.

この補足はローカルHTMLへ反映可能だが、未確認の固定保存期間は入れない。`publication_ready=false` を維持する。公開前の最小判断は [整理](PUBLICATION_DECISIONS.md) を参照。以下は申告の根拠と追加品質試験を分けて進める。未検証の全通信停止・全queue破棄・全OEM復元を保証する文は確定しない。

1. 新署名候補のFirebase構成一致は確認済み。期間／reset／Signals／広告連携／共有／exportの読み取り時点と、既存Play配布版への適用範囲を区別する。
2. 追加品質試験として、許可された範囲でOFF直後／次回起動／offline queue／OFF中crash／再ONを分けて観測する。テスト端末・SDK版・通信・レポートの時刻を記録し、収集ON/OFFのUI値だけで判定しない。
3. Firebase Supportに、Crashlyticsの個別UUID／FIDの照合・削除対象・完了期間と、ML Kit barcode18.1.0診断の保持・無効化・個別削除を確認する。現在は問い合わせを送っていない。
4. 本人のデータを安全に特定し、削除要求を実行・完了確認できる窓口を確立する。IDリセットやアンインストール後は旧IDの特定が難しくなることも扱う。診断削除のためにファイル本文や招待鍵を要求しない。
5. 保存期間は種類ごとに説明し、集計・追加コピー・OS backupを分ける。受信cloud除外はD2Dや旧版コピーを一括削除する処理ではない。
