import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

export const currencies = ['RUB', 'USD', 'EUR'];
const maximum = 999999999999;
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), {status});
};
const text = (value, max, required = true) => {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value))
    fail('Некорректный текст');
  const result = value.trim();
  if (required && !result) fail('Заполни название');
  return result;
};
export function money(value, signed = false) {
  if (typeof value !== 'string' || !/^-?\d{1,10}(?:[.,]\d{1,2})?$/.test(value.trim()))
    fail('Сумма: число, не более двух знаков после запятой');
  const raw = value.trim().replace(',', '.'),
    [whole, fraction = ''] = raw.replace('-', '').split('.');
  const cents =
    (Number(whole) * 100 + Number(fraction.padEnd(2, '0'))) * (raw.startsWith('-') ? -1 : 1);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > maximum || (!signed && cents <= 0))
    fail('Сумма вне допустимого диапазона');
  return cents;
}
const dateValue = (value) => {
  if (typeof value !== 'string' || !/^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(value))
    fail('Некорректная дата');
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    fail('Некорректная дата');
  return value;
};
const balanceSQL = `SELECT a.*, a.opening + COALESCE((SELECT SUM(CASE WHEN t.kind='income' THEN t.amount ELSE -t.amount END) FROM transactions t WHERE t.account=a.id),0) + COALESCE((SELECT SUM(t.received) FROM transactions t WHERE t.target=a.id),0) AS balance, EXISTS(SELECT 1 FROM transactions t WHERE t.account=a.id OR t.target=a.id) AS used FROM accounts a`;

