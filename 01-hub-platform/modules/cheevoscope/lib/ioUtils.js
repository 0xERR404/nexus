// Пишет JSON во временный файл рядом с целевым и переименовывает его
// поверх оригинала (fs.rename — атомарная операция на одной файловой
// системе). Если процесс упадёт посреди записи, исходный файл останется
// целым, не обрежется наполовину — просто не будет обновлён.
//
// Директорию создаёт сама (mkdir recursive) — в Python-оригинале все
// нужные папки создавались один раз при старте (config.py), здесь эквивалент
// того же самого сделан на уровне самой записи, а не отдельным шагом
// инициализации, который легко забыть вызвать в новом месте.
const fs = require('node:fs/promises');
const path = require('node:path');

async function atomicWriteJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
}

module.exports = { atomicWriteJson };
