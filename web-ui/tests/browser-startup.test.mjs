import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../src/telemetry", () => ({ initializeWebTelemetry: async () => {} }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
  delete window.__ponletBackend;
});

it("stops checking for the Go bridge after startup times out", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "Go",
    class {
      importObject = {};
      async run() {}
    },
  );
  vi.stubGlobal("tailSendTailcat", undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(gzipSync(new Uint8Array()))),
  );
  vi.spyOn(WebAssembly, "instantiate").mockResolvedValue({ instance: {} });
  const { initializeBrowserBackend } = await import("../src/backends/browser.ts");
  const failed = expect(initializeBrowserBackend()).rejects.toThrow("startup timed out");
  // DecompressionStream uses native tasks, then the fake clock drives startup.
  await vi.waitFor(() => expect(WebAssembly.instantiate).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(30_000);
  await failed;
  expect(vi.getTimerCount()).toBe(0);
});
