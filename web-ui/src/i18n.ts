import type { TransportPath } from "./api/application-api";

export const isJapanese =
  typeof navigator !== "undefined" && Boolean(navigator.language?.toLowerCase().startsWith("ja"));

export const uiText = isJapanese
  ? {
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
      scanUnavailable: "このWebViewではカメラQR読取を利用できません。URLを貼り付けてください。",
      qrLabel: "招待QRコード",
      invitation: "招待URLを貼り付け…",
      connect: "接続",
      createInvite: "招待を作成",
      disconnect: "切断",
      settings: "設定",
      close: "閉じる",
      settingsDescription:
        "通信経路と保存先は接続されたbackendが管理します。テレメトリ設定はこの端末に保存されます。",
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
    }
  : {
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
      scanUnavailable: "Camera QR scanning is unavailable in this WebView. Paste the URL instead.",
      qrLabel: "Invitation QR code",
      invitation: "Paste invitation URL…",
      connect: "Connect",
      createInvite: "Create invite",
      disconnect: "Disconnect",
      settings: "Settings",
      close: "Close",
      settingsDescription:
        "The backend controls transport and storage. Telemetry preference is stored on this device.",
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
    };

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
