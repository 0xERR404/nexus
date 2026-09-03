#!/bin/bash
# =============================================================================
# NEXUS404 — базовая настройка сервера (самодостаточный установщик)
#
# DNS, swap+BBR, обновления, auditd, sudo-пользователь + блокировка root,
# SSH-порт + firewall, способ входа, fail2ban, apparmor, таймзона+NTP,
# лимиты, автообновления+cron, health-checker, финальная проверка. Это
# база, поверх которой дальше разворачивается хаб NEXUS404 (Docker+Caddy).
#
# Использование:
#   curl -fsSL <raw-url-этого-файла> | bash
#   или просто: bash nexus404-base-setup.sh
#
# Прогресс сохраняется в STATEFILE — можно прервать и запустить заново,
# уже пройденные шаги не повторяются.
# =============================================================================

set -uo pipefail
# Без set -e: часть шагов сама решает при ошибке (check_or_fail/retry_apt
# с явным exit), часть команд ожидаемо не нулевая в условиях (grep -q) —
# не повод падать всем скриптом.

if [[ $EUID -ne 0 ]]; then
    echo "Запусти от root (sudo bash nexus404-base-setup.sh)."
    exit 1
fi

# Без этого apt может упереться в интерактивный вопрос об изменённых
# конфигах — при curl | bash stdin для ответа недоступен, apt падает.
export DEBIAN_FRONTEND=noninteractive

# C/POSIX-локаль по умолчанию считает длину строки в байтах, не символах —
# кириллица (2 байта/символ) выравнивается криво. C.UTF-8 есть из коробки.
export LC_ALL=C.UTF-8 2>/dev/null || export LC_ALL=en_US.UTF-8 2>/dev/null || true

DK_VERSION="1.0.0"

# --- Цвета (без цвета, если вывод не в терминал — например, в лог-файл) ---
if [ -t 1 ]; then
    BOLD=$'\033[1m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'
    RED=$'\033[31m'; YELLOW=$'\033[33m'; NC=$'\033[0m'
else
    BOLD=""; CYAN=""; GREEN=""; RED=""; YELLOW=""; NC=""
fi

# --- Состояние и пути ---
DK_DIR="/var/lib/nexus404-base"
mkdir -p "$DK_DIR"
STATEFILE="$DK_DIR/state"
FLAGFILE="$DK_DIR/installed.flag"
LOGFILE="$DK_DIR/install.log"
HEALTHLOG="$DK_DIR/health.log"
USERFILE="$DK_DIR/sudo_user"
PORTFILE="$DK_DIR/ssh_port"
AUTHMETHODFILE="$DK_DIR/auth_method"
SSHD_CONFIG="/etc/ssh/sshd_config"
FIELD_WIDTH=22

touch "$STATEFILE" "$LOGFILE"
chmod 600 "$STATEFILE" "$LOGFILE"

# --- Полное логирование в файл, вывод в терминал сохраняется как есть ---
enable_full_logging() {
    exec > >(tee -a "$LOGFILE") 2>&1
}

# --- Прогресс по шагам ---
is_done() {
    grep -qxF "$1" "$STATEFILE" 2>/dev/null
}
mark_done() {
    echo "$1" >> "$STATEFILE"
}

# --- Выполнить команду, при ошибке — понятное сообщение и стоп ---
# Использование: check_or_fail "описание" команда аргументы...
check_or_fail() {
    local desc="$1"; shift
    if "$@" >> "$LOGFILE" 2>&1; then
        return 0
    else
        echo "${RED}[!]${NC} Ошибка: $desc"
        echo "    Подробности — в конце $LOGFILE"
        tail -n 15 "$LOGFILE"
        exit 1
    fi
}

