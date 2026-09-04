// Трекер статуса обновления (state/stage/progress/lastSuccessAt/error) —
// Steam- и RA-пайплайну нужна одна и та же логика, отличается только
// путь к файлу статуса.
const fs = require('node:fs/promises');
const { atomicWriteJson } = require('./ioUtils.js');

const IDLE_STATUS = { state: 'idle', stage: null, progress: null, secondaryStage: null, secondaryProgress: null, lastSuccessAt: null, error: null };

function nowIso() {
  return new Date().toISOString();
}

// Возвращает {readStatus, writeStatus, progressCb}, уже привязанные к
// конкретному statusFile — по одному набору на пайплайн (Steam/RA).
function makeStatusTracker(statusFile) {
  async function readStatus() {
    try {
      const raw = await fs.readFile(statusFile, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return { ...IDLE_STATUS };
    }
  }

  // Достижения (Web API) и картинки/цены/отзывы (витрина) теперь считаются
  // параллельно (см. pipeline.js) и оба пишут статус в один и тот же файл
  // через progressCb ниже. Без сериализации — гонка: "прочитать → изменить
  // → записать" у двух concurrent-вызовов пересекается, один перезаписывает
  // прогресс другого поверх (у ачивок вызовов на порядок больше — их
  // запись почти всегда "побеждает" и постоянно затирает прогресс витрины,
  // из-за чего казалось, что тот "завис"). writeQueue — простой мьютекс:
  // каждый следующий writeStatus дожидается, пока закончится предыдущий,
  // прежде чем сам начнёт свой цикл чтение-запись.
  let writeQueue = Promise.resolve();

  async function writeStatus(patch) {
    const task = writeQueue.then(async () => {
      const current = await readStatus();
      Object.assign(current, patch);
      current.updatedAt = nowIso();
      await atomicWriteJson(statusFile, current);
    });
    // Даже если этот конкретный patch упадёт с ошибкой — очередь не должна
    // застрять навсегда, следующий writeStatus обязан суметь пойти дальше.
    writeQueue = task.catch(() => {});
    return task;
  }

  async function progressCb(stage, done, total) {
    await writeStatus({ state: 'running', stage, progress: { done, total } });
  }

  // Второй, независимый "трек" прогресса — достижения (Web API) и витрина
  // теперь считаются параллельно (см. pipeline.js), у обоих есть что
  // показать одновременно. Пишет в ОТДЕЛЬНЫЕ поля (secondaryStage/
  // secondaryProgress), не в stage/progress — оба трека видны в статусе
  // разом, ни один не перетирает другой просто по факту более частой записи.
  async function secondaryProgressCb(stage, done, total) {
    await writeStatus({ secondaryStage: stage, secondaryProgress: { done, total } });
  }

  return { readStatus, writeStatus, progressCb, secondaryProgressCb };
}

module.exports = { makeStatusTracker, nowIso };
