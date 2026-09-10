import { webcrypto } from "node:crypto";
import { expect, it, vi } from "vitest";
import { checkForUpdate, CONTROL_CACHE_NAME, RELEASE_CACHE_PREFIX } from "../src/update/client.ts";
import { sha256Hex } from "../src/update/crypto.ts";

class MemoryCache {
  entries = new Map();

  async delete(request) {
    return this.entries.delete(String(request));
  }

  async match(request) {
    return this.entries.get(String(request));
  }

  async put(request, response) {
    this.entries.set(String(request), response.clone());
  }
}

function memoryCacheStorage() {
  const stores = new Map();
  return {
    stores,
    async delete(name) {
      return stores.delete(name);
    },
    async has(name) {
      return stores.has(name);
    },
    async open(name) {
      let cache = stores.get(name);
      if (!cache) {
        cache = new MemoryCache();
        stores.set(name, cache);
      }
      return cache;
    },
  };
}

function response(bytes, contentType = "application/octet-stream") {
  return new Response(bytes, {
    headers: {
      "content-length": String(bytes.byteLength),
      "content-type": contentType,
    },
  });
}

it("stages a verified release and leaves activation to the service worker", async () => {
  const originalCrypto = globalThis.crypto;
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const originalConfig = window.__PONLET_UPDATE_CONFIG__;
  const originalWorker = window.navigator.serviceWorker;
  vi.stubGlobal("crypto", webcrypto);
  const storage = memoryCacheStorage();
  vi.stubGlobal("caches", storage);
  const worker = { postMessage: vi.fn() };
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve({ active: worker }),
      register: vi.fn(async () => ({ active: worker })),
    },
  });
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const indexBytes = new TextEncoder().encode("index");
  const manifestObject = {
    release_id: "release-2",
    revision: 2,
    distribution: "web",
    target: "browser",
    min_api_version: 1,
    files: [
      {
        path: "index.html",
        size: indexBytes.byteLength,
        sha256: await sha256Hex(indexBytes),
      },
    ],
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestObject));
  const signature = new Uint8Array(
    await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, manifestBytes),
  );
  const publicKey = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  window.__PONLET_UPDATE_CONFIG__ = {
    apiVersion: 1,
    currentRevision: 1,
    distribution: "web",
    fileBaseUrl: "https://updates.example/releases/release-2/",
    manifestUrl: "https://updates.example/releases/release-2/manifest.json",
    publicKey,
    signatureUrl: "https://updates.example/releases/release-2/manifest.sig",
    target: "browser",
  };
  globalThis.fetch = vi.fn(async (url) => {
    const value = String(url);
    if (value.endsWith("manifest.json")) {
      return response(manifestBytes, "application/json");
    }
    if (value.endsWith("manifest.sig")) {
      return response(
        new TextEncoder().encode(Buffer.from(signature).toString("base64")),
        "text/plain",
      );
    }
    if (value.endsWith("index.html")) {
      return new Response(indexBytes, { headers: { "content-type": "text/html" } });
    }
    return new Response("missing", { status: 404 });
  });
  try {
    const result = await checkForUpdate();
    expect(result).toEqual({ releaseId: "release-2", status: "staged" });
    const releaseCache = storage.stores.get(`${RELEASE_CACHE_PREFIX}release-2`);
    expect(await releaseCache.match("http://localhost:3000/index.html")).toBeDefined();
    const control = storage.stores.get(CONTROL_CACHE_NAME);
    expect(await (await control.match("/pending-release")).text()).toBe("release-2");
    expect(worker.postMessage).toHaveBeenCalledWith({ releaseId: "release-2", type: "stage" });
  } finally {
    globalThis.crypto = originalCrypto;
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
    window.__PONLET_UPDATE_CONFIG__ = originalConfig;
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: originalWorker,
    });
  }
});

it("does not contact an update endpoint in a Tauri WebView", async () => {
  const originalFetch = globalThis.fetch;
  const originalConfig = window.__PONLET_UPDATE_CONFIG__;
  const originalTauri = window.__TAURI_INTERNALS__;
  const fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy;
  window.__PONLET_UPDATE_CONFIG__ = {
    apiVersion: 1,
    currentRevision: 1,
    distribution: "web",
    manifestUrl: "https://updates.example/manifest.json",
    publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    signatureUrl: "https://updates.example/manifest.sig",
    target: "browser",
  };
  window.__TAURI_INTERNALS__ = {};
  try {
    await expect(checkForUpdate()).resolves.toEqual({ status: "disabled" });
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
    window.__PONLET_UPDATE_CONFIG__ = originalConfig;
    window.__TAURI_INTERNALS__ = originalTauri;
  }
});