# --- Брайль-спиннер с таймером — не забирает статус (kill -0 не "съедает"
# exit-код), реальный wait "$pid" делает вызывающая функция один раз ---
_spin_wait() {
    local pid="$1" desc="$2" frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' start elapsed i=0
    start=$(date +%s)
    if [ -t 1 ]; then
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

# --- То же самое, но с "крутилкой"-статусом и явным сообщением об успехе ---
# Использование: run_spinner "описание" "команда одной строкой"
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

# --- apt с повторными попытками (сеть иногда моргает) ---
# Использование: retry_apt "описание" "apt-команда одной строкой"
retry_apt() {
    local desc="$1"; local cmd="$2"; local tries=0; local max=3
    echo "${CYAN}[*]${NC} ${desc}..."
    while true; do
        setsid bash -c "$cmd" </dev/null >> "$LOGFILE" 2>&1 &
        local pid=$!
        _spin_wait "$pid" "$desc"
        if wait "$pid"; then
            echo "${GREEN}[✓]${NC} ${desc} — готово"
            return 0
        fi
        tries=$((tries + 1))
        if [ "$tries" -ge "$max" ]; then
            echo "${RED}[!]${NC} ${desc} — не удалось после ${max} попыток"
            tail -n 15 "$LOGFILE"
            exit 1
        fi
        echo "${YELLOW}[?]${NC} Попытка ${tries} не удалась, жду 3с и пробую снова..."
        sleep 3
    done
}

# --- Пауза с обязательным подтверждением человеком (из /dev/tty — работает
# и при curl | bash). Отказ просто завершает скрипт, ничего не откатывая. ---
confirm_or_exit() {
    local prompt="$1"; local abort_msg="$2"; local answer=""
    echo ""
    read -rp "${YELLOW}[?]${NC} ${prompt} (yes/no): " answer < /dev/tty
    if [ "$answer" != "yes" ] && [ "$answer" != "y" ]; then
        echo "${RED}[!]${NC} ${abort_msg}"
        exit 1
    fi
}

read_or_default() {
    if [ -f "$1" ] && [ -s "$1" ]; then cat "$1"; else echo "$2"; fi
}

pad_field() {
    # Считаем длину в символах (${#s}), не байтах — иначе кириллица
    # (2 байта/символ) получала бы меньше пробивок при выравнивании.
    local s="$1" width="$2" len pad
    len=${#s}
    pad=$((width - len))
    [ "$pad" -lt 0 ] && pad=0
    printf '%s%*s' "$s" "$pad" ""
}

check_disk_space() {
    local need_mb="$1"
    local free_mb
    free_mb=$(df -Pm / | awk 'NR==2{print $4}')
    [ "$free_mb" -ge "$need_mb" ]
}

# --- Строка отчёта в финальной проверке (шаг 14) ---
check_item() {
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then
        echo "${GREEN}[✓]${NC}  $desc"
    else
        echo "${RED}[!]${NC}  $desc"
        CHECK_FAILED=$((CHECK_FAILED + 1))
    fi
}

enable_full_logging

echo "${BOLD}${CYAN}==========================================================================="
echo "  БАЗОВАЯ НАСТРОЙКА СЕРВЕРА"
echo "===========================================================================${NC}"

TOTAL_STEPS=15
DONE_COUNT=$(grep -c '^step1_' "$STATEFILE" 2>/dev/null || true)
DONE_COUNT="${DONE_COUNT:-0}"

if [ -f "$FLAGFILE" ] && [ "$DONE_COUNT" -ge "$TOTAL_STEPS" ]; then
    FLAG_DATE=$(grep -oP '(?<=INSTALLED_AT=)[0-9-]+' "$FLAGFILE" 2>/dev/null)
    echo "${CYAN}[*]${NC} Сервер уже настраивался этим скриптом ($FLAG_DATE)"
elif [ "$DONE_COUNT" -gt 0 ]; then
    echo "${CYAN}[*]${NC} Найден файл состояния: пройдено $DONE_COUNT из $TOTAL_STEPS шагов, продолжаем"
fi
echo ""

# перезапуск sshd — специфично для этого модуля, живёт здесь
restart_ssh() {
    # /run/sshd нужен для privilege separation — без него sshd -t падает
    # ложной ошибкой, даже если конфиг корректен.
    mkdir -p /run/sshd

    # Проверка синтаксиса ДО перезапуска — битый конфиг после restart
    # оборвал бы SSH без возможности откатиться удалённо.
    if ! sshd -t 2>>"$LOGFILE"; then
        echo "${RED}[!]${NC} Конфиг sshd не проходит проверку синтаксиса (sshd -t) —"
        echo "    перезапуск ОТМЕНЁН"
        echo "    Служба SSH не тронута, чтобы не потерять доступ. Проверьте"
        echo "    бэкап: ${SSHD_CONFIG}.bak.*"
        echo "${RED}[!]${NC} --- вывод sshd -t (последние строки лога) ---"
        tail -n 15 "$LOGFILE"
        exit 1
    fi

    local target_port
    target_port=$(grep -E "^Port " "$SSHD_CONFIG" | awk '{print $2}')
    target_port=${target_port:-22}

    # На Ubuntu 24.04 ssh.socket слушает порт НЕЗАВИСИМО от службы — обычный
    # restart не освобождает его. Выключаем сокет ВСЕГДА первым шагом.
    if systemctl list-unit-files 2>/dev/null | grep -q '^ssh\.socket'; then
        echo "${CYAN}[*]${NC} Обнаружен ssh.socket — выключаю его перед сменой порта"
        systemctl stop ssh.socket >> "$LOGFILE" 2>&1 || true
        systemctl disable ssh.socket >> "$LOGFILE" 2>&1 || true
    fi

    run_spinner "Запуск SSH-службы на порту $target_port" \
        "systemctl enable --now ssh.service >> \"$LOGFILE\" 2>&1 || systemctl enable --now sshd.service >> \"$LOGFILE\" 2>&1 || systemctl restart sshd || systemctl restart ssh"

    sleep 1
    if ss -tln 2>/dev/null | grep -q ":${target_port} "; then
        echo "${GREEN}[✓]${NC} Порт $target_port слушается"
        return 0
    fi

    echo "${RED}[!]${NC} Порт $target_port не слушается — проверь вручную:"
    echo "    systemctl status sshd ssh ssh.socket"
    echo "    journalctl -u sshd -u ssh -u ssh.socket --no-pager | tail -30"
}

# ================== ШАГ 1 ==================
if is_done "step1_1"; then
    :
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 1: DNS-серверы"
    echo "===========================================================================${NC}"

    if ! command -v ping >/dev/null 2>&1; then
        retry_apt "Установка ping" "apt-get install -y iputils-ping"
    fi

    if ! ping -c1 -W2 8.8.8.8 >/dev/null 2>&1; then
        echo "${YELLOW}[?]${NC} Не вижу интернета (8.8.8.8 не отвечает) — DNS-провайдеры"
        echo "    могут показать 'н/д'."
        echo "    Проверьте сеть, если что-то пойдёт не так на следующих шагах."
    fi

    echo "${CYAN}[*]${NC} Проверяю доступность и скорость DNS-серверов..."
    echo ""

    # measure_ping <ip> — среднее время в мс (число) или пусто, если недоступен
    measure_ping() {
        ping -c 3 -W 1 "$1" 2>/dev/null | tail -1 | awk -F'= ' '{print $2}' | cut -d/ -f2
    }

    # формат записи: Имя:IP1:IP2
    DNS_LIST=(
        "Яндекс.DNS:77.88.8.8:77.88.8.1"
        "Google:8.8.8.8:8.8.4.4"
        "Cloudflare:1.1.1.1:1.0.0.1"
    )

    PINGS=()
    for entry in "${DNS_LIST[@]}"; do
        ip1="${entry#*:}"; ip1="${ip1%%:*}"
        PINGS+=("$(measure_ping "$ip1")")
    done

    for i in "${!DNS_LIST[@]}"; do
        name="${DNS_LIST[$i]%%:*}"
        rest="${DNS_LIST[$i]#*:}"
        if [ -n "${PINGS[$i]}" ]; then
            ping_disp=$(printf "%6s мс" "${PINGS[$i]}")
        else
            ping_disp=$(printf "%6s   " "н/д")
        fi
        ip_str="(${rest/:/, })"
        printf "  %d) %s %s   — %s\n" "$((i+1))" "$(pad_field "$name" 18)" "$(pad_field "$ip_str" 24)" "$ping_disp"
        sleep 0.2
    done
    echo ""

    DNS1=""
    # DNS_CHOICE можно задать заранее переменной окружения (1-3) — тогда
    # вопрос не задаётся вообще.
    while [ -z "$DNS1" ]; do
        if [ -n "${DNS_CHOICE:-}" ]; then
            :
        else
            read -rp "${YELLOW}[?]${NC} Выберите вариант (1-3): " DNS_CHOICE < /dev/tty || { echo "${RED}[!]${NC} Не удалось прочитать ввод"; exit 1; }
        fi
        if [[ "$DNS_CHOICE" =~ ^[1-3]$ ]]; then
            rest="${DNS_LIST[$((DNS_CHOICE-1))]#*:}"
            DNS1="${rest%%:*}"
            DNS2="${rest#*:}"
        else
            echo "${RED}[!]${NC} Введите 1, 2 или 3"
            unset DNS_CHOICE
        fi
    done
    echo "${CYAN}[*]${NC} Выбран DNS: вариант $DNS_CHOICE"

    if systemctl is-active --quiet systemd-resolved 2>/dev/null; then
        RESOLVED_CONF="/etc/systemd/resolved.conf"
        cp "$RESOLVED_CONF" "${RESOLVED_CONF}.bak.$(date +%s)" 2>/dev/null || true
        if grep -q "^\[Resolve\]" "$RESOLVED_CONF" 2>/dev/null; then
            sed -i "/^\[Resolve\]/,/^\[/ { /^DNS=/d }" "$RESOLVED_CONF"
            sed -i "/^\[Resolve\]/a DNS=$DNS1 $DNS2" "$RESOLVED_CONF"
        else
            {
                echo "[Resolve]"
                echo "DNS=$DNS1 $DNS2"
            } >> "$RESOLVED_CONF"
        fi
        check_or_fail "перезапуск systemd-resolved" systemctl restart systemd-resolved
        echo "${GREEN}[✓]${NC} DNS настроен через systemd-resolved: $DNS1, $DNS2"
    else
        if [ -L /etc/resolv.conf ]; then
            RESOLV_LINK_TARGET=$(readlink -f /etc/resolv.conf)
            echo "${YELLOW}[?]${NC} /etc/resolv.conf — символическая ссылка на $RESOLV_LINK_TARGET"
            echo "    Вероятно, DNS управляется NetworkManager/resolvconf — запись"
            echo "    может не пережить перезагрузку."
        fi
        cp /etc/resolv.conf "/etc/resolv.conf.bak.$(date +%s)" 2>/dev/null || true
        {
            echo "nameserver $DNS1"
            echo "nameserver $DNS2"
        } > /etc/resolv.conf
        echo "${GREEN}[✓]${NC} DNS записан напрямую в /etc/resolv.conf: $DNS1, $DNS2"
        echo "${CYAN}[*]${NC} Если сервер использует DHCP, при перезагрузке файл может"
        echo "    перезаписаться — в этом случае DNS нужно будет закрепить через"
        echo "    настройки сетевого менеджера."
    fi

    echo "${GREEN}[✓]${NC} Шаг 1 завершён успешно"
    mark_done "step1_1"
fi

# ================== ШАГ 2 ==================
if is_done "step1_2"; then
    :
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 2: Файл подкачки (swap) и BBR"
    echo "===========================================================================${NC}"

    RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
    echo "${CYAN}[*]${NC} Обнаружено оперативной памяти: ${RAM_MB} MB"

    if [ "$RAM_MB" -le 2048 ]; then
        SWAP_MB=$((RAM_MB * 2))
    elif [ "$RAM_MB" -le 8192 ]; then
        SWAP_MB=$RAM_MB
    else
        SWAP_MB=4096
    fi
    echo "${CYAN}[*]${NC} Расчётный размер swap: ${SWAP_MB} MB"

    TOTAL_DISK_MB=$(df -Pm / | awk 'NR==2{print $2}')
    FREE_DISK_MB=$(df -Pm / | awk 'NR==2{print $4}')
    FREE_PCT=$(( FREE_DISK_MB * 100 / TOTAL_DISK_MB ))
    echo "${CYAN}[*]${NC} Свободно на диске: ${FREE_DISK_MB} MB (${FREE_PCT}% от ${TOTAL_DISK_MB} MB)"

    if [ "$FREE_PCT" -le 10 ]; then
        echo "${YELLOW}[?]${NC} Свободного места меньше 10% диска — размер swap будет"
        echo "    уменьшен или шаг пропущен"
    fi

    if ! check_disk_space $((SWAP_MB + 1024)) || [ "$FREE_PCT" -le 10 ]; then
        OLD_SWAP_MB=$SWAP_MB
        SWAP_MB=$(( FREE_DISK_MB / 2 ))
        if [ "$SWAP_MB" -lt 256 ]; then
            echo "${RED}[!]${NC} Недостаточно места на диске для swap, пропускаю этот шаг"
            SWAP_MB=0
        else
            echo "${CYAN}[*]${NC} Места мало — размер swap уменьшен с ${OLD_SWAP_MB} MB до"
            echo "    ${SWAP_MB} MB (оставляем запас 1 ГБ)"
        fi
    fi

    SWAPFILE="/swapfile"
    if [ "$SWAP_MB" -eq 0 ]; then
        :
    elif swapon --show | grep -q "$SWAPFILE"; then
        EXISTING_SWAP_MB=$(du -m "$SWAPFILE" 2>/dev/null | awk '{print $1}')
        echo "${CYAN}[*]${NC} Swap-файл уже подключён (размер: ${EXISTING_SWAP_MB:-?} MB,"
        echo "    расчётный: ${SWAP_MB} MB), пропуск создания"
    elif [ -f "$SWAPFILE" ]; then
        EXISTING_SWAP_MB=$(du -m "$SWAPFILE" 2>/dev/null | awk '{print $1}')
        echo "${CYAN}[*]${NC} Файл $SWAPFILE уже существует (размер: ${EXISTING_SWAP_MB:-?} MB,"
        echo "    расчётный: ${SWAP_MB} MB), включаем как есть"
        check_or_fail "включение swap" swapon "$SWAPFILE"
        echo "${GREEN}[✓]${NC} Swap включён"
    else
        run_spinner "Создание swap-файла (${SWAP_MB} MB)" "fallocate -l ${SWAP_MB}M $SWAPFILE || dd if=/dev/zero of=$SWAPFILE bs=1M count=$SWAP_MB"
        chmod 600 "$SWAPFILE"
        check_or_fail "форматирование swap" mkswap "$SWAPFILE"
        check_or_fail "включение swap" swapon "$SWAPFILE"
        echo "${GREEN}[✓]${NC} Swap-файл создан и включён"

        if ! grep -q "^$SWAPFILE " /etc/fstab 2>/dev/null; then
            echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
            echo "${GREEN}[✓]${NC} Запись добавлена в /etc/fstab"
        fi
    fi

    echo "${CYAN}[*]${NC} Настройка swappiness..."
    sed -i '/^vm.swappiness/d' /etc/sysctl.conf
    echo "vm.swappiness=10" >> /etc/sysctl.conf
    sysctl -w vm.swappiness=10 >> "$LOGFILE" 2>&1
    echo "${GREEN}[✓]${NC} vm.swappiness выставлен в 10"

    echo ""
    echo "${CYAN}[*]${NC} Включение BBR..."

    modprobe tcp_bbr >> "$LOGFILE" 2>&1 || echo "${RED}[!]${NC} Не удалось загрузить модуль tcp_bbr (возможно, уже встроен в ядро)"
    mkdir -p /etc/modules-load.d
    if ! grep -qsx "tcp_bbr" /etc/modules-load.d/*.conf 2>/dev/null; then
        echo "tcp_bbr" >> /etc/modules-load.d/bbr.conf
    fi

    sed -i '/^net.core.default_qdisc/d; /^net.ipv4.tcp_congestion_control/d' /etc/sysctl.conf
    {
        echo "net.core.default_qdisc=fq"
        echo "net.ipv4.tcp_congestion_control=bbr"
    } >> /etc/sysctl.conf

    sysctl -p >> "$LOGFILE" 2>&1

    ACTIVE_CC=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)
    if [ "$ACTIVE_CC" == "bbr" ]; then
        echo "${GREEN}[✓]${NC} BBR активен (tcp_congestion_control = bbr)"
    else
        echo "${RED}[!]${NC} BBR не активировался (сейчас: $ACTIVE_CC). Возможно, нужно"
        echo "    ядро новее или перезагрузка."
    fi

    echo "${GREEN}[✓]${NC} Шаг 2 завершён успешно"
    mark_done "step1_2"
fi

# ================== ШАГ 3 ==================
if is_done "step1_3"; then
    :
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 3: Обновление системы"
    echo "===========================================================================${NC}"

    retry_apt "Обновление списка пакетов" "apt-get update -y"
    retry_apt "Обновление установленных пакетов" "apt-get -o Dpkg::Options::='--force-confold' upgrade -y"

    command -v fuser >/dev/null 2>&1 || retry_apt "Установка psmisc (нужен для fuser)" "apt-get install -y psmisc"

    echo "${GREEN}[✓]${NC} Система обновлена"
    echo "${GREEN}[✓]${NC} Шаг 3 завершён успешно"
    mark_done "step1_3"
fi

# ================== ШАГ 4 ==================
if is_done "step1_4"; then
    :
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 4: Аудит системных событий (auditd)"
    echo "===========================================================================${NC}"

    retry_apt "Установка auditd" "apt-get install -y auditd audispd-plugins"
    check_or_fail "включение auditd" systemctl enable --now auditd

    AUDIT_RULES="/etc/audit/rules.d/deploy-kit.rules"
    cat > "$AUDIT_RULES" << 'EOF'
-w /etc/passwd -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/gshadow -p wa -k identity
-w /etc/ssh/sshd_config -p wa -k sshd_config
-w /etc/sudoers -p wa -k sudoers
EOF
    check_or_fail "применение правил аудита" augenrules --load
    echo "${GREEN}[✓]${NC} Auditd настроен: слежение за passwd, shadow, group,"
    echo "    gshadow, sshd_config, sudoers"

    echo "${GREEN}[✓]${NC} Шаг 4 завершён успешно"
    mark_done "step1_4"
fi

# ================== ШАГ 5 ==================
if is_done "step1_5"; then
    :
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 5: Создание пользователя и блокировка root"
    echo "===========================================================================${NC}"

    # PRESET_SUDO_USER/PRESET_SUDO_PASSWORD — задать заранее, без вопросов.
    # Невалидное значение (занято/короткий пароль) — откат к вопросу, не падает.
    _preset_user="${PRESET_SUDO_USER:-}"
    NEW_USER=""
    while [ -z "$NEW_USER" ]; do
        if [ -n "$_preset_user" ]; then
            INPUT_USER="$_preset_user"
            _preset_user=""
        else
            read -rp "${YELLOW}[?]${NC} Введите имя нового sudo-пользователя: " INPUT_USER < /dev/tty || { echo "${RED}[!]${NC} Не удалось прочитать ввод"; exit 1; }
        fi
        if [[ ! "$INPUT_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
            echo "${RED}[!]${NC} Только латиница в нижнем регистре, цифры, '_' и '-',"
            echo "    начиная с буквы (проверьте раскладку)"
        elif id "$INPUT_USER" >/dev/null 2>&1; then
            echo "${RED}[!]${NC} Пользователь '$INPUT_USER' уже существует, выберите другое имя"
        else
            NEW_USER="$INPUT_USER"
        fi
    done

    _preset_pass="${PRESET_SUDO_PASSWORD:-}"
    while true; do
        if [ -n "$_preset_pass" ]; then
            NEW_PASS="$_preset_pass"
        else
            read -rsp "${YELLOW}[?]${NC} Введите пароль для '$NEW_USER' (минимум 8 символов): " NEW_PASS < /dev/tty || { echo "${RED}[!]${NC} Не удалось прочитать ввод"; exit 1; }
            echo ""
        fi
        if [ "${#NEW_PASS}" -lt 8 ]; then
            echo "${RED}[!]${NC} Слишком короткий пароль (минимум 8 символов), попробуйте снова"
            _preset_pass=""
            continue
        fi
        if [ -n "${PRESET_SUDO_PASSWORD:-}" ] && [ "$NEW_PASS" = "$PRESET_SUDO_PASSWORD" ]; then
            NEW_PASS_CONFIRM="$NEW_PASS"
        else
            read -rsp "${YELLOW}[?]${NC} Повторите пароль: " NEW_PASS_CONFIRM < /dev/tty || { echo "${RED}[!]${NC} Не удалось прочитать ввод"; exit 1; }
            echo ""
        fi
        if [ "$NEW_PASS" == "$NEW_PASS_CONFIRM" ]; then
            break
        else
            echo "${RED}[!]${NC} Пароли не совпадают, попробуйте снова"
        fi
    done

    check_or_fail "создание пользователя '$NEW_USER'" adduser --gecos "" --disabled-password "$NEW_USER"
    if ! chpasswd <<< "$NEW_USER:$NEW_PASS" >> "$LOGFILE" 2>&1; then
        echo "${RED}[!]${NC} Ошибка при установке пароля"
        echo "${RED}[!]${NC} --- последние строки лога ($LOGFILE) ---"
        tail -n 15 "$LOGFILE"
        exit 1
    fi
    echo "${GREEN}[✓]${NC} Пользователь '$NEW_USER' создан"
    echo "$NEW_USER" > "$USERFILE"
    chmod 644 "$USERFILE"

    if grep -q "^DEPLOY_USER=" "$DK_DIR/.env" 2>/dev/null; then
        sed -i "s/^DEPLOY_USER=.*/DEPLOY_USER=$NEW_USER/" "$DK_DIR/.env"
    else
        echo "DEPLOY_USER=$NEW_USER" >> "$DK_DIR/.env"
    fi
    chmod 600 "$DK_DIR/.env"

    check_or_fail "добавление в группу sudo" usermod -aG sudo "$NEW_USER"
    echo "${GREEN}[✓]${NC} Пользователь '$NEW_USER' добавлен в группу sudo"

    echo ""
    echo "${BOLD}${YELLOW}==========================================================================="
    echo "  ПРОВЕРКА: не закрывайте эту сессию!"
    echo "===========================================================================${NC}"
    echo "${RED}[!]${NC} Откройте НОВОЕ окно терминала и подключитесь:"
    echo "    ssh $NEW_USER@$(hostname -I | awk '{print $1}')"
    echo "${RED}[!]${NC} Убедитесь, что вход выполнен и работает 'sudo -l'"
    echo ""

    confirm_or_exit "Новый пользователь подключился и sudo работает?" "Прервано. Root пока не заблокирован."

    echo "${GREEN}[✓]${NC} Доступ нового пользователя подтверждён"

    check_or_fail "блокировка root" passwd -l root
    echo "${GREEN}[✓]${NC} Root-пользователь заблокирован (пароль)"

    if [ -f /root/.ssh/authorized_keys ] && [ -s /root/.ssh/authorized_keys ]; then
        echo "${YELLOW}[?]${NC} У root есть активные SSH-ключи (/root/.ssh/authorized_keys) —"
        echo "    вход по паролю заблокирован, но по ключу root всё ещё доступен."
        ROOT_KEY_CHOICE="${PRESET_REMOVE_ROOT_KEYS:-}"
        while [ -z "$ROOT_KEY_CHOICE" ]; do
            read -rp "${YELLOW}[?]${NC} Убрать SSH-ключи root? (y/n): " ROOT_KEY_CHOICE < /dev/tty || { echo "${RED}[!]${NC} Не удалось прочитать ввод"; exit 1; }
            case "$ROOT_KEY_CHOICE" in
                y|Y)
                    mv /root/.ssh/authorized_keys "/root/.ssh/authorized_keys.bak.$(date +%s)"
                    echo "${GREEN}[✓]${NC} Ключи root перемещены в authorized_keys.bak.* (вход по ключу отключён)"
                    ;;
                n|N)
                    echo "${CYAN}[*]${NC} Оставлено как есть — вход root по ключу всё ещё возможен"
                    ;;
                *)
                    echo "${RED}[!]${NC} Введите 'y' или 'n'"
                    ROOT_KEY_CHOICE=""
                    ;;
            esac
        done
    fi

    echo "${GREEN}[✓]${NC} Шаг 5 завершён успешно"
    mark_done "step1_5"
