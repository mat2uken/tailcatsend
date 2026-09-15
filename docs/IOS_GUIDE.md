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

## Share Extension

Share Extension は `group.jp.yasagure.ponlet` の App Group に項目を一時保存し、Ponlet 本体が起動・復帰したときに読み取ります。接続していない状態で共有した項目も最大 32 件まで保持し、接続後にテキストまたはファイルとして順番に送信してから削除します。テキストの上限は通信側と同じ 1 MiB です。

Apple Developer で本体の App ID と `jp.yasagure.ponlet.share` の Extension App ID に同じ App Group を追加し、それぞれの実機用署名プロファイルを作成します。CI では本体を `BUILD_PROVISION_PROFILE_BASE64`、Extension を `BUILD_PROVISION_PROFILE_SHARE_BASE64` に登録します。ローカルの配布ビルドでは `PROVISIONING_PROFILE_SPECIFIER` と `PROVISIONING_PROFILE_SPECIFIER_SHARE` を指定してください。

確認手順は、別アプリからテキストとファイルを Ponlet に共有し、共有元へ戻ったあとに未接続なら項目が残ること、接続すると順番に送信されて App Group から消えることです。アプリを終了してから共有した場合も、次回起動後に同じ項目が送信待ちになることを確認します。
