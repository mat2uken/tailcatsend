# 承認後のAndroid方針・成果物検証

2026-10-03 UTC。ユーザーが17:59 UTCに承認した4方針を、同じ `feature/android-play-readiness` のローカル作業へ反映した。実装時の親commitは `7686d4bb6b5dd17892e1b6ec58aecbb943486134`。新候補を検証した結果であり、旧内部テスト・iOS・macOSの実績を流用していない。

## 実装した範囲

- Play本体無料、子ども向けを意図しない一般向けを草案へ記録した。具体的なPlay年齢帯は提案で、Consoleを選択・保存していない。
- Android受信 `files/received/` だけをクラウドバックアップから除外した。`allowBackup=true` とAPI31+の空の `device-transfer` を維持し、設定・隣接ファイル・D2D対象範囲を変更していない。legacy規則は受信除外がcloud／D2D双方に及ぶが、minSdk31の製品は旧APIへ到達しない。
- Firebase Analytics広告ID取得と広告personalizationの2フラグをfalseにし、AD_ID／AdServices AD_ID／ATTRIBUTIONの3権限をmerged manifestから除いた。
- Analytics／Crashlyticsの既定ONと保存済みOFFを維持した。OFFで転送通信やAndroid ML KitのQR診断が停止しないことを日英UIとprivacy／supportへ記載した。
- AAB／APKのcompiled resource IDから実backup XMLを解決する検査を追加した。参照欠落、未対応alias、異なる設定variant、文字列falseによる広告フラグの代用は合格しない。新広告・backup gateを検証用／Play用の両CIに追加した。CIは実行していない。

根拠：`apps/tauri/gen/android/app/src/main/AndroidManifest.xml`、同 `res/xml/backup_rules.xml`／`data_extraction_rules.xml`、`TelemetryBridge.kt`、`web-ui/src/components/settings-dialog.ts`、`scripts/verify_android_artifacts.py`。

## 新候補の実体

`scripts/build_android_verify.sh` でrelease AAB／unsigned APKを生成しexit0。元checkoutは変更せず、署名秘密・本番Firebase設定・新credentialは読んでいない。Google Services／Crashlytics build pluginを無効にしており、Firebase client configurationを含む本番候補の代替ではない。環境は[初回検証記録](VALIDATION_RESULTS.md)と同じ既存ツール群・隔離cacheを利用した。

| 生成物 | SHA-256 |
| --- | --- |
| `app/build/outputs/bundle/universalRelease/app-universal-release.aab` | `28f3bd088968fd33c5f0bf6608c363b9907d06924364908b98324154fa2661d8` |
| `app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk` | `ae49dcfe40bfa62bc7ee6f789dbd12ba8fdba92bec4abadd6626c7b4cc643961` |

ルートは `apps/tauri/gen/android/`。両方 `jp.yasagure.ponlet`／versionName `1.0.18`／versionCode `2030000102`／minSdk31／targetSdk36／arm64-v8a。新候補のversionNameは既存版と同じため、既存内部テスト `2026093037` とversionCode・SHAで区別する。

| 検査 | 結果・範囲 |
| --- | --- |
| 広告設定 | 実compiled boolean falseが2件、広告3権限が不在。広告ID以外の識別子・IP由来概略位置・診断の不収集を保証しない |
| backup規則 | 両artifactの実tableから参照を解決。APKの最適化名 `res/Qq.xml`／`res/4j.xml` を推測せず検査。cloud受信だけ除外、prefs／他ファイル・D2D保持 |
| camera | camera／camera.any／autofocusが任意 |
| 16KB静的 | 全9本のLOAD／APK ZIP整列、AAB `PAGE_ALIGNMENT_16K` 合格。build-tools36.0.0 `zipalign -c -P 16 -v 4` 合格 |
| RELRO | DataStore／CameraXのガイド式2件は既存の監査警告。通常gateは警告付き合格。詳細は[再評価](RELRO_ASSESSMENT.md) |
| 16KB native実行 | API35・page size16384の既存read-only AVDで、新APKの全9本をRTLD_NOWでdlopen／dlclose、全process exit0。SDK JNI初期化・QR・転送・アプリ起動の試験ではない |
| scripts | 隔離venvで全62件合格。compiled資源・広告boolean・backup範囲、旧候補の負対照を含む |
| UI | 21ファイル・133件、lint／typecheck／format合格 |
| workflow | `actionlint` が両変更workflowに合格。shell構文とdiff check合格 |

