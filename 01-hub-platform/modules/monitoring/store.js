// NEXUS404 — хранилище метрик модуля мониторинга.
//
// /app/data смонтирован host-bridge'ем как персистентная папка (теперь
// есть у КАЖДОГО модуля, не только у этого — см. bridge.py) — переживает
// docker rm -f при каждом перезапуске хаба. Текущие значения держим
// только в памяти (не обязаны переживать перезапуск, обновятся в первый
// же тик), на диск пишем только историю — ради графиков за 24ч.

const fs = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = process.env.MODULE_DATA_DIR || '/app/data';

// Было раз в 1с — реальной пользы для глаза почти нет, а лишний тик —
// это реальное чтение /proc, диска и сети каждую секунду. 5с — с
// запасом ниже OFFLINE_AFTER_MS (15с), "живость" не пострадает.
// Офлайн-порог не привязан к SAMPLE_INTERVAL_MS — удалённые агенты
// шлют реже (см. install-agent.sh), иначе всегда считались бы "оффлайн".
const SAMPLE_INTERVAL_MS = 5000;
// 48ч — с запасом сверх 24ч, которые реально показываем на графике.
const HISTORY_RETENTION_MS = 48 * 60 * 60 * 1000;
// Фиксированный порог — должен с запасом покрывать интервал агента по
// умолчанию (2с, install-agent.sh) плюс сетевые заминки.
const OFFLINE_AFTER_MS = 15000;

const latestByServer = new Map(); // name -> { isLocal, lastSeen, ...metrics }

function safeFileName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'server';
}

function historyFile(name) {
  return path.join(DATA_DIR, `history-${safeFileName(name)}.jsonl`);
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

// Стабильное имя ЛОКАЛЬНОГО сервера, если LOCAL_SERVER_NAME не задан.
//
// Раньше запасным вариантом был os.hostname() — не персистентный: при
// каждом `docker rm -f` + новый `docker run` контейнер получает новый
// хостнейм, монитор считал это новым сервером (баг: "при обновлении
// создаётся новая карточка"). LOCAL_SERVER_NAME мог реально быть пустой
// строкой (не отсутствовать) — falsy в JS, уходило в hostname всё равно.
//
// Исправление — свой независимый запасной вариант в модуле: если пуст,
// один раз генерируем имя и сохраняем в /app/data (переживает
// `docker rm -f`), при следующем запуске читаем уже сохранённое.
const LOCAL_IDENTITY_FILE = path.join(DATA_DIR, 'local-server-identity.txt');

async function resolveLocalServerName(hostnameFallback) {
  const explicit = (process.env.LOCAL_SERVER_NAME || '').trim();
  if (explicit) return explicit;

  try {
    const saved = (await fs.readFile(LOCAL_IDENTITY_FILE, 'utf-8')).trim();
    if (saved) return saved;
  } catch {
    // файла ещё нет — первый запуск без LOCAL_SERVER_NAME, создаём ниже
  }

  const generated = hostnameFallback || 'server';
  try {
    await ensureDir();
    await fs.writeFile(LOCAL_IDENTITY_FILE, generated);
  } catch {
    // не удалось сохранить — не критично для ЭТОГО запуска (имя всё
    // равно используется), просто при следующем пересоздании контейнера
    // придётся сгенерировать заново
  }
  return generated;
}

async function recordSample(name, isLocal, metrics) {
  const now = new Date().toISOString();
  latestByServer.set(name, { isLocal, lastSeen: now, ...metrics });
  await ensureDir();
  // Имя и isLocal — прямо в строке истории, не только в имени файла:
  // safeFileName необратимо схлопывает символы, восстановить оригинал
  // из имени файла при рестарте модуля нельзя.
  const line = JSON.stringify({ t: now, name, isLocal, ...metrics }) + '\n';
  await fs.appendFile(historyFile(name), line);
}

function listServers() {
  const now = Date.now();
  return Array.from(latestByServer.entries())
    .map(([name, data]) => ({
      name,
      ...data,
      online: now - new Date(data.lastSeen).getTime() < OFFLINE_AFTER_MS,
    }))
    // Локальный сервер всегда первым — это "главный", остальные агенты
    // после него, по алфавиту, чтобы порядок не прыгал между обновлениями.
    .sort((a, b) => (a.isLocal === b.isLocal ? a.name.localeCompare(b.name) : a.isLocal ? -1 : 1));
}

function getServerLatest(name) {
  return latestByServer.get(name) || null;
}

// Удаление сервера — убирает и текущую запись в памяти, и историю на
// диске. Если это ещё активный сервер/агент — запись появится заново на
// следующем тике, это ожидаемо, не баг.
async function removeServer(name) {
  const existed = latestByServer.delete(name);
  try {
    await fs.unlink(historyFile(name));
  } catch {
    // файла истории могло не быть — не ошибка
  }
  return existed;
}

// Бакетинг в ~288 точек (5-минутные окна на 24ч) — иначе на клиент
// уходит по несколько тысяч точек на метрику при интервале сэмплов 15с,
// без всякой пользы для видимой на экране линии.
function bucketSamples(samples, bucketMs, fields) {
  if (samples.length === 0) return [];
  const buckets = new Map();
  for (const s of samples) {
    const bucketKey = Math.floor(new Date(s.t).getTime() / bucketMs);
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, { count: 0, sums: {} });
    const bucket = buckets.get(bucketKey);
    bucket.count += 1;
    for (const f of fields) bucket.sums[f] = (bucket.sums[f] || 0) + (Number(s[f]) || 0);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucketKey, bucket]) => {
      const point = { t: new Date(bucketKey * bucketMs).toISOString() };
      for (const f of fields) point[f] = bucket.sums[f] / bucket.count;
      return point;
    });
}

