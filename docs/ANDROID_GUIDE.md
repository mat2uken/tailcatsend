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

- Workflow: [`.github/workflows/google_play.yml`](../.github/workflows/google_play.yml)
- Tauri Android shell: [`apps/tauri/gen/android`](../apps/tauri/gen/android)
- Build entry: [`scripts/build_tauri_mobile.sh`](../scripts/build_tauri_mobile.sh)

Play Console の初回登録、署名鍵の保管、内部テストへの段階配布は、対象アプリと現在の Google Play 設定を確認してから行います。
