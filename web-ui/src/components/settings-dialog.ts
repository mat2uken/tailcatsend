import van from "vanjs-core";
import { uiText } from "../i18n";

const { button, h2, input, label, p } = van.tags;

const TELEMETRY_STORAGE_KEY = "ponlet.telemetry";

export interface SettingsDialogComponent {
  closeSettings(): void;
  dialog: HTMLDialogElement;
  openSettings(triggerElement?: HTMLElement | null): void;
}

export function createSettingsDialog(): SettingsDialogComponent {
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "settings-dialog-title");
  let returnFocus: HTMLElement | null = null;
  const telemetryToggle = input({ id: "settings-telemetry-toggle", type: "checkbox" });
  telemetryToggle.checked = localStorage.getItem(TELEMETRY_STORAGE_KEY) !== "off";

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
    const activeElement = document.activeElement;
    returnFocus =
      triggerElement ??
      (activeElement && activeElement.nodeType === 1 ? (activeElement as HTMLElement) : null);
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }

  dialog.className = "settings-dialog";
  dialog.append(
    h2({ id: "settings-dialog-title" }, uiText.settings),
    p(uiText.settingsDescription),
    label(
      { class: "settings-toggle", for: "settings-telemetry-toggle" },
      telemetryToggle,
      uiText.allowTelemetry,
    ),
    button(
      { class: "secondary dialog-close", type: "button", onclick: () => closeSettings() },
      uiText.close,
    ),
  );

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSettings();
  });

  telemetryToggle.addEventListener("change", () => {
    localStorage.setItem(TELEMETRY_STORAGE_KEY, telemetryToggle.checked ? "on" : "off");
  });

  return {
    closeSettings,
    dialog,
    openSettings,
  };
}
