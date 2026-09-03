import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyFormbody from "@fastify/formbody";
import fastifyMultipart from "@fastify/multipart";
import { mkdir, appendFile, readFile } from "node:fs/promises";
import { createWriteStream, readFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import http from "node:http";
import { ModuleSupervisor } from "./moduleSupervisor.js";
import {
  checkCredentials,
  createSessionToken,
  verifySessionToken,
  renderLoginPage,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
} from "./auth.js";
import { renderDashboard, renderChatPage } from "./dashboard.js";
import { getKeyStatus, setKey, clearKey, getMonitoringAgentToken } from "./keys.js";
import { listTopics, createTopic, deleteTopic, getTopic, getMessages, appendMessage, newMessage } from "./chat/storage.js";
import { buildContext } from "./chat/context.js";
import { askDeepSeek, DeepSeekNotConfiguredError, getDeepSeekBalance } from "./chat/deepseek.js";
import { getProviderStatus } from "./chat/providerStatus.js";
import { getVapidKeys, addSubscription, removeSubscription, sendPushToAll, getSubscriptionCount } from "./push.js";
import { startEventWatcher } from "./eventWatcher.js";
import { askGemini, GeminiNotConfiguredError } from "./chat/gemini.js";
import { askFlowMusic, FlowMusicNotConfiguredError } from "./chat/flowmusic.js";
import { askClaude, ClaudeNotConfiguredError } from "./chat/claude.js";
import { recordUsage, getUsageSummary } from "./chat/usage.js";
import type { TokenUsage } from "./chat/usage.js";
import { callHostBridge, waitForHostBridge } from "./hostBridge.js";

const MODULES_DIR = process.env.MODULES_DIR ?? "/app/modules";
const HUB_DATA_DIR = process.env.HUB_DATA_DIR ?? "/app/data";
const HUB_PORT = 3000;
const DOCKER_NETWORK = process.env.DOCKER_NETWORK ?? "nexus404";
// Токен для /internal/* — модули отдельные контейнеры на той же сети, что
// и Caddy, проверка "127.0.0.1" больше ничего не отличает. Генерируется
// заново при каждом старте, передаётся только модулям хабом самим.
const INTERNAL_TOKEN = crypto.randomBytes(32).toString("hex");
// Общий журнал — тот же файл, куда пишет event_hook.sh (fail2ban/
// unattended-upgrades/cron из базовой настройки), формат JSONL одинаковый.
const EVENTS_LOG = process.env.EVENTS_LOG ?? "/app/hooks/events/events.jsonl";

// trustProxy: true — иначе request.ip показывал бы IP самого Caddy, не
// клиента. Caddy проставляет X-Forwarded-For корректно, сеть между ними
// замкнута внутри docker-сети, снаружи подделать нельзя.
const app = Fastify({ logger: true, trustProxy: true });
await app.register(fastifyCookie);
await app.register(fastifyFormbody);
await app.register(fastifyMultipart, { limits: { fileSize: 20 * 1024 * 1024 } });

// Общий механизм событий — любой код может сказать "вот что-то случилось,
// запиши", без фиксированного списка типов. Пишет в тот же журнал, что и
// bash-хук event_hook.sh.
export async function emitEvent(type: string, details: unknown = {}) {
  const line = JSON.stringify({ type, time: new Date().toISOString(), details }) + "\n";
  try {
    await appendFile(EVENTS_LOG, line);
  } catch (err) {
    app.log.warn({ err }, "не удалось записать событие");
  }
}

const supervisor = new ModuleSupervisor(MODULES_DIR, HUB_PORT, INTERNAL_TOKEN, DOCKER_NETWORK, emitEvent);

// Страница входа закрывает вообще всё, без исключений — единственные
// пути наружу без сессии: GET /login и POST /api/auth/login. /internal/*
// отдельная категория (модуль → хаб), не браузерная сессия.
//
// PWA-статика — осознанное исключение: без открытого доступа установка
// PWA физически не работает (Chrome запрашивает манифест без сессии,
// получал бы редирект на /login вместо JSON).
const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/manifest.json",
  "/sw.js",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/favicon.ico",
  "/offline.html",
]);

