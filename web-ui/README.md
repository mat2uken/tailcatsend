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

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run build -- --mode web
npm run build -- --mode tauri
```

リポジトリの`./scripts/build_web_ui.sh`でも以上を実行できる。テストは既存ViteでTypeScriptを読み込み、Nodeの標準test runnerから実行する。

APIの変換、既存UIとの比較、更新機能へ接続する順序は[移行状態](../docs/WEBVIEW_MIGRATION.md)と[レビュー記録](../docs/WEBVIEW_REVIEW.md)を参照。
