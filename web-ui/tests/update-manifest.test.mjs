import { webcrypto } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  checkCompatibility,
  decodeManifest,
  ManifestError,
  validateManifest,
} from "../src/update/manifest.ts";
import { sha256Hex, verifyManifestSignature } from "../src/update/crypto.ts";

const validFile = {
  path: "assets/index.js",
  size: 5,
  sha256: "a".repeat(64),
};

function manifest(overrides = {}) {
  return {
    release_id: "release-1",
    revision: 2,
    distribution: "web",
    target: "browser",
    min_api_version: 1,
    files: [validFile],
    ...overrides,
  };
}

it("normalizes a valid manifest and lowercases hashes", () => {
  const value = validateManifest({
    ...manifest(),
    files: [{ ...validFile, sha256: "A".repeat(64) }],
  });
  expect(value.files[0].sha256).toBe("a".repeat(64));
});

it("rejects traversal, aliases, reserved names, and file directory conflicts", () => {
  for (const path of ["../index.js", "%2e%2e/index.js", "index.js?x", "CON.txt", "index.js."]) {
    expect(() => validateManifest({ ...manifest(), files: [{ ...validFile, path }] })).toThrow(
      ManifestError,
    );
  }
  expect(() =>
    validateManifest({
      ...manifest(),
      files: [validFile, { ...validFile, path: "ASSETS/index.js", size: 0 }],
    }),
  ).toThrow(/duplicate/);
  expect(() =>
    validateManifest({
      ...manifest(),
      files: [validFile, { ...validFile, path: "assets/index.js/child", size: 0 }],
    }),
  ).toThrow(/file\/directory/);
});

it("rejects incompatible and rolled back releases", () => {
  const value = validateManifest(manifest());
  expect(() =>
    checkCompatibility(value, {
      distribution: "native",
      target: "browser",
      apiVersion: 1,
      currentRevision: 1,
    }),
  ).toThrow(/distribution/);
  expect(() =>
    checkCompatibility(value, {
      distribution: "web",
      target: "browser",
      apiVersion: 1,
      currentRevision: 2,
    }),
  ).toThrow(/revision/);
});

it("rejects oversized or malformed exact manifest bytes", () => {
  expect(() => decodeManifest(new Uint8Array(512 * 1024 + 1))).toThrow(/too large/);
  expect(() => decodeManifest(Uint8Array.from([0xff]))).toThrow(/UTF-8/);
  expect(() => decodeManifest(new TextEncoder().encode("{}"))).toThrow(ManifestError);
});

it("verifies P-256 r||s signatures over exact bytes", async () => {
  const originalCrypto = globalThis.crypto;
  vi.stubGlobal("crypto", webcrypto);
  try {
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const bytes = new TextEncoder().encode(JSON.stringify(manifest()));
    const signature = new Uint8Array(
      await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, bytes),
    );
    const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
    await expect(verifyManifestSignature(jwk, bytes, signature)).resolves.toBeUndefined();
    bytes[0] ^= 1;
    await expect(verifyManifestSignature(jwk, bytes, signature)).rejects.toThrow(/signature/);
    expect(await sha256Hex(new TextEncoder().encode("hello"))).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  } finally {
    vi.stubGlobal("crypto", originalCrypto);
  }
});
