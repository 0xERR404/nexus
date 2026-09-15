#!/bin/bash
# =============================================================================
# NEXUS404 — обновление хаб-платформы
#
# install-hub-platform.sh не копирует файлы заново при повторном запуске
# (чтобы не переспрашивать домен). Для обновления кода — этот скрипт.
#
# Использование (после git pull в репозитории):
#   cd nexus/01-hub-platform
#   sudo bash update.sh
# =============================================================================

set -uo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Запусти от root."
    exit 1
fi

# IS_TTY запоминаем СЕЙЧАС, до enable_full_logging ниже — тот делает
# exec > >(tee ...), после чего [ -t 1 ] всегда лжёт, хотя реальный
# терминал никуда не делся.
if [ -t 1 ]; then
    IS_TTY=1
    BOLD=$'\033[1m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'; RED=$'\033[31m'; NC=$'\033[0m'
else
    IS_TTY=0
    BOLD=""; CYAN=""; GREEN=""; RED=""; NC=""
fi

NEXUS_DIR="/opt/nexus404"
STATE_DIR="/var/lib/nexus404-hub"
LOGFILE="$STATE_DIR/install.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$STATE_DIR"
touch "$LOGFILE"

# --- Логирование в файл + вывод в терминал — как в install-hub-platform.sh ---
enable_full_logging() {
    exec > >(tee -a "$LOGFILE") 2>&1
}
enable_full_logging

# --- Брайль-спиннер с таймером — тот же код, что в install-hub-platform.sh/
# базовом скрипте (отдельные curl|bash файлы, общий модуль не подключить) ---
_spin_wait() {
    local pid="$1" desc="$2" frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' start elapsed i=0
    start=$(date +%s)
    if [ "$IS_TTY" = "1" ]; then
        while kill -0 "$pid" 2>/dev/null; do
            elapsed=$(( $(date +%s) - start ))
            printf "\r${CYAN}[%s]${NC} %s... (%02d:%02d)  " \
                "${frames:$((i % ${#frames})):1}" "$desc" $((elapsed / 60)) $((elapsed % 60))
            i=$((i + 1))
            sleep 0.1
        done
        printf '\r\033[K'
    else
        wait "$pid" 2>/dev/null
    fi
}

# run_spinner(desc, cmd) — та же сигнатура, что и в остальных двух скриптах.
run_spinner() {
    local desc="$1"; local cmd="$2"
    echo "${CYAN}[*]${NC} ${desc}..."
    setsid bash -c "$cmd" </dev/null >> "$LOGFILE" 2>&1 &
    local pid=$!
    _spin_wait "$pid" "$desc"
    if wait "$pid"; then
        echo "${GREEN}[✓]${NC} ${desc} — готово"
    else
        echo "${RED}[!]${NC} ${desc} — ошибка, подробности в $LOGFILE"
        tail -n 15 "$LOGFILE"
        exit 1
    fi
}

echo "${BOLD}${CYAN}==========================================================================="
echo "  NEXUS404 — обновление хаб-платформы"
echo "===========================================================================${NC}"

# Событие деплоя — общий журнал (event_hook.sh). Trap на EXIT ловит любой
# ненулевой выход; успех шлётся отдельно в конце, не через trap.
HOOK="$NEXUS_DIR/hooks/event_hook.sh"
emit_deploy_event() {
    [ -x "$HOOK" ] && "$HOOK" "$1" "$2" || true
}
trap '
    code=$?
    if [ "$code" -ne 0 ]; then
        emit_deploy_event deploy.update.failed "update.sh завершился с ошибкой (код $code)"
    fi
' EXIT

# ================== Проверка сохранённых данных ==================
echo "${BOLD}${CYAN}==========================================================================="
echo "  Проверка сохранённых данных"
echo "===========================================================================${NC}"
DOMAIN=$(cat "$STATE_DIR/domain" 2>/dev/null || echo "")
AUTH_USER=$(cat "$STATE_DIR/auth_user" 2>/dev/null || echo "")
AUTH_HASH=$(cat "$STATE_DIR/auth_hash" 2>/dev/null || echo "")
SESSION_SECRET=$(cat "$STATE_DIR/session_secret" 2>/dev/null || echo "")
# Необязательный (появился позже) — если не найден, хаб сам подставит
# hostname контейнера (см. metrics.js).
LOCAL_SERVER_NAME=$(cat "$STATE_DIR/local_server_name" 2>/dev/null || echo "")
if [ -z "$DOMAIN" ] || [ -z "$AUTH_USER" ] || [ -z "$AUTH_HASH" ] || [ -z "$SESSION_SECRET" ]; then
    echo "${RED}[!]${NC} Не нашёл сохранённые домен/логин/хэш/секрет ($STATE_DIR) —"
    echo "    похоже, install-hub-platform.sh ещё ни разу не запускался, или"
    echo "    запускался версией до появления страницы входа. Прогони его"
    echo "    заново — уже пройденные шаги не повторятся, отработает только"
    echo "    новый шаг: sudo bash install-hub-platform.sh"
    exit 1
