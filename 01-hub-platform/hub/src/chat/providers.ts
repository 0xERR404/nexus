// Провайдеры чата: DeepSeek, Gemini, Claude, FlowMusic + статус
// провайдера (rate-limit/billing по факту последнего запроса).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getDeepSeekKey, getGeminiKey, getGeminiBaseUrl, getClaudeKey, getClaudeBaseUrl, getFlowMusicKey, getFlowMusicBaseUrl, setKey } from "../keys.js";
import { withFileLock } from "../fileLock.js";
import { Impit, type RequestInit as ImpitRequestInit, type ImpitResponse } from "impit";
import type { TokenUsage } from "./usage.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatReply {
  content: string;
  usage?: TokenUsage;
  model?: string;
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 3_000;
const DEFAULT_MAX_TOKENS_REPLY = 4096;
const MAX_TOKENS_REPLY = Number(process.env.CHAT_MAX_REPLY_TOKENS) || DEFAULT_MAX_TOKENS_REPLY;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ---------- DeepSeek ----------

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_MODELS = ["deepseek-v4-flash"] as const;
export type DeepSeekModel = (typeof DEEPSEEK_MODELS)[number];
export const DEFAULT_DEEPSEEK_MODEL: DeepSeekModel = "deepseek-v4-flash";

export class DeepSeekNotConfiguredError extends Error {
  constructor() {
    super("DeepSeek API-ключ не задан — введи его в настройках хаба");
  }
}

function resolveDeepSeekModel(model: string | undefined): DeepSeekModel {
  return (DEEPSEEK_MODELS as readonly string[]).includes(model ?? "") ? (model as DeepSeekModel) : DEFAULT_DEEPSEEK_MODEL;
}

