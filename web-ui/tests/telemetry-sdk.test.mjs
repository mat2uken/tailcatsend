import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  initializeApp: vi.fn(),
  getAnalytics: vi.fn(),
  isSupported: vi.fn(),
  logEvent: vi.fn(),
  setAnalyticsCollectionEnabled: vi.fn(),
}));
vi.mock("https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js", () => ({
  initializeApp: sdk.initializeApp,
}));
vi.mock("https://www.gstatic.com/firebasejs/12.3.0/firebase-analytics.js", () => sdk);

beforeEach(() => {
  sdk.initializeApp.mockReturnValue({});
  sdk.getAnalytics.mockReturnValue({ analytics: true });
  sdk.isSupported.mockResolvedValue(true);
  const preferences = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key) => preferences.get(key) ?? null,
    setItem: (key, value) => preferences.set(key, value),
  });
  window.__FIREBASE_CONFIG__ = {
    apiKey: "key",
    projectId: "project",
    appId: "app",
    measurementId: "measurement",
  };
});

afterEach(() => {
  delete window.__FIREBASE_CONFIG__;
  delete window.__tailcatTelemetry;
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.resetAllMocks();
});

it("delivers events after SDK initialization and honors opt-out", async () => {
  let ready;
  sdk.isSupported.mockReturnValue(
    new Promise((resolve) => {
      ready = resolve;
    }),
  );
  await import("../../dist/assets/telemetry.js");
  window.__tailcatTelemetry.setEnabled(true);
  window.__tailcatTelemetry.setEnabled(true);
  expect(sdk.initializeApp).toHaveBeenCalledTimes(1);
  expect(sdk.isSupported).toHaveBeenCalledTimes(1);
  window.__tailcatTelemetry.logEvent("queued", { count: 1 });
  expect(sdk.logEvent).not.toHaveBeenCalled();
  ready(true);
  await vi.waitFor(() =>
    expect(sdk.logEvent).toHaveBeenCalledWith({ analytics: true }, "queued", { count: 1 }),
  );
  window.__tailcatTelemetry.setEnabled(false);
  window.__tailcatTelemetry.logEvent("disabled", {});
  expect(localStorage.getItem("telemetry_enabled")).toBe("0");
  expect(sdk.setAnalyticsCollectionEnabled).toHaveBeenLastCalledWith({ analytics: true }, false);
  expect(sdk.logEvent).toHaveBeenCalledTimes(1);
});

it("does not initialize SDKs for a saved opt-out or placeholder configuration", async () => {
  localStorage.setItem("telemetry_enabled", "0");
  await import("../../dist/assets/telemetry.js");
  window.__tailcatTelemetry.logEvent("disabled", {});
  expect(sdk.initializeApp).not.toHaveBeenCalled();
  vi.resetModules();
  localStorage.setItem("telemetry_enabled", "1");
  window.__FIREBASE_CONFIG__.apiKey = "PLACEHOLDER";
  await import("../../dist/assets/telemetry.js");
  window.__tailcatTelemetry.logEvent("placeholder", {});
  expect(sdk.initializeApp).not.toHaveBeenCalled();
  expect(sdk.logEvent).not.toHaveBeenCalled();
});
