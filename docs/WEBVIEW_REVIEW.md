# WebView移行レビュー記録

対象は`feature/common-rust-transfer-engine`。共通Rust転送基盤、Web UIツールチェーン、Tauri native adapterはそれぞれ`3d6400a`、`0cc621c`、`90e2c91`以降へコミット済みである。以下の実機・配布・性能項目は現在のコミットで再確認していない。

## レビュー判断

共通転送、状態管理、C ABI、保存、署名検証は移行の部品として利用できる形へ改善した。TauriデスクトップではVanJS UIから共通Rust転送・Go C ABIへ接続するadapterを追加した。Browserでは旧Slint WASMを共通Rust service WASMへ置き換え、Go Tailcat bridgeの起動後にVanJS UIへ接続する構成へ更新した。Dedicated Worker分離、旧ネイティブアプリの削除、Pagesの実デプロイ、実機転送は未完了である。

優先して修正した不具合は次の通り。

| 優先度 | 不具合 | 修正箇所 |
| --- | --- | --- |
| P1 | backendがないのに接続・送信完了を表示 | `web-ui/src/backend.ts` |
| P1 | 保存先の準備後にヘッダーエラーになるとabortされず、最後の進捗後の取消でも保存を確定 | `tailsend-transfer/src/live.rs` |
| P1 | OPFSの失敗・同時書き込み・確定中の取消で途中保存が残る、または確定される | `web-ui/src/opfs.ts` |
| P1 | Goの終了・再初期化、dial完了・取消、clientの解放が競合 | `tailcat/bridge/native/bridge.go` |
| P1 | Rustの標準時刻処理がWASMで実行できない | `tailsend-core/src/service.rs` |
| P2 | 購読開始時の状態欠落、重複テキスト、別転送の終了通知による表示消去 | `tailsend-core/src/service.rs`、`web-ui/src/session.ts` |
| P2 | class実装のbridgeメソッドがspreadで失われる、非同期エラーやクリップボード失敗が表示に出ない | `web-ui/src/backend.ts`、`main.ts` |
| P2 | テキスト受信が接続終了まで通知されず、メッセージを貯め続ける | `tailsend-transfer/src/live.rs` |
| P2 | 署名が正しくても別対象・旧revision・非互換APIを選べる、移植先によって意味が変わるパスを許す | `tailsend-updates/src/lib.rs` |
| P2 | 通常のcargo testで転送テストが0件になり、Web UIにも回帰テストがない | `tailsend-transfer/Cargo.toml`、`web-ui/tests/` |
| P1 | Browser UIが旧Slint WASMを前提にし、共通Rust serviceを呼ばない | `apps/web/src/lib.rs`、`web-ui/src/backends/browser.ts`、`.github/workflows/deploy_pages.yml` |

