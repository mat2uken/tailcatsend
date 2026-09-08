# 🤖 Ponlet (TailSend) Android アプリ ＆ Google Play リリース手順書

Android 向け Ponlet アプリの構成、署名キーストア情報、および **Google Play Console 本人確認完了後の残り作業手順** をまとめたガイドです。

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

今後のすべてのアップデート署名にこのキーストアが必要です。紛失すると同一アプリの更新ができなくなるため、厳重に保管してください。

- **キーストア保管場所**:
  - `~/Desktop/ponlet-release.keystore`（ローカル環境に退避済み）
  - リポジトリ内: `build/certs/ponlet-release.keystore`（`.gitignore` 対象）
- **エイリアス**: `ponlet`
- **キーストアパスワード**: `PonletSecureKey2026`
- **キーパスワード**: `PonletSecureKey2026`
- **GitHub Secrets 設定状況**: **設定完了済み**
  - `ANDROID_KEYSTORE_BASE64`
  - `ANDROID_KEYSTORE_PASSWORD`
  - `ANDROID_KEY_ALIAS`
  - `ANDROID_KEY_PASSWORD`

---

## 📦 初回手動登録用 AAB ファイル

Google Play の仕様上、新規アプリ登録時は API 経由でのバイナリアップロードが制限されています。**初回のみ Google Play Console の Web UI から手動で AAB をアップロード** し、パッケージ名と署名鍵の紐付けを完了させる必要があります。

