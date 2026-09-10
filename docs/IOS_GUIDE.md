# Ponlet iOS ビルドと配布

iOS 版は `apps/tauri/gen/apple` の Tauri mobile shell と共通 WebView UI を使います。旧 Swift/Slint shell は削除済みです。

## ビルド

```bash
# iOS Simulator
./scripts/build_ios.sh sim

# 実機用 archive / IPA
./scripts/build_ios.sh device

# 接続済み端末へ debug build をインストール
./scripts/build_ios.sh device-install <UDID>

# XcodeGen 入力を更新
./scripts/build_ios.sh xcode
```

`APPLE_DEVELOPMENT_TEAM` は実行環境から渡します。証明書、provisioning profile、App Store Connect API key は Git に保存しません。TestFlight workflow は [`.github/workflows/testflight.yml`](../.github/workflows/testflight.yml) で Tauri iOS archive を作成します。

## 実機検証

招待、QR、テキスト、ファイル選択、受信保存、取消、再接続を iOS 17 端末で確認します。ファイル本文は WebView の invoke payload に入れず、Rust 側の file handle を使います。端末ロック、Developer Mode、署名期限などで起動できなかった場合は、ビルド成功と実機起動成功を分けて記録します。
