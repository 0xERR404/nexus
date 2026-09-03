import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const HUB_DATA_DIR = process.env.HUB_DATA_DIR ?? "/app/data";
const KEYS_FILE = path.join(HUB_DATA_DIR, "keys.json");

// Жёстко определённые поля, не открытое "вставь любой ключ".
export interface ApiKeys {
  deepseek?: string;
  gemini?: string;
  flowmusic?: string;
  claude?: string;
  // Базовые URL — переопределяют адрес провайдера (свой прокси, если сеть
  // напрямую недоступна). Не секреты, обычный текст, тот же слот хранения.
  geminiBaseUrl?: string;
  claudeBaseUrl?: string;
  flowmusicBaseUrl?: string;
  // Токен, который хаб сам придумывает для представления удалённых
  // агентов мониторинга — тот же слот хранения, что и у ключей.
  monitoringAgentToken?: string;
}

const KNOWN_KEYS: (keyof ApiKeys)[] = [
  "deepseek",
  "gemini",
  "flowmusic",
  "claude",
  "geminiBaseUrl",
  "claudeBaseUrl",
  "flowmusicBaseUrl",
  "monitoringAgentToken",
];

async function ensureDir() {
  await mkdir(HUB_DATA_DIR, { recursive: true });
}

export async function getKeys(): Promise<ApiKeys> {
  try {
    return JSON.parse(await readFile(KEYS_FILE, "utf-8")) as ApiKeys;
  } catch {
    return {};
  }
}

export async function setKey(name: string, value: string): Promise<void> {
  if (!KNOWN_KEYS.includes(name as keyof ApiKeys)) {
    throw new Error(`неизвестное поле ключа: ${name}`);
  }
  await ensureDir();
  const keys = await getKeys();
  (keys as Record<string, string>)[name] = value;
  await writeFile(KEYS_FILE, JSON.stringify(keys, null, 2));
}

// Стереть поле насовсем, не пустой строкой — та бы осталась "задана" (точка
// в UI горела бы зелёным). Нужно для geminiBaseUrl: вернуться к прямому
// адресу после воркера. Секретные ключи стереть пустым значением нельзя —
// см. проверку в index.ts (POST /api/settings/keys).
export async function clearKey(name: string): Promise<void> {
  if (!KNOWN_KEYS.includes(name as keyof ApiKeys)) {
    throw new Error(`неизвестное поле ключа: ${name}`);
  }
  await ensureDir();
  const keys = await getKeys();
  delete (keys as Record<string, string>)[name];
  await writeFile(KEYS_FILE, JSON.stringify(keys, null, 2));
}

// Для UI — только факт "задан/не задан", сам ключ наружу не отдаём никогда.
export async function getKeyStatus(): Promise<Record<string, boolean>> {
  const keys = await getKeys();
  const status: Record<string, boolean> = {};
  for (const k of KNOWN_KEYS) {
    status[k] = Boolean(keys[k]);
  }
  return status;
}

export async function getDeepSeekKey(): Promise<string | undefined> {
  const keys = await getKeys();
  return keys.deepseek;
}

export async function getGeminiKey(): Promise<string | undefined> {
  const keys = await getKeys();
  return keys.gemini;
}

export async function getGeminiBaseUrl(): Promise<string | undefined> {
  const keys = await getKeys();
  return keys.geminiBaseUrl;
}

export async function getFlowMusicKey(): Promise<string | undefined> {
  const keys = await getKeys();
  return keys.flowmusic;
}

export async function getClaudeKey(): Promise<string | undefined> {
  const keys = await getKeys();
  return keys.claude;
}

export async function getClaudeBaseUrl(): Promise<string | undefined> {
  const keys = await getKeys();
  return keys.claudeBaseUrl;
}

export async function getFlowMusicBaseUrl(): Promise<string | undefined> {
  const keys = await getKeys();
  return keys.flowmusicBaseUrl;
}

export async function getMonitoringAgentToken(): Promise<string | undefined> {
  const keys = await getKeys();
  return keys.monitoringAgentToken;
}
