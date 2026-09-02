# 08. Platform Adapter要件

## 1. 共通原則

Platform AdapterはOS／browser固有の能力だけを実装します。UI、session、protocol rulesをplatform側へ複製しません。

```rust
pub struct PlatformCapabilities {
    pub can_pick_multiple_files: bool,
    pub can_stream_save: bool,
    pub can_choose_save_location: bool,
    pub can_copy_text: bool,
    pub can_open_received_item: bool,
    pub can_receive_share_intent: bool,
}
```

## 2. Web

### P0

- `location.hash`からinvitation取得。
- parse直後にaddress barからfragmentを除去。
- Clipboard API＋fallback。
- `<input type=file multiple>`。
- Browser Fileをoffset＋lengthでchunk read。
- Chrome／Edgeでstreaming save pathを実装。
- 非対応browserでは安全な小容量fallbackまたは明示的Unsupported。
- Page Visibility／beforeunloadで転送中警告。
- Tailcat Go WASM bridge。

### File受信

優先順位:

1. File System Access API等でuser gestureによりwritable handleを取得し逐次write。
2. browserが提供するstream-to-download方式を検証。
3. Blob全量bufferは小容量上限以下だけ。
4. どれも不可なら受信前にUnsupportedとして拒否。

保存Dialogはuser gesture制約があるため、FileOffer受信DialogのAccept click中にsink handleを確保してから`FileDecision(accepted)`を送る。

### Safari

- connect、listener、text、small fileをP0検証。
- streaming save API差異をcapabilityへ反映。
- mobile Safariはtab background／screen lockで停止しうるため、前景維持を案内。
- 1GiBは正式P0 Gateにしないが、可能範囲を記録。

## 3. Windows

### P0

- Rust＋Slint executable。
- Tailcat Go DLL／static artifact packaging。
- native file picker。
- native temporary file＋atomic rename。
- clipboard copy。
- invite URLをdefault browserで開く必要はP1。
- drag＆dropはP1。
- installerなしで実行可能なdevelopment package。

### 注意

- DLL search pathを固定し、working directory依存にしない。
- Windows Defender／firewall promptの有無を記録。
- long path、reserved names、invalid charactersをsanitize。
- received fileにMark-of-the-Web相当が必要か製品化時に検討。

## 4. macOS

### P0

- Rust＋Slint `.app`またはdevelopment executable。
- Tailcat Go static library。
- native file picker／save location。
- temporary file＋atomic rename。
- clipboard。
- non-Store／non-sandboxでPoC。

### 注意

- code signingはlocal ad-hocでよいが手順を記録。
- hardened runtime／notarizationはP1。
- sandboxを後から導入できるよう、file handle abstractionをpath前提にしない。

## 5. Android

### P0最終対象

- Slint Android app起動。
- Tailcat Go `.so`をABIごとにpackaging。
- foreground中にListener開始。
- QR表示／invite copy。
- Web Joinerとのconnect。
- Androidからbrowserへ、browserからAndroidへtext／file転送。
- Storage Access Framework／`content://`からstream read。
- 受信先をuserに選ばせる、またはapp-specific storageへ保存。

### P0制約

- 常時Foreground Serviceなし。
- background受信保証なし。
- appを前景に維持。
- OS share intentはP1。

### 権限

- `INTERNET`。
- camera不要（Native内QR読取はP1）。
- broad storage permissionを要求せず、SAF／URI permissionを利用。

## 6. iOS

### P0最終対象

- Slint iOS app起動。
- Tailcat Go static library／XCFramework統合。
- foreground中Listener。
- QR表示／invite copy。
- Web Joinerとのconnect。
- document pickerからfile source取得。
- 受信fileをdocument picker／app containerへ保存。
- browserとの双方向text／file。

### P0制約

- foreground中のみ。
- screen lock／background移行でsessionが切れることを許容。
- Share Extensionなし。
- Store submissionなし。

### 注意

- security-scoped resource accessをsource handle lifetimeと対応させる。
- Go thread／Slint event loopの実機挙動を検証。
- Simulator成功だけで完了としない。

## 7. Native Joiner

P0の正式QR読取先はWebです。NativeのCore APIは`JoinSession(invitation)`を実装しますが、以下はP1です。

- iOS Universal Link
- Android App Link
- Windows protocol activation
- macOS Universal Link／URL scheme
- Native app内camera scanner

これによりCoreは全組み合わせへ対応しつつ、PoCのOS設定を抑えます。

## 8. OS Share integration P1

### Android

- `ACTION_SEND`／`ACTION_SEND_MULTIPLE`
- text、URL、`content://`
- app未接続時はpending selectionとして保持

### iOS／macOS

- Share Extension
- App Groupでmain appへhandoff
- Extension内でTailcat runtimeを起動しない

### Windows

- Share Targetまたはcontext menu
- まずdrag＆dropを優先

### Web

- Web Share API／Share Targetはprogressive enhancement
- PWAは必須にしない

## 9. FileSource／FileSink契約

### FileSource

```rust
pub trait FileSource {
    fn metadata(&self) -> FileMetadata;
    async fn read_at(&self, offset: u64, max: usize)
        -> Result<Bytes, StorageError>;
    async fn close(&self);
}
```

Sequential sourceしか提供できないplatformでは別traitでもよいが、resume拡張を考慮してread-at capabilityを明示します。

### SinkFactory

Offer Acceptのuser gesture中にsink planを作る。

```rust
pub trait IncomingFileSinkFactory {
    async fn prepare(&self, offer: &FileOffer)
        -> Result<Vec<Box<dyn IncomingFileSink>>, StorageError>;
}
```

`prepare`成功後だけAcceptを送る。

## 10. Lifecycle

- Native app foreground/background eventをCoreへ通知。
- Web visibility eventをCoreへ通知。
- P0ではbackgroundへ入ったら警告し、transportが失敗したらsessionを終了。
- 自動resumeは行わない。
- resource closeはlifecycle callbackの時間制限に依存せず、best effort＋次回cleanupを用意。
