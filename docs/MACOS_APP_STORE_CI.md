# macOS App Store packageをGitHub Actionsで作る

この手動workflowはStore向けpkgと、同じ生成物から作る撮影・実機検証用sandbox appを出力します。Appleへのupload/submit、GitHub Release公開は行いません。通常配布のrelease.ymlとPages workflowは変更しません。

## 実行前に必要な確認

1. 本体 `jp.yasagure.ponlet` とMac共有拡張 `jp.yasagure.ponlet.share` のmacOS Store profilesが、Team `K7VNGA9K78`、App Group `group.jp.yasagure.ponlet.k7vnga9k78`、同じApple Distribution証明書に対応していることを確認します。iOSのsharek profileは使いません。
2. App Store Connectで現在のmacOS最大build番号を本人が確認し、`previous_build` に入力します。CIはAppleに問い合わせません。入力の正しさ・他の提出との重複は自動保証されません。
3. `build_number` が空ならこの専用workflowの `(1000 + run_number).0.run_attempt` を使用します。再実行も別番号です。過去番号より小さい/同じ場合は失敗し、本人がより大きい未使用番号を明示入力します。各桁は保守的に1..9999、0..99、0..99とし、桁上限を超えても剰余で再利用しません。これは実装の制限です。Apple現行文書は1〜3個の整数をピリオドで区切る形式を示します。
4. 指定したXcode 26.4がstandard arm64 `macos-26` runnerに存在する必要があります。存在しなければ明確に失敗します。実runnerでのavailabilityとuniversal build/exportはまだ未検証です。runnerの7GB RAM/14GB空き容量で足りるかも未検証です。有料large runnerへの変更はしていません。

## 本人が登録するGitHub Actions Secrets

GitHub repository Settings → Secrets and variables → Actions → New repository secretで以下を登録します。Secrets設定への既存読取は403だったため、登録状態は未確認です。別アカウントや権限で迂回しません。CI実装のためにこのMacから秘密鍵を読み出す/転送する操作は行っていません。

| Name                             | 入れる物                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| MACOS_APP_CERT_P12               | 本人が管理するApple Distribution証明書と秘密鍵のpassword付きp12をBase64化した1行                |
| MACOS_APP_CERT_PASSWORD          | 上のp12のpassword                                                                               |
| MACOS_INSTALLER_CERT_P12         | 本人が管理する3rd Party Mac Developer Installer証明書と秘密鍵のpassword付きp12をBase64化した1行 |
| MACOS_INSTALLER_CERT_PASSWORD    | 上のp12のpassword                                                                               |
| MACOS_STORE_PROFILE_BASE64       | 本体の有効なmacOS App Store provisionprofileをBase64化した1行                                   |
| MACOS_STORE_SHARE_PROFILE_BASE64 | Mac共有拡張の有効なmacOS App Store provisionprofileをBase64化した1行                            |
| KEYCHAIN_PASSWORD                | このjobだけの一時keychain用の十分長いランダムpassword                                           |

証明書4項目のSecret名はkmvirtualcameraと共通ですが、PonletにはApp Store用のApple Distribution／3rd Party Mac Developer Installerを登録します。Developer ID Application／Installerは今回のStore提出に流用しません。p8のnotary/APIキーはarchive/export-onlyの本workflowには不要です。

Base64は暗号化ではありません。安全なローカル環境で本人が作成し、チャット・Issue・リポジトリ・ログに貼らず、GitHubのSecret入力欄へ直接登録します。既存iOS secretsは上書きしません。App Store Connect API keyは不要です。新規証明書/profileが必要な場合は別途確認します。

## 検証と安全性

