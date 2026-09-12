import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScannerDialog } from "../src/components/scanner-dialog.ts";
import decode from "jsqr";
vi.mock("jsqr", () => ({ default: vi.fn() }));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};
let frames;
let number;
let stopped;
let stream;
let scanner;
beforeEach(() => {
  frames = new Map();
  number = 0;
  stopped = vi.fn();
  stream = { getTracks: () => [{ stop: stopped }] };
  vi.stubGlobal("requestAnimationFrame", (callback) => {
    frames.set(++number, callback);
    return number;
  });
  vi.stubGlobal("cancelAnimationFrame", (id) => frames.delete(id));
  vi.stubGlobal("navigator", {
    language: "en",
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });
  vi.stubGlobal(
    "BarcodeDetector",
    class {
      async detect() {
        return [];
      }
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray(16), width: 2, height: 2 }),
  });
  decode.mockReset();
  scanner = createScannerDialog();
  // The test camera has no real tracks. Keep attachment/detachment observable
  // while bypassing happy-dom's native MediaStream instance check for this double.
  Object.defineProperty(scanner.dialog.querySelector("video"), "srcObject", {
    configurable: true,
    writable: true,
    value: null,
  });
  document.body.append(scanner.dialog);
});
afterEach(() => {
  scanner.closeScanner();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function nextFrame() {
  const [id, callback] = frames.entries().next().value;
  frames.delete(id);
  callback(1000);
}

describe("camera scanner cancellation", () => {
  it("finishes when closed between frames, allowing another scan", async () => {
    const pending = scanner.openScanner();
    await flush();
    expect(frames.size).toBe(1);
    expect(scanner.dialog.querySelector("video").srcObject).toBe(stream);
    scanner.closeScanner();
    await expect(pending).resolves.toBeNull();
    expect(frames.size).toBe(0);
    expect(scanner.dialog.querySelector("video").srcObject).toBeNull();
    expect(stopped).toHaveBeenCalledTimes(1);
    const retry = scanner.openScanner();
    await flush();
    scanner.closeScanner();
    await expect(retry).resolves.toBeNull();
  });
  it("Escape completes before permission resolves and stops a late stream", async () => {
    const permission = deferred();
    navigator.mediaDevices.getUserMedia.mockReturnValue(permission.promise);
    const pending = scanner.openScanner();
    scanner.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await expect(pending).resolves.toBeNull();
    permission.resolve(stream);
    await flush();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(scanner.dialog.hasAttribute("open")).toBe(false);
  });
  it("cleans up when permission or video playback fails", async () => {
    navigator.mediaDevices.getUserMedia.mockRejectedValueOnce(new Error("denied"));
    await expect(scanner.openScanner()).rejects.toThrow("denied");
    expect(scanner.dialog.hasAttribute("open")).toBe(false);
    HTMLMediaElement.prototype.play.mockRejectedValueOnce(new Error("playback"));
    await expect(scanner.openScanner()).rejects.toThrow("playback");
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });
  it("ignores a detector result that arrives after closing", async () => {
    const detection = deferred();
    vi.stubGlobal(
      "BarcodeDetector",
      class {
        detect() {
          return detection.promise;
        }
      },
    );
    const pending = scanner.openScanner();
    await flush();
    nextFrame();
    scanner.closeScanner();
    await expect(pending).resolves.toBeNull();
    detection.resolve([{ rawValue: "https://example.test/#i=stale" }]);
    await flush();
    expect(frames.size).toBe(0);
  });
});
it("uses the portable decoder without BarcodeDetector", async () => {
  delete globalThis.BarcodeDetector;
  const video = scanner.dialog.querySelector("video");
  Object.defineProperties(video, { videoWidth: { value: 2 }, videoHeight: { value: 2 } });
  decode.mockReturnValue({ data: "https://example.test/#i=portable" });
  const pending = scanner.openScanner();
  await flush();
  nextFrame();
  await expect(pending).resolves.toBe("https://example.test/#i=portable");
  expect(decode).toHaveBeenCalled();
  expect(stopped).toHaveBeenCalledTimes(1);
});
it("cancels native scanning and restores the app even while permission is pending", async () => {
  const scan = deferred();
  const cancel = vi.fn().mockResolvedValue();
  const pending = scanner.openNativeScanner(() => scan.promise, cancel);
  expect(document.documentElement.classList.contains("native-scanning")).toBe(true);
  scanner.closeScanner();
  await expect(pending).resolves.toBeNull();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(document.documentElement.classList.contains("native-scanning")).toBe(false);
  scan.resolve("stale");
  await flush();
  expect(scanner.dialog.open).toBe(false);
});
