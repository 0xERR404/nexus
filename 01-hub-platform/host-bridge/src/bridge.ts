/**
 * NEXUS404 — host-bridge
 *
 * Хаб живёт в Docker-контейнере и не может выполнить действие на уровне
 * хоста напрямую. Этот демон работает НА ХОСТЕ, слушает unix-сокет,
 * вмонтированный внутрь контейнера хаба, и исполняет только то, что есть
 * в его собственном белом списке — двойная защита поверх белого списка
 * самого хаба (PRIVILEGED_ACTIONS в hub/src/index.ts): даже если контейнер
 * хаба скомпрометирован, мост не выполнит ничего лишнего.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { execFile } from "node:child_process";

// Сокет — своя директория (bind-mount директории, не файла), чтобы hub
// всегда видел актуальный файл сокета даже после перезапуска этого демона.
const SOCKET_DIR = "/opt/nexus404/host-bridge-sock";
const SOCKET_PATH = path.join(SOCKET_DIR, "host-bridge.sock");
const HOOK_SCRIPT = "/opt/nexus404/hooks/event_hook.sh";
const MODULES_DIR = "/opt/nexus404/modules";
const IMAGE_PREFIX = "nexus404-module-";
const CONTAINER_PREFIX = "nexus404-module-";
const DEFAULT_NETWORK = "nexus404";
const MODULE_DATA_ROOT = "/opt/nexus404/module-data";

const MODULE_NAME_RE = /^[a-z0-9_-]{1,64}$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

interface FixedAction {
  cmd: string[];
  event: string;
}

// Фиксированные действия без параметров — расширение только правкой этого
// файла, не настраивается изнутри контейнера.
const ALLOWED_ACTIONS: Record<string, FixedAction> = {
  restart_server: { cmd: ["/sbin/shutdown", "-r", "+1", "NEXUS404: перезапуск по запросу из хаба"], event: "system.reboot.privileged_action" },
  run_cleanup: { cmd: ["/usr/local/bin/deploy_kit_cleanup.sh"], event: "system.cleanup.privileged_action" },
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Response = Record<string, JsonValue>;

function emitEvent(eventType: string, details = ""): void {
  if (!fs.existsSync(HOOK_SCRIPT)) return;
  try {
    execFile(HOOK_SCRIPT, [eventType, details], { timeout: 5000 }, () => {});
  } catch {
    // не критично — событие лучшего усилия
  }
}

interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

// execFile — не через shell, инъекция через аргументы невозможна. Ненулевой
// код возврата резолвится (как Python subprocess.run без check=True) —
// ошибка только если процесс не удалось запустить/дождаться.
function docker(args: string[], timeoutMs = 60000): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code !== "number") {
        reject(error); // спавн не удался (ENOENT) или убит по таймауту/сигналу
        return;
      }
      resolve({ code: error ? Number((error as NodeJS.ErrnoException).code) : 0, stdout, stderr });
    });
  });
}

function safeModuleName(name: unknown): name is string {
  return typeof name === "string" && MODULE_NAME_RE.test(name);
}

async function handleModuleAction(action: string, params: Record<string, unknown>): Promise<Response> {
  const name = params.name;
  if (!safeModuleName(name)) return { ok: false, error: "недопустимое имя модуля" };

  const moduleDir = path.join(MODULES_DIR, name);
  if (!fs.existsSync(moduleDir) || !fs.statSync(moduleDir).isDirectory()) {
    return { ok: false, error: `папка модуля '${name}' не найдена на хосте` };
  }

  const imageTag = `${IMAGE_PREFIX}${name}:latest`;
  const containerName = `${CONTAINER_PREFIX}${name}`;

  if (action === "module_build") {
    const r = await docker(["build", "-t", imageTag, moduleDir], 180000);
    return { ok: r.code === 0, stdout: r.stdout.slice(-2000), stderr: r.stderr.slice(-2000) };
  }

  if (action === "module_ensure_running") {
    const network = (params.network as string) || DEFAULT_NETWORK;
    const env = params.env ?? {};
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      return { ok: false, error: "env должен быть объектом" };
    }

    await docker(["rm", "-f", containerName], 30000).catch(() => {}); // старый контейнер, если остался

    const moduleDataDir = path.join(MODULE_DATA_ROOT, name);
    fs.mkdirSync(moduleDataDir, { recursive: true });

    // unless-stopped — переживает рестарт самого Docker-демона; уважает
    // намеренную остановку (module_stop/remove), не трогает её.
    const runArgs = ["run", "-d", "--name", containerName, "--network", network, "--restart", "unless-stopped", "-v", `${moduleDataDir}:/app/data`];

    // Только monitoring видит хост (метрики CPU/RAM/диск), остальные модули — нет.
    if (name === "monitoring") runArgs.push("-v", "/proc:/host/proc:ro", "-v", "/:/host/root:ro");

    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (ENV_KEY_RE.test(key)) runArgs.push("-e", `${key}=${String(value)}`);
    }
    runArgs.push(imageTag);

    const r = await docker(runArgs, 30000);
    return { ok: r.code === 0, containerId: r.code === 0 ? r.stdout.trim().slice(0, 12) : null, stderr: r.stderr.slice(-2000) };
  }

  if (action === "module_inspect") {
    const r = await docker(["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}} {{.Id}}", containerName], 10000);
    if (r.code !== 0) return { ok: true, exists: false };
    const parts = r.stdout.trim().split(/\s+/);
    if (parts.length !== 3) return { ok: true, exists: false };
    const exitCodeNum = Number(parts[1]);
    return { ok: true, exists: true, running: parts[0] === "true", exitCode: Number.isFinite(exitCodeNum) ? exitCodeNum : null, containerId: parts[2].slice(0, 12) };
  }

  if (action === "module_stop") {
    return { ok: (await docker(["stop", containerName], 15000)).code === 0 };
  }
  if (action === "module_remove") {
    return { ok: (await docker(["rm", "-f", containerName], 15000)).code === 0 };
  }
  return { ok: false, error: `неизвестное действие '${action}'` };
}

async function handleRequest(raw: string): Promise<Response> {
  const request = JSON.parse(raw) as { action?: string; params?: Record<string, unknown> };
  const action = request.action ?? "";
  const params = request.params ?? {};

  if (action.startsWith("module_")) return handleModuleAction(action, params);

  // Проверка готовности ДЕМОНА Docker (не только моста) — module_inspect на
  // несуществующее имя отклоняется раньше, чем дошло бы до docker.
  if (action === "docker_ready") {
    try {
      const r = await docker(["version", "--format", "{{.Server.Version}}"], 5000);
      return { ok: r.code === 0 };
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e) };
    }
  }

  const entry = ALLOWED_ACTIONS[action];
  if (!entry) return { ok: false, error: `действие '${action}' не в белом списке моста` };

  try {
    const [cmd, ...args] = entry.cmd;
    const r = await new Promise<DockerResult>((resolve, reject) => {
      execFile(cmd, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error ? Number((error as NodeJS.ErrnoException).code) : 0, stdout, stderr });
      });
    });
    emitEvent(entry.event, `action=${action} returncode=${r.code}`);
    return { ok: r.code === 0, returncode: r.code, stdout: r.stdout.slice(-2000), stderr: r.stderr.slice(-2000) };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

function handleClient(conn: net.Socket): void {
  const chunks: Buffer[] = [];
  conn.on("data", (chunk) => chunks.push(chunk));
  conn.on("end", () => {
    const data = Buffer.concat(chunks);
    if (data.length === 0) {
      conn.end();
      return;
    }
    (async () => {
      let response: Response;
      try {
        response = await handleRequest(data.toString("utf-8"));
      } catch (e) {
        response = { ok: false, error: String((e as Error).message ?? e) };
      }
      conn.end(JSON.stringify(response) + "\n");
    })();
  });
  conn.on("error", () => conn.destroy()); // одно плохое соединение не должно ронять процесс
}

function main(): void {
  if (fs.existsSync(SOCKET_DIR) && !fs.statSync(SOCKET_DIR).isDirectory()) {
    console.log(`[host-bridge] ${SOCKET_DIR} существует, но не директория — удаляю`);
    fs.rmSync(SOCKET_DIR);
  }
  fs.mkdirSync(SOCKET_DIR, { recursive: true });
  if (fs.existsSync(SOCKET_PATH)) fs.rmSync(SOCKET_PATH);

  // allowHalfOpen — иначе Node сам закрывает сокет на запись при FIN от
  // клиента (тот делает shutdown(SHUT_WR) сразу после запроса), и ответ
  // не успевает уйти ("write after end").
  const server = net.createServer({ allowHalfOpen: true }, handleClient);
  server.on("error", (e) => console.log(`[host-bridge] ошибка сервера (не фатально): ${e.message}`));
  server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o600);
    console.log(`[host-bridge] слушаю ${SOCKET_PATH}`);
  });
}

process.on("uncaughtException", (err) => {
  console.log("[host-bridge] ФАТАЛЬНАЯ ошибка, процесс завершается:", err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.log("[host-bridge] ФАТАЛЬНАЯ ошибка (unhandled rejection), процесс завершается:", err);
  process.exit(1);
});

main();
