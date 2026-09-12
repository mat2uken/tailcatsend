import type { BackendEvent, BackendSnapshot, QrBitmap } from "./api/application-api";
import {
  decodeFrame,
  encodeFrame,
  jsonBytes,
  MessageKind,
  Opcode,
  parseJson,
  qrPayload,
  type IpcFrame,
} from "./ipc";
import {
  commitReceivedFile,
  createReceivedWriter,
  disposeReceivedFiles,
  prepareReceivedFile,
} from "./worker-storage";

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

export interface WorkerInitMessage {
  goPort: MessagePort;
  rpcPort: MessagePort;
  type: "init";
  wasmUrl: string;
}

export type BrowserWorkerMessage = WorkerInitMessage;

export type BrowserWorkerResponse =
  | { type: "ready"; ok: true }
  | {
      type: "ready";
      ok: false;
      error: string;
    };

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
  | {
      type: "stream-read";
      requestId: number;
      connectionId: string;
      length: number;
      buffer: ArrayBuffer;
      byteOffset: number;
      byteLength: number;
    }
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
  buffer?: ArrayBuffer | null;
  byteLength?: number;
  byteOffset?: number;
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
  readInto(destination: Uint8Array, length?: number): Promise<GoReadProxyResult>;
  readonly transportType: number;
  write(bytes: Uint8Array): Promise<unknown>;
}

interface GoReadProxyResult {
  code: number;
  count: number;
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
  __ponletCommitReceivedFile?: typeof commitReceivedFile;
  __ponletCreateReceivedWriter?: typeof createReceivedWriter;
  __ponletPrepareReceivedFile?: typeof prepareReceivedFile;
  tailSendTailcat?: GoTransportProxy;
};
scope.__ponletCommitReceivedFile = commitReceivedFile;
scope.__ponletCreateReceivedWriter = createReceivedWriter;
scope.__ponletPrepareReceivedFile = prepareReceivedFile;

let goPort: MessagePort | undefined;
let goRequestId = 0;
let listenerId = 0;
let backend: RustBackend | undefined;
let rpcPort: MessagePort | undefined;
const queuedEvents: Array<BackendEvent> = [];
let eventFlushScheduled = false;
const goPending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
const listeners = new Map<string, (connection: GoConnectionProxy) => void>();

function workerPost(message: BrowserWorkerResponse): void {
  (globalThis as unknown as { postMessage(value: unknown): void }).postMessage(message);
}

function postRpc(frame: IpcFrame): void {
  const port = rpcPort;
  if (!port) {
    return;
  }
  const bytes = encodeFrame(frame);
  port.postMessage(bytes.buffer, [bytes.buffer]);
}

function responseFrame(request: IpcFrame, status: number, payload: Uint8Array): IpcFrame {
  return {
    kind: MessageKind.Response,
    opcode: request.opcode,
    requestId: request.requestId,
    sequence: request.sequence,
    status,
    payload,
  };
}

function responseError(request: IpcFrame, error: unknown): IpcFrame {
  return responseFrame(request, 1, new TextEncoder().encode(errorText(error)));
}

function flushRpcEvents(): void {
  eventFlushScheduled = false;
  if (!rpcPort || queuedEvents.length === 0) {
    return;
  }
  const events = queuedEvents.splice(0, 32);
  postRpc({
    kind: MessageKind.Event,
    opcode: Opcode.WaitEvent,
    requestId: BigInt(0),
    sequence: BigInt(events.at(-1)?.sequence ?? 0),
    status: 0,
    payload: jsonBytes(events),
  });
  if (queuedEvents.length > 0) {
    eventFlushScheduled = true;
    queueMicrotask(flushRpcEvents);
  }
}

function queueRpcEvent(event: BackendEvent): void {
  queuedEvents.push(event);
  if (!eventFlushScheduled) {
    eventFlushScheduled = true;
    queueMicrotask(flushRpcEvents);
  }
}

function normalizeQr(value: QrBitmap): QrBitmap {
  return {
    width: value.width,
    height: value.height,
    rgbaPixels:
      Object.prototype.toString.call(value.rgbaPixels) === "[object Uint8Array]"
        ? value.rgbaPixels
        : Uint8Array.from(value.rgbaPixels),
  };
}

