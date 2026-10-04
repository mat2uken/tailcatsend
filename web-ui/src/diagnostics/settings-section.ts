import van from "vanjs-core";
import { uiText } from "../i18n";
import {
  diagnosticsAvailable,
  type DiagnosticsBackend,
  type DiagnosticsCapabilities,
  type DiagnosticsDeletionRequest,
  type DiagnosticsStatus,
  type DiagnosticsRemoteProgress,
  type DiagnosticsProviderState,
} from "../api/diagnostics-api";
import {
  preserveDiagnosticsReceipt,
  validateDiagnosticsCapabilities,
  validateDiagnosticsStatus,
} from "../backends/diagnostics-native";

interface Options {
  canMutate: () => boolean;
  getBackend: () => DiagnosticsBackend | undefined;
  onBusyChange: (busy: boolean) => void;
  onTelemetryStopped: () => void;
}
const { button, div, h3, p } = van.tags;

/** Product settings, driven only by typed native results. This module emits no analytics. */
export function createDiagnosticsSettings(options: Options) {
  let capability: DiagnosticsCapabilities | undefined;
  let status: DiagnosticsStatus | undefined;
  let busy = false;
  let refreshVersion = 0;
  let confirming: DiagnosticsDeletionRequest["scope"] | undefined;
  let confirmationTrigger: HTMLElement | undefined;
  let confirmationPolicy: string | null | undefined;
  const state = van.state(0);
  const error = p(
    { id: "diagnostics-error", role: "alert", hidden: true },
    () => uiText.diagnosticsError,
  );
  const unavailable = p(
    { id: "diagnostics-unavailable", class: "settings-note" },
    () => uiText.diagnosticsUnavailable,
  );
  const statusText = p({ id: "diagnostics-state" }, () => {
    void state.val;
    return status?.futureTelemetry === "persistence_incomplete"
      ? uiText.diagnosticsPersistenceIncomplete
      : stateLabel(status);
  });
  const requestText = p({ id: "diagnostics-request", class: "settings-note" }, () => {
    void state.val;
    return status?.requestId ? `${uiText.diagnosticsRequestId}: ${status.requestId}` : "";
  });
  const serverText = p({ id: "diagnostics-server" }, () => {
    void state.val;
    return status?.serverAccepted
      ? uiText.diagnosticsServerAccepted
      : uiText.diagnosticsServerUnconfirmed;
  });
  const awaitingLocalText = p({ id: "diagnostics-awaiting-local", role: "status" }, () => {
    void state.val;
    return `${uiText.diagnosticsAwaitingLocal} ${waitingForLocal(status).join(", ")}`;
  });
  const providerText = p({ id: "diagnostics-providers" }, () => {
    void state.val;
    return `Google Analytics: ${providerLabel(status?.providerAccepted.analytics ?? false, status?.providerStates?.analytics)}. Firebase Crashlytics: ${providerLabel(status?.providerAccepted.crashlytics ?? false, status?.providerStates?.crashlytics)}`;
  });
  const localText = p({ id: "diagnostics-local-state" }, () => {
    void state.val;
    if (!status) {
      return "";
    }
    return `Analytics: ${localLabel(status.analyticsLocal)}. Crashlytics: ${localLabel(status.crashlyticsLocal)}`;
  });
  const previousText = p({ id: "diagnostics-previous", class: "settings-note" }, () => {
    void state.val;
    return (status?.previousRequests ?? [])
      .map(
        (value) =>
          `${uiText.diagnosticsPreviousRequest} ${value.requestId}: ${stateLabel(value)} ${value.serverAccepted ? uiText.diagnosticsServerAccepted : uiText.diagnosticsServerUnconfirmed} Google Analytics: ${providerLabel(value.providerAccepted.analytics, value.providerStates?.analytics)}. Firebase Crashlytics: ${providerLabel(value.providerAccepted.crashlytics, value.providerStates?.crashlytics)}${value.restartRequired ? `. ${uiText.diagnosticsRestart}` : ""}`,
      )
      .join("\n");
  });
  const retentionText = p({ id: "diagnostics-retention-expired", role: "status" }, () => {
    void state.val;
    return retentionLabel(status);
  });
  const persistenceText = p(
    { id: "diagnostics-persistence-incomplete", role: "alert" },
    () => uiText.diagnosticsPersistenceIncomplete,
  );
  const stoppedText = p({ id: "diagnostics-stopped" }, () => uiText.diagnosticsStopped);
  const restartText = p(
    { id: "diagnostics-restart", role: "status" },
    () => uiText.diagnosticsRestart,
  );
  const partialText = p(
    { id: "diagnostics-partial", role: "status" },
    () => uiText.diagnosticsPartial,
  );
  const incompleteText = p(
    { id: "diagnostics-no-completion", class: "settings-note" },
    () => uiText.diagnosticsNoCompletion,
  );
  const progress = div(
    { id: "diagnostics-progress", "aria-live": "polite", "aria-atomic": "true" },
    statusText,
    requestText,
    serverText,
    awaitingLocalText,
    providerText,
    previousText,
    localText,
    stoppedText,
    retentionText,
    persistenceText,
    restartText,
    partialText,
    incompleteText,
  );
  const localButton: HTMLButtonElement = button(
    {
      id: "diagnostics-delete-local",
      type: "button",
      class: "secondary",
      disabled: true,
      onclick: () => beginConfirmation("local", localButton),
    },
    () => uiText.diagnosticsLocalAction,
  );
  const remoteButton: HTMLButtonElement = button(
    {
      id: "diagnostics-delete-remote",
      type: "button",
      class: "secondary",
      disabled: true,
      onclick: () => beginConfirmation("bound_remote", remoteButton),
    },
    () => uiText.diagnosticsRemoteAction,
  );
  const refreshButton = button(
    {
      id: "diagnostics-refresh",
      type: "button",
      class: "secondary",
      onclick: () => {
        void refresh();
      },
    },
    () => uiText.diagnosticsRefresh,
  );
  const retryButton = button(
    {
      id: "diagnostics-retry",
      type: "button",
      class: "secondary",
      hidden: true,
      onclick: () => {
        void perform("retry");
      },
    },
    () => uiText.retry,
  );
  const continueButton = button(
    {
      id: "diagnostics-continue",
      type: "button",
      class: "secondary",
      hidden: true,
      onclick: () => {
        void perform("continue");
      },
    },
    () => uiText.diagnosticsContinue,
  );
  const cancelButton = button(
    {
      id: "diagnostics-cancel",
      type: "button",
      class: "secondary",
      onclick: () => cancelConfirmation(),
    },
    () => uiText.cancel,
  );
  const confirmButton = button(
    {
      id: "diagnostics-confirm",
      type: "button",
      onclick: () => {
        if (confirming) {
          void perform("request", confirming);
        }
      },
    },
    () => uiText.diagnosticsConfirm,
  );
  const confirmation = div(
    {
      id: "diagnostics-confirmation",
      hidden: true,
      role: "group",
      "aria-labelledby": "diagnostics-confirm-title",
      "aria-describedby": "diagnostics-confirm-description",
    },
    h3({ id: "diagnostics-confirm-title" }, () => uiText.diagnosticsConfirmTitle),
    p({ id: "diagnostics-confirm-description" }, () => {
      void state.val;
      return confirming === "local"
        ? uiText.diagnosticsConfirmLocal
        : uiText.diagnosticsConfirmRemote;
    }),
    p({ class: "settings-note" }, () => uiText.diagnosticsExclusions),
    cancelButton,
    confirmButton,
  );
  const element = div(
    { class: "diagnostics-settings", id: "diagnostics-settings" },
    h3(() => uiText.diagnosticsTitle),
    p({ class: "settings-note" }, () => uiText.diagnosticsScope),
    p({ id: "diagnostics-exclusions", class: "settings-note" }, () => uiText.diagnosticsExclusions),
    p({ id: "diagnostics-retention", class: "settings-note" }, () => uiText.diagnosticsRetention),
    unavailable,
    localButton,
    remoteButton,
    confirmation,
    error,
    progress,
    div({ class: "diagnostics-status-actions" }, refreshButton, retryButton, continueButton),
  );

  function syncControls(): void {
    const locked = busy || !options.canMutate();
    localButton.disabled = locked || !!confirming || !diagnosticsAvailable(capability, "local");
    remoteButton.disabled =
      locked || !!confirming || !diagnosticsAvailable(capability, "bound_remote");
    confirmButton.disabled = locked || !confirming || !diagnosticsAvailable(capability, confirming);
    retryButton.disabled =
      locked || !!confirming || !diagnosticsAvailable(capability, "bound_remote");
    continueButton.disabled = locked || !!confirming || !diagnosticsAvailable(capability, "local");
    refreshButton.disabled = locked || !!confirming;
    cancelButton.disabled = busy;
    const retryStates = ["retry_wait", "blocked", "local_pending"];
    retryButton.hidden =
      !(status?.requestId && !status.retentionExpired && retryStates.includes(status.state)) &&
      !(status?.previousRequests ?? []).some(
        (value) => !value.retentionExpired && retryStates.includes(value.state),
      );
    continueButton.hidden =
      !(status?.restartRequired && !status.retentionExpired) &&
      !(status?.previousRequests ?? []).some(
        (value) => !value.retentionExpired && value.restartRequired,
      );
    unavailable.hidden = diagnosticsAvailable(capability, "bound_remote");
    progress.hidden = !status || (status.state === "idle" && !status.previousRequests?.length);
    previousText.hidden = !status?.previousRequests?.length;
    serverText.hidden = !status?.requestId;
    awaitingLocalText.hidden = waitingForLocal(status).length === 0;
    providerText.hidden = !status?.requestId;
    stoppedText.hidden = status?.futureTelemetry !== "disabled_persisted";
    retentionText.hidden = !status?.retentionExpired;
    persistenceText.hidden = status?.futureTelemetry !== "persistence_incomplete";
    restartText.hidden = !status?.restartRequired;
    partialText.hidden = !status?.partialFailures.length && !needsAttention(status);
    incompleteText.hidden = !(
      status?.serverAccepted ||
      status?.providerAccepted.analytics ||
      status?.providerAccepted.crashlytics
    );
    element.setAttribute("aria-busy", String(busy));
    state.val++;
  }
  function setBusy(value: boolean): void {
    busy = value;
    options.onBusyChange(value);
    syncControls();
  }
  function cancelConfirmation(restoreFocus = true): boolean {
    if (!confirming) {
      return false;
    }
    confirming = undefined;
    confirmationPolicy = undefined;
    confirmation.hidden = true;
    syncControls();
    if (restoreFocus) {
      confirmationTrigger?.focus();
    }
    confirmationTrigger = undefined;
    return true;
  }
  function beginConfirmation(
    scope: DiagnosticsDeletionRequest["scope"],
    trigger: HTMLElement,
  ): void {
    if (busy || !options.canMutate() || !diagnosticsAvailable(capability, scope)) {
      return;
    }
    confirming = scope;
    confirmationPolicy = capability?.policyVersion;
    confirmationTrigger = trigger;
    confirmation.hidden = false;
    error.hidden = true;
    syncControls();
    // Safe default: keyboard users land on Cancel, never the destructive action.
    cancelButton.focus();
  }
  function accept(incoming: DiagnosticsStatus, stopPreference = false): void {
    status = preserveDiagnosticsReceipt(
      status,
      validateDiagnosticsStatus(incoming),
      stopPreference,
    );
    if (stopPreference && status.futureTelemetry === "disabled_persisted") {
      options.onTelemetryStopped();
    }
    syncControls();
  }
  async function refresh(): Promise<void> {
    if (busy || confirming) {
      return;
    }
    const version = ++refreshVersion;
    const backend = options.getBackend();
    if (!backend) {
      capability = undefined;
      syncControls();
      return;
    }
    setBusy(true);
    try {
      const [cap, next] = await Promise.all([
        backend.diagnosticsCapabilities(),
        backend.diagnosticsStatus(),
      ]);
      if (version !== refreshVersion) {
        return;
      }
      capability = validateDiagnosticsCapabilities(cap);
      accept(next);
      error.hidden = true;
    } catch {
      if (version !== refreshVersion) {
        return;
      }
      capability = undefined;
      error.hidden = false;
      // Keep every already observed receipt. Do not send errors to normal analytics/toasts.
    } finally {
      if (version === refreshVersion) {
        setBusy(false);
      }
    }
  }
  async function perform(
    action: "request" | "retry" | "continue",
    scope?: DiagnosticsDeletionRequest["scope"],
  ): Promise<void> {
    if (busy || !options.canMutate()) {
      return;
    }
    const backend = options.getBackend();
    const requiredScope = scope ?? (action === "continue" ? "local" : "bound_remote");
    if (!backend || !diagnosticsAvailable(capability, requiredScope)) {
      return;
    }
    ++refreshVersion;
    setBusy(true);
    error.hidden = true;
    try {
      // Recheck on confirmation: capability may have changed since the dialog opened.
      capability = validateDiagnosticsCapabilities(await backend.diagnosticsCapabilities());
      if (
        !diagnosticsAvailable(capability, requiredScope) ||
        (action === "request" &&
          requiredScope === "bound_remote" &&
          capability.policyVersion !== confirmationPolicy)
      ) {
        throw new Error("diagnostics_unavailable");
      }
      const next =
        action === "request"
          ? await backend.requestDiagnosticsDeletion({ scope: scope!, confirmed: true })
          : action === "retry"
            ? await backend.retryDiagnosticsDeletion()
            : await backend.diagnosticsContinueAfterRestart();
      accept(next, action === "request");
    } catch {
      error.hidden = false;
    } finally {
      setBusy(false);
      // Closing settings while work was pending must not steal focus or re-open UI.
      const trigger = confirmationTrigger;
      const hadConfirmation = cancelConfirmation(false);
      if (hadConfirmation && element.closest("dialog")?.open) {
        trigger?.focus();
      }
      syncControls();
    }
  }
  syncControls();
  return { element, refresh, syncControls, cancelConfirmation };
}
function stateLabel(
  value:
    | (Pick<DiagnosticsStatus, "state" | "providerAccepted"> & DiagnosticsRemoteProgress)
    | undefined,
): string {
  if (!value) {
    return uiText.diagnosticsNotLoaded;
  }
  if (value.retentionExpired) {
    return retentionLabel(value);
  }
  if (
    value.providerStates?.analytics?.additionalSubmissionRequired ||
    value.providerStates?.crashlytics?.additionalSubmissionRequired
  ) {
    return uiText.diagnosticsAdditionalRequired;
  }
  if (
    value.remoteState === "operator_action_required" ||
    value.providerStates?.analytics?.state === "operator_action_required" ||
    value.providerStates?.crashlytics?.state === "operator_action_required"
  ) {
    return uiText.diagnosticsOperatorRequired;
  }
  if (value.remoteState === "retrying") {
    return uiText.diagnosticsRetryWait;
  }
  if (needsAttention(value)) {
    return uiText.diagnosticsPartial;
  }
  switch (value.state) {
    case "idle":
      return uiText.diagnosticsIdle;
    case "disabled_persisted":
      return uiText.diagnosticsStopped;
    case "snapshot_pending":
      return uiText.diagnosticsSnapshotPending;
    case "local_pending":
      return uiText.diagnosticsLocalPending;
    case "restart_required":
      return uiText.diagnosticsRestart;
    case "retry_wait":
      return uiText.diagnosticsRetryWait;
    case "accepted":
      return uiText.diagnosticsServerAccepted;
    case "provider_submitted":
      return value.providerAccepted.analytics && value.providerAccepted.crashlytics
        ? uiText.diagnosticsProviderSubmitted
        : uiText.diagnosticsProviderPartial;
    case "blocked":
      return uiText.diagnosticsBlocked;
  }
}
/** Server persistence is distinct from each provider's first submission. */
function waitingForLocal(value: DiagnosticsStatus | undefined): Array<string> {
  if (!value?.serverAccepted || value.retentionExpired) {
    return [];
  }
  const pending = [];
  if (!value.providerAccepted.analytics && value.analyticsLocal !== "reset_requested") {
    pending.push("Google Analytics");
  }
  if (
    !value.providerAccepted.crashlytics &&
    !["delete_queued", "no_unsent_reports_observed"].includes(value.crashlyticsLocal)
  ) {
    pending.push("Firebase Crashlytics");
  }
  return pending;
}

