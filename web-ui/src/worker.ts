import type { BackendEvent, BackendSnapshot, QrBitmap } from "./api/application-api";

/**
 * The worker keeps Rust state and OPFS in one execution context. Go stays in
 * the window because its WebRTC implementation needs the browser's
 * RTCPeerConnection. The two contexts exchange only metadata and transferable
 * ArrayBuffers through the small protocol below.
 */

export type TransferWorkerCommand =
  | { type: "init"; sessionId: string; credits: number }
  | {
      type: "chunk";
      transferId: string;
      slot: number;
      buffer: ArrayBuffer;
      byteOffset: number;
      byteLength: number;
    }
  | { type: "cancel"; transferId: string };

export type TransferWorkerEvent =
  | { type: "need-chunk"; transferId: string; slot: number; maxLength: number }
  | {
      type: "chunk-written";
      transferId: string;
      slot: number;
      buffer: ArrayBuffer;
      byteOffset: number;
      byteLength: number;
    }
  | {
      type: "terminal";
      transferId: string;
      status: "completed" | "cancelled" | "failed";
      message?: string;
    };

export const MAX_IN_FLIGHT_CHUNKS = 2;
export const CHUNK_SIZE = 64 * 1024;

export type WorkerMethod =
  | "snapshot"
  | "createInvite"
  | "join"
  | "sendText"
  | "sendFiles"
  | "cancelTransfer"
  | "disconnect"
  | "dispose"
  | "qrCode";

export interface WorkerInitMessage {
  goPort: MessagePort;
  type: "init";
  wasmUrl: string;
}

export interface WorkerCallMessage {
  args: Array<unknown>;
  id: number;
  method: WorkerMethod;
  type: "call";
}

export interface WorkerDisposeMessage {
  id: number;
  type: "dispose";
}

export type BrowserWorkerMessage = WorkerInitMessage | WorkerCallMessage | WorkerDisposeMessage;

export type BrowserWorkerResponse =
  | { type: "ready"; ok: true }
  | { type: "ready"; ok: false; error: string }
  | { type: "response"; id: number; ok: true; value: unknown }
  | { type: "response"; id: number; ok: false; error: string }
  | { type: "event"; event: BackendEvent };

export type GoCommand =
  | {
      type: "listen";
      requestId: number;
      listenerId: string;
      derpMapURL: string;
      verbose: boolean;
    }
  | {
      type: "dial";
      requestId: number;
      address: string;
      port: number;
      derpMapURL: string;
      verbose: boolean;
    }
  | { type: "listener-close"; requestId: number; listenerId: string }
  | { type: "stream-read"; requestId: number; connectionId: string; length: number }
  | {
      type: "stream-write";
      requestId: number;
      connectionId: string;
      buffer: ArrayBuffer;
      byteOffset: number;
      byteLength: number;
    }
  | { type: "stream-close-write"; requestId: number; connectionId: string }
  | { type: "stream-close"; requestId: number; connectionId: string };

export type GoResponse = {
  type: "response";
  requestId: number;
  ok: boolean;
  value?: unknown;
  error?: string;
};

export type GoIncoming = {
  type: "incoming";
  listenerId: string;
  connectionId: string;
  port: number;
  transportType: number;
};

export type GoMessage = GoResponse | GoIncoming;

interface GoConnectionDescriptor {
  connectionId: string;
  port: number;
  transportType: number;
}

interface GoListenerDescriptor {
  address: string;
}

interface GoReadResult {
  buffer: ArrayBuffer | null;
  byteLength: number;
  byteOffset: number;
  statusCode?: number;
  statusMessage?: string;
  transportType: number;
}

interface GoTransportProxy {
  dial(options: Record<string, unknown>): Promise<GoConnectionProxy>;
  listen(
    options: Record<string, unknown>,
  ): Promise<{ addr: string; address: string; close(): Promise<void> }>;
}

