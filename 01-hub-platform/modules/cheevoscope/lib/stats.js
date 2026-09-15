// Steam-пайплайн — перенос stats.py. Фабрика createStats(ctx): ctx.steamApi
// и ctx.cache приходят снаружи (см. steamApi.js/cache.js), не глобальные
// импорты, как в исходнике — тот же принцип, что и у остальных lib/*.
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteJson } = require('./ioUtils.js');
const { runParallel } = require('./runParallel.js');
const { nowIso } = require('./statusTracker.js');
const { getOwnedAppsViaClient } = require('./steamClientApi.js');

// Тиры "крутости" ачивки по её мировой редкости (доля игроков, открывших
// её) — та же идея, что качество предметов в RPG: чем меньше людей
// открыли ачивку, тем она круче. Верхняя граница включительно.
const RARITY_TIERS = [
  ['gold', 1.0, '#dcb35c'],
  ['purple', 3.0, '#b478f0'],
  ['blue', 8.0, '#4a90d9'],
  ['green', 20.0, '#4cb389'],
  ['white', 50.0, '#d7dbe0'],
  ['gray', 101.0, '#6b7280'],
];

function rarityTierFor(percent) {
  for (const [tierId, ceiling] of RARITY_TIERS) {
    if (percent <= ceiling) return tierId;
  }
  return 'gray';
}

// Распределение ВСЕХ открытых ачивок (с известным % редкости) по тирам —
// насколько круто в целом набита библиотека, не только топ-10 находок.
// coolness_score: 100 - средний global_percent открытых ачивок — про то,
// НАСКОЛЬКО РЕДКИЕ вещи открываете, не сколько всего.
function computeRarityTiers(candidates) {
  const counts = Object.fromEntries(RARITY_TIERS.map(([id]) => [id, 0]));
  let total = 0;
  let percentSum = 0;
  for (const c of candidates) {
    const pct = c.globalPercent;
    if (pct === null || pct === undefined) continue;
    counts[rarityTierFor(pct)]++;
    percentSum += pct;
    total++;
  }
  const coolnessScore = total ? Math.round((100 - percentSum / total) * 10) / 10 : 0.0;
  return { totalRated: total, counts, coolnessScore };
}

