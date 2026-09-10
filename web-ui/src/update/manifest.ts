/**
 * Browser-side validation for a signed WebView release.
 *
 * The Rust update crate performs the same checks for native callers. Keeping
 * this module free of DOM, Cache Storage, and network code makes the rules
 * easy to test and prevents an unverified manifest from reaching either
 * platform's installer.
 */

export const MAX_MANIFEST_BYTES = 512 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface ReleaseFile {
  path: string;
  sha256: string;
  size: number;
}

export interface ReleaseManifest {
  distribution: string;
  files: Array<ReleaseFile>;
  min_api_version: number;
  release_id: string;
  revision: number;
  target: string;
}

export interface ReleaseCompatibility {
  apiVersion: number;
  currentRevision: number;
  distribution: string;
  target: string;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafePathComponent(component: string): boolean {
  if (
    component.length === 0 ||
    component === "." ||
    component === ".." ||
    component.endsWith(".") ||
    !/^[A-Za-z0-9._-]+$/.test(component)
  ) {
    return false;
  }
  const stem = component.split(".", 1)[0].toUpperCase();
  return !(
    stem === "CON" ||
    stem === "PRN" ||
    stem === "AUX" ||
    stem === "NUL" ||
    (/^(COM|LPT)[1-9]$/.test(stem) && stem.length === 4)
  );
}

function assertString(value: unknown, field: string, maxLength?: number): string {
  if (typeof value !== "string" || (maxLength !== undefined && value.length > maxLength)) {
    throw new ManifestError(`invalid ${field}`);
  }
  return value;
}

function assertInteger(value: unknown, field: string, max?: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (max !== undefined && (value as number) > max)
  ) {
    throw new ManifestError(`invalid ${field}`);
  }
  return value as number;
}

function normalizeFile(value: unknown, index: number): ReleaseFile {
  if (!isRecord(value)) {
    throw new ManifestError(`invalid file entry ${index}`);
  }
  const path = assertString(value.path, `file path ${index}`);
  if (
    path.startsWith("/") ||
    path.split("/").some((component) => !isSafePathComponent(component))
  ) {
    throw new ManifestError(`invalid file path: ${path}`);
  }
  const size = assertInteger(value.size, `file size ${path}`, MAX_FILE_BYTES);
  const sha256 = assertString(value.sha256, `file hash ${path}`);
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new ManifestError(`invalid file hash: ${path}`);
  }
  return { path, sha256: sha256.toLowerCase(), size };
}

/** Validate an already parsed manifest and return a normalized copy. */
export function validateManifest(value: unknown): ReleaseManifest {
  if (!isRecord(value)) {
    throw new ManifestError("manifest must be an object");
  }
  const release_id = assertString(value.release_id, "release_id", 128);
  if (!isSafePathComponent(release_id)) {
    throw new ManifestError("invalid release_id");
  }
  const distribution = assertString(value.distribution, "distribution");
  const target = assertString(value.target, "target");
  if (distribution.length === 0 || target.length === 0) {
    throw new ManifestError("invalid distribution/target");
  }
  const revision = assertInteger(value.revision, "revision");
  const min_api_version = assertInteger(value.min_api_version, "min_api_version");
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new ManifestError("manifest files must not be empty");
  }

  const files = value.files.map(normalizeFile);
  const seen = new Set<string>();
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (seen.has(key)) {
      throw new ManifestError(`duplicate file path: ${file.path}`);
    }
    seen.add(key);
  }
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index++) {
      if (seen.has(parts.slice(0, index).join("/").toLowerCase())) {
        throw new ManifestError(`file/directory conflict: ${file.path}`);
      }
    }
  }

  return { distribution, files, min_api_version, release_id, revision, target };
}

/** Decode and validate the exact UTF-8 bytes that were signed. */
export function decodeManifest(bytes: Uint8Array): ReleaseManifest {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new ManifestError("manifest is too large");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ManifestError("manifest is not valid UTF-8");
  }
  try {
    return validateManifest(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof ManifestError) {
      throw error;
    }
    throw new ManifestError("manifest JSON is invalid");
  }
}

export function checkCompatibility(
  manifest: ReleaseManifest,
  expected: ReleaseCompatibility,
): void {
  if (manifest.distribution !== expected.distribution) {
    throw new ManifestError("release distribution is incompatible");
  }
  if (manifest.target !== expected.target) {
    throw new ManifestError("release target is incompatible");
  }
  if (manifest.min_api_version > expected.apiVersion) {
    throw new ManifestError("release API version is incompatible");
  }
  if (manifest.revision <= expected.currentRevision) {
    throw new ManifestError("release revision is not newer");
  }
}
