// RetroAchievements Web API (https://retroachievements.org/APIDemo.php).
// Авторизация — статические query-параметры z (username) и y (api key),
// не OAuth, аналогично Steam-ключу. Фабрика createRetroApi({username,
// apiKey}) — та же причина, что и у steamApi.js: ключи из хаба, не
// глобальные константы.
const { makeRateLimiter } = require('./rateLimiter.js');

const BASE_URL = 'https://retroachievements.org/API';

// RA не документирует точный rate-limit так же явно, как Steam — по опыту
// сообщества, несколько запросов в секунду безопасно. Консервативная пауза.
const REQUEST_DELAY = 0.5;
const CONCURRENCY = 3;

function createRetroApi({ username, apiKey, logger = console }) {
  const limiter = makeRateLimiter(REQUEST_DELAY, CONCURRENCY);

  async function get(endpoint, params = {}, timeoutMs = 15000, maxRetries = 3) {
    const url = `${BASE_URL}/${endpoint}.php`;
    const query = { z: username, y: apiKey, ...params };
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let res;
      try {
        res = await limiter.run(() => fetchWithTimeout(withParams(url, query), timeoutMs));
      } catch (e) {
        if (attempt < maxRetries - 1) {
          await sleep(2 ** (attempt + 1) * 1000);
          continue;
        }
        logger.warn(`Не удалось получить ${endpoint} от RA API: ${e.message}`);
        return {};
      }
      if (res.status === 429 && attempt < maxRetries - 1) {
        const wait = 2 ** (attempt + 1);
        logger.warn(`429 от RA API (${endpoint}), жду ${wait}с...`);
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok) {
        if (attempt < maxRetries - 1) {
          await sleep(2 ** (attempt + 1) * 1000);
          continue;
        }
        logger.warn(`Не удалось получить ${endpoint} от RA API: HTTP ${res.status}`);
        return {};
      }
      try {
        return await res.json();
      } catch (e) {
        logger.warn(`Не удалось разобрать ответ ${endpoint} от RA API: ${e.message}`);
        return {};
      }
    }
    return {};
  }

  // RA иногда отвечает НЕ JSON-объектом, а голой строкой (например, при
  // неверном username/ключе — валидный JSON вида "Invalid API Key", это
  // парсится как строка, не объект). Без этой проверки любой .foo на
  // таком ответе роняет весь пайплайн невнятной ошибкой.
  function ensureObject(data, endpoint) {
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) return data;
    logger.warn(`RA API ${endpoint} вернул не объект, а ${typeof data}: ${JSON.stringify(data)}`);
    return {};
  }

  // API_GetUserProfile — аватар, ранг, очки, RetroPoints, motto.
  async function getUserProfile() {
    return ensureObject(await get('API_GetUserProfile', { u: username }), 'API_GetUserProfile');
  }

  // API_GetUserCompletionProgress — постранично ВСЕ игры с прогрессом.
  // Пагинация обязательна: один вызов отдаёт ограниченный "Count" записей,
  // "Total" — сколько всего. maxPages — защита от бесконечного цикла.
  async function getUserCompletionProgress(maxPages = 20) {
    const results = [];
    let offset = 0;
    const pageSize = 100;
    for (let i = 0; i < maxPages; i++) {
      const raw = await get('API_GetUserCompletionProgress', { u: username, c: pageSize, o: offset });
      const data = ensureObject(raw, 'API_GetUserCompletionProgress');
      if (!data || Object.keys(data).length === 0) break;
      const chunk = (data.Results || []).filter((g) => g && typeof g === 'object');
      results.push(...chunk);
      const total = data.Total ?? results.length;
      offset += pageSize;
      if (offset >= total || chunk.length === 0) break;
    }
    return results;
  }

  // API_GetGameInfoAndUserProgress — метаданные игры + полный список
  // ачивок с редкостью (NumAwarded/NumAwardedHardcore) и личным прогрессом
  // (DateEarned/DateEarnedHardcore) одним вызовом.
  async function getGameInfoAndUserProgress(gameId) {
    const raw = await get('API_GetGameInfoAndUserProgress', { u: username, g: gameId });
    return ensureObject(raw, 'API_GetGameInfoAndUserProgress');
  }

  // API_GetUserAwards — витрина "трофеев": Mastery/Completion/event-бейджи.
  async function getUserAwards() {
    const data = ensureObject(await get('API_GetUserAwards', { u: username }), 'API_GetUserAwards');
    return (data.VisibleUserAwards || []).filter((a) => a && typeof a === 'object');
  }

  // API_GetUserRecentAchievements — лента последних разлоченных ачивок.
  // minutes по умолчанию — 2 недели.
  async function getUserRecentAchievements(minutes = 60 * 24 * 14) {
    const data = await get('API_GetUserRecentAchievements', { u: username, m: minutes });
    return Array.isArray(data) ? data.filter((a) => a && typeof a === 'object') : [];
  }

  // API_GetConsoleIDs — справочник ID → название консоли.
  async function getConsoleIds() {
    const data = await get('API_GetConsoleIDs');
    return Array.isArray(data) ? data : [];
  }

  // Быстрая проверка, что username/apiKey реально валидны.
  async function verifyConnection() {
    const profile = await getUserProfile();
    return Boolean(profile.User);
  }

  return {
    getUserProfile,
    getUserCompletionProgress,
    getGameInfoAndUserProgress,
    getUserAwards,
    getUserRecentAchievements,
    getConsoleIds,
    verifyConnection,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withParams(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { createRetroApi };
