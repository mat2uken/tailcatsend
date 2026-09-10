# Ponlet WebView UI

VanJSとTypeScriptによる移行用UI。`web` modeは`dist/web`、`tauri` modeは`dist/native`へ出力する。同じUIから`@backend`でadapterの入口を選ぶ。

現在はTauri shell、Worker bootstrap、実通信adapterが未実装。初期化済みの`window.__ponletBackend`を渡す仕組みを想定しているが、未接続の場合は送受信不可を表示し、成功イベントを作らない。

- `src/api/`: UIが利用する型とAPI版の検査。
- `src/backend.ts`: 注入されたadapterの確認とブラウザ操作の補助。
- `src/session.ts`: snapshotとイベントの順序、重複除外、表示状態、終了。
- `src/main.ts`: DOMとユーザー操作。
- `src/opfs.ts`: ファイル単位の途中保存・確定・取消。Workerへは未接続。
- `src/worker.ts`: 今後使うメッセージ型。Worker実行本体ではない。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run build -- --mode web
npm run build -- --mode tauri
```

リポジトリの`./scripts/build_web_ui.sh`でも以上を実行できる。テストは既存ViteでTypeScriptを読み込み、Nodeの標準test runnerから実行する。

APIの変換、既存UIとの比較、更新機能へ接続する順序は[移行状態](../docs/WEBVIEW_MIGRATION.md)と[レビュー記録](../docs/WEBVIEW_REVIEW.md)を参照。
