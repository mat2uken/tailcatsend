# fastlane（App Store 提出用メタデータ）

TailSend（製品名 Ponlet）の iOS 版 App Store Connect 提出用メタデータです。[fastlane deliver](https://docs.fastlane.tools/actions/deliver/) が読み込む `metadata/` と、App Store Connect の設問へ転記するための補助資料 `review_information/` で構成しています。

## ディレクトリ構成

```
fastlane/
├── README.md                      # このファイル
├── metadata/
│   ├── ja/                        # 日本語ロケール
│   │   ├── name.txt               # アプリ名（30文字以内）
│   │   ├── subtitle.txt           # サブタイトル（30文字以内）
│   │   ├── description.txt        # 説明文（4000文字以内）
│   │   ├── keywords.txt           # 検索キーワード（100文字以内・カンマ区切り）
│   │   ├── promotional_text.txt   # プロモーションテキスト（170文字以内）
│   │   ├── release_notes.txt      # リリースノート（4000文字以内）
│   │   ├── privacy_url.txt        # プライバシーポリシーURL
│   │   ├── support_url.txt        # サポートURL
│   │   └── marketing_url.txt      # マーケティングURL
│   └── en-US/                     # 英語ロケール（同構成）
└── review_information/            # deliver は直接読み込まない補助資料
    ├── app_review_notes_ja.md     # App Review へのメモ（日本語）
    ├── app_review_notes_en.md     # App Review へのメモ（英語・提出用）
    ├── app_privacy_answers.md     # App プライバシー設問の回答案
    ├── age_rating_answers.md      # 年齢レーティング設問の回答案
    └── export_compliance_and_content_rights.md  # 輸出コンプライアンス・コンテンツ権利の回答案
```

## ロケールコードについて

- フォルダ名は fastlane deliver の正式な言語コードに合わせています。日本語は **`ja`**、英語（米国）は **`en-US`** です。
- 根拠: fastlane 公式ドキュメントの「Available language codes」（https://docs.fastlane.tools/actions/deliver/ ）に `ja` があり、`ja-JP` はありません（2026-09-23 に確認）。

## 文字数制限

| ファイル | 制限 |
| --- | --- |
| name.txt | 30 文字 |
| subtitle.txt | 30 文字 |
| description.txt | 4000 文字 |
| keywords.txt | 100 文字 |
| promotional_text.txt | 170 文字 |
| release_notes.txt | 4000 文字 |

## スクリーンショット

- 置き場所: `fastlane/screenshots/<locale>/`（例: `fastlane/screenshots/ja/`、`fastlane/screenshots/en-US/`）
- iPhone・iPad 用の日本語・英語画像は、各ロケールのディレクトリに置いています。iOS 用の `deliver` 実行時はこのディレクトリを指定します。
- macOS 用の日本語・英語画像は `fastlane/screenshots-macos/` に分けています。iOS 用の `deliver` 実行時には含めません。

## fastlane deliver でのアップロード手順（概要）

1. fastlane を導入する（`brew install fastlane` または `gem install fastlane`）。
2. App Store Connect との接続情報を用意する（App Store Connect API キーの JSON、または Apple ID）。API キーの使い方は https://docs.fastlane.tools/app-store-connect-api/ を参照。
3. プロジェクトの `apps/tauri/gen/apple/` 配下でビルド・アーカイブして ipa を用意する（ビルド手順は iOS 提出手順書を参照）。
4. リポジトリ直下（この `fastlane/` が見える位置）で実行する:

   ```sh
   # メタデータとスクリーンショットのみアップロード（ビルドは添付しない）
   fastlane deliver --metadata_path fastlane/metadata --screenshots_path fastlane/screenshots --skip_binary_upload

   # ipa を添付して審査に提出する場合
   fastlane deliver --metadata_path fastlane/metadata --screenshots_path fastlane/screenshots --ipa path/to/Ponlet.ipa --submit_for_review
   ```

5. 最初に HTML の確認レポートが生成されるので、内容を確認してからアップロードする（`force: true` で省略可能）。
6. 既存メタデータを App Store Connect から取得する場合は `fastlane deliver download_metadata` / `download_screenshots`。

Fastfile で使う場合の例:

```ruby
lane :release do
  deliver(
    metadata_path: "fastlane/metadata",
    screenshots_path: "fastlane/screenshots",
    skip_binary_upload: true,
    submit_for_review: false
  )
end
```

## review_information/ の使い方

この配下は fastlane deliver が読み込まない補助資料です。App Store Connect の画面で回答する各設問へ、そのまま転記できる形で整理しています。

- `app_review_notes_ja.md` / `app_review_notes_en.md`: App Review のメモ欄へ転記します。提出用は英語版です。
- `app_privacy_answers.md`: App プライバシー設問の回答案。deliver では更新できません。
  App Store Connect で入力するか、`upload_app_privacy_details_to_app_store` を使います（[手順](https://docs.fastlane.tools/uploading-app-privacy-details/)）。
- `age_rating_answers.md`: 「Age Ratings」設問の回答案と推定レーティング。App Store Connect の画面で回答します。
- `export_compliance_and_content_rights.md`: 輸出コンプライアンス（暗号化）設問とコンテンツ権利設問の回答案。

各ファイルの「未確認・要確認リスト」に挙げた項目は、提出前に人間の判断・確認が必要です。

## 設定画面（App Store Connect）で直接入力する項目（本ディレクトリには含めない）

以下は deliver のメタデータフォルダでは管理しません。App Store Connect で設定してください。

- アプリ名（名前の変更は審査対象。`name.txt` は初回登録用）
- カテゴリ（主カテゴリ・副カテゴリ）・著作権表示
- 年齢レーティング・App プライバシー・輸出コンプライアンスの回答
- App Review 情報（担当者名・電話番号・メールアドレス、およびメモ欄への転記）
- 価格・リリース方法
