// Оркестрация Steam-пайплайна: async-функция с защитой от повторного
// запуска через isRunning, вызывающий код сам решает, ждать ли результат.
const fs = require('node:fs/promises');
const path = require('node:path');
const { makeStatusTracker, nowIso } = require('./statusTracker.js');

function createPipeline({ getStats, statusFile, cacheDir, logger = console }) {
  let isRunning = false;
  // Пересобирается перед каждым прогоном — ключи могут смениться между
  // запусками, не кэшируем.
  let stats;
  const { readStatus, writeStatus, progressCb, secondaryProgressCb } = makeStatusTracker(statusFile);

  // "Обновить" — список игр, достижения (умный кэш бережёт запросы),
  // картинки только для новых игр; цены/отзывы не считает.
  // Картинки и достижения — два независимых лимитера, параллельно;
  // достижения пишут во второй трек прогресса (иначе перетирали бы
  // прогресс картинок частыми записями).
  async function runQuickPipeline() {
    const previous = await stats.loadGamesList();
    const previousAppids = new Set(previous ? previous.games.map((g) => g.appid) : []);

    await writeStatus({ state: 'running', stage: 'games_list', progress: null, error: null });
    const gamesData = await stats.fetchGamesList();
    let imagesData = await stats.loadImages();
    await stats.generateReport(gamesData, await stats.loadAchievementsStats(), await stats.loadLibraryCost(), await stats.loadReviews(), imagesData);

    const newGames = gamesData.games.filter((g) => !previousAppids.has(g.appid));

    const imagesPromise = newGames.length
      ? (async () => {
          logger.info(`Обнаружено новых игр: ${newGames.length} — подтягиваю для них картинки.`);
          await writeStatus({ state: 'running', stage: 'images', progress: null });
          const data = await stats.fetchGameImages(newGames, progressCb);
          imagesData = data;
          await stats.generateReport(gamesData, await stats.loadAchievementsStats(), await stats.loadLibraryCost(), await stats.loadReviews(), imagesData);
          return data;
        })()
      : Promise.resolve(imagesData);

    const achievementsPromise = (async () => {
      // Стартует сразу, даже если newGames.length === 0 — не ждёт
      // условие, обе ветки запускаются одним and-then.
      await writeStatus({ state: 'running', secondaryStage: 'achievements', secondaryProgress: null });
      return stats.fetchAchievementsStats(gamesData.games, secondaryProgressCb);
    })();

    const [, achievementsData] = await Promise.all([imagesPromise, achievementsPromise]);
    // Готово раньше картинок — трек очищаем, не оставляем "N/N" висеть
    // до самого конца, будто всё ещё считается (та же причина, что и в
    // runFullPipeline).
    await writeStatus({ secondaryStage: null, secondaryProgress: null });

    await writeStatus({ state: 'running', stage: 'report', progress: null });
    await stats.generateReport(gamesData, achievementsData, await stats.loadLibraryCost(), await stats.loadReviews(), imagesData);
  }

  // "Обновить всё" — кэш полностью чистится (clearAllCache), затем
  // полный прогон. Достижения и картинки/отзывы/цены — два независимых
  // лимитера, параллельно (итоговое время — по самому медленному, не
  // сумма). Картинки/отзывы/цены между собой — друг за другом: картинки
  // и цены используют один и тот же ответ витрины на appid.
  async function runFullPipeline() {
    await writeStatus({ state: 'running', stage: 'games_list', progress: null, error: null });
    const gamesData = await stats.fetchGamesList();
    await stats.generateReport(gamesData, await stats.loadAchievementsStats(), await stats.loadLibraryCost(), await stats.loadReviews(), await stats.loadImages());

    await writeStatus({ state: 'running', stage: 'images', progress: null, secondaryStage: 'achievements', secondaryProgress: null, error: null });
    // Достижения готовы — сразу освежаем отчёт тем, что уже есть по
    // картинкам/ценам/отзывам. Второй трек прогресса — у витрины запросов
    // на порядок меньше, без разделения полей её прогресс не попадал бы в статус.
    const achievementsPromise = stats.fetchAchievementsStats(gamesData.games, secondaryProgressCb).then(async (data) => {
      await stats.generateReport(gamesData, data, await stats.loadLibraryCost(), await stats.loadReviews(), await stats.loadImages());
      // Готово раньше витрины — трек очищаем, а не оставляем "410/410"
      // висеть до самого конца, будто всё ещё считается.
      await writeStatus({ secondaryStage: null, secondaryProgress: null });
      return data;
    });

    const storeStagesPromise = (async () => {
      const imagesData = await stats.fetchGameImages(gamesData.games, progressCb);
      const reviewsData = await stats.fetchReviews(gamesData.games, progressCb);
      const costData = await stats.fetchLibraryCost(gamesData.games, progressCb);
      return { imagesData, reviewsData, costData };
    })();

    const [achievementsData, storeStages] = await Promise.all([achievementsPromise, storeStagesPromise]);
    const { imagesData, reviewsData, costData } = storeStages;

    await writeStatus({ state: 'running', stage: 'report', progress: null });
    await stats.generateReport(gamesData, achievementsData, costData, reviewsData, imagesData);
  }

  // Чистит картинки/цены/отзывы/личные достижения — то, что реально может
  // устареть лично для вас. Глобальную статистику ачивок не трогаем —
  // меняется очень медленно.
  async function clearAllCache() {
    let removed = 0;
    let files;
    try {
      files = await fs.readdir(cacheDir);
    } catch {
      return 0;
    }
    const patterns = [/^price_.*\.json$/, /^review_.*\.json$/, /^player_ach_.*\.json$/];
    for (const file of files) {
      if (patterns.some((p) => p.test(file))) {
        try {
          await fs.unlink(path.join(cacheDir, file));
          removed++;
        } catch {
          // не удалось удалить — не критично, пропускаем
        }
      }
    }
    return removed;
  }

  async function runPipeline(mode) {
    try {
      stats = await getStats();
      if (!stats) throw new Error('Steam API-ключ/SteamID не заданы — настрой их в модуле "AI API"');
      if (mode === 'full') {
        const removed = await clearAllCache();
        logger.info(`Обновить всё: кэш полностью очищен (${removed} файлов удалено).`);
        await runFullPipeline();
      } else {
        await runQuickPipeline();
      }
      await writeStatus({ state: 'done', stage: null, progress: null, lastSuccessAt: nowIso(), error: null });
      logger.info('Обновление успешно завершено.');
    } catch (e) {
      logger.error(`Ошибка при обновлении: ${e.message}\n${e.stack}`);
      await writeStatus({ state: 'error', error: e.message });
    } finally {
      isRunning = false;
    }
  }

  // Возвращает {started: false}, если обновление уже идёт. Не дожидается
  // завершения пайплайна — вызывающий код (HTTP-ручка или почасовая
  // задача) решает сам, ждать ли результат.
  function startRefresh(mode = 'quick') {
    if (mode !== 'quick' && mode !== 'full') {
      throw new Error(`Неизвестный режим обновления: ${mode}`);
    }
    if (isRunning) return { started: false, promise: null };
    isRunning = true;
    const promise = runPipeline(mode);
    return { started: true, promise };
  }

  // На старте — "running" в файле статуса точно эхо предыдущего
  // процесса (не дожил до finally). Без сброса — тупик: фронтенд
  // блокирует обе кнопки навсегда, а сменить статус некому.
  (async () => {
    const current = await readStatus();
    if (current.state === 'running') {
      await writeStatus({
        state: 'error',
        stage: null,
        progress: null,
        secondaryStage: null,
        secondaryProgress: null,
        error: 'Обновление прервано перезапуском модуля — нажмите "Обновить" ещё раз',
      });
    }
  })();

  return { startRefresh, readStatus };
}

module.exports = { createPipeline };
