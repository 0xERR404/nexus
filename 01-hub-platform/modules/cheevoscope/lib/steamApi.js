// Steam Web API (api.steampowered.com) + витрина (store.steampowered.com).
// Фабрика createSteamApi({apiKey, steamId}) — не глобальные константы, как
// в исходнике: ключи приходят из хаба и могут смениться, каждый прогон
// пайплайна создаёт свой экземпляр со свежими значениями.
const { makeRateLimiter } = require('./rateLimiter.js');

// Пауза между запросами к основному Web API (сек) — глобальный лимит на
// весь процесс, соблюдается общим лимитером даже при параллельных
// запросах. 0.25с (4 запроса/сек) на практике не приводит к 429.
const REQUEST_DELAY = 0.25;
const API_CONCURRENCY = 10;

// Отдельная, более медленная пауза для витрины (store.steampowered.com) —
// у неё гораздо более жёсткий rate-limit (~200 запросов/5 минут на IP).
const STORE_REQUEST_DELAY = 0.8;
const STORE_CONCURRENCY = 5;

// Регион для цены — только US, единственный регион, который Steam
// гарантированно денежит в USD (appdetails отдаёт цену в валюте региона
// запроса, не в USD — не конвертируем чужую валюту "один в один").
const PRICE_FALLBACK_COUNTRIES = ['us'];

const REVIEW_SCORE_LABELS_RU = {
  9: 'Крайне положительные',
  8: 'Очень положительные',
  7: 'Положительные',
  6: 'Скорее положительные',
  5: 'Смешанные',
  4: 'Скорее отрицательные',
  3: 'Отрицательные',
  2: 'Очень отрицательные',
  1: 'Крайне отрицательные',
  0: 'Недостаточно отзывов',
};

