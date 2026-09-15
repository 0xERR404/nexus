import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { sendPushToAll } from "./push.js";

const EVENTS_LOG = process.env.EVENTS_LOG ?? "/app/hooks/events/events.jsonl";
const HUB_DATA_DIR = process.env.HUB_DATA_DIR ?? "/app/data";
const CHECKPOINT_FILE = path.join(HUB_DATA_DIR, "events-push-checkpoint.txt");
const POLL_INTERVAL_MS = 5000;

interface RawEvent {
  type: string;
  time: string;
  details?: unknown;
}

// events.jsonl — пишут ДВА источника: сам хаб (emitEvent) и bash-хук
// event_hook.sh (fail2ban/unattended-upgrades/cron/reboot, в обход хаба
// напрямую). Единственный надёжный способ поймать оба — периодически
// перечитывать файл и сравнивать по числу строк (не по времени —
// часовые пояса ненадёжны).
function usernameOf(details: unknown): string {
  if (details && typeof details === "object" && "username" in details) {
    const u = (details as { username?: unknown }).username;
    if (typeof u === "string" && u) return u;
  }
  return "";
}
function ipOf(details: unknown): string {
  if (details && typeof details === "object" && "ip" in details) {
    const ip = (details as { ip?: unknown }).ip;
    if (typeof ip === "string" && ip) return ip;
  }
  return "";
}
// Один парсер на оба формата details: объект (события из хаба) или
// строка "key=value" (bash-хук, см. deploy_kit_ssh_events.sh) — нужно и
// для "user" (SSH), и для "username" (веб-логин), названных по-разному.
function detailsFieldOf(details: unknown, key: string): string {
  if (details && typeof details === "object" && key in details) {
    const v = (details as Record<string, unknown>)[key];
    if (typeof v === "string" && v) return v;
  }
  if (typeof details === "string") {
    const match = details.match(new RegExp(`${key}=(\\S+)`));
    if (match) return match[1];
  }
  return "";
}
function detailsText(details: unknown): string {
  if (typeof details === "string") return details;
  if (details && typeof details === "object") {
    // Структурированные объекты из хаба без своего форматтера — JSON как есть.
    return JSON.stringify(details);
  }
  return "";
}

// "IP=1.2.3.4 jail=sshd" (bash-хук fail2ban) — в читаемый текст.
function formatFail2banDetails(details: unknown): string {
  const text = detailsText(details);
  const ipMatch = text.match(/IP=(\S+)/);
  const jailMatch = text.match(/jail=(\S+)/);
  const ip = ipMatch ? ipMatch[1] : "неизвестен";
  const jail = jailMatch ? jailMatch[1] : "";
  const service = jail === "sshd" ? "SSH" : jail || "неизвестный сервис";
  return `Слишком много неудачных попыток входа по ${service}, адрес: ${ip}`;
}

