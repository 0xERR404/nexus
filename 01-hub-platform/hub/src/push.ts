import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import webpush from "web-push";
import { withFileLock } from "./fileLock.js";

const HUB_DATA_DIR = process.env.HUB_DATA_DIR ?? "/app/data";
const VAPID_FILE = path.join(HUB_DATA_DIR, "vapid-keys.json");
const SUBSCRIPTIONS_FILE = path.join(HUB_DATA_DIR, "push-subscriptions.json");

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  addedAt: string;
}

let vapidCache: VapidKeys | null = null;

async function ensureDir() {
  await mkdir(HUB_DATA_DIR, { recursive: true });
}

// Генерируются один раз, хранятся на диске — иначе все подписки браузеров
// стали бы недействительны при каждом перезапуске хаба. withFileLock —
// без него два запроса сразу после установки (до появления файла) могли
// бы сгенерировать РАЗНЫЕ пары ключей и записать разное на диск.
export async function getVapidKeys(): Promise<VapidKeys> {
  if (vapidCache) return vapidCache;
  return withFileLock(VAPID_FILE, async () => {
    if (vapidCache) return vapidCache;
    try {
      vapidCache = JSON.parse(await readFile(VAPID_FILE, "utf-8")) as VapidKeys;
      return vapidCache;
    } catch {
      // файла ещё нет — генерируем ниже
    }
    const generated = webpush.generateVAPIDKeys();
    vapidCache = generated;
    await ensureDir();
    await writeFile(VAPID_FILE, JSON.stringify(generated, null, 2));
    return generated;
  });
}

async function readSubscriptions(): Promise<PushSubscriptionRecord[]> {
  try {
    return JSON.parse(await readFile(SUBSCRIPTIONS_FILE, "utf-8")) as PushSubscriptionRecord[];
  } catch {
    return [];
  }
}

async function writeSubscriptions(subs: PushSubscriptionRecord[]): Promise<void> {
  await ensureDir();
  await writeFile(SUBSCRIPTIONS_FILE, JSON.stringify(subs, null, 2));
}

export async function addSubscription(sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void> {
  await withFileLock(SUBSCRIPTIONS_FILE, async () => {
    const subs = await readSubscriptions();
    if (subs.some((s) => s.endpoint === sub.endpoint)) return;
    subs.push({ endpoint: sub.endpoint, keys: sub.keys, addedAt: new Date().toISOString() });
    await writeSubscriptions(subs);
  });
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await withFileLock(SUBSCRIPTIONS_FILE, async () => {
    const subs = await readSubscriptions();
    await writeSubscriptions(subs.filter((s) => s.endpoint !== endpoint));
  });
}

export async function getSubscriptionCount(): Promise<number> {
  return (await readSubscriptions()).length;
}

// Каждое событие — отдельным уведомлением, не сводкой. Битые подписки
// (404/410) удаляются сразу.
export async function sendPushToAll(payload: { title: string; body: string; tag?: string }): Promise<void> {
  const subs = await readSubscriptions();
  if (subs.length === 0) {
    console.log(`[push] "${payload.title}" — подписок нет, отправлять некому`);
    return;
  }

  const vapid = await getVapidKeys();
  webpush.setVapidDetails("mailto:admin@localhost", vapid.publicKey, vapid.privateKey);

  const body = JSON.stringify(payload);
  const deadEndpoints = new Set<string>();
  let sent = 0;
  let failed = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        // urgency: high — иначе Android придерживает доставку свёрнутому
        // приложению; TTL сутки — догонит офлайн-телефон.
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { urgency: "high", TTL: 24 * 60 * 60 });
        sent += 1;
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        failed += 1;
        if (statusCode === 404 || statusCode === 410) {
          deadEndpoints.add(sub.endpoint);
          console.log(`[push] подписка ${sub.endpoint.slice(0, 60)}... больше не действует (${statusCode}), убрана`);
        } else {
          const message = (err as { body?: string; message?: string })?.body ?? (err as Error)?.message ?? String(err);
          console.error(`[push] не удалось отправить на ${sub.endpoint.slice(0, 60)}...: ${statusCode ?? "?"} ${message}`);
        }
      }
    })
  );

  console.log(`[push] "${payload.title}" — доставлено ${sent}/${subs.length}${failed ? `, ошибок: ${failed}` : ""}`);

  if (deadEndpoints.size > 0) {
    // Читаем АКТУАЛЬНОЕ состояние прямо перед записью (не снимок до
    // рассылки) — устройство могло подписаться/отписаться, пока слались
    // уведомления; так свежие изменения не теряются.
    await withFileLock(SUBSCRIPTIONS_FILE, async () => {
      const current = await readSubscriptions();
      await writeSubscriptions(current.filter((s) => !deadEndpoints.has(s.endpoint)));
    });
  }
}
