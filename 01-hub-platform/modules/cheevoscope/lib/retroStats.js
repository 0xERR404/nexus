// RA-аналог stats.js — собирает retro_report.json из данных
// RetroAchievements. В отличие от Steam-версии, список игр с прогрессом —
// ОДИН вызов (API_GetUserCompletionProgress, постранично), а не перебор
// appid по одному — отдельного fetchGamesList нет. Per-game вызов
// (GetGameInfoAndUserProgress) нужен только там, где нужны реальные Points,
// не просто % — это "полный" режим, он же прогревает кэш для модалки ачивок
// (см. achievementDetails.js).
const fs = require('node:fs/promises');
const { atomicWriteJson } = require('./ioUtils.js');
const { runParallel } = require('./runParallel.js');
const { nowIso } = require('./statusTracker.js');

const RETRO_NO_PROGRESS_CACHE_TTL_HOURS = 24 * 30;
const RETRO_MASTERED_CACHE_TTL_HOURS = 24 * 7;

function createRetroStats({ retroApi, cache, paths, computeRarityTiers, logger = console }) {
  const { retroReportJsonFile } = paths;

  async function fetchProfile() {
    // Профиль: очки, RetroPoints, ранг. Меняется часто — без долгого кэша.
    return retroApi.getUserProfile();
  }

  async function fetchCompletionProgress() {
    return retroApi.getUserCompletionProgress();
  }

  async function fetchAwards() {
    return retroApi.getUserAwards();
  }

  async function fetchRecentAchievements() {
    return retroApi.getUserRecentAchievements();
  }

  // Тот же принцип "умного" TTL, что у Steam-версии: игра без единого
  // прогресса почти не меняется, замастеренная (100% hardcore) — тоже,
  // "в процессе" — всегда свежая.
  function gameDetailCacheTtl(progressEntry) {
    const maxPossible = progressEntry.MaxPossible || 0;
    const numAwardedHc = progressEntry.NumAwardedHardcore || 0;
    const numAwarded = progressEntry.NumAwarded || 0;
    if (numAwarded === 0) return RETRO_NO_PROGRESS_CACHE_TTL_HOURS;
    if (maxPossible && numAwardedHc === maxPossible) return RETRO_MASTERED_CACHE_TTL_HOURS;
    return 0.0;
  }

  // Дотягивает GetGameInfoAndUserProgress для одной игры — нужен ради
  // реальных Points, которых нет в completion-progress. Кэш под ключом
  // retro_detail_{gameId} — тот же самый, который читает
  // achievementDetails.getRetroGameAchievements для модалки, так что после
  // "Обновить всё" модалка открывается мгновенно, без похода в сеть.
  async function fetchOneGameDetail(progressEntry) {
    const gameId = progressEntry.GameID;
    const cacheKey = `retro_detail_${gameId}`;
    const cached = await cache.cacheGetWithAge(cacheKey);
    const ttl = gameDetailCacheTtl(progressEntry);
    if (cached !== null && cached.ageHours <= ttl && cached.data && typeof cached.data === 'object') {
      return cached.data;
    }
    const detail = await retroApi.getGameInfoAndUserProgress(gameId);
    await cache.cacheSet(cacheKey, detail);
    return detail;
  }

  // Полный прогон по всем играм — "Обновить всё". В быстром режиме этот
  // шаг пропускается (см. retroPipeline) — очки по консолям просто не
  // обновляются в текущем прогоне, остаются из предыдущего полного.
  async function fetchGameDetails(progressList, progressCb = null) {
    return runParallel(progressList, fetchOneGameDetail, 3, 'retro_game_details', progressCb, (item) => item.GameID);
  }

  async function loadRetroReport() {
    try {
      const raw = await fs.readFile(retroReportJsonFile, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  async function generateReport(profile, progressList, awards, recent, gameDetails) {
    const games = [];
    let pointsByConsole = {};
    let totalHardcoreEarned = 0;
    let totalSoftcoreEarned = 0;
    let totalPossible = 0;
    let masteredCount = 0;
    let completedCount = 0;
    const rarityCandidates = [];

    for (const entry of progressList) {
      if (!entry || typeof entry !== 'object') {
        logger.warn(`RetroAchievements: пропускаю неожиданный элемент прогресса (не объект): ${JSON.stringify(entry)}`);
        continue;
      }
      const gameId = entry.GameID;
      const maxPossible = entry.MaxPossible || 0;
      const numAwarded = entry.NumAwarded || 0;
      const numAwardedHc = entry.NumAwardedHardcore || 0;
      const console_ = entry.ConsoleName || '—';

      const hardcorePct = maxPossible ? Math.round((100 * numAwardedHc / maxPossible) * 10) / 10 : 0.0;
      const softcorePct = maxPossible ? Math.round((100 * numAwarded / maxPossible) * 10) / 10 : 0.0;
      const isMastered = maxPossible > 0 && numAwardedHc === maxPossible;
      const isCompleted = maxPossible > 0 && numAwarded === maxPossible && !isMastered;

      if (isMastered) masteredCount++;
      else if (isCompleted) completedCount++;

      totalHardcoreEarned += numAwardedHc;
      totalSoftcoreEarned += numAwarded;
      totalPossible += maxPossible;

      let detail = (gameDetails.get ? gameDetails.get(gameId) : gameDetails[gameId]) || {};
      if (!detail || typeof detail !== 'object') detail = {};
      const detailAchievements = Object.values(detail.Achievements || {});
      const hardcorePoints = detailAchievements.filter((a) => a.DateEarnedHardcore).reduce((s, a) => s + (Number(a.Points) || 0), 0);
      const softcorePoints = detailAchievements.filter((a) => a.DateEarned).reduce((s, a) => s + (Number(a.Points) || 0), 0);
      if (detailAchievements.length) {
        const bucket = pointsByConsole[console_] || { hardcore: 0, softcore: 0 };
        bucket.hardcore += hardcorePoints;
        bucket.softcore += softcorePoints;
        pointsByConsole[console_] = bucket;
      }

      // Кандидаты для библиотечного топ-10 самых редких — только открытые
      // ачивки, только там, где известен знаменатель (число игроков).
      const totalPlayers = detail.NumDistinctPlayersHardcore || detail.NumDistinctPlayersCasual || 0;
      if (totalPlayers) {
        for (const a of detailAchievements) {
          if (!a.DateEarned) continue;
          const numAHc = a.NumAwardedHardcore || 0;
          const percent = Math.round((100 * numAHc / totalPlayers) * 10) / 10;
          rarityCandidates.push({ gameId, game: entry.Title || `game ${gameId}`, name: a.Title || '', globalPercent: percent });
        }
      }

      games.push({
        gameId,
        title: entry.Title || `game ${gameId}`,
        console: console_,
        imageIcon: entry.ImageIcon || '',
        maxPossible,
        numAwarded,
        numAwardedHardcore: numAwardedHc,
        hardcorePercent: hardcorePct,
        softcorePercent: softcorePct,
        status: isMastered ? 'mastered' : isCompleted ? 'completed' : 'in_progress',
        mostRecentAwardDate: entry.MostRecentAwardedDate || null,
      });
    }

    games.sort((a, b) => (b.mostRecentAwardDate || '').localeCompare(a.mostRecentAwardDate || ''));

    const overallHardcorePercent = totalPossible ? Math.round((100 * totalHardcoreEarned / totalPossible) * 10) / 10 : 0.0;

    const awardsSafe = (awards || []).filter((a) => a && typeof a === 'object');
    const awardsOut = [...awardsSafe]
      .sort((a, b) => (b.AwardedAt || '').localeCompare(a.AwardedAt || ''))
      .map((a) => ({ title: a.Title || '', console: a.ConsoleName || '', awardType: a.AwardType || '', awardDate: a.AwardedAt || '' }));

    const recentOut = (recent || [])
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({ achievement: r.Title || '', game: r.GameTitle || '', date: r.Date || '', hardcore: Boolean(r.HardcoreMode) }));

    rarityCandidates.sort((a, b) => a.globalPercent - b.globalPercent);
    let rarestAchievements = rarityCandidates.slice(0, 10);
    let rarityTiers = computeRarityTiers(rarityCandidates);

    const gameDetailsEmpty = gameDetails.size !== undefined ? gameDetails.size === 0 : Object.keys(gameDetails).length === 0;
    if (!gameDetails || gameDetailsEmpty) {
      // Быстрый режим не дотягивает GetGameInfoAndUserProgress (дорого) —
      // сохраняем очки по консолям из предыдущего полного прогона, чтобы
      // блок не обнулялся на каждом "Обновить".
      const previous = await loadRetroReport();
      pointsByConsole = previous.pointsByConsole || {};
      rarestAchievements = previous.rarestAchievements || [];
      rarityTiers = previous.rarityTiers || { totalRated: 0, counts: {}, coolnessScore: 0.0 };
    }

    const report = {
      generatedAt: nowIso(),
      profile: {
        username: profile.User || '',
        points: profile.TotalPoints || 0,
        retroPoints: profile.TotalTruePoints || 0,
        rank: profile.Rank ?? null,
        avatarUrl: profile.UserPic || '',
      },
      summary: {
        gamesCount: games.length,
        gamesMastered: masteredCount,
        gamesCompleted: completedCount,
        achievementsHardcoreTotal: totalHardcoreEarned,
        achievementsSoftcoreTotal: totalSoftcoreEarned,
        achievementsPossibleTotal: totalPossible,
        overallHardcorePercent,
      },
      pointsByConsole,
      games,
      awards: awardsOut,
      recentAchievements: recentOut,
      rarestAchievements,
      rarityTiers,
    };

    await atomicWriteJson(retroReportJsonFile, report);
    return report;
  }

  return {
    fetchProfile,
    fetchCompletionProgress,
    fetchAwards,
    fetchRecentAchievements,
    fetchGameDetails,
    loadRetroReport,
    generateReport,
  };
}

module.exports = { createRetroStats };
