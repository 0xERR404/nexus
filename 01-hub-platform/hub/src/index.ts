import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyFormbody from "@fastify/formbody";
import fastifyMultipart from "@fastify/multipart";
import { mkdir, appendFile, readFile, writeFile, stat, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
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
import { getKeyStatus, setKey, clearKey, getMonitoringAgentToken, getSteamApiKey, getSteamId, getRaUsername, getRaApiKey } from "./keys.js";
import { listTopics, createTopic, deleteTopic, getTopic, getMessages, appendMessage, newMessage, setTopicFlowMusicProjectId, removeAttachmentFromMessage } from "./chat/storage.js";
import { buildContext } from "./chat/context.js";
import { askDeepSeek, DeepSeekNotConfiguredError, getDeepSeekBalance, getProviderStatus, askGemini, GeminiNotConfiguredError, askFlowMusic, getFlowMusicBalance, FlowMusicNotConfiguredError, askClaude, ClaudeNotConfiguredError } from "./chat/providers.js";
import { getVapidKeys, addSubscription, removeSubscription, sendPushToAll, getSubscriptionCount } from "./push.js";
import { startEventWatcher } from "./eventWatcher.js";
import { recordUsage, getUsageSummary } from "./chat/usage.js";
import type { TokenUsage } from "./chat/usage.js";
import { callHostBridge, waitForHostBridge } from "./hostBridge.js";
import { withFileLock } from "./fileLock.js";

const MODULES_DIR = process.env.MODULES_DIR ?? "/app/modules";
const HUB_DATA_DIR = process.env.HUB_DATA_DIR ?? "/app/data";
const HUB_PORT = 3000;
const DOCKER_NETWORK = process.env.DOCKER_NETWORK ?? "nexus404";
// Токен для /internal/* — генерируется заново при каждом старте, передаётся
// только модулям, которых сам хаб запускает.
const INTERNAL_TOKEN = crypto.randomBytes(32).toString("hex");
const EVENTS_LOG = process.env.EVENTS_LOG ?? "/app/hooks/events/events.jsonl";

// trustProxy — иначе request.ip показывал бы IP Caddy, не клиента.
const app = Fastify({ logger: true, trustProxy: true });
await app.register(fastifyCookie);
await app.register(fastifyFormbody);
await app.register(fastifyMultipart, { limits: { fileSize: 20 * 1024 * 1024 } });

// Общий журнал событий — тот же файл, куда пишет bash-хук event_hook.sh.
export async function emitEvent(type: string, details: unknown = {}) {
  const line = JSON.stringify({ type, time: new Date().toISOString(), details }) + "\n";
  try {
    await appendFile(EVENTS_LOG, line);
  } catch (err) {
    app.log.warn({ err }, "не удалось записать событие");
  }
}

const supervisor = new ModuleSupervisor(MODULES_DIR, HUB_PORT, INTERNAL_TOKEN, DOCKER_NETWORK, emitEvent);

// Страница входа закрывает всё без исключений; PWA-статика — осознанное
// исключение (иначе установка PWA не работает без сессии).
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

  // /internal/* — модуль → хаб, не браузерная сессия. Токен-проверка тут
  // же, одним местом, вместо повтора в каждом /internal/* маршруте.
  if (pathname.startsWith("/internal/")) {
    if (request.headers["x-internal-token"] !== INTERNAL_TOKEN) {
      reply.code(403);
      reply.send({ error: "доступно только модулям хаба" });
      return reply;
    }
    return;
  }
  // Удалённые агенты мониторинга/оповещений — свой токен внутри модуля,
  // не сессия браузера. Путь named-exact, остальные ручки модуля — сессия.
  if (pathname === "/modules/monitoring/api/agent/report") return;
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

app.get("/login", async (request, reply) => {
  reply.type("text/html");
  reply.header("Cache-Control", "no-store, no-cache, must-revalidate");
  reply.header("Pragma", "no-cache");
  return renderLoginPage();
});

app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", async (request, reply) => {
  const password = request.body?.password ?? "";
  const username = request.body?.username ?? "";
  const ok = await checkCredentials(username, password);

  if (!ok) {
    // Пароль не логируем даже неудачным — многие переиспользуют пароли.
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

app.post("/api/auth/logout", async (request, reply) => {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  reply.redirect("/login");
});

// Белый список привилегированных действий — расширение только правкой
// кода хаба. restart_server/run_cleanup идут через host-bridge — у него
// свой независимый белый список (двойная защита).
const PRIVILEGED_ACTIONS: Record<string, () => Promise<unknown>> = {
  ping: async () => ({ pong: true, time: new Date().toISOString() }),
  restart_server: async () => callHostBridge("restart_server"),
  run_cleanup: async () => callHostBridge("run_cleanup"),
};

app.get("/", async (request, reply) => {
  reply.type("text/html");
  reply.header("Cache-Control", "no-store, no-cache, must-revalidate");
  reply.header("Pragma", "no-cache");
  return renderDashboard(process.env.AUTH_USER ?? "user");
});

app.get("/chat", async (request, reply) => {
  reply.type("text/html");
  reply.header("Cache-Control", "no-store, no-cache, must-revalidate");
  reply.header("Pragma", "no-cache");
  return renderChatPage(process.env.AUTH_USER ?? "user");
});

app.get("/api/settings/keys", async () => {
  return getKeyStatus();
});

// Настраиваемые необязательные поля можно стереть пустым значением
// (не сами ключи).
const CLEARABLE_KEY_FIELDS = new Set(["geminiBaseUrl", "claudeBaseUrl", "flowmusicBaseUrl", "steamId"]);

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

// Чат разложен по ответственности: chat/storage.ts хранит сообщения,
// chat/context.ts собирает контекст, chat/providers.ts — сами вызовы API.
// Здесь только маршруты, склеивающие эти части.

// Голый чат — без персонажа, без памяти, без сжатия. Провайдер и model
// (только для DeepSeek) приходят с фронтенда вместе с сообщением; FlowMusic
// генерирует аудио по последнему сообщению, результат — `!audio(URL)` в
// тексте (тем же принципом, что и `![alt](url)` для картинок).
type Provider = "deepseek" | "gemini" | "flowmusic" | "claude";

async function getReply(
  context: { role: "system" | "user" | "assistant"; content: string }[],
  provider: Provider,
  model: string | undefined,
  topicId: string
): Promise<{ content: string; usage?: TokenUsage; model?: string }> {
  if (provider === "gemini") {
    return askGemini(context);
  }
  if (provider === "claude") {
    return askClaude(context);
  }
  if (provider === "flowmusic") {
    const lastUserMessage = [...context].reverse().find((m) => m.role === "user");
    // Мьютекс по теме — защита от гонки (два клика/вкладки одновременно):
    // без него второй запрос читал бы ещё не сохранённый flowmusicProjectId
    // и завёл бы отдельную сессию на стороне FlowMusic вместо продолжения.
    return withFileLock(`flowmusic-topic-${topicId}`, async () => {
      const topic = await getTopic(topicId);
      // onProjectCreated — сохраняем id СРАЗУ, как только он известен, не
      // дожидаясь конца всей функции (генерация+опрос+скачивание может
      // упасть по таймауту уже ПОСЛЕ создания проекта — раньше в этом
      // случае id проекта нигде не сохранялся, и повторная попытка не
      // видела уже существующий проект, создавая на FlowMusic ещё один).
      const { tracks } = await askFlowMusic(lastUserMessage?.content ?? "", topic?.flowmusicProjectId, (id) => {
        if (!topic?.flowmusicProjectId) {
          setTopicFlowMusicProjectId(topicId, id).catch(() => {});
        }
      });
      const markers: string[] = [];
      for (const track of tracks) {
        const saved = await saveChatAttachment(topicId, track.audioBuffer, track.filename);
        if (!saved) throw new Error("не удалось сохранить сгенерированное аудио — некорректный topicId");
        markers.push(`!audio(${saved.url})`);
      }
      return { content: markers.join("\n") };
    });
  }
  return askDeepSeek(context, model);
}

app.get("/api/chat/topics", async () => {
  return { topics: await listTopics() };
});

app.get("/api/chat/usage", async () => {
  return { usage: await getUsageSummary() };
});

// path.join() не защищает от "../" в параметрах маршрута (find-my-way
// матчит до URL-декодирования) — строим путь и проверяем, что он не
// вышел за пределы baseDir.
function safeJoin(baseDir: string, ...segments: string[]): string | null {
  const target = path.join(baseDir, ...segments);
  const normalizedBase = path.normalize(baseDir + path.sep);
  if (target !== path.normalize(baseDir) && !target.startsWith(normalizedBase)) return null;
  return target;
}

// Общее место сохранения для аудио, сгенерированного FlowMusic (см.
// getReply ниже) — тот же каталог и та же схема ссылки, что и у файлов,
// загруженных пользователем (см. маршрут ниже), но принимает готовый
// Buffer, а не поток — у FlowMusic это уже скачанный целиком файл.
async function saveChatAttachment(topicId: string, buffer: Buffer, filename: string): Promise<{ id: string; url: string } | null> {
  const safeName = filename.replace(/[^\w.\-а-яА-ЯёЁ]/g, "_");
  const id = crypto.randomUUID();
  const dir = safeJoin(HUB_DATA_DIR, "chat", "attachments", topicId);
  if (!dir) return null;
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${id}-${safeName}`);
  await writeFile(filePath, buffer);
  return { id, url: `/api/chat/${topicId}/attachments/${id}-${encodeURIComponent(safeName)}` };
}

// Расширение -> Content-Type для отдачи вложений ниже. Раньше вообще не
// выставлялся (Fastify отдавал бы Buffer как application/octet-stream по
// умолчанию) — для <img> браузеры почти всегда распознают формат по
// содержимому и без него, а вот <audio> (см. !audio(URL) в dashboard.ts)
// куда менее терпим к отсутствию/неверному Content-Type.
const ATTACHMENT_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

// Файл сохраняется на диск потоково (не буферизуется целиком в памяти,
// в отличие от saveChatAttachment выше — там уже готовый Buffer, тут
// поток из multipart-формы), в сообщение уходит только короткая ссылка.
app.post<{ Params: { topicId: string } }>("/api/chat/:topicId/attachments", async (request, reply) => {
  const data = await request.file();
  if (!data) {
    reply.code(400);
    return { error: "файл не передан" };
  }
  const topicId = request.params.topicId;
  const safeName = data.filename.replace(/[^\w.\-а-яА-ЯёЁ]/g, "_");
  const id = crypto.randomUUID();
  const dir = safeJoin(HUB_DATA_DIR, "chat", "attachments", topicId);
  if (!dir) {
    reply.code(400);
    return { error: "некорректный topicId" };
  }
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${id}-${safeName}`);
  await pipeline(data.file, createWriteStream(filePath));

  return { id, filename: data.filename, url: `/api/chat/${topicId}/attachments/${id}-${encodeURIComponent(safeName)}` };
});

