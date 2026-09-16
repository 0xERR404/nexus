// До maxConcurrency запросов одновременно, но старты разнесены не менее
// чем на minIntervalSec — темп отправки тот же, ускорение за счёт
// перекрытия сетевого ожидания. Слот занимается сразу при выдаче, ещё
// до паузы на minInterval.
function makeRateLimiter(minIntervalSec, maxConcurrency) {
  let nextSlotAt = 0; // мс, epoch — не раньше какого момента разрешён следующий старт
  let activeCount = 0;
  const waiting = [];

  function pump() {
    while (activeCount < maxConcurrency && waiting.length > 0) {
      const now = Date.now();
      const startAt = Math.max(now, nextSlotAt);
      nextSlotAt = startAt + minIntervalSec * 1000;
      const delay = startAt - now;
      const resolve = waiting.shift();
      activeCount++;
      if (delay <= 0) resolve();
      else setTimeout(resolve, delay);
    }
  }

  function acquire() {
    return new Promise((resolve) => {
      waiting.push(resolve);
      pump();
    });
  }

  function release() {
    activeCount--;
    pump();
  }

  // Удобный wrapper: acquire → await fn() → release (даже при ошибке).
  async function run(fn) {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { run };
}

module.exports = { makeRateLimiter };
