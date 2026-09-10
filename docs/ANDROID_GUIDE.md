# Android ビルド・実機検証ガイド

Android 製品入口は Tauri mobile WebView です。詳細な配布手順はリポジトリ直下の [ANDROID_GUIDE.md](../ANDROID_GUIDE.md) を参照してください。

```bash
./scripts/build_tauri_mobile.sh android debug
PONLET_ANDROID_ARTIFACT=aab ./scripts/build_tauri_mobile.sh android release
```

検証時は、招待、テキスト、ファイル選択、受信保存、取消、再接続を実機で確認し、Tailcat の WireGuard UDP／WebRTC DataChannel／DERP を分けて結果を記録します。秘密鍵、keystore、Play API JSON は Git に追加しません。
