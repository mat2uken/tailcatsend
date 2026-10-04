# 個別Save／Shareメニュー修正と追試

2026-10-04 UTC。修正sourceは `c7408ea0e0d767b9ac482b30acb6e42aa6fba81e`、専用branch `feature/android-play-readiness`。前回の署名候補734d9590の試験とは分ける。公開Web版を更新・公開した結果ではない。

## 問題と修正

前回16KB AVDで、履歴最下行の個別操作menuが履歴のoverflowで切れ、Shareの一部とSaveが押せなかった。修正では開いているmenuだけをbody直下へ移し、既存 `placeAnchor` で画面内へflip／位置補正する。高さが不足する場合はmenu内をscrollできる。履歴のoverflowは維持する。閉じたmenuは元のrowへ戻し、履歴再描画・切断・tab変更・画面外へのscrollで残らないようにした。viewport resize／visualViewport scrollにも追従する。

キーボード操作では⋯を開いた状態のTabでCopyへ進み、内部はShare／Saveへ進める。Escape、先頭のShift-Tab、末尾のTabで閉じ、元のボタンへfocusを戻す。

## ローカル検証

- unit 133件、共有UI e2e全19件、lint、format、TypeScript型、native向けVite build成功。既存依存と既存headless Chromiumを使用、新依存の導入なし。
- 新しい到達確認4件は受信／送信の最下行、複数行テキスト、360×420画面でCopy／Share／Saveの画面内位置と実hit-testを確認し、Save／Shareが対象本文をbackendへ渡すことを検証。縮小viewport／履歴scroll／tab変更とkeyboard復帰も検査する。
- 同じ新4件を修正前 `1365554819c317aeafa79105a4153aa173e7d2a7` のmain/CSSで実行し、実hit-testの4件失敗を再現した。検証後は修正sourceを完全に復元した。
- 独立レビューでkeyboard導線の回帰を検出して補強後、重大指摘なし。これらはstub backendを使う共通UIの試験で、署名APK・実Android keyboardの成功とは分ける。

ローカル証拠：`work/menu-fix/baseline-regression-proof.json`、`baseline-e2e.log`、e2e出力。原本・生成物はGitへ追加しない。

## 署名候補・16KB追試

