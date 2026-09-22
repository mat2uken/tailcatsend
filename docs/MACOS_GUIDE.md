# macOS のビルドと動作確認

Rust stable、Go 1.27 系、Node.js、Xcode Command Line Tools を用意し、Tailcat submodule を取得します。

```bash
git submodule update --init --recursive
./scripts/build_tauri.sh
./target/release/tailsend
```

`build_tauri.sh` は Go C archive、共通VanJS UI、Tauriアプリをビルドし、`target/release/tailsend` に起動ファイルを置きます。製品の入口は `apps/tauri` です。

アプリを起動したら、招待URLまたはQRコードで相手と接続し、テキストと複数ファイルの双方向転送、キャンセル、受信ファイルを開く操作を確認します。クリップボードとファイル選択も確認してください。接続経路はUDP・WebRTC・DERPを区別し、受信ファイルはサイズとSHA-256を照合します。

ビルド成功と実機での動作確認は分け、検証したcommit・相手端末・OS・接続経路を記録します。自動テストと過去の確認結果は `docs/reviews/` を参照してください。
