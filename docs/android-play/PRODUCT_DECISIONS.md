# 提出前の製品判断と最小確認事項

内部レビュー用、2026-10-03 UTC。この文書は既存資料とユーザーの承認を記録する。Console保存は行っていない。iOS資料は過去の提出回答であり、現在のAndroid申告・実通信を保証しない。


新候補の未署名AAB `versionCode=2030000102` は親担当の最終artifact validatorで確認済み。compiled manifestの広告ID取得・広告personalization flagsは両方false、3広告関連権限は不在。compiled resourcesからbackup XMLを解決し、API31+のcloudでは `received/` だけを除外、SharedPreferencesと隣接ファイルを保持、空のD2D規則は既存の対象を保持することを確認した。これはOS復元試験・実通信・署名・Play配布の成功を意味しない。詳細は [承認後の方針検証](POLICY_VALIDATION_RESULTS.md) を参照。

## 既存iOS方針との照合

| 論点 | 記録・現在の実装 | Androidでの扱い |
| --- | --- | --- |
| 広告用途 | `fastlane/review_information/app_privacy_answers.md:55–56,69–79` は広告／マーケティング利用なし、IDFA／ATTなし。`age_rating_answers.md:29` も広告表示なし | Android現行AABのAD_ID／AdServices権限はこの方針と整合確認が必要。広告IDの明示無効化は広告用途なし方針に沿う候補。IDFAなしという過去のApple申告をAndroid広告IDなしの証拠にしない |
| テレメトリ | `app_privacy_answers.md:14–19,108,119` は既定ON／opt-outを2026-09-23に決定した記録。現在のSwift `PonletPlatformPlugin.swift:243–263` も `?? true`、Analytics／Crashlytics切替 | 既定ON維持は既存方針に一致。opt-inやAnalytics廃止へ変更するなら新しい製品判断。初期manifestの収集falseを初回opt-inと説明しない |
| Appleの位置・ID分類 | `app_privacy_answers.md:31,41,82–84` は概略位置を申告しない／Device ID Not Linkedという過去判断。実通信未確認の注意あり | Playへ流用しない。Google公式資料に沿ってIP由来概略位置と各SDK識別子を別に評価。共通公開policyで位置／ID全不収集を保証しない |
| 年齢 | `age_rating_answers.md:17–29,76–79` は年齢確認なし、1対1チャットあり、推定4+、Made for Kidsを選ばない | 4+はコンテンツレーティングの記録で、Playの対象ユーザー全児童を選ぶ指示ではない。「子ども向けではない」と「利用可能最低年齢」は同一でない。IARC回答とtarget audienceを分ける |
| 課金 | `fastlane/metadata/ja/description.txt:31` と `app_review_notes_ja.md:14–19` はIAP／subscription／広告／外部購入リンク／ロック機能なし | このiOS資料だけからPlay本体価格は決めない。Play本体無料は下記17:59 UTCのユーザー承認で確定し、配布国は未確定 |
| バックアップ | 方針確認前の候補にはallowBackup等の指定なし、内部受信filesとSharedPreferencesはOS既定対象になり得る | この調査でiOSのOSバックアップ方針までは検証していない。Androidのbackup範囲と復元・削除を明示し、共通policyで「アンインストールすれば全コピー消去」と保証しない |

現在のiOS `Package.swift:13–14` のFirebase依存はAnalyticsとCrashlytics。旧1.0.14の審査メモにあるRemote Configは現在の構成へ移さない。

## 2026-10-03 17:59 UTCの承認記録

| 項目 | 承認済みの決定 | 残る確認・範囲 |
| --- | --- | --- |
| 本体価格 | Play本体は無料 | Console保存しない。配布国・merchant／価格ロックの状態は別確認 |
| 対象者 | 子ども向けを意図しない一般向け | 具体的なPlay年齢区分は実態に合わせて提案のみ。Apple4+を流用せず、Console選択しない |
| 受信ファイルbackup | Androidの受信 `files/received` をcloud backupから除外 | 未署名候補のAPI31+ cloud-only規則は検査済み。署名する提出AABで再検査。D2Dは既存範囲を維持し、拡張しない。OS／OEM挙動、設定復元、旧版backupの削除は未検証 |
| 広告IDとtelemetry | 広告ID取得・広告personalizationを無効化、不要な3広告関連権限を除去。Analytics／Crashlytics既定ONとOFF操作を維持 | 未署名候補のflags／permissionsは検査済み。署名する提出AABで再検査。ML Kit診断はOFFスイッチで止まらないことを説明。SDK実通信・Google設定は未検証 |

上記4点を再質問しない。Analytics廃止・初回opt-in化・D2D範囲拡張・追加年齢制限は承認に含まれない。backup除外で受信ファイルをcloudから復元できなくなる副作用も方針に含めて記録する。受信ファイル以外の設定やSDKデータをすべてbackup無効化する変更は行わない。

## 実装と公開の確認

日英privacy／supportのローカルHTML変更は承認済み、公開・Console変更は未承認。承認済みの4方針を [各草案](README.md) へ反映した。広告IDやcloud ruleの確定文は新候補AABの検査結果と照合する。保存期間・削除手順は捏造せず、docs内の保留欄で扱う。正式公開準備は `publication_ready=false`。

[Play価格資料](https://support.google.com/googleplay/android-developer/answer/6334373)の無料提供後の有料変更制約と、[対象者資料](https://support.google.com/googleplay/android-developer/answer/9867159)は提出担当が必要時に再確認する。今回Consoleを変更しない。

## Play対象年齢の提案（Console未選択）

最初の候補は **18歳以上**。現状の用途・説明は、端末間で本人がファイルやテキストを転送する一般的なツールであり、子ども向けの題材・教材・遊びを前提にしていない。未成年を意図した紹介や想定ユーザーの根拠はこの調査では確認できていないため、13–15歳／16–17歳を機械的に追加しない。実際の紹介文、画像、想定する利用者層を所有者と提出担当で確認して最終回答を決める。

18歳以上は対象ユーザーの申告案であり、利用者の年齢確認や18歳未満の利用禁止を新たに実装する決定ではない。一般向けという承認だけで年齢帯を確定したとは扱わない。少年・少女を実際に想定する場合は13–15歳／16–17歳の追加を評価し、12歳以下を意図的な対象とする場合はFamilies要件とFirebase／ML Kitの識別子・診断を別途評価する。

IARCのコンテンツ設問では1対1のテキスト通信を実態どおり回答し、target audienceと別に生成されたレーティングを確認する。Appleの4+は転用しない。[Google Play対象者資料](https://support.google.com/googleplay/android-developer/answer/9867159)に従い、今回はConsoleを選択・保存しない。
