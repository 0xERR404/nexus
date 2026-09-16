// Провайдеры чата: DeepSeek, Gemini, Claude, FlowMusic + статус
// провайдера (rate-limit/billing по факту последнего запроса).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getDeepSeekKey, getGeminiKey, getGeminiBaseUrl, getClaudeKey, getClaudeBaseUrl, getFlowMusicKey, getFlowMusicBaseUrl } from "../keys.js";
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
  const all = await readProviderStatusAll();
  all[provider] = { status, at: new Date().toISOString() };
  await writeFile(STATUS_FILE, JSON.stringify(all, null, 2));
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
// Официальной документации API не было под рукой — контракт по типовому
// REST-паттерну для генерации музыки, не проверен живым запросом.

const DEFAULT_FLOWMUSIC_BASE_URL = "https://api.flowmusic.ai/v1";
const ENV_FLOWMUSIC_BASE_URL = process.env.FLOWMUSIC_BASE_URL;
const FLOWMUSIC_TIMEOUT_MS = 60_000; // генерация музыки медленнее текста

export class FlowMusicNotConfiguredError extends Error {
  constructor() {
    super("FlowMusic API-ключ не задан — введи его в настройках хаба");
  }
}

export interface FlowMusicResult {
  audioUrl: string;
}

function sendFlowMusicRequest(baseUrl: string, apiKey: string, prompt: string): Promise<Response> {
  return fetchWithTimeout(
    `${baseUrl}/generate`,
    { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ prompt }) },
    FLOWMUSIC_TIMEOUT_MS
  );
}

// Генерирует не из истории переписки, а из одного промпта — последнего
// сообщения пользователя.
export async function askFlowMusic(prompt: string): Promise<FlowMusicResult> {
  const apiKey = await getFlowMusicKey();
  if (!apiKey) throw new FlowMusicNotConfiguredError();
  const baseUrl = (await getFlowMusicBaseUrl()) || ENV_FLOWMUSIC_BASE_URL || DEFAULT_FLOWMUSIC_BASE_URL;

  let res: Response;
  try {
    res = await sendFlowMusicRequest(baseUrl, apiKey, prompt);
  } catch (err) {
    if (!(err instanceof Error && err.name === "AbortError")) throw err;
    await sleep(RETRY_DELAY_MS);
    try {
      res = await sendFlowMusicRequest(baseUrl, apiKey, prompt);
    } catch (err2) {
      if (err2 instanceof Error && err2.name === "AbortError") throw new Error(`FlowMusic API не ответил вовремя дважды подряд`);
      throw err2;
    }
  }
  if (!res.ok) throw new Error(`FlowMusic API ошибка ${res.status}: ${await res.text().catch(() => "")}`);

  const data = (await res.json()) as { audio_url?: string; url?: string };
  const audioUrl = data.audio_url ?? data.url;
  if (!audioUrl) throw new Error("FlowMusic API не вернул ссылку на аудио");
  return { audioUrl };
}
