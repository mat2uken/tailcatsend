# 開発署名・Firebaseなしの16KBローカルpilot

2026-10-03 18:51–19:00 UTC。重複pilotや実行中AVDがないことを確認して実施した。既存ARM64/16KB system image、SDK tools、開発用keystoreを使用し、依存導入・新credential作成・macOS権限変更はしていない。今回起動した専用AVDは試験後に終了した。

## 候補と隔離条件

製品コードの基準は `5e0125797c2466918772a6722302d84219a1792a`、文書を含む調査時HEADは `c6a557c22caffd53d460cc40a5f8892c000b0beb`。既存unsigned release APKのコピーへ、既存 `/Users/kenichim/.android/debug.keystore` をapksigner内だけで使用して開発署名した。秘密鍵・passwordの抽出や出力はしていない。開発用標準passwordを用いる既存keyであり、production署名を使った試験ではない。

| 項目 | 実測・確認 |
| --- | --- |
| package／version | `jp.yasagure.ponlet`／1.0.18／2030000102、min31／target36、arm64-v8a |
| 入力unsigned APK SHA-256 | `ae49dcfe40bfa62bc7ee6f789dbd12ba8fdba92bec4abadd6626c7b4cc643961` |
| 開発署名APK SHA-256 | `4fb6a17307a1e4e2294c735e811818c86482dd0d26f4175bbfe8bd4d80fcf711` |
| 署名検査 | apksigner verify成功、v3署名、signer1 |
| 元APKとの比較 | 元ZIP entryの内容差分0。追加はMETA-INF署名3件のみ |
| AVD | `ponlet-pilot-16k`、API35、`arm64-v8a`、`getconf PAGE_SIZE=16384` |
| データ領域 | workspaceの `work/local-dev-pilot/avd-home/` に空の試験AVDを用意。既存AVDのconfigだけを参照し、既存userdataやsnapshotはコピー・使用しない |
| インストール | package不在を確認後、この開発署名APK1本だけを新しい試験AVDへinstall。既存アプリの更新・uninstall・data clearはなし |
| 操作経路 | loopback5581のraw ADB。AUTH要求なら即停止。ADB server、USB、物理端末を使わない。既存の試験用emulator homeを利用し、新しいADB鍵は作らない |
| camera／audio | camera front/back none、no-audio、no-window、snapshotなし。macOSカメラ・音声・boardには触れない |
| runtime通信 | boot完了後、app install前にIPv4/IPv6 OUTPUTの先頭へ `! -o lo -j REJECT`。終了前にも継続を確認。外向き通信を許可してSDK挙動を観測した試験ではない |

AVD boot前から全通信を遮断したという保証ではない。Google APIs system imageにはGoogle側の既存アプリが含まれる。Ponletのinstall/runtime期間の遮断と、boot時のOS通信を区別する。proxyの設定だけを遮断根拠にせず、install前の両iptables規則を根拠にした。

## 結果

| 試験 | 結果 | 証拠・限界 |
| --- | --- | --- |
| releaseアプリ起動 | 成功 | MainActivityのCOLD start3回、process生存、Ponlet実画面と招待QR表示。QR読取・peer接続の成功ではない |
| Rust／GoロードとIPC | 成功 | 実アプリprocessのAPK実行mappingをELF LOAD offsetと照合し、`libtailsend_tauri_lib.so`／`libtailcat.so`を確認。`PonletPort: ArrayBuffer IPC listener attached`。未使用SDK全9本がアプリ内で初期化成功したという意味ではない |
| 初回既定ON | 成功 | 設定画面のチェック表示。初期保存keyなしの場合の既定trueと一致 |
| OFFの保存・再起動 | 成功 | 実画面から変更し、`telemetry_prefs.xml` の `telemetry_enabled=false` を確認。force-stop→COLD start後もfalseとOFF画面を確認 |
| 再ONの保存・再起動 | 成功 | 同じ操作でtrue保存、COLD start後のtrueとON画面を確認。SDKへの送信再開を実証した結果ではない |
| scratchの基本保存 | 成功 | 生成した日本語テキスト35byte、0byteファイルを専用 `/data/local/tmp/ponlet-policy-runtime/` へ保存しSHA-256一致。ADB経由の保存であり、Ponletの受信保存・SAF保存経路ではない |
| crash／ANR | 試験中の記録なし | crash buffer空、アプリのexit-infoは試験操作によるforce-stop。WebView isolated processの終了も区別。短時間試験であり長期安定性の保証ではない |
| Firebase初期化 | 未初期化（予想どおり） | Ponlet PIDのログはdefault optionsなし。別PIDのGoogleアプリのFirebase成功ログをPonletの成功に流用しない |