interface GoConnectionProxy {
  close(): Promise<unknown>;
  closeWrite(): Promise<unknown>;
  getTransport(): number;
  port: number;
  read(length: number): Promise<Uint8Array | GoReadProxyResult | null>;
  write(bytes: Uint8Array): Promise<unknown>;
}

interface GoReadProxyResult {
  bytes: Uint8Array | null;
  code: number;
  error?: string;
}

interface RustBackend {
  cancelTransfer(id: string): Promise<void>;
  createInvite(): Promise<void>;
  disconnect(): Promise<void>;
  dispose(): Promise<void>;
  join(invite: string): Promise<void>;
  qrCode(url: string): Promise<QrBitmap>;
  sendFiles(files: Array<File>): Promise<void>;
  sendText(text: string): Promise<void>;
  snapshot(): Promise<BackendSnapshot>;
  subscribe(listener: (event: BackendEvent) => void): () => void;
}

const scope = globalThis as typeof globalThis & {
  __ponletBackend?: RustBackend;
  tailSendTailcat?: GoTransportProxy;
};

let goPort: MessagePort | undefined;
let goRequestId = 0;
let listenerId = 0;
let backend: RustBackend | undefined;
let unsubscribe: (() => void) | undefined;
const goPending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
const listeners = new Map<string, (connection: GoConnectionProxy) => void>();

