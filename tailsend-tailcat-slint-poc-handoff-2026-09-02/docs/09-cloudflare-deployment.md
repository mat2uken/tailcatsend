# 09. Cloudflare Workers Static Assets配信

## 1. Cloudflareの責務

P0のCloudflareはWeb appの静的配信だけを担当します。

配信物:

- HTML bootstrap
- JavaScript bridge
- Slint Rust WASM
- Tailcat Go WASM gzip artifact
- `wasm_exec.js`
- CSS／icons／fonts
- build metadata

保持しないもの:

- invitation
- Tailcat private key
- session state
- peer address database
- text／file content
- user account
- transfer log

使用しないもの:

- KV
- D1
- Durable Objects
- R2
- Cloudflare WebSocket relay

## 2. URL

```text
Create:
https://<deployment-host>/

Join:
https://<deployment-host>/#i=<invitation>
```

fragmentはHTTP requestに含まれません。Web bootstrapは直ちにfragmentを取得し、decode用memoryへ渡した後、`history.replaceState`でvisible URLから除去します。

## 3. Static asset layout

```text
dist/
  index.html
  bootstrap.<hash>.js
  app.<hash>.js
  slint_app.<hash>.wasm
  tailcat.<hash>.wasm.gz
  wasm_exec.<hash>.js
  app.<hash>.css
  assets/
  version.json
  _headers
```

- hashed assetはimmutable cache。
- `index.html`と`version.json`は短期／no-cache。
- `tailcat.wasm.gz`はraw compressed objectとしてfetchし、browserでdecompress後`application/wasm` Responseに包む。

## 4. Wrangler

たたき台は`cloudflare/wrangler.jsonc`です。

```jsonc
{
  "name": "tailsend-poc",
  "compatibility_date": "2026-09-02",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application"
  }
}
```

実際のproject rootとの相対pathに合わせて調整します。P0はassets-only deploymentとし、Worker scriptを不要にします。

## 5. Size上限

Cloudflare Workers Static Assetsの個別file上限を超えないこと。調査時点では25MiBです。上流Tailcat raw WASMは約27MiBと記載されているため、raw fileのdeployを前提にしません。

CIで以下を検査します。

```text
- deploy対象の各file size
- tailcat wasm gzip size
- Slint wasm size
- total asset count／size
- source mapがproduction bundleへ混入していないこと
```

## 6. WASM loader

概念手順:

```js
const response = await fetch(tailcatGzipUrl);
const decompressed = response.body.pipeThrough(new DecompressionStream("gzip"));
const wasmResponse = new Response(decompressed, {
  headers: { "Content-Type": "application/wasm" }
});
const { instance } = await WebAssembly.instantiateStreaming(
  wasmResponse,
  go.importObject
);
go.run(instance);
```

- download progressをcompressed bytesで表示。
- decompression／instantiate errorを区別。
- `DecompressionStream`非対応時は、軽量JS inflaterまたは別配信経路を検討。fallback追加前にSafari対象versionで実測。
- WASMのintegrityはcontent hash filenameとdeployment controlを基本とし、必要ならmanifest hash検証を追加。

## 7. Security headers

`cloudflare/_headers`のたたき台を使用します。

主要方針:

- `default-src 'self'`
- WASM実行に必要なpolicyのみ許可
- DERP WebSocketとDERP map fetchを`connect-src`で許可
- frame embedding禁止
- object禁止
- `Referrer-Policy: no-referrer`
- camera／microphone／geolocation禁止（P0 WebはQRを読み取らず、標準カメラからURLを開く）

CSPは実際のTailcat WebSocket endpoint、Slint renderer、font利用をbrowser consoleで確認し、`*`や`unsafe-eval`を安易に追加しないでください。WASM用の`'wasm-unsafe-eval'`対応差を検証します。

## 8. Cache policy

### `index.html`

```text
Cache-Control: no-cache
```

### hashed assets

```text
Cache-Control: public, max-age=31536000, immutable
```

### `version.json`

```text
Cache-Control: no-store
```

WebとNativeのprotocol major不一致時に、単なるreload loopを起こさず明確な更新案内を表示します。

## 9. Deployment commands

例:

```bash
npm ci
cargo build --locked --target wasm32-unknown-unknown --release -p tailsend-web
./scripts/build-tailcat-wasm.sh
./scripts/assemble-web-dist.sh
npx wrangler deploy
```

実際のcommandはrepositoryで1つの`just web-deploy`または`make web-deploy`へまとめます。

## 10. Environments

- local: local static server、production DERPまたはtest DERP
- preview: Cloudflare preview URL
- production-poc:固定workers.dev URL

Invitationには現在開いているoriginを使う。previewで生成した招待がproductionを開かないようにする。

## 11. CI Gate

- fresh build。
- asset size check。
- secret scan。
- `_headers`存在。
- no source map／debug symbolの意図しない配布。
- headless Chromiumでroot create modeを起動。
- second contextでinvite join。
- text round trip。
- small file round trip。
- deployment後smoke test。

## 12. Public DERPに関する表示

PoCはrate-limitedでSLAのないpublic DERPを利用します。UIへ過剰な技術説明は不要ですが、About／diagnosticsに実験的PoCであることを記載します。性能測定結果をサービス保証と表現しません。
