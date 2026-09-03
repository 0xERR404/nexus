import net from "node:net";

const BRIDGE_SOCKET = process.env.HOST_BRIDGE_SOCKET ?? "/var/run/host-bridge.sock";
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
// module_inspect с несуществующим именем — лёгкий проб: мост отклоняет
// его на первой же проверке, не завязано на реальный Docker.
export async function waitForHostBridge(maxWaitMs = 120000, pollIntervalMs = 1000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      await callHostBridge("module_inspect", { name: "__hub_readiness_probe__" });
      return true; // любой распарсенный ответ — сокет реально слушает
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
}
