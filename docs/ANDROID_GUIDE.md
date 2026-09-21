# Android ビルド・実機検証ガイド

Android 製品入口は Tauri mobile WebView です。詳細な配布手順はリポジトリ直下の [ANDROID_GUIDE.md](../ANDROID_GUIDE.md) を参照してください。

```bash
./scripts/build_tauri_mobile.sh android debug
PONLET_ANDROID_ARTIFACT=aab ./scripts/build_tauri_mobile.sh android release
```

検証時は、招待、テキスト、ファイル選択、受信保存、取消、再接続を実機で確認し、Tailcat の WireGuard UDP／WebRTC DataChannel／DERP を分けて結果を記録します。秘密鍵、keystore、Play API JSON は Git に追加しません。

Webとの実通信テストは、起動済みのdebuggableアプリに対して実行します。

```bash
export PONLET_ANDROID_SERIAL='<対象端末のADB serial>'
node tests/e2e/test_android_browser_real.mjs
PONLET_TEST_TRANSPORT=derp node tests/e2e/test_android_browser_real.mjs
node tests/e2e/test_android_browser_cancel.mjs
```

別のapplicationIdでインストールした検証版を対象にする場合は、`PONLET_ANDROID_PACKAGE` をそのIDへ設定します。既定値は `jp.yasagure.ponlet` です。対象packageのプロセスを起動した状態で実行し、別の接続が残っていれば検証版だけを再起動します。

このテストはWebViewのCDPと`run-as`を使用します。CI署名APKと既存Play版の署名が違う場合は上書きできないため、製品版のビルド結果と、別IDの検証版による実機結果を分けて記録します。Androidからのファイル送信はnative APIへのFileRequest渡しで検証しているため、OS pickerでの選択と受信行の「開く」は別に実画面で確認します。
