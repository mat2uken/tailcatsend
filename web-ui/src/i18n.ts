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
export let isJapanese = language.val === "ja";
export function setLanguage(value: Language): void {
  isJapanese = value === "ja";
  language.val = value;
  try {
    localStorage.setItem(LANGUAGE_KEY, value);
  } catch {
    /* Keep the runtime choice. */
  }
}

const translations = {
  ja: {
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
    return isJapanese ? "WireGuard UDP" : "WireGuard UDP";
  }
  if (path === "webrtc") {
    return isJapanese ? "WebRTC DataChannel" : "WebRTC DataChannel";
  }
  if (path === "derp") {
    return "DERP relay";
  }
  return "";
}