[run37172964773](https://github.com/mat2uken/tailcatsend/actions/runs/37172964773)、`mode=runtime`／`confirm_deploy=false`／source c7408ea0固定で成功。request・署名検証・always cleanupはsuccess、Play配布jobはskipped。前回と同じopaque署名・Firebase構成、90分上限、APKだけ1日保存とした。AABはMacへ取得していない。

| 項目 | 記録 |
| --- | --- |
| release metadata（Mac APK） | `jp.yasagure.ponlet` / `1.0.18` / code `2030000102` / minSDK 31 / targetSDK 36 / arm64-v8a |
| APK SHA256 | `266602611b1233ca3b917f0aaffe8ba25853f2b41ba643e74843c5e0bc836780` |
| AAB SHA256（CI内） | `6d2560e69f6a1ad3ab51e561291389dc635a856881c8f6fd6e7643614db95e79` |
| 公開署名証明書 SHA256 | `d8dea3cfe16327293fa7fc7510859fd546ebfe50ca622dd87622fbb05f8539f5` |
| artifact削除 | このrunのAPK artifact `11292357557` をMac検証後03:25:16 UTCに削除。同runの残存artifact 0件を確認 |
| 実行環境 | fresh専用API35 / arm64 / `getconf PAGE_SIZE=16384`、隔離Web相手、実機・USB・camera・audioなし |
| 後始末 | 03:50:17 UTCにこの試験のWebセッションと所有確認済みAVDだけを停止。私有出力はignored領域へ移動 |

既存JDK／SDKで署名・metadata・native ZIP／ELFをMac再検証し、独立担当の18比較もPASS。全9ライブラリのLOAD／ZIP 16KB配置とAAB/APK間native hash一致、camera optional・広告ID権限なし・受信cloud backup除外・Firebase構成3項目を確認した。RELROガイド警告2件は前回と同じ。CI出力のpackageはGitHub maskingで文字列照合できず、Mac APKの実packageを期待値と照合した。maskの原因となった入力は推測しない。

### 個別menuの実操作

- 自作43バイト・3行テキストをWeb UIから4件受信。画面下端の受信menuが上側へ配置され、Copy／Share／Saveが全て画面内に表示された。
- 個別SaveからAndroid SAFのDownloadsへ保存。保存43バイトが原文と完全一致し、SHA256は `1003e5aea86957300e329604abeeceae5375193754326f358f9809bf65462ecf`。
- 個別Shareからシステムの「Sharing text」chooserと原文previewを確認。送信先を選ばず閉じた。外部アプリへの実送信は未実施。
- composerでsoft keyboardを表示し、その上の見えるメッセージボタンを開くとkeyboardが閉じ、3操作を表示した。keyboardとmenuの同時表示は観測していない。UI dumpはkeyboardに隠れた背後の座標も返すため、最初の操作はkeyboard上の1文字を未送信入力し、画面照合で対象を修正した。これは製品のmenu失敗とは数えない。
- 既知のPonlet PIDの取得済み限定logでFATAL EXCEPTION／ANR markerは0件。最後のAndroid Back操作後はlauncherへ戻り、Ponlet PIDは不在だった。全期間・全processのcrash不存在を保証しない。

URL接続は初回一括入力が343文字中120文字で止まり、正しくないURLで失敗した。新しい自作inviteを50文字ずつ入力してUI値343文字の完全一致を確認後、接続が成功した。初回入力失敗を通信不安定性の再現と扱わない。今回endpoint UIはWebRTC DataChannelを観測したが、全payloadの経路証明ではない。このmenu追試では前回の99バイト画像初回timeoutを再試験していない。後続の [3条件限定追試](TIMEOUT_RETEST_RESULTS.md) は同APK実体を使い、今回は再現せず、原因未特定と記録した。

今回pcapはAVD全体の14329 records、UDP53解析のDNS errors 0、レコード末尾の不完全データなし（`partial_tail=false`）であった。全通信の捕捉やpacket欠落なしは未保証。Ponlet UID／SDK payloadへの帰属やOFF時の停止を確認した結果ではない。前回のSDK実通信・端末queue・Google側削除の未確定項目を解消したとは扱わない。

私有証拠：`work/menu-runtime/independent-apk-verification.json` と `work/menu-runtime/private/` 配下の `menu-native-proof.json`、`mac-comparison.json`、`artifact-deletion-confirmation.json`、`cleanup.json`、各UI／screenshot。招待URL・生log・APK・pcapは公開Gitへ追加しない。

## 初回画像timeoutの追加調査

対象は [前回の記録](SIGNED_RUNTIME_RESULTS.md) のsource734d9590で、初回FAIL→1回再試行PASSを維持する。既存ログとコードから、テキスト成功時に作られたWeb Clientの再利用、timeout後のcache破棄、新Client生成と整合する記録がある。ただし直接のcache hit／create記録はなく、再試行まで約10分の間隔と通信状態の変化がある。cacheが根本原因、DERP fallbackが解決したとは断定しない。

旧remote peerのWebRTC retry／失敗記録は、新しいpeerの成功後にも残る。その件数を現在の転送失敗数として数えない。Native→Web側のreader reset記録は、逆方向の初回dial failureの原因証拠として使わない。UIのDERP表示はこの端点の観測状態であり、未成立のfile flowや全payloadの経路証明ではない。

現証拠から必須と判断できる通信コード修正は未確定。無根拠な自動retryを追加せず、fresh接続と、text送信後にClientを再利用する条件を揃えて比較し、dial開始／完了・Client世代・経路状態だけを記録する追試案を残す。本文・ファイル名・鍵・招待URLは診断logに出さない。
