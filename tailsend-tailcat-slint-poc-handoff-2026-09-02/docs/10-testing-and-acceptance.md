# 10. テスト戦略と受入条件

## 1. 基本方針

PoCは「buildできた」ではなく、異なるruntime間の相互接続、bounded memory、失敗時cleanupまでを合格条件とします。

テスト層:

1. Pure Rust unit／property test
2. Go bridge unit test
3. C ABI／JavaScript bridge contract test
4. Mock transportによるsession integration test
5. Local DERPを使うTailcat integration test
6. Real browser E2E
7. Native↔Web E2E
8. Mobile実機test
9. Cloudflare deployment smoke test
10. 大容量／fault injection test

## 2. Test fixture

固定fixture:

- UTF-8 text: ASCII、日本語、emoji、改行、URL、1MiB境界
- files:
  - 0byte
  - 1byte
  - 1KiB
  - 64KiB-1／64KiB／64KiB+1
  - 10MiB
  - 100MiB
  - 1GiB generated stream
  - Japanese filename
  - emoji filename
  - long filename boundary
  - same-name files
  - random binary
- deterministic session／nonce／secret for protocol test vectors

1GiB fixtureはrepositoryへcommitせず、deterministic generatorで作る。

## 3. Protocol unit test

### Invitation

- canonical CBOR roundtrip
- base64url no-padding roundtrip
- malformed CBOR
- duplicate map keys
- unknown major version
- expired／future-issued
- boundary length
- invalid Tailcat prefix
- HMAC known-answer test
- one-bit proof mutation
- constant-time compare API利用確認

### Control frame

- partial header reads
- partial payload reads
- multiple frames in one read
- 0 length
- max length
- max+1
- unknown message
- invalid required field
- integer overflow
- sequence replay／out-of-order policy

### Data header

- exact 48byte text header
- exact 60byte file header
- bad magic
- bad version
- nonzero reserved
- wrong session／transfer／item
- size mismatch
- early EOF
- extra bytes

### State machine

- create success
- join success
- invalid proof then valid peer
- simultaneous valid joiners: one winner
- offer accept／reject
- busy response
- sender cancel／receiver cancel
- disconnect during offer／data／commit
- stale async event from previous generation ignored

Property／fuzz testをcontrol decoder、invitation decoder、filename sanitizerへ追加する。

## 4. Mock Transport integration

In-memory full-duplex transportで以下を確認:

- 2つのCore instanceがhandshake。
- 双方向text。
- file offer→accept→payload→result。
- bounded chunking。
- artificial latency／small writes。
- mid-stream failure。
- event ordering。

MockがTailcatの都合を過度に模倣せず、arbitrary partial read／writeを発生させること。

## 5. Tailcat Web bridge test

上流のbrowser integration testを参考にし、local WebSocket-capable DERPで実行します。

- browser listener produces `tc...` address。
- browser dial→browser listener。
- incoming portが正しい。
- 64KiB roundtrip。
- 2MiB random binary hash一致。
- half-close／EOF。
- listener close後の接続拒否。
- page reloadによるresource cleanup。
- 2 browser contextsの相互listener address交換。

Chromium headlessをCI P0とし、Safariは実機／WebDriver可能範囲で別test。

## 6. Platform matrix

### 必須P0

| Creator | Joiner | Text | Small file | Large file | 備考 |
|---|---|---:|---:|---:|---|
| Chrome desktop | Chrome desktop | 必須 | 必須 | 100MiB | Web↔Web |
| Chrome desktop | Edge desktop | 必須 | 必須 | 100MiB | Web↔Web |
| Windows Native | Chrome／Edge desktop | 必須 | 必須 | 1GiB | 正式large Gate |
| macOS Native | Chrome desktop | 必須 | 必須 | 1GiB | 正式large Gate |
| macOS Native | Safari macOS | 必須 | 必須 | best effort | Safari |
| Web desktop | Safari iOS | 必須 | 小容量 | 記録 | Web Host |
| Windows／macOS Native | Chrome Android | 必須 | 通常容量 | 記録 | mobile Web |
| Android Native | Chrome desktop／mobile | 必須 | 通常容量 | 記録 | foreground |
| iOS Native | Safari／Chrome on other device | 必須 | 通常容量 | 記録 | foreground／実機 |

