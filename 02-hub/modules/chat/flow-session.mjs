import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fail} from './store.mjs';
export async function readJSON(response, limit = 2 * 1024 * 1024) {
  if (!response.body) fail('FlowMusic вернул пустой ответ.', 502);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) fail('Ответ сервиса слишком большой.', 502);
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      fail('Неизвестный формат ответа сервиса.', 502);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = file + '.' + randomUUID();
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    fd = fs.openSync(path.dirname(file), 'r');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, {force: true});
  }
}
const secret = (value) => typeof value === 'string' && /^[\x21-\x7e]{8,16384}$/.test(value);
export class FlowSession {
  constructor(directory, {fetcher = fetch, now = Date.now} = {}) {
    this.file = path.join(directory, 'flowmusic.json');
    this.fetcher = fetcher;
    this.now = now;
    this.revision = 0;
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.data = {};
    }
    if (this.data.refreshing) this.data.needsLogin = true;
  }
  publicConfig() {
    return {
      configured: Boolean(this.data.refresh_token && this.data.anon_key),
      needsLogin: Boolean(this.data.needsLogin)
    };
  }
  start() {
    this.active = true;
    this.schedule();
  }
  close() {
    this.active = false;
    clearTimeout(this.timer);
  }
  schedule() {
    clearTimeout(this.timer);
    if (!this.active || !this.publicConfig().configured || this.data.needsLogin) return;
    const delay = Math.max(
      1000,
      Math.min(2147483647, (this.data.expires_at || 0) * 1000 - this.now() - 120000)
    );
    this.timer = setTimeout(() => {
      void this.refresh().catch(() => {});
    }, delay);
    this.timer.unref();
  }
  save(data) {
    if (data.remove === true) {
      atomic(this.file, {});
      this.data = {};
      this.revision++;
      this.schedule();
      return this.publicConfig();
    }
    if (!secret(data.refreshToken) || !secret(data.anonKey))
      fail('Нужны новый refresh token и Supabase anon key.');
    const next = {
      refresh_token: data.refreshToken,
      anon_key: data.anonKey,
      access_token: '',
      expires_at: 0
    };
    atomic(this.file, next);
    this.data = next;
    this.revision++;
    this.schedule();
    return this.publicConfig();
  }
  async refresh(staleToken) {
    if (this.pending) return this.pending;
    if (!this.publicConfig().configured) fail('Сессия FlowMusic не задана.', 409);
    if (this.data.needsLogin) fail('FlowMusic: войди заново и замени сессию в настройках.', 409);
    if (staleToken && staleToken !== this.data.access_token && this.data.access_token)
      return this.data.access_token;
    const revision = this.revision,
      saved = this.data;
    let rotated;
    this.pending = (async () => {
      try {
        atomic(this.file, {...saved, refreshing: true});
        const response = await this.fetcher(
          'https://sb.flowmusic.app/auth/v1/token?grant_type=refresh_token',
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(20000),
            headers: {apikey: saved.anon_key, 'Content-Type': 'application/json'},
            body: JSON.stringify({refresh_token: saved.refresh_token})
          }
        );
        if (!response.ok) {
          await response.body?.cancel();
          fail('FlowMusic не обновил сессию. Требуется новый вход.', 502);
        }
        const value = await readJSON(response, 128 * 1024);
        const expires =
          Number(value.expires_at) || Math.floor(this.now() / 1000) + Number(value.expires_in);
        if (
          !secret(value.access_token) ||
          !secret(value.refresh_token) ||
          !Number.isSafeInteger(expires) ||
          expires * 1000 <= this.now() + 120000
        )
          fail('FlowMusic вернул неполную сессию. Требуется новый вход.', 502);
        if (this.revision !== revision) fail('Сессия изменена. Повтори запрос.', 409);
        const next = {
          anon_key: saved.anon_key,
          access_token: value.access_token,
          refresh_token: value.refresh_token,
          expires_at: expires
        };
        rotated = next;
        atomic(this.file, next);
        this.data = next;
        this.schedule();
        return next.access_token;
      } catch (error) {
        if (this.revision === revision) {
          this.data = {...(rotated ?? saved), needsLogin: true};
          clearTimeout(this.timer);
          try {
            atomic(this.file, this.data);
          } catch {}
        }
        if (error.status) throw error;
        fail('Не удалось обновить сессию FlowMusic. Введи новую сессию в настройках.', 502);
      }
    })();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
  async token() {
    if (this.data.needsLogin) fail('FlowMusic: нужна новая сессия в настройках.', 409);
    if (!this.data.access_token || this.data.expires_at * 1000 - this.now() < 120000)
      return this.refresh();
    return this.data.access_token;
  }
  async request(route, {signal, body, method = body === undefined ? 'GET' : 'POST'} = {}) {
    let token = await this.token();
    const send = () =>
      this.fetcher('https://www.flowmusic.app/__api' + route, {
        method,
        signal,
        redirect: 'error',
        headers: {
          Authorization: 'Bearer ' + token,
          ...(body === undefined ? {} : {'Content-Type': 'application/json'})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel();
      token = await this.refresh(token);
      response = await send();
    }
    if (!response.ok) {
      await response.body?.cancel();
      const errors = {
        401: 'Сессия FlowMusic отклонена. Войди заново.',
        402: 'Недостаточно средств FlowMusic.',
        403: 'FlowMusic запретил действие для этой сессии.',
        429: 'Лимит FlowMusic. Повтори позже.'
      };
      throw Object.assign(
        new Error(errors[response.status] ?? 'FlowMusic не выполнил запрос. Попробуй позже.'),
        {status: 502, providerStatus: response.status}
      );
    }
    return response;
  }
}
