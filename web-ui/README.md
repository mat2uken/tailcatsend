# Ponlet WebView UI

VanJSとTypeScriptで実装した共通UI。`web` modeは`dist/web`、`tauri` modeは`dist/native`へ出力する。同じUIから`@backend`でadapterの入口を選ぶ。Vite 8、esbuild、Oxlint、Oxfmt、Vitestはvanjslitetemplateの構成に合わせ、実行時依存は`vanjs-core`とTauri APIだけに絞っている。

ブラウザmodeは起動時にGo Tailcat WASMをWindowへ読み込み、Rust WASMサービスをDedicated Worker内で初期化する。Rust側が招待、handshake、NAME形式の転送、進捗、取消、OPFS保存を担当し、WorkerとWindowの間はMessagePortとTransferableなArrayBufferで接続する。Workerを利用できない古いWebViewでは従来の同一Window adapterへ切り替える。必要なWASMがない場合は送受信成功を作らず、画面にエラーを表示する。Tauri modeは同じUIからTauri command/event adapterを使用する。

- `src/api/`: UIが利用する型とAPI版の検査。
- `src/backend.ts`: 注入されたadapterの確認とブラウザ操作の補助。
- `src/backends/browser.ts`: Go bridgeとRust WASMサービスの起動。
- `src/backends/tauri.ts`: Tauri command/event adapter。
- `src/session.ts`: snapshotとイベントの順序、重複除外、表示状態、終了。
- `src/main.ts`: DOMとユーザー操作。
- `src/opfs.ts`: WorkerとWindowで共有するファイル単位の途中保存・確定・取消。
- `src/worker.ts`: Rust service、Go bridge proxy、Transferable bufferの上限を扱うDedicated Worker entry。
- `src/update/`: P-256署名、manifest、ファイルサイズ／SHA-256の検査と、検証済み版を次回起動用へ保存する処理。
- `web-public/ponlet-sw.js`: 保留版を次回のナビゲーションで有効化する最小Service Worker。実運用では`window.__PONLET_UPDATE_CONFIG__`へPagesのmanifest URL、署名URL、公開鍵、revisionを注入する。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run build -- --mode web
npm run build -- --mode tauri
```

リポジトリの`./scripts/build_web_ui.sh`でも以上を実行できる。テストはVite設定を共有するVitestで実行する。

更新設定がない場合、ブラウザはネットワークへ接続せず内蔵版をそのまま起動する。更新設定を使う場合も、実行中の画面は置き換えず、全ファイルの検査後に次回ナビゲーションで切り替える。Tauri WebViewでは更新確認を無効にしてアプリ内のbundleを使う。Pages workflow は `scripts/write_web_update_config.mjs` と `scripts/write_web_update_manifest.mjs` を呼ぶ。`PONLET_UPDATE_PRIVATE_KEY_PEM` secret がある場合は、dist内のファイル一覧、SHA-256、manifest、P-256署名を生成し、公開鍵は秘密鍵から導出する。外部のmanifestを使う場合は `PONLET_UPDATE_MANIFEST_URL`、`PONLET_UPDATE_SIGNATURE_URL`、`PONLET_UPDATE_PUBLIC_KEY_JWK` などの repository variables を指定できる。秘密鍵はログや成果物へ出力しない。

APIの変換、既存UIとの比較、更新機能へ接続する順序は[移行状態](../docs/WEBVIEW_MIGRATION.md)と[レビュー記録](../docs/WEBVIEW_REVIEW.md)を参照。
