# 07. Slint共通UI設計

## 1. 採用方針

SlintをWindows、macOS、Android、iOS、Webの共通UI記述として利用します。PoC開始時の候補versionは`1.17.1`です。Cargo.lockをcommitし、version更新は明示的に行います。

Web版SlintはRust→WebAssemblyで動作し、DOM componentではなくCanvas／WebGL中心の描画です。このため見た目とViewModelは共通化できますが、file picker、download、startup URL、clipboard等はJavaScript Adapterが必要です。

## 2. UIとCoreの境界

Slint側は表示とuser intentの通知だけを担当します。

```text
Slint callback
  → UiCommand
  → Rust Session Actor
  → AppSnapshot
  → Slint property/model更新
```

Slint callback内で以下を行わないこと。

- Tailcat dial／listen
- file open／read／write
- blocking C ABI
- async runtimeの`block_on`
- 大きいdataのcopy

## 3. Top-level UI contract

概念例:

```slint
export component AppWindow inherits Window {
    in property <AppScreen> screen;
    in property <ConnectionViewModel> connection;
    in property <[TransferListItem]> transfers;
    in property <PlatformCapabilities> platform-capabilities;

    callback copy-invite();
    callback regenerate-invite();
    callback cancel-connect();
    callback disconnect();
    callback compose-text();
    callback pick-files();
    callback accept-transfer(string);
    callback reject-transfer(string);
    callback cancel-transfer(string);
}
```

Slintへsecret、private key、ConnBlobを渡さない。QR表示用画像とcopy用invite URLは必要だが、diagnostic modelやaccessibility textへConnBlobを分離して露出しない。

## 4. Screens

```text
BootScreen
InviteScreen
JoiningScreen
ConnectedScreen
TextComposeDialog
IncomingTextDialog
FileSelectionDialog / native picker trigger
IncomingFilesDialog
TransferProgressCard
DisconnectedScreen
ErrorDialog
AboutDialog
```

## 5. View model

### Connection

```text
state
status_text
peer_display_name
invite_qr_image
invite_expires_in_seconds
can_copy_invite
can_regenerate
can_disconnect
```

### Transfer

```text
id
kind: text | files
incoming: bool
state
primary_text
secondary_text
bytes_done
bytes_total
progress_0_to_1
speed_bytes_per_sec
can_cancel
```

## 6. QR生成

QR encodeはRust共通crateで行い、pixel bufferをSlint `Image`へ渡します。

要件:

- UTF-8ではなく完成済みASCII URLをQR encode。
- quiet zone 4 modules以上。
- dark／light contrast固定。OS themeで反転しない。
- error correction levelはURL長と読取性を実測してMまたはQから選ぶ。
- image interpolationを無効にし、整数scaleで描画。
- 320〜420px程度を推奨。
- QR下にリンクを全文表示しない。

Inviteが長すぎてQR密度が高くなる場合、DERP情報を埋め込まずcompact ConnBlobを使い、CBOR integer key／base64url no paddingで短縮する。中央short-code serviceはP0で作らない。

## 7. Responsive layout

### Compact

- mobile browser／mobile Native。
- single column。
- action buttonsをbottom areaへ。
- transfer listはvertical。

### Regular

- desktop。
- central content max width。
- Connected時はaction panel＋session listの2columnを許容。

BreakpointはSlint layoutのavailable widthで決定し、platform名で分岐しない。

## 8. Bootstrap shell

WebではTailcat Go WASMとSlint Rust WASMのload前にSlint UIを出せません。最小HTML／CSS bootstrapを許容します。

Bootstrapの責務:

- application title／logo
- WASM download progress
- fatal browser incompatibility
- retry／hard reload

Core起動後はbootstrapを非表示にし、すべてSlint UIへ移行する。bootstrapを第二のapplication UIにしない。

## 9. File pickerとの連携

- Slintの「ファイル」callbackでPlatform Adapterを呼ぶ。
- Webではhidden `<input type=file multiple>`をJavaScriptが開く。
- NativeではOS file dialog。
- 結果は`FileSourceHandle`と表示metadataだけをCoreへ返す。
- Native pathをSlint modelへそのまま出さない。

## 10. Accessibility

Slint WebのCanvas UIはDOM native controlと同等のaccessibilityを自動で得られない可能性があります。PoCでは以下を最低限確認します。

- keyboard focus order
- Enter／Escape
- visible focus indicator
- sufficient contrast
- text scaling
- screen readerで主要actionが認識可能か

不足は`docs/12-risks-and-decisions.md`へ記録し、製品化判断のGateにします。Web accessibilityが重要要件へ上がる場合、WebだけDOM UIに切り替える選択肢を残します。

## 11. Localization

P0:

- 日本語
- English

stringを`.slint`へ散在させず、translation modelまたは生成resourceで管理する。protocol error textを直接表示せず、stable error codeからlocale stringへ変換する。

## 12. Themeとbranding

- LocalSendの操作構造を参考にするが、asset／trademark／画面を複製しない。
- 仮称TailSendと仮iconを使用。
- Slint license attributionをAbout／third-party noticesへ掲載。
- license形態未確定のため、release前にRoyalty-Free／GPL／commercialの適合性を確認。

## 13. UI test

- Core snapshotをfixtureにし、networkなしで全stateを描画。
- QR expiry countdown。
- long peer name／filename。
- 128 files offer。
- 0／100％progress。
- narrow mobile／wide desktop。
- Japanese／English。
- dark／light。

Screenshot testはplatform差で不安定になりうるため、component state testとmanual visual reviewを併用します。
