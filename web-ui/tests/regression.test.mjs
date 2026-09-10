import { expect, it } from "vitest";
import { createBackend } from "../src/backend.ts";
import { initialSnapshot } from "../src/api/application-api.ts";
import { Session } from "../src/session.ts";
import { openOpfsSink } from "../src/opfs.ts";
import { placeAnchor } from "../src/lib/position.ts";

function navigatorWith(properties = {}) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { language: "en", ...properties },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function bridge(overrides = {}) {
  return {
    snapshot: async () => initialSnapshot(),
    subscribe: () => () => {},
    createInvite: async () => {},
    join: async () => {},
    sendText: async () => {},
    sendFiles: async () => {},
    cancelTransfer: async () => {},
    disconnect: async () => {},
    openReceivedItem: async () => {},
    dispose: async () => {},
    ...overrides,
  };
}

navigatorWith();

it("missing backend refuses connection and delivery", async () => {
  const backend = createBackend();
  const snapshot = await backend.snapshot();
  expect(snapshot.state).toBe("error");
  expect(snapshot.canSend).toBe(false);
  const events = [];
  backend.subscribe((event) => events.push(event));
  await expect(backend.join("anything")).rejects.toThrow(/unavailable/);
  await expect(backend.sendFiles([])).rejects.toThrow(/unavailable/);
  await expect(backend.sendText("hello")).rejects.toThrow(/unavailable/);
  expect(events).toEqual([]);
});

it("class adapters keep prototype methods and their receiver", async () => {
  class Adapter {
    calls = [];
    async snapshot() {
      this.calls.push("snapshot");
      return initialSnapshot();
    }
    subscribe() {
      this.calls.push("subscribe");
      return () => this.calls.push("unsubscribe");
    }
    async createInvite() {
      this.calls.push("invite");
    }
    async join() {}
    async sendText(text) {
      this.calls.push(text);
    }
    async sendFiles() {}
    async cancelTransfer() {}
    async disconnect() {}
    async dispose() {
      this.calls.push("dispose");
    }
  }
  const adapter = new Adapter();
  const backend = createBackend(adapter);
  await backend.snapshot();
  const unsubscribe = backend.subscribe(() => {});
  await backend.createInvite();
  await backend.sendText("hello");
  unsubscribe();
  await backend.dispose();
  expect(adapter.calls).toEqual([
    "snapshot",
    "subscribe",
    "invite",
    "hello",
    "unsubscribe",
    "dispose",
  ]);
});

it("forwards the native picker without requiring a JavaScript File object", async () => {
  let picked = 0;
  const backend = createBackend(
    bridge({
      pickAndSendFiles: async () => {
        picked++;
      },
    }),
  );
  expect(typeof backend.pickAndSendFiles).toBe("function");
  await backend.pickAndSendFiles();
  expect(picked).toBe(1);
});

it("forwards the QR renderer without adding a JavaScript QR dependency", async () => {
  const bitmap = { width: 2, height: 2, rgbaPixels: [0, 0, 0, 255, 255, 255, 255, 255] };
  const backend = createBackend(bridge({ qrCode: async () => bitmap }));
  await expect(backend.qrCode?.("https://example.test/#i=abc")).resolves.toEqual(bitmap);
});

it("opens received items through the adapter without exposing file bytes", async () => {
  const opened = [];
  const item = { name: "report.txt", size: 12, localPathOrHandle: "/tmp/report.txt" };
  const backend = createBackend(
    bridge({
      openReceivedItem: async (received) => opened.push(received),
    }),
  );
  await backend.openReceivedItem(item);
  expect(opened).toEqual([item]);
});

it("unsupported API version and unavailable clipboard reject", async () => {
  const backend = createBackend(
    bridge({ snapshot: async () => ({ ...initialSnapshot(), apiVersion: 2 }) }),
  );
  await expect(backend.snapshot()).rejects.toThrow(/API version/);
  navigatorWith();
  await expect(backend.copyText("hello")).rejects.toThrow(/Clipboard is unavailable/);
});

