import van from "vanjs-core";
import { uiText } from "../i18n";

const { button, div, h2, p } = van.tags;
type BarcodeDetectorLike = {
  detect(video: HTMLVideoElement): Promise<Array<{ rawValue?: string }>>;
};
type BarcodeDetectorConstructorLike = new (options?: {
  formats?: Array<string>;
}) => BarcodeDetectorLike;
type QrDecoder = typeof import("jsqr").default;

export interface ScannerDialogComponent {
  closeScanner(): void;
  dialog: HTMLDialogElement;
  openNativeScanner(
    scan: () => Promise<string | null>,
    cancel: () => Promise<void>,
    triggerElement?: HTMLElement | null,
  ): Promise<string | null>;
  openScanner(triggerElement?: HTMLElement | null): Promise<string | null>;
}

export function canScanWithCamera(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

export function createScannerDialog(): ScannerDialogComponent {
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "scanner-dialog-title");
  dialog.className = "scanner-dialog";
  const video = document.createElement("video");
  video.className = "scanner-video";
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  const canvas = document.createElement("canvas");
  const status = p({ class: "scanner-status", role: "status" }, () => uiText.scannerStarting);
  let stream: MediaStream | undefined;
  let frame = 0;
  let generation = 0;
  let returnFocus: HTMLElement | null = null;
  let nativeCancel: (() => Promise<void>) | undefined;
  let settle: ((value: string | null) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;

  function cleanup(): void {
    generation++;
    document.documentElement.classList.remove("native-scanning");
    dialog.classList.remove("native-scanner");
    cancelAnimationFrame(frame);
    frame = 0;
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
  function finish(value: string | null, error?: unknown): void {
    const resolve = settle;
    const reject = fail;
    settle = undefined;
    fail = undefined;
    cleanup();
    if (error !== undefined) {
      reject?.(error);
    } else {
      resolve?.(value);
    }
  }
  function closeScanner(): void {
    const cancel = nativeCancel;
    nativeCancel = undefined;
    finish(null);
    if (cancel) {
      void cancel().catch(() => {});
    }
  }
  function openNativeScanner(
    scan: () => Promise<string | null>,
    cancel: () => Promise<void>,
    triggerElement?: HTMLElement | null,
  ): Promise<string | null> {
    closeScanner();
    const current = generation;
    returnFocus = triggerElement ?? (document.activeElement as HTMLElement | null);
    nativeCancel = cancel;
    const pending = new Promise<string | null>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    document.documentElement.classList.add("native-scanning");
    dialog.classList.add("native-scanner");
    status.textContent = uiText.scannerReady;
    try {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
      void scan()
        .then((value) => {
          if (current === generation) {
            nativeCancel = undefined;
            finish(value);
          }
        })
        .catch((error: unknown) => {
          if (current === generation) {
            nativeCancel = undefined;
            finish(null, error);
          }
        });
    } catch (error) {
      nativeCancel = undefined;
      finish(null, error);
    }
    return pending;
  }
  dialog.append(
    h2({ id: "scanner-dialog-title" }, () => uiText.scan),
    div({ class: "scanner-preview" }, video, div({ class: "scanner-reticle" })),
    status,
    button(
      { class: "secondary dialog-close", type: "button", onclick: closeScanner },
      () => uiText.close,
    ),
  );
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeScanner();
  });
  dialog.addEventListener("close", () => {
    if (settle && !dialog.open) {
      closeScanner();
    }
  });

  function openScanner(triggerElement?: HTMLElement | null): Promise<string | null> {
    closeScanner();
    if (!canScanWithCamera()) {
      return Promise.reject(new Error(uiText.scanUnavailable));
    }
    const current = generation;
    returnFocus = triggerElement ?? (document.activeElement as HTMLElement | null);
    const pending = new Promise<string | null>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    // Install the cancellation resolver before either the dialog or the permission request.
    void (async () => {
      try {
        status.textContent = uiText.scannerStarting;
        if (typeof dialog.showModal === "function") {
          dialog.showModal();
        } else {
          dialog.setAttribute("open", "");
        }
        const acquired = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (current !== generation) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = acquired;
        video.srcObject = acquired;
        await video.play();
        if (current !== generation) {
          return;
        }
        const Detector = (
          globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructorLike }
        ).BarcodeDetector;
        let detector: BarcodeDetectorLike | undefined;
        try {
          detector = Detector ? new Detector({ formats: ["qr_code"] }) : undefined;
        } catch {
          /* Use the portable decoder. */
        }
        let decode: QrDecoder | undefined;
        const portable = async (): Promise<string | undefined> => {
          decode ??= (await import("jsqr")).default;
          if (current !== generation || !video.videoWidth || !video.videoHeight) {
            return;
          }
          const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) {
            throw new Error(uiText.scanUnavailable);
          }
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          return decode(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })
            ?.data;
        };
        status.textContent = uiText.scannerReady;
        let lastFrame = 0;
        const poll = async (time: number): Promise<void> => {
          if (current !== generation) {
            return;
          }
          if (time - lastFrame < 100) {
            frame = requestAnimationFrame((next) => void poll(next));
            return;
          }
          lastFrame = time;
          try {
            let value: string | undefined;
            if (detector) {
              try {
                value = (await detector.detect(video)).find((code) => code.rawValue)?.rawValue;
              } catch {
                detector = undefined;
              }
            }
            if (!detector) {
              value = await portable();
            }
            if (current !== generation) {
              return;
            }
            if (value) {
              finish(value);
              return;
            }
          } catch (error) {
            if (current === generation) {
              finish(null, error);
            }
            return;
          }
          if (current === generation) {
            frame = requestAnimationFrame((next) => void poll(next));
          }
        };
        frame = requestAnimationFrame((next) => void poll(next));
      } catch (error) {
        if (current === generation) {
          finish(null, error);
        }
      }
    })();
    return pending;
  }
  return { closeScanner, dialog, openScanner, openNativeScanner };
}
