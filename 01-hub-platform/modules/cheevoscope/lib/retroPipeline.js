// Оркестрация RA-пайплайна — перенос retro_pipeline.py. Та же причина
// упрощения, что и в pipeline.js: один способ запуска вместо
// поток/отдельный-процесс, вызывающий код сам решает, ждать ли завершения.
const { makeStatusTracker, nowIso } = require('./statusTracker.js');

function createRetroPipeline({ getRetroStats, statusFile, logger = console }) {
  let isRunning = false;
  // Тот же принцип, что в pipeline.js — пересобирается перед каждым
  // прогоном, ключи RA могут смениться в интерфейсе между запусками.
  let retroStats;
  const { readStatus, writeStatus, progressCb } = makeStatusTracker(statusFile);

  // "Обновить": профиль, список игр с прогрессом, награды, лента
  // активности. НЕ дотягивает точные очки по консолям — самая дорогая по
  // запросам часть (1 вызов на игру), для быстрой кнопки того не стоит:
  // hardcore/softcore % по каждой игре и так уже точны из completion-progress.
  async function runQuickPipeline() {
    await writeStatus({ state: 'running', stage: 'profile', progress: null, error: null });
    const profile = await retroStats.fetchProfile();

    await writeStatus({ state: 'running', stage: 'games', progress: null });
    const progressList = await retroStats.fetchCompletionProgress();

    await writeStatus({ state: 'running', stage: 'awards', progress: null });
    const awards = await retroStats.fetchAwards();
    const recent = await retroStats.fetchRecentAchievements();

    await writeStatus({ state: 'running', stage: 'report', progress: null });
    await retroStats.generateReport(profile, progressList, awards, recent, new Map());
  }

  // "Обновить всё": то же самое + точные очки по консолям (per-game вызов,
  // свой кэш — повторные полные прогоны быстры для игр, чей прогресс не менялся).
  async function runFullPipeline() {
    await writeStatus({ state: 'running', stage: 'profile', progress: null, error: null });
    const profile = await retroStats.fetchProfile();

    await writeStatus({ state: 'running', stage: 'games', progress: null });
    const progressList = await retroStats.fetchCompletionProgress();
    await retroStats.generateReport(profile, progressList, [], [], new Map());

    await writeStatus({ state: 'running', stage: 'game_details', progress: null });
    const gameDetails = await retroStats.fetchGameDetails(progressList, progressCb);

    await writeStatus({ state: 'running', stage: 'awards', progress: null });
    const awards = await retroStats.fetchAwards();
    const recent = await retroStats.fetchRecentAchievements();

    await writeStatus({ state: 'running', stage: 'report', progress: null });
    await retroStats.generateReport(profile, progressList, awards, recent, gameDetails);
  }

  async function runPipeline(mode) {
    try {
      retroStats = await getRetroStats();
      if (!retroStats) throw new Error('RA_USERNAME/RA_API_KEY не заданы — настрой их в модуле "AI API"');
      if (mode === 'full') await runFullPipeline();
      else await runQuickPipeline();
      await writeStatus({ state: 'done', stage: null, progress: null, lastSuccessAt: nowIso(), error: null });
      logger.info('RetroAchievements: обновление успешно завершено.');
    } catch (e) {
      logger.error(`RetroAchievements: ошибка при обновлении: ${e.message}\n${e.stack}`);
      await writeStatus({ state: 'error', error: e.message });
    } finally {
      isRunning = false;
    }
  }

  function startRefresh(mode = 'quick') {
    if (mode !== 'quick' && mode !== 'full') {
      throw new Error(`Неизвестный режим обновления: ${mode}`);
    }
    if (isRunning) {
      logger.info('RetroAchievements: обновление уже идёт — пропускаю.');
      return { started: false, promise: null };
    }
    isRunning = true;
    const promise = runPipeline(mode);
    return { started: true, promise };
  }

  return { startRefresh, readStatus };
}

module.exports = { createRetroPipeline };
