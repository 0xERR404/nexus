import {fail} from './store.mjs';
import {normalizeUsage} from '../../src/ai-usage.mjs';
const base = 'https://api.deepseek.com';
const errors = {
  401: 'DeepSeek отклонил ключ. Проверь его в настройках.',
  402: 'Недостаточно средств на счёте DeepSeek.',
  429: 'Лимит DeepSeek. Повтори немного позже.',
  400: 'DeepSeek отклонил параметры запроса.',
  422: 'DeepSeek отклонил параметры запроса.'
};
export async function checkKey(key, fetcher = fetch) {
  if (!key) fail('Сначала сохрани API-ключ.');
  const response = await fetcher(base + '/models', {
    headers: {Authorization: 'Bearer ' + key},
    redirect: 'error',
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    await response.body?.cancel();
    fail(errors[response.status] ?? 'DeepSeek сейчас недоступен.', 502);
  }
  const data = await response.json();
  const available = [
    ...new Set(
      (Array.isArray(data.data) ? data.data : [])
        .map((m) => m.id)
        .filter((id) => typeof id === 'string' && /^deepseek-[a-z0-9-]{1,64}$/.test(id))
    )
  ].slice(0, 32);
  if (!available.length) fail('DeepSeek не вернул доступных моделей.', 502);
  return {ok: true, models: available};
}
export async function complete({
  key,
  model,
  thinking,
  maxTokens,
  messages,
  signal,
  onDelta,
  onUsage = () => {},
  fetcher = fetch
}) {
  const response = await fetcher(base + '/chat/completions', {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'},
    body: JSON.stringify({
      model,
      messages,
      thinking: {type: thinking ? 'enabled' : 'disabled'},
      max_tokens: maxTokens,
      stream: true,
      stream_options: {include_usage: true}
    })
  });
  if (!response.ok) {
    await response.body?.cancel();
    fail(errors[response.status] ?? 'DeepSeek сейчас недоступен. Повтори позже.', 502);
  }
  if (!response.body) fail('Пустой ответ DeepSeek.', 502);
  const decoder = new TextDecoder();
  let buffer = '',
    content = '',
    usage = null,
    finish = '',
    done = false,
    total = 0;
  const reader = response.body.getReader();
  const line = (value) => {
    if (!value.startsWith('data:')) return;
    const raw = value.slice(5).trim();
    if (!raw) return;
    if (raw === '[DONE]') {
      done = true;
      return;
    }
    const data = JSON.parse(raw);
    if (data.error) fail('Ошибка потока DeepSeek.', 502);
    if (data.usage) {
      const received = normalizeUsage(data.usage);
      if (received) {
        usage = received;
        onUsage(usage);
      }
    }
    const choice = data.choices?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;
    const chunk = choice?.delta?.content;
    if (typeof chunk === 'string' && chunk) {
      content += chunk;
      if (content.length > 500000) fail('Ответ превысил допустимый размер.', 502);
      onDelta(chunk);
    }
  };
  try {
    while (!done) {
      const {value, done: end} = await reader.read();
      if (end) break;
      total += value.length;
      if (total > 8 * 1024 * 1024) fail('Ответ превысил допустимый размер.', 502);
      buffer += decoder.decode(value, {stream: true});
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
        if (done) break;
      }
      if (buffer.length > 1024 * 1024) fail('Некорректный поток DeepSeek.', 502);
    }
    if (!done) {
      buffer += decoder.decode();
      if (buffer.trim()) line(buffer.trim());
    }
    if (!done || !finish) fail('Соединение с DeepSeek оборвалось.', 502);
    if (!content.trim())
      fail(
        finish === 'length'
          ? 'Лимита ответа не хватило. Увеличь его в настройках.'
          : 'DeepSeek вернул пустой ответ.',
        502
      );
    return {
      content,
      usage,
      notice:
        finish === 'length'
          ? 'Достигнут лимит ответа. Можно попросить продолжить.'
          : finish === 'stop'
            ? ''
            : 'Ответ завершён досрочно.'
    };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
