const fs = require('node:fs/promises');
const path = require('node:path');

// Версия формата кэша. Поднимите её, если поменяете структуру данных
// внутри — старые файлы кэша перестанут считаться валидными и
// перескачаются заново.
const CACHE_FORMAT_VERSION = 1;

function makeCache(cacheDir, defaultTtlHours) {
  function cachePath(key) {
    const safeKey = key.replace(/\//g, '_').replace(/ /g, '_');
    return path.join(cacheDir, `${safeKey}.json`);
  }

  // Возвращает {data, ageHours} БЕЗ проверки TTL — решение "ещё свежо или
  // уже нет" принимает вызывающий код (см. _achievements_cache_ttl_hours
  // в исходнике — у "без ачивок"/"100% пройдено" свой, более длинный
  // порог свежести, чем у "в процессе"). null, если записи нет или битая.
  async function cacheGetWithAge(key) {
    const p = cachePath(key);
    let payload;
    try {
      const raw = await fs.readFile(p, 'utf-8');
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
    if (payload._version !== CACHE_FORMAT_VERSION) return null;
    const ageHours = (Date.now() / 1000 - (payload._cachedAt || 0)) / 3600;
    return { data: payload.data, ageHours };
  }

  // Обычная проверка TTL поверх cacheGetWithAge.
  async function cacheGet(key, ttlHours = defaultTtlHours) {
    const cached = await cacheGetWithAge(key);
    if (cached === null) return null;
    if (cached.ageHours > ttlHours) return null;
    return cached.data;
  }

  async function cacheSet(key, data) {
    const p = cachePath(key);
    const payload = { _version: CACHE_FORMAT_VERSION, _cachedAt: Date.now() / 1000, data };
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(p, JSON.stringify(payload), 'utf-8');
  }

  // Вернуть данные из кэша, если свежие; иначе вызвать fetchFn(), сохранить и вернуть.
  async function cachedCall(key, fetchFn, ttlHours = defaultTtlHours) {
    const cached = await cacheGet(key, ttlHours);
    if (cached !== null) return cached;
    const fresh = await fetchFn();
    await cacheSet(key, fresh);
    return fresh;
  }

  return { cacheGetWithAge, cacheGet, cacheSet, cachedCall };
}

module.exports = { makeCache };
