# App Store 提出チェックリスト（iOS・iPadOS・macOS）

対象: Ponlet 1.0.14。バンドル識別子は `jp.yasagure.ponlet`。iOS 17.0 以上の iPhone・iPad に対応する。
基準日: 2026-09-24。提出物を生成した時点のブランチは `feature/ios-share-inbox`、HEAD は `32d4a0b`。ビルドやスクリーンショットには当時の未コミット変更も含まれるため、この HEAD 単独の成果とは扱わない。

これは 1.0.14 の提出時点の記録である。統合先の 1.0.17 は共有拡張 ID が `jp.yasagure.ponlet.sharek7vnga9k78` で、Firebase Remote Config を使用しない。以下の ID・SHA・署名・端末での確認結果は 1.0.17 の提出・検証結果を示さない。審査状態や公開状況も提出時点の記録であり、現在の App Store Connect の状態は再照会していない。本文中のコードの行番号や `dist/privacy_ja.html` の行番号も提出時点のものである。

この文書は提出担当者が生成物、回答案、残る操作と検証を確認するための一覧である。状態は次の意味で使う。

- 済: 記載した範囲の生成物や内容を確認済み
- 作業中: 生成・検証・提出が未完了
- 要判断: 提出担当者による判断や App Store Connect での操作が必要
- 任意・見送り: 現時点で提出しない項目

旧候補はアップロード検証で拒否された。修正版の iOS・macOS は App Store Connect への提出を完了し、審査待ち。審査通過と公開は未確認。

## 1. アプリのビルドと識別情報

| 項目 | 状態 | 場所・備考 |
| --- | --- | --- |
| バンドル識別子 | 済 | `jp.yasagure.ponlet` |
| ShareExtension | 済（修正版で検証） | `PonletShareExtension`。識別子を変更 |
| バージョン | 済 | iOS / iPadOS 1.0.14 |
| 対応デバイス | 済 | iPhone・iPad |
| 最小 iOS | 済 | 17.0 |
| App Store 用アイコン | 済 | 1024x1024、不透明。全18サイズ |
| 輸出コンプライアンス | 済 | 非免責の暗号化は使用しない（NO） |
| アイコンの図柄統一 | 済 | 二重リング |
| `CFBundleDisplayName` | 済 | 追記しない方針 |
| iOS / iPadOS Store IPA | 済（アップロード・処理） | `target/ios-appstore/Ponlet-fixed-share.ipa` |
| macOS 配布署名済みアプリ | 済（新 UI 版ローカルビルド） | universal、実物 QR 読取・接続・再読取を確認 |
| macOS Store パッケージ | 済（アップロード・処理） | `target/macos-xcode/exports/Ponlet-fixed-share.pkg` |
| Intel Mac 実機での起動 | 見送り | x86_64 版のビルド・署名を確認。実機起動は未確認 |

識別子は `apps/tauri/tauri.conf.json` と `apps/tauri/gen/apple/project.yml` を参照。共有拡張の修正後の識別子は `jp.yasagure.ponlet.share`。Apple Developer で新 App ID に既存の App Group を割り当て、iOS・macOS 用プロファイルを再発行した。修正版の署名も検証済み。`CFBundleShortVersionString` と `CFBundleVersion` は修正版の本体・共有拡張で 1.0.14 に一致する。TestFlight CI はビルド番号を日付ベースに上書きする（`.github/workflows/testflight.yml`）。iPad 対応は継続する方針で、`TARGETED_DEVICE_FAMILY = "1,2"` である。

App Store 用アイコンは `apps/tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`。2026-09-23 に Tauri（`apps/tauri/icons/`）、macOS（`apps/desktop/`）、Web（`dist/` の favicon 類）、Android の図柄を統一した。Web の `favicon.ico` は実際の 16/32/48 サイズを収めた ICO に置換し、Android の hdpi 画像の寸法も是正した。iOS の AppIcon 一式は図柄の基準として変更していない。再生成用スクリプトは `scripts/generate_desktop_icons.swift`。参照されていない Android テンプレート XML 2 件は未変更。

