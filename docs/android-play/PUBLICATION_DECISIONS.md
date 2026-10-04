# 申告・掲載資料で残る最小の判断

2026-10-04 UTC。内部草案。Console保存・公開ページ差し替え・Play配布は行っていない。無料、子ども向けを意図しない一般向け、診断既定ONとOFF操作、広告ID無効化、Android受信cloud backup除外は承認済みで、再確認しない。closed testの12人確保は所有者が別途検討する。募集・招待は行わない。

## 所有者が決める2点

1. **配布国と具体的なPlay対象年齢帯**。18歳以上は提案で、確定済みではない。実際の想定利用者・掲載内容と合わせて決める。一般向けという承認やAppleのratingから具体的年齢帯を補わない。地域確定後に、その地域での表示・同意要件と現行の既定ON説明を照合する。[Console草案](CONSOLE_ANSWERS_DRAFT.md)を参照。
2. **診断データの削除相談を処理する運用**。既存の `app-support@mat2uken.app` で誰が受け付けるか、本人とSDK識別子を安全に照合できるか、Google側へ確認できる対象、対応できない範囲、受付／完了の回答を決める。窓口の存在だけで削除実行を保証しない。新しい削除UIやSDK廃止を必須と判定したものではない。本文・ファイル・招待URL・鍵を削除相談のために要求しない。[SDKの削除調査](SDK_RETENTION_AND_DELETION.md)を参照。

Google側の広告personalization・account共有・保持期間を変更することは、現時点で公開前の必須操作とは判定していない。現設定を説明に反映し、変更する場合だけ他platformへの影響を含めて別に判断する。[実設定記録](PROJECT_SETTINGS_READONLY.md)を参照。

## 検証限界を添えて整理できる事実

| 項目 | 現証拠から書ける内容 | 書かない保証／残る担当確認 |
| --- | --- | --- |
| SDK収集 | 利用状況、クラッシュ／診断、識別子、AnalyticsのIP由来概略位置を申告対象として整理する | 全payloadを取得済み、広告ID以外のIDなし、位置権限なしだから概略位置なしとはしない |
| 任意性 | Firebaseの2 SDKは設定でOFF可能。QR処理とML Kit診断は別 | データ種別に複数SDKが含まれる場合、全体を任意と自動回答しない。SDK開始条件と実際のConsole設問を担当が照合する |
| OFFと削除 | Crashlyticsは次回起動からOFF反映。端末保持・再ON時の未送信情報送信がある。OFFは過去データ削除ではない | 全Google通信の即時停止、queueの完全破棄、ML Kit停止とは説明しない |
| 新署名候補 | source c7408ea0、code2030000102で広告関連3権限なし、広告ID／personalization flag false、受信cloud除外、Firebase project構成一致をCIとMacで確認済み | 既存Play内部テスト版2026093037や全platformまで同じ設定としない。Play経由配布・全OEM復元は別 |
| SDK保持 | 読み取り対象GAのevent2か月／user14か月／活動による期限更新ONを対象別に説明。Crashlytics90日は削除開始まで | 全データの最大14か月、全て90日で消えるとはしない。ML Kitの固定保持期間は未確認のまま |
| 転送内容 | 独自telemetryの引数に本文・ファイル名・パス・招待URL・鍵を渡さない。転送内容はE2EE | E2EE内容の開示例外と、診断・接続情報・OS backupを一括扱いしない。各経路の適用除外を担当が判断する |
| Google送信と共有分類 | Googleへの送信とGoogle Play設問の「共有」は別。現account／project設定を参照する | Google送信だから全種共有あり、service providerだから全共有なしと自動回答しない |

署名候補の実体検証は [menu修正・追試](MENU_FIX_RESULTS.md)、SDKの一般仕様は [保持・OFF・削除](SDK_RETENTION_AND_DELETION.md)、実設定は [read-only記録](PROJECT_SETTINGS_READONLY.md) に分ける。端末のOFF保存成功はSDKの全送信停止を観測した結果ではない。

## 資料を仕上げるための担当確認

所有者の上記2判断を受け、担当は次の3点だけを提出対象の状態に合わせて詰める。確認不能な値や削除保証を仮値で埋めない。

- **Consoleの分類**：第三者SDKを含む実データ種別・用途・任意／必須・共有／例外、E2EE・OS backupの扱い、暗号化と削除要求の設問を最終照合する。新候補の結果を、まだ有効な旧版を含む申告範囲へ無条件に適用しない。
- **保持・削除の説明**：固定保持期間が不明なML Kitは不明のまま説明し、対象別の期間・追加コピー・Google側の処理と運用窓口の対応範囲を一致させる。Googleへの保持／個別削除の問い合わせはまだ送っていない。所有者の判断だけでSDK仕様を確定しない。
- **日英・Androidの一致**：ローカルHTMLとData safetyの意味を揃え、未検証の全通信停止・全コピー削除・全端末復元保証を含めない。署名APKで確認済みの操作と未実施の実camera・Play導入等を分ける。内容が確定しても公開は別承認とし、公開後のURL／app内リンク／Console登録の一致を確認する。

全payload取得、OFF中の全queue、全OEM復元を網羅する追加品質試験を、限定した説明文を整えるための一律必須条件にはしない。ただし、未検証の機能を保証する文や、実行できない削除要求の申告は確定しない。`publication_ready=false` を維持する。

2026-10-04に [Playの設問定義](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en)、[Firebase開示資料](https://firebase.google.com/docs/android/play-data-disclosure)、[ML Kit開示資料](https://developers.google.com/ml-kit/android-data-disclosure) を再確認した。PlayはSDK経由の収集も対象とし、任意性は全利用者の選択可否で判断する。ML Kit資料は最新SDKの説明であり、barcode18.1.0の実payloadを観測した証明として使わない。