function createStats({ steamApi, cache, paths, apiConcurrency = 10, storeConcurrency = 5, logger = console }) {
  const {
    dataDir,
    gamesListFile,
    imagesFile,
    gameImagesDir,
    achievementsStatsFile,
    libraryCostFile,
    reviewsFile,
    reportMdFile,
    reportJsonFile,
    manualAppidsFile,
    steamSessionFile,
  } = paths;

  const NO_ACHIEVEMENTS_CACHE_TTL_HOURS = 24 * 30;
  const COMPLETED_ACHIEVEMENTS_CACHE_TTL_HOURS = 24 * 7;
  const ACHIEVEMENT_SCHEMA_CACHE_TTL_HOURS = 24 * 30;
  const GLOBAL_PCT_CACHE_TTL_HOURS = 24 * 7;
  // Цены/отзывы меняются медленно (скидки — не каждый день, отзывы —
  // плавно). 21 день вместо 7 — «Обновить всё» на большой библиотеке
  // (сотни игр) в большинстве повторных прогонов попадает в кэш вместо
  // похода на витрину (самый жёстко ограниченный по скорости источник),
  // не теряя актуальности сколько-нибудь заметно.
  const PRICE_REVIEW_CACHE_TTL_HOURS = 24 * 21;

  function achievementsCacheTtlHours(cachedData) {
    const achievements = cachedData.achievements || [];
    const total = achievements.length;
    if (total === 0) return NO_ACHIEVEMENTS_CACHE_TTL_HOURS;
    const unlocked = achievements.filter((a) => a.achieved === 1).length;
    if (unlocked === total) return COMPLETED_ACHIEVEMENTS_CACHE_TTL_HOURS;
    return 0.0;
  }

  // Игры, которые Steam не отдаёт НИ ОДНИМ официальным Web API-эндпоинтом —
  // владелец добавляет appid вручную в manual_appids.json на диске модуля.
  async function loadManualAppids() {
    try {
      const raw = await fs.readFile(manualAppidsFile, 'utf-8');
      const entries = JSON.parse(raw);
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  }

  // ---------- Библиотека и время ----------

  // Собирает ПОЛНЫЙ список игр. Раньше базой считался GetOwnedGames
  // (официальный Web API), а публичная страница профиля была резервным
  // "долавливателем" F2P-игр поверх него. Перевёрнуто по итогам разбора
  // в переписке: страница библиотеки профиля (games/?tab=all — та же,
  // что видит сам владелец в браузере/Steam-клиенте) теперь считается
  // ПЕРВИЧНЫМ источником списка appid+название — GetOwnedGames для
  // части аккаунтов упускает часть игр, тогда как страница профиля
  // отражает реальную библиотеку полнее (владелец подтвердил на своём
  // аккаунте). GetOwnedGames остаётся, но уже как источник
  // ОБОГАЩЕНИЯ — даёт playtime_forever (страницы профиля эту метрику не
  // отдают) и подстраховку на случай, если он знает что-то, чего нет на
  // странице профиля (не должно случаться в норме, но не полагаемся
  // слепо на один источник — тихая деградация лучше падения).
  //
  // ВАЖНО (найдено в переписке через реальный пример — appid 4819490,
  // "Crash Position"): GetRecentlyPlayedGames видит игру только внутри
  // короткого окна "недавней активности" (~2 недели). Раньше список
  // собирался С НУЛЯ на каждый вызов — appid, однажды промелькнувший в
  // этом окне и затем выпавший из него, терялся НАВСЕГДА, даже если у
  // игры реально есть прогресс по ачивкам (GetPlayerAchievements его
  // прекрасно видит — не связан с "недавностью" вообще). Сторонние
  // трекеры (TrueSteamAchievements и т.п.) обходят это не особым
  // доступом к API — его просто нет ни у кого, включая их — а тем, что
  // копят историю НЕПРЕРЫВНО: увидев appid один раз, они не забывают
  // его при следующем опросе, даже если он больше не "недавний".
  // Теперь так же: ПРЕДЫДУЩИЙ сохранённый список читается первым и
  // используется как стартовая база — ни один appid, обнаруженный
  // хоть раз ЛЮБЫМ источником в прошлом, больше не может тихо
  // потеряться просто потому, что сейчас источник о нём не знает.
  async function fetchGamesList() {
    logger.info('Запрашиваю полный список игр (страница профиля — основной источник)...');

    let libraryCheck = {
      attempted: false, ok: false, error: null, privacyBlocked: false,
      baseSource: null, baseCount: 0, ownedGamesCount: 0, ownedOnlyCount: 0,
      extraGamesCount: 0, zeroFoundButAttempted: false, historyCount: 0,
    };

    const known = new Map(); // appid -> {appid, name, playtime_forever, _unverified?}

    // История — ПЕРВЫЙ источник, до всех "живых" запросов к Steam.
    // Дальнейшие источники ниже могут ОБНОВИТЬ запись (например,
    // актуализировать playtime, если игра снова видна GetOwnedGames),
    // но не могут её убрать — .set() по тому же appid перезаписывает
    // поля, не удаляет запись целиком.
    try {
      const previous = await loadGamesList();
      if (previous && Array.isArray(previous.games)) {
        for (const g of previous.games) {
          if (g && g.appid !== undefined && g.appid !== null) {
            known.set(g.appid, { appid: g.appid, name: g.name, playtime_forever: g.playtime_forever || 0, _unverified: Boolean(g._unverified) });
          }
        }
        libraryCheck.historyCount = known.size;
      }
    } catch (e) {
      logger.warn(`Не удалось прочитать сохранённый список игр с прошлого раза (не критично, продолжаю без истории): ${e.message}`);
    }

    // Вход как владелец аккаунта (steam-user) — источник ВЫСШЕГО
    // приоритета из всех: единственный, что явно просит Steam НЕ
    // фильтровать "непроверенные" игры (skip_unvetted_apps: false —
    // параметр, которого нет в публичном REST API вообще, см.
    // lib/steamClientApi.js). Если сессия ещё не настроена
    // (steamClientAuth.js ни разу не запускался) — needsLogin:true,
    // источник просто пропускается, остальной пайплайн работает как
    // раньше, ничего не падает.
    libraryCheck.clientLogin = { attempted: false, ok: false, appsFound: 0, needsLogin: false };
    if (steamSessionFile) {
      libraryCheck.clientLogin.attempted = true;
      const clientResult = await getOwnedAppsViaClient({ sessionFile: steamSessionFile, logger });
      libraryCheck.clientLogin.needsLogin = clientResult.needsLogin;
      if (clientResult.apps) {
        for (const g of clientResult.apps) {
          const existing = known.get(g.appid);
          known.set(g.appid, {
            appid: g.appid,
            name: g.name,
            playtime_forever: g.playtime_forever || existing?.playtime_forever || 0,
          });
        }
        libraryCheck.clientLogin.ok = true;
        libraryCheck.clientLogin.appsFound = clientResult.apps.length;
      }
    }

    try {
      const steamid64 = await steamApi.getResolvedSteamId();
      libraryCheck.attempted = true;

      // .set() ниже НЕ должен затирать playtime_forever, уже известный
      // из истории/клиентского логина выше (реальный найденный баг: до
      // этой правки любая игра, известная ТОЛЬКО через историю/клиент
      // (не через GetOwnedGames), теряла свой playtime здесь — профиль
      // не отдаёт время игры вообще, но раньше безусловно писал сюда 0,
      // стирая то, что уже было корректно известно).
      const htmlResult = await steamApi.getFullLibraryHtml(steamid64);
      if (htmlResult.games.length > 0) {
        for (const g of htmlResult.games) {
          const existing = known.get(g.appid);
          known.set(g.appid, { appid: g.appid, name: g.name, playtime_forever: existing?.playtime_forever || 0 });
        }
        libraryCheck.baseSource = 'html';
      } else {
        if (htmlResult.privacyBlocked) libraryCheck.privacyBlocked = true;
        // HTML ничего не дал (приватность/редирект на логин/Valve
        // поменяла разметку) — пробуем старый xml=1-фид как запасной
        // вариант той же самой страницы (та же приватность может дать
        // тот же результат, но не полагаемся на один код пути).
        const xmlResult = await steamApi.getFullLibrary(steamid64);
        if (xmlResult.privacyBlocked) libraryCheck.privacyBlocked = true;
        if (xmlResult.games.length > 0) {
          for (const g of xmlResult.games) {
            const existing = known.get(g.appid);
            known.set(g.appid, { appid: g.appid, name: g.name, playtime_forever: existing?.playtime_forever || 0 });
          }
          libraryCheck.baseSource = 'xml';
        }
      }
      libraryCheck.ok = true;
    } catch (e) {
      libraryCheck.error = e.message;
      logger.warn(`Не удалось получить базовый список библиотеки через профиль: ${e.message}`);
    }
    libraryCheck.baseCount = known.size;

    // GetOwnedGames — обогащаем playtime у того, что уже знаем из
    // профиля, и добавляем то, чего почему-то не было на странице
    // профиля (подстраховка). Если база из профиля пуста (профиль
    // недоступен/приватен/сбой сети выше) — GetOwnedGames становится
    // де-факто базой сам по себе, как и было раньше до этой правки —
    // деградация плавная, не падение в никуда.
    let ownedGamesCount = 0;
    let ownedOnlyCount = 0;
    try {
      const owned = await steamApi.getOwnedGames();
      ownedGamesCount = owned.length;
      for (const g of owned) {
        const existing = known.get(g.appid);
        if (existing) {
          existing.playtime_forever = g.playtime_forever || 0;
        } else {
          known.set(g.appid, { appid: g.appid, name: g.name || `appid ${g.appid}`, playtime_forever: g.playtime_forever || 0 });
          ownedOnlyCount++;
        }
      }
    } catch (e) {
      logger.warn(`GetOwnedGames недоступен — используется только список из профиля, playtime не будет проставлен: ${e.message}`);
    }
    libraryCheck.ownedGamesCount = ownedGamesCount;
    libraryCheck.ownedOnlyCount = ownedOnlyCount;

    // Резервные добавки поверх обоих источников выше — как и раньше,
    // только то, чего не было НИГДЕ. _unverified: true теперь значит
    // "подтверждено ТОЛЬКО этим слабым источником, ни страницей
    // профиля, ни GetOwnedGames" — влияет на кэш ачивок ниже (см.
    // fetchOneGameAchievements) — данные из профиля больше НЕ считаются
    // "неподтверждёнными" (это и было сутью правки: доверять профилю).
    let extraGamesCount = 0;
    for (const g of await steamApi.getRecentlyPlayedGames()) {
      if (known.has(g.appid)) continue;
      known.set(g.appid, { appid: g.appid, name: g.name || `appid ${g.appid}`, playtime_forever: g.playtime_forever || 0, _unverified: true });
      extraGamesCount++;
    }
    for (const entry of await loadManualAppids()) {
      const appid = entry.appid;
      if (appid === undefined || appid === null || known.has(appid)) continue;
      known.set(appid, { appid, name: entry.name || `appid ${appid}`, playtime_forever: 0, _unverified: true });
      extraGamesCount++;
    }
    libraryCheck.extraGamesCount = extraGamesCount;

    // ВАЖНО: предупреждение на странице должно зажигаться только когда
    // Steam ЯВНО ответил ошибкой приватности (privacyBlocked=true), не
    // просто "профиль ничего лишнего не добавил". Для подавляющего
    // большинства аккаунтов список из профиля и так покрывает всё.
    libraryCheck.zeroFoundButAttempted = libraryCheck.attempted && libraryCheck.ok && libraryCheck.privacyBlocked;

    const games = Array.from(known.values());
    const totalMinutes = games.reduce((sum, g) => sum + (g.playtime_forever || 0), 0);
    const result = {
      fetchedAt: nowIso(),
      gamesCount: games.length,
      totalHours: Math.round((totalMinutes / 60) * 10) / 10,
      games,
      libraryCheck,
    };
    await atomicWriteJson(gamesListFile, result);
    logger.info(`Найдено игр: ${result.gamesCount} (база: ${libraryCheck.baseSource || 'только GetOwnedGames, профиль недоступен'}), общее время: ${result.totalHours} часов`);
    return result;
  }

  // ---------- Достижения ----------

  async function fetchOneGameAchievements(game) {
    const appid = game.appid;
    const name = game.name || `appid ${appid}`;

    const globalPct = await cache.cachedCall(`global_pct_${appid}`, () => steamApi.getGlobalAchievementPercentages(appid), GLOBAL_PCT_CACHE_TTL_HOURS);

    // "Умный" кэш: игры без ачивок/пройденные на 100% берутся из кэша
    // подолгу, "в процессе" — всегда свежими. Игры, найденные НЕ через
    // основной GetOwnedGames, кэш не используют вообще — их данные могут
    // быть ещё нестабильны.
    const skipCache = Boolean(game._unverified);
    const cacheKey = `player_ach_${appid}`;
    let playerData = null;
    if (!skipCache) {
      const cached = await cache.cacheGetWithAge(cacheKey);
      if (cached !== null && cached.ageHours <= achievementsCacheTtlHours(cached.data)) {
        playerData = cached.data;
      }
    }
    if (playerData === null) {
      playerData = await steamApi.getPlayerAchievements(appid);
      if (!playerData.transientError && !skipCache) await cache.cacheSet(cacheKey, playerData);
    }

    const playerAchievements = playerData.achievements || [];
    const totalAchievements = playerAchievements.length;
    if (totalAchievements === 0) return null;

    const unlocked = playerAchievements.filter((a) => a.achieved === 1);
    const unlockedCount = unlocked.length;

    // unlocktime == 0 означает "неизвестно/никогда" даже при achieved==1
    // (очень старые записи) — такие в календарь не включаем.
    const unlockDates = [];
    for (const a of unlocked) {
      const ts = a.unlocktime || 0;
      if (ts > 0) unlockDates.push(new Date(ts * 1000).toISOString().slice(0, 10));
    }

    let rarestUnlocked = null;
    let unlockedRarities = [];
    if (unlocked.length && globalPct.length) {
      // Steam отдаёт percent строкой ("45.9"), не числом.
      const pctByName = {};
      for (const a of globalPct) {
        const v = Number(a.percent);
        if (!Number.isNaN(v)) pctByName[a.name] = v;
      }
      const rarities = unlocked
        .map((a) => [a.apiname, pctByName[a.apiname]])
        .filter(([, pct]) => pct !== undefined);
      if (rarities.length) {
        rarestUnlocked = rarities.reduce((min, r) => (r[1] < min[1] ? r : min));
        unlockedRarities = rarities.map(([apiname, percent]) => ({ apiname, globalPercent: percent }));
      }
    }

    return {
      name,
      unlocked: unlockedCount,
      total: totalAchievements,
      percentComplete: Math.round((100 * unlockedCount / totalAchievements) * 10) / 10,
      rarestUnlocked: rarestUnlocked ? { apiname: rarestUnlocked[0], globalPercent: rarestUnlocked[1] } : null,
      unlockedRarities,
      unlockDates,
    };
  }

  function collectUnlockedRarityCandidates(achievementsData) {
    const candidates = [];
    for (const [appidStr, info] of Object.entries(achievementsData.games || {})) {
      for (const entry of info.unlockedRarities || []) {
        candidates.push({ appid: Number(appidStr), apiname: entry.apiname, globalPercent: entry.globalPercent });
      }
    }
    return candidates;
  }

  // Топ-N самых редких ОТКРЫТЫХ ачивок по всей библиотеке разом. Название
  // самой ачивки дотягивается ЦЕЛЕНАПРАВЛЕННО только для этих top_n игр
  // (GetSchemaForGame), кэшируется тем же ключом, что использует модалка
  // "все ачивки" — повторного похода в Steam не будет.
  async function computeRarestAchievements(achievementsData, games, topN = 10) {
    const nameByAppid = Object.fromEntries(games.map((g) => [g.appid, g.name || `appid ${g.appid}`]));
    const candidates = collectUnlockedRarityCandidates(achievementsData);
    candidates.sort((a, b) => a.globalPercent - b.globalPercent);
    const top = candidates.slice(0, topN);

    const result = [];
    const schemaCache = {};
    for (const c of top) {
      const appid = c.appid;
      if (!(appid in schemaCache)) {
        schemaCache[appid] = await cache.cachedCall(`schema_ru_${appid}`, () => steamApi.getSchemaForGame(appid), ACHIEVEMENT_SCHEMA_CACHE_TTL_HOURS);
      }
      let displayName = c.apiname;
      for (const a of schemaCache[appid]) {
        if (a.name === c.apiname) {
          displayName = a.displayName || c.apiname;
          break;
        }
      }
      result.push({ appid, game: nameByAppid[appid] || `appid ${appid}`, name: displayName, globalPercent: Math.round(c.globalPercent * 10) / 10 });
    }
    return result;
  }

  // Календарь активности — сколько достижений разлочено в каждый день,
  // по всей библиотеке разом, из unlocktime (уже есть в данных).
  function computeActivityHeatmap(achievementsData) {
    const counts = {};
    for (const info of Object.values(achievementsData.games || {})) {
      for (const dateStr of info.unlockDates || []) {
        counts[dateStr] = (counts[dateStr] || 0) + 1;
      }
    }
    return counts;
  }

  async function fetchAchievementsStats(games, progressCb = null) {
    const raw = await runParallel(games, fetchOneGameAchievements, apiConcurrency, 'achievements', progressCb, (g) => g.appid);
    const perGame = {};
    for (const [appid, info] of raw) {
      if (info !== null) perGame[String(appid)] = info;
    }
    const result = { fetchedAt: nowIso(), games: perGame };
    result.rarestAchievements = await computeRarestAchievements(result, games);
    result.rarityTiers = computeRarityTiers(collectUnlockedRarityCandidates(result));
    result.activityHeatmap = computeActivityHeatmap(result);
    await atomicWriteJson(achievementsStatsFile, result);
    return result;
  }

  // ---------- Картинки ----------

  // Приоритет источника картинки — должен совпадать с приоритетом на
  // фронтенде: header_image (без обрезки) > capsule_imagev5 (крупнее, но
  // обрежется по бокам) > старый мелкий capsule_image.
  function bestImageUrl(info) {
    return info.headerImage || info.capsuleImagev5 || info.capsuleImage || null;
  }

  // Скачивает картинку на диск и возвращает запись для images.json. Если
  // ссылка не изменилась и файл уже на диске — повторно не качает.
  async function downloadOneGameImage(appid, info, existingEntry) {
    const url = bestImageUrl(info);
    const entry = {
      headerImage: info.headerImage || null,
      capsuleImage: info.capsuleImage || null,
      capsuleImagev5: info.capsuleImagev5 || null,
      localImage: existingEntry.localImage || null,
      sourceUrl: existingEntry.sourceUrl || null,
    };

    if (!url) {
      entry.localImage = null;
      entry.sourceUrl = null;
      return entry;
    }

    let ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) ext = 'jpg';
    const localPath = path.join(gameImagesDir, `${appid}.${ext}`);

    if (existingEntry.sourceUrl === url) {
      try {
        await fs.access(localPath);
        return entry; // без изменений, уже на диске
      } catch {
        // файла нет — качаем заново, несмотря на совпавший URL
      }
    }

    const data = await steamApi.downloadImageBytes(url);
    if (data === null) return entry; // не скачалось — оставляем как было

    // Расширение сменилось с прошлого раза — подчищаем старый файл.
    const oldLocal = existingEntry.localImage;
    if (oldLocal && oldLocal !== `/static/game_images/${appid}.${ext}`) {
      const oldPath = path.join(gameImagesDir, path.basename(oldLocal));
      await fs.unlink(oldPath).catch(() => {});
    }

    try {
      await fs.mkdir(gameImagesDir, { recursive: true });
      await fs.writeFile(localPath, data);
      entry.localImage = `/static/game_images/${appid}.${ext}`;
      entry.sourceUrl = url;
    } catch (e) {
      logger.warn(`Не удалось сохранить картинку appid=${appid} на диск: ${e.message}`);
    }
    return entry;
  }

  // РЕАЛЬНО скачивает картинки на диск (не только URL) — отдаются через
  // /static, при повторных заходах грузятся с сервера, не с CDN Steam.
  // Результат СЛИВАЕТСЯ с уже сохранённым, не затирает целиком — "Обновить"
  // вызывает это только для НОВЫХ игр.
  async function fetchGameImages(games, progressCb = null) {
    const existing = (await loadImages()).games || {};
    const raw = await runParallel(games, fetchOneGamePrice, storeConcurrency, 'images', progressCb, (g) => g.appid);

    const downloadArgs = games.map((game) => [game.appid, raw.get(game.appid) || {}, existing[String(game.appid)] || {}]);
    const downloaded = new Map();
    const downloadResults = await runParallel(
      downloadArgs.map(([appid, info, existingEntry]) => ({ appid, info, existingEntry })),
      async (item) => downloadOneGameImage(item.appid, item.info, item.existingEntry),
      10,
      'images_download',
      null,
      (item) => item.appid
    );
    for (const [appid, result] of downloadResults) downloaded.set(appid, result);

    const perGame = { ...existing };
    for (const game of games) perGame[String(game.appid)] = downloaded.get(game.appid);

    const found = Object.values(perGame).filter((v) => v && (v.localImage || v.headerImage || v.capsuleImage)).length;
    const result = { fetchedAt: nowIso(), gamesWithImages: found, games: perGame };
    await atomicWriteJson(imagesFile, result);
    logger.info(`Картинки: ${found} из ${Object.keys(perGame).length} игр в библиотеке (обновлено сейчас: ${games.length}).`);
    return result;
  }

  // ---------- Стоимость библиотеки ----------

  async function fetchOneGamePrice(game) {
    const appid = game.appid;
    const cacheKey = `price_${appid}`;
    let priceInfo = await cache.cacheGet(cacheKey, PRICE_REVIEW_CACHE_TTL_HOURS);
    if (priceInfo === null) {
      priceInfo = await steamApi.getAppPrice(appid);
      // Временные ошибки НЕ кэшируем — иначе застрянут как "цена не найдена" на неделю.
      if (!priceInfo.transientError) await cache.cacheSet(cacheKey, priceInfo);
    }
    return priceInfo;
  }

  async function fetchLibraryCost(games, progressCb = null) {
    const raw = await runParallel(games, fetchOneGamePrice, storeConcurrency, 'library_cost', progressCb, (g) => g.appid);

    const perGame = {};
    let totalCost = 0;
    let notFound = 0;
    let rateLimited = 0;

    for (const game of games) {
      const appid = game.appid;
      const name = game.name || `appid ${appid}`;
      const priceInfo = raw.get(appid) || {};

      if (priceInfo.priceFound) {
        const price = priceInfo.initialPriceUsd || 0.0;
        perGame[String(appid)] = { name, priceUsd: price, headerImage: priceInfo.headerImage, capsuleImage: priceInfo.capsuleImage, capsuleImagev5: priceInfo.capsuleImagev5 };
        totalCost += price;
      } else if (priceInfo.transientError) {
        notFound++;
        rateLimited++;
        perGame[String(appid)] = { name, priceUsd: null, headerImage: priceInfo.headerImage, capsuleImage: priceInfo.capsuleImage, capsuleImagev5: priceInfo.capsuleImagev5 };
      } else {
        perGame[String(appid)] = { name, priceUsd: 0.0, headerImage: priceInfo.headerImage, capsuleImage: priceInfo.capsuleImage, capsuleImagev5: priceInfo.capsuleImagev5 };
      }
    }

    const result = {
      fetchedAt: nowIso(),
      totalCostUsd: Math.round(totalCost * 100) / 100,
      gamesPriced: games.length - notFound,
      gamesPriceNotFound: notFound,
      gamesPriceRateLimited: rateLimited,
      games: perGame,
    };
    await atomicWriteJson(libraryCostFile, result);
    logger.info(`Общая стоимость библиотеки без скидок: $${result.totalCostUsd} (ожидают повтора из-за rate-limit: ${notFound})`);
    return result;
  }

  // ---------- Отзывы ----------

  async function fetchOneGameReview(game) {
    const appid = game.appid;
    const cacheKey = `review_${appid}`;
    let reviewInfo = await cache.cacheGet(cacheKey, PRICE_REVIEW_CACHE_TTL_HOURS);
    if (reviewInfo === null) {
      reviewInfo = await steamApi.getAppReviews(appid);
      if (!reviewInfo.transientError) await cache.cacheSet(cacheKey, reviewInfo);
    }
    return reviewInfo;
  }

  async function fetchReviews(games, progressCb = null) {
    const raw = await runParallel(games, fetchOneGameReview, storeConcurrency, 'reviews', progressCb, (g) => g.appid);

    const perGame = {};
    let found = 0;

    for (const game of games) {
      const appid = game.appid;
      const name = game.name || `appid ${appid}`;
      const reviewInfo = raw.get(appid) || {};
      if (reviewInfo.reviewsFound) {
        found++;
        perGame[String(appid)] = { name, reviewScore: reviewInfo.reviewScore || 0, reviewDesc: reviewInfo.reviewDesc || '', totalReviews: reviewInfo.totalReviews || 0, positivePercent: reviewInfo.positivePercent || 0 };
      } else {
        perGame[String(appid)] = null;
      }
    }

    const result = { fetchedAt: nowIso(), gamesWithReviews: found, games: perGame };
    await atomicWriteJson(reviewsFile, result);
    logger.info(`Отзывы найдены для ${found} из ${games.length} игр.`);
    return result;
  }

  // ---------- Загрузка кэша этапов, которые в этом прогоне не обновлялись ----------

  async function loadJsonOrDefault(filePath, defaultValue) {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (e) {
      if (e.code !== 'ENOENT') logger.warn(`Не удалось прочитать ${filePath}: ${e.message}, использую пустые данные.`);
      return defaultValue;
    }
  }

  // null, если списка игр ещё никогда не было — вызывающий код должен
  // попросить сначала нажать "Обновить".
  async function loadGamesList() {
    try {
      await fs.access(gamesListFile);
    } catch {
      return null;
    }
    return loadJsonOrDefault(gamesListFile, null);
  }

  async function loadAchievementsStats() {
    return loadJsonOrDefault(achievementsStatsFile, {
      fetchedAt: null,
      games: {},
      rarestAchievements: [],
      rarityTiers: { totalRated: 0, counts: {}, coolnessScore: 0.0 },
      activityHeatmap: {},
    });
  }

  async function loadLibraryCost() {
    return loadJsonOrDefault(libraryCostFile, {
      fetchedAt: null,
      totalCostUsd: 0.0,
      gamesPriced: 0,
      gamesPriceNotFound: 0,
      gamesPriceRateLimited: 0,
      games: {},
    });
  }

  async function loadReviews() {
    return loadJsonOrDefault(reviewsFile, { fetchedAt: null, gamesWithReviews: 0, games: {} });
  }

  async function loadImages() {
    return loadJsonOrDefault(imagesFile, { fetchedAt: null, gamesWithImages: 0, games: {} });
  }

  // ---------- Сборка единого отчёта ----------

  async function generateReport(gamesData, achievementsData, costData, reviewsData = null, imagesData = null) {
    const achievementsByAppid = achievementsData.games || {};
    const reviewsByAppid = (reviewsData || {}).games || {};
    const costByAppid = costData.games || {};
    const imagesByAppid = (imagesData || {}).games || {};

    const gamesGrid = [];
    for (const g of gamesData.games) {
      const appid = g.appid;
      const info = achievementsByAppid[String(appid)];
      const review = reviewsByAppid[String(appid)];
      const costInfo = costByAppid[String(appid)];
      const imageInfo = imagesByAppid[String(appid)];
      gamesGrid.push({
        appid,
        name: g.name || `appid ${appid}`,
        hours: Math.round(((g.playtime_forever || 0) / 60) * 10) / 10,
        achievementsPercent: info ? info.percentComplete : null,
        achievementsUnlocked: info ? info.unlocked : null,
        achievementsTotal: info ? info.total : null,
        localImage: (imageInfo || {}).localImage || null,
        headerImage: (imageInfo || {}).headerImage || (costInfo || {}).headerImage || null,
        capsuleImage: (imageInfo || {}).capsuleImage || (costInfo || {}).capsuleImage || null,
        capsuleImagev5: (imageInfo || {}).capsuleImagev5 || (costInfo || {}).capsuleImagev5 || null,
        reviewDesc: review ? review.reviewDesc : null,
        reviewScore: review ? review.reviewScore : null,
        reviewPositivePercent: review ? review.positivePercent : null,
        reviewTotal: review ? review.totalReviews : null,
      });
    }

    // Сначала игры С достижениями (по алфавиту), потом БЕЗ (по алфавиту).
    const withAch = gamesGrid.filter((g) => g.achievementsPercent !== null).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const withoutAch = gamesGrid.filter((g) => g.achievementsPercent === null).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const sortedGrid = [...withAch, ...withoutAch];

    const totalAchUnlocked = Object.values(achievementsByAppid).reduce((s, info) => s + info.unlocked, 0);
    const totalAchAvailable = Object.values(achievementsByAppid).reduce((s, info) => s + info.total, 0);
    const overallPercent = totalAchAvailable ? Math.round((100 * totalAchUnlocked / totalAchAvailable) * 10) / 10 : 0.0;
    const gamesCompleted100 = Object.values(achievementsByAppid).filter((info) => info.percentComplete === 100.0).length;

    const report = {
      generatedAt: nowIso(),
      summary: {
        gamesCount: gamesData.gamesCount,
        totalHours: gamesData.totalHours,
        libraryCostUsd: costData.totalCostUsd,
        gamesPriced: costData.gamesPriced,
        gamesPriceNotFound: costData.gamesPriceNotFound,
        gamesPriceRateLimited: costData.gamesPriceRateLimited || 0,
        achievementsUnlockedTotal: totalAchUnlocked,
        achievementsAvailableTotal: totalAchAvailable,
        achievementsOverallPercent: overallPercent,
        gamesCompleted100,
        gamesWithAchievements: withAch.length,
        gamesWithoutAchievements: withoutAch.length,
        libraryCheck: gamesData.libraryCheck || null,
      },
      gamesGrid: sortedGrid,
      rarestAchievements: achievementsData.rarestAchievements || [],
      rarityTiers: achievementsData.rarityTiers || { totalRated: 0, counts: {}, coolnessScore: 0.0 },
      activityHeatmap: achievementsData.activityHeatmap || {},
    };

    await atomicWriteJson(reportJsonFile, report);
    await writeMarkdownReport(report);
    return report;
  }

  async function writeMarkdownReport(report) {
    const s = report.summary;
    const lines = [
      '# Steam Library Report',
      '',
      `_Сгенерировано: ${report.generatedAt}_`,
      '',
      '## Сводка',
      '',
      `- Игр в библиотеке: **${s.gamesCount}**`,
      `- Суммарное время: **${s.totalHours} часов**`,
      `- Стоимость библиотеки без скидок: **$${s.libraryCostUsd}**`,
      `  (цена найдена для ${s.gamesPriced} игр, не найдена для ${s.gamesPriceNotFound})`,
      '',
      '## Прогресс по достижениям (вся библиотека)',
      '',
      `- Открыто **${s.achievementsUnlockedTotal}** из **${s.achievementsAvailableTotal}** достижений (**${s.achievementsOverallPercent}%**)`,
      `- Игр пройдено на 100%: **${s.gamesCompleted100}**`,
      `- Игр с достижениями: ${s.gamesWithAchievements}, без достижений: ${s.gamesWithoutAchievements}`,
      '',
      '## Достижения по играм',
      '',
    ];
    for (const g of report.gamesGrid) {
      if (g.achievementsPercent !== null) {
        lines.push(`- ${g.name}: ${g.achievementsUnlocked}/${g.achievementsTotal} (${g.achievementsPercent}%)`);
      } else {
        lines.push(`- ${g.name}: нет достижений`);
      }
    }
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(reportMdFile, lines.join('\n') + '\n', 'utf-8');
  }

  return {
    fetchGamesList,
    fetchAchievementsStats,
    fetchGameImages,
    fetchLibraryCost,
    fetchReviews,
    generateReport,
    loadGamesList,
    loadAchievementsStats,
    loadLibraryCost,
    loadReviews,
    loadImages,
  };
}

module.exports = { createStats, computeRarityTiers, RARITY_TIERS };
