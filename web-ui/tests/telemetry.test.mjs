import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialSnapshot } from "../src/api/application-api";

beforeEach(() => {
  const saved = new Map();
  vi.stubGlobal("localStorage", {
    clear: () => saved.clear(),
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, String(value)),
  });
});

afterEach(() => {
  localStorage.clear();
  delete window.__tailcatTelemetry;
  vi.resetModules();
  vi.unstubAllGlobals();
});

it("preserves either Slint or interim WebView opt-out before SDK initialization", async () => {
  for (const [key, value] of [
    ["telemetry_enabled", "0"],
    ["ponlet.telemetry", "off"],
    ["ponlet.telemetry", "false"],
  ]) {
    localStorage.clear();
    vi.resetModules();
    localStorage.setItem(key, value);
    const telemetry = await import("../src/telemetry");
    expect(await telemetry.getTelemetryEnabled()).toBe(false);
    const before = document.head.querySelectorAll("script").length;
    await telemetry.initializeWebTelemetry();
    expect(document.head.querySelectorAll("script").length).toBe(before);
  }
});

it("connects the setting to collection and sends only coarse event fields", async () => {
  const logEvent = vi.fn();
  const setEnabled = vi.fn();
  window.__tailcatTelemetry = { isEnabled: () => true, setEnabled, logEvent };
  const telemetry = await import("../src/telemetry");
  const observer = telemetry.telemetryObserver();
  observer({
    type: "snapshot",
    sequence: 1,
    snapshot: {
      ...initialSnapshot(),
      sequence: 1,
      state: "awaiting-peer",
      inviteUrl: "https://private/#secret",
    },
  });
  observer({ type: "text", sequence: 2, text: "private message", incoming: true });
  observer({
    type: "terminal",
    sequence: 3,
    id: "private-file-name",
    status: "failed",
    message: "private/path",
  });
  expect(JSON.stringify(logEvent.mock.calls)).not.toMatch(/private|secret/);
  expect(logEvent).toHaveBeenCalledWith("text_message_received", { length_bucket: "xs" });
  const previous = logEvent.mock.calls.length;
  await telemetry.setTelemetryEnabled(false);
  telemetry.textSent("do not collect");
  expect(logEvent.mock.calls.length).toBe(previous);
  expect(setEnabled).toHaveBeenLastCalledWith(false);
  expect(localStorage.getItem("telemetry_enabled")).toBe("0");
});
