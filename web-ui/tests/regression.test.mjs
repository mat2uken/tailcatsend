import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

// Use the existing build tool to load TypeScript; no second transpiler or
// test runtime is needed, and these tests never start a network listener.
const vite = await createServer({ mode: 'web', server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => vite.close());
const { createBackend } = await vite.ssrLoadModule('/src/backend.ts');
const { initialSnapshot } = await vite.ssrLoadModule('/src/api/application-api.ts');
const { Session } = await vite.ssrLoadModule('/src/session.ts');
const { openOpfsSink } = await vite.ssrLoadModule('/src/opfs.ts');
const { placeAnchor } = await vite.ssrLoadModule('/src/lib/position.ts');

function navigatorWith(properties = {}) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en', ...properties } });
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function bridge(overrides = {}) {
  return {
    snapshot: async () => initialSnapshot(), subscribe: () => () => {},
    createInvite: async () => {}, join: async () => {}, sendText: async () => {},
    sendFiles: async () => {}, cancelTransfer: async () => {}, disconnect: async () => {},
    dispose: async () => {}, ...overrides,
  };
}

navigatorWith();
globalThis.window = {};

test('missing backend refuses connection and delivery', async () => {
  const backend = createBackend();
  const snapshot = await backend.snapshot();
  assert.equal(snapshot.state, 'error');
  assert.equal(snapshot.canSend, false);
  const events = [];
  backend.subscribe((event) => events.push(event));
  await assert.rejects(backend.join('anything'), /unavailable/);
  await assert.rejects(backend.sendFiles([]), /unavailable/);
  await assert.rejects(backend.sendText('hello'), /unavailable/);
  assert.deepEqual(events, []);
});

test('class adapters keep prototype methods and their receiver', async () => {
  class Adapter {
    calls = [];
    async snapshot() { this.calls.push('snapshot'); return initialSnapshot(); }
    subscribe() { this.calls.push('subscribe'); return () => this.calls.push('unsubscribe'); }
    async createInvite() { this.calls.push('invite'); }
    async join() {}
    async sendText(text) { this.calls.push(text); }
    async sendFiles() {}
    async cancelTransfer() {}
    async disconnect() {}
    async dispose() { this.calls.push('dispose'); }
  }
  const adapter = new Adapter();
  const backend = createBackend(adapter);
  await backend.snapshot();
  const unsubscribe = backend.subscribe(() => {});
  await backend.createInvite();
  await backend.sendText('hello');
  unsubscribe();
  await backend.dispose();
  assert.deepEqual(adapter.calls, ['snapshot', 'subscribe', 'invite', 'hello', 'unsubscribe', 'dispose']);
});

test('unsupported API version and unavailable clipboard reject', async () => {
  const backend = createBackend(bridge({ snapshot: async () => ({ ...initialSnapshot(), apiVersion: 2 }) }));
  await assert.rejects(backend.snapshot(), /API version/);
  navigatorWith();
  await assert.rejects(backend.copyText('hello'), /Clipboard is unavailable/);
});

test('late initial snapshot cannot overwrite newer subscription state', async () => {
  const first = deferred();
  let listener;
  const session = new Session(bridge({ snapshot: () => first.promise, subscribe: (callback) => { listener = callback; return () => {}; } }), () => {});
  const started = session.start();
  listener({ type: 'snapshot', sequence: 2, snapshot: { ...initialSnapshot(), sequence: 2, state: 'connected', canSend: true } });
  first.resolve(initialSnapshot());
  await started;
  assert.equal(session.view.snapshot.state, 'connected');
  assert.equal(session.view.snapshot.sequence, 2);
});

test('text events advance the cursor and duplicate delivery is ignored', async () => {
  const session = new Session(bridge(), () => {});
  await session.start();
  const message = { type: 'text', sequence: 5, text: 'hello', incoming: true };
  session.applyEvent(message);
  session.applyEvent(message);
  session.applyEvent({ type: 'snapshot', sequence: 4, snapshot: { ...initialSnapshot(), sequence: 4 } });
  assert.equal(session.view.snapshot.sequence, 5);
  assert.equal(session.view.messages.length, 1);
  assert.equal(session.view.lastReceivedText, 'hello');
});

test('old transfer completion cannot clear the currently active transfer', async () => {
  const session = new Session(bridge(), () => {});
  await session.start();
  session.applyEvent({ type: 'snapshot', sequence: 2, snapshot: { ...initialSnapshot(), sequence: 2, state: 'transferring', transfer: { id: 'new', name: 'new.bin', done: 0, total: 100, incoming: true, status: 'receiving' } } });
  session.applyEvent({ type: 'terminal', sequence: 3, id: 'old', status: 'completed' });
  assert.equal(session.view.snapshot.transfer.id, 'new');
  assert.equal(session.view.snapshot.state, 'transferring');
});

test('dispose is idempotent and late snapshot responses cannot update the UI', async () => {
  const first = deferred();
  let cleanups = 0;
  let disposals = 0;
  let updates = 0;
  const session = new Session(bridge({ snapshot: () => first.promise, subscribe: () => () => { cleanups++; }, dispose: async () => { disposals++; } }), () => { updates++; });
  const started = session.start();
  await session.dispose();
  await session.dispose();
  first.resolve({ ...initialSnapshot(), sequence: 3 });
  await started;
  assert.equal(cleanups, 1);
  assert.equal(disposals, 1);
  assert.equal(updates, 0);
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
          if (failAt === 'create') throw new Error('create failed');
          return {
            async write({ position, data }) {
              if (writeGate) await writeGate.promise;
              if (failAt === 'write') throw new Error('quota exceeded');
              positions.push(position);
              for (let i = 0; i < data.length; i++) file.bytes[position + i] = data[i];
            },
            async close() {
              closeStarted?.resolve();
              if (closeGate) await closeGate.promise;
              if (failAt === 'close') throw new Error('close failed');
            },
            async abort() {},
          };
        },
        async move(next) {
          moveStarted?.resolve();
          if (moveGate) await moveGate.promise;
          if (failAt === 'move') throw new Error('move failed');
          entries.delete(file.name);
          file.name = next;
          entries.set(next, file);
        },
      };
    },
    async removeEntry(name) { entries.delete(name); },
  };
  navigatorWith({ storage: { async getDirectory() { return { async getDirectoryHandle() { return directory; } }; } } });
  return { entries, positions };
}

