import van from "vanjs-core";
import isPresent from "@nkzw/core/isPresent";
import type { PonletBackend } from "../api/application-api";
import { uiText } from "../i18n";

const { canvas, div, p } = van.tags;

export interface QrViewOptions {
  getBackend: () => PonletBackend;
  onError?: (error: unknown) => void;
}

export interface QrViewComponent {
  canvas: HTMLCanvasElement;
  container: HTMLDivElement;
  label: HTMLParagraphElement;
  renderInviteQr(url: string | null, force?: boolean): Promise<void>;
}

export function createQrView(options: QrViewOptions): QrViewComponent {
  const qrCanvas = canvas({
    class: "invite-qr",
    width: 256,
    height: 256,
    hidden: true,
    role: "img",
    "aria-label": () => uiText.qrLabel,
  });
  const qrFrame = div({ class: "qr-frame" }, qrCanvas);
  const qrLabel = p({ class: "qr-label" }, () => uiText.qrLabel);
  const qrContainer = div({ class: "qr-container", hidden: true }, qrFrame, qrLabel);

  let qrRequest = 0;
  let qrUrl = "";

  async function renderInviteQr(url: string | null, force?: boolean): Promise<void> {
    const nextUrl = isPresent(url) ? url : "";
    // State updates can repeat the URL while the worker is still rendering it.
    // Only a different invitation should invalidate that pending response.
    if (!force && nextUrl === qrUrl) {
      return;
    }
    const request = ++qrRequest;
    qrUrl = nextUrl;
    qrCanvas.hidden = true;
    qrLabel.hidden = true;
    qrContainer.hidden = true;
    if (nextUrl.length === 0) {
      return;
    }
    try {
      const bitmap = await options.getBackend().qrCode(nextUrl);
      if (request !== qrRequest) {
        return;
      }
      const context = qrCanvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas is unavailable");
      }
      qrCanvas.width = bitmap.width;
      qrCanvas.height = bitmap.height;
      const pixels = new Uint8ClampedArray(bitmap.rgbaPixels);
      context.putImageData(new ImageData(pixels, bitmap.width, bitmap.height), 0, 0);
      qrCanvas.hidden = false;
      qrLabel.hidden = false;
      qrContainer.hidden = false;
    } catch (error) {
      if (request === qrRequest) {
        qrCanvas.hidden = true;
        qrLabel.hidden = true;
        qrContainer.hidden = true;
        options.onError?.(error);
      }
    }
  }

  return {
    canvas: qrCanvas,
    container: qrContainer,
    label: qrLabel,
    renderInviteQr,
  };
}
