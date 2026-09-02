# 14. 調査ソースと固定情報

確認日: 2026-09-02

## 1. Tailcat

### Repository

- `https://github.com/tailscale/tailcat`
- 固定commit: `4a25a91e0337252a4d16e097b03cf3cbb92c20cd`
- commit date: 2026-09-01

### README

- `https://github.com/tailscale/tailcat/blob/4a25a91e0337252a4d16e097b03cf3cbb92c20cd/README.md`
- TailcatはTailscale data plane部品をcontrol planeなしで利用するuserspace library／CLI。
- NativeではDirect UDPを試み、失敗時DERP。
- browser demoはWebAssemblyでfile／textを送受信し、browser trafficはDERP-only。
- public DERPはfree／rate-limitedでSLAなし。

### Web bridge

- `https://github.com/tailscale/tailcat/blob/4a25a91e0337252a4d16e097b03cf3cbb92c20cd/web/main_js.go`
- `tailcatListen`、`tailcatDial`をJavaScriptへ公開。
- BrowserはDERPへWebSocket接続。
- connectionは`read`、`write`、`closeWrite`、`close`。
- readはpull-based、64KiB buffer。

### Web application／tests

- `https://github.com/tailscale/tailcat/blob/4a25a91e0337252a4d16e097b03cf3cbb92c20cd/web/app.js`
- `https://github.com/tailscale/tailcat/blob/4a25a91e0337252a4d16e097b03cf3cbb92c20cd/web/wasm_test.go`
- BrowserがListener／Dialerになり、file／textを扱う実装とChromium統合testがある。

### Go module

- `https://github.com/tailscale/tailcat/blob/4a25a91e0337252a4d16e097b03cf3cbb92c20cd/go.mod`
- `go 1.27.0`

### Build tags

- `https://github.com/tailscale/tailcat/blob/4a25a91e0337252a4d16e097b03cf3cbb92c20cd/build-tags.txt`

### Web artifact build

- `https://github.com/tailscale/tailcat/blob/4a25a91e0337252a4d16e097b03cf3cbb92c20cd/internal/wasmbuild/wasmbuild.go`
- `https://github.com/tailscale/tailcat/blob/4a25a91e0337252a4d16e097b03cf3cbb92c20cd/.github/workflows/webdemo-pages.yml`
- raw WASM約27MiBとのworkflow記載があり、GitHub Pagesではgzip版のみを配信。

### License

- `https://github.com/tailscale/tailcat/blob/4a25a91e0337252a4d16e097b03cf3cbb92c20cd/LICENSE`
- BSD-3-Clause。

## 2. Tailcatchat

- `https://github.com/tailscale/tailcatchat`
- `https://github.com/tailscale/tailcatchat/blob/main/README.md`
- `https://github.com/tailscale/tailcatchat/blob/main/web/app.js`

参考点:

- static siteだけでbrowser roomを作成。
- invitationをURL fragmentへ格納。
- invitationを開いたbrowserもListenerを開始。
- encrypted Control Streamで新Listener addressを返す。
- port 100 control、101 text、102 files。
- Browser通信はDERP-only。

TailSendはTailcatchat protocolをそのまま採用せず、対称sessionの成立例として参照します。

## 3. Slint

- Web: `https://docs.slint.dev/latest/docs/slint/guide/platforms/web/`
- Android: `https://docs.slint.dev/latest/docs/slint/guide/platforms/mobile/android/`
- iOS: `https://docs.slint.dev/latest/docs/slint/guide/platforms/mobile/ios/`
- License: `https://slint.dev/pricing`

確認事項:

- RustからWebAssemblyへbuild可能。
- Web UIはCanvas／WebGL中心でDOM／CSS appではない。
- iOSはRust pathを利用。
- AndroidもRust利用可能。
- license／attributionは配布形態に応じて確認が必要。

PoC初期候補version: `1.17.1`。実装開始時にofficial release／crate availabilityを再確認する。

## 4. Cloudflare Workers Static Assets

- `https://developers.cloudflare.com/workers/static-assets/`
- `https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/`
- `https://developers.cloudflare.com/workers/static-assets/headers/`
- `https://developers.cloudflare.com/workers/platform/limits/`

確認事項:

- Workerと同じdeployでstatic assetsを配信可能。
- SPA fallback設定が可能。
- `_headers`を利用可能。
- 調査時点のindividual static asset上限は25MiB。

## 5. Browser APIs

- URL fragment: `https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment`
- File System Access: `https://developer.mozilla.org/en-US/docs/Web/API/File_System_API`
- DecompressionStream: `https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream`
- Page Visibility: `https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API`
- Clipboard: `https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API`

Browser supportは変化するため、MDN表だけで確定せず対象versionを実機testする。

## 6. 参照時の注意

- Tailcat／Tailcatchatは実験的で、mainの内容が変わりうる。必ず固定commitを利用する。
- 本文書は2026-09-02時点の調査結果であり、build開始時にtoolchain availabilityを再確認する。
- raw URLをdependency download scriptへ直書きする場合、SHA-256またはcommitを検証する。
