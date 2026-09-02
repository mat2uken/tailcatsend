# Codex独立レビュー／修正用プロンプト

以下は、実装後に別のコーディングエージェントまたは新しいセッションへ渡すレビュー用プロンプトです。

---

あなたはTailSend PoCの独立シニアレビュー担当です。repository内の実装を、添付または`handoff/`にある仕様一式と照合し、表面的なコードレビューではなく、build、test、protocol、security、resource lifecycle、大容量streaming、Native／Web相互運用を監査してください。可能な範囲で重大問題を修正し、再テストしてください。

## 1. 参照順序

1. `START_HERE.md`
2. `spec/invitation.cddl`
3. `spec/control-protocol.cddl`
4. `spec/poc-spec.yaml`
5. `docs/03-system-architecture.md`
6. `docs/04-invitation-and-session.md`
7. `docs/05-transfer-protocol.md`
8. `docs/06-tailcat-integration.md`
9. `docs/10-testing-and-acceptance.md`
10. 実装repositoryのREADME、ADR、status、test report

wire formatはCDDLを正本とします。

## 2. 最初に行うこと

- 未commit変更を確認し、破壊しない。
- repository treeとdependency lockを確認。
- Tailcatが`4a25a91e0337252a4d16e097b03cf3cbb92c20cd`へ固定されているか確認。
- build／test commandを実行。
- 失敗を再現し、環境不足と実装不具合を分離。
- 監査結果だけで終わらず、安全に修正できるCritical／High issueは修正し再テスト。

## 3. 必須監査領域

### Scope

- P0が完成しているか。
- P1機能で不必要に複雑化していないか。
- Cloudflareがstatic-onlyか。

### Protocol

- CDDLとRust／Go／JS実装のfield、endianness、header size、limitが一致するか。
- text header 48byte、file header 60byteか。
- partial read／writeを正しく扱うか。
- exact byte count、early EOF、overrunを検出するか。
- version negotiationが安全か。

### Invitation／authentication

- CSPRNGを使用しているか。
- secret length、nonce lengthが正しいか。
- HMAC inputが曖昧でないか。
- constant-time comparisonか。
- expiry／single-useがatomicか。
- invalid Tailcat connectionがinviteをconsumeしないか。
- URL fragmentを早期消去するか。

### Tailcat bridge

- Go pointerをforeign側へ保持していないか。
- handle use-after-close／double close／leakがないか。
- callback reentrancyがないか。
- shutdownでgoroutine／listenerが残らないか。
- EOF、timeout、cancel、network errorを区別するか。
- full ConnBlob／keyをlogへ出していないか。
- Web listenerとdialの両方が実装されているか。

### Concurrency／state

- Session Actor以外がstateを直接変更していないか。
- stale generation eventを無視するか。
- simultaneous joinerで1Peerだけ成立するか。
- offer／cancel／completion raceでterminal stateが二重通知されないか。
- Control Stream writerが直列化されているか。

### File security

- traversal、absolute path、UNC、drive letter、NUL、reserved name。
- checked arithmetic。
- Accept前data拒否。
- wrong session／transfer／item拒否。
- temporary fileからatomic commit。
- cancel／error時cleanup。
- same-name race。

### Memory／performance

- `read_to_end`、`arrayBuffer()`全量、`Blob(chunks)`、巨大`Vec`等がfile pathにないか。
- queueがboundedか。
- browser間copyが不必要に増えていないか。
- progress eventがUIを飽和させないか。
- 100MiB／1GiB試験のmemory evidenceがあるか。

### Slint／UI

- 同じ`.slint` componentをNative／Webで利用しているか。
- UI threadでblocking I/Oしていないか。
- Host／Joiner、Native／Webの不要な分岐がUIへ漏れていないか。
- unsupported capabilityが正しくdisabledか。
- QR contrast／quiet zone／decode test。

### Web／Cloudflare

- raw 25MiB超artifactをdeployしていないか。
- gzip loaderがboundedか。
- CSPを不要に緩めていないか。
- fragmentがrequest／Referer／analyticsへ送られないか。
- source mapやsecretがproduction distへないか。
- browser save user gestureを守るか。

### Mobile

- Android `content://`をpathへ変換しようとしていないか。
- iOS security-scoped resource lifetime。
- backgroundを誤って保証していないか。
- physical device未検証を完了扱いしていないか。

### Licensing

- Tailcat BSD notice。
- transitive third-party notices。
- Slint license／attribution。
- LocalSend asset／codeを無断copyしていないか。

## 4. 実行すべきテスト

利用可能な環境で次を実行してください。

- format／lint／unit tests
- Rust protocol／state tests
- Go bridge tests
- browser E2E with local DERP
- Web↔Web bidirectional text/file
- desktop Native↔Web
- asset size check
- fault injection subset
- secret scan
- large-file testまたは少なくとも100MiB test

実行できない項目は理由と正確な未検証範囲を示してください。

## 5. Severity

- Critical: secret漏洩、任意path write、認証bypass、重大data corruption
- High: use-after-free、unbounded 1GiB memory、session混線、P0主要経路不動
- Medium: cleanup漏れ、互換性不足、誤ったerror handling、著しいUX問題
- Low: maintainability、minor UX、documentation gap

## 6. 出力

最終報告を次の順にしてください。

1. Executive summary／Go-No-Go
2. Findingsをseverity順に、file:line、再現方法、影響、修正案付きで列挙
3. 実際に修正した内容
4. 実行したcommandと結果
5. Platform matrix
6. Size／memory／performance evidence
7. 未検証項目
8. 残るP0 blocker
9. P1へ回す事項

Critical／High issueを修正した場合は、仕様文書やtestも同じ変更で同期してください。成功していないものを成功と表現しないでください。

---