app.addHook("preHandler", async (request, reply) => {
  const pathname = request.url.split("?")[0];
  if (PUBLIC_PATHS.has(pathname)) return;
  if (request.url.startsWith("/internal/")) return;
  // Удалённые агенты мониторинга — свой токен внутри модуля, не сессия
  // браузера. Путь named-exact, не префикс — остальные ручки модуля
  // по-прежнему требуют сессию.
  if (pathname === "/modules/monitoring/api/agent/report") return;
  // Тот же принцип для оповещений — тот же агент репортит метрики и события.
  if (pathname === "/modules/notifications/api/agent/report-event") return;

  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!verifySessionToken(token)) {
    if (request.method === "GET") {
      reply.redirect("/login");
    } else {
      reply.code(401);
      reply.send({ error: "не авторизован" });
    }
    return reply;
  }
});

// PWA-статика — раздача файлов. Логика "публично или нет" — в PUBLIC_PATHS выше.
const PUBLIC_DIR = path.join(process.cwd(), "public");
const STATIC_FILES: Record<string, string> = {
  "/manifest.json": "application/manifest+json",
  "/sw.js": "application/javascript",
  "/icon-192.png": "image/png",
  "/icon-512.png": "image/png",
  "/apple-touch-icon.png": "image/png",
  "/offline.html": "text/html",
};
for (const [route, contentType] of Object.entries(STATIC_FILES)) {
  app.get(route, async (request, reply) => {
    try {
      const data = await readFile(path.join(PUBLIC_DIR, route));
      reply.type(contentType);
      return data;
    } catch {
      reply.code(404);
      return { error: "не найдено" };
    }
  });
}

// Браузер сам запрашивает /favicon.ico по умолчанию — отдельного файла под
// это нет, просто отдаём уже существующую иконку по этому пути, чтобы не
// сыпались лишние 404 в консоли.
app.get("/favicon.ico", async (request, reply) => {
  try {
    const data = await readFile(path.join(PUBLIC_DIR, "/icon-192.png"));
    reply.type("image/png");
    return data;
  } catch {
    reply.code(404);
    return { error: "не найдено" };
  }
});

// GET /login — страница входа (публичная, см. PUBLIC_PATHS выше).
app.get("/login", async (request, reply) => {
  reply.type("text/html");
  reply.header("Cache-Control", "no-store, no-cache, must-revalidate");
  reply.header("Pragma", "no-cache");
  return renderLoginPage();
});

// POST /api/auth/login — проверка пароля, выдача сессии подписанной кукой.
app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", async (request, reply) => {
  const password = request.body?.password ?? "";
  // Логин приходит из формы, не подставляется автоматически — проверка
  // должна быть настоящей по обоим полям.
  const username = request.body?.username ?? "";
  const ok = await checkCredentials(username, password);

  if (!ok) {
    // Пароль не логируем даже неудачным — многие переиспользуют пароли,
    // логина и IP достаточно, чтобы понять, что происходит.
    await emitEvent("auth.login_failed", { ip: request.ip, username });
    reply.type("text/html");
    reply.code(401);
    return renderLoginPage("неверный логин или пароль");
  }

  const token = createSessionToken();
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  await emitEvent("auth.login_succeeded", { ip: request.ip, username });
  reply.redirect("/");
});

// POST /api/auth/logout — сброс сессии.
app.post("/api/auth/logout", async (request, reply) => {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  reply.redirect("/login");
});

// Белый список привилегированных действий — расширение только правкой
// кода хаба, не настраивается модулем на лету.
//
// restart_server/run_cleanup исполняются через host-bridge (хаб сам в
// контейнере) — маленький демон на хосте со СВОИМ независимым белым
// списком (двойная защита).
const PRIVILEGED_ACTIONS: Record<string, () => Promise<unknown>> = {
  ping: async () => ({ pong: true, time: new Date().toISOString() }),
  restart_server: async () => callHostBridge("restart_server"),
  run_cleanup: async () => callHostBridge("run_cleanup"),
};