2026-09-23 に `ITSAppUsesNonExemptEncryption: false` を両ターゲットで確認した。対象は `tailsend-tauri_iOS/Info.plist` と `ShareExtension/Info.plist`。申告方針は `fastlane/review_information/export_compliance_and_content_rights.md` の第2節に記録した。

`CFBundleDisplayName` は追記しない。未記載でも `CFBundleName` の `Ponlet` がホーム画面に表示され、実害がないため。

iOS / iPadOS の Store IPA は 2026-09-24 に生成・検証済み。ファイルは `target/ios-appstore/Ponlet-current.ipa`。

SHA-256: `4da2809bfd8f7e758ad49ca8393c44cd151bf902550d6deae2374a1e1b18b5be`

旧候補の本体と ShareExtension の Apple Distribution 署名、iPhone・iPad 対応、両方のプライバシー・マニフェストを検証した。ただし App Store Connect のアップロード検証では共有拡張の識別子に対する `90347` で拒否された。旧候補は提出しない。

修正版は `target/ios-appstore/Ponlet-fixed-share.ipa`。SHA-256 は `3159b08263da493bbdc52a5579119995f0e878efa0fe303bf57f890aadb19a6c`。本体・拡張ともに 1.0.14 で、新識別子・App Group・署名・プライバシー・マニフェストを確認済み。`altool` の検証とアップロードを通過した。App Store Connect のビルド ID は `80d5f4be-38b2-4a73-8e9f-3529fc7b32e4`。処理状態 `VALID`、`APP_STORE_ELIGIBLE` を確認済み。審査提出後は `WAITING_FOR_REVIEW`。

macOS の新 UI 版は 2026-09-24 にローカル署名済み universal ビルドを生成した。arm64 UUID は `CA70EA77-B59C-316C-8EE5-634BD126EB0A`。x86_64 UUID は `1D8593CB-8375-3479-B1CE-49AACB6AAFD1`。旧候補は `target/macos-xcode/exports/Ponlet-inline-qr.pkg`。SHA-256 は `adfe2a0537b0edbd1288292d3dd7245451a40ca61813c12964f1736cc7778b86`。`scripts/verify_apple_macos_distribution.sh` は成功し、署名・組み込みプロファイル・universal 本体と拡張を検証済み。`.pkg` 内の本体 UUID も上記と一致した。ただしアップロード検証では共有拡張の識別子に対する `90347` で拒否されたため、旧候補は提出しない。新 UI 版での実物 QR 読取・接続・取消後の再読取を確認済み。Intel Mac 実機での起動試験はユーザー方針により省略し、実機起動は未確認。

修正版は `target/macos-xcode/exports/Ponlet-fixed-share.pkg`。SHA-256 は `b8ded442afd45fce42a54db3db44249737839c2530bebdf09b95ced8a502952e`。macOS ネイティブ arm64・x86_64 を再ビルドし、本体と共有拡張の署名・App Group・権限・プライバシー・マニフェストを確認した。`altool` の検証とアップロードを通過した。App Store Connect のビルド ID は `47040301-9fd9-4e05-91cf-a9ec18fdb888`。処理状態 `VALID`、`APP_STORE_ELIGIBLE` を確認済み。審査提出後は `WAITING_FOR_REVIEW`。

旧 Store 用パッケージは `target/macos-xcode/exports/Ponlet-vision-qr.pkg`。arm64 UUID は `1CB3913B-5E3E-3B2E-B2C2-B0755EF0D58E`。SHA-256 は `c2c0d5da47bef1796867a01627bcbbf6db685932bf5b6bb6298342bc6e567a03`。署名・組み込みプロファイル・sandbox の検証、および同じ UUID の署名済みアプリでの FaceTime HD カメラのプレビュー、映像フレーム受信、取消後の再読取開始は確認済み。暫定ネイティブカメラパネル版の実物 QR 読取は、別の署名済み universal ローカルビルドで確認した。この版の arm64 UUID は `92F7222D-E19D-334D-AD47-6C585899B725`。x86_64 UUID は `AE6F71D1-CBAC-3449-B933-8D3A238253D0`。旧 `.pkg` は新 UI 未反映のため提出候補から外した。

