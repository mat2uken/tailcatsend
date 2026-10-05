import van from "vanjs-core";
import type { DiagnosticsBackend } from "../api/diagnostics-api";
import { createDiagnosticsSettings } from "../diagnostics/settings-section";
import { language, setLanguage, uiText, type Language } from "../i18n";

const { button, h2, input, label, p, select, option } = van.tags;

interface SettingsDialogOptions {
  canConfigureTelemetry?: () => boolean;
  getDiagnosticsBackend?: () => DiagnosticsBackend | undefined;
  getTelemetryEnabled?: () => Promise<boolean>;
  onError?: (error: unknown) => void;
  setTelemetryEnabled?: (enabled: boolean) => Promise<void>;
}
interface SettingsDialogComponent {
  closeSettings(): void;
  dialog: HTMLDialogElement;
  openSettings(triggerElement?: HTMLElement | null): void;
  refreshSettings(): Promise<void>;
}

export function createSettingsDialog(options: SettingsDialogOptions = {}): SettingsDialogComponent {
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "settings-dialog-title");
  let returnFocus: HTMLElement | null = null;
  let telemetryBusy = false;
  let diagnosticsBusy = false;
  let telemetryAvailable = false;
  const telemetryToggle = input({
    id: "settings-telemetry-toggle",
    type: "checkbox",
    disabled: true,
    indeterminate: true,
    "aria-describedby": "settings-telemetry-description",
  });
  const telemetryNotice = p(
    { id: "settings-telemetry-unavailable", class: "settings-note" },
    () => uiText.telemetryUnavailable,
  );
  const languageSelect = select(
    {
      id: "settings-language",
      onchange: (event: Event) => {
        setLanguage((event.target as HTMLSelectElement).value as Language);
      },
    },
    option({ value: "ja" }, "日本語"),
    option({ value: "en" }, "English"),
  );
  van.derive(() => {
    languageSelect.value = language.val;
  });

  const diagnostics = createDiagnosticsSettings({
    getBackend: () => options.getDiagnosticsBackend?.(),
    canMutate: () => !telemetryBusy,
    onBusyChange: (busy) => {
      diagnosticsBusy = busy;
      telemetryToggle.disabled = busy || telemetryBusy || !telemetryAvailable;
    },
    onTelemetryStopped: () => {
      telemetryToggle.checked = false;
    },
  });

  function canConfigureTelemetry(): boolean {
    return Boolean(
      options.getTelemetryEnabled &&
      options.setTelemetryEnabled &&
      (options.canConfigureTelemetry?.() ?? true),
    );
  }
  async function readTelemetryPreference(): Promise<void> {
    telemetryAvailable = false;
    telemetryToggle.indeterminate = true;
    try {
      telemetryToggle.checked = await options.getTelemetryEnabled!();
      telemetryToggle.indeterminate = false;
      telemetryAvailable = true;
      telemetryNotice.hidden = true;
    } catch (error) {
      // An unreadable preference is unknown, not evidence for either ON or OFF.
      telemetryNotice.hidden = false;
      options.onError?.(error);
    }
  }
  async function refreshSettings(): Promise<void> {
    if (telemetryBusy || diagnosticsBusy) {
      return;
    }
    const available = canConfigureTelemetry();
    telemetryAvailable = false;
    telemetryToggle.indeterminate = true;
    telemetryToggle.disabled = true;
    if (!available) {
      telemetryNotice.hidden = false;
      await diagnostics.refresh();
      return;
    }
    telemetryBusy = true;
    diagnostics.syncControls();
    try {
      await readTelemetryPreference();
    } finally {
      telemetryBusy = false;
      telemetryToggle.disabled = diagnosticsBusy || !telemetryAvailable || !canConfigureTelemetry();
      diagnostics.syncControls();
    }
    await diagnostics.refresh();
  }
  function closeSettings(): void {
    diagnostics.cancelConfirmation(false);
    if (typeof dialog.close === "function") {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
    returnFocus?.focus();
    returnFocus = null;
  }
  function openSettings(triggerElement?: HTMLElement | null): void {
    if (dialog.open) {
      return;
    }
    returnFocus = triggerElement ?? (document.activeElement as HTMLElement | null);
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
    void refreshSettings();
  }
  dialog.className = "settings-dialog";
  dialog.append(
    h2({ id: "settings-dialog-title" }, () => uiText.settings),
    p(() => uiText.settingsDescription),
    label(
      { class: "settings-language", for: "settings-language" },
      () => uiText.languageLabel,
      languageSelect,
    ),
    label(
      { class: "settings-toggle", for: "settings-telemetry-toggle" },
      telemetryToggle,
      () => uiText.allowTelemetry,
    ),
    p(
      { id: "settings-telemetry-description", class: "settings-note" },
      () => uiText.telemetryDescription,
    ),
    telemetryNotice,
    diagnostics.element,
    button(
      { class: "secondary dialog-close", type: "button", onclick: closeSettings },
      () => uiText.close,
    ),
  );
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!diagnostics.cancelConfirmation()) {
      closeSettings();
    }
  });
  telemetryToggle.addEventListener("change", () => {
    if (telemetryBusy || diagnosticsBusy || !telemetryAvailable || !canConfigureTelemetry()) {
      return;
    }
    const enabled = telemetryToggle.checked;
    telemetryBusy = true;
    diagnostics.syncControls();
    telemetryToggle.disabled = true;
    void Promise.resolve()
      .then(() => options.setTelemetryEnabled!(enabled))
      .catch(async (error: unknown) => {
        // Native saving may commit before an SDK operation fails. Only a fresh
        // preference read can tell us which value was persisted.
        options.onError?.(error);
        await readTelemetryPreference();
      })
      .finally(() => {
        telemetryBusy = false;
        telemetryToggle.disabled =
          diagnosticsBusy || !telemetryAvailable || !canConfigureTelemetry();
        diagnostics.syncControls();
      });
  });
  return { closeSettings, dialog, openSettings, refreshSettings };
}
