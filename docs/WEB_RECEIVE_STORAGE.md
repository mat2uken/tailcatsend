# Web の受信保存とブラウザ互換性

Web の受信は共通 Rust 転送処理から Dedicated Worker の保存処理を呼ぶ。UI に渡すのは完了したファイルの名前、サイズ、保存先を示す文字列だけで、ファイル全体の byte 配列を UI へ送らない。

## 保存方式の選択

`prepareReceivedFile` は、最初の受信 byte を受け取る前に OPFS の一時ファイルと writer を準備する。OPFS が使える場合は従来どおり逐次保存する。`createWritable` が未提供または `NotSupportedError` なら Worker で利用できる `createSyncAccessHandle` を使う。

`getDirectory`、一時ファイル作成、writer の準備が失敗した場合は、作成済み writer の abort と一時ファイルの削除を試みてから、Worker 内の Blob 保存に切り替える。ブラウザにより private context の OPFS が `UnknownError` を返す場合もこの経路を通る。受信途中の write、close、move、copy の失敗から保存方式を切り替えることはない。受信済み byte の欠損や容量不足を成功として扱わず、転送エラーと部分ファイルの後始末を行う。

Blob 保存では各チャンクを Blob にして保持し、呼び出し元が後で入力バッファを再利用しても内容が変わらないようにする。共通 Rust 転送処理の予定サイズ検査後、Worker でも書き込み byte 数を確認して完了させる。取消と失敗では保持中のチャンクを破棄する。

この代替保存は旧 Slint Web と同じくファイル全体を保持する方式であり、OPFS のようにメモリ使用量を小さく抑えられない。大きなファイルや多数の完了ファイルはブラウザのメモリ制限を受ける。永続保存でもないため、必要なファイルはページを閉じる前にダウンロードする。

## 同名ファイルとダウンロード URL

OPFS の保存先名の選択と move/copy は、同一 origin の Ponlet タブと Worker で共通の Web Lock の中で行う。既存のファイルやディレクトリ名は上書きせず、`name (1).ext` のような別名を選ぶ。Web Locks が使えない場合、OPFS の commit は失敗として扱う。

Blob 保存では完了ごとに別の Blob URL を作り、同じ Worker 内の同名受信には連番を付ける。タブ間でも各 Blob URL が別の内容を保持し、既存の OPFS ファイルを書き換えない。UI はこの URL を直接ダウンロードリンクに使う。

完了した Worker の Blob URL は、通常の切断、再接続、再ダウンロードでは revoke しない。backend の dispose は未完了の保存を abort してから全 URL を明示的に revoke する。dispose 中に準備や書き込みが遅れて完了しても、新たな受信完了を返さない。Worker 終了時の自動 revoke だけには依存しない。OPFS からダウンロードする際に UI が作成した一時 URL は、そのダウンロード後に UI が revoke する。

## WebKit の move 呼び出し

WebKit の `FileSystemHandle.idl` は `move(FileSystemHandle destination, USVString newName)` を定義し、実装は保存先がディレクトリでなければ `TypeMismatchError` を返す。単一の名前だけを渡す Chromium の overload には依存せず、OPFS の commit は `file.move(directory, name)` を使う。move 自体が未提供または `NotSupportedError` の場合だけ、Web Lock を保持したまま 64 KiB ごとに copy する。`TypeMismatchError` など他の失敗を無条件に copy で隠さない。

一次資料:

- [WebKit FileSystemHandle.idl](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/filesystem/FileSystemHandle.idl)
- [WebKit FileSystemHandle.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/filesystem/FileSystemHandle.cpp)
- [File API: Blob の生成](https://w3c.github.io/FileAPI/#constructorBlob)
- [File API: Blob URL の寿命](https://w3c.github.io/FileAPI/#lifeTime)
- [Web Locks](https://w3c.github.io/web-locks/)
- [File System: FileSystemSyncAccessHandle](https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle)

## 喪失した時点と回帰確認

`988f1a8`（2026-09-10、ブラウザ WASM と VanJS 配信を共通転送へ接続）で導入された `WebFileSink` は OPFS を必須にした。直前の `875dbf1:dist/index.html` の 749–773 行は OPFS 準備の例外時にメモリへ受信し、909–943 行はサイズ検査後に Blob としてダウンロードしていた。この代替経路が移行時に抜けたことで、旧版が受信できた OPFS 不可の環境で受信が失敗するようになった。

回帰テストは `web-ui/tests/worker-storage.test.mjs`、`worker-receive.test.mjs`、`received-download.test.mjs` に置く。OPFS の同名保護、sync writer と bounded copy、準備時だけの代替、途中失敗、取消、破棄後の遅延応答、Blob URL の再利用と revoke、WebKit の引数形式を確認する。これらの unit テストとは別に、Chromium、Firefox、WebKit の実通信とダウンロード結果を、再生成した WASM と UI の同じビルドで確認する必要がある。
