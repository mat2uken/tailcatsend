# 設定・補助操作と通信経路の確認手順

この手順は、SlintからWebViewへ移した共通画面で、設定・補助操作と通信経路の表示を同じ入力で確認するためのものです。検証したcommit、端末、OS、操作結果を一つの記録に残してください。過去の実行結果や別のビルドの画面を、現在の結果として扱わないでください。

## 自動確認

依存関係を準備したリポジトリのルートで、次を実行します。

```sh
cd web-ui
npm run lint
npm run typecheck
npm test
npm run test:e2e
```

実通信では、同じ生成物を使った2つのブラウザを接続します。通常経路とDERP固定を分けて実行し、端末ごとのsnapshotに記録された `transport` を確認します。

```sh
npm run test:e2e:real
npm run test:e2e:real:derp
```

iPhoneを接続した場合は、[IOS_DEVICE_VALIDATION.md](IOS_DEVICE_VALIDATION.md) のUDID指定と専用CDP確認を先に行ってから、次を実行します。

```sh
PONLET_IOS_UDID=<unlocked-device-udid> npm run test:e2e:ios
PONLET_IOS_UDID=<unlocked-device-udid> npm run test:e2e:ios:derp
```

Android実機では既存の `PONLET_ANDROID_SERIAL` を指定します。

```sh
PONLET_ANDROID_SERIAL=<serial> npm run test:e2e:android
PONLET_ANDROID_SERIAL=<serial> npm run test:e2e:android:derp
```

## 設定と補助操作

各OSの同じ接続で、次の順に確認します。操作が使えない場合は、成功表示だけを記録せず、エラー表示と再試行結果も残します。

| 項目 | 確認内容 |
| --- | --- |
| 表示言語 | Settingsを開き、日本語とEnglishを切り替える。ダイアログを閉じて再表示し、選択値と画面全体の文言が維持されることを確認する。`ponlet.language` も記録する。 |
| Telemetry | 現在値の読み込み、ON/OFF切替、切替中の二重操作抑止を確認する。読み込みまたは書き込みを失敗させた場合、toggleの状態が戻り、再試行できることを確認する。 |
| 招待URL | QR待受後にCopy invitationを実行し、別端末で貼り付けて接続する。再生成前後のURLが異なり、期限表示が更新されることを確認する。 |
| Clipboard | Pasteで本文を入力し、Paste & connectで招待URLを入力する。clipboardが使えない環境では案内を表示し、接続を開始しないことを確認する。 |
| 履歴 | 送受信した日本語本文が新着順に表示され、Clear historyで消えることを確認する。送信成功後も自分の履歴が残ることを確認する。 |
| 本文の補助操作 | Copy、Save、Shareを同じ本文で実行し、各OSの結果または失敗理由を記録する。ブラウザのShare非対応時はCopyへ戻ることを確認する。 |
| 受信ファイル | Open、Copy save locationを実行する。ファイル名、byte数、保存内容のSHA-256を記録し、同名ファイルを2回受信して両方が残ることを確認する。 |
| QR読取 | 対応端末でカメラを開き、閉じる→再表示→閉じるを行う。権限拒否、Escape、取消後に待機が終了し、遅れて返ったQRで接続しないことを確認する。 |

## 経路表示の読み方

`transport` は接続相手全体で共有する値ではなく、そのアプリの端点が最後に確認したデータstreamの経路です。相手側のsnapshotとは別に記録します。

| 値 | Tailcatでの根拠 | 画面表示 |
| --- | --- | --- |
| `direct-udp` | `PingResult.Endpoint` に直接UDPのendpointが入る | `WireGuard UDP` |
| `webrtc` | `Endpoint` が `127.3.3.41:<port>` のWebRTC用endpoint | `WebRTC DataChannel` |
| `derp` | `PeerRelay` または `DERPRegionID` が設定され、直接endpointがない | `DERP relay` / `DERPリレー` |
| `unknown` | まだ有効な経路を観測できない | `Checking path…` / `経路を確認中…` |

実通信の記録には、最低限次を含めます。

```text
commit=<sha>
端末A=<name/os>
端末B=<name/os>
端末A transport=<snapshot.transport>
端末B transport=<snapshot.transport>
方向=<A->B または B->A>
入力=<name,size,sha256>
受信=<name,size,sha256>
結果=<completed/cancelled/failed>
時刻=<ISO-8601>
```

片方がWebRTC、もう片方がDERPと表示しても、それだけでは転送失敗や経路分類の誤りを意味しません。2つの端点が同じ経路を観測したかを主張する場合は、同じ実行の両側のsnapshot、転送方向、受信byte数、保存内容をそろえて判定します。`unknown` のままの表示や、表示だけの「P2P」は実通信の証拠にしません。

## 全OSの配布前チェック

Windows、macOS、Linux、iOS、Android、Webについて、ビルド成功、画面操作、実通信、保存内容、公開物を別々に記録します。実機がないOSは、CIのビルド結果を実機操作の代わりに扱いません。公開Webへ反映した場合は、生成したUI、Rust WASM、Go WASMの取得元とSHA-256を記録し、上記のWeb実通信を公開物で再実行します。