「通常容量」はまず10MiB、次に100MiBを試し、OS／browser制約を記録します。

### Optional diagnostic

- Native↔Nativeはprotocol／transport API検証として実施可能だが、標準QR flowのP0受入には含めない。
- Web HostからNative Joinerはdeep linkなしでは手動invite入力でdiagnostic可能。

## 7. QR test

- Android／iOS標準cameraで読める。
- desktop screenの100%、75%、50%表示。
- light／dark OS themeでcontrast不変。
- workers.dev URL。
- maximum expected invitation length。
- expiry countdown。
- copy link一致。
- expired link。
- corrupted 1char。
- consumed invite。

QR imageをscreenshotに保存してdecoder libraryで自動decodeするtestも持つ。

## 8. File I/O test

- whole-file bufferingがないこと。
- chunk boundary cases。
- read returns smaller than requested。
- write returns delay／error。
- disk full simulation。
- permission denied。
- destination disappears。
- duplicate name race。
- temporary cleanup。
- commit failure。
- cancel while save picker open。

WebではAccept clickからsink取得までのuser gesture制約を手動確認する。

## 9. Fault injection

各phaseで切断する。

```text
before ClientHello
between ClientHello and ServerHello
before ReadyAck
after Offer before Decision
after Accept before data dial
in data header
at 1 byte / 50% / final byte
before item result
before transfer result
```

期待:

- panic／browser hangなし。
- temporary dataをcommitしない。
- sessionが安全にDisconnectedまたはIdleへ戻る。
- user-visible errorが一度だけ表示。
- resource handle leakなし。

## 10. Security test

- invalid HMACを受け入れない。
- invite consumed race。
- oversized control frame。
- path traversal names。
- absolute path／drive letter／UNC。
- NUL／control char。
- malicious Unicode filename表示。
- declared size overflow。
- unexpected incoming data stream。
- data before Accept。
- wrong session stream。
- stale stream after reconnect。
- logsにsecret／ConnBlob全文がない。
- Cloudflare request logへfragmentが含まれないことを確認。

## 11. Performance measurement

### Web startup

- HTML first paint
- Tailcat WASM compressed download
- decompress
- instantiate／Go runtime ready
- Slint WASM ready
- Listener ready

### Session

- QR scanからpage load
- dial startからTailcat connected
- application handshake

### Transfer

- bytes/sec
- CPU
- peak RSS／WASM memory
- JS heap
- progress update frequency
- bridge copy回数または推定bytes

## 12. 1GiB Gate

正式対象:

- Windows Native↔Chrome／Edge desktop
- macOS Native↔Chrome desktop

合格条件:

- 完了する。
- receiver file size一致。
- external SHA-256一致。
- memoryがfile sizeへ比例しない。
- cancelが5秒以内を目標に反応。
- UI操作可能。
- temporary fileが失敗後に残存しない、または明示cleanup対象になる。
- public DERP速度そのものはpass／failにしない。

## 13. Mobile Gate

### Android

- physical arm64 device。
- foregroundでlistener／QR。
- Chrome Webとのtext／10MiB file双方。
- app background時の挙動を記録。
- `content://` source。

### iOS

- physical deviceを必須。
- foreground listener。
- Safari Webとのtext／10MiB file双方。
- screen lock／background時に安全に失敗。
- document picker resource lifetime。

## 14. Cloudflare smoke test

Deployment後:

- root 200。
- hashed asset cache header。
- CSP violationなし。
- Tailcat gzip artifact load。
- DERP map fetch。
- Web HostがQR生成。
- second browserがjoin。
- text roundtrip。
- 1MiB file roundtrip。
- fragmentがserver requestへ含まれない。

## 15. CI構成

Pull Request:

- format／lint
- Rust unit／integration
- Go test
- protocol fuzz corpus smoke
- Web build
- asset size
- Chromium E2E with local DERP
- desktop bridge build where runner available

Nightly／manual:

- 100MiB／1GiB
- fault matrix
- Cloudflare preview deploy
- mobile manual checklist
- Safari matrix

## 16. Test report

各release candidateで`templates/TEST_REPORT.md`を複製し、以下を記録します。

- commit IDs
- toolchain versions
- target devices／OS／browser versions
- matrix result
- size／memory／throughput
- known failures
- logs／screenshotsの場所
- Go／No-Go結論
