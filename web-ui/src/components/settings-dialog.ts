import van from "vanjs-core";
import { language, setLanguage, uiText, type Language } from "../i18n";

const { button, h2, input, label, p, select, option } = van.tags;

export interface SettingsDialogOptions {
  canConfigureTelemetry?: () => boolean;
  getTelemetryEnabled?: () => Promise<boolean>;
  onError?: (error: unknown) => void;
  setTelemetryEnabled?: (enabled: boolean) => Promise<void>;
}
export interface SettingsDialogComponent {
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
  const telemetryToggle = input({
    id: "settings-telemetry-toggle",
    type: "checkbox",
    disabled: true,
  });
  const telemetryNotice = p({ class: "settings-note" }, () => uiText.telemetryUnavailable);
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

  function canConfigureTelemetry(): boolean {
    return Boolean(
      options.getTelemetryEnabled &&
      options.setTelemetryEnabled &&
      (options.canConfigureTelemetry?.() ?? true),
    );
  }
  async function refreshSettings(): Promise<void> {
    if (telemetryBusy) {
      return;
    }
    const available = canConfigureTelemetry();
    telemetryToggle.disabled = true;
    telemetryNotice.hidden = available;
    if (!available) {
      return;
    }
    telemetryBusy = true;
    try {
      telemetryToggle.checked = await options.getTelemetryEnabled!();
      telemetryToggle.disabled = false;
    } catch (error) {
      options.onError?.(error);
    } finally {
      telemetryBusy = false;
    }
  }
  function closeSettings(): void {
    if (typeof dialog.close === "function") {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
    returnFocus?.focus();
    returnFocus = null;
  }
  function openSettings(triggerElement?: HTMLElement | null): void {
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
    telemetryNotice,
    button(
      { class: "secondary dialog-close", type: "button", onclick: closeSettings },
      () => uiText.close,
    ),
  );
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSettings();
  });
  telemetryToggle.addEventListener("change", () => {
    if (telemetryBusy || !canConfigureTelemetry()) {
      return;
    }
    const enabled = telemetryToggle.checked;
    telemetryBusy = true;
    telemetryToggle.disabled = true;
    void options.setTelemetryEnabled!(enabled)
      .catch((error: unknown) => {
        telemetryToggle.checked = !enabled;
        options.onError?.(error);
      })
      .finally(() => {
        telemetryBusy = false;
        telemetryToggle.disabled = !canConfigureTelemetry();
      });
  });
  return { closeSettings, dialog, openSettings, refreshSettings };
}
