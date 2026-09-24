import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { initialSnapshot } from "../src/api/application-api.ts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  invoke.mockReset();
  listen.mockReset();
  vi.resetModules();
});

function setupMac(scan) {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no binary scheme")));
  vi.stubGlobal("ponletbin", undefined);
  invoke.mockImplementation((command) => {
    if (command === "ponlet_initialize_platform") {
      return Promise.resolve("macos");
    }
    if (command === "ponlet_snapshot" || command === "ponlet_subscribe") {
      return Promise.resolve(initialSnapshot());
    }
    if (command === "ponlet_wait_event") {
      return new Promise(() => {});
    }
    if (command === "ponlet_scan_qr") {
      return scan.promise;
    }
    return Promise.resolve();
  });
}

it("scans in the macOS process, stops on cancel and ignores a late result", async () => {
  const first = deferred();
  let scans = 0;
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no binary scheme")));
  vi.stubGlobal("ponletbin", undefined);
  invoke.mockImplementation((command) => {
    if (command === "ponlet_initialize_platform") {
      return Promise.resolve("macos");
    }
    if (command === "ponlet_snapshot" || command === "ponlet_subscribe") {
      return Promise.resolve(initialSnapshot());
    }
    if (command === "ponlet_wait_event") {
      return new Promise(() => {});
    }
    if (command === "ponlet_scan_qr") {
      return ++scans === 1 ? first.promise : Promise.resolve("https://ponlet.example/#i=invite");
    }
    return Promise.resolve();
  });
  const { createBackend, initializeBrowserBackend } = await import("../src/backends/tauri.ts");
  await initializeBrowserBackend();
  const backend = createBackend();
  try {
    expect(backend.scanQr).toBeTypeOf("function");
    const stale = backend.scanQr();
    const id = invoke.mock.calls.find(([command]) => command === "ponlet_scan_qr")[1].scanId;
    await backend.cancelScan();
    expect(invoke).toHaveBeenCalledWith("ponlet_cancel_scan", { scanId: id });
    first.resolve("https://ponlet.example/#i=stale");
    await expect(stale).resolves.toBeNull();
    await expect(backend.scanQr()).resolves.toBe("https://ponlet.example/#i=invite");
    expect(
      invoke.mock.calls.filter(([command]) => command.startsWith("plugin:barcode-scanner")),
    ).toHaveLength(0);
  } finally {
    await backend.dispose();
  }
});

it("subscribes before scanning, shows only matching frames and unsubscribes on success", async () => {
  const scan = deferred();
  const unlisten = vi.fn();
  let emit;
  setupMac(scan);
  listen.mockImplementation(async (_event, handler) => {
    emit = (payload) => handler({ payload });
    return unlisten;
  });
  const { createBackend, initializeBrowserBackend } = await import("../src/backends/tauri.ts");
  await initializeBrowserBackend();
  const backend = createBackend();
  try {
    const previews = [];
    const pending = backend.scanQrWithPreview((image) => previews.push(image));
    expect(listen).toHaveBeenCalledWith("ponlet-qr-preview", expect.any(Function));
    expect(invoke.mock.calls.some(([command]) => command === "ponlet_scan_qr")).toBe(false);
    await Promise.resolve();
    const id = invoke.mock.calls.find(([command]) => command === "ponlet_scan_qr")[1].scanId;
    emit({ scanId: id + 1, image: "data:image/jpeg;base64,bad" });
    emit({ scanId: id, image: "not an image" });
    emit({ scanId: id, image: "data:image/jpeg;base64,frame" });
    expect(previews).toEqual(["data:image/jpeg;base64,frame"]);
    scan.resolve("invite");
    await expect(pending).resolves.toBe("invite");
    expect(unlisten).toHaveBeenCalledTimes(1);
    emit({ scanId: id, image: "data:image/jpeg;base64,late" });
    expect(previews).toHaveLength(1);
  } finally {
    await backend.dispose();
  }
});

it("cancels a scan while preview subscription is pending without invoking the camera", async () => {
  const scan = deferred();
  const subscription = deferred();
  const unlisten = vi.fn();
  setupMac(scan);
  listen.mockReturnValue(subscription.promise);
  const { createBackend, initializeBrowserBackend } = await import("../src/backends/tauri.ts");
  await initializeBrowserBackend();
  const backend = createBackend();
  try {
    const pending = backend.scanQrWithPreview(vi.fn());
    await backend.cancelScan();
    subscription.resolve(unlisten);
    await expect(pending).resolves.toBeNull();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls.some(([command]) => command === "ponlet_scan_qr")).toBe(false);
  } finally {
    await backend.dispose();
  }
});

it("unsubscribes immediately on cancellation and ignores subsequent frames", async () => {
  const scan = deferred();
  const unlisten = vi.fn();
  let emit;
  setupMac(scan);
  listen.mockImplementation(async (_event, handler) => {
    emit = (payload) => handler({ payload });
    return unlisten;
  });
  const { createBackend, initializeBrowserBackend } = await import("../src/backends/tauri.ts");
  await initializeBrowserBackend();
  const backend = createBackend();
  try {
    const preview = vi.fn();
    const pending = backend.scanQrWithPreview(preview);
    await Promise.resolve();
    const id = invoke.mock.calls.find(([command]) => command === "ponlet_scan_qr")[1].scanId;
    await backend.cancelScan();
    expect(unlisten).toHaveBeenCalledTimes(1);
    emit({ scanId: id, image: "data:image/jpeg;base64,late" });
    expect(preview).not.toHaveBeenCalled();
    scan.resolve("late");
    await expect(pending).resolves.toBeNull();
    expect(unlisten).toHaveBeenCalledTimes(1);
  } finally {
    await backend.dispose();
  }
});

it("unsubscribes when native scanning fails", async () => {
  const scan = deferred();
  const unlisten = vi.fn();
  setupMac(scan);
  listen.mockResolvedValue(unlisten);
  const { createBackend, initializeBrowserBackend } = await import("../src/backends/tauri.ts");
  await initializeBrowserBackend();
  const backend = createBackend();
  try {
    const pending = backend.scanQrWithPreview(vi.fn());
    await Promise.resolve();
    scan.resolve(Promise.reject(new Error("camera failed")));
    await expect(pending).rejects.toThrow("camera failed");
    expect(unlisten).toHaveBeenCalledTimes(1);
  } finally {
    await backend.dispose();
  }
});
