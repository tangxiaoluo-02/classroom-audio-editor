const CACHE = "recording-editor-v2";
const APP_FILES = ["./", "./index.html", "./style.css", "./app.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
const VENDOR_FILES = ["./vendor/wavesurfer.min.js", "./vendor/regions.min.js", "./vendor/lame.min.js", "./vendor/soundtouch.min.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([...APP_FILES, ...VENDOR_FILES])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

function isAppFile(url) {
  return APP_FILES.some((f) => url.endsWith(f.replace("./", "/")) || url.endsWith("/") || url.endsWith("/index.html"));
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  if (isAppFile(url.pathname)) {
    // App shell changes often during active development: always prefer the network
    // so a pushed fix is visible on next load, falling back to cache only when offline.
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Vendor libraries are pinned by version and never change in place, so cache-first is safe.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