fi

if [ ! -d "$NEXUS_DIR" ]; then
    echo "${RED}[!]${NC} $NEXUS_DIR не существует — хаб-платформа ещё не установлена."
    exit 1
fi
echo "${GREEN}[✓]${NC} Домен: $DOMAIN"

# ================== Обновление файлов ==================
echo "${BOLD}${CYAN}==========================================================================="
echo "  Обновление файлов (хаб, модули, Caddyfile)"
echo "===========================================================================${NC}"

cp "$SCRIPT_DIR/docker-compose.yml" "$NEXUS_DIR/docker-compose.yml"
# basic_auth убран из Caddyfile — только подстановка домена.
sed "s/your-domain\.example\.com/${DOMAIN}/" \
    "$SCRIPT_DIR/Caddyfile" > "$NEXUS_DIR/caddy/Caddyfile"
cp -r "$SCRIPT_DIR/hub/." "$NEXUS_DIR/hub/"

# Экранирование '$' -> '$$' обязательно и для env_file (не только .env) —
# см. подробный комментарий в install-hub-platform.sh на этом же месте.
AUTH_HASH_ESCAPED="${AUTH_HASH//\$/\$\$}"
cat > "$NEXUS_DIR/secrets.env" << ENVEOF
AUTH_USER=${AUTH_USER}
AUTH_HASH=${AUTH_HASH_ESCAPED}
SESSION_SECRET=${SESSION_SECRET}
LOCAL_SERVER_NAME=${LOCAL_SERVER_NAME}
ENVEOF
chmod 600 "$NEXUS_DIR/secrets.env"

# cp -r ничего не удаляет — модули, добавленные вручную на сервере, не трогает.
if [ -d "$SCRIPT_DIR/modules" ]; then
    mkdir -p "$NEXUS_DIR/modules"
    cp -r "$SCRIPT_DIR/modules/." "$NEXUS_DIR/modules/"
fi

# host-bridge — обновляем и перезапускаем, только если уже установлен
# (иначе это задача install-hub-platform.sh).
if [ -f /etc/systemd/system/nexus404-host-bridge.service ]; then
    cp "$SCRIPT_DIR/host-bridge/bridge.py" "$NEXUS_DIR/host-bridge/bridge.py"
    cp "$SCRIPT_DIR/host-bridge/nexus404-host-bridge.service" /etc/systemd/system/nexus404-host-bridge.service
    systemctl daemon-reload
    systemctl restart nexus404-host-bridge.service

    # restart возвращает управление сразу, не дожидаясь готовности сокета —
    # ждём до 15с явно, вторая независимая защита поверх ожидания в хабе
    # (waitForHostBridge в hostBridge.ts). _spin_wait напрямую (не через
    # run_spinner) — тут неготовность лишь предупреждение, не exit 1.
    (
        for _ in $(seq 1 15); do
            systemctl is-active --quiet nexus404-host-bridge.service && exit 0
            sleep 1
        done
        exit 1
    ) &
    bridge_wait_pid=$!
    _spin_wait "$bridge_wait_pid" "Ожидание готовности host-bridge"
    if wait "$bridge_wait_pid"; then
        echo "${GREEN}[✓]${NC} host-bridge обновлён и перезапущен"
    else
        echo "${RED}[!]${NC} host-bridge не поднялся за 15с после перезапуска — модули хаба"
        echo "    могут не запуститься. Проверь: sudo systemctl status nexus404-host-bridge"
    fi
fi

echo "${GREEN}[✓]${NC} Файлы обновлены"

# ================== Пересборка и перезапуск ==================
echo "${BOLD}${CYAN}==========================================================================="
echo "  Пересборка и перезапуск (Caddy + хаб)"
echo "===========================================================================${NC}"

cd "$NEXUS_DIR"
run_spinner "Пересборка образа хаба" "docker compose build hub"

# --force-recreate обязателен: modules/ смонтирован volume'ом, правки в
# модулях не меняют сам образ, без флага Docker не пересоздаст контейнер.
run_spinner "Пересоздание контейнера хаба" "docker compose up -d --force-recreate hub"

# Caddyfile смонтирован volume'ом, Caddy не перечитывает его на лету.
run_spinner "Перезапуск Caddy" "docker compose restart caddy"

echo ""
echo "${BOLD}${GREEN}==========================================================================="
echo "  Обновление завершено"
echo "===========================================================================${NC}"
docker compose ps
echo ""
echo "Проверить: curl https://${DOMAIN}/health"

emit_deploy_event deploy.update.completed "код обновлён, hub и caddy пересозданы"
