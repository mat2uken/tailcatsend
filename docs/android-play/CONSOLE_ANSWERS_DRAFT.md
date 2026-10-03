# Play Console未完項目の回答草案

内部レビュー用。フォームを保存・送信していない。2026-10-03 UTCの親担当の読み取りでは設定完了は8/13。dashboardの未完はData safety、category/contact、listing、merchant account、価格設定。カテゴリはTools登録済み、contactは空、listingは未作成、価格はロック表示。App content側はData safetyとAdvertising IDの2申告が未完。Policy centerは未審査のため情報がまだ表示されていない。未表示を違反なし・審査通過と扱わない。以下をConsoleの最新の設問と提出AABに合わせて確定する。

2026-10-03 17:59 UTCにユーザーが承認：Play本体無料、子ども向けを意図しない一般向け、Android受信ファイルのクラウドバックアップ除外、広告ID無効化。Analytics／Crashlyticsは既定ONとOFF操作を維持する。具体的なPlay年齢区分とConsole選択は未実施、D2D移行の対象範囲は拡張しない。


新候補の未署名AAB `versionCode=2030000102` は親担当の最終artifact validatorで確認済み。compiled manifestの広告ID取得・広告personalization flagsは両方false、3広告関連権限は不在。compiled resourcesからbackup XMLを解決し、API31+のcloudでは `received/` だけを除外、SharedPreferencesと隣接ファイルを保持、空のD2D規則は既存の対象を保持することを確認した。これはOS復元試験・実通信・署名・Play配布の成功を意味しない。詳細は [承認後の方針検証](POLICY_VALIDATION_RESULTS.md) を参照。

## 回答候補と残る確認

| 設定 | 回答候補／入力案 | 状態・根拠 |
| --- | --- | --- |
| アプリ名 | Ponlet | パッケージ `jp.yasagure.ponlet` と一致させる |
| アプリ種別／カテゴリ | アプリ。Tools登録済み | Toolsを維持する候補。通信があるだけで公開SNSと分類しない |
| App access | アカウント登録・ログイン・demo credentialは不要。二つの端末、またはAndroidとWebで転送を再現できる。機能に必要なのは相手との接続とインターネット | `web-ui/src/main.ts`、公開support。カメラ拒否でもURL貼付で接続可能。[審査員手順](REVIEW_AND_TEST_PLAN.md)を使用 |
| 広告を含むか | 広告表示なしを候補 | 広告UI／広告配信SDKは確認されていない。Advertising ID設問とは別 |
| Advertising ID | 既存1.0.18には `AD_ID` 等が存在。新候補は広告ID無効化と3広告関連権限除去の方針を承認済み | 未署名候補のflags／権限は検査済み。署名する提出AABと既存配布版を含むConsoleの回答範囲を確認後、申告案を確定する。今回はConsoleを変更しない |
| Data safety | 収集あり。利用状況、診断・クラッシュ、識別子、IP由来概略位置、ML Kitに加え、未評価のOSバックアップ経路を確認 | [Data safety草案](DATA_SAFETY_DRAFT.md)。共有・任意性・削除・暗号化・バックアップ対象と適用除外の確認を完了してから保存 |
| Privacy URL | 日本語 `https://ponlet.mat2uken.app/privacy_ja.html`、英語 `https://ponlet.mat2uken.app/privacy_en.html` | 4ページHTTP 200確認済み。ただし本文は [修正草案](PRIVACY_SUPPORT_DRAFTS.md) の整合修正が必要 |
| Support URL / email | `https://ponlet.mat2uken.app/support_ja.html`、`https://ponlet.mat2uken.app/support_en.html`、`app-support@mat2uken.app` | Consoleのcontactは空。emailと任意のwebsite欄に入力する候補。公開読取確認済み。Android保存案内の追記候補あり |
| 価格・課金 | **本体無料は承認済み**。配布国は未決定。アプリ内課金・subscriptionを実装しているコードは確認されていない | merchant account未完、価格設定はロック表示。解除条件をConsoleで確認する。App Store説明の「IAPなし」をPlayでのアプリ価格決定へ転用しない。無料方針を記録するが、Console価格設定は今回操作しない |
| 対象年齢／ターゲットユーザー | **子ども向けを意図しない一般向けで承認済み** | Appleレーティングから流用しない。具体案は18歳以上を最初の候補とする。子ども向け題材を持たない本人間の転送ツールで、未成年を意図した紹介は未確認。実際のブランド・想定利用者を所有者と最終確認する。年齢確認や未成年利用禁止の決定ではなく、Console選択はしない |
| Content rating / IARC | テキストやファイルをユーザーが選んだ相手に直接送る機能はある。公開タイムライン、ユーザー検索・推薦、サーバー保存投稿、アプリ内購入、ギャンブル機能は確認されていない | 正確な設問を読み、ユーザー間通信／共有を「なし」と一括回答しない。実年齢レーティングはIARC回答から決定する |
| アカウント削除 | 通常利用に作成・ログインするアカウントなし | アカウントなしとSDKデータ削除不要は同義ではない。Data safetyとprivacyの削除手順は別途確定 |
| Financial features | 金融サービス／決済機能は確認されていないため「なし」を候補 | ユーザーが任意の金融文書を転送できることと、アプリが金融サービスであることを分ける。設問を再確認 |
| Health apps | 健康機能／Health Connect利用は確認されていないため「なし」を候補 | 任意の健康文書転送と、健康機能・健康データ取得を混同しない。設問を再確認 |
| Government apps | 政府機関による提供・政府向け専用機能は確認されていない | 所有者の実際の立場を確認してから回答 |
| News apps | ニュース提供機能は確認されていないため「なし」を候補 | Consoleに表示される場合に回答 |
| ストア説明／screenshots | Android現行機能を説明し、同じ提出候補のAndroid画面を使用 | iOS共有拡張／macOS保存先、受信ファイル共有機能をAndroidに保証しない。iOSの審査実績をAndroidの動作保証にしない |

