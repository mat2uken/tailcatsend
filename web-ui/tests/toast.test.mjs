import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showAnchorToast, showToast } from "../src/lib/toast.ts";

describe("Lightweight Toast Notification System", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("renders toast in container and automatically removes container when expired", () => {
    showToast("Hello Toast", 1000);

    const container = document.querySelector(".toast-container");
    expect(container).not.toBeNull();
    expect(container?.textContent).toContain("Hello Toast");

    const toast = container?.querySelector(".toast");
    expect(toast).not.toBeNull();

    // Fast-forward half the duration: toast should still be visible
    vi.advanceTimersByTime(500);
    expect(document.querySelector(".toast")).not.toBeNull();
    expect(document.querySelector(".toast-container")).not.toBeNull();

    // Fast-forward past duration: toast and empty container should be unmounted
    vi.advanceTimersByTime(501);
    expect(document.querySelector(".toast")).toBeNull();
    expect(document.querySelector(".toast-container")).toBeNull();
  });

  it("supports manual dismissal and immediately unmounts", () => {
    const dismiss = showToast("Manual dismiss", 5000);

    expect(document.querySelector(".toast-container")).not.toBeNull();
    expect(document.querySelector(".toast")).not.toBeNull();

    dismiss();

    expect(document.querySelector(".toast")).toBeNull();
    expect(document.querySelector(".toast-container")).toBeNull();

    // Advancing timers should not cause errors
    vi.advanceTimersByTime(6000);
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("stacks multiple toasts and cleans up each individually", () => {
    const dismiss1 = showToast("Toast 1", 1000);
    showToast("Toast 2", 2000);

    const container = document.querySelector(".toast-container");
    expect(container).not.toBeNull();
    const toasts = container?.querySelectorAll(".toast");
    expect(toasts?.length).toBe(2);

    // Manually dismiss first toast
    dismiss1();
    expect(container?.querySelectorAll(".toast").length).toBe(1);
    expect(container?.textContent).toContain("Toast 2");
    // Container still exists because Toast 2 is active
    expect(document.querySelector(".toast-container")).not.toBeNull();

    // Fast-forward past Toast 2 duration
    vi.advanceTimersByTime(2000);
    expect(document.querySelector(".toast")).toBeNull();
    expect(document.querySelector(".toast-container")).toBeNull();
  });

  it("positions anchor toast and clears on timeout", () => {
    const button = document.createElement("button");
    button.textContent = "Invite";
    document.body.append(button);

    showToast("Invite copied", { anchor: button, duration: 1200 });

    const anchorToast = document.querySelector(".toast-anchor");
    expect(anchorToast).not.toBeNull();
    expect(anchorToast?.textContent).toBe("Invite copied");
    expect(anchorToast?.style.position).toBe("fixed");

    // Fast-forward past duration
    vi.advanceTimersByTime(1200);
    expect(document.querySelector(".toast-anchor")).toBeNull();
  });

  it("supports showAnchorToast helper", () => {
    const link = document.createElement("a");
    document.body.append(link);

    const dismiss = showAnchorToast(link, "Anchor Helper", 1000);
    expect(document.querySelector(".toast-anchor")?.textContent).toBe("Anchor Helper");

    dismiss();
    expect(document.querySelector(".toast-anchor")).toBeNull();
  });

  it("cancels previous timer on rapid anchor clicks avoiding timer race and premature hide", () => {
    const link = document.createElement("a");
    document.body.append(link);

    // First click: duration 1000ms
    showToast("First click", { anchor: link, duration: 1000 });
    expect(document.querySelector(".toast-anchor")?.textContent).toBe("First click");

    // Advance 600ms
    vi.advanceTimersByTime(600);

    // Second click: duration 1000ms
    showToast("Second click", { anchor: link, duration: 1000 });

    // The toast should now show "Second click" and only one anchor toast should exist
    const toasts = document.querySelectorAll(".toast-anchor");
    expect(toasts.length).toBe(1);
    expect(toasts[0]?.textContent).toBe("Second click");

    // Advance 500ms (1100ms from first click).
    // If the old timer had not been cleared, it would have fired at 1000ms and closed the second toast!
    vi.advanceTimersByTime(500);
    expect(document.querySelector(".toast-anchor")).not.toBeNull();
    expect(document.querySelector(".toast-anchor")?.textContent).toBe("Second click");

    // Advance remaining 501ms (total 1001ms from second click): now it should disappear
    vi.advanceTimersByTime(501);
    expect(document.querySelector(".toast-anchor")).toBeNull();
  });
});
