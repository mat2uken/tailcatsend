# Codex開発開始用マスタープロンプト

以下を、そのままコーディングエージェントへ渡してください。ZIPも同時に渡し、展開した文書を参照できる状態にします。

---

あなたは、TailcatとSlintを利用したクロスプラットフォーム送受信アプリ「TailSend」のPoCを実装するリードエンジニアです。添付された`tailsend-tailcat-slint-poc-handoff-2026-09-02.zip`を展開し、内容を設計入力として、計画だけで終わらず実装・ビルド・テストを開始してください。

## 1. 最初に行うこと

1. 現在のrepositoryを調査し、既存コード、未commit変更、build system、利用可能toolchainを把握してください。ユーザーの既存作業を破壊しないでください。
2. ZIPをrepository内の`handoff/`等へ展開するか、すでに展開済みなら場所を確認してください。
3. 次の順で必ず読んでください。
   - `START_HERE.md`
   - `docs/01-product-scope.md`
   - `docs/02-user-flows-and-ui.md`
   - `docs/03-system-architecture.md`
   - `docs/04-invitation-and-session.md`
   - `docs/05-transfer-protocol.md`
   - `docs/06-tailcat-integration.md`
   - `docs/07-slint-ui.md`
   - `docs/08-platform-adapters.md`
   - `docs/09-cloudflare-deployment.md`
   - `docs/10-testing-and-acceptance.md`
   - `docs/11-implementation-plan.md`
   - `docs/12-risks-and-decisions.md`
   - `docs/13-repository-layout.md`
   - `spec/*.cddl`
   - `spec/poc-spec.yaml`
4. 文書を読んだ後、repositoryの現状、採用する構成、最初のVertical Slice、検出したblockerを簡潔に報告してください。
5. 報告だけで止まらず、直ちにPhase 0とPhase 1の実装を開始してください。安全性または本質的な仕様矛盾がない限り、確認待ちにしないでください。

## 2. 仕様の優先順位

矛盾がある場合は次の順で扱ってください。

1. `spec/invitation.cddl`と`spec/control-protocol.cddl` — wire format
2. `spec/poc-spec.yaml` — scope／limit／target
3. `docs/04-invitation-and-session.md`、`docs/05-transfer-protocol.md`
4. その他の設計文書
5. このプロンプト

矛盾を見つけた場合は、勝手に複数解釈を実装せず、最小で安全な解釈を選び、`docs/decisions/ADR-*.md`へ記録してください。

## 3. 最終目標

NativeまたはWebを招待なしで起動すると、エフェメラルなTailcat Listenerを開始してCloudflare上のWeb URL形式のQRコードを表示します。別端末がQRを読み取ると同じWebアプリがJoinerとして起動し、自身のListenerを開始してHostへ接続します。HMAC認証済みControl Streamで双方のListener addressを交換し、接続後はHost／Joiner、Native／Webを区別しない対称Peerとして、どちらからでもテキストまたはファイルを送受信します。

Cloudflareは静的アセット配信だけを担当し、招待、秘密鍵、セッション、テキスト、ファイルを保存・中継しません。

## 4. 固定条件

- Tailcat repository: `https://github.com/tailscale/tailcat`
- Tailcat commit: `4a25a91e0337252a4d16e097b03cf3cbb92c20cd`
- Go: Tailcatが要求する`1.27.0`
- DERP map: `https://tailcat.dev/derpmap.json`
- Slint: 初期候補`1.17.1`。取得不能やMSRV問題があれば検証結果と変更理由をADRへ記録する。
- Tailcat／Tailscaleの`main`や`latest`を直接参照しない。
- Cargo.lock、Go dependency、Node lockfileをcommitする。
- Public DERPはPoC限定として利用する。

## 5. P0範囲

必須:

