# Package Manifest

Package: `tailsend-tailcat-slint-poc-handoff-2026-09-02`  
Generated: 2026-09-02  
Purpose: Tailcat＋SlintによるQR起点クロスプラットフォーム送受信PoCの開発引き継ぎ

## Root

- `START_HERE.md` — 読み順、固定version、最小仕様、実装原則
- `MANIFEST.md` — 本ファイル
- `SHA256SUMS.txt` — ZIP内ファイルのSHA-256（本ファイル自身を除く）

## Design documents

- `docs/01-product-scope.md` — P0／P1、対象platform、非機能、完了条件
- `docs/02-user-flows-and-ui.md` — Create／Join flow、状態機械、画面仕様
- `docs/03-system-architecture.md` — Rust／Slint／Go／WASM全体構成
- `docs/04-invitation-and-session.md` — QR URL、HMAC認証、address交換
- `docs/05-transfer-protocol.md` — Control／Text／File wire protocol
- `docs/06-tailcat-integration.md` — Web Go WASM、Native C ABI、固定commit
- `docs/07-slint-ui.md` — 共通UI、ViewModel、responsive設計
- `docs/08-platform-adapters.md` — Web／Windows／macOS／Android／iOS固有部
- `docs/09-cloudflare-deployment.md` — Static Assets、WASM配信、headers、cache
- `docs/10-testing-and-acceptance.md` — protocol、browser、mobile、1GiB Gate
- `docs/11-implementation-plan.md` — Phase 0〜10の実装順序とexit criteria
- `docs/12-risks-and-decisions.md` — 決定済み事項、risk register、No-Go条件
- `docs/13-repository-layout.md` — 推奨workspace／dependency direction
- `docs/14-source-references.md` — 参照URLと2026-09-02時点の固定情報

## Machine-readable specifications

- `spec/poc-spec.yaml` — scope、limits、targets、acceptance gates
- `spec/invitation.cddl` — invitation canonical CBOR schema
- `spec/control-protocol.cddl` — control message canonical CBOR schema

## Boundary API drafts

- `interfaces/tailcat_bridge.h` — Native Go↔Rust C ABI案
- `interfaces/web_tailcat_bridge.d.ts` — Web Tailcat JS bridge契約案

## Cloudflare templates

- `cloudflare/wrangler.jsonc` — assets-only deploymentたたき台
- `cloudflare/_headers` — cache／CSP／security headersたたき台

## Prompts

- `prompts/CODEX_MASTER_PROMPT.md` — 開発開始・継続用マスタープロンプト
- `prompts/CODEX_REVIEW_PROMPT.md` — 独立監査・修正用プロンプト
- `prompts/README.md` — 利用方法

## Templates

- `templates/TEST_REPORT.md` — platform／large-file／security試験報告
- `templates/DECISION_LOG.md` — ADRテンプレート

## Fixed upstream snapshot

- Tailcat: `tailscale/tailcat@4a25a91e0337252a4d16e097b03cf3cbb92c20cd`
- Go requirement observed in pinned Tailcat: `1.27.0`
- Slint initial candidate: `1.17.1`
- DERP map: `https://tailcat.dev/derpmap.json`