function localLabel(value: string): string {
  switch (value) {
    case "pending":
      return uiText.diagnosticsLocalPendingStep;
    case "reset_requested":
      return uiText.diagnosticsResetRequested;
    case "delete_queued":
      return uiText.diagnosticsDeleteQueued;
    case "no_unsent_reports_observed":
      return uiText.diagnosticsNoReports;
    case "restart_required":
      return uiText.diagnosticsRestart;
    case "unavailable":
    case "sdk_unavailable":
      return uiText.diagnosticsLocalUnavailable;
    case "failed":
      return uiText.diagnosticsLocalFailed;
    default:
      return uiText.diagnosticsLocalUnconfirmed;
  }
}

function needsAttention(value: DiagnosticsRemoteProgress | undefined): boolean {
  return (
    !!value &&
    (value.remoteState === "operator_action_required" ||
      [value.providerStates?.analytics, value.providerStates?.crashlytics].some(
        (provider) =>
          provider?.state === "operator_action_required" ||
          !!provider?.errorCode ||
          !!provider?.additionalSubmissionRequired,
      ))
  );
}
function providerLabel(
  accepted: boolean,
  value: DiagnosticsProviderState | null | undefined,
): string {
  const receipt = accepted
    ? uiText.diagnosticsProviderAccepted
    : uiText.diagnosticsProviderUnconfirmed;
  if (value?.additionalSubmissionRequired) {
    return `${receipt}; ${uiText.diagnosticsAdditionalRequired}`;
  }
  if (value?.state === "operator_action_required") {
    return `${receipt}; ${uiText.diagnosticsOperatorRequired}`;
  }
  if (value?.state === "retry_wait") {
    return `${receipt}; ${uiText.diagnosticsRetryWait}`;
  }
  if (value?.errorCode) {
    return `${receipt}; ${uiText.diagnosticsPartial}`;
  }
  if (value?.state === "queued" || value?.state === "in_flight") {
    return `${receipt}; ${uiText.diagnosticsProviderPending}`;
  }
  if (value?.state === "unsupported") {
    return `${receipt}; ${uiText.diagnosticsLocalUnavailable}`;
  }
  return receipt;
}

function retentionLabel(value: DiagnosticsRemoteProgress | undefined): string {
  if (value?.keyCleanupPending === false) {
    return uiText.diagnosticsRetentionExpired;
  }
  return value?.keyCleanupPending === true
    ? uiText.diagnosticsRetentionCleanupPending
    : uiText.diagnosticsRetentionCleanupUnknown;
}
