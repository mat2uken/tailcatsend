import van from "vanjs-core";
import type { TransportPath } from "./api/application-api";

export type Language = "ja" | "en";
const LANGUAGE_KEY = "ponlet.language";
function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (saved === "ja" || saved === "en") {
      return saved;
    }
  } catch {
    /* Preferences are optional when storage is unavailable. */
  }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("ja")
    ? "ja"
    : "en";
}
export const language = van.state<Language>(initialLanguage());
export function setLanguage(value: Language): void {
  language.val = value;
  try {
    localStorage.setItem(LANGUAGE_KEY, value);
  } catch {
    /* Keep the runtime choice. */
  }
}

const translations = {
  ja: {
    diagnosticsAwaitingLocal:
      "サーバーには申請を保存済みです。まだ Google に受け付けられていない次のサービスへの申請は、対応する端末内の処理を確認してから進めます:",
    diagnosticsLocalPendingStep: "端末内の処理待ち",
    diagnosticsRetentionCleanupPending:
      "確認期間が終了し、申請記録内の対象 ID を整理しました。端末の専用鍵は整理待ちです。この申請の再送・提供元への状況照会は行いません。受付記録は完全消去の証明ではありません。",
    diagnosticsRetentionCleanupUnknown:
      "確認期間が終了し、申請記録内の対象 ID を整理しました。端末の専用鍵の整理状況は未確認です。この申請の再送・提供元への状況照会は行いません。受付記録は完全消去の証明ではありません。",
    diagnosticsRetentionExpired:
      "確認期間が終了し、この申請の対象 ID と古い削除用の鍵を端末から整理しました。この端末からの再申請・提供元への状況照会はできません。受付記録は残っていますが、完全消去の証明ではありません。",
    diagnosticsPersistenceIncomplete:
      "送信停止の保存が完了していません。保存済み OFF や削除完了は確認できません。状態を再確認してください。",
    diagnosticsOperatorRequired:
      "提供元での処理に問題があり、管理者の対応を待っています。確認済みの受付は保持しています。",
    diagnosticsAdditionalRequired:
      "遅れて届いたデータへの追加申請が必要か、管理者による確認を待っています。削除完了とは確認できません。",
    diagnosticsProviderPending: "提供元での受付処理を待っています",
    diagnosticsProviderPartial:
      "一部のサービスで削除申請を受け付けました。他の処理はまだ確認できていません。削除完了は確認していません。",
    diagnosticsPreviousRequest: "以前の申請",
    diagnosticsTitle: "診断データの削除",
    diagnosticsScope:
      "端末内の未送信データ削除と、送信済みデータの削除申請は別の操作です。どちらも今後の利用状況収集とクラッシュレポートの自動送信を停止します。",
    diagnosticsExclusions:
      "対象はこのインストールの Analytics と Crashlytics です。送信済みデータの自動申請は削除用 ID が設定されていた期間だけが対象です。古いバージョン・再インストール前・他端末のデータ、ML Kit の診断情報、BigQuery 等へのエクスポートコピーは対象外です。転送ファイル、メッセージ、招待鍵は変更しません。",
    diagnosticsRetention:
      "再試行と状況確認のため、最小限の申請情報と削除用の鍵を端末に保持します。サーバーの保持方針・必要設定が未確定の場合、送信済み削除の申請は利用できません。",
    diagnosticsUnavailable:
      "送信済みデータの自動削除申請は、この環境では未対応または準備が完了していません。端末内の操作は、利用可能な場合だけ有効になります。",
    diagnosticsLocalAction: "この端末の未送信データを削除",
    diagnosticsRemoteAction: "送信済み診断データの削除を申請",
    diagnosticsConfirmTitle: "停止して削除を進めますか？",
    diagnosticsConfirmLocal:
      "今後の送信を停止し、端末内の Analytics データのリセットと未送信クラッシュレポートの削除を依頼します。Crashlytics は次回起動で続行する場合があります。Google に送信済みのデータは削除されません。必要な旧識別情報は先に保存しますが、古いデータの後日の申請ができなくなる場合があります。",
    diagnosticsConfirmRemote:
      "このインストールの対応するデータについて、Google Analytics と Firebase Crashlytics に削除を依頼します。削除用の識別子と申請情報を Ponlet の Cloudflare サーバーに送ります。今後の送信を停止し、端末内の対象データの削除も進めます。Google の受付は削除完了の確認ではありません。",
    diagnosticsConfirm: "停止して削除を進める",
    diagnosticsRefresh: "状況を確認",
    diagnosticsContinue: "端末内の処理を再確認",
    diagnosticsError:
      "状況の取得または処理に失敗しました。確認済みの受付情報は保持しています。状況を再確認してください。",
    diagnosticsNotLoaded: "状況は未確認です。",
    diagnosticsIdle: "削除申請はありません。",
    diagnosticsRequestId: "申請番号",
    diagnosticsStopped:
      "この申請時に送信を OFF として保存しました。現在の設定は上のスイッチで確認できます。クラッシュの自動送信停止は次回起動から反映される場合があります。",
    diagnosticsSnapshotPending:
      "送信を停止し、必要な旧識別情報の保存を待っています。リセットはまだ実行していません。",
    diagnosticsLocalPending: "端末に処理を保存しました。サーバーの受付はまだ確認できていません。",
    diagnosticsRestart: "未送信クラッシュの削除と自動送信停止は、次回のアプリ起動時に続行します。",
    diagnosticsRetryWait: "再試行を待っています。確認済みの受付情報は保持しています。",
    diagnosticsServerAccepted: "Ponlet サーバーで削除申請を受け付けました。",
    diagnosticsServerUnconfirmed: "Ponlet サーバーの受付は未確認です。",
    diagnosticsProviderSubmitted:
      "Google に削除を依頼しました。削除完了はこの画面では確認できません。",
    diagnosticsProviderAccepted: "削除申請を受付済み（完了未確認）",
    diagnosticsProviderUnconfirmed: "削除申請の受付は未確認",
    diagnosticsPartial:
      "一部の処理が保留または失敗しています。サービス別の受付状況と再起動待ちを確認してください。",
    diagnosticsBlocked: "処理に問題が起きています。保存済みの申請は取り消されていません。",
    diagnosticsNoCompletion:
      "サーバー受付、Google 受付、端末内の処理は別々の状態です。Google の目標時刻を過ぎても削除完了とは表示しません。",
    diagnosticsResetRequested: "端末内リセットを要求済み",
    diagnosticsDeleteQueued: "未送信レポートの削除をキューに追加済み",
    diagnosticsNoReports: "検査時に未送信レポートなし",
    diagnosticsLocalUnavailable: "この環境では利用不可",
    diagnosticsLocalFailed: "処理に失敗",
    diagnosticsLocalUnconfirmed: "端末内の処理は未確認",
    languageLabel: "表示言語",
    pasteJoin: "貼り付けて接続",
    paste: "貼り付け",
    clearDraft: "入力をクリア",
    clearHistory: "履歴をクリア",
    historyCleared: "履歴をクリアしました",
    expires: "有効期限",
    expired: "期限切れです。招待を再生成してください。",
    regenerate: "再生成",
    sending: "送信中…",
    receiving: "受信中…",
    sent: "送信完了",
    received: "受信完了",
    cancelled: "転送をキャンセルしました",
    failed: "転送に失敗しました",
    dismiss: "閉じる",
    retry: "再試行",
    privacy: "プライバシーポリシー",
    licenses: "OSSライセンス",
    downloads: "受信フォルダを開く",
    clipboardUnavailable: "クリップボードを読み取れません。入力欄へ貼り付けてください。",
    scannerStarting: "カメラを準備しています…",
    scannerReady: "相手のQRコードを枠内に映してください",
    telemetryUnavailable: "この環境では利用状況データの送信を利用できません。",
    telemetryDescription:
      "テレメトリは既定で有効です。OFFにしても転送の通信は行われます。OFF にしても送信済みデータは削除されません。Android のクラッシュレポートの自動送信停止は次回起動から反映される場合があり、端末内のレポート保存は続く場合があります。AndroidのQR読取に伴う診断送信は、この設定の対象外です。",
    transportObserved: "この端末で確認した経路",
    transportUnknown: "経路を確認中…",
    transportHint: "この端末が最後に確認した経路です。相手側と異なることがあります。",
    connectionDetails: "接続情報",
    showQr: "QRを表示",
    joinPeer: "相手に接続",
    workspaceTabs: "接続後の操作",
    chatActions: "チャットの操作",
    messageActions: "メッセージの操作",

    app: "Ponlet",
    cancel: "キャンセル",
    send: "送信",
    chooseFile: "ファイルを選択",
    copy: "コピー",
    share: "共有",
    save: "保存",
    copyPath: "保存先をコピー",
    openFile: "開く",
    receivedFiles: "受信ファイル",
    scan: "カメラで読取",
    scanUnavailable: "カメラを利用できません。招待URLを貼り付けて接続してください。",
    qrLabel: "招待QRコード",
    invitation: "招待URLを貼り付け…",
    connect: "接続",
    createInvite: "招待を作成",
    disconnect: "切断",
    settings: "設定",
    close: "閉じる",
    settingsDescription: "表示言語と利用状況データの送信を設定できます。",
    message: "メッセージ…",
    transfer: "転送",
    messages: "メッセージ",
    preparing: "安全なP2P通信を準備中…",
    ready: "接続待機中",
    connected: "接続済み",
    waiting: "相手を待機中",
    pendingShares: "送信待ち",
    pendingSharesHint: "接続すると次の項目を順番に自動送信します",
    pendingText: "テキスト",
    pendingFile: "ファイル",
    peer: "相手",
    saved: "招待URLをコピー",
    copiedPath: "保存先をコピーしました",
    copiedMessage: "メッセージをコピーしました",
    copiedInvite: "招待URLをコピーしました",
    noMessages: "メッセージはありません",
    noMessagesHint: "接続すると相手とリアルタイムにメッセージをやり取りできます",
    noReceivedFiles: "受信ファイルはありません",
    noReceivedFilesHint: "相手から送信されたファイルがここに表示されます",
    footer: "P2P transfer · end-to-end encrypted",
    allowTelemetry: "テレメトリを許可",
    statusAriaLabel: "接続状態",
    messageLogAriaLabel: "メッセージ履歴",
    transferProgressAriaLabel: "転送進捗",
    fileInputAriaLabel: "送信ファイル",
    messageInputAriaLabel: "メッセージ入力",
    joinInputAriaLabel: "招待URL",
  },
  en: {
    diagnosticsAwaitingLocal:
      "The request is saved on the server. Submission to the following Google services is waiting for confirmation of their local processing:",
    diagnosticsLocalPendingStep: "local processing pending",
    diagnosticsRetentionCleanupPending:
      "The status-check period ended and target IDs were removed from the request record. Device key cleanup is pending. This request will not be resubmitted or queried at the provider. Acceptance records are not proof of complete erasure.",
    diagnosticsRetentionCleanupUnknown:
      "The status-check period ended and target IDs were removed from the request record. Device key cleanup is unconfirmed. This request will not be resubmitted or queried at the provider. Acceptance records are not proof of complete erasure.",
    diagnosticsRetentionExpired:
      "The status-check period ended. This request’s target IDs and old deletion key were removed from this device. It can no longer resubmit this request or query the provider. Acceptance records remain; this is not proof of complete erasure.",
    diagnosticsPersistenceIncomplete:
      "Saving the sending-stop preference is incomplete. Persisted OFF and deletion completion are unconfirmed. Check the status again.",
    diagnosticsOperatorRequired:
      "Provider processing needs operator attention. Previously confirmed acceptance is retained.",
    diagnosticsAdditionalRequired:
      "Operator verification is required for an additional request covering late-arriving data. Deletion completion is unconfirmed.",
    diagnosticsProviderPending: "waiting for provider acceptance",
    diagnosticsProviderPartial:
      "Some services accepted the deletion request. Other processing is still unconfirmed. Deletion completion is unconfirmed.",
    diagnosticsPreviousRequest: "Previous request",
    diagnosticsTitle: "Delete diagnostic data",
    diagnosticsScope:
      "Deleting unsent data on this device and requesting deletion of sent data are separate actions. Both stop future usage collection and automatic crash reporting.",
    diagnosticsExclusions:
      "This covers Analytics and Crashlytics for this installation. Automatic requests for sent data cover only the period with a deletion ID assigned. Legacy versions, earlier installations, other devices, ML Kit diagnostics, and exported copies such as BigQuery are excluded. Transfer files, messages and invitation keys are unchanged.",
    diagnosticsRetention:
      "The device retains minimal request information and deletion keys for retries and status checks. Remote deletion requests remain unavailable until the server retention policy and required configuration are set.",
    diagnosticsUnavailable:
      "Automatic deletion requests for sent data are unsupported or not ready in this environment. Local actions are enabled only when available.",
    diagnosticsLocalAction: "Delete unsent data on this device",
    diagnosticsRemoteAction: "Request deletion of sent diagnostic data",
    diagnosticsConfirmTitle: "Stop collection and proceed?",
    diagnosticsConfirmLocal:
      "This stops future sending, requests a reset of local Analytics data, and queues deletion of unsent crash reports. Crashlytics may continue on the next app launch. This does not delete data already sent to Google. Required old identifiers are saved first, but requesting deletion of some legacy data later may no longer be possible.",
    diagnosticsConfirmRemote:
      "Request deletion of this installation’s covered data from Google Analytics and Firebase Crashlytics. Deletion identifiers and request information are sent to Ponlet’s Cloudflare server. Future sending stops and local deletion is also requested. Google acceptance does not confirm completed deletion.",
    diagnosticsConfirm: "Stop and proceed with deletion",
    diagnosticsRefresh: "Refresh status",
    diagnosticsContinue: "Check local continuation",
    diagnosticsError:
      "The status check or operation failed. Previously confirmed receipts are retained. Refresh the status to check again.",
    diagnosticsNotLoaded: "Status has not been checked.",
    diagnosticsIdle: "No deletion request.",
    diagnosticsRequestId: "Request ID",
    diagnosticsStopped:
      "Sending was saved as OFF for this request. The switch above shows the current setting. Disabling automatic crash reporting may take effect on the next app launch.",
    diagnosticsSnapshotPending:
      "Sending is being stopped while required old identifiers are saved. Reset has not yet run.",
    diagnosticsLocalPending:
      "The operation is saved on the device. Server acceptance has not yet been confirmed.",
    diagnosticsRestart:
      "Unsent crash deletion and disabling automatic crash reporting will continue on the next app launch.",
    diagnosticsRetryWait: "Waiting to retry. Previously confirmed receipts are retained.",
    diagnosticsServerAccepted: "Ponlet’s server accepted the deletion request.",
    diagnosticsServerUnconfirmed: "Ponlet server acceptance is unconfirmed.",
    diagnosticsProviderSubmitted:
      "Deletion has been requested from Google. This screen cannot confirm completed deletion.",
    diagnosticsProviderAccepted: "deletion request accepted (completion unconfirmed)",
    diagnosticsProviderUnconfirmed: "deletion request acceptance unconfirmed",
    diagnosticsPartial:
      "Some operations are pending or failed. Check each service’s acceptance and any restart requirement.",
    diagnosticsBlocked: "Processing is blocked. The saved request has not been cancelled.",
    diagnosticsNoCompletion:
      "Server acceptance, Google acceptance and local processing are separate states. Passing a Google target time does not confirm completed deletion.",
    diagnosticsResetRequested: "local reset requested",
    diagnosticsDeleteQueued: "unsent report deletion queued",
    diagnosticsNoReports: "no unsent reports observed at check",
    diagnosticsLocalUnavailable: "unavailable in this environment",
    diagnosticsLocalFailed: "operation failed",
    diagnosticsLocalUnconfirmed: "local operation unconfirmed",
    languageLabel: "Language",
    pasteJoin: "Paste & connect",
    paste: "Paste",
    clearDraft: "Clear input",
    clearHistory: "Clear history",
    historyCleared: "History cleared",
    expires: "Valid for",
    expired: "Invitation expired. Create a new invite.",
    regenerate: "Regenerate",
    sending: "Sending…",
    receiving: "Receiving…",
    sent: "Sent successfully",
    received: "Received successfully",
    cancelled: "Transfer cancelled",
    failed: "Transfer failed",
    dismiss: "Dismiss",
    retry: "Retry",
    privacy: "Privacy Policy",
    licenses: "OSS Licenses",
    downloads: "Open received folder",
    clipboardUnavailable: "Clipboard cannot be read. Paste into the input field.",
    scannerStarting: "Starting camera…",
    scannerReady: "Place the peer’s QR code inside the frame",
    telemetryUnavailable: "Usage data collection is unavailable in this environment.",
    telemetryDescription:
      "Telemetry is enabled by default. Turning it off does not stop peer-transfer networking. Turning it off does not delete sent data. Disabling Android automatic crash reporting may take effect on the next app launch, and reports may still be saved locally. Diagnostics associated with QR scanning on Android are not disabled by this setting.",
    transportObserved: "Path observed on this device",
    transportUnknown: "Checking path…",
    transportHint: "This is the last path observed by this device; the peer may show another path.",
    connectionDetails: "Connection details",
    showQr: "Show QR",
    joinPeer: "Join a peer",
    workspaceTabs: "Connected actions",
    chatActions: "Chat actions",
    messageActions: "Message actions",

    app: "Ponlet",
    cancel: "Cancel",
    send: "Send",
    chooseFile: "Choose file",
    copy: "Copy",
    share: "Share",
    save: "Save",
    copyPath: "Copy save location",
    openFile: "Open",
    receivedFiles: "Received files",
    scan: "Scan with camera",
    scanUnavailable: "Camera access is unavailable. Paste the invitation URL to connect.",
    qrLabel: "Invitation QR code",
    invitation: "Paste invitation URL…",
    connect: "Connect",
    createInvite: "Create invite",
    disconnect: "Disconnect",
    settings: "Settings",
    close: "Close",
    settingsDescription: "Choose a display language and whether to send usage data.",
    message: "Message…",
    transfer: "Transfer",
    messages: "Messages",
    preparing: "Preparing secure P2P network…",
    ready: "Ready to connect",
    connected: "Connected",
    waiting: "Waiting for peer",
    pendingShares: "Waiting to send",
    pendingSharesHint: "These items will be sent automatically in order when connected.",
    pendingText: "Text",
    pendingFile: "File",
    peer: "Peer",
    saved: "Copy invitation",
    copiedPath: "Save location copied",
    copiedMessage: "Message copied",
    copiedInvite: "Invitation copied",
    noMessages: "No messages yet",
    noMessagesHint: "Messages will appear here once connected to a peer.",
    noReceivedFiles: "No received files",
    noReceivedFilesHint: "Files sent by your peer will appear here.",
    footer: "P2P transfer · end-to-end encrypted",
    allowTelemetry: "Allow telemetry",
    statusAriaLabel: "Connection status",
    messageLogAriaLabel: "Message history",
    transferProgressAriaLabel: "Transfer progress",
    fileInputAriaLabel: "Files to send",
    messageInputAriaLabel: "Message input",
    joinInputAriaLabel: "Invitation URL",
  },
};
export const uiText = new Proxy(translations.en, {
  get(_target, key: string) {
    return translations[language.val][key as keyof typeof translations.en];
  },
});

export function transportLabel(path: TransportPath): string {
  if (path === "direct-udp") {
    return "WireGuard UDP";
  }
  if (path === "webrtc") {
    return "WebRTC DataChannel";
  }
  if (path === "derp") {
    return language.val === "ja" ? "DERPリレー" : "DERP relay";
  }
  return uiText.transportUnknown;
}