test('OPFS writes are serialized and abort after commit preserves the saved file', async () => {
  const fake = opfs();
  const sink = await openOpfsSink('name'.repeat(200), 4);
  await Promise.all([sink.write(new Uint8Array([1, 2])), sink.write(new Uint8Array([3, 4]))]);
  const item = await sink.commit();
  await sink.abort();
  assert.deepEqual(fake.positions, [0, 2]);
  assert.equal(fake.entries.size, 1);
  assert.deepEqual(fake.entries.get(item.handleName).bytes, [1, 2, 3, 4]);
  assert.ok(item.handleName.length < 80);
  assert.ok(item.handleName.endsWith('.complete'));
});

for (const failAt of ['create', 'write', 'close', 'move']) {
  test(`OPFS ${failAt} failure removes the partial entry`, async () => {
    const fake = opfs({ failAt });
    if (failAt === 'create') {
      await assert.rejects(openOpfsSink('file', 1), /failed/);
    } else {
      const sink = await openOpfsSink('file', 1);
      if (failAt === 'write') await assert.rejects(sink.write(new Uint8Array([1])), /quota/);
      else {
        await sink.write(new Uint8Array([1]));
        await assert.rejects(sink.commit(), /failed/);
      }
    }
    assert.equal(fake.entries.size, 0);
  });
}

test('OPFS wrong byte counts remove partial entries', async () => {
  for (const size of [0, 2]) {
    const fake = opfs();
    const sink = await openOpfsSink('file', size);
    if (size === 0) await assert.rejects(sink.write(new Uint8Array([1])), /more bytes/);
    else { await sink.write(new Uint8Array([1])); await assert.rejects(sink.commit(), /mismatch/); }
    assert.equal(fake.entries.size, 0);
  }
});

for (const phase of ['close', 'move']) {
  test(`OPFS cancellation during ${phase} cannot leave a completed file`, async () => {
    const gate = deferred();
    const started = deferred();
    const fake = opfs({ [`${phase}Gate`]: gate, [`${phase}Started`]: started });
    const sink = await openOpfsSink('file', 0);
    const commit = sink.commit();
    await started.promise;
    const abort = sink.abort();
    gate.resolve();
    await assert.rejects(commit, /closed/);
    await abort;
    assert.equal(fake.entries.size, 0);
  });
}

test('popover clamps to the visible viewport including its offset', () => {
  globalThis.window = { visualViewport: { width: 200, height: 150, offsetLeft: 30, offsetTop: 100 } };
  const floating = { style: {}, getBoundingClientRect: () => ({ width: 80, height: 50 }) };
  placeAnchor({ getBoundingClientRect: () => ({ left: 220, right: 240, top: 240, bottom: 260 }) }, floating);
  assert.equal(floating.style.left, '142px');
  assert.equal(floating.style.top, '182px');
  globalThis.window = {};
});
