# 🍎 TailSend macOS 実機動作確認ガイド

TailSend は Rust (Tauri WebView UI) と Go (Tailcat P2P WireGuard エンジン) で構築されており、macOSでは共通VanJS UIをローカルWebViewへ表示します。

---

## 1. 前提条件（Mac 側に必要な環境）

Mac のターミナルを開き、以下のツールがインストールされているか確認してください：

1. **Rust (Cargo)**:
   ```bash
   # 未インストールの場合は以下を実行
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source "$HOME/.cargo/env"
   ```
2. **Go (1.22+)**:
   ```bash
   # Homebrew でインストール
   brew install go
   ```

---

## 2. ビルド ＆ 起動手順 (ワンコマンド)

リポジトリ直下で付属のスクリプトを実行すると、Go C archive、VanJS UI、Tauriデスクトップアプリがビルドされます：

```bash
# 実行権限を付与して起動
chmod +x scripts/build_macos.sh
./scripts/build_macos.sh
```

---

## 3. 手動で個別にビルド・実行する場合

```bash
# 1. Go C archive、VanJS UI、Tauri desktop shellのビルド
./scripts/build_tauri.sh

# 2. Tauriデスクトップアプリの起動
./target/debug/tailsend
```

---

## 4. macOS で確認できるネイティブ機能

1. **WebView UI**:
   - VanJS UIをTauriのローカルWebViewで表示し、RustサービスとGo C archiveへ接続します。
2. **Mac クリップボード連携 (`Paste & Send`)**:
   - Mac で `Cmd + C` でコピーしたテキストを、画面上の「**Paste & Send**」ボタンからワンタップで相手端末（iPhone や Windows）へ即時送信。
3. **Finder 連携 (`Share to App`)**:
   - 受信ログ欄の「**Share to App**」を押すと、macOS の `open` コマンドが発火し、Mac の `Downloads/TailSend/` フォルダが Finder で自動で開きます。
4. **大容量ファイル双方向 P2P 転送**:
   - Tauriのファイル選択から共通Rust転送エンジンへファイル参照を渡します。実機転送は別の検証項目です。

---

## 5. macOS 実機検証結果 (2026-09-02)

以下は2026-09-02時点の旧Slint構成の記録であり、現在のTauri WebView構成の成功証拠ではない。

| 検証項目 | 検証内容 | 結果 | 備考 |
|---|---|---|---|
| **Go Tailcat デーモン ビルド** | `bridge/native/daemon.go` (darwin/arm64) | ✅ **PASS** | `tailcat_daemon` (26MB) 生成 |
| **Rust Slint ネイティブビルド** | `cargo build -p tailsend-desktop --release` | ✅ **PASS** | Cocoa/Metal バックエンド (18MB) |
| **QRコード生成 & Metal 描画** | 高精細 RGBA ピクセルラスタライズ | ✅ **PASS** | Retina 高解像度 QR レンダリング |
| **テキスト・クリップボード送受信** | `Paste & Send` / 双方向リアルタイムログ | ✅ **PASS** | `arboard` + `NSPasteboard` 連携 |
| **5MB / 50MB / 100MB ファイル転送** | 64 KiB チャンクストリーミング + Base64 | ✅ **PASS** | **SHA-256 100% 完全一致** |
| **macOS Finder 連携** | `~/Downloads/TailSend/` への自動保存 & `open` | ✅ **PASS** | Finder でのフォルダ表示・確認完了 |
