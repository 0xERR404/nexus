import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const HUB_DATA_DIR = process.env.HUB_DATA_DIR ?? "/app/data";
const STATUS_FILE = path.join(HUB_DATA_DIR, "provider-status.json");

// Не проактивная проверка баланса — у Gemini/Claude/FlowMusic нет
// эндпоинта для этого (в отличие от DeepSeek /user/balance). Единственное
// доступное с обычным API-ключом — статус ПО ФАКТУ запроса: успех,
// "лимит" (429) или "биллинг не включён" (403).
export type ProviderStatusValue = "ok" | "rate_limited" | "billing_error";

interface ProviderStatusRecord {
  status: ProviderStatusValue;
  at: string; // ISO — когда именно это видели, не "сейчас"
}

type ProviderStatusMap = Record<string, ProviderStatusRecord>;

async function ensureDir() {
  await mkdir(HUB_DATA_DIR, { recursive: true });
}

async function readAll(): Promise<ProviderStatusMap> {
  try {
    return JSON.parse(await readFile(STATUS_FILE, "utf-8")) as ProviderStatusMap;
  } catch {
    return {};
  }
}

export async function recordProviderStatus(provider: string, status: ProviderStatusValue): Promise<void> {
  await ensureDir();
  const all = await readAll();
  all[provider] = { status, at: new Date().toISOString() };
  await writeFile(STATUS_FILE, JSON.stringify(all, null, 2));
}

export async function getProviderStatus(provider: string): Promise<ProviderStatusRecord | undefined> {
  const all = await readAll();
  return all[provider];
}
