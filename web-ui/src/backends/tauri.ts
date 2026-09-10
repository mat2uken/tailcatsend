import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  BackendEvent,
  BackendSnapshot,
  PonletBackend,
  QrBitmap,
  ReceivedItem,
} from "../api/application-api";
import { validateSnapshot } from "../api/validation";

type TauriFile = File & { path?: string };

interface NativeFileRequest {
  mime: string | null;
  name: string;
  path: string;
  size: number;
}

async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard is unavailable");
  }
  await navigator.clipboard.writeText(text);
}

async function shareText(text: string): Promise<void> {
  if (navigator.share) {
    await navigator.share({ text });
  } else {
    await copyText(text);
  }
}

async function saveText(text: string): Promise<void> {
  await invoke("ponlet_save_text", { text });
}

function toFileRequest(file: File): NativeFileRequest {
  const path = (file as TauriFile).path;
  if (!path) {
    throw new Error(
      "The native file path is unavailable. Use the platform file picker before sending.",
    );
  }
  return {
    name: file.name,
    size: file.size,
    mime: file.type || null,
    path,
  };
}

/** Tauri adapter for the shared Rust service. Payloads contain metadata only. */
export function createBackend(): PonletBackend {
  let disposed = false;
  return {
    snapshot: async (): Promise<BackendSnapshot> =>
      validateSnapshot(await invoke<BackendSnapshot>("ponlet_snapshot")),
    subscribe: (listener) => {
      let active = true;
      let unlisten: (() => void) | undefined;
      void listen<BackendEvent>("ponlet:event", (event) => {
        if (active) {
          listener(event.payload);
        }
      }).then((cleanup) => {
        if (active) {
          unlisten = cleanup;
        } else {
          cleanup();
        }
      });
      return () => {
        active = false;
        unlisten?.();
      };
    },
    createInvite: () => invoke("ponlet_create_invite"),
    join: (invite) => invoke("ponlet_join", { invite }),
    sendText: (text) => invoke("ponlet_send_text", { text }),
    sendFiles: (files) => invoke("ponlet_send_files", { files: files.map(toFileRequest) }),
    pickAndSendFiles: () => invoke("ponlet_pick_and_send_files"),
    qrCode: (url): Promise<QrBitmap> => invoke("ponlet_qr_code", { url }),
    cancelTransfer: (id) => invoke("ponlet_cancel_transfer", { id }),
    disconnect: () => invoke("ponlet_disconnect"),
    openReceivedItem: (item: ReceivedItem) =>
      invoke("ponlet_open_received", { localPathOrHandle: item.localPathOrHandle }),
    copyText,
    shareText,
    saveText,
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      await invoke("ponlet_disconnect");
    },
  };
}

export type { BackendEvent, BackendSnapshot, PonletBackend } from "../api/application-api";

/** Tauri bundles the Rust service in the application; no browser bootstrap is needed. */
export function initializeBrowserBackend(): Promise<void> {
  return Promise.resolve();
}
