// 離線快取：程式和單字表先用快取(背景更新);抓小說(/api/)一律走網路。
const VERSION = "eread-v4";
const SHELL = [
  "./", "index.html", "app.js", "manifest.webmanifest", "data/vocab.json",
  "vendor/jszip.min.js", "vendor/opencc-cn2t.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/api/")) return;
  // stale-while-revalidate:先給快取，同時更新
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const key = url.pathname.endsWith("/") ? "./" : e.request;
      const hit = await cache.match(key, { ignoreSearch: true });
      const net = fetch(e.request).then((r) => {
        if (r.ok) cache.put(key, r.clone());
        return r;
      }).catch(() => hit);
      return hit || net;
    }),
  );
});
