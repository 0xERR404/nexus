// Прогоняет worker(item) по items с пределом maxWorkers, стримит прогресс
// через progressCb. Результаты — в Map по ключу keyFn(item).
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