fi

# ================== ШАГ 6 ==================
if is_done "step1_6"; then
    :
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 6: Смена SSH-порта и настройка файрвола"
    echo "===========================================================================${NC}"

    if [ ! -f "$SSHD_CONFIG" ]; then
        echo "${RED}[!]${NC} Файл $SSHD_CONFIG не найден."
        echo "    Похоже, openssh-server не установлен."
        echo "${RED}[!]${NC} Установите его: apt-get install -y openssh-server"
        exit 1
    fi

    CURRENT_PORT=$(grep -E "^Port " "$SSHD_CONFIG" | awk '{print $2}')
    CURRENT_PORT=${CURRENT_PORT:-22}
    echo "${CYAN}[*]${NC} Текущий SSH-порт: $CURRENT_PORT"

    # PRESET_SSH_PORT — переменная окружения, чтобы не спрашивать порт.
    _preset_port="${PRESET_SSH_PORT:-}"
    while true; do
        if [ -n "$_preset_port" ]; then
            NEW_PORT="$_preset_port"
        else
            read -rp "${YELLOW}[?]${NC} Введите новый SSH-порт (1024-65535): " NEW_PORT < /dev/tty || { echo "${RED}[!]${NC} Не удалось прочитать ввод"; exit 1; }
        fi
        if [[ "$NEW_PORT" =~ ^[0-9]+$ ]] && [ "$NEW_PORT" -ge 1024 ] && [ "$NEW_PORT" -le 65535 ]; then
            break
        else
            echo "${RED}[!]${NC} Некорректный порт, попробуйте снова"
            _preset_port=""
        fi
    done

    cp "$SSHD_CONFIG" "${SSHD_CONFIG}.bak.$(date +%s)"
    echo "${GREEN}[✓]${NC} Резервная копия sshd_config создана"

    if grep -qE "^Port " "$SSHD_CONFIG"; then
        sed -i "s/^Port .*/Port $NEW_PORT/" "$SSHD_CONFIG"
    else
        echo "Port $NEW_PORT" >> "$SSHD_CONFIG"
    fi
    echo "${GREEN}[✓]${NC} Порт в конфиге изменён на $NEW_PORT"
    echo "$NEW_PORT" > "$PORTFILE"

    sed -i '/^MaxAuthTries /d; /^LoginGraceTime /d' "$SSHD_CONFIG"
    {
        echo "MaxAuthTries 3"
        echo "LoginGraceTime 20"
    } >> "$SSHD_CONFIG"
    echo "${GREEN}[✓]${NC} Ограничение попыток входа: MaxAuthTries 3, LoginGraceTime 20с"

    if ! command -v ufw >/dev/null 2>&1; then
        echo "${CYAN}[*]${NC} ufw не найден, устанавливаю..."
        retry_apt "Установка ufw" "apt-get install -y ufw"
    fi

    echo "${CYAN}[*]${NC} Настройка файрвола: блокируем всё, кроме необходимого минимума"
    # ВАЖНО: старый порт пока НЕ удаляем — если новый порт вдруг не пройдёт
    # (например, Security Group хостинга ещё не пропускает его), доступ
    # не потеряется. Закрываем старый порт только после подтверждения ниже.
    check_or_fail "настройка правил ufw" bash -c "ufw default deny incoming && ufw default allow outgoing && ufw allow $NEW_PORT/tcp comment SSH"
    if [ "$CURRENT_PORT" != "$NEW_PORT" ]; then
        check_or_fail "временное разрешение старого порта $CURRENT_PORT" ufw allow "$CURRENT_PORT"/tcp comment "SSH (old, temp until confirmed)"
        echo "${GREEN}[✓]${NC} Разрешены оба порта — новый ($NEW_PORT) и старый ($CURRENT_PORT) —"
        echo "    старый закроется только после подтверждения входа по новому"
    else
        echo "${GREEN}[✓]${NC} Порт не менялся ($NEW_PORT) — закрывать нечего, просто обновил"
        echo "    остальные правила firewall"
    fi
    echo "${CYAN}[*]${NC} Порты 80/443 (сайты/API) откроются автоматически в модуле 2"
    echo "    при установке Caddy"

    restart_ssh

    check_or_fail "включение файрвола" ufw --force enable
    if [ "$CURRENT_PORT" != "$NEW_PORT" ]; then
        echo "${GREEN}[✓]${NC} Файрвол включён (оба порта пока разрешены)"
    else
        echo "${GREEN}[✓]${NC} Файрвол включён"
    fi

    echo ""
    echo "${BOLD}${YELLOW}==========================================================================="
    echo "  ПРОВЕРКА: не закрывайте эту сессию!"
    echo "===========================================================================${NC}"
    echo "${RED}[!]${NC} Откройте НОВОЕ окно терминала и подключитесь:"
    SSH_TEST_USER=$(read_or_default "$USERFILE" "<ваш sudo-пользователь>")
    echo "    ssh -p $NEW_PORT $SSH_TEST_USER@$(hostname -I | awk '{print $1}')"
    echo "${RED}[!]${NC} Убедитесь, что подключение по новому порту работает"
    echo "${RED}[!]${NC} Также проверьте Security Group / файрвол у вашего хостинг-провайдера —"
    echo "    новый порт должен быть разрешён и там, иначе доступ потеряется."
    echo ""
    if [ "$CURRENT_PORT" != "$NEW_PORT" ]; then
        echo "${CYAN}[*]${NC} Если что-то не так — старый порт $CURRENT_PORT пока ещё открыт,"
        echo "    можно спокойно зайти им и разобраться, ничего не потеряно."
        echo ""
    fi

    if [ "$CURRENT_PORT" != "$NEW_PORT" ]; then
        ABORT_MSG="Прервано. Старый порт $CURRENT_PORT остаётся открытым, доступ не потерян. Бэкап: ${SSHD_CONFIG}.bak.*"
    else
        ABORT_MSG="Прервано. Бэкап: ${SSHD_CONFIG}.bak.*"
    fi
    confirm_or_exit "Подключение по порту $NEW_PORT работает?" "$ABORT_MSG"

    echo "${GREEN}[✓]${NC} SSH-порт подтверждён"

    if [ "$CURRENT_PORT" != "$NEW_PORT" ]; then
        check_or_fail "закрытие старого порта $CURRENT_PORT" ufw delete allow "$CURRENT_PORT"/tcp
        echo "${GREEN}[✓]${NC} Старый порт $CURRENT_PORT закрыт — доступ теперь только через $NEW_PORT"
    fi

    echo "${GREEN}[✓]${NC} Шаг 6 завершён успешно"
    mark_done "step1_6"
