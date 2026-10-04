# 初回画像転送timeoutの限定追試

2026-10-04 UTC。既存取得済みの最新署名APKを使い、最大3条件・画像各1回・retryなしで追試した。今回3条件ではtimeoutを再現できず、原因と必須の製品修正は特定していない。前回734d9590の初回FAIL／再試行1回PASSは [前回記録](SIGNED_RUNTIME_RESULTS.md) のまま保持する。

## 対象と条件

- APK source `c7408ea0e0d767b9ac482b30acb6e42aa6fba81e`、SHA256 `266602611b1233ca3b917f0aaffe8ba25853f2b41ba643e74843c5e0bc836780`。専用AVDのインストール実体も起動前に同hashを確認。新CI実行・署名入力読取・公開artifact生成なし。
- 前回menu試験専用AVDだけを再起動。API35／arm64-v8a／PAGE_SIZE16384を毎回guardした。同じAVDデータとOS環境を維持し、条件ごとにPonletだけをforce-stop／再起動、Web相手は新しい隔離contextとした。端末全体のcold start同士の比較ではない。
- 相手は既存公開 `https://ponlet.mat2uken.app/`。そのWeb／WASMのsource revisionは未確定で、ローカルコードの同一revisionを配信しているとは保証しない。既存Google／Firebase・relay通信と自作dummyだけの範囲。実QR、実機・USB、audio、第三者宛送信、Console保存・Play配布・サイト公開は行わない。
- 接続は既存UIと今回だけの自作inviteを使用。Native UI入力の全343文字一致、Web state=connected／canSend、NativeのConnected actions表示を確認。画像を再送せず、接続後最初のfile attemptを記録した。
- 隔離Webの既存Go bridgeに観測ラッパーを置き、port・開始／完了・Promise所要時間・成否・同じ宛先のordinal・listener ordinalだけを保存した。addr・鍵・本文は数値イベントへ出力しない。成功値をそのまま返し、元のerrorを再throwする `.then` による軽微な計測介入がある。未計測版と時間・実行順が完全同一とはしない。

## 3条件の結果

| 条件 | 最初のdial／相手の準備状態 | 今回の結果 |
| --- | --- | --- |
| A：新接続、テキスト送信なし、Web→Android画像 | Web listener ready後にcontrol100をaccept。接続後のWeb側outgoing dial先行なしで、最初にport102／peer ordinal1を1回。control acceptからfile dial開始まで63.353秒。Native接続UIを事前確認 | Promise成功2122ms。新規受信99 bytesとSHA256一致。受信mtime04:04:10 UTCが今回の試行と一致。Web snapshotはDERP表示 |
| B：新接続、Web→Androidテキストの受信後idle、最初の画像 | 同peer ordinal1でtext101成功→file102。text dial成功からfile dial開始まで581.954秒。本文受信をNative UIで完全確認した時点から画像試行まで439.047秒。直前Web connected／canSendとNative接続UIを確認。送信後にもNative PID存在を確認 | Promise成功2019ms。別名の新規受信99 bytesとSHA256一致。Web snapshotはWebRTC表示。待機6観測点ではvisible／onlineを維持 |
| C：新接続、最初のAndroid→Web画像 | 同Web listener ordinal1でcontrol100→file102をaccept。Web側outgoing dialなし。Nativeは先にjoin100の通信があるため、Aとの完全対称なcold transport比較ではない | Web受信1件、UIのOpen（Web download）で新規97 bytesとSHA256一致。Native側dial開始／完了の直接計測はしていない。Web snapshotはWebRTC表示 |

99 bytesのSHA256は `be95da8b3f09406cc671b23e14e692948c5be2fc96d7dfc5eed7eade0c4b7f37`、97 bytesは `9b1dd1e812425b88dce4b8bd1594f3c6b76f8c97f0c2de135e1acbdd3b0ca1fb`。Bの本文は自作43 bytes／3行で、Native UI一致を確認した。Aは今回の受信mtime、B／Cは条件固有の名前と受信hashで、過去の同一dummyの誤認を避けた。Android側hash読取は前回と同じ既存debug AVDの `su 0` で、今回の受信dummyだけを対象とした。

Bは360秒を予定したが、UIの件数badgeでtab名が変わり、最新UIを照合してから未実行のfile attemptを開始した。439.047秒と581.954秒を、正確な「6分後」と記録しない。初期WebView準備待ち、URL完全入力、badge付きUI名やdownloadボタンの確認、hash読取方法の補正は試験手順の問題で、画像retryや製品timeoutの再現とは数えない。画像の試行は3回、再試行0回。

取得した各条件のPonlet PID限定logにはFATAL EXCEPTION／ANR markerは0件。全process・全期間のcrash不存在や、SDK送信停止を保証した結果ではない。

## 原因について言える範囲

ローカル `tailcat/bridge/web/main.go:157–191` はaddrごとにClientをcacheし、新ClientだけPingを行い、TCP dial失敗時にcacheを破棄する。同じtargetへの101→102はClient再利用と整合するが、観測ordinalは宛先の一致であり、Go内部cache hit・Client世代・WireGuard状態の直接証拠ではない。公開Webのrevisionも未確定である。

計測したPromise時間には初期化・Ping・dial後の経路判定も含まれ得る。`tailcat/bridge/transportpath/transportpath.go:87–93` の判定は最大2秒のDiscoPingを行うため、約2秒をTCP handshake時間と呼ばない。端点UIのDERP／WebRTC表示も、全payloadの経路証明には使わない。

前回の画像初回失敗時はDERP表示、今回のidle条件BはWebRTC表示で、**DERP表示下のtext後idle条件は今回未検証**。APK実体も前回734d9590と異なる。3条件各1例の成功から、初回timeoutの解消、再現不能、6分cache不具合なし、常時方向差なしとは判断しない。前回失敗時の相手file102の準備状態と内部Client状態は、今回の成功から遡って確定できない。

現証拠では通信コードの修正・自動retry追加を裏付ける原因はなく、製品コードは変更していない。残る追試候補は、再発時のDERP表示／WebRTC表示、同一宛先101→102、実測idle、受信側準備状態を揃え、内部Client生成／再利用・dial開始／完了を秘密値なしで識別すること。特定経路を強制する新buildや計測コードの製品追加は今回実施していない。無制限な反復はしない。

## 後始末と証拠

04:27:22 UTCに、この追試の隔離Web相手3プロセスと、PID／AVD名／port／専用pcap pathで所有確認したAVDだけを停止した。他のADB server・実機・ユーザーブラウザは操作していない。今回新しいActions artifactは作っておらず、使用APKの元run37172964773の短期artifactは前回削除済み。

私有証拠はignored `work/timeout-runtime/private/` の `trial-a-result.json`、`trial-b-result.json`、`trial-c-result.json`、各connection-proof・safe snapshot・UI、`cleanup.json`。観測コードは `work/timeout-runtime/observer.js` とhelperに保持する。APK、invite、raw log、pcap、受信downloadはGitへ追加しない。pcap2447 recordsは全AVDの限定captureで、`partial_tail=false` はレコード末尾が不完全でないことだけを示す。全通信の捕捉・packet欠落なし・SDK payload帰属を保証しない。
