// Асинхронный аналог RateLimiter из steam_api.py: до maxConcurrency
// запросов "в полёте" одновременно, но моменты СТАРТА запросов разнесены
// не менее чем на minIntervalSec секунд — то есть общий темп ОТПРАВКИ
// запросов остаётся прежним, а ускорение получаем за счёт перекрытия
// сетевого ожидания (RTT) между несколькими одновременными запросами.
//
// Слот концурентности занимается СРАЗУ при выдаче (даже если сама задача
// ещё ждёт своего момента старта по minInterval) — то же самое, что в
// Python-версии: semaphore.acquire() идёт ПЕРЕД паузой на min_interval,
// значит период ожидания старта тоже засчитывается в "занят слотом".
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