fi

# ================== ШАГ 7 ==================
if is_done "step1_7"; then
    :
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 7: Способ входа по SSH"
    echo "===========================================================================${NC}"

    if [ ! -f "$USERFILE" ]; then
        echo "${RED}[!]${NC} Не найден файл с именем пользователя, пропустить шаг нельзя"
        exit 1
    fi
    SSH_USER=$(cat "$USERFILE")

    echo ""
    echo "  1) Пароль (оставить как есть)"
    echo "  2) SSH-ключ (вставить свой публичный ключ)"
    echo ""

    # PRESET_SSH_AUTH_METHOD=1|2 и PRESET_SSH_PUBLIC_KEY — чтобы не спрашивать.
    AUTH_CHOICE="${PRESET_SSH_AUTH_METHOD:-}"
    while [ "$AUTH_CHOICE" != "1" ] && [ "$AUTH_CHOICE" != "2" ]; do
        if [ -n "$AUTH_CHOICE" ]; then
            echo "${RED}[!]${NC} PRESET_SSH_AUTH_METHOD должен быть 1 или 2"
        fi
        read -rp "${YELLOW}[?]${NC} Выберите вариант (1 или 2): " AUTH_CHOICE < /dev/tty || { echo "${RED}[!]${NC} Не удалось прочитать ввод"; exit 1; }
    done

    if [ "$AUTH_CHOICE" == "2" ]; then
        echo "${CYAN}[*]${NC} Вставьте публичный ключ с вашего компьютера (обычно"
        echo "    ~/.ssh/id_ed25519.pub или id_rsa.pub)"
        echo "${CYAN}[*]${NC} Оставьте пустым и нажмите Enter, чтобы остаться на входе по паролю"
        PASTED_KEY=""
        CANCELLED=0
        _preset_key="${PRESET_SSH_PUBLIC_KEY:-}"
        while [ -z "$PASTED_KEY" ] && [ "$CANCELLED" -eq 0 ]; do
            if [ -n "$_preset_key" ]; then
                KEY_INPUT="$_preset_key"
                _preset_key=""
            else
                read -rp "${YELLOW}[?]${NC} Публичный ключ: " KEY_INPUT < /dev/tty || { echo "${RED}[!]${NC} Не удалось прочитать ввод"; exit 1; }
            fi
            if [ -z "$KEY_INPUT" ]; then
                CANCELLED=1
            elif [[ "$KEY_INPUT" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+)\ [A-Za-z0-9+/=]+([[:space:]].*)?$ ]]; then
                PASTED_KEY="$KEY_INPUT"
            else
                echo "${RED}[!]${NC} Не похоже на публичный ключ (должен начинаться с"
                echo "    ssh-ed25519/ssh-rsa/ecdsa-...)"
            fi
        done
        if [ "$CANCELLED" -eq 1 ]; then
            AUTH_CHOICE="1"
            echo "${CYAN}[*]${NC} Ключ не введён — оставлен вход по паролю"
        fi
    fi

    if [ "$AUTH_CHOICE" == "1" ]; then
        echo "${CYAN}[*]${NC} Оставлен вход по паролю, без изменений"
    else
        USER_HOME=$(getent passwd "$SSH_USER" | cut -d: -f6)
        SSH_DIR="$USER_HOME/.ssh"

        mkdir -p "$SSH_DIR"
        chmod 700 "$SSH_DIR"

        echo "$PASTED_KEY" >> "$SSH_DIR/authorized_keys"
        chmod 600 "$SSH_DIR/authorized_keys"
        check_or_fail "смена владельца .ssh" chown -R "$SSH_USER:$SSH_USER" "$SSH_DIR"
        echo "${GREEN}[✓]${NC} Ваш публичный ключ добавлен в authorized_keys —"
        echo "    приватный ключ сервер никогда не видел"

        SSH_PORT_FOR_TEST=$(read_or_default "$PORTFILE" "22")

        echo ""
        echo "${BOLD}${YELLOW}==========================================================================="
        echo "  ПРОВЕРКА: не закрывайте эту сессию!"
        echo "===========================================================================${NC}"
        echo "${RED}[!]${NC} В НОВОМ окне терминала подключитесь ключом:"
        echo "    ssh -p $SSH_PORT_FOR_TEST -i /путь/к/вашему/приватному/ключу $SSH_USER@$(hostname -I | awk '{print $1}')"
        echo ""

        confirm_or_exit "Вход по ключу работает?" "Прервано. Пароль пока не отключён."

        cp "$SSHD_CONFIG" "${SSHD_CONFIG}.bak.$(date +%s)"
        if grep -qE "^PasswordAuthentication " "$SSHD_CONFIG"; then
            sed -i "s/^PasswordAuthentication .*/PasswordAuthentication no/" "$SSHD_CONFIG"
        else
            echo "PasswordAuthentication no" >> "$SSHD_CONFIG"
        fi
        sed -i '/^ChallengeResponseAuthentication /d; /^KbdInteractiveAuthentication /d' "$SSHD_CONFIG"
        {
            echo "ChallengeResponseAuthentication no"
            echo "KbdInteractiveAuthentication no"
        } >> "$SSHD_CONFIG"
        restart_ssh
        echo "key" > "$AUTHMETHODFILE"
        chmod 644 "$AUTHMETHODFILE"
        echo "${GREEN}[✓]${NC} Вход по паролю отключён, доступ только по ключу"
    fi

    echo "${GREEN}[✓]${NC} Шаг 7 завершён успешно"
    mark_done "step1_7"