function createSteamApi({ apiKey, steamId, logger = console }) {
  const apiLimiter = makeRateLimiter(REQUEST_DELAY, API_CONCURRENCY);
  const storeLimiter = makeRateLimiter(STORE_REQUEST_DELAY, STORE_CONCURRENCY);

  async function get(url, params, timeoutMs = 15000) {
    return apiLimiter.run(async () => {
      const res = await fetchWithTimeout(withParams(url, params), timeoutMs);
      if (!res.ok) throw new HttpError(res.status, await safeText(res));
      return res.json();
    });
  }

  // Запрос к store.steampowered.com со своим лимитером и retry-с-backoff
  // на 429. Если Steam прислал Retry-After — уважаем его, иначе ждём по
  // экспоненте (2с, 4с, 8с, 16с).
  async function getStore(url, params, timeoutMs = 15000, maxRetries = 4) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const res = await storeLimiter.run(() => fetchWithTimeout(withParams(url, params), timeoutMs));
      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const wait = retryAfter ? Number(retryAfter) : 2 ** (attempt + 1);
        logger.warn(`429 от store.steampowered.com (попытка ${attempt + 1}/${maxRetries}), жду ${wait}с...`);
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok) throw new HttpError(res.status, await safeText(res));
      return res.json();
    }
    return {};
  }

  // IPlayerService/GetOwnedGames — список игр пользователя с playtime.
  async function getOwnedGames() {
    const url = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/';
    const data = await get(url, {
      key: apiKey,
      steamid: steamId,
      include_appinfo: 1,
      include_played_free_games: 1,
      format: 'json',
    });
    return data.response?.games || [];
  }

  // IPlayerService/GetRecentlyPlayedGames — резервный источник, ловит
  // совсем свежую сессию раньше, чем GetOwnedGames успевает её
  // отреплицировать. Тихо возвращает [] при ошибке — это не основной
  // источник.
  async function getRecentlyPlayedGames() {
    const url = 'https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/';
    try {
      const data = await get(url, { key: apiKey, steamid: steamId, count: 0, format: 'json' });
      return data.response?.games || [];
    } catch (e) {
      logger.warn(`Резервный источник (недавняя активность) недоступен: ${e.message}`);
      return [];
    }
  }

  // STEAM_ID может быть готовым SteamID64 (17 цифр), ником (vanity URL)
  // или ссылкой на профиль — приводим к числовому SteamID64.
  async function resolveSteamId64(raw) {
    raw = raw.trim();
    if (/^\d{17}$/.test(raw)) return raw;

    let vanity = raw;
    for (const marker of ['/profiles/', '/id/']) {
      if (raw.includes(marker)) {
        const tail = raw.split(marker)[1];
        vanity = tail.replace(/\/+$/, '').split('/')[0];
        break;
      }
    }
    if (/^\d{17}$/.test(vanity)) return vanity;

    logger.info(`STEAM_ID='${raw}' не похоже на готовый SteamID64 — резолвлю vanity-имя «${vanity}»...`);
    const url = 'https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/';
    const data = await get(url, { key: apiKey, vanityurl: vanity, format: 'json' });
    const response = data.response || {};
    if (response.success !== 1) {
      throw new Error(
        `Steam не смог найти профиль по имени «${vanity}» (success=${response.success}, message=${response.message}).`
      );
    }
    return response.steamid;
  }

  // Полный список игр через публичный XML-фид страницы "Игры" профиля —
  // ловит F2P-игры, ни разу не запущенные через клиент (GetOwnedGames их
  // не отдаёт). Не требует авторизации, но "Сведения об играх" в профиле
  // должны быть публичными. Возвращает [], если профиль/список приватны —
  // это резервный источник, тихая деградация лучше падения.
  async function getFullLibrary(steamid64) {
    const url = `https://steamcommunity.com/profiles/${steamid64}/games?tab=all&xml=1`;
    let text;
    try {
      const res = await fetchWithTimeout(url, 20000, { 'User-Agent': 'Mozilla/5.0' });
      if (!res.ok) throw new HttpError(res.status, '');
      text = await res.text();
    } catch (e) {
      logger.warn(`Не удалось получить полный список библиотеки (XML-фид профиля): ${e.message}`);
      return [];
    }

    if (text.includes('<error>')) {
      const errorMsg = text.split('<error>')[1]?.split('</error>')[0] || '';
      logger.warn(
        `XML-фид библиотеки ответил ошибкой: ${errorMsg}. Обычно значит, что "Сведения об играх" скрыты в настройках приватности профиля.`
      );
      return [];
    }

    return parseGamesXml(text);
  }

  // ISteamUserStats/GetGlobalAchievementPercentagesForApp — % игроков на ачивку.
  async function getGlobalAchievementPercentages(appid) {
    const url = 'https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/';
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const data = await get(url, { gameid: appid, format: 'json' });
        return data.achievementpercentages?.achievements || [];
      } catch (e) {
        if (e instanceof HttpError && isRetryableStatus(e.status) && attempt < maxRetries - 1) {
          await sleep(2 ** (attempt + 1) * 1000);
          continue;
        }
        // Нет глобальной статистики или стойкая ошибка — используется
        // только для необязательной "редкости", не влияет на подсчёт %.
        return [];
      }
    }
    return [];
  }

  // ISteamUserStats/GetSchemaForGame — статичное описание ачивок игры
  // (apiname, displayName, description, иконки). l=russian — русская
  // локализация, если у игры есть перевод; иначе Steam тихо отдаёт
  // английский. Игры без official-схемы достижений — возвращает [].
  async function getSchemaForGame(appid) {
    const url = 'https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/';
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const data = await get(url, { key: apiKey, appid, l: 'russian', format: 'json' });
        return data.game?.availableGameStats?.achievements || [];
      } catch (e) {
        if (e instanceof HttpError && isRetryableStatus(e.status) && attempt < maxRetries - 1) {
          await sleep(2 ** (attempt + 1) * 1000);
          continue;
        }
        logger.warn(`Не удалось получить схему ачивок для appid=${appid}: ${e.message}`);
        return [];
      }
    }
    return [];
  }

  // ISteamUserStats/GetPlayerAchievements — какие ачивки открыты у вас.
  // transientError=false + achievements=[] — Steam явно сказал "нет
  // статистики" (окончательно, можно кэшировать). transientError=true —
  // сетевая ошибка/429/5xx после ретраев (НЕЛЬЗЯ кэшировать как "нет
  // достижений").
  async function getPlayerAchievements(appid) {
    const url = 'https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/';
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const data = await get(url, { key: apiKey, steamid: steamId, appid, format: 'json' });
        const response = data.playerstats || {};
        if (!response.success) {
          return { achievements: [], transientError: false };
        }
        response.transientError = false;
        return response;
      } catch (e) {
        if (e instanceof HttpError && isRetryableStatus(e.status) && attempt < maxRetries - 1) {
          const wait = 2 ** (attempt + 1);
          logger.warn(
            `Ошибка ${e.status} при получении достижений appid=${appid} (попытка ${attempt + 1}/${maxRetries}), жду ${wait}с...`
          );
          await sleep(wait * 1000);
          continue;
        }
        logger.warn(`Не удалось получить достижения для appid=${appid} (после ретраев): ${e.message}`);
        return { achievements: [], transientError: true };
      }
    }
    return { achievements: [], transientError: true };
  }

  // Скачивает саму картинку (CDN, не store API) — без общего throttle'а
  // витрины и с большим параллелизмом, это обычный статический CDN.
  async function downloadImageBytes(url) {
    try {
      const res = await fetchWithTimeout(url, 20000);
      if (!res.ok) throw new HttpError(res.status, '');
      const buf = await res.arrayBuffer();
      return Buffer.from(buf);
    } catch (e) {
      logger.warn(`Не удалось скачать картинку ${url}: ${e.message}`);
      return null;
    }
  }

  // Цена игры через store.steampowered.com/api/appdetails. Считаем
  // строго в USD — appdetails отдаёт цену в валюте региона запроса, не в
  // долларах; чужая валюта без конвертации раздула бы сумму библиотеки.
  // Заодно забирает header_image/capsule_image из ответа Steam.
  async function getAppPrice(appid) {
    const url = 'https://store.steampowered.com/api/appdetails';
    let imageUrls = {};

    for (const cc of PRICE_FALLBACK_COUNTRIES) {
      const params = { appids: appid, cc, l: 'en' };
      let data;
      try {
        data = await getStore(url, params);
      } catch (e) {
        logger.warn(`Не удалось получить цену для appid=${appid}, регион ${cc}: ${e.message}`);
        if (cc === PRICE_FALLBACK_COUNTRIES[PRICE_FALLBACK_COUNTRIES.length - 1]) {
          return { priceFound: false, transientError: true, ...imageUrls };
        }
        continue;
      }

      const entry = data[String(appid)];
      if (!entry || !entry.success) continue;

      const appData = entry.data || {};
      if (Object.keys(imageUrls).length === 0) {
        if (appData.header_image) imageUrls.headerImage = appData.header_image;
        if (appData.capsule_image) imageUrls.capsuleImage = appData.capsule_image;
        if (appData.capsule_imagev5) imageUrls.capsuleImagev5 = appData.capsule_imagev5;
      }

      if (appData.is_free) {
        return { priceFound: true, transientError: false, isFree: true, initialPriceUsd: 0.0, priceRegion: cc, ...imageUrls };
      }
      const priceOverview = appData.price_overview;
      if (priceOverview) {
        const currency = priceOverview.currency || 'USD';
        if (currency !== 'USD') continue; // не доллары — пробуем следующий регион
        return {
          priceFound: true,
          transientError: false,
          isFree: false,
          initialPriceUsd: Math.round((priceOverview.initial || 0) / 100 * 100) / 100,
          priceRegion: cc,
          ...imageUrls,
        };
      }
    }

    return { priceFound: false, transientError: false, ...imageUrls };
  }

  // Оценка отзывов через store.steampowered.com/appreviews/{appid} — тот
  // же официальный витринный эндпоинт, что и цены.
  async function getAppReviews(appid) {
    const url = `https://store.steampowered.com/appreviews/${appid}`;
    const params = { json: 1, language: 'all', purchase_type: 'all', num_per_page: 0 };
    try {
      const data = await getStore(url, params);
      if (!data.success) return { reviewsFound: false, transientError: false };
      const summary = data.query_summary || {};
      const total = summary.total_reviews || 0;
      if (!total) return { reviewsFound: false, transientError: false };
      const positive = summary.total_positive || 0;
      const score = summary.review_score || 0;
      return {
        reviewsFound: true,
        transientError: false,
        reviewScore: score,
        reviewDesc: REVIEW_SCORE_LABELS_RU[score] ?? summary.review_score_desc ?? '',
        totalReviews: total,
        positivePercent: Math.round((100 * positive / total) * 10) / 10,
      };
    } catch (e) {
      logger.warn(`Не удалось получить отзывы для appid=${appid} (после ретраев): ${e.message}`);
      return { reviewsFound: false, transientError: true };
    }
  }

  return {
    getOwnedGames,
    getRecentlyPlayedGames,
    resolveSteamId64,
    getFullLibrary,
    getGlobalAchievementPercentages,
    getSchemaForGame,
    getPlayerAchievements,
    downloadImageBytes,
    getAppPrice,
    getAppReviews,
  };
}

