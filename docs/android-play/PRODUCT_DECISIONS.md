# 提出前の製品判断と最小確認事項

内部レビュー用、2026-10-03 UTC。製品判断、コード変更、Console保存はこの文書では行っていない。iOS資料は過去の提出回答であり、現在のAndroid申告・実通信を保証しない。

## 既存iOS方針との照合

| 論点 | 記録・現在の実装 | Androidでの扱い |
| --- | --- | --- |
| 広告用途 | `fastlane/review_information/app_privacy_answers.md:55–56,69–79` は広告／マーケティング利用なし、IDFA／ATTなし。`age_rating_answers.md:29` も広告表示なし | Android現行AABのAD_ID／AdServices権限はこの方針と整合確認が必要。広告IDの明示無効化は広告用途なし方針に沿う候補。IDFAなしという過去のApple申告をAndroid広告IDなしの証拠にしない |
| テレメトリ | `app_privacy_answers.md:14–19,108,119` は既定ON／opt-outを2026-09-23に決定した記録。現在のSwift `PonletPlatformPlugin.swift:243–263` も `?? true`、Analytics／Crashlytics切替 | 既定ON維持は既存方針に一致。opt-inやAnalytics廃止へ変更するなら新しい製品判断。初期manifestの収集falseを初回opt-inと説明しない |
| Appleの位置・ID分類 | `app_privacy_answers.md:31,41,82–84` は概略位置を申告しない／Device ID Not Linkedという過去判断。実通信未確認の注意あり | Playへ流用しない。Google公式資料に沿ってIP由来概略位置と各SDK識別子を別に評価。共通公開policyで位置／ID全不収集を保証しない |
| 年齢 | `age_rating_answers.md:17–29,76–79` は年齢確認なし、1対1チャットあり、推定4+、Made for Kidsを選ばない | 4+はコンテンツレーティングの記録で、Playの対象ユーザー全児童を選ぶ指示ではない。「子ども向けではない」と「利用可能最低年齢」は同一でない。IARC回答とtarget audienceを分ける |
| 課金 | `fastlane/metadata/ja/description.txt:31` と `app_review_notes_ja.md:14–19` はIAP／subscription／広告／外部購入リンク／ロック機能なし | Playのアプリ本体を無料にする決定は確認できない。無料／有料、配布国を所有者が確定。IAPなしから価格を決めない |
| バックアップ | Android新候補にはallowBackup等の指定なし、内部受信filesとSharedPreferencesはOS既定対象になり得る | この調査でiOSのOSバックアップ方針までは検証していない。Androidのbackup範囲と復元・削除を明示し、共通policyで「アンインストールすれば全コピー消去」と保証しない |

現在のiOS `Package.swift:13–14` のFirebase依存はAnalyticsとCrashlytics。旧1.0.14の審査メモにあるRemote Configは現在の構成へ移さない。

## 最小の確認セットと推薦

同じ質問を繰り返さない。現在のセッションで以下が既に許可・決定されていれば、その項目は質問から外して記録だけ更新する。複数の独立した判断を一つの「すべて承認」にまとめない。

| 確認の文案 | 推薦 | 主な効果・副作用 |
| --- | --- | --- |
| 広告用途なしを維持して、Androidの広告ID取得・広告パーソナライズと不要な広告関連権限を無効化する方針でよいか | 広告用途がないなら明示無効化を推薦。既存のテレメトリ既定ONは維持 | 広告アトリビューション／Ads連携に影響。品質改善Analyticsを丸ごと廃止する変更ではない。app-instance ID、概略位置、Crashlytics／ML Kit診断は残る。最終AABと通常動作の再検証が必要 |
| Playのアプリ本体は無料か、有料にする意図があるか | IAP／ロック機能なしの汎用ツールとして無料を候補。ただし価格は推測で確定しない | [Play公式価格資料](https://support.google.com/googleplay/android-developer/answer/6334373)では一度無料提供した同packageを有料へ変更できない。将来の本体販売意図があるなら無料への保存前に決める |
| 主な対象者は一般利用者で子ども向けにはしないか、子どもも意図して対象に含めるか | 現状のMade for Kidsを選ばない記録に沿って一般向けを候補。具体的な年齢帯は実際の製品対象に合わせて決める | [Play対象者資料](https://support.google.com/googleplay/android-developer/answer/9867159)に従い、子どもを対象に含める場合はFamilies／SDK等の追加確認が必要。既存4+から13+／18+や全年齢を機械的に選ばない |
| 受信ファイルをOSのクラウドバックアップへ含めたいか、対象外にしたいか | プライバシー方針に合わせ、受信ファイルのクラウドバックアップ除外を候補。設定の復元と端末移行は別に精査 | 除外すると再導入・機種変更で受信ファイルを復元できない場合がある。設定復元でtelemetry OFFを保つ価値がある。バックアップ全体無効化を即決せず、OS／OEMのcloudとD2D差を確認する |

対象年齢の確認はストア上の年齢制限を勝手に追加する承認ではない。backup除外の推薦も未実装であり、現行はOS既定のまま。

## テレメトリを改めて聞く必要がある場合

既定ON維持は今回の草案と過去の製品方針に沿うため、単に調査が始まったことを理由に再度決定を求める必要はない。ユーザーが同意方式を変えたい場合、または配布地域・実際の収集に応じた同意要件の評価で変更が必要になった場合だけ、次を比較して確認する。

- **既定ON維持**：品質改善の利用統計を継続し、既存ユーザー設定と動作を保ちやすい。説明・Data safety・地域に応じた必要な同意の確認は残る。Apple審査通過を合法性やAndroid合格の保証にしない。
- **初回opt-in**：明示同意までAnalytics／Crashlyticsを開始しない設計。初回画面、SDK開始順、既存ON／OFF設定の移行、再同意・撤回を追加検証する。利用統計・診断の母集団が変わる。ML Kit／OSバックアップを自動的に止める変更ではない。
- **Analytics廃止**：利用集計を失う。Crashlytics／ML KitとOSバックアップは別途扱う。今回の指示から導ける変更ではない。

価格・対象年齢・backupの3点が未決定なら、まずそれだけを明確に尋ねる。広告IDの明示無効化は、既に広告用途なしと修正が承認されているかを確認してから質問の要否を判断する。
