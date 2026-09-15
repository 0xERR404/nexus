import { getClaudeKey, getClaudeBaseUrl } from "../keys.js";
import type { ChatMessage, ChatReply } from "./deepseek.js";
import type { TokenUsage } from "./usage.js";

// Базовый URL — настраиваемый (claudeBaseUrl в keys.ts), как у Gemini:
// пусто — прямой Anthropic, задано — свой прокси.
const DEFAULT_CLAUDE_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

// Строка модели — через переменную окружения, модельные линейки меняются
// без предупреждения. max_tokens у Anthropic обязателен (в отличие от
// OpenAI-совместимых API).
const DEFAULT_MODEL = "claude-sonnet-5";
const CLAUDE_MODEL = process.env.CHAT_CLAUDE_MODEL || DEFAULT_MODEL;
const DEFAULT_MAX_TOKENS_REPLY = 4096;
const MAX_TOKENS_REPLY = Number(process.env.CHAT_MAX_REPLY_TOKENS) || DEFAULT_MAX_TOKENS_REPLY;
// Тайм-аут + повтор — та же защита от зависаний прокси, что у gemini.ts.
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 3_000;

export class ClaudeNotConfiguredError extends Error {
  constructor() {
    super("Claude API-ключ не задан — введи его в настройках хаба");
  }
}

function sendClaudeRequest(baseUrl: string, apiKey: string, body: Record<string, unknown>): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ЧЕСТНАЯ ОГОВОРКА: настоящего ключа под рукой не было, полный цикл не
// проверен. Но форма запроса — да: заведомо неверный ключ вернул
// корректный 401 authentication_error (не сетевую ошибку и не 400) —
// эндпоинт/заголовки/тело разобраны сервером как валидные.
export async function askClaude(messages: ChatMessage[]): Promise<ChatReply> {
  const apiKey = await getClaudeKey();
  if (!apiKey) {
    throw new ClaudeNotConfiguredError();
  }
  const baseUrl = (await getClaudeBaseUrl()) || DEFAULT_CLAUDE_BASE_URL;

  // Системный промпт — отдельным полем, не сообщением в истории (как у Gemini).
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const conversation = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  const body: Record<string, unknown> = {
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS_REPLY,
    messages: conversation,
  };
  if (systemParts.length > 0) {
    body.system = systemParts.join("\n\n");
  }

  // Один повтор при сетевом сбое/таймауте или 503 — не бесконечный цикл.
  let res: Response;
  try {
    res = await sendClaudeRequest(baseUrl, apiKey, body);
  } catch {
    await delay(RETRY_DELAY_MS);
    res = await sendClaudeRequest(baseUrl, apiKey, body);
  }
  if (res.status === 503) {
    await delay(RETRY_DELAY_MS);
    res = await sendClaudeRequest(baseUrl, apiKey, body);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Claude API ошибка ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const content = (data.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");

  const usage: TokenUsage | undefined = data.usage
    ? {
        promptTokens: data.usage.input_tokens ?? 0,
        completionTokens: data.usage.output_tokens ?? 0,
        // Anthropic не отдаёт total_tokens отдельно — считаем сами.
        totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
      }
    : undefined;

  if (data.stop_reason === "max_tokens") {
    return { content: content + "\n\n*(ответ обрезан лимитом токенов — попроси продолжить)*", usage };
  }
  return { content, usage };
}

// У Anthropic нет публичного REST-эндпоинта баланса (только веб-консоль),
// как и у Gemini — заглушки нарочно нет, billing показывает это прямо.