WASM時刻処理の選択には[web-timeの仕様](https://docs.rs/web-time/latest/web_time/)を確認し、実際にWASMへビルドして実行した。

## 検証結果

| 確認 | 結果 | 確認できる範囲 |
| --- | --- | --- |
| Rust unit tests | 36件成功 | core 12 / transfer 17 / updates 5 / native bridge 2 |
| 共通Rustのwasm32 check | 成功 | core / transfer / updatesのコンパイル |
| Go native unit tests | race検査込みで成功 | 部分write、取消、generation、並行init/shutdown |
| Go daemon build | 成功 | macOSで`tailcat_daemon` tagの生成 |
| Web UI tests | 16件成功、import解決警告なし | bridge、イベント順序、OPFS、popover位置 |
| TypeScript / Vite | 成功 | 型検査、web/tauri両mode |
| Tauri native build | 成功 | macOSでGo c-archive生成後に`apps/tauri`をリンク。UI bundle、commands、event DTOを含む |
| Browser Rust WASM bindgen | 成功 | `apps/web`を`wasm32-unknown-unknown --release`でビルドし、`wasm-bindgen --target web`を実行。生成WASMは約260 KiB、gzip約100 KiB |
| Browser VanJS production bundle | 成功 | `web-ui`のweb/tauri両modeをVite 8で生成。UI JavaScriptは約18 KiB |
| ローカルWeb UI表示 | 成功 | backend未接続表示、送信・ファイル選択・接続ボタンの無効化 |
| 旧Web appのwasm32 check | 成功 | 既存Slintアプリとのコンパイル互換 |
| 旧desktop appのcheck | 成功 | 共通crateとSlintアプリのコンパイル互換。警告なし |
| Android / iOS / iOS Simulator check | 成功 | 各targetでのRustコンパイル。Androidには未使用importのwarningが3件ある |
| WASM実行smoke | 成功 | Node上で招待状態、時刻、進捗間引き、flush、sequenceを確認 |
| Native C ABI smoke | 成功 | Go c-sharedを実ヘッダーでCからリンク。init/version/shutdown/reinit |
| 静的検査 | 成功 | 変更した4 workflowのactionlint、build_web_ui.shのshellcheck、各変更shellの構文、Rust整形と差分の空白 |

ローカルWeb UI表示は、このリポジトリの`web-ui`をcwdとして専用Viteを`http://127.0.0.1:4181/`で起動して確認した。検証後に終了している。

WASM実行smokeの一時ソースと生成物は`/tmp/tailsend-wasm-smoke`、C ABI smokeは`/tmp/tailcat-c-abi-smoke`に置いた。WASM側の出力は`state_seq=1,progress_seq=2,flush_seq=3,snapshot_seq=3,done=3`、C側の版取得は`tailcat-bridge/abi2/dev`だった。一時生成物はGitへ追加していない。

Tauri native buildの成功はリンク確認であり、Go bridgeを使った2端末間の実転送や、DERP・WebRTC DataChannel・WireGuard UDPの経路選択を証明するものではない。これらはWebView製品版の実機・速度・省メモリ性と同じく未検証である。

## 置換前に残る比較

旧UIの確認元は`ui/app-window.slint`と各`apps/*/src`のcallbackである。

| 既存機能 | 新Web UIの状態 | 必要な確認 |
| --- | --- | --- |
| 招待URL・QR表示・再生成・カメラ読取・貼り付け接続 | URL入力とボタンのみ。実通信未接続 | 同じ招待形式・有効期限、QRとdeep link |
| テキスト送受信・Paste & Send・履歴消去 | 入力・表示・copy/share/saveの入口のみ | 双方向通信、IME、改行、貼り付け、履歴と各OS操作 |
| ファイル送受信・取消 | UIと共通engineが別々に存在 | transport/file adapter、保存完了、取消、ディスク不足、0-byte/大容量 |
| 保存先表示・パスcopy・受信ファイルshare | 未移植 | 同じ保存先とOSの共有・開く操作 |
| 言語切替・telemetry設定・接続経路・速度表示 | OS言語判定と簡易画面のみ | 現行設定の保持と全表示項目 |
| Tauriからのtailcat利用 | `apps/tauri`のcommands、Go C ABI、共通Rust転送へ接続。`scripts/build_tauri.sh`でGo archiveを先に生成 | 実機での起動、再起動、終了、各OSリンク、実転送 |
| ブラウザWASM/Worker | Browser Rust WASMとGo bridgeは実装・bindgen確認済み。Dedicated Worker本体は未接続 | Worker移設、メッセージ処理、バッファ再利用、送信量の制御 |
| Pagesから新しいUI/WASMを取得 | 検証関数のみ | manifest作成、取得、完全性確認、一括切替、内蔵版への復元 |

実転送の比較では旧版・新版の送信側/受信側を同時に記録し、バイト数、SHA-256、保存先のファイル、取消結果、所要時間、メモリ使用量を同じ条件で確認する。送信側が書き終わったことだけを受信保存の成功として扱わない。
