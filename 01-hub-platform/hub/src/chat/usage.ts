import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const HUB_DATA_DIR = process.env.HUB_DATA_DIR ?? "/app/data";
const CHAT_DIR = path.join(HUB_DATA_DIR, "chat");
const USAGE_FILE = path.join(CHAT_DIR, "usage.jsonl");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface UsageEntry extends TokenUsage {
  topicId: string;
  provider: string;
  timestamp: string;
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageSummary {
  today: UsageTotals; // календарный день
  allTime: UsageTotals;
  byTopic: Record<string, UsageTotals>;
  byProviderAllTime: Record<string, UsageTotals>;
  byProviderToday: Record<string, UsageTotals>;
  // Скользящее окно от текущего момента (60/1440/43200 минут), не
  // календарная граница — для billing, честнее "сегодня" (не обнуляется
  // в полночь). "Месяц" — 30 дней, не календарный.
  lastHour: UsageTotals;
  lastDay: UsageTotals;
  lastMonth: UsageTotals;
  byProviderLastHour: Record<string, UsageTotals>;
  byProviderLastDay: Record<string, UsageTotals>;
  byProviderLastMonth: Record<string, UsageTotals>;
}

async function ensureDir() {
  await mkdir(CHAT_DIR, { recursive: true });
}

function emptyTotals(): UsageTotals {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addTo(totals: UsageTotals, usage: TokenUsage) {
  totals.promptTokens += usage.promptTokens;
  totals.completionTokens += usage.completionTokens;
  totals.totalTokens += usage.totalTokens;
}

function addToProvider(map: Record<string, UsageTotals>, provider: string, usage: TokenUsage) {
  if (!map[provider]) map[provider] = emptyTotals();
  addTo(map[provider], usage);
}

// Реальные числа из usage/usageMetadata ответа API, не оценка. FlowMusic
// сюда не попадает — генерация аудио, токенов у провайдера нет.
export async function recordUsage(topicId: string, provider: string, usage: TokenUsage): Promise<void> {
  await ensureDir();
  const entry: UsageEntry = { topicId, provider, ...usage, timestamp: new Date().toISOString() };
  await appendFile(USAGE_FILE, JSON.stringify(entry) + "\n");
}

// Журнал — единственный источник правды. Отдельного счётчика нет: на
// личном масштабе просуммировать весь журнал на каждый запрос не
// проблема, а счётчик рисковал бы разойтись с журналом при сбое.
export async function getUsageSummary(): Promise<UsageSummary> {
  const summary: UsageSummary = {
    today: emptyTotals(),
    allTime: emptyTotals(),
    byTopic: {},
    byProviderAllTime: {},
    byProviderToday: {},
    lastHour: emptyTotals(),
    lastDay: emptyTotals(),
    byProviderLastHour: {},
    byProviderLastDay: {},
    lastMonth: emptyTotals(),
    byProviderLastMonth: {},
  };

  let raw: string;
  try {
    raw = await readFile(USAGE_FILE, "utf-8");
  } catch {
    return summary;
  }

  const now = Date.now();
  const todayKey = new Date(now).toISOString().slice(0, 10);

  for (const line of raw.trim().split("\n")) {
    if (!line) continue;
    let entry: UsageEntry;
    try {
      entry = JSON.parse(line) as UsageEntry;
    } catch {
      continue; // повреждённая строка — пропускаем, не роняем весь дашборд
    }

    addTo(summary.allTime, entry);
    addToProvider(summary.byProviderAllTime, entry.provider, entry);

    if (entry.timestamp.slice(0, 10) === todayKey) {
      addTo(summary.today, entry);
      addToProvider(summary.byProviderToday, entry.provider, entry);
    }

    const ageMs = now - new Date(entry.timestamp).getTime();
    if (ageMs >= 0 && ageMs <= MONTH_MS) {
      addTo(summary.lastMonth, entry);
      addToProvider(summary.byProviderLastMonth, entry.provider, entry);
    }
    if (ageMs >= 0 && ageMs <= DAY_MS) {
      addTo(summary.lastDay, entry);
      addToProvider(summary.byProviderLastDay, entry.provider, entry);
    }
    if (ageMs >= 0 && ageMs <= HOUR_MS) {
      addTo(summary.lastHour, entry);
      addToProvider(summary.byProviderLastHour, entry.provider, entry);
    }

    if (!summary.byTopic[entry.topicId]) summary.byTopic[entry.topicId] = emptyTotals();
    addTo(summary.byTopic[entry.topicId], entry);
  }

  return summary;
}
