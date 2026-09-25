import {setTimeout as delay} from 'node:timers/promises';
export const fail = (message, status = 502) => Object.assign(new Error(message), {status});
const integer = (x) => Number.isSafeInteger(x) && x >= 0;
const label = (x, n = 300) => (typeof x === 'string' ? x.slice(0, n) : '');
const percent = (n, d) => (d > 0 && n >= 0 && n <= d ? Math.round((n / d) * 10000) / 100 : null);
export function timestamp(value) {
  if (!value) return null;
  const t =
    typeof value === 'number'
      ? value * 1000
      : Date.parse(/^[\d-]+ [\d:]+$/.test(value) ? value.replace(' ', 'T') + 'Z' : value);
  return Number.isFinite(t) && t > 0 && t <= Date.now() + 86400000 ? t : null;
}
export function steamId(input) {
  if (typeof input !== 'string' || input.length > 200)
    throw fail('Укажи SteamID64 или ссылку на профиль', 400);
  let value = input.trim();
  if (/^https?:/.test(value)) {
    const u = new URL(value);
    if (u.hostname !== 'steamcommunity.com') throw fail('Нужна ссылка steamcommunity.com', 400);
    const m = /^\/(profiles|id)\/([^/]+)\/?$/.exec(u.pathname);
    if (!m) throw fail('Нужна ссылка на профиль Steam', 400);
    value = m[2];
  }
  if (!/^[A-Za-z0-9_-]{2,80}$/.test(value)) throw fail('Некорректный профиль Steam', 400);
  return value;
}
export class Provider {
  constructor(
    kind,
    account,
    {fetcher = fetch, now = Date.now, sleep = delay, budget = () => {}, token = null} = {}
  ) {
    Object.assign(this, {kind, account, fetcher, now, sleep, budget, token});
    this.next = {};
    this.gates = {};
    this.stopped = false;
    this.controller = new AbortController();
  }
  close() {
    this.stopped = true;
    this.controller.abort();
  }
  async get(endpoint, args = {}, source = 'api') {
    const url =
      source === 'store'
        ? new URL('https://store.steampowered.com/' + endpoint)
        : this.kind === 'steam'
          ? new URL('https://api.steampowered.com/' + endpoint)
          : new URL('https://retroachievements.org/API/API_' + endpoint + '.php');
    const stats = this.kind === 'steam' && endpoint.startsWith('ISteamUserStats/');
    const publicRequest =
      source === 'store' || endpoint.includes('GetGlobalAchievementPercentages');
    const useToken = !publicRequest && !stats && this.token;
    if (stats && !publicRequest && !this.account.key)
      throw fail(
        'Для достижений Steam добавь Web API key в настройках «Трофеев». QR-сессия сохранена.',
        409
      );
    url.search = new URLSearchParams({
      ...args,
      ...(publicRequest
        ? {}
        : useToken
          ? {access_token: await this.token(false)}
          : {[this.kind === 'steam' ? 'key' : 'y']: this.account.key})
    }).toString();
    let refreshed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.stopped) throw fail('Синхронизация остановлена', 503);
      const gate = (this.gates[source] ?? Promise.resolve()).then(async () => {
        await this.sleep(Math.max(0, (this.next[source] || 0) - this.now()));
        if (this.stopped) throw fail('Синхронизация остановлена', 503);
        this.budget();
        this.next[source] =
          this.now() + (source === 'store' ? 700 : this.kind === 'steam' ? 200 : 1100);
      });
      this.gates[source] = gate.catch(() => {});
      await gate;
      let response;
      try {
        response = await this.fetcher(url, {
          redirect: 'error',
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(20000)]),
          headers: {Accept: 'application/json', 'User-Agent': 'NEXUS404/0.20.0'}
        });
      } catch {
        throw fail('Сервис не отвечает. Сохранённые данные оставлены.');
      }
      if ((response.status === 401 || response.status === 403) && useToken && !refreshed) {
        await response.body?.cancel();
        refreshed = true;
        url.searchParams.set('access_token', await this.token(true));
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        const retry = response.headers.get('retry-after');
        const seconds = /^\d+$/.test(retry ?? '')
          ? Number(retry)
          : (Date.parse(retry) - this.now()) / 1000;
        const wait =
          Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2000 * 2 ** attempt;
        await response.body?.cancel();
        this.next[source] = Math.max(this.next[source] || 0, this.now() + wait);
        if (attempt === 2 || wait > 60000)
          throw fail('Сервис ограничил запросы. Повторим позже.', 503);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw fail(
          response.status === 401 || response.status === 403
            ? useToken
              ? 'Сессия Steam не даёт доступа к этому запросу. Повтори вход по QR.'
              : stats
                ? 'Steam не открыл статистику этой игры. Проверь ключ и приватность игры.'
                : 'Проверь ключ API и доступность профиля.'
            : 'API отклонил запрос. Данные оставлены.',
          [401, 403].includes(response.status) ? (useToken ? 401 : stats ? 502 : 409) : 502
        );
      }
      try {
        const reader = response.body.getReader();
        let size = 0;
        const chunks = [];
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 16 * 1024 * 1024) {
            await reader.cancel();
            throw Error();
          }
          chunks.push(Buffer.from(value));
        }
        return JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        throw fail('Неожиданный ответ API. Сохранённые данные оставлены.');
      }
    }
  }
  async identity(input) {
    if (this.kind === 'steam') {
      let id = steamId(input);
      if (!/^\d{17}$/.test(id)) {
        const d = await this.get('ISteamUser/ResolveVanityURL/v1/', {vanityurl: id});
        id = d.response?.steamid;
      }
      if (!/^\d{17}$/.test(id ?? '')) throw fail('Профиль Steam не найден', 400);
      const d = await this.get('ISteamUser/GetPlayerSummaries/v2/', {steamids: id});
      const p = d.response?.players?.find((x) => x.steamid === id);
      if (!p) throw fail('Профиль Steam не найден', 400);
      return {id, name: label(p.personaname) || id};
    }
    if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input))
      throw fail('Некорректное имя RetroAchievements', 400);
    const p = await this.get('GetUserProfile', {u: input});
    if (!p.User || !/^[A-Z0-9]{26}$/i.test(p.ULID ?? ''))
      throw fail('Профиль RetroAchievements не найден', 400);
    return {id: p.ULID, name: label(p.User)};
  }
  async library() {
    if (this.kind === 'steam') {
      const d = await this.get('IPlayerService/GetOwnedGames/v1/', {
        steamid: this.account.id,
        include_appinfo: 1,
        include_played_free_games: 1,
        include_free_sub: 1,
        skip_unvetted_apps: 0
      });
      const r = d.response;
      if (
        !r ||
        !integer(r.game_count) ||
        (r.game_count > 0 && !Array.isArray(r.games)) ||
        (r.games ?? []).length !== r.game_count
      )
        throw fail('Список Steam недоступен. Открой профиль и сведения об играх.');
      const items = (r.games ?? []).map((g) => {
        if (!integer(g.appid) || !g.appid) throw fail('Неожиданный формат списка Steam');
        return {
          id: String(g.appid),
          title: label(g.name) || String(g.appid),
          console: 'Steam',
          minutes: integer(g.playtime_forever) ? g.playtime_forever : null,
          lastPlayed: timestamp(g.rtime_last_played),
          cover: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.appid}/header.jpg`
        };
      });
      if (new Set(items.map((x) => x.id)).size !== items.length)
        throw fail('Повтор игр в ответе Steam');
      return {items, awards: []};
    }
    const items = [];
    let total = null;
    do {
      const r = await this.get('GetUserCompletionProgress', {
        u: this.account.id,
        c: 100,
        o: items.length
      });
      if (
        !integer(r.Total) ||
        !Array.isArray(r.Results) ||
        r.Count !== r.Results.length ||
        (total !== null && r.Total !== total)
      )
        throw fail('Неожиданный формат списка RetroAchievements');
      total = r.Total;
      if (total > 50000 || (!r.Results.length && items.length < total))
        throw fail('Неполный список RetroAchievements');
      for (const g of r.Results) {
        if (!integer(g.GameID) || !g.GameID || !integer(g.MaxPossible))
          throw fail('Неожиданный формат игры RetroAchievements');
        items.push({
          id: String(g.GameID),
          title: label(g.Title),
          console: label(g.ConsoleName),
          cover: raImage(g.ImageIcon),
          total: g.MaxPossible,
          soft: g.NumAwarded,
          hard: g.NumAwardedHardcore
        });
      }
    } while (items.length < total);
    if (items.length !== total || new Set(items.map((x) => x.id)).size !== total)
      throw fail('Неполный список RetroAchievements');
    const a = await this.get('GetUserAwards', {u: this.account.id});
    if (!Array.isArray(a.VisibleUserAwards))
      throw fail('Неожиданный формат наград RetroAchievements');
    return {
      items,
      awards: a.VisibleUserAwards.map((x) => ({
        game: String(x.AwardData),
        type: label(x.AwardType),
        hard: Number(x.AwardDataExtra) === 1,
        title: label(x.Title),
        time: timestamp(x.AwardedAt)
      })),
      hiddenAwards: Number(a.HiddenAwardsCount) || 0
    };
  }
  async reviews(id) {
    const r = await this.get(
      'appreviews/' + id,
      {json: 1, language: 'all', purchase_type: 'all', num_per_page: 0, filter: 'all'},
      'store'
    );
    const q = r.query_summary;
    if (
      r.success !== 1 ||
      !q ||
      !integer(q.total_reviews) ||
      !integer(q.total_positive) ||
      q.total_positive > q.total_reviews
    )
      throw fail('Отзывы Steam временно недоступны');
    return {
      reviewPercent: percent(q.total_positive, q.total_reviews),
      reviewCount: q.total_reviews,
      reviewAt: this.now()
    };
  }
  async price(id) {
    const r = await this.get('api/appdetails', {appids: id, cc: 'us', l: 'english'}, 'store');
    const entry = r[id];
    if (!entry || typeof entry.success !== 'boolean') throw fail('Цена Steam временно недоступна');
    const d = entry.data,
      price = d?.price_overview;
    return {
      priceUsd:
        d?.is_free === true
          ? 0
          : price?.currency === 'USD' && integer(price.initial)
            ? price.initial / 100
            : null,
      priceAt: this.now()
    };
  }
  async game(game, cached = {}) {
    if (this.kind === 'ra') {
      const r = await this.get('GetGameInfoAndUserProgress', {
        u: this.account.id,
        g: game.id,
        a: 1
      });
      if (
        String(r.ID) !== game.id ||
        !integer(r.NumAchievements) ||
        !r.Achievements ||
        typeof r.Achievements !== 'object'
      )
        throw fail('Неожиданный формат достижений RetroAchievements');
      const achievements = Object.values(r.Achievements).map((a) => {
        if (!integer(a.ID) || !a.ID) throw fail('Некорректное достижение RetroAchievements');
        return {
          id: String(a.ID),
          title: label(a.Title),
          description: label(a.Description, 1000),
          soft: !!a.DateEarned || !!a.DateEarnedHardcore,
          hard: !!a.DateEarnedHardcore,
          date: timestamp(a.DateEarned),
          hardDate: timestamp(a.DateEarnedHardcore),
          rarity: percent(a.NumAwarded, r.NumDistinctPlayersCasual),
          hardRarity: percent(a.NumAwardedHardcore, r.NumDistinctPlayersHardcore),
          points: Number(a.Points) || 0
        };
      });
      if (
        achievements.length !== r.NumAchievements ||
        new Set(achievements.map((a) => a.id)).size !== achievements.length
      )
        throw fail('Неполный список достижений RetroAchievements');
      return {...game, achievements, total: achievements.length, detailAt: this.now(), error: null};
    }
    let schema = cached.schema,
      schemaAt = cached.schemaAt,
      rarity = cached.rarity,
      rarityAt = cached.rarityAt;
    if (!schema || this.now() - schemaAt > 30 * 86400000) {
      const r = await this.get('ISteamUserStats/GetSchemaForGame/v2/', {
        appid: game.id,
        l: 'russian'
      });
      if (!r.game || typeof r.game !== 'object' || !Object.keys(r.game).length)
        throw fail('Схема достижений Steam недоступна');
      schema = r.game.availableGameStats?.achievements ?? [];
      if (
        !Array.isArray(schema) ||
        schema.some((a) => typeof a.name !== 'string') ||
        new Set(schema.map((a) => a.name)).size !== schema.length
      )
        throw fail('Неожиданная схема Steam');
      schemaAt = this.now();
    }
    if (!schema.length)
      return {
        ...cached,
        ...game,
        achievements: [],
        total: 0,
        schema,
        schemaAt,
        detailAt: this.now(),
        error: null
      };
    const r = await this.get('ISteamUserStats/GetPlayerAchievements/v1/', {
      appid: game.id,
      steamid: this.account.id,
      l: 'russian'
    });
    if (r.playerstats?.success !== true || !Array.isArray(r.playerstats.achievements))
      throw fail('Прогресс Steam недоступен. Проверь приватность игры.');
    const progress = new Map(r.playerstats.achievements.map((a) => [a.apiname, a]));
    if (progress.size !== r.playerstats.achievements.length) throw fail('Повтор достижений Steam');
    if (schema.length !== progress.size || schema.some((a) => !progress.has(a.name))) {
      if (cached.schema) return this.game(game, {...cached, schema: null});
      throw fail('Неполный прогресс Steam');
    }
    if (!rarity || this.now() - rarityAt > 86400000) {
      try {
        const g = await this.get('ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/', {
          gameid: game.id
        });
        if (!Array.isArray(g.achievementpercentages?.achievements)) throw Error();
        rarity = Object.fromEntries(
          g.achievementpercentages.achievements.map((a) => [a.name, Number(a.percent)])
        );
        rarityAt = this.now();
      } catch {
        rarity ??= {};
      }
    }
    const achievements = schema.map((a) => {
      const p = progress.get(a.name),
        rare = rarity[a.name];
      if (![0, 1].includes(p.achieved)) throw fail('Некорректный прогресс Steam');
      return {
        id: a.name,
        title: label(a.displayName) || a.name,
        description: label(a.description, 1000),
        soft: p.achieved === 1,
        hard: false,
        date: p.achieved ? timestamp(p.unlocktime) : null,
        hardDate: null,
        rarity: Number.isFinite(rare) && rare >= 0 && rare <= 100 ? rare : null,
        hardRarity: null
      };
    });
    return {
      ...cached,
      ...game,
      achievements,
      total: achievements.length,
      schema,
      schemaAt,
      rarity,
      rarityAt,
      detailAt: this.now(),
      error: null
    };
  }
}
export function raImage(input) {
  if (typeof input !== 'string') return '';
  const u = new URL(input, 'https://media.retroachievements.org');
  return ['media.retroachievements.org', 'retroachievements.org'].includes(u.hostname) &&
    u.protocol === 'https:' &&
    /^\/Images\/\d+\.(png|jpg|webp)$/i.test(u.pathname)
    ? u.href
    : '';
}
