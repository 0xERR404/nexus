import { getMessages } from "./storage.js";
import { estimateTokens } from "./tokens.js";

export interface ContextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Голый чат — без персонажа, без памяти, без сжатия истории (см. README).
// Что не влезло в контекст — просто не идёт в запрос, без умного сжатия.
//
// Режем по оценке токенов, не по числу сообщений (было — фиксированные
// 40, но это могло раздуться до сотен тысяч токенов на длинных сообщениях).
//
// CHAT_MAX_CONTEXT_TOKENS — переменная окружения, подстроить бюджет без правки кода.
const DEFAULT_MAX_CONTEXT_TOKENS = 6000;
const MAX_CONTEXT_TOKENS = Number(process.env.CHAT_MAX_CONTEXT_TOKENS) || DEFAULT_MAX_CONTEXT_TOKENS;

// Предохранитель — не читаем с диска больше, даже если сообщения короткие.
const MAX_MESSAGE_COUNT = 200;

export async function buildContext(topicId: string): Promise<ContextMessage[]> {
  const messages = await getMessages(topicId, MAX_MESSAGE_COUNT);

  const selected: ContextMessage[] = [];
  let usedTokens = 0;

  // Идём от новых к старым, останавливаемся, как только сообщение не
  // влезает. Самое новое попадает всегда, даже если само больше бюджета.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const t = estimateTokens(m.content);
    if (selected.length > 0 && usedTokens + t > MAX_CONTEXT_TOKENS) {
      break;
    }
    selected.unshift({ role: m.role, content: m.content });
    usedTokens += t;
  }

  return selected;
}
