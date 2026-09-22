import { invoke } from "@tauri-apps/api/core";
import type {
  BackendEvent,
  BackendSnapshot,
  PonletBackend,
  QrBitmap,
  ReceivedItem,
  SharedImportSummary,
} from "../api/application-api";
import { validateSnapshot } from "../api/validation";
import {
  BinaryRpcClient,
  Opcode,
  PortBinaryTransport,
  RawBinaryTransport,
  SchemeBinaryTransport,
} from "../ipc";
import { startJsonNotifications } from "./json-notifications";

type TauriFile = File & { path?: string };

interface NativeFileRequest {
  mime: string | null;
  name: string;
  path: string;
  size: number;
}

type BinaryPort = ConstructorParameters<typeof PortBinaryTransport>[0];

let selection: Promise<BinaryRpcClient | undefined> | undefined;
let nativePlatform = "";
let scanGeneration = 0;

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("Ponlet IPC probe timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  }
}

async function copyText(text: string): Promise<void> {
  await invoke("ponlet_copy_text", { text });
}

async function shareText(text: string): Promise<void> {
  await invoke("ponlet_share_text", { text });
}

async function cancelScan(): Promise<void> {
  scanGeneration++;
  await invoke("plugin:barcode-scanner|cancel");
}

async function scanQr(): Promise<string | null> {
  const generation = ++scanGeneration;
  try {
    let permission = await invoke<{ camera: string }>("plugin:barcode-scanner|check_permissions");
    if (generation !== scanGeneration) {
      return null;
    }
    if (permission.camera !== "granted") {
      permission = await invoke<{ camera: string }>("plugin:barcode-scanner|request_permissions");
    }
    // Closing while the OS permission prompt was displayed must not start a camera later.
    if (generation !== scanGeneration) {
      return null;
    }
    if (permission.camera !== "granted") {
      throw new Error("Camera permission is required to scan a QR code");
    }
    const result = await invoke<{ content: string }>("plugin:barcode-scanner|scan", {
      formats: ["QR_CODE"],
      cameraDirection: "back",
      windowed: true,
    });
    return generation === scanGeneration ? result.content : null;
  } catch (error) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : String(error);
    if (generation !== scanGeneration || /cancelled|canceled/i.test(message)) {
      return null;
    }
    throw error;
  } finally {
    if (generation === scanGeneration) {
      scanGeneration++;
      await invoke("plugin:barcode-scanner|cancel").catch(() => undefined);
    }
  }
}

function normalizeQr(value: QrBitmap): QrBitmap {
  const pixels = value.rgbaPixels;
  return {
    width: value.width,
    height: value.height,
    rgbaPixels:
      Object.prototype.toString.call(pixels) === "[object Uint8Array]"
        ? pixels
        : Uint8Array.from(pixels),
  };
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

function injectedPort(): BinaryPort | undefined {
  const global = globalThis as typeof globalThis & {
    ponletbin?: unknown;
  };
  const value = global.ponletbin;
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as BinaryPort).postMessage !== "function"
  ) {
    return undefined;
  }
  return value as BinaryPort;
}

async function probeTransport(transport: RawBinaryTransport): Promise<BinaryRpcClient | undefined> {
  const client = new BinaryRpcClient(transport);
  try {
    validateSnapshot(await withTimeout(client.call<BackendSnapshot>(Opcode.Snapshot), 1500));
    return client;
  } catch {
    client.close();
    return undefined;
  }
}

async function selectTransport(): Promise<BinaryRpcClient | undefined> {
  if (typeof BigInt !== "function") {
    return undefined;
  }
  // Select once at startup. Never replay accepted operations through JSON.
  const port = injectedPort();
  return (
    (port ? await probeTransport(new PortBinaryTransport(port)) : undefined) ??
    (await probeTransport(new SchemeBinaryTransport()))
  );
}

function prepareSelection(): Promise<BinaryRpcClient | undefined> {
  return (selection ??= selectTransport());
}

