// Прогоняет worker(item) по списку items с пределом maxWorkers одновременно
// и стримит прогресс через progressCb(stage, done, total). Результаты
// собираются в Map по ключу от keyFn(item) — порядок завершения не важен,
// вызывающий код всегда обращается к ним по ключу (как в Python-версии
// результаты собирались в dict по appid/GameID).
async function runParallel(items, worker, maxWorkers, stage, progressCb, keyFn) {
  const results = new Map();
  let done = 0;
  const total = items.length;
  let index = 0;

  async function workerLoop() {
    while (index < items.length) {
      const item = items[index++];
      const key = keyFn(item);
      const res = await worker(item);
      results.set(key, res);
      done++;
      if (progressCb) await progressCb(stage, done, total);
    }
  }

  const workerCount = Math.max(1, Math.min(maxWorkers, items.length));
  const workers = Array.from({ length: workerCount }, () => workerLoop());
  await Promise.all(workers);
  return results;
}

module.exports = { runParallel };
