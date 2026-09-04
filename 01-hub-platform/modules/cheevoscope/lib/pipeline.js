// Оркестрация Steam-пайплайна — перенос pipeline.py. В Python здесь было
// два разных способа запуска (start_refresh — в фоновом потоке, для HTTP;
// run_refresh_sync — синхронно, для отдельного процесса почасового
// refresh). В Node нет отдельного процесса для почасовой проверки (см.
// index.js — обычный setInterval внутри того же процесса, не systemd-
// таймер) и нет реальных потоков — оба сценария сводятся к одному и тому
// же: async-функция с защитой от повторного запуска через isRunning,
// вызывающий код решает сам, дожидаться её или нет.
const fs = require('node:fs/promises');
const path = require('node:path');
const { makeStatusTracker, nowIso } = require('./statusTracker.js');

function createPipeline({ getStats, statusFile, cacheDir, logger = console }) {
  let isRunning = false;
  // Пересобирается заново перед КАЖДЫМ прогоном (см. runPipeline ниже) —
  // ключи Steam приходят из хаба и могут смениться в интерфейсе между
  // запусками, тот же принцип, что и у токена агентов мониторинга:
  // "спрашиваем заново, не кэшируем".
  let stats;
  const { readStatus, writeStatus, progressCb, secondaryProgressCb } = makeStatusTracker(statusFile);

  // Кнопка "Обновить" — быстрое обновление, трогает по минимуму:
  // 1) список игр (дёшево), 2) достижения для ВСЕХ игр (но за счёт
  // "умного" кэша реально сходит в Steam только за играми "в процессе"),
  // 3) картинки — ТОЛЬКО для НОВЫХ игр. Цены и отзывы не считает вообще.
  async function runQuickPipeline() {
    const previous = await stats.loadGamesList();
    const previousAppids = new Set(previous ? previous.games.map((g) => g.appid) : []);

    await writeStatus({ state: 'running', stage: 'games_list', progress: null, error: null });
    const gamesData = await stats.fetchGamesList();
    let imagesData = await stats.loadImages();
    await stats.generateReport(gamesData, await stats.loadAchievementsStats(), await stats.loadLibraryCost(), await stats.loadReviews(), imagesData);

    const newGames = gamesData.games.filter((g) => !previousAppids.has(g.appid));
    if (newGames.length) {
      logger.info(`Обнаружено новых игр: ${newGames.length} — подтягиваю для них картинки.`);
      await writeStatus({ state: 'running', stage: 'images', progress: null });
      imagesData = await stats.fetchGameImages(newGames, progressCb);
      await stats.generateReport(gamesData, await stats.loadAchievementsStats(), await stats.loadLibraryCost(), await stats.loadReviews(), imagesData);
    }

    await writeStatus({ state: 'running', stage: 'achievements', progress: null });
    const achievementsData = await stats.fetchAchievementsStats(gamesData.games, progressCb);

    await writeStatus({ state: 'running', stage: 'report', progress: null });
    await stats.generateReport(gamesData, achievementsData, await stats.loadLibraryCost(), await stats.loadReviews(), imagesData);
  }

  // Кнопка "Обновить всё" — жёсткий пересчёт с нуля. Кэш ПОЛНОСТЬЮ
  // чистится перед запуском (см. clearAllCache), после чего полный прогон
  // по всем данным.
  //
  // Достижения (Web API) и картинки/отзывы/цены (витрина) — используют
  // ДВА РАЗНЫХ, независимых лимитера (см. steamApi.js), ходят на разные
  // домены без пересечения. Раньше шли строго друг за другом — теперь
  // параллельно: итоговое время определяется самым медленным из двух
  // направлений (обычно витрина — у неё лимит жёстче), не их суммой. На
  // большой библиотеке (сотни игр) экономит несколько минут.
  //
  // Картинки/отзывы/цены между собой — по-прежнему друг за другом:
  // картинки и цены используют один и тот же ответ витрины на appid
  // (fetchOneGamePrice), запусти их параллельно друг с другом — получили
  // бы дублирующиеся сетевые запросы вместо переиспользования свежего
  // кэша, записанного первым из двух.
  async function runFullPipeline() {
    await writeStatus({ state: 'running', stage: 'games_list', progress: null, error: null });
    const gamesData = await stats.fetchGamesList();
    await stats.generateReport(gamesData, await stats.loadAchievementsStats(), await stats.loadLibraryCost(), await stats.loadReviews(), await stats.loadImages());

    await writeStatus({ state: 'running', stage: 'images', progress: null, secondaryStage: 'achievements', secondaryProgress: null, error: null });
    // Как только достижения готовы — сразу освежаем отчёт тем, что уже
    // есть по картинкам/ценам/отзывам (могут быть ещё не готовы —
    // подставится то, что уже лежит на диске) — прогресс виден раньше,
    // не только в самом конце обоих параллельных направлений. Пишет
    // прогресс во ВТОРОЙ трек (secondaryProgressCb) — у витрины (ниже)
    // в разы меньше запросов в единицу времени, без разделения на два
    // независимых поля её прогресс почти никогда не попадал бы в статус,
    // постоянно перетираемый более частыми записями от достижений.
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

  // Чистит кэш перед "Обновить всё" — картинки/цены, отзывы и ЛИЧНЫЕ
  // достижения по каждой игре. Это всё, что реально может "устареть"
  // применительно к вам лично. Глобальную статистику ачивок (global_pct_*,
  // % игроков по игре — общая величина, не зависит от вас) НЕ трогаем —
  // меняется очень медленно, чистка была бы основным источником "тормозов".
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

  return { startRefresh, readStatus };
}

module.exports = { createPipeline };
