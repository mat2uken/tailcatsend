import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "dist");
const manifestPath = resolve(process.argv[3] ?? `${root}/ponlet-manifest.json`);
const signaturePath = resolve(process.argv[4] ?? `${root}/ponlet-manifest.sig`);
const manifestRelativePath = relative(root, manifestPath).split(sep).join("/");
const signatureRelativePath = relative(root, signaturePath).split(sep).join("/");
const privateKeyPem = process.env.PONLET_UPDATE_PRIVATE_KEY_PEM;
const MAX_MANIFEST_BYTES = 512 * 1024;

function insideRoot(path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

function safeComponent(component) {
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

function assertSafeRelativePath(path, field) {
  if (
    !path ||
    path.startsWith("/") ||
    path.split("/").some((component) => !safeComponent(component))
  ) {
    throw new Error(`invalid ${field}: ${path}`);
  }
}

function nonNegativeInteger(name, fallback) {
  const value = process.env[name] || fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${name} is too large`);
  }
  return number;
}

async function removeIfPresent(path) {
  await rm(path, { force: true });
}

if (!insideRoot(manifestPath) || !insideRoot(signaturePath)) {
  throw new Error("manifest and signature outputs must be inside the release directory");
}
if (manifestPath === signaturePath) {
  throw new Error("manifest and signature outputs must be different files");
}
assertSafeRelativePath(manifestRelativePath, "manifest output path");
assertSafeRelativePath(signatureRelativePath, "signature output path");

if (!privateKeyPem) {
  await removeIfPresent(manifestPath);
  await removeIfPresent(signaturePath);
  console.log("Signed browser update is disabled: PONLET_UPDATE_PRIVATE_KEY_PEM is not set");
  process.exit(0);
}

const releaseId = process.env.PONLET_UPDATE_RELEASE_ID || process.env.GITHUB_SHA || "release-0";
assertSafeRelativePath(releaseId, "release_id");
const revision = nonNegativeInteger("PONLET_UPDATE_REVISION", process.env.GITHUB_RUN_NUMBER ?? "0");
const minApiVersion = nonNegativeInteger("PONLET_UPDATE_API_VERSION", "2");
if (minApiVersion > 65_535) {
  throw new Error("PONLET_UPDATE_API_VERSION is too large");
}
const distribution = process.env.PONLET_UPDATE_DISTRIBUTION || "web";
const target = process.env.PONLET_UPDATE_TARGET || "browser";
if (!distribution || !target) {
  throw new Error("PONLET_UPDATE_DISTRIBUTION and PONLET_UPDATE_TARGET must not be empty");
}
const maxFileBytes = nonNegativeInteger("PONLET_UPDATE_MAX_FILE_BYTES", String(25 * 1024 * 1024));
const excluded = new Set(
  [manifestRelativePath, signatureRelativePath]
    .concat(process.env.PONLET_UPDATE_EXCLUDE?.split(",") ?? [])
    .map((path) => path.trim())
    .filter(Boolean),
);
for (const path of excluded) {
  assertSafeRelativePath(path, "excluded path");
}

const privateKey = createPrivateKey({ key: privateKeyPem, format: "pem" });
const publicKey = createPublicKey(privateKey);
const publicJwk = publicKey.export({ format: "jwk" });
if (publicJwk.kty !== "EC" || publicJwk.crv !== "P-256") {
  throw new Error("PONLET_UPDATE_PRIVATE_KEY_PEM must be a P-256 EC key");
}

async function collectFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    assertSafeRelativePath(relativePath, "file path");
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath, relativePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`release contains a non-regular file: ${relativePath}`);
    }
    if (!excluded.has(relativePath)) {
      files.push({ path: relativePath, fullPath });
    }
  }
  return files;
}

const files = [];
const seenPaths = new Set();
for (const entry of await collectFiles(root)) {
  const stat = await lstat(entry.fullPath);
  if (stat.size > maxFileBytes) {
    throw new Error(
      `file exceeds PONLET_UPDATE_MAX_FILE_BYTES (${maxFileBytes}): ${entry.path} (${stat.size})`,
    );
  }
  const bytes = await readFile(entry.fullPath);
  if (bytes.byteLength !== stat.size) {
    throw new Error(`file changed while reading: ${entry.path}`);
  }
  const key = entry.path.toLowerCase();
  if (seenPaths.has(key)) {
    throw new Error(`duplicate file path with different casing: ${entry.path}`);
  }
  seenPaths.add(key);
  files.push({
    path: entry.path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

if (files.length === 0 || !files.some((file) => file.path === "index.html")) {
  throw new Error("release directory must contain index.html and at least one file");
}
for (const file of files) {
  const parts = file.path.split("/");
  for (let index = 1; index < parts.length; index++) {
    if (seenPaths.has(parts.slice(0, index).join("/").toLowerCase())) {
      throw new Error(`file/directory conflict: ${file.path}`);
    }
  }
}

const manifest = {
  release_id: releaseId,
  revision,
  distribution,
  target,
  min_api_version: minApiVersion,
  files,
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
  throw new Error(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
}
const signature = sign("sha256", manifestBytes, {
  key: privateKey,
  dsaEncoding: "ieee-p1363",
});
if (signature.byteLength !== 64) {
  throw new Error(`unexpected P-256 signature length: ${signature.byteLength}`);
}

await mkdir(dirname(manifestPath), { recursive: true });
await mkdir(dirname(signaturePath), { recursive: true });
await writeFile(manifestPath, manifestBytes);
await writeFile(signaturePath, `${signature.toString("base64")}\n`);

console.log(
  JSON.stringify({
    files: files.length,
    manifest: manifestPath,
    publicKey: publicJwk,
    releaseId,
    revision,
    signature: signaturePath,
  }),
);
