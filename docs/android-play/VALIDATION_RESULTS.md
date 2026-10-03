# Android準備ブランチの検証結果

2026-10-03 UTC。基準 `31fafb7aa7b59dd9c530fa1de4187293843512eb` から `feature/android-play-readiness` に作成したローカル変更を検証した。元checkoutは変更していない。端末・USB・音声、署名秘密、CI dispatch、GitHub／Play upload、公開サイト、Console保存・提出にはアクセスしていない。

## 実装

- Go c-sharedをAndroid API 31と外部linkerで生成し、最大・共通ページを16KBに設定した。Rust Android linkerにも同設定を追加した。
- merged manifestでcamera／camera.any／autofocusを任意にする設定を追加した。
- 署名・Firebase upload・成果物配布を含まない検証入口とCI workflowを追加した。既存Play workflowは手動実行だけにし、実AAB検査をupload前に配置した。
- 日付下2桁によるversionCodeを廃止し、確認済みConsole最大値とrun／attemptから割り当てる。最大値は手動確認値であり、別経路uploadや古い入力との競合を自動解決する保証はない。
- 標準PythonでAAB／APKのmanifest、全native LOAD／RELRO、AABの16KB指定、APK native ZIP alignmentを検査する入口を追加した。

## ローカルビルドの範囲

`scripts/build_android_verify.sh` でrelease AABとAPKを生成、exit 0。並列数は2。JDK Corretto 21.0.12、Go toolchain 1.27.1、Tauri CLI 2.10.0、NDK 28.2.13676358、Gradle 8.14.3、既存Rust Android targetを使用した。Gradle／Go cacheはこのworktreeの `work/` に分離した。CIのJava 17／NDK r28bと同一環境ではない。

署名設定とGoogle Services／Crashlytics build pluginを検証モードで無効にした。Firebase SDKの依存と製品の既定ON設定は変更していないが、この生成物にはFirebase client configurationを含まない。**提出候補の署名・Firebase初期化・SDK通信を検証した結果ではない。**

| 生成物 | SHA-256 |
| --- | --- |
| `apps/tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab` | `019447c982f6d595684b16d7ce9308cfe7a52d759cc69e6374085da784c1fe40` |
| `apps/tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk` | `d3c4455d01ec45d762c2bb759477db730325063dc394e8d20a51ecc89adf8133` |

両方のpackageは `jp.yasagure.ponlet`、versionName `1.0.18`、検証用versionCode `2030000101`、minSdk 31／targetSdk 36、arm64-v8a。camera／camera.any／autofocusは任意となった。広告関連権限は残る。既存版のConsole表示にはCHECK_LICENSEがあるが、元のCI AAB実体と今回のローカル成果物にはない。

## 静的検査

| 検査 | 結果 |
| --- | --- |
| 全9 native libraryのLOAD | AAB／APKとも16KB以上、offset／vaddrの16KB整合性を満たす |
| Go `libtailcat.so` RELRO | 終端modulo 16KBが0。旧4KB LOAD問題を解消 |
| Rust `libtailsend_tauri_lib.so` RELRO | 終端modulo 16KBが0。旧終端未整列を解消 |
| AAB BundleConfig | `PAGE_ALIGNMENT_16K` |
| APK native ZIP alignment | 全9ライブラリ16KB。SDK build-tools 36.0.0 `zipalign -c -P 16 -v 4` が `Verification successful` |
| strict RELRO | **失敗**。下記SDK2本を検出し、validator exit 1 |
| 16KB実行環境／Play処理 | 未実行 |

