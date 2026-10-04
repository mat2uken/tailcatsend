# Ponlet 診断削除 Worker 実装

機能を無効にした本番向け実装コードです。固定fixtureだけのprototypeとは異なり、WebCrypto署名検証、実Google HTTP adapter、server-only OAuth、Durable Objects保存APIに接続するコードを含みます。今回実行したのはローカル固定fixtureテストだけです。実credential・Google疎通・登録・削除・公開は行っていません。

## ローカル検証

Node 24で npm test / npm run check。新しい依存は不要です。Cloudflare runtimeを動かしたテストではありません。保存試験はNode内蔵SQLiteでCloudflareの使用API部分を再現しています。

src/entry.mjs は Cloudflare組込みの cloudflare:workers をimportします。これをNodeで直接起動せず、coordinator/auth/provider/storageのテストを実行してください。Wranglerは未導入で、このフォルダにdeployコマンドはありません。

## 実装内容

- GET /v1/capabilities、POST /v1/challenges、POST /v1/enrollments、POST /v1/requests、GET /v1/requests/{requestId}、POST /v1/requests/{requestId}/client-state
- Ponlet-Privacy-KeyにRFC7638 thumbprint、Ponlet-Privacy-ProofにES256 JWS。登録・削除作成とそれら向けchallengeはX-Firebase-AppCheckが必要
- challenge本文はschemaVersion/kid/method/path。登録向けだけpublicJwkを加える。既存受付の照会/続行challengeはrate-limitを適用し、AppCheck更新の障害だけで遮断しない
- AppCheckは固定Google JWKS URLのRS256署名・issuer/audience/allowed app/expiryを検証。初版はWorkerごとにFirebase Android appを1つに限定し、削除先appと一致を必須にする
- 初回登録は公開鍵所持証明で、他人の既存Firebase IDの所有を証明した扱いにはしない。サーバーで独立256bitのサービス別IDを作るコードを持つ。テストは固定ID生成器を注入
- 受付・対象snapshot・nonce消費・epoch退役・次回alarmをSQLite-backed Durable Objectの同じtransactionで保存。202は保存後だけ
- Google呼出しはtransaction外。leaseと永続した次回予定で復旧。exactly-onceは保証しない
- 最初のGoogle申請は、そのサービスの端末処理確認を待つ。Analyticsはreset_requested、Crashlyticsはdelete_queuedまたはno_unsent_reports_observedまで待機し、独立したもう一方の処理を止めない。再起動中にalarmを繰り返さず、client-state保存と同じtransactionで次回予定を戻す
- 既存epochのpolicyVersionを維持。provider property/project/appも登録時に固定し、環境変更で古いIDを別宛先に送らない。すでに受け付けた重複申請は宛先変更後も元の受付を返す
- 受付と対応表の保持日数も登録時に固定し、後の設定変更で旧申請の保持を短縮しない。enrollment応答のretentionに保存済みreceiptDays/mappingDays/retiredKeyPolicyを返し、nativeは適用前に自分の保持設定と照合する。再登録応答にも現在の環境値ではなく保存済み値を返す
- 古い保存状態などで、停止/削除の未確認から確認済みへの変化がGoogle申請後になった場合、providerごとにadditionalSubmissionRequiredを保持する。確認済みのdelete_queuedからno_unsent_reports_observedへの補強だけでは追加申請にしない。Google内部での後着データへの追加申請方針は未検証であり、自動で完了扱い・無限再申請はしない
- 設定・資格情報の一時障害でも既受付と対応表整理のalarmを残し、修復後に復旧できるようにする。待機間隔は障害前の明示設定を保存して使う
- 権限修復後の再開はDO内部のresumeAfterConfigurationFixだけ。公開HTTPやアプリから操作できず、元の対象と失敗したサービスだけを扱う。後着データの追加評価を迂回しない
- リクエスト本文は長さだけでなく読取り時間も制限し、遅い送信でDOを割り当て続けない

## 無効のままになっている設定

wrangler.example.jsonc は公開しない例で、機能false・adapter disabledです。保持日数、audience、policyVersion、対象Google識別子、rate-limit、AppCheck、lease、timeout、IAM確認などはconfig.mjsの明示値が必要です。未設定・不正な値、plain variableを誤って渡したbindingはfail closedです。

GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEYは選択肢としてserver-only OAuth adapterが参照する名前です。秘密情報をコード・アプリ・チャットに入れません。service account作成・鍵作成・保存方法の選択もまだ行っていません。鍵なし方式を選ぶ場合はgetToken(provider,{scopes,signal})を満たすサーバー側adapterへ置き換えられます。

必要なOAuth scopeはAnalyticsのanalytics.edit、Crashlyticsのfirebaseだけを固定し、cloud-platformへの拡張を行いません。scopeは対象データへの権限を付与するものではありません。Crashlytics最小IAMを未確認の広いroleで代用しません。

## 保持

日数は本番値を決めていません。RECEIPT_RETENTION_DAYSとMAPPING_RETENTION_DAYSは、登録時の値を対象に保存し、Google側の両受付と端末進捗を確認した時点から別々に適用します。端末進捗がunavailable、未解決・再起動待ち・追加評価待ちは期限だけで捨てません。この整理条件は実データの削除完了を示すものではありません。条件を満たした後に受付を整理し、その後対応表を整理します。

RETIRED_KEY_POLICY=retain_tombstone は、対応表を除いた後も旧鍵の再登録を拒否する最小markerをhashed Durable Object名の下に残す明示方針です。永続markerの採用は本番設定前の確認事項です。BACKUP_RETENTION_DAYSは宣言値でCloudflareのPITR設定を変更しません。SQLite Durable ObjectのPITRは公式説明上30日を扱うため、実際の保存・復旧・バックアップ方針との照合なしに保持の達成を約束しません。

## 未検証

Cloudflare/Googleの実疎通・storage/alarmの実挙動・rate-limit binding設定・least IAM・失効/ローテーション・遅延到着の終了条件・実保持/backupを含む運用は未検証です。fixture成功で本番readyとはしません。JWKSは設定TTLを使ってcacheするため、新しいkidはcache期限まで拒否され得ます。明示rate-limitと短く適切なTTLを実環境で検証する必要があります。

公式仕様: [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)、[rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)、[App Check](https://firebase.google.com/docs/app-check/custom-resource-backend)
