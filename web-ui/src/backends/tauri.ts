import { invoke } from "@tauri-apps/api/core";
import type {
  BackendEvent,
  BackendSnapshot,
  PonletBackend,
  QrBitmap,
  ReceivedItem,
} from "../api/application-api";
import { validateSnapshot } from "../api/validation";
import {
  BinaryRpcClient,
  Opcode,
  PortBinaryTransport,
  RawBinaryTransport,
  SchemeBinaryTransport,
} from "../ipc";

type TauriFile = File & { path?: string };

interface NativeFileRequest {
  mime: string | null;
  name: string;
  path: string;
  size: number;
}

interface BinaryPort {
  addEventListener?(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  close?(): void;
  onmessage?: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: ArrayBuffer | Uint8Array): void;
  removeEventListener?(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  start?(): void;
}

type SelectedTransport =
  | { client: BinaryRpcClient; kind: "port" | "scheme"; transport: RawBinaryTransport }
  | { kind: "json" };

let selection: Promise<SelectedTransport> | undefined;

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

async function probePort(): Promise<SelectedTransport | undefined> {
  if (typeof BigInt !== "function") {
    return undefined;
  }
  const port = injectedPort();
  if (!port) {
    return undefined;
  }
  // The Android listener replies to a request on this same ArrayBuffer port.
  // Keeping a single WaitEvent request outstanding gives notifications the
  // same binary path without a second event channel.
  const transport = new PortBinaryTransport(port);
  const client = new BinaryRpcClient(transport);
  try {
    validateSnapshot(await withTimeout(client.call<BackendSnapshot>(Opcode.Snapshot), 1500));
    return { client, kind: "port", transport };
  } catch {
    client.close();
    return undefined;
  }
}

async function probeScheme(): Promise<SelectedTransport | undefined> {
  if (typeof BigInt !== "function") {
    return undefined;
  }
  const transport = new SchemeBinaryTransport();
  const client = new BinaryRpcClient(transport);
  try {
    validateSnapshot(await withTimeout(client.call<BackendSnapshot>(Opcode.Snapshot), 1500));
    return { client, kind: "scheme", transport };
  } catch {
    client.close();
    return undefined;
  }
}

async function selectTransport(): Promise<SelectedTransport> {
  // The injected Android port is preferred, then the binary custom scheme.
  // JSON invoke is selected once at startup and is never used as an automatic
  // retry after an operation has already been accepted by a fast path.
  return (await probePort()) ?? (await probeScheme()) ?? { kind: "json" };
}

function prepareSelection(): Promise<SelectedTransport> {
  selection ??= selectTransport();
  return selection;
}

function createJsonFallback(listeners: Set<(event: BackendEvent) => void>): {
  backend: Omit<PonletBackend, "subscribe">;
  start: () => () => void;
} {
  return {
    backend: {
      snapshot: async () => validateSnapshot(await invoke<BackendSnapshot>("ponlet_snapshot")),
      createInvite: () => invoke("ponlet_create_invite"),
      join: (invite) => invoke("ponlet_join", { invite }),
      sendText: (text) => invoke("ponlet_send_text", { text }),
      sendFiles: (files) => invoke("ponlet_send_files", { files: files.map(toFileRequest) }),
      pickAndSendFiles: () => invoke("ponlet_pick_and_send_files"),
      qrCode: async (url) => normalizeQr(await invoke<QrBitmap>("ponlet_qr_code", { url })),
      cancelTransfer: (id) => invoke("ponlet_cancel_transfer", { id }),
      disconnect: () => invoke("ponlet_disconnect"),
      openReceivedItem: (item: ReceivedItem) =>
        invoke("ponlet_open_received", { localPathOrHandle: item.localPathOrHandle }),
      copyText,
      shareText,
      saveText: (text) => invoke("ponlet_save_text", { text }),
      dispose: () => invoke("ponlet_disconnect"),
    },
    start: () => {
      let active = true;
      let lastSequence = 0;
      const subscriptionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const deliver = (value: BackendEvent | Array<BackendEvent>): void => {
        const events = Array.isArray(value) ? value : [value];
        for (const event of events) {
          if (event.sequence <= lastSequence) {
            continue;
          }
          lastSequence = event.sequence;
          for (const listener of listeners) {
            listener(event);
          }
        }
      };
      const wait = async (): Promise<void> => {
        const snapshot = await invoke<BackendSnapshot>("ponlet_subscribe", {
          subscriptionId,
        });
        if (!active) {
          void invoke("ponlet_unsubscribe", { subscriptionId }).catch(() => undefined);
          return;
        }
        lastSequence = snapshot.sequence;
        const initial: BackendEvent = { type: "snapshot", sequence: snapshot.sequence, snapshot };
        for (const listener of listeners) {
          listener(initial);
        }
        while (active) {
          const event = await invoke<BackendEvent | Array<BackendEvent> | null>(
            "ponlet_wait_event",
            { subscriptionId, lastSequence },
          );
          if (!active) {
            return;
          }
          if (event) {
            deliver(event);
          }
        }
      };
      void wait().catch(() => undefined);
      return () => {
        active = false;
        void invoke("ponlet_unsubscribe", { subscriptionId }).catch(() => undefined);
      };
    },
  };
}

/** Tauri adapter. Fast binary IPC is selected once; JSON invoke remains the fallback. */
export function createBackend(): PonletBackend {
  const listeners = new Set<(event: BackendEvent) => void>();
  const fallback = createJsonFallback(listeners);
  let selected: SelectedTransport | undefined;
  let cleanupFallback: (() => void) | undefined;
  let cleanupFast: (() => void) | undefined;
  let disposed = false;

  const ready = prepareSelection().then((value) => {
    selected = value;
    if (disposed) {
      if (value.kind !== "json") {
        value.client.close();
      }
      return value;
    }
    if (value.kind === "json") {
      cleanupFallback = fallback.start();
    } else {
      cleanupFast = value.client.subscribe((event) => {
        for (const listener of listeners) {
          listener(event);
        }
      });
    }
    return value;
  });
  const fastCall = async <T>(opcode: Opcode, payload?: unknown): Promise<T> => {
    const value = selected ?? (await ready);
    if (value.kind === "json") {
      throw new Error("Fast IPC is unavailable");
    }
    return value.client.call<T>(opcode, payload);
  };
  const jsonOrFast = async <T>(
    fast: () => Promise<T>,
    fallbackCall: () => Promise<T>,
  ): Promise<T> => {
    const value = selected ?? (await ready);
    return value.kind === "json" ? fallbackCall() : fast();
  };

  return {
    snapshot: () =>
      jsonOrFast(
        async () => validateSnapshot(await fastCall<BackendSnapshot>(Opcode.Snapshot)),
        fallback.backend.snapshot,
      ),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    createInvite: () =>
      jsonOrFast(() => fastCall(Opcode.CreateInvite), fallback.backend.createInvite),
    join: (invite) =>
      jsonOrFast(
        () => fastCall(Opcode.Join, invite),
        () => fallback.backend.join(invite),
      ),
    sendText: (text) =>
      jsonOrFast(
        () => fastCall(Opcode.SendText, text),
        () => fallback.backend.sendText(text),
      ),
    sendFiles: (files) => {
      const requests = files.map(toFileRequest);
      return jsonOrFast(
        () => fastCall(Opcode.SendFiles, requests),
        () => fallback.backend.sendFiles(files),
      );
    },
    pickAndSendFiles: () =>
      jsonOrFast(
        () => fastCall(Opcode.PickAndSendFiles),
        () => fallback.backend.pickAndSendFiles!(),
      ),
    qrCode: (url) =>
      jsonOrFast(
        async () => normalizeQr(await fastCall<QrBitmap>(Opcode.QrCode, url)),
        () => fallback.backend.qrCode(url),
      ),
    cancelTransfer: (id) =>
      jsonOrFast(
        () => fastCall(Opcode.CancelTransfer, id),
        () => fallback.backend.cancelTransfer(id),
      ),
    disconnect: () => jsonOrFast(() => fastCall(Opcode.Disconnect), fallback.backend.disconnect),
    openReceivedItem: (item) =>
      jsonOrFast(
        () => fastCall(Opcode.OpenReceived, { localPathOrHandle: item.localPathOrHandle }),
        () => fallback.backend.openReceivedItem(item),
      ),
    copyText,
    shareText,
    saveText: (text) =>
      jsonOrFast(
        () => fastCall(Opcode.SaveText, text),
        () => fallback.backend.saveText(text),
      ),
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      cleanupFallback?.();
      cleanupFast?.();
      listeners.clear();
      const value = selected ?? (await ready);
      if (value.kind === "json") {
        await fallback.backend.dispose();
      } else {
        try {
          await value.client.call(Opcode.Disconnect);
        } catch {
          // The native process may already be exiting. Closing the transport
          // still cancels the notification wait and rejects pending calls.
        } finally {
          value.client.close();
        }
      }
      selection = undefined;
    },
  };
}

export type { BackendEvent, BackendSnapshot, PonletBackend } from "../api/application-api";

/** Probe the fast paths before the first snapshot is requested. */
export function initializeBrowserBackend(): Promise<void> {
  return prepareSelection().then(() => undefined);
}