function workerPost(message: BrowserWorkerResponse): void {
  (globalThis as unknown as { postMessage(value: unknown): void }).postMessage(message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function postGo(command: GoCommand, transfer: Array<Transferable> = []): Promise<unknown> {
  const port = goPort;
  if (!port) {
    return Promise.reject(new Error("Go bridge port is unavailable"));
  }
  return new Promise((resolve, reject) => {
    const requestId = command.requestId;
    goPending.set(requestId, { resolve, reject });
    try {
      port.postMessage(command, transfer);
    } catch (error) {
      goPending.delete(requestId);
      reject(new Error(errorText(error)));
    }
  });
}

function transportType(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

function connectionProxy(descriptor: GoConnectionDescriptor): GoConnectionProxy {
  let currentTransport = descriptor.transportType;
  const updateTransport = (value: unknown): void => {
    currentTransport = transportType(value, currentTransport);
  };
  return {
    port: descriptor.port,
    getTransport: () => currentTransport,
    read: async (length) => {
      const result = (await postGo({
        type: "stream-read",
        requestId: ++goRequestId,
        connectionId: descriptor.connectionId,
        length,
      })) as GoReadResult;
      updateTransport(result.transportType);
      if (!result.buffer || result.byteLength === 0) {
        if (typeof result.statusCode === "number" && result.statusCode !== 0) {
          return {
            bytes: null,
            code: result.statusCode,
            error: result.statusMessage,
          } satisfies GoReadProxyResult;
        }
        return null;
      }
      const bytes = new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
      if (typeof result.statusCode === "number" && result.statusCode !== 0) {
        return {
          bytes,
          code: result.statusCode,
          error: result.statusMessage,
        } satisfies GoReadProxyResult;
      }
      return bytes;
    },
    write: async (bytes) => {
      const buffer = bytes.buffer;
      const transfer = isArrayBuffer(buffer) ? [buffer] : [];
      const result = await postGo(
        {
          type: "stream-write",
          requestId: ++goRequestId,
          connectionId: descriptor.connectionId,
          buffer: buffer as ArrayBuffer,
          byteOffset: bytes.byteOffset,
          byteLength: bytes.byteLength,
        },
        transfer,
      );
      return result;
    },
    closeWrite: () =>
      postGo({
        type: "stream-close-write",
        requestId: ++goRequestId,
        connectionId: descriptor.connectionId,
      }),
    close: () =>
      postGo({
        type: "stream-close",
        requestId: ++goRequestId,
        connectionId: descriptor.connectionId,
      }),
  };
}

function installGoProxy(port: MessagePort): void {
  goPort = port;
  port.onmessage = (event: MessageEvent<GoMessage>): void => {
    const message = event.data;
    if (message.type === "incoming") {
      const callback = listeners.get(message.listenerId);
      callback?.(
        connectionProxy({
          connectionId: message.connectionId,
          port: message.port,
          transportType: message.transportType,
        }),
      );
      return;
    }
    const pending = goPending.get(message.requestId);
    if (!pending) {
      return;
    }
    goPending.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.value);
    } else {
      pending.reject(new Error(message.error ?? "Go bridge request failed"));
    }
  };
  port.start();

  const proxy: GoTransportProxy = {
    listen: async (options) => {
      const id = `listener-${++listenerId}`;
      const callback = options.onConnection;
      if (typeof callback !== "function") {
        throw new Error("Tailcat listener callback is unavailable");
      }
      listeners.set(id, callback as (connection: GoConnectionProxy) => void);
      try {
        const value = (await postGo({
          type: "listen",
          requestId: ++goRequestId,
          listenerId: id,
          derpMapURL: typeof options.derpMapURL === "string" ? options.derpMapURL : "",
          verbose: options.verbose === true,
        })) as GoListenerDescriptor;
        return {
          addr: value.address,
          address: value.address,
          close: async () => {
            listeners.delete(id);
            await postGo({
              type: "listener-close",
              requestId: ++goRequestId,
              listenerId: id,
            });
          },
        };
      } catch (error) {
        listeners.delete(id);
        throw error;
      }
    },
    dial: async (options) => {
      const value = (await postGo({
        type: "dial",
        requestId: ++goRequestId,
        address: typeof options.addr === "string" ? options.addr : "",
        port: typeof options.port === "number" ? options.port : 100,
        derpMapURL: typeof options.derpMapURL === "string" ? options.derpMapURL : "",
        verbose: options.verbose === true,
      })) as GoConnectionDescriptor;
      return connectionProxy(value);
    },
  };
  scope.tailSendTailcat = proxy;
}

async function initialize(message: WorkerInitMessage): Promise<void> {
  installGoProxy(message.goPort);
  const module = (await import(/* @vite-ignore */ message.wasmUrl)) as unknown as {
    default(input?: unknown): Promise<unknown>;
    install_backend(): void;
  };
  await module.default();
  module.install_backend();
  backend = scope.__ponletBackend;
  if (!backend) {
    throw new Error("Rust WebAssembly service did not install the worker adapter");
  }
  unsubscribe = backend.subscribe((event) => workerPost({ type: "event", event }));
  workerPost({ type: "ready", ok: true });
}

async function callBackend(message: WorkerCallMessage | WorkerDisposeMessage): Promise<unknown> {
  if (!backend) {
    throw new Error("Rust WebAssembly service is not ready");
  }
  if (message.type === "dispose") {
    unsubscribe?.();
    unsubscribe = undefined;
    return backend.dispose();
  }
  const method = backend[message.method];
  if (typeof method !== "function") {
    throw new Error(`Rust backend method ${message.method} is unavailable`);
  }
  return (method as unknown as (...args: Array<unknown>) => unknown).apply(backend, message.args);
}

(
  globalThis as unknown as {
    onmessage: ((event: MessageEvent<BrowserWorkerMessage>) => void) | null;
  }
).onmessage = (event: MessageEvent<BrowserWorkerMessage>): void => {
  const message = event.data;
  if (message.type === "init") {
    void initialize(message).catch((error) => {
      workerPost({ type: "ready", ok: false, error: errorText(error) });
    });
    return;
  }
  const id = message.id;
  void callBackend(message)
    .then((value) => workerPost({ type: "response", id, ok: true, value }))
    .catch((error) => workerPost({ type: "response", id, ok: false, error: errorText(error) }));
};

export function postChunk(
  port: MessagePort,
  command: Extract<TransferWorkerCommand, { type: "chunk" }>,
): void {
  port.postMessage(command, [command.buffer]);
}