export class Ledger {
  constructor(file) {
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
      fs.closeSync(fs.openSync(file, 'a', 0o600));
      fs.chmodSync(file, 0o600);
    }
    this.db = new DatabaseSync(file, {timeout: 3000});
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.atomic(() => {
        const version = this.db.prepare('PRAGMA user_version').get().user_version;
        if (version > 1) throw new Error('Нужна более новая версия модуля «Баланс»');
        if (version === 1) return;
        this.db.exec(`
          CREATE TABLE accounts(id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('RUB','USD','EUR')), kind TEXT NOT NULL CHECK(kind IN ('card','cash','savings')), opening INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1) STRICT;
          CREATE TABLE categories(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('income','expense')), archived INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1) STRICT;
          CREATE TABLE transactions(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('income','expense','transfer')), date TEXT NOT NULL, account TEXT NOT NULL REFERENCES accounts(id), target TEXT REFERENCES accounts(id), amount INTEGER NOT NULL CHECK(amount>0), received INTEGER, category TEXT REFERENCES categories(id), note TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, CHECK((kind='transfer' AND target IS NOT NULL AND target<>account AND received IS NOT NULL AND received>0 AND category IS NULL) OR (kind<>'transfer' AND target IS NULL AND received IS NULL AND category IS NOT NULL))) STRICT;
          CREATE INDEX transaction_date ON transactions(date DESC,created DESC,id);
          CREATE INDEX transaction_account ON transactions(account);
          CREATE INDEX transaction_target ON transactions(target);
          CREATE TABLE requests(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL) STRICT;
          CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
          INSERT INTO state VALUES(1,0);
          PRAGMA user_version=1;
        `);
        for (const [name, kind] of [
          ['Карта', 'card'],
          ['Накопления', 'savings']
        ])
          this.db
            .prepare('INSERT INTO accounts(id,name,currency,kind,opening) VALUES(?,?,?,?,0)')
            .run(randomUUID(), name, 'RUB', kind);
        for (const [kind, names] of [
          ['income', ['Зарплата', 'Проценты', 'Другое']],
          ['expense', ['Продукты', 'Дом', 'Транспорт', 'Здоровье', 'Досуг', 'Другое']]
        ])
          for (const name of names)
            this.db
              .prepare('INSERT INTO categories(id,name,kind) VALUES(?,?,?)')
              .run(randomUUID(), name, kind);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  atomic(fn, write = true) {
    this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  record(table, id) {
    const row =
      typeof id === 'string' && this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!row) fail('Запись не найдена', 404);
    return row;
  }
  current(row, version) {
    if (!Number.isSafeInteger(version) || version !== row.version)
      fail('Запись изменена в другой вкладке. Обнови страницу и повтори.', 409);
  }
  accounts() {
    return this.db.prepare(balanceSQL + ' ORDER BY a.archived,a.rowid').all();
  }
  filter(params) {
    const month = params.get('month') ?? new Date().toISOString().slice(0, 7);
    if (!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(month)) fail('Некорректный месяц');
    const [year, number] = month.split('-').map(Number);
    const next = `${number === 12 ? year + 1 : year}-${String(number === 12 ? 1 : number + 1).padStart(2, '0')}-01`;
    const args = [month + '-01', next],
      clauses = ['t.date>=? AND t.date<?'];
    const account = params.get('account'),
      kind = params.get('kind');
    if (account) {
      this.record('accounts', account);
      clauses.push('(t.account=? OR t.target=?)');
      args.push(account, account);
    }
    if (kind) {
      if (!['income', 'expense', 'transfer'].includes(kind)) fail('Неизвестный тип операции');
      clauses.push('t.kind=?');
      args.push(kind);
    }
    return {month, next, args, where: clauses.join(' AND ')};
  }
  totals(accounts = this.accounts()) {
    return currencies
      .map((currency) => ({
        currency,
        amount: accounts
          .filter((a) => a.currency === currency)
          .reduce((sum, a) => sum + a.balance, 0)
      }))
      .filter((t) => accounts.some((a) => a.currency === t.currency));
  }
  snapshot(params = new URLSearchParams()) {
    return this.atomic(() => this.readSnapshot(params), false);
  }
  readSnapshot(params) {
    const f = this.filter(params),
      rawOffset = params.get('offset') ?? '0';
    if (!/^\d{1,9}$/.test(rawOffset)) fail('Некорректная страница');
    const offset = Number(rawOffset),
      accounts = this.accounts();
    const totals = this.totals(accounts);
    const period = this.db
      .prepare(
        `SELECT a.currency,t.kind,SUM(t.amount) AS amount FROM transactions t JOIN accounts a ON a.id=t.account WHERE t.date>=? AND t.date<? AND t.kind<>'transfer' GROUP BY a.currency,t.kind`
      )
      .all(f.month + '-01', f.next);
    const rows = this.db
      .prepare(
        `SELECT t.* FROM transactions t WHERE ${f.where} ORDER BY t.date DESC,t.created DESC,t.rowid DESC LIMIT 30 OFFSET ?`
      )
      .all(...f.args, offset);
    return {
      revision: this.db.prepare('SELECT revision FROM state').get().revision,
      accounts,
      categories: this.db.prepare('SELECT * FROM categories ORDER BY archived,kind,name').all(),
      totals,
      period,
      month: f.month,
      transactions: rows,
      total: this.db
        .prepare(`SELECT COUNT(*) AS total FROM transactions t WHERE ${f.where}`)
        .get(...f.args).total,
      offset,
      limit: 30
    };
  }
  mutate({requestId, action, data}) {
    if (
      typeof requestId !== 'string' ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(requestId) ||
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data)
    )
      fail('Некорректный запрос');
    const fingerprint = createHash('sha256').update(JSON.stringify({action, data})).digest('hex');
    return this.atomic(() => {
      const previous = this.db.prepare('SELECT * FROM requests WHERE id=?').get(requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          fail('Этот запрос уже использован. Обнови страницу.', 409);
        return JSON.parse(previous.result);
      }
      let id;
      if (action === 'transaction.save') id = this.saveTransaction(data);
      else if (action === 'transaction.delete') {
        const row = this.record('transactions', data.id);
        this.current(row, data.version);
        for (const account of [row.account, row.target].filter(Boolean))
          if (this.record('accounts', account).archived) fail('Сначала восстанови архивный счёт');
        this.db.prepare('DELETE FROM transactions WHERE id=?').run(row.id);
        id = row.id;
      } else if (action === 'account.save') id = this.saveAccount(data);
      else if (action === 'category.save') id = this.saveCategory(data);
      else if (action === 'account.archive' || action === 'category.archive') {
        const table = action.startsWith('account') ? 'accounts' : 'categories',
          row = this.record(table, data.id);
        this.current(row, data.version);
        if (typeof data.archived !== 'boolean') fail('Некорректное состояние');
        if (
          table === 'accounts' &&
          data.archived &&
          this.accounts().find((a) => a.id === row.id).balance !== 0
        )
          fail('Перед архивированием переведи остаток со счёта');
        this.db
          .prepare(`UPDATE ${table} SET archived=?,version=version+1 WHERE id=?`)
          .run(Number(data.archived), row.id);
        id = row.id;
      } else fail('Неизвестное действие');
      if (
        this.accounts().some(
          (a) => !Number.isSafeInteger(a.balance) || Math.abs(a.balance) > maximum
        )
      )
        fail('Остаток счёта превышает допустимый диапазон');
      this.db.prepare('UPDATE state SET revision=revision+1').run();
      const result = {id, revision: this.db.prepare('SELECT revision FROM state').get().revision};
      this.db
        .prepare('INSERT INTO requests VALUES(?,?,?)')
        .run(requestId, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  saveAccount(data) {
    const old = data.id ? this.record('accounts', data.id) : null;
    if (old) this.current(old, data.version);
    if (!currencies.includes(data.currency) || !['card', 'cash', 'savings'].includes(data.kind))
      fail('Проверь валюту и тип счёта');
    const name = text(data.name, 60),
      opening = money(data.opening, true),
      id = old?.id ?? randomUUID();
    if (
      old &&
      this.accounts().find((a) => a.id === old.id).used &&
      (old.currency !== data.currency || old.opening !== opening)
    )
      fail('Валюта и начальный остаток счёта с операциями не изменяются');
    if (old)
      this.db
        .prepare(
          'UPDATE accounts SET name=?,currency=?,kind=?,opening=?,version=version+1 WHERE id=?'
        )
        .run(name, data.currency, data.kind, opening, id);
    else {
      if (this.db.prepare('SELECT COUNT(*) n FROM accounts').get().n >= 100)
        fail('Не более 100 счетов');
      this.db
        .prepare('INSERT INTO accounts(id,name,currency,kind,opening) VALUES(?,?,?,?,?)')
        .run(id, name, data.currency, data.kind, opening);
    }
    return id;
  }
  saveCategory(data) {
    const old = data.id ? this.record('categories', data.id) : null;
    if (old) this.current(old, data.version);
    if (!['income', 'expense'].includes(data.kind)) fail('Некорректный тип категории');
    if (old && old.kind !== data.kind) fail('Тип существующей категории не изменяется');
    const name = text(data.name, 50),
      id = old?.id ?? randomUUID();
    if (old)
      this.db.prepare('UPDATE categories SET name=?,version=version+1 WHERE id=?').run(name, id);
    else {
      if (this.db.prepare('SELECT COUNT(*) n FROM categories').get().n >= 200)
        fail('Не более 200 категорий');
      this.db
        .prepare('INSERT INTO categories(id,name,kind) VALUES(?,?,?)')
        .run(id, name, data.kind);
    }
    return id;
  }
  saveTransaction(data) {
    const old = data.id ? this.record('transactions', data.id) : null;
    if (old) this.current(old, data.version);
    if (!['income', 'expense', 'transfer'].includes(data.kind)) fail('Некорректный тип операции');
    const account = this.record('accounts', data.account),
      target = data.kind === 'transfer' ? this.record('accounts', data.target) : null;
    for (const id of new Set([account.id, target?.id, old?.account, old?.target].filter(Boolean)))
      if (this.record('accounts', id).archived) fail('Сначала восстанови архивный счёт');
    if (target?.id === account.id) fail('Для перевода выбери другой счёт');
    const category = data.kind === 'transfer' ? null : this.record('categories', data.category);
    if (
      category &&
      (category.kind !== data.kind || (category.archived && old?.category !== category.id))
    )
      fail('Выбери подходящую активную категорию');
    const amount = money(data.amount),
      received = target
        ? target.currency === account.currency
          ? amount
          : money(data.received)
        : null;
    const id = old?.id ?? randomUUID(),
      date = dateValue(data.date),
      note = text(data.note ?? '', 300, false);
    const values = [
      data.kind,
      date,
      account.id,
      target?.id ?? null,
      amount,
      received,
      category?.id ?? null,
      note
    ];
    if (old)
      this.db
        .prepare(
          'UPDATE transactions SET kind=?,date=?,account=?,target=?,amount=?,received=?,category=?,note=?,version=version+1 WHERE id=?'
        )
        .run(...values, id);
    else
      this.db
        .prepare(
          'INSERT INTO transactions(kind,date,account,target,amount,received,category,note,id,created) VALUES(?,?,?,?,?,?,?,?,?,?)'
        )
        .run(...values, id, Date.now());
    return id;
  }
}