証拠：`work/android-policy-build.log`、`work/android-policy-artifacts-verification.json`、`work/android-policy-zipalign.log`、`work/android-policy-script-tests-final.log`、`work/android-policy-runtime/{inputs.json,smoke-report.json,smoke.log}`。生成物・logはGitへ追加しない。初回候補は `work/pre-policy-artifacts/` に区別して保存した。

## Android frameworkによる復元対象の確認

既存API35・16KB AVDのscratch領域で、unsigned APKに含まれる両XMLをAndroid `FullBackup.BackupScheme` の実parserへ渡し、cloud／D2Dのsection選択と `BackupAgent.isFileEligibleForRestore`／`onRestoreFile` を検査した。受信・受信の再帰配下・隣接フォルダ・SharedPreferencesの各4件×cloud／D2D／legacy、計12件で対象判定と復元結果が一致した。

unsigned・uninstalledのため、installed packageのresource lookupは迂回し、実parserが返したinclude／excludeをscratch schemeへ設定している。legacyもAPI35上で旧XML parserを呼んだ結果であり、API30端末の実行結果ではない。OSの実transport・Google cloud・OEM移行、旧backup削除、アプリ全体再導入は未検証。

12件のうち設定の3件では、実際の `telemetry_prefs.xml`／`telemetry_enabled=false` を復元し、Android `SharedPreferencesImpl.getBoolean(..., true)` でもfalseを保持することを確認した。Firebaseや `TelemetryBridge.bootstrap` は初期化していないため、復元後のSDK通信を検証した結果ではない。

API35の `getPackageArchiveInfo` はApplicationInfo.flags全体が0で、allowBackupもfalseとして返した。一方、actual compiled manifestはtrue、Android旧 `PackageParser.parsePackage` でも `FLAG_ALLOW_BACKUP=true` だった。AOSPの未finalized packageでは派生flagsが未設定で、archive生成経路がその値をApplicationInfoへコピーするため、このarchive APIのflagsをinstalled packageのbackup設定の根拠に使わない。検査はcompiled manifestと実XMLに基づく。

証拠：`work/backup-runtime/BackupRulesAudit.java`、`framework-audit.json`、`framework-audit.log`、`README.md` と同ディレクトリのAOSP調査資料。[AOSP API35 FullBackup](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-15.0.0_r1/core/java/android/app/backup/FullBackup.java) を参照。今回のAVDはread-only／snapshot保存なし／カメラ・音声無効で起動し、試験終了後にこの作業のPIDだけを終了した。

独立レビューで実装・日英HTML・草案・成果物と試験の対応にP0／P1／P2指摘なし。レビュー担当も現行AAB／APKの新gateとAndroid関連37テストを再実行し、成功を確認した。archive flagsの説明は上記の未設定値コピーへ明確化した。

## 署名・本番Firebaseを含む検証経路

既存 `google_play.yml` はsigning secretの導入・Firebase client configuration復元・Crashlytics symbol upload・GitHub artifact upload・Play deploymentを同じ経路に含む。`release.yml` も配布を伴う。現在の許可範囲でこの経路をdispatchしない。

今回のbuild-onlyは署名・Google Servicesを無効にするため、Firebase初期化や実通信の合格証拠にできない。既存署名済み旧版も新設定の検証へ流用できない。新credential作成・key読取・本番Firebase設定読取なしで、新署名済み候補を安全に生成／試験できる既存の分離経路は確認できなかった。次段階では、所有者が管理する署名とFirebase構成を保持した「配布・symbol uploadなし」の候補生成経路を別途確定し、source／AAB SHAを揃えて試験する。

## 残るブロッカーと準備順

1. **提出releaseの動作**：同じ署名済み候補を16KB／通常ページ環境で起動し、QR、文書選択、双方向転送、受信ファイルの開く／書き出し、OFF／再ON・OFF保存済みupgrade、SDK通信、実transportのbackup／restoreを[試験計画](REVIEW_AND_TEST_PLAN.md)で確認する。
2. **Data safety・公開本文**：Google側の保存期間／削除手順／連携設定と実通信を確認し、草案の保留を解消する。日英HTMLはローカル改訂済みで `publication_ready=false`。受信cloud除外や広告ID無効でも、他データの収集／backupや旧コピーを一括不収集・消去と申告しない。
3. **Consoleと本番アクセス**：無料・一般向けは承認済み。配布国、年齢帯の最終確認、listing、contact、Data safety／Advertising ID回答を整える。Console既知状態はclosed test参加0人・12人連続14日条件。本番アクセス申請は条件を実際に満たしてから進める。
4. 上記を揃えた後、公開・配布・Console保存・審査提出を別途承認された段階で実行する。今回はpush／PR／サイト公開／upload／Console保存・提出を行っていない。物理端末・USB・音声・別アプリの環境には触れていない。
