import van from "vanjs-core";
import { uiText } from "../i18n";

const { button, h2, p } = van.tags;

type BarcodeDetectorLike = {
  detect(video: HTMLVideoElement): Promise<Array<{ rawValue?: string }>>;
};
type BarcodeDetectorConstructorLike = new (options?: {
  formats?: Array<string>;
}) => BarcodeDetectorLike;

export interface ScannerDialogComponent {
  closeScanner(): void;
  dialog: HTMLDialogElement;
  openScanner(triggerElement?: HTMLElement | null): Promise<string | null>;
}

export function createScannerDialog(): ScannerDialogComponent {
  const dialog = document.createElement("dialog");
  const video = document.createElement("video");
  video.className = "scanner-video";
  video.autoplay = true;
  video.playsInline = true;
  dialog.className = "scanner-dialog";

  let stream: MediaStream | undefined;
  let frame = 0;
  let returnFocus: HTMLElement | null = null;

  function closeScanner(): void {
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    video.srcObject = null;
    if (typeof dialog.close === "function") {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
    returnFocus?.focus();
    returnFocus = null;
  }

  dialog.append(
    h2(uiText.scan),
    video,
    p({ class: "scanner-status" }, ""),
    button({ type: "button", onclick: () => closeScanner() }, uiText.close),
  );

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeScanner();
  });

  async function openScanner(triggerElement?: HTMLElement | null): Promise<string | null> {
    const Detector = (
      globalThis as typeof globalThis & {
        BarcodeDetector?: BarcodeDetectorConstructorLike;
      }
    ).BarcodeDetector;
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      throw new Error(uiText.scanUnavailable);
    }
    const activeElement = document.activeElement;
    returnFocus =
      triggerElement ??
      (activeElement && activeElement.nodeType === 1 ? (activeElement as HTMLElement) : null);
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    video.srcObject = stream;
    await video.play();
    const detector = new Detector({ formats: ["qr_code"] });
    return new Promise<string | null>((resolve) => {
      const poll = async (): Promise<void> => {
        if (!stream) {
          resolve(null);
          return;
        }
        try {
          const codes = await detector.detect(video);
          const value = codes.find((code) => typeof code.rawValue === "string")?.rawValue;
          if (value) {
            resolve(value);
            closeScanner();
            return;
          }
        } catch {
          // Camera frames can be unavailable while the WebView rotates or resumes.
        }
        frame = requestAnimationFrame(() => void poll());
      };
      void poll();
    });
  }

  return {
    closeScanner,
    dialog,
    openScanner,
  };
}
