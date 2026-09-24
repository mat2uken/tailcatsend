# 年齢レーティング 設問への回答案（Ponlet 1.0.14）

対象: App Store Connect の「Age Ratings」設問（Set Up Age Ratings ダイアログ）
参考: https://developer.apple.com/help/app-store-connect/reference/age-ratings （Age ratings values and definitions、2026-09-23 に確認）および https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating
位置付け: fastlane deliver が直接読み込まない補助資料。設問ごとの回答と推定レーティングをまとめたもの。

## 0. 設問形式について（確認できたこと）

- App Store Connect の「Age Ratings」→「Set Up Age Rating」から、記述子（content descriptor）ごとに頻度（**NONE / INFREQUENT / FREQUENT**）または該当の有無（**YES / NO**）を選択する。回答から Apple がグローバルレーティングと地域レーティングを算出する。
- 記述子の大分類は「In-App Controls」「Capabilities」「Mature Themes」「Medical or Wellness」「Sexuality or Nudity」「Violence」「Chance-Based Activities」。
- レーティング値は iOS 26 以降向け（4+ / 9+ / 13+ / 16+ / 18+ / Unrated）と、それ以前の OS 向け（4+ / 9+ / 12+ / 17+ / Unrated）で表示が異なる。App Store Connect の「Operating Systems Earlier than Version 26」で旧 OS 向けの表示も確認できる。

## 1. In-App Controls

| 設問 | 回答 | 理由 |
| --- | --- | --- |
| Parental Controls（ペアレンタルコントロール） | NO | 該当する設定・機能はない |
| Age Assurance（年齢確認） | NO | 年齢確認の仕組みはない |

## 2. Capabilities

| 設問 | 回答 | 理由 |
| --- | --- | --- |
| Unrestricted Web Access（無制限のウェブアクセス） | NO（決定済み） | アプリ内ブラウザはない。外部に出るのはプライバシーポリシー（privacy_ja.html / privacy_en.html）と OSS ライセンス（licenses.html）の固定 URL のみで、いずれも自社（開発者）のサイト。システムのブラウザ（Safari）で開く。実装を確認済み: web-ui/src/backend.ts の openExternal → apps/tauri/src/commands.rs の open_url（tauri_plugin_opener）でシステム側に渡す。ユーザーがアプリ内で任意のページを閲覧することはできない。2026-09-23 判断: 自社サイトのみのため NO と確定 |
| User-Generated Content（ユーザーコンテンツの広範な配布） | NO | 1 対 1 の私的な転送のみで、フィード等による「広範な配布（broad distribution）」に該当する機能はない |
| Social Media | NO | 該当機能なし |
| Social Media Disabled for Users Under 13 | NO | Social Media が「なし」のため該当しない |
| Messaging and Chat | YES | 端末間の 1 対 1 テキストチャット（双方向メッセージング）。新しい設問体系では Messaging and chat は 4+ の定義に含まれる |
| Advertising | NO | 広告を一切表示しない |

## 3. Mature Themes

| 設問 | 回答 | 理由 |
| --- | --- | --- |
| Profanity or Crude Humor | NONE | アプリ自身が表示・配信するコンテンツに該当なし |
| Horror/Fear Themes | NONE | 同上 |
| Alcohol, Tobacco, or Drug Use or References | NONE | 同上 |

注: 記述子はアプリが提供するコンテンツに対して回答する。ユーザー間で送受信される私的なファイル・テキストは、開発者が編集・配信するコンテンツではない（→ 10 節の要確認 ④）。

## 4. Medical or Wellness

| 設問 | 回答 |
| --- | --- |
| Medical or Treatment Information | NONE |
| Health or Wellness Topics | NONE |

## 5. Sexuality or Nudity

| 設問 | 回答 |
| --- | --- |
| Mature or Suggestive Themes | NONE |
| Sexual Content or Nudity | NONE |
| Graphic Sexual Content and Nudity | NONE |

## 6. Violence

| 設問 | 回答 |
| --- | --- |
| Cartoon or Fantasy Violence | NONE |
| Realistic Violence | NONE |
| Prolonged Graphic or Sadistic Realistic Violence | NONE |
| Guns or Other Weapons | NONE |

## 7. Chance-Based Activities

| 設問 | 回答 | 理由 |
| --- | --- | --- |
| Gambling | NO | 実貨の賭け事なし |
| Simulated Gambling | NONE | 賭け事を模した機能なし |
| Contests | NONE | ランキング・報酬・競技の仕組みはない |
| Loot Boxes | NO | 課金・ランダム購入なし |

## 8. 推定レーティング

- グローバル（iOS 26 以降向け）: **4+**（Messaging and chat は 4+ の定義に含まれるため）
- グローバル（iOS 26 未満向け）: **4+**（問題となる記述子が一切ない）
- Age Categories and Override: Not Applicable（Made for Kids は不可逆の選択のため選ばない）。Override to Higher Age Rating も使用しない（計算値のまま）。
- Age Suitability URL: 任意項目のため未設定でよい。

### 地域レーティング

| 地域 | 影響 | 備考 |
| --- | --- | --- |
| 韓国（GRAC） | 要確認 | Games / Entertainment カテゴリ（主・副）のアプリに地域レーティングが表示される。→ カテゴリ未確定のため要確認 ②。Utilities / Productivity 等なら追加対応は不要（「All」相当） |
| オーストラリア | なし | Games の Loot Boxes / Simulated Gambling に該当しない |
| ブラジル | なし | 賭博機能がないため AL 相当。固定オッズ賭博の免許も不要 |
| フランス | なし | 17+ のグローバルレーティングにのみ追加表示あり。4+ なので該当しない |
| ベトナム | なし | 00+ 相当 |

## 9. ユーザーコンテンツと Web アクセスの考え方（補足）

- **端末間のプライベートなテキスト送受信**: 「Messaging and Chat」に該当し、4+ の定義に含まれる。公開フィード・プロフィール・検索など第三者が閲覧する仕組みがないため「User-Generated Content」（広範な配布）には該当しない。
- **Web アクセス**: アプリ内から開けるのは固定の 2 ページのみで、いずれもシステムのブラウザで開く。組み込みブラウザがないため「Unrestricted Web Access」は NO と判断する。
- 受信ファイルは送り手と受信者の間だけを移動し、アプリのサンドボックスに保存される。

## 10. 未確認・要確認リスト（人間の判断が必要）

1. ~~Unrestricted Web Access の最終判断~~（決定済み: NO と確定。開くリンクは自社サイトの固定 2 ページのみ。2026-09-23）
2. **韓国 GRAC の地域レーティングの要否**。アプリのカテゴリが Entertainment の場合に追加対応が必要。
3. **iOS 26 未満の旧設問フォームの文言・選択肢の差異**。提出画面で実際の設問を確認し、本回答案を読み替える必要がある。
4. ~~プライベートなユーザー生成コンテンツ（送受信されるファイル・テキスト）の扱い~~（決定済み: App プライバシーでも「収集しない」と整理し、UGC の広範な配布にも該当しない。2026-09-23）