## 2. プライバシー

| 項目 | 状態 | 場所・備考 |
| --- | --- | --- |
| プライバシー・マニフェスト | 済 | iOS 本体・ShareExtension に組み込み |
| Required Reason API | 済 | 各理由コードを設定 |
| 使用目的説明 | 済 | カメラ・ローカルネットワーク |
| プライバシーポリシー | 済 | 日本語・英語 |
| App プライバシー設問の回答 | 済（公開） | `app_privacy_answers.md` と照合 |
| 収集データの実態 | 済 | テレメトリは既定 ON |
| Coarse Location の申告 | 済 | 載せない方針 |
| Device ID の識別への紐付け | 済 | Not Linked |

本体のマニフェストは `apps/tauri/gen/apple/tailsend-tauri_iOS/PrivacyInfo.xcprivacy`。
共有拡張のマニフェストは `apps/tauri/gen/apple/ShareExtension/PrivacyInfo.xcprivacy`。
`project.yml` 経由で両ターゲットの Resources に組み込んだ。Required Reason API は UserDefaults `CA92.1`、File Timestamp `C617.1` と `3B52.1`、System Boot Time `35F9.1`。依存 SDK 分は各 SDK のマニフェストに委ねる。

使用目的説明は QR 読取用のカメラと、直接接続・転送用のローカルネットワークのみ。写真・マイク・Bluetooth・ATT・通知・バックグラウンド実行は使用しない。公開ポリシーの日本語版は `https://ponlet.mat2uken.app/privacy_ja.html`。英語版は `https://ponlet.mat2uken.app/privacy_en.html`。対応するファイルは `dist/privacy_ja.html` と `dist/privacy_en.html`。2026-09-24 に公開ページの設定操作案内を現行 UI に合わせて更新し、掲載内容を確認した。

App プライバシーの回答案は `fastlane/review_information/app_privacy_answers.md`。User Content（テキスト・ファイルのやり取り）は「収集しない」で確定（2026-09-23）。ファイル名・パス・転送内容・個人情報はテレメトリで送信しない（`crates/tailsend-telemetry/src/lib.rs` 8–13 行、121–126 行）。Crashlytics には custom key、log、非例外 error を渡していない（回答案の第8節⑤）。

2026-09-24、App Store Connect の App Privacy にデバイス ID、製品の操作、その他の使用状況データ、クラッシュデータ、その他の診断データを申告して公開した。５種ともユーザーに関連付けず、トラッキングしない。公開画面を再読込して保存状態を確認済み。Firebase の実送信項目と Crashlytics が自動生成するレポートの実データは未検証。

テレメトリはオプトアウト制・既定 ON とする判断を 2026-09-23 に確定した。実装（`PonletPlatformPlugin.swift` 238 行）、公開ポリシー（`dist/privacy_ja.html` 681 行）、回答案（同第8節⑥・⑨）の記載を統一済み。Coarse Location は申告しない方針で、マニフェストから除外し、回答案も「収集しない」とした（2026-09-23）。Device ID はアカウント・ユーザー ID がなく身元に結び付けられないため、「しない（Not Linked）」で確定した（同日）。

## 3. ストアメタデータ（fastlane deliver 形式）

| 項目 | 状態 | 場所・備考 |
| --- | --- | --- |
| 日英のアプリ名・説明文など | 済（登録・照合） | `fastlane/metadata/ja/`、`en-US/` |
| サポート URL | 済 | `https://github.com/mat2uken/tailcatsend/issues` |
| マーケティング URL | 済 | `https://ponlet.mat2uken.app` |
| 審査メモ（Notes for Review） | 済（英語版を登録） | 日英の原稿あり |
| 年齢レーティング設問の回答 | 済（登録） | 算出結果 4+ |
| 輸出・コンテンツ権利の回答 | 済（一部登録） | コンテンツ権利を登録済み |

