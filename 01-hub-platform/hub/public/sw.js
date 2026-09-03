// NEXUS404 — service worker
//
// Специально осторожный: кэш только для по-настоящему статичных файлов
// (иконки, манифест). Всё остальное — HTML-страницы, чат, статус модулей —
// НЕ кэшируется вообще, идёт напрямую в сеть. Кэшировать динамику здесь
// значило бы рисковать показать протухшие данные (старый статус модуля,
// старое сообщение чата) — это хуже, чем просто требовать сеть каждый раз.
// Наличие fetch-обработчика — то, что нужно для критерия «можно установить
// на экран», не более того.

const CACHE_NAME = "nexus404-static-v3";
const STATIC_ASSETS = ["/manifest.json", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/offline.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isStaticAsset = STATIC_ASSETS.includes(url.pathname);

  if (isStaticAsset) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
    return;
  }

  // Навигация (открытие страницы, не запрос данных) — если сеть реально
  // недоступна, показываем свою офлайн-страницу вместо системной ошибки
  // браузера. Динамический контент по-прежнему НЕ кэшируется и не
  // подменяется — это срабатывает только когда сеть правда упала, а не
  // вместо обычного ответа.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/offline.html"))
    );
    return;
  }

  // Всё остальное — не трогаем вообще, обычный сетевой запрос как без SW.
});

// ---------------------------------------------------------------------------
// Push-уведомления — модуль "Оповещения". payload приходит от хаба
// (см. hub/src/push.ts, sendPushToAll) готовым JSON: {title, body}.
//
// Правка по просьбе пользователя: Android иногда придерживает доставку
// push для фонового приложения и присылает пачкой все разом, спустя
// время — раньше каждое было отдельным уведомлением, и пачка из
// нескольких выглядела бы как шторка, забитая одинаковыми строчками.
// Теперь — одно СВОРАЧИВАЕМОЕ уведомление: копим ещё не просмотренные
// события в IndexedDB (обычная память между вызовами service worker'у
// не годится — процесс может выгружаться между событиями), при показе
// собираем список. Одно событие — показываем как есть, несколько — общий
// заголовок "N новых событий" и последние из них в теле, разворачивается
// свайпом/тапом на телефоне. Список стирается, как только уведомление
// открыли (или явно смахнули) — следующая пачка начинается заново.
// ---------------------------------------------------------------------------
const NOTIF_DB_NAME = "nexus404-notifications";
const NOTIF_STORE_NAME = "pending";
const MAX_SHOWN_IN_BODY = 6;

function openNotifDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NOTIF_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(NOTIF_STORE_NAME, { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function addPendingNotification(entry) {
  const db = await openNotifDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NOTIF_STORE_NAME, "readwrite");
    tx.objectStore(NOTIF_STORE_NAME).add(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getPendingNotifications() {
  const db = await openNotifDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NOTIF_STORE_NAME, "readonly");
    const req = tx.objectStore(NOTIF_STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function clearPendingNotifications() {
  const db = await openNotifDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NOTIF_STORE_NAME, "readwrite");
    tx.objectStore(NOTIF_STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload = { title: "NEXUS404", body: "" };
      try {
        if (event.data) payload = event.data.json();
      } catch {
        // не JSON — покажем как есть текстом, не теряем уведомление молча
        payload = { title: "NEXUS404", body: event.data ? event.data.text() : "" };
      }

      await addPendingNotification({ title: payload.title || "NEXUS404", body: payload.body || "" }).catch(() => {});
      const pending = await getPendingNotifications().catch(() => [payload]);

      let title, body;
      if (pending.length <= 1) {
        const only = pending[0] || payload;
        title = only.title;
        body = only.body;
      } else {
        title = pending.length + " новых событий";
        const shown = pending.slice(-MAX_SHOWN_IN_BODY);
        const hiddenCount = pending.length - shown.length;
        const lines = shown.map((p) => "• " + p.title + (p.body ? ": " + p.body : ""));
        body = (hiddenCount > 0 ? "…и ещё " + hiddenCount + " раньше\n" : "") + lines.join("\n");
      }

      // Один и тот же tag у всех — заменяет предыдущее, не плодит
      // отдельную строку на каждое (то, от чего и была жалоба на "пачку
      // одинаковых уведомлений") — renotify:true всё равно поднимает
      // уведомление наверх шторки и даёт знать о себе (звук/вибрация по
      // настройкам телефона) при каждом новом событии, несмотря на замену.
      await self.registration.showNotification(title, {
        body,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: "nexus404-events",
        renotify: true,
        data: { url: "/modules/notifications/" },
      });
    })()
  );
});

// Клик по уведомлению — открывает уже открытую вкладку хаба, если такая
// есть (не плодит новые), иначе открывает новую на странице модуля
// оповещений. Список накопленных событий очищается — следующая пачка
// начинается с чистого листа, не продолжает расти поверх уже просмотренных.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      await clearPendingNotifications().catch(() => {});
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientsList) {
        if ("focus" in client) {
          client.navigate(targetUrl).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })()
  );
});

// Смахнули не читая — тоже начинаем накопление заново, а не продолжаем
// расти поверх того, что человек уже отклонил.
self.addEventListener("notificationclose", (event) => {
  event.waitUntil(clearPendingNotifications().catch(() => {}));
});
