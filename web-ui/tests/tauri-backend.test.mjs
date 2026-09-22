import { afterEach, expect, it, vi } from "vitest";
import { initialSnapshot } from "../src/api/application-api.ts";
import {
  decodeFrame,
  encodeFrame,
  jsonBytes,
  MessageKind,
  Opcode,
  parseJson,
  qrPayload,
} from "../src/ipc.ts";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  invoke.mockReset();
});

async function nativeBackend(binary, failOpcode) {
  const requests = [];
  const bitmap = { width: 1, height: 1, rgbaPixels: [1, 2, 3, 255] };
  invoke.mockImplementation(async (command) => {
    if (command === "ponlet_initialize_platform") {
      return "ios";
    }
    if (command === "ponlet_snapshot" || command === "ponlet_subscribe") {
      return initialSnapshot();
    }
    if (command === "ponlet_wait_event") {
      return new Promise(() => {});
    }
    if (command === "ponlet_qr_code") {
      return bitmap;
    }
  });
  if (binary) {
    const port = {
      onmessage: null,
      postMessage(bytes) {
        const request = decodeFrame(bytes);
        requests.push({
          opcode: request.opcode,
          payload: request.payload.length ? parseJson(request.payload) : undefined,
        });
        if (request.opcode === Opcode.WaitEvent) {
          return;
        }
        const payload =
          request.opcode === failOpcode
            ? new TextEncoder().encode("operation failed")
            : request.opcode === Opcode.Snapshot || request.opcode === Opcode.Subscribe
              ? jsonBytes(initialSnapshot())
              : request.opcode === Opcode.QrCode
                ? qrPayload(bitmap)
                : new Uint8Array();
        port.onmessage({
          data: encodeFrame({
            ...request,
            kind: MessageKind.Response,
            payload,
            status: request.opcode === failOpcode ? 1 : 0,
          }),
        });
      },
    };
    vi.stubGlobal("ponletbin", port);
  } else {
    vi.stubGlobal("BigInt", undefined);
  }
  const module = await import("../src/backends/tauri.ts");
  await module.initializeBrowserBackend();
  const backend = module.createBackend();
  await backend.snapshot();
  return { backend, requests };
}

for (const binary of [true, false]) {
  it(`preserves native operation arguments through ${binary ? "binary" : "JSON"} dispatch`, async () => {
    const { backend, requests } = await nativeBackend(binary);
    const file = new File(["abc"], "source.txt", { type: "text/plain" });
    Object.defineProperty(file, "path", { value: "/send/source.txt" });
    const files = [{ name: file.name, size: 3, mime: "text/plain", path: file.path }];
    const received = { name: "received.txt", size: 3, localPathOrHandle: "/received/item" };
    await backend.createInvite();
    await backend.join("invite");
    await backend.sendText("text");
    await backend.sendFiles([file]);
    await backend.pickAndSendFiles();
    await expect(backend.qrCode("qr-url")).resolves.toEqual({
      width: 1,
      height: 1,
      rgbaPixels: Uint8Array.of(1, 2, 3, 255),
    });
    await backend.cancelTransfer("transfer");
    await backend.openReceivedItem(received);
    await backend.saveText("saved");
    await backend.disconnect();
    const expected = [
      [Opcode.CreateInvite, "ponlet_create_invite", undefined, undefined],
      [Opcode.Join, "ponlet_join", "invite", { invite: "invite" }],
      [Opcode.SendText, "ponlet_send_text", "text", { text: "text" }],
      [Opcode.SendFiles, "ponlet_send_files", files, { files }],
      [Opcode.PickAndSendFiles, "ponlet_pick_and_send_files", undefined, undefined],
      [Opcode.QrCode, "ponlet_qr_code", "qr-url", { url: "qr-url" }],
      [Opcode.CancelTransfer, "ponlet_cancel_transfer", "transfer", { id: "transfer" }],
      [
        Opcode.OpenReceived,
        "ponlet_open_received",
        { localPathOrHandle: received.localPathOrHandle },
        { localPathOrHandle: received.localPathOrHandle },
      ],
      [Opcode.SaveText, "ponlet_save_text", "saved", { text: "saved" }],
      [Opcode.Disconnect, "ponlet_disconnect", undefined, undefined],
    ];
    if (binary) {
      expect(
        requests.filter(({ opcode }) => opcode > Opcode.Snapshot && opcode < Opcode.Subscribe),
      ).toEqual(expected.map(([opcode, , payload]) => ({ opcode, payload })));
      expect(
        invoke.mock.calls.filter(([command]) => expected.some(([, name]) => name === command)),
      ).toEqual([]);
    } else {
      const calls = invoke.mock.calls
        .filter(([command]) => expected.some(([, name]) => name === command))
        .map(([command, args]) => [command, args]);
      expect(calls).toEqual(expected.map(([, command, , args]) => [command, args]));
    }
    await backend.shareReceivedItem(received);
    expect(invoke).toHaveBeenCalledWith("ponlet_share_received", {
      localPathOrHandle: received.localPathOrHandle,
    });
    await backend.dispose();
  });
}

it("does not replay a failed binary mutation through JSON", async () => {
  const { backend } = await nativeBackend(true, Opcode.SendText);
  await expect(backend.sendText("once")).rejects.toThrow("operation failed");
  expect(invoke.mock.calls.some(([command]) => command === "ponlet_send_text")).toBe(false);
  await backend.dispose();
});
