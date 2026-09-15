#!/bin/bash
# =============================================================================
# NEXUS404 — установка Docker + Caddy + скелет хаба
#
# Запускать ПОСЛЕ базовой настройки сервера (00-base-server). Ставит Docker
# Engine, сеть, Caddy (HTTPS) и хаб (Fastify/TypeScript) через docker compose.
#
# Использование:
#   sudo bash install-hub-platform.sh
# =============================================================================

set -uo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Запусти от root (или через sudo)."
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C.UTF-8 2>/dev/null || export LC_ALL=en_US.UTF-8 2>/dev/null || true

# IS_TTY запоминаем СЕЙЧАС, до enable_full_logging ниже — тот делает
# exec > >(tee ...), после чего [ -t 1 ] всегда лжёт (stdout стал
# каналом в tee), хотя реальный терминал никуда не делся. Без этого
# _spin_wait решил бы, что терминала нет, и молча отключил бы
# анимацию/таймер спиннера на весь остаток скрипта.
if [ -t 1 ]; then
    IS_TTY=1
    BOLD=$'\033[1m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'
    RED=$'\033[31m'; YELLOW=$'\033[33m'; NC=$'\033[0m'
else
    IS_TTY=0
    BOLD=""; CYAN=""; GREEN=""; RED=""; YELLOW=""; NC=""
fi

NEXUS_DIR="/opt/nexus404"
STATE_DIR="/var/lib/nexus404-hub"
STATEFILE="$STATE_DIR/state"
LOGFILE="$STATE_DIR/install.log"
mkdir -p "$STATE_DIR"
touch "$STATEFILE" "$LOGFILE"

# --- Логирование в файл + вывод в терминал, как в базовом скрипте ---
enable_full_logging() {
    exec > >(tee -a "$LOGFILE") 2>&1
}
enable_full_logging

is_done() {
    grep -qxF "$1" "$STATEFILE" 2>/dev/null
}
mark_done() {
    echo "$1" >> "$STATEFILE"
}

check_or_fail() {
    local desc="$1"; shift
    echo "${CYAN}[*]${NC} ${desc}..."
    setsid "$@" </dev/null >> "$LOGFILE" 2>&1 &
    local pid=$!
    _spin_wait "$pid" "$desc"
    if wait "$pid"; then
        echo "${GREEN}[✓]${NC} ${desc} — готово"
    else
        echo "${RED}[!]${NC} Ошибка: $desc — подробности в $LOGFILE"
        tail -n 15 "$LOGFILE"
        exit 1
    fi
}

# --- Брайль-спиннер с таймером — не забирает статус (kill -0 не "съедает"
# exit-код), реальный wait "$pid" делает вызывающая функция один раз ---
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
        # Не терминал (лог-файл, CI) — анимация ни к чему, просто ждём
        wait "$pid" 2>/dev/null
    fi
}

# run_spinner(desc, cmd) — спиннер + лог, выход 1 при ошибке.
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

# То же, но с захватом stdout (VAR=$(...)) — статус/анимация идут в
# stderr, чтобы не попасть в переменную вместе с результатом команды.
run_spinner_capture() {
    local desc="$1"; local cmd="$2"
    local tmpfile
    tmpfile=$(mktemp)
    {
        echo "${CYAN}[*]${NC} ${desc}..."
        bash -c "$cmd" > "$tmpfile" 2>>"$LOGFILE" &
        local pid=$!
        _spin_wait "$pid" "$desc"
        if wait "$pid"; then
            echo "${GREEN}[✓]${NC} ${desc} — готово"
        else
            echo "${RED}[!]${NC} ${desc} — ошибка, подробности в $LOGFILE"
            tail -n 15 "$LOGFILE"
            rm -f "$tmpfile"
            exit 1
        fi
    } >&2
    cat "$tmpfile"
    rm -f "$tmpfile"
}

echo "${BOLD}${CYAN}==========================================================================="
echo "  NEXUS404 — установка Docker + Caddy + скелет хаба"
echo "===========================================================================${NC}"

