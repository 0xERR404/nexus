#!/bin/bash
# =============================================================================
# NEXUS404 — установка агента на удалённый сервер
#
# Один агент — две задачи: метрики (CPU/RAM/диск/сеть — модуль "Системные
# ресурсы") и, если на этом сервере тоже настроен 00-base-server, пересылка
# его локальных событий (вход, обновления, перезагрузки, очистка — модуль
# "Оповещения"). Второе — необязательно, агент сам определяет, есть ли что
# пересылать, отдельно настраивать не нужно.
#
# Запускать НА ТОМ СЕРВЕРЕ, метрики которого должны появиться в модуле
# "Системные ресурсы" хаба. Ставится независимо от хаба — обычный
# systemd-сервис на хосте, без Docker (агенту нечего изолировать, он и
# так работает от root ради чтения /proc и статистики диска — то же самое
# доверие, что и у host-bridge на основном сервере хаба).
#
# Использование:
#   sudo bash install-agent.sh
# либо без вопросов (например, в облачном cloud-init):
#   NEXUS_AGENT_NAME="web-1" \
#   NEXUS_AGENT_HUB_URL="https://your-domain.example.com" \
#   NEXUS_AGENT_TOKEN="..." \
#   sudo -E bash install-agent.sh
# =============================================================================

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Запусти от root (sudo bash install-agent.sh)."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/nexus404-agent"
CONFIG_DIR="/etc/nexus404-agent"

echo "==========================================================================="
echo "  NEXUS404 — агент мониторинга"
echo "==========================================================================="
echo ""

# Название сервера — единственное, что реально нужно ввести руками: это
# то самое "название" из плана ("при развёртывании нужно указывать
# название сервера") — без него в интерфейсе хаба было бы просто
# безымянное множество одинаковых карточек.
SERVER_NAME="${NEXUS_AGENT_NAME:-}"
if [ -z "$SERVER_NAME" ]; then
    read -rp "Название этого сервера (появится в хабе): " SERVER_NAME < /dev/tty
fi
if [ -z "$SERVER_NAME" ]; then
    echo "Название не может быть пустым."
    exit 1
fi

HUB_URL="${NEXUS_AGENT_HUB_URL:-}"
if [ -z "$HUB_URL" ]; then
    read -rp "URL хаба (например, https://your-domain.example.com): " HUB_URL < /dev/tty
fi
HUB_URL="${HUB_URL%/}"
if [ -z "$HUB_URL" ]; then
    echo "URL хаба не может быть пустым."
    exit 1
fi

TOKEN="${NEXUS_AGENT_TOKEN:-}"
if [ -z "$TOKEN" ]; then
    read -rsp "Токен агентов (см. AI API -> мониторинг -> общий токен агентов в хабе): " TOKEN < /dev/tty
    echo ""
fi
if [ -z "$TOKEN" ]; then
    echo "Токен не может быть пустым — сгенерируй его в интерфейсе AI API на хабе."
    exit 1
fi

command -v python3 >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq python3; }

echo "[*] Копирую агента в $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/agent.py" "$INSTALL_DIR/agent.py"
chmod 700 "$INSTALL_DIR/agent.py"

echo "[*] Пишу конфиг в $CONFIG_DIR..."
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
cat > "$CONFIG_DIR/config.json" << EOF
{
  "server_name": "${SERVER_NAME}",
  "hub_url": "${HUB_URL}",
  "token": "${TOKEN}",
  "interval_seconds": 2
}
EOF
chmod 600 "$CONFIG_DIR/config.json"

echo "[*] Устанавливаю systemd-сервис..."
cp "$SCRIPT_DIR/nexus404-agent.service" /etc/systemd/system/nexus404-agent.service
systemctl daemon-reload
systemctl enable --now nexus404-agent.service

echo ""
echo "[✓] Готово. Сервер '${SERVER_NAME}' должен появиться в модуле"
echo "    'Системные ресурсы' на хабе в течение ~15 секунд."
echo ""
echo "Заодно, если на этом сервере тоже стоит 00-base-server (fail2ban,"
echo "автообновления, автоочистка, плановая перезагрузка) — события с него"
echo "начнут появляться и в модуле 'Оповещения' на хабе, тем же агентом,"
echo "тем же токеном. Если 00-base-server тут не запускался — не страшно,"
echo "агент просто не найдёт файл журнала событий и продолжит слать только"
echo "метрики, как и раньше."
echo ""
echo "Проверить: sudo systemctl status nexus404-agent.service"
echo "Логи:      sudo journalctl -u nexus404-agent.service -f"