it("accepts the four transport path values exposed by native and browser adapters", async () => {
  const backend = createBackend(
    bridge({
      snapshot: async () => ({ ...initialSnapshot(), state: "connected", transport: "derp" }),
    }),
  );
  await expect(backend.snapshot()).resolves.toMatchObject({
    state: "connected",
    transport: "derp",
  });
  const invalid = createBackend(
    bridge({ snapshot: async () => ({ ...initialSnapshot(), transport: "quic" }) }),
  );
  await expect(invalid.snapshot()).rejects.toThrow(/transport path/);
});

it("late initial snapshot cannot overwrite newer subscription state", async () => {
  const first = deferred();
  let listener;
  const session = new Session(
    bridge({
      snapshot: () => first.promise,
      subscribe: (callback) => {
        listener = callback;
        return () => {};
      },
    }),
    () => {},
  );
  const started = session.start();
  listener({
    type: "snapshot",
    sequence: 2,
    snapshot: { ...initialSnapshot(), sequence: 2, state: "connected", canSend: true },
  });
  first.resolve(initialSnapshot());
  await started;
  expect(session.view.snapshot.state).toBe("connected");
  expect(session.view.snapshot.sequence).toBe(2);
});

it("text events advance the cursor and duplicate delivery is ignored", async () => {
  const session = new Session(bridge(), () => {});
  await session.start();
  const message = { type: "text", sequence: 5, text: "hello", incoming: true };
  session.applyEvent(message);
  session.applyEvent(message);
  session.applyEvent({
    type: "snapshot",
    sequence: 4,
    snapshot: { ...initialSnapshot(), sequence: 4 },
  });
  expect(session.view.snapshot.sequence).toBe(5);
  expect(session.view.messages.length).toBe(1);
  expect(session.view.lastReceivedText).toBe("hello");
});

it("keeps received file metadata in the UI snapshot", async () => {
  const session = new Session(bridge(), () => {});
  await session.start();
  session.applyEvent({
    type: "files",
    sequence: 2,
    items: [{ name: "report.txt", size: 12, localPathOrHandle: "opfs:/Ponlet/report.txt" }],
  });
  expect(session.view.snapshot.received).toEqual([
    { name: "report.txt", size: 12, localPathOrHandle: "opfs:/Ponlet/report.txt" },
  ]);
});

it("old transfer completion cannot clear the currently active transfer", async () => {
  const session = new Session(bridge(), () => {});
  await session.start();
  session.applyEvent({
    type: "snapshot",
    sequence: 2,
    snapshot: {
      ...initialSnapshot(),
      sequence: 2,
      state: "transferring",
      transfer: {
        id: "new",
        name: "new.bin",
        done: 0,
        total: 100,
        incoming: true,
        status: "receiving",
      },
    },
  });
  session.applyEvent({ type: "terminal", sequence: 3, id: "old", status: "completed" });
  expect(session.view.snapshot.transfer.id).toBe("new");
  expect(session.view.snapshot.state).toBe("transferring");
});

it("dispose is idempotent and late snapshot responses cannot update the UI", async () => {
  const first = deferred();
  let cleanups = 0;
  let disposals = 0;
  let updates = 0;
  const session = new Session(
    bridge({
      snapshot: () => first.promise,
      subscribe: () => () => {
        cleanups++;
      },
      dispose: async () => {
        disposals++;
      },
    }),
    () => {
      updates++;
    },
  );
  const started = session.start();
  await session.dispose();
  await session.dispose();
  first.resolve({ ...initialSnapshot(), sequence: 3 });
  await started;
  expect(cleanups).toBe(1);
  expect(disposals).toBe(1);
  expect(updates).toBe(0);
});