# ================== ШАГ 1: Docker Engine ==================
if is_done "hub_1_docker"; then
    echo "${CYAN}[*]${NC} Docker уже установлен, пропуск"
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 1: Docker Engine"
    echo "===========================================================================${NC}"

    if command -v docker >/dev/null 2>&1; then
        echo "${CYAN}[*]${NC} Docker уже присутствует в системе"
    else
        run_spinner "Установка зависимостей" "apt-get install -y ca-certificates curl gnupg"
        install -m 0755 -d /etc/apt/keyrings
        run_spinner "Загрузка GPG-ключа Docker" \
            "curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc"
        chmod a+r /etc/apt/keyrings/docker.asc

        . /etc/os-release
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
            > /etc/apt/sources.list.d/docker.list

        run_spinner "Обновление списка пакетов" "apt-get update"
        run_spinner "Установка Docker Engine + Compose plugin" \
            "apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
    fi

    check_or_fail "включение docker в автозагрузку" systemctl enable --now docker

    # Sudo-пользователь — в группу docker, чтобы не работать от root.
    HUB_USER=$(cat /var/lib/nexus404-base/sudo_user 2>/dev/null || echo "")
    if [ -n "$HUB_USER" ] && id "$HUB_USER" >/dev/null 2>&1; then
        usermod -aG docker "$HUB_USER"
        echo "${GREEN}[✓]${NC} Пользователь '$HUB_USER' добавлен в группу docker"
        echo "    (перелогиниться, чтобы это применилось в текущей сессии)"
    fi

    echo "${GREEN}[✓]${NC} Docker: $(docker --version)"
    mark_done "hub_1_docker"
fi

# ================== ШАГ 2: структура каталогов + сеть ==================
if is_done "hub_2_structure"; then
    echo "${CYAN}[*]${NC} Структура каталогов уже создана, пропуск"
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 2: структура каталогов + docker-сеть"
    echo "===========================================================================${NC}"

    mkdir -p "$NEXUS_DIR"/{hub,modules,data,caddy/data,caddy/config,hooks/events}
    chmod 700 "$NEXUS_DIR/hooks/events"
    echo "${GREEN}[✓]${NC} Каталоги созданы: $NEXUS_DIR/{hub,modules,data,caddy,hooks}"

    if docker network inspect nexus404 >/dev/null 2>&1; then
        echo "${CYAN}[*]${NC} Сеть nexus404 уже существует"
    else
        check_or_fail "создание docker-сети nexus404" docker network create nexus404
    fi

    mark_done "hub_2_structure"
fi

# ================== ШАГ 2b: общий механизм событий (хуки) ==================
if is_done "hub_2b_hooks"; then
    echo "${CYAN}[*]${NC} Хук-механизм уже установлен, пропуск"
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 2b: общий механизм событий (хуки)"
    echo "===========================================================================${NC}"
    echo "${CYAN}[*]${NC} Любой код может записать событие любого типа —"
    echo "    не список из заранее придуманных."

    cat > "$NEXUS_DIR/hooks/event_hook.sh" << 'HOOKEOF'