### 最新バイナリ情報 (v1.0.2)
- **対象バージョン**: `1.0.2` (Version Code: 7)
- **ビルド実行**: GitHub Actions [Run #34178656309](https://github.com/mat2uken/tailcatsend/actions/runs/34178656309)
- **AAB ファイル配置先**:
  - `~/Desktop/ponlet-release.aab`（最新 v1.0.2 バイナリを配置済み、約 35 MB）
  - リポジトリ内: `build/dist/ponlet-release.aab`
  - GitHub Actions アーティファクト: `Ponlet-Android-AAB`

---

## 📝 本人確認完了後の残り作業チェックリスト

Google Play Console の本人確認が完了次第、以下の手順を順番に進めてください。

### Step 1: Google Play Console でアプリを新規作成
1. [Google Play Console](https://play.google.com/console) にログインします。
2. **「アプリを作成」** をクリックします。
   - **アプリ名**: `Ponlet`
   - **デフォルト言語**: 日本語（または英語）
   - **アプリまたはゲーム**: 「アプリ」
   - **無料または有料**: 「無料」
   - 各種宣言事項のチェックボックスを確認して作成します。

### Step 2: 初回 AAB を内部テストに手動アップロード
1. 左側メニューから **「テスト」 > 「内部テスト」** を開きます。
2. 画面右上の **「新しいリリースを作成」** をクリックします。
3. **「Play アプリ署名」**（Google Play App Signing）の規約を確認し、有効化します。
4. デスクトップの **`~/Desktop/ponlet-release.aab`** を「App Bundle」領域にドラッグ＆ドロップしてアップロードします。
   - パッケージ名が `jp.yasagure.ponlet`、バージョン名が `1.0.2` と認識されることを確認します。
5. リリース名とリリースノートを入力し、**「保存」** をクリックします。
   ※ テスターへの即時公開は任意です。下書き保存またはレビュー完了の状態で問題ありません。

### Step 3: ストア掲載情報の必須項目入力（初期セットアップ）
Google Play ダッシュボードの「アプリのセットアップ」に表示される以下の必須項目を入力します：
- **プライバシーポリシー**: URL を入力（Web サイトまたは GitHub Pages 等）
- **アプリのアクセス権**: 「特別なアクセス権なしで利用可能」
- **広告**: 「アプリに広告は含まれていません」
- **コンテンツのレーティング**: アンケートに回答してレーティングを取得
- **ターゲット層**: 18歳以上（または対象年齢）
- **データセーフティ**: データ収集に関する設問に回答（アカウント情報、ファイル送受信等）

### Step 4: Google Play Developer API とサービスアカウントのセットアップ
GitHub Actions から完全自動でデプロイできるようにするための設定です。

1. **Google Play Console で API アクセスを有効化**:
   - Google Play Console の左メニュー **「設定」 > 「API アクセス」** を開きます。
   - Google Cloud プロジェクトとリンクします（「新しいプロジェクトを作成」または既存プロジェクトを選択）。
2. **Google Cloud Console で API を有効化**:
   - [Google Cloud Console](https://console.cloud.google.com/) を開きます。
   - 対象プロジェクトで **「Google Play Android Developer API」** を検索し、**「有効にする」** をクリックします。
3. **サービスアカウントの作成 & キーの発行**:
   - Google Cloud Console の「IAM と管理」 > 「サービス アカウント」を開きます。
   - **「サービス アカウントを作成」** をクリックします（名前例: `github-actions-play-deploy`）。
   - 作成後、サービスアカウントの詳細を開き、**「キー」タブ > 「鍵を追加」 > 「新しい鍵を作成」 > 「JSON」** を選択します。
   - JSON ファイル（例: `google-play-key.json`）が手元にダウンロードされます。
4. **Google Play Console でサービスアカウントに権限を付与**:
   - Google Play Console の **「ユーザーと権限」** を開きます。
   - **「新しいユーザーを招待」** をクリックします。
   - メールアドレスに、先ほど作成したサービスアカウントのメールアドレス（`xxx@xxx.iam.gserviceaccount.com`）を入力します。
   - 「アプリの権限」で `Ponlet` を追加します。
   - 「権限」タブで **「リリースの管理（製品版、クローズドテスト、内部テストトラック）」** 等の必要な権限を付与して招待を送信・保存します。

### Step 5: GitHub Secrets にサービスアカウント JSON を登録
ダウンロードした JSON キーファイルの内容を、リポジトリの Secrets に登録します。

ターミナルから以下のコマンドを実行します：

```bash
gh secret set PLAY_CONFIG_JSON -R mat2uken/tailcatsend < ~/Downloads/google-play-key.json
```
（※ `~/Downloads/google-play-key.json` は実際のダウンロード先パスに合わせてください）

### Step 6: 自動デプロイの動作確認
`PLAY_CONFIG_JSON` の登録完了後、GitHub Actions から自動デプロイが実行可能になります。

#### 1. 手動実行 (workflow_dispatch)
GitHub の Actions タブ、またはターミナルからワークフローを手動トリガーします：

```bash
gh workflow run google_play.yml -R mat2uken/tailcatsend
```

手動実行時は以下の入力パラメータを指定可能です：
- **track**: デプロイ先トラック（`internal`, `alpha`, `beta`, `production`。初期値: `internal`）
- **version_name**: アプリバージョン名（空欄の場合はタグ名または `1.0.0` を自動適用）
- **version_code**: アプリバージョンコード（空欄の場合は `github.run_number` を自動採番）

#### 2. タグプッシュ実行 (push: tags: ['v*'])
`git tag v1.0.3 && git push origin v1.0.3` のようにタグをプッシュすると自動的に以下が実行されます：
1. Go Tailcat および Rust のクロスコンパイル
2. AAB の生成とリリース署名
3. 署名済み AAB のアーティファクト保存
4. Google Play Console の **内部テスト（internal）** トラックへの自動アップロード

※ `PLAY_CONFIG_JSON` が未登録の状態では、デプロイステップのみ安全にスキップされ、AAB のビルドとアーティファクト保存までが正常に完了します。

---

## 🛠️ ビルドおよびワークフロー構成

- **ワークフロー定義**: [`.github/workflows/google_play.yml`](.github/workflows/google_play.yml)
- **Android Gradle 設定**: [`apps/android/app/build.gradle`](apps/android/app/build.gradle)
- **Android マニフェスト**: [`apps/android/app/src/main/AndroidManifest.xml`](apps/android/app/src/main/AndroidManifest.xml)
- **JNI ライブラリ**:
  - `libtailcat_android.so`（Go 製 Tailcat WireGuard エンジン）
  - `libtailsend_android.so`（Rust 製 NativeActivity / Slint アプリケーション）
