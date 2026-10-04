import { describe, expect, it, vi } from "vitest";
import {
  createDiagnosticsNativeBackend,
  validateDiagnosticsCapabilities,
  validateDiagnosticsStatus,
} from "../src/backends/diagnostics-native.ts";
const capability = (overrides = {}) => ({
  schemaVersion: 1,
  platform: "android",
  featureEnabled: true,
  configured: true,
  signedNativeReady: true,
  backendAvailable: true,
  localDeletionAvailable: true,
  remoteDeletionAvailable: true,
  policyVersion: "fixture_policy",
  unavailableReason: null,
  ...overrides,
});
const status = (overrides = {}) => ({
  schemaVersion: 1,
  state: "idle",
  requestId: null,
  serverAccepted: false,
  providerAccepted: { analytics: false, crashlytics: false },
  restartRequired: false,
  partialFailures: [],
  excludedData: ["legacy_unbound", "mlkit"],
  analyticsLocal: "pending",
  crashlyticsLocal: "pending",
  futureTelemetry: "unchanged",
  ...overrides,
});

describe("native diagnostics adapter", () => {
  it.each([
    "featureEnabled",
    "configured",
    "signedNativeReady",
    "backendAvailable",
    "remoteDeletionAvailable",
  ])("fails closed with %s false", async (key) => {
    const invoke = vi.fn().mockResolvedValue(capability({ [key]: false }));
    const backend = createDiagnosticsNativeBackend(invoke);
    await expect(
      backend.requestDiagnosticsDeletion({ scope: "bound_remote", confirmed: true }),
    ).rejects.toThrow("diagnostics_unavailable");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("ponlet_diagnostics_capabilities");
  });
  it("sends only typed scope and confirmation, without a Google ID or URL", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(capability())
      .mockResolvedValueOnce(status({ state: "local_pending", requestId: "fixture_request" }));
    const backend = createDiagnosticsNativeBackend(invoke);
    await backend.requestDiagnosticsDeletion({ scope: "local", confirmed: true });
    expect(invoke).toHaveBeenLastCalledWith("ponlet_diagnostics_request", {
      request: { scope: "local", confirmed: true },
    });
  });
  it("rejects unconfirmed, arbitrary scope and extra target identifiers", async () => {
    const invoke = vi.fn();
    const backend = createDiagnosticsNativeBackend(invoke);
    for (const request of [
      { scope: "local", confirmed: false },
      { scope: "all", confirmed: true },
      { scope: "local", confirmed: true, userId: "arbitrary" },
    ]) {
      await expect(backend.requestDiagnosticsDeletion(request)).rejects.toThrow(
        "diagnostics_invalid_request",
      );
    }
    expect(invoke).not.toHaveBeenCalled();
  });
  it("preserves server and individual provider acceptance on retry", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(
        status({
          state: "accepted",
          requestId: "old_request",
          serverAccepted: true,
          providerAccepted: { analytics: true, crashlytics: false },
        }),
      )
      .mockResolvedValueOnce(status({ state: "retry_wait", requestId: "old_request" }));
    const backend = createDiagnosticsNativeBackend(invoke);
    await backend.diagnosticsStatus();
    const next = await backend.diagnosticsStatus();
    expect(next.serverAccepted).toBe(true);
    expect(next.providerAccepted.analytics).toBe(true);
  });
  it("never accepts a completed response or inconsistent acceptance", () => {
    expect(() => validateDiagnosticsStatus(status({ state: "completed" }))).toThrow();
    expect(() =>
      validateDiagnosticsStatus(status({ state: "accepted", serverAccepted: true })),
    ).toThrow();
    expect(() => validateDiagnosticsCapabilities({ schemaVersion: 1 })).toThrow();
  });
});

it("rejects an unsolicited current request change even with a previous receipt", async () => {
  const previous = {
    requestId: "old_request",
    state: "accepted",
    serverAccepted: true,
    providerAccepted: { analytics: false, crashlytics: false },
    restartRequired: false,
  };
  const invoke = vi
    .fn()
    .mockResolvedValueOnce(status({ ...previous }))
    .mockResolvedValueOnce(
      status({ state: "local_pending", requestId: "new_request", previousRequests: [previous] }),
    );
  const backend = createDiagnosticsNativeBackend(invoke);
  await backend.diagnosticsStatus();
  await expect(backend.diagnosticsStatus()).rejects.toThrow("diagnostics_request_changed");
});

it("preserves retention tombstones and validates sending-state enums", async () => {
  const retained = status({
    state: "provider_submitted",
    requestId: "old_request",
    serverAccepted: true,
    providerAccepted: { analytics: true, crashlytics: true },
    retentionExpired: true,
  });
  const invoke = vi
    .fn()
    .mockResolvedValueOnce(retained)
    .mockResolvedValueOnce({ ...retained, retentionExpired: undefined });
  const backend = createDiagnosticsNativeBackend(invoke);
  await backend.diagnosticsStatus();
  expect((await backend.diagnosticsStatus()).retentionExpired).toBe(true);
  expect(() => validateDiagnosticsStatus(status({ futureTelemetry: "definitely_off" }))).toThrow();
  expect(() => validateDiagnosticsStatus(status({ retentionExpired: "yes" }))).toThrow();
  expect(
    validateDiagnosticsStatus(
      status({ state: "blocked", futureTelemetry: "persistence_incomplete" }),
    ).futureTelemetry,
  ).toBe("persistence_incomplete");
});
