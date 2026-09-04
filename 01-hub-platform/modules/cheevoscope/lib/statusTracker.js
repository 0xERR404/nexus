// Трекер статуса обновления (state/stage/progress/lastSuccessAt/error) —
// Steam- и RA-пайплайну нужна одна и та же логика, отличается только
// путь к файлу статуса.
const fs = require('node:fs/promises');
const { atomicWriteJson } = require('./ioUtils.js');

const IDLE_STATUS = { state: 'idle', stage: null, progress: null, lastSuccessAt: null, error: null };

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

  async function writeStatus(patch) {
    const current = await readStatus();
    Object.assign(current, patch);
    current.updatedAt = nowIso();
    await atomicWriteJson(statusFile, current);
  }

  async function progressCb(stage, done, total) {
    await writeStatus({ state: 'running', stage, progress: { done, total } });
  }

  return { readStatus, writeStatus, progressCb };
}

module.exports = { makeStatusTracker, nowIso };
