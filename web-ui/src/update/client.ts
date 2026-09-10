import {
  checkCompatibility,
  decodeManifest,
  ManifestError,
  MAX_FILE_BYTES,
  MAX_MANIFEST_BYTES,
  type ReleaseManifest,
} from "./manifest";
import { decodeBase64, sha256Hex, verifyManifestSignature } from "./crypto";

export const UPDATE_TIMEOUT_MS = 1_500;
export const CONTROL_CACHE_NAME = "ponlet-control-v1";
export const RELEASE_CACHE_PREFIX = "ponlet-release-";

const PENDING_RELEASE_KEY = "/pending-release";
const MAX_SIGNATURE_BYTES = 512;

export interface UpdateConfig {
  apiVersion: number;
  currentRevision: number;
  distribution: string;
  fileBaseUrl?: string;
  manifestUrl: string;
  publicKey: JsonWebKey;
  signatureUrl: string;
  target: string;
  timeoutMs?: number;
}

export type UpdateResult =
  | { status: "disabled" | "no-update" | "unsupported" }
  | { status: "failed" | "timeout"; error: string }
  | { releaseId: string; status: "staged" };

declare global {
  interface Window {
    __PONLET_UPDATE_CONFIG__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseUrl(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) {
    return undefined;
  }
  try {
    const url = new URL(text, document.baseURI);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function readConfig(): UpdateConfig | undefined {
  if (typeof window === "undefined" || window.__TAURI_INTERNALS__ !== undefined) {
    return undefined;
  }
  const value = window.__PONLET_UPDATE_CONFIG__;
  if (!isRecord(value) || !isRecord(value.publicKey)) {
    return undefined;
  }
  const manifestUrl = parseUrl(value.manifestUrl);
  const signatureUrl = parseUrl(value.signatureUrl);
  const distribution = asString(value.distribution);
  const target = asString(value.target);
  const apiVersion = asNonNegativeInteger(value.apiVersion);
  const currentRevision = asNonNegativeInteger(value.currentRevision);
  if (
    !manifestUrl ||
    !signatureUrl ||
    !distribution ||
    !target ||
    apiVersion === undefined ||
    currentRevision === undefined
  ) {
    return undefined;
  }
  const fileBaseUrl = value.fileBaseUrl === undefined ? undefined : parseUrl(value.fileBaseUrl);
  if (value.fileBaseUrl !== undefined && !fileBaseUrl) {
    return undefined;
  }
  const timeoutMs =
    value.timeoutMs === undefined ? UPDATE_TIMEOUT_MS : asNonNegativeInteger(value.timeoutMs);
  if (timeoutMs === undefined || timeoutMs === 0 || timeoutMs > UPDATE_TIMEOUT_MS) {
    return undefined;
  }
  return {
    apiVersion,
    currentRevision,
    distribution,
    ...(fileBaseUrl ? { fileBaseUrl } : {}),
    manifestUrl,
    publicKey: value.publicKey as JsonWebKey,
    signatureUrl,
    target,
    timeoutMs,
  };
}

function releaseCacheName(releaseId: string): string {
  return `${RELEASE_CACHE_PREFIX}${releaseId}`;
}

function ensureBrowserStorage(): void {
  if (typeof caches === "undefined" || navigator.serviceWorker === undefined) {
    throw new ManifestError("browser update storage is unavailable");
  }
}

function canUseServiceWorker(): boolean {
  if (typeof navigator === "undefined" || navigator.serviceWorker === undefined) {
    return false;
  }
  return (
    location.protocol === "https:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1"
  );
}

function contentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null) {
    return undefined;
  }
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

function abortError(): DOMException {
  return new DOMException("update check timed out", "AbortError");
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const settle = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      action();
    };
    const onAbort = (): void => settle(() => reject(abortError()));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

async function fetchBytes(url: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) {
    throw new ManifestError(`update fetch failed (${response.status})`);
  }
  const length = contentLength(response);
  if (length !== undefined && length > maxBytes) {
    throw new ManifestError("update file is too large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new ManifestError("update file is too large");
  }
  return bytes;
}

async function fetchSignature(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const bytes = await fetchBytes(url, MAX_SIGNATURE_BYTES, signal);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ManifestError("manifest signature is not valid UTF-8");
  }
  return decodeBase64(text);
}

async function stageFiles(
  manifest: ReleaseManifest,
  config: UpdateConfig,
  signal: AbortSignal,
): Promise<void> {
  if (!manifest.files.some((file) => file.path === "index.html")) {
    throw new ManifestError("release does not contain index.html");
  }
  const cache = await caches.open(releaseCacheName(manifest.release_id));
  const sourceBase = new URL(config.fileBaseUrl ?? "./", config.manifestUrl);
  const appBase = new URL("./", document.baseURI);
  try {
    for (const file of manifest.files) {
      const sourceUrl = new URL(file.path, sourceBase);
      const appUrl = new URL(file.path, appBase);
      if (appUrl.origin !== location.origin) {
        throw new ManifestError(`release path is outside the application: ${file.path}`);
      }
      const response = await fetch(sourceUrl, { cache: "no-store", signal });
      if (!response.ok) {
        throw new ManifestError(`update file fetch failed (${response.status})`);
      }
      const length = contentLength(response);
      if (length !== undefined && length > MAX_FILE_BYTES) {
        throw new ManifestError(`update file is too large: ${file.path}`);
      }
      const bytes = new Uint8Array(await response.clone().arrayBuffer());
      if (bytes.byteLength > MAX_FILE_BYTES || bytes.byteLength !== file.size) {
        throw new ManifestError(`update file size mismatch: ${file.path}`);
      }
      if ((await sha256Hex(bytes)) !== file.sha256) {
        throw new ManifestError(`update file hash mismatch: ${file.path}`);
      }
      await withAbort(cache.put(appUrl.toString(), response), signal);
    }
  } catch (error) {
    await caches.delete(releaseCacheName(manifest.release_id));
    throw error;
  }
}

async function markPendingRelease(releaseId: string, signal: AbortSignal): Promise<void> {
  const control = await caches.open(CONTROL_CACHE_NAME);
  await control.put(
    PENDING_RELEASE_KEY,
    new Response(releaseId, { headers: { "content-type": "text/plain" } }),
  );
  const registration = await withAbort(navigator.serviceWorker.ready, signal);
  registration.active?.postMessage({ releaseId, type: "stage" });
}

async function checkAndStage(config: UpdateConfig, signal: AbortSignal): Promise<UpdateResult> {
  ensureBrowserStorage();
  const [manifestBytes, signature] = await Promise.all([
    fetchBytes(config.manifestUrl, MAX_MANIFEST_BYTES, signal),
    fetchSignature(config.signatureUrl, signal),
  ]);
  await verifyManifestSignature(config.publicKey, manifestBytes, signature);
  const manifest = decodeManifest(manifestBytes);
  try {
    checkCompatibility(manifest, config);
  } catch (error) {
    if (error instanceof ManifestError && /revision/.test(error.message)) {
      return { status: "no-update" };
    }
    throw error;
  }
  await stageFiles(manifest, config, signal);
  await markPendingRelease(manifest.release_id, signal);
  return { releaseId: manifest.release_id, status: "staged" };
}

/** Check and stage a signed release; the running page is never replaced. */
export async function checkForUpdate(): Promise<UpdateResult> {
  const config = readConfig();
  if (!config) {
    return { status: "disabled" };
  }
  if (!canUseServiceWorker() || typeof caches === "undefined") {
    return { status: "unsupported" };
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    await withAbort(
      navigator.serviceWorker.register("./ponlet-sw.js", { scope: "./" }),
      controller.signal,
    );
    const result = await checkAndStage(config, controller.signal);
    return controller.signal.aborted
      ? { error: "update check timed out", status: "timeout" }
      : result;
  } catch (error) {
    if (controller.signal.aborted) {
      return { error: "update check timed out", status: "timeout" };
    }
    return { error: error instanceof Error ? error.message : String(error), status: "failed" };
  } finally {
    window.clearTimeout(timeout);
  }
}