function sendDeepSeekRequest(apiKey: string, body: Record<string, unknown>): Promise<Response> {
  return fetchWithTimeout(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
}

export async function askDeepSeek(messages: ChatMessage[], model?: string): Promise<ChatReply> {
  const apiKey = await getDeepSeekKey();
  if (!apiKey) throw new DeepSeekNotConfiguredError();
  const resolvedModel = resolveDeepSeekModel(model);
  const requestBody = { model: resolvedModel, messages, max_tokens: MAX_TOKENS_REPLY };

  let res: Response;
  try {
    res = await sendDeepSeekRequest(apiKey, requestBody);
  } catch {
    await sleep(RETRY_DELAY_MS);
    try {
      res = await sendDeepSeekRequest(apiKey, requestBody);
    } catch (err2) {
      const isTimeout = err2 instanceof Error && err2.name === "AbortError";
      throw new Error(isTimeout ? `DeepSeek API не ответил вовремя дважды подряд` : `DeepSeek API — сетевая ошибка: ${err2 instanceof Error ? err2.message : String(err2)}`);
    }
  }
  if (!res.ok) throw new Error(`DeepSeek API ошибка ${res.status}: ${await res.text().catch(() => "")}`);

  const data = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const usage: TokenUsage | undefined = data.usage
    ? { promptTokens: data.usage.prompt_tokens ?? 0, completionTokens: data.usage.completion_tokens ?? 0, totalTokens: data.usage.total_tokens ?? 0 }
    : undefined;
  if (data.choices?.[0]?.finish_reason === "length") {
    return { content: content + "\n\n*(ответ обрезан лимитом токенов — попроси продолжить)*", usage, model: resolvedModel };
  }
  return { content, usage, model: resolvedModel };
}

export interface DeepSeekBalance {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}
export type DeepSeekBalanceResult =
  | { configured: false }
  | { configured: true; ok: true; balances: DeepSeekBalance[] }
  | { configured: true; ok: false; error: string };

export async function getDeepSeekBalance(): Promise<DeepSeekBalanceResult> {
  const apiKey = await getDeepSeekKey();
  if (!apiKey) return { configured: false };
  try {
    const res = await fetchWithTimeout(`${DEEPSEEK_BASE_URL}/user/balance`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return { configured: true, ok: false, error: `DeepSeek API ошибка ${res.status}: ${await res.text().catch(() => "")}` };
    const data = (await res.json()) as { balance_infos?: { currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }[] };
    const balances: DeepSeekBalance[] = (data.balance_infos ?? []).map((b) => ({ currency: b.currency, totalBalance: b.total_balance, grantedBalance: b.granted_balance, toppedUpBalance: b.topped_up_balance }));
    return { configured: true, ok: true, balances };
  } catch (err) {
    return { configured: true, ok: false, error: String(err) };
  }
}

// ---------- Статус провайдера (rate-limit/billing по факту запроса) ----------
// Только Gemini и Claude не отдают баланс через API — единственный сигнал
// для них — код ответа последнего реального запроса.

const HUB_DATA_DIR = process.env.HUB_DATA_DIR ?? "/app/data";
const STATUS_FILE = path.join(HUB_DATA_DIR, "provider-status.json");
export type ProviderStatusValue = "ok" | "rate_limited" | "billing_error";
type ProviderStatusMap = Record<string, { status: ProviderStatusValue; at: string }>;

async function readProviderStatusAll(): Promise<ProviderStatusMap> {
  try {
    return JSON.parse(await readFile(STATUS_FILE, "utf-8")) as ProviderStatusMap;
  } catch {
    return {};
  }
}

export async function recordProviderStatus(provider: string, status: ProviderStatusValue): Promise<void> {
  await mkdir(HUB_DATA_DIR, { recursive: true });
  await withFileLock(STATUS_FILE, async () => {
    const all = await readProviderStatusAll();
    all[provider] = { status, at: new Date().toISOString() };
    await writeFile(STATUS_FILE, JSON.stringify(all, null, 2));
  });
}

export async function getProviderStatus(provider: string) {
  return (await readProviderStatusAll())[provider];
}

// ---------- Gemini ----------
// Не проверено живым запросом (сеть до Google недоступна в среде
// разработки) — формат по документации Gemini API.

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_MODEL = process.env.CHAT_GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

export class GeminiNotConfiguredError extends Error {
  constructor() {
    super("Gemini API-ключ не задан — введи его в настройках хаба");
  }
}

function sendGeminiRequest(baseUrl: string, apiKey: string, body: Record<string, unknown>): Promise<Response> {
  return fetchWithTimeout(`${baseUrl}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function askGemini(messages: ChatMessage[]): Promise<ChatReply> {
  const apiKey = await getGeminiKey();
  if (!apiKey) throw new GeminiNotConfiguredError();
  const baseUrl = (await getGeminiBaseUrl()) || DEFAULT_GEMINI_BASE_URL;

  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const contents = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const body: Record<string, unknown> = { contents, generationConfig: { maxOutputTokens: MAX_TOKENS_REPLY } };
  if (systemParts.length > 0) body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };

  let res: Response;
  try {
    res = await sendGeminiRequest(baseUrl, apiKey, body);
  } catch {
    await sleep(RETRY_DELAY_MS);
    try {
      res = await sendGeminiRequest(baseUrl, apiKey, body);
    } catch (err2) {
      const isTimeout = err2 instanceof Error && err2.name === "AbortError";
      throw new Error(isTimeout ? `Gemini API не ответил вовремя дважды подряд` : `Gemini API — сетевая ошибка: ${err2 instanceof Error ? err2.message : String(err2)}`);
    }
  }
  // 503 — временная перегрузка Google, один повтор.
  if (res.status === 503) {
    await sleep(RETRY_DELAY_MS);
    res = await sendGeminiRequest(baseUrl, apiKey, body);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 429) await recordProviderStatus("gemini", "rate_limited").catch(() => {});
    else if (res.status === 403) await recordProviderStatus("gemini", "billing_error").catch(() => {});
    throw new Error(`Gemini API ошибка ${res.status}: ${text}`);
  }
  await recordProviderStatus("gemini", "ok").catch(() => {});

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const content = parts.map((p) => p.text ?? "").join("");
  const usage: TokenUsage | undefined = data.usageMetadata
    ? { promptTokens: data.usageMetadata.promptTokenCount ?? 0, completionTokens: data.usageMetadata.candidatesTokenCount ?? 0, totalTokens: data.usageMetadata.totalTokenCount ?? 0 }
    : undefined;
  if (data.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    return { content: content + "\n\n*(ответ обрезан лимитом токенов — попроси продолжить)*", usage };
  }
  return { content, usage };
}

// ---------- Claude ----------
// У Anthropic нет публичного REST-эндпоинта баланса — billing честно
// показывает это, заглушки нет.

const DEFAULT_CLAUDE_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";
const CLAUDE_MODEL = process.env.CHAT_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;

export class ClaudeNotConfiguredError extends Error {
  constructor() {
    super("Claude API-ключ не задан — введи его в настройках хаба");
  }
}

function sendClaudeRequest(baseUrl: string, apiKey: string, body: Record<string, unknown>): Promise<Response> {
  return fetchWithTimeout(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
    body: JSON.stringify(body),
  });
}

export async function askClaude(messages: ChatMessage[]): Promise<ChatReply> {
  const apiKey = await getClaudeKey();
  if (!apiKey) throw new ClaudeNotConfiguredError();
  const baseUrl = (await getClaudeBaseUrl()) || DEFAULT_CLAUDE_BASE_URL;

  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const conversation = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
  const body: Record<string, unknown> = { model: CLAUDE_MODEL, max_tokens: MAX_TOKENS_REPLY, messages: conversation };
  if (systemParts.length > 0) body.system = systemParts.join("\n\n");

  let res: Response;
  try {
    res = await sendClaudeRequest(baseUrl, apiKey, body);
  } catch {
    await sleep(RETRY_DELAY_MS);
    res = await sendClaudeRequest(baseUrl, apiKey, body);
  }
  if (res.status === 503) {
    await sleep(RETRY_DELAY_MS);
    res = await sendClaudeRequest(baseUrl, apiKey, body);
  }
  if (!res.ok) throw new Error(`Claude API ошибка ${res.status}: ${await res.text().catch(() => "")}`);

  const data = (await res.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  const content = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  const usage: TokenUsage | undefined = data.usage
    ? { promptTokens: data.usage.input_tokens ?? 0, completionTokens: data.usage.output_tokens ?? 0, totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0) }
    : undefined;
  if (data.stop_reason === "max_tokens") {
    return { content: content + "\n\n*(ответ обрезан лимитом токенов — попроси продолжить)*", usage };
  }
  return { content, usage };
}

// ---------- FlowMusic ----------
// Официального API нет — токен браузерной сессии (Supabase
// access_token/refresh_token из куки flowmusic.app), не ключ. Вставляется
// целиком в настройках, access_token обновляется сам по refresh_token
// (тот не истекает, пока не разлогиниться на flowmusic.app явно).
// Эндпоинты (/__api/projects, /__api/conversation, .../stream,
// /__api/audio-create-song-status/*, /__api/download/audio/*) взяты из
// рабочего стороннего клиента (@justmpm/flowmusic, npm, MIT), не догадка.

const DEFAULT_FLOWMUSIC_BASE_URL = "https://www.flowmusic.app";
const ENV_FLOWMUSIC_BASE_URL = process.env.FLOWMUSIC_BASE_URL;
const FLOWMUSIC_TIMEOUT_MS = 60_000; // генерация музыки медленнее текста
// Отдельный лимит на скачивание — wav весит на порядок больше m4a,
// обычный 60-секундный таймаут не рассчитан на несколько мегабайт тела.
const FLOWMUSIC_DOWNLOAD_TIMEOUT_MS = 300_000;
const FLOWMUSIC_POLL_INTERVAL_MS = 3_000;
const FLOWMUSIC_MAX_POLL_ATTEMPTS = 60; // до ~3 минут на генерацию
// Отдельный Supabase-проект именно для авторизации flowmusic.app — не то
// же самое, что "свой адрес вместо flowmusic.ai" в настройках (тот — для
// основного API, на случай воркера/прокси перед ним). Не настраивается —
// это инфраструктурная деталь самого FlowMusic, не пользовательский выбор.
const FLOWMUSIC_SUPABASE_AUTH_URL = "https://sb.producer.ai";

export class FlowMusicNotConfiguredError extends Error {
  constructor() {
    super("Токен сессии FlowMusic не задан — введи его в настройках хаба");
  }
}

export interface FlowMusicResult {
  audioBuffer: Buffer;
  mimeType: string;
  filename: string;
}

interface FlowMusicSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix-секунды
}

// Значение куки — base64(JSON), часто с префиксом "base64-". Пробуем
// сначала как готовый JSON, потом снимаем префикс и декодируем base64
// (как в decodeSupabaseToken у @justmpm/flowmusic). Supabase иногда режет
// большую куку на части (sb-...-auth-token.0/.1/...) — принимаем и
// несколько строк подряд, склеиваем перед декодированием.
function parseFlowMusicSession(raw: string): FlowMusicSession | null {
  const tryParse = (text: string): { access_token?: string; refresh_token?: string; expires_at?: number } | null => {
    try {
      return JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_at?: number };
    } catch {
      return null;
    }
  };

  // Сценарий 1: уже готовый JSON целиком (например, из session.json стороннего инструмента).
  let data = tryParse(raw.trim());

  // Сценарий 2: одна или несколько строк base64 (по одной на часть куки,
  // .0/.1/... по порядку) — снимаем префикс "base64-" с каждой части
  // отдельно (Supabase иногда добавляет его на каждую, не только на
  // первую) и склеиваем перед декодированием.
  if (!data || typeof data.access_token !== "string") {
    const parts = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^base64-/, ""));
    if (parts.length > 0) {
      try {
        const decoded = Buffer.from(parts.join(""), "base64").toString("utf-8");
        data = tryParse(decoded);
      } catch {
        data = null;
      }
    }
  }
  if (!data || typeof data.access_token !== "string") return null;

  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : "",
    expiresAt: typeof data.expires_at === "number" ? data.expires_at : 0,
  };
}

// 60с запас до истечения — тот же буфер, что в @justmpm/flowmusic.
function isFlowMusicTokenExpired(expiresAt: number): boolean {
  if (!expiresAt) return true;
  return Date.now() / 1000 >= expiresAt - 60;
}

// Заголовки браузера — HTTP 403 с HTML-телом (а не JSON-ошибкой Supabase)
// похоже на блокировку WAF/бот-защитой ДО того, как запрос вообще дошёл
// до логики Supabase: голый серверный fetch без User-Agent/Origin/Referer
// Единый клиент с имперсонацией Chrome (браузерный TLS-отпечаток, не
// только заголовки) — обычный fetch() из Node (undici) отличим по
// TLS-рукопожатию от настоящего браузера независимо от заголовков сверху,
// это и давало HTTP 403 с HTML на голых запросах. impit — компактный
// (нативный бинарник на Rust, без Chromium) drop-in для fetch с реальной
// подменой отпечатка, см. https://github.com/apify/impit. Origin/Referer
// оставлены вручную — это контекст конкретной страницы, не характеристика
// браузера, impit сам их не знает; User-Agent/sec-ch-ua и т.п. impit
// подставляет сам, согласованно с TLS-профилем — свои поверх не добавляем,
// иначе получилось бы рассогласование (заголовки от одной версии Chrome,
// TLS-отпечаток от другой), что заметнее, чем вообще ничего не подделывать.
const flowMusicClient = new Impit({ browser: "chrome", vanillaFallback: true });
const FLOWMUSIC_CONTEXT_HEADERS = {
  Origin: "https://www.flowmusic.app",
  Referer: "https://www.flowmusic.app/",
};

// Одна повторная попытка с паузой при сбое обновления токена — часть
// сбоев может быть переходной (сетевой обрыв, кратковременный WAF-челлендж),
// не постоянной блокировкой.
async function refreshFlowMusicTokenWithRetry(refreshToken: string): Promise<FlowMusicSession | null> {
  const first = await refreshFlowMusicToken(refreshToken);
  if (first) return first;
  await sleep(RETRY_DELAY_MS);
  return refreshFlowMusicToken(refreshToken);
}

async function refreshFlowMusicToken(refreshToken: string): Promise<FlowMusicSession | null> {
  if (!refreshToken) return null;
  try {
    // apikey — не секрет, а имя Supabase-проекта (поддомен перед первой
    // точкой в FLOWMUSIC_SUPABASE_AUTH_URL) — тот же вывод, что в
    // @justmpm/flowmusic, не догадка "на глаз".
    const apikey = FLOWMUSIC_SUPABASE_AUTH_URL.split("//")[1]?.split(".")[0] ?? "";
    const res = await flowMusicClient.fetch(`${FLOWMUSIC_SUPABASE_AUTH_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey, ...FLOWMUSIC_CONTEXT_HEADERS },
      body: JSON.stringify({ refresh_token: refreshToken }),
      timeout: FLOWMUSIC_TIMEOUT_MS,
    });
    if (!res.ok) {
      // Раньше молча возвращали null — единственный сигнал пользователю
      // был "истекла и не удалось обновить", без единой зацепки, ПОЧЕМУ
      // (неверный apikey, invalid_grant из-за уже использованного
      // refresh_token, рейт-лимит Supabase и т.п.). В логи хаба — реальный
      // ответ, не только факт неудачи.
      const bodyText = await res.text().catch(() => "");
      console.error(`[flowmusic] обновление токена не удалось: HTTP ${res.status} — ${bodyText.slice(0, 500)}`);
      return null;
    }
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) {
      console.error(`[flowmusic] Supabase ответил 200, но без access_token: ${JSON.stringify(data).slice(0, 500)}`);
      return null;
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    };
  } catch (err) {
    console.error(`[flowmusic] обновление токена — сетевая ошибка: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// Токен FlowMusic — один общий на весь хаб (одна запись в keys.json), не
// по темам. Мьютекс по теме в index.ts (flowmusic-topic-${topicId})
// защищает только project_id ЭТОЙ темы — если две РАЗНЫЕ темы одновременно
// увидят истекший токен, обе дёрнули бы Supabase одним и тем же
// refresh_token (тот одноразовый) — вторая получила бы invalid_grant.
// Отдельная, глобальная блокировка здесь — под тем же фиксированным
// ключом для любого вызова, независимо от темы.
async function ensureFlowMusicAccessToken(): Promise<string> {
  return withFileLock("flowmusic-token-refresh", async () => {
    const raw = await getFlowMusicKey();
    if (!raw) throw new FlowMusicNotConfiguredError();
    const session = parseFlowMusicSession(raw);
    if (!session) {
      throw new Error(
        "Не удалось разобрать токен сессии FlowMusic — вставь значение куки " +
          "sb-...-auth-token с flowmusic.app как есть (можно с префиксом " +
          "\"base64-\") либо готовый JSON с access_token/refresh_token/expires_at."
      );
    }
    if (!isFlowMusicTokenExpired(session.expiresAt)) return session.accessToken;

    const refreshed = await refreshFlowMusicTokenWithRetry(session.refreshToken);
    if (!refreshed) {
      throw new Error("Сессия FlowMusic истекла и не удалось обновить — зайди на flowmusic.app заново и вставь новый токен в настройках хаба.");
    }
    // refresh_token у Supabase одноразовый — не сохранить обновлённый
    // означало бы потерять возможность обновиться в следующий раз. Ошибку
    // записи логируем, не глотаем — молчание тут маскировало бы реальную причину.
    try {
      await setKey(
        "flowmusic",
        JSON.stringify({ access_token: refreshed.accessToken, refresh_token: refreshed.refreshToken, expires_at: refreshed.expiresAt })
      );
    } catch (err) {
      console.error(`[flowmusic] обновлённый токен получен, но НЕ СОХРАНЁН на диск: ${err instanceof Error ? err.message : String(err)}`);
    }
    return refreshed.accessToken;
  });
}

async function flowMusicFetch(baseUrl: string, path: string, init: ImpitRequestInit = {}, timeoutMs = FLOWMUSIC_TIMEOUT_MS): Promise<ImpitResponse> {
  const token = await ensureFlowMusicAccessToken();
  const headers: Record<string, string> = {
    ...FLOWMUSIC_CONTEXT_HEADERS,
    ...(init.headers as Record<string, string> | undefined),
    Authorization: `Bearer ${token}`,
  };
  if (!headers["Content-Type"] && (init.method === "POST" || init.method === "PUT")) headers["Content-Type"] = "application/json";
  return flowMusicClient.fetch(`${baseUrl}${path}`, { ...init, headers, timeout: timeoutMs });
}

// Статус приходит SSE-потоком. FlowMusic обычно даёт сразу несколько
// вариантов на запрос — возвращаем ВСЕ operation_id, не только последний.
function parseFlowMusicStreamOperationIds(streamText: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  let currentEvent = "";
  for (const line of streamText.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const rawJson = line.slice(5).trim();
    if (!rawJson || currentEvent !== "part") continue;
    try {
      const data = JSON.parse(rawJson) as { part?: { content?: { operation_id?: string } } };
      const opId = data.part?.content?.operation_id;
      if (typeof opId === "string" && !seen.has(opId)) {
        seen.add(opId);
        order.push(opId);
      }
    } catch {
      // не JSON-строка потока (комментарий/keep-alive) — пропускаем
    }
  }
  return order;
}

interface FlowMusicTrackState {
  clipId: string | null;
  error: string | null;
}

// Генерирует по одному промпту (последнее сообщение пользователя).
// Возвращает массив треков (обычно 2) — сохранение как вложений делает
// index.ts (providers.ts не знает о темах чата вообще).
export interface FlowMusicGenerateResult {
  tracks: FlowMusicResult[];
  projectId: string;
}

// existingProjectId — переиспользуем project_id темы вместо создания
// нового на каждое сообщение (иначе FlowMusic заводил бы отдельную
// сессию на каждое). onProjectCreated вызывается СРАЗУ, как только id
// известен, — не в конце всей функции: иначе сбой на более позднем шаге
// (опрос/скачивание) терял бы id несохранённым, и ретрай снова создавал
// бы новый проект вместо использования уже существующего.
export async function askFlowMusic(
  prompt: string,
  existingProjectId?: string,
  onProjectCreated?: (id: string) => void
): Promise<FlowMusicGenerateResult> {
  const baseUrl = (await getFlowMusicBaseUrl()) || ENV_FLOWMUSIC_BASE_URL || DEFAULT_FLOWMUSIC_BASE_URL;

  let projectId = existingProjectId;
  if (!projectId) {
    const project = (await (
      await flowMusicFetch(baseUrl, "/__api/projects", {
        method: "POST",
        body: JSON.stringify({ title: prompt.slice(0, 100), description: prompt }),
      })
    ).json()) as { id?: string };
    if (!project.id) throw new Error("FlowMusic не вернул id проекта");
    projectId = project.id;
  }
  onProjectCreated?.(projectId);

  const job = (await (
    await flowMusicFetch(baseUrl, "/__api/conversation", {
      method: "POST",
      body: JSON.stringify({ parts: [{ content: prompt, part_kind: "user-prompt" }], client_context: {}, project_id: projectId }),
    })
  ).json()) as { job_id?: string };
  if (!job.job_id) throw new Error("FlowMusic не вернул job_id");

  // operationId -> состояние. Перечитываем поток КАЖДУЮ итерацию (не
  // только пока пусто) — operation_id второго/третьего варианта может
  // появиться в потоке позже первого, не одновременно с ним.
  const tracks = new Map<string, FlowMusicTrackState>();
  for (let attempt = 0; attempt < FLOWMUSIC_MAX_POLL_ATTEMPTS; attempt++) {
    const streamText = await (await flowMusicFetch(baseUrl, `/__api/messages/${job.job_id}/stream?last_id=0`)).text();
    for (const opId of parseFlowMusicStreamOperationIds(streamText)) {
      if (!tracks.has(opId)) tracks.set(opId, { clipId: null, error: null });
    }

    for (const [opId, state] of tracks) {
      if (state.clipId || state.error) continue; // этот вариант уже готов или уже упал с ошибкой
      const status = (await (await flowMusicFetch(baseUrl, `/__api/audio-create-song-status/${opId}`)).json()) as {
        clip_id?: string;
        error_type?: string;
        error_message?: string;
      };
      if (status.error_type) {
        state.error = `${status.error_type}${status.error_message ? " — " + status.error_message : ""}`;
      } else if (status.clip_id) {
        state.clipId = status.clip_id;
      }
    }

    const allSettled = tracks.size > 0 && Array.from(tracks.values()).every((t) => t.clipId || t.error);
    if (allSettled) break;
    await sleep(FLOWMUSIC_POLL_INTERVAL_MS);
  }

  const ready = Array.from(tracks.values()).filter((t): t is FlowMusicTrackState & { clipId: string } => Boolean(t.clipId));
  if (ready.length === 0) {
    const firstError = Array.from(tracks.values()).find((t) => t.error)?.error;
    if (firstError) throw new Error(`FlowMusic — ошибка генерации: ${firstError}`);
    throw new Error("FlowMusic не закончил генерацию за отведённое время — попробуй ещё раз");
  }

  // wav — без потерь (m4a легче, но по запросу пользователя точность важнее
  // размера). Файл ощутимо больше m4a — отдельный, более щедрый таймаут
  // именно на скачивание (см. FLOWMUSIC_DOWNLOAD_TIMEOUT_MS), обычный
  // 60-секундный на скачивание нескольких мегабайт целиком не рассчитан.
  const results: FlowMusicResult[] = [];
  for (const track of ready) {
    const audioRes = await flowMusicFetch(baseUrl, `/__api/download/audio/${track.clipId}?format=wav`, {}, FLOWMUSIC_DOWNLOAD_TIMEOUT_MS);
    if (!audioRes.ok) throw new Error(`FlowMusic — не удалось скачать готовое аудио: ${audioRes.status}`);
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    results.push({ audioBuffer, mimeType: "audio/wav", filename: `${track.clipId}.wav` });
  }
  return { tracks: results, projectId };
}

// Эндпоинт найден у другого стороннего проекта (FlowMusic2API, Go,
// github.com/genz27/FlowMusic2API), не у @justmpm/flowmusic. GET
// /__api/billing/credits -> {data:{credits_remaining,tokens_remaining}},
// GET /__api/billing/subscription -> {data:{subscription_tier}}.
export type FlowMusicBalanceResult =
  | { configured: false }
  | { configured: true; ok: true; creditsRemaining: number; tokensRemaining: number; subscriptionTier: string | null }
  | { configured: true; ok: false; error: string };

export async function getFlowMusicBalance(): Promise<FlowMusicBalanceResult> {
  const raw = await getFlowMusicKey();
  if (!raw) return { configured: false };
  const baseUrl = (await getFlowMusicBaseUrl()) || ENV_FLOWMUSIC_BASE_URL || DEFAULT_FLOWMUSIC_BASE_URL;
  try {
    const creditsRes = await flowMusicFetch(baseUrl, "/__api/billing/credits");
    if (!creditsRes.ok) return { configured: true, ok: false, error: `FlowMusic API ошибка ${creditsRes.status}: ${await creditsRes.text().catch(() => "")}` };
    const creditsJson = (await creditsRes.json()) as { data?: { credits_remaining?: number; tokens_remaining?: number } };

    // Подписка — отдельный запрос, необязательный: если этот конкретный
    // эндпоинт недоступен/поменялся, показываем хотя бы кредиты, не
    // проваливаем всё целиком из-за второстепенного поля.
    let subscriptionTier: string | null = null;
    try {
      const subRes = await flowMusicFetch(baseUrl, "/__api/billing/subscription");
      if (subRes.ok) {
        const subJson = (await subRes.json()) as { data?: { subscription_tier?: string } };
        subscriptionTier = subJson.data?.subscription_tier ?? null;
      }
    } catch {
      // необязательно — молча пропускаем
    }

    return {
      configured: true,
      ok: true,
      creditsRemaining: creditsJson.data?.credits_remaining ?? 0,
      tokensRemaining: creditsJson.data?.tokens_remaining ?? 0,
      subscriptionTier,
    };
  } catch (err) {
    return { configured: true, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
