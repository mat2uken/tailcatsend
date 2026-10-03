# 16KB RELROの再評価

2026-10-03 UTC。前の報告で「SDKのRELRO式不合格2件が提出ブロッカー」「SDK修正／再ビルドが必須」とした評価を訂正する。**式の不一致は事実だが、起動不可やPlay拒否は確認できていない。** LOAD、APK ZIP、RELRO保護、アプリ機能、Play処理を別々に判定する。

## 公式資料とlinker実装

[Googleのガイド](https://developer.android.com/guide/practices/page-sizes#relro)には `(VirtAddr + MemSiz) % 0x4000 == 0` のRELRO式と、余分な保護範囲の書き込みで障害になる説明がある。一方、[Android 16 linker](https://android.googlesource.com/platform/bionic/+/android16-release/linker/linker_phdr.cpp#1376)はRELRO開始をページ先頭へ切り下げ、終端を切り上げて `mprotect(PROT_READ)` する。Android 15も同じ方式で、余りが非0という理由だけで拒否する処理ではない。再配置後に保護するので、その後に必要な書き込み・実行範囲が同じページへ入るかを調べる必要がある。

[公式のalignment検査スクリプト](https://android.googlesource.com/platform/system/extras/+/refs/heads/main/tools/check_elf_alignment.sh)はLOADのalignmentとAPKのzipalignを検査し、RELRO式を使わない。ただしこれがPlay内部の判定と同一という根拠はない。新AABのConsole検出結果は未確認である。

| 検査 | 今回の結果 | その結果だけでは分からないこと |
| --- | --- | --- |
| LOADのalignment／offset-vaddr整合 | 全9本16KBで合格 | SDK処理、固定4KB前提の有無 |
| APK ZIP配置 | 全9本16KB、zipalign合格 | AABからPlayが生成したAPKの実体 |
| RELROガイド式 | SDK2本は非0 | 実際のロード失敗、保護後の書き込み失敗、Play拒否 |
| RELROが丸めて保護する領域 | 下記2本に可変データの重複なし | 実行時の全動作 |
| 通常validator | 警告付き合格 | Androidアプリ・Firebase／CameraX機能の成功 |
| strict option | 式監査として失敗 | 公式に公開されたPlay拒否条件ではない |

## 実ELFの配置

| 対象 | RELRO／RW範囲 | 16KB保護範囲 | 追加保護される可変データ |
| --- | --- | --- | --- |
| CameraX 1.5.1／1.6.2 `libsurface_util_jni.so` | RW LOADとRELROが `[0x49b0, 0x5000)` で一致 | `[0x4000, 0x8000)` | `.data`／`.bss`なし、追加tailに別のwritable LOADなし |
| DataStore 1.1.7 `libdatastore_shared_counter.so` | RELRO `[0x51c0, 0x6000)`、同RW LOAD `[0x51c0, 0x5428)` | `[0x4000, 0x8000)` | 可変 `.bss` `[0x9428, 0x9429)` は保護範囲外 |

いずれもBIND_NOW。公式ガイドが例示する「RELROを丸めた先の書き込みデータが読取専用になる」原因は、この配置には見つからない。安全な全動作の証明ではないが、余りのみでSDK不具合とする根拠にもならない。

readelf・取得ソースの証拠は `/tmp/ponlet-relro-review/`、SDK比較JSONは `/tmp/ponlet-sdk-comparison/report.json`。DataStore最新安定1.2.1はガイド式の余り0、CameraX最新安定1.6.2は旧版と同じ非0だった。[DataStore公式リリース情報](https://developer.android.com/jetpack/androidx/releases/datastore)、[CameraX公式リリース情報](https://developer.android.com/jetpack/androidx/releases/camera)にRELRO／16KB修正歴の明示は見つからず、この式だけを理由にSDK更新・fork再ビルドは進めていない。

## 検証の限界と次の確認

既存の `musicaz-16k-20260907` AVDとAPI 35 `google_apis_ps16k/arm64-v8a` revision 5のsystem imageを発見した。新emulator・system imageのinstallは不要。読み取り専用・snapshot保存なし・音声なし・カメラなし・headlessで、別loopback portへ起動した。既存ADB server／USBを操作せず、認証鍵を読み取らない生ADB接続を使う。

未署名APKは `apksigner verify` が署名なしとして拒否した。Androidへそのままインストールすることはできず、署名秘密を使わない今回の範囲では**アプリ起動は未検証**。native `.so` を取り出してロードを検証しても、APK起動やQR／Firebase機能と同じ試験ではない。

### 16KB nativeロード実行結果

同じ未署名APK（SHA-256 `d3c4455d01ec45d762c2bb759477db730325063dc394e8d20a51ecc89adf8133`）から全9本を抽出。NDKで作った小さなprobeを、各ライブラリについて独立プロセスで実行した。guestの `getconf PAGE_SIZE` とprobe自身の `sysconf(_SC_PAGESIZE)` はともに16384、ABI arm64、API35、boot完了を確認した。

**全9本で `dlopen(RTLD_NOW) → dlclose → exit 0` が成功**。旧DataStore 1.1.7とCameraX 1.5.1のRELRO余りが、この環境でのnativeロード・再配置・保護を失敗させるという結果は出なかった。Go／Rust、Crashlytics、image processingも同じ範囲を通過した。probe自身も16KB LOADで作っており、4KBアプリを互換モードで動かした試験ではない。

入力hashと全結果は `work/relro-runtime/inputs.json`、`smoke-report.json`、`smoke.log`、probeソースは `dlopen_smoke.c`。これはSDKのJNI初期化・CameraX実Surface・QR・Firebase・ファイル転送・バックアップの試験を含まない。

さらにDataStore 1.1.7の実装C++ exportsを呼び、正常な一時ファイルでtruncate、共有カウンタmmap、1000回のatomic increment/read、backing fileの値1000、munmap/dlcloseを確認した。page size16384、exit 0。JNIenvを偽装していない。この旧ライブラリのnativeカウンタ経路も成功したため、ガイド式の余りだけでこの経路が壊れるとは言えない。`work/relro-runtime/datastore-counter-report.json` と `datastore-symbol-analysis.txt` に結果・関数解析を保存した。Firebase／Javaから実際にこの経路へ到達する試験は含まない。

試験終了後、この作業が起動したemulatorプロセスだけを終了し、exit 0を確認した。snapshot保存や既存端末の変更は行っていない。

通常workflowからstrict式監査を外し、LOAD／ZIP／manifest／version検査を維持した。CLIの `--strict-relro` は式監査として残し、表示を起動不可の証明と誤解しないようにした。次は別途許可された署名済み候補で、16KB環境のアプリ起動・Go接続・CameraXのQR・DataStore/Firebase経路を実行し、承認されたupload後にPlayの検出結果を確認する。現段階でSDK fork／再ビルドは不要。