app.get<{ Params: { topicId: string; filename: string } }>(
  "/api/chat/:topicId/attachments/:filename",
  async (request, reply) => {
    const filePath = safeJoin(HUB_DATA_DIR, "chat", "attachments", request.params.topicId, request.params.filename);
    if (!filePath) {
      reply.code(400);
      return { error: "некорректный путь" };
    }
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      reply.code(404);
      return { error: "не найдено" };
    }

    const ext = path.extname(request.params.filename).toLowerCase();
    reply.header("Content-Type", ATTACHMENT_CONTENT_TYPES[ext] ?? "application/octet-stream");
    reply.header("Content-Disposition", `inline; filename="${request.params.filename}"`);
    // Accept-Ranges — рекламируем поддержку Range всегда, даже вне самого
    // Range-запроса, иначе некоторые браузеры/плееры не станут ПРОБОВАТЬ
    // сикать вообще, посчитав сервер неспособным на это в принципе.
    reply.header("Accept-Ranges", "bytes");

    // <audio> перематывает через частичный запрос байт (Range: bytes=X-Y,
    // ожидает 206) — без поддержки клик по таймлайну на части браузеров
    // не перематывает, а перезапускает воспроизведение с начала.
    const rangeHeader = request.headers.range;
    if (!rangeHeader) {
      reply.header("Content-Length", fileStat.size);
      return createReadStream(filePath);
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    const start = match?.[1] ? parseInt(match[1], 10) : 0;
    const end = match?.[2] ? parseInt(match[2], 10) : fileStat.size - 1;
    if (!match || Number.isNaN(start) || Number.isNaN(end) || start > end || end >= fileStat.size) {
      reply.code(416); // Range Not Satisfiable
      reply.header("Content-Range", `bytes */${fileStat.size}`);
      return reply.send();
    }

    reply.code(206);
    reply.header("Content-Range", `bytes ${start}-${end}/${fileStat.size}`);
    reply.header("Content-Length", end - start + 1);
    return createReadStream(filePath, { start, end });
  }
);