function opfs({ failAt, writeGate, closeGate, closeStarted, moveGate, moveStarted } = {}) {
  const entries = new Map();
  const positions = [];
  const directory = {
    async getFileHandle(name) {
      const file = { bytes: [], name };
      entries.set(name, file);
      return {
        async createWritable() {
          if (failAt === "create") {
            throw new Error("create failed");
          }
          return {
            async write({ position, data }) {
              if (writeGate) {
                await writeGate.promise;
              }
              if (failAt === "write") {
                throw new Error("quota exceeded");
              }
              positions.push(position);
              for (let i = 0; i < data.length; i++) {
                file.bytes[position + i] = data[i];
              }
            },
            async close() {
              closeStarted?.resolve();
              if (closeGate) {
                await closeGate.promise;
              }
              if (failAt === "close") {
                throw new Error("close failed");
              }
            },
            async abort() {},
          };
        },
        async move(next) {
          moveStarted?.resolve();
          if (moveGate) {
            await moveGate.promise;
          }
          if (failAt === "move") {
            throw new Error("move failed");
          }
          entries.delete(file.name);
          file.name = next;
          entries.set(next, file);
        },
      };
    },
    async removeEntry(name) {
      entries.delete(name);
    },
  };
  navigatorWith({
    storage: {
      async getDirectory() {
        return {
          async getDirectoryHandle() {
            return directory;
          },
        };
      },
    },
  });
  return { entries, positions };
}

it("OPFS writes are serialized and abort after commit preserves the saved file", async () => {
  const fake = opfs();
  const sink = await openOpfsSink("name".repeat(200), 4);
  await Promise.all([sink.write(new Uint8Array([1, 2])), sink.write(new Uint8Array([3, 4]))]);
  const item = await sink.commit();
  await sink.abort();
  expect(fake.positions).toEqual([0, 2]);
  expect(fake.entries.size).toBe(1);
  expect(fake.entries.get(item.handleName).bytes).toEqual([1, 2, 3, 4]);
  expect(item.handleName.length).toBeLessThan(80);
  expect(item.handleName.endsWith(".complete")).toBe(true);
});

for (const failAt of ["create", "write", "close", "move"]) {
  it(`OPFS ${failAt} failure removes the partial entry`, async () => {
    const fake = opfs({ failAt });
    if (failAt === "create") {
      await expect(openOpfsSink("file", 1)).rejects.toThrow(/failed/);
    } else {
      const sink = await openOpfsSink("file", 1);
      if (failAt === "write") {
        await expect(sink.write(new Uint8Array([1]))).rejects.toThrow(/quota/);
      } else {
        await sink.write(new Uint8Array([1]));
        await expect(sink.commit()).rejects.toThrow(/failed/);
      }
    }
    expect(fake.entries.size).toBe(0);
  });
}

it("OPFS wrong byte counts remove partial entries", async () => {
  for (const size of [0, 2]) {
    const fake = opfs();
    const sink = await openOpfsSink("file", size);
    if (size === 0) {
      await expect(sink.write(new Uint8Array([1]))).rejects.toThrow(/more bytes/);
    } else {
      await sink.write(new Uint8Array([1]));
      await expect(sink.commit()).rejects.toThrow(/mismatch/);
    }
    expect(fake.entries.size).toBe(0);
  }
});

for (const phase of ["close", "move"]) {
  it(`OPFS cancellation during ${phase} cannot leave a completed file`, async () => {
    const gate = deferred();
    const started = deferred();
    const fake = opfs({ [`${phase}Gate`]: gate, [`${phase}Started`]: started });
    const sink = await openOpfsSink("file", 0);
    const commit = sink.commit();
    await started.promise;
    const abort = sink.abort();
    gate.resolve();
    await expect(commit).rejects.toThrow(/closed/);
    await abort;
    expect(fake.entries.size).toBe(0);
  });
}

it("popover clamps to the visible viewport including its offset", () => {
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: { width: 200, height: 150, offsetLeft: 30, offsetTop: 100 },
  });
  const floating = { style: {}, getBoundingClientRect: () => ({ width: 80, height: 50 }) };
  placeAnchor(
    { getBoundingClientRect: () => ({ left: 220, right: 240, top: 240, bottom: 260 }) },
    floating,
  );
  expect(floating.style.left).toBe("142px");
  expect(floating.style.top).toBe("182px");
  Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
});
