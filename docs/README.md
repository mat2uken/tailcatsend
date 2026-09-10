# TailSend 開発者向け資料

- [Android ビルド・実機検証](ANDROID_GUIDE.md)
- [iOS ビルド・実機検証](IOS_GUIDE.md)
- [macOS ビルド・実機検証](MACOS_GUIDE.md)
- [実装状態](IMPLEMENTATION_STATUS.md)
- [WebView 移行記録](WEBVIEW_MIGRATION.md)
- [WebView レビュー](WEBVIEW_REVIEW.md)

全プラットフォームで共通 Rust 転送エンジンを使い、UI は VanJS WebView、Tailcat の接続処理は Go bridge に分けています。検証結果は source、bundle、実機、通信経路ごとに分けて記録します。
