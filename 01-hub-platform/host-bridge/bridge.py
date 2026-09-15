#!/usr/bin/env python3
"""
NEXUS404 — host-bridge

Хаб живёт внутри Docker-контейнера и физически не может выполнить
действие на уровне хоста (перезапуск сервера, управление другими
контейнерами) напрямую. Этот демон запускается НА ХОСТЕ (не в контейнере),
слушает Unix-сокет, вмонтированный внутрь контейнера хаба, и исполняет
только то, что есть в его собственном белом списке.

Двойная защита, не одна: у хаба есть свой белый список привилегированных
действий (что вообще можно попросить, см. PRIVILEGED_ACTIONS в
hub/src/index.ts) — это не отменяет и не заменяет список здесь. Даже
если контейнер хаба полностью скомпрометирован, мост всё равно не
выполнит ничего, чего нет в ALLOWED_ACTIONS/поддерживаемых module_*
действиях ниже.

Управление контейнерами модулей (build/run/inspect/stop) теперь тоже
здесь, а не через docker.sock, смонтированный напрямую в хаб — раньше
у хаба был прямой доступ к Docker API, что по факту равносильно root на
хосте. Теперь хаб просит мост, мост сам считает, какое имя модуля
допустимо, и исполняет только конкретные docker-команды с этим именем,
не произвольные.
"""
import json
import os
import re
import socket
import subprocess
import threading

# Сокет живёт в собственной директории (не как одиночный файл),
# смонтированной в контейнер hub через bind-mount директории. Так
# каждое новое подключение из hub резолвит путь заново через живую
# директорию хоста и всегда попадает на актуальный файл сокета —
# даже если этот демон перезапускается и пересоздаёт файл (новый
# inode). Раньше при монтировании одного файла сокета в контейнер
# hub тот держал старый, уже не существующий inode до собственного
# пересоздания (docker compose up -d --force-recreate hub).
SOCKET_DIR = "/opt/nexus404/host-bridge-sock"
SOCKET_PATH = os.path.join(SOCKET_DIR, "host-bridge.sock")
HOOK_SCRIPT = "/opt/nexus404/hooks/event_hook.sh"
MODULES_DIR = "/opt/nexus404/modules"
IMAGE_PREFIX = "nexus404-module-"
CONTAINER_PREFIX = "nexus404-module-"
DEFAULT_NETWORK = "nexus404"

# Имя модуля — только то, что реально может быть именем папки под
# MODULES_DIR, ничего больше. Не доверяем имени из запроса напрямую нигде.
MODULE_NAME_RE = re.compile(r"^[a-z0-9_-]{1,64}$")

# Каждый модуль получает свою постоянную папку на хосте, смонтированную в
# /app/data внутри контейнера — раньше у модулей не было вообще никакого
# постоянного хранилища (docker rm -f при каждом перезапуске хаба стирал
# всё содержимое контейнера). Путь строится из уже провалидированного
# MODULE_NAME_RE-имени — не пользовательский ввод в чистом виде.
MODULE_DATA_ROOT = "/opt/nexus404/module-data"

# Фиксированные действия без параметров — расширение означает правку
# этого файла на хосте, не что-то настраиваемое изнутри контейнера.
ALLOWED_ACTIONS = {
    "restart_server": {
        "cmd": ["/sbin/shutdown", "-r", "+1", "NEXUS404: перезапуск по запросу из хаба"],
        "event": "system.reboot.privileged_action",
    },
    "run_cleanup": {
        "cmd": ["/usr/local/bin/deploy_kit_cleanup.sh"],
        "event": "system.cleanup.privileged_action",
    },
}


def emit_event(event_type: str, details: str = "") -> None:
    if not os.path.exists(HOOK_SCRIPT):
        return
    try:
        subprocess.run([HOOK_SCRIPT, event_type, details], timeout=5, check=False)
    except Exception:
        pass


