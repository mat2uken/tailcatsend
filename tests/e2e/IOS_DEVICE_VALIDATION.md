# iOS実機とWebの通信検証

インストールするIPA、実機、接続先Webを実行ごとに記録する。
WebViewのUAに含まれるOS番号ではなく、`devicectl device info details` のOS番号を採用する。

## 準備

1. `git status --short --branch`、`git rev-parse HEAD`、IPAのSHA-256と署名を確認する。
2. 使用する実機のUDIDを明示し、ロック解除を確認する。既定の先頭端末を使わない。
3. 必要な場合だけ、そのIPAをインストールする。起動オプションはbundle IDより前に置く。

```sh
export PONLET_IOS_UDID='<使用を許可された端末のUDID>'
export PONLET_IOS_CDP_PORT=9236
xcrun devicectl device info lockState --device "$PONLET_IOS_UDID"
xcrun devicectl device process launch \
  --device "$PONLET_IOS_UDID" --activate --timeout 30 jp.yasagure.ponlet
```

端末のWeb Inspectorが利用可能な環境で、以下を別のterminalから実行する。
他の検証で利用しているポートや共有サービスを置き換えない。

```sh
pymobiledevice3 webinspector cdp \
  --udid "$PONLET_IOS_UDID" --host 127.0.0.1 --port "$PONLET_IOS_CDP_PORT"
```

テストはこの専用プロセスのUDID/ポートと、実ページの `tauri://localhost`、iPhone/iPadのplatform・UAを確認する。
`/json/version` の一般的なSafari情報や、ポート番号だけで端末を判定しない。

## 実行

`web-ui` のPlaywrightとChromiumを使用する。公開Webが既定で、別の配信先を使う場合はURLを明示する。

```sh
export PONLET_TEST_WEB_URL=https://ponlet.mat2uken.app/
export PONLET_TEST_OUTPUT=/tmp/ponlet-ios-validation/default
node tests/e2e/test_ios_browser_real.mjs

PONLET_TEST_OUTPUT=/tmp/ponlet-ios-validation/derp \
PONLET_TEST_TRANSPORT=derp node tests/e2e/test_ios_browser_real.mjs
```

各回でQR再生成を2回行い、招待URLが変わること、双方向テキスト、双方向131071バイトのファイルを検査する。
実機側の保存内容は `devicectl device copy from` でPonletの保存領域から取得し、Web側はダウンロードした内容のSHA-256を照合する。
同名のテキストを2回送り、両方の保存後に再読込して、内容・名前・保存先がそれぞれ維持されることを検査する。
DERP指定時はWeb側のWebRTCを無効にし、両端がDERPと報告することも検査する。

成功時は `identity.json`、`result.json`、取得したファイルとWebViewの画面画像を指定ディレクトリに残す。
コマンドの終了状態も記録する。再実行は出力先を変え、過去の成功記録を上書きしない。

## 別に確認する操作

この通信テストのiOSからのファイル送信は、受信済みファイルのFileRequestをnative APIへ渡す。
Web InspectorのCDP変換でスクロール後のclick位置がずれる場合があるため、iOS側のボタンは有効になるのを待ってDOMからclickする。指による操作の検証とは区別する。
OSファイル選択、受信ファイルの内容表示、カメラ映像、光学的なQR読取、転送取消の成功はこの結果から判断しない。
それぞれ実際のOS画面・保存内容・受信側の結果を確認する。

ロック、許可画面、検証用接続の不具合は、製品側の通信不具合と分けて記録する。
終了後は自分が起動した専用CDPを終了し、端末をPonletの通常画面へ戻す。
