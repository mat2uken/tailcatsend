import { afterEach, expect, it, vi } from "vitest";

async function workerProxy() {
  const commands = [];
  const goPort = {
    onmessage: null,
    start() {},
    postMessage(message) {
      commands.push(message);
    },
  };
  const workerPost = vi.fn();
  vi.stubGlobal("postMessage", workerPost);
  vi.stubGlobal("onmessage", undefined);
  vi.stubGlobal("tailSendTailcat", undefined);
  vi.stubGlobal("__ponletPrepareReceivedFile", undefined);
  vi.stubGlobal("__ponletBackend", { subscribe: () => () => {} });
  await import("../src/worker.ts");
  globalThis.onmessage({
    data: {
      type: "init",
      goPort,
      rpcPort: { start() {}, postMessage() {} },
      wasmUrl:
        "data:text/javascript,export default async function(){};export function install_backend(){}",
    },
  });
  await vi.waitFor(() => expect(workerPost).toHaveBeenCalledWith({ type: "ready", ok: true }));
  const reply = (request, ok = true, value = undefined) =>
    goPort.onmessage({ data: { type: "response", requestId: request.requestId, ok, value } });
  const incoming = (listenerId, connectionId) =>
    goPort.onmessage({
      data: { type: "incoming", listenerId, connectionId, port: 100, transportType: 2 },
    });
  return { commands, incoming, proxy: globalThis.tailSendTailcat, reply };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("closes connections arriving while their listener close is awaiting its reply", async () => {
  const { commands, incoming, proxy, reply } = await workerProxy();
  const accepted = vi.fn();
  const listening = proxy.listen({ onConnection: accepted });
  const listenRequest = commands.at(-1);
  reply(listenRequest, true, { address: "listener-address" });
  const listener = await listening;
  const closing = listener.close();
  const closeRequest = commands.at(-1);
  incoming(listenRequest.listenerId, "late-connection");
  reply(closeRequest);
  await closing;
  expect(accepted).not.toHaveBeenCalled();
  const connectionCloses = commands.filter((command) => command.type === "stream-close");
  expect(connectionCloses).toEqual([
    { type: "stream-close", requestId: expect.any(Number), connectionId: "late-connection" },
  ]);
  reply(connectionCloses[0]);
});

it("closes connections arriving after listener creation has failed", async () => {
  const { commands, incoming, proxy, reply } = await workerProxy();
  const accepted = vi.fn();
  const listening = expect(proxy.listen({ onConnection: accepted })).rejects.toThrow(
    "Go bridge request failed",
  );
  const listenRequest = commands.at(-1);
  reply(listenRequest, false);
  await listening;
  incoming(listenRequest.listenerId, "rejected-listener-connection");
  expect(accepted).not.toHaveBeenCalled();
  const connectionCloses = commands.filter((command) => command.type === "stream-close");
  expect(connectionCloses).toEqual([
    {
      type: "stream-close",
      requestId: expect.any(Number),
      connectionId: "rejected-listener-connection",
    },
  ]);
  // A close failure must not escape the message handler as an unhandled rejection.
  reply(connectionCloses[0], false);
  await Promise.resolve();
});

it("delivers connections to an active listener without closing them", async () => {
  const { commands, incoming, proxy, reply } = await workerProxy();
  const accepted = vi.fn();
  const listening = proxy.listen({ onConnection: accepted });
  const request = commands.at(-1);
  reply(request, true, { address: "active-listener" });
  const listener = await listening;
  incoming(request.listenerId, "accepted-connection");
  expect(accepted).toHaveBeenCalledOnce();
  expect(accepted.mock.calls[0][0]).toMatchObject({ port: 100, transportType: 2 });
  expect(commands.filter((command) => command.type === "stream-close")).toEqual([]);
  const closing = listener.close();
  reply(commands.at(-1));
  await closing;
});
