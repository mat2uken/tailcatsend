import type { BackendEvent, BackendSnapshot, QrBitmap } from "./api/application-api";

export const IPC_MAGIC = new Uint8Array([0x50, 0x4e, 0x4c, 0x54]);
export const IPC_VERSION = 2;
export const IPC_HEADER_SIZE = 32;
export const IPC_MAX_PAYLOAD = 8 * 1024 * 1024;

export const enum MessageKind {
  Request = 1,
  Response = 2,
  Event = 3,
  Subscribe = 4,
  Unsubscribe = 5,
  WaitEvent = 6,
}

export const enum Opcode {
  Snapshot = 1,
  CreateInvite = 2,
  Join = 3,
  SendText = 4,
  SendFiles = 5,
  PickAndSendFiles = 6,
  SaveText = 7,
  QrCode = 8,
  CancelTransfer = 9,
  Disconnect = 10,
  OpenReceived = 11,
  Subscribe = 12,
  Unsubscribe = 13,
  WaitEvent = 14,
}

export interface IpcFrame {
  kind: MessageKind;
  opcode: Opcode;
  payload: Uint8Array;
  requestId: bigint;
  sequence: bigint;
  status: number;
}

export function encodeFrame(frame: IpcFrame): Uint8Array {
  if (frame.payload.byteLength > IPC_MAX_PAYLOAD) {
    throw new Error(`IPC payload is too large (${frame.payload.byteLength} bytes)`);
  }
  const output = new Uint8Array(IPC_HEADER_SIZE + frame.payload.byteLength);
  output.set(IPC_MAGIC, 0);
  output[4] = IPC_VERSION;
  output[5] = frame.kind;
  const view = new DataView(output.buffer);
  view.setUint16(6, frame.opcode, true);
  view.setBigUint64(8, frame.requestId, true);
  view.setBigUint64(16, frame.sequence, true);
  view.setUint32(24, frame.payload.byteLength, true);
  view.setUint32(28, frame.status >>> 0, true);
  output.set(frame.payload, IPC_HEADER_SIZE);
  return output;
}