- Web Host↔Web Joiner
- Windows Native Host↔Web Joiner
- macOS Native Host↔Web Joiner
- Android Native Host↔Web Joiner（foreground）
- iOS Native Host↔Web Joiner（foreground、physical device testは環境がある場合）
- QR invitation URL
- invitation link copy
- 双方向text
- 双方向file
- offer／accept／reject
- progress／cancel
- bounded streaming
- Cloudflare Workers Static Assets向けdist
- Chrome／Edge P0、Safari compatibility test

P0対象外:

- LocalSend protocol互換
- LAN discovery
- short code service
- account／cloud storage
- folder transfer
- resume
- persistent pairing
- background receive
- OS Share Extension／Intent
- concurrent peer／transfer
- PWA必須化
- Store submission

P1機能を「ついでに」実装しないでください。将来拡張用fieldやtraitは最小限に留め、未実装は`Unsupported`として明示してください。

## 6. Architecture上の絶対条件

### 共通部分

- Slint UIをNative／Webで共有する。
- Rustにapplication state、session actor、invitation、HMAC handshake、control codec、transfer orchestrationを置く。
- Protocol crateはTailcat、Slint、OS SDKに依存させない。
- CoreはGo object、JavaScript object、OS pathを直接参照しない。
- Platform／Transport Adapterをtrait境界にする。

### Tailcat

- Webはpinned TailcatのGo WASMを利用し、`listen`と`dial`を両方提供する。
- Nativeは小さなC ABI wrapperを使う。`interfaces/tailcat_bridge.h`はdraftなので、Phase 0でtarget別buildmodeを実証してから確定する。
- Go pointerをC／Rustへ保存しない。
- opaque handle table、idempotent close、明確なEOF、cancel、error codeを実装する。
- Go callbackからSlintへ直接入らず、event queue／Rust channelを経由する。

### Web

- Go WASMとRust WASMは別memoryであることを前提にする。
- 最初は64KiB bounded chunkで実装し、copy、memory、throughputを計測する。
- Web file dataがRust↔JS↔Go間を不必要に往復し、100MiB／1GiB Gateを阻害する場合は、文書に従って`BulkTransferBackend` fast pathを実装する。
- Fast pathを入れてもsession semantics、wire format、Slint UIを変えない。
- File全体をBlob／Vecへ読み込むfallbackは小容量上限以下だけにする。

### Cloudflare

- assets-only deployment。
- KV、D1、Durable Objects、R2、Worker relayを追加しない。
- invitationはURL fragment `#i=`。
- fragmentをparse後にvisible URLから除去する。
- raw Tailcat WASMがasset上限を超える可能性があるため、gzip artifactを配信できるloaderを作る。
- CSPやcacheを緩める場合は理由を記録する。

## 7. Security上の絶対条件

- QRへprivate keyを含めない。
- session ID 16byte、invite secret 32byte、nonce 32byteをCSPRNGで生成。
- HMAC-SHA-256 proofをCDDL／文書どおりに実装し、known-answer testを作る。
- invitationは既定10分、最初の認証成功でsingle-use。
- first Tailcat connectionではなくfirst valid proofでconsumeする。
- proof比較はconstant-time API。
- Control frameは1MiB上限。
- Textは1MiB上限。
- File count、filename length、declared sizeを検証。
- Receive Accept前のdataを拒否。
- wrong session／transfer／item streamを拒否。
- file path traversal、absolute path、NUL、reserved namesを安全に処理。
- temporary sinkへ書き、完全受信後にcommit。
- secret、ConnBlob全文、payload、private pathを通常logへ出さない。

## 8. Code品質

- 依存を最少にし、標準libraryと小さな実績あるcrateを優先する。
- 不要なframework、DI container、macro-heavy abstractionを導入しない。
- 同じ処理をplatformごとにcopyしない。
- ただし「共通化のためだけの巨大な抽象化」も作らない。
- function／typeは責務を小さくする。
- errorを握り潰さない。
- unsafeは必要箇所へ局所化し、安全条件をコメントとtestで示す。
- generated codeやvendor copyでrepositoryを膨らませない。
- warning zeroを目標にする。
- コメントは「何をしているか」より「なぜ必要か」を説明する。
- mock／stubがproduction pathで成功を返さない。