// Только эти типы стоят push на телефон — остальное видно в модуле
// notifications (полный журнал), не должно засыпать телефон по мелочам.
//
// Логин/адрес подписаны словами явно; если поля нет в details — честно
// "не указан"/"не определён", не молчим.
const PUSH_FORMATTERS: Record<string, (details: unknown) => { title: string; body: string }> = {
  "auth.login_succeeded": (d) => ({
    title: "Вход в систему",
    body: `Успешный вход. Логин: ${usernameOf(d) || "не указан"}. Адрес: ${ipOf(d) || "не определён"}`,
  }),
  "auth.login_failed": (d) => ({
    title: "⚠️ Неудачная попытка входа",
    body: `Логин: ${usernameOf(d) || "не указан"}. Адрес: ${ipOf(d) || "не определён"}`,
  }),
  "deploy.update.completed": () => ({ title: "Сервер обновился", body: "Обновление хаба прошло успешно" }),
  "deploy.update.failed": (d) => ({ title: "⚠️ Ошибка обновления", body: detailsText(d) || "Обновление хаба завершилось с ошибкой" }),
  "system.update.completed": () => ({ title: "Сервер обновился", body: "Автообновления безопасности установлены" }),
  "system.reboot.completed": () => ({ title: "Сервер перезагрузился", body: "Сервер снова в сети после перезагрузки" }),
  "system.reboot.scheduled": (d) => ({ title: "Скоро перезагрузка", body: detailsText(d) || "Плановая перезагрузка сервера" }),
  "system.cleanup.completed": () => ({ title: "Сервер очищен от мусора", body: "Автоочистка выполнена" }),
  "system.healthcheck.completed": (d) => {
    const text = detailsText(d);
    const hasWarning = /внимание|warning|failed_units=[1-9]/i.test(text);
    return {
      title: hasWarning ? "⚠️ Проверка сервера — есть замечания" : "Проверка сервера — всё в порядке",
      body: text || "Ежедневная проверка выполнена",
    };
  },
  "security.fail2ban.ban": (d) => ({ title: "⚠️ Доступ заблокирован", body: formatFail2banDetails(d) }),
  "security.ssh.login_succeeded": (d) => ({
    title: "Вход по SSH",
    body: `Логин: ${detailsFieldOf(d, "user") || "не указан"}. Адрес: ${detailsFieldOf(d, "ip") || "не определён"}`,
  }),
  "security.ssh.login_failed": (d) => ({
    title: "⚠️ Неудачная попытка входа по SSH",
    body: `Логин: ${detailsFieldOf(d, "user") || "не указан"}. Адрес: ${detailsFieldOf(d, "ip") || "не определён"}`,
  }),
};

let cachedCheckpoint: number | null = null;

async function ensureDir() {
  await mkdir(HUB_DATA_DIR, { recursive: true });
}

async function loadCheckpoint(totalLines: number): Promise<number> {
  if (cachedCheckpoint !== null) return cachedCheckpoint;
  try {
    const raw = await readFile(CHECKPOINT_FILE, "utf-8");
    const parsed = Number(raw.trim());
    cachedCheckpoint = Number.isFinite(parsed) && parsed >= 0 ? parsed : totalLines;
    return cachedCheckpoint;
  } catch {
    // Первый запуск — не заваливаем телефон историей журнала, считаем с
    // текущего конца. Сохраняем сразу, иначе при перезапуске ДО первого
    // нового события пришлось бы решать это заново.
    cachedCheckpoint = totalLines;
    await saveCheckpoint(cachedCheckpoint);
    return cachedCheckpoint;
  }
}

async function saveCheckpoint(n: number) {
  cachedCheckpoint = n;
  try {
    await ensureDir();
    await writeFile(CHECKPOINT_FILE, String(n));
  } catch {
    // Не критично — в худшем случае повторно отправим прошлые события, не потеряем.
  }
}

export async function pollEventsAndPush(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(EVENTS_LOG, "utf-8");
  } catch {
    return; // журнала ещё нет — ждём следующего тика
  }
  const lines = raw.trim().split("\n").filter(Boolean);
  const checkpoint = await loadCheckpoint(lines.length);
  if (lines.length <= checkpoint) return; // ничего нового

  const newLines = lines.slice(checkpoint);
  for (const line of newLines) {
    let event: RawEvent;
    try {
      event = JSON.parse(line) as RawEvent;
    } catch {
      continue; // повреждённая строка — пропускаем
    }
    const formatter = PUSH_FORMATTERS[event.type];
    if (!formatter) continue;
    const { title, body } = formatter(event.details);
    console.log(`[eventWatcher] событие "${event.type}" подходит под push — отправляю`);
    // Без tag — иначе несколько событий одного типа подряд схлопывались
    // бы в одно уведомление (браузер заменяет уведомление с тем же tag).
    await sendPushToAll({ title, body }).catch((err) => {
      console.error(`[eventWatcher] sendPushToAll упал для "${event.type}":`, err);
    });
  }
  await saveCheckpoint(lines.length);
}

export function startEventWatcher() {
  pollEventsAndPush().catch(() => {});
  setInterval(() => {
    pollEventsAndPush().catch(() => {});
  }, POLL_INTERVAL_MS);
}
