// __BUILD_VERSION__ はビルド時に vite.config.ts のプラグインが版番号へ置換する。
// デプロイごとに sw.js の中身が変わるので、ブラウザが必ず「更新あり」と判定する。
const CACHE_NAME = "kakeibo-app-cache-__BUILD_VERSION__";
const BUILD_ASSETS = /* __BUILD_ASSETS__ */ [];
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/kakeibo-app-icon.svg",
  "./icons/kakeibo-app-maskable.svg",
  "./icons/kakeibo-app-icon-192.png",
  "./icons/kakeibo-app-icon-512.png",
  "./icons/kakeibo-app-maskable-512.png",
  "./icons/apple-touch-icon.png",
  ...BUILD_ASSETS,
];
const APP_FALLBACK = new URL("index.html", self.registration.scope);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// 新しい SW が waiting になったとき、ページ側（main.tsx）からの合図で即座に切り替える
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  // 画面表示は控えてある index.html をすぐ返し、最新版の取得は裏で行う。
  if (event.request.mode === "navigate") {
    const update = fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(APP_FALLBACK, response.clone()));
      return response;
    });
    event.waitUntil(update.then(() => undefined).catch(() => undefined));
    event.respondWith(caches.match(APP_FALLBACK).then((cached) => cached || update));
    return;
  }

  const update = fetch(event.request).then((response) => {
    if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
    return response;
  });
  event.waitUntil(update.then(() => undefined).catch(() => undefined));
  event.respondWith(caches.match(event.request).then((cached) => cached || update));
});
