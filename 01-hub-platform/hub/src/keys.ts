import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "./fileLock.js";

const HUB_DATA_DIR = process.env.HUB_DATA_DIR ?? "/app/data";
const KEYS_FILE = path.join(HUB_DATA_DIR, "keys.json");

// Жёстко определённые поля, не открытое "вставь любой ключ".
export interface ApiKeys {
  deepseek?: string;
  gemini?: string;
  flowmusic?: string;
  claude?: string;
  // Базовые URL провайдеров — не секреты, тот же слот хранения.
  geminiBaseUrl?: string;
  claudeBaseUrl?: string;
  flowmusicBaseUrl?: string;
  monitoringAgentToken?: string;
  // CheevoScope — ключи Steam/RetroAchievements, тот же принцип хранения.
  steamApiKey?: string;
  steamId?: string;
  raUsername?: string;
  raApiKey?: string;
}

const KNOWN_KEYS: (keyof ApiKeys)[] = [
  "deepseek", "gemini", "flowmusic", "claude",
  "geminiBaseUrl", "claudeBaseUrl", "flowmusicBaseUrl",
  "monitoringAgentToken", "steamApiKey", "steamId", "raUsername", "raApiKey",
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
  if (!KNOWN_KEYS.includes(name as keyof ApiKeys)) throw new Error(`неизвестное поле ключа: ${name}`);
  // Блокировка — без неё два конкурентных запроса читали бы файл с одной
  // стартовой версией, и более поздняя запись стирала бы более раннюю.
  await withFileLock(KEYS_FILE, async () => {
    await ensureDir();
    const keys = await getKeys();
    (keys as Record<string, string>)[name] = value;
    await writeFile(KEYS_FILE, JSON.stringify(keys, null, 2));
  });
}

// Стереть поле насовсем, не пустой строкой (та осталась бы "задана" в UI).
export async function clearKey(name: string): Promise<void> {
  if (!KNOWN_KEYS.includes(name as keyof ApiKeys)) throw new Error(`неизвестное поле ключа: ${name}`);
  await withFileLock(KEYS_FILE, async () => {
    await ensureDir();
    const keys = await getKeys();
    delete (keys as Record<string, string>)[name];
    await writeFile(KEYS_FILE, JSON.stringify(keys, null, 2));
  });
}

// Для UI — только факт "задан/не задан", сам ключ наружу не отдаём.
export async function getKeyStatus(): Promise<Record<string, boolean>> {
  const keys = await getKeys();
  const status: Record<string, boolean> = {};
  for (const k of KNOWN_KEYS) status[k] = Boolean(keys[k]);
  return status;
}

function field<K extends keyof ApiKeys>(key: K): () => Promise<ApiKeys[K]> {
  return async () => (await getKeys())[key];
}

export const getDeepSeekKey = field("deepseek");
export const getGeminiKey = field("gemini");
export const getGeminiBaseUrl = field("geminiBaseUrl");
export const getFlowMusicKey = field("flowmusic");
export const getClaudeKey = field("claude");
export const getClaudeBaseUrl = field("claudeBaseUrl");
export const getFlowMusicBaseUrl = field("flowmusicBaseUrl");
export const getMonitoringAgentToken = field("monitoringAgentToken");
export const getSteamApiKey = field("steamApiKey");
export const getSteamId = field("steamId");
export const getRaUsername = field("raUsername");
export const getRaApiKey = field("raApiKey");
