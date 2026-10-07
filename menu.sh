#!/bin/sh
# Загрузка Node.js; вся установка проекта — в JavaScript.
main() {
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
[ "$(id -u)" = 0 ] || { echo 'Запусти через sudo.'; exit 1; }
[ -d /run/systemd/system ] || { echo 'Нужен сервер Debian/Ubuntu с systemd.'; exit 1; }
case "$(sed -n 's/^ID=//p' /etc/os-release | tr -d '\"')" in
    debian|ubuntu) ;; *) echo 'Поддерживаются Debian и Ubuntu.'; exit 1;;
esac
# Пайп curl не используется для ответов меню.
: </dev/tty || { echo 'Нужен интерактивный терминал.'; exit 1; }
install_tools() {
    apt-get -o DPkg::Lock::Timeout=120 update
    DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y ca-certificates curl git xz-utils util-linux
}
project_dir=''
if [ -z "${NEXUS_REPO+x}" ] && [ "${0##*/}" = menu.sh ] && [ -f "$0" ]; then
    local_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
    [ ! -f "$local_dir/menu.mjs" ] || project_dir=$local_dir
fi
repo=${NEXUS_REPO:-0xERR404/nexus}
branch=${NEXUS_BRANCH:-main}
if [ -z "$project_dir" ]; then
    printf '%s\n' "$repo" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$' || { echo 'NEXUS_REPO: OWNER/REPO'; exit 1; }
    printf '%s\n' "$branch" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9_./-]*$' || { echo 'Некорректная ветка.'; exit 1; }
    case "$repo/$branch" in *..*|*//*) echo 'Некорректный путь репозитория или ветки.'; exit 1;; esac
    if ! command -v git >/dev/null || ! command -v curl >/dev/null || ! command -v flock >/dev/null; then install_tools; fi
fi
if ! /usr/local/bin/nexus404-node -e 'process.exit(+process.versions.node.split(".")[0]>=24?0:1)' 2>/dev/null; then
    install_tools
    case "$(uname -m)" in x86_64) node_arch=x64;; aarch64) node_arch=arm64;; *) echo 'Нужен Linux x64 или arm64.'; exit 1;; esac
    node_temp=$(mktemp -d)
    trap 'rm -rf "$node_temp"' EXIT
    trap 'exit 130' HUP INT TERM
    curl -fsSL --retry 3 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$node_temp/SHASUMS256.txt"
    node_archive=$(awk -v arch="$node_arch" '$2 ~ "^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$" { print $2 }' "$node_temp/SHASUMS256.txt")
    [ -n "$node_archive" ] || { echo 'Не найден Node.js 24.'; exit 1; }
    node_version=${node_archive#node-}
    node_version=${node_version%-linux-*}
    curl -fsSL --retry 3 --max-filesize 200000000 "https://nodejs.org/dist/$node_version/$node_archive" -o "$node_temp/$node_archive"
    (cd "$node_temp" && grep "  $node_archive\$" SHASUMS256.txt | sha256sum -c -)
    mkdir -p /opt/nexus404/runtime /usr/local/bin
    chmod 755 /opt/nexus404 /opt/nexus404/runtime
    (
        flock -x 9
        tar -xJf "$node_temp/$node_archive" -C "$node_temp"
        node_target=/opt/nexus404/runtime/node-$node_version-linux-$node_arch
        [ -d "$node_target" ] || mv "$node_temp/node-$node_version-linux-$node_arch" "$node_target"
        chmod 755 "$node_target"
        "$node_target/bin/node" --version
        ln -sfn "$node_target/bin/node" /usr/local/bin/nexus404-node
    ) 9>/run/lock/nexus404-runtime.lock
    rm -rf "$node_temp"
    trap - EXIT HUP INT TERM
fi
if [ -n "$project_dir" ]; then
    exec /usr/local/bin/nexus404-node "$project_dir/menu.mjs" "$@" </dev/tty
fi
bootstrap_temp=$(mktemp -d)
trap 'rm -rf "$bootstrap_temp"' EXIT
trap 'exit 130' HUP INT TERM
curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 10 --max-time 120 \
    "https://raw.githubusercontent.com/$repo/$branch/bootstrap.mjs" -o "$bootstrap_temp/bootstrap.mjs"
/usr/local/bin/nexus404-node "$bootstrap_temp/bootstrap.mjs" \
    --repo "$repo" --branch "$branch" --directory "${NEXUS_DIRECTORY:-/opt/nexus404-repo}" -- "$@" </dev/tty
}
main "$@"
