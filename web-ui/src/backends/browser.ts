import type { BackendEvent, BackendSnapshot, QrBitmap } from "../api/application-api";
import type { NativeBridge } from "../backend";
import type {
  BrowserWorkerMessage,
  BrowserWorkerResponse,
  GoCommand,
  GoMessage,
  WorkerMethod,
} from "../worker";

/** Browser composition root for the Rust WASM service. */
export { createBackend } from "../backend";
export type { BackendEvent, BackendSnapshot, PonletBackend } from "../backend";

let initialization: Promise<void> | undefined;

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

type GoConstructor = new () => GoRuntime;

interface GoListener {
  addr?: string;
  address?: string;
  close(): unknown;
}

interface GoConnection {
  close(): unknown;
  closeWrite(): Promise<unknown>;
  getTransport?(): number;
  port?: number;
  read(length: number): Promise<Uint8Array | ArrayBuffer | GoReadValue | null>;
  transportType?: number;
  write(bytes: Uint8Array): Promise<unknown>;
}

interface GoBridge {
  dial(options: Record<string, unknown>): Promise<GoConnection>;
  listen(options: Record<string, unknown>): Promise<GoListener>;
}

interface PendingWorkerCall {
  reject(error: Error): void;
  resolve(value: unknown): void;
}

function globalGo(): GoConstructor | undefined {
  return (globalThis as typeof globalThis & { Go?: GoConstructor }).Go;
}

function globalTailcat(): GoBridge {
  const value = (globalThis as typeof globalThis & { tailSendTailcat?: unknown }).tailSendTailcat;
  if (!value || typeof value !== "object") {
    throw new Error("Tailcat WebAssembly bridge is unavailable");
  }
  return value as GoBridge;
}

