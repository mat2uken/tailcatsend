# 12. リスク、判断事項、既定決定

## 1. 既定決定

| ID | 決定 |
|---|---|
| D-001 | LocalSendとはprotocol互換にせず、UXだけを参考にする |
| D-002 | QR invitationはCloudflare Web URL＋URL fragment |
| D-003 | Cloudflareはstatic assetsのみ。state／fileを保存しない |
| D-004 | 招待なし起動はCreate、招待あり起動はJoin |
| D-005 | Create／Join双方がTailcat Listenerを開始する |
| D-006 | handshake後は対称Peerとして扱う |
| D-007 | control port 100、text 101、file 102 |
| D-008 | application protocolはRust共通実装 |
| D-009 | Native TailcatはGo C ABI、WebはGo WASM JS bridge |
| D-010 | P0はephemeral session、1 peer、1 active transfer |
| D-011 | folder、resume、pairing、OS shareはP1 |
| D-012 | Browserを含む経路はDERP-onlyとして扱う |
| D-013 | public DERPはPoC限定。製品化時に再評価 |
| D-014 | 1GiB正式GateはNative↔Chrome／Edge desktop |
| D-015 | Web bulk data fast pathは測定後のDecision Gate |

## 2. リスク登録簿

### R-001 Tailcat API／wire formatの不安定性

- 影響: build break、旧アプリとの非互換。
- 対策: commit固定、adapter隔離、interop test、依存更新を別PR。
- PoC判断: Accept。

### R-002 Native Go runtime／binary size

- 影響: mobile app size、RSS、起動時間。
- 対策: build tags、strip、ABI split、実測。PoC後にIroh等と比較可能なTransport境界。
- Gate: Phase 0 size report。

### R-003 Go C ABIのplatform差

- 影響: Windows／iOS／Android build blocker。
- 対策: Phase 0でbuildmode spike、opaque handle、target別packaging。
- Gate: 実compileなしにarchitectureを確定しない。

### R-004 二重WASMとcopy overhead

- 影響: throughput低下、CPU／memory増大。
- 対策: 64KiB bounded chunk、early measurement、optional JS／Go bulk fast path。
- Gate: 100MiB Web↔Web、1GiB Native↔Web。

### R-005 Tailcat WASM asset size

- 影響: Cloudflare individual asset limit、initial load遅延。
- 対策: gzip artifact only、content hash cache、load progress、CI size check。

### R-006 Safari互換性

- 影響: WASM loader、WebSocket、DecompressionStream、file save、background tab。
- 対策: Safariを早期manual Gate、capability detection、small-file fallback。
- 合否: connect/text/small fileはP0。1GiBは非必須。

### R-007 Public DERP rate limit／SLAなし

- 影響: 大容量試験の速度／可用性。
- 対策: speedを合否にしない、test DERPをCIで使用、製品化時self-host。

### R-008 URL capability漏洩

- 影響: 第三者がsessionへ参加。
- 対策: fragment、10分expiry、256bit secret、HMAC proof、single use、clear address bar、first valid peer only。

### R-009 QR密度

- 影響: 標準cameraで読みづらい。
- 対策: compact ConnBlob、canonical CBOR、base64url、device infoを招待へ含めない、実機test。

### R-010 Browser user-gesture制約

- 影響: incoming fileのstreaming save開始不可。
- 対策: Accept clickの中でsink handle取得後にAccept messageを送る。

### R-011 Browser／mobile lifecycle

- 影響: tab background、screen lockで切断。
- 対策: P0 foreground、visibility warning、安全なabort、再QR。

### R-012 Slint Web accessibility

- 影響: Canvas UIがWeb標準controlより弱い。
- 対策: keyboard／focus／screen reader test。製品要件次第でWeb DOM UI分離を再検討。

### R-013 File path／metadata攻撃

- 影響: traversal、overwrite、resource exhaustion。
- 対策: strict limits、basename、temporary sink、exclusive commit、checked arithmetic。

### R-014 Protocolと実装の乖離

- 影響: Native／Web interop failure。
- 対策: CDDL正本、generated／shared types、golden vectors、cross-runtime tests。

### R-015 iOS packaging／App lifecycle

- 影響: Go static linking、thread、foreground transitionの問題。
- 対策: physical device early spike、P0 foreground-only、Store要件を後回し。

## 3. 未決事項

| ID | 項目 | 決定時期 |
|---|---|---|
| O-001 | Native target別Go buildmode | Phase 0 |
| O-002 | Rust async runtime選択 | Phase 0／1 |
| O-003 | QR error correction level | Phase 1実測 |
| O-004 | Web streaming save具体API／fallback | Phase 4 |
| O-005 | Web bulk fast path要否 | Phase 4測定 |
| O-006 | invitation expiry時にlistener再生成するか | Phase 3 |
| O-007 | Safari対応最低version | Phase 9 |
| O-008 | Slint license形態 | 製品化判断前 |
| O-009 | self-hosted DERP topology | P1／製品化 |
| O-010 | Native Joiner deep link | P1 |

## 4. Go／No-Go判断

### Go

- Browser↔Browser対称sessionが安定。
- Desktop Native↔Webが成立。
- 1GiBがbounded memoryで完走。
- mobile実機でforeground transferが成立。
- asset sizeと初期loadが許容範囲。

### Conditional Go

- Safariで大容量不可だがtext／通常fileは可能。
- public DERP速度にばらつきがあるが機能は正しい。
- Native binary sizeが大きいがPoC目的には許容。

### No-Go／再設計

- Browser listenerが主要対象browserで不安定。
- Web memoryがfile sizeに比例し、streaming sinkで解消不能。
- Go Native bridgeがmobile targetで成立せず、代替bind方式も不可能。
- QRが実用的な密度に収まらない。
- Slint Webと二重WASMによりUXがPoC基準を大きく下回る。

No-Go時もTransport／Protocol／UI Coreを保持し、Iroh等のtransport比較へ再利用できる構成にします。
