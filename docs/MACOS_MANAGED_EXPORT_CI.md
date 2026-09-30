# Actionsだけで完結するManaged署名の実験

通常の再提出経路は、archive-only Actionsで検証済みarchiveとlocal sandbox appを生成し、このMacのXcodeでManaged署名・pkg exportする方式です。この文書のB workflowはそれとは別の実験で、実行成功は未検証です。ローカルInstaller秘密鍵のp12を必須にはしません。

## 承認と実行の分離

`macos-managed-export.yml` はworkflow_dispatchだけです。`authorize_cloud_signing` はfalseが既定で、falseならjobを実行しません。今回の実装・push承認だけではCI実験の実行、API key登録、権限追加、新しいprofile/certificate作成は行いません。本人がkey種別・role・cloud署名権限を確認し、Xcodeによるprofile/cloud certificate作成・更新を含む実験を別途承認した後に実行します。

既存Secretsへの読取が拒否された経緯を踏まえ、別認証での照会や秘密値の読出し・Macからの転送は行いません。必要なSecretsは以下の3つです。既存値の存在・適合性は未確認です。

| Secret                        | 内容                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| APP_STORE_CONNECT_PRIVATE_KEY | 本人が安全に管理するTeam App Store Connect API keyのraw PEM p8。Base64ではありません |
| APP_STORE_CONNECT_KEY_ID      | そのkey ID                                                                           |
| APP_STORE_CONNECT_ISSUER_ID   | Team issuer ID                                                                       |

Team keyはroleで操作が制限されますが、app単位には限定できません。Individual keyはProvisioning APIを利用できず、今回のprovisioning/cloud署名候補に適合すると扱いません。最低roleを断定せず、Certificates, Identifiers & Profilesとcloud-managed certificatesの権限を含め実際のTeam設定を本人が確認します。API keyの新規作成や既存keyへのアクセス拡張は実装範囲に含めません。GitHubのrepository Secrets入力欄へ本人が直接登録し、チャット・Issue・ログに貼らないでください。

default branchにworkflowが存在することがworkflow_dispatchの前提です。現在のfeature branchへのpushだけでは実行できず、mainへのmergeは別途承認が必要です。

## 入力と検証

- Aの成功run IDとartifact名を指定します。downloadはこのrepositoryのartifactに限定され、buildを繰り返しません。
- レビューしたAの完全なsource commit SHAと`Ponlet-preflight.xcarchive.zip`のSHA256を本人が入力します。manifestのclean入力・各成果物hash、ZIPのpath/symlinkを確認してから展開します。
- Aのarchiveは同じjobのlocal sandbox appを格納した署名資材なしのarchiveです。実行ファイルにad-hoc sandbox署名があります。「完全な未署名Mach-O」とは扱いません。
- 指定archiveとlocal appのversion/build・権限・実行コードを照合します。export後も本体・共有拡張のStore署名/profile/App Group/sandbox・privacy manifest、Installer署名を検査し、local appとの署名除去後4slice SHA256一致を必須にします。
- `method=app-store-connect`、`destination=export`、`signingStyle=automatic`、`manageAppVersionAndBuildNumber=false`でXcode26.4を使用します。この版がrunnerにない場合は失敗します。archiveからのautomatic署名、API keyによるManaged Installer署名、標準runnerでの処理は未検証です。

## 外部操作と秘密の扱い

`-allowProvisioningUpdates`とauthentication key path/ID/issuerを使います。XcodeはApple Developerへ通信し、profileやcloud-managed certificateを作成・更新し得ます。これは読み取り操作ではありません。Appleへのアプリupload、review submit、notarizationは含めません。

API keyはpermission0700のprivate scratch下へ0600で保存し、環境からunsetしてから後続検証・exportを実行します。成功・失敗・INT・TERMでscratchを削除し、削除失敗もjob失敗とします。強制終了時の残留はGitHub-hosted ephemeral runner破棄に依存します。自動署名が作るXcode側の公開profile/cacheもそのrunnerに限られます。

Secretsは署名step以外のdownload/setup/upload Actionsへ渡しません。exportログ、p8、認証キャッシュ、decoded profile、keychainはartifactに含めません。出力は検証済みpkgと公開署名・実行権限・hash・archive source情報・export helper SHA/toolchain/run URLだけです。pkgには配布に必要な公開profile/certificateが含まれます。公開repositoryのActions artifactを取得できる利用者にも配布候補が見える可能性があります。

## 現在の証拠と限界

このMacでは既存Xcode accountでManaged Installer署名pkgのexportが成功しました。その成功はGitHub runner/API key経路の成功とは区別します。AppleはXcode13以降のOrganizer配布にcloud署名を説明しています。このMacのXcode26.6 helpはmanual archiveからautomatic exportでmanaged certificate/profileを用意できることと、API key引数を示します。しかしad-hoc staging archiveをGitHub runnerからAPI keyでexportできることは、この実装だけでは証明できません。失敗した場合は通常のA→Mac export経路を維持します。

既存撮影動画は1.0.18/build1.0.19のローカル検証版です。Aの新しい成果物の同一性を自動的に主張せず、コード・権限の実測比較と必要な再検証を行います。

参照: [Cloud-managed certificates](https://developer.apple.com/help/account/certificates/cloud-managed-certificates/)、[App Store Connect API](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/)、[Roles and access](https://developer.apple.com/help/account/access/roles/)、ローカルXcode26.6 `xcodebuild -help`。
