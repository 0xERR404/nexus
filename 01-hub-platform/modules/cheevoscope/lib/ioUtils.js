// Пишет во временный файл и переименовывает поверх оригинала (fs.rename
// атомарен) — если процесс упадёт посреди записи, исходный файл цел.
const fs = require('node:fs/promises');
const path = require('node:path');

async function atomicWriteJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
}

module.exports = { atomicWriteJson };
