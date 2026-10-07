import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {money} from './store.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), {status});
};
const clean = (value, limit) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > limit ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    fail('Некорректное поле уведомления');
  return value.trim();
};
const secret =
  /(?:одноразов|парол|подтвер[дж]|авторизац|вход\w*|verification|password|\botp\b|\bcode\b|код(?:\s|:|\s*—))/iu;
export function expenseProposal(text) {
  const value = text.replace(/[\u00a0\u202f]/g, ' ');
  if (secret.test(value)) return {ignored: true};
  if (
    /(?:возврат|зачислен|поступлен|отмен|отклон|недостаточ|перевод|refund|declined|transfer)/iu.test(
      value
    )
  )
    return {amount: null, currency: null};
  // Only an amount immediately following an expense marker; balances are never candidates.
  const matches = [
    ...value.matchAll(
      /(?:покупка|оплата|списание|списано|purchase|payment)\s*[:—-]?\s*((?:\d{1,3}(?: \d{3})+|\d{1,10})(?:[.,]\d{1,2})?)\s*(₽|руб\.?|RUB|USD|EUR|\$|€)(?=\s|[.,;!]|$)/giu
    )
  ];
  if (matches.length !== 1) return {amount: null, currency: null};
  try {
    const amount = money(matches[0][1].replaceAll(' ', ''));
    const currency = /^(?:₽|руб\.?|RUB)$/iu.test(matches[0][2])
      ? 'RUB'
      : /^(?:USD|\$)$/i.test(matches[0][2])
        ? 'USD'
        : 'EUR';
    return {amount, currency};
  } catch {
    return {amount: null, currency: null};
  }
}
export class BankInbox {
  constructor(ledger, {now = Date.now} = {}) {
    this.ledger = ledger;
    this.db = ledger.db;
    this.now = now;
    ledger.atomic(() =>
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS bank_sources (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, package TEXT NOT NULL,
        account TEXT NOT NULL REFERENCES accounts(id), zone TEXT NOT NULL,
        token_hash TEXT UNIQUE, created INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS bank_events (
        id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES bank_sources(id),
        event_hash TEXT NOT NULL, payload_hash TEXT NOT NULL, text TEXT NOT NULL,
        occurred INTEGER NOT NULL, received INTEGER NOT NULL, date TEXT NOT NULL,
        amount INTEGER, currency TEXT, state TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending','accepted','dismissed')),
        transaction_id TEXT, UNIQUE(source,event_hash), UNIQUE(payload_hash)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS bank_rules (
        id TEXT PRIMARY KEY, merchant TEXT NOT NULL, normalized TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL REFERENCES categories(id), version INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE INDEX IF NOT EXISTS bank_pending ON bank_events(state,received);
    `)
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(bank_events)')
        .all()
        .some((c) => c.name === 'channel')
    )
      this.db.exec("ALTER TABLE bank_events ADD COLUMN channel TEXT NOT NULL DEFAULT 'push'");
    if (
      !this.db
        .prepare('PRAGMA table_info(bank_events)')
        .all()
        .some((c) => c.name === 'kind')
    )
      this.db.exec("ALTER TABLE bank_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'expense'");
    if (
      !this.db
        .prepare('PRAGMA table_info(bank_sources)')
        .all()
        .some((c) => c.name === 'auto_credits')
    )
      this.db.exec('ALTER TABLE bank_sources ADD COLUMN auto_credits INTEGER NOT NULL DEFAULT 0');
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS bank_channel_match ON bank_events(source,amount,currency,occurred)'
    );
  }
  merchantKey(value) {
    return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU');
  }
  rules() {
    return this.db
      .prepare(
        'SELECT r.*,c.name AS category_name,c.archived FROM bank_rules r JOIN categories c ON c.id=r.category ORDER BY r.normalized'
      )
      .all();
  }
  saveRule(data) {
    return this.ledger.atomic(() => {
      const merchant = clean(data.merchant, 160);
      if (/[\r\n\t]/.test(merchant)) fail('Название магазина должно быть одной строкой');
      const normalized = this.merchantKey(merchant),
        category = this.ledger.record('categories', data.category);
      if (category.kind !== 'expense' || category.archived)
        fail('Выбери активную категорию расходов');
      const old = data.id ? this.ledger.record('bank_rules', data.id) : null;
      if (old && data.version !== old.version)
        fail('Правило изменено в другой вкладке. Обнови список и открой его заново.', 409);
      if (
        this.db
          .prepare('SELECT id FROM bank_rules WHERE normalized=? AND id<>?')
          .get(normalized, old?.id ?? '')
      )
        fail('Для этого магазина правило уже есть', 409);
      if (!old && this.db.prepare('SELECT COUNT(*) n FROM bank_rules').get().n >= 500)
        fail('Не более 500 правил');
      const id = old?.id ?? randomUUID();
      if (old)
        this.db
          .prepare(
            'UPDATE bank_rules SET merchant=?,normalized=?,category=?,version=version+1 WHERE id=?'
          )
          .run(merchant, normalized, category.id, id);
      else
        this.db
          .prepare('INSERT INTO bank_rules(id,merchant,normalized,category) VALUES(?,?,?,?)')
          .run(id, merchant, normalized, category.id);
      return {id};
    });
  }
  deleteRule(data) {
    return this.ledger.atomic(() => {
      const rule = this.ledger.record('bank_rules', data.id);
      if (data.version !== rule.version)
        fail('Правило изменено в другой вкладке. Обнови список.', 409);
      this.db.prepare('DELETE FROM bank_rules WHERE id=?').run(rule.id);
      return {ok: true};
    });
  }
  sources() {
    return this.db
      .prepare(
        'SELECT id,name,package,account,zone,created,last_seen,auto_credits,token_hash IS NOT NULL AS enabled FROM bank_sources ORDER BY created DESC'
      )
      .all();
  }
  create(data) {
    const name = clean(data.name, 60),
      packageName = clean(data.package, 160),
      zone = clean(data.zone, 80);
    if (!/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+$/.test(packageName))
      fail('Укажи идентификатор банковского приложения, например com.example.bank');
    try {
      new Intl.DateTimeFormat('en', {timeZone: zone});
    } catch {
      fail('Некорректный часовой пояс');
    }
    const account = this.ledger.record('accounts', data.account);
    if (account.archived) fail('Выбери активный счёт');
    if (this.sources().filter((s) => s.enabled).length >= 10 || this.sources().length >= 100)
      fail('Достигнут лимит источников');
    const token = randomBytes(32).toString('base64url'),
      id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO bank_sources(id,name,package,account,zone,token_hash,created) VALUES(?,?,?,?,?,?,?)'
      )
      .run(id, name, packageName, account.id, zone, hash(token), this.now());
    return {id, token};
  }
  revoke(id) {
    this.ledger.record('bank_sources', id);
    this.db.prepare('UPDATE bank_sources SET token_hash=NULL WHERE id=?').run(id);
    return {ok: true};
  }
  autoCredits(data) {
    if (typeof data.enabled !== 'boolean') fail('Нужно состояние автозаписи');
    this.ledger.record('bank_sources', data.id);
    this.db
      .prepare('UPDATE bank_sources SET auto_credits=? WHERE id=?')
      .run(+data.enabled, data.id);
    return {ok: true};
  }
  authenticate(header) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? '');
    const source =
      match && this.db.prepare('SELECT * FROM bank_sources WHERE token_hash=?').get(hash(match[1]));
    if (!source) fail('Неверный или отозванный ключ источника', 401);
    return source;
  }
  receive(header, data) {
    // Revalidate after the request body has arrived, so revocation also stops in-flight uploads.
    const source = this.authenticate(header);
    const eventId = clean(data.eventId, 200),
      packageName = clean(data.package, 160);
    const channel = data.channel ?? 'push';
    if (!['push', 'sms'].includes(channel) || (channel === 'sms' && !data.operation))
      fail('Некорректный канал уведомления');
    let text,
      proposal,
      merchant = '',
      kind = 'expense';
    if (data.operation !== undefined) {
      const op = data.operation;
      if (
        data.text !== undefined ||
        !op ||
        typeof op !== 'object' ||
        Array.isArray(op) ||
        !['expense', 'income', 'refund'].includes(op.kind) ||
        !Number.isSafeInteger(op.amountMinor) ||
        op.amountMinor <= 0 ||
        op.amountMinor > 999999999999 ||
        !['RUB', 'USD', 'EUR'].includes(op.currency)
      )
        fail('Некорректная операция телефона');
      if (
        op.merchant !== undefined &&
        (typeof op.merchant !== 'string' ||
          op.merchant.length > 160 ||
          /[\x00-\x1f\x7f]/.test(op.merchant))
      )
        fail('Некорректное название магазина');
      kind = op.kind;
      merchant = op.merchant?.trim() ?? '';
      proposal = {amount: op.amountMinor, currency: op.currency};
      text = merchant || 'Операция из приложения · ' + packageName;
    } else {
      text = clean(data.text, 2000);
      proposal = expenseProposal(text);
    }
    if (source.package !== packageName) fail('Это приложение не разрешено для источника', 403);
    const occurred =
      typeof data.occurredAt === 'number'
        ? data.occurredAt
        : typeof data.occurredAt === 'string' &&
            /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(data.occurredAt)
          ? Date.parse(data.occurredAt)
          : NaN;
    const now = this.now();
    if (
      !Number.isSafeInteger(occurred) ||
      occurred < now - 90 * 86400000 ||
      occurred > now + 300000
    )
      fail(
        'Нужно время уведомления: Unix-миллисекунды или ISO 8601 с часовым поясом, не старше 90 дней'
      );
    if (proposal.ignored) return {state: 'ignored', reason: 'security_message'};
    const eventHash = hash(eventId),
      payloadHash = hash(
        JSON.stringify([
          packageName,
          occurred,
          data.operation
            ? kind === 'expense'
              ? [proposal.amount, proposal.currency]
              : [kind, proposal.amount, proposal.currency]
            : text
        ])
      );
    return this.ledger.atomic(() => {
      const previous = this.db
        .prepare(
          'SELECT id,state,event_hash,payload_hash FROM bank_events WHERE (source=? AND event_hash=?) OR payload_hash=?'
        )
        .get(source.id, eventHash, payloadHash);
      if (previous) {
        if (previous.payload_hash !== payloadHash)
          fail('eventId уже использован для другого уведомления', 409);
        return {id: previous.id, state: previous.state, duplicate: true};
      }
      const count = this.db
        .prepare(
          "SELECT COUNT(*) AS total,SUM(state='pending') AS pending,SUM(source=? AND received>?) AS recent FROM bank_events"
        )
        .get(source.id, now - 3600000);
      if (count.total >= 100000 || count.pending >= 1000)
        fail('Входящие заполнены. Проверь уведомления в Плутосе.', 507);
      if (count.recent >= 120) fail('Не более 120 новых уведомлений источника в час', 429);
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: source.zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(occurred);
      const part = (type) => parts.find((p) => p.type === type).value;
      const date = `${part('year')}-${part('month')}-${part('day')}`,
        id = randomUUID();
      this.db
        .prepare(
          'INSERT INTO bank_events(id,source,event_hash,payload_hash,text,occurred,received,date,amount,currency,channel,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          id,
          source.id,
          eventHash,
          payloadHash,
          text,
          occurred,
          now,
          date,
          proposal.amount,
          proposal.currency,
          channel,
          kind
        );
      this.db.prepare('UPDATE bank_sources SET last_seen=? WHERE id=?').run(now, source.id);
      const otherChannel =
        data.operation &&
        this.db
          .prepare(
            "SELECT id FROM bank_events WHERE source=? AND amount=? AND currency=? AND channel<>? AND kind=? AND occurred BETWEEN ? AND ? AND state<>'dismissed' LIMIT 1"
          )
          .get(
            source.id,
            proposal.amount,
            proposal.currency,
            channel,
            kind,
            occurred - 600000,
            occurred + 600000
          );
      if (otherChannel)
        this.db
          .prepare('UPDATE bank_events SET text=? WHERE id=?')
          .run('Возможный повтор SMS/пуша: сверь историю перед подтверждением. ' + text, id);
      const result =
        data.operation && !otherChannel && (kind === 'expense' || source.auto_credits)
          ? this.autoRecord(id, source, proposal, date, merchant, kind)
          : {state: 'pending'};
      return {id, ...result, duplicate: false};
    });
  }
  autoRecord(id, source, proposal, date, merchant, kind = 'expense') {
    const account = this.ledger.record('accounts', source.account);
    if (account.archived || account.currency !== proposal.currency) return {state: 'pending'};
    this.db.exec('SAVEPOINT bank_auto');
    try {
      const ledgerKind = kind === 'expense' ? 'expense' : 'income';
      let category =
        kind === 'expense' &&
        merchant &&
        this.db
          .prepare(
            "SELECT r.category FROM bank_rules r JOIN categories c ON c.id=r.category WHERE r.normalized=? AND c.archived=0 AND c.kind='expense'"
          )
          .get(this.merchantKey(merchant))?.category;
      const categoryName =
        kind === 'refund' ? 'Возвраты покупок' : kind === 'income' ? 'Поступления банка' : 'Другое';
      category ||= this.db
        .prepare(
          'SELECT id FROM categories WHERE kind=? AND archived=0 AND name=? ORDER BY id LIMIT 1'
        )
        .get(ledgerKind, categoryName)?.id;
      if (!category) category = this.ledger.saveCategory({kind: ledgerKind, name: categoryName});
      const amount = `${Math.floor(proposal.amount / 100)}.${String(proposal.amount % 100).padStart(2, '0')}`;
      const transactionId = this.ledger.saveTransaction({
        kind: ledgerKind,
        account: account.id,
        category,
        date,
        amount,
        note:
          (kind === 'refund' ? 'Возврат покупки · ' : kind === 'income' ? 'Поступление · ' : '') +
          (merchant || (kind === 'expense' ? 'Покупка · ' : '') + source.name)
      });
      if (
        this.ledger
          .accounts()
          .some((a) => !Number.isSafeInteger(a.balance) || Math.abs(a.balance) > 999999999999)
      )
        fail('Остаток счёта превышает допустимый диапазон');
      this.db
        .prepare("UPDATE bank_events SET state='accepted',transaction_id=?,text='' WHERE id=?")
        .run(transactionId, id);
      this.db.prepare('UPDATE state SET revision=revision+1').run();
      this.db.exec('RELEASE bank_auto');
      return {state: 'accepted', transactionId};
    } catch (error) {
      this.db.exec('ROLLBACK TO bank_auto; RELEASE bank_auto');
      if (error.status === 400) return {state: 'pending'};
      throw error;
    }
  }
  list(offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
      fail('Некорректная страница');
    const items = this.db
      .prepare(
        "SELECT e.id,e.kind,e.text,e.occurred,e.date,e.amount,e.currency,s.name AS source_name,s.account FROM bank_events e JOIN bank_sources s ON s.id=e.source WHERE e.state='pending' ORDER BY e.received,e.id LIMIT 30 OFFSET ?"
      )
      .all(offset);
    return {
      items,
      total: this.db.prepare("SELECT COUNT(*) AS n FROM bank_events WHERE state='pending'").get().n
    };
  }
  resolve(data) {
    return this.ledger.atomic(() => {
      const row = this.ledger.record('bank_events', data.id);
      if (row.state !== 'pending')
        return {id: row.id, state: row.state, transactionId: row.transaction_id};
      if (!['accept', 'dismiss'].includes(data.action)) fail('Неизвестное действие');
      let transactionId = null;
      if (data.action === 'accept') {
        if (
          data.transaction?.id ||
          data.transaction?.kind !== (row.kind === 'expense' ? 'expense' : 'income')
        )
          fail('Тип операции не соответствует уведомлению');
        const account = this.ledger.record('accounts', data.transaction.account);
        if (row.currency && account.currency !== row.currency)
          fail('Валюта уведомления не совпадает с валютой счёта');
        transactionId = this.ledger.saveTransaction({
          ...data.transaction,
          note:
            row.kind === 'refund'
              ? ('Возврат покупки · ' + String(data.transaction.note || '')).slice(0, 300)
              : data.transaction.note
        });
        if (
          this.ledger
            .accounts()
            .some((a) => !Number.isSafeInteger(a.balance) || Math.abs(a.balance) > 999999999999)
        )
          fail('Остаток счёта превышает допустимый диапазон');
        this.db.prepare('UPDATE state SET revision=revision+1').run();
      }
      const state = transactionId ? 'accepted' : 'dismissed';
      // Keep only hashes after review: notification text may include a balance or card suffix.
      this.db
        .prepare("UPDATE bank_events SET state=?,transaction_id=?,text='' WHERE id=?")
        .run(state, transactionId, row.id);
      return {id: row.id, state, transactionId};
    });
  }
}
