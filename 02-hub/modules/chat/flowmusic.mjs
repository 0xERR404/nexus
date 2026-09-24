import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fail} from './store.mjs';
import {readJSON} from './flow-session.mjs';
export const flowID = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export function clipIDs(part) {
  if (part?.part_kind !== 'tool-return' || !part.content || typeof part.content !== 'object')
    return [];
  const c = part.content;
  return [
    ...new Set(
      [
        c.clip_id,
        c.clip_id_b,
        c.result_clip_id,
        c.result_upload_id,
        ...(Array.isArray(c.stems) ? c.stems.map((s) => s?.clip_id) : [])
      ].filter(flowID)
    )
  ];
}
export async function readEvents(response, onEvent) {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel();
    fail('Неизвестный формат потока FlowMusic.', 502);
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    total = 0,
    event = '',
    id = '',
    data = [],
    ended = false;
  async function line(value) {
    if (!value) {
      if (data.length) {
        let parsed;
        try {
          parsed = JSON.parse(data.join('\n'));
        } catch {
          fail('Повреждённое событие FlowMusic.', 502);
        }
        ended = (await onEvent({event: event || 'message', id, data: parsed})) === false;
      } else if (['complete', 'final'].includes(event))
        ended = (await onEvent({event, id, data: {}})) === false;
      event = '';
      id = '';
      data = [];
    } else if (value.startsWith('event:')) event = value.slice(6).trim();
    else if (value.startsWith('id:')) {
      const valueID = value.slice(3).trim();
      if (valueID.length <= 256 && !/[\x00-\x1f]/.test(valueID)) id = valueID;
    } else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  }
  try {
    while (!ended) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 16 * 1024 * 1024) fail('Поток FlowMusic слишком большой.', 502);
      buffer += decoder.decode(value, {stream: true});
      let i;
      while ((i = buffer.indexOf('\n')) >= 0 && !ended) {
        await line(buffer.slice(0, i).replace(/\r$/, ''));
        buffer = buffer.slice(i + 1);
      }
      if (buffer.length + data.join('\n').length > 1024 * 1024)
        fail('Событие FlowMusic слишком большое.', 502);
    }
    if (!ended) {
      buffer += decoder.decode();
      if (buffer.trim()) await line(buffer.replace(/\r$/, ''));
      await line('');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function generate({
  session,
  audio,
  job,
  store,
  signal,
  onDelta,
  onProgress,
  onReset = () => {},
  poll = 2000
}) {
  const state = JSON.parse(job.state || '{}');
  state.texts ??= {};
  state.clipIds ??= [];
  state.audioIds ??= {};
  const persist = () => store.checkpoint(job, state);
  const content = () =>
    Object.keys(state.texts)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => state.texts[k])
      .join('\n');
  if (state.failed) fail('FlowMusic завершил это задание с ошибкой. Отправь новый запрос.', 409);
  if (!state.jobId) {
    if (state.started)
      fail(
        'Запрос мог быть принят FlowMusic. Проверь его там перед новым запуском; автоматический повтор отключён.',
        409
      );
    onProgress('Запуск генерации…');
    // Refresh до фиксации отправки: сбой авторизации ещё не запускает генерацию.
    await session.token();
    signal.throwIfAborted();
    state.started = true;
    persist();
    const conversationId = store.remote(job.topic);
    const request = {
      parts: [{content: store.context(job).messages.at(-1).content, part_kind: 'user-prompt'}],
      ...(conversationId ? {conversation_id: conversationId} : {}),
      client_context: {
        ...store.flowContext(job.topic),
        selected_model: null,
        lyrics_id_map: {},
        ghostwriter_version: 'standard',
        enable_lyria_agent: false
      },
      model_name: 'producer:standard',
      mode: 'standard'
    };
    let response;
    try {
      response = await session.request('/conversation', {body: request, signal});
    } catch (error) {
      if ([400, 401, 402, 403, 404, 422, 429].includes(error.providerStatus)) {
        state.started = false;
        persist();
      }
      throw error;
    }
    const result = await readJSON(response);
    if (!flowID(result.job_id))
      fail('FlowMusic не вернул job_id. Проверь задание в FlowMusic перед новым запуском.', 502);
    state.jobId = result.job_id;
    persist();
  }
  if (content()) onDelta(content());
  for (let attempt = 0; !state.complete && attempt < 3; attempt++) {
    signal.throwIfAborted();
    onProgress(attempt ? 'Восстановление потока…' : 'FlowMusic создаёт ответ…');
    if (!state.lastId) {
      state.texts = {};
      state.clipIds = [];
      onReset('');
      onProgress('Чтение состояния задания…');
    }
    const stream = await session.request(
      '/messages/' +
        encodeURIComponent(state.jobId) +
        '/stream?last_id=' +
        encodeURIComponent(state.lastId || '0'),
      {signal}
    );
    await readEvents(stream, ({event, id, data}) => {
      if (id && state.lastId === id) return;
      if (event === 'error') {
        state.failed = true;
        persist();
        fail('FlowMusic сообщил об ошибке генерации.', 502);
      }
      if (event === 'conversation_id') {
        if (!flowID(data.id)) fail('Некорректный ID беседы FlowMusic.', 502);
        state.conversationId = data.id;
        store.remote(job.topic, data.id);
      }
      if (event === 'part') {
        const part = data.part;
        if (!Number.isInteger(data.index) || data.index < 0 || data.index > 10000)
          fail('Некорректная часть ответа FlowMusic.', 502);
        const before = content();
        if (part?.part_kind === 'text') {
          if (data.status === 'delta' && typeof data.delta === 'string')
            state.texts[data.index] = (state.texts[data.index] || '') + data.delta;
          else if (typeof part.content === 'string') state.texts[data.index] = part.content;
        }
        state.clipIds = [...new Set([...state.clipIds, ...clipIDs(part)])];
        if (state.clipIds.length > 8 || content().length > 500000)
          fail('Ответ FlowMusic превысил лимит.', 502);
        const after = content();
        if (after !== before) {
          if (after.startsWith(before)) onDelta(after.slice(before.length));
          else onReset(after);
        }
        if (part?.part_kind === 'tool-call') onProgress('Обработка музыки…');
        if (state.clipIds.length) onProgress('Найдено треков: ' + state.clipIds.length);
      }
      if (event === 'complete') state.complete = true;
      if (id) state.lastId = id;
      persist();
      if (state.complete || event === 'final') return false;
    });
    if (!state.complete && attempt < 2) await delay(poll, undefined, {signal});
  }
  if (!state.complete) fail('Поток FlowMusic прерван. Повтор продолжит это задание.', 502);
  if (!state.clipIds.length) {
    if (!content().trim())
      fail('Не удалось распознать результат FlowMusic. Требуется проверить формат ответа.', 502);
    return {content: content(), audio: []};
  }
  const ready = [];
  while (ready.length < state.clipIds.length) {
    signal.throwIfAborted();
    onProgress('Готовим аудио: ' + ready.length + '/' + state.clipIds.length);
    const result = await readJSON(
      await session.request('/clips', {body: {clip_ids: state.clipIds}, signal})
    );
    if (!result.clips || typeof result.clips !== 'object' || Array.isArray(result.clips))
      fail('Неизвестный формат треков FlowMusic.', 502);
    for (const id of state.clipIds) {
      if (ready.some((r) => r.clip === id)) continue;
      const clip = result.clips[id];
      if (!clip) continue;
      if (
        ['failed', 'error', 'cancelled'].includes(clip.status) ||
        ['failed', 'error', 'cancelled'].includes(clip.operation?.status)
      ) {
        state.failed = true;
        persist();
        fail('FlowMusic не смог создать один из треков.', 502);
      }
      if (typeof clip.audio_url !== 'string' || !clip.audio_url) continue;
      state.audioIds[id] ??= randomUUID();
      persist();
      onProgress('Сохраняем трек ' + (ready.length + 1) + '…');
      ready.push({clip: id, audio: await audio.save(clip, state.audioIds[id], signal)});
    }
    if (ready.length < state.clipIds.length) await delay(poll, undefined, {signal});
  }
  return {content: content() || 'Готово.', audio: ready.map((r) => r.audio)};
}
