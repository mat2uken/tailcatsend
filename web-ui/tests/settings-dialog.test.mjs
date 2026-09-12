import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsDialog } from "../src/components/settings-dialog.ts";
import { setLanguage } from "../src/i18n.ts";

const flush = async () => {
  for (let index = 0; index < 6; index++) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  const saved = new Map();
  vi.stubGlobal("localStorage", {
    clear: () => saved.clear(),
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, String(value)),
  });
  setLanguage("en");
  document.body.replaceChildren();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("settings dialog", () => {
  it("persists the language, updates labels, and restores focus", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Settings";
    document.body.append(trigger);
    const component = createSettingsDialog({
      getTelemetryEnabled: async () => true,
      setTelemetryEnabled: async () => {},
    });
    document.body.append(component.dialog);

    trigger.focus();
    component.openSettings(trigger);
    await flush();
    const language = component.dialog.querySelector("#settings-language");
    expect(language).not.toBeNull();
    expect(language.value).toBe("en");
    expect(component.dialog.querySelector("h2").textContent).toBe("Settings");

    language.value = "ja";
    language.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(localStorage.getItem("ponlet.language")).toBe("ja");
    expect(language.value).toBe("ja");
    expect(component.dialog.querySelector("h2").textContent).toBe("設定");

    component.closeSettings();
    expect(document.activeElement).toBe(trigger);
  });

  it("loads and writes telemetry, restoring the toggle after a failed write", async () => {
    const getTelemetryEnabled = vi.fn().mockResolvedValue(false);
    const setTelemetryEnabled = vi
      .fn()
      .mockRejectedValueOnce(new Error("preference write failed"))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const component = createSettingsDialog({
      getTelemetryEnabled,
      setTelemetryEnabled,
      onError,
    });
    document.body.append(component.dialog);

    component.openSettings();
    const toggle = component.dialog.querySelector("#settings-telemetry-toggle");
    await flush();
    expect(getTelemetryEnabled).toHaveBeenCalledTimes(1);
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(toggle.disabled).toBe(true);
    await flush();
    expect(setTelemetryEnabled).toHaveBeenNthCalledWith(1, true);
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "preference write failed" }),
    );

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(setTelemetryEnabled).toHaveBeenNthCalledWith(2, true);
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
  });

  it("shows the unavailable notice when the native preference cannot be read", async () => {
    const onError = vi.fn();
    const component = createSettingsDialog({
      getTelemetryEnabled: async () => {
        throw new Error("preference read failed");
      },
      setTelemetryEnabled: async () => {},
      onError,
    });
    document.body.append(component.dialog);

    component.openSettings();
    await flush();
    const notice = component.dialog.querySelector(".settings-note");
    const toggle = component.dialog.querySelector("#settings-telemetry-toggle");
    expect(notice.hidden).toBe(false);
    expect(toggle.disabled).toBe(true);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "preference read failed" }),
    );
  });

  it("keeps telemetry unavailable when the adapter has no setting methods", async () => {
    const component = createSettingsDialog();
    document.body.append(component.dialog);

    component.openSettings();
    await component.refreshSettings();
    expect(component.dialog.querySelector(".settings-note").hidden).toBe(false);
    expect(component.dialog.querySelector("#settings-telemetry-toggle").disabled).toBe(true);
  });
});
