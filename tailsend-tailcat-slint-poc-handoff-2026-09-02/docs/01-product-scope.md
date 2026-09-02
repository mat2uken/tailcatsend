# 01. 製品スコープとPoC要件

## 1. 目的

TailSend PoCは、LocalSendに近い簡潔な操作感を持ちながら、同一LANやアカウントに依存せず、QRコードだけで2端末を一時接続し、テキストとファイルを双方向転送できることを検証します。

LocalSendとのプロトコル互換は要求しません。参考にするのは以下の体験です。

- 送る内容を選ぶ
- 相手を簡単に選ぶ
- 相手が内容を確認して受け入れる
- 転送状況と結果が明瞭に分かる
- 操作にネットワーク知識を要求しない

## 2. 対象プラットフォーム

### P0実装対象

- Web: Chrome／Edge desktop、Chrome Android
- Web互換性対象: Safari macOS、Safari iOS
- Native desktop: Windows x64／arm64を考慮、macOS arm64
- Native mobile: Android arm64、iOS arm64（foreground動作）

### P1以降

- Android／iOSのOS共有拡張、background常時受信、Store品質のpackaging
- Linux正式対応
- Store配布

PoCの早期Vertical SliceはWeb↔Webで作り、その後Desktop Native↔Web、Android／iOS Native↔Webへ段階的に進めます。最終P0はWindows、macOS、Android、iOS、Webを実動対象とし、mobileは物理端末でforeground転送を検証します。

## 3. P0ユーザーストーリー

### US-01 セッション作成

ユーザーとして、アプリまたはWebページを開くだけでQRコードを表示し、相手がそのQRを読み取って接続できるようにしたい。

### US-02 セッション参加

ユーザーとして、QRコードを標準カメラで読み取り、インストール不要のWebページから自動的に相手へ接続したい。

### US-03 対称な送受信

ユーザーとして、QRを表示した側か読み取った側かに関係なく、接続後はどちらからでも送信したい。

### US-04 テキスト転送

ユーザーとして、日本語、改行、絵文字、URLを含むテキストを送信し、相手側で承認・表示・コピーしたい。

### US-05 ファイル転送

ユーザーとして、単一または複数ファイルを選び、相手に名前・件数・サイズを確認してもらってから転送したい。

### US-06 進捗とキャンセル

ユーザーとして、転送量、割合、速度、完了・失敗を確認し、途中でキャンセルしたい。

## 4. P0機能

### 接続

- 招待なし起動時にTailcat Listenerを開始する。
- Cloudflare上のWeb URLを含むQRコードを生成する。
- 招待URLをクリップボードへコピーできる。
- 招待URLありで起動したPeerは自分のListenerを開始してHostへ接続する。
- アプリケーションレベル認証後に双方のListener addressを交換する。
- 1セッションにつき相手は1Peerだけ受け入れる。
- 切断後は新しいセッション／招待を生成できる。

### テキスト

- UTF-8送受信。
- 初期上限1MiB。
- 受信前に送信者、種別、文字数を表示。
- 承認／拒否。
- 受信後にコピー。

### ファイル

- 単一／複数ファイルを選択。
- 送信前にメタデータをOffer。
- 受信側が転送全体を承認／拒否。
- ファイルは順次送信。
- ストリーミングI/O。
- 進捗、速度、キャンセル。
- 一時ファイルへ保存し、完全受信後に確定。
- 同名時は安全な自動リネーム。
- 0byte、Unicode名、1GiBを考慮。

### UI

- Create／Joinを意識させない自動遷移。
- QR待受画面、接続中画面、Connected画面、受信確認Dialog、転送進捗。
- Native／Webで共通のSlint componentを利用。
- mobile／desktopでresponsive layout。
- Light／Dark／System themeは、工数が大きければSystem themeだけでもよい。

## 5. 明確なP0対象外

- LocalSend互換プロトコル
- LAN内自動探索
- 6桁コード等のrendezvous service
- アカウント／クラウド同期
- オフライン配送
- Cloudflareへのファイルアップロード
- 同時に複数Peerへ接続
- 同時に複数転送
- 転送再開
- フォルダー転送
- 永続ペアリング
- 常時バックグラウンド受信
- Native側のQRカメラスキャナー
- PWA必須化
- Explorer／Finderの高度なshell extension
- Store配布

## 6. P1候補

- フォルダー再帰送信
- OS共有からTailSendへ投入
- TailSendからOS共有へ送る
- Native JoinerをUniversal Link／App Linkで起動
- 永続ペアリング
- Quick Save
- 転送履歴の永続化
- SHA-256完全性検証
- offsetベースの転送再開
- 複数ファイルの部分承認
- 複数同時転送
- self-hosted DERP

## 7. 非機能要件

### メモリ

- ファイルサイズに比例してRSS／WASM memoryが増えない。
- P0 chunk sizeは64KiBを初期値とする。
- 未処理queueをboundedにする。
- 1転送あたりのアプリ層buffer budgetは8MiB以下を目標とする。

### 性能

- UI threadでI/O、hash、blocking FFIを行わない。
- 進捗UIは30〜100ms程度へthrottleする。
- public DERPの速度は合否条件にしない。
- 1GiB試験では完走、メモリ安定性、キャンセル応答、データ長一致を評価する。

### 信頼性

- 接続タイムアウトを明示する。
- peer tab close／app closeを検知して切断表示する。
- Network変更時はP0では安全に失敗し、再QR接続可能にする。
- 一時ファイルを異常終了後に識別・削除できる。

### セキュリティ

- ConnBlob、invite secret、private keyを通常ログへ出さない。
- QR invitationは期限付き・session限定。
- Tailcat暗号化に加えてapplication-level invitation proofを検証する。
- ファイル名をbasename化し、`..`、絶対path、NUL、危険な長さを拒否する。
- control payload、text、file count、filename length、declared sizeへ上限を持つ。
- 受信承認前にfile dataを受け入れない。

### 保守性

- Tailcat commitを固定。
- TransportとProtocolを分離。
- Native／Webで同じprotocol conformance testsを通す。
- P1実装をP0コードへ先回りして複雑化しない。

## 8. PoC完了条件

PoCは以下を満たした時点で完了とします。

1. Web Host↔Web JoinerがQRで接続し、双方向テキスト送信できる。
2. Web↔Webで小容量ファイルを双方へ送れる。
3. Windows Native↔Web、macOS Native↔Webで同じ操作ができる。
4. 受信承認、拒否、キャンセル、切断、エラー表示が機能する。
5. Chrome／Edge desktopとNative間で1GiBをストリーミング転送できる。
6. Safari macOS／iOSで接続、テキスト、小〜中容量ファイルを検証し、制約を文書化する。
7. Cloudflareは静的アセット以外を保持していないことを確認する。
8. 自動テスト、相互接続テスト、手動テストレポートが残る。
