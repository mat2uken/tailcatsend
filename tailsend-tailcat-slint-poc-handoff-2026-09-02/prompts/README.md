# Prompts

## `CODEX_MASTER_PROMPT.md`

新規または既存repositoryでPoC開発を開始するための主プロンプトです。ZIP全体と一緒に渡してください。最初のBuild SpikeからWeb↔Web Vertical Slice、Native、mobile、Cloudflareまでの進め方を含みます。

## `CODEX_REVIEW_PROMPT.md`

実装後に別セッションまたは別エージェントへ渡す、独立レビュー／修正用プロンプトです。security、C ABI、WASM memory、protocol conformance、大容量fileを重点監査します。

## 推奨利用方法

1. ZIPを対象repositoryの外または`handoff/`へ展開。
2. `CODEX_MASTER_PROMPT.md`本文を開発エージェントへ渡す。
3. Milestoneごとに`IMPLEMENTATION_STATUS.md`とtest reportを更新させる。
4. P0到達後、別コンテキストで`CODEX_REVIEW_PROMPT.md`を使用。