// GET / — главная страница, сетка карточек модулей. Данные — из
// супервизора (GET /modules), карточка чата дорисовывается отдельно на
// клиенте (не Docker-контейнер, супервизор её не знает).
app.get("/", async (request, reply) => {
  reply.type("text/html");
  // Явный запрет кэширования — статус модулей должен приходить свежим.
  reply.header("Cache-Control", "no-store, no-cache, must-revalidate");
  reply.header("Pragma", "no-cache");
  return renderDashboard(process.env.AUTH_USER ?? "user");
});

// GET /chat — обычная защищённая сессией страница, как и всё остальное.
// Ключи провайдеров настраиваются в модуле "AI API", не здесь.
app.get("/chat", async (request, reply) => {
  reply.type("text/html");
  reply.header("Cache-Control", "no-store, no-cache, must-revalidate");
  reply.header("Pragma", "no-cache");
  return renderChatPage(process.env.AUTH_USER ?? "user");
});

// GET/POST /api/settings/keys — значение наружу не отдаётся, только факт
// "задан/не задан". Список полей жёстко определён в keys.ts.
app.get("/api/settings/keys", async () => {
  return getKeyStatus();
});

// Поля, которые можно стереть пустым значением — настраиваемые
// необязательные параметры (geminiBaseUrl и т.п.), не сами ключи.
const CLEARABLE_KEY_FIELDS = new Set(["geminiBaseUrl", "claudeBaseUrl", "flowmusicBaseUrl"]);

app.post<{ Body: Record<string, string> }>("/api/settings/keys", async (request, reply) => {
  const body = request.body ?? {};
  const results: Record<string, boolean> = {};
  for (const [name, value] of Object.entries(body)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) {
      if (!CLEARABLE_KEY_FIELDS.has(name)) continue;
      try {
        await clearKey(name);
        results[name] = true;
      } catch {
        results[name] = false;
      }
      continue;
    }
    try {
      await setKey(name, trimmed);
      results[name] = true;
    } catch {
      results[name] = false;
    }
  }
  await emitEvent("settings.keys_updated", { fields: Object.keys(results) });
  return results;
});

// Публичный VAPID-ключ отдаётся браузеру (для этого он и публичный,
// приватная половина не покидает push.ts). Подписка/отписка — обычные
// сессионные ручки.
app.get("/api/notifications/vapid-public-key", async () => {
  const vapid = await getVapidKeys();
  return { publicKey: vapid.publicKey };
});

