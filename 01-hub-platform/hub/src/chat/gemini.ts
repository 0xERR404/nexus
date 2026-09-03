import { getGeminiKey, getGeminiBaseUrl } from "../keys.js";
import { recordProviderStatus } from "./providerStatus.js";
import type { ChatMessage, ChatReply } from "./deepseek.js";
import type { TokenUsage } from "./usage.js";

// ЧЕСТНАЯ ОГОВОРКА: не проверено живым запросом (сеть до Google
// недоступна из среды разработки). Формат — по документации Gemini API.
//
// Базовый URL — настраиваемый (geminiBaseUrl в keys.ts): у Google есть
// сетевые ограничения по регионам, обходной путь — свой Cloudflare
// Worker-прокси. Пусто — прямой адрес Google; если задан, должен
// включать "/v1beta" на конце, как и DEFAULT_GEMINI_BASE_URL — воркер
// прозрачный, путь дописывается поверх того же base.
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
// gemini-2.0-flash-exp снята с v1beta, gemini-2.5-flash тоже (найдено
// живыми 404). ЧЕСТНАЯ ОГОВОРКА: Google в ответе упоминает "Interactions
// API" как замену — название незнакомо, появилось позже обучающих
// данных, проверить документацию нет возможности. Пока используется
// generateContent с новым именем модели — если тоже не сработает,
// понадобится реальная документация нового API.
//
// Переменная окружения (как CHAT_CLAUDE_MODEL) — сменится у Google снова.
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_MODEL = process.env.CHAT_GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
// CHAT_MAX_REPLY_TOKENS общая с deepseek.ts — см. там про лимит 4096.
const DEFAULT_MAX_TOKENS_REPLY = 4096;
const MAX_TOKENS_REPLY = Number(process.env.CHAT_MAX_REPLY_TOKENS) || DEFAULT_MAX_TOKENS_REPLY;
// Пауза перед одним повтором на 503 — не мгновенно, не слишком долго.
const RETRY_ON_UNAVAILABLE_DELAY_MS = 3000;
// Тайм-аут — найдено по жалобе "иногда долго висит, со второго раза
// нормально" (лишний хоп через воркер иногда холодный/сеть моргает).
const REQUEST_TIMEOUT_MS = 30_000;

export class GeminiNotConfiguredError extends Error {
  constructor() {
    super("Gemini API-ключ не задан — введи его в настройках хаба");
  }
}

function sendGeminiRequest(baseUrl: string, apiKey: string, body: Record<string, unknown>): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(`${baseUrl}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Gemini использует "model" вместо "assistant" и системный промпт
// отдельным полем — переводим из общего ChatMessage.
export async function askGemini(messages: ChatMessage[]): Promise<ChatReply> {
  const apiKey = await getGeminiKey();
  if (!apiKey) {
    throw new GeminiNotConfiguredError();
  }
  const baseUrl = (await getGeminiBaseUrl()) || DEFAULT_GEMINI_BASE_URL;

  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: { maxOutputTokens: MAX_TOKENS_REPLY },
  };
  if (systemParts.length > 0) {
    body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
  }

  let res: Response;
  try {
    res = await sendGeminiRequest(baseUrl, apiKey, body);
  } catch {
    // Сетевой сбой или тайм-аут — один повтор с паузой, не бесконечно.
    await delay(RETRY_ON_UNAVAILABLE_DELAY_MS);
    try {
      res = await sendGeminiRequest(baseUrl, apiKey, body);
    } catch (err2) {
      // Не отдаём сырой AbortError наружу — формулируем по-человечески.
      const isTimeout = err2 instanceof Error && err2.name === "AbortError";
      throw new Error(
        isTimeout
          ? `Gemini API не ответил вовремя (${REQUEST_TIMEOUT_MS / 1000}с) — дважды подряд`
          : `Gemini API — сетевая ошибка: ${err2 instanceof Error ? err2.message : String(err2)}`
      );
    }
  }

  // 503 UNAVAILABLE — временная перегрузка Google, не наша ошибка. Один
  // повтор с паузой, не бесконечный цикл.
  if (res.status === 503) {
    await delay(RETRY_ON_UNAVAILABLE_DELAY_MS);
    res = await sendGeminiRequest(baseUrl, apiKey, body);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Только эти два кода говорят о тарифе/биллинге — остальные не наше
    // дело интерпретировать.
    if (res.status === 429) {
      await recordProviderStatus("gemini", "rate_limited").catch(() => {});
    } else if (res.status === 403) {
      await recordProviderStatus("gemini", "billing_error").catch(() => {});
    }
    throw new Error(`Gemini API ошибка ${res.status}: ${text}`);
  }
  // Успех — тоже статус: если раньше был виден 429/403, карточка billing
  // не должна залипать на старой проблеме.
  await recordProviderStatus("gemini", "ok").catch(() => {});

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    // Реальный расход токенов от самой Gemini — не оценка.
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const content = parts.map((p) => p.text ?? "").join("");
  const usage: TokenUsage | undefined = data.usageMetadata
    ? {
        promptTokens: data.usageMetadata.promptTokenCount ?? 0,
        completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
        totalTokens: data.usageMetadata.totalTokenCount ?? 0,
      }
    : undefined;

  if (data.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    return { content: content + "\n\n*(ответ обрезан лимитом токенов — попроси продолжить)*", usage };
  }
  return { content, usage };
}
