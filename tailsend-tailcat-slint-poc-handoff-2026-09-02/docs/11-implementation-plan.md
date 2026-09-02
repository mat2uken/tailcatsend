# 11. 実装計画

## 1. 開発原則

- phaseごとに実動Vertical Sliceを残す。
- P1を先に実装しない。
- mock成功だけでTailcat統合完了としない。
- upstream commit、toolchain、artifact sizeを最初に固定・記録する。
- Web↔Webで対称sessionを成立させてからNative／mobileへ展開する。
- 大容量問題は早い段階で測り、最後まで先送りしない。

## Phase 0: Repository bootstrapとBuild Spikes

### 作業

- Cargo workspace／Go module／web build／Cloudflare config作成。
- Tailcat commit固定。
- Rust／Go／Node／Wrangler version確認。
- Slint minimal appをNative desktopとWebで起動。
- Tailcat Go WASMをbuildし、上流web demoを起動。
- Native C ABI hello／listener start／close spike。
- Android／iOS向けGo artifactのcompile spike。
- licenses収集開始。

### 成果物

- reproducible bootstrap command
- `toolchains.md`またはmise／asdf／devcontainer設定
- build artifact size report
- ADR: Native Go buildmode選択
- known blockers

### Exit

Windows／macOS／Web minimal buildが再現でき、mobile artifactの可否が実測されている。

## Phase 1: Protocol／CoreをMockで完成

### 作業

- invitation CDDL実装。
- HMAC test vector。
- control codec。
- data headers。
- state machine／session actor。
- mock TailcatTransport。
- mock file source／sink。
- Slint UI shellとViewModel。
- QR生成。

### Vertical Slice

2つのin-process Coreがmock transportで接続し、UI simulatorからtext／small fileを双方向転送。

### Exit

protocol unit／property test、state machine testが通る。

## Phase 2: Web Tailcat Transport

### 作業

- pinned Tailcatから専用Go WASM bridgeを作成。
- `tailcatListen`／`tailcatDial` wrapper。
- JS Promise↔Rust WASM adapter。
- listener／stream handle lifecycle。
- DERP map取得。
- WASM gzip loader。
- headless Chromium test。

### Exit

2 browser contextsがTailcat streamを双方向に開閉できる。

## Phase 3: Web↔Web QR Session

### 作業

- Create modeでlistener／invite URL／QR。
- Join modeでfragment parse／clear。
- 双方listener address交換。
- HMAC handshake。
- persistent control stream。
- Connected UI。
- text offer／accept／payload。

### Exit

Cloudflare local／preview相当でQRからWeb↔Web text双方向。

## Phase 4: Web File Transfer

### 作業

- browser file picker。
- file offer／accept。
- data stream header。
- chunked send／receive。
- streaming sink capability。
- progress／cancel。
- temporary／commit semanticsのWeb相当。
- bridge memory measurement。

### Decision Gate

Rust↔JS↔Go WASM copyで性能／memoryが不適切なら`BulkTransferBackend` fast pathを実装。

### Exit

Web↔Webで100MiB、bounded memory、cancel、hash一致。

## Phase 5: Native Desktop Tailcat Adapter

### 作業

- C ABIを確定。
- Go handle／event queue。
- Rust Native adapter。
- Windows artifact packaging。
- macOS artifact packaging。
- native file source／sink。
- common Slint UI統合。

### Exit

Windows／macOSの各Native CreatorへWeb JoinerがQR接続し、text／small fileを双方へ転送。

## Phase 6: Large-file Hardening

### 作業

- 1GiB fixture。
- backpressure確認。
- progress throttle。
- cancel latency。
- disk full／disconnect fault。
- temporary cleanup。
- Web bulk fast path再評価。

### Exit

1GiB GateをWindows／macOS Native↔Chrome／Edgeで満たす。

## Phase 7: Android

### 作業

- Slint Android packaging。
- Go Tailcat shared artifact。
- Rust bridge。
- foreground lifecycle。
- QR表示／copy。
- SAF file source／sink。
- Web Joinerとの相互接続。

### Exit

physical Androidでtext／10MiB file双方向、異常終了なし。

## Phase 8: iOS

### 作業

- Slint iOS project。
- Go static artifact／XCFramework。
- Rust bridge。
- document picker source／sink。
- foreground lifecycle。
- QR表示／copy。
- Web Joinerとの相互接続。

### Exit

physical iPhone／iPadでtext／10MiB file双方向。background時の制約を記録。

## Phase 9: Cloudflare Deployment／Compatibility

### 作業

- production-poc asset assembly。
- `_headers`／cache／CSP。
- workers.dev deploy。
- Chrome／Edge／Safari matrix。
- version mismatch UX。
- third-party notices。

### Exit

公開URLでP0 smoke testが通る。

## Phase 10: Review／Handoff

### 作業

- `CODEX_REVIEW_PROMPT.md`で監査。
- test report。
- architecture／protocolを実装に同期。
- known issues／P1 backlog。
- reproducible commands。

## 2. 推奨commit分割

1. `chore: bootstrap workspace and pinned toolchains`
2. `feat(protocol): add invitation and handshake codecs`
3. `feat(core): add session state machine with mock transport`
4. `feat(ui): add shared Slint create/join/connected flow`
5. `feat(web): add Tailcat WASM transport adapter`
6. `feat(web): establish symmetric browser sessions`
7. `feat(transfer): add accepted text transfer`
8. `feat(transfer): add streaming file protocol`
9. `feat(native): add Go C ABI and Rust adapter`
10. `feat(desktop): add Windows and macOS packaging`
11. `feat(android): add foreground mobile PoC`
12. `feat(ios): add foreground mobile PoC`
13. `chore(cloudflare): add static deployment and smoke tests`
14. `test: add large-file and fault matrix`

無理に1PRへ詰め込まず、各commitがbuild可能であることを優先します。

## 3. 開発command目標

最終的に以下のような統一commandを提供します。

```bash
just bootstrap
just test
just test-web-e2e
just build-web
just serve-web
just deploy-web-preview
just build-windows
just build-macos
just build-android
just build-ios
just test-large
```

`make`でも構いませんが、READMEにcommandを散在させないでください。

## 4. Definition of Done per feature

- codeだけでなくtestがある。
- docs／CDDLと実装が一致。
- error pathを実装。
- resource close／cancelを確認。
- secret loggingなし。
- unsupported platformで明示error。
- build commandをREADMEへ追加。
- P0／P1 scopeを逸脱しない。

## 5. 判断が必要になった場合

作業を止める前に、以下の順で処理します。

1. 文書間の優先順位を確認。
2. `spec/*.cddl`をwire formatの正本とする。
3. P0を小さく保つ案を選ぶ。
4. reversibleなAdapter境界に閉じ込める。
5. `templates/DECISION_LOG.md`形式でADRを作る。
6. 安全性／互換性に関わる場合は曖昧に実装せず、明示的にblockerとして報告する。
