import fs from 'node:fs';
import path from 'node:path';
import {modulePage} from '../../src/views.mjs';
import {body} from '../../src/server.mjs';
import {ChatStore, fail} from './store.mjs';
import {complete, checkKey} from './deepseek.mjs';
import {FlowSession} from './flow-session.mjs';
import {FlowAudio} from './flow-audio.mjs';
import {generate} from './flowmusic.mjs';
const assets = new Map(
  ['chat.css', 'chat.js'].map((name) => [
    '/' + name,
    fs.readFileSync(new URL(name, import.meta.url))
  ])
);
const include =
  '<link rel="stylesheet" href="/modules/chat/chat.css"><script src="/modules/chat/chat.js" defer></script>';
const status =
  '<p id="chatStatus" class="chat-status" role="status" aria-live="polite">Загрузка…</p>';
const modelOptions =
  '<option value="deepseek-flash">Flash</option><option value="deepseek-v4-pro">Pro</option>';
const closeButton =
  '<button type="button" class="dialog-close" data-chat-close aria-label="Закрыть">×</button>';
const content = `${include}<div id="chatPage">${status}<div class="chat-toolbar"><select id="chatProvider" aria-label="Сервис"><option value="deepseek">DeepSeek</option><option value="flowmusic">FlowMusic</option></select><select id="chatModel" aria-label="Модель DeepSeek">${modelOptions}</select><select id="chatTopics" aria-label="Название чата"></select><button id="chatNew" type="button" class="chat-icon" aria-label="Новый чат" title="Новый чат"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button><button id="chatRename" type="button" class="chat-icon" aria-label="Переименовать чат" title="Переименовать чат"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z"/></svg></button><button id="chatDelete" type="button" class="chat-icon" aria-label="Удалить чат" title="Удалить чат"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></svg></button></div><dialog id="flowCreditDialog" aria-labelledby="flowCreditTitle"><div class="chat-title"><h2 id="flowCreditTitle">Кредиты FlowMusic</h2><button id="flowCreditClose" class="dialog-close" aria-label="Закрыть">×</button></div><p id="flowCreditStatus"></p><div id="flowCreditHistory"></div><p class="chat-hint">Изменение остатка включает действия вне хаба. Это не счёт за отдельную генерацию.</p></dialog><button id="chatOlder" type="button" hidden>Ранее</button><div id="chatMessages" aria-live="off"></div><form id="chatComposer"><label class="sr-only" for="chatInput">Сообщение</label><textarea id="chatInput" rows="5" maxlength="32000" placeholder="Напиши сообщение…" required></textarea><div class="chat-actions"><label class="chat-file chat-icon" for="chatFile" title="Прикрепить файл"><span class="sr-only">Прикрепить файл</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2M6 15l9-9"/></svg><input id="chatFile" type="file" accept=".txt,.md,.js,.mjs,.json,.csv,.log,.sh,.html,.css,.yaml,.yml,.ts,.py" class="sr-only"></label><span class="chat-hint">Enter — отправить · Shift+Enter — строка</span><button id="chatStop" type="button" hidden>Стоп</button><button id="chatSend" type="submit" class="chat-icon" aria-label="Отправить" title="Отправить"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 18-7-7 18-3-8-8-3ZM11 13 21 3"/></svg></button></div><div class="chat-meta"><span id="chatUsage"></span><button id="flowCredits" type="button" hidden>Кредиты · —</button></div></form><dialog id="chatDialog" aria-labelledby="chatDialogTitle"><form id="chatDialogForm"><div class="chat-title"><h2 id="chatDialogTitle"></h2>${closeButton}</div><label id="chatTitleLabel" for="chatTitle">Название<input id="chatTitle" maxlength="100" required autocomplete="off"></label><p id="chatDialogText"></p><p id="chatDialogError" class="chat-error" role="alert"></p><div class="chat-actions chat-end"><button type="button" data-chat-close id="chatCancel">Отмена</button><button type="submit" id="chatConfirm">Сохранить</button></div></form></dialog></div>`;
export const settings = {
  title: 'ИИ',
  content: `${include}<div id="chatSettings">${status}<section class="chat-panel"><div class="chat-title"><h2>DeepSeek</h2><span id="chatKeyState"></span></div><form id="chatKeyForm"><label for="chatKey">API-ключ<input id="chatKey" type="password" autocomplete="new-password" maxlength="512" placeholder="Новый ключ"></label><div class="chat-settings-grid"><label for="chatDefaultModel">Модель по умолчанию<select id="chatDefaultModel">${modelOptions}</select></label><label for="chatMaxTokens">Лимит ответа<select id="chatMaxTokens"><option value="4096">4 096 токенов</option><option value="8192">8 192 токенов</option><option value="16384">16 384 токена</option></select></label></div><label class="chat-check"><input type="checkbox" id="chatThinking">Глубокое размышление</label><p class="chat-help">Пустое поле сохраняет прежний ключ. История выбранной темы отправляется в DeepSeek.</p><div class="chat-actions"><button type="submit">Сохранить</button><button type="button" id="chatCheckKey">Проверить</button><button type="button" id="chatRemoveKey" class="chat-danger">Удалить ключ</button></div></form></section><section class="chat-panel"><div class="chat-title"><h2>FlowMusic</h2><span id="flowState"></span></div><form id="flowForm"><label for="flowRefresh">Refresh token<input id="flowRefresh" type="password" autocomplete="new-password" maxlength="16384" required></label><label for="flowAnon">Supabase anon key<input id="flowAnon" type="password" autocomplete="new-password" maxlength="16384" required></label><p class="chat-help">Войди в FlowMusic заново и используй новую сессию. Секреты сохраняются только на сервере. Не используй эту сессию одновременно в других клиентах. Запуск музыки расходует лимит FlowMusic.</p><div class="chat-actions"><button type="submit">Сохранить сессию</button><button type="button" id="flowCheck">Проверить</button><button type="button" id="flowRemove" class="chat-danger">Удалить сессию</button></div></form></section><dialog id="flowDialog" aria-labelledby="flowDialogTitle"><div class="chat-title"><h2 id="flowDialogTitle">Удалить сессию FlowMusic?</h2>${closeButton}</div><p>Переписка и скачанные треки сохранятся.</p><p id="flowError" class="chat-error" role="alert"></p><div class="chat-actions chat-end"><button type="button" data-chat-close autofocus>Отмена</button><button type="button" id="flowDeleteConfirm" class="chat-danger">Удалить</button></div></dialog><dialog id="chatKeyDialog" aria-labelledby="chatKeyDialogTitle"><div class="chat-title"><h2 id="chatKeyDialogTitle">Удалить API-ключ?</h2>${closeButton}</div><p>Новые ответы будут недоступны. Переписка сохранится.</p><p id="chatKeyError" class="chat-error" role="alert"></p><div class="chat-actions chat-end"><button type="button" data-chat-close autofocus>Отмена</button><button type="button" id="chatKeyDeleteConfirm" class="chat-danger">Удалить</button></div></dialog></div>`
};
export function createModule(
  directory = path.join(process.env.DATA_DIR ?? '/app/data', 'chat'),
  {fetcher = fetch, timeout = 180000, flowTimeout = 1200000, flowPoll = 2000} = {}
) {
  let db,
    auth,
    recovered = false;
  const audio = new FlowAudio(directory, fetcher);
  const session = () => (auth ??= new FlowSession(directory, {fetcher}));
  const jobs = new Map();
  const store = () => (db ??= new ChatStore(directory));
  function snapshot(topic, before = 0) {
    return {...store().history(topic, before), requests: store().requests(topic)};
  }
  const errorResponse = (error) =>
    Response.json(
      {error: error.status ? error.message : 'Не удалось выполнить запрос. Повтори позже.'},
      {status: error.status ?? 503}
    );
  function start() {
    if (recovered) return;
    store().recover();
    session().start();
    recovered = true;
  }
  return {
    start,
    close() {
      for (const job of jobs.values()) job.abort();
      auth?.close();
      db?.close();
      db = undefined;
      recovered = false;
    },
    async summary() {
      return {
        state: session().publicConfig().needsLogin
          ? 'warning'
          : store().config().key || session().publicConfig().configured
            ? 'ok'
            : 'warning',
        items: [
          {label: 'Темы', value: String(store().list().length)},
          {label: 'DeepSeek', value: store().config().key ? 'подключён' : 'нет ключа'},
          {
            label: 'FlowMusic',
            value: session().publicConfig().needsLogin
              ? 'нужен вход'
              : session().publicConfig().configured
                ? 'подключён'
                : 'нет сессии'
          }
        ]
      };
    },
    async handle({request, path: route, user, searchParams = new URLSearchParams(), signal}) {
      try {
        start();
        if (['GET', 'HEAD'].includes(request.method)) {
          if (route === '/')
            return new Response(modulePage({username: user.username, title: 'Чат', content}), {
              headers: {'Content-Type': 'text/html; charset=utf-8'}
            });
          if (assets.has(route))
            return new Response(assets.get(route), {
              headers: {'Content-Type': route.endsWith('.css') ? 'text/css' : 'text/javascript'}
            });
          if (route === '/flow/credits') return Response.json(await session().credits());
          if (route === '/config')
            return Response.json({...store().publicConfig(), flowmusic: session().publicConfig()});
          if (route.startsWith('/audio/'))
            return audio.serve(route.slice(7), request, searchParams.has('download'));
          if (route === '/topics') return Response.json({topics: store().list()});
          if (route === '/history')
            return Response.json(
              snapshot(searchParams.get('topic'), Number(searchParams.get('before') ?? 0))
            );
        }
        if (
          request.method !== 'POST' ||
          ![
            '/config',
            '/check',
            '/flow/config',
            '/flow/check',
            '/topic',
            '/send',
            '/retry',
            '/stop'
          ].includes(route)
        )
          return Response.json({error: 'Маршрут не найден.'}, {status: 404});
        if (!request.headers['content-type']?.startsWith('application/json'))
          fail('Ожидается JSON.', 415);
        let data;
        try {
          data = JSON.parse(await body(request, 160000));
        } catch (error) {
          fail(
            error.status === 413 ? 'Слишком большой запрос.' : 'Некорректный JSON.',
            error.status ?? 400
          );
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) fail('Некорректный запрос.');
        if (route === '/config') return Response.json(store().saveConfig(data));
        if (route === '/check') {
          const key = store().config().key;
          const result = await checkKey(key, fetcher);
          return Response.json({ok: true, ...store().saveModels(key, result.models)});
        }
        if (route === '/flow/config') return Response.json(session().save(data));
        if (route === '/flow/check') {
          await session().refresh();
          return Response.json({ok: true, ...session().publicConfig()});
        }
        if (route === '/topic') {
          const ids = data.action === 'delete' ? store().audioIDs(data.id) : [];
          const result = store().change(data);
          audio.remove(ids);
          return Response.json(result);
        }
        if (route === '/stop') {
          jobs.get(data.requestId)?.abort();
          return Response.json({ok: true});
        }
        const config = store().config();
        const provider = store().provider(data, route === '/retry');
        const flow = provider === 'flowmusic';
        if (!flow && !config.key) fail('API-ключ DeepSeek не задан.', 409);
        if (flow && !session().publicConfig().configured) fail('Сессия FlowMusic не задана.', 409);
        const job = store().begin(data, route === '/retry');
        if (job.replay) {
          if (job.status === 'running')
            return Response.json({error: 'Ответ уже создаётся. Обнови тему.'}, {status: 409});
          return Response.json({saved: true, ...snapshot(job.topic)});
        }
        const controller = new AbortController();
        jobs.set(job.id, controller);
        const stop = () => controller.abort();
        signal?.addEventListener('abort', stop, {once: true});
        if (signal?.aborted) stop();
        const timer = setTimeout(() => controller.abort('timeout'), flow ? flowTimeout : timeout);
        const context = store().context(job);
        let partial = '',
          closed = false;
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(stream) {
              const emit = (value) => {
                if (!closed)
                  try {
                    stream.enqueue(encoder.encode(JSON.stringify(value) + '\n'));
                  } catch {
                    closed = true;
                    stop();
                  }
              };
              emit({type: 'start', requestId: job.id, limited: context.limited});
              const heartbeat = setInterval(() => emit({type: 'ping'}), 15000);
              void (async () => {
                try {
                  const result = flow
                    ? await generate({
                        session: session(),
                        audio,
                        job,
                        store: store(),
                        signal: controller.signal,
                        poll: flowPoll,
                        onProgress: (text) => emit({type: 'progress', text}),
                        onReset: (text) => {
                          partial = text;
                          emit({type: 'replace', text});
                        },
                        onDelta: (text) => {
                          partial += text;
                          emit({type: 'delta', text});
                        }
                      })
                    : await complete({
                        ...config,
                        model: job.model,
                        messages: context.messages,
                        signal: controller.signal,
                        fetcher,
                        onUsage: (usage) => store().recordUsage(job, usage),
                        onDelta: (chunk) => {
                          partial += chunk;
                          emit({type: 'delta', text: chunk});
                        }
                      });
                  store().finish(job, result);
                  emit({type: 'done', ...snapshot(job.topic)});
                } catch (error) {
                  const notice = controller.signal.aborted
                    ? controller.signal.reason === 'timeout'
                      ? flow
                        ? 'Ожидание FlowMusic истекло. Повтор продолжит это задание.'
                        : 'DeepSeek не успел ответить. Можно повторить.'
                      : flow
                        ? 'Ожидание остановлено. FlowMusic может продолжать генерацию. Повтор проверит то же задание.'
                        : 'Ответ остановлен.'
                    : error.status
                      ? error.message
                      : flow
                        ? 'Связь с FlowMusic прервана. Повтор проверит сохранённое задание.'
                        : 'Связь с DeepSeek прервана. Можно повторить.';
                  try {
                    store().finish(job, {content: partial, status: 'error', notice});
                    emit({type: 'error', error: notice, ...snapshot(job.topic)});
                  } catch {
                    emit({
                      type: 'error',
                      error: 'Не удалось сохранить ответ. Обнови тему перед повтором.'
                    });
                  }
                } finally {
                  if (flow)
                    void session()
                      .credits(true)
                      .catch(() => {});
                  clearTimeout(timer);
                  clearInterval(heartbeat);
                  jobs.delete(job.id);
                  signal?.removeEventListener('abort', stop);
                  if (!closed) {
                    closed = true;
                    stream.close();
                  }
                }
              })();
            },
            cancel() {
              closed = true;
              stop();
            }
          }),
          {
            headers: {
              'Content-Type': 'application/x-ndjson; charset=utf-8',
              'X-Accel-Buffering': 'no'
            }
          }
        );
      } catch (error) {
        return errorResponse(error);
      }
    }
  };
}
const module = createModule();
export const handle = module.handle;
export const summary = module.summary;

export const start = module.start;
export const close = module.close;