async function loadScript(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Unable to load ${url}`));
    document.head.append(script);
  });
}

async function loadTailcatBridge(): Promise<void> {
  if (window.__ponletBackend || (globalThis as { tailSendTailcat?: unknown }).tailSendTailcat) {
    return;
  }
  if (!globalGo()) {
    await loadScript("/assets/wasm_exec.js");
  }
  const Go = globalGo();
  if (!Go) {
    throw new Error("Go WebAssembly runtime is unavailable");
  }
  const go = new Go();
  const response = await fetch("/assets/tailcat.wasm.gz");
  if (!response.ok) {
    throw new Error(`Unable to load Tailcat WebAssembly (${response.status})`);
  }
  const compressed = await response.arrayBuffer();
  const bytes =
    "DecompressionStream" in globalThis
      ? await new Response(
          new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")),
        ).arrayBuffer()
      : await (async () => {
          const raw = await fetch("/assets/tailcat.wasm");
          if (!raw.ok) {
            throw new Error(`Unable to load uncompressed Tailcat WebAssembly (${raw.status})`);
          }
          return raw.arrayBuffer();
        })();
  const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
  void go.run(instance);
  await new Promise<void>((resolve, reject) => {
    const deadline = window.setTimeout(
      () => reject(new Error("Tailcat WebAssembly startup timed out")),
      30_000,
    );
    const check = (): void => {
      if ((globalThis as { tailSendTailcat?: unknown }).tailSendTailcat) {
        window.clearTimeout(deadline);
        resolve();
      } else {
        window.setTimeout(check, 10);
      }
    };
    check();
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentTransport(connection: GoConnection): number {
  try {
    const value = connection.getTransport?.() ?? connection.transportType;
    return typeof value === "number" && Number.isFinite(value) ? value : 255;
  } catch {
    return 255;
  }
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

function asBytes(value: Uint8Array | ArrayBuffer | null): Uint8Array | null {
  if (value == null) {
    return null;
  }
  return ArrayBuffer.isView(value) ? value : new Uint8Array(value);
}

interface GoReadValue {
  bytes?: Uint8Array | ArrayBuffer | null;
  code?: number;
  error?: string;
}

function decodeGoRead(value: unknown): { bytes: Uint8Array | null; code?: number; error?: string } {
  if (value == null) {
    return { bytes: null };
  }
  if (ArrayBuffer.isView(value) || isArrayBuffer(value)) {
    return { bytes: asBytes(value as Uint8Array | ArrayBuffer) };
  }
  if (typeof value === "object") {
    const result = value as GoReadValue;
    return {
      bytes: asBytes(result.bytes ?? null),
      code: typeof result.code === "number" ? result.code : undefined,
      error: typeof result.error === "string" ? result.error : undefined,
    };
  }
  throw new Error("Tailcat read returned an invalid result");
}

async function handleGoMessage(
  event: MessageEvent<GoCommand>,
  bridge: GoBridge,
  listeners: Map<string, (connection: GoConnection) => void>,
  connections: Map<string, GoConnection>,
  nativeListeners: Map<string, GoListener>,
  post: (message: GoMessage, transfer?: Array<Transferable>) => void,
  nextConnectionId: () => string,
): Promise<void> {
  const message = event.data;
  if (message.type === "listen") {
    try {
      const listener = await bridge.listen({
        derpMapURL: message.derpMapURL,
        verbose: message.verbose,
        onConnection: (connection: GoConnection) => {
          const connectionId = nextConnectionId();
          connections.set(connectionId, connection);
          post({
            type: "incoming",
            listenerId: message.listenerId,
            connectionId,
            port: connection.port ?? 0,
            transportType: currentTransport(connection),
          });
        },
      });
      nativeListeners.set(message.listenerId, listener);
      post({
        type: "response",
        requestId: message.requestId,
        ok: true,
        value: { address: listener.addr ?? listener.address ?? "" },
      });
    } catch (error) {
      post({
        type: "response",
        requestId: message.requestId,
        ok: false,
        error: errorText(error),
      });
    }
    return;
  }

  if (message.type === "dial") {
    try {
      const connection = await bridge.dial({
        addr: message.address,
        port: message.port,
        derpMapURL: message.derpMapURL,
        verbose: message.verbose,
      });
      const connectionId = nextConnectionId();
      connections.set(connectionId, connection);
      post({
        type: "response",
        requestId: message.requestId,
        ok: true,
        value: {
          connectionId,
          port: connection.port ?? 0,
          transportType: currentTransport(connection),
        },
      });
    } catch (error) {
      post({
        type: "response",
        requestId: message.requestId,
        ok: false,
        error: errorText(error),
      });
    }
    return;
  }

  if (message.type === "listener-close") {
    try {
      const listener = nativeListeners.get(message.listenerId);
      nativeListeners.delete(message.listenerId);
      listeners.delete(message.listenerId);
      await Promise.resolve(listener?.close());
      post({ type: "response", requestId: message.requestId, ok: true, value: undefined });
    } catch (error) {
      post({
        type: "response",
        requestId: message.requestId,
        ok: false,
        error: errorText(error),
      });
    }
    return;
  }

  const connection = connections.get(message.connectionId);
  if (!connection) {
    post({
      type: "response",
      requestId: message.requestId,
      ok: false,
      error: "Tailcat connection is unavailable",
    });
    return;
  }
  try {
    if (message.type === "stream-read") {
      const decoded = decodeGoRead(await connection.read(message.length));
      const bytes = decoded.bytes;
      const buffer = bytes?.buffer;
      const transfer = isArrayBuffer(buffer) ? [buffer] : [];
      post(
        {
          type: "response",
          requestId: message.requestId,
          ok: true,
          value: {
            buffer: buffer ?? null,
            byteOffset: bytes?.byteOffset ?? 0,
            byteLength: bytes?.byteLength ?? 0,
            statusCode: decoded.code,
            statusMessage: decoded.error,
            transportType: currentTransport(connection),
          },
        },
        transfer,
      );
    } else if (message.type === "stream-write") {
      const bytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
      const result = await connection.write(bytes);
      const value =
        typeof result === "number"
          ? { written: result, code: 0 }
          : typeof result === "object" && result !== null
            ? result
            : { written: bytes.byteLength, code: 0 };
      post({
        type: "response",
        requestId: message.requestId,
        ok: true,
        value: { ...value, transportType: currentTransport(connection) },
      });
    } else if (message.type === "stream-close-write") {
      await connection.closeWrite();
      post({ type: "response", requestId: message.requestId, ok: true, value: undefined });
    } else if (message.type === "stream-close") {
      connections.delete(message.connectionId);
      await Promise.resolve(connection.close());
      post({ type: "response", requestId: message.requestId, ok: true, value: undefined });
    }
  } catch (error) {
    post({
      type: "response",
      requestId: message.requestId,
      ok: false,
      error: errorText(error),
    });
  }
}

function startWorkerBackend(wasmUrl: string): Promise<NativeBridge> {
  const worker = new Worker(new URL("../worker.ts", import.meta.url), { type: "module" });
  const goChannel = new MessageChannel();
  const bridge = globalTailcat();
  const listeners = new Set<(event: BackendEvent) => void>();
  const pending = new Map<number, PendingWorkerCall>();
  let nextId = 0;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  let settled = false;

  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimer = window.setTimeout(
    () => rejectAll(new Error("Rust WebAssembly worker startup timed out")),
    30_000,
  );
  const rejectAll = (error: Error): void => {
    window.clearTimeout(readyTimer);
    if (!settled) {
      settled = true;
      readyReject?.(error);
    }
    for (const call of pending.values()) {
      call.reject(error);
    }
    pending.clear();
    goChannel.port1.close();
    worker.terminate();
  };
  worker.onerror = (event) => {
    rejectAll(new Error(event.message || "Rust WebAssembly worker failed"));
  };
  worker.onmessage = (event: MessageEvent<BrowserWorkerResponse>): void => {
    const message = event.data;
    if (message.type === "ready") {
      if (message.ok) {
        settled = true;
        window.clearTimeout(readyTimer);
        readyResolve?.();
      } else {
        rejectAll(new Error(message.error));
      }
      return;
    }
    if (message.type === "event") {
      for (const listener of listeners) {
        listener(message.event);
      }
      return;
    }
    const call = pending.get(message.id);
    if (!call) {
      return;
    }
    pending.delete(message.id);
    if (message.ok) {
      call.resolve(message.value);
    } else {
      call.reject(new Error(message.error));
    }
  };
  const goPost = (message: GoMessage, transfer: Array<Transferable> = []): void => {
    goChannel.port1.postMessage(message, transfer);
  };
  const goConnections = new Map<string, GoConnection>();
  const goListeners = new Map<string, GoListener>();
  const workerListeners = new Map<string, (connection: GoConnection) => void>();
  let connectionSequence = 0;
  // The worker sends listener callbacks through the Go port. Keep the callback
  // map in the window side and let the common handler route each connection.
  goChannel.port1.onmessage = (event: MessageEvent<GoCommand>): void => {
    void handleGoMessage(
      event,
      bridge,
      workerListeners,
      goConnections,
      goListeners,
      goPost,
      () => `connection-${++connectionSequence}`,
    );
  };
  goChannel.port1.start();
  worker.postMessage(
    { type: "init", goPort: goChannel.port2, wasmUrl } satisfies BrowserWorkerMessage,
    [goChannel.port2],
  );

  const call = (method: WorkerMethod, args: Array<unknown> = []): Promise<unknown> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: "call", id, method, args } satisfies BrowserWorkerMessage);
    });
  };
  const workerBackend = async (): Promise<NativeBridge> => {
    await ready;
    let disposed = false;
    return {
      snapshot: () => call("snapshot") as Promise<BackendSnapshot>,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      createInvite: () => call("createInvite") as Promise<void>,
      join: (invite) => call("join", [invite]) as Promise<void>,
      sendText: (text) => call("sendText", [text]) as Promise<void>,
      sendFiles: (files) => call("sendFiles", [files]) as Promise<void>,
      cancelTransfer: (id) => call("cancelTransfer", [id]) as Promise<void>,
      disconnect: () => call("disconnect") as Promise<void>,
      qrCode: (url) => call("qrCode", [url]) as Promise<QrBitmap>,
      dispose: async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        try {
          await call("dispose");
        } finally {
          listeners.clear();
          goChannel.port1.close();
          worker.terminate();
        }
      },
    };
  };
  return workerBackend();
}

/**
 * Load the Rust service after the static UI has been parsed. Go remains in the
 * window and is proxied to a Dedicated Worker, where Rust state and OPFS run
 * together. Older WebViews without module Worker support use the direct
 * adapter as a compatibility path.
 */
export function initializeBrowserBackend(): Promise<void> {
  if (window.__ponletBackend) {
    return Promise.resolve();
  }
  initialization ??= (async () => {
    await loadTailcatBridge();
    const moduleUrl = new URL("/wasm/tailsend_web.js", window.location.origin).href;
    if (typeof Worker === "function" && typeof MessageChannel === "function") {
      const bridge = await startWorkerBackend(moduleUrl);
      window.__ponletBackend = bridge;
      return;
    }
    const wasm = await import(/* @vite-ignore */ moduleUrl);
    await wasm.default();
    wasm.install_backend();
    if (!window.__ponletBackend) {
      throw new Error("Rust WebAssembly service did not install the browser adapter");
    }
  })();
  return initialization;
}