fi

# ================== ШАГ 8 ==================
if is_done "step1_8"; then
    :
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 8: Fail2ban"
    echo "===========================================================================${NC}"

    retry_apt "Установка fail2ban" "apt-get install -y fail2ban"

    SSH_PORT_FOR_F2B=$(read_or_default "$PORTFILE" "22")

    IGNORE_IPS="127.0.0.1/8 ::1"

    cat > /etc/fail2ban/jail.local << EOF
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5
ignoreip = $IGNORE_IPS

[sshd]
enabled = true
port = $SSH_PORT_FOR_F2B
filter = sshd
logpath = /var/log/auth.log
maxretry = 5
EOF

    run_spinner "Запуск fail2ban" "systemctl enable --now fail2ban"
    echo "${GREEN}[✓]${NC} Fail2ban настроен для SSH-порта $SSH_PORT_FOR_F2B (бан на"
    echo "    1 час после 5 неудачных попыток)"
    echo "${CYAN}[*]${NC} Свой IP в исключения не добавляем — при случайном бане себя самого:"
    echo "    fail2ban-client set sshd unbanip <ваш_IP>"

    echo "${GREEN}[✓]${NC} Шаг 8 завершён успешно"
    mark_done "step1_8"
fi

# ================== ШАГ 9 ==================
if is_done "step1_9"; then
    :
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 9: AppArmor"
    echo "===========================================================================${NC}"

    if ! command -v aa-status >/dev/null 2>&1; then
        retry_apt "Установка AppArmor" "apt-get install -y apparmor apparmor-utils"
    else
        echo "${CYAN}[*]${NC} AppArmor уже установлен"
    fi

    check_or_fail "включение AppArmor" systemctl enable --now apparmor

    PROFILE_COUNT=$(aa-status 2>/dev/null | awk '/profiles are loaded/{print $1}')
    if systemctl is-active --quiet apparmor; then
        echo "${GREEN}[✓]${NC} AppArmor активен, загружено профилей: ${PROFILE_COUNT:-?}"
    else
        echo "${RED}[!]${NC} AppArmor установлен, но служба не запущена — проверьте"
        echo "    вручную после перезагрузки"
    fi

    echo "${GREEN}[✓]${NC} Шаг 9 завершён успешно"
    mark_done "step1_9"
fi

