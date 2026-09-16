import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { callHostBridge } from "./hostBridge.js";

interface Manifest {
  name: string;
  displayName?: string;
  version?: string;
  description?: string;
  port: number;
}

type ModuleStatus = "building" | "starting" | "running" | "restarting" | "broken" | "stopped";

interface ModuleState {
  manifest: Manifest;
  dir: string;
  containerId: string | null;
  status: ModuleStatus;
  consecutiveFailures: number;
  lastHealthAt: string | null;
  intentionalStop: boolean;
  // "broken" не навсегда — получает медленные повторы (RETRY_COOLDOWN_MS).
  nextRetryEligibleAt: number | null;
}

const MAX_CONSECUTIVE_FAILURES = 5;
const HEALTH_INTERVAL_MS = 5000;
const SCAN_INTERVAL_MS = 10000;
const RESTART_BACKOFF_MS = 3000;
const RETRY_COOLDOWN_MS = 2 * 60 * 1000;
const CONTAINER_PREFIX = "nexus404-module-";

// Контейнерами управляет через host-bridge (не прямой docker.sock).
// Health-check — прямой HTTP к контейнеру, моста не требует.
export class ModuleSupervisor {
  private modules = new Map<string, ModuleState>();
  private modulesDir: string;
  private hubPort: number;
  private internalToken: string;
  private dockerNetwork: string;
  private emitEvent: (type: string, details: unknown) => Promise<void>;

  // Запуск модулей строго по одному, не все разом — иначе параллельные
  // docker build конкурируют за CPU/диск при старте хаба.
  private launchQueue: string[] = [];
  private queueRunning = false;

  constructor(
    modulesDir: string,
    hubPort: number,
    internalToken: string,
    dockerNetwork: string,
    emitEvent: (type: string, details: unknown) => Promise<void>
  ) {
    this.modulesDir = modulesDir;
    this.hubPort = hubPort;
    this.internalToken = internalToken;
    this.dockerNetwork = dockerNetwork;
    this.emitEvent = emitEvent;
  }

  start() {
    this.scan();
    setInterval(() => this.scan(), SCAN_INTERVAL_MS);
    setInterval(() => this.healthCheckAll(), HEALTH_INTERVAL_MS);
  }

  getStatus() {
    return Array.from(this.modules.entries()).map(([name, m]) => ({
      name,
      displayName: m.manifest.displayName ?? name,
      description: m.manifest.description ?? "",
      version: m.manifest.version ?? "0.0.0",
      status: m.status,
      port: m.manifest.port,
      containerId: m.containerId,
      consecutiveFailures: m.consecutiveFailures,
      lastHealthAt: m.lastHealthAt,
    }));
  }

  getModuleTarget(name: string): { host: string; port: number } | null {
    const state = this.modules.get(name);
    if (!state) return null;
    return { host: `${CONTAINER_PREFIX}${name}`, port: state.manifest.port };
  }

  private enqueueLaunch(name: string) {
    if (this.launchQueue.includes(name)) return; // уже в очереди

    this.launchQueue.push(name);
    this.runQueue();
  }

  private async runQueue() {
    if (this.queueRunning) return;
    this.queueRunning = true;
    while (this.launchQueue.length > 0) {
      const name = this.launchQueue.shift()!;
      try {
        await this.launch(name);
      } catch (err) {
        console.error(`[supervisor] launch(${name}) упал:`, err);
      }
    }
    this.queueRunning = false;
  }

