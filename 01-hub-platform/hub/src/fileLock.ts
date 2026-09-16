// Сериализует чтение→изменение→запись по одному файлу в пределах
// процесса — без этого конкурентные запросы к одному JSON-файлу молча
// теряют правки друг друга (последний writeFile побеждает над устаревшими
// данными). Один процесс на файл данных — мьютекса уровня процесса
// достаточно, отдельный lock-файл на диске не нужен.
const locks = new Map<string, Promise<unknown>>();

export function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn); // fn стартует даже если предыдущий держатель упал
  locks.set(key, run.catch(() => {})); // проглатываем ошибку в карте — вызывающий получает её через run
  return run;
}
