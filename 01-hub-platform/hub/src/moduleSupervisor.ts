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
  // Модуль, ни разу не поднявшийся успешно и исчерпавший быстрый бюджет
  // повторов, не должен оставаться "broken" навсегда — получает медленные
  // повторы (RETRY_COOLDOWN_MS в scan()) на случай временной причины.
  nextRetryEligibleAt: number | null;
}

const MAX_CONSECUTIVE_FAILURES = 5;
const HEALTH_INTERVAL_MS = 5000;
const SCAN_INTERVAL_MS = 10000;
const RESTART_BACKOFF_MS = 3000;
const RETRY_COOLDOWN_MS = 2 * 60 * 1000;
const CONTAINER_PREFIX = "nexus404-module-";

// Управление контейнерами модулей — через host-bridge (Unix-сокет на
// хосте), не прямой docker.sock (тот = root на хосте). Health-check —
// прямой HTTP к контейнеру, не привилегированное действие, моста не требует.
export class ModuleSupervisor {
  private modules = new Map<string, ModuleState>();
  private modulesDir: string;
  private hubPort: number;
  private internalToken: string;
  private dockerNetwork: string;
  private emitEvent: (type: string, details: unknown) => Promise<void>;

  // Очередь запуска модулей — без неё scan() при старте хаба запускал
  // launch() для ВСЕХ обнаруженных модулей одновременно (fire-and-forget),
  // а launch() дёргает через host-bridge "docker build" + "docker run".
  // На сервере с малым числом ядер (после ребута заодно поднимаются сам
  // Docker-демон, host-bridge, Caddy) параллельные сборки всех модулей
  // разом конкурируют за CPU/диск и общее время до "всё online" сильно
  // растягивается. Очередь запускает модули строго один за другим —
  // каждый следующий стартует только после того, как предыдущий
  // закончил свой build+run (не обязательно дождался health, просто
  // launch() отработал).
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
    // Не дублируем: если модуль уже стоит в очереди (например, повторный
    // scan() до того, как предыдущий launch успел стартовать) — не
    // добавляем второй раз.
    if (this.launchQueue.includes(name)) return;
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
    // readdir() НЕ гарантирует какой-либо порядок — POSIX явно оставляет
    // его неопределённым (может зависеть от hash-дерева файловой системы,
    // порядка создания записей и т.д.). Без явной сортировки очередь
    // запуска в enqueueLaunch() ниже получала бы модули в произвольном,
    // невоспроизводимом порядке — от перезагрузки к перезагрузке (и уж
    // тем более между разными серверами) порядок мог отличаться, что и
    // выглядело как "белиберда", а не как осмысленное "по очереди".
    // Сортируем по имени папки — детерминированно и предсказуемо.
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

      // "broken" — пробуем снова, но медленно (RETRY_COOLDOWN_MS): частые
      // повторы не помогут, если причина отказа не разовая гонка, а
      // что-то более стойкое. Раньше это ограничивалось условием
      // lastHealthAt === null ("ни разу вообще не запускался успешно") —
      // но модуль, который какое-то время честно проработал, а потом
      // упал (что угодно могло прислать ему SIGTERM — не обязательно
      // сам супервизор), точно так же исчерпывает MAX_CONSECUTIVE_FAILURES
      // в checkOne() и помечается broken, просто с уже НЕ-null
      // lastHealthAt с прошлого раза — из-за одного этого условия он
      // НИКОГДА не подходил под повтор и оставался offline навсегда,
      // хотя изначально был рабочим. Условие убрано — "broken" значит
      // "исчерпал быстрый бюджет попыток", неважно, был ли он раньше
      // здоров хоть раз.
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
      // LOCAL_SERVER_NAME — из install-hub-platform.sh шаг 3c. Нужен
      // только monitoring — пробрасываем точечно, не всем модулям.
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
          // AUTH_USER — для единой шапки страницы модуля (не секрет,
          // пробрасывается всем модулям, в отличие от LOCAL_SERVER_NAME).
          AUTH_USER: process.env.AUTH_USER ?? "user",
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
    // Раньше "broken" пропускался здесь целиком — единственный путь
    // выбраться был через медленный повтор в scan() с полной пересборкой
    // контейнера. Модуль мог давно ожить сам (например, был отмечен
    // broken по ошибке ещё до недавнего исправления lastHealthAt) и
    // отвечать на реальные запросы через прокси — но статус на дашборде
    // оставался бы красным, пока не сработает тяжёлый цикл. Теперь
    // "broken" тоже проверяется лёгкой проверкой ниже — если контейнер и
    // правда жив и отвечает на /health, статус чинится сразу, без
    // пересоздания. Только "stopped" (осознанная остановка) пропускается —
    // его не нужно дёргать самопроизвольно.
    for (const [name, state] of this.modules) {
      if (state.status === "stopped") continue;
      this.checkOne(name, state);
    }
  }

  // Опрос "жив ли контейнер" (замена событию exit) + HTTP health-check содержимого.
  private async checkOne(name: string, state: ModuleState) {
    try {
      const inspect = await callHostBridge("module_inspect", { name });
      if (!inspect.exists) {
        // Ещё не поднялся или убрали руками — не считаем падением сразу.
        return;
      }
      if (!inspect.running) {
        if (state.intentionalStop) {
          state.status = "stopped";
          return;
        }
        // Уже "broken" — не продлеваем кулдаун на каждой проверке (раз в
        // 5с) до бесконечности, просто ждём, пока сработает уже
        // назначенный медленный повтор в scan(). Продление здесь свело
        // бы на нет весь смысл RETRY_COOLDOWN_MS — таймер никогда не
        // истекал бы, пока контейнер не поднимется сам.
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

    // Контейнер работает — обычный HTTP health-check, не привилегированное
    // действие. Успех здесь ВСЕГДА возвращает в "running" — даже если
    // статус был "broken": реальный живой ответ важнее устаревшей пометки,
    // не нужно ждать медленного повтора, чтобы это заметить.
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
    req.on("error", () => {
      // Ещё не отвечает на HTTP (стартует) — отслеживается через module_inspect выше.
    });
    req.end();
  }
}
