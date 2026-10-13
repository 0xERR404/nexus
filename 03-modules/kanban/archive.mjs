import fs from 'node:fs';
import path from 'node:path';

export function startSundayArchive(store, {
  directory = process.env.MAINTENANCE_DIRECTORY,
  now = Date.now,
  readStatus = () => directory ? JSON.parse(fs.readFileSync(path.join(directory,'status/status.json'),'utf8')) : null,
  repeat = setInterval,
  cancel = clearInterval,
  log = console.log,
  warn = console.error
} = {}) {
  store.enableSundayArchive(now());
  let failed = false;
  const tick = () => {
    try {
      const count = store.archiveAfterBoot(readStatus(),now());
      if (count) log(`Афина: после воскресной перезагрузки архивировано задач: ${count}`);
      failed = false;
    } catch (error) {
      // The host may not have published its first status yet. Retry without advancing the checkpoint.
      if (error.code !== 'ENOENT' && !failed) warn('Афина: автоархив недоступен; проверка будет повторена');
      failed = true;
    }
  };
  tick();
  const timer = repeat(tick,30000);
  timer.unref?.();
  return () => cancel(timer);
}
