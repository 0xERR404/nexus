import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
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
      const manifest = JSON.parse(
        await readFile(path.join(directory, entry.name, 'manifest.json'), 'utf8')
      );
      validateManifest(manifest);
      if (!manifest.enabled) continue;
      const {handle, summary, settings, start, close} = await import(
        pathToFileURL(path.join(directory, entry.name, 'index.mjs')).href
      );
      if (typeof handle !== 'function') throw new Error('Missing handler');
      if (initialize && typeof start === 'function') {
        cleanup = close;
        await start();
      }
      modules.set(entry.name, {
        id: entry.name,
        title: manifest.title,
        description: manifest.description,
        handle,
        start: typeof start === 'function' ? start : undefined,
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
    if (!['ok', 'warning', 'stale'].includes(data?.state) || !Array.isArray(data.items))
      throw new Error('Invalid summary');
    return {
      state: data.state,
      items: data.items.slice(0, 3).map((item) => ({
        label: String(item.label ?? '').slice(0, 24),
        value: String(item.value ?? '—').slice(0, 24)
      }))
    };
  } catch {
    return {state: 'stale', items: []};
  } finally {
    clearTimeout(timer);
  }
}
