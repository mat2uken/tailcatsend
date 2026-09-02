# 04. 招待URL・認証・セッション確立

## 1. 基本モデル

- 招待なしで起動したPeerを一時的に`Creator`と呼ぶ。
- 招待URLから起動したPeerを一時的に`Joiner`と呼ぶ。
- 両者ともTailcat Listenerを持つ。
- JoinerがCreatorのControl portへdialし、自分のListener addressを伝える。
- handshake後はどちらも対称な`Peer`となる。
- Creator／Joinerの役割はUIへ表示しない。

## 2. 招待URL

```text
https://<cloudflare-host>/#i=<base64url-no-pad(canonical-cbor(invitation))>
```

例:

```text
https://tailsend-poc.example.workers.dev/#i=pwEBA...省略
```

### URL fragmentを使う理由

- HTTP request path／queryへ招待を送らない。
- Cloudflare access logやorigin requestにConnBlobを載せない。
- 同じstatic Web appでCreate／Joinを切り替えられる。

ただしfragmentは、browser history、extension、screen capture、リンクを受け取った人から見えます。招待URL自体をcapability secretとして扱います。

## 3. Invitation wire model

CDDLの正本は`spec/invitation.cddl`です。概念モデル:

```text
InvitationV1 {
  version:        1
  protocol_major: 1
  protocol_minor: 0
  host_address:   "tc..."
  session_id:     16 random bytes
  invite_secret:  32 random bytes
  issued_at:      Unix seconds
  expires_at:     Unix seconds
}
```

### 制約

- canonical CBOR invitation: 1024byte以下。
- base64url payload: 1300 ASCII byte以下。
- 完成したQR URL: 1500 ASCII byte以下。超える場合はQRを生成せず明示error。
- `host_address`: ASCII、`tc` prefix、768byte以下。最終的な妥当性はTailcat parserにも委ねる。
- `session_id`: CSPRNG 128bit。
- `invite_secret`: CSPRNG 256bit。
- lifetime既定10分、最大60分。
- clock skew許容60秒。
- canonical CBOR以外はdecode後にrejectしてもよい。
- QRにはprivate keyを絶対に含めない。

## 4. Invitation lifecycle

```text
New
  → Displayed
  → ConnectionAttempted
  → Authenticated
  → Consumed

New / Displayed
  → Expired

すべて
  → Revoked
```

- invitationは最初の**認証成功**でconsumeする。
- Tailcat接続だけでconsumeしない。不正接続で招待を潰されないようにする。
- consumed後の新規Control接続は`InviteAlreadyUsed`として閉じる。
- disconnect後の再接続はP0では新しいQRが必要。
- QR再生成は旧listener／secretをclose・破棄してから行う。

## 5. Application-level handshake

Tailcatの暗号化は通信内容を保護しますが、P0ではQR invitationを持つPeerであることを明示的に確認するため、`invite_secret`を用いたHMAC-SHA-256 proofを追加します。

### 5.1 Joinerの処理

1. invitation検証。
2. local listener起動。
3. `joiner_nonce` 32byte生成。
4. Creatorのport 100へdial。
5. `ClientHello`を送信。

```text
ClientHello {
  protocol version
  session_id
  joiner_nonce
  joiner_listener_address
  peer_info
  capabilities
  proof
}
```

`proof`:

```text
HMAC-SHA256(
  invite_secret,
  "tailsend/join/v1" ||
  session_id ||
  joiner_nonce ||
  utf8(joiner_listener_address) ||
  canonical_cbor(peer_info) ||
  canonical_cbor(capabilities)
)
```

長さを曖昧にしないため、実装では各variable fieldを`u32_be length || bytes`としてMAC inputへ入れるか、canonical CBORのarrayをMACします。CDDLとtest vectorで固定してください。

### 5.2 Creatorの処理

1. session ID、expiry、consume stateを確認。
2. proofをconstant-time compare。
3. `creator_nonce` 32byte生成。
4. peer address／capabilitiesを保存。
5. `ServerHello`を返す。

`ServerHello proof`:

```text
HMAC-SHA256(
  invite_secret,
  "tailsend/host/v1" ||
  session_id ||
  joiner_nonce ||
  creator_nonce ||
  utf8(host_listener_address) ||
  utf8(joiner_listener_address) ||
  canonical_cbor(peer_info) ||
  canonical_cbor(capabilities)
)
```

### 5.3 Ready exchange

- JoinerがHost proofを検証後、`SessionReady`を送る。
- Creatorが`SessionReadyAck`を返した時点で双方を`ConnectedIdle`へ遷移。
- Creatorはこの時点でinvitationをconsumeし、QRを隠す。
- Control Streamはそのままsession終了まで維持する。

## 6. PeerInfo

```text
PeerInfo {
  display_name: 1..64 Unicode scalar values
  platform: web | windows | macos | android | ios | linux | unknown
  runtime: native | browser
  app_version: 1..32 ASCII
  user_agent_family?: chrome | edge | safari | firefox | other
}
```

- device固有識別子やhostname全文を無断送信しない。
- default表示名はユーザーに過度な情報を漏らさない一般名にする。
- P0では編集可能なsession display nameでもよい。

## 7. Capabilities

```text
Capabilities {
  text: true
  files: true
  directories: false
  transfer_resume: false
  max_text_bytes: 1048576
  max_control_frame: 1048576
  max_files_per_offer: 128
  max_filename_bytes: 1024
  streaming_receive: bool
}
```

negotiated valueは双方のintersection／minimumを用いる。

## 8. Duplicate／simultaneous connection

- P0は1 authenticated peerのみ。
- 未認証connectionは最大4、handshake timeout 15秒。
- 認証成功後は未認証connectionをclose。
- 同じinvitationで2つが同時に正しいproofを送った場合、Creatorがatomic compare-and-swapで最初の1つだけconsumeする。
- loserには一般的な`InviteAlreadyUsed`を返す。

## 9. Timeout

| 操作 | 初期値 |
|---|---:|
| listener start | 30秒 |
| Tailcat dial／ping | 60秒 |
| application handshake | 15秒 |
| user offer decision | 5分 |
| idle session heartbeat | 30秒間隔、3回失敗で切断を候補 |

HeartbeatはP0後半でよいが、Control Stream EOFは即時切断として扱う。

## 10. Disconnect

- 明示切断時は`Goodbye`をbest effortで送る。
- control stream、data stream、listenerをclose。
- active transferをcancel。
- temporary sinkをabort。
- invite secret、private key、peer addressをmemoryからdrop。
- UIを`Disconnected`へ遷移し「新しい接続を作る」を表示。

Rustで秘密値を完全zeroizeできる範囲は限定されるため、`zeroize` crate利用を検討し、Go／JS側にもcopyが残りうることをリスクとして記録します。

## 11. Deep link将来拡張

P1でNative Joinerを実装してもinvitation形式は変えません。

```text
HTTPS universal/app link
       ├─ app installed → Native Join
       └─ not installed → Web Join
```

PoCではOS設定を要求せず、標準カメラからWebを開く経路を正式経路とします。
