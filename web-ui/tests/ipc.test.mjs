import { expect, it } from "vitest";
import {
  BinaryRpcClient,
  decodeFrame,
  encodeFrame,
  jsonBytes,
  MessageKind,
  Opcode,
  PortBinaryTransport,
  qrPayload,
} from "../src/ipc.ts";

class FakePort {
  listeners = new Set();
  peer;

  addEventListener(_type, listener) {
    this.listeners.add(listener);
  }

  removeEventListener(_type, listener) {
    this.listeners.delete(listener);
  }

  start() {}

  close() {}

  postMessage(data) {
    queueMicrotask(() => {
      for (const listener of this.peer.listeners) {
        listener({ data });
      }
    });
  }
}

function portPair() {
  const left = new FakePort();
  const right = new FakePort();
  left.peer = right;
  right.peer = left;
  return { left, right };
}

function snapshotFixture(sequence) {
  return {
    apiVersion: 2,
    sequence,
    state: "booting",
    peerName: "",
    inviteUrl: null,
    inviteExpiresInSecs: 0,
    canSend: false,
    canDisconnect: false,
    transfer: null,
    error: null,
    transport: "unknown",
    received: [],
  };
}

it("round trips a binary header without changing identifiers", () => {
  const frame = encodeFrame({
    kind: MessageKind.Event,
    opcode: Opcode.WaitEvent,
    requestId: 9n,
    sequence: 12n,
    status: 0,
    payload: Uint8Array.of(0, 1, 255),
  });
  expect(decodeFrame(frame)).toMatchObject({
    kind: MessageKind.Event,
    opcode: Opcode.WaitEvent,
    requestId: 9n,
    sequence: 12n,
    payload: Uint8Array.of(0, 1, 255),
  });
});

it("uses one MessagePort for replies, pushed notifications, and QR bytes", async () => {
  const { left, right } = portPair();
  right.addEventListener("message", (event) => {
    const request = decodeFrame(event.data);
    if (request.opcode === Opcode.QrCode) {
      const pixels = Uint8Array.of(1, 2, 3, 4);
      right.postMessage(
        encodeFrame({
          kind: MessageKind.Response,
          opcode: request.opcode,
          requestId: request.requestId,
          sequence: 0n,
          status: 0,
          payload: qrPayload({ width: 1, height: 1, rgbaPixels: pixels }),
        }).buffer,
      );
    } else if (request.opcode === Opcode.Subscribe || request.opcode === Opcode.Unsubscribe) {
      right.postMessage(
        encodeFrame({
          kind: MessageKind.Response,
          opcode: request.opcode,
          requestId: request.requestId,
          sequence: 0n,
          status: 0,
          payload:
            request.opcode === Opcode.Subscribe
              ? jsonBytes({
                  apiVersion: 2,
                  sequence: 0,
                  state: "booting",
                  peerName: "",
                  inviteUrl: null,
                  inviteExpiresInSecs: 0,
                  canSend: false,
                  canDisconnect: false,
                  transfer: null,
                  error: null,
                  transport: "unknown",
                  received: [],
                })
              : new Uint8Array(),
        }).buffer,
      );
    }
  });
  const transport = new PortBinaryTransport(left, true);
  const client = new BinaryRpcClient(transport);
  await expect(client.call(Opcode.QrCode, "https://example.test")).resolves.toEqual({
    width: 1,
    height: 1,
    rgbaPixels: Uint8Array.of(1, 2, 3, 4),
  });
  const events = [];
  const unsubscribe = client.subscribe((event) => events.push(event));
  const event = encodeFrame({
    kind: MessageKind.Event,
    opcode: Opcode.WaitEvent,
    requestId: 0n,
    sequence: 1n,
    status: 0,
    payload: new TextEncoder().encode(
      JSON.stringify({ type: "text", sequence: 1, text: "通知", incoming: true }),
    ),
  });
  right.postMessage(event.buffer);
  await new Promise((resolve) => queueMicrotask(resolve));
  expect(events.filter((value) => value.type === "text")).toEqual([
    { type: "text", sequence: 1, text: "通知", incoming: true },
  ]);
  unsubscribe();
  client.close();
});

it("requests a snapshot when a notification sequence has a gap", async () => {
  const { left, right } = portPair();
  right.addEventListener("message", (event) => {
    const request = decodeFrame(event.data);
    if (request.opcode === Opcode.Subscribe || request.opcode === Opcode.Snapshot) {
      right.postMessage(
        encodeFrame({
          kind: MessageKind.Response,
          opcode: request.opcode,
          requestId: request.requestId,
          sequence: 0n,
          status: 0,
          payload: jsonBytes(snapshotFixture(request.opcode === Opcode.Snapshot ? 2 : 0)),
        }).buffer,
      );
    } else if (request.opcode === Opcode.Unsubscribe) {
      right.postMessage(
        encodeFrame({
          kind: MessageKind.Response,
          opcode: request.opcode,
          requestId: request.requestId,
          sequence: 0n,
          status: 0,
          payload: new Uint8Array(),
        }).buffer,
      );
    }
  });
  const client = new BinaryRpcClient(new PortBinaryTransport(left, true));
  const events = [];
  const unsubscribe = client.subscribe((event) => events.push(event));
  await new Promise((resolve) => queueMicrotask(resolve));
  right.postMessage(
    encodeFrame({
      kind: MessageKind.Event,
      opcode: Opcode.WaitEvent,
      requestId: 0n,
      sequence: 2n,
      status: 0,
      payload: jsonBytes({ type: "text", sequence: 2, text: "欠落", incoming: true }),
    }).buffer,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(events.some((event) => event.type === "snapshot" && event.sequence === 2)).toBe(true);
  expect(events.some((event) => event.type === "text")).toBe(false);
  unsubscribe();
  client.close();
});

it("accepts a complete snapshot across a gap without discarding recovered messages", async () => {
  const { left, right } = portPair();
  let resyncs = 0;
  right.addEventListener("message", (event) => {
    const request = decodeFrame(event.data);
    if (request.opcode === Opcode.Snapshot) {
      resyncs++;
    }
    right.postMessage(
      encodeFrame({
        kind: MessageKind.Response,
        opcode: request.opcode,
        requestId: request.requestId,
        sequence: 0n,
        status: 0,
        payload:
          request.opcode === Opcode.Subscribe ? jsonBytes(snapshotFixture(0)) : new Uint8Array(),
      }).buffer,
    );
  });
  const client = new BinaryRpcClient(new PortBinaryTransport(left, true));
  const events = [];
  const unsubscribe = client.subscribe((event) => events.push(event));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const snapshot = {
    ...snapshotFixture(10),
    receivedMessages: [{ sequence: 7, text: "recovered" }],
  };
  right.postMessage(
    encodeFrame({
      kind: MessageKind.Event,
      opcode: Opcode.WaitEvent,
      requestId: 0n,
      sequence: 10n,
      status: 0,
      payload: jsonBytes({ type: "snapshot", sequence: 10, snapshot }),
    }).buffer,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(resyncs).toBe(0);
  expect(events.at(-1).snapshot.receivedMessages).toEqual([{ sequence: 7, text: "recovered" }]);
  unsubscribe();
  client.close();
});
