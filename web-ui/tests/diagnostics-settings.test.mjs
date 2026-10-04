import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsDialog } from "../src/components/settings-dialog.ts";
import { setLanguage } from "../src/i18n.ts";
const flush = async () => {
  for (let i = 0; i < 24; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
};
const cap = {
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
};
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
function setup(initial = status(), capabilities = cap) {
  const backend = {
    diagnosticsCapabilities: vi.fn().mockResolvedValue(capabilities),
    diagnosticsStatus: vi.fn().mockResolvedValue(initial),
    requestDiagnosticsDeletion: vi.fn().mockResolvedValue(
      status({
        state: "local_pending",
        requestId: "fixture_request",
        futureTelemetry: "disabled_persisted",
      }),
    ),
    retryDiagnosticsDeletion: vi.fn().mockResolvedValue(initial),
    diagnosticsContinueAfterRestart: vi.fn().mockResolvedValue(initial),
  };
  const setTelemetryEnabled = vi.fn().mockResolvedValue(undefined);
  const component = createSettingsDialog({
    getDiagnosticsBackend: () => backend,
    getTelemetryEnabled: async () => false,
    setTelemetryEnabled,
  });
  document.body.append(component.dialog);
  component.openSettings();
  return {
    component,
    backend,
    setTelemetryEnabled,
    find: (id) => component.dialog.querySelector(`#${id}`),
  };
}
beforeEach(() => {
  localStorage.clear();
  setLanguage("en");
  document.body.replaceChildren();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
describe("product diagnostics settings", () => {
  it("keeps saved OFF and never enrolls or requests deletion on open", async () => {
    const h = setup();
    await flush();
    expect(h.find("settings-telemetry-toggle").checked).toBe(false);
    expect(h.setTelemetryEnabled).not.toHaveBeenCalled();
    expect(h.backend.requestDiagnosticsDeletion).not.toHaveBeenCalled();
  });
  it("requires confirmation, puts focus on Cancel, and Escape restores the trigger", async () => {
    const h = setup();
    await flush();
    h.find("diagnostics-delete-remote").click();
    expect(document.activeElement).toBe(h.find("diagnostics-cancel"));
    h.component.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(h.find("diagnostics-confirmation").hidden).toBe(true);
    expect(document.activeElement).toBe(h.find("diagnostics-delete-remote"));
    expect(h.backend.requestDiagnosticsDeletion).not.toHaveBeenCalled();
  });
  it("serializes repeated confirmation clicks", async () => {
    const h = setup();
    let resolve;
    h.backend.requestDiagnosticsDeletion.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await flush();
    h.find("diagnostics-delete-remote").click();
    for (let i = 0; i < 20; i++) {
      h.find("diagnostics-confirm").click();
    }
    await flush();
    expect(h.backend.requestDiagnosticsDeletion).toHaveBeenCalledTimes(1);
    expect(h.find("settings-telemetry-toggle").disabled).toBe(true);
    resolve(status({ state: "local_pending", requestId: "fixture_request" }));
    await flush();
  });
  it("gates remote while preserving available local actions", async () => {
    const h = setup(status(), { ...cap, signedNativeReady: false, backendAvailable: false });
    await flush();
    expect(h.find("diagnostics-delete-remote").disabled).toBe(true);
    expect(h.find("diagnostics-delete-local").disabled).toBe(false);
  });
  it("renders accepted, partially submitted and restart-required separately", async () => {
    const h = setup(
      status({
        state: "provider_submitted",
        requestId: "fixture_request",
        serverAccepted: true,
        providerAccepted: { analytics: true, crashlytics: false },
        restartRequired: true,
        partialFailures: ["provider_error"],
      }),
    );
    await flush();
    expect(h.find("diagnostics-server").textContent).toContain("accepted");
    expect(h.find("diagnostics-providers").textContent).toContain("completion unconfirmed");
    expect(h.find("diagnostics-restart").hidden).toBe(false);
    expect(h.find("diagnostics-partial").hidden).toBe(false);
    expect(h.component.dialog.textContent).not.toContain("provider_error");
  });
  it("retains old receipts after a status failure without displaying internal errors", async () => {
    const h = setup(status({ state: "accepted", requestId: "old_request", serverAccepted: true }));
    await flush();
    h.backend.diagnosticsStatus.mockRejectedValue(new Error("private_token"));
    h.find("diagnostics-refresh").click();
    await flush();
    expect(h.find("diagnostics-request").textContent).toContain("old_request");
    expect(h.component.dialog.textContent).not.toContain("private_token");
  });
  it("does not reopen a confirmation after close and reopen", async () => {
    const h = setup();
    await flush();
    h.find("diagnostics-delete-local").click();
    h.component.closeSettings();
    h.component.openSettings();
    await flush();
    expect(h.find("diagnostics-confirmation").hidden).toBe(true);
    expect(h.backend.requestDiagnosticsDeletion).not.toHaveBeenCalled();
  });
  it("keeps exclusions translated in both languages", async () => {
    const h = setup();
    await flush();
    for (const lang of ["ja", "en"]) {
      setLanguage(lang);
      await flush();
      expect(h.find("diagnostics-exclusions").textContent).toContain("ML Kit");
      expect(h.find("diagnostics-exclusions").textContent).toContain("BigQuery");
    }
  });
});

it("shows previous native receipts after a new epoch and keeps old retry controls", async () => {
  const previous = {
    requestId: "old_request",
    state: "retry_wait",
    serverAccepted: true,
    providerAccepted: { analytics: true, crashlytics: false },
    restartRequired: true,
  };
  const h = setup(
    status({
      state: "accepted",
      requestId: "new_request",
      serverAccepted: true,
      previousRequests: [previous],
    }),
  );
  await flush();
  expect(h.find("diagnostics-previous").textContent).toContain("old_request");
  expect(h.find("diagnostics-previous").textContent).toContain("completion unconfirmed");
  expect(h.find("diagnostics-retry").hidden).toBe(false);
  expect(h.find("diagnostics-continue").hidden).toBe(false);
});

it("prioritizes late-arrival operator verification over two acceptance booleans", async () => {
  const h = setup(
    status({
      state: "provider_submitted",
      requestId: "fixture_request",
      serverAccepted: true,
      providerAccepted: { analytics: true, crashlytics: true },
      remoteState: "operator_action_required",
      providerStates: {
        analytics: { state: "submitted", errorCode: null, additionalSubmissionRequired: true },
        crashlytics: { state: "submitted", errorCode: null, additionalSubmissionRequired: false },
      },
    }),
  );
  await flush();
  expect(h.find("diagnostics-state").textContent).toContain("Operator verification is required");
  expect(h.find("diagnostics-partial").hidden).toBe(false);
});

it("shows an expired retention tombstone as lost query ability, not proof of erasure", async () => {
  const h = setup(
    status({
      state: "provider_submitted",
      requestId: "fixture_request",
      serverAccepted: true,
      providerAccepted: { analytics: true, crashlytics: true },
      retentionExpired: true,
      keyCleanupPending: false,
    }),
  );
  await flush();
  expect(h.find("diagnostics-retention-expired").hidden).toBe(false);
  expect(h.find("diagnostics-state").textContent).toContain("not proof of complete erasure");
  expect(h.find("diagnostics-retry").hidden).toBe(true);
});

it("does not say persisted OFF when the preference mirror is incomplete", async () => {
  const h = setup(
    status({
      state: "blocked",
      requestId: "fixture_request",
      futureTelemetry: "persistence_incomplete",
    }),
  );
  await flush();
  expect(h.find("diagnostics-persistence-incomplete").hidden).toBe(false);
  expect(h.find("diagnostics-stopped").hidden).toBe(true);
  expect(h.find("diagnostics-state").textContent).toContain(
    "Saving the sending-stop preference is incomplete",
  );
});

it("distinguishes pending native key cleanup from confirmed key removal", async () => {
  const current = status({
    state: "provider_submitted",
    requestId: "fixture_request",
    serverAccepted: true,
    providerAccepted: { analytics: true, crashlytics: true },
    retentionExpired: true,
    keyCleanupPending: true,
  });
  const h = setup(current);
  await flush();
  expect(h.find("diagnostics-state").textContent).toContain("key cleanup is pending");
  h.backend.diagnosticsStatus.mockResolvedValue({ ...current, keyCleanupPending: false });
  h.find("diagnostics-refresh").click();
  await flush();
  expect(h.find("diagnostics-state").textContent).toContain("old deletion key were removed");
  expect(h.find("diagnostics-state").textContent).toContain("not proof of complete erasure");
});

it.each(["pending", "failed", "unavailable"])(
  "shows server-saved Analytics work waiting for local %s",
  async (analyticsLocal) => {
    const h = setup(
      status({
        state: "accepted",
        requestId: "fixture_request",
        serverAccepted: true,
        analyticsLocal,
        crashlyticsLocal: "delete_queued",
      }),
    );
    await flush();
    expect(h.find("diagnostics-awaiting-local").hidden).toBe(false);
    expect(h.find("diagnostics-awaiting-local").textContent).toContain("saved on the server");
    expect(h.find("diagnostics-awaiting-local").textContent).toContain("Google Analytics");
    expect(h.find("diagnostics-awaiting-local").textContent).not.toContain("Firebase Crashlytics");
    setLanguage("ja");
    await flush();
    expect(h.find("diagnostics-awaiting-local").textContent).toContain(
      "端末内の処理を確認してから",
    );
  },
);

it("waits for Crashlytics local processing but keeps Analytics acceptance", async () => {
  const h = setup(
    status({
      state: "provider_submitted",
      requestId: "fixture_request",
      serverAccepted: true,
      providerAccepted: { analytics: true, crashlytics: false },
      analyticsLocal: "failed",
      crashlyticsLocal: "restart_required",
      restartRequired: true,
    }),
  );
  await flush();
  expect(h.find("diagnostics-awaiting-local").textContent).toContain("Firebase Crashlytics");
  expect(h.find("diagnostics-awaiting-local").textContent).not.toContain("Google Analytics");
  expect(h.find("diagnostics-providers").textContent).toContain(
    "Google Analytics: deletion request accepted",
  );
  expect(h.find("diagnostics-restart").hidden).toBe(false);
});

it.each(["delete_queued", "no_unsent_reports_observed"])(
  "clears the local-wait message after Analytics reset and Crashlytics %s",
  async (crashlyticsLocal) => {
    const h = setup(
      status({
        state: "accepted",
        requestId: "fixture_request",
        serverAccepted: true,
        analyticsLocal: "reset_requested",
        crashlyticsLocal,
      }),
    );
    await flush();
    expect(h.find("diagnostics-awaiting-local").hidden).toBe(true);
    expect(h.find("diagnostics-server").textContent).toContain("accepted");
  },
);