本体無料と一般向け、cloud受信除外、広告ID無効は承認済み。配布国、具体的なPlay年齢帯、データ削除方法、外部Googleサービスの設定はなお確認が必要。未確定のままデフォルト値を保存しない。

## 短いアプリ説明案

日本語：`招待QRやURLでつながり、端末間でファイルとテキストを送れます。`

English: `Connect with an invitation QR code or URL to transfer files and text between devices.`

価格・広告ID・SDK診断の説明と矛盾しないことをレビューする。「一切のデータを収集しない」「すべての通信が常に直接P2P」「Androidのダウンロードフォルダへ自動保存」とは説明しない。

## 本番アクセスまでの準備

親担当が確認したConsoleはclosed testの12人・14日条件を示し、確認時点の参加人数は0人。内部テストの有効化はこの条件を満たした証拠ではない。対象アカウントに表示される最新の条件に従う。

1. 本書の未確定項目を所有者と確定し、Data safety／privacy／release検証を完成させる。
2. closed test対象者・募集方法・連絡方法を決める。候補一覧の作成だけで参加・opt-in済みと記録しない。
3. 配布を別途承認した後にclosed test releaseとopt-in URLを設定する。現行の16 KB非対応AABをそのまま本番候補にしない。
4. 実際のopt-in状態と連続期間をConsoleで記録し、通常利用・不具合・改善点を集める。メールや外部への招待送信は別の明示許可を得る。
5. Consoleが条件達成を認識したら、テスト内容、フィードバック、変更、公開準備状況を証拠に基づいて本番アクセス申請へ回答する。
6. 本番アクセス許可後も、release提出・段階公開・全公開を同一操作として扱わず、最新のConsole状態を確認する。

この文書の作成は、closed testの開始、対象者への連絡、Console保存、本番申請、審査提出の実行を意味しない。
