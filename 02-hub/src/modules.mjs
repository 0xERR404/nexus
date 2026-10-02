import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export function currentManifest(id, manifest) {
  const names = {
    pulse: ['Пульс', 'Атлас'],
    signal: ['Сигнал', 'Гермес'],
    balance: ['Баланс', 'Плутос'],
    chat: ['Чат', 'Оракул'],
    anime: ['Кадр', 'Дионис'],
    trophies: ['Трофеи', 'Ника'],
    wave: ['Волна', 'Аполлон'],
    storage: ['Хранилище', 'Гестия'],
    projects: ['Проекты', 'Гефест'],
    kanban: ['Канбан', 'Афина'],
    rhythm: ['Ритм', 'Асклепий']
  };
  return names[id]?.[0] === manifest.title ? {...manifest, title: names[id][1]} : manifest;
}
export function validateManifest(manifest) {
  if (
    !manifest ||
    manifest.apiVersion !== 1 ||
    typeof manifest.enabled !== 'boolean' ||
    typeof manifest.title !== 'string' ||
    !manifest.title.trim() ||
    manifest.title.length > 64 ||
    typeof manifest.description !== 'string' ||
    manifest.description.length > 160
  )
    throw new Error('Invalid manifest');
  return manifest;
}
export async function loadModules(directory, {start: initialize = false} = {}) {
  const modules = new Map();
  modules.diagnostics = [];
  let entries;
  try {
    entries = await readdir(directory, {withFileTypes: true});
  } catch (error) {
    if (error.code === 'ENOENT') return modules;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^[a-z][a-z0-9-]{0,31}$/.test(entry.name)) continue;
    let cleanup;
    try {
      const manifest = currentManifest(
        entry.name,
        JSON.parse(await readFile(path.join(directory, entry.name, 'manifest.json'), 'utf8'))
      );
      validateManifest(manifest);
      if (!manifest.enabled) {
        modules.diagnostics.push({
          id: entry.name,
          title: manifest.title,
          version: manifest.version ?? null,
          state: 'disabled'
        });
        continue;
      }
      if (
        entry.name === 'trophies' &&
        fs.existsSync(path.join(directory, entry.name, 'steam-auth.mjs'))
      )
        throw new Error('Legacy QR module must be updated before loading');
      const {handle, summary, settings, start, close, publicHandle, uploads, removeUpload, recent} =
        await import(pathToFileURL(path.join(directory, entry.name, 'index.mjs')).href);
      if (typeof handle !== 'function') throw new Error('Missing handler');
      if (initialize && typeof start === 'function') {
        cleanup = close;
        await start();
      }
      modules.set(entry.name, {
        id: entry.name,
        title: manifest.title,
        description: manifest.description,
        version: typeof manifest.version === 'string' ? manifest.version : null,
        handle,
        recent: typeof recent === 'function' ? recent : undefined,
        uploads: typeof uploads === 'function' ? uploads : undefined,
        removeUpload: typeof removeUpload === 'function' ? removeUpload : undefined,
        publicHandle: typeof publicHandle === 'function' ? publicHandle : undefined,
        start: typeof start === 'function' ? start : undefined,
        close: typeof close === 'function' ? close : undefined,
        summary: typeof summary === 'function' ? summary : undefined,
        settings:
          typeof settings?.title === 'string' &&
          settings.title.trim() &&
          settings.title.length <= 64 &&
          typeof settings.content === 'string'
            ? {title: settings.title, content: settings.content}
            : undefined
      });
    } catch {
      if (typeof cleanup === 'function') {
        try {
          await cleanup();
        } catch {}
      }
      modules.diagnostics.push({
        id: entry.name,
        title: entry.name,
        version: null,
        state: 'error',
        error: 'Модуль не загрузился: проверь установку и совместимость версии'
      });
      console.error('Module not loaded:', entry.name);
    }
  }
  return modules;
}

export async function moduleSummary(module, timeout = 3000) {
  if (!module.summary) return undefined;
  let timer;
  const controller = new AbortController();
  try {
    const data = await Promise.race([
      Promise.resolve().then(() => module.summary({signal: controller.signal})),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('timeout'));
        }, timeout);
      })
    ]);
    return cleanSummary(module, data);
  } catch {
    return {state: 'stale', items: []};
  } finally {
    clearTimeout(timer);
  }
}