app.post<{ Body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } }>(
  "/api/notifications/subscribe",
  async (request, reply) => {
    const { endpoint, keys } = request.body ?? {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      reply.code(400);
      return { error: "некорректная подписка" };
    }
    await addSubscription({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
    return { ok: true };
  }
);

app.post<{ Body: { endpoint?: string } }>("/api/notifications/unsubscribe", async (request, reply) => {
  const endpoint = request.body?.endpoint;
  if (!endpoint) {
    reply.code(400);
    return { error: "endpoint обязателен" };
  }
  await removeSubscription(endpoint);
  return { ok: true };
});

// Чат разложен по ответственности: storage.ts хранит сообщения, context.ts
// собирает контекст, deepseek.ts/gemini.ts/etc — сами вызовы. Здесь только
// маршруты, склеивающие эти части.

// Голый чат — без персонажа, без памяти, без сжатия. Выбор провайдера
// приходит с фронтенда вместе с сообщением.
type Provider = "deepseek" | "gemini" | "flowmusic" | "claude";

// FlowMusic генерирует аудио по промпту (последнее сообщение
// пользователя), не по всей истории. Результат — `!audio(URL)` в тексте,
// тем же принципом, что и картинки `![alt](url)` — фронтенд рендерит
// плеер по маркеру. Токенов нет — usage не возвращается.
//
// model — только для DeepSeek, не свойство темы, приходит заново с
// каждым сообщением; незнакомое значение askDeepSeek тихо заменяет
// дефолтом. Остальные провайдеры параметр игнорируют.
async function getReply(
  context: { role: "system" | "user" | "assistant"; content: string }[],
  provider: Provider,
  model?: string
): Promise<{ content: string; usage?: TokenUsage; model?: string }> {
  if (provider === "gemini") {
    return askGemini(context);
  }
  if (provider === "claude") {
    return askClaude(context);
  }
  if (provider === "flowmusic") {
    const lastUserMessage = [...context].reverse().find((m) => m.role === "user");
    const { audioUrl } = await askFlowMusic(lastUserMessage?.content ?? "");
    return { content: `!audio(${audioUrl})` };
  }
  return askDeepSeek(context, model);
}

app.get("/api/chat/topics", async () => {
  return { topics: await listTopics() };
});

// Расход токенов — реальные числа из ответов провайдеров (usage.ts), не
// оценка. Сегодня / всего / по темам — для счётчика в шапке чата.
app.get("/api/chat/usage", async () => {
  return { usage: await getUsageSummary() };
});

// Вложения — файл сохраняется на диск, в сообщение уходит только короткая ссылка.
app.post<{ Params: { topicId: string } }>("/api/chat/:topicId/attachments", async (request, reply) => {
  const data = await request.file();
  if (!data) {
    reply.code(400);
    return { error: "файл не передан" };
  }
  const topicId = request.params.topicId;
  const safeName = data.filename.replace(/[^\w.\-а-яА-ЯёЁ]/g, "_");
  const id = crypto.randomUUID();
  const dir = path.join(HUB_DATA_DIR, "chat", "attachments", topicId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${id}-${safeName}`);
  await pipeline(data.file, createWriteStream(filePath));

  return { id, filename: data.filename, url: `/api/chat/${topicId}/attachments/${id}-${encodeURIComponent(safeName)}` };
});

app.get<{ Params: { topicId: string; filename: string } }>(
  "/api/chat/:topicId/attachments/:filename",
  async (request, reply) => {
    const filePath = path.join(HUB_DATA_DIR, "chat", "attachments", request.params.topicId, request.params.filename);
    try {
      const data = await readFile(filePath);
      reply.header("Content-Disposition", `inline; filename="${request.params.filename}"`);
      return data;
    } catch {
      reply.code(404);
      return { error: "не найдено" };
    }
  }
);

app.post<{ Body: { title?: string; provider?: Provider } }>("/api/chat/topics", async (request) => {
  const requestedProvider = request.body?.provider;
  const provider: Provider =
    requestedProvider === "gemini"
      ? "gemini"
      : requestedProvider === "flowmusic"
        ? "flowmusic"
        : requestedProvider === "claude"
          ? "claude"
          : "deepseek";
  return createTopic(request.body?.title ?? "Новый разговор", provider);
});

app.delete<{ Params: { topicId: string } }>("/api/chat/topics/:topicId", async (request, reply) => {
  const deleted = await deleteTopic(request.params.topicId);
  if (!deleted) {
    reply.code(404);
    return { error: "тема не найдена" };
  }
  return { ok: true };
});

app.get<{ Params: { topicId: string } }>("/api/chat/:topicId/messages", async (request) => {
  return { messages: await getMessages(request.params.topicId, 50) };
});

app.post<{ Params: { topicId: string }; Body: { content?: string; model?: string } }>(
  "/api/chat/:topicId/messages",
  async (request, reply) => {
    const content = request.body?.content?.trim();
    if (!content) {
      reply.code(400);
      return { error: "пустое сообщение" };
    }

    const topicId = request.params.topicId;
    // Модель, отвечающая в теме, — свойство темы (закреплено при
    // создании), не выбор на каждое сообщение. Провайдер клиент прислать
    // уже не может — источник истины один, сама тема на сервере.
    //
    // model — другое дело: выбор конкретной модели ВНУТРИ уже
    // закреплённого DeepSeek (flash/pro), приходит с каждым сообщением —
    // смена модели не должна разделять историю на разные темы.
    const topic = await getTopic(topicId);
    if (!topic) {
      reply.code(404);
      return { error: "тема не найдена" };
    }
    const provider: Provider = topic.provider;
    const model = request.body?.model;

    const userMessage = newMessage("user", content);
    await appendMessage(topicId, userMessage);

    try {
      const context = await buildContext(topicId);
      const { content: replyContent, usage, model: resolvedModel } = await getReply(context, provider, model);
      const assistantMessage = newMessage("assistant", replyContent, provider, usage, resolvedModel);
      await appendMessage(topicId, assistantMessage);
      // Реальный расход — в отдельный журнал, не блокирует ответ пользователю.
      if (usage) {
        await recordUsage(topicId, provider, usage).catch((err) => {
          app.log.error({ err }, "не удалось записать расход токенов");
        });
      }
      return { userMessage, assistantMessage };
    } catch (err) {
      if (
        err instanceof DeepSeekNotConfiguredError ||
        err instanceof GeminiNotConfiguredError ||
        err instanceof FlowMusicNotConfiguredError ||
        err instanceof ClaudeNotConfiguredError
      ) {
        reply.code(400);
        return { userMessage, error: err.message };
      }
      app.log.error({ err }, `ошибка вызова ${provider}`);
      reply.code(502);
      // Реальный текст ошибки — личный хаб на одного человека, прятать
      // технические детали от самого себя смысла нет, зато проще
      // отлаживать интеграции (свой прокси для Gemini и т.п.).
      const details = err instanceof Error ? err.message : String(err);
      return { userMessage, error: "не удалось получить ответ от модели", details };
    }
  }
);

// GET /health — требует сессию, как и всё остальное (не для внешнего
// автоматического мониторинга, для этого нужен отдельный токен).
//
// version — читается из package.json при старте, не захардкожена строкой.
const HUB_VERSION: string = (() => {
  try {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(dirname, "..", "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

app.get("/health", async () => {
  return {
    status: "ok",
    version: HUB_VERSION,
    uptime_seconds: Math.floor(process.uptime()),
  };
});

// GET /modules — реальный статус от супервизора (не список папок):
// работает/перезапускается/сломан, pid, число неудач подряд.
app.get("/modules", async () => {
  return { modules: supervisor.getStatus() };
});

// GET/POST /modules/:name/* — прокси к контейнеру модуля. Настоящий URL
// для каждого модуля — кнопка "назад" работает сама, без специального
// JS, это обычная навигация браузера.
//
// Хаб решает, к какому контейнеру стучаться (через getModuleTarget) — не
// доверяет имени из URL напрямую, только известным модулям.
app.all("/modules/:name/*", async (request, reply) => {
  const { name } = request.params as { name: string };
  const wildcard = (request.params as { "*": string })["*"] ?? "";
  const target = supervisor.getModuleTarget(name);
  if (!target) {
    reply.code(404);
    return { error: `модуль '${name}' не найден` };
  }

  const targetPath = `/${wildcard}${request.url.includes("?") ? "?" + request.url.split("?")[1] : ""}`;

  // content-length/host/connection не пересылаем как есть — тело
  // пересобирается сами (другая длина в байтах), host свой.
  const forwardedHeaders: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === "content-length" || lower === "host" || lower === "connection") continue;
    forwardedHeaders[key] = value;
  }
  forwardedHeaders.host = `${target.host}:${target.port}`;

  await new Promise<void>((resolve) => {
    const proxyReq = http.request(
      {
        host: target.host,
        port: target.port,
        path: targetPath,
        method: request.method,
        headers: forwardedHeaders,
        timeout: 10000,
      },
      (proxyRes) => {
        reply.code(proxyRes.statusCode ?? 502);
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value === undefined) continue;
          // Не пересылаем — Fastify сам пересчитывает длину/кодирование в reply.send().
          if (key.toLowerCase() === "content-length" || key.toLowerCase() === "transfer-encoding") continue;
          reply.header(key, value);
        }
        // Страница модуля не должна кэшироваться, как / и /login.
        reply.header("Cache-Control", "no-store, no-cache, must-revalidate");
        reply.send(proxyRes);
        resolve();
      }
    );
    proxyReq.on("error", (err) => {
      reply.code(502);
      reply.send({ error: `модуль '${name}' недоступен`, details: String(err) });
      resolve();
    });
    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      reply.code(504);
      reply.send({ error: `модуль '${name}' не ответил вовремя` });
      resolve();
    });
    if (request.body) {
      proxyReq.end(typeof request.body === "string" ? request.body : JSON.stringify(request.body));
    } else {
      proxyReq.end();
    }
  });
});

// POST /internal/privileged/:action — единственная дверь к привилегированным
// действиям. Токен хаб генерирует заново при каждом старте, передаёт
// только модулям, которых сам запускает — снаружи неоткуда взять.
app.post<{ Params: { action: string } }>("/internal/privileged/:action", async (request, reply) => {
  const token = request.headers["x-internal-token"];
  if (token !== INTERNAL_TOKEN) {
    reply.code(403);
    return { error: "доступно только модулям хаба" };
  }

  const action = request.params.action;
  const handler = PRIVILEGED_ACTIONS[action];
  if (!handler) {
    reply.code(403);
    return { error: `действие '${action}' не в белом списке` };
  }

  await emitEvent("privileged.action.executed", { action });
  return handler();
});

// GET /internal/module-state/:name — любой модуль может спросить состояние
// другого через хаб. Конвенция: модуль может реализовать GET /state,
// хаб просто проксирует, не проверяет формат. Та же авторизация токеном.
app.get<{ Params: { name: string } }>("/internal/module-state/:name", async (request, reply) => {
  const token = request.headers["x-internal-token"];
  if (token !== INTERNAL_TOKEN) {
    reply.code(403);
    return { error: "доступно только модулям хаба" };
  }

  const target = supervisor.getModuleTarget(request.params.name);
  if (!target) {
    reply.code(404);
    return { error: `модуль '${request.params.name}' не найден` };
  }

  return new Promise((resolve) => {
    const req = http.request(
      { host: target.host, port: target.port, path: "/state", method: "GET", timeout: 3000 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          reply.code(res.statusCode ?? 502);
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ error: "модуль вернул не-JSON ответ" });
          }
        });
      }
    );
    req.on("error", () => {
      reply.code(502);
      resolve({ error: `модуль '${request.params.name}' не реализует /state или недоступен` });
    });
    req.on("timeout", () => {
      req.destroy();
      reply.code(504);
      resolve({ error: `модуль '${request.params.name}' не ответил вовремя` });
    });
    req.end();
  });
});

// GET /internal/monitoring-token — модуль спрашивает токен агентов при
// каждой проверке (не хранит копию), смена в интерфейсе действует сразу.
app.get("/internal/monitoring-token", async (request, reply) => {
  const token = request.headers["x-internal-token"];
  if (token !== INTERNAL_TOKEN) {
    reply.code(403);
    return { error: "доступно только модулям хаба" };
  }
  return { token: (await getMonitoringAgentToken()) ?? null };
});

// GET /internal/chat-usage — расход токенов чата, реальные числа из
// usage.ts. Единственный потребитель — модуль billing.
app.get("/internal/chat-usage", async (request, reply) => {
  const token = request.headers["x-internal-token"];
  if (token !== INTERNAL_TOKEN) {
    reply.code(403);
    return { error: "доступно только модулям хаба" };
  }
  return { usage: await getUsageSummary() };
});

// GET /internal/provider-balance/deepseek — баланс через тот же ключ,
// что у чата, сам ключ модулю не передаётся. У Gemini/Claude/FlowMusic
// такого API нет вообще — честно показываем ограничение, не изображаем.
//
// Для Gemini есть другое — /internal/provider-status/gemini ниже:
// последний реально увиденный статус по факту запросов, не баланс.
app.get("/internal/provider-balance/deepseek", async (request, reply) => {
  const token = request.headers["x-internal-token"];
  if (token !== INTERNAL_TOKEN) {
    reply.code(403);
    return { error: "доступно только модулям хаба" };
  }
  return await getDeepSeekBalance();
});

app.get("/internal/provider-status/gemini", async (request, reply) => {
  const token = request.headers["x-internal-token"];
  if (token !== INTERNAL_TOKEN) {
    reply.code(403);
    return { error: "доступно только модулям хаба" };
  }
  const status = await getProviderStatus("gemini");
  return { status: status ?? null };
});

// GET /internal/recent-events — последние записи журнала для модуля
// notifications. Хаб уже читает/пишет этот файл напрямую.
//
// Журнал смешанный: bash-хук пишет details строкой, хаб (emitEvent) —
// объектом. Модуль сам разбирается, тут — сырые строки без нормализации.
app.get("/internal/recent-events", async (request, reply) => {
  const token = request.headers["x-internal-token"];
  if (token !== INTERNAL_TOKEN) {
    reply.code(403);
    return { error: "доступно только модулям хаба" };
  }
  const query = request.query as { limit?: string };
  const limit = Math.min(500, Math.max(1, Number(query?.limit) || 200));

  let events: unknown[] = [];
  try {
    const raw = await readFile(EVENTS_LOG, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    events = lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null; // повреждённая строка — пропускаем, не роняем весь список
        }
      })
      .filter((e) => e !== null)
      .reverse(); // самые новые первыми
  } catch {
    // журнала ещё нет — событий пока не было, отдаём пустой список, не ошибку
  }
  return { events };
});

// POST /internal/send-push — модуль (notifications) просит хаб разослать
// push для событий из ДРУГИХ источников (удалённый агент), которых нет
// в локальном EVENTS_LOG (тот хаб уже обрабатывает сам, см. eventWatcher.ts).
app.post<{ Body: { title?: string; body?: string; tag?: string } }>("/internal/send-push", async (request, reply) => {
  const token = request.headers["x-internal-token"];
  if (token !== INTERNAL_TOKEN) {
    reply.code(403);
    return { error: "доступно только модулям хаба" };
  }
  const { title, body, tag } = request.body ?? {};
  if (!title || !body) {
    reply.code(400);
    return { error: "title и body обязательны" };
  }
  await sendPushToAll({ title, body, tag }).catch(() => {});
  return { ok: true };
});

// GET /internal/push-subscription-count — для мини-карточки notifications.
// Сами подписки наружу не отдаются, только число.
app.get("/internal/push-subscription-count", async (request, reply) => {
  const token = request.headers["x-internal-token"];
  if (token !== INTERNAL_TOKEN) {
    reply.code(403);
    return { error: "доступно только модулям хаба" };
  }
  return { count: await getSubscriptionCount() };
});

const start = async () => {
  await mkdir(HUB_DATA_DIR, { recursive: true }).catch(() => {});
  await mkdir(MODULES_DIR, { recursive: true }).catch(() => {});
  await mkdir(path.dirname(EVENTS_LOG), { recursive: true }).catch(() => {});
  await emitEvent("hub.started", { pid: process.pid });

  try {
    await app.listen({ port: HUB_PORT, host: "0.0.0.0" });

    // Наблюдатель за событиями — не зависит от host-bridge, читает свой
    // локальный EVENTS_LOG. Запускаем сразу, до ожидания моста ниже.
    startEventWatcher();

    // Ждём, пока host-bridge реально ответит, ПЕРЕД тем как супервизор
    // начнёт поднимать модули — иначе при перезагрузке сервера велик шанс
    // поймать гонку и потерять модули без ручного вмешательства (см.
    // hostBridge.ts). Хаб уже слушает порт — пауза не блокирует ничего,
    // кроме запуска модулей.
    const bridgeReady = await waitForHostBridge();
    if (!bridgeReady) {
      app.log.error(
        "host-bridge не ответил за отведённое время — модули не будут запущены автоматически, " +
          "проверь `systemctl status nexus404-host-bridge` на хосте"
      );
      await emitEvent("hub.host_bridge_not_ready", {});
    }
    supervisor.start();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

process.on("SIGTERM", async () => {
  await emitEvent("hub.stopping", { reason: "SIGTERM" });
  await app.close();
  process.exit(0);
});

// Подстраховка на уровне процесса — если где-то забудется обработчик,
// хаб залогирует и продолжит жить, не рухнет молча.
process.on("uncaughtException", (err) => {
  app.log.error({ err }, "непойманное исключение — хаб продолжает работать");
});
process.on("unhandledRejection", (reason) => {
  app.log.error({ reason }, "необработанный отказ промиса — хаб продолжает работать");
});

start();