export function decodeFrame(value: ArrayBuffer | Uint8Array): IpcFrame {
  const bytes = isUint8Array(value) ? value : new Uint8Array(value);
  if (bytes.byteLength < IPC_HEADER_SIZE) {
    throw new Error(`IPC frame header is truncated (${bytes.byteLength} bytes)`);
  }
  if (!IPC_MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new Error("IPC frame magic is invalid");
  }
  if (bytes[4] !== IPC_VERSION) {
    throw new Error(`IPC protocol version ${bytes[4]} is unsupported`);
  }
  if (!(bytes[5] >= MessageKind.Request && bytes[5] <= MessageKind.WaitEvent)) {
    throw new Error(`IPC message kind ${bytes[5]} is unknown`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const opcode = view.getUint16(6, true);
  if (opcode < Opcode.Snapshot || opcode > Opcode.WaitEvent) {
    throw new Error(`IPC opcode ${opcode} is unknown`);
  }
  const payloadLength = view.getUint32(24, true);
  if (payloadLength > IPC_MAX_PAYLOAD) {
    throw new Error(`IPC payload is too large (${payloadLength} bytes)`);
  }
  const expected = IPC_HEADER_SIZE + payloadLength;
  if (bytes.byteLength !== expected) {
    throw new Error(`IPC frame length mismatch: expected ${expected}, got ${bytes.byteLength}`);
  }
  return {
    kind: bytes[5] as MessageKind,
    opcode: opcode as Opcode,
    requestId: view.getBigUint64(8, true),
    sequence: view.getBigUint64(16, true),
    status: view.getUint32(28, true),
    payload: bytes.subarray(IPC_HEADER_SIZE),
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function parseJson<T>(payload: Uint8Array): T {
  return JSON.parse(decoder.decode(payload)) as T;
}

export interface RawBinaryTransport {
  close(): void;
  send(frame: Uint8Array, attachments?: ReadonlyArray<unknown>): Promise<Uint8Array>;
  subscribe(listener: (frame: Uint8Array) => void): () => void;
  readonly supportsPushEvents: boolean;
}

interface PendingResponse {
  reject(error: Error): void;
  resolve(frame: Uint8Array): void;
}

interface BinaryPort {
  addEventListener?(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  close?(): void;
  onmessage?: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Array<Transferable>): void;
  removeEventListener?(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  start?(): void;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

function isUint8Array(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function asFrameBytes(value: unknown): Uint8Array | undefined {
  if (isArrayBuffer(value)) {
    return new Uint8Array(value);
  }
  if (isUint8Array(value)) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value && typeof value === "object" && "frame" in value) {
    return asFrameBytes((value as { frame: unknown }).frame);
  }
  if (value && typeof value === "object" && "data" in value) {
    return asFrameBytes((value as { data: unknown }).data);
  }
  return undefined;
}

/** MessagePort/WebMessageListener transport. Frames use ArrayBuffer directly. */
export class PortBinaryTransport implements RawBinaryTransport {
  readonly supportsPushEvents: boolean;
  private readonly pending = new Map<bigint, PendingResponse>();
  private readonly listeners = new Set<(frame: Uint8Array) => void>();
  private readonly onMessage: (event: MessageEvent<unknown>) => void;

  constructor(
    private readonly port: BinaryPort,
    supportsPushEvents = false,
  ) {
    this.supportsPushEvents = supportsPushEvents;
    this.onMessage = (event) => {
      const bytes = asFrameBytes(event.data);
      if (!bytes) {
        return;
      }
      let frame: IpcFrame;
      try {
        frame = decodeFrame(bytes);
      } catch {
        return;
      }
      if (frame.kind === MessageKind.Response || frame.kind === MessageKind.Event) {
        const pending = this.pending.get(frame.requestId);
        if (pending) {
          this.pending.delete(frame.requestId);
          pending.resolve(bytes);
          return;
        }
      }
      for (const listener of this.listeners) {
        listener(bytes);
      }
    };
    if (port.addEventListener) {
      port.addEventListener("message", this.onMessage);
      port.start?.();
    } else {
      port.onmessage = this.onMessage;
    }
  }

  send(frame: Uint8Array, attachments: ReadonlyArray<unknown> = []): Promise<Uint8Array> {
    let requestId: bigint;
    try {
      requestId = decodeFrame(frame).requestId;
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        // Android WebView converts transferred buffers inconsistently. The
        // native port receives a view, while MessagePort can transfer a copy.
        const buffer =
          frame.byteOffset === 0 && frame.byteLength === frame.buffer.byteLength
            ? (frame.buffer as ArrayBuffer)
            : (frame.slice().buffer as ArrayBuffer);
        const message = attachments.length > 0 ? { frame: buffer, attachments } : buffer;
        const canTransfer = Object.prototype.toString.call(this.port) === "[object MessagePort]";
        if (canTransfer) {
          this.port.postMessage(message, [buffer]);
        } else {
          this.port.postMessage(message);
        }
      } catch (error) {
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  subscribe(listener: (frame: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    const error = new Error("Binary transport closed");
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    if (this.port.removeEventListener) {
      this.port.removeEventListener("message", this.onMessage);
    }
    this.port.close?.();
  }
}

/** Tauri custom-scheme POST transport. One request carries one complete frame. */
export class SchemeBinaryTransport implements RawBinaryTransport {
  readonly supportsPushEvents = false;
  private readonly listeners = new Set<(frame: Uint8Array) => void>();
  private readonly controller = new AbortController();

  constructor(private readonly baseUrl = "ponletbin://localhost") {}

  async send(frame: Uint8Array): Promise<Uint8Array> {
    const body =
      frame.byteOffset === 0 && frame.byteLength === frame.buffer.byteLength
        ? (frame.buffer as ArrayBuffer)
        : (frame.slice().buffer as ArrayBuffer);
    const response = await fetch(`${this.baseUrl}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body,
      signal: this.controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Ponlet binary transport failed (${response.status})`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  subscribe(listener: (frame: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.controller.abort();
    this.listeners.clear();
  }
}

function qrFromPayload(payload: Uint8Array): QrBitmap {
  if (payload.byteLength < 8) {
    throw new Error("QR response is truncated");
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const pixels = payload.subarray(8);
  if (pixels.byteLength !== width * height * 4) {
    throw new Error("QR response has an invalid pixel length");
  }
  return { width, height, rgbaPixels: pixels };
}

export function qrPayload(bitmap: QrBitmap): Uint8Array {
  const pixels = isUint8Array(bitmap.rgbaPixels)
    ? bitmap.rgbaPixels
    : Uint8Array.from(bitmap.rgbaPixels);
  const output = new Uint8Array(8 + pixels.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, bitmap.width, true);
  view.setUint32(4, bitmap.height, true);
  output.set(pixels, 8);
  return output;
}

/** Request/notification layer shared by the Tauri, Android and Worker adapters. */
export class BinaryRpcClient {
  private nextRequestId = BigInt(1);
  private nextSubscriptionId =
    BigInt(Date.now()) * BigInt(65_536) + BigInt(Math.floor(Math.random() * 65_536));
  private readonly listeners = new Set<(event: BackendEvent) => void>();
  private readonly unsubscribeRaw: () => void;
  private lastSequence = 0;
  private waitActive = false;
  private disposed = false;
  private subscriptionId = BigInt(0);
  private subscriptionReady: Promise<void> = Promise.resolve();
  private resyncInFlight: Promise<void> | undefined;

  constructor(private readonly transport: RawBinaryTransport) {
    this.unsubscribeRaw = transport.subscribe((bytes) => this.onFrame(bytes));
  }

  async call<T>(
    opcode: Opcode,
    value?: unknown,
    attachments: ReadonlyArray<unknown> = [],
  ): Promise<T> {
    const requestId = this.nextRequestId++;
    const frame = encodeFrame({
      kind: MessageKind.Request,
      opcode,
      requestId,
      sequence: BigInt(0),
      status: 0,
      payload: value === undefined ? new Uint8Array() : jsonBytes(value),
    });
    const response = decodeFrame(await this.transport.send(frame, attachments));
    if (
      response.opcode !== opcode ||
      (opcode !== Opcode.WaitEvent && response.kind !== MessageKind.Response)
    ) {
      throw new Error("Ponlet IPC response does not match the request");
    }
    if (response.status !== 0) {
      throw new Error(
        response.payload.byteLength
          ? new TextDecoder().decode(response.payload)
          : `Ponlet operation failed (${response.status})`,
      );
    }
    if (opcode === Opcode.QrCode) {
      return qrFromPayload(response.payload) as T;
    }
    if (response.payload.byteLength === 0) {
      return undefined as T;
    }
    return parseJson<T>(response.payload);
  }

  subscribe(listener: (event: BackendEvent) => void): () => void {
    const firstListener = this.listeners.size === 0;
    this.listeners.add(listener);
    if (firstListener) {
      this.subscriptionId = this.nextSubscriptionId++;
      const subscriptionId = this.subscriptionId;
      this.subscriptionReady = this.call<BackendSnapshot>(Opcode.Subscribe, {
        subscriptionId: subscriptionId.toString(),
      }).then((snapshot) => {
        if (this.disposed || this.listeners.size === 0 || this.subscriptionId !== subscriptionId) {
          return;
        }
        this.lastSequence = Math.max(this.lastSequence, snapshot.sequence);
        const event: BackendEvent = {
          type: "snapshot",
          sequence: snapshot.sequence,
          snapshot,
        };
        for (const callback of this.listeners) {
          callback(event);
        }
      });
      if (!this.transport.supportsPushEvents) {
        this.waitActive = true;
        void this.subscriptionReady.then(
          () => {
            if (this.waitActive && !this.disposed) {
              void this.waitLoop();
            }
          },
          () => {
            this.waitActive = false;
          },
        );
      }
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.waitActive = false;
        const subscriptionId = this.subscriptionId;
        this.subscriptionId = BigInt(0);
        this.sendUnsubscribe(subscriptionId);
      }
    };
  }

  close(): void {
    this.sendUnsubscribe(this.subscriptionId);
    this.disposed = true;
    this.waitActive = false;
    this.unsubscribeRaw();
    this.transport.close();
    this.listeners.clear();
  }

  private async waitLoop(): Promise<void> {
    while (this.waitActive && !this.disposed) {
      const requestId = this.nextRequestId++;
      const frame = encodeFrame({
        kind: MessageKind.WaitEvent,
        opcode: Opcode.WaitEvent,
        requestId,
        sequence: BigInt(this.lastSequence),
        status: 0,
        payload: jsonBytes({
          subscriptionId: this.subscriptionId.toString(),
          lastSequence: this.lastSequence,
        }),
      });
      try {
        const response = decodeFrame(await this.transport.send(frame));
        if (response.kind === MessageKind.Event) {
          this.dispatchEvent(response);
        } else {
          // A notification wait must stay outstanding until an event arrives.
          // Treat an empty response as a broken endpoint instead of turning it
          // into a periodic poll.
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } catch {
        if (this.waitActive) {
          // A disconnected transport must not turn into a tight empty poll.
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    }
  }

  private sendUnsubscribe(subscriptionId: bigint): void {
    if (subscriptionId === BigInt(0) || this.disposed) {
      return;
    }
    const frame = encodeFrame({
      kind: MessageKind.Unsubscribe,
      opcode: Opcode.Unsubscribe,
      requestId: this.nextRequestId++,
      sequence: BigInt(0),
      status: 0,
      payload: jsonBytes({ subscriptionId: subscriptionId.toString() }),
    });
    void this.transport.send(frame).catch(() => undefined);
  }

  private onFrame(bytes: Uint8Array): void {
    let frame: IpcFrame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      return;
    }
    if (frame.kind === MessageKind.Event) {
      this.dispatchEvent(frame);
    }
  }

  private dispatchEvent(frame: IpcFrame): void {
    let value: BackendEvent | Array<BackendEvent>;
    try {
      value = parseJson<BackendEvent | Array<BackendEvent>>(frame.payload);
    } catch {
      return;
    }
    const events = Array.isArray(value) ? value : [value];
    let expected = this.lastSequence;
    const accepted: Array<BackendEvent> = [];
    for (const event of events) {
      if (!event || !Number.isSafeInteger(event.sequence) || event.sequence <= expected) {
        continue;
      }
      if (event.sequence > expected + 1) {
        this.requestResync();
        return;
      }
      accepted.push(event);
      expected = event.sequence;
    }
    if (accepted.length === 0) {
      return;
    }
    this.lastSequence = expected;
    for (const event of accepted) {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }

  private requestResync(): void {
    if (this.resyncInFlight || this.disposed || this.listeners.size === 0) {
      return;
    }
    const resync = this.call<BackendSnapshot>(Opcode.Snapshot)
      .then((snapshot) => {
        if (this.disposed || this.listeners.size === 0) {
          return;
        }
        this.lastSequence = snapshot.sequence;
        const event: BackendEvent = { type: "snapshot", sequence: snapshot.sequence, snapshot };
        for (const listener of this.listeners) {
          listener(event);
        }
      })
      .catch(() => undefined);
    this.resyncInFlight = resync;
    void resync.then(() => {
      if (this.resyncInFlight === resync) {
        this.resyncInFlight = undefined;
      }
    });
  }
}
