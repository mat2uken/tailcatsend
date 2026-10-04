import {
  diagnosticsAvailable,
  type DiagnosticsBackend,
  type DiagnosticsCapabilities,
  type DiagnosticsDeletionRequest,
  type DiagnosticsState,
  type DiagnosticsReceipt,
  type DiagnosticsRemoteProgress,
  type DiagnosticsProviderState,
  type DiagnosticsStatus,
  type DiagnosticsTelemetryState,
} from "../api/diagnostics-api";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const states: Array<DiagnosticsState> = [
  "idle",
  "disabled_persisted",
  "snapshot_pending",
  "local_pending",
  "restart_required",
  "retry_wait",
  "accepted",
  "provider_submitted",
  "blocked",
];
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("diagnostics_invalid_response");
  }
  return value as Record<string, unknown>;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("diagnostics_invalid_response");
  }
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 128) {
    throw new Error("diagnostics_invalid_response");
  }
  return value;
}
function optionalText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function codes(value: unknown): Array<string> {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("diagnostics_invalid_response");
  }
  return value.map(text);
}
export function validateDiagnosticsCapabilities(value: unknown): DiagnosticsCapabilities {
  const v = record(value);
  if (v.schemaVersion !== 1 || !["android", "unsupported"].includes(String(v.platform))) {
    throw new Error("diagnostics_invalid_response");
  }
  return {
    schemaVersion: 1,
    platform: v.platform as DiagnosticsCapabilities["platform"],
    featureEnabled: bool(v.featureEnabled),
    configured: bool(v.configured),
    signedNativeReady: bool(v.signedNativeReady),
    backendAvailable: bool(v.backendAvailable),
    localDeletionAvailable: bool(v.localDeletionAvailable),
    remoteDeletionAvailable: bool(v.remoteDeletionAvailable),
    policyVersion: optionalText(v.policyVersion),
    unavailableReason: optionalText(v.unavailableReason),
  };
}
function remoteProgress(value: Record<string, unknown>): DiagnosticsRemoteProgress {
  const result: DiagnosticsRemoteProgress = {};
  if (value.retentionExpired !== undefined) {
    result.retentionExpired = bool(value.retentionExpired);
  }
  if (value.keyCleanupPending !== undefined) {
    result.keyCleanupPending = bool(value.keyCleanupPending);
  }
  if (value.remoteState !== undefined) {
    if (
      value.remoteState !== null &&
      !["accepted", "retrying", "provider_submitted", "operator_action_required"].includes(
        String(value.remoteState),
      )
    ) {
      throw new Error("diagnostics_invalid_response");
    }
    result.remoteState = value.remoteState as DiagnosticsRemoteProgress["remoteState"];
  }
  if (value.providerStates !== undefined) {
    const providers = record(value.providerStates);
    const provider = (input: unknown): DiagnosticsProviderState | null => {
      if (input === null) {
        return null;
      }
      const v = record(input);
      if (
        ![
          "queued",
          "in_flight",
          "retry_wait",
          "submitted",
          "operator_action_required",
          "unsupported",
        ].includes(String(v.state))
      ) {
        throw new Error("diagnostics_invalid_response");
      }
      return {
        state: v.state as DiagnosticsProviderState["state"],
        errorCode: optionalText(v.errorCode),
        additionalSubmissionRequired: bool(v.additionalSubmissionRequired),
      };
    };
    result.providerStates = {
      analytics: provider(providers.analytics),
      crashlytics: provider(providers.crashlytics),
    };
  }
  return result;
}
function receipt(value: unknown): DiagnosticsReceipt {
  const v = record(value),
    p = record(v.providerAccepted);
  const id = text(v.requestId);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !states.includes(v.state as DiagnosticsState)) {
    throw new Error("diagnostics_invalid_response");
  }
  const serverAccepted = bool(v.serverAccepted);
  const providerAccepted = { analytics: bool(p.analytics), crashlytics: bool(p.crashlytics) };
  if ((providerAccepted.analytics || providerAccepted.crashlytics) && !serverAccepted) {
    throw new Error("diagnostics_invalid_response");
  }
  if (
    (v.state === "accepted" && !serverAccepted) ||
    (v.state === "provider_submitted" &&
      !(providerAccepted.analytics || providerAccepted.crashlytics))
  ) {
    throw new Error("diagnostics_invalid_response");
  }
  return {
    requestId: id,
    state: v.state as DiagnosticsState,
    serverAccepted,
    providerAccepted,
    restartRequired: bool(v.restartRequired),
    ...remoteProgress(v),
  };
}
export function validateDiagnosticsStatus(value: unknown): DiagnosticsStatus {
  const v = record(value),
    p = record(v.providerAccepted);
  if (v.schemaVersion !== 1 || !states.includes(v.state as DiagnosticsState)) {
    throw new Error("diagnostics_invalid_response");
  }
  const requestId = optionalText(v.requestId);
  if (requestId !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
    throw new Error("diagnostics_invalid_response");
  }
  const futureTelemetry = text(v.futureTelemetry);
  if (
    ![
      "unchanged",
      "enabled",
      "disabled_persisted",
      "registration_pending",
      "persistence_incomplete",
    ].includes(futureTelemetry)
  ) {
    throw new Error("diagnostics_invalid_response");
  }
  const result: DiagnosticsStatus = {
    schemaVersion: 1,
    state: v.state as DiagnosticsState,
    requestId,
    ...remoteProgress(v),
    serverAccepted: bool(v.serverAccepted),
    providerAccepted: { analytics: bool(p.analytics), crashlytics: bool(p.crashlytics) },
    restartRequired: bool(v.restartRequired),
    partialFailures: codes(v.partialFailures),
    excludedData: codes(v.excludedData),
    analyticsLocal: text(v.analyticsLocal),
    crashlyticsLocal: text(v.crashlyticsLocal),
    futureTelemetry: futureTelemetry as DiagnosticsTelemetryState,
  };
  if (
    (result.retentionExpired && !requestId) ||
    (result.serverAccepted && !requestId) ||
    ((result.providerAccepted.analytics || result.providerAccepted.crashlytics) &&
      !result.serverAccepted) ||
    (result.state === "accepted" && !result.serverAccepted) ||
    (result.state === "provider_submitted" &&
      !(result.providerAccepted.analytics || result.providerAccepted.crashlytics))
  ) {
    throw new Error("diagnostics_invalid_response");
  }
  if (v.previousRequests !== undefined) {
    // Bounded parser; native storage/history pagination must be resolved before release.
    if (!Array.isArray(v.previousRequests) || v.previousRequests.length > 1000) {
      throw new Error("diagnostics_invalid_response");
    }
    result.previousRequests = v.previousRequests.map(receipt);
    const ids = result.previousRequests.map((value) => value.requestId);
    if (new Set(ids).size !== ids.length || ids.includes(requestId ?? "")) {
      throw new Error("diagnostics_invalid_response");
    }
  }
  return result;
}
/** Sticky receipts survive a temporary failure/stale read. Never guess a new request ID. */
export function preserveDiagnosticsReceipt(
  previous: DiagnosticsStatus | undefined,
  incoming: DiagnosticsStatus,
  allowRequestChange = false,
): DiagnosticsStatus {
  if (!previous) {
    return incoming;
  }
  const old = new Map((previous.previousRequests ?? []).map((value) => [value.requestId, value]));
  if (previous.requestId) {
    old.set(previous.requestId, {
      requestId: previous.requestId,
      state: previous.state,
      serverAccepted: previous.serverAccepted,
      providerAccepted: previous.providerAccepted,
      restartRequired: previous.restartRequired,
      remoteState: previous.remoteState,
      providerStates: previous.providerStates,
      retentionExpired: previous.retentionExpired,
      keyCleanupPending: previous.keyCleanupPending,
    });
  }
  if (
    previous.requestId &&
    incoming.requestId !== previous.requestId &&
    (!allowRequestChange ||
      !incoming.previousRequests?.some((value) => value.requestId === previous.requestId))
  ) {
    throw new Error("diagnostics_request_changed");
  }
  const merge = <T extends DiagnosticsReceipt>(value: T): T => {
    const prior = old.get(value.requestId);
    return {
      ...value,
      retentionExpired: value.retentionExpired || prior?.retentionExpired,
      keyCleanupPending: value.keyCleanupPending ?? prior?.keyCleanupPending,
      remoteState:
        value.remoteState === undefined && !value.retentionExpired
          ? prior?.remoteState
          : value.remoteState,
      providerStates:
        value.providerStates === undefined && !value.retentionExpired
          ? prior?.providerStates
          : value.providerStates,
      serverAccepted: value.serverAccepted || !!prior?.serverAccepted,
      providerAccepted: {
        analytics: value.providerAccepted.analytics || !!prior?.providerAccepted.analytics,
        crashlytics: value.providerAccepted.crashlytics || !!prior?.providerAccepted.crashlytics,
      },
    };
  };
  for (const value of incoming.previousRequests ?? []) {
    old.set(value.requestId, merge(value));
  }
  const prior = incoming.requestId ? old.get(incoming.requestId) : undefined;
  const next = {
    ...incoming,
    retentionExpired: incoming.retentionExpired || prior?.retentionExpired,
    keyCleanupPending: incoming.keyCleanupPending ?? prior?.keyCleanupPending,
    remoteState:
      incoming.remoteState === undefined && !incoming.retentionExpired
        ? prior?.remoteState
        : incoming.remoteState,
    providerStates:
      incoming.providerStates === undefined && !incoming.retentionExpired
        ? prior?.providerStates
        : incoming.providerStates,
    serverAccepted: incoming.serverAccepted || !!prior?.serverAccepted,
    providerAccepted: {
      analytics: incoming.providerAccepted.analytics || !!prior?.providerAccepted.analytics,
      crashlytics: incoming.providerAccepted.crashlytics || !!prior?.providerAccepted.crashlytics,
    },
  };
  if (incoming.requestId) {
    old.delete(incoming.requestId);
  }
  return { ...next, previousRequests: [...old.values()] };
}
/** Invokes native commands only. Never HTTP, App Check, key generation or enrollment in JS. */
export function createDiagnosticsNativeBackend(invoke: Invoke): DiagnosticsBackend {
  let last: DiagnosticsStatus | undefined;
  let mutation = false;
  let readSequence = 0;
  const capabilities = async (): Promise<DiagnosticsCapabilities> =>
    validateDiagnosticsCapabilities(await invoke<unknown>("ponlet_diagnostics_capabilities"));
  const status = async (): Promise<DiagnosticsStatus> => {
    const sequence = ++readSequence;
    const incoming = validateDiagnosticsStatus(await invoke<unknown>("ponlet_diagnostics_status"));
    // A slow read issued before a mutation cannot overwrite its result.
    if (sequence !== readSequence && last) {
      return last;
    }
    return (last = preserveDiagnosticsReceipt(last, incoming));
  };
  async function mutate(
    command: string,
    request?: DiagnosticsDeletionRequest,
    scope: DiagnosticsDeletionRequest["scope"] = "bound_remote",
  ): Promise<DiagnosticsStatus> {
    if (mutation) {
      throw new Error("diagnostics_busy");
    }
    mutation = true;
    ++readSequence;
    try {
      const cap = await capabilities();
      // Local continuation does not depend on a network connection; native still gates any remote send.
      if (!diagnosticsAvailable(cap, request?.scope ?? scope)) {
        throw new Error("diagnostics_unavailable");
      }
      const incoming = validateDiagnosticsStatus(
        await invoke<unknown>(command, request ? { request } : undefined),
      );
      ++readSequence;
      return (last = preserveDiagnosticsReceipt(last, incoming, request !== undefined));
    } finally {
      mutation = false;
    }
  }
  return {
    diagnosticsCapabilities: capabilities,
    diagnosticsStatus: status,
    requestDiagnosticsDeletion: (request) => {
      if (
        request.confirmed !== true ||
        !["local", "bound_remote"].includes(request.scope) ||
        Object.keys(request).some((key) => !["scope", "confirmed"].includes(key))
      ) {
        return Promise.reject(new Error("diagnostics_invalid_request"));
      }
      return mutate("ponlet_diagnostics_request", request);
    },
    retryDiagnosticsDeletion: () => mutate("ponlet_diagnostics_retry"),
    diagnosticsContinueAfterRestart: () =>
      mutate("ponlet_diagnostics_continue_after_restart", undefined, "local"),
  };
}
