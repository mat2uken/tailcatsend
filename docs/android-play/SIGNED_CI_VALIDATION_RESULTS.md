# 配布を伴わない署名build検証

2026-10-03 UTC。ユーザー承認後に実装、独立レビュー、専用branchのpush、手動CI実行を行った。先行の [計画](SIGNED_RELEASE_VALIDATION_PLAN.md) の未実装・未実行という記述は、その計画作成時点の記録である。今回の実施範囲は以下に限る。

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

## 残る提出準備

1. 署名候補の静的検査を完了し、artifact hash・公開証明書・manifest・16KB結果をこの記録に対応させる。
2. 同じ提出候補でAndroid runtime、QR、送受信、SAF、telemetry OFF/ON、復元を確認する。本番Firebase通信や端末使用は別の実施範囲として扱う。
3. Data safetyと公開privacy/supportの記述を確定する。ローカルHTMLは `publication_ready=false` のまま。
4. Consoleの未完設定、store listing、対象年齢、無料設定とclosed test条件を完了する。既存内部テスト・iOS審査通過をAndroid本番アクセスの合格として扱わない。