// Удаление одного трека из сообщения, не всего сообщения целиком —
// FlowMusic обычно даёт сразу несколько вариантов. url — та же ссылка,
// что в !audio(url) внутри content, ей же адресуем и файл на диске.
app.delete<{ Params: { topicId: string; messageId: string }; Body: { url?: string } }>(
  "/api/chat/:topicId/messages/:messageId/attachments",
  async (request, reply) => {
    const url = request.body?.url;
    if (!url) {
      reply.code(400);
      return { error: "не передан url трека" };
    }
    const updated = await removeAttachmentFromMessage(request.params.topicId, request.params.messageId, url);
    if (!updated) {
      reply.code(404);
      return { error: "сообщение не найдено" };
    }

    // UUID в имени файла исключает коллизию между сообщениями — можно
    // удалить с диска, не просто отвязать ссылку. Не критично при неудаче.
    try {
      const filename = url.split("/").pop();
      if (filename) {
        const filePath = safeJoin(HUB_DATA_DIR, "chat", "attachments", request.params.topicId, filename);
        if (filePath) await unlink(filePath);
      }
    } catch {
      // не критично
    }

    return { message: updated };
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
    // Провайдер закреплён за темой при создании, клиент его не выбирает
    // заново; model — только для DeepSeek, приходит с каждым сообщением.
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
      const { content: replyContent, usage, model: resolvedModel } = await getReply(context, provider, model, topicId);
      const assistantMessage = newMessage("assistant", replyContent, provider, usage, resolvedModel);
      await appendMessage(topicId, assistantMessage);
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
      const details = err instanceof Error ? err.message : String(err);
      return { userMessage, error: "не удалось получить ответ от модели", details };
    }
  }
);

