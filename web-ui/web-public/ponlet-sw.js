const CONTROL_CACHE_NAME = "ponlet-control-v1";
const RELEASE_CACHE_PREFIX = "ponlet-release-";
const ACTIVE_RELEASE_KEY = "/active-release";
const PENDING_RELEASE_KEY = "/pending-release";

function releaseCacheName(releaseId) {
  return `${RELEASE_CACHE_PREFIX}${releaseId}`;
}

function controlUrl(key) {
  return new URL(key, self.location.origin).toString();
}

function scopedUrl(path) {
  return new URL(path, self.registration.scope).toString();
}

async function readControl(key) {
  const cache = await caches.open(CONTROL_CACHE_NAME);
  const response = await cache.match(controlUrl(key));
  return response ? response.text() : "";
}

async function writeControl(key, value) {
  const cache = await caches.open(CONTROL_CACHE_NAME);
  await cache.put(
    controlUrl(key),
    new Response(value, { headers: { "content-type": "text/plain" } }),
  );
}

async function promotePending() {
  let active = await readControl(ACTIVE_RELEASE_KEY);
  const pending = await readControl(PENDING_RELEASE_KEY);
  if (!pending || !(await caches.has(releaseCacheName(pending)))) {
    return active;
  }
  const cache = await caches.open(releaseCacheName(pending));
  if (!(await cache.match(scopedUrl("index.html")))) {
    return active;
  }
  await writeControl(ACTIVE_RELEASE_KEY, pending);
  const control = await caches.open(CONTROL_CACHE_NAME);
  await control.delete(controlUrl(PENDING_RELEASE_KEY));
  active = pending;
  return active;
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  if (event.data?.type !== "stage" || typeof event.data.releaseId !== "string") {
    return;
  }
  event.waitUntil(
    (async () => {
      const releaseId = event.data.releaseId;
      if (!/^[A-Za-z0-9._-]+$/.test(releaseId)) {
        return;
      }
      const cache = await caches.open(releaseCacheName(releaseId));
      if (await cache.match(scopedUrl("index.html"))) {
        await writeControl(PENDING_RELEASE_KEY, releaseId);
      }
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    (async () => {
      const url = new URL(request.url);
      const releaseId =
        request.mode === "navigate"
          ? await promotePending()
          : await readControl(ACTIVE_RELEASE_KEY);
      if (releaseId) {
        const cache = await caches.open(releaseCacheName(releaseId));
        const path =
          request.mode === "navigate" && url.pathname.endsWith("/")
            ? scopedUrl("index.html")
            : new URL(url.pathname, self.location.origin).toString();
        const cached = await cache.match(path);
        if (cached) {
          return cached;
        }
      }
      return fetch(request);
    })(),
  );
});