def docker(args: list, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(["docker"] + args, capture_output=True, timeout=timeout, text=True)


def safe_module_name(name) -> bool:
    return isinstance(name, str) and bool(MODULE_NAME_RE.match(name))


def handle_module_action(action: str, params: dict) -> dict:
    name = params.get("name", "")
    if not safe_module_name(name):
        return {"ok": False, "error": "недопустимое имя модуля"}

    module_dir = os.path.join(MODULES_DIR, name)
    if not os.path.isdir(module_dir):
        return {"ok": False, "error": f"папка модуля '{name}' не найдена на хосте"}

    image_tag = f"{IMAGE_PREFIX}{name}:latest"
    container_name = f"{CONTAINER_PREFIX}{name}"

    if action == "module_build":
        r = docker(["build", "-t", image_tag, module_dir], timeout=180)
        return {"ok": r.returncode == 0, "stdout": r.stdout[-2000:], "stderr": r.stderr[-2000:]}

    if action == "module_ensure_running":
        network = params.get("network") or DEFAULT_NETWORK
        env = params.get("env") or {}
        if not isinstance(env, dict):
            return {"ok": False, "error": "env должен быть объектом"}

        # Убираем старый контейнер с этим именем, если остался от прошлого
        # запуска — игнорируем ошибку, если его и не было.
        docker(["rm", "-f", container_name], timeout=30)

        module_data_dir = os.path.join(MODULE_DATA_ROOT, name)
        os.makedirs(module_data_dir, exist_ok=True)

        # unless-stopped — вторая, независимая от супервизора хаба линия
        # защиты: если Docker-демон сам перезапустится (например, из-за
        # переинициализации сети при полной перезагрузке сервера) и
        # остановит контейнеры без политики перезапуска, модуль без этого
        # флага остался бы лежать навсегда без единой попытки подняться —
        # супервизор узнал бы об этом только на следующей проверке
        # здоровья, а до недавнего исправления мог вообще не заметить
        # (см. правку lastHealthAt в moduleSupervisor.ts). "unless-stopped"
        # уважает НАМЕРЕННУЮ остановку (module_stop/module_remove ниже),
        # перезапускает только при неожиданном завершении.
        run_args = [
            "run", "-d", "--name", container_name, "--network", network,
            "--restart", "unless-stopped",
            "-v", f"{module_data_dir}:/app/data",
        ]

        # Точечное исключение только для модуля мониторинга — ему нужна
        # видимость метрик ХОСТА (CPU/RAM/диск/сеть самого сервера), не
        # только контейнера. Обычные модули хост не видят вообще — то же
        # правило "точечно, не общим списком", что и у restart_server/
        # run_cleanup выше: расширение — это правка кода моста на хосте,
        # не что-то, что модуль может попросить сам.
        if name == "monitoring":
            run_args += [
                "-v", "/proc:/host/proc:ro",
                "-v", "/:/host/root:ro",
            ]

        for key, value in env.items():
            # Ключи переменных окружения тоже не доверяем вслепую — только
            # то, что реально похоже на имя переменной окружения.
            if not re.match(r"^[A-Z_][A-Z0-9_]*$", str(key)):
                continue
            run_args += ["-e", f"{key}={value}"]
        run_args.append(image_tag)

        r = docker(run_args, timeout=30)
        container_id = r.stdout.strip()[:12] if r.returncode == 0 else None
        return {"ok": r.returncode == 0, "containerId": container_id, "stderr": r.stderr[-2000:]}

    if action == "module_inspect":
        r = docker(
            ["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}} {{.Id}}", container_name],
            timeout=10,
        )
        if r.returncode != 0:
            return {"ok": True, "exists": False}
        parts = r.stdout.strip().split()
        if len(parts) != 3:
            return {"ok": True, "exists": False}
        return {
            "ok": True,
            "exists": True,
            "running": parts[0] == "true",
            "exitCode": int(parts[1]) if parts[1].lstrip("-").isdigit() else None,
            "containerId": parts[2][:12],
        }

    if action == "module_stop":
        r = docker(["stop", container_name], timeout=15)
        return {"ok": r.returncode == 0}

    if action == "module_remove":
        r = docker(["rm", "-f", container_name], timeout=15)
        return {"ok": r.returncode == 0}

    return {"ok": False, "error": f"неизвестное действие '{action}'"}


def handle_client(conn: socket.socket) -> None:
    try:
        data = conn.recv(65536)
        if not data:
            return
        request = json.loads(data.decode("utf-8"))
        action = request.get("action", "")
        params = request.get("params") or {}

        if action.startswith("module_"):
            response = handle_module_action(action, params)
            conn.sendall((json.dumps(response) + "\n").encode("utf-8"))
            return

        # Настоящая проверка готовности ДЕМОНА Docker, не только самого
        # моста — при полной перезагрузке сервера systemd не гарантирует
        # порядок host-bridge.service относительно docker.service
        # настолько строго, чтобы Docker уже принимал команды в момент,
        # когда мост уже слушает сокет (сам мост от Docker при старте не
        # зависит вообще). module_inspect на несуществующее имя (см.
        # waitForHostBridge в hub/src/hostBridge.ts) отклоняется РАНЬШЕ,
        # чем дошло бы до настоящей команды docker — не годится как проба
        # готовности самого Docker. Эта проверка — реальный, но самый
        # дешёвый вызов (docker version), не завязанный на существование
        # какого-либо модуля/образа/контейнера.
        if action == "docker_ready":
            try:
                r = docker(["version", "--format", "{{.Server.Version}}"], timeout=5)
                response = {"ok": r.returncode == 0}
            except Exception as e:
                response = {"ok": False, "error": str(e)}
            conn.sendall((json.dumps(response) + "\n").encode("utf-8"))
            return

        entry = ALLOWED_ACTIONS.get(action)
        if not entry:
            response = {"ok": False, "error": f"действие '{action}' не в белом списке моста"}
            conn.sendall((json.dumps(response) + "\n").encode("utf-8"))
            return

        try:
            result = subprocess.run(entry["cmd"], capture_output=True, timeout=30, text=True)
            response = {
                "ok": result.returncode == 0,
                "returncode": result.returncode,
                "stdout": result.stdout[-2000:],
                "stderr": result.stderr[-2000:],
            }
            emit_event(entry["event"], f"action={action} returncode={result.returncode}")
        except Exception as e:  # noqa: BLE001
            response = {"ok": False, "error": str(e)}

        conn.sendall((json.dumps(response) + "\n").encode("utf-8"))
    except Exception as e:  # noqa: BLE001
        try:
            conn.sendall((json.dumps({"ok": False, "error": str(e)}) + "\n").encode("utf-8"))
        except Exception:
            pass
    finally:
        conn.close()


def main() -> None:
    # os.makedirs(..., exist_ok=True) подавляет ошибку, только если по
    # SOCKET_DIR уже лежит ДИРЕКТОРИЯ — если там почему-то оказался
    # обычный файл (например, ручное вмешательство или гонка при самом
    # первом деплое этой версии), exist_ok=True не спасёт и makedirs
    # бросит FileExistsError. Разбираем сами: не директория — убираем,
    # чтобы демон не падал намертво на ровном месте при старте.
    if os.path.exists(SOCKET_DIR) and not os.path.isdir(SOCKET_DIR):
        print(f"[host-bridge] {SOCKET_DIR} существует, но не директория — удаляю", flush=True)
        os.remove(SOCKET_DIR)
    os.makedirs(SOCKET_DIR, exist_ok=True)

    if os.path.exists(SOCKET_PATH):
        os.remove(SOCKET_PATH)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET_PATH)
    os.chmod(SOCKET_PATH, 0o600)
    server.listen(5)

    print(f"[host-bridge] слушаю {SOCKET_PATH}", flush=True)

    while True:
        try:
            conn, _ = server.accept()
        except OSError as e:
            # Транзиентная ошибка accept() (например, EMFILE — кончились
            # файловые дескрипторы под нагрузкой) раньше валила весь
            # процесс целиком, снося сокет для ВСЕХ модулей разом до
            # следующего перезапуска systemd. Логируем и продолжаем
            # слушать — не даём одиночному сбою убить весь мост.
            print(f"[host-bridge] accept() ошибка (не фатально, продолжаю слушать): {e}", flush=True)
            continue
        threading.Thread(target=handle_client, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Явный маркер в journalctl — по умолчанию Python и так печатает
        # traceback в stderr при необработанном исключении, но без
        # опознаваемого префикса "[host-bridge]" его легко потерять среди
        # прочего вывода. exit(1) сохраняем — Restart=on-failure в
        # systemd-юните должен сработать как и раньше.
        import traceback
        print("[host-bridge] ФАТАЛЬНАЯ ошибка, процесс завершается:", flush=True)
        traceback.print_exc()
        raise
