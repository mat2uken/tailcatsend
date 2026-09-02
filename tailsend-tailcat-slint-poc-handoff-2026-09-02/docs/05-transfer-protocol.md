# 05. テキスト／ファイル転送プロトコル

## 1. 設計原則

- Tailcatはsecure duplex streamを提供し、本仕様はその上のapplication protocolを定義する。
- Controlとbulk dataを分離する。
- 受信承認前にdataを送らない。
- file全体をmemoryへ保持しない。
- P0は1 active transfer、files sequential。
- protocolはNative／Webで同一。
- declared sizeと実際のbyte数を厳密に一致させる。

## 2. Tailcat port割当

| Port | 用途 | P0 |
|---:|---|---:|
| 100 | persistent control stream／handshake | 必須 |
| 101 | text payload stream | 必須 |
| 102 | file item stream | 必須 |
| 103 | directory／future | 予約 |

Port 1のraw Tailcat互換面はTailSend protocolでは使用しません。

## 3. Control framing

```text
+----------------------+ 4 bytes
| payload_length u32BE |
+----------------------+ payload_length bytes
| canonical CBOR       |
+----------------------+
```

- `payload_length`: 1〜1,048,576。
- zero-length、上限超過はprotocol error。
- CBOR mapは整数keyを用い、unknown optional keyはminor version互換で無視可能。
- message共通field:
  - protocol major／minor
  - message type
  - session ID
  - monotonically increasing sequence number
  - request／transfer ID（必要時）

正本は`spec/control-protocol.cddl`です。

## 4. Control message

### Session

- `ClientHello`
- `ServerHello`
- `SessionReady`
- `SessionReadyAck`
- `Ping`
- `Pong`
- `Goodbye`
- `Error`

### Text

- `TextOffer`
- `TextDecision`
- `TextResult`

### Files

- `FileOffer`
- `FileDecision`
- `FileItemResult`
- `TransferComplete`
- `TransferResult`
- `TransferCancel`

## 5. Text transfer

### 5.1 Offer

```text
TextOffer {
  transfer_id: 16 bytes
  byte_length: u64
  character_count: u64
  preview: first <= 256 Unicode scalar values
}
```

- full textはOfferに含めない。
- `byte_length <= negotiated max_text_bytes`。

### 5.2 Decision

```text
TextDecision {
  transfer_id
  accepted: bool
  reason?: user_rejected | busy | too_large | unsupported
}
```

### 5.3 Text data stream

Accept後、送信側がpeer port 101へdialし、以下を送る。

```text
+--------------------+
| "TST1"      4byte |
| version      u8    |
| flags        u8    |
| reserved     u16BE |
| session_id   16    |
| transfer_id  16    |
| byte_length  u64BE |
+--------------------+
| UTF-8 payload       |
+--------------------+
```

- header length: 48byte。
- receiverはsession／transfer／expected lengthを照合。
- invalid UTF-8はreject。
- exact length後にEOFを要求。余剰byteはprotocol error。
- receiverがUI modelへ渡す前に最大1MiBまでmemoryへ保持することはP0で許容。
- commit後`TextResult(success)`をControl Streamで返す。

## 6. File Offer

```text
FileOffer {
  transfer_id: 16 bytes
  items: [
    {
      item_id: u32
      name: text
      size: u64
      mime?: text
      modified_unix_ms?: i64
    }
  ]
  total_size: u64
}
```

制約:

- items: 1〜128。
- duplicate item ID禁止。
- item sizeとtotal sizeはchecked arithmeticで検証。
- filename UTF-8 byte長最大1024。
- path separator、`.`、`..`、absolute path、NULを禁止。
- P0ではdirectory entryを含めない。
- MIMEは表示hintに過ぎず信用しない。

## 7. File Decision

```text
FileDecision {
  transfer_id
  accepted: bool
  reason?: user_rejected | busy | insufficient_space | unsupported
}
```

P0は全item一括Accept／Reject。Accept前にreceiverは可能なら保存先と概算空き容量を確認する。

## 8. File data stream

Accept後、senderはitemごとにpeer port 102へ新しいstreamを開き、順番に送る。

