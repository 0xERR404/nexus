// NEXUS404 — сбор метрик ХОСТА (не контейнера) для локального сервера.
//
// Работает только потому, что host-bridge монтирует этому конкретному
// модулю /proc и корень хоста только на чтение (см. bridge.py,
// module_ensure_running — точечное исключение по имени "monitoring", не
// общее правило для всех модулей). Без этих монтирований здесь были бы
// видны только цифры самого контейнера — бессмысленно для мониторинга
// сервера в целом.

const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const PROC_DIR = process.env.HOST_PROC_DIR || '/host/proc';
const ROOT_DIR = process.env.HOST_ROOT_DIR || '/host/root';

// CPU% нельзя посчитать по одному снимку /proc/stat — там кумулятивные
// счётчики jiffies с момента загрузки хоста, не мгновенное значение.
// Нужны два снимка с разницей во времени; храним предыдущий между тиками.
let prevCpu = null;

function parseCpuLine(line) {
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = parts;
  const idleTotal = idle + iowait;
  const total = user + nice + system + idleTotal + irq + softirq + steal;
  return { idleTotal, total };
}

async function readCpuPercent() {
  const raw = await fs.readFile(`${PROC_DIR}/stat`, 'utf-8');
  const cur = parseCpuLine(raw.split('\n')[0]);
  if (!prevCpu) {
    prevCpu = cur;
    return 0; // первый тик после старта — сравнивать не с чем, честный 0
  }
  const totalDelta = cur.total - prevCpu.total;
  const idleDelta = cur.idleTotal - prevCpu.idleTotal;
  prevCpu = cur;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

// Число ядер — строки "cpu0", "cpu1", ... в /proc/stat (сама строка
// "cpu " без номера — суммарная по всем ядрам, не считается). Показывать
// просто "23%" рядом с остальными двузначными парами (5.0 ГБ / 59.0 ГБ)
// смотрелось одиноко — с числом ядер это тоже пара значений.
async function readCpuCores() {
  const raw = await fs.readFile(`${PROC_DIR}/stat`, 'utf-8');
  return raw.split('\n').filter((line) => /^cpu\d+\s/.test(line)).length || 1;
}

async function readMemory() {
  const raw = await fs.readFile(`${PROC_DIR}/meminfo`, 'utf-8');
  const lines = raw.split('\n');
  const get = (key) => {
    const line = lines.find((l) => l.startsWith(key + ':'));
    const match = line && line.match(/(\d+)/);
    return match ? Number(match[1]) * 1024 : 0; // kB -> байты
  };
  const total = get('MemTotal');
  const available = get('MemAvailable');
  return { ramTotalBytes: total, ramUsedBytes: Math.max(0, total - available) };
}

async function readDisk() {
  // df на bind-смонтированный (только чтение) корень хоста — та же самая
  // файловая система хоста, просто видна из контейнера по другому пути.
  // ЧЕСТНАЯ ОГОВОРКА: busybox df (node:alpine) не понимает GNU-флаг
  // --output, поэтому разбираем стандартные позиционные колонки
  // (Filesystem, 1K-blocks, Used, Available, Use%, Mounted on) — этот
  // формат одинаков и у busybox, и у GNU coreutils df.
  try {
    const { stdout } = await execFileAsync('df', ['-k', ROOT_DIR]);
    const dataLine = stdout.trim().split('\n').pop().trim().split(/\s+/);
    const totalKb = Number(dataLine[1]);
    const usedKb = Number(dataLine[2]);
    if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb)) throw new Error('не удалось разобрать df');
    return { diskUsedBytes: usedKb * 1024, diskTotalBytes: totalKb * 1024 };
  } catch {
    return { diskUsedBytes: 0, diskTotalBytes: 0 };
  }
}

let prevNet = null;

async function readNetworkRate() {
  const raw = await fs.readFile(`${PROC_DIR}/net/dev`, 'utf-8');
  const lines = raw.split('\n').slice(2); // первые 2 строки — заголовки таблицы
  let rx = 0;
  let tx = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sepIdx = trimmed.indexOf(':');
    if (sepIdx === -1) continue;
    const iface = trimmed.slice(0, sepIdx).trim();
    if (iface === 'lo') continue; // loopback не реальный сетевой трафик
    const fields = trimmed.slice(sepIdx + 1).trim().split(/\s+/).map(Number);
    rx += fields[0] || 0; // receive bytes — колонка 1
    tx += fields[8] || 0; // transmit bytes — колонка 9
  }
  const now = Date.now();
  if (!prevNet) {
    prevNet = { rx, tx, at: now };
    return { netRxBytesPerSec: 0, netTxBytesPerSec: 0 };
  }
  const deltaSec = (now - prevNet.at) / 1000;
  const rxRate = deltaSec > 0 ? Math.max(0, (rx - prevNet.rx) / deltaSec) : 0;
  const txRate = deltaSec > 0 ? Math.max(0, (tx - prevNet.tx) / deltaSec) : 0;
  prevNet = { rx, tx, at: now };
  return { netRxBytesPerSec: rxRate, netTxBytesPerSec: txRate };
}

async function readUptimeSeconds() {
  try {
    const raw = await fs.readFile(`${PROC_DIR}/uptime`, 'utf-8');
    return Math.floor(Number(raw.trim().split(/\s+/)[0]));
  } catch {
    return 0;
  }
}

async function collectLocalMetrics() {
  const [cpuPercent, cpuCores, memory, disk, network, uptimeSeconds] = await Promise.all([
    readCpuPercent(),
    readCpuCores(),
    readMemory(),
    readDisk(),
    readNetworkRate(),
    readUptimeSeconds(),
  ]);
  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    cpuCores,
    ...memory,
    ...disk,
    ...network,
    uptimeSeconds,
  };
}

module.exports = { collectLocalMetrics };
