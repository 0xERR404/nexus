import net from "node:net";

// Сокет лежит в смонтированной директории (не отдельный файл) — путь
// резолвится заново на каждый вызов, независимо от пересоздания файла
// на хосте. См. docker-compose.yml.
const BRIDGE_SOCKET = process.env.HOST_BRIDGE_SOCKET ?? "/var/run/host-bridge-sock/host-bridge.sock";
const RESPONSE_TIMEOUT_MS = 35000;

export interface BridgeResponse {
  ok: boolean;
  [key: string]: unknown;
}

// Единственный способ хаба выполнить что-то на уровне хоста. У самого
// моста (host-bridge/src/bridge.ts) свой независимый белый список —
// вторая защита на случай компрометации контейнера хаба.
export function callHostBridge(action: string, params?: Record<string, unknown>): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(BRIDGE_SOCKET, () => {
      client.write(JSON.stringify({ action, params: params ?? {} }));
      client.end();
    });

    let buffer = "";
    client.on("data", (chunk) => (buffer += chunk.toString()));
    client.on("end", () => {
      try {
        resolve(JSON.parse(buffer.trim()) as BridgeResponse);
      } catch (err) {
        reject(new Error(`не удалось разобрать ответ host-bridge: ${String(err)}`));
      }
    });
    client.on("error", (err) => reject(new Error(`host-bridge недоступен: ${err.message}`)));
    client.setTimeout(RESPONSE_TIMEOUT_MS, () => {
      client.destroy();
      reject(new Error("таймаут ожидания ответа от host-bridge"));
    });
  });
}

// Ждёт, пока мост начнёт отвечать (шаг 1), затем пока Docker-демон реально
// готов принимать команды (шаг 2, docker_ready) — systemd не гарантирует
// строгий порядок относительно docker.service при полной перезагрузке.
export async function waitForHostBridge(maxWaitMs = 120000, pollIntervalMs = 1000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      await callHostBridge("module_inspect", { name: "__hub_readiness_probe__" });
      break;
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
      // не ответил на этот конкретный запрос — пробуем снова
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}
