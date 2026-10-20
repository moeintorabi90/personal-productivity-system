/* App-shell service worker (DECISIONS T-008). Built by apps/web/vite.config.ts, which replaces the
 * two placeholders below with the build's file list and a content hash.
 *
 * - The versioned shell (HTML, JS, CSS, icons, manifest) is precached at install.
 * - Navigations are served from the cache first, so the app opens offline.
 * - API requests (/v1/…) are never cached: sync data lives in IndexedDB, not in this cache.
 * - Updating deletes only old "pps-shell-*" caches; IndexedDB records are never touched.
 */
const CACHE_VERSION = "__PPS_CACHE_VERSION__";
const PRECACHE = __PPS_PRECACHE__;
const CACHE_NAME = `pps-shell-${CACHE_VERSION}`;
const INDEX_URL = new URL("index.html", self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE.map((path) => new URL(path, self.registration.scope).href)))
      // The shell has no lazily loaded chunks, so an open page keeps working after the switch.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key.startsWith("pps-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/v1/")) return;

  // ignoreVary: servers often send "Vary: Origin", and the page's crossorigin script/style
  // requests carry different headers than the precache requests. Precached files are
  // versioned by content, so the Vary distinction does not matter here.
  const options = { cacheName: CACHE_NAME, ignoreVary: true };

  if (request.mode === "navigate") {
    event.respondWith(caches.match(INDEX_URL, options).then((cached) => cached || fetch(request)));
    return;
  }

  event.respondWith(caches.match(request, options).then((cached) => cached || fetch(request)));
});
