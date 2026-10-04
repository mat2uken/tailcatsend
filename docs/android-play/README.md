# Ponlet Android Google Play 提出準備

このフォルダは内部レビュー用の草案である。Consoleへの保存、公開ページへの反映、審査提出は行っていない。日英privacy／supportのローカルHTMLを改訂し、後続承認で配布を伴わない署名build検証を実施した。日付は2026-10-03–04 UTC。最新合格署名CIは `c7408ea0e0d767b9ac482b30acb6e42aa6fba81e` / [run37172964773](https://github.com/mat2uken/tailcatsend/actions/runs/37172964773) で静的検査PASS。承認済みAPK移送・削除と専用16KB AVD基本試験・後始末も完了した。初回コード調査の基準は `31fafb7aa7b59dd9c530fa1de4187293843512eb`。後続候補の修正・試験と既存Play配布物の状態を混同しない。

| 文書 | 用途 |
| --- | --- |
| [初回ローカル検証](VALIDATION_RESULTS.md) | 承認前候補の検証。SDK2本のRELRO式は警告であり、修正必須のブロッカーとは判定しない |
| [承認後の方針検証](POLICY_VALIDATION_RESULTS.md) | 広告ID・cloud除外の承認後候補2030000102のartifactとframework検証、未実行の実通信・復元試験 |
| [RELRO再評価](RELRO_ASSESSMENT.md) | ガイド式、linker実装、実行確認、Play判定の区別 |
| [SDKの保存・削除・OFF調査](SDK_RETENTION_AND_DELETION.md) | 公式仕様、端末内queue、個別削除手段と未確定の範囲 |
| [Firebase／Analytics実設定](PROJECT_SETTINGS_READONLY.md) | 照合済みproject／propertyのread-only確認値。配布Androidの接続先照合は別途必要 |
| [署名release検証の最小手順](SIGNED_RELEASE_VALIDATION_PLAN.md) | 配布を伴わないCI候補、runner制約、実行に必要な承認と試験対象 |
| [署名build CI実施記録](SIGNED_CI_VALIDATION_RESULTS.md) | 承認後の検証実装・branch push・手動CI。実行時点の署名候補の結果とruntime未検証を区別 |
| [署名runtime試験・後始末](SIGNED_RUNTIME_RESULTS.md) | 前回734d9590の基本試験、転送初回失敗・menu切れ・SDK観測不足 |
| [個別menu修正・追試](MENU_FIX_RESULTS.md) | 最新c7408ea0の回帰・署名検査、個別SAF保存／Share chooser、初回timeoutの追加調査 |
| [runtime最小手順](MINIMAL_RUNTIME_PLAN.md) | 承認済み範囲と別段階の実機・復元・Play確認 |
| [開発署名16KBローカルpilot](LOCAL_DEV_PILOT_RESULTS.md) | Firebaseなしの実アプリ起動、設定保存・再起動、scratch保存。配布候補・実転送・SDK通信は別検証 |
| [初回timeout限定追試](TIMEOUT_RETEST_RESULTS.md) | 最新APKで3条件各1回は成功。前回DERP表示下idleのtimeout原因は未特定 |
| [公開前の最小判断](PUBLICATION_DECISIONS.md) | 配布国・対象年齢と削除相談の運用、検証限界を付けて確定できる事項 |
| [Data safety回答草案](DATA_SAFETY_DRAFT.md) | Firebase／ML Kit／転送内容、広告ID、収集・共有・任意性の判断材料 |
| [日英privacy／support修正草案](PRIVACY_SUPPORT_DRAFTS.md) | 公開ページの差し替え候補と、公開前に埋める必要がある項目 |
| [Console回答草案](CONSOLE_ANSWERS_DRAFT.md) | 未完のアプリ設定、課金・対象年齢等の要決定事項 |
| [審査員手順とテスト計画](REVIEW_AND_TEST_PLAN.md) | 日英操作案内、Android releaseの検証項目と記録様式 |
| [製品判断と最小確認事項](PRODUCT_DECISIONS.md) | 既存iOS方針との照合、広告ID・価格・対象年齢・backupの推薦と副作用 |

## 確認済みの配布物とConsole状態

親担当が既存GitHub Actions成果物と認証済みPlay Consoleを読み取りで確認した。以下はその調査結果であり、この文書作成時に再ビルド・再配布した結果ではない。

| 項目 | 確認結果 |
| --- | --- |
| パッケージ | `jp.yasagure.ponlet` |
| 既存内部テストAAB | `v1.0.18`、source `d8f7c41c7e86acb778fa5871044becdffce243be`、GitHub Actions run `36648848996` |
| versionName / versionCode | `1.0.18` / `2026093037` |
| AAB SHA-256 | `1197ceab9b556a7bd7ed17f6fac8527cf00ca1102ed05d82d0b342ed11633b28` |
| SDK / ABI | minSdk 31、targetSdk 36、arm64-v8a |
| Data safety | 未完、手順1。保存済み回答として扱わない |
| アプリ設定 | dashboard表示は8/13完了。Data safety、category/contact、listing、merchant account、価格設定が未完。カテゴリはTools登録済みだがcontactは空、listingは未作成、価格設定はロック表示 |
| App content | Data safetyとAdvertising IDの2申告が未完 |
| Policy center | 未審査のため情報はまだ表示されていない。違反なし・審査通過の証拠ではない |
| 本番アクセス | Consoleにclosed testの12人・14日条件が表示され、確認時点の人数は0人。内部テスト有効だけで条件を満たしたとは扱わない |
| 16 KBページ対応 | 既存AABはConsoleが非対応、`libtailcat.so` を指定。新候補での修正・最終AAB検査が必要 |
| カメラ必須設定 | 既存AABの `android.hardware.camera.any` は `required=true`。ソースの任意設定だけでカメラなし端末対応済みと扱わない |
| OSバックアップ | 方針確認前の候補はバックアップ指定なし。17:59 UTCの承認後に、Android API31+で受信 `files/received` をcloud backupから除外する。未署名候補2030000102のcompiled rule検査は合格、backup復元は未確認。D2Dは既存の範囲を維持、OS／OEM依存 |

既存AABと基準コードのAndroidコードに差分がないことは親担当が確認した。ただし新候補のバージョン、署名、SDK構成、manifest、通信挙動は新候補ごとに検査する。

## 優先順位

1. Consoleに表示されたclosed testの12人・連続14日と本番アクセス要件は残る。12人確保は所有者が別途検討する事項として扱い、募集・招待は行わない。確認時点は0人で、内部テスト有効だけでは代用できない。未完設定、store listing/contact、配布国・具体的Play年齢区分・無料設定も確定する。
2. Data safetyと日英privacy/supportを、Firebase／ML Kitの収集・OFF・保持・削除、OSバックアップの説明に一致させる。SDK宛先・queue・backend削除は今回の観測では確定せず、公開可能な説明と運用手順を詰める。全Google通信停止や一律削除の保証を書かない。
3. P2のメッセージ単位menu切れは修正し、共通UIの回帰19件と最新署名APKの個別Save／Share chooser追試で確認済み。初回ファイルdial失敗は3条件各1回で限定追試し、今回は再現せず。DERP表示下のtext後idleは未検証で原因未特定。無根拠なretryは追加しない。前回734d9590で基本起動・URL接続・双方向dummy転送・履歴SAF保存・OFF再起動保存を確認。最新c7408ea0では起動・URL接続・受信dummyテキスト・個別Save／Share chooserを追試した。ただし初回転送のFAILと再試行PASSを両方残し、一般的な安定性を保証しない。実カメラQRは未実施。
4. 別途許可された配布段階で、新AABのPlay側16KB判定とPlayでの導入・upgradeを確認する。SDK2本のRELRO式は監査警告として保持し、それだけで提出不可とは判定しない。[再評価](RELRO_ASSESSMENT.md)を参照。広いOEM復元・異常系確認は品質試験として分ける。

今回の署名AAB/APKは、証明書一致、versionCode2030000102、全9本の16KB LOAD、APK ZIP16KB配置、カメラ任意、広告ID関連設定、受信cloud除外、compiled Firebase設定に合格した。対応native9本はhashも一致。APKはCIとMacで独立再検証し、専用API35/16KB AVDで候補ごとに上記範囲を試験した。短期Actions artifactはMac照合後に削除、専用AVD／Web相手も終了済み。[前回runtime記録](SIGNED_RUNTIME_RESULTS.md)と[最新menu追試](MENU_FIX_RESULTS.md)に、各候補のhash・失敗・限定事項・後始末を記載する。cloud復元・Play側判定は未実施。iOS／macOSやFirebaseなしpilotの結果でAndroidを保証しない。

2026-10-03 17:59 UTCにユーザーが承認：Play本体無料、子ども向けを意図しない一般向け、Android受信ファイルのクラウドバックアップ除外、広告ID無効化。Analytics／Crashlyticsは既定ONとOFF操作を維持する。具体的なPlay年齢区分とConsole選択は未実施、D2D移行の対象範囲は拡張しない。 Analytics廃止・初回opt-inへの変更は行わない。

`publication_ready=false`。Google側の削除手順・ML Kit保持とSDK実通信の限定、runtimeで判明した不具合、Console設定が残っており、ローカルHTMLをそのまま公開しない。

18:30 UTC前後の後続読み取りでは、対象Firebase／GAのイベント2か月・ユーザー14か月・活動ごとの期限更新ONなどを確認した。[実設定記録](PROJECT_SETTINGS_READONLY.md)と[SDK仕様](SDK_RETENTION_AND_DELETION.md)を分け、未照合の配布Androidへ値を適用していない。日英ローカルHTMLにはAndroid Crashlyticsの次起動OFF反映・端末保持・再ON送信だけを補足し、保存期間の仮値は追加していない。後続文書と補足は独立レビューを完了、重大指摘なし。18:30 UTCの調査段階ではGoogle設定変更・削除API・新runtime試験・workflow追加・CI実行・配布はしていない。後続の署名CI実装・実行は[実施記録](SIGNED_CI_VALIDATION_RESULTS.md)を参照。署名候補のcompiled Firebase project一致は最終CIで確認済み。限定runtimeでrelay使用とdummy転送を確認したが、SDK宛先／送信内容、個別削除手順、ML Kit診断の保持と削除はなお未確認。
