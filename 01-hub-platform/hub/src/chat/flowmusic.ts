import { getFlowMusicKey, getFlowMusicBaseUrl } from "../keys.js";

// ЧЕСТНАЯ ОГОВОРКА (как в gemini.ts): официальной документации FlowMusic
// API под рукой не было — контракт собран по типовому паттерну REST для
// генерации музыки, не проверен живым запросом. Сверить при появлении
// реальной спецификации.
//
// Базовый URL — настраивается через интерфейс (flowmusicBaseUrl в keys.ts),
// переменная окружения FLOWMUSIC_BASE_URL — запасной вариант, если
// интерфейс не задан.
const DEFAULT_FLOWMUSIC_BASE_URL = "https://api.flowmusic.ai/v1";
const ENV_FLOWMUSIC_BASE_URL = process.env.FLOWMUSIC_BASE_URL;
const FLOWMUSIC_TIMEOUT_MS = 60_000; // генерация музыки медленнее текстового ответа
const RETRY_DELAY_MS = 3_000;

export class FlowMusicNotConfiguredError extends Error {
  constructor() {
    super("FlowMusic API-ключ не задан — введи его в настройках хаба");
  }
}

export interface FlowMusicResult {
  audioUrl: string;
}

function sendFlowMusicRequest(baseUrl: string, apiKey: string, prompt: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FLOWMUSIC_TIMEOUT_MS);
  return fetch(`${baseUrl}/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ prompt }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// FlowMusic генерирует не из истории переписки, а из одного промпта —
// последнего сообщения пользователя.
export async function askFlowMusic(prompt: string): Promise<FlowMusicResult> {
  const apiKey = await getFlowMusicKey();
  if (!apiKey) {
    throw new FlowMusicNotConfiguredError();
  }
  const baseUrl = (await getFlowMusicBaseUrl()) || ENV_FLOWMUSIC_BASE_URL || DEFAULT_FLOWMUSIC_BASE_URL;

  let res: Response;
  try {
    res = await sendFlowMusicRequest(baseUrl, apiKey, prompt);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // Один повтор — одиночный сбой соединения не должен сразу становиться отказом.
      await delay(RETRY_DELAY_MS);
      try {
        res = await sendFlowMusicRequest(baseUrl, apiKey, prompt);
      } catch (err2) {
        if (err2 instanceof Error && err2.name === "AbortError") {
          throw new Error(`FlowMusic API не ответил вовремя (${FLOWMUSIC_TIMEOUT_MS / 1000}с) — дважды подряд`);
        }
        throw err2;
      }
    } else {
      throw err;
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`FlowMusic API ошибка ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { audio_url?: string; url?: string };
  const audioUrl = data.audio_url ?? data.url;
  if (!audioUrl) {
    throw new Error("FlowMusic API не вернул ссылку на аудио");
  }
  return { audioUrl };
}