  private async scan() {
    let entries;
    try {
      entries = await readdir(this.modulesDir, { withFileTypes: true });
    } catch {
      return;
    }
    // readdir() не гарантирует порядок — сортируем по имени для
    // детерминированной очереди запуска.
    entries = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const dir = path.join(this.modulesDir, entry.name);
      const manifestPath = path.join(dir, "manifest.json");
      const dockerfilePath = path.join(dir, "Dockerfile");
      let manifest: Manifest;
      try {
        const raw = await readFile(manifestPath, "utf-8");
        manifest = JSON.parse(raw);
        if (!manifest.name || !manifest.port) {
          throw new Error("manifest.json: обязательны name, port");
        }
        await readFile(dockerfilePath); // просто проверяем, что Dockerfile есть
      } catch {
        continue;
      }

      if (!this.modules.has(manifest.name)) {
        this.modules.set(manifest.name, {
          manifest,
          dir,
          containerId: null,
          status: "building",
          consecutiveFailures: 0,
          lastHealthAt: null,
          intentionalStop: false,
          nextRetryEligibleAt: null,
        });
        this.enqueueLaunch(manifest.name);
        continue;
      }

      // "broken" — медленный повтор (RETRY_COOLDOWN_MS), неважно,
      // работал ли модуль раньше хоть раз.
      const state = this.modules.get(manifest.name)!;
      if (
        state.status === "broken" &&
        state.nextRetryEligibleAt !== null &&
        Date.now() >= state.nextRetryEligibleAt
      ) {
        state.consecutiveFailures = 0;
        state.nextRetryEligibleAt = null;
        this.emitEvent("module.retry_after_broken", { name: manifest.name }).catch(() => {});
        this.enqueueLaunch(manifest.name);
      }
    }
  }

  private async launch(name: string): Promise<void> {
    const state = this.modules.get(name);
    if (!state) return;
    state.intentionalStop = false;
    state.status = "building";

    try {
      const buildResult = await callHostBridge("module_build", { name });
      if (!buildResult.ok) {
        throw new Error(`сборка образа не удалась: ${JSON.stringify(buildResult)}`);
      }

      state.status = "starting";
      // LOCAL_SERVER_NAME нужен только monitoring.
      const extraEnv: Record<string, string> =
        name === "monitoring" && process.env.LOCAL_SERVER_NAME
          ? { LOCAL_SERVER_NAME: process.env.LOCAL_SERVER_NAME }
          : {};
      const runResult = await callHostBridge("module_ensure_running", {
        name,
        network: this.dockerNetwork,
        env: {
          MODULE_PORT: String(state.manifest.port),
          HUB_HOST: "hub",
          HUB_PORT: String(this.hubPort),
          HUB_INTERNAL_TOKEN: this.internalToken,
          AUTH_USER: process.env.AUTH_USER ?? "user", // для шапки страницы модуля
          ...extraEnv,
        },
      });
      if (!runResult.ok) {
        throw new Error(`запуск контейнера не удался: ${JSON.stringify(runResult)}`);
      }

      state.containerId = typeof runResult.containerId === "string" ? runResult.containerId : null;
      state.status = "starting";
    } catch (err) {
      this.emitEvent("module.build_or_start_failed", { name, error: String(err) }).catch(() => {});
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        state.status = "broken";
        state.nextRetryEligibleAt = Date.now() + RETRY_COOLDOWN_MS;
        this.emitEvent("module.marked_broken", { name, failures: state.consecutiveFailures }).catch(() => {});
        return;
      }
      state.status = "restarting";
      setTimeout(() => this.enqueueLaunch(name), RESTART_BACKOFF_MS);
    }
  }

  private healthCheckAll() {
    // "broken" тоже проверяется — живой ответ чинит статус сразу, без
    // пересоздания контейнера. Пропускается только "stopped".
    for (const [name, state] of this.modules) {
      if (state.status === "stopped") continue;
      this.checkOne(name, state);
    }
  }

  // Опрос "жив ли контейнер" (замена событию exit) + HTTP health-check содержимого.
  private async checkOne(name: string, state: ModuleState) {
    try {
      const inspect = await callHostBridge("module_inspect", { name });
      if (!inspect.exists) return; // ещё не поднялся или убрали руками
      if (!inspect.running) {
        if (state.intentionalStop) {
          state.status = "stopped";
          return;
        }
        // уже "broken" — не продлеваем кулдаун на каждой проверке
        if (state.status === "broken") return;
        this.emitEvent("module.crashed", { name, exitCode: inspect.exitCode }).catch(() => {});
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          state.status = "broken";
          state.nextRetryEligibleAt = Date.now() + RETRY_COOLDOWN_MS;
          this.emitEvent("module.marked_broken", { name, failures: state.consecutiveFailures }).catch(() => {});
          return;
        }
        state.status = "restarting";
        setTimeout(() => this.enqueueLaunch(name), RESTART_BACKOFF_MS);
        return;
      }
      if (typeof inspect.containerId === "string") state.containerId = inspect.containerId;
    } catch (err) {
      console.error(`[supervisor] module_inspect(${name}) ошибка:`, err);
      return;
    }

    // Живой ответ всегда возвращает в "running", даже если был "broken".
    const host = `${CONTAINER_PREFIX}${name}`;
    const req = http.request(
      { host, port: state.manifest.port, path: "/health", method: "GET", timeout: 2000 },
      (res) => {
        if (res.statusCode === 200) {
          if (state.status === "broken") {
            this.emitEvent("module.recovered", { name }).catch(() => {});
          }
          state.status = "running";
          state.lastHealthAt = new Date().toISOString();
          state.consecutiveFailures = 0;
          state.nextRetryEligibleAt = null;
        }
        res.resume();
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => {}); // ещё не отвечает на HTTP — отслеживается через module_inspect выше
    req.end();
  }
}
