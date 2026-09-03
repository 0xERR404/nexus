#!/usr/bin/env python3
"""
NEXUS404 — агент мониторинга для удалённых серверов.

Работает НА ХОСТЕ (не в контейнере), поэтому в отличие от самого модуля
мониторинга (который видит хост только через смонтированные /host/proc,
/host/root) читает /proc и диск напрямую — тут никакого контейнера нет.

Раз в интервал считает CPU/RAM/диск/сеть/аптайм и отправляет одним POST
на хаб. Никаких внешних зависимостей — только stdlib, чтобы ставиться
одной командой на голый сервер без pip/venv.

Конфиг — /etc/nexus404-agent/config.json, пишет install-agent.sh при
установке (имя сервера, URL хаба, токен — см. install-agent.sh).
"""
import json
import os
import subprocess
import time
import urllib.error
import urllib.request

CONFIG_PATH = "/etc/nexus404-agent/config.json"
# Тот же путь, что и на сервере с хабом (00-base-server ставит event_hook.sh
# везде одинаково — предполагается, что удалённый сервер тоже прошёл эту
# базовую настройку, иначе тут просто нечего будет читать, см.
# tail_new_events ниже: файла нет — тихо пропускаем, не падаем).
EVENTS_LOG_PATH = "/opt/nexus404/hooks/events/events.jsonl"
# Своя позиция в файле событий — сколько строк уже переслали. Не тот же
# файл, что checkpoint у хаба (eventWatcher.ts) — это ДРУГОЙ процесс на
# ДРУГОЙ машине, свой собственный прогресс.
EVENTS_CHECKPOINT_PATH = "/etc/nexus404-agent/events-checkpoint.txt"


def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def read_cpu_line() -> tuple:
    with open("/proc/stat", "r", encoding="utf-8") as f:
        line = f.readline()
    parts = [int(x) for x in line.split()[1:]]
    user, nice, system, idle = parts[0], parts[1], parts[2], parts[3]
    iowait = parts[4] if len(parts) > 4 else 0
    irq = parts[5] if len(parts) > 5 else 0
    softirq = parts[6] if len(parts) > 6 else 0
    steal = parts[7] if len(parts) > 7 else 0
    idle_total = idle + iowait
    total = user + nice + system + idle_total + irq + softirq + steal
    return idle_total, total


def read_memory() -> dict:
    values = {}
    with open("/proc/meminfo", "r", encoding="utf-8") as f:
        for line in f:
            key, _, rest = line.partition(":")
            digits = "".join(ch for ch in rest if ch.isdigit())
            if digits:
                values[key] = int(digits) * 1024  # kB -> байты
    total = values.get("MemTotal", 0)
    available = values.get("MemAvailable", 0)
    return {"ramTotalBytes": total, "ramUsedBytes": max(0, total - available)}


def read_disk() -> dict:
    # statvfs на "/" — сам агент живёт на хосте, читать нечего через df
    # отдельным процессом, os.statvfs делает то же самое напрямую.
    st = os.statvfs("/")
    total = st.f_frsize * st.f_blocks
    free = st.f_frsize * st.f_bavail
    return {"diskUsedBytes": max(0, total - free), "diskTotalBytes": total}


def read_network_totals() -> tuple:
    rx = tx = 0
    with open("/proc/net/dev", "r", encoding="utf-8") as f:
        lines = f.readlines()[2:]  # первые 2 строки — заголовки таблицы
    for line in lines:
        if ":" not in line:
            continue
        iface, rest = line.split(":", 1)
        iface = iface.strip()
        if iface == "lo":
            continue
        fields = rest.split()
        if len(fields) < 9:
            continue
        rx += int(fields[0])
        tx += int(fields[8])
    return rx, tx


def read_uptime_seconds() -> int:
    with open("/proc/uptime", "r", encoding="utf-8") as f:
        return int(float(f.read().split()[0]))


def collect_metrics(prev_cpu, prev_net) -> tuple:
    idle_total, total = read_cpu_line()
    if prev_cpu is None:
        cpu_percent = 0.0
    else:
        prev_idle, prev_total = prev_cpu
        total_delta = total - prev_total
        idle_delta = idle_total - prev_idle
        cpu_percent = 0.0 if total_delta <= 0 else max(0.0, min(100.0, (1 - idle_delta / total_delta) * 100))

    rx, tx = read_network_totals()
    now = time.time()
    if prev_net is None:
        rx_rate = tx_rate = 0.0
    else:
        prev_rx, prev_tx, prev_at = prev_net
        delta_sec = now - prev_at
        rx_rate = max(0.0, (rx - prev_rx) / delta_sec) if delta_sec > 0 else 0.0
        tx_rate = max(0.0, (tx - prev_tx) / delta_sec) if delta_sec > 0 else 0.0

    metrics = {
        "cpuPercent": round(cpu_percent, 1),
        "cpuCores": os.cpu_count() or 1,
        **read_memory(),
        **read_disk(),
        "netRxBytesPerSec": rx_rate,
        "netTxBytesPerSec": tx_rate,
        "uptimeSeconds": read_uptime_seconds(),
    }
    return metrics, (idle_total, total), (rx, tx, now)


