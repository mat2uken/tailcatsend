import van from "vanjs-core";
import isPresent from "@nkzw/core/isPresent";
import type { PonletBackend } from "../api/application-api";
import { uiText } from "../i18n";

const { canvas, p } = van.tags;

export interface QrViewOptions {
  getBackend: () => PonletBackend;
  onError?: (error: unknown) => void;
}

export interface QrViewComponent {
  canvas: HTMLCanvasElement;
  label: HTMLParagraphElement;
  renderInviteQr(url: string | null): Promise<void>;
}

export function createQrView(options: QrViewOptions): QrViewComponent {
  const qrCanvas = canvas({ class: "invite-qr", width: 256, height: 256, hidden: true });
  const qrLabel = p({ class: "qr-label" }, uiText.qrLabel);

  let qrRequest = 0;
  let qrUrl = "";

  async function renderInviteQr(url: string | null): Promise<void> {
    const request = ++qrRequest;
    const backend = options.getBackend();
    if (!isPresent(url) || url.length === 0 || !backend.qrCode) {
      qrCanvas.hidden = true;
      qrLabel.hidden = true;
      qrUrl = "";
      return;
    }
    if (url === qrUrl) {
      return;
    }
    qrUrl = url;
    try {
      const bitmap = await backend.qrCode(url);
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
    } catch (error) {
      qrCanvas.hidden = true;
      qrLabel.hidden = true;
      if (request === qrRequest) {
        options.onError?.(error);
      }
    }
  }

  return {
    canvas: qrCanvas,
    label: qrLabel,
    renderInviteQr,
  };
}
