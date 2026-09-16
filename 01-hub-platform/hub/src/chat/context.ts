import { getMessages } from "./storage.js";

export interface ContextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Голый чат — без персонажа, без памяти, без сжатия истории (см. README).
// Режем по оценке токенов (~3 символа/токен), не по числу сообщений —
// иначе длинные сообщения раздували бы контекст до сотен тысяч токенов.
const CHARS_PER_TOKEN_ESTIMATE = 3;
function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE) : 0;
}

const MAX_CONTEXT_TOKENS = Number(process.env.CHAT_MAX_CONTEXT_TOKENS) || 6000;
const MAX_MESSAGE_COUNT = 200; // предохранитель — не читаем с диска больше

export async function buildContext(topicId: string): Promise<ContextMessage[]> {
  const messages = await getMessages(topicId, MAX_MESSAGE_COUNT);
  const selected: ContextMessage[] = [];
  let usedTokens = 0;

  // От новых к старым, самое новое попадает всегда, даже если больше бюджета.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const t = estimateTokens(m.content);
    if (selected.length > 0 && usedTokens + t > MAX_CONTEXT_TOKENS) break;
    selected.unshift({ role: m.role, content: m.content });
    usedTokens += t;
  }
  return selected;
}
