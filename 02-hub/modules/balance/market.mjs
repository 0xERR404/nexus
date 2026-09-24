import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
const fiat = ['USD', 'EUR', 'KZT', 'CNY'];
const coins = {BTC: 'bitcoin', ETH: 'ethereum', XMR: 'monero', TON: 'the-open-network'};
const valid = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = file + '.' + randomUUID();
  try {
    fs.writeFileSync(temp, JSON.stringify(value), {mode: 0o600, flag: 'wx'});
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, {force: true});
  }
}
export async function readRemote(url, fetcher, headers = {}) {
  const response = await fetcher(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(6000)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('upstream');
  }
  if (!response.body) throw new Error('empty');
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 262144) throw new Error('size');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function parseFiat(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('xml');
  const date = xml.match(/<ValCurs\b[^>]*\bDate="(\d{2}\.\d{2}\.\d{4})"/)?.[1];
  const prices = {};
  for (const match of xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g)) {
    const code = match[1].match(/<CharCode>([A-Z]{3})<\/CharCode>/)?.[1];
    if (!fiat.includes(code)) continue;
    const nominal = Number(match[1].match(/<Nominal>(\d+)<\/Nominal>/)?.[1]);
    const value = Number(match[1].match(/<Value>([\d,.]+)<\/Value>/)?.[1].replace(',', '.'));
    if (!valid(nominal) || !valid(value)) throw new Error('rate');
    prices[code] = value / nominal;
  }
  if (!date || fiat.some((code) => !valid(prices[code]))) throw new Error('rates');
  return {prices, date};
}
export function parseCrypto(data, now) {
  const prices = {},
    timestamps = [];
  for (const [code, id] of Object.entries(coins)) {
    const value = data[id];
    if (
      !valid(value?.usd) ||
      !valid(value?.last_updated_at) ||
      value.last_updated_at * 1000 > now + 300000
    )
      throw new Error('rate');
    prices[code] = value.usd;
    timestamps.push(value.last_updated_at * 1000);
  }
  return {prices, sourceAt: Math.min(...timestamps)};
}
export class Market {
  constructor(directory, {fetcher = fetch, now = Date.now} = {}) {
    this.directory = directory;
    this.fetcher = fetcher;
    this.now = now;
    this.configFile = path.join(directory, 'market.json');
    this.cacheFile = path.join(directory, 'rates.json');
    try {
      this.cache = read(this.cacheFile, {});
    } catch {
      this.cache = {};
    }
    if (!this.cache || typeof this.cache !== 'object' || Array.isArray(this.cache)) this.cache = {};
    this.pending = new Map();
    this.next = {};
  }
  config() {
    return read(this.configFile, {});
  }
  publicConfig() {
    return {configured: Boolean(this.config().key)};
  }
  saveConfig(data) {
    if (typeof data.key !== 'string' || (data.key && !/^[A-Za-z0-9_-]{8,160}$/.test(data.key)))
      throw Object.assign(new Error('Некорректный ключ CoinGecko.'), {status: 400});
    const old = this.config();
    write(this.configFile, {key: data.removeKey === true ? '' : data.key || old.key || ''});
    this.next.crypto = 0;
    return this.publicConfig();
  }
  async update(kind) {
    if (this.pending.has(kind)) return this.pending.get(kind);
    if (this.now() < (this.next[kind] ?? 0)) return;
    const task = (async () => {
      try {
        const data =
          kind === 'fiat'
            ? parseFiat(await readRemote('https://www.cbr.ru/scripts/XML_daily.asp', this.fetcher))
            : parseCrypto(
                JSON.parse(
                  await readRemote(
                    'https://api.coingecko.com/api/v3/simple/price?ids=' +
                      Object.values(coins).join(',') +
                      '&vs_currencies=usd&include_last_updated_at=true',
                    this.fetcher,
                    this.config().key ? {'x-cg-demo-api-key': this.config().key} : {}
                  )
                ),
                this.now()
              );
        this.cache[kind] = {...data, fetchedAt: this.now(), failed: false};
        this.next[kind] = this.now() + (kind === 'fiat' ? 3600000 : 300000);
        write(this.cacheFile, this.cache);
      } catch {
        this.cache[kind] = {...this.cache[kind], failed: true};
        this.next[kind] = this.now() + 60000;
      }
    })().finally(() => this.pending.delete(kind));
    this.pending.set(kind, task);
    return task;
  }
  async rates() {
    await Promise.all([this.update('fiat'), this.update('crypto')]);
    return Object.fromEntries(
      ['fiat', 'crypto'].map((kind) => {
        const item = this.cache[kind] ?? {};
        const codes = kind === 'fiat' ? fiat : Object.keys(coins);
        const prices = Object.fromEntries(
          codes
            .filter((code) => valid(item.prices?.[code]))
            .map((code) => [code, item.prices[code]])
        );
        return [
          kind,
          {
            prices,
            date: item.date ?? null,
            sourceAt: item.sourceAt ?? null,
            fetchedAt: item.fetchedAt ?? null,
            stale: Boolean(
              item.failed ||
                !item.fetchedAt ||
                this.now() - (kind === 'crypto' ? item.sourceAt || 0 : item.fetchedAt) >
                  (kind === 'fiat' ? 6 * 3600000 : 900000)
            )
          }
        ];
      })
    );
  }
  async credit(chatDirectory) {
    let key;
    try {
      key = read(path.join(chatDirectory, 'deepseek.json'), {}).key;
    } catch {
      return {state: 'error'};
    }
    if (!key) {
      this.creditCache = undefined;
      return {state: 'unconfigured'};
    }
    const fingerprint = createHash('sha256').update(key).digest('hex');
    if (this.creditCache?.fingerprint !== fingerprint) this.creditCache = {fingerprint, next: 0};
    const cache = this.creditCache;
    if (!cache.pending && this.now() < cache.next) return cache.value;
    cache.pending ??= (async () => {
      try {
        const data = JSON.parse(
          await readRemote('https://api.deepseek.com/user/balance', this.fetcher, {
            Authorization: 'Bearer ' + key
          })
        );
        if (!Array.isArray(data.balance_infos) || !data.balance_infos.length)
          throw new Error('balance');
        const balances = data.balance_infos.map((item) => {
          if (
            !['USD', 'CNY'].includes(item.currency) ||
            typeof item.total_balance !== 'string' ||
            !/^-?\d{1,12}(\.\d{1,12})?$/.test(item.total_balance)
          )
            throw new Error('balance');
          return {currency: item.currency, amount: item.total_balance};
        });
        cache.value = {state: 'ok', balances, updatedAt: this.now()};
        cache.next = this.now() + 60000;
      } catch {
        cache.value = {...cache.value, state: 'error'};
        cache.next = this.now() + 60000;
      } finally {
        cache.pending = undefined;
      }
      return cache.value;
    })();
    const value = await cache.pending;
    try {
      const current = read(path.join(chatDirectory, 'deepseek.json'), {}).key;
      if (current !== key) return {state: current ? 'error' : 'unconfigured'};
    } catch {
      return {state: 'error'};
    }
    return value;
  }
}