`fastlane/metadata/ja/` と `fastlane/metadata/en-US/` に、アプリ名、サブタイトル、説明文、キーワード、プロモテキスト、リリースノートを用意した。各項目は文字数上限内と実測済み。上限は順に 30、30、4000、100、170、4000 文字。

2026-09-24、App Store Connect の iOS・macOS 初回版を両方とも 1.0.14 に更新した。日英の名前、サブタイトル、説明、キーワード、プロモテキスト、サポート URL、マーケティング URL、プライバシー URL を登録して API で照合済み。初回版の `whatsNew` は Apple API が編集を拒否したため空欄。両版とも審査状態は提出後 `WAITING_FOR_REVIEW`。審査通過後はユーザー指定により手動公開とする。

両版の著作権表示はユーザー指定の `2026 Kenichi Matsumoto`。主カテゴリはユーティリティ、副カテゴリは仕事効率化。24項目の年齢レーティング回答を登録し、算出結果は 4+。コンテンツ権利の回答は `DOES_NOT_USE_THIRD_PARTY_CONTENT`。両版に処理済みビルドを紐付け、公開方法 `MANUAL` を確認した。ユーザーが両版の審査連絡先を入力し、各４項目の保存を API で確認した。英語の審査メモも両版に登録済み。デモアカウントは不要と設定した。

価格はユーザー指定の日本税込500円、配信先はすべての地域。ユーザーは Business 画面の有料アプリ同意と EU 向け事業者情報の手続きを完了したと回答した。日本を基準地域として購入者価格500円を登録し、175地域すべてを配信対象とした。API で再取得して保存を確認した。ただし EU の27地域には `TRADER_STATUS_NOT_PROVIDED` が残るため、事業者情報の反映状況は未確認。全地域に `AVAILABLE_FOR_SALE_UNRELEASED_APP` と `CANNOT_SELL` があり、審査・公開前のため販売可能とは扱わない。

審査メモの日本語版は `fastlane/review_information/app_review_notes_ja.md`。
英語版は `fastlane/review_information/app_review_notes_en.md`。英語版を提出用、日本語版を添付用とする。年齢レーティング回答案は `fastlane/review_information/age_rating_answers.md`。Unrestricted Web Access は開くリンクが自社サイトのみのため「NO」で確定（2026-09-23）。

輸出コンプライアンスとコンテンツ権利の回答は `fastlane/review_information/export_compliance_and_content_rights.md`。BIS の年次自己分類レポートは「提出しない・必要なし」で確定（2026-09-23）。判断材料は同第3節に記録した。回答案が揃っていることと App Store Connect 上の回答・審査結果は別に確認する。

## 4. スクリーンショット

| 項目 | 状態 | 場所・備考 |
| --- | --- | --- |
| 6.9 型 iPhone（1320x2868）日英 | 済（登録・処理） | 各5枚、計10枚 |
| 13 型 iPad（2064x2752）日英 | 済（登録・処理） | 各3枚 |
| macOS（1440x900）日英 | 済（登録・処理） | 各1枚、RGB・アルファなし |
| 6.5 型（1242x2688） | 任意 | 未提供。6.9 型から縮小 |
| ShareExtension のシート | 見送り | 英語セットと表示言語が不一致 |

iPhone 画像は `fastlane/screenshots/ja/` と `fastlane/screenshots/en-US/` に各5枚。内容は招待 QR、接続、転送中、受信ファイル、メッセージ。2026-09-24 に全10枚を OCR とピクセル解析で検品した。言語が混ざらず、ステータスバーは 9:41 で、ダイアログなどの写り込みはない。

iPad 画像は同じディレクトリに各3枚。内容は QR と接続の横並び、転送中、メッセージ。検品済み。ステータスバーの日付は ja で「9月23日」、en で「Thu Sep 24」と表示される。全画像の時刻は 9:41。日付表記にはロケール間で軽微な差がある。

