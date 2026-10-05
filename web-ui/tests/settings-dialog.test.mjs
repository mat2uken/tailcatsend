import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsDialog } from "../src/components/settings-dialog.ts";
import { setLanguage } from "../src/i18n.ts";

const flush = async () => {
  for (let index = 0; index < 24; index++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
};

const pending = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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

  it("loads and writes telemetry, rereading the saved value after a failed write", async () => {
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
    expect(getTelemetryEnabled).toHaveBeenCalledTimes(2);
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

  it.each([false, true])(
    "shows saved %s when native commits the preference before an SDK error",
    async (saved) => {
      let persisted = !saved;
      const sdkError = new Error("SDK operation failed after preference commit");
      const getTelemetryEnabled = vi.fn(async () => persisted);
      const setTelemetryEnabled = vi.fn(async (enabled) => {
        persisted = enabled;
        throw sdkError;
      });
      const onError = vi.fn();
      const component = createSettingsDialog({
        getTelemetryEnabled,
        setTelemetryEnabled,
        onError,
      });
      document.body.append(component.dialog);
      component.openSettings();
      await flush();
      const toggle = component.dialog.querySelector("#settings-telemetry-toggle");
      toggle.checked = saved;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();

      expect(persisted).toBe(saved);
      expect(toggle.checked).toBe(saved);
      expect(toggle.indeterminate).toBe(false);
      expect(toggle.disabled).toBe(false);
      expect(getTelemetryEnabled).toHaveBeenCalledTimes(2);
      expect(setTelemetryEnabled).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledExactlyOnceWith(sdkError);
      expect(component.dialog.querySelector("#settings-telemetry-unavailable").hidden).toBe(true);
      expect(component.dialog.querySelector("#diagnostics-stopped").hidden).toBe(true);
      expect(component.dialog.querySelector("#diagnostics-progress").hidden).toBe(true);
    },
  );

  it.each([
    [false, "refresh"],
    [true, "refresh"],
    [false, "reopen"],
    [true, "reopen"],
  ])("keeps saved %s unknown after readback fails until %s succeeds", async (saved, recovery) => {
    const recoveryRead = pending();
    const sdkError = new Error("SDK operation failed after preference commit");
    const readError = new Error("preference readback failed");
    const getTelemetryEnabled = vi
      .fn()
      .mockResolvedValueOnce(!saved)
      .mockRejectedValueOnce(readError)
      .mockImplementation(() => recoveryRead.promise);
    const setTelemetryEnabled = vi.fn().mockRejectedValue(sdkError);
    const onError = vi.fn();
    const component = createSettingsDialog({
      getTelemetryEnabled,
      setTelemetryEnabled,
      onError,
    });
    document.body.append(component.dialog);
    component.openSettings();
    await flush();
    const toggle = component.dialog.querySelector("#settings-telemetry-toggle");
    const notice = component.dialog.querySelector("#settings-telemetry-unavailable");
    toggle.checked = saved;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    expect(toggle.indeterminate).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(notice.hidden).toBe(false);
    expect(onError).toHaveBeenNthCalledWith(1, sdkError);
    expect(onError).toHaveBeenNthCalledWith(2, readError);
    // Even an explicitly dispatched change cannot write while unavailable.
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(setTelemetryEnabled).toHaveBeenCalledTimes(1);

    if (recovery === "reopen") {
      component.closeSettings();
      component.openSettings();
    } else {
      void component.refreshSettings();
    }
    await flush();
    expect(toggle.indeterminate).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(notice.hidden).toBe(false);
    recoveryRead.resolve(saved);
    await flush();
    expect(toggle.checked).toBe(saved);
    expect(toggle.indeterminate).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(notice.hidden).toBe(true);
    expect(getTelemetryEnabled).toHaveBeenCalledTimes(3);
    expect(setTelemetryEnabled).toHaveBeenCalledTimes(1);
  });

  it("serializes writes and readback across repeated changes, refresh and close/reopen", async () => {
    const write = pending();
    const readback = pending();
    const sdkError = new Error("SDK stop failed after OFF commit");
    const getTelemetryEnabled = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockImplementation(() => readback.promise);
    const setTelemetryEnabled = vi.fn(() => write.promise);
    const onError = vi.fn();
    const component = createSettingsDialog({
      getTelemetryEnabled,
      setTelemetryEnabled,
      onError,
    });
    document.body.append(component.dialog);
    component.openSettings();
    await flush();
    const toggle = component.dialog.querySelector("#settings-telemetry-toggle");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    for (let i = 0; i < 20; i++) {
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
      void component.refreshSettings();
    }
    component.closeSettings();
    component.openSettings();
    await flush();
    expect(setTelemetryEnabled).toHaveBeenCalledTimes(1);
    expect(getTelemetryEnabled).toHaveBeenCalledTimes(1);
    write.reject(sdkError);
    await flush();
    expect(getTelemetryEnabled).toHaveBeenCalledTimes(2);
    expect(toggle.indeterminate).toBe(true);
    expect(toggle.disabled).toBe(true);
    component.closeSettings();
    component.openSettings();
    await component.refreshSettings();
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(getTelemetryEnabled).toHaveBeenCalledTimes(2);
    component.closeSettings();
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    readback.resolve(false);
    await flush();
    expect(component.dialog.open).toBe(false);
    expect(document.activeElement).toBe(other);
    expect(toggle.checked).toBe(false);
    expect(toggle.indeterminate).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(setTelemetryEnabled).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(sdkError);
  });

  it("keeps the Android diagnostic scope visible when telemetry is off in both languages", async () => {
    const component = createSettingsDialog({
      getTelemetryEnabled: async () => false,
      setTelemetryEnabled: async () => {},
    });
    document.body.append(component.dialog);
    component.openSettings();
    await flush();
    const toggle = component.dialog.querySelector("#settings-telemetry-toggle");
    const description = component.dialog.querySelector("#settings-telemetry-description");
    expect(toggle.checked).toBe(false);
    expect(toggle.getAttribute("aria-describedby")).toBe(description.id);
    expect(description.hidden).toBe(false);
    expect(description.textContent).toContain("enabled by default");
    expect(description.textContent).toContain("not disabled by this setting");
    setLanguage("ja");
    await flush();
    expect(description.textContent).toContain("既定で有効");
    expect(description.textContent).toContain("この設定の対象外");
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
    const notice = component.dialog.querySelector("#settings-telemetry-unavailable");
    const toggle = component.dialog.querySelector("#settings-telemetry-toggle");
    expect(notice.hidden).toBe(false);
    expect(toggle.disabled).toBe(true);
    expect(toggle.indeterminate).toBe(true);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "preference read failed" }),
    );
  });

  it("keeps telemetry unavailable when the adapter has no setting methods", async () => {
    const component = createSettingsDialog();
    document.body.append(component.dialog);

    component.openSettings();
    await component.refreshSettings();
    expect(component.dialog.querySelector("#settings-telemetry-unavailable").hidden).toBe(false);
    expect(component.dialog.querySelector("#settings-telemetry-toggle").disabled).toBe(true);
  });
});
