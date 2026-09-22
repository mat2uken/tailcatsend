import van from "vanjs-core";
import { placeAnchor, type PositionOptions } from "./position";

const { div } = van.tags;

interface ToastOptions {
  anchor?: HTMLElement;
  duration?: number;
  positionOptions?: PositionOptions;
}

let toastContainer: HTMLDivElement | null = null;
let activeAnchorDismiss: (() => void) | null = null;

function getOrCreateContainer(): HTMLDivElement {
  if (!toastContainer || !document.body.contains(toastContainer)) {
    toastContainer = div({
      class: "toast-container",
      role: "region",
      "aria-label": "Notifications",
    });
    document.body.append(toastContainer);
  }
  return toastContainer;
}

/** Shows a toast and returns an idempotent dismissal callback. */
export function showToast(message: string, durationOrOptions?: number | ToastOptions): () => void {
  const {
    duration = 2500,
    anchor,
    positionOptions,
  } = typeof durationOrOptions === "number"
    ? { duration: durationOrOptions }
    : (durationOrOptions ?? {});
  if (anchor) {
    activeAnchorDismiss?.();
  }
  const container = anchor ? document.body : getOrCreateContainer();
  const toastEl = div(
    {
      class: anchor ? "toast-anchor toast" : "toast",
      role: "status",
      "aria-live": "polite",
    },
    message,
  );
  container.append(toastEl);
  if (anchor) {
    placeAnchor(anchor, toastEl, positionOptions);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dismissed = false;
  const dismiss = (): void => {
    if (dismissed) {
      return;
    }
    dismissed = true;
    clearTimeout(timer);
    toastEl.remove();
    if (anchor) {
      if (activeAnchorDismiss === dismiss) {
        activeAnchorDismiss = null;
      }
    } else if (container.childNodes.length === 0) {
      container.remove();
      if (toastContainer === container) {
        toastContainer = null;
      }
    }
  };
  if (anchor) {
    activeAnchorDismiss = dismiss;
  }
  if (duration > 0) {
    timer = setTimeout(dismiss, duration);
  }
  return dismiss;
}