// version читается из package.json при старте, не захардкожена строкой.
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

app.get("/modules", async () => {
  return { modules: supervisor.getStatus() };
});

// Прокси к контейнеру модуля — хаб резолвит имя через getModuleTarget,
// не доверяет URL напрямую.
app.all("/modules/:name/*", async (request, reply) => {
  const { name } = request.params as { name: string };
  const wildcard = (request.params as { "*": string })["*"] ?? "";
  const target = supervisor.getModuleTarget(name);
  if (!target) {
    reply.code(404);
    return { error: `модуль '${name}' не найден` };
  }

  const targetPath = `/${wildcard}${request.url.includes("?") ? "?" + request.url.split("?")[1] : ""}`;

  // content-length/host/connection не пересылаем — тело пересобирается
  // само (другая длина), host свой.
  const forwardedHeaders: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === "content-length" || lower === "host" || lower === "connection") continue;
    forwardedHeaders[key] = value;
  }
  forwardedHeaders.host = `${target.host}:${target.port}`;

  // request.body уже разобран (fastify-formbody), исходные байты не
  // достать — пересобираем как JSON и форсируем этот content-type,
  // иначе заголовок разошёлся бы с телом (например form-urlencoded).
  if (request.body && typeof request.body === "object") {
    forwardedHeaders["content-type"] = "application/json";
  }

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
          if (key.toLowerCase() === "content-length" || key.toLowerCase() === "transfer-encoding") continue;
          reply.header(key, value);
        }
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

app.post<{ Params: { action: string } }>("/internal/privileged/:action", async (request, reply) => {
  const action = request.params.action;
  const handler = PRIVILEGED_ACTIONS[action];
  if (!handler) {
    reply.code(403);
    return { error: `действие '${action}' не в белом списке` };
  }

  await emitEvent("privileged.action.executed", { action });
  return handler();
});

// Модуль может реализовать GET /state — хаб проксирует, не проверяя формат.
app.get<{ Params: { name: string } }>("/internal/module-state/:name", async (request, reply) => {
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
  return { token: (await getMonitoringAgentToken()) ?? null };
});

