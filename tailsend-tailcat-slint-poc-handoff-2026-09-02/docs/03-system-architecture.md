# 03. システムアーキテクチャ

## 1. 設計目標

1. UIとapplication stateをNative／Webで共通化する。
2. Tailcat固有処理を小さなTransport Adapterへ隔離する。
3. invitation、session、control protocol、transfer orchestrationをRustで共通化する。
4. Webの大容量転送だけは、性能上必要ならJavaScript／Go WASMのfast pathへ差し替えられるようにする。
5. Cloudflare側に状態を置かず、2Peer間のend-to-end通信だけで成立させる。
6. P0を小さく保ちながら、後のmobile／folder／share extensionを阻害しない境界を作る。

## 2. 論理構成

```text
┌──────────────────────────────────────────────────────────────┐
│ Shared Slint UI                                              │
│ QR / connect / transfer offer / progress / history-in-session│
└──────────────────────────┬───────────────────────────────────┘
                           │ callbacks + models
┌──────────────────────────▼───────────────────────────────────┐
│ Shared Rust Application Core                                 │
│ StartupMode / SessionState / Commands / ViewModel            │
├──────────────────────────────────────────────────────────────┤
│ Shared Rust Protocol                                         │
│ Invitation / handshake / control codec / transfer coordinator│
├─────────────────────┬────────────────────────────────────────┤
│ Transport traits    │ Platform capability traits             │
└──────────┬──────────┴───────────────┬────────────────────────┘
           │                          │
   ┌───────▼────────┐        ┌────────▼─────────┐
   │ Native Adapter │        │ Web Adapter       │
   │ Rust ↔ C ABI   │        │ Rust WASM ↔ JS    │
   └───────┬────────┘        └────────┬──────────┘
           │                          │
   ┌───────▼────────┐        ┌────────▼──────────┐
   │ Tailcat Go     │        │ Tailcat Go WASM   │
   │ static/shared  │        │ tailcatListen/Dial│
   └───────┬────────┘        └────────┬──────────┘
           │                          │ WebSocket
           └──────────── DERP ────────┘
```

Native同士では将来Direct UDPへ昇格できます。ブラウザを含むP0経路はDERP-onlyです。

## 3. 推奨repository構成

詳細は`13-repository-layout.md`を参照してください。概念的には次のworkspaceとします。

```text
crates/
  core/                 # application state machine
  protocol/             # transport-independent protocol
  transport-api/        # async traits and handles
  platform-api/         # file/clipboard/startup abstractions
  ui-controller/        # Slint model adapter
ui/                     # .slint files
native/
  tailcat-bridge-go/     # Go C ABI
  desktop/              # desktop bootstrap
  android/              # later
  ios/                  # later
web/
  app/                   # Rust WASM + Slint
  tailcat-wasm/          # Go WASM bridge build
  bootstrap/             # minimal HTML/JS
cloudflare/
```

## 4. Component責務

### 4.1 `core`

- 起動モード判定
- listener lifecycle
- invitation lifecycle
- session state machine
- command serialization
- 送受信競合制御
- UIへ公開するimmutable snapshot
- diagnostics eventの収集

`core`はSlint、Go、JavaScript、OS file handleを直接参照しません。

### 4.2 `protocol`

- canonical invitation encoding／decoding
- HMAC proof生成／検証
- control frame codec
- protocol version negotiation
- message validation
- transfer IDsとitem IDs
- data stream header codec
- size／count／string length上限

`protocol`はpure Rustとしてnative unit testと`wasm32-unknown-unknown` testを持ちます。

### 4.3 `transport-api`

必要最小限の概念だけを公開します。

```rust
pub trait Listener: Send + Sync {
    fn local_address(&self) -> &str;
    async fn accept(&self) -> Result<IncomingStream, TransportError>;
    async fn close(&self) -> Result<(), TransportError>;
}

pub trait TailcatTransport: Send + Sync {
    async fn listen(&self, options: ListenOptions)
        -> Result<Box<dyn Listener>, TransportError>;

    async fn dial(&self, address: &str, port: u16, timeout: Duration)
        -> Result<Box<dyn DuplexStream>, TransportError>;
}

pub trait DuplexStream: Send + Sync {
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, TransportError>;
    async fn write_all(&mut self, buf: &[u8]) -> Result<(), TransportError>;
    async fn close_write(&mut self) -> Result<(), TransportError>;
    async fn close(&mut self) -> Result<(), TransportError>;
}
```

実際にはRust async traitのobject safetyやWASM `Send`要件を踏まえて、`cfg`別type aliasまたは`trait_variant`を使ってよい。APIの意味を統一し、プラットフォーム都合を上位へ漏らさないことが重要です。

### 4.4 `platform-api`

