import { ManifestError } from "./manifest";

function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

/** Decode the URL-safe or regular base64 representation used by CI output. */
export function decodeBase64(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/").split(/\s+/).join("");
  if (normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new ManifestError("invalid base64 signature");
  }
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    throw new ManifestError("invalid base64 signature");
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

/** Verify the exact manifest bytes with a P-256 ECDSA/SHA-256 key. */
export async function verifyManifestSignature(
  publicKeyJwk: JsonWebKey,
  manifestBytes: Uint8Array,
  signature: Uint8Array,
): Promise<void> {
  if (signature.byteLength !== 64) {
    throw new ManifestError("manifest signature must be 64-byte r||s");
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new ManifestError("manifest public key is invalid");
  }
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    asBufferSource(signature),
    asBufferSource(manifestBytes),
  );
  if (!valid) {
    throw new ManifestError("manifest signature is invalid");
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
