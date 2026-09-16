// Данные для модалки "все ачивки + % редкости + выбито/нет" — по клику
// на плитку, не в основном отчёте (иначе тот разбухает в разы).
const ACHIEVEMENT_SCHEMA_CACHE_TTL_HOURS = 24 * 30;
const GLOBAL_PCT_CACHE_TTL_HOURS = 24 * 7;

function createAchievementDetails({ steamApi, retroApi, cache, logger = console }) {
  // Собирает по одной Steam-игре: apiname, название, описание, иконка, %
  // игроков (редкость), выбита ли у вас лично. Схема и глобальные % —
  // долгий кэш (не зависят от вас лично); личный прогресс — каждый раз
  // заново (дешёвый одиночный вызов, важна свежесть галочки "выбито").
  async function getSteamGameAchievements(appid) {
    // Три запроса параллельно — на холодном кэше их сумма легко
    // вылезала за тайм-аут прокси хаба (10с).
    const [schema, globalPct, playerData] = await Promise.all([
      cache.cachedCall(`schema_ru_${appid}`, () => steamApi.getSchemaForGame(appid), ACHIEVEMENT_SCHEMA_CACHE_TTL_HOURS),
      cache.cachedCall(`global_pct_${appid}`, () => steamApi.getGlobalAchievementPercentages(appid), GLOBAL_PCT_CACHE_TTL_HOURS),
      steamApi.getPlayerAchievements(appid),
    ]);

    if (!schema || schema.length === 0) {
      return { appid, available: false, achievements: [] };
    }

    // Диагностика — если модалка снова покажет всё одним цветом (все
    // открыты/все заблокированы) для конкретной игры, эта строка в логе
    // покажет, сколько ачивок реально пришло от Steam и сколько из них
    // совпало по имени, вместо гадания вслепую.
    const rawUnlockedCount = (playerData.achievements || []).filter((a) => a.achieved === 1).length;
    logger.info(
      `Ачивки appid=${appid}: схема ${schema.length}, личный прогресс ${(playerData.achievements || []).length} записей (${rawUnlockedCount} открыто), transientError=${Boolean(playerData.transientError)}`
    );

    // personalDataUnavailable — отличить "не открыто" от "не удалось
    // проверить"; пока только диагностика, поведение то же ([] в обоих случаях).
    if (playerData.transientError) {
      logger.warn(`appid=${appid}: личный прогресс не получен после ретраев — unlocked ниже не может быть достоверным`);
    }

    const pctByName = {};
    for (const a of globalPct) pctByName[a.name] = a.percent;

    const unlockedByName = {};
    for (const a of playerData.achievements || []) {
      if (a.achieved === 1) unlockedByName[a.apiname] = a.unlocktime;
    }

    const achievements = schema.map((a) => {
      const apiname = a.name;
      const rawPercent = pctByName[apiname];
      // Steam отдаёт percent строкой ("45.9"), не числом.
      let percent = null;
      if (rawPercent !== undefined && rawPercent !== null) {
        const v = Number(rawPercent);
        if (!Number.isNaN(v)) percent = v;
      }
      return {
        apiname,
        name: a.displayName || apiname,
        description: a.description || '',
        icon: a.icon || '',
        iconGray: a.icongray || '',
        globalPercent: percent !== null ? Math.round(percent * 10) / 10 : null,
        unlocked: apiname in unlockedByName,
        unlockTime: unlockedByName[apiname] ?? null,
      };
    });

    // Сначала самые редкие, неизвестная редкость (null) — в конец.
    achievements.sort((a, b) => {
      const aNull = a.globalPercent === null;
      const bNull = b.globalPercent === null;
      if (aNull !== bNull) return aNull ? 1 : -1;
      return (a.globalPercent || 0) - (b.globalPercent || 0);
    });

    return { appid, available: true, achievements, personalDataUnavailable: Boolean(playerData.transientError) };
  }

  // RA отдаёт всё одним вызовом. Тот же кэш-ключ, что у retroStats —
  // после "Обновить всё" модалка открывается мгновенно.
  async function getRetroGameAchievements(gameId) {
    const cacheKey = `retro_detail_${gameId}`;
    const cached = await cache.cacheGetWithAge(cacheKey);
    let detail = null;
    if (cached !== null && cached.ageHours <= 6 && cached.data && typeof cached.data === 'object') {
      detail = cached.data;
    }
    if (detail === null) {
      detail = await retroApi.getGameInfoAndUserProgress(gameId);
      if (detail && Object.keys(detail).length) await cache.cacheSet(cacheKey, detail);
    }

    if (!detail || !detail.Achievements) {
      return { gameId, available: false, achievements: [] };
    }

    const totalPlayers = detail.NumDistinctPlayersHardcore || detail.NumDistinctPlayersCasual || 0;

    const achievementsRaw = detail.Achievements;
    if (!achievementsRaw || typeof achievementsRaw !== 'object' || Array.isArray(achievementsRaw)) {
      return { gameId, available: false, achievements: [] };
    }

    const achievements = [];
    for (const a of Object.values(achievementsRaw)) {
      if (!a || typeof a !== 'object') continue;
      const numAwardedHc = a.NumAwardedHardcore || 0;
      const rarityHardcore = totalPlayers ? Math.round((100 * numAwardedHc / totalPlayers) * 10) / 10 : null;
      achievements.push({
        id: a.ID ?? null,
        name: a.Title || '',
        description: a.Description || '',
        points: a.Points || 0,
        badgeUrl: a.BadgeName ? `https://retroachievements.org/Badge/${a.BadgeName}.png` : '',
        globalPercent: rarityHardcore,
        unlocked: Boolean(a.DateEarned),
        unlockedHardcore: Boolean(a.DateEarnedHardcore),
        unlockTime: a.DateEarnedHardcore || a.DateEarned || null,
      });
    }

    achievements.sort((a, b) => {
      const aNull = a.globalPercent === null;
      const bNull = b.globalPercent === null;
      if (aNull !== bNull) return aNull ? 1 : -1;
      return (a.globalPercent || 0) - (b.globalPercent || 0);
    });

    return { gameId, available: true, achievements };
  }

  return { getSteamGameAchievements, getRetroGameAchievements };
}

module.exports = { createAchievementDetails };
