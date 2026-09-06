# 🤖 Ponlet (TailSend) Android アプリ ＆ Google Play リリース手順メモ

Android 向け Ponlet（旧 TailSend）アプリのアーキテクチャ、署名キーストア情報、および **Google Play Console 本人確認完了後の残り作業** をまとめたメモです。

---

## 📌 基本情報

| 項目 | 設定値 |
|---|---|
| **アプリ表示名** | Ponlet |
| **パッケージ名 (Application ID)** | `jp.yasagure.ponlet` |
| **UI フレームワーク** | Slint (Android NativeActivity / FemtovG レンダラー) |
| **P2P 通信エンジン** | Go Tailcat (WireGuard / P2P Mesh) + Tokio |
| **対応アーキテクチャ** | `arm64-v8a` |
| **最小 SDK / ターゲット SDK** | minSdk 31 (Android 12+) / targetSdk 34 (Android 14) |
| **署名形式** | AAB (Android App Bundle) / v1, v2, v3 署名 |

---

## 🔑 リリース署名キーストア（最重要保管ファイル）

将来のすべてのアップデートの署名にこのキーストアが必要です。紛失すると同一アプリの更新ができなくなりますので厳重に保管してください。

- **キーストア保管場所**:
  - `~/Desktop/ponlet-release.keystore`（ユーザーデスクトップに退避済み）
  - リポジトリ内: `build/certs/ponlet-release.keystore`（`.gitignore` 済み）
- **エイリアス**: `ponlet`
- **パスワード**: `[REDACTED]`
- **キーパスワード**: `[REDACTED]`
- **GitHub Secrets 設定状況**: **設定完了済み**
  - `ANDROID_KEYSTORE_BASE64`
  - `ANDROID_KEYSTORE_PASSWORD`
  - `ANDROID_KEY_ALIAS`
  - `ANDROID_KEY_PASSWORD`

---

## 📦 初回手動登録用 AAB ファイル

Google Play の仕様上、**初回のみ Google Play Console のブラウザ画面から手動で AAB をアップロード** する必要があります（新規登録時は API 経由のアップロードが Google 側でブロックされるため）。

- **初回用 AAB ファイル**: `~/Desktop/ponlet-release.aab`（32 MB）
  - GitHub Actions [Run #34014423748](https://github.com/mat2uken/tailcatsend/actions/runs/34014423748) でビルド・署名済み

---

## 📝 本人確認完了後の残り作業チェックリスト

Google Play Console の本人確認が承認されたら、以下の手順を順番に進めてください。

### Step 1: Google Play Console でアプリを新規作成
1. [Google Play Console](https://play.google.com/console) にログイン。
2. **「アプリを作成」** をクリック。
   - **アプリ名**: `Ponlet`
   - **デフォルト言語**: 日本語（または英語）
   - **アプリまたはゲーム**: 「アプリ」
   - **無料または有料**: 「無料」
   - 宣言項目にチェックを入れて作成。

### Step 2: 初回 AAB を内部テストに手動アップロード
1. 左メニューの **「テスト」 > 「内部テスト」** を開く。
2. 右上の **「新しいリリースを作成」** をクリック。
3. **「Play アプリ署名」**（Google Play App Signing）の規約を確認して有効化。
4. デスクトップにある **`~/Desktop/ponlet-release.aab`** を「App Bundle」エリアにドラッグ＆ドロップしてアップロード。
   - パッケージ名が `jp.yasagure.ponlet` として認識されます。
5. リリース名（例: `1.0.0 (3)`）とリリースノートを入力し、**「保存」** → **「リリースのレビュー」** を進める。
   ※ テスターへの公開は任意です（まずは下書き保存またはレビュー完了で OK）。

### Step 3: ストア掲載情報の必須項目入力（初期セットアップタスク）
Google Play ダッシュボードの「アプリのセットアップ」に表示される以下の項目を入力・完了させます：
- **プライバシーポリシー**: URL を入力（Web サイトまたは GitHub Pages 等）
- **アプリのアクセス権**: 「特別なアクセス権なしで利用可能」
- **広告**: 「アプリに広告は含まれていません」
- **コンテンツのレーティング**: アンケートに回答（全年齢/対象レーティング取得）
- **ターゲット層**: 18歳以上（または全年齢）
- **データセーフティ**: 収集データに関する質問に回答（アカウント情報、ファイル送受信等の利用範囲）

### Step 4: Google Play Developer API とサービスアカウントのセットアップ
GitHub Actions から完全自動アップロードできるようにするための設定です。

1. **Google Play Console で API アクセスを有効化**:
   - Google Play Console の左メニュー **「設定」 > 「API アクセス」** を開く。
   - Google Cloud プロジェクトとリンクする（「新しいプロジェクトを作成」または既存プロジェクトを選択）。
2. **Google Cloud Console で API を有効化**:
   - [Google Cloud Console](https://console.cloud.google.com/) を開く。
   - 対象プロジェクトで **「Google Play Android Developer API」** を検索し、**「有効にする」** をクリック。
3. **サービスアカウントの作成 & キーの発行**:
   - 「IAM と管理」 > 「サービス アカウント」を開く。
   - **「サービス アカウントを作成」** をクリック（名前例: `github-actions-play-deploy`）。
   - 作成後、作成したサービスアカウントをクリックし、**「キー」タブ > 「鍵を追加」 > 「新しい鍵を作成」 > 「JSON」** を選択。
   - JSON ファイル（例: `google-play-key.json`）がダウンロードされます。
4. **Google Play Console でサービスアカウントに権限付与**:
   - Google Play Console の **「ユーザーと権限」** を開く。
   - **「新しいユーザーを招待」** をクリック。
   - メールアドレスに先ほど作成したサービスアカウントのメール（`xxx@xxx.iam.gserviceaccount.com`）を入力。
   - 「アプリの権限」で `Ponlet` を追加。
   - 「権限」タブで **「リリースの管理（製品版、クローズドテスト、内部テストトラック）」** にチェックを入れて招待を送信。

### Step 5: GitHub Secrets にサービスアカウント JSON を登録
ダウンロードした JSON キーファイルの内容を、リポジトリの Secrets に登録します。

Mac のターミナルから以下のコマンドを実行するだけで登録完了します：

```bash
gh secret set PLAY_CONFIG_JSON -R mat2uken/tailcatsend < ~/Downloads/google-play-key.json
```
（※ `~/Downloads/google-play-key.json` は実際のダウンロード先パスに置き換えてください）

### Step 6: GitHub Actions 自動デプロイの動作確認
GitHub リポジトリの **Actions** タブから、**「Android Google Play Deployment」** ワークフローを手動トリガー（`Run workflow`）します：

```bash
gh workflow run google_play.yml -R mat2uken/tailcatsend
```

実行後、自動的に以下が行われれば完了です：
1. Rust & Go の自動ビルド
2. AAB の生成 & リリース署名
3. Google Play Console の **内部テスト（Internal Track）** への自動アップロード完了！

---

## 🛠️ GitHub Actions ワークフロー設定

- ワークフロー定義: [`.github/workflows/google_play.yml`](.github/workflows/google_play.yml)
- Android Gradle 設定: [`apps/android/app/build.gradle`](apps/android/app/build.gradle)
- Android マニフェスト: [`apps/android/app/src/main/AndroidManifest.xml`](apps/android/app/src/main/AndroidManifest.xml)
