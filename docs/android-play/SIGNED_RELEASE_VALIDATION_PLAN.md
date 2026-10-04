# 署名・Firebase設定を含むAndroid release検証の次段計画

2026-10-03 UTC。これは実装・実行前の計画。workflow追加、push、dispatch、成果物配布、Play／Console／サイト操作は行っていない。鍵・パスワード・Firebase設定の値も読んでいない。

後続で配布なし署名CIを実装・実行した。下記の未実装・未生成・未実行は計画作成時点の記録であり、最新SHAと結果は [署名CI実施記録](SIGNED_CI_VALIDATION_RESULTS.md) を参照する。runtime試験の承認や合格はこの追記に含まない。

## 比較対象と到達点

対象repoは `mat2uken/tailcatsend`、local branchは `feature/android-play-readiness`。製品コードの基準SHAは `5e0125797c2466918772a6722302d84219a1792a`。今回検証済みのunsigned候補は `jp.yasagure.ponlet`／1.0.18／2030000102／min31／target36／arm64-v8a。

| 候補 | source／設定 | AAB SHA-256 | APK SHA-256 |
| --- | --- | --- | --- |
| 現在の検証済み候補 | 上記SHAの製品コード、release、署名・Google Services／Crashlytics build pluginなし | `28f3bd088968fd33c5f0bf6608c363b9907d06924364908b98324154fa2661d8` | `ae49dcfe40bfa62bc7ee6f789dbd12ba8fdba92bec4abadd6626c7b4cc643961` |
| 次の署名・Firebase候補 | 同じ製品SHA／versionCodeを最初の比較条件とし、既存署名とFirebase構成をrunner内で使用。build pluginを保持しuploadだけ停止 | **未生成** | **未生成** |

次候補は署名・生成Firebase resources・Crashlytics build ID・ビルド環境が異なり、現在のAAB／APKと同じhashになるとは想定しない。source SHA、workflowを含む実行用SHA、versionCode、Firebase構成が有効かどうか、SDK一覧、全native library hash、署名証明書の公開fingerprint、AAB／APK hash、runner／AVD環境を対応表に残す。Firebase設定内容やキーの値はreportへ出さない。新versionCodeやソースへ変えた最終提出物は、その実体を改めて検査・試験する。

現在の成功は全nativeのLOAD／ZIP配置、compiled manifest／backup XML、16KBでのdlopen、Android frameworkのscratch復元まで。[方針検証記録](POLICY_VALIDATION_RESULTS.md)を参照。Ponlet実アプリのFirebase初期化・転送・バックアップtransportはまだ合格していない。

後続の[ローカル開発署名pilot](LOCAL_DEV_PILOT_RESULTS.md)で、Firebaseなしの同unsigned APKコピーを既存開発keyで署名し、16KB実アプリ起動と設定の保存／再起動保持を確認した。これは上表の「次の署名・Firebase候補」ではなく、production署名・SDK初期化／通信・Play upgradeの未検証を解消していない。

## 現行CIをそのまま使わない理由

| 現行ファイル | 確認した動作 | 次段での扱い |
| --- | --- | --- |
| `.github/workflows/android-build-only.yml`／`scripts/build_android_verify.sh` | unsigned、Firebase build pluginなし、uploadなし | 無署名の回帰経路として維持。署名／Firebase検証と取り違えない |
| `.github/workflows/google_play.yml` | 署名導入、Firebase構成復元、AAB artifact upload、Play `status: completed` | **検証目的でdispatchしない** |
| `.github/workflows/release.yml` | Android署名APKとGitHub artifact、他OSのbuild。tagも対象 | **検証目的でdispatch／tag pushしない** |
| `app/build.gradle.kts` | Firebase構成があればCrashlytics pluginを適用し、nativeSymbolUploadEnabled=true、bundle後にsymbol taskをfinalize | signed検証ではplugin／runtime SDKを保ち、native／mapping uploadを明示抑止 |