// В отличие от чат-провайдеров (хаб сам делает запрос, ключ наружу не
// выходит) — cheevoscope сам обращается к Steam/RA API, нужен настоящий
// ключ. Спрашивает заново при каждом запуске, не кэширует у себя.
app.get("/internal/cheevoscope-keys", async (request, reply) => {
  return {
    steamApiKey: (await getSteamApiKey()) ?? null,
    steamId: (await getSteamId()) ?? null,
    raUsername: (await getRaUsername()) ?? null,
    raApiKey: (await getRaApiKey()) ?? null,
  };
});

// GET /internal/chat-usage — расход токенов чата, реальные числа из
// usage.ts. Единственный потребитель — модуль billing.
app.get("/internal/chat-usage", async (request, reply) => {
  return { usage: await getUsageSummary() };
});

// Баланс через тот же ключ, что у чата, сам ключ модулю не передаётся.
// У Gemini/Claude публичного API баланса нет вообще. Для Gemini есть
// другое — /internal/provider-status/gemini: статус по факту запросов.
app.get("/internal/provider-balance/deepseek", async (request, reply) => {
  return await getDeepSeekBalance();
});

// GET /internal/provider-balance/flowmusic — кредиты аккаунта, тот же
// принцип, что у DeepSeek выше, но не публичный официальный API — сам
// эндпоинт найден в исходниках стороннего проекта (см. честную оговорку
// в getFlowMusicBalance).
app.get("/internal/provider-balance/flowmusic", async (request, reply) => {
  return await getFlowMusicBalance();
});

// POST /internal/flowmusic-session — модуль technical (AI API, реальный
// Chromium внутри — держит вкладку flowmusic.app живой) присылает актуальную
// куку сессии после каждого успешного цикла. Формат тот же, что при
// ручной вставке в /api/settings/keys (одна или несколько строк —
// .0/.1 части большой куки), providers.ts разбирает сам при следующем
// запросе к FlowMusic — дублировать парсинг здесь не нужно.
app.post<{ Body: { sessionRaw?: string } }>("/internal/flowmusic-session", async (request, reply) => {
  const raw = request.body?.sessionRaw;
  if (!raw || typeof raw !== "string" || !raw.trim()) {
    reply.code(400);
    return { error: "sessionRaw обязателен" };
  }
  await setKey("flowmusic", raw);
  return { ok: true };
});

app.get("/internal/provider-status/gemini", async (request, reply) => {
  const status = await getProviderStatus("gemini");
  return { status: status ?? null };
});

// GET /internal/recent-events — последние записи журнала для модуля
// notifications. Хаб уже читает/пишет этот файл напрямую.
//
// Журнал смешанный: bash-хук пишет details строкой, хаб (emitEvent) —
// объектом. Модуль сам разбирается, тут — сырые строки без нормализации.
app.get("/internal/recent-events", async (request, reply) => {
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
  return { count: await getSubscriptionCount() };
});

const start = async () => {
  await mkdir(HUB_DATA_DIR, { recursive: true }).catch(() => {});
  await mkdir(MODULES_DIR, { recursive: true }).catch(() => {});
  await mkdir(path.dirname(EVENTS_LOG), { recursive: true }).catch(() => {});
  await emitEvent("hub.started", { pid: process.pid });

  try {
    await app.listen({ port: HUB_PORT, host: "0.0.0.0" });
    startEventWatcher(); // не зависит от host-bridge, читает свой EVENTS_LOG

    // Ждём host-bridge ПЕРЕД запуском супервизора — иначе при перезагрузке
    // сервера велик шанс поймать гонку и потерять модули.
    const bridgeReady = await waitForHostBridge();
    if (!bridgeReady) {
      app.log.error("host-bridge не ответил — модули не будут запущены автоматически, проверь `systemctl status nexus404-host-bridge`");
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

process.on("uncaughtException", (err) => {
  app.log.error({ err }, "непойманное исключение — хаб продолжает работать");
});
process.on("unhandledRejection", (reason) => {
  app.log.error({ reason }, "необработанный отказ промиса — хаб продолжает работать");
});

start();
