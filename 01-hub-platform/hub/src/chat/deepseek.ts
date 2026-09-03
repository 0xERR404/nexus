import { getDeepSeekKey } from "../keys.js";
import type { TokenUsage } from "./usage.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatReply {
  content: string;
  usage?: TokenUsage;
  // Реально применённая модель (после resolveDeepSeekModel), не то, что
  // прислал клиент — сообщение в истории должно отражать правду.
  model?: string;
}

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

// Модель — свойство сообщения, не темы: тема остаётся одним разговором с
// DeepSeek независимо от того, какая из двух отвечала на сообщение.
// Приходит в теле каждого запроса от клиента (как раньше provider, до
// того как его закрепили за темой).
export const DEEPSEEK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;
export type DeepSeekModel = (typeof DEEPSEEK_MODELS)[number];
export const DEFAULT_DEEPSEEK_MODEL: DeepSeekModel = "deepseek-v4-flash";

function resolveDeepSeekModel(model: string | undefined): DeepSeekModel {
  return (DEEPSEEK_MODELS as readonly string[]).includes(model ?? "")
    ? (model as DeepSeekModel)
    : DEFAULT_DEEPSEEK_MODEL;
}

// Без max_tokens ответы обрывались на полуслове без предупреждения при
// старом лимите 1024. CHAT_MAX_REPLY_TOKENS — переменная окружения,
// подстроить бюджет без правки кода.
const DEFAULT_MAX_TOKENS_REPLY = 4096;
const MAX_TOKENS_REPLY = Number(process.env.CHAT_MAX_REPLY_TOKENS) || DEFAULT_MAX_TOKENS_REPLY;

export class DeepSeekNotConfiguredError extends Error {
  constructor() {
    super("DeepSeek API-ключ не задан — введи его в настройках хаба");
  }
}

// Незнакомая или отсутствующая model — тихо падаем на дефолт, не
// отправляем в API произвольную строку от клиента как есть.
export async function askDeepSeek(messages: ChatMessage[], model?: string): Promise<ChatReply> {
  const apiKey = await getDeepSeekKey();
  if (!apiKey) {
    throw new DeepSeekNotConfiguredError();
  }
  const resolvedModel = resolveDeepSeekModel(model);

  const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: resolvedModel,
      messages,
      max_tokens: MAX_TOKENS_REPLY,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DeepSeek API ошибка ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    // OpenAI-совместимый формат — реальный расход токенов в каждом ответе.
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const finishReason = data.choices?.[0]?.finish_reason;
  const usage: TokenUsage | undefined = data.usage
    ? {
        promptTokens: data.usage.prompt_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? 0,
        totalTokens: data.usage.total_tokens ?? 0,
      }
    : undefined;

  if (finishReason === "length") {
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

// ЧЕСТНАЯ ОГОВОРКА: формат — по документированному эндпоинту DeepSeek
// (GET /user/balance), живым запросом не проверено (сеть недоступна из
// среды сборки). Сверить поля при подключении на реальном сервере.
export async function getDeepSeekBalance(): Promise<DeepSeekBalanceResult> {
  const apiKey = await getDeepSeekKey();
  if (!apiKey) {
    return { configured: false };
  }

  try {
    const res = await fetch(`${DEEPSEEK_BASE_URL}/user/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { configured: true, ok: false, error: `DeepSeek API ошибка ${res.status}: ${text}` };
    }
    const data = (await res.json()) as {
      is_available?: boolean;
      balance_infos?: { currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }[];
    };
    const balances: DeepSeekBalance[] = (data.balance_infos ?? []).map((b) => ({
      currency: b.currency,
      totalBalance: b.total_balance,
      grantedBalance: b.granted_balance,
      toppedUpBalance: b.topped_up_balance,
    }));
    return { configured: true, ok: true, balances };
  } catch (err) {
    return { configured: true, ok: false, error: String(err) };
  }
}