UIAutomator XMLのcheckbox checked値はスクリーンショットと一致しなかった。また起動直後のdumpはWebViewのみで、早い設定tapは無効だった。トグル状態の証拠には、画面が準備できた後のスクリーンショットと実保存値を使った。自動化にXML単独の判定を採用しない。

## まだ試験していないもの

- 本番署名、Firebase client構成込みのrelease、Play署名版からのupgrade、4KB環境、実機／OEM。
- Firebase初期化後のAnalytics／Crashlytics収集・queue・OFF／再ON送信、ML Kit独立診断。今回Google client設定を追加していない。
- QRカメラ読取、双方向転送、Document pickerでの送信、受信ファイル保存／開く、メッセージのSAF保存。offlineの相手未接続状態ではworkspaceと保存操作が有効にならず、生成データを内部状態へ注入して合格とする方法は採らない。
- cloud backup／D2D実移行。承認済みの受信cloud除外とD2D既存対象維持は別々に保持する。18歳以上は提案であり、このpilotで決定していない。

## OFF説明と変更候補

AnalyticsのOFFは収集設定を無効にする操作であり、即時の全通信停止・過去データ削除の保証ではない。Android Crashlyticsのfalseは次回アプリ起動から有効で、OFF中もcrashを端末に保存し、再ON時に未送信情報を送信し得る。今回確認したのはPonletの設定保存と画面であり、未初期化SDKのqueueや送信を実証した結果ではない。[公式APIと根拠](SDK_RETENTION_AND_DELETION.md#off端末queue再onの動作)

未送信情報の確認／破棄UI、再ON時の説明追加、OFF時の自動破棄は**変更候補のみ**。現行コードへ追加していない。`deleteUnsentReports()` は収集ON時no-opで、端末の未送信情報向けの非同期処理であり、Googleへ既に送ったデータの削除ではない。AnalyticsのローカルresetとGoogle側削除も別の操作である。既定ON／保存済みOFF維持を勝手にopt-inへ変えない。

次段は[署名release検証計画](SIGNED_RELEASE_VALIDATION_PLAN.md)に従う。実転送とアプリ保存には相手を接続する限定試験が必要であり、使用するlocal dev経路・試験APK・通信許可範囲を具体化する。新SDK導入や新OS権限は今回不要だった。production Firebase／crash生成／配布・CIを今回のpilotへ追加しない。

## ローカル証拠

`work/local-dev-pilot/`（Git対象外）へ以下を保存した。設定画面以外の画像には試験用の招待QRがあるため公開しない。

- `preinstall.txt`、`install.txt`、`launch.txt`、`final-runtime.txt`：環境、遮断、install、起動、対象PIDのSDK／IPCログとexit-info。
- `settings.png`、`off-restart-ready.png`、`on-restart-ready.png`：初回ON／再起動OFF／再起動ONの実画面。
- `off.txt`、`off-restart-ready.txt`、`on.txt`、`on-restart-ready.txt`：自分で作った保存値。
- `apk-comparison.json`、`native-maps.txt`／`native-maps-summary.json`、`dummy-storage.json`：候補同一性、core nativeロード、scratch保存の限定した証拠。
- `pilot-report.json`：候補hashと実測範囲、未検証項目、終了結果の機械可読な記録。
- `emulator.log`、`inspect.py`、専用AVD設定：実行条件。emulatorはPID17668だけをTERMで終了、実行sessionはexit0。

push、CI dispatch、Play、upload、公開、Google設定変更は行っていない。