// --- вспомогательное ---

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function withParams(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function fetchWithTimeout(url, timeoutMs, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

// Разбор XML-фида библиотеки Steam (<games><game><appID>.../<appID>
// <name>...</name></game>...</games>) без внешних зависимостей — формат
// плоский, регулярка по каждому <game>...</game> блоку достаточна и
// надёжнее, чем кажется на первый взгляд, потому что Steam сам эскейпит
// спецсимволы в этом фиде (&amp; и т.п.), а не выдаёт настоящий вложенный XML.
function parseGamesXml(text) {
  const result = [];
  const gameBlocks = text.match(/<game>[\s\S]*?<\/game>/g) || [];
  for (const block of gameBlocks) {
    const appidMatch = block.match(/<appID>(\d+)<\/appID>/);
    if (!appidMatch) continue;
    const appid = Number(appidMatch[1]);
    const nameMatch = block.match(/<name><!\[CDATA\[([\s\S]*?)\]\]><\/name>|<name>([\s\S]*?)<\/name>/);
    const rawName = nameMatch ? (nameMatch[1] ?? nameMatch[2] ?? '') : '';
    const name = decodeXmlEntities(rawName).trim() || `appid ${appid}`;
    result.push({ appid, name });
  }
  return result;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

module.exports = { createSteamApi, REVIEW_SCORE_LABELS_RU };
