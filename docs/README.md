# TailSend Internal Documentation & Developer Guides

本ディレクトリには、TailSend の各プラットフォーム別ビルド手順、署名・ストア申請、および実装仕様に関する内部開発者向けドキュメントをまとめています。

---

## 📚 ドキュメント一覧

### 1. プラットフォーム別ガイド
- [**Android 実機ビルド & Google Play リリース手順**](ANDROID_GUIDE.md)
  - Android (arm64-v8a) 向けビルド手順
  - Slint NativeActivity + Go Tailcat 共有ライブラリの構成
  - リリース署名キーストアの管理方針と GitHub Actions 連携
  - Google Play Console 内部テスト・自動デプロイ手順

- [**iOS 実機ビルド & TestFlight リリース手順**](IOS_GUIDE.md)
  - iOS (Metal / UIKit) 向けビルド手順
  - XcodeGen によるプロジェクト生成とシミュレータ / 実機インストール
  - Apple 配布用証明書・プロビジョニングプロファイルのセットアップ
  - TestFlight への GitHub Actions 自動アップロード手順

- [**macOS ネイティブ実機動作確認ガイド**](MACOS_GUIDE.md)
  - macOS (Apple Silicon / Intel) 向けビルド & 起動手順
  - Metal / Cocoa による 60fps UI 描画
  - クリップボード連携 (`Paste & Send`)、Finder 連携、大容量ファイル転送の検証

### 2. 仕様 & 実装ステータス
- [**PoC 実装ステータス & アーキテクチャ仕様書**](IMPLEMENTATION_STATUS.md)
  - 全体アーキテクチャとクレート構成
  - Tailcat WireGuard P2P メッシュ統合仕様
  - CBOR プロトコルフレーミングと HMAC-SHA-256 相互認証
  - WebAssembly (WASM) 圧縮・Cloudflare Static Assets 最適化
  - テスト検証結果とセキュリティ対策
