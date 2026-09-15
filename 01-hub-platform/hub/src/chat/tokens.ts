// Не настоящий токенайзер — грубая оценка по длине текста, только чтобы
// решить, сколько последних сообщений влезает в бюджет контекста ДО
// отправки (см. context.ts). Точный расход после ответа — из usage
// самого API (usage.ts).
//
// ~3 символа/токен — консервативная оценка с запасом что для кириллицы
// (проект русский, режется мельче), что для латиницы/кода.
const CHARS_PER_TOKEN_ESTIMATE = 3;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}
