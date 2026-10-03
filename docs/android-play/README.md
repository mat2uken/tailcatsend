# Ponlet Android Google Play 提出準備

このフォルダは内部レビュー用の草案である。Consoleへの保存、公開ページへの反映、審査提出は行っていない。日付は2026-10-03 UTC。コード調査の基準は `31fafb7aa7b59dd9c530fa1de4187293843512eb`。後続のコード修正と未実行の試験を、既存配布物の状態と混同しない。

| 文書 | 用途 |
| --- | --- |
| [ローカル検証結果](VALIDATION_RESULTS.md) | 実装、未署名AAB/APK、テスト、SDKの残存ブロッカーと証拠 |
| [Data safety回答草案](DATA_SAFETY_DRAFT.md) | Firebase／ML Kit／転送内容、広告ID、収集・共有・任意性の判断材料 |
| [日英privacy／support修正草案](PRIVACY_SUPPORT_DRAFTS.md) | 公開ページの差し替え候補と、公開前に埋める必要がある項目 |
| [Console回答草案](CONSOLE_ANSWERS_DRAFT.md) | 未完のアプリ設定、課金・対象年齢等の要決定事項 |
| [審査員手順とテスト計画](REVIEW_AND_TEST_PLAN.md) | 日英操作案内、Android releaseの検証項目と記録様式 |

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
| OSバックアップ | 新候補AABにも `allowBackup`、`fullBackupContent`、`dataExtractionRules` の指定なし。Androidの既定バックアップ対象に入り得る。実行・復元・削除範囲は未検証 |

既存AABと基準コードのAndroidコードに差分がないことは親担当が確認した。ただし新候補のバージョン、署名、SDK構成、manifest、通信挙動は新候補ごとに検査する。

## 優先順位

1. 16 KB対応の全体確認を完了する。親担当の新候補AAB検査では全9本のLOAD整列、Go／RustのRELRO、カメラ任意設定を確認したが、第三者SDK2本のRELRO strict検査で不合格が残る。実機／Play Consoleでの新候補確認も未完であり、全体の対応済みとは扱わない。
2. 広告ID／広告関連権限を新候補でどう扱うか決定し、Data safety・公開ポリシーを提出AABに一致させる。
3. Firebase／ML Kitの収集、OFFの効果、保存期間・削除方法に加え、OSバックアップと復元の経路を確認し、日英ポリシーとConsole回答を完成させる。
4. Android release実機試験と審査員手順の再現を完了する。iOS／macOSの結果はAndroidの合格記録に転用しない。
5. 未完のアプリ設定、価格・配布国・対象年齢を決め、closed test条件と本番アクセス要件を満たす。

この作業では既定ONのAnalyticsを廃止したり、初回opt-inへ変更したりする判断はしていない。課金と対象年齢も未決定である。
