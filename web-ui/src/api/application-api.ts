/** Metadata and operations shared by browser and native adapters. */
export const APPLICATION_API_VERSION = 2 as const;

export type SessionState =
  | "ready"
  | "booting"
  | "awaiting-peer"
  | "connected"
  | "transferring"
  | "error";

export type TransportPath = "direct-udp" | "webrtc" | "derp" | "unknown";

export interface ReceivedItem {
  localPathOrHandle: string;
  name: string;
  size: number;
}

export interface QrBitmap {
  height: number;
  rgbaPixels: Uint8Array;
  width: number;
}

export interface BackendSnapshot {
  apiVersion: number;
  canDisconnect: boolean;
  canSend: boolean;
  error: string | null;
  inviteExpiresInSecs: number;
  inviteUrl: string | null;
  lastTransfer?: (NonNullable<BackendSnapshot["transfer"]> & { message?: string | null }) | null;
  peerName: string;
  received: Array<ReceivedItem>;
  receivedMessages?: Array<{ sequence: number; text: string }>;
  sequence: number;
  state: SessionState;
  transfer: {
    id: string;
    name: string;
    done: number;
    total: number;
    incoming: boolean;
    status: string;
  } | null;
  /** Last path observed by this app's endpoint; the peer can observe another path. */
  transport: TransportPath;
}

export type BackendEvent =
  | { sequence: number; type: "snapshot"; snapshot: BackendSnapshot }
  | { sequence: number; type: "progress"; id: string; done: number; total: number }
  | { sequence: number; type: "text"; text: string; incoming: boolean }
  | { sequence: number; type: "files"; items: Array<ReceivedItem> }
  | {
      sequence: number;
      type: "terminal";
      id: string;
      status: "completed" | "cancelled" | "failed";
      message?: string;
    };

export interface PonletBackend {
  cancelScan?: () => Promise<void>;
  cancelTransfer(id: string): Promise<void>;
  copyText(text: string): Promise<void>;
  createInvite(): Promise<void>;
  disconnect(): Promise<void>;
  dispose(): Promise<void>;
  getTelemetryEnabled?: () => Promise<boolean>;
  join(invite: string): Promise<void>;
  /** Desktop receive folder and public information links. */
  openDownloads?: () => Promise<void>;
  openExternal?: (url: string) => Promise<void>;
  /** Open a received file without copying its bytes through the UI. */
  openReceivedItem(item: ReceivedItem): Promise<void>;
  /** Open the native picker and start a transfer without exposing file bytes to JS. */
  pickAndSendFiles?: () => Promise<void>;
  /** Render an invitation without adding a JavaScript QR dependency. */
  qrCode: (url: string) => Promise<QrBitmap>;
  /** Read text only after an explicit paste action. */
  readClipboard?: () => Promise<string>;
  saveText(text: string): Promise<void>;
  /** Native mobile camera scanner; cancellation returns null. */
  scanQr?: () => Promise<string | null>;
  sendFiles(files: Array<File>): Promise<void>;
  sendText(text: string): Promise<void>;
  setTelemetryEnabled?: (enabled: boolean) => Promise<void>;
  shareText(text: string): Promise<void>;
  snapshot(): Promise<BackendSnapshot>;
  subscribe(listener: (event: BackendEvent) => void): () => void;
}

export function initialSnapshot(): BackendSnapshot {
  return {
    apiVersion: APPLICATION_API_VERSION,
    sequence: 0,
    state: "booting",
    transport: "unknown",
    peerName: "",
    inviteUrl: null,
    inviteExpiresInSecs: 0,
    canSend: false,
    canDisconnect: false,
    transfer: null,
    received: [],
    error: null,
  };
}