function cleanSummary(module, data) {
  if (!['ok', 'warning', 'stale'].includes(data?.state) || !Array.isArray(data.items))
    throw new Error('Invalid summary');
  return {
    state: data.state,
    ...(module.id === 'signal' && Array.isArray(data.preview)
      ? {
          preview: data.preview
            .slice(0, 2)
            .filter((e) => e && Number.isFinite(e.time) && e.time > 0)
            .map((e) => ({title: String(e.title ?? '').slice(0, 100), time: e.time}))
        }
      : {}),
    ...(module.id === 'anime' && Array.isArray(data.covers)
      ? {
          covers: data.covers
            .filter((id) => Number.isSafeInteger(id) && id > 0 && id <= 9999999999)
            .slice(0, 3)
        }
      : {}),
    ...(data.chart &&
    ['RUB', 'USD', 'EUR'].includes(data.chart.currency) &&
    /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(data.chart.month) &&
    Array.isArray(data.chart.points) &&
    data.chart.points.length > 0 &&
    data.chart.points.length <= 31 &&
    data.chart.points.every(Number.isSafeInteger)
      ? {
          chart: {
            currency: data.chart.currency,
            month: data.chart.month,
            points: data.chart.points
          }
        }
      : {}),
    items: data.items.slice(0, 3).map((item) => ({
      label: String(item.label ?? '').slice(0, 24),
      value: String(item.value ?? '—').slice(0, 24)
    }))
  };
}

export class DashboardCache {
  constructor(modules, {file, identity = '', now = Date.now, timeout = 3000} = {}) {
    Object.assign(this, {modules, file, identity, now, timeout});
    this.records = new Map();
    this.due = new Map();
    this.pending = new Map();
    this.dirty = new Set();
    this.stopped = false;
    this.lastSave = 0;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 262144) throw Error('Invalid snapshot');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.schema !== 1 || saved.identity !== identity || !Array.isArray(saved.modules))
        throw Error('Invalid snapshot');
      for (const item of saved.modules.slice(0, 128)) {
        const module = modules.get(item.id),
          age = now() - item.updatedAt;
        if (
          !module?.summary ||
          !Number.isFinite(item.updatedAt) ||
          item.updatedAt <= 0 ||
          age < 0 ||
          age > 86400000
        )
          continue;
        try {
          const summary = cleanSummary(module, item.summary);
          if (summary.state !== 'stale')
            this.records.set(item.id, {summary, updatedAt: item.updatedAt, stale: true});
        } catch {}
      }
    } catch {}
    this.publish();
  }
  interval(id) {
    return id === 'pulse' ? 10000 : id === 'signal' ? 15000 : 60000;
  }
  publish() {
    this.body = JSON.stringify({
      modules: [...this.modules.values()].map((module) => {
        const record = this.records.get(module.id);
        return {
          id: module.id,
          title: module.title,
          description: module.description,
          ...(module.summary
            ? {
                summary: record?.summary ?? {state: 'stale', items: []},
                updatedAt: record?.updatedAt ?? 0,
                stale:
                  !record ||
                  record.stale ||
                  this.now() - record.updatedAt > this.interval(module.id) * 2
              }
            : {})
        };
      })
    });
  }
  read() {
    return this.body;
  }
  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, 5000);
    this.timer.unref();
    return this.refresh().then(() => this.persist());
  }
  refresh() {
    if (this.stopped) return Promise.resolve();
    for (const [id, module] of this.modules) {
      if (!module.summary || this.pending.has(id) || (this.due.get(id) ?? 0) > this.now()) continue;
      this.dirty.delete(id);
      const job = moduleSummary(module, this.timeout)
        .then((summary) => {
          if (this.stopped) return;
          const previous = this.records.get(id);
          this.records.set(
            id,
            summary.state === 'stale'
              ? {...(previous ?? {summary, updatedAt: 0}), stale: true}
              : {summary, updatedAt: this.now(), stale: false}
          );
          this.due.set(id, this.dirty.has(id) ? 0 : this.now() + this.interval(id));
          this.publish();
          if (this.now() - this.lastSave >= 30000) this.persist();
        })
        .finally(() => {
          this.pending.delete(id);
          if (!this.stopped && this.dirty.has(id))
            queueMicrotask(() => {
              void this.refresh();
            });
        });
      this.pending.set(id, job);
    }
    this.publish();
    return Promise.all([...this.pending.values()]);
  }
  invalidate(id) {
    if (!this.modules.has(id) || this.stopped) return;
    this.dirty.add(id);
    this.due.set(id, 0);
    queueMicrotask(() => {
      void this.refresh();
    });
  }
  persist() {
    if (!this.file || this.savedBody === this.body) return;
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), {recursive: true, mode: 0o700});
      const data = JSON.stringify({schema: 1, identity: this.identity, ...JSON.parse(this.body)});
      if (Buffer.byteLength(data) > 262144) return;
      fs.writeFileSync(temporary, data, {mode: 0o600, flag: 'wx'});
      fs.renameSync(temporary, this.file);
      this.savedBody = this.body;
      this.lastSave = this.now();
    } catch {
      // Memory remains available when storage is unavailable.
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
  }
  close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.persist();
  }
}
