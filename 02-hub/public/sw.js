const CACHE = 'nexus404-shell-__ASSET_HASH__';
const ASSETS = [
  '/app.css',
  '/cosmos.webp',
  '/app.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/offline.html',
  '/fonts/jetbrains-mono.woff2',
  '/fonts/space-grotesk.woff2'
];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, {cache: 'reload'}))))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('nexus404-') && name !== CACHE)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (ASSETS.includes(url.pathname) && !url.search) {
    event.respondWith(
      caches
        .open(CACHE)
        .then((cache) => cache.match(event.request))
        .then((cached) => cached || fetch(event.request))
    );
  } else if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(async () => (await caches.open(CACHE)).match('/offline.html'))
    );
  }
});

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data = {};
      try {
        const parsed = event.data?.json();
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
      } catch {}
      const id = typeof data.id === 'string' ? data.id.slice(0, 100) : String(Date.now());
      await self.registration.showNotification(
        String(data.title ?? 'NEXUS404 · Сигнал').slice(0, 160),
        {
          body: String(data.body ?? 'Новое событие сервера. Открой «Сигнал».').slice(0, 600),
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: 'nexus404-' + id,
          data: {url: '/modules/signal/?event=' + encodeURIComponent(id)},
          requireInteraction: data.level === 'critical'
        }
      );
    })()
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const target = new URL(
        event.notification.data?.url ?? '/modules/signal/',
        self.location.origin
      );
      if (target.origin !== self.location.origin || target.pathname !== '/modules/signal/') return;
      const windows = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin
      );
      if (existing) {
        await existing.navigate(target.href);
        await existing.focus();
      } else await self.clients.openWindow(target.href);
    })()
  );
});
