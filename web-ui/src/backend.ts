import { initialSnapshot } from "./api/application-api";
import type { PonletBackend, ReceivedItem } from "./api/application-api";
import { validateSnapshot } from "./api/validation";
import { downloadOpfsItem } from "./opfs";
import { getTelemetryEnabled, setTelemetryEnabled, telemetryObserver, textSent } from "./telemetry";
export type {
  BackendEvent,
  BackendSnapshot,
  PonletBackend,
  ReceivedItem,
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

async function openReceivedItem(item: ReceivedItem): Promise<void> {
  await downloadOpfsItem(item.localPathOrHandle, item.name);
}

function unavailableBackend(): PonletBackend {
  const message = navigator.language.toLowerCase().startsWith("ja")
    ? "通信処理を開始できませんでした。再試行してください。"
    : "The connection service is unavailable. Please retry.";
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
    qrCode: unavailable,
    openReceivedItem: unavailable,
    readClipboard: async () => navigator.clipboard.readText(),
    getTelemetryEnabled,
    setTelemetryEnabled,
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
    "qrCode",
  ] as const;
  if (required.some((method) => typeof bridge[method] !== "function")) {
    return unavailableBackend();
  }
  const native = bridge as PonletBackend;
  const observe = telemetryObserver();
  return {
    snapshot: async () => validateSnapshot(await native.snapshot()),
    subscribe: (listener) => {
      const unsubscribe = native.subscribe((event) => {
        observe(event);
        listener(event);
      });
      if (typeof unsubscribe !== "function") {
        throw new Error("Backend subscription has no cleanup");
      }
      return unsubscribe;
    },
    createInvite: () => native.createInvite(),
    join: (invite) => native.join(invite),
    sendText: async (text) => {
      await native.sendText(text);
      textSent(text);
    },
    sendFiles: (files) => native.sendFiles(files),
    cancelTransfer: (id) => native.cancelTransfer(id),
    disconnect: () => native.disconnect(),
    openReceivedItem: native.openReceivedItem
      ? (item) => native.openReceivedItem!(item)
      : openReceivedItem,
    readClipboard: () =>
      native.readClipboard ? native.readClipboard() : navigator.clipboard.readText(),
    getTelemetryEnabled: () =>
      native.getTelemetryEnabled ? native.getTelemetryEnabled() : getTelemetryEnabled(),
    setTelemetryEnabled: (enabled) =>
      native.setTelemetryEnabled
        ? native.setTelemetryEnabled(enabled)
        : setTelemetryEnabled(enabled),
    openExternal: async (url) => {
      if (native.openExternal) {
        await native.openExternal(url);
        return;
      }
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        throw new Error("Unsupported external URL");
      }
      window.open(parsed.href, "_blank", "noopener,noreferrer");
    },
    ...(native.openDownloads ? { openDownloads: () => native.openDownloads!() } : {}),
    ...(native.scanQr ? { scanQr: () => native.scanQr!() } : {}),
    ...(native.cancelScan ? { cancelScan: () => native.cancelScan!() } : {}),
    copyText: (text) => (native.copyText ? native.copyText(text) : copyText(text)),
    shareText: (text) => (native.shareText ? native.shareText(text) : shareText(text)),
    saveText: (text) => (native.saveText ? native.saveText(text) : saveText(text)),
    dispose: () => native.dispose(),
    ...(native.pickAndSendFiles ? { pickAndSendFiles: () => native.pickAndSendFiles!() } : {}),
    qrCode: (url) => native.qrCode!(url),
  };
}
