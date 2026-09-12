import { expect, it, vi } from "vitest";
import { Session } from "../src/session.ts";
import { initialSnapshot } from "../src/api/application-api.ts";
function sessionWith(snapshot = initialSnapshot()) {
  return new Session(
    { snapshot: async () => snapshot, subscribe: () => () => {}, dispose: async () => {} },
    () => {},
  );
}
function snapshotEvent(sequence, extra = {}) {
  return {
    type: "snapshot",
    sequence,
    snapshot: { ...initialSnapshot(), sequence, state: "connected", ...extra },
  };
}
it("recovers missed incoming messages in newest order without duplicate events", async () => {
  const session = sessionWith();
  await session.start();
  session.applyEvent({ type: "text", sequence: 2, incoming: true, text: "first" });
  session.applyEvent({ type: "text", sequence: 3, incoming: false, text: "reply" });
  session.applyEvent(
    snapshotEvent(6, {
      receivedMessages: [
        { sequence: 2, text: "first" },
        { sequence: 5, text: "missed" },
      ],
    }),
  );
  session.applyEvent({ type: "text", sequence: 5, incoming: true, text: "missed" });
  expect(session.view.messages.map((item) => item.text)).toEqual(["missed", "reply", "first"]);
  expect(session.view.lastReceivedText).toBe("missed");
  session.applyEvent(snapshotEvent(4, { receivedMessages: [{ sequence: 4, text: "stale" }] }));
  expect(session.view.messages).toHaveLength(3);
});
it("does not restore cleared history from a later snapshot", async () => {
  const session = sessionWith();
  await session.start();
  session.applyEvent(
    snapshotEvent(5, { receivedMessages: [{ sequence: 2, text: "private old text" }] }),
  );
  session.clearHistory();
  session.applyEvent(
    snapshotEvent(9, {
      receivedMessages: [
        { sequence: 2, text: "private old text" },
        { sequence: 8, text: "new" },
      ],
    }),
  );
  expect(session.view.messages.map((item) => item.text)).toEqual(["new"]);
  expect(session.view.lastReceivedText).toBe("new");
});
it("keeps an explicit terminal result after a connected snapshot clears progress", async () => {
  const session = sessionWith();
  await session.start();
  const transfer = {
    id: "file",
    name: "report.txt",
    done: 0,
    total: 1000,
    incoming: false,
    status: "sending",
  };
  vi.spyOn(Date, "now")
    .mockReturnValueOnce(1000)
    .mockReturnValueOnce(1000)
    .mockReturnValueOnce(2000);
  session.applyEvent(snapshotEvent(2, { state: "transferring", transfer }));
  session.applyEvent({ type: "progress", sequence: 3, id: "file", done: 500, total: 1000 });
  expect(session.view.transferBytesPerSecond).toBe(500);
  session.applyEvent(snapshotEvent(4));
  session.applyEvent({ type: "terminal", sequence: 5, id: "file", status: "cancelled" });
  expect(session.view.lastTransfer).toMatchObject({
    name: "report.txt",
    incoming: false,
    status: "cancelled",
    done: 500,
  });
  expect(session.view.snapshot.transfer).toBeNull();
  session.dismissTransfer();
  expect(session.view.lastTransfer).toBeNull();
  vi.restoreAllMocks();
});

it("records successful sends without requiring an outgoing backend event", async () => {
  const session = sessionWith();
  await session.start();
  session.recordSentText("repeat");
  session.recordSentText("repeat");
  expect(session.view.messages.map((message) => message.text)).toEqual(["repeat", "repeat"]);
  session.applyEvent(snapshotEvent(4, { receivedMessages: [{ sequence: 3, text: "reply" }] }));
  expect(session.view.messages.map((message) => message.text)).toEqual([
    "reply",
    "repeat",
    "repeat",
  ]);
});
it("does not duplicate an outgoing event emitted during the same send", async () => {
  const session = sessionWith();
  await session.start();
  const previous = session.view.messages;
  session.applyEvent({ type: "text", sequence: 2, incoming: false, text: "hello" });
  session.recordSentText("hello", previous);
  expect(session.view.messages).toHaveLength(1);
  // Sending identical text again is a distinct delivery.
  session.recordSentText("hello", session.view.messages);
  expect(session.view.messages).toHaveLength(2);
});

it.each(["completed", "cancelled", "failed"])(
  "restores a %s transfer from a snapshot even when its event was skipped",
  async (status) => {
    const session = sessionWith();
    await session.start();
    const lastTransfer = {
      id: "restored",
      name: "sent.bin",
      done: 42,
      total: 42,
      incoming: false,
      status,
      message: status === "failed" ? "disk full" : null,
    };
    session.applyEvent(snapshotEvent(10, { lastTransfer }));
    session.applyEvent({ type: "terminal", sequence: 9, id: "restored", status });
    expect(session.view.lastTransfer).toEqual({
      ...lastTransfer,
      message: lastTransfer.message ?? undefined,
    });
    expect(session.view.snapshot.transfer).toBeNull();
  },
);
it("does not revive a dismissed transfer from repeated snapshots or a delayed terminal event", async () => {
  const session = sessionWith();
  await session.start();
  const transfer = {
    id: "dismissed",
    name: "received.txt",
    done: 12,
    total: 12,
    incoming: true,
    status: "receiving",
  };
  session.applyEvent(snapshotEvent(2, { state: "transferring", transfer }));
  session.applyEvent(snapshotEvent(4, { lastTransfer: { ...transfer, status: "completed" } }));
  session.dismissTransfer();
  session.applyEvent(snapshotEvent(6, { lastTransfer: { ...transfer, status: "completed" } }));
  session.applyEvent({ type: "terminal", sequence: 7, id: transfer.id, status: "completed" });
  expect(session.view.lastTransfer).toBeNull();
  session.applyEvent(
    snapshotEvent(8, { lastTransfer: { ...transfer, id: "next", status: "cancelled" } }),
  );
  expect(session.view.lastTransfer).toMatchObject({ id: "next", status: "cancelled" });
  session.applyEvent(snapshotEvent(5, { lastTransfer: { ...transfer, status: "completed" } }));
  expect(session.view.lastTransfer.id).toBe("next");
});
