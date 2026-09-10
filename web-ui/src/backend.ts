import { initialSnapshot } from "./api/application-api";
import type { PonletBackend } from "./api/application-api";
import { validateSnapshot } from "./api/validation";
export type {
  BackendEvent,
  BackendSnapshot,
  PonletBackend,
  SessionState,
} from "./api/application-api";

export type NativeBridge = Partial<PonletBackend>;

declare global {
  interface Window {
    __ponletBackend?: NativeBridge;
  }
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
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "ponlet-message.txt";
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Let the browser start the download before releasing the URL.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function unavailableBackend(): PonletBackend {
  const message = navigator.language.toLowerCase().startsWith("ja")
    ? "通信処理が未接続です。この移行用UIでは送受信できません。"
    : "The transfer backend is unavailable. This migration UI cannot send or receive.";
  const unavailable = async (): Promise<never> => {
    throw new Error(message);
  };
  return {
    snapshot: async () => ({ ...initialSnapshot(), state: "error", error: message }),
    subscribe: () => () => undefined,
    createInvite: unavailable,
    join: unavailable,
    sendText: unavailable,
    sendFiles: unavailable,
    cancelTransfer: unavailable,
    disconnect: unavailable,
    copyText,
    shareText,
    saveText,
    dispose: async () => undefined,
  };
}

/** The shell supplies an initialized adapter. Missing adapters never simulate
 * connection or delivery. Prototype methods retain their original receiver. */
export function createBackend(
  bridge: NativeBridge | undefined = window.__ponletBackend,
): PonletBackend {
  if (!bridge) {
    return unavailableBackend();
  }
  const required = [
    "snapshot",
    "subscribe",
    "createInvite",
    "join",
    "sendText",
    "sendFiles",
    "cancelTransfer",
    "disconnect",
    "dispose",
  ] as const;
  if (required.some((method) => typeof bridge[method] !== "function")) {
    return unavailableBackend();
  }
  const native = bridge as PonletBackend;
  return {
    snapshot: async () => validateSnapshot(await native.snapshot()),
    subscribe: (listener) => {
      const unsubscribe = native.subscribe(listener);
      if (typeof unsubscribe !== "function") {
        throw new Error("Backend subscription has no cleanup");
      }
      return unsubscribe;
    },
    createInvite: () => native.createInvite(),
    join: (invite) => native.join(invite),
    sendText: (text) => native.sendText(text),
    sendFiles: (files) => native.sendFiles(files),
    cancelTransfer: (id) => native.cancelTransfer(id),
    disconnect: () => native.disconnect(),
    copyText: (text) => (native.copyText ? native.copyText(text) : copyText(text)),
    shareText: (text) => (native.shareText ? native.shareText(text) : shareText(text)),
    saveText: (text) => (native.saveText ? native.saveText(text) : saveText(text)),
    dispose: () => native.dispose(),
  };
}