## 9. 実装順序

`docs/11-implementation-plan.md`を基本とし、次の順で進めてください。

### Milestone A: Build Spike

- workspace bootstrap
- pinned toolchains
- minimal Slint Native／Web
- Tailcat Web WASM build
- Native C ABI target probes
- Android／iOS artifact compile probes
- artifact size report

### Milestone B: Mock Vertical Slice

- invitation／HMAC
- control／data codec
- session actor
- mock transport
- shared Slint create／join／connected UI
- mock text／file transfer

### Milestone C: Web↔Web

- Tailcat JS bridge
- both browser listeners
- invitation URL／QR
- symmetric address exchange
- text transfer
- file transfer
- browser E2E with local DERP

### Milestone D: Native desktop↔Web

- C ABI
- Windows／macOS adapters
- Native file source／sink
- shared UI
- interop test

### Milestone E: Large file

- 100MiB Web↔Web
- 1GiB Native↔Chrome／Edge
- memory／cancel／hash／fault test
- bulk fast path decision

### Milestone F: Mobile

- Android foreground
- iOS foreground
- physical device test手順と結果

### Milestone G: Cloudflare／review

- deployable dist
- asset size／headers／cache／CSP
- preview／production smoke test（credentialsが利用可能な場合）
- final test report

## 10. 最初の実装checkpoint

最初の作業セッションでは、最低限以下まで進めてください。

1. repository layoutを作る。
2. toolchainとTailcat pinを固定する。
3. Protocol crateを作り、invitation encode/decodeとHMAC test vectorを実装する。
4. Mock transportで2 Coreがhandshakeするtestを実装する。
5. SlintでBoot／Invite／Joining／Connectedの最低限画面を起動する。
6. Tailcat Go WASMがbuildできることを確認する。
7. `IMPLEMENTATION_STATUS.md`へ実施内容、commands、結果、次のblockerを記録する。

時間や環境上の制約で全部できない場合も、動作する最小commitを残し、未検証を成功と表現しないでください。

## 11. Test要件

少なくとも次を自動化してください。

- invitation canonical roundtrip
- malformed／expired invitation
- HMAC known-answer／mutation
- control partial read／oversize
- text／file data header golden vectors
- state machine normal／reject／cancel／disconnect
- filename sanitizer
- 2 browser listener／dial integration
- bidirectional text
- small file hash match
- resource close

1GiB、Safari、mobile physical deviceはmanual／nightlyでもよいですが、`templates/TEST_REPORT.md`形式で結果を残してください。

## 12. 作業報告形式

各checkpointで以下を簡潔に報告してください。

- 実装したもの
- 変更file
- 実行したcommand
- test／build結果
- 実測artifact size／memory（取得できた場合）
- 未解決blocker
- 次に実装するVertical Slice

単に「完了」と書かず、検証した証拠を示してください。

## 13. Credentials／deviceがない場合

- Cloudflare credentialsがなければdeploy可能なdistとcommandを完成させ、local E2Eを行う。deploy成功を捏造しない。
- Apple signing／physical iOS deviceがなければunsigned／simulator buildと実機手順を完成させ、未実施を明記する。
- Android deviceがなければemulator／buildまで行い、physical resultを未実施とする。
- 欠けている環境がWeb↔Web／desktop実装を妨げない限り、そこで作業全体を止めない。

## 14. 完了時成果物

- build可能なsource
- reproducible commands
- pinned dependencies
- shared Slint UI
- Rust Core／Protocol
- Web Go WASM bridge
- Native Go C ABI bridge
- Windows／macOS／Android／iOS project
- Cloudflare dist/config
- CI／tests
- third-party notices
- `IMPLEMENTATION_STATUS.md`
- test report
- known issues／P1 backlog

まず文書とrepositoryを調査し、最初の簡潔な状況報告をした後、実装を開始してください。

---