function errorText(error: unknown): string {
  return error && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

function isUint8Array(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
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
  return value === 0 || value === 1 || value === 2 ? value : fallback;
}

function connectionProxy(descriptor: GoConnectionDescriptor): GoConnectionProxy {
  let currentTransport = descriptor.transportType;
  let readBuffer: ArrayBuffer | undefined;
  let writeBuffer: ArrayBuffer | undefined;
  const updateTransport = (value: unknown): void => {
    currentTransport = transportType(value, currentTransport);
  };
  return {
    port: descriptor.port,
    get transportType() {
      return currentTransport;
    },
    getTransport: () => currentTransport,
    readInto: async (destination, length = destination.byteLength) => {
      if (!Number.isSafeInteger(length) || length < 0 || length > destination.byteLength) {
        throw new Error("Tailcat readInto received an invalid length");
      }
      if (length === 0) {
        return { count: 0, code: 0 };
      }
      const buffer =
        readBuffer && readBuffer.byteLength >= length
          ? readBuffer
          : new ArrayBuffer(Math.max(CHUNK_SIZE, length));
      readBuffer = undefined;
      let result: GoReadResult;
      try {
        result = (await postGo(
          {
            type: "stream-read",
            requestId: ++goRequestId,
            connectionId: descriptor.connectionId,
            length,
            buffer,
            byteOffset: 0,
            byteLength: Math.min(buffer.byteLength, Math.max(0, length)),
          },
          [buffer],
        )) as GoReadResult;
      } catch (error) {
        // Transferring a buffer detaches it. A failed request must therefore
        // drop this slot and allocate a fresh one on the next read.
        readBuffer = undefined;
        throw error;
      }
      if (isArrayBuffer(result.buffer)) {
        readBuffer = result.buffer;
      }
      updateTransport(result.transportType);
      const byteLength = result.byteLength ?? 0;
      const byteOffset = result.byteOffset ?? 0;
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength < 0 ||
        byteLength > length ||
        !Number.isSafeInteger(byteOffset) ||
        byteOffset < 0 ||
        (byteLength > 0 &&
          (!isArrayBuffer(result.buffer) || byteOffset + byteLength > result.buffer.byteLength))
      ) {
        throw new Error("Tailcat readInto returned an invalid byte range");
      }
      if (byteLength > 0 && result.buffer) {
        destination.set(new Uint8Array(result.buffer, byteOffset, byteLength));
      }
      return {
        count: byteLength,
        code: result.statusCode ?? 0,
        error: result.statusMessage,
      };
    },
    write: async (bytes) => {
      const buffer =
        writeBuffer && writeBuffer.byteLength >= bytes.byteLength
          ? writeBuffer
          : new ArrayBuffer(Math.max(CHUNK_SIZE, bytes.byteLength));
      writeBuffer = undefined;
      new Uint8Array(buffer, 0, bytes.byteLength).set(bytes);
      let result: unknown;
      try {
        result = await postGo(
          {
            type: "stream-write",
            requestId: ++goRequestId,
            connectionId: descriptor.connectionId,
            buffer,
            byteOffset: 0,
            byteLength: bytes.byteLength,
          },
          [buffer],
        );
      } catch (error) {
        writeBuffer = undefined;
        throw error;
      }
      if (
        result &&
        typeof result === "object" &&
        isArrayBuffer((result as { buffer?: unknown }).buffer)
      ) {
        writeBuffer = (result as { buffer: ArrayBuffer }).buffer;
      }
      if (result && typeof result === "object" && "transportType" in result) {
        updateTransport(result.transportType);
      }
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
  rpcPort = message.rpcPort;
  rpcPort.start();
  rpcPort.onmessage = (event: MessageEvent<unknown>): void => {
    const data = event.data as { frame?: unknown; attachments?: Array<unknown> };
    const raw = data && typeof data === "object" && "frame" in data ? data.frame : event.data;
    const bytes = isArrayBuffer(raw)
      ? new Uint8Array(raw)
      : isUint8Array(raw)
        ? raw
        : ArrayBuffer.isView(raw)
          ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
          : undefined;
    if (!bytes) {
      return;
    }
    let frame: IpcFrame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      return;
    }
    void handleRpcFrame(
      frame,
      data && typeof data === "object" && "attachments" in data ? (data.attachments ?? []) : [],
    )
      .then(postRpc)
      .catch((error) => postRpc(responseError(frame, error)));
  };
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
  backend.subscribe(queueRpcEvent);
  workerPost({ type: "ready", ok: true });
}

async function handleRpcFrame(frame: IpcFrame, attachments: Array<unknown>): Promise<IpcFrame> {
  if (!backend) {
    throw new Error("Rust WebAssembly service is not ready");
  }
  if (
    frame.kind !== MessageKind.Request &&
    frame.kind !== MessageKind.Subscribe &&
    frame.kind !== MessageKind.Unsubscribe &&
    frame.kind !== MessageKind.WaitEvent
  ) {
    throw new Error("invalid IPC request kind");
  }
  if (
    (frame.kind === MessageKind.Subscribe && frame.opcode !== Opcode.Subscribe) ||
    (frame.kind === MessageKind.Unsubscribe && frame.opcode !== Opcode.Unsubscribe)
  ) {
    throw new Error("invalid IPC subscription operation");
  }
  if (frame.kind === MessageKind.WaitEvent) {
    if (frame.opcode !== Opcode.WaitEvent) {
      throw new Error("invalid IPC wait operation");
    }
    // Worker notifications are pushed on the same MessagePort. A wait request
    // is acknowledged without an empty poll so the caller can keep one
    // subscription loop for ports and custom schemes.
    return responseFrame(frame, 0, new Uint8Array());
  }
  let value: unknown = undefined;
  if (frame.payload.byteLength > 0) {
    value = parseJson<unknown>(frame.payload);
  }
  switch (frame.opcode) {
    case Opcode.Snapshot:
      return responseFrame(frame, 0, jsonBytes(await backend.snapshot()));
    case Opcode.CreateInvite:
      await backend.createInvite();
      return responseFrame(frame, 0, new Uint8Array());
    case Opcode.Join:
      await backend.join(value as string);
      return responseFrame(frame, 0, new Uint8Array());
    case Opcode.SendText:
      await backend.sendText(value as string);
      return responseFrame(frame, 0, new Uint8Array());
    case Opcode.SendFiles:
      await backend.sendFiles((attachments.length > 0 ? attachments : value) as Array<File>);
      return responseFrame(frame, 0, new Uint8Array());
    case Opcode.QrCode:
      return responseFrame(frame, 0, qrPayload(normalizeQr(await backend.qrCode(value as string))));
    case Opcode.CancelTransfer:
      await backend.cancelTransfer(value as string);
      return responseFrame(frame, 0, new Uint8Array());
    case Opcode.Disconnect:
      try {
        await backend.disconnect();
      } finally {
        if (
          value &&
          typeof value === "object" &&
          "disposeStorage" in value &&
          value.disposeStorage === true
        ) {
          await disposeReceivedFiles();
        }
      }
      return responseFrame(frame, 0, new Uint8Array());
    case Opcode.Subscribe:
      return responseFrame(frame, 0, jsonBytes(await backend.snapshot()));
    case Opcode.Unsubscribe:
      return responseFrame(frame, 0, new Uint8Array());
    default:
      throw new Error(`Rust backend method for opcode ${frame.opcode} is unavailable`);
  }
}

(
  globalThis as unknown as {
    onmessage: ((event: MessageEvent<BrowserWorkerMessage>) => void) | null;
  }
).onmessage = (event: MessageEvent<BrowserWorkerMessage>): void => {
  const message = event.data;
  void initialize(message).catch((error) => {
    workerPost({ type: "ready", ok: false, error: errorText(error) });
  });
};

export function postChunk(
  port: MessagePort,
  command: Extract<TransferWorkerCommand, { type: "chunk" }>,
): void {
  port.postMessage(command, [command.buffer]);
}