/** Tauri adapter. Fast binary IPC is selected once; JSON invoke remains the fallback. */
export function createBackend(): PonletBackend {
  const mobile = nativePlatform === "ios" || nativePlatform === "android";
  const listeners = new Set<(event: BackendEvent) => void>();
  let cleanup: (() => void) | undefined;
  let disposed = false;

  const ready = prepareSelection().then((client) => {
    if (disposed) {
      client?.close();
      return client;
    }
    cleanup = client
      ? client.subscribe((event) => {
          for (const listener of listeners) {
            listener(event);
          }
        })
      : startJsonNotifications(invoke, listeners);
    return client;
  });
  const call = async <T>(
    opcode: Opcode,
    command: string,
    payload?: unknown,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    const client = await ready;
    return client ? client.call<T>(opcode, payload) : invoke<T>(command, args);
  };

  return {
    snapshot: async () =>
      validateSnapshot(await call<BackendSnapshot>(Opcode.Snapshot, "ponlet_snapshot")),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    createInvite: () => call(Opcode.CreateInvite, "ponlet_create_invite"),
    join: (invite) => call(Opcode.Join, "ponlet_join", invite, { invite }),
    sendText: (text) => call(Opcode.SendText, "ponlet_send_text", text, { text }),
    sendFiles: (files) => {
      const requests = files.map(toFileRequest);
      return call(Opcode.SendFiles, "ponlet_send_files", requests, { files: requests });
    },
    pickAndSendFiles: () => call(Opcode.PickAndSendFiles, "ponlet_pick_and_send_files"),
    importShared: () => invoke<SharedImportSummary>("ponlet_import_shared"),
    qrCode: async (url) =>
      normalizeQr(await call<QrBitmap>(Opcode.QrCode, "ponlet_qr_code", url, { url })),
    cancelTransfer: (id) => call(Opcode.CancelTransfer, "ponlet_cancel_transfer", id, { id }),
    disconnect: () => call(Opcode.Disconnect, "ponlet_disconnect"),
    openReceivedItem: (item) => {
      const request = { localPathOrHandle: item.localPathOrHandle };
      return call(Opcode.OpenReceived, "ponlet_open_received", request, request);
    },
    copyText,
    shareText,
    readClipboard: () => invoke<string>("ponlet_read_clipboard"),
    ...(mobile
      ? {
          scanQr,
          cancelScan,
          ...(nativePlatform === "ios"
            ? {
                shareReceivedItem: (item: ReceivedItem) =>
                  invoke("ponlet_share_received", {
                    localPathOrHandle: item.localPathOrHandle,
                  }),
              }
            : {}),
        }
      : { openDownloads: () => invoke<void>("ponlet_open_downloads") }),
    openExternal: (url) => invoke("ponlet_open_external", { url }),
    getTelemetryEnabled: () => invoke<boolean>("ponlet_get_telemetry_enabled"),
    setTelemetryEnabled: (enabled) => invoke("ponlet_set_telemetry_enabled", { enabled }),
    saveText: (text) => call(Opcode.SaveText, "ponlet_save_text", text, { text }),
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      cleanup?.();
      listeners.clear();
      if (mobile) {
        await cancelScan().catch(() => undefined);
      }
      const client = await ready;
      if (client) {
        try {
          await client.call(Opcode.Disconnect);
        } catch {
          // The native process may already be exiting. Closing the transport
          // still cancels the notification wait and rejects pending calls.
        } finally {
          client.close();
        }
      } else {
        await invoke("ponlet_disconnect");
      }
      selection = undefined;
    },
  };
}

export type { BackendEvent, BackendSnapshot, PonletBackend } from "../api/application-api";

/** Probe the fast paths before the first snapshot is requested. */
export function initializeBrowserBackend(): Promise<void> {
  let optOut = false;
  try {
    const saved = localStorage.getItem("ponlet.telemetry");
    optOut = saved === "off" || saved === "false";
  } catch {
    // The native preference remains authoritative when WebView storage is unavailable.
  }
  return Promise.all([
    prepareSelection(),
    invoke<string>("ponlet_initialize_platform", {
      optOut,
    }).then((platform) => {
      nativePlatform = platform;
    }),
  ]).then(() => undefined);
}
