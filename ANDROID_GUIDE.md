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

## GitHub Actions

- Workflow: [`.github/workflows/google_play.yml`](.github/workflows/google_play.yml)
- Tauri Android shell: [`apps/tauri/gen/android`](apps/tauri/gen/android)
- Build entry: [`scripts/build_tauri_mobile.sh`](scripts/build_tauri_mobile.sh)

Play Console の初回登録、署名鍵の保管、内部テストへの段階配布は、対象アプリと現在の Google Play 設定を確認してから行います。