# ================== ШАГ 10 ==================
if is_done "step1_10"; then
    :
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 10: Часовой пояс и синхронизация времени (NTP)"
    echo "===========================================================================${NC}"

    echo "${CYAN}[*]${NC} Текущий часовой пояс: $(timedatectl show -p Timezone --value 2>/dev/null || echo 'неизвестно')"
    echo ""

    # формат записи: Region/City:пояс относительно МСК
    TZ_LIST=(
        "Europe/Moscow:МСК,   UTC+3"
        "Europe/Kaliningrad:МСК-1, UTC+2"
        "Europe/Samara:МСК+1, UTC+4"
        "Asia/Yekaterinburg:МСК+2, UTC+5"
        "Asia/Omsk:МСК+3, UTC+6"
        "Asia/Krasnoyarsk:МСК+4, UTC+7"
        "Asia/Irkutsk:МСК+5, UTC+8"
        "Asia/Yakutsk:МСК+6, UTC+9"
        "Asia/Vladivostok:МСК+7, UTC+10"
        "Asia/Magadan:МСК+8, UTC+11"
        "Asia/Kamchatka:МСК+9, UTC+12"
        "UTC:без смещения"
        "Europe/London:UTC+0/+1"
        "Europe/Berlin:UTC+1/+2"
    )

    for i in "${!TZ_LIST[@]}"; do
        printf "  %2d) %-21s (%s)\n" "$((i+1))" "${TZ_LIST[$i]%%:*}" "${TZ_LIST[$i]#*:}"
        sleep 0.1
    done
    echo "  15) Свой вариант (ввести вручную, например Asia/Dubai)"
    echo ""

    SELECTED_TZ=""
    # PRESET_TIMEZONE — готовое имя пояса (напр. Europe/Moscow), в обход списка.
    if [ -n "${PRESET_TIMEZONE:-}" ]; then
        if timedatectl list-timezones 2>/dev/null | grep -qx "$PRESET_TIMEZONE"; then
            SELECTED_TZ="$PRESET_TIMEZONE"
        else
            echo "${RED}[!]${NC} PRESET_TIMEZONE='$PRESET_TIMEZONE' не найден в списке,"
            echo "    перехожу к обычному выбору"
        fi
    fi
    while [ -z "$SELECTED_TZ" ]; do
        read -rp "${YELLOW}[?]${NC} Выберите вариант (1-15): " TZ_CHOICE < /dev/tty || { echo "${RED}[!]${NC} Не удалось прочитать ввод"; exit 1; }
        if [ "$TZ_CHOICE" == "15" ]; then
            read -rp "${YELLOW}[?]${NC} Введите часовой пояс (формат Region/City): " TZ_CUSTOM < /dev/tty || { echo "${RED}[!]${NC} Не удалось прочитать ввод"; exit 1; }
            if timedatectl list-timezones 2>/dev/null | grep -qx "$TZ_CUSTOM"; then
                SELECTED_TZ="$TZ_CUSTOM"
            else
                echo "${RED}[!]${NC} Такой часовой пояс не найден, попробуйте снова"
            fi
        elif [[ "$TZ_CHOICE" =~ ^[0-9]+$ ]] && [ "$TZ_CHOICE" -ge 1 ] && [ "$TZ_CHOICE" -le "${#TZ_LIST[@]}" ]; then
            SELECTED_TZ="${TZ_LIST[$((TZ_CHOICE-1))]%%:*}"
        else
            echo "${RED}[!]${NC} Некорректный номер, введите значение от 1 до 15"
        fi
    done

    check_or_fail "установка часового пояса" timedatectl set-timezone "$SELECTED_TZ"
    echo "${GREEN}[✓]${NC} Часовой пояс установлен: $SELECTED_TZ"

    check_or_fail "включение NTP" timedatectl set-ntp true
    sleep 1
    if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q "yes"; then
        echo "${GREEN}[✓]${NC} Синхронизация времени (NTP) активна"
    else
        echo "${CYAN}[*]${NC} NTP включён, синхронизация может занять немного времени"
    fi

    echo "${GREEN}[✓]${NC} Шаг 10 завершён успешно"
    mark_done "step1_10"
fi

# ================== ШАГ 11 ==================
if is_done "step1_11"; then
    :
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 11: Системные лимиты"
    echo "===========================================================================${NC}"

    cat > /etc/security/limits.d/99-deploy-kit.conf << 'EOF'
* soft nofile 65535
* hard nofile 65535
root soft nofile 65535
root hard nofile 65535
EOF
    echo "${GREEN}[✓]${NC} Лимит открытых файлов (nofile) увеличен до 65535 для всех пользователей"

    if ! grep -q "^DefaultLimitNOFILE=" /etc/systemd/system.conf 2>/dev/null; then
        sed -i '/^\[Manager\]/a DefaultLimitNOFILE=65535' /etc/systemd/system.conf
    else
        sed -i 's/^DefaultLimitNOFILE=.*/DefaultLimitNOFILE=65535/' /etc/systemd/system.conf
    fi
    echo "${GREEN}[✓]${NC} Лимит для systemd-сервисов увеличен (потребует"
    echo "    перезагрузки для полного применения)"

    echo "${GREEN}[✓]${NC} Шаг 11 завершён успешно"
    mark_done "step1_11"
fi

# ================== ШАГ 12 ==================
if is_done "step1_12"; then
    :
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 12: Автообновления, автоочистка, автоперезагрузка"
    echo "===========================================================================${NC}"

    retry_apt "Установка unattended-upgrades" "apt-get install -y unattended-upgrades"

    # свой drop-in вместо sed по чужому файлу — не зависит от формата 50unattended-upgrades
    cat > /etc/apt/apt.conf.d/51-deploy-kit-security-only.conf << 'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "02:00";
EOF
    echo "${GREEN}[✓]${NC} unattended-upgrades настроен: только security-патчи"
    echo "${GREEN}[✓]${NC} Автоперезагрузка при критическом обновлении: включена"
    echo "    (в 02:00, если требуется)"

    cat > /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