```text
+----------------------+ offset
| "TSF1"       4byte | 0
| version       u8    | 4
| flags         u8    | 5
| reserved      u16BE | 6
| session_id    16    | 8
| transfer_id   16    | 24
| item_id       u32BE | 40
| offset        u64BE | 44
| payload_size  u64BE | 52
+----------------------+ 60 bytes total
| raw file bytes       |
+----------------------+
```

P0:

- `version = 1`
- `flags = 0`
- `offset = 0`
- `payload_size = offered item size`
- chunk size 64KiB初期値

将来resume時はoffsetとremaining payloadを利用可能だが、P0では0以外を`Unsupported`として拒否する。

### Receiver validation順序

1. magic／version／reserved。
2. current authenticated session ID。
3. accepted transfer ID。
4. expected next item ID。
5. offset 0。
6. payload sizeがOfferと一致。
7. sinkをtemporary fileとして作成。
8. exactly payload sizeをbounded read/write。
9. EOFまたはclose-writeを確認。
10. flush／fsync可能なら実行。
11. atomic renameまたはplatform commit。
12. `FileItemResult`送信。

### Sender completion

- item payloadを書き終えたら`close_write`。
- `FileItemResult`をControl Streamで待つ。
- success時のみ次itemへ進む。
- 全item後に`TransferComplete`。
- receiverが`TransferResult`を返してsession idleへ戻る。

## 9. Cancellation

どちら側もControl Streamで送る。

```text
TransferCancel {
  transfer_id
  reason: user | disconnect | io_error | protocol_error | timeout
}
```

- cancelはidempotent。
- active data streamをclose。
- sender sourceをclose。
- receiver temporary sinkをabort／delete。
- UIへCancelledを一度だけ通知。
- raceでitem successとcancelが交差した場合、actor sequenceで先に確定したterminal stateを採用。

## 10. Backpressure

- Transport `read`はpull型。
- bounded channel容量を超えてread aheadしない。
- file sourceからのreadは前chunkのwrite完了後。
- progress eventはdata channelとは別にthrottle。
- WebではWritableStreamの`write()` Promiseをawaitしてから次chunkを読む。

## 11. File保存の抽象化

```rust
pub trait IncomingFileSink {
    async fn write(&mut self, chunk: &[u8]) -> Result<(), StorageError>;
    async fn commit(self: Box<Self>) -> Result<ReceivedItem, StorageError>;
    async fn abort(self: Box<Self>) -> Result<(), StorageError>;
}
```

Nativeはtemporary file＋rename。WebはFile System Access API等のwritable stream、非対応browserはcapabilityに応じたfallbackを使う。

Blobへ全量蓄積するfallbackは、設定した小容量上限以下だけ許容する。1GiB経路では禁止。

## 12. 同名ファイル

P0既定:

```text
photo.jpg
photo (1).jpg
photo (2).jpg
```

- extensionを維持。
- raceを避けるため、final commit時にexclusive createまたはatomic name allocation。
- sender pathを保存しない。

## 13. Integrity

Tailcat／TCPが転送中のbit corruptionを検出しますが、アプリケーション上のend-to-end file hashはP1です。P0でも以下は必須です。

- exact byte count
- premature EOF検出
- overrun検出
- completed後のfile size確認

TestではfixtureのSHA-256を外部で比較します。

## 14. Compatibility

- major不一致: 接続拒否。
- minorは低い方のcapabilityに合わせる。
- unknown message type: `UnsupportedMessage` error後、重大でなければsession継続を検討。P0では安全側にdisconnectでもよい。
- reserved fieldが非zero: v1ではreject。

## 15. Security limits

| 項目 | 初期上限 |
|---|---:|
| control frame | 1MiB |
| text payload | 1MiB |
| files per offer | 128 |
| filename | 1024 UTF-8 bytes |
| invitation CBOR | 1024 bytes |
| encoded QR URL | 1500 bytes |
| unauthenticated connections | 4 |
| concurrent authenticated peers | 1 |
| active transfers | 1 |

File size自体は明示上限を設けず、`u64`、platform capacity、user confirmationで扱う。
