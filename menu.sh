#!/bin/bash
# =============================================================================
# NEXUS404 — меню установки
#
# Работает в двух режимах:
#   1) Из уже склонированного репозитория: bash menu.sh
#   2) Через curl (сам клонирует репозиторий, если его тут нет рядом):
#        curl -fsSL https://raw.githubusercontent.com/0xERR404/nexus/main/menu.sh | sudo bash
#
# Каждый пункт меню запускает свой самостоятельный, самодостаточный скрипт
# (у каждого — своё сохранение прогресса). Меню — просто удобная навигация,
# не общая логика/зависимость между шагами.
# =============================================================================

set -uo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Запусти от root (sudo bash menu.sh)."
    exit 1
fi

REPO_URL="https://github.com/0xERR404/nexus.git"
FALLBACK_DIR="/opt/nexus404-repo"

if [ -t 1 ]; then
    BOLD=$'\033[1m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'
    RED=$'\033[31m'; YELLOW=$'\033[33m'; NC=$'\033[0m'
else
    BOLD=""; CYAN=""; GREEN=""; RED=""; YELLOW=""; NC=""
fi

# Определяем, откуда реально запущен скрипт. Если рядом уже лежит
# 00-base-server (то есть мы внутри склонированного репозитория) —
# используем этот путь. Если нет (например, запущено через curl | bash,
# где у скрипта нет постоянного пути на диске) — клонируем репозиторий и
# передаём управление копии оттуда.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"

if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/00-base-server" ]; then
    REPO_DIR="$SCRIPT_DIR"
else
    REPO_DIR="$FALLBACK_DIR"
    echo "${CYAN}[*]${NC} Запущено не из репозитория — клонирую в $REPO_DIR..."
    command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git; }
    if [ -d "$REPO_DIR" ]; then
        # reset --hard, не pull — та же логика, что и раньше: локальные
        # правки в этой директории не должны мешать обновлению.
        git -C "$REPO_DIR" fetch -q origin
        git -C "$REPO_DIR" reset -q --hard origin/main
    else
        git clone -q "$REPO_URL" "$REPO_DIR"
    fi
    exec bash "$REPO_DIR/menu.sh"
fi

pause() {
    echo ""
    read -rp "Нажми Enter, чтобы вернуться в меню..." _ < /dev/tty
}

while true; do
    clear 2>/dev/null || true
    echo "${BOLD}${CYAN}==========================================================================="
    echo "  NEXUS404 — установка"
    echo "===========================================================================${NC}"
    echo ""
    echo "  1) Базовая настройка сервера — SSH, firewall, автообновления"
    echo "  2) Хаб-платформа — установка (Docker, Caddy, хаб) ${YELLOW}[после 1]${NC}"
    echo "  3) Хаб-платформа — обновить ${YELLOW}[после 2]${NC}"
    echo "  4) Агент мониторинга — установка на ЭТОТ сервер (для доп. серверов)"
    echo ""
    echo "  0) Выход"
    echo ""

    if [ -f /var/lib/nexus404-base/state ]; then
        DONE=$(grep -c '^step1_' /var/lib/nexus404-base/state 2>/dev/null || echo 0)
        echo "  ${CYAN}[*]${NC} Базовая настройка: $DONE из 15 шагов"
    fi
    if [ -f /var/lib/nexus404-hub/state ]; then
        echo "  ${CYAN}[*]${NC} Хаб-платформа: установлена"
    fi
    if [ -f /etc/systemd/system/nexus404-agent.service ]; then
        AGENT_STATE=$(systemctl is-active nexus404-agent.service 2>/dev/null || echo "неизвестно")
        echo "  ${CYAN}[*]${NC} Агент мониторинга: установлен (${AGENT_STATE})"
    fi
    echo ""

    read -rp "Выбор: " CHOICE < /dev/tty || exit 1

    case "$CHOICE" in
        1)
            bash "$REPO_DIR/00-base-server/nexus404-base-setup.sh"
            pause
            ;;
        2)
            if [ ! -f /var/lib/nexus404-base/state ] || [ "$(grep -c '^step1_' /var/lib/nexus404-base/state 2>/dev/null || echo 0)" -lt 15 ]; then
                echo "${YELLOW}[?]${NC} Базовая настройка (пункт 1), похоже, ещё не завершена."
                read -rp "Всё равно продолжить? (yes/no): " CONT < /dev/tty
                [ "$CONT" != "yes" ] && continue
            fi
            (cd "$REPO_DIR/01-hub-platform" && bash install-hub-platform.sh)
            pause
            ;;
        3)
            if [ ! -f /var/lib/nexus404-hub/state ]; then
                echo "${RED}[!]${NC} Хаб-платформа ещё не устанавливалась (пункт 2) — обновлять нечего."
                sleep 2
                continue
            fi
            echo "${CYAN}[*]${NC} Синхронизирую репозиторий..."
            git -C "$REPO_DIR" fetch -q origin
            git -C "$REPO_DIR" reset -q --hard origin/main
            (cd "$REPO_DIR/01-hub-platform" && bash update.sh)
            pause
            ;;
        4)
            # Независим от пунктов 1-3: агент — обычный systemd-сервис на
            # голом Python (см. agent/agent.py), не требует ни Docker, ни
            # базовой настройки, ни самого хаба — рассчитан на то, чтобы
            # ставиться на ДРУГОЙ сервер (не тот, где живёт хаб), метрики
            # которого должны появиться в модуле "Системные ресурсы".
            echo "${CYAN}[*]${NC} Синхронизирую репозиторий..."
            git -C "$REPO_DIR" fetch -q origin
            git -C "$REPO_DIR" reset -q --hard origin/main
            bash "$REPO_DIR/01-hub-platform/agent/install-agent.sh"
            pause
            ;;
        0)
            echo "Пока."
            exit 0
            ;;
        *)
            echo "${RED}[!]${NC} Некорректный выбор"
            sleep 1
            ;;
    esac
done
