import van from "vanjs-core";
import { placeAnchor, type PositionOptions } from "./position";

const { div } = van.tags;

export interface ToastOptions {
  anchor?: HTMLElement;
  duration?: number;
  positionOptions?: PositionOptions;
}

let toastContainer: HTMLDivElement | null = null;
let activeAnchorDismiss: (() => void) | null = null;

function getOrCreateContainer(): HTMLDivElement {
  if (!toastContainer || !document.body.contains(toastContainer)) {
    toastContainer = div({
      class: "toast-container c-toast-container",
      role: "region",
      "aria-label": "Notifications",
    });
    document.body.append(toastContainer);
  }
  return toastContainer;
}

/**
 * Shows a lightweight toast notification.
 * Auto-cleans and unmounts container from body when empty (zero memory leak).
 * Automatically cancels timers on dismiss to avoid timer leaks.
 * Supports anchor-positioned notifications using placeAnchor.
 */
export function showToast(message: string, duration?: number): () => void;
export function showToast(message: string, options?: ToastOptions): () => void;
export function showToast(message: string, durationOrOptions?: number | ToastOptions): () => void {
  const options: ToastOptions =
    typeof durationOrOptions === "number"
      ? { duration: durationOrOptions }
      : (durationOrOptions ?? {});

  const { duration = 2500, anchor, positionOptions } = options;

  if (anchor) {
    if (activeAnchorDismiss) {
      activeAnchorDismiss();
      activeAnchorDismiss = null;
    }

    const toastEl = div(
      {
        class: "toast-anchor toast c-toast",
        role: "status",
        "aria-live": "polite",
      },
      message,
    );
    document.body.append(toastEl);
    placeAnchor(anchor, toastEl, positionOptions);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let dismissed = false;

    const dismiss = () => {
      if (dismissed) {
        return;
      }
      dismissed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (toastEl.parentNode) {
        toastEl.remove();
      }
      if (activeAnchorDismiss === dismiss) {
        activeAnchorDismiss = null;
      }
    };

    activeAnchorDismiss = dismiss;

    if (duration > 0) {
      timer = setTimeout(dismiss, duration);
    }

    return dismiss;
  }

  const container = getOrCreateContainer();
  const toastEl = div(
    {
      class: "toast c-toast",
      role: "status",
      "aria-live": "polite",
    },
    message,
  );
  container.append(toastEl);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let dismissed = false;

  const dismiss = () => {
    if (dismissed) {
      return;
    }
    dismissed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (toastEl.parentNode) {
      toastEl.remove();
    }
    if (toastContainer && toastContainer.childNodes.length === 0) {
      toastContainer.remove();
      toastContainer = null;
    }
  };

  if (duration > 0) {
    timer = setTimeout(dismiss, duration);
  }

  return dismiss;
}

export function showAnchorToast(
  anchor: HTMLElement,
  message: string,
  duration?: number,
  positionOptions?: PositionOptions,
): () => void {
  return showToast(message, { anchor, duration, positionOptions });
}
