import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import webpush from "web-push";

const HUB_DATA_DIR = process.env.HUB_DATA_DIR ?? "/app/data";
const VAPID_FILE = path.join(HUB_DATA_DIR, "vapid-keys.json");
const SUBSCRIPTIONS_FILE = path.join(HUB_DATA_DIR, "push-subscriptions.json");

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

// PushSubscription — то, что отдаёт браузер после pushManager.subscribe():
// endpoint push-сервиса + ключи шифрования устройства. Не секрет, но и
// не для лишней огласки — теоретически позволяет слать push на устройство.
export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  addedAt: string;
}

let vapidCache: VapidKeys | null = null;

async function ensureDir() {
  await mkdir(HUB_DATA_DIR, { recursive: true });
}

// VAPID-ключи — генерируются один раз и хранятся на диске (переживают
// пересоздание контейнера) — иначе все подписки браузеров стали бы
// недействительны при каждом перезапуске хаба.
export async function getVapidKeys(): Promise<VapidKeys> {
  if (vapidCache) return vapidCache;
  try {
    const raw = await readFile(VAPID_FILE, "utf-8");
    vapidCache = JSON.parse(raw) as VapidKeys;
    return vapidCache;
  } catch {
    // файла ещё нет — генерируем и сохраняем
  }
  const generated = webpush.generateVAPIDKeys();
  vapidCache = generated;
  await ensureDir();
  await writeFile(VAPID_FILE, JSON.stringify(generated, null, 2));
  return generated;
}

async function readSubscriptions(): Promise<PushSubscriptionRecord[]> {
  try {
    const raw = await readFile(SUBSCRIPTIONS_FILE, "utf-8");
    return JSON.parse(raw) as PushSubscriptionRecord[];
  } catch {
    return [];
  }
}

async function writeSubscriptions(subs: PushSubscriptionRecord[]): Promise<void> {
  await ensureDir();
  await writeFile(SUBSCRIPTIONS_FILE, JSON.stringify(subs, null, 2));
}

export async function addSubscription(sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void> {
  const subs = await readSubscriptions();
  if (subs.some((s) => s.endpoint === sub.endpoint)) return; // уже подписан этим устройством
  subs.push({ endpoint: sub.endpoint, keys: sub.keys, addedAt: new Date().toISOString() });
  await writeSubscriptions(subs);
}

export async function removeSubscription(endpoint: string): Promise<void> {
  const subs = await readSubscriptions();
  await writeSubscriptions(subs.filter((s) => s.endpoint !== endpoint));
}

export async function getSubscriptionCount(): Promise<number> {
  return (await readSubscriptions()).length;
}

// Каждое событие — отдельным уведомлением, не сводкой (решение
// пользователя). Битые подписки (404/410) удаляются сразу, не копятся.
export async function sendPushToAll(payload: { title: string; body: string; tag?: string }): Promise<void> {
  const subs = await readSubscriptions();
  if (subs.length === 0) {
    // Явный лог — иначе неотличимо от "отправлен, но не доставлен".
    console.log(`[push] "${payload.title}" — подписок нет, отправлять некому`);
    return;
  }

  const vapid = await getVapidKeys();
  webpush.setVapidDetails("mailto:admin@localhost", vapid.publicKey, vapid.privateKey);

  const body = JSON.stringify(payload);
  const stillValid: PushSubscriptionRecord[] = [];
  let changed = false;
  let sent = 0;
  let failed = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        // urgency: high — иначе Android может придержать доставку
        // свёрнутому приложению до следующего окна обслуживания (минуты,
        // не секунды). TTL сутки — успеет догнать телефон офлайн.
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, {
          urgency: "high",
          TTL: 24 * 60 * 60,
        });
        stillValid.push(sub);
        sent += 1;
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        const message = (err as { body?: string; message?: string })?.body ?? (err as Error)?.message ?? String(err);
        failed += 1;
        if (statusCode === 404 || statusCode === 410) {
          changed = true; // подписка мертва — не переносим её в новый список
          console.log(`[push] подписка ${sub.endpoint.slice(0, 60)}... больше не действует (${statusCode}), убрана`);
        } else {
          stillValid.push(sub); // временная ошибка (сеть и т.п.) — не удаляем подписку из-за неё
          console.error(`[push] не удалось отправить на ${sub.endpoint.slice(0, 60)}...: ${statusCode ?? "?"} ${message}`);
        }
      }
    })
  );

  console.log(`[push] "${payload.title}" — доставлено ${sent}/${subs.length}${failed ? `, ошибок: ${failed}` : ""}`);

  if (changed) {
    await writeSubscriptions(stillValid);
  }
}
