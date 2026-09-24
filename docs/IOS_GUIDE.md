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

受信ファイルの行には「共有」ボタンがあります。iOS の共有シートから「ファイルに保存」または任意の対応アプリを選択して、アプリ外へ保存・送信できます。「開く」は従来どおりプレビューを表示します。

## Share Extension

Share Extension は共有シート内にファイル名・サイズ、テキストの冒頭、接続用QRコードを表示します。相手がQRコードまたはコピーした招待URLを開くか、シートに相手の招待URLを貼り付けて接続すると、そのまま順番に送信します。Ponlet 本体を開く必要はありません。送信状況と完了を同じシートに表示し、「完了」で共有元へ戻ります。テキストの上限は通信側と同じ 1 MiB です。

Extension は `ponlet-share-session` の Rust ライブラリと既存の Go 通信処理を使用します。ファイルは Extension の一時ディレクトリにコピーし、本文をまとめてメモリに読み込まずに送信します。本体の送信待ちキューには新規追加しません。旧版が `group.jp.yasagure.ponlet.k7vnga9k78` に残した項目は、引き続き本体で読み取って送信します。

送信が終わるまでは共有シートを開いたままにしてください。共有元がバックグラウンドに移った場合は中断し、復帰後に再接続します。接続・送信エラー時は、送信済みと判定していない項目を再送できます。「共有を終了」で終了した項目は自動再送されませんが、元のファイルは残ります。現行の転送方式には受信先の保存完了応答がないため、切断直前に届いた項目を再送すると重複する場合があります。

Apple Developer で本体の App ID と `jp.yasagure.ponlet.sharek7vnga9k78` の Extension App ID に同じ App Group を追加し、それぞれの実機用署名プロファイルを作成します。CI では本体を `BUILD_PROVISION_PROFILE_BASE64`、Extension を `BUILD_PROVISION_PROFILE_SHARE_BASE64` に登録します。ローカルの配布ビルドでは `PROVISIONING_PROFILE_SPECIFIER` と `PROVISIONING_PROFILE_SPECIFIER_SHARE` を指定してください。

2026-09-24 に審査提出した Ponlet 1.0.14 の共有拡張 ID は `jp.yasagure.ponlet.share` です。現行のビルド設定（1.0.17）とは異なるため、提出時の署名・実機検証を現行版の確認結果として扱わないでください（`docs/APPSTORE_SUBMISSION_CHECKLIST.md`）。

確認手順は、Files からファイル、別アプリからテキストを Ponlet に共有し、シートが閉じずに内容とQRコードを表示すること、接続後に進捗・完了を表示すること、相手側の受信内容が一致することです。QRコード側と招待URL貼り付け側の両方、送信中の終了、バックグラウンド移行、接続失敗後の再試行も確認します。ビルド成功、端末へのインストール、シート表示、受信側の内容確認は別々に記録します。

macOS 用の Go archive `target/native/tailcat/libtailcat.a` がある環境では、次のテストで C API から既存の受信処理へファイル・テキストを送信し、受信内容と接続前キャンセルを確認できます。実ネットワークを使用するため、通常のユニットテストとは分けています。これは iPhone 上の UI やメモリ使用量の検証を代替しません。

```bash
RUSTFLAGS='-L native=target/native/tailcat' cargo test -p ponlet-share-session \
  --features native-interop-tests --test native_interop
```
