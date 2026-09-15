import net from "node:net";

// Путь резолвится через env (см. docker-compose.yml) — сокет теперь
// лежит в смонтированной директории /var/run/host-bridge-sock, а не
// как отдельный файл, смонтированный напрямую. callHostBridge() ниже
// открывает новое соединение по этому пути при каждом вызове, так что
// путь всегда резолвится заново через живую директорию хоста и не
// зависит от того, пересоздавался ли файл сокета на хосте.
const BRIDGE_SOCKET = process.env.HOST_BRIDGE_SOCKET ?? "/var/run/host-bridge-sock/host-bridge.sock";
const RESPONSE_TIMEOUT_MS = 35000;

export interface BridgeResponse {
  ok: boolean;
  [key: string]: unknown;
}

// Единственный способ хаба выполнить что-то на уровне хоста. У самого
// моста (bridge.py) свой независимый белый список — вторая защита на
// случай компрометации контейнера хаба.
export function callHostBridge(action: string, params?: Record<string, unknown>): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(BRIDGE_SOCKET, () => {
      client.write(JSON.stringify({ action, params: params ?? {} }));
      client.end();
    });

    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk.toString();
    });

    client.on("end", () => {
      try {
        resolve(JSON.parse(buffer.trim()) as BridgeResponse);
      } catch (err) {
        reject(new Error(`не удалось разобрать ответ host-bridge: ${String(err)}`));
      }
    });

    client.on("error", (err) => {
      reject(new Error(`host-bridge недоступен: ${err.message}`));
    });

    client.setTimeout(RESPONSE_TIMEOUT_MS, () => {
      client.destroy();
      reject(new Error("таймаут ожидания ответа от host-bridge"));
    });
  });
}

// Ждём, пока host-bridge реально начнёт отвечать на сокет — при полной
// перезагрузке сервера systemd гарантирует только порядок ЮНИТОВ
// (After=docker.service), не факт, что хаб уже поднялся ПОСЛЕ моста —
// был случай, когда хаб успевал стартовать раньше и модули не поднимались.
//
// Проверка в два шага: сначала — что сам мост отвечает вообще (сокет
// слушает), потом — что готов уже и сам Docker-демон (docker_ready,
// реальная команда docker version). Раньше проверялся только первый шаг
// (module_inspect на несуществующее имя — отклоняется РАНЬШЕ, чем дошло
// бы до настоящего docker, не зависит от него вообще) — мост сам не
// ждёт Docker при старте, поэтому мог начать отвечать раньше, чем Docker
// реально готов принимать команды: хаб решал "мост готов" и запускал
// супервизор, а первые попытки docker run/build проваливались, уходя в
// медленный 2-минутный повтор (см. RETRY_COOLDOWN_MS в moduleSupervisor.ts)
// вместо того, чтобы просто чуть подождать здесь.
export async function waitForHostBridge(maxWaitMs = 120000, pollIntervalMs = 1000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      await callHostBridge("module_inspect", { name: "__hub_readiness_probe__" });
      break; // мост отвечает — переходим ко второму шагу
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
  for (;;) {
    try {
      const res = await callHostBridge("docker_ready");
      if (res.ok) return true;
    } catch {
      // мост не ответил на этот конкретный запрос — не страшно, пробуем снова
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}
