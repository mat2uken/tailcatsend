import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const output = resolve(process.argv[2] ?? "dist/ponlet-update-config.js");
const required = [
  process.env.PONLET_UPDATE_MANIFEST_URL,
  process.env.PONLET_UPDATE_SIGNATURE_URL,
  process.env.PONLET_UPDATE_PUBLIC_KEY_JWK,
];

if (required.some((value) => !value)) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    "// Update configuration is intentionally disabled for this build.\nglobalThis.__PONLET_UPDATE_CONFIG__ ??= undefined;\n",
  );
  process.exit(0);
}

let publicKey;
try {
  publicKey = JSON.parse(process.env.PONLET_UPDATE_PUBLIC_KEY_JWK);
} catch (error) {
  throw new Error(`PONLET_UPDATE_PUBLIC_KEY_JWK is not valid JSON: ${error}`);
}
if (!publicKey || typeof publicKey !== "object" || Array.isArray(publicKey)) {
  throw new Error("PONLET_UPDATE_PUBLIC_KEY_JWK must be a JSON object");
}

const integer = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(value);
};
const config = {
  apiVersion: integer("PONLET_UPDATE_API_VERSION", "1"),
  currentRevision: integer("PONLET_UPDATE_CURRENT_REVISION", "0"),
  distribution: process.env.PONLET_UPDATE_DISTRIBUTION ?? "web",
  ...(process.env.PONLET_UPDATE_FILE_BASE_URL
    ? { fileBaseUrl: process.env.PONLET_UPDATE_FILE_BASE_URL }
    : {}),
  manifestUrl: process.env.PONLET_UPDATE_MANIFEST_URL,
  publicKey,
  signatureUrl: process.env.PONLET_UPDATE_SIGNATURE_URL,
  target: process.env.PONLET_UPDATE_TARGET ?? "browser",
};

await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  `globalThis.__PONLET_UPDATE_CONFIG__ = ${JSON.stringify(config)};\n`,
);
