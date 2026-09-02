# TailSend Tailcat + Slint PoC 開発引き継ぎパッケージ

更新日: 2026-09-02  
文書言語: 日本語  
仮称: **TailSend**

## 1. このパッケージの目的

このパッケージは、Tailcatを通信基盤、Slintを共通UI基盤として、Native／Webのどの組み合わせでもQRコードを起点に一時セッションを確立し、テキストとファイルを双方向転送するPoCを、コーディングエージェントが直ちに着手できる粒度へ整理したものです。

PoCの中心仮説は次の3点です。

1. Webブラウザを含む双方でTailcat Listenerを起動し、招待URLを開いた側が自分のListener addressを暗号化Control Streamで返せば、接続後は対称Peerとして扱える。
2. Slint UI、Rustの状態管理、招待・セッション・転送プロトコルを共通化し、TailcatとOS機能だけをAdapterとして分離できる。
3. ブラウザを含む経路はDERP relayのみでも、テキストと大容量ファイルをストリーミング転送できる。

## 2. 最初に読む順序

1. `docs/01-product-scope.md` — PoCの範囲と完了条件
2. `docs/02-user-flows-and-ui.md` — QR起点の操作フローと画面
3. `docs/03-system-architecture.md` — 全体アーキテクチャ
4. `docs/04-invitation-and-session.md` — 招待URL、認証、接続確立
5. `docs/05-transfer-protocol.md` — テキスト／ファイル転送仕様
6. `docs/06-tailcat-integration.md` — Native／Web Tailcat統合
7. `docs/07-slint-ui.md` — Slint共通UI設計
8. `docs/08-platform-adapters.md` — OS／Web固有処理
9. `docs/09-cloudflare-deployment.md` — Cloudflareへの静的配信
10. `docs/10-testing-and-acceptance.md` — テストと合格条件
11. `docs/11-implementation-plan.md` — 実装順序
12. `prompts/CODEX_MASTER_PROMPT.md` — 開発開始用の指示プロンプト

機械可読な補助仕様は`spec/`、境界APIのたたき台は`interfaces/`にあります。

## 3. 固定する上流バージョン

PoC開始時点では、再現性を優先して以下を固定します。

- Tailcat repository: `https://github.com/tailscale/tailcat`
- Tailcat commit: `4a25a91e0337252a4d16e097b03cf3cbb92c20cd`
- Tailcatが要求するGo: `1.27.0`
- Slint: `1.17.1`を初期候補として固定。実装開始時にcrateの取得可能性とRust MSRVを確認し、変更する場合はADRへ記録する。
- Public DERP map: `https://tailcat.dev/derpmap.json`
- Web deployment: Cloudflare Workers Static Assets

上流の`main`を直接追従しないでください。依存更新は別コミットとし、相互接続テストを通してから採用します。

## 4. 最小PoCの一文仕様

> NativeまたはWebを招待なしで起動すると、エフェメラルなTailcat Listenerを開始してCloudflare上のWeb URL形式のQRコードを表示する。別端末がQRを読み取ると同じWebアプリがJoinerとして起動し、自身のListenerを開始したうえでHostへ接続し、認証済みControl Streamで双方のListener addressを交換する。接続後はNative／Web、Host／Joinerを区別せず、同じSlint UIとセッションプロトコルを使い、どちら側からでもテキストまたはファイルを送受信する。

## 5. P0で必ず守る境界

- アカウント、LAN探索、短縮コード、中央セッションDBを作らない。
- CloudflareはHTML／JavaScript／WASM等の静的配信だけを行い、招待・鍵・ファイルを保持しない。
- QRにはHTTPS URLを格納し、招待データはURL fragmentに置く。
- 両PeerはListenerを持つ。Host／Joinerは開始時の役割に過ぎない。
- 接続後のPeerは対称で、どちらからでも送信できる。
- テキストはP0、ファイルはP0、フォルダーはP1。
- 同時Peerは1、同時転送は1。転送再開、永続ペアリング、バックグラウンド受信はP1以降。
- ファイル全体をメモリへ載せない。1GiBをChrome／Edge desktopとNative間で検証する。
- iOSは前景中のみをP0として許容する。
- ブラウザを含むTailcat経路はDERP-onlyとして扱う。

## 6. 実装時に最初に潰す技術リスク

1. Tailcat Go libraryをWindows／macOS Native向けC ABIに安全にラップできるか。
2. Tailcat Go WASMとSlint Rust WASMを同一ページで安定稼働させられるか。
3. Web HostとWeb Joinerが互いのListener addressを交換し、双方向に新規streamを開けるか。
4. Rust WASMとGo WASMの境界で、大容量データを不必要に往復コピーせずに済むか。
5. Cloudflare配信時に、圧縮Tailcat WASMのサイズ・MIME・キャッシュ・CSPが正しく機能するか。
6. Safari／iOS SafariでTailcat WASMのlisten／dialと小容量ファイル転送が成立するか。

## 7. 実装者への重要な指針

- まずVertical Sliceを通し、全画面やP1機能を先に作らない。
- UIからTailcat型、Go handle、JavaScript objectを見せない。
- Protocol crateはTransport非依存にする。
- NativeとWebの差を「Transport」「File I/O」「Startup URL」「Clipboard」Adapterへ閉じ込める。
- Web大容量転送がRust WASM↔JS↔Go WASMを多重コピーする場合、UI共通化よりストリームの健全性を優先し、Webのbulk data pumpだけJavaScript／Go側へ置くことを許容する。
- 実装していない機能をスタブの成功値でごまかさない。未実装は明示的な`Unsupported`にする。
- エラーを握り潰さず、ユーザー向けエラーと診断情報を分離する。

## 8. 成果物

最初のPoC完了時に最低限必要な成果物は以下です。

- Windows Native Host／Peer
- macOS Native Host／Peer
- Cloudflareに配信可能なWeb Host／Peer
- Browser↔Browser、Native↔BrowserのQR接続
- 双方向テキスト送受信
- 受信承認付き双方向ファイル送受信
- 転送進捗、キャンセル、失敗表示
- 1GiBストリーミング試験結果
- Safari互換性試験結果
- 自動テストと手動テストレポート
- Native mobile向けAdapter skeletonとビルド可否記録

実装順序は、Windows／macOS／Webでプロトコルを安定させてからAndroid／iOSへ広げることを推奨します。ただし共通Coreと境界APIは最初からmobileを考慮します。
