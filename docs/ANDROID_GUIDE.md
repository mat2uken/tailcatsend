# Ponlet Android ビルドと配布

Android 版は `apps/tauri/gen/android` の Tauri mobile shell に、共通 Rust service、Go Tailcat bridge、VanJS bundle をリンクします。旧 NativeActivity 入口は使いません。

| 項目 | 現在の値 |
| --- | --- |
| Application ID | `jp.yasagure.ponlet` |
| UI | Tauri WebView + VanJS/TypeScript |
| 通信 | Go Tailcat（WireGuard UDP / DERP / WebRTC） |
| Rust | 共通セッション・転送・保存処理 |
| ABI | arm64-v8a |
| SDK | minSdk 31 / targetSdk 36 |
| 配布形式 | APK（検証用）／AAB（Play 配布） |

## ローカルビルド

```bash
# 接続端末向け debug APK
./scripts/build_tauri_mobile.sh android debug

# Play 配布向け AAB
PONLET_ANDROID_ARTIFACT=aab ./scripts/build_tauri_mobile.sh android release
```

生成された成果物は Tauri の `apps/tauri/gen/android/app/build/outputs/` 以下に置かれます。Go bridge はビルド時に `scripts/build_tauri_mobile.sh` が生成します。本文ファイルは WebView の JSON や JavaScript に載せず、Rust 側の file source/sink で読み書きします。

## 実機確認

1. USB デバッグを有効にした Android 端末を `adb devices` で確認する。
2. debug APK をインストールして起動する。
3. 招待を作成し、別端末またはブラウザから参加する。
4. テキスト、0 byte を含む小ファイル、日本語名、大容量ファイルを双方向で試す。
5. 受信後の保存先、共有／開く操作、取消、再接続を確認する。
6. Tailcat の状態表示を記録し、WireGuard UDP、WebRTC DataChannel、DERP を別々の条件で検証する。

端末の署名や Play 用 secrets はリポジトリへ保存しません。GitHub Actions の `google_play.yml` には keystore と Play API の secret を設定し、配布前に同じ SHA の AAB と署名結果を記録してください。

## Web との実通信検証

Webとの実通信テストは、起動済みのdebuggableアプリに対して実行します。

```bash
export PONLET_ANDROID_SERIAL='<対象端末のADB serial>'
node tests/e2e/test_android_browser_real.mjs
PONLET_TEST_TRANSPORT=derp node tests/e2e/test_android_browser_real.mjs
node tests/e2e/test_android_browser_cancel.mjs
```

別のapplicationIdでインストールした検証版を対象にする場合は、`PONLET_ANDROID_PACKAGE` をそのIDへ設定します。既定値は `jp.yasagure.ponlet` です。対象packageのプロセスを起動した状態で実行し、別の接続が残っていれば検証版だけを再起動します。

このテストはWebViewのCDPと`run-as`を使用します。CI署名APKと既存Play版の署名が違う場合は上書きできないため、製品版のビルド結果と、別IDの検証版による実機結果を分けて記録します。Androidからのファイル送信はnative APIへのFileRequest渡しで検証しているため、OS pickerでの選択と受信行の「開く」は別に実画面で確認します。

## GitHub Actions

- 配布なし検証: [`.github/workflows/android-build-only.yml`](../.github/workflows/android-build-only.yml)。手動または `v*` tagでunsigned release AAB/APKを生成し、静的検査する。署名秘密、Firebase設定、Play認証、成果物アップロードは使わない。
- Play 配布: [`.github/workflows/google_play.yml`](../.github/workflows/google_play.yml)。手動のみ。tagでは配布しない。Consoleの全trackで最大のversionCodeを確認し、`previous_version_code` に入力する。署名ビルド後、AAB実体のversionCode・カメラ任意設定・native配置を成果物upload前に検査し、Play upload直前にも候補が入力値より大きいことを確認する。
- Tauri Android shell: [`apps/tauri/gen/android`](../apps/tauri/gen/android)
- Build entry: [`scripts/build_tauri_mobile.sh`](../scripts/build_tauri_mobile.sh)

配布なしローカル検証は `./scripts/build_android_verify.sh` を使う。`PONLET_ANDROID_BUILD_ONLY=1` を固定し、既存署名環境変数を解除する。Gradleはこの場合、既存 `google-services.json` があってもGoogle Services／Crashlytics pluginを適用せず、署名設定も使わない。API endpointへuploadする工程はない。生成物はFirebase設定を含むPlay候補と同一ではないため、配布候補は別途検証する。

両workflowの通常検査は [`scripts/verify_android_artifacts.py`](../scripts/verify_android_artifacts.py) のLOAD／ZIP配置、manifest、versionCodeを提出前の停止条件にする。RELROの端数はreportの警告として記録し、これだけで起動不可とは判定しない。`--strict-relro` はRELROを追加の停止条件にする監査用オプションとして残すが、通常workflowでは使わない。静的検査の成功は16KB端末での起動・転送やPlay Console判定の成功を保証しない。警告対象も含めた16KB環境での実行時試験と、配布候補を使ったPlay側の検証は別に記録する。

Android CI版番号は [`scripts/android_version_code.py`](../scripts/android_version_code.py) を使い、`2030000000 + (GITHUB_RUN_NUMBER - 1) × 100 + GITHUB_RUN_ATTEMPT` と、確認済みConsole最大値＋1のうち大きい値を使う。既存Console最大値 `2026093037` を超える開始値を選んだ。別workflowが先行した場合も、その最大値を入力して新しい番号を割り当てられる。attemptは1〜99で、100回目は停止する。run番号700000までは計算式の全attemptがPlay上限2100000000以内に収まる。Console最大値が上限へ達した場合や計算式が上限を超えた場合は停止する。日付や下2桁の循環は使わない。iOSの `set_ci_build_number.sh` は変更しない。

`GITHUB_RUN_NUMBER` はworkflowごとに異なる。別workflowの成果物や古いrunの再実行を新しいPlay版番号として自動的に保証できない。候補が入力したConsole最大値を超えなければupload前に停止する。`previous_version_code` は人が確認した値で、APIから最大値を取得する処理ではない。Console最大値＋1を使ったrunは、同じ入力で再実行すると同じ版番号になり得る。待機中に別の経路から配布された場合や古い入力値のまま再実行した場合、Play側の重複・順序チェックで拒否される可能性がある。配布直前に最大値を再確認し、入力が古ければそのrunを再利用せず新しい手動runへ進む。GitHub release APKの版番号はPlay用に予約した番号ではない。

Play Console の初回登録、署名鍵の保管、内部テストへの段階配布は、対象アプリと現在の Google Play 設定を確認してから行います。
