# Tailcat更新記録

## 更新対象

2026-09-22に上流`main`を確認し、専用worktreeのTailcatを更新した。

| 対象 | 更新前 | 更新後 |
|---|---|---|
| Tailcat submodule | `cbbabaf30e18efbb02b28ac1a8126193354c7f19` | `c03c52432ca9f3105f9ace3835748a2365e6afde` |
| Tailscale submodule | `31d8badb3bfb88618dc8ea8e6a5c3bce0cd6cc9f` | `a2263542f260e73260e821a2d1b81475c35b0766` |

Tailscaleは更新後Tailcatの`go.mod`が指定するrevisionに合わせた。bridge側の`go.mod`/`go.sum`、`upstream.lock`、Webの`bridgeVersion`も同期した。

## 管理パッチ

- `0001-android-selinux-netmon-fallback.patch`を維持した。上流のAndroid対応は主にraw executable向けで、Ponletの`GOOS=android CGO_ENABLED=1`用のnetmon再試行・通知を置き換えない。
- `0002-tailscale-webrtc-transport.patch`を新Tailscaleに移植した。上流の依存更新と`tsnet/TestDeps`のDNS制約を保ち、WebRTCの追加分だけを残した。過去の`.orig`バックアップ4件とNix依存固定用の古い生成差分3件は除いた。
- 更新後のwireguard-goでは`conn.ReceiveFunc`が連続バッファと`[]conn.ReceivedPacket`を受け取る形式になったため、`receiveWebRTC`を追従させた。上流の`receiveDERP`同様、バッファ先頭にコピーし、`Offset=0`・`Size`・`Endpoint`を返す。受信内容、空/未知peer/過大packetの読み飛ばし、終了時の`net.ErrClosed`を確認する回帰テスト2件を追加した。
- `0003-tailcat-status-peer-report.patch`は削除した。上流`15ab9e68b`が`StatusBuilder{WantPeers: true}`と`TestStatusReportsPeers`を追加しているため、適用スクリプトからも取り除いた。
- `wasm-build-tags.txt`は新Tailcatの`internal/buildtags.WasmTags()`と同じ計算で再生成した。`androidbin`、`androiddns`、`connreject`、`dnsresolvecache`の除外タグを追加し、上流で廃止された`netgo`、`osusergo`、`omitidna`、`omitpemdecrypt`を除いた。タグ数は82のまま。
- lockに`tailscale_commit`を記録し、既存updaterの`commit=`置換を行頭一致に限定した。

## 検証

- 両submoduleの固定SHAから一時indexを作り、管理パッチの適用と逆適用を検証した。適用後の全ファイル（Tailcat 1件、Tailscale 24件）が作業中のファイルとGit blob単位で一致した。submodule内のindexは変更していない。
- `scripts/apply_tailcat_patches.sh`の再実行は両パッチとも適用済みとして成功した。変更したBashスクリプトの構文検査も成功した。

| 検証 | 結果 |
|---|---|
| Go bridge native / transportpath | 成功 |
| native daemon / macOS c-archive | 成功 |
| Go WASM Promise / Listener | 成功 |
| 製品タグでのGo WASM build / gzip | 成功 |
| 上流`TestStatusReportsPeers` | 成功 |
| `feature/webrtc`全テスト、magicsockの`-run WebRTC` | 成功。今回追加した`TestReceiveWebRTC*`も成功 |
| `tsnet/TestDeps` | 成功 |
| 生成WASMのlistener lifecycle | 成功。20回破棄、retained=0、lateClosed=2、unhandledRejectionsなし |
| Chromium実通信（WebRTC / DERP固定） | 両方成功 |
| Firefox / WebKit実通信 | 両方成功 |
| macOS製品の未署名build | `cargo tauri build --no-bundle --ci --no-sign`成功 |
| Android arm64 Go c-shared | 成功 |
| iOS arm64 Go c-archive | 成功 |

ログ・補助スクリプトは`work/tailcat-update-20260922/`に保存する。macOS製品は今回生成したc-archiveでリンクした。Android/iOSはGoライブラリのクロスビルドで、署名済アプリ・実機動作は未検証。Windows/Linux CIも未実施。

主要ログ: `go-test-native-transport-final.log`、`go-wasm-tests.log`、`upstream-status-final.log`、`feature-webrtc-all.log`、`magicsock-webrtc-all.log`、`tsnet-testdeps.log`、`web-listener-e2e.log`、`browser-{chromium,chromium-derp,firefox,webkit}.log`、`cargo-tauri-build.log`、`go-build-{android,ios}-arm64.log`。上表のコマンドはすべて終了コード0。

macOS buildが生成した`acl-manifests.json`のbarcode-scanner項目削除は、当該項目以外に差分がないことを確認して復元した。元のDesktop worktreeは`32d4a0b`のままclean、`tailcatsend-final`の既存12ファイル差分も維持している。
