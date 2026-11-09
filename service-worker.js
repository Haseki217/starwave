const CACHE_NAME = "starwave-pwa-v6";

const APP_SHELL = [
  "./",
  "./index.html",
  "./utils/indexeddb.js",
  "./utils/sync.js?v=google-drive-4",
  "./sync-config.js?v=google-drive-1",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./favicon-32.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
  );

  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith("starwave-pwa-") && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );

  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(event.request.url);

  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  const navigation = event.request.mode === "navigate";
  const codeAsset = /\.(?:html|js|css)$/.test(requestUrl.pathname);
  if (navigation || codeAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cacheKey = navigation ? "./index.html" : event.request;
      try {
        const response = await fetch(event.request);
        if (!response.ok) {
          return (await cache.match(cacheKey)) || response;
        }
        // 成功上線時更新離線副本；儲存失敗不妨礙載入新版。
        try { await cache.put(cacheKey, response.clone()); } catch (_) {}
        return response;
      } catch (error) {
        const cached = await cache.match(cacheKey);
        if (cached) return cached;
        throw error;
      }
    })());
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(async response => {
          if (!response || !response.ok) return response;
          try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(event.request, response.clone());
          } catch (_) {}
          return response;
        });
      })
  );
});