APT::Periodic::Download-Upgradeable-Packages "1";
EOF
    echo "${GREEN}[✓]${NC} Ежедневная проверка и установка security-обновлений включена"

    echo ""
    echo "${CYAN}[*]${NC} Настройка еженедельной перезагрузки (фиксированное время)..."

    declare -A DAY_MAP=( ["вс"]=0 ["пн"]=1 ["вт"]=2 ["ср"]=3 ["чт"]=4 ["пт"]=5 ["сб"]=6 )

    # PRESET_REBOOT_DAY (пн/вт/.../вс) и PRESET_REBOOT_TIME (ЧЧ:ММ) — чтобы
    # не спрашивать.
    REBOOT_DOW=""
    _preset_day="${PRESET_REBOOT_DAY:-}"
    while [ -z "$REBOOT_DOW" ]; do
        if [ -n "$_preset_day" ]; then
            DAY_INPUT="$_preset_day"
            _preset_day=""
        else
            read -rp "${YELLOW}[?]${NC} День недели для перезагрузки (пн/вт/ср/чт/пт/сб/вс): " DAY_INPUT < /dev/tty || { echo "${RED}[!]${NC} Не удалось прочитать ввод"; exit 1; }
        fi
        DAY_INPUT=$(echo "$DAY_INPUT" | tr '[:upper:]' '[:lower:]')
        if [ -z "$DAY_INPUT" ] || [ -z "${DAY_MAP[$DAY_INPUT]+x}" ]; then
            echo "${RED}[!]${NC} Не распознано, введите одно из: пн вт ср чт пт сб вс"
        else
            REBOOT_DOW="${DAY_MAP[$DAY_INPUT]}"
        fi
    done

    REBOOT_TIME=""
    _preset_reboot_time="${PRESET_REBOOT_TIME:-}"
    while [ -z "$REBOOT_TIME" ]; do
        if [ -n "$_preset_reboot_time" ]; then
            TIME_INPUT="$_preset_reboot_time"
            _preset_reboot_time=""
        else
            read -rp "${YELLOW}[?]${NC} Время перезагрузки в формате ЧЧ:ММ (например 04:00): " TIME_INPUT < /dev/tty || { echo "${RED}[!]${NC} Не удалось прочитать ввод"; exit 1; }
        fi
        if [[ "$TIME_INPUT" =~ ^([01][0-9]|2[0-3]):([0-5][0-9])$ ]]; then
            REBOOT_HOUR="${BASH_REMATCH[1]}"
            REBOOT_MIN="${BASH_REMATCH[2]}"
            REBOOT_TIME="$TIME_INPUT"
        else
            echo "${RED}[!]${NC} Некорректный формат, пример: 04:00"
        fi
    done

    REBOOT_HOUR_N=$((10#$REBOOT_HOUR))
    REBOOT_MIN_N=$((10#$REBOOT_MIN))

    cat > /etc/cron.d/deploy_kit_weekly_reboot << EOF
$REBOOT_MIN_N $REBOOT_HOUR_N * * $REBOOT_DOW root /sbin/shutdown -r now
EOF
    echo "${GREEN}[✓]${NC} Еженедельная перезагрузка настроена: день недели #$REBOOT_DOW, время $REBOOT_TIME"
    echo "${CYAN}[*]${NC} (0=вс, 1=пн, 2=вт, 3=ср, 4=чт, 5=пт, 6=сб)"

    echo ""
    echo "${CYAN}[*]${NC} Настройка автоочистки мусора (через 10 минут после"
    echo "    плановой перезагрузки)..."

    cat > /usr/local/bin/deploy_kit_cleanup.sh << 'EOF'
#!/bin/bash
# Автоочистка: пакеты, кэш apt, старые логи
apt-get autoremove -y >> /var/lib/deploy_kit/deploy_kit.log 2>&1
apt-get autoclean -y >> /var/lib/deploy_kit/deploy_kit.log 2>&1
journalctl --vacuum-time=7d >> /var/lib/deploy_kit/deploy_kit.log 2>&1
find /var/log -type f -name "*.gz" -mtime +14 -delete
find /var/log -type f -name "*.[0-9]" -mtime +14 -delete
EOF
    chmod +x /usr/local/bin/deploy_kit_cleanup.sh

    CLEANUP_TOTAL_MIN=$(( REBOOT_HOUR_N * 60 + REBOOT_MIN_N + 10 ))
    CLEANUP_HOUR=$(( (CLEANUP_TOTAL_MIN / 60) % 24 ))
    CLEANUP_MIN=$(( CLEANUP_TOTAL_MIN % 60 ))
    CLEANUP_DOW=$(( (REBOOT_DOW + CLEANUP_TOTAL_MIN / 1440) % 7 ))

    cat > /etc/cron.d/deploy_kit_cleanup << EOF
$CLEANUP_MIN $CLEANUP_HOUR * * $CLEANUP_DOW root /usr/local/bin/deploy_kit_cleanup.sh
EOF
    printf "${GREEN}[✓]${NC} Автоочистка настроена: через 10 минут после перезагрузки (%02d:%02d, день недели #%d)\n" "$CLEANUP_HOUR" "$CLEANUP_MIN" "$CLEANUP_DOW"

    cat > /etc/logrotate.d/deploy_kit << 'EOF'
/var/lib/deploy_kit/deploy_kit.log {
    size 10M
    rotate 5
    compress
    missingok
    notifempty
}
EOF
    echo "${GREEN}[✓]${NC} Логротация для deploy_kit.log настроена (по достижении"
    echo "    10 МБ, хранить 5 архивов)"

    echo "${GREEN}[✓]${NC} Шаг 12 завершён успешно"
    mark_done "step1_12"
fi

# ================== ШАГ 13 ==================
if is_done "step1_13"; then
    :
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 13: Health-checker"
    echo "===========================================================================${NC}"

    cat > /usr/local/bin/deploy_kit_healthcheck.sh << 'EOF'
#!/bin/bash
LOG="/var/lib/deploy_kit/deploy_kit_health.log"
STAMP=$(date '+%Y-%m-%d %H:%M:%S')

{
    echo "===== $STAMP ====="

    DISK_PCT=$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}')
    MEM_PCT=$(free | awk '/^Mem:/{printf "%.0f", $3/$2*100}')
    LOAD1=$(awk '{print $1}' /proc/loadavg)
    CPUS=$(nproc)
    echo "Ресурсы: диск=${DISK_PCT}% память=${MEM_PCT}% load1=${LOAD1} cpus=${CPUS}"
    [ "$DISK_PCT" -ge 85 ] && echo "[ВНИМАНИЕ] Диск заполнен на ${DISK_PCT}%"
    [ "$MEM_PCT" -ge 90 ] && echo "[ВНИМАНИЕ] Память заполнена на ${MEM_PCT}%"

    echo "Службы:"
    for svc in ssh sshd fail2ban apparmor auditd ufw; do
        if systemctl list-unit-files --type=service 2>/dev/null | grep -q "^${svc}\.service"; then
            if systemctl is-active --quiet "$svc"; then
                echo "  [OK] $svc"
            else
                echo "  [ВНИМАНИЕ] $svc не запущен"
            fi
        fi
    done

    FAILED=$(systemctl --failed --no-legend 2>/dev/null | wc -l)
    if [ "$FAILED" -gt 0 ]; then
        echo "[ВНИМАНИЕ] Упавших systemd-юнитов: $FAILED"
        systemctl --failed --no-legend 2>/dev/null | awk '{print "  - "$1}'
    else
        echo "Упавших systemd-юнитов: 0"
    fi

    ERR_COUNT=$(journalctl -p err -S "-1 hour" --no-pager 2>/dev/null | wc -l)
    echo "Ошибок в журнале за последний час: $ERR_COUNT"
} >> "$LOG"

# храним лог не больше 1000 строк
tail -n 1000 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
EOF
    chmod +x /usr/local/bin/deploy_kit_healthcheck.sh
    touch "$HEALTHLOG"
    chmod 644 "$HEALTHLOG"

    echo "${CYAN}[*]${NC} Настройка ежедневной проверки системы..."

    # PRESET_HEALTHCHECK_TIME (ЧЧ:ММ) — чтобы не спрашивать.
    HC_TIME=""
    _preset_hc_time="${PRESET_HEALTHCHECK_TIME:-}"
    while [ -z "$HC_TIME" ]; do
        if [ -n "$_preset_hc_time" ]; then
            HC_TIME_INPUT="$_preset_hc_time"
            _preset_hc_time=""
        else
            read -rp "${YELLOW}[?]${NC} Время ежедневной проверки в формате ЧЧ:ММ (например 06:00): " HC_TIME_INPUT < /dev/tty || { echo "${RED}[!]${NC} Не удалось прочитать ввод"; exit 1; }
        fi
        if [[ "$HC_TIME_INPUT" =~ ^([01][0-9]|2[0-3]):([0-5][0-9])$ ]]; then
            HC_HOUR_N=$((10#${BASH_REMATCH[1]}))
            HC_MIN_N=$((10#${BASH_REMATCH[2]}))
            HC_TIME="$HC_TIME_INPUT"
        else
            echo "${RED}[!]${NC} Некорректный формат, пример: 06:00"
        fi
    done

    cat > /etc/cron.d/deploy_kit_healthcheck << EOF
$HC_MIN_N $HC_HOUR_N * * * root /usr/local/bin/deploy_kit_healthcheck.sh
EOF
    echo "${GREEN}[✓]${NC} Health-checker настроен: каждый день в $HC_TIME, лог в $HEALTHLOG"
    echo "${CYAN}[*]${NC} Проверяются: диск, память, load average, статус служб"
    echo "    (ssh/fail2ban/apparmor/auditd/ufw),"
    echo "    упавшие systemd-юниты и ошибки в журнале за последний час"

    echo "${GREEN}[✓]${NC} Шаг 13 завершён успешно"
    mark_done "step1_13"
fi

# ================== ШАГ 13b ==================
if is_done "step1_13b"; then
    echo "${CYAN}[*]${NC} Слежение за входом по SSH уже настроено, пропуск"
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 13b: Слежение за входом по SSH (уведомления о каждой попытке)"
    echo "===========================================================================${NC}"
    echo "${CYAN}[*]${NC} fail2ban уже ловит СЕРИЮ неудачных попыток (бан) — этого события"
    echo "    события мало, если нужно видеть КАЖДУЮ попытку входа по SSH,"
    echo "    успешную или нет, не только итоговую блокировку."

    cat > /usr/local/bin/deploy_kit_ssh_events.sh << 'SSHEOF'
#!/usr/bin/env bash
# NEXUS404 — слушает журнал sshd через journalctl (только новые строки,
# -n 0), на "Accepted"/"Failed" вызывает event_hook.sh. journald надёжнее
# парсинга auth.log — не зависит от того, включён ли файловый rsyslog.
set -uo pipefail

HOOK="/opt/nexus404/hooks/event_hook.sh"

# Debian/Ubuntu — ssh.service, RHEL/CentOS — sshd.service.
SSH_UNIT="ssh.service"
systemctl list-unit-files "$SSH_UNIT" >/dev/null 2>&1 || SSH_UNIT="sshd.service"

journalctl -u "$SSH_UNIT" -f -n 0 -o cat | while IFS= read -r line; do
    if [[ "$line" =~ Accepted\ ([a-zA-Z0-9/_-]+)\ for\ ([a-zA-Z0-9._-]+)\ from\ ([0-9a-fA-F:.]+) ]]; then
        method="${BASH_REMATCH[1]}"; user="${BASH_REMATCH[2]}"; ip="${BASH_REMATCH[3]}"
        [ -x "$HOOK" ] && "$HOOK" security.ssh.login_succeeded "user=${user} ip=${ip} method=${method}" || true
    # "invalid user" сдвигает позицию имени в строке — без него regex не сматчился бы.
    elif [[ "$line" =~ Failed\ ([a-zA-Z0-9/_-]+)\ for\ (invalid\ user\ )?([a-zA-Z0-9._-]+)\ from\ ([0-9a-fA-F:.]+) ]]; then
        method="${BASH_REMATCH[1]}"; user="${BASH_REMATCH[3]}"; ip="${BASH_REMATCH[4]}"
        [ -x "$HOOK" ] && "$HOOK" security.ssh.login_failed "user=${user} ip=${ip} method=${method}" || true
    fi
done
SSHEOF
    chmod 755 /usr/local/bin/deploy_kit_ssh_events.sh

    cat > /etc/systemd/system/nexus404-ssh-events.service << 'EOF'
[Unit]
Description=NEXUS404 — событие на каждый вход по SSH (успешный/неудачный)
After=network.target ssh.service sshd.service

[Service]
Type=simple
ExecStart=/usr/local/bin/deploy_kit_ssh_events.sh
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now nexus404-ssh-events.service >> "$LOGFILE" 2>&1

    if systemctl is-active --quiet nexus404-ssh-events.service; then
        echo "${GREEN}[✓]${NC} Слежение за SSH-входом запущено — событие на каждую попытку,"
        echo "    успешную или нет, появится в модуле \"Оповещения\" на хабе"
        echo "    (если хаб-платформа ещё не установлена — событие просто некому"
        echo "    записать, event_hook.sh появится позже, ошибок из-за этого нет)"
    else
        echo "${RED}[!]${NC} nexus404-ssh-events.service не запустился — проверьте:"
        echo "    systemctl status nexus404-ssh-events.service"
    fi

    echo "${GREEN}[✓]${NC} Шаг 13b завершён успешно"
    mark_done "step1_13b"
fi

# ================== ШАГ 14 ==================
if is_done "step1_14"; then
    :
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 14: Финальная проверка"
    echo "===========================================================================${NC}"
    echo "${CYAN}[*]${NC} Проверяю, что все предыдущие шаги реально применились..."
    echo ""

    CHECK_FAILED=0
    CHECK_USER=$(read_or_default "$USERFILE" "")
    CHECK_PORT=$(read_or_default "$PORTFILE" "22")

    echo "===== Результаты финальной проверки ($(date '+%Y-%m-%d %H:%M:%S')) =====" >> "$LOGFILE"

    # порядок проверок соответствует порядку самих шагов (1..13)
    check_item "DNS настроен" bash -c "grep -q nameserver /etc/resolv.conf || grep -q '^DNS=' /etc/systemd/resolved.conf"
    check_item "Swap активен" bash -c "swapon --show | grep -q ."
    check_item "BBR включён" bash -c "[ \"\$(sysctl -n net.ipv4.tcp_congestion_control)\" = bbr ]"
    check_item "Auditd запущен" systemctl is-active --quiet auditd
    if [ -z "$CHECK_USER" ]; then
        echo "${RED}[!]${NC}  Sudo-пользователь не найден"
        echo "    (файл $USERFILE отсутствует)"
        CHECK_FAILED=$((CHECK_FAILED + 1))
        sleep 0.3
    else
        check_item "Sudo-пользователь '$CHECK_USER' существует" bash -c "id '$CHECK_USER'"
        check_item "Пользователь '$CHECK_USER' в группе sudo" bash -c "id -nG '$CHECK_USER' | grep -qw sudo"
    fi
    check_item "Root заблокирован" bash -c "passwd -S root | awk '{print \$2}' | grep -q '^L'"
    check_item "SSH реально слушает порт $CHECK_PORT" bash -c "ss -tln | grep -q ':$CHECK_PORT '"
    check_item "SSH-служба запущена" bash -c "systemctl is-active --quiet sshd || systemctl is-active --quiet ssh"
    # Важен факт (что-то слушает порт и переживёт перезагрузку), не то,
    # через ssh.socket или напрямую через service — оба варианта рабочие.
    check_item "SSH настроен на автозапуск при загрузке" bash -c "systemctl is-enabled --quiet sshd 2>/dev/null || systemctl is-enabled --quiet ssh 2>/dev/null || systemctl is-enabled --quiet ssh.socket 2>/dev/null"
    check_item "Файрвол (ufw) активен" bash -c "ufw status | grep -q 'Status: active'"
    check_item "Fail2ban запущен" systemctl is-active --quiet fail2ban
    check_item "Конфиг fail2ban создан" test -f /etc/fail2ban/jail.local
    check_item "AppArmor запущен" systemctl is-active --quiet apparmor
    check_item "NTP синхронизирован" bash -c "[ \"\$(timedatectl show -p NTPSynchronized --value)\" = yes ]"
    check_item "Лимиты nofile настроены" test -f /etc/security/limits.d/99-deploy-kit.conf
    check_item "Cron: еженедельная перезагрузка" test -f /etc/cron.d/deploy_kit_weekly_reboot
    check_item "Cron: автоочистка" test -f /etc/cron.d/deploy_kit_cleanup
    check_item "unattended-upgrades настроен" test -f /etc/apt/apt.conf.d/51-deploy-kit-security-only.conf
    check_item "Cron: health-checker" test -f /etc/cron.d/deploy_kit_healthcheck
    check_item "Слежение за SSH-входом запущено" systemctl is-active --quiet nexus404-ssh-events.service

    echo ""
    if [ "$CHECK_FAILED" -eq 0 ]; then
        echo "${GREEN}[✓]${NC} Все проверки пройдены успешно"
    else
        echo "${RED}[!]${NC} Проверок с ошибкой: $CHECK_FAILED — просмотрите список выше,"
        echo "    что-то могло не примениться"
    fi

    echo "${GREEN}[✓]${NC} Шаг 14 завершён успешно"
    mark_done "step1_14"
fi

# ================== ШАГ 15 ==================
if is_done "step1_15"; then
    :
else
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  ШАГ 15: Финальный отчёт"
    echo "===========================================================================${NC}"
    echo "${CYAN}[*]${NC} Итоговые данные для подключения — см. ниже, после завершения модуля"

    echo "${GREEN}[✓]${NC} Шаг 15 завершён успешно"
    mark_done "step1_15"
fi

# скрытый флаг: подтверждает, что deploy_kit уже здесь разворачивался
{
    echo "DK_VERSION=$DK_VERSION"
    echo "INSTALLED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "SUDO_USER=$(read_or_default "$USERFILE" "-")"
    echo "SSH_PORT=$(read_or_default "$PORTFILE" "22")"
    echo "STEPS_DONE=$(tr '\n' ',' < "$STATEFILE" | sed 's/,$//')"
} > "$FLAGFILE"
chmod 644 "$FLAGFILE"

echo ""
echo "${BOLD}${CYAN}==========================================================================="
echo "  Базовая настройка сервера завершена — сохраните эту информацию."
echo "===========================================================================${NC}"

REPORT_USER=$(read_or_default "$USERFILE" "не задан")
REPORT_PORT=$(read_or_default "$PORTFILE" "22")
REPORT_IP=$(hostname -I | awk '{print $1}')

echo "$(pad_field "IP сервера:" "$FIELD_WIDTH")$REPORT_IP"
echo "$(pad_field "Sudo-пользователь:" "$FIELD_WIDTH")$REPORT_USER"
echo "$(pad_field "SSH-порт:" "$FIELD_WIDTH")$REPORT_PORT"
echo "$(pad_field "Root:" "$FIELD_WIDTH")заблокирован (пароль)"

if [ -f "$AUTHMETHODFILE" ] && [ "$(cat "$AUTHMETHODFILE")" == "key" ]; then
    echo "$(pad_field "Вход:" "$FIELD_WIDTH")по SSH-ключу"
    echo ""
    echo "Команда подключения:"
    echo "    ssh -p $REPORT_PORT -i /путь/к/вашему/приватному/ключу ${REPORT_USER}@${REPORT_IP}"
else
    echo "$(pad_field "Вход:" "$FIELD_WIDTH")по паролю"
    echo ""
    echo "Команда подключения:"
    echo "    ssh -p $REPORT_PORT ${REPORT_USER}@${REPORT_IP}"
fi

echo ""
echo "$(pad_field "Бэкапы конфигов:" "$FIELD_WIDTH")${SSHD_CONFIG}.bak.*"
echo "$(pad_field "Полный лог установки:" "$FIELD_WIDTH")$LOGFILE"
echo "$(pad_field "Лог health-checker:" "$FIELD_WIDTH")$HEALTHLOG"
echo ""