- `StartupLinkProvider`
- `Clipboard`
- `FilePicker`
- `IncomingFileSinkFactory`
- `OutgoingFileSource`
- `OpenReceivedItem`
- `PlatformInfo`

ファイルを単なるpath文字列に限定しないでください。Android `content://`、iOS security-scoped URL、Web `File`はpathを持たないため、read-atまたはstream source handleとして抽象化します。

### 4.5 `ui-controller`

- Slint callbackをCore commandへ変換
- Core snapshotをSlint modelへ反映
- UI threadへのdispatch
- progress eventのthrottle

UI callback内でnetworkやfile I/Oを待たないこと。

## 5. Native Runtime構成

```text
Slint event loop
      │ command channel
Rust async runtime / session actor
      │ C ABI calls
Go Tailcat runtime
      │
DERP / direct network
```

### Threading原則

- Slint UI threadは専用。
- Rust session actorは1つのcommand ownerを持つ。
- Go callbackを直接Slintへ呼ばない。Rust channelへeventを投入する。
- C callback中にGoへ再入しない。
- callback dataは呼出し中だけ有効と定義し、Rust側で必要分をcopyする。
- stream read／writeはhandle IDを使い、同じstreamへの同時readを禁止する。

## 6. Web Runtime構成

```text
HTML bootstrap
  ├─ Tailcat Go WASMをロード
  ├─ Slint Rust WASMをロード
  └─ JavaScript bridgeを登録
             │
       Rust session core
             │ JS Promise API
       Tailcat Go WASM
             │ WebSocket
             ▼
            DERP
```

### Web上の重要な制約

Go WASMとRust WASMは別memoryを持ちます。単純な`read() -> Uint8Array -> Rust Vec`、`Rust &[u8] -> Uint8Array -> Go []byte`ではchunkごとにcopyが発生します。P0は64KiB bounded chunkでまず成立性を検証します。

### Web bulk fast pathのDecision Gate

Vertical Slice後、以下のいずれかを満たさなければfast pathを実装します。

- 1GiB送信時にmemoryがboundedである。
- UIが応答し続ける。
- 64KiBあたりのbridge overheadが転送時間を支配しない。
- browser receiveを逐次sinkへ書き込める。

Fast pathでは、Rust CoreはOffer／Accept／progress／cancelだけを管理し、actual bytesはJavaScriptが`File`から読み、Tailcat Go WASMへ直接渡します。受信もGo WASM→JavaScript writable sinkとし、Rustにはprogressだけを通知します。これを`BulkTransferBackend` traitの差し替えとして実装し、UI／session semanticsを変えないようにします。

## 7. Session Actor Model

1 sessionにつき1 actorを持ち、以下を直列化します。

```text
Command:
  CreateSession
  JoinSession(invitation)
  SendText(text)
  SendFiles(sources)
  AcceptTransfer(id, sink_plan)
  RejectTransfer(id)
  CancelTransfer(id)
  Disconnect

Event:
  StateChanged
  PeerChanged
  IncomingOffer
  TransferProgress
  TransferCompleted
  TransferFailed
  Disconnected
```

Network reader、file reader、timerはactorへeventを送ります。UIやcallbackがstateを直接変更しません。

## 8. Resource ownership

### Listener

- session generationが所有。
- invitation expiry／disconnect／recreateで確実にclose。

### Control Stream

- handshake成功からsession終了まで維持。
- single reader task。
- writerはmutexまたはactor commandで直列化。

### Data Stream

- transfer item単位。
- cancel時にclose。
- receive側はexpected transfer／itemと一致するheaderだけ受理。

### Temporary File

- receive item taskが所有。
- success時にcommit。
- reject／cancel／I/O error／protocol error時にabort cleanup。

## 9. Error taxonomy

```rust
pub enum AppErrorCode {
    InviteMissing,
    InviteMalformed,
    InviteExpired,
    InviteAlreadyUsed,
    UnsupportedProtocol,
    ListenerStartFailed,
    PeerUnreachable,
    AuthenticationFailed,
    PeerBusy,
    TransferRejected,
    TransferCancelled,
    InvalidMetadata,
    InvalidDataStream,
    StorageUnavailable,
    StorageFull,
    PermissionDenied,
    TransportClosed,
    Timeout,
    Unsupported,
    Internal,
}
```

内部error chainは保持しますが、secret、ConnBlob全文、file contentをlogへ含めません。

## 10. Observability

最低限のstructured event:

```text
session_generation
session_id_hash      # full IDではなく短いhash
platform
runtime_kind         # native/web
state
operation
duration_ms
bytes
result_code
transport_path       # unknown/derp/direct;取得可能な場合のみ
```

公開DERPの性能評価用に、WASM load time、listener start time、dial time、handshake time、transfer throughput、peak memoryを計測します。