async function loadHistory(name, hours) {
  let raw;
  try {
    raw = await fs.readFile(historyFile(name), 'utf-8');
  } catch {
    return [];
  }
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const samples = raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((s) => s && new Date(s.t).getTime() >= cutoff);

  const bucketMs = Math.max(SAMPLE_INTERVAL_MS, Math.floor((hours * 60 * 60 * 1000) / 288));
  return bucketSamples(samples, bucketMs, [
    'cpuPercent',
    'ramUsedBytes',
    'ramTotalBytes',
    'diskUsedBytes',
    'diskTotalBytes',
    'netRxBytesPerSec',
    'netTxBytesPerSec',
    'uptimeSeconds',
  ]);
}

// Чистка старых строк — раз в час, не на каждую запись. 48ч ретеншен не
// обязан резаться миллисекунда в миллисекунду.
async function pruneOldHistory() {
  await ensureDir();
  let files;
  try {
    files = await fs.readdir(DATA_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - HISTORY_RETENTION_MS;
  for (const file of files) {
    if (!file.startsWith('history-') || !file.endsWith('.jsonl')) continue;
    const filePath = path.join(DATA_DIR, file);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const kept = raw
        .trim()
        .split('\n')
        .filter(Boolean)
        .filter((line) => {
          try {
            return new Date(JSON.parse(line).t).getTime() >= cutoff;
          } catch {
            return false;
          }
        });
      await fs.writeFile(filePath, kept.length ? kept.join('\n') + '\n' : '');
    } catch {
      // файл мог исчезнуть между readdir и чтением — не критично
    }
  }
}

// При старте модуля восстанавливаем последнюю известную точку каждого
// сервера из истории на диске — иначе список серверов пустует до
// следующего отчёта (для локального — до первого тика сборщика, для
// удалённых агентов — может быть минуты).
async function restoreLatestFromHistory() {
  await ensureDir();
  let files;
  try {
    files = await fs.readdir(DATA_DIR);
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.startsWith('history-') || !file.endsWith('.jsonl')) continue;
    try {
      const raw = await fs.readFile(path.join(DATA_DIR, file), 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      if (lines.length === 0) continue;
      const last = JSON.parse(lines[lines.length - 1]);
      if (last.name) {
        const { t, name, isLocal, ...metrics } = last;
        latestByServer.set(name, { isLocal: !!isLocal, lastSeen: t, ...metrics });
      }
    } catch {
      // повреждённая строка — пропускаем, не валим запуск модуля
    }
  }
}

module.exports = {
  SAMPLE_INTERVAL_MS,
  recordSample,
  listServers,
  getServerLatest,
  removeServer,
  loadHistory,
  pruneOldHistory,
  restoreLatestFromHistory,
  resolveLocalServerName,
};
