import van from "vanjs-core";
import { isJapanese, uiText } from "../i18n";

const { button, h2, input, label, p } = van.tags;

const TELEMETRY_STORAGE_KEY = "ponlet.telemetry";

export interface SettingsDialogComponent {
  closeSettings(): void;
  dialog: HTMLDialogElement;
  openSettings(triggerElement?: HTMLElement | null): void;
}

export function createSettingsDialog(): SettingsDialogComponent {
  const dialog = document.createElement("dialog");
  let returnFocus: HTMLElement | null = null;
  const telemetryToggle = input({ type: "checkbox" });
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
    h2(uiText.settings),
    p(uiText.settingsDescription),
    label(
      { class: "settings-toggle" },
      telemetryToggle,
      isJapanese ? "テレメトリを許可" : "Allow telemetry",
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
