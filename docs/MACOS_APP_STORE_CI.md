# macOSのActions archiveとManaged署名（経路A）

今回の提出候補は、GitHub Actionsでarchiveとlocal sandbox appを生成し、本人のMacにある既存Apple Distribution identityとXcode accountを使ってManaged Installer署名のpkgを書き出す方式です。Apple upload/submitは行いません。通常配布release、Pages、iOS workflowは変更しません。

## AのActions実行前

1. `macos-app-store.yml` は手動のみです。GitHubのworkflow_dispatchにはworkflowがdefault branchに存在する必要があります。今回のfeature branchのpushだけでは実行を保証できず、mainへのmergeは別途承認が必要です。
2. 本人がASCの現在のmacOS最大build番号を確認して`previous_build`へ入力します。`build_number`は明示指定するか、既定 `(1000 + run_number).0.run_attempt` を使います。過去番号以下は拒否し、番号上限で剰余による再利用はしません。ASCへの問い合わせや他の提出との重複自動保証はありません。最新番号が未確定なら実行しません。
3. AはApple Secrets、API key、p12、profile、keychain設定変更を必要としません。arm64 `macos-26`、Xcode26.4、Go1.27.1、Rust1.94.0、Node24、Tauri CLI2.10.0、XcodeGenを使用し、実際の版を記録します。runner availability・容量・実buildは未検証です。
4. 公式ActionsをSHA固定、contents:read、checkout credentials非保持で使用します。実行は今回まだ行っていません。

## Aのartifact

`Ponlet-macOS-Archive-RUN-ATTEMPT`には次を保存します。

- `Ponlet-preflight.xcarchive.zip`：Store署名資材なしのarchive。完全な未署名Mach-Oではなく、検証用ad-hoc sandbox署名を含みます。
- `Ponlet-local-sandbox.zip`：同一jobの撮影・実機検証用app。
- `build-input.json`：commit、submodule、version/build、toolchain、run URL、入力clean状態。
- main/shareの実効sandbox・App Group・版・arm64/x86_64・privacy manifest検査結果、署名除去後4sliceコードhash、frontendファイルhash、ZIP等のSHA256。
- 利用可能ならbuild側のdSYM。CPU UUIDが対応することを確認し、空のUUID結果や不一致は拒否します。

Xcodeのbuildとarchiveでnative wrapperが異なる可能性があるため、archiveのProductsに検証したlocal appを格納します。4sliceコードhash一致を必須にします。コード比較はMach-Oの範囲であり、resources/dSYM全部の同一性を保証するものではありません。元ソース・入力SHAとfrontend hashも記録します。

## 本人MacでのManaged export

Aの成果物をrepo外へ取得します。同じsource commitのclean checkoutで、reviewしたcommit SHAとarchive ZIPのSHA256を指定し、`scripts/export_macos_archive_on_mac.sh`を使う候補です。ZIP経路、manifest、版・権限・コードを認証前に検査します。

本人が指定する非秘密の入力：

- `EXPECTED_SOURCE_COMMIT`相当の完全SHA、archive ZIPのSHA256（scriptの引数）。
- `PONLET_MAC_MAIN_PROFILE`：`jp.yasagure.ponlet`の既存OSX Store profile。
- `PONLET_MAC_SHARE_PROFILE`：`jp.yasagure.ponlet.share`の既存OSX Store profile。
- 既存Mac account・Managed署名の利用を本人が確認して`PONLET_CONFIRM_EXISTING_MANAGED_SIGNING=yes`。

例（まだ実行していません。パス・SHAは本人の確認値へ置換）：

```bash
PONLET_CONFIRM_EXISTING_MANAGED_SIGNING=yes \
PONLET_MAC_MAIN_PROFILE='/path/to/main.provisionprofile' \
PONLET_MAC_SHARE_PROFILE='/path/to/share.provisionprofile' \
bash scripts/export_macos_archive_on_mac.sh \
  /path/outside/repo/archive-artifact FULL_SOURCE_COMMIT ARCHIVE_ZIP_SHA256 \
  /path/outside/repo/new-export-output
```

本体/shareは同じTeam K7VNGA9K78、App Group group.jp.yasagure.ponlet.k7vnga9k78、同じ期限内Distribution証明書に対応する必要があります。iOS sharek、開発用profile、Developer ID Installerは使いません。既存Apple Distribution identityでapp/shareを署名し、`signingStyle=automatic`でManaged Installer exportします。API keyや`-allowProvisioningUpdates`は渡さず、新しいkeychain/profileのインストールもしません。Xcode accountや秘密鍵利用のアクセス要求、新規証明書/rotationが必要になれば止めて本人へ報告します。

以前、このMacではローカルDistribution署名済みappからautomatic exportが成功し、ログにRemotePackageSigningToolが確認されました。しかし今回の新しいad-hoc staging archiveから再署名・Managed exportするscript、GitHub製archiveからのexportは未実行です。構造検査の成功をexport成功とは扱いません。

export後はInstallerのApple-issued署名、Store app/shareのDistribution種類・証明書・profile・版・権限を検査し、CIと4sliceコードhash一致を確認します。pkgと公開検査記録だけ保存し、decoded profile・私的exportログは保存先へコピーしません。Appleへ送信しません。

## Bの並行実験と旧manual方式

Bは[MACOS_MANAGED_EXPORT_CI.md](MACOS_MANAGED_EXPORT_CI.md)を参照。A成果物を再buildせずAPI認証でManaged exportする別workflowです。実験承認は既定falseで、p8登録・権限追加・外部実験は未実施。Aの提出をBの成功待ちにしません。

旧`scripts/build_macos_store_ci.sh`はlocal秘密鍵付きStore Installer p12がある場合のmanual方式として残していますが、A/B workflowは使いません。KMと統一した`MACOS_APP_CERT_P12/PASSWORD`、`MACOS_INSTALLER_CERT_P12/PASSWORD`の名前はこの旧方式に維持します。Managed Installerをp12へexportすることは要求しません。Aにはこの7 Secretsの登録は不要です。

## 検証限界と動画

既存撮影v2はこのMacで作った1.0.18/build1.0.19のlocal sandbox版です。新CI成果物と自動的に同一と扱わず、生成後に実測して差異があれば再検証・必要な撮影を行います。新archiveの構造・後署名可否と、実Managed exportの成功は別の確認です。

参照：[Cloud-managed certificates](https://developer.apple.com/help/account/certificates/cloud-managed-certificates/)、[CFBundleVersion](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion)、[workflow_dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)、ローカルXcode26.6 `xcodebuild -help`。
