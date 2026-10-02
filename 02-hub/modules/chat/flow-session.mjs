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
    this.creditFile = path.join(directory, 'flowmusic-credits.json');
    this.fetcher = fetcher;
    this.now = now;
    this.revision = 0;
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.data = {};
    }
    // Retry interrupted and legacy failures once; confirmed revocations stay blocked.
    if (this.data.refreshing || (this.data.needsLogin && !this.data.failureKind)) {
      delete this.data.needsLogin;
      delete this.data.refreshing;
    }
  }
  publicConfig() {
    return {
      configured: Boolean(this.data.refresh_token && this.data.anon_key),
      needsLogin: Boolean(this.data.needsLogin),
      error: this.data.error ?? null,
      lastRefresh: this.data.lastRefresh ?? null,
      nextRetry: this.data.nextRetry ?? null
    };
  }
  start() {
    this.active = true;
    this.closed = false;
    this.schedule();
    const check = () => {
      if (this.publicConfig().configured) void this.credits().catch(() => {});
    };
    this.creditTimer = setInterval(check, 300000);
    this.creditTimer.unref();
  }
  close() {
    this.active = false;
    this.closed = true;
    this.revision++;
    clearTimeout(this.timer);
    clearInterval(this.creditTimer);
  }
  schedule() {
    clearTimeout(this.timer);
    if (!this.active || !this.publicConfig().configured || this.data.needsLogin) return;
    const delay = Math.max(
      1000,
      Math.min(
        2147483647,
        Math.max((this.data.expires_at || 0) * 1000 - 120000, this.data.nextRetry || 0) - this.now()
      )
    );
    this.timer = setTimeout(() => {
      void this.refresh().catch(() => {});
    }, delay);
    this.timer.unref();
  }
  creditSnapshot() {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.creditFile, 'utf8'));
    } catch {}
    return {
      ...saved,
      remaining: saved.remaining ?? null,
      updatedAt: saved.updatedAt ?? null,
      history: saved.history ?? [],
      stale: !saved.updatedAt || this.now() - saved.updatedAt > 300000 || Boolean(saved.error)
    };
  }
  async credits(force = false) {
    if (this.closed || !this.publicConfig().configured)
      return {
        remaining: null,
        updatedAt: null,
        history: [],
        stale: true,
        error: 'FlowMusic не подключён.'
      };
    if (this.creditJob) return this.creditJob;
    const saved = this.creditSnapshot(),
      revision = this.revision;
    if (
      saved.nextAttempt > this.now() ||
      (!force && saved.updatedAt && this.now() - saved.updatedAt < 300000)
    )
      return saved;
    this.creditJob = (async () => {
      let next;
      try {
        const response = await this.request('/billing/credits', {
          signal: AbortSignal.timeout(20000)
        });
        const payload = await readJSON(response, 128 * 1024),
          value = payload?.data?.credits_remaining ?? payload?.credits_remaining;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
          fail('FlowMusic изменил формат кредитов.', 502);
        const updatedAt = this.now(),
          history = [...saved.history];
        if (saved.remaining !== value)
          history.push({
            time: updatedAt,
            remaining: value,
            change:
              saved.remaining == null ? null : Math.round((value - saved.remaining) * 100) / 100
          });
        next = {
          remaining: value,
          updatedAt,
          history: history.slice(-90),
          nextAttempt: updatedAt + 10000,
          error: null
        };
      } catch (error) {
        next = {
          ...saved,
          nextAttempt: this.now() + 30000,
          error: error.status
            ? error.message
            : 'Не удалось проверить кредиты. Предыдущий остаток сохранён.'
        };
      }
      if (revision !== this.revision) return this.creditSnapshot();
      atomic(this.creditFile, next);
      return this.creditSnapshot();
    })();
    try {
      return await this.creditJob;
    } finally {
      this.creditJob = null;
    }
  }
  save(data) {
    if (data.remove === true) {
      atomic(this.file, {});
      this.data = {};
      this.revision++;
      fs.rmSync(this.creditFile, {force: true});
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
    fs.rmSync(this.creditFile, {force: true});
    this.schedule();
    return this.publicConfig();
  }
  async refresh(staleToken) {
    if (this.pending) return this.pending;
    if (!this.publicConfig().configured) fail('Сессия FlowMusic не задана.', 409);
    if (this.data.needsLogin) fail('FlowMusic: войди заново и замени сессию в настройках.', 409);
    if (staleToken && staleToken !== this.data.access_token && this.data.access_token)
      return this.data.access_token;
    if (this.data.nextRetry > this.now())
      fail('FlowMusic временно недоступен. Повторим автоматически.', 503);
    const revision = this.revision,
      saved = this.data;
    let rotated,
      permanent = false,
      retryAfter = 0;
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
          permanent = [400, 401, 403].includes(response.status);
          const retry = response.headers.get('retry-after');
          retryAfter = /^\d+$/.test(retry ?? '')
            ? Number(retry) * 1000
            : Math.max(0, Date.parse(retry) - this.now()) || 0;
          await response.body?.cancel();
          fail(
            permanent
              ? 'FlowMusic отклонил сессию или anon key. Проверь настройки и выполни новый вход.'
              : 'FlowMusic временно недоступен. Повторим автоматически.',
            permanent ? 409 : 503
          );
        }
        const value = await readJSON(response, 128 * 1024);
        const expires =
          Number(value.expires_at) || Math.floor(this.now() / 1000) + Number(value.expires_in);
        if (
          !secret(value.access_token) ||
          !secret(value.refresh_token) ||
          !Number.isSafeInteger(expires) ||
          expires * 1000 <= this.now() + 120000
        ) {
          permanent = true;
          fail('FlowMusic вернул неполную сессию. Требуется новый вход.', 502);
        }
        if (this.revision !== revision) fail('Сессия изменена. Повтори запрос.', 409);
        const next = {
          anon_key: saved.anon_key,
          access_token: value.access_token,
          refresh_token: value.refresh_token,
          expires_at: expires,
          lastRefresh: this.now()
        };
        rotated = next;
        atomic(this.file, next);
        this.data = next;
        this.schedule();
        return next.access_token;
      } catch (error) {
        if (this.revision === revision) {
          this.data = {
            ...(rotated ?? saved),
            refreshing: false,
            needsLogin: permanent,
            failureKind: permanent ? 'rejected' : 'temporary',
            failures: (saved.failures || 0) + 1,
            error: permanent
              ? 'Сессия отклонена. Нужен новый вход и проверка anon key.'
              : 'Временный сбой связи. Повторим автоматически.',
            nextRetry: permanent
              ? 0
              : this.now() +
                Math.min(
                  2147483647,
                  Math.max(
                    retryAfter,
                    Math.min(300000, 30000 * 2 ** Math.min(saved.failures || 0, 4))
                  )
                )
          };
          try {
            atomic(this.file, this.data);
          } catch {}
          this.schedule();
        }
        if (error.status) throw error;
        fail('FlowMusic: временный сбой обновления сессии. Повторим автоматически.', 503);
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
      try {
        return await this.refresh();
      } catch (error) {
        if (
          !this.data.needsLogin &&
          this.data.access_token &&
          this.data.expires_at * 1000 > this.now() + 5000
        )
          return this.data.access_token;
        throw error;
      }
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
