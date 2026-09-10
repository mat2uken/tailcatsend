/** Metadata and operations shared by browser and native adapters. */
export const APPLICATION_API_VERSION = 1 as const;

export type SessionState = "booting" | "awaiting-peer" | "connected" | "transferring" | "error";

export interface BackendSnapshot {
  apiVersion: number;
  canDisconnect: boolean;
  canSend: boolean;
  error: string | null;
  inviteExpiresInSecs: number;
  inviteUrl: string | null;
  peerName: string;
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
}

export type BackendEvent =
  | { sequence: number; type: "snapshot"; snapshot: BackendSnapshot }
  | { sequence: number; type: "progress"; id: string; done: number; total: number }
  | { sequence: number; type: "text"; text: string; incoming: boolean }
  | {
      sequence: number;
      type: "terminal";
      id: string;
      status: "completed" | "cancelled" | "failed";
      message?: string;
    };

export interface PonletBackend {
  cancelTransfer(id: string): Promise<void>;
  copyText(text: string): Promise<void>;
  createInvite(): Promise<void>;
  disconnect(): Promise<void>;
  dispose(): Promise<void>;
  join(invite: string): Promise<void>;
  saveText(text: string): Promise<void>;
  sendFiles(files: Array<File>): Promise<void>;
  sendText(text: string): Promise<void>;
  shareText(text: string): Promise<void>;
  snapshot(): Promise<BackendSnapshot>;
  subscribe(listener: (event: BackendEvent) => void): () => void;
}

export function initialSnapshot(): BackendSnapshot {
  return {
    apiVersion: 1,
    sequence: 0,
    state: "booting",
    peerName: "",
    inviteUrl: null,
    inviteExpiresInSecs: 0,
    canSend: false,
    canDisconnect: false,
    transfer: null,
    error: null,
  };
}