macOS 画像は `fastlane/screenshots-macos/ja/` と `fastlane/screenshots-macos/en-US/` にある。各1枚、1440x900 の RGB PNG でアルファなし。画像の準備完了は Mac Store パッケージの準備完了を意味しない。

2026-09-24、iPhone・iPad・macOS の計18枚を App Store Connect に登録した。全画像の処理状態 `COMPLETE` と画像サイズ・チェックサム・表示順を照合済み。

ShareExtension のシートは UI が日本語固定で英語セットと揃わないため見送り、iPhone の5枚目をメッセージ画面にした。必要なら後日追加する。撮影は iOS シミュレータ上の実際のアプリ UI。再現手順は iPad 分の `scripts/appstore_ipad_capture.sh` など `scripts/appstore_*` に記録した。画像プレビューが実ファイルと対応しない環境不具合があるため、検品には `scripts/appstore_ocr.swift` と `scripts/appstore_png_probe.py` を使う。

## 5. 提出前の確認事項

1. 2026-09-24、旧 iOS IPA と旧 macOS pkg は App Store Connect のアップロード検証で `90347` として拒否された。共有拡張の旧識別子 `jp.yasagure.ponlet.share.k7vnga9k78` に、親アプリの識別子以降のピリオドが二つあるため。拡張の識別子を `jp.yasagure.ponlet.share` に修正し、新 App ID に既存 App Group を割り当てた。iOS・macOS 用プロファイルも再発行して両方を再ビルドし、アップロード・処理済み。ビルド経路は `./scripts/build_tauri_mobile.sh ios release` と `.github/workflows/testflight.yml`。TestFlight CI を利用したときは、本体と ShareExtension の `CFBundleVersion` がビルド番号の上書き後も一致することを確認する。
2. 2026-09-24、暫定ネイティブカメラパネル版で Mac 内蔵 FaceTime HD カメラの選択と最初の映像フレームを確認した。iPhone 12 Pro の実物招待 QR も光学読取に成功した。ログは `selected camera`、`first video frame`、`finished (decoded)`。Mac 画面は「接続済み」と表示され、ユーザーも接続成功を報告した。既定の KM Virtual Camera を避けて内蔵カメラを優先する実装による結果。診断アプリによる生成 QR 画像の Vision 判定も確認済み。新 UI 版は別ウィンドウを開かず、既存の `scanner-preview` 枠に内蔵カメラのライブ映像を表示した。iPhone 12 Pro（旧 Ponlet 1.0.12）の画面にある実物招待 QR も光学読取した。Mac 側の `finished (decoded)`、WireGuard handshake、UI の「接続済み」を確認し、ユーザーも接続成功を回答した。切断後の scan3 はフレーム受信後に取消し、ログは `finished (cancelled)`。scan5 でもフレームを受信し、閉じた後もアプリは相手を待機中で再読取ボタンが有効だった。新 UI 版で取消後の再読取まで確認済み。
3. 1.0.14 の提出時、`NSBonjourServices`（`_tailsend._tcp` / `_tailsend._udp`）に対応する実装はコードにないことを確認し、ユーザー方針により `project.yml` と `tailsend-tauri_iOS/Info.plist` から削除した（2026-09-23）。統合先の 1.0.17 では main の設定を維持しており、両ファイルにこの値がある。`NSLocalNetworkUsageDescription` は実使用があるため残している。
4. 審査メモには既知の制限を記載する。共有シートを開いたままにする必要がある。バックグラウンド移行で送信が中断し、保存完了応答がないため稀に重複受信する。
5. 2台の接続は、実機2台または本アプリと Web 版 `https://ponlet.mat2uken.app/` の組み合わせで確認できる。2026-09-23 には iPhone XS 実機と Web 版で接続、QR 再生成、双方向テキスト、双方向ファイル転送を確認した。転送物は 131,071 byte で SHA-256 が一致した。同名ファイルの重複保存と DERP 経路も同条件で確認済み。詳細は `docs/IMPLEMENTATION_STATUS.md`。
6. ユーザー報告（2026-09-24）: iPhone 12 Pro の既存 Ponlet 1.0.12 で、Mac 版 1.0.14 の画面 QR を読み取った。Mac 版は署名済みで、iPhone カメラからの接続に成功した。iPhone→Mac のメッセージ `iPhone12Pro-1.0.12-20260924` は Mac 側の表示を確認。Mac→iPhone の `Mac1.0.14-to-iPhone1.0.12-20260924` は iPhone 側に届いたとの回答を得た。Mac→iPhone の最初のファイル送信は誤選択と `Connection closed` で失敗した。その後 `mac-to-iphone.txt`（69 byte）の送信完了を Mac 画面の 69/69 byte（100%）表示で確認した。iPhone 側でも受信できたとの報告を得た。iPhone→Mac の `04 Beat It.wav` は Mac 1.0.14 の受信一覧に表示された。`~/Downloads/Ponlet/04 Beat It.wav` に 45,680,588 byte で保存された。形式は WAV PCM 16 bit・stereo・44100 Hz。SHA-256 は `052da0962ecf1fc553543abe1f4c016adcf6a2eaba4a4d66f73f3bfd2904cc00`。元ファイルとの SHA-256 照合は未検証。
7. iPhone Air（iOS 27.0）に、受理済み Store IPA と本体・共有拡張の Mach-O UUID が一致する Ad Hoc 署名の 1.0.14 を上書きした。起動・招待 QR 表示と、以前の受信ファイルが残っていることを確認済み。カメラでの QR 読取、Document Picker、共有シートは未確認。iPhone 12 Pro の旧 1.0.12 は Team `UNSVNT8C85` と現行 Team `K7VNGA9K78` が異なる。データを残す上書きは不可で、旧アプリは削除していない。
8. ユーザー回答（2026-09-24）: 現行アイコンの元絵は自作で利用可能。「Ponlet」の名称も販売予定地域で調べ、使用可能と判断済み。OSS 通知は追加調査で不足を確認した。Go モジュール、Go 標準ライブラリ、`option-ext`、ICU4X、Firebase 関連などの原文を追加した。保存先は `dist/licenses/` と `THIRD_PARTY_LICENSES.md`。Cloudflare Pages の本番デプロイ `5b5a582e-4d64-41d9-aa5a-e251116be146` に反映済み。Rust 全依存の通知、最終ビルドの各 SDK と通知の照合、アプリからの通知原文への到達性は未確認。