残存ライブラリは `libdatastore_shared_counter.so`（DataStore 1.1.7、終端modulo `0x2000`）と `libsurface_util_jni.so`（CameraX 1.5.1、`0x1000`）。各LOADは16KBだが、[Android公式RELRO式](https://developer.android.com/guide/practices/page-sizes#relro)を満たさない。rounded tailに書込LOADの重複が見つからなかったことを理由に、公式式のstrict判定を緩めていない。SDK修正と最終AAB再検査が必要で、**16KB完全対応・提出可能とは判定しない。**

検査証拠はworktree内 `work/android-artifacts-verification-strict.json`、`work/android-zipalign.log`、`work/android-build.log`。生成物・ログはGitへ追加しない。旧内部テストAABも負対照として検査し、旧camera必須、Go LOAD4KB、Rust／SDK RELROの失敗を再現した。

### 公式SDKの非破壊比較

Google Mavenから最新安定版AARを別ディレクトリへ取得し、arm64ライブラリを比較した。製品依存は変更していない。

| 比較対象 | 結果と次の対応 |
| --- | --- |
| [DataStore 1.2.1](https://developer.android.com/jetpack/androidx/releases/datastore#1.2.1) | `libdatastore_shared_counter.so` のRELRO終端は `0x9440 + 0x2bc0 = 0xc000`、余り0。修正版候補。推移依存全体とKotlin metadataを含めて更新・再ビルド検証が必要 |
| [CameraX 1.6.2](https://developer.android.com/jetpack/androidx/releases/camera#1.6.2) | `libsurface_util_jni.so` は `0x49b0 + 0x650 = 0x5000`、余り `0x1000` が残る。この更新だけでは解決しない。CameraPipe移行も含むため、今回の未整列だけを目的に依存変更していない |

両最新ライブラリのLOADは16KB。上記は静的結果で、実際のクラッシュは未確認。公式に準拠するCameraX修正版の供給状況確認、または同じ機能を維持するソース再ビルドの評価が必要。RELRO保護の解除やELFの見かけだけの書き換えは実施していない。取得URL・AAR／SO hash・全segmentの比較証拠は `/tmp/ponlet-sdk-comparison/report.json`。

## テストとレビュー

- UI: 21ファイル・132テスト、lint／typecheck／format checkが合格。
- scripts: 49テスト合格。versionCodeの上限・循環防止・跨workflow復帰、build-only隔離、壊れたAAB／APK／ELF、camera暗黙必須、未整列を拒否する検査を含む。
- Kotlin: barcode scannerの既存release unit tests 3件合格（ScanSessionTest、Gradle `BUILD SUCCESSFUL`）。
- shell構文、Rust変更のformat、`git diff --check`が合格。
- 独立レビュー: 実装にP0／P1指摘なし。SDK RELROは未解決ブロッカーとして維持。OS Auto Backupのポリシー・復元説明不足を草案へ反映。

scripts全体の再現コマンドは `work/test-venv/bin/python -m unittest discover -s scripts/tests -p 'test_*.py'`。隔離venvへ既存TestFlightテスト用のPyJWT 2.15.1／cryptography 50.0.2を公式PyPIから導入した。Android関連24テスト自体は標準Pythonだけで動くが、全scriptsを未準備のsystem Pythonで実行するとこの既存依存が不足する。既存TestFlightテストは一時fixtureを使用し、実際の署名秘密を読んでいない。

Android release実機、QR、文書選択、転送、FileProvider、OFF／再ON通信、バックアップ復元は未実行。[試験計画](REVIEW_AND_TEST_PLAN.md)に従い、同じ提出候補を検証する。

## 次の準備

1. SDK2本の16KB RELRO修正、必要なら供給元の修正版／再ビルドを評価する。公式に準拠する最終AABと生成APKを再検査する。
2. 別途許可された環境で署名・Firebase設定を含む候補を作り、16KB release実行とSDK通信を確認する。
3. 広告IDの方針、Google側保存期間・削除・連携設定、OS backupの扱いを確定し、[Data safety](DATA_SAFETY_DRAFT.md)と[日英privacy／support](PRIVACY_SUPPORT_DRAFTS.md)の未確定欄を解消する。
4. 価格・地域・対象年齢、listing／連絡先を確定し、別途承認後に公開・Console保存・closed testへ進める。Console確認時は12人連続14日が必要で、参加0人。内部テスト有効のみでは本番アクセスを満たさない。
