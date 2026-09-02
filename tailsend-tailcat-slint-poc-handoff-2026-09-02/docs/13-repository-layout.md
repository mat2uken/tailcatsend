# 13. 推奨Repository Layout

```text
tailsend/
├─ README.md
├─ LICENSES/
├─ THIRD_PARTY_NOTICES.md
├─ Cargo.toml
├─ Cargo.lock
├─ go.work
├─ rust-toolchain.toml
├─ justfile
│
├─ docs/
│  ├─ architecture.md
│  ├─ protocol.md
│  ├─ decisions/
│  └─ test-reports/
│
├─ spec/
│  ├─ invitation.cddl
│  ├─ control-protocol.cddl
│  └─ test-vectors/
│
├─ crates/
│  ├─ tailsend-core/
│  │  └─ src/
│  │     ├─ actor.rs
│  │     ├─ command.rs
│  │     ├─ event.rs
│  │     ├─ state.rs
│  │     └─ snapshot.rs
│  │
│  ├─ tailsend-protocol/
│  │  └─ src/
│  │     ├─ invitation.rs
│  │     ├─ auth.rs
│  │     ├─ control.rs
│  │     ├─ data_header.rs
│  │     ├─ limits.rs
│  │     └─ filename.rs
│  │
│  ├─ tailsend-transport-api/
│  ├─ tailsend-platform-api/
│  ├─ tailsend-transfer/
│  ├─ tailsend-qr/
│  └─ tailsend-ui-controller/
│
├─ ui/
│  ├─ app-window.slint
│  ├─ screens/
│  │  ├─ boot.slint
│  │  ├─ invite.slint
│  │  ├─ joining.slint
│  │  └─ connected.slint
│  ├─ dialogs/
│  ├─ components/
│  ├─ styles/
│  └─ i18n/
│
├─ tailcat/
│  ├─ go.mod
│  ├─ go.sum
│  ├─ upstream.lock
│  ├─ bridge/
│  │  ├─ common/
│  │  ├─ native/
│  │  └─ web/
│  ├─ include/
│  │  └─ tailcat_bridge.h
│  ├─ patches/
│  └─ scripts/
│
├─ apps/
│  ├─ desktop/
│  │  ├─ src/
│  │  ├─ windows/
│  │  └─ macos/
│  ├─ android/
│  ├─ ios/
│  └─ web/
│     ├─ src/
│     ├─ bootstrap/
│     └─ dist/          # ignored
│
├─ cloudflare/
│  ├─ wrangler.jsonc
│  └─ _headers
│
├─ tests/
│  ├─ protocol-vectors/
│  ├─ mock-integration/
│  ├─ browser-e2e/
│  ├─ native-e2e/
│  ├─ large-file/
│  └─ fault-injection/
│
├─ scripts/
│  ├─ bootstrap.sh
│  ├─ build-tailcat-wasm.sh
│  ├─ build-native-bridge.sh
│  ├─ assemble-web-dist.sh
│  ├─ check-asset-size.sh
│  └─ generate-large-fixture.sh
│
└─ .github/workflows/
   ├─ ci.yml
   ├─ web-e2e.yml
   ├─ desktop.yml
   └─ cloudflare-preview.yml
```

## 1. Dependency direction

```text
apps/ui-controller
      ↓
core → transfer
 ↓       ↓
protocol
 ↓
transport-api / platform-api

platform implementations depend inward;
core never depends on apps, Slint, Go, JS, or OS SDK.
```

循環依存を避けます。

## 2. Go module

Tailcat bridgeはRust workspace内へsource copyせず、Go moduleとして管理します。

`upstream.lock`例:

```text
repository=https://github.com/tailscale/tailcat
commit=4a25a91e0337252a4d16e097b03cf3cbb92c20cd
go=1.27.0
```

`go.mod`はcommit pseudo-versionまたは`replace`で再現可能に固定します。

## 3. Generated files

Generated artifactsをsource controlへ入れるかは以下で判断します。

- C header: source of truthから生成ならCIでdiff check。配布利便性のためcommit可。
- protocol test vectors: commitする。
- WASM／DLL／XCFramework: commitしない。CI artifactまたはrelease asset。
- Slint generated Rust/C++:通常commitしない。
- Cloudflare `dist/`: commitしない。

## 4. Feature flags

Rust:

```text
default = []
web
desktop
android
ios
diagnostics
test-hooks
```

`test-hooks`をproduction artifactへ含めないCI checkを置く。

## 5. Configuration

Runtime configとcompile-time configを分離します。

Compile-time:

- protocol major/minor
- default Web origin
- Tailcat pinned version metadata

Runtime:

- DERP map URL
- diagnostics verbosity
- invite lifetime（許容範囲内）
- display name

secretをconfig fileへ置かない。

## 6. Documentation sync

wire format変更時は同じPRで以下を変更します。

- CDDL
- Rust types／codec
- known-answer vectors
- protocol docs
- compatibility test
- protocol version判断