macOS のファイルピッカーとシミュレータ間転送は、旧 `.pkg` と同じ arm64 UUID `1CB3913B-5E3E-3B2E-B2C2-B0755EF0D58E` で再確認済み。52 byte の送受信完了と SHA-256 `38fad959132e14504dd05d589aa375f2c0405016cce6f60fc061f5135ea22a19` の一致を確認した。修正版の審査結果はまだ確認していない。

## 6. App Store Connect への提出結果

2026-09-24、両版の審査申請を作成して提出した。Apple の API で各申請とバージョンを再取得し、指定したビルド、審査待ちの状態、手動公開の設定を照合した。提出時の検証エラーはなかった。

| 版 | 審査申請 ID | 状態 |
| --- | --- | --- |
| iOS・iPadOS | `0e5c9a25-4665-4f65-b3b4-b62377796d5b` | `WAITING_FOR_REVIEW` |
| macOS | `d76fed24-5f76-466b-951e-de86a607faa0` | `WAITING_FOR_REVIEW` |

Apple による審査通過と手動公開は未実施。EU では Ponlet の事業者区分が「トレーダーアプリ」に設定済みだが、地域別 API に `TRADER_STATUS_NOT_PROVIDED` が残る。ユーザーは必要な情報の入力完了を報告した。Apple による確認・地域への反映は未確認。iPhone Air の QR 読取、Document Picker、共有シートは、現行の提出ビルドと同一の本体・拡張バイナリで操作確認できていない。OSS 通知の全依存との照合も未完了。
