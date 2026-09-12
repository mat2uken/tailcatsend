import type { BackendSnapshot, QrBitmap } from "../api/application-api";
import type { NativeBridge } from "../backend";
import { BinaryRpcClient, Opcode, PortBinaryTransport } from "../ipc";
import { resolvePublicUrl } from "../lib/public-url";
import { initializeWebTelemetry } from "../telemetry";
import type { BrowserWorkerMessage, BrowserWorkerResponse, GoCommand, GoMessage } from "../worker";

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
  readInto(destination: Uint8Array, length?: number): Promise<GoReadIntoValue>;
  transportType?: number;
  write(bytes: Uint8Array): Promise<unknown>;
}

interface GoBridge {
  dial(options: Record<string, unknown>): Promise<GoConnection>;
  listen(options: Record<string, unknown>): Promise<GoListener>;
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

function publicUrl(path: string): string {
  // Resolve from the document base instead of the origin root. This keeps a
  // Pages project served below a path prefix working without changing the
  // generated bundle or the signed asset names.
  return resolvePublicUrl(path, document.baseURI);
}

async function loadTailcatBridge(): Promise<void> {
  if (window.__ponletBackend || (globalThis as { tailSendTailcat?: unknown }).tailSendTailcat) {
    return;
  }
  if (!globalGo()) {
    await loadScript(publicUrl("assets/wasm_exec.js"));
  }
  const Go = globalGo();
  if (!Go) {
    throw new Error("Go WebAssembly runtime is unavailable");
  }
  const go = new Go();
  const response = await fetch(publicUrl("assets/tailcat.wasm.gz"));
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
          const raw = await fetch(publicUrl("assets/tailcat.wasm"));
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

interface GoReadIntoValue {
  code?: number;
  count?: number;
  error?: string;
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
      const target = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
      const result = await connection.readInto(target, message.length);
      const count = result.count;
      const code = result.code;
      const error = result.error;
      if (typeof count !== "number" || !Number.isSafeInteger(count)) {
        throw new Error("Tailcat readInto returned an invalid count");
      }
      if (count < 0 || count > target.byteLength) {
        throw new Error(`Tailcat readInto overrun: ${count} > ${target.byteLength}`);
      }
      post(
        {
          type: "response",
          requestId: message.requestId,
          ok: true,
          value: {
            buffer: message.buffer,
            byteOffset: message.byteOffset,
            byteLength: count,
            statusCode: code,
            statusMessage: error,
            transportType: currentTransport(connection),
          },
        },
        [message.buffer],
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
      post(
        {
          type: "response",
          requestId: message.requestId,
          ok: true,
          value: {
            ...value,
            buffer: message.buffer,
            transportType: currentTransport(connection),
          },
        },
        [message.buffer],
      );
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
  const rpcChannel = new MessageChannel();
  const bridge = globalTailcat();
  const rpcTransport = new PortBinaryTransport(rpcChannel.port1, true);
  const rpc = new BinaryRpcClient(rpcTransport);
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
    rpc.close();
    goChannel.port1.close();
    rpcChannel.port1.close();
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
    {
      type: "init",
      goPort: goChannel.port2,
      rpcPort: rpcChannel.port2,
      wasmUrl,
    } satisfies BrowserWorkerMessage,
    [goChannel.port2, rpcChannel.port2],
  );

  const workerBackend = async (): Promise<NativeBridge> => {
    await ready;
    let disposed = false;
    return {
      snapshot: () => rpc.call<BackendSnapshot>(Opcode.Snapshot),
      subscribe: (listener) => rpc.subscribe(listener),
      createInvite: () => rpc.call(Opcode.CreateInvite),
      join: (invite) => rpc.call(Opcode.Join, invite),
      sendText: (text) => rpc.call(Opcode.SendText, text),
      sendFiles: (files) =>
        rpc.call(
          Opcode.SendFiles,
          files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
          files,
        ),
      cancelTransfer: (id) => rpc.call(Opcode.CancelTransfer, id),
      disconnect: () => rpc.call(Opcode.Disconnect),
      qrCode: (url) => rpc.call<QrBitmap>(Opcode.QrCode, url),
      dispose: async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        try {
          await rpc.call(Opcode.Disconnect);
        } catch {
          // The worker may already be stopping during pagehide. Closing the
          // port below still releases all pending requests in that case.
        } finally {
          rpc.close();
          goChannel.port1.close();
          rpcChannel.port1.close();
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
 * together. The Worker/MessagePort path is required for the browser backend;
 * the JSON invoke adapter is the only compatibility path kept for native
 * WebViews.
 */
export function initializeBrowserBackend(): Promise<void> {
  if (window.__ponletBackend) {
    return Promise.resolve();
  }
  initialization ??= (async () => {
    void initializeWebTelemetry();
    await loadTailcatBridge();
    const moduleUrl = publicUrl("wasm/tailsend_web.js");
    if (typeof Worker !== "function" || typeof MessageChannel !== "function") {
      throw new Error("Ponlet requires Dedicated Worker and MessagePort support");
    }
    const bridge = await startWorkerBackend(moduleUrl);
    window.__ponletBackend = bridge;
  })().catch((error) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}
