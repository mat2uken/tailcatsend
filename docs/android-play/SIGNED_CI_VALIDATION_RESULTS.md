# 配布を伴わない署名build検証

2026-10-03–04 UTC。ユーザー承認後に実装、独立レビュー、専用branchのpush、手動CI実行を行った。先行の [計画](SIGNED_RELEASE_VALIDATION_PLAN.md) の未実装・未実行という記述は、その計画作成時点の記録である。今回の実施範囲は以下に限る。

| 項目 | 実施内容 |
| --- | --- |
| repository / branch | `mat2uken/tailcatsend` / `feature/android-play-readiness` |
| CI対象SHA | `21b2ae525675eef5713774a14eb5437f41f2855d` |
| 製品コードの先行比較基準 | `5e0125797c2466918772a6722302d84219a1792a`。署名CI実装commitの追加差分は検証workflow・helper・fixtureで、製品コードの変更は含まない |
| workflow | 既存登録済み `google_play.yml` のfeature branch版、`mode=verify`、`confirm_deploy=false`、完全SHA入力 |
| run | [37158561946](https://github.com/mat2uken/tailcatsend/actions/runs/37158561946) |
| 上限 | request検査5分、署名検証job90分 |
| versionCode | `2030000102`固定。これより高い候補を提出する場合は、その候補を再検査する |
| 署名・Firebase入力 | 既存4署名入力とFirebase構成だけをrunner内で使用。値の表示・ローカルへの移送・新規credential設定なし |
|配布制御|配布jobのスキップをrun metadataで確認。検証jobにPlay credentialなし。Play / Release / artifact / cache uploadなし |
| runtime | install・起動・Firebase実通信なし。QR・転送・SAF等の合格として扱わない |

default branchへの登録変更は不要だった。mainへのmerge、tag、PR、サイト公開、Console変更、Play upload、審査提出は行っていない。別AuraGaugeのUSB・board・音声にも触れていない。

AAB/APKはartifactとして保存・移送しない。CI結果はそのrun内の実体に対応する。後続のruntime試験や提出で再生成した候補は、そのhash・署名・設定を新たに検査し、今回と同じ実体と呼ばない。

## 検査の構成

- SHAとdebug無効化を署名入力導入前に確認する。
- 署名helperの出力先を私有env fileに限定し、allowlist解析で子processへ渡す。生のbuild logは公開せず、安全な分類とhashだけを記録する。
- Google ServicesとCrashlytics plugin、生成設定、build IDを保持する。外部Gradle initでmapping/native upload設定をfalse、`uploadCrashlytics*` tasksを無効化し、dry-runと実buildのtask graphで確認する。
- AABのJAR署名、APKのapksigner検証、両者の公開証明書fingerprint一致を検査する。これはPlay App Signing証明書の照合やPlay版upgrade成功を保証しない。
- AAB/APK実体のversion・manifest・backup・広告関連設定・arm64 native・16KB配置を検査する。Firebase compiled設定は存在・project一致だけを安全にreportし、値は表示しない。
- 終了・中断時は所有マーカーとinodeを使い、今回生成した入力・設定と私有作業領域をcleanupする。

独立レビューに重大指摘なし。関連fixture 26件成功、workflowのactionlintと差分空白検査成功。fixtureの成功は実署名build成功とは分ける。

## 実行結果

**初回CIは失敗。** 2026-10-03 22:28:49–22:44:41 UTC、署名検証jobは約16分。request検査・完全SHA照合・安全性fixture 13件・tool setupは成功。配布jobはskipped、`always()` cleanupはsuccess、runのartifact数は0件。

公開ログの安全な失敗情報は `phase=build-apk` / `category=unclassified` / `log_sha256=ae39f3f321ade0f6cb568895613d63894e1cd281f1f01d3844e6ac6f544d4851`。私有build logはcleanupで破棄済みで、hashから原因を復元できない。鍵や私有ログの持出し・表示で診断を代用しない。

| 検査 | 結果と限界 |
| --- | --- |
| request / 完全SHA / debug無効 | PASS |
| tool setup | PASS |
| Gradle dry-run / upload抑止 | helperの制御順序上、次のAPK段へ進む前に成功。通常buildを安全に通したことと、成果物の最終署名検査は分ける |
| AAB build subprocess | 制御順序上、正常終了とtask graph markerを確認してAPK段に進んだ。独立artifact verifierはまだ実行されていない |
| APK build subprocess | FAIL。非0終了。原因は未分類 |
| AAB署名・APK署名・証明書一致 | NOT_RUN。AAB/APK両方の生成後に置いた検査へ到達せず |
| version・manifest・backup・広告設定・全native16KB・compiled Firebase設定 | この署名CIのartifact verifierではNOT_RUN。先行unsigned候補の成功を流用しない |
| 配布 / artifact upload | 配布job SKIPPED、artifact 0件 |
| cleanup | always cleanup step PASS |

再試行の前に、秘密を出さないphase timing・終了code・固定enumの診断を強化する。未分類の原因を決めつけて署名・Firebase・upload抑止を外したり、製品コードを変更したりしない。再試行は新しい実行SHAで記録し、この失敗runを書き換えない。

診断補強は実装済み。各phaseの開始・成功・失敗・中断、所要秒、終了code、私有logのhash、runnerの空きdiskと利用可能memoryの数値だけを記録する。失敗分類は固定enumの手掛かりであり、根本原因の証明ではない。生ログ・コマンド・path・env・設定値を出さない。関連safety fixtureは14件成功。製品コード、既存build script、workflow、署名入力、Firebase構成、upload抑止はこの診断補強で変更していない。

**診断補強commit作成時点では追加CI未実行。** 再試行の承認を確認後、下記runを実行した。`mode=verify` / `confirm_deploy=false` / `track=internal`、90分上限を維持する。`track` は検証modeで使用されない。配布jobへの切替やuploadは再試行に含めない。

## 診断補強版の再試行

| 項目 | 値 |
| --- | --- |
| run | [37160029775](https://github.com/mat2uken/tailcatsend/actions/runs/37160029775) |
| source SHA | `bde026160c883a5a80a072e272f617ccc946e820` |
| 状態 | FAIL。署名検証jobは22:55:07–23:06:11 UTC。request・完全SHA・tool setup・safety fixtureを通過。配布jobはskipped、always cleanup成功、artifact 0件 |

実署名stepの診断JSONだけを抽出した。credential-free fixtureが出すsynthetic phase JSONは実buildの証拠に含めない。

| 実phase | 秒 / exit | 結果 |
| --- | --- | --- |
| cargo-metadata | 2.007 / 0 | 成功 |
| signing | 0.665 / 0 | helper正常終了。成果物署名検証とは分ける |
| gradle-graph | 66.700 / 0 | 成功 |
| build-aab | 305.164 / 0 | 成功 |
| build-apk | 6.991 / 1 | `category=patches`。log hash `1a6884fc1ac5cd2090133dbcb2dee2de7fb4b7f7944feb145523b1f0a9a9489f` |

署名・証明書一致・16KB・manifest・compiled Firebase設定のartifact verifierは未到達のまま。失敗時の空きdiskは79,528,804,352 bytes、利用可能memoryは14,989,864,960 bytesだった。これらのsnapshotを根本原因の証明とは扱わない。

## patch再適用の不具合と最小修正

`0001-android-selinux-netmon-fallback.patch` のtest import文脈は `strings` の次が `sync/atomic` だが、現在のsubmodule HEADには間に `sync` がある。原checkoutを変更せず `git apply --reverse --check --unidiff-zero` を実行すると、適用済みの `tailcat_test.go` のimport hunkで失敗する。`0002` のreverse checkは成功した。

現在のHEADの2ファイルを一時コピーして再現した。旧patchはMacのportable patch fallbackで一度目に適用できても、二度目も `Applied` と表示して変更を取り消し、両fileのhashが変わった。CI側は `patches` 分類までを確認し、GNU fallbackの生ログと挙動詳細は保持していない。

最小修正は `0001` のimport文脈2行だけ。`sync` を含めるとGit forward check・reverse checkが成功し、二度目は `Already applied`、両fileの内容は不変になる。修正後の初回内容は旧patch初回適用内容と一致し、runtime Goコードの意味を変えない。

| 適用後file | SHA-256（旧初回・修正初回・修正二度目で一致） |
| --- | --- |
| tailcat.go | `2fdf4609d594e410fef73bcb6ec9e0c82daf3ea2516922a37a079d38c89972aa` |
| tailcat_test.go | `d82e815338502cbabbf0b3a673c3679e61f4e3cc3018240bf57b3b741d045e8b` |

回帰テストで、同じsourceへhelperを二度実行して内容が変わらないことを検査する。CIのcredential-free stepでも実行する。原submoduleのファイル・HEADを直接変更せず、外部credentialやupload制御も変えない。この修正後の新しい完全SHAで再検証する。

独立レビューに重大指摘なし。回帰テスト1件、workflow actionlint成功。patch構文に必須のcontext prefix（space）とGo indent（tab）だけは通常の空白検査が警告するため、その項目だけをcommand-localで除外し、残りの空白検査を通した。Git設定ファイルを変更していない。

## patch修正版の再検証

| 項目 | 値 |
| --- | --- |
| run | [37161248190](https://github.com/mat2uken/tailcatsend/actions/runs/37161248190) |
| source SHA | `ce787ef4ed7b01f6e4faee579c1dad5c1636c013` |
| 状態 | FAIL。署名検証jobは23:16:50–23:33:23 UTC。request・完全SHA・patch回帰を含む事前fixtureは通過。配布jobはskipped、always cleanup成功、artifact 0件 |

実署名stepではAAB build 436.646秒、APK build 82.810秒で両方成功した。patch修正後はAPK段の適用失敗が解消した。artifact verificationは3.868秒で失敗し、安全なerrorは `apk_public_certificate_missing_or_ambiguous`。検証log hashは `8664ad16d149993964df1e26c4b3896f60ba5d370502a6e97a9f2be6e1e7c193`。

APK署名toolの正常終了、`Verifies`、署名者数1の確認後に、公開証明書digestの解析で停止した。最終reportが完成していないため、証明書一致・16KB・manifest・compiled Firebase設定の総合PASSとは扱わない。

## APK証明書出力の解析修正

旧解析は `Signer #1` だけを受け付けていた。[Android公式実装](https://android.googlesource.com/platform/tools/apksig/+/refs/heads/main/src/apksigner/java/com/android/apksigner/ApkSignerTool.java)にはv3.1使用時の `Signer (minSdkVersion=..., maxSdkVersion=...)` 表記もある。この公式形式に限定して対応した。CI3の原出力は公開していないため、実際にこの表記だったかは仮説であり、次のCIで修正の効果を確認する。

正常終了・署名検証成功・署名者数1を引き続き要求する。SDK範囲表記はv3.1成功表示と有効なSDK範囲を要求し、複数範囲でも公開fingerprintが全て同じ場合だけ受け付ける。異fingerprint、未知label、形式混在、複数署名者、壊れたdigestを拒否する。失敗時は固定4項目の件数（0..128）のみを出し、原文、alias、所有者、path、digest値を出さない。

独立レビューに重大指摘なし。verifier 17件、helper 16件、patch回帰1件のfixtureとworkflow actionlint、差分空白検査が成功。システムpython3で全scripts 95件を実行すると、Androidと無関係のTestFlightテスト1件だけが未導入の`jwt`で停止した。依存installはしていない。その後、既存 `work/test-venv/bin/python` で最終差分の全96件が成功した。既存の開発署名APKはSDK34/35/36のapksignerで実検証成功し、fingerprintは3版で一致した。このAPKは開発用証明書であり、CIの本番署名候補の証拠には流用しない。署名入力、Firebase構成、build、upload抑止は変更しない。

## 証明書解析修正版の再検証

| 項目 | 値 |
| --- | --- |
| run | [37162811567](https://github.com/mat2uken/tailcatsend/actions/runs/37162811567) |
| source SHA | `108ef1feff27285ba0519769225180ec24a0a364` |
| 状態 | FAIL。署名検証jobは2026-10-03 23:46:16–2026-10-04 00:02:31 UTC。request成功、配布jobはskipped、always cleanup成功、artifact 0件。`mode=verify` / `confirm_deploy=false`、90分上限を維持 |

AAB build 428.594秒、APK build 82.888秒で両方成功。artifact verificationは3.720秒で同じ `apk_public_certificate_missing_or_ambiguous` により失敗した。検証log hashは `f8279fdbb4d3d51054eaaefde40290d72d5f8801fe7126998a9582fb0393549b`。

固定件数診断は numbered/sdk-range/unknown-label/unique-fingerprint が全て0。正規表現に一致する証明書digest行がないという事実であり、SDK範囲表記への対応だけでは解消しなかった。証明書が存在しない、署名無効、どの出力形式だったかの断定には使わない。原出力は非公開・cleanup済みのまま。次の再試行前に証明書出力とtool選択を切り分ける。最終総合静的PASSは未取得。

## 証明書印字の追加切り分け

CI4の4件数だけでは証明書印字の欠落・indent・表記差を区別できない。追加診断を固定12項目へ拡張し、各整数0..128だけを許可する。DN/digest語句、Signer行、PEM開始、v2/v3/v3.1成功表示の件数を加える。選択したbuild-toolsのversionもstrictな数値3要素に限定して記録し、toolのpathや原文を出さない。

公式のoptional boolean引数を明示し、`verify --verbose true --print-certs true` とする。証明書印字の省略解釈への依存を除くが、これがCI4の根本原因だったとは断定しない。暗号署名成功、署名者1、未知ラベル拒否、全fingerprint一致、AABとの一致の合格条件は維持する。PEMによる代替合格は採用しない。新sourceの再実行は、この診断と明示引数の効果を確かめるために行う。独立レビューに重大指摘なし。verifier19件、helper17件、全scripts99件の既存環境テスト、workflow actionlint、差分空白検査が成功。既存開発署名APKのSDK34/35/36実検証も成功したが、CI署名候補の結果へ流用しない。

## 印字診断補強版の再検証

| 項目 | 値 |
| --- | --- |
| run | [37164330828](https://github.com/mat2uken/tailcatsend/actions/runs/37164330828) |
| source SHA | `96ce3d880c85be09b31de1a28438a5f0cc8dfef8` |
| 状態 | FAIL。署名検証jobは2026-10-04 00:14:38–00:26:21 UTC。配布jobはskipped、always cleanup成功、artifact 0件。`mode=verify` / `confirm_deploy=false`、90分上限を維持 |

AAB build 291.657秒、APK build 53.075秒で両方成功。artifact verification 2.472秒、同じ証明書解析errorで失敗。検証log hash `f5a09c8b56cbce16dd604c9ca39b51897202de848686be513003df2f0d87101e`。

選択apksignerのbuild-toolsは37.0.0。証明書digest語句とDNの件数は各1、indent件数0、Signer行件数0。v2署名成功表示1、v3/v3.1は0。証明書印字がないという仮説はこのrunでは否定され、既知のSigner接頭辞に一致しない表記へ切り分けられた。SDK37の公式実装を照合して最小修正を決める。明示booleanだけでは解消していない。

## SDK37の正式な証明書ラベルへの最小対応

[Google公式配布manifest](https://dl.google.com/android/repository/repository2-3.xml)が列挙する [SDK37 Linux ZIP](https://dl.google.com/android/repository/build-tools_r37_linux.zip) を一時領域で読み取り、manifestのSHA-1 `70954e99f4c3d9d46ee70fa32624672fe7cd6ebe` と実体が一致することを確認した。ZIP SHA-256 `01af179347cbcd9c208b7f8171f7b21f6dd1d2f85bcd15e88caa51d5d7b86060`、ZIP内apksigner.jar SHA-256 `2defad215d7ff52968a409cde528cdaef7918b115e276b8e3378ca7a178e4180`、Pkg.Revision 37.0.0。

既存`javap`でbytecodeを読むと、v3/v3.1不使用・v2成功時のprefixが `V2 `、単一証明書時に `Signer:` を連結し、`V2 Signer: certificate SHA-256 digest:` になる。source stampは `Source Stamp Signer:` の別分岐。SDK37を配置・実行・署名に使用せず、静的照合だけを行った。独立レビューでもZIP/checksum、ZIP内jarと解析対象jarの一致を再計算した。CI5のversionと件数診断はこの形式と一致するが、CI側jarのhashそのものは未計測なので同一実体とは断定しない。

対応は上記のexact V2形式だけを追加する。単一証明書行・64桁digest・v2成功・v3/v3.1不使用を要求し、署名者1・AABとの証明書一致を保持する。旧形式との混在、重複、未知のV1/V3.0/Hybrid形式は拒否し、source stamp単独をアプリ署名へ採用しない。製品コード、tool選択、credential、upload抑止は変更しない。独立レビューに重大指摘なし、関連38件、全scripts101件の既存環境テスト、workflow actionlint、差分空白検査が成功。新しい完全SHAで実署名候補を再検証する。

## 残る提出準備

1. 署名候補の静的検査を完了し、artifact hash・公開証明書・manifest・16KB結果をこの記録に対応させる。
2. 同じ提出候補でAndroid runtime、QR、送受信、SAF、telemetry OFF/ON、復元を確認する。本番Firebase通信や端末使用は別の実施範囲として扱う。
3. Data safetyと公開privacy/supportの記述を確定する。ローカルHTMLは `publication_ready=false` のまま。
4. Consoleの未完設定、store listing、対象年齢、無料設定とclosed test条件を完了する。既存内部テスト・iOS審査通過をAndroid本番アクセスの合格として扱わない。