#!/usr/bin/env bash
# NEXUS404 — общий механизм событий
# Использование: event_hook.sh <тип.события> "детали в свободной форме"
# Хранение — простой добавляемый журнал (JSONL). Тот же файл читает хаб
# (см. EVENTS_LOG в hub/src/index.ts) — один общий журнал, не два разных.
set -euo pipefail
EVENT_TYPE="${1:?Использование: event_hook.sh <тип.события> [детали]}"
DETAILS="${2:-}"
LOG_DIR="/opt/nexus404/hooks/events"
LOG_FILE="${LOG_DIR}/events.jsonl"
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
ESCAPED_DETAILS=$(printf '%s' "$DETAILS" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n')
printf '{"type":"%s","time":"%s","details":"%s"}\n' \
    "$EVENT_TYPE" "$TIMESTAMP" "$ESCAPED_DETAILS" >> "$LOG_FILE"
HOOKEOF
    chmod 755 "$NEXUS_DIR/hooks/event_hook.sh"

    cat > /etc/logrotate.d/nexus404-hooks << 'EOF'
/opt/nexus404/hooks/events/events.jsonl {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    copytruncate
}
EOF
    echo "${GREEN}[✓]${NC} Хук установлен: $NEXUS_DIR/hooks/event_hook.sh"

    # --- Подключаем к уже существующим конфигам базовой настройки ---
    HOOK="$NEXUS_DIR/hooks/event_hook.sh"
    WIRED=0

    if [ -f /etc/fail2ban/jail.local ]; then
        cat > /etc/fail2ban/action.d/nexus404-hook.conf << EOF
[Definition]
actionban = ${HOOK} security.fail2ban.ban "IP=<ip> jail=<name>"
actionunban = ${HOOK} security.fail2ban.unban "IP=<ip> jail=<name>"
EOF
        if ! grep -q "nexus404-hook" /etc/fail2ban/jail.local; then
            sed -i '/^\[sshd\]/a action = %(action_)s\n         nexus404-hook' /etc/fail2ban/jail.local
        fi
        systemctl restart fail2ban >> "$LOGFILE" 2>&1 || true
        echo "${GREEN}[✓]${NC} fail2ban подключён к хукам (security.fail2ban.ban/unban)"
        WIRED=$((WIRED + 1))
    fi

    UU_CONF="/etc/apt/apt.conf.d/51-deploy-kit-security-only.conf"
    if [ -f "$UU_CONF" ] && ! grep -q "nexus404" "$UU_CONF"; then
        echo "Unattended-Upgrade::Post-Invoke-Success { \"${HOOK} system.update.completed 'unattended-upgrades finished' || true\"; };" >> "$UU_CONF"
        echo "${GREEN}[✓]${NC} unattended-upgrades подключён к хукам (system.update.completed)"
        WIRED=$((WIRED + 1))
    fi

    REBOOT_CRON="/etc/cron.d/deploy_kit_weekly_reboot"
    if [ -f "$REBOOT_CRON" ] && ! grep -q "nexus404" "$REBOOT_CRON"; then
        sed -i "s#root /sbin/shutdown -r now#root ${HOOK} system.reboot.scheduled 'weekly planned reboot' ; /sbin/shutdown -r now#" "$REBOOT_CRON"
        echo "${GREEN}[✓]${NC} Плановый рестарт подключён к хукам (system.reboot.scheduled)"
        WIRED=$((WIRED + 1))
    fi

    CLEANUP_SCRIPT="/usr/local/bin/deploy_kit_cleanup.sh"
    if [ -f "$CLEANUP_SCRIPT" ] && ! grep -q "nexus404" "$CLEANUP_SCRIPT"; then
        echo "${HOOK} system.cleanup.completed 'apt autoremove/autoclean, journal vacuum, old logs' || true" >> "$CLEANUP_SCRIPT"
        echo "${GREEN}[✓]${NC} Автоочистка подключена к хукам (system.cleanup.completed)"
        WIRED=$((WIRED + 1))
    fi

    HC_SCRIPT="/usr/local/bin/deploy_kit_healthcheck.sh"
    if [ -f "$HC_SCRIPT" ] && ! grep -q "nexus404" "$HC_SCRIPT"; then
        echo "${HOOK} system.healthcheck.completed \"failed_units=\${FAILED:-0} disk=\${DISK_PCT:-?}% mem=\${MEM_PCT:-?}%\" || true" >> "$HC_SCRIPT"
        echo "${GREEN}[✓]${NC} Health-checker подключён к хукам (system.healthcheck.completed)"
        WIRED=$((WIRED + 1))
    fi

    if [ "$WIRED" -eq 0 ]; then
        echo "${YELLOW}[?]${NC} Не нашёл конфигов базовой настройки для подключения —"
        echo "    возможно, 00-base-server ещё не запускался. Хук-механизм всё"
        echo "    равно установлен и готов к использованию хабом напрямую."
    fi

    # Событие "перезагрузился" (не "запланирован", это уже выше) —
    # systemd oneshot при каждой загрузке ОС, честный факт постфактум.
    cat > /etc/systemd/system/nexus404-boot-event.service << EOF
[Unit]
Description=NEXUS404 — событие "сервер перезагрузился" (один раз при загрузке)
After=network.target

[Service]
Type=oneshot
ExecStart=${HOOK} system.reboot.completed "server boot"

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable nexus404-boot-event.service >> "$LOGFILE" 2>&1 || true
    echo "${GREEN}[✓]${NC} Событие \"сервер перезагрузился\" подключено (system.reboot.completed,"
    echo "    срабатывает при каждой загрузке ОС)"

    mark_done "hub_2b_hooks"
fi

# ================== ШАГ 3: Настройка хаба (домен, вход, имя сервера) ==================
# Раньше это было три отдельных псевдо-шага (3/3b/3c) — искусственное
# дробление одного и того же дела ("собрать настройки перед установкой").
# Совместимость: если старые флаги уже отмечены на уже настроенном
# сервере (до этого объединения) — считаем шаг пройденным, не спрашиваем
# заново то, что уже сохранено на диске.
if is_done "hub_3_setup" || { is_done "hub_3_domain" && is_done "hub_3b_auth" && is_done "hub_3c_server_name"; }; then
    is_done "hub_3_setup" || mark_done "hub_3_setup"
    echo "${CYAN}[*]${NC} Настройка хаба уже выполнена, пропуск"
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 3: Настройка хаба (домен, вход, имя сервера)"
    echo "===========================================================================${NC}"

    DOMAIN="${PRESET_DOMAIN:-}"
    while [ -z "$DOMAIN" ]; do
        read -rp "${YELLOW}[?]${NC} Домен, указывающий на этот сервер (например hub.example.com): " DOMAIN < /dev/tty || { echo "${RED}[!]${NC} Не удалось прочитать ввод"; exit 1; }
        if [[ ! "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$ ]]; then
            echo "${RED}[!]${NC} Не похоже на домен (например hub.example.com), попробуй снова"
            DOMAIN=""
        fi
    done
    echo "$DOMAIN" > "$STATE_DIR/domain"
    echo "${GREEN}[✓]${NC} Домен: $DOMAIN"

    echo "${CYAN}[*]${NC} Логин/пароль для входа в хаб (тот же хэш — и временная"
    echo "    защита через Caddy, если понадобится включить снова)."

    AUTH_USER="${PRESET_AUTH_USER:-}"
    while [ -z "$AUTH_USER" ]; do
        read -rp "${YELLOW}[?]${NC} Логин: " AUTH_USER < /dev/tty || { echo "${RED}[!]${NC} Не удалось прочитать ввод"; exit 1; }
    done

    # Минимум 8 символов + повтор — раньше пароль спрашивался один раз
    # без проверки длины, опечатка в пароле обнаруживалась только на
    # первом реальном входе. PRESET_AUTH_PASSWORD (полная автоматизация)
    # короче 8 символов — отбрасываем и спрашиваем как обычно, не падаем.
    AUTH_PASS="${PRESET_AUTH_PASSWORD:-}"
    if [ -n "$AUTH_PASS" ] && [ "${#AUTH_PASS}" -lt 8 ]; then
        echo "${YELLOW}[?]${NC} PRESET_AUTH_PASSWORD короче 8 символов — игнорирую, спрошу вручную"
        AUTH_PASS=""
    fi
    while [ -z "$AUTH_PASS" ]; do
        read -rsp "${YELLOW}[?]${NC} Пароль (минимум 8 символов): " AUTH_PASS < /dev/tty; echo ""
        if [ "${#AUTH_PASS}" -lt 8 ]; then
            echo "${RED}[!]${NC} Пароль короче 8 символов, попробуй снова"
            AUTH_PASS=""
            continue
        fi
        read -rsp "${YELLOW}[?]${NC} Повтори пароль: " AUTH_PASS_CONFIRM < /dev/tty; echo ""
        if [ "$AUTH_PASS" != "$AUTH_PASS_CONFIRM" ]; then
            echo "${RED}[!]${NC} Пароли не совпадают, попробуй снова"
            AUTH_PASS=""
        fi
    done
    unset AUTH_PASS_CONFIRM

    # Хэш считает Caddy (bcrypt) через одноразовый контейнер. Пароль — через
    # переменную окружения, не в строке команды (спецсимволы могли бы сломать её).
    export AUTH_PASS
    AUTH_HASH=$(run_spinner_capture "Вычисление хэша пароля" 'docker run --rm caddy:2-alpine caddy hash-password --plaintext "$AUTH_PASS"')
    unset AUTH_PASS
    if [ -z "$AUTH_HASH" ]; then
        echo "${RED}[!]${NC} Не удалось посчитать хэш пароля"
        exit 1
    fi

    echo "$AUTH_USER" > "$STATE_DIR/auth_user"
    echo "$AUTH_HASH" > "$STATE_DIR/auth_hash"
    chmod 600 "$STATE_DIR/auth_user" "$STATE_DIR/auth_hash"
    echo "${GREEN}[✓]${NC} Логин/пароль сохранены (пароль — только как bcrypt-хэш)"

    DEFAULT_SERVER_NAME="$(hostname 2>/dev/null || echo server)"
    LOCAL_SERVER_NAME="${PRESET_LOCAL_SERVER_NAME:-}"
    if [ -z "$LOCAL_SERVER_NAME" ]; then
        read -rp "${YELLOW}[?]${NC} Имя этого сервера в списке мониторинга [${DEFAULT_SERVER_NAME}]: " LOCAL_SERVER_NAME < /dev/tty || { echo "${RED}[!]${NC} Не удалось прочитать ввод"; exit 1; }
    fi
    LOCAL_SERVER_NAME="${LOCAL_SERVER_NAME:-$DEFAULT_SERVER_NAME}"
    echo "$LOCAL_SERVER_NAME" > "$STATE_DIR/local_server_name"
    echo "${GREEN}[✓]${NC} Имя сервера: $LOCAL_SERVER_NAME"

    echo "${GREEN}[✓]${NC} Шаг 3 завершён успешно"
    mark_done "hub_3_setup"
fi
DOMAIN=$(cat "$STATE_DIR/domain" 2>/dev/null || echo "")
AUTH_USER=$(cat "$STATE_DIR/auth_user" 2>/dev/null || echo "")
AUTH_HASH=$(cat "$STATE_DIR/auth_hash" 2>/dev/null || echo "")
LOCAL_SERVER_NAME=$(cat "$STATE_DIR/local_server_name" 2>/dev/null || echo "")

# Секрет сессий — вне блока is_done "hub_3_setup": на уже настроенных
# установках тот шаг мог пройти ещё до появления страницы входа.
if [ ! -f "$STATE_DIR/session_secret" ]; then
    echo "${CYAN}[*]${NC} Генерирую секрет для сессий хаба..."
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32 > "$STATE_DIR/session_secret"
    else
        head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$STATE_DIR/session_secret"
    fi
    chmod 600 "$STATE_DIR/session_secret"
    echo "${GREEN}[✓]${NC} Секрет сессий сгенерирован"
fi
SESSION_SECRET=$(cat "$STATE_DIR/session_secret" 2>/dev/null || echo "")

# ================== ШАГ 4: файлы хаба и Caddy ==================
if is_done "hub_4_files"; then
    echo "${CYAN}[*]${NC} Файлы хаба и Caddy уже на месте, пропуск"
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 4: файлы хаба и Caddy"
    echo "===========================================================================${NC}"
    echo "${YELLOW}[?]${NC} Ожидается, что этот скрипт лежит рядом с docker-compose.yml,"
    echo "    Caddyfile и папкой hub/ (из репозитория) — копирую их в $NEXUS_DIR"

    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    for f in docker-compose.yml Caddyfile; do
        if [ ! -f "$SCRIPT_DIR/$f" ]; then
            echo "${RED}[!]${NC} Не найден $SCRIPT_DIR/$f — проверь, что запускаешь из"
            echo "    склонированного репозитория, не отдельно скачанным файлом"
            exit 1
        fi
    done
    if [ ! -d "$SCRIPT_DIR/hub" ]; then
        echo "${RED}[!]${NC} Не найдена папка $SCRIPT_DIR/hub — то же самое, нужен весь репозиторий"
        exit 1
    fi

    cp "$SCRIPT_DIR/docker-compose.yml" "$NEXUS_DIR/docker-compose.yml"
    # Домен подставляется автоматически, basic_auth убран из Caddyfile.
    sed "s/your-domain\.example\.com/${DOMAIN}/" \
        "$SCRIPT_DIR/Caddyfile" > "$NEXUS_DIR/caddy/Caddyfile"
    cp -r "$SCRIPT_DIR/hub/." "$NEXUS_DIR/hub/"

    # Docker Compose интерполирует ${переменная} даже в env_file — AUTH_HASH
    # (bcrypt) содержит '$', без экранирования часть хэша обрежется. '$$' —
    # способ Compose записать буквальный '$'.
    AUTH_HASH_ESCAPED="${AUTH_HASH//\$/\$\$}"
    cat > "$NEXUS_DIR/secrets.env" << ENVEOF
AUTH_USER=${AUTH_USER}
AUTH_HASH=${AUTH_HASH_ESCAPED}
SESSION_SECRET=${SESSION_SECRET}
LOCAL_SERVER_NAME=${LOCAL_SERVER_NAME}
ENVEOF
    chmod 600 "$NEXUS_DIR/secrets.env"
    echo "${GREEN}[✓]${NC} secrets.env создан ($NEXUS_DIR/secrets.env)"

    # Стартовые модули — копируются один раз. Новые модули дальше
    # добавляются на сервер вручную, хаб подхватит их сканированием.
    if [ -d "$SCRIPT_DIR/modules" ]; then
        mkdir -p "$NEXUS_DIR/modules"
        cp -r "$SCRIPT_DIR/modules/." "$NEXUS_DIR/modules/"
        echo "${GREEN}[✓]${NC} Стартовые модули скопированы в $NEXUS_DIR/modules"
    fi

    echo "${GREEN}[✓]${NC} Файлы скопированы в $NEXUS_DIR (Caddyfile — с доменом $DOMAIN)"

    mark_done "hub_4_files"
fi

# ================== ШАГ 4b: host-bridge (мост к хосту) ==================
if is_done "hub_4b_bridge"; then
    echo "${CYAN}[*]${NC} host-bridge уже установлен, пропуск"
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 4b: host-bridge (мост к хосту)"
    echo "===========================================================================${NC}"
    echo "${CYAN}[*]${NC} Хаб в контейнере не может выполнить действие на"
    echo "    уровне хоста напрямую — этот демон на хосте делает это за"
    echo "    него, со своим независимым белым списком (двойная защита)."

    command -v python3 >/dev/null 2>&1 || run_spinner "Установка python3" "apt-get install -y python3"

    mkdir -p "$NEXUS_DIR/host-bridge"
    cp "$SCRIPT_DIR/host-bridge/bridge.py" "$NEXUS_DIR/host-bridge/bridge.py"
    chmod 700 "$NEXUS_DIR/host-bridge/bridge.py"

    cp "$SCRIPT_DIR/host-bridge/nexus404-host-bridge.service" /etc/systemd/system/nexus404-host-bridge.service
    systemctl daemon-reload
    check_or_fail "включение host-bridge" systemctl enable --now nexus404-host-bridge.service

    sleep 1
    if [ -S "$NEXUS_DIR/host-bridge.sock" ]; then
        echo "${GREEN}[✓]${NC} host-bridge слушает $NEXUS_DIR/host-bridge.sock"
    else
        echo "${RED}[!]${NC} Сокет не появился — проверь: systemctl status nexus404-host-bridge"
        exit 1
    fi

    mark_done "hub_4b_bridge"
fi

# ================== ШАГ 5: сборка и запуск ==================
if is_done "hub_5_up"; then
    echo "${CYAN}[*]${NC} Контейнеры уже поднимались этим скриптом, пропуск"
    echo "${CYAN}[*]${NC} Для обновления после правок: cd $NEXUS_DIR && docker compose up -d --build"
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 5: сборка и запуск (Caddy + хаб)"
    echo "===========================================================================${NC}"
    echo "${CYAN}[*]${NC} Управление контейнерами модулей идёт через host-bridge,"
    echo "    без прямого docker.sock у хаба."
    cd "$NEXUS_DIR"
    run_spinner "Сборка и запуск контейнеров" "docker compose up -d --build"

    echo "${CYAN}[*]${NC} Жду, пока хаб поднимется..."
    sleep 3
    if docker compose exec -T hub wget -qO- http://localhost:3000/health >> "$LOGFILE" 2>&1; then
        echo "${GREEN}[✓]${NC} Хаб отвечает на /health изнутри контейнера"
    else
        echo "${YELLOW}[?]${NC} Хаб пока не ответил на /health — может, ещё стартует."
        echo "    Проверь вручную: docker compose logs hub"
    fi

    mark_done "hub_5_up"
fi

echo ""
echo "${BOLD}${GREEN}==========================================================================="
echo "  Docker + Caddy + скелет хаба подняты"
echo "===========================================================================${NC}"
echo "Домен:          $DOMAIN"
echo "Каталог:        $NEXUS_DIR"
echo "Логи установки: $LOGFILE"
echo ""
echo "Проверить снаружи (после того как DNS домена указывает на этот сервер):"
echo "    curl https://${DOMAIN}/health"
echo ""
echo "${YELLOW}[?]${NC} Caddyfile сейчас настроен на STAGING Let's Encrypt (браузер будет"
echo "    ругаться на сертификат) — это временно, на время отладки. TODO явно"
echo "    помечен внутри $NEXUS_DIR/caddy/Caddyfile."
echo ""
echo "Полезные команды:"
echo "    cd $NEXUS_DIR && docker compose ps"
echo "    cd $NEXUS_DIR && docker compose logs -f hub"
echo "    cd $NEXUS_DIR && docker compose logs -f caddy"