`setup_android_signing.sh` は既存secretをrunnerの一時keystoreへ復元し、Gradle用envを設定する。値の表示や手動鍵読取を必要とする手順へ変えない。現在のhelperを今回実行したわけではない。

helperと対象workflowのコード読取では `set -x`／`printenv`／秘密の標準出力への表示は見つからない。helperのbase64用 `echo` はdecode pipeへ、password／alias用 `echo` は `GITHUB_ENV` へのredirect内へ流れる。これらをlog用 `cat`／環境ダンプへ変えない。GitHubのdebug traceも検証jobで有効化せず、秘密を含むenv fileを成果物・summaryの収集対象へ含めない。将来の実装差分で再確認する。

## runner候補と先行pilot

GitHub公式表ではstandard `macos-14`／`macos-15`／`macos-26` はarm64。まず **`macos-26`、同じjobでbuildとAVD試験**を候補とする。既存repoのActions secretsを使えれば、新しいrunner登録・credential作成・鍵のMacへの持出しは不要になる。私有repoではActions枠／課金を確認する。[GitHub runner仕様](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

ただし同公式資料はarm64 macOS runnerのnested virtualization非対応を明記している。arm64ラベルだけでHVFによるAndroid AVD起動を保証しない。先に**secretsを参照しない短いpilot**で次を確認する。既存MacでAVDが動いた実績をhosted VMへ流用しない。

1. `uname -m`、空きdisk、SDK／NDK／emulator版、`emulator -accel-check` を記録する。
2. 公式SDKのAPI35 Google APIs Experimental 16KB ARM64 imageと4KB ARM64 imageを専用一時AVDへ配置する。nested accelerationが使えなければ、公式CLIの `-accel off` がこのarm64組合せで動くか試す。ソフトウェア動作は未実行・未保証で、性能も合格条件に含める。[Android 16KB環境](https://developer.android.com/guide/practices/page-sizes)、[emulator CLI](https://developer.android.com/studio/run/emulator-commandline)
3. bootを10分など承認済み時間内に限定し、`ro.product.cpu.abi=arm64-v8a`、API35、`getconf PAGE_SIZE=16384`／4096を実測する。cameraなし・audioなし・snapshot保存なし。pilotはアプリ・署名・Firebaseなしで終了する。
4. 失敗、空き容量不足、時間超過なら署名secret導入へ進まず停止する。HVF必須の環境に無理にnested virtualizationを設定しない。

pilotには、秘密ではない固定fixtureによるbase64 encode／decodeとshell toolsの互換確認も含める。既存helperの `base64 --decode`、GNU／BSDオプション、`find`、Python、Java／keytoolの実体を確認する。手元Macのbase64は `--decode` を提供するが、hosted runnerでの成功へ流用しない。bash版も記録し、macOS標準bash3.2に `mapfile`／`readarray` がない点を確認する。既存Ubuntu検証stepをそのままコピーせず、artifacts配列はPythonまたはbash3.2対応の読込へ変えるか、承認済みのbash版を明示して動作を確認する。署名secretやFirebase設定で互換性を試さない。

pilot成功後もM1 runnerの限られたRAM／diskでRust・Go・GradleとAVDを同時に動かせるかは未確認。build並列数を抑え、build中はAVDを終了し、完成後にAVDを起動する。job時間上限と許容費用を先に決める。standard hosted pilotが失敗した場合、既に所有者が管理するbare-metal arm64 runnerの有無を確認する。別runner登録や署名APKだけの限定移送を自動で始めない。

## レビューする最小差分案（未実装）

新しい `.github/workflows/android-signed-runtime.yml` を **workflow_dispatchだけ**で追加する案。push／tag／PR起動、Play、GitHub Release、artifact／cache upload、他OS buildは含めない。既存2本は変更せず、検証専用jobを独立させる。

| 項目 | 最小案 |
| --- | --- |
| 入力 | 承認済み製品sourceの完全40桁 `source_sha`、確認用versionCode、`allow_signed_runtime=false`、`allow_production_firebase_network=false` を既定。実行前に承認した値を固定 |
| 権限 | `contents: read`。Play secret、OIDC、配布tokenを参照しない。checkoutはpersist-credentials=false |
| 制御 | 同じapp向けconcurrencyで同時試験を避ける。sourceのcheckout後にHEADが指定SHAと一致することを確認。署名前にpilot／upload抑止検査を終える |
| 署名入力 | 既存 `ANDROID_KEYSTORE_BASE64`／password／alias secret入力は署名build stepだけへ渡す。現helperの導出envは別の継続範囲を持つため、下記の抑止を実装する。新設、ダンプ、base64表示、鍵の外部保存、署名設定変更なし |
| Firebase入力 | 既存 `GOOGLE_SERVICES_JSON_BASE64` をrunner checkout内へopaqueに復元。空なら「Firebaseなし」で合格にせず停止。原本／値をlogやartifactへ載せない |
| build | `PONLET_ANDROID_BUILD_ONLY` は使わない。既存release署名＋Google Services／Crashlytics pluginを保持し、同sourceからAABとAPKを生成する。現在のunsigned wrapperは呼ばない |
| 環境 | Java17、Go1.27.x、Node24、Tauri CLI2.10.0、NDKr28b等の既存CI版を維持。`macos-26`で未確認のcommunity actionは先に互換性を確認。不要cache uploadなし |
| 記録 | hash、version、署名verify結果、公開fingerprint、validator結果、試験結果の安全な摘要だけjob log／summaryへ出す。APK／AAB／秘密ファイル／端末dataをuploadしない |
| 終了 | always cleanupで自分が起動したAVD PIDのみ終了し、一時keystore／証明書／Firebase原本・Gradle用secret env fileを破棄。runner全体や他アプリの設定を変更しない |

現helperは導出したpassword／alias／keystore pathを `GITHUB_ENV` へ書くため、**入力がstep-localでも導出値は後続job stepsへ継続する**。最小検証案では署名とbuildを一つのstep内へ限定し、helperを使う場合も子processの出力先を専用private env fileへ差し替え、allowlist付きの文字列解析からbuild子processのenvへ渡す方法をレビューする。env fileをshellの `source`／`eval` で実行しない。通常のjob-wide `GITHUB_ENV` 書込を残す代案なら、runtime前に署名／Firebase入力をshellからunsetするだけで済ませず、後続stepへの導出envを空にし、生成したcommand fileの機密行が安全に処理・破棄されることを確認する。AVD／ブラウザへ署名envを継承させない。runtimeに必要なFirebase client resourcesはAPK内に残し、原本と秘密入力を残すこととは区別する。

Crashlyticsはbuild pluginを全部外すと実初期化条件まで変わるため、upload抑止だけを追加する。既存3.0.2 JARの `CrashlyticsExtension` で `mappingFileUploadEnabled`／`nativeSymbolUploadEnabled` setterの存在をread-onlyで確認済み。[mapping設定](https://firebase.google.com/docs/crashlytics/android/get-deobfuscated-reports)、[native symbols設定](https://firebase.google.com/docs/crashlytics/android/get-started-ndk)

製品sourceを **`5e0125797c2466918772a6722302d84219a1792a` に固定する比較build**では、そこに存在しない新validation flagを立ててもuploadは止まらない。第一案は実行用SHAで管理する専用 `GRADLE_USER_HOME/init.d/` の一時init scriptを外部制御として導入し、両upload設定をfalse、`uploadCrashlytics*` tasksを無効にして、既存 `finalizedBy` 経由でも実行されないことをtask graphで確認する。init script自体のSHAも記録し、製品checkoutへ無断patchしない。

別案は製品Gradleへ専用validation flagを実装し、両upload設定をfalse、symbol `finalizedBy` を付けない構成にする。その場合は **新しい製品実装SHAが必要**であり、5e012579固定buildとは呼ばない。新sourceをレビュー・承認し、比較表へ実SHAを記録する。どちらの案でも署名／Firebase構成復元後のtask graph／dry-runを確認し、upload taskが実行対象に残る場合はbuildを止める。Google Services resourcesとCrashlytics build IDの生成は残し、通常配布設定を変えない。現在はどちらも未実装であり、「flagだけで安全」とは扱わない。

validatorはLOAD／ZIP、camera optional、広告ID不在／boolean false、cloud受信除外、versionCodeをAAB／APK実体に確認する。RELROは通常reportの監査警告として記録する。AABの署名verifyとAPKの `apksigner verify` は成果物に対して行い、秘密鍵を表示しない。完成APKに `adb install` する前にも、同じhashと公開署名fingerprintを対応させる。

## push／dispatch対象を固定する

製品基準 `5e0125797c2466918772a6722302d84219a1792a` はローカルcommitとして確認済み。新workflowやupload抑止差分の実装後は、その**実行用commit SHAをレビューして追記**する。現時点で未存在のcommitやremote branchをあるものとしてdispatchしない。

GitHubの手動workflowはdefault branchに登録されている必要がある。[GitHub公式手順](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow) したがって必要な順序は、ローカル実装・レビュー→ユーザーが対象SHAと差分を承認→`feature/android-play-readiness` の指定SHAだけpush→workflow登録のためのdefault branch導入を別途レビュー・承認→手動pilot→署名runtime jobである。default branchへ導入済みなら、対象branchを `--ref` に選び、job内の `source_sha` も完全SHAで固定する。tagは作らない。push後に対象refや登録状態が異なれば止める。

特に現 `android-build-only.yml` はこのlocal branchで新規追加したものなので、mainへ登録されていると仮定しない。default branchへの登録は、必要な手動workflowと検証制御だけの小さな差分を第一案とし、readiness branch全体をそのままmergeしない。現在の `deploy_pages.yml` はmain pushの `dist/**`／`web-ui/**`／`crates/**` 等を監視するため、全体mergeは未公開policy・supportを公開する可能性がある。

別案として、mainで既に登録されている `google_play.yml` のfeature branch版に検証専用入力modeと独立jobを追加し、そのrefを手動選択する方法もレビューできる。ただし検証jobへ現job-level `PLAY_CONFIG_JSON` を継承させず、配布jobは入力modeで確実に非実行、Crashlytics uploadは前述の抑止、tag自動配布も非実行という差分が必要になる。既存deploy job内のupload stepだけを外す案では不十分。今回この代案のworkflowコードを変更していない。

push前にremote側の最新workflowと連携サービスを再確認し、副作用表を更新する。現在のlocal定義では、feature branch通常push／PRに該当するworkflowは見つからない一方、`v*` tag pushはTestFlight／multi-platform release／build-onlyを起動する。既存main版Google Playにtag triggerが残っている可能性も別に確認する。main pushは上記Pages公開が対象になる。PRを作る場合もremoteの `pull_request`／`pull_request_target` や追加連携を確認し、「PRは常に副作用なし」と扱わない。今回remote変更やtrigger実行はしていない。

本計画はpush、PR作成、mainへのmergeを承認したものではない。新workflow名は提案であり、登録されていない。既存 `google_play.yml`／`release.yml` の実行で代替しない。

## installと署名の区別

unsigned APKは実アプリとしてinstallできない。次段ではrunner内で既存keystoreを使って署名したAPKを、**そのjob専用の空のAVDだけ**へinstallする。これには署名secretのopaque使用とapp install／起動の明示承認が必要。既存Macの利用中AVD、ユーザー実機、Playアプリの上書き・uninstall・data clearへ広げない。

既存CI keystoreがupload keyかapp signing keyかは未確認。Play App Signingのupload certificateと最終配布APKのapp signing certificateは異なり得る。同keyの署名APKで同key旧APKからのupgradeを試せても、Play版からのupgrade成功とは呼ばない。[Android署名の公式説明](https://developer.android.com/studio/publish/app-signing)

公開fingerprintだけを照合し、鍵を取り出さない。Play app-signing certificateが異なる場合、Play署名の最終候補を取得する承認済み経路が別途必要になる。そのためだけにPlayへ候補uploadすることはこの計画に含めない。別package名／debug署名／x86_64 ABI追加による試験も、同じrelease候補の代替にしない。

## runtime試験と追加承認

最初はAVDの外向き通信を遮断し、releaseアプリの起動、WebView／Rust／Go、native SDK初期化、初回既定ON表示、OFF／再起動後OFF保持、picker取消、受信行表示等を確認する。ネットワーク遮断はアプリのSDK設定やコードを変更する方法で代用せず、AVD／runner側の限定設定をレビューする。build依存の取得と、アプリを起動するruntime通信の許可を分ける。

| 試験 | 可能な場所／条件 | 証拠と限界 |
| --- | --- | --- |
| 4KB／16KBで起動・停止・再起動、UI／native初期化 | 同runner専用ARM64 AVD。最初はoffline | actual signed APK hash／process状態／app画面。dlopen単独を起動成功としない |
| Document picker・小ファイル・0byte・日本語名・保存／開く | AVDとjob専用の合成ファイル | 相手アプリ／providerを含む実画面を確認。実クラウドproviderは別承認 |
| Android↔Web双方向転送・取消・再接続 | AVD＋job専用ブラウザ、合成データ | UDP／WebRTC／DERPを区別。招待サーバー等への通信範囲を承認し、ファイルhashを比較 |
| OFF／ON・OFF保存済みupgrade | 同keyで署名された対照APKと新APKを専用AVDで使用 | OFF設定読取とSDK動作を確認。既存Play署名との一致がなければPlay upgrade未検証 |
| Firebase実収集、OFF中QR、再ON・再起動、pending report | 本番Firebase設定込みの同APK、対象endpointへの通信を別承認 | 新しいアプリinstance／診断等が本番へ送られ得る。ログの不存在だけで無通信とはしない。SDK状態・観測可能な通信／受信側を対応させる |
| QRカメラ、実provider、OEM migration／backup | まず合成カメラ対応AVD、最終は指定した実機 | 物理カメラ・実クラウドrestore・OEM差は実機確認が必要。現MacのUSB／カメラ／音声は使わない |
| 強制crash・ANR・native fault | 別承認の試験のみ | 本番Crashlyticsに試験データを作り得る。releaseへ試験用faultコードを足した別hashを合格証拠へ流用しない |

既存CDP／`run-as`ベースE2Eはdebuggable向けなので、releaseで実行できるという前提を置かない。release実画面と外部からの操作を基本に、必要な観測方法を先にレビューする。サーバー側確認に既存認証が必要でも、今回それを調べたり新しく設定したりしていない。

AVD pilotでは、アプリの製品コードを変えずにrelease UIを操作する方法（公式UI Automator等）も確定する。artifact uploadなしの場合は画面・試験用ファイルをjob内で評価し、秘密や生の識別子を含まない結果だけsummaryへ残す。QRは合成映像を使い、hostのカメラを有効にしない。

所有者に確認する具体的な実施対象は、(1)指定SHAのpushとworkflow default branch登録、(2)hosted pilotの時間／費用とSDK導入、(3)既存署名／Firebase secretsのrunner内opaque使用、(4)専用AVDへの署名release install・起動、(5)本番Firebaseや招待／リレー等への限定通信、(6)crash／実backup／物理端末試験の範囲である。各実施内容を確定してから承認を得る。鍵や設定の値をユーザーへ尋ねる必要はない。

今回追加で価値があるのは、計画・task graph抑止・署名/Firebase差の検査項目を具体化すること。unsigned再build、同じdlopenやscratch復元の反復、既存AVD再起動は行わない。別AuraGaugeのUSB／board／音声や利用中アプリに触れない。
