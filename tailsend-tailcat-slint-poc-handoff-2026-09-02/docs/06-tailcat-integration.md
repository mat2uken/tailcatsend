# 06. Tailcat統合設計

## 1. 固定する上流

PoCでは以下へ固定します。

```text
repository: https://github.com/tailscale/tailcat
commit:     4a25a91e0337252a4d16e097b03cf3cbb92c20cd
Go:         1.27.0
DERP map:   https://tailcat.dev/derpmap.json
license:    BSD-3-Clause
```

`main`の追従や`@latest`は使用しません。TailcatのAPI／wire formatはまだ安定契約ではないため、更新時は全相互接続testを通します。

## 2. 利用するTailcat能力

P0で必要なのは以下だけです。

- エフェメラルNode private key生成
- Server／Listener開始
- ConnBlob生成
- 任意portのincoming TCP stream受理
- ConnBlobへのclient接続
- 指定portへのTCP stream dial
- stream read／write／half-close／close
- Listener／Clientのclose
- diagnostics log callback

不要:

- CLI parsing
- SSH／SFTP
- port forwarding UI
- Taildrop
- DNS／OS routing
- system VPN
- long-lived identity persistence

## 3. Web統合

上流`web/main_js.go`は、ブラウザ向けに以下をJavaScript globalとして公開しています。

```text
tailcatListen(options) -> Promise<listener>
tailcatDial(options)   -> Promise<connection>
```

概念API:

```ts
type TailcatListener = {
  addr: string;
  privateKeyJSON: string;
  close(): void;
};

type TailcatConnection = {
  port: number;
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  closeWrite(): Promise<void>;
  close(): void;
};
```

`tailcatListen`はincoming callbackを受け、`tailcatDial`はaddressとportへ接続します。上流のreadはpull-basedで64KiB bufferを使うため、上位が読み進めない限り無制限にbrowser memoryへ溜めない設計です。

### 3.1 P0で行う変更

上流fileを直接編集せず、専用package `web/tailcat-wasm`を作るか、最小patchを明示的に管理します。

必要な追加:

- Listener callbackをJavaScript bridgeへ安全にdispatch。
- 複数portの識別。
- stable numeric handle IDを利用できるwrapper。
- listener／client／streamのidempotent close。
- abort signalまたはcancel API。
- log redaction。
- test hookはproduction buildから除外。

### 3.2 Web private key

P0はエフェメラルです。

- `localStorage`へ保存しない。
- reloadでsessionを失う。
- listener addressは毎回変わる。
- 永続pairing導入時だけSecure Storage相当を再検討。

### 3.3 Browser通信経路

ブラウザは任意UDP socketを開けないため、Tailcatのbrowser trafficはDERP relayへWebSocketで接続します。Web↔Web、Web↔NativeはいずれもP0ではDERP-onlyです。

### 3.4 DERP map

QRを小さくするため、P0はcompactなTailcat ConnBlobと固定DERP map URLを使います。Web appは`https://tailcat.dev/derpmap.json`を取得し、Tailcat bridgeへ渡します。

- CORS失敗時の明確なエラー。
- fetch timeout。
- optional same-origin snapshotはdiagnostic fallbackとしてのみ検討。
- DERP mapをinviteへ丸ごと埋め込まない。

## 4. Native統合

NativeはTailcat Go libraryを小さなC ABIで包み、Rustから呼びます。

```text
Rust Native Adapter
       │ C ABI
Go tailcat bridge
       │
Tailcat library
```

### 4.1 Target別artifact候補

| Target | 候補 |
|---|---|
| Windows | `c-shared` DLLまたは対応するstatic archiveをBuild Spikeで確認 |
| macOS | `c-archive`／static library＋header |
| Android | `c-shared` `.so`＋JNI不要のRust FFI、またはAAR packaging |
| iOS | `c-archive`をXCFrameworkへpackaging |

Go 1.27のbuildmode対応をPhase 0で実際にcompileし、結果をADRへ記録します。推測でbuild systemを作り込まないでください。

### 4.2 C ABI方針