def send_report(hub_url: str, token: str, server_name: str, metrics: dict) -> None:
    url = hub_url.rstrip("/") + "/modules/monitoring/api/agent/report"
    body = json.dumps({"name": server_name, **metrics}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        resp.read()


def send_event_report(hub_url: str, token: str, server_name: str, event_type: str, details) -> None:
    url = hub_url.rstrip("/") + "/modules/notifications/api/agent/report-event"
    body = json.dumps({"server": server_name, "type": event_type, "details": details}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        resp.read()


# Пересылка событий с этого сервера — тот же общий журнал, что читает
# eventWatcher.ts на сервере с хабом (event_hook.sh, fail2ban/apt/cron из
# базовой настройки), только СВОЙ, локальный для этой машины. Хаб про
# события ДРУГИХ серверов ничего не знает и узнать не может никаким
# другим путём — только через агента, тот же принцип, что и у метрик.
#
# Позиция — по числу строк, не по времени (часы на разных серверах могут
# быть рассинхронизированы) — тот же приём, что и в eventWatcher.ts на
# стороне хаба. Файла может не быть вообще (сервер не проходил
# 00-base-server, или прошёл версией без хук-механизма) — это НЕ ошибка,
# просто на этом сервере пересылать пока нечего.
def tail_new_events() -> list:
    try:
        with open(EVENTS_LOG_PATH, "r", encoding="utf-8") as f:
            lines = [line for line in f.read().strip().split("\n") if line]
    except FileNotFoundError:
        return []

    try:
        with open(EVENTS_CHECKPOINT_PATH, "r", encoding="utf-8") as f:
            checkpoint = int(f.read().strip())
    except (FileNotFoundError, ValueError):
        # Первый запуск этой возможности — не заваливаем хаб пересылкой
        # всей истории журнала, начинаем с текущего конца файла (тот же
        # принцип, что и в eventWatcher.ts).
        checkpoint = len(lines)
        _save_events_checkpoint(checkpoint)

    if len(lines) <= checkpoint:
        return []

    new_lines = lines[checkpoint:]
    events = []
    for line in new_lines:
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # повреждённая строка — пропускаем, не роняем агента
    _save_events_checkpoint(len(lines))
    return events


def _save_events_checkpoint(n: int) -> None:
    try:
        os.makedirs(os.path.dirname(EVENTS_CHECKPOINT_PATH), exist_ok=True)
        with open(EVENTS_CHECKPOINT_PATH, "w", encoding="utf-8") as f:
            f.write(str(n))
    except OSError:
        pass  # не критично — в худшем случае перешлём те же события повторно на следующем тике


def main() -> None:
    config = load_config()
    hub_url = config["hub_url"]
    token = config["token"]
    server_name = config["server_name"]
    interval = int(config.get("interval_seconds", 15))

    prev_cpu = None
    prev_net = None

    print(f"[agent] сервер '{server_name}' -> {hub_url}, интервал {interval}с", flush=True)

    while True:
        try:
            metrics, prev_cpu, prev_net = collect_metrics(prev_cpu, prev_net)
            send_report(hub_url, token, server_name, metrics)
        except urllib.error.HTTPError as e:
            # 401/403 — почти наверняка неверный или устаревший токен
            # (сменили в интерфейсе хаба) — не валим процесс, просто
            # сообщаем и пробуем снова на следующем тике: токен могут
            # поправить в конфиге и без перезапуска агента заново.
            print(f"[agent] хаб отклонил отчёт: {e.code} {e.reason}", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[agent] ошибка тика: {e}", flush=True)

        # Само чтение файла — тоже в защите: неожиданная ошибка чтения
        # (права доступа и т.п.) не должна ронять весь цикл агента.
        try:
            new_events = tail_new_events()
        except Exception as e:  # noqa: BLE001
            print(f"[agent] не удалось прочитать журнал событий: {e}", flush=True)
            new_events = []

        for event in new_events:
            event_type = event.get("type")
            if not event_type:
                continue
            try:
                send_event_report(hub_url, token, server_name, event_type, event.get("details"))
            except urllib.error.HTTPError as e:
                print(f"[agent] хаб отклонил событие {event_type}: {e.code} {e.reason}", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"[agent] ошибка пересылки события {event_type}: {e}", flush=True)

        time.sleep(interval)


if __name__ == "__main__":
    main()