- workflow_dispatchのみ、contents:read、checkout credentials非保持。第三者setup/upload Actionsは公式repositoryのcommit SHAで固定。Rust/Go/Tauri CLI/Xcodeを明示し、実際の版を記録します。Node24とXcodeGenのpatch版はrunner/install時の状態に依存し、manifestに記録します。完全なbit単位再現を保証しません。
- Secretsは不足を確認する短いpreflightと署名shellだけに渡し、他のActionsやfrontend検査には渡しません。値を表示せず、コンパイル前に環境からunsetします。private scratchとkeychain以外へp12を保存しません。cleanupは成功・失敗・INT・TERMでprofileを削除し、keychain検索リスト/既定を復元して一時keychainを削除します。強制runner終了時はGitHub-hosted ephemeral VMの破棄に依存します。
- profileのteam、bundle、platform、Store種別、期限、App Group、証明書一致を確認。本体と共有拡張のversion/build、arm64+x86_64、署名、実効sandbox entitlements、privacy manifestを確認します。
- manual exportで証明書fingerprintと両profile UUIDを指定します。`-allowProvisioningUpdates` は使いません。pkg Installer署名team、展開payloadのDistribution証明書とprofileも検査します。
- local sandbox appとStore payloadの両実行ファイル4sliceについて署名除去後SHA256が一致することを必須にします。署名/profileは異なります。Store用のapplication/team identifierを追加しますが実行権限は同じです。
- artifactは検証後のpkg、local sandbox app ZIP、version/build/commit/submodule/toolchain/run URL、検証結果、実行コードと成果物SHA256だけ。p12、private keys、decoded profiles、keychain、exportログ、環境dumpを含めません。Store pkgには配布に必要な公開証明書/profileが含まれます。公開repositoryのActions artifactはアクセス可能な利用者に取得され得るため、未公開にしたいアプリコードの扱いを実行前に確認してください。

## 撮影済み動画との対応

既存v2動画はこのMacで作った1.0.18/build1.0.19のlocal sandbox検証版です。今後CIで作るappと自動的に同じとは扱いません。CIの実行コード・実効権限を既存版と照合し、不一致ならCIのlocal sandbox appで実機検証・必要な撮影を行います。同じjob内のpkgとの一致は記録しますが、Appleによる再処理後の配布物まで同一だとは主張しません。

## 実装段階の検証限界

workflow構文、shell lint、Pythonの番号/profile異常系、missing-secret早期失敗をローカル確認します。既存1.0.18/build1.0.19のappでmetadata/binary照合方法を確認できますが、新しいCI生成物の成功証拠とは区別します。今回workflowのpush・実行、Secrets登録、Apple送信は未実施です。既存のローカル署名用verify scriptやMacの識別子は変更せず、CI生成時だけMacの本体/拡張build番号を揃えます。

参照: https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion ; https://docs.github.com/en/actions/reference/runners/github-hosted-runners

## 今回のローカル検証結果

基底commit a8b08db、feature/macos-store-ciの未コミット新規6ファイル。actionlint、shellcheck、bash構文、7件のPythonテストを確認済み。Secrets不足、番号の範囲・前番号との比較、iOSを保持した両Mac番号更新、profile異常系、一時keychain作成失敗と証明書import失敗時の後始末を模擬コマンドで検証しました。実keychainは変更していません。

既存1.0.18/build1.0.19のlocal sandbox appとStore書き出しappで、新しいbundle検査（版、両architecture、実効権限、privacy manifest、Store公開署名証明書・profile）を確認しました。署名除去後の本体/共有拡張4slice hashも一致しました。これらは既存成果物による検査手法の確認であり、新CI成果物ではありません。隔離したtrackedコピーにbuild1001.0.1を設定し、XcodeGen生成と両Mac Info.plistへの反映も確認しました。

web-uiはoffline npm ci（install scriptsなし）、lint、typecheck、format成功。既存132テストは131件成功＋sandboxによるHTTP待受EPERMの1件を通常権限で再実行し成功しました。元main・既存ビルド用worktreeの変更を保持し、push、PR、Actions実行、Secrets登録、Appleへの送信は行っていません。