- opaque `uint64_t` handle。
- stringはpointer＋length、NUL終端へ依存しない。
- bytesもpointer＋length。
- 呼出しごとにnumeric status code。
- 詳細errorはhandle単位またはthread-safeな`last_error` copy API。
- callbackはeventだけ。同期read／write APIと混在させる場合のreentrancy禁止。
- Rust所有memoryをGoがcall終了後に保持しない。
- Go pointerをC／Rustへ保存しない。
- handle tableはGo側でmutex保護。
- closeはidempotent。

具体案は`interfaces/tailcat_bridge.h`を参照。

### 4.3 Incoming stream

Listener callbackから直接処理を開始せず、Go側event queueへ登録します。

```text
Go listener callback
  → stream handle割当
  → event queueへIncomingStream{listener, stream, port}
  → Rustがpoll／wait
```

この方式はcallback reentrancyとForeign thread問題を減らします。P0では`tc_wait_event(timeout_ms)`のblocking callをRust worker threadから呼ぶ案が単純です。

### 4.4 Stream API

- 1streamにつき同時readは1つ。
- writeは上位で直列化。
- read timeout／cancelを提供。
- EOFはerrorと区別。
- `close_write`対応。
- read bufferはcaller-owned。
- partial writeをbridge内部で`write_all`にするか、戻り値を厳密に扱う。

## 5. Go runtimeとサイズ

Native版はGo runtimeを含みます。PoCではTailcat互換性と開発速度を優先しますが、以下を必ず計測します。

- library／app binary増分
- platform slice別size
- startup RSS
- idle RSS
- connected RSS
- transfer中peak RSS

Tailcatの推奨`build-tags.txt`と`-ldflags "-s -w"`を基準にし、不要なTailscale機能を除外します。ただしtagをblind copyせず、TailSendで必要なWeb／network機能が消えていないことをcompile testで確認します。

## 6. Web WASM size

上流のworkflow記述では未圧縮Tailcat WASMは約27MiBです。Cloudflare Static Assetsの1file上限を考慮し、P0ではgzip済みartifactを配信し、browser側でstreaming decompressionして`WebAssembly.instantiateStreaming`相当へ渡します。

配信候補:

```text
assets/tailcat.<content-hash>.wasm.gz
assets/wasm_exec.<content-hash>.js
```

検証項目:

- gzip後size
- initial load duration
- browser memory peak during decompression／instantiation
- cache hit時の起動時間
- Safariの`DecompressionStream("gzip")`対応。未対応時のfallback方針

raw WASMをCloudflareへ置けるかに依存しないbuildにします。

## 7. Tailcat patch管理

推奨順:

1. 可能な限りupstream public APIだけを利用する別module。
2. unavoidableな場合だけ`patches/tailcat/*.patch`として管理。
3. forkを使う場合もupstream commitをsubmodule／module replaceで明確化。
4. patchごとに理由とupstream issue候補を記録。

Tailcatソースをcopy-pasteして出所不明にしないでください。

## 8. Logging

Go log callbackで次をredactします。

- `tc...` address全文
- private key JSON
- invitation secret
- full session ID
- file path／text content

開発時でもaddressは先頭／末尾数文字またはhashへ変換します。

## 9. License compliance

TailcatはBSD-3-Clauseです。binary distributionではcopyright notice、license本文、disclaimerをdocumentation／materialsへ含めます。

さらにTailscale／gVisor等のtransitive licenseをSBOMまたはthird-party noticesへ収集します。Slintの選択licenseとattributionも別途確認します。

## 10. Build Spike合格条件

### Web

- pinned TailcatからGo WASMをbuild。
- Cloudflare相当のstatic serverからload。
- 2 browser contextでlistener／dial。
- 64KiB往復。
- close／reload後resource cleanup。

### Native desktop

- WindowsとmacOSでC ABI artifactをbuild。
- Rust executableからlistener／dial。
- Go callback／event queueがshutdown可能。
- binary sizeとRSSを記録。

### Mobile

- Android arm64とiOS device／simulator artifactをcompile。
- minimal appからlistener start／close。
- 実接続はdesktop／web成立後に追加。
