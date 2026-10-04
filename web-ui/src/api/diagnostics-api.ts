/** Versioned native-only privacy API. No SDK identifiers, keys or URLs enter the WebView. */
export interface DiagnosticsCapabilities {
  backendAvailable: boolean;
  configured: boolean;
  featureEnabled: boolean;
  localDeletionAvailable: boolean;
  platform: "android" | "unsupported";
  policyVersion: string | null;
  remoteDeletionAvailable: boolean;
  schemaVersion: 1;
  signedNativeReady: boolean;
  unavailableReason: string | null;
}
export type DiagnosticsState =
  | "idle"
  | "disabled_persisted"
  | "snapshot_pending"
  | "local_pending"
  | "restart_required"
  | "retry_wait"
  | "accepted"
  | "provider_submitted"
  | "blocked";
export interface DiagnosticsProviderState {
  additionalSubmissionRequired: boolean;
  errorCode: string | null;
  state:
    | "queued"
    | "in_flight"
    | "retry_wait"
    | "submitted"
    | "operator_action_required"
    | "unsupported";
}
export interface DiagnosticsRemoteProgress {
  /** True until the native key-cleanup queue confirms deletion. */
  keyCleanupPending?: boolean;
  providerStates?: {
    analytics: DiagnosticsProviderState | null;
    crashlytics: DiagnosticsProviderState | null;
  };
  remoteState?: "accepted" | "retrying" | "provider_submitted" | "operator_action_required" | null;
  /** Native target identifiers and old signing key have been removed; not proof of remote erasure. */
  retentionExpired?: boolean;
}
export interface DiagnosticsReceipt extends DiagnosticsRemoteProgress {
  providerAccepted: { analytics: boolean; crashlytics: boolean };
  requestId: string;
  restartRequired: boolean;
  serverAccepted: boolean;
  state: DiagnosticsState;
}
export type DiagnosticsTelemetryState =
  | "unchanged"
  | "enabled"
  | "disabled_persisted"
  | "registration_pending"
  | "persistence_incomplete";
export interface DiagnosticsStatus extends DiagnosticsRemoteProgress {
  analyticsLocal: string;
  crashlyticsLocal: string;
  excludedData: Array<string>;
  futureTelemetry: DiagnosticsTelemetryState;
  partialFailures: Array<string>;
  previousRequests?: Array<DiagnosticsReceipt>;
  providerAccepted: { analytics: boolean; crashlytics: boolean };
  requestId: string | null;
  restartRequired: boolean;
  schemaVersion: 1;
  serverAccepted: boolean;
  state: DiagnosticsState;
}
export interface DiagnosticsDeletionRequest {
  confirmed: true;
  scope: "local" | "bound_remote";
}
export interface DiagnosticsBackend {
  diagnosticsCapabilities(): Promise<DiagnosticsCapabilities>;
  diagnosticsContinueAfterRestart(): Promise<DiagnosticsStatus>;
  diagnosticsStatus(): Promise<DiagnosticsStatus>;
  requestDiagnosticsDeletion(request: DiagnosticsDeletionRequest): Promise<DiagnosticsStatus>;
  retryDiagnosticsDeletion(): Promise<DiagnosticsStatus>;
}
/** Independent runtime guards. UI/build flags alone can never enable the native path. */
export function diagnosticsAvailable(
  value: DiagnosticsCapabilities | undefined,
  scope: DiagnosticsDeletionRequest["scope"],
): boolean {
  return Boolean(
    value?.schemaVersion === 1 &&
    value.platform === "android" &&
    value.featureEnabled &&
    (scope === "local"
      ? value.localDeletionAvailable
      : value.configured &&
        value.signedNativeReady &&
        value.backendAvailable &&
        value.policyVersion &&
        value.remoteDeletionAvailable),
  );
}
