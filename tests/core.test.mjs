import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// tests/anime
{
  const {AnimeStore, save, normalize, posterURL} = await import('../02-hub/modules/anime/store.mjs');
  const credentials = {
    appName: 'NEXUS404',
    clientId: 'client-id-1234567890',
    clientSecret: 'secret-12345678901234567890'
  };
  const tokens = (n) => ({
    access_token: 'access-1234567890-' + n,
    refresh_token: 'refresh-1234567890-' + n,
    expires_in: 86400
  });
  const rate = (id) => ({
    score: 8,
    status: 'watching',
    episodes: 6,
    anime: {
      id,
      name: 'Anime ' + id,
      russian: 'Аниме ' + id,
      episodes: 12,
      image: {preview: '/uploads/' + id + '.jpg'}
    }
  });
  function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-anime-'));
    let clock = Date.now();
    const f = {
      dir,
      calls: [],
      waits: [],
      pages: [[rate(1)], []],
      userId: 7,
      serial: 0,
      intercept: null
    };
    f.options = {
      now: () => clock,
      wait: async (ms) => {
        f.waits.push(ms);
        clock += ms;
      },
      fetcher: async (url, init) => {
        f.calls.push({url, init, at: clock});
        const intercepted = await f.intercept?.(url, init);
        if (intercepted) return intercepted;
        if (url.endsWith('/oauth/token')) return Response.json(tokens(++f.serial));
        if (url.endsWith('/whoami')) return Response.json({id: f.userId, nickname: 'Viewer'});
        if (url.includes('/anime_rates'))
          return Response.json(f.pages[Number(new URL(url).searchParams.get('page')) - 1] ?? null);
        if (url.endsWith('/api/graphql')) {
          const ids = JSON.parse(init.body)
            .query.match(/ids: "([\d,]+)"/)[1]
            .split(',');
          return Response.json({
            data: {
              animes: ids.map((id) => ({
                id,
                poster: {mainUrl: 'https://shikimori.io/uploads/' + id + '.webp'}
              }))
            }
          });
        }
        throw new Error('unexpected request');
      }
    };
    f.store = new AnimeStore(dir, f.options);
    f.connect = async () => {
      f.store.setup(credentials);
      await f.store.connect('code-1234567890123456');
    };
    f.advance = (ms) => {
      clock += ms;
    };
    t.after(() => {
      f.store.close();
      fs.rmSync(dir, {recursive: true, force: true});
    });
    return f;
  }
  test('anime connects via OAuth, redacts secrets and persists private credentials', async (t) => {
    const f = fixture(t);
    await f.connect();
    assert.equal(f.store.config().user.id, 7);
    const output = JSON.stringify(f.store.snapshot());
    for (const secret of [
      credentials.clientSecret,
      tokens(1).access_token,
      tokens(1).refresh_token
    ])
      assert.ok(!output.includes(secret));
    assert.equal(fs.statSync(f.store.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.dir).mode & 0o077, 0);
    assert.equal(f.calls[0].init.headers.Authorization, undefined);
    assert.equal(f.calls[1].init.headers.Authorization, 'Bearer ' + tokens(1).access_token);
    assert.equal(f.calls[1].init.redirect, 'error');
  });
  test('anime imports overlapping limit-plus-one pages exactly once and batches posters', async (t) => {
    const f = fixture(t);
    await f.connect();
    f.pages = [Array.from({length: 101}, (_, i) => rate(i + 1)), [rate(101), rate(102)]];
    assert.equal(await f.store.sync(), true);
    const d = f.store.snapshot();
    assert.equal(d.items.length, 102);
    assert.equal(d.items[101].cover, '/modules/anime/cover/102');
    assert.equal(d.stale, false);
    assert.ok(d.syncedAt);
    assert.equal(f.calls.filter((x) => x.url.endsWith('/api/graphql')).length, 3);
    assert.equal(f.calls.filter((x) => x.url.includes('/anime_rates')).length, 2);
    for (let i = 1; i < f.calls.length; i++) assert.ok(f.calls[i].at - f.calls[i - 1].at >= 1100);
    assert.equal(new AnimeStore(f.dir, f.options).snapshot().items.length, 102);
  });
  test('anime handles real Shikimori pagination boundaries and null terminal pages', async (t) => {
    for (const count of [0, 1, 99, 100, 101, 200, 201]) {
      const f = fixture(t);
      await f.connect();
      const all = Array.from({length: count}, (_, i) => rate(i + 1));
      f.intercept = (url) => {
        if (!url.includes('/anime_rates')) return null;
        const offset = (Number(new URL(url).searchParams.get('page')) - 1) * 100;
        return Response.json(offset > count ? null : all.slice(offset, offset + 101));
      };
      assert.equal(await f.store.sync(), true, 'count=' + count);
      assert.deepEqual(
        f.store.snapshot().items.map((x) => x.id),
        all.map((x) => x.anime.id)
      );
      assert.ok(!f.store.snapshot().error);
    }
    const f = fixture(t);
    await f.connect();
    f.pages = [Array.from({length: 100}, (_, i) => rate(i + 1)), null];
    assert.equal(await f.store.sync(), true);
    assert.equal(f.store.snapshot().items.length, 100);
  });
  test('anime refuses null first pages and error objects without erasing saved data', async (t) => {
    const f = fixture(t);
    await f.connect();
    await f.store.sync();
    const before = f.store.snapshot();
    for (const response of [null, {error: 'upstream failure'}, {data: []}, '']) {
      f.advance(3600000);
      f.intercept = (url) => (url.includes('/anime_rates') ? Response.json(response) : null);
      assert.equal(await f.store.sync(), false);
      assert.deepEqual(f.store.snapshot().items, before.items);
      assert.equal(f.store.snapshot().syncedAt, before.syncedAt);
    }
  });
  test('anime rejects a missing or changed lookahead record instead of publishing an incomplete list', async (t) => {
    const f = fixture(t);
    await f.connect();
    await f.store.sync();
    const before = f.store.snapshot().items;
    for (const next of [[], null, [rate(102)]]) {
      f.advance(3600000);
      f.pages = [Array.from({length: 101}, (_, i) => rate(i + 1)), next];
      assert.equal(await f.store.sync(), false);
      assert.deepEqual(f.store.snapshot().items, before);
    }
  });
  test('anime preserves last complete snapshot and timestamp after failure on a later page', async (t) => {
    const f = fixture(t);
    await f.connect();
    await f.store.sync();
    const before = f.store.snapshot();
    f.advance(3600000);
    f.pages = [Array.from({length: 100}, (_, i) => rate(i + 2)), [{broken: true}]];
    assert.equal(await f.store.sync(), false);
    const after = new AnimeStore(f.dir, f.options).snapshot();
    assert.deepEqual(after.items, before.items);
    assert.equal(after.syncedAt, before.syncedAt);
    assert.equal(after.stale, true);
    assert.match(after.error, /формат/);
  });
  test('anime rejects repeated pages and GraphQL partial failures without replacing the list', async (t) => {
    const f = fixture(t);
    await f.connect();
    await f.store.sync();
    const before = f.store.snapshot().items;
    f.advance(3600000);
    f.pages = [Array.from({length: 100}, (_, i) => rate(i + 2)), [rate(2)]];
    assert.equal(await f.store.sync(), false);
    assert.deepEqual(f.store.snapshot().items, before);
    f.advance(3600000);
    f.pages = [[rate(3)], []];
    f.intercept = (url) =>
      url.endsWith('/api/graphql')
        ? Response.json({data: {animes: []}, errors: [{message: 'error'}]})
        : null;
    assert.equal(await f.store.sync(), false);
    assert.deepEqual(f.store.snapshot().items, before);
  });
  test('anime handles valid empty lists and unknown episode totals', async (t) => {
    const f = fixture(t);
    await f.connect();
    await f.store.sync();
    f.advance(3600000);
    f.pages = [[]];
    assert.equal(await f.store.sync(), true);
    assert.deepEqual(f.store.snapshot().items, []);
    const unknown = rate(2);
    unknown.anime.episodes = 0;
    unknown.score = 0;
    assert.equal(normalize(unknown).episodes, 0);
    assert.equal(normalize(unknown).score, 0);
  });
  test('anime honors Retry-After and bounds retries', async (t) => {
    const f = fixture(t);
    await f.connect();
    let calls = 0;
    f.intercept = (url) =>
      url.includes('/anime_rates') && ++calls <= 2
        ? new Response(null, {status: 429, headers: {'Retry-After': '5'}})
        : null;
    assert.equal(await f.store.sync(), true);
    assert.equal(f.waits.filter((ms) => ms === 5000).length, 2);
    f.advance(3600000);
    calls = 0;
    f.intercept = (url) =>
      url.includes('/anime_rates') ? (++calls, new Response(null, {status: 503})) : null;
    assert.equal(await f.store.sync(), false);
    assert.equal(calls, 3);
    assert.equal(f.store.snapshot().items.length, 1);
  });
  test('anime persists a long rate-limit cooldown rather than waiting inside an HTTP request', async (t) => {
    const f = fixture(t);
    await f.connect();
    f.intercept = (url) =>
      url.includes('/anime_rates')
        ? new Response(null, {status: 429, headers: {'Retry-After': '3600'}})
        : null;
    assert.equal(await f.store.sync(), false);
    assert.ok(f.store.snapshot().nextAttempt >= f.options.now() + 3600000);
    assert.throws(
      () => new AnimeStore(f.dir, f.options).sync(),
      (e) => e.status === 429
    );
  });
  test('anime rotates both tokens before expiry and saves before the next API call', async (t) => {
    const f = fixture(t);
    await f.connect();
    f.advance(86400000);
    f.intercept = (url) => {
      if (url.includes('/anime_rates'))
        assert.equal(
          JSON.parse(fs.readFileSync(f.store.file)).connection.refresh_token,
          tokens(2).refresh_token
        );
      return null;
    };
    assert.equal(await f.store.sync(), true);
    assert.equal(f.serial, 2);
    assert.equal(f.store.data.connection.access_token, tokens(2).access_token);
  });
  test('anime retries a 401 once and never loops on invalid authorization', async (t) => {
    const f = fixture(t);
    await f.connect();
    let attempts = 0;
    f.intercept = (url) =>
      url.includes('/anime_rates') ? (++attempts, new Response(null, {status: 401})) : null;
    assert.equal(await f.store.sync(), false);
    assert.equal(attempts, 2);
    assert.equal(f.serial, 2);
  });
  test('anime refuses to reuse a refresh token after an interrupted rotation', async (t) => {
    const f = fixture(t);
    await f.connect();
    await f.store.sync();
    f.advance(86400000);
    f.intercept = (url) => {
      if (url.endsWith('/oauth/token')) throw new Error('network with secret');
    };
    assert.equal(await f.store.sync(), false);
    const next = new AnimeStore(f.dir, f.options);
    assert.equal(next.config().needsReconnect, true);
    assert.equal(next.snapshot().items.length, 1);
    assert.ok(!next.snapshot().error.includes('secret'));
    f.advance(3600000);
    const before = f.calls.length;
    await next.sync();
    assert.equal(f.calls.length, before);
  });
  test('anime sync is single-flight and account replacement cannot race it', async (t) => {
    const f = fixture(t);
    await f.connect();
    let release;
    const gate = new Promise((r) => (release = r));
    f.intercept = async (url) => {
      if (url.includes('/anime_rates')) await gate;
    };
    const job = f.store.sync();
    assert.equal(f.store.sync(), job);
    assert.throws(
      () => f.store.disconnect(),
      (e) => e.status === 409
    );
    assert.throws(
      () => f.store.setup(credentials),
      (e) => e.status === 409
    );
    release();
    await job;
    f.userId = 8;
    await f.connect();
    assert.equal(f.store.snapshot().syncedAt, null);
    assert.equal(f.store.snapshot().items.length, 0);
    f.store.disconnect();
    assert.equal(new AnimeStore(f.dir, f.options).config().connected, false);
  });
  test('anime failed reconnection keeps the existing account and cache', async (t) => {
    const f = fixture(t);
    await f.connect();
    await f.store.sync();
    f.store.setup(credentials);
    f.intercept = (url) => (url.endsWith('/whoami') ? Response.json({error: 'bad'}) : null);
    await assert.rejects(f.store.connect('another-code-1234567890'));
    assert.equal(f.store.config().user.id, 7);
    assert.equal(f.store.snapshot().items.length, 1);
  });
  test('anime failed disk write cannot publish a partially updated snapshot', async (t) => {
    const f = fixture(t);
    await f.connect();
    await f.store.sync();
    f.advance(3600000);
    const before = fs.readFileSync(f.store.file, 'utf8');
    f.store.write = () => {
      throw new Error('disk');
    };
    assert.equal(await f.store.sync(), false);
    assert.equal(fs.readFileSync(f.store.file, 'utf8'), before);
    assert.equal(f.store.snapshot().items.length, 1);
    assert.equal(f.store.snapshot().stale, true);
  });
  test('anime background scheduler refreshes hourly, retries errors and resumes after restart', async (t) => {
    const f = fixture(t);
    await f.connect();
    await f.store.tick();
    const before = f.calls.length;
    await f.store.tick();
    assert.equal(f.calls.length, before);
    f.advance(3600000);
    f.pages = [[rate(2)], []];
    await f.store.tick();
    assert.equal(f.store.snapshot().items[0].id, 2);
    f.advance(3600000);
    f.pages = [[{broken: true}]];
    await f.store.tick();
    const failed = f.calls.length;
    f.advance(60000);
    await f.store.tick();
    assert.equal(f.calls.length, failed);
    f.advance(300000);
    f.pages = [[rate(3)], []];
    const restarted = new AnimeStore(f.dir, f.options);
    await restarted.tick();
    assert.equal(restarted.snapshot().items[0].id, 3);
  });
  test('anime cover proxy restricts hosts, size and content type and never sends tokens', async (t) => {
    const f = fixture(t);
    await f.connect();
    await f.store.sync();
    for (const url of [
      'http://127.0.0.1/a',
      'https://shikimori.io.evil/a',
      'https://user:password@shikimori.io/a',
      'https://shikimori.io:444/a',
      'file:///etc/passwd'
    ])
      assert.equal(posterURL(url), '');
    let calls = 0;
    f.intercept = (url, init) => {
      if (url.includes('/uploads/')) {
        calls++;
        assert.equal(init.headers.Authorization, undefined);
        return new Response('small-image', {headers: {'Content-Type': 'image/webp'}});
      }
    };
    assert.equal((await f.store.cover(1)).type, 'image/webp');
    await f.store.cover(1);
    assert.equal(calls, 1);
    assert.equal(await f.store.cover(999), null);
    f.store.images.clear();
    fs.rmSync(f.store.coverCache.directory, {recursive: true, force: true});
    f.intercept = (url) =>
      url.includes('/uploads/')
        ? new Response('<svg/>', {headers: {'Content-Type': 'image/svg+xml'}})
        : null;
    assert.equal(await f.store.cover(1), null);
    f.intercept = (url) =>
      url.includes('/uploads/')
        ? new Response(Buffer.alloc(524289), {headers: {'Content-Type': 'image/png'}})
        : null;
    assert.equal(await f.store.cover(1), null);
  });
  test('anime details are cached, sanitized, deduplicated and retain stale data on error', async (t) => {
    const f = fixture(t);
    await f.connect();
    await f.store.sync();
    let calls = 0;
    f.intercept = (url, init) => {
      if (url.endsWith('/api/animes/1')) {
        calls++;
        assert.equal(init.headers.Authorization, undefined);
        return Response.json({
          id: 1,
          name: 'Anime',
          russian: 'Аниме',
          description: '<b>Описание</b> [url=x]текст[/url]',
          genres: [{russian: 'Драма'}],
          studios: [{name: 'Studio'}],
          score: '8.5',
          episodes: 12
        });
      }
    };
    const [a, b] = await Promise.all([f.store.detail(1), f.store.detail(1)]);
    assert.equal(calls, 1);
    assert.equal(a.description, 'Описание текст');
    assert.equal(b.score, 8.5);
    await assert.rejects(f.store.detail(999), (e) => e.status === 404);
    f.advance(7 * 3600000);
    f.intercept = (url) => (url.endsWith('/api/animes/1') ? new Response('', {status: 503}) : null);
    const stale = await f.store.detail(1);
    assert.equal(stale.stale, true);
    assert.equal(stale.title, 'Аниме');
  });
  test('anime empty cached descriptions refresh from HTML and a failed disk cache does not hide the result', async (t) => {
    const f = fixture(t);
    await f.connect();
    await f.store.sync();
    f.store.details.set(1, {
      id: 1,
      title: 'Old',
      description: '',
      genres: [],
      studios: [],
      updatedAt: Date.now()
    });
    f.intercept = (url) =>
      url.endsWith('/api/animes/1')
        ? Response.json({
            id: 1,
            name: 'Anime',
            description: '',
            description_html: '<p>Новый &amp; текст</p><script>bad()</script><p>Продолжение</p>'
          })
        : null;
    f.store.detailCache.put = () => {
      throw Error('disk full');
    };
    const result = await f.store.detail(1);
    assert.equal(result.description, 'Новый & текст\nПродолжение');
    assert.equal(result.stale, false);
    assert.equal(f.store.details.get(1).format, 2);
    f.intercept = (url) =>
      url.endsWith('/api/animes/1')
        ? Response.json({id: 1, name: 'Anime', description: 'Исправлено'})
        : null;
    assert.equal((await f.store.detail(1, true)).description, 'Исправлено');
  });
  test('anime covers load six at once and reject redirects to other hosts', async (t) => {
    const f = fixture(t);
    f.pages = [Array.from({length: 12}, (_, i) => rate(i + 1)), []];
    await f.connect();
    await f.store.sync();
    let active = 0,
      peak = 0;
    f.intercept = async (url) => {
      if (url.includes('/uploads/')) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return new Response('image', {headers: {'Content-Type': 'image/png'}});
      }
    };
    const images = await Promise.all(Array.from({length: 12}, (_, i) => f.store.cover(i + 1)));
    assert.equal(images.filter(Boolean).length, 12);
    assert.equal(peak, 6);
    f.store.images.clear();
    fs.rmSync(f.store.coverCache.directory, {recursive: true, force: true});
    let calls = 0;
    f.intercept = (url) => {
      calls++;
      return new Response(null, {status: 302, headers: {location: 'http://127.0.0.1/private'}});
    };
    assert.equal(await f.store.cover(1), null);
    assert.equal(calls, 1);
  });
  test('anime endpoints require login and same-origin mutations; settings stay outside the module', async (t) => {
    const f = fixture(t);
    const {createModule, settings} = await import('../02-hub/modules/anime/index.mjs');
    const {createApp} = await import('../02-hub/src/server.mjs');
    const {passwordHash} = await import('../02-hub/src/auth.mjs');
    const mod = createModule(f.dir, f.options),
      config = {
        username: 'admin',
        origin: 'https://hub.example.com',
        ...(await passwordHash('test-password-123'))
      };
    const app = createApp({
      config,
      modules: new Map([
        ['anime', {id: 'anime', title: 'Дионис', description: '', ...mod, settings}]
      ])
    });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    t.after(async () => {
      mod.close();
      app.closeAllConnections();
      await new Promise((r) => app.close(r));
    });
    const base = 'http://127.0.0.1:' + app.address().port;
    assert.equal((await fetch(base + '/modules/anime/api', {redirect: 'manual'})).status, 303);
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      redirect: 'manual',
      headers: {Origin: config.origin, 'Content-Type': 'application/x-www-form-urlencoded'},
      body: 'username=admin&password=test-password-123'
    });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    const post = (route, payload, Origin = config.origin) =>
      fetch(base + '/modules/anime' + route, {
        method: 'POST',
        headers: {Cookie, Origin, 'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      });
    assert.equal((await post('/setup', credentials, 'https://evil.example')).status, 403);
    assert.equal((await post('/setup', credentials)).status, 200);
    assert.equal((await post('/connect', {code: 'test-code-1234567890'})).status, 200);
    await mod.store.job;
    const list = await fetch(base + '/modules/anime/api', {headers: {Cookie}});
    assert.equal(list.headers.get('cache-control'), 'no-store');
    assert.ok(!(await list.text()).includes(credentials.clientSecret));
    const html = await (await fetch(base + '/modules/anime/', {headers: {Cookie}})).text();
    assert.ok(!html.includes('animeSetupForm'));
    const settingsHTML = await (
      await fetch(base + '/settings/?module=anime', {headers: {Cookie}})
    ).text();
    assert.ok(settingsHTML.includes('animeSetupForm'));
  });
}

// tests/bootstrap
{
  const {spawnSync} = await import('node:child_process');
  const {options, syncRepository, launchMenu, projectFiles} = await import('../bootstrap.mjs');
  function git(...args) {
    const r = spawnSync('git', args, {encoding: 'utf8'});
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  }
  function fixture(t, complete = true) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-bootstrap-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const source = root + '/source',
      directory = root + '/install';
    fs.mkdirSync(source);
    git('init', '--initial-branch=main', source);
    git('-C', source, 'config', 'user.name', 'Test');
    git('-C', source, 'config', 'user.email', 'test@example.invalid');
    for (const file of projectFiles.filter((file) => complete || file !== '02-hub/package.json')) {
      fs.mkdirSync(path.dirname(source + '/' + file), {recursive: true});
      fs.writeFileSync(
        source + '/' + file,
        file === 'menu.mjs' ? 'process.exitCode = Number(process.argv[2] ?? 0);\n' : '{}\n'
      );
    }
    git('-C', source, 'add', '.');
    git('-C', source, 'commit', '-m', 'first');
    return {source, directory, root, url: 'file://' + source, branch: 'main'};
  }
  test('bootstrap parses repository and branch without accepting URLs or shell syntax', () => {
    assert.equal(options([]).url, 'https://github.com/0xERR404/nexus.git');
    const selected = options([
      '--repo',
      'owner/project',
      '--branch',
      'feature/install',
      '--directory',
      '/opt/my-nexus',
      '--',
      '--task',
      '7'
    ]);
    assert.deepEqual(selected.menu, ['--task', '7']);
    assert.equal(selected.branch, 'feature/install');
    for (const args of [
      ['--repo', 'https://github.com/a/b'],
      ['--repo', 'a/b;reboot'],
      ['--repo', 'a/..'],
      ['--branch', '../main'],
      ['--branch', '-main'],
      ['--directory', '/'],
      ['--directory', 'relative'],
      ['--unknown'],
      ['--branch']
    ])
      assert.throws(() => options(args));
  });
  test('bootstrap clones the whole selected branch with Git metadata', (t) => {
    const f = fixture(t);
    assert.equal(syncRepository(f), 'cloned');
    assert.ok(fs.existsSync(f.directory + '/host/common.mjs'));
    assert.equal(git('-C', f.directory, 'branch', '--show-current'), 'main');
    assert.equal(git('-C', f.directory, 'remote', 'get-url', 'origin'), f.url);
    assert.equal(git('-C', f.directory, 'rev-parse', '--is-shallow-repository'), 'true');
  });
  test('repeated bootstrap fast-forwards the existing installation', (t) => {
    const f = fixture(t);
    syncRepository(f);
    fs.writeFileSync(f.source + '/new-module.mjs', 'export const ready = true;\n');
    git('-C', f.source, 'add', '.');
    git('-C', f.source, 'commit', '-m', 'next');
    assert.equal(syncRepository(f), 'updated');
    assert.equal(
      fs.readFileSync(f.directory + '/new-module.mjs', 'utf8'),
      'export const ready = true;\n'
    );
  });
  test('bootstrap preserves local changes and rejects another origin or branch', (t) => {
    const f = fixture(t);
    syncRepository(f);
    fs.writeFileSync(f.directory + '/menu.mjs', 'local edit');
    assert.throws(() => syncRepository(f), /локальные изменения/);
    assert.equal(fs.readFileSync(f.directory + '/menu.mjs', 'utf8'), 'local edit');
    git('-C', f.directory, 'restore', 'menu.mjs');
    assert.throws(
      () => syncRepository({...f, url: 'https://github.com/other/project.git'}),
      /другой origin/
    );
    assert.throws(() => syncRepository({...f, branch: 'develop'}), /другая ветка/);
  });
  test('bootstrap refuses divergent histories without resetting local commits', (t) => {
    const f = fixture(t);
    syncRepository(f);
    git('-C', f.directory, 'config', 'user.name', 'Test');
    git('-C', f.directory, 'config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(f.directory + '/local.txt', 'local');
    git('-C', f.directory, 'add', '.');
    git('-C', f.directory, 'commit', '-m', 'local');
    const before = git('-C', f.directory, 'rev-parse', 'HEAD');
    fs.writeFileSync(f.source + '/remote.txt', 'remote');
    git('-C', f.source, 'add', '.');
    git('-C', f.source, 'commit', '-m', 'remote');
    assert.throws(() => syncRepository(f));
    assert.equal(git('-C', f.directory, 'rev-parse', 'HEAD'), before);
  });
  test('bootstrap accepts clone and update without optional Docker ignore files', (t) => {
    const f = fixture(t);
    for (const name of ['.dockerignore', 'Dockerfile.dockerignore']) {
      assert.equal(fs.existsSync(f.source + '/02-hub/' + name), false);
      assert.equal(projectFiles.includes('02-hub/' + name), false);
    }
    syncRepository(f);
    fs.writeFileSync(f.source + '/README.md', 'Updated project');
    git('-C', f.source, 'add', 'README.md');
    git('-C', f.source, 'commit', '-m', 'update without optional build exclusions');
    syncRepository(f);
    assert.equal(fs.readFileSync(f.directory + '/README.md', 'utf8'), 'Updated project');
  });
  test('failed or incomplete clone leaves no half-installed target', (t) => {
    const f = fixture(t, false);
    assert.throws(() => syncRepository(f), /Неполный проект/);
    assert.equal(fs.existsSync(f.directory), false);
    assert.deepEqual(fs.readdirSync(f.root), ['source']);
    assert.throws(() => syncRepository({...f, branch: 'missing'}));
    assert.equal(fs.existsSync(f.directory), false);
    assert.deepEqual(fs.readdirSync(f.root), ['source']);
  });
  test('bootstrap does not overwrite another folder or symlink', (t) => {
    const f = fixture(t);
    fs.mkdirSync(f.directory);
    fs.writeFileSync(f.directory + '/keep', 'keep');
    assert.throws(() => syncRepository(f), /Каталог занят/);
    assert.equal(fs.readFileSync(f.directory + '/keep', 'utf8'), 'keep');
    const link = f.root + '/link';
    fs.symlinkSync(f.source, link);
    assert.throws(() => syncRepository({...f, directory: link}), /Каталог занят/);
  });
  test('menu launcher passes arguments and preserves failure status', async (t) => {
    const f = fixture(t);
    assert.equal(await launchMenu(f.source, ['7']), 7);
    assert.equal(await launchMenu(f.source), 0);
  });

  test('incomplete remote update never replaces the working checkout', (t) => {
    const f = fixture(t);
    syncRepository(f);
    const before = git('-C', f.directory, 'rev-parse', 'HEAD');
    git('-C', f.source, 'rm', 'host/common.mjs');
    git('-C', f.source, 'commit', '-m', 'incomplete');
    assert.throws(() => syncRepository(f));
    assert.equal(git('-C', f.directory, 'rev-parse', 'HEAD'), before);
    assert.ok(fs.existsSync(f.directory + '/host/common.mjs'));
  });

  test('missing hub build or browser files prevents an update before merge', (t) => {
    const f = fixture(t);
    syncRepository(f);
    const head = git('-C', f.directory, 'rev-parse', 'HEAD');
    git('-C', f.source, 'rm', '02-hub/Dockerfile', '02-hub/public/app.js');
    git('-C', f.source, 'commit', '-m', 'broken build');
    assert.throws(() => syncRepository(f), /Неполное обновление/);
    assert.equal(git('-C', f.directory, 'rev-parse', 'HEAD'), head);
  });
  test('a symlink cannot replace an install payload file', (t) => {
    const f = fixture(t);
    syncRepository(f);
    const head = git('-C', f.directory, 'rev-parse', 'HEAD');
    const file = f.source + '/host/ssh.mjs';
    fs.unlinkSync(file);
    fs.symlinkSync('common.mjs', file);
    git('-C', f.source, 'add', '.');
    git('-C', f.source, 'commit', '-m', 'linked file');
    assert.throws(() => syncRepository(f), /Неполное обновление/);
    assert.equal(git('-C', f.directory, 'rev-parse', 'HEAD'), head);
    assert.throws(() => syncRepository({...f, directory: f.root + '/other'}), /Неполный проект/);
  });
  test('release contains the full required install payload', async () => {
    const {checkProject} = await import('../bootstrap.mjs');
    checkProject(new URL('../', import.meta.url).pathname);
  });
}

// tests/host
{
  const {validPort, validUser, validTime, withLock, atomic} = await import('../host/common.mjs');
  const {
    cpuCounters,
    cpuUsage,
    memoryUsage,
    networkCounters,
    networkUsage,
    mountpoints,
    diskUsage,
    Collector
  } = await import('../host/metrics.mjs');
  const {clearPorts, parseSSH} = await import('../host/ssh.mjs');
  const {validDomain, validUpstream, renderCaddy, preflight} = await import('../host/platform.mjs');
  const {warnSchedule} = await import('../host/maintenance.mjs');
  const {sshEvent} = await import('../host/events.mjs');
  const {portFindings, loopback, dhcpClient} = await import('../host/security.mjs');
  const temporary = (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    return dir;
  };
  test('validation rejects unsafe users, ports and times', () => {
    for (const v of ['root', 'a b', '*', '-x', 'a;reboot']) assert.equal(validUser(v), false);
    assert.ok(validUser('deploy'));
    for (const v of ['22', '65536', '1e4', '-1234', '3000;']) assert.equal(validPort(v), false);
    assert.ok(validPort('2222'));
    assert.ok(validTime('00:00'));
    assert.equal(validTime('24:01'), false);
  });
  test('CPU excludes guest duplication and handles reset', () => {
    const old = cpuCounters('cpu 100 0 20 800 30 0 0 50 40 0\ncpu0 0\ncpu1 0');
    const current = cpuCounters('cpu 120 0 30 850 40 0 0 60 60 0');
    assert.equal(old.cores, 2);
    assert.deepEqual(cpuUsage(old.values, current.values), {
      percent: 40,
      iowait_percent: 10,
      steal_percent: 10
    });
    assert.equal(cpuUsage(null, current.values).percent, null);
    assert.equal(cpuUsage(current.values, old.values).percent, null);
  });
  test('memory uses available cache and preserves disabled swap', () => {
    const m = memoryUsage(
      'MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 400 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB'
    );
    assert.equal(m.memory.percent, 60);
    assert.equal(m.memory.used, 614400);
    assert.equal(m.swap.percent, null);
  });
  test('network rates use elapsed time and counter reset is unknown', () => {
    const c = networkCounters(
      'eth0: 1500 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\nveth1: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0'
    );
    assert.deepEqual(Object.keys(c), ['eth0']);
    const r = networkUsage({eth0: [1000, 1000]}, c, 2.5)[0];
    assert.equal(r.rx_per_second, 200);
    assert.equal(r.tx_per_second, 400);
    assert.equal(networkUsage(c, {eth0: [0, 0]}, 5)[0].rx_per_second, null);
  });
  test('disk mount deduplication, escaped names, inode and reserve accounting', () => {
    const table =
      '1 0 8:1 / / rw - ext4 /dev/sda rw\n2 1 8:1 /home /home rw - ext4 /dev/sda rw\n3 1 8:2 / /data\\040store rw - xfs /dev/sdb rw\n4 1 0:2 / /mnt/nfs rw - nfs a:/x rw';
    assert.deepEqual(
      mountpoints(table).map((d) => d.mount),
      ['/', '/data store']
    );
    const {disks, failed} = diskUsage(table, (p) => {
      if (p !== '/') throw new Error();
      return {blocks: 100, bfree: 40, bavail: 30, bsize: 1024, files: 1000, ffree: 100};
    });
    assert.equal(disks[0].reserved, 10240);
    assert.equal(disks[0].inodes_percent, 90);
    assert.deepEqual(failed, ['/data store']);
  });
  test('missing metrics are null with warnings', (t) => {
    const data = new Collector(temporary(t)).sample();
    assert.equal(data.cpu, null);
    assert.equal(data.memory, null);
    assert.equal(data.uptime_seconds, null);
    assert.ok(data.warnings.includes('cpu'));
  });
  test('SSH removes global ports but preserves Match blocks', () => {
    assert.equal(
      clearPorts('Port 22\n# x\nMatch User deploy\n Port 2222\n'),
      '# x\nMatch User deploy\n Port 2222\n'
    );
    assert.deepEqual(parseSSH('port 22\nport 2222\nallowusers admin deploy').port, ['22', '2222']);
  });
  test('Caddy validates upstreams and rejects config injection', () => {
    for (const v of [
      'https://user:pass@x:443',
      'http://x/path',
      'http://x/',
      'http://x:0',
      'http://x:65536',
      'http://x\nrespond 200',
      'ftp://x'
    ])
      assert.equal(validUpstream(v), false, v);
    for (const v of [
      '',
      'http://container:3000',
      'http://host.docker.internal:8080',
      'http://[::1]:8080'
    ])
      assert.ok(validUpstream(v), v);
    assert.ok(validDomain('server.example.com'));
    assert.equal(validDomain('x\n{}'), false);
    assert.throws(() => renderCaddy('x {}', ''));
    assert.match(renderCaddy('server.example.com', ''), /Caddy ready/);
    assert.match(
      renderCaddy('server.example.com', 'http://nexus404-hub:3000'),
      /header Strict-Transport-Security "max-age=604800"/
    );
    assert.doesNotMatch(renderCaddy('server.example.com', ''), /includeSubDomains|preload/);
  });
  test('Caddy preflight rejects other container on ports', () => {
    const run = (cmd, args) =>
      cmd === 'docker' && args[0] === 'ps'
        ? {ok: true, text: 'id'}
        : cmd === 'docker'
          ? {
              ok: true,
              text: JSON.stringify([
                {Config: {Labels: {}}, NetworkSettings: {Ports: {'8080/tcp': [{HostPort: '443'}]}}}
              ])
            }
          : {ok: true, text: ''};
    assert.throws(() => preflight('server.example.com', run), /занят/);
  });
  test('firewall audit recognises mapped loopback and unexpected Docker ports', () => {
    assert.ok(loopback('[::ffff:127.0.0.1]'));
    assert.equal(loopback('0.0.0.0'), false);
    const run = (cmd, args) =>
      cmd === 'docker' && args[0] === 'ps'
        ? {ok: true, text: 'a'}
        : cmd === 'docker'
          ? {
              ok: true,
              text: JSON.stringify([
                {
                  Name: '/app',
                  NetworkSettings: {Ports: {'3000/tcp': [{HostIp: '0.0.0.0', HostPort: '3000'}]}},
                  HostConfig: {LogConfig: {Type: 'local'}}
                }
              ])
            }
          : cmd === 'ufw'
            ? {ok: true, text: 'Status: active'}
            : {ok: true, text: ''};
    assert.ok(
      portFindings(run, () => '2222', true).some(
        (r) => r.key.includes('docker.port.app.3000') && r.level === 'warning'
      )
    );
  });
  test('DHCP exception requires a trusted executable and preserves unrelated port warnings', () => {
    const row =
      'udp UNCONN 0 0 192.0.2.1%eth0:68 0.0.0.0:* users:(("systemd-network",pid=123,fd=18))';
    const trusted = {exe: '/usr/lib/systemd/systemd-networkd', uid: 0, writable: false};
    assert.equal(
      dhcpClient(row, () => trusted),
      true
    );
    for (const data of [
      {...trusted, uid: 1000},
      {...trusted, writable: true},
      {...trusted, exe: '/tmp/dhclient'}
    ])
      assert.equal(
        dhcpClient(row, () => data),
        false
      );
    assert.equal(
      dhcpClient(row, () => {
        throw new Error('gone');
      }),
      false
    );
    assert.equal(
      dhcpClient(row.split(' users:')[0], () => trusted),
      false
    );
    assert.equal(
      dhcpClient(row.replace(':68 ', ':9000 '), () => trusted),
      false
    );
    assert.equal(
      dhcpClient(row.replace('udp ', 'tcp '), () => trusted),
      false
    );
    assert.equal(
      dhcpClient(row + ' pid=456', (pid) =>
        pid === '123' ? trusted : {...trusted, exe: '/tmp/app'}
      ),
      false
    );
    const rows = [row, row.replace(':68 ', ':9000 ')];
    const run = (cmd, args) => ({
      ok: true,
      text:
        cmd === 'ss' && args.includes('-4')
          ? rows.join('\n')
          : cmd === 'ufw'
            ? 'Status: active'
            : ''
    });
    const findings = portFindings(
      run,
      () => '2222',
      false,
      (line) => dhcpClient(line, () => trusted)
    );
    assert.equal(findings.find((f) => f.key.endsWith('.68')).level, 'ok');
    assert.equal(findings.find((f) => f.key.endsWith('.9000')).level, 'warning');
  });
  test('pre-reboot notice crosses midnight and week correctly', () => {
    assert.equal(warnSchedule('00:02', 0), '57 23 * * 6');
    assert.equal(warnSchedule('03:00', 2), '55 2 * * 2');
  });
  test('SSH events contain only user, IP and method', () => {
    const e = sshEvent('Accepted publickey for deploy from 192.0.2.1 port 4567 ssh2: key-extra');
    assert.equal(e.type, 'security.ssh.login_succeeded');
    assert.equal(e.details, 'user=deploy ip=192.0.2.1 method=publickey');
    assert.equal(sshEvent('some other log'), null);
  });
  test('file lock rejects overlapping setup and releases after error', async (t) => {
    const dir = temporary(t),
      file = dir + '/lock';
    await withLock(file, async () => {
      await assert.rejects(withLock(file, async () => {}, true));
    });
    await assert.rejects(
      withLock(file, async () => {
        throw new Error('expected');
      })
    );
    await withLock(file, async () => {});
  });
  test('atomic configuration is private and leaves no partial file', (t) => {
    const dir = temporary(t),
      file = dir + '/config';
    atomic(file, 'first');
    atomic(file, 'second');
    assert.equal(fs.readFileSync(file, 'utf8'), 'second');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['config']);
  });

  test('public atomic files remain readable with restrictive service umask', (t) => {
    const dir = temporary(t),
      old = process.umask(0o077);
    try {
      atomic(dir + '/feed.json', '{}', 0o644);
      assert.equal(fs.statSync(dir + '/feed.json').mode & 0o777, 0o644);
    } finally {
      process.umask(old);
    }
  });
  test('runtime manifest selects exact architecture and refuses foreign major', async () => {
    const {runtimeRelease} = await import('../host/runtime.mjs');
    const text =
      'a'.repeat(64) +
      '  node-v24.10.0-linux-x64.tar.xz\n' +
      'b'.repeat(64) +
      '  node-v24.10.0-linux-arm64.tar.xz';
    assert.equal(runtimeRelease(text, 'arm64').hash, 'b'.repeat(64));
    assert.equal(runtimeRelease(text, 'x64').version, 'v24.10.0');
    assert.throws(() => runtimeRelease(text.replaceAll('v24.', 'v26.')));
    assert.throws(() => runtimeRelease(text, 'ia32'));
  });
}

// tests/maintenance
{
  const {job, installSchedules, warnSchedule} = await import('../host/maintenance.mjs');
  function fixture(t) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-'));
    t.after(() => fs.rmSync(base, {recursive: true, force: true}));
    const calls = [],
      events = [];
    const bootFile = base + '/boot',
      requiredFile = base + '/required';
    fs.writeFileSync(bootFile, 'boot-a');
    fs.writeFileSync(base + '/installed.flag', 'yes');
    let released = 0;
    const options = {
      base,
      bootFile,
      requiredFile,
      acquire: async () => async () => {
        released++;
      },
      run: async (...args) => calls.push(args),
      emit: (...args) => events.push(args),
      inspect: () => ({ok: true, text: 'inactive'}),
      check: () => 0
    };
    return {base, calls, events, options, released: () => released};
  }
  test('maintenance skips every task while setup holds its lock', async (t) => {
    const f = fixture(t);
    f.options.acquire = async () => {
      throw Object.assign(new Error('busy'), {code: 'ELOCKED'});
    };
    for (const name of ['health', 'pre-reboot', 'reboot', 'cleanup', 'security-reboot'])
      await job(name, f.options);
    assert.equal(f.calls.length, 0);
    assert.equal(f.events.length, 0);
    f.options.acquire = async () => {
      throw new Error('broken flock');
    };
    await assert.rejects(job('reboot', f.options), /broken flock/);
  });
  test('maintenance never reboots or checks an incomplete setup', async (t) => {
    const f = fixture(t);
    fs.unlinkSync(f.base + '/installed.flag');
    f.options.check = () => {
      throw new Error('must not run');
    };
    await job('health', f.options);
    await job('reboot', f.options);
    assert.equal(f.calls.length, 0);
    assert.equal(f.released(), 2);
  });
  test('completed health findings do not become an additional maintenance failure', async (t) => {
    const f = fixture(t);
    f.options.check = () => 1;
    assert.equal(await job('health', f.options), 1);
    assert.equal(f.events.length, 0);
    assert.equal(f.released(), 1);
    f.options.check = () => {
      throw new Error('diagnostic crashed');
    };
    await assert.rejects(job('health', f.options), /diagnostic crashed/);
    assert.equal(f.released(), 2);
  });
  test('security restart requires the OS reboot marker and avoids duplicate shutdown', async (t) => {
    const f = fixture(t);
    await job('pre-security-reboot', f.options);
    await job('security-reboot', f.options);
    assert.equal(f.events.length, 0);
    fs.writeFileSync(f.options.requiredFile, 'yes');
    await job('pre-security-reboot', f.options);
    await job('security-reboot', f.options);
    await job('reboot', f.options);
    assert.equal(f.events[0][0], 'system.reboot.scheduled');
    assert.equal(f.calls.filter(([cmd]) => cmd === '/sbin/shutdown').length, 1);
    assert.equal(fs.readFileSync(f.base + '/cleanup-after-reboot', 'utf8').trim(), 'boot-a');
  });
  test('cleanup waits for a new boot and retries after an apt failure', async (t) => {
    const f = fixture(t);
    await job('reboot', f.options);
    await job('cleanup', f.options);
    assert.equal(f.calls.length, 1);
    fs.writeFileSync(f.options.bootFile, 'boot-b');
    f.options.run = async () => {
      throw new Error('apt busy');
    };
    await assert.rejects(job('cleanup', f.options));
    assert.ok(fs.existsSync(f.base + '/cleanup-after-reboot'));
    f.options.run = async (...args) => f.calls.push(args);
    await job('cleanup', f.options);
    assert.equal(fs.existsSync(f.base + '/cleanup-after-reboot'), false);
    assert.equal(f.calls.filter(([cmd]) => cmd === 'apt-get').length, 2);
    assert.ok(f.events.some(([type]) => type === 'system.cleanup.completed'));
  });
  test('failed shutdown restores a pending cleanup from an earlier boot', async (t) => {
    const f = fixture(t);
    fs.writeFileSync(f.base + '/cleanup-after-reboot', 'older-boot');
    f.options.run = async () => {
      throw new Error('shutdown failed');
    };
    await assert.rejects(job('reboot', f.options));
    assert.equal(fs.readFileSync(f.base + '/cleanup-after-reboot', 'utf8').trim(), 'older-boot');
  });
  test('schedules disable unguarded APT restart and use guarded daily jobs', () => {
    const files = new Map();
    const io = {write: (file, value) => files.set(file, value), remove() {}};
    assert.throws(() => installSchedules('25:00', 1, '05:00', io));
    assert.equal(files.size, 0);
    installSchedules('03:00', 0, '06:00', io);
    assert.match(files.get('/etc/apt/apt.conf.d/99-nexus404-reboot'), /Automatic-Reboot "false"/);
    assert.match(
      files.get('/etc/cron.d/nexus404_security_reboot'),
      /55 1 \* \* \* root .*pre-security-reboot/
    );
    assert.match(
      files.get('/etc/cron.d/nexus404_security_reboot'),
      /0 2 \* \* \* root .* security-reboot/
    );
    assert.equal(warnSchedule('00:02', '*'), '57 23 * * *');
    const check = files.get('/etc/systemd/system/nexus404-security-check.service');
    assert.match(check, /SuccessExitStatus=3\n/);
    assert.match(check, /OnFailure=nexus404-event-failure@%n.service/);
  });

  test('restart waits while automatic updates run and rejects unknown service state', async (t) => {
    const f = fixture(t);
    f.options.inspect = () => ({ok: true, text: 'activating'});
    await job('reboot', f.options);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(f.base + '/cleanup-after-reboot'), false);
    f.options.inspect = () => ({ok: false, text: ''});
    await assert.rejects(job('reboot', f.options), /проверить службу/);
  });

  test('SSH jail may become ready after systemctl has returned', async () => {
    const {waitForSSHJail} = await import('../host/maintenance.mjs');
    let now = 0,
      attempts = 0;
    const ui = {task: async (_label, fn) => fn()};
    await waitForSSHJail(ui, {
      now: () => now,
      pause: async (ms) => {
        now += ms;
      },
      inspect: (command, args) => {
        assert.equal(command, 'fail2ban-client');
        assert.deepEqual(args, ['status', 'sshd']);
        return ++attempts === 3
          ? {ok: true, text: 'Status for the jail: sshd'}
          : {ok: false, error: 'Socket not ready'};
      }
    });
    assert.equal(attempts, 3);
    assert.equal(now, 2000);
  });
  test('SSH jail readiness has a deadline and logs service diagnostics on failure', async (t) => {
    const {waitForSSHJail} = await import('../host/maintenance.mjs');
    const f = fixture(t);
    let now = 0,
      attempts = 0;
    const log = f.base + '/setup.log',
      ui = {log, task: async (_label, fn) => fn()};
    await assert.rejects(
      waitForSSHJail(ui, {
        now: () => now,
        pause: async (ms) => {
          now += ms;
        },
        inspect: (command) => {
          if (command === 'journalctl')
            return {ok: true, text: 'Jail startup failed: backend error'};
          attempts++;
          return {ok: false, error: 'Jail sshd does not exist'};
        }
      }),
      /SSH jail не готов за 30 с.*Jail sshd does not exist/
    );
    assert.equal(now, 30000);
    assert.ok(attempts <= 31);
    assert.match(fs.readFileSync(log, 'utf8'), /backend error/);
  });
  test('SSH jail readiness does not hide a cancelled check', async () => {
    const {waitForSSHJail} = await import('../host/maintenance.mjs');
    const interrupted = Object.assign(new Error('interrupted'), {code: 'ECANCELLED'});
    await assert.rejects(
      waitForSSHJail(
        {task: async (_label, fn) => fn()},
        {
          inspect: () => {
            throw interrupted;
          },
          pause: async () => {
            assert.fail('must not retry');
          }
        }
      ),
      {code: 'ECANCELLED'}
    );
  });
}

// tests/menu
{
  const {installModules, modulesMenu, modules} = await import('../menu.mjs');
  const ui = () => ({
    lines: [],
    section(text) {
      this.lines.push(text);
    },
    line(text = '') {
      this.lines.push(text);
    }
  });
  test('install all modules runs sequentially with one maintenance pass', async () => {
    const events = [],
      screen = ui();
    let running = false;
    await installModules(screen, 'all', {
      install: async (u, id, maintenance) => {
        assert.equal(running, false);
        running = true;
        assert.equal(maintenance, false);
        await Promise.resolve();
        events.push(id);
        running = false;
      },
      maintenance: async () => events.push('maintenance')
    });
    assert.deepEqual(events, [
      'pulse',
      'signal',
      'chat',
      'balance',
      'anime',
      'trophies',
      'wave',
      'gallery',
      'articles',
      'reader',
      'storage',
      'projects',
      'kanban',
      'rhythm',
      'cinema',
      'statistics',
      'maintenance'
    ]);
  });
  test('individual selection runs only the requested module; invalid ID runs nothing', async () => {
    const calls = [],
      deps = {
        install: async (u, id) => calls.push(id),
        maintenance: async () => calls.push('maintenance')
      };
    await installModules(ui(), 'chat', deps);
    assert.deepEqual(calls, ['chat', 'maintenance']);
    await assert.rejects(installModules(ui(), 'invalid', deps), /Неизвестный/);
    assert.deepEqual(calls, ['chat', 'maintenance']);
  });
  test('failure stops the batch and completes maintenance for already installed modules', async () => {
    const screen = ui(),
      events = [];
    await assert.rejects(
      installModules(screen, 'all', {
        install: async (u, id) => {
          events.push(id);
          if (id === 'signal') throw new Error('service failed');
        },
        maintenance: async () => events.push('maintenance')
      }),
      /service failed/
    );
    assert.deepEqual(events, ['pulse', 'signal', 'maintenance']);
    assert.ok(screen.lines.some((t) => t.includes('Готово: Атлас')));
    assert.equal(
      screen.lines.some((t) => t.includes('Все модули установлены')),
      false
    );
  });
  test('missing prerequisites or failure in the first module do not run maintenance', async () => {
    let maintenance = false;
    await assert.rejects(
      installModules(ui(), 'all', {
        install: async () => {
          throw new Error('Сначала установи хаб через пункт 5');
        },
        maintenance: async () => {
          maintenance = true;
        }
      }),
      /Сначала установи хаб/
    );
    assert.equal(maintenance, false);
  });
  test('submenu handles invalid input, locks only installation and returns without recursion', async () => {
    const screen = ui(),
      choices = ['bad', '1', '', '0'],
      calls = [];
    let locked = false;
    screen.prompt = async () => {
      assert.equal(locked, false);
      assert.ok(choices.length);
      return choices.shift();
    };
    await modulesMenu(screen, {
      lock: async (fn) => {
        calls.push('lock');
        locked = true;
        try {
          await fn();
        } finally {
          locked = false;
        }
      },
      install: async (u, id) => {
        assert.equal(locked, true);
        calls.push(id);
      },
      report: () => assert.fail('Unexpected error')
    });
    assert.deepEqual(calls, ['lock', 'all']);
    assert.equal(choices.length, 0);
  });
  test('every individual submenu entry maps to its module; errors return to submenu', async () => {
    const screen = ui(),
      choices = modules.flatMap((m, i) => [String(i + 2), '']).concat('0'),
      calls = [],
      reports = [];
    screen.prompt = async () => {
      assert.ok(choices.length);
      return choices.shift();
    };
    await modulesMenu(screen, {
      lock: async (fn) => fn(),
      install: async (u, id) => {
        calls.push(id);
        if (id === 'signal') throw new Error('test failure');
      },
      report: (m) => reports.push(m)
    });
    assert.deepEqual(
      calls,
      modules.map((m) => m.id)
    );
    assert.deepEqual(reports, ['test failure']);
  });
}

// tests/module-files
{
  const {moduleFiles} = await import('../host/platform.mjs');

  function fixture(t, installed = true) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-module-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const hub = root + '/hub',
      state = root + '/state',
      source = root + '/02-hub/modules/balance',
      target = hub + '/modules/balance',
      marker = state + '/balance-installed';
    fs.mkdirSync(source, {recursive: true});
    fs.mkdirSync(state);
    const manifest = {apiVersion: 1, title: 'Плутос', description: '', enabled: true, version: '0.34.2'};
    fs.writeFileSync(source + '/manifest.json', JSON.stringify(manifest));
    fs.writeFileSync(source + '/index.mjs', 'new code');
    fs.writeFileSync(source + '/balance.js', 'new UI');
    if (installed) {
      fs.mkdirSync(target, {recursive: true});
      fs.writeFileSync(target + '/index.mjs', 'old code');
      fs.writeFileSync(target + '/obsolete.js', 'old UI');
      fs.writeFileSync(
        target + '/manifest.json',
        JSON.stringify({...manifest, title: 'Баланс', enabled: false, version: '0.20.0'})
      );
      fs.writeFileSync(marker, 'old marker');
    }
    return {root, hub, state, source, target, marker};
  }
  function unchanged(f) {
    assert.equal(fs.readFileSync(f.target + '/index.mjs', 'utf8'), 'old code');
    assert.equal(fs.readFileSync(f.target + '/obsolete.js', 'utf8'), 'old UI');
    assert.equal(fs.existsSync(f.target + '/balance.js'), false);
    assert.deepEqual(fs.readdirSync(f.hub + '/modules'), ['balance']);
  }
  test('module update replaces complete code and preserves disabled manifest and data', (t) => {
    const f = fixture(t);
    fs.mkdirSync(f.hub + '/data');
    fs.writeFileSync(f.hub + '/data/ledger.sqlite', 'private data');
    moduleFiles('balance', f);
    assert.equal(fs.readFileSync(f.target + '/index.mjs', 'utf8'), 'new code');
    assert.equal(fs.existsSync(f.target + '/obsolete.js'), false);
    assert.equal(JSON.parse(fs.readFileSync(f.target + '/manifest.json')).enabled, false);
    assert.equal(JSON.parse(fs.readFileSync(f.target + '/manifest.json')).title, 'Плутос');
    assert.equal(JSON.parse(fs.readFileSync(f.target + '/manifest.json')).version, '0.34.2');
    assert.equal(fs.readFileSync(f.hub + '/data/ledger.sqlite', 'utf8'), 'private data');
    assert.equal(fs.statSync(f.target + '/index.mjs').mode & 0o777, 0o644);
    assert.deepEqual(fs.readdirSync(f.hub + '/modules'), ['balance']);
  });
  test('copy failure leaves installed code and marker unchanged', (t) => {
    const f = fixture(t);
    let copies = 0;
    assert.throws(
      () =>
        moduleFiles('balance', {
          ...f,
          copy: (from, to) => {
            if (++copies === 2) throw new Error('disk full');
            fs.copyFileSync(from, to);
          }
        }),
      /disk full/
    );
    unchanged(f);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'old marker');
  });
  test('failed first copy leaves no installed marker or partial module', (t) => {
    const f = fixture(t, false);
    assert.throws(() =>
      moduleFiles('balance', {
        ...f,
        copy: () => {
          throw new Error('disk full');
        }
      })
    );
    assert.equal(fs.existsSync(f.marker), false);
    assert.deepEqual(fs.readdirSync(f.hub + '/modules'), []);
  });
  test('marker write failure restores previous module or removes a new installation', (t) => {
    for (const installed of [true, false]) {
      const f = fixture(t, installed);
      if (installed) fs.rmSync(f.marker);
      fs.mkdirSync(f.marker);
      assert.throws(() => moduleFiles('balance', f));
      if (installed) unchanged(f);
      else assert.deepEqual(fs.readdirSync(f.hub + '/modules'), []);
    }
  });
  test('module update rejects unknown IDs, unmanaged directories and source links', (t) => {
    const f = fixture(t);
    assert.throws(() => moduleFiles('../chat', f), /Неизвестный/);
    fs.symlinkSync(f.source + '/index.mjs', f.source + '/link.mjs');
    assert.throws(() => moduleFiles('balance', f), /Ожидался файл/);
    unchanged(f);
    fs.rmSync(f.marker);
    assert.throws(() => moduleFiles('balance', f), /Каталог модуля занят/);
    unchanged(f);
  });
}

// tests/runtime
{
  const {pathToFileURL} = await import('node:url');
  const {exec, apt, installHost, saveJSON} = await import('../host/common.mjs');
  const {updateHubOrigin} = await import('../host/platform.mjs');
  const temporary = (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    return dir;
  };
  test('commands propagate failures and remove cancellation handlers', async () => {
    const listeners = process.listenerCount('SIGINT');
    await assert.rejects(exec('nexus-command-that-does-not-exist'), {code: 'ENOENT'});
    await assert.rejects(exec(process.execPath, ['-e', 'process.exit(7)']), /код 7/);
    await assert.rejects(
      exec(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {timeout: 100}),
      {
        code: 'ECANCELLED'
      }
    );
    assert.equal(process.listenerCount('SIGINT'), listeners);
  });
  test('interrupted apt is not retried', async () => {
    let calls = 0;
    await assert.rejects(
      apt(
        {
          run: async () => {
            calls++;
            throw Object.assign(new Error('interrupted'), {code: 'ECANCELLED'});
          }
        },
        'packages',
        'update'
      ),
      {code: 'ECANCELLED'}
    );
    assert.equal(calls, 1);
  });
  test('installed runtime imports its shared dependencies with restrictive umask', async (t) => {
    const dir = temporary(t),
      old = process.umask(0o077);
    try {
      installHost(dir);
    } finally {
      process.umask(old);
    }
    for (const name of ['signal', 'maintenance', 'metrics', 'platform'])
      await import(pathToFileURL(dir + '/host/' + name + '.mjs'));
    assert.equal(fs.statSync(dir + '/02-hub/src/webpush.mjs').mode & 0o777, 0o644);
    assert.equal(fs.statSync(dir + '/host').mode & 0o777, 0o755);
    for (const name of ['backup', 'backup-schedule', 'restore-check'])
      await import(pathToFileURL(dir + '/tools/backup/' + name + '.mjs'));
    assert.equal(fs.existsSync(dir + '/backup.mjs'), false);
    fs.writeFileSync(dir + '/backup.mjs', 'old implementation');
    installHost(dir);
    const {spawnSync} = await import('node:child_process');
    const legacy = spawnSync(process.execPath, [dir + '/backup.mjs'], {encoding: 'utf8'});
    assert.equal(legacy.status, 2);
    assert.match(legacy.stderr, /Мнемосина/);

  });
  test('Caddy domain change keeps credentials and refreshes hub origin once', async (t) => {
    const dir = temporary(t),
      file = dir + '/config/auth.json',
      state = dir + '/state';
    const auth = {
      username: 'admin',
      salt: 'a'.repeat(32),
      hash: 'b'.repeat(64),
      origin: 'https://old.example.com'
    };
    saveJSON(file, auth);
    let restarts = 0;
    const options = {
      hub: dir,
      state,
      write: saveJSON,
      restart: async () => {
        restarts++;
      }
    };
    await updateHubOrigin({}, 'new.example.com', options);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), {
      ...auth,
      origin: 'https://new.example.com'
    });
    assert.equal(fs.readFileSync(state + '/domain', 'utf8').trim(), 'new.example.com');
    await updateHubOrigin({}, 'new.example.com', options);
    assert.equal(restarts, 1);
    await assert.rejects(updateHubOrigin({}, 'bad domain', options));
    assert.equal(restarts, 1);
  });

  test('failed hub restart remains retryable after an origin change', async (t) => {
    const dir = temporary(t),
      state = dir + '/state';
    saveJSON(dir + '/config/auth.json', {origin: 'https://old.example.com'});
    const options = {
      hub: dir,
      state,
      write: saveJSON,
      restart: async () => {
        throw new Error('not ready');
      }
    };
    await assert.rejects(updateHubOrigin({}, 'new.example.com', options), /not ready/);
    assert.equal(fs.existsSync(state + '/domain'), false);
    let restarted = false;
    options.restart = async () => {
      restarted = true;
    };
    await updateHubOrigin({}, 'new.example.com', options);
    assert.ok(restarted);
    assert.equal(fs.readFileSync(state + '/domain', 'utf8').trim(), 'new.example.com');
  });
}

// tests/signal
{
  const {Rules, defaultSettings} = await import('../host/signal-rules.mjs');
  const {Signal, readEvents, readSettings} = await import('../host/signal.mjs');
  const {vapidKeys, subscriptionId} = await import('../host/webpush.mjs');
  const {saveJSON} = await import('../host/common.mjs');
  const sub = {
    endpoint: 'https://fcm.googleapis.com/wp/test',
    keys: {
      p256dh:
        'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg'
    }
  };
  const temp = (t) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-'));
    t.after(() => fs.rmSync(d, {recursive: true, force: true}));
    return d;
  };
  test('sustained CPU warning waits five minutes and recovers once', () => {
    let now = 0;
    const state = {},
      r = new Rules(state, () => now),
      data = {generated_at: 0, cpu: {percent: 95}, disks: [], warnings: []};
    r.metrics(data);
    assert.equal(r.take().length, 0);
    now = 299999;
    data.generated_at = now;
    r.metrics(data);
    assert.equal(r.take().length, 0);
    now = 300000;
    data.generated_at = now;
    r.metrics(data);
    assert.equal(r.take()[0].key, 'resources.cpu');
    now += 5000;
    data.generated_at = now;
    r.metrics(data);
    assert.equal(r.take().length, 0);
    data.cpu.percent = 20;
    r.metrics(data);
    now += 60000;
    data.generated_at = now;
    r.metrics(data);
    assert.equal(r.take()[0].category, 'recovery');
    assert.equal(r.take().length, 0);
  });
  test('disk critical is immediate and restart preserves deduplication', () => {
    let now = 100000;
    const state = {},
      d = {
        generated_at: now,
        cpu: {percent: 10},
        disks: [{mount: '/', percent: 96, inodes_percent: 10}],
        warnings: []
      };
    const r = new Rules(state, () => now);
    r.metrics(d);
    assert.equal(r.take()[0].level, 'critical');
    const restarted = new Rules(JSON.parse(JSON.stringify(state)), () => now);
    restarted.metrics(d);
    assert.equal(restarted.take().length, 0);
  });
  test('login failures and bans are grouped, cleanup recovers', () => {
    let now = 10000;
    const r = new Rules({}, () => now);
    for (let i = 0; i < 9; i++)
      r.event({type: 'security.hub.login_failed', details: 'ip=192.0.2.1'});
    assert.equal(r.take().length, 0);
    r.event({type: 'security.hub.login_failed'});
    assert.equal(r.take().length, 1);
    for (let i = 0; i < 3; i++) r.event({type: 'security.fail2ban.ban'});
    assert.equal(r.take().length, 1);
    now += 600001;
    r.flushGroups();
    assert.equal(r.take().length, 1);
    r.event({type: 'system.cleanup.failed', details: 'apt failed'});
    assert.equal(r.take()[0].level, 'critical');
    r.event({type: 'system.cleanup.completed'});
    assert.equal(r.take()[0].category, 'recovery');
  });
  test('daily summary once per local day', () => {
    let now = new Date(2026, 8, 22, 10, 0).getTime();
    const state = {},
      r = new Rules(state, () => now);
    r.daily('09:00', true, 'summary');
    assert.equal(r.take().length, 1);
    new Rules(state, () => now).daily('09:00', true, 'summary');
    assert.equal(r.take().length, 0);
    now += 86400000;
    r.daily('09:00', true, 'summary');
    assert.equal(r.take().length, 1);
  });
  test('journal cursor follows append and rotation without replay', (t) => {
    const dir = temp(t),
      file = dir + '/events',
      cursor = {};
    const event = {type: 'system.reboot.completed', time: new Date().toISOString()};
    fs.writeFileSync(file, JSON.stringify(event) + '\n');
    assert.equal(readEvents(file, cursor).length, 1);
    assert.equal(readEvents(file, cursor).length, 0);
    fs.renameSync(file, file + '.old');
    fs.writeFileSync(file, JSON.stringify(event) + '\n');
    assert.equal(readEvents(file, cursor).length, 1);
  });
  function fixture(t, sender) {
    const directory = temp(t);
    fs.mkdirSync(directory + '/public');
    saveJSON(directory + '/keys.json', vapidKeys());
    const device = {
      id: subscriptionId(sub),
      name: 'Phone',
      subscription: sub,
      updatedAt: 1,
      testAt: 0
    };
    const settings = {
      ...defaultSettings,
      categories: {...defaultSettings.categories},
      devices: [device]
    };
    const signal = new Signal({directory, sender, settings: () => settings, now: () => 1000000});
    return {signal, settings, device, directory};
  }
  test('queue survives restart, retries and records acceptance rather than delivery', async (t) => {
    let calls = 0;
    const f = fixture(t, async () => {
      calls++;
      return calls === 1 ? {ok: false, status: 503, retryAfter: 60} : {ok: true};
    });
    f.signal.enqueue(
      {
        id: 'event',
        time: 1000000,
        title: 'Test',
        body: 'detail',
        category: 'services',
        level: 'warning'
      },
      f.settings
    );
    f.signal.save();
    await f.signal.drain();
    assert.equal(f.signal.state.queue.length, 1);
    assert.equal(f.signal.state.queue[0].attempts, 1);
    const restarted = new Signal({
      directory: f.directory,
      settings: () => f.settings,
      sender: async () => ({ok: true}),
      now: () => 1200000
    });
    await restarted.drain();
    assert.equal(restarted.state.queue.length, 0);
    assert.equal(restarted.state.devices[f.device.id].acceptedAt, 1200000);
  });
  test('expired devices stop retries and revoked devices lose queued events', async (t) => {
    const f = fixture(t, async () => ({ok: false, status: 410, gone: true}));
    f.signal.enqueue(
      {id: 'event', time: 1000000, title: 'Test', body: 'detail', category: 'services'},
      f.settings
    );
    await f.signal.drain();
    assert.equal(f.signal.state.queue.length, 0);
    assert.equal(f.signal.state.devices[f.device.id].expiredAt, 1);
    f.signal.state.queue.push({
      id: f.device.id,
      event: {time: 1000000, category: 'services'},
      next: 1000000
    });
    f.settings.devices = [];
    await f.signal.drain();
    assert.equal(f.signal.state.queue.length, 0);
  });
  test('disabled category stays in inbox but is not pushed', (t) => {
    const f = fixture(t, async () => ({ok: true}));
    f.settings.categories.security = false;
    f.signal.enqueue({id: 'e', time: 1000000, category: 'security'}, f.settings);
    assert.equal(f.signal.state.events.length, 1);
    assert.equal(f.signal.state.queue.length, 0);
  });
  test('credential change invalidates old device subscriptions', (t) => {
    const dir = temp(t);
    saveJSON(dir + '/auth', {username: 'admin', salt: 'new', hash: 'new'});
    saveJSON(dir + '/settings', {identity: 'old', devices: [{subscription: sub}]});
    assert.equal(readSettings(dir + '/settings', dir + '/auth').devices.length, 0);
  });

  test('closed port recovers only after a complete successful inspection', (t) => {
    const f = fixture(t, async () => ({ok: true}));
    let now = 1000000;
    f.signal.rules.now = () => now;
    const finding = {key: 'port.tcp.0.0.0.0.9000', title: 'Port 9000', level: 'warning'};
    f.signal.securityFindings([finding]);
    now += 60000;
    f.signal.securityFindings([finding]);
    assert.equal(f.signal.rules.take()[0].key, finding.key);
    now += 60000;
    f.signal.securityFindings([{key: 'ports.read.4', level: 'warning', title: 'Cannot inspect'}]);
    assert.ok(f.signal.state.conditions[finding.key]);
    f.signal.securityFindings([]);
    now += 60000;
    f.signal.securityFindings([]);
    assert.ok(f.signal.rules.take().some((e) => e.key === finding.key + '.recovered'));
    assert.equal(f.signal.state.conditions[finding.key], undefined);
  });
  test('expired queued event is never sent after downtime', async (t) => {
    let sent = 0;
    const f = fixture(t, async () => {
      sent++;
      return {ok: true};
    });
    f.signal.state.queue.push({
      id: f.device.id,
      event: {time: -86400000, category: 'services'},
      next: 0
    });
    await f.signal.drain();
    assert.equal(sent, 0);
    assert.equal(f.signal.state.queue.length, 0);
  });

  test('brief normal readings reset an unannounced sustained warning', () => {
    let now = 0;
    const r = new Rules({}, () => now);
    const check = (active) => r.condition('cpu', active, {title: 'CPU', delay: 300000});
    check(true);
    now = 295000;
    check(false);
    now = 300000;
    check(true);
    now = 305000;
    check(true);
    assert.deepEqual(r.take(), []);
    now = 600000;
    check(true);
    assert.equal(r.take().length, 1);
  });
  test('missing samples cannot complete a sustained warning', () => {
    let now = 0;
    const r = new Rules({}, () => now);
    r.condition('cpu', true, {title: 'CPU', delay: 300000});
    now = 299000;
    r.condition('cpu', null, {title: 'CPU'});
    now = 301000;
    r.condition('cpu', true, {title: 'CPU', delay: 300000});
    assert.deepEqual(r.take(), []);
  });
  test('health diagnostics retain their severity and service failures identify the unit', () => {
    for (const [details, level] of [
      ['errors=0 warnings=1 status=warning', 'warning'],
      ['errors=2 warnings=0 status=warning', 'critical']
    ]) {
      const r = new Rules({}, () => 100000);
      r.event({type: 'system.healthcheck.completed', details});
      const events = r.take();
      assert.equal(events.length, 1);
      assert.equal(events[0].level, level);
      assert.equal(events[0].body, details);
    }
    const r = new Rules({}, () => 100000);
    r.event({type: 'system.service.failed', details: 'nexus404-security-check.service failed'});
    assert.match(r.take()[0].title, /nexus404-security-check.service/);
  });
  test('healthcheck recovery is emitted on the first successful daily report', () => {
    const r = new Rules({}, () => 100000);
    r.event({type: 'system.healthcheck.completed', details: 'status=warning'});
    r.take();
    r.event({type: 'system.healthcheck.completed', details: 'status=ok'});
    assert.equal(r.take()[0].category, 'recovery');
  });
  test('ban summary survives a new event at the interval boundary', () => {
    let now = 10000;
    const r = new Rules({}, () => now);
    r.event({type: 'security.fail2ban.ban'});
    r.event({type: 'security.fail2ban.ban'});
    r.take();
    now += 600001;
    r.event({type: 'security.fail2ban.ban'});
    const events = r.take();
    assert.equal(events.length, 2);
    assert.match(events[0].body, /Дополнительно заблокировано: 1/);
  });
  test('push delivery cannot make a failed monitor appear fresh', async (t) => {
    const f = fixture(t, async () => ({ok: true}));
    f.signal.state.checkedAt = 900000;
    f.signal.enqueue(
      {id: 'e', time: 1000000, title: 'Test', body: 'test', category: 'services'},
      f.settings
    );
    await f.signal.drain();
    const feed = JSON.parse(fs.readFileSync(f.directory + '/public/feed.json'));
    assert.equal(feed.updatedAt, 900000);
  });
  test('failed system checks still deliver a diagnostic and retain stale status', async (t) => {
    const f = fixture(t, async () => ({ok: true}));
    f.signal.checks = async () => {
      throw new Error('probe failed');
    };
    await f.signal.tick();
    assert.ok(f.signal.state.events.some((e) => e.key === 'monitor.checks'));
    assert.equal(f.signal.state.checkedAt, undefined);
  });
  test('a device receives one ordered request at a time', async (t) => {
    let calls = 0;
    const f = fixture(t, async () => {
      calls++;
      return {ok: true};
    });
    for (let i = 0; i < 2; i++)
      f.signal.enqueue(
        {id: 'e' + i, time: 1000000, title: 'Test', body: 'test', category: 'services'},
        f.settings
      );
    await f.signal.drain();
    assert.equal(calls, 1);
    assert.equal(f.signal.state.queue.length, 1);
    await f.signal.drain();
    assert.equal(calls, 2);
  });
  test('oversized event text is bounded before persistent queuing', (t) => {
    const f = fixture(t, async () => ({ok: true}));
    f.signal.enqueue(
      {
        id: 'e',
        key: 'x'.repeat(5000),
        time: 1000000,
        title: 'x'.repeat(5000),
        body: 'x'.repeat(50000),
        category: 'services'
      },
      f.settings
    );
    assert.equal(f.signal.state.events[0].body.length, 500);
    assert.equal(f.signal.state.queue[0].event.title.length, 160);
  });

  test('later events cannot overtake an earlier retry for the same device', async (t) => {
    const sent = [];
    let now = 1000000;
    const f = fixture(t, async (_device, payload) => {
      sent.push(payload.id);
      return sent.length === 1 ? {ok: false, status: 503, retryAfter: 60} : {ok: true};
    });
    f.signal.now = () => now;
    for (const id of ['first', 'second'])
      f.signal.enqueue({id, time: now, title: id, body: '', category: 'services'}, f.settings);
    await f.signal.drain();
    await f.signal.drain();
    assert.deepEqual(sent, ['first']);
    now += 61000;
    await f.signal.drain();
    await f.signal.drain();
    assert.deepEqual(sent, ['first', 'first', 'second']);
  });
  test('missing disk samples break a pending sustained warning', () => {
    for (const missing of [[], [{mount: '/', percent: null}]]) {
      let now = 1000000;
      const state = {},
        rules = new Rules(state, () => now);
      const sample = (disks) => rules.metrics({generated_at: now, disks, warnings: []});
      const full = [{mount: '/', percent: 90}];
      sample(full);
      now += 30000;
      sample(missing);
      now += 40000;
      sample(full);
      assert.equal(rules.take().filter((e) => e.key.startsWith('resources.percent')).length, 0);
      now += 60000;
      sample(full);
      assert.equal(rules.take().filter((e) => e.key.startsWith('resources.percent')).length, 1);
    }
  });
}

// tests/ssh
{
  const {SSH, rollback, migrateManagedSSH} = await import('../host/ssh.mjs');
  const {exec, read} = await import('../host/common.mjs');
  function fixture(t) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-guard-')),
      sshDirectory = base + '/etc-ssh',
      calls = [];
    fs.mkdirSync(sshDirectory + '/sshd_config.d', {recursive: true});
    fs.writeFileSync(sshDirectory + '/sshd_config', 'Port 22\nPermitRootLogin yes\n');
    fs.writeFileSync(sshDirectory + '/sshd_config.d/original.conf', 'PasswordAuthentication yes\n');
    t.after(() => fs.rmSync(base, {recursive: true, force: true}));
    const options = {
      base,
      sshDirectory,
      runtimeDirectory: base + '/run/sshd',
      run: async (command, args) => {
        calls.push([command, args]);
        if (command === 'cp') await exec(command, args);
      },
      inspect: (command, args) => {
        calls.push([command, args]);
        return {ok: true, text: ''};
      }
    };
    const ui = {line() {}, confirm: async () => true};
    return {base, sshDirectory, calls, options, ui, ssh: new SSH(ui, options)};
  }
  function legacyFixture(t) {
    const f = fixture(t);
    f.legacy = f.sshDirectory + '/sshd_config.d/00-nexus404.conf';
    fs.writeFileSync(
      f.legacy,
      'Port 12345\nAllowUsers deploy\nPermitRootLogin no\nPasswordAuthentication yes\n'
    );
    fs.writeFileSync(f.base + '/sudo_user', 'deploy');
    fs.writeFileSync(
      f.sshDirectory + '/sshd_config',
      'Include ' + f.legacy + '\nInclude ' + f.sshDirectory + '/sshd_config.d/*.conf\n'
    );
    f.options.inspect = (cmd, args) => {
      if (cmd === 'sshd')
        return {
          ok: true,
          text: fs.existsSync(f.legacy)
            ? 'port 12345\nport 12345\nallowusers deploy\nallowusers deploy\npermitrootlogin no\npasswordauthentication yes'
            : 'port 12345\nallowusers deploy\npermitrootlogin no\npasswordauthentication yes'
        };
      return {ok: args.at(-1) !== 'ssh.socket', text: ''};
    };
    return f;
  }
  test('SSH migration removes duplicate wildcard inclusion without reloading unchanged policy', async (t) => {
    const f = legacyFixture(t);
    assert.equal(await migrateManagedSSH(f.ui, f.options), true);
    assert.equal(fs.existsSync(f.legacy), false);
    assert.match(read(f.ssh.managedFile), /Port 12345/);
    assert.match(read(f.sshDirectory + '/sshd_config'), /nexus404\.inc/);
    assert.equal(
      f.calls.some(
        ([cmd, args]) =>
          cmd === 'systemctl' && ['restart', 'reload', 'reload-or-restart'].includes(args[0])
      ),
      false
    );
    assert.equal(await migrateManagedSSH(f.ui, f.options), false);
    assert.equal(fs.statSync(f.ssh.managedFile).mode & 0o777, 0o600);
  });
  test('SSH migration restores legacy files if effective policy changes', async (t) => {
    const f = legacyFixture(t),
      inspect = f.options.inspect;
    f.options.inspect = (cmd, args) => {
      const result = inspect(cmd, args);
      if (cmd === 'sshd' && !fs.existsSync(f.legacy)) result.text += '\npermitrootlogin yes';
      return result;
    };
    await assert.rejects(migrateManagedSSH(f.ui, f.options), /изменил политику/);
    assert.equal(fs.existsSync(f.legacy), true);
    assert.equal(fs.existsSync(f.ssh.managedFile), false);
    assert.match(read(f.sshDirectory + '/sshd_config'), /00-nexus404\.conf/);
  });
  test('SSH migration rolls back failed validation and rejects ambiguous files', async (t) => {
    const f = legacyFixture(t),
      run = f.options.run;
    f.options.run = async (cmd, args) => {
      if (cmd === 'sshd' && fs.existsSync(f.ssh.managedFile))
        throw new Error('invalid configuration');
      return run(cmd, args);
    };
    await assert.rejects(migrateManagedSSH(f.ui, f.options), /invalid configuration/);
    assert.equal(fs.existsSync(f.legacy), true);
    fs.writeFileSync(f.ssh.managedFile, 'Custom settings');
    assert.throws(() => f.ssh.managed(), /ручной перенос/);
    assert.equal(read(f.ssh.managedFile), 'Custom settings');
  });
  test('SSH global port cleanup includes the new managed extension', (t) => {
    const f = fixture(t);
    f.ssh.managed();
    f.ssh.set('Port', '12345');
    f.ssh.set('AllowUsers', 'deploy');
    f.ssh.clearPorts();
    assert.doesNotMatch(read(f.ssh.managedFile), /Port /);
    assert.match(read(f.ssh.managedFile), /AllowUsers deploy/);
  });
  test('SSH recreates its runtime directory immediately before each configuration check', (t) => {
    const f = fixture(t),
      directory = f.options.runtimeDirectory,
      old = process.umask(0o077);
    t.after(() => process.umask(old));
    f.ssh.inspect = () => {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
      return {ok: true, text: 'port 22\npasswordauthentication yes'};
    };
    assert.equal(f.ssh.config('deploy').passwordauthentication[0], 'yes');
    fs.rmSync(directory, {recursive: true});
    assert.deepEqual(f.ssh.ports(), [22]);
    fs.rmSync(directory, {recursive: true});
    assert.equal(f.ssh.config('root').port[0], '22');
  });
  test('SSH configuration failures retain the diagnostic and never reload the service', (t) => {
    const f = fixture(t);
    f.ssh.inspect = () => ({
      ok: false,
      error: '/etc/ssh/sshd_config line 12: Bad configuration option\n'
    });
    assert.throws(() => f.ssh.config('deploy'), /line 12: Bad configuration option/);
    assert.throws(() => f.ssh.ports(), /line 12: Bad configuration option/);
    assert.equal(
      f.calls.some(([cmd, args]) => cmd === 'systemctl' && args[0] !== 'cat'),
      false
    );
  });
  test('SSH reload and rollback prepare a missing runtime directory before validation', async (t) => {
    const f = fixture(t),
      directory = f.options.runtimeDirectory;
    const run = f.options.run;
    f.options.run = f.ssh.run = async (command, args) => {
      if (command === 'sshd') assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
      await run(command, args);
    };
    f.ssh.inspect = (command, args) => ({ok: args.at(-1) !== 'ssh.socket', text: ''});
    await f.ssh.reload();
    await f.ssh.begin();
    fs.rmSync(directory, {recursive: true});
    await f.ssh.abort();
    assert.equal(fs.existsSync(directory), true);
  });
  test('SSH rejected confirmation restores original files and stops timer', async (t) => {
    const f = fixture(t);
    await f.ssh.begin();
    f.ssh.managed();
    f.ssh.set('Port', '2222');
    f.ui.confirm = async () => false;
    await assert.rejects(f.ssh.confirm('Confirm'), /не подтверждён/);
    await f.ssh.abort();
    assert.equal(read(f.sshDirectory + '/sshd_config'), 'Port 22\nPermitRootLogin yes');
    assert.equal(fs.existsSync(f.ssh.managedFile), false);
    assert.ok(
      f.calls.some(([cmd, args]) => cmd === 'systemd-run' && args.includes('--on-active=10m'))
    );
    assert.ok(f.calls.some(([cmd, args]) => cmd === 'systemctl' && args[0] === 'stop'));
  });
  test('SSH timer rollback while prompt is open prevents late confirmation', async (t) => {
    const f = fixture(t);
    await f.ssh.begin();
    f.ssh.managed();
    f.ssh.set('Port', '2222');
    const folder = f.ssh.guard.folder;
    f.ui.confirm = async () => {
      await rollback(folder, f.options);
      return true;
    };
    await assert.rejects(f.ssh.confirm('Confirm'), /Таймер уже/);
    await f.ssh.abort();
    assert.equal(read(f.sshDirectory + '/sshd_config'), 'Port 22\nPermitRootLogin yes');
    assert.equal(fs.existsSync(folder + '/committed'), false);
  });
  test('committed SSH change cannot be reverted by a delayed timer', async (t) => {
    const f = fixture(t);
    await f.ssh.begin();
    f.ssh.managed();
    f.ssh.set('Port', '2222');
    const folder = f.ssh.guard.folder;
    await f.ssh.confirm('Confirm');
    await f.ssh.commit();
    const count = f.calls.length;
    await rollback(folder, f.options);
    assert.equal(f.calls.length, count);
    assert.equal(read(f.ssh.managedFile), 'Port 2222');
    assert.ok(fs.existsSync(folder + '/committed'));
  });
  test('SSH refuses socket restart that would terminate current connections', async (t) => {
    const f = fixture(t);
    f.ssh.inspect = () => ({ok: true, text: 'control-group'});
    await assert.rejects(f.ssh.reload(), /KillMode/);
    assert.ok(f.calls.some(([cmd, args]) => cmd === 'sshd' && args[0] === '-t'));
    assert.equal(
      f.calls.some(
        ([cmd, args]) => cmd === 'systemctl' && ['restart', 'disable'].includes(args[0])
      ),
      false
    );
  });

  test('SSH rollback preserves ports originally supplied by socket activation', async (t) => {
    const f = fixture(t);
    f.ssh.previousPorts = () => [2222];
    await f.ssh.begin();
    f.ssh.managed();
    f.ssh.set('Port', '3333');
    await f.ssh.abort();
    assert.match(read(f.ssh.managedFile), /Port 2222/);
    assert.doesNotMatch(read(f.ssh.managedFile), /3333/);
    assert.match(read(f.sshDirectory + '/sshd_config'), /^Include /);
    assert.ok(
      f.calls.some(
        ([cmd, args]) => cmd === 'systemctl' && args[0] === 'enable' && args[1] === 'ssh.service'
      )
    );
  });
}

// tests/webpush
{
  const {createPublicKey, verify} = await import('node:crypto');
  const {encrypt, authorization, vapidKeys, validateSubscription, sendPush} = await import(
    '../host/webpush.mjs'
  );
  const client =
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
  const sub = {
    endpoint: 'https://fcm.googleapis.com/wp/test',
    keys: {p256dh: client, auth: 'BTBZMqHH6r4Tts7J_aSIgg'}
  };
  test('Web Push encryption matches RFC 8291 byte-for-byte', () => {
    const output = encrypt('When I grow up, I want to be a watermelon', sub, {
      salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
      privateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url')
    });
    assert.equal(
      output.toString('base64url'),
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
    );
  });
  test('VAPID signature and audience validate', () => {
    const keys = vapidKeys(),
      header = authorization(sub.endpoint, keys, 'https://hub.example.com', 1000000),
      token = /t=([^,]+)/.exec(header)[1],
      [h, p, s] = token.split('.');
    assert.equal(JSON.parse(Buffer.from(p, 'base64url')).aud, 'https://fcm.googleapis.com');
    assert.equal(JSON.parse(Buffer.from(p, 'base64url')).exp, 4600);
    assert.ok(
      verify(
        'sha256',
        Buffer.from(h + '.' + p),
        {key: createPublicKey(keys.privateKey), dsaEncoding: 'ieee-p1363'},
        Buffer.from(s, 'base64url')
      )
    );
  });
  test('Push blocks SSRF, credentials, malformed keys and large payload', () => {
    for (const endpoint of [
      'http://127.0.0.1/',
      'https://127.0.0.1/',
      'https://fcm.googleapis.com.evil.test/',
      'https://fcm.googleapis.com:444/',
      'https://name:pass@fcm.googleapis.com/'
    ])
      assert.throws(() => validateSubscription({...sub, endpoint}));
    assert.throws(() =>
      validateSubscription({
        ...sub,
        keys: {...sub.keys, p256dh: Buffer.alloc(65).toString('base64url')}
      })
    );
    assert.throws(() => encrypt('x'.repeat(4000), sub));
    assert.deepEqual(validateSubscription(sub), sub);
  });
  test('Push uses encrypted body, rejects redirects and recognises expired subscription', async () => {
    let request;
    const result = await sendPush(sub, {title: 'Test'}, vapidKeys(), 'https://hub.example.com', {
      fetcher: async (url, options) => {
        request = {url, ...options};
        return new Response('', {status: 410});
      }
    });
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(result.gone, true);
    assert.equal(result.ok, false);
    assert.ok(!request.body.includes('Test'));
  });
}

// 02-hub/tests/balance-ui
{
  const {readFileSync} = await import('node:fs');
  const {runInNewContext} = await import('node:vm');
  const {setImmediate} = await import('node:timers/promises');

  test('quote cards leave loading state after failure, recover and retain last prices', async () => {
    const nodes = new Map();
    const element = () => ({
      textContent: 'Загрузка…',
      value: '',
      children: [],
      classList: {toggle() {}},
      addEventListener() {},
      querySelectorAll: () => [],
      append(...children) {
        this.children.push(...children);
      },
      replaceChildren(...children) {
        this.children = children;
        this.textContent = '';
      }
    });
    const get = (id) => {
      if (id === 'balanceSettings') return null;
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    };
    let failed = true,
      refresh;
    runInNewContext(
      readFileSync(new URL('../02-hub/modules/balance/balance.js', import.meta.url), 'utf8'),
      {
        document: {
          getElementById: get,
          createElement: element,
          addEventListener() {},
          hidden: false
        },
        addEventListener() {},
        setInterval: (callback) => {
          refresh = callback;
        },
        AbortSignal,
        URLSearchParams,
        fetch: async (url) => {
          if (url.endsWith('/rates'))
            return failed
              ? Response.json({error: 'offline'}, {status: 503})
              : Response.json({
                  fiat: {prices: {USD: 90, EUR: 100, KZT: 0.2, CNY: 12}},
                  crypto: {prices: {BTC: 90000, ETH: 3000, XMR: 200, TON: 3}}
                });
          if (url.endsWith('/ai')) return Response.json({available: false});
          if (url.endsWith('/credit')) return Response.json({state: 'unconfigured'});
          return Response.json({error: 'offline'}, {status: 503});
        }
      }
    );
    await setImmediate();
    const values = (id) => get(id).children.map((row) => row.children[1].textContent);
    for (const id of ['balanceFiat', 'balanceCrypto']) {
      assert.deepEqual(values(id), ['—', '—', '—', '—']);
      assert.equal(get(id).textContent.includes('Загрузка'), false);
      assert.match(get(id + 'Date').textContent, /Нет соединения/);
    }
    failed = false;
    await refresh();
    const prices = values('balanceFiat');
    assert.equal(prices[0], '90');
    assert.doesNotMatch(get('balanceFiatDate').textContent, /Нет соединения/);
    failed = true;
    await refresh();
    assert.deepEqual(values('balanceFiat'), prices);
    assert.match(get('balanceFiatDate').textContent, /Нет соединения/);
  });
}

// 02-hub/tests/balance
{
  const {randomUUID} = await import('node:crypto');
  const {Worker} = await import('node:worker_threads');
  const {Ledger, money} = await import('../02-hub/modules/balance/store.mjs');
  const {createModule, settings} = await import('../02-hub/modules/balance/index.mjs');
  const {createApp} = await import('../02-hub/src/server.mjs');
  const {passwordHash} = await import('../02-hub/src/auth.mjs');
  const month = new URLSearchParams({month: '2026-09'});
  function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-')),
      file = dir + '/ledger.sqlite',
      ledger = new Ledger(file);
    t.after(() => {
      try {
        ledger.close();
      } catch {}
      fs.rmSync(dir, {recursive: true, force: true});
    });
    const s = ledger.snapshot(month),
      [card, savings] = s.accounts,
      income = s.categories.find((c) => c.kind === 'income'),
      expense = s.categories.find((c) => c.kind === 'expense');
    const send = (action, data, requestId = randomUUID()) =>
      ledger.mutate({action, data, requestId});
    const transaction = (extra = {}) => ({
      kind: 'income',
      date: '2026-09-12',
      account: card.id,
      amount: '10.00',
      category: income.id,
      note: '',
      ...extra
    });
    return {dir, file, ledger, card, savings, income, expense, send, transaction};
  }
  test('balance history preserves currencies, transfers and pre-period opening amounts', (t) => {
    const f = fixture(t);
    f.send('account.save', {...f.card, opening: '100'});
    f.send('transaction.save', f.transaction({date: '2026-08-31', amount: '20'}));
    f.send(
      'transaction.save',
      f.transaction({date: '2026-09-02', kind: 'expense', category: f.expense.id, amount: '10'})
    );
    f.send(
      'transaction.save',
      f.transaction({date: '2026-09-03', kind: 'transfer', target: f.savings.id, amount: '30'})
    );
    const usd = f.send('account.save', {
      name: 'USD',
      currency: 'USD',
      kind: 'cash',
      opening: '5'
    }).id;
    f.send(
      'transaction.save',
      f.transaction({
        date: '2026-09-04',
        kind: 'transfer',
        target: usd,
        amount: '20',
        received: '2'
      })
    );
    f.send('transaction.save', f.transaction({date: '2026-09-25', amount: '999'}));
    const history = f.ledger.history('2026-09', new Date('2026-09-24T12:00:00Z'));
    assert.deepEqual(history[0].points.slice(0, 5), [12000, 11000, 11000, 9000, 9000]);
    assert.deepEqual(history[1].points.slice(0, 5), [500, 500, 500, 700, 700]);
    assert.equal(history[0].points.length, 24);
    assert.equal(history[0].points.at(-1), 9000);
    assert.equal(history[0].currency, 'RUB');
    assert.equal(history[1].currency, 'USD');
  });
  test('balance history recomputes deleted operations and handles empty, leap and future months', (t) => {
    const f = fixture(t),
      now = new Date('2026-10-01T00:00:00Z');
    const row = f.send('transaction.save', f.transaction());
    assert.equal(f.ledger.history('2026-09', now)[0].points.at(-1), 1000);
    f.send('transaction.delete', {id: row.id, version: 1});
    assert.deepEqual(f.ledger.history('2026-09', now)[0].points, Array(30).fill(0));
    assert.equal(f.ledger.history('2024-02', now)[0].points.length, 29);
    assert.equal(f.ledger.history('2026-01', now)[0].points.length, 31);
    assert.deepEqual(f.ledger.history('2027-01', now), []);
    assert.throws(() => f.ledger.history('2026-99', now));
  });
  test('money is exact cents, not implicit rounding', () => {
    assert.equal(money('0,10') + money('0.20'), 30);
    assert.equal(money('-12.34', true), -1234);
    for (const v of ['0', '-1', '1.001', '1e3', 'NaN', 'Infinity', '10000000000', 0.3, ''])
      assert.throws(() => money(v));
  });
  test('income, expense and transfer preserve totals and monthly cash flow', (t) => {
    const f = fixture(t);
    f.send('transaction.save', f.transaction({amount: '0.10'}));
    f.send('transaction.save', f.transaction({amount: '0.20'}));
    f.send(
      'transaction.save',
      f.transaction({kind: 'expense', amount: '0.05', category: f.expense.id})
    );
    f.send(
      'transaction.save',
      f.transaction({kind: 'transfer', amount: '0.15', target: f.savings.id})
    );
    const s = f.ledger.snapshot(month);
    assert.deepEqual(
      s.accounts.map((a) => a.balance),
      [10, 15]
    );
    assert.equal(s.totals[0].amount, 25);
    assert.equal(s.period.find((p) => p.kind === 'income').amount, 30);
    assert.equal(s.period.find((p) => p.kind === 'expense').amount, 5);
  });
  test('editing and deleting a transfer recomputes both sides without drift', (t) => {
    const f = fixture(t);
    f.send('transaction.save', f.transaction({amount: '100'}));
    const transfer = f.transaction({kind: 'transfer', amount: '30', target: f.savings.id}),
      {id} = f.send('transaction.save', transfer);
    f.send('transaction.save', {...transfer, id, version: 1, amount: '40'});
    assert.deepEqual(
      f.ledger.snapshot(month).accounts.map((a) => a.balance),
      [6000, 4000]
    );
    assert.throws(
      () => f.send('transaction.delete', {id, version: 1}),
      (e) => e.status === 409
    );
    f.send('transaction.delete', {id, version: 2});
    assert.deepEqual(
      f.ledger.snapshot(month).accounts.map((a) => a.balance),
      [10000, 0]
    );
  });
  test('FX transfers use received amounts and keep currency totals separate', (t) => {
    const f = fixture(t),
      {id} = f.send('account.save', {name: 'USD', kind: 'cash', currency: 'USD', opening: '0'});
    f.send('transaction.save', f.transaction({amount: '2000'}));
    f.send(
      'transaction.save',
      f.transaction({kind: 'transfer', target: id, amount: '1800', received: '20.15'})
    );
    const s = f.ledger.snapshot(month);
    assert.deepEqual(
      s.totals.map((x) => [x.currency, x.amount]),
      [
        ['RUB', 20000],
        ['USD', 2015]
      ]
    );
    assert.equal(s.period.length, 1);
    assert.throws(() =>
      f.send('transaction.save', f.transaction({kind: 'transfer', target: id, received: '0'}))
    );
  });
  test('idempotency survives restart and never resurrects a deleted entry', (t) => {
    const f = fixture(t),
      requestId = randomUUID(),
      data = f.transaction(),
      first = f.send('transaction.save', data, requestId);
    assert.deepEqual(f.send('transaction.save', data, requestId), first);
    assert.throws(
      () => f.send('transaction.save', {...data, amount: '20'}, requestId),
      (e) => e.status === 409
    );
    f.send('transaction.delete', {id: first.id, version: 1});
    f.ledger.close();
    const reopened = new Ledger(f.file);
    try {
      assert.deepEqual(reopened.mutate({requestId, action: 'transaction.save', data}), first);
      assert.equal(reopened.snapshot(month).total, 0);
    } finally {
      reopened.close();
    }
  });
  test('failed write rolls back balances, history, revision and retry token', (t) => {
    const f = fixture(t);
    f.send('account.save', {...f.card, opening: '9999999999.99'});
    const before = f.ledger.snapshot(month),
      requestId = randomUUID();
    assert.throws(
      () => f.send('transaction.save', f.transaction({amount: '0.01'}), requestId),
      /диапазон/
    );
    assert.deepEqual(f.ledger.snapshot(month), before);
    f.send(
      'transaction.save',
      f.transaction({kind: 'expense', category: f.expense.id, amount: '0.01'}),
      requestId
    );
    assert.equal(f.ledger.snapshot(month).total, 1);
  });
  test('four independent writers preserve all one hundred operations', async (t) => {
    const f = fixture(t),
      moduleURL = new URL('../02-hub/modules/balance/store.mjs', import.meta.url).href;
    await Promise.all(
      Array.from(
        {length: 4},
        () =>
          new Promise((resolve, reject) => {
            const worker = new Worker(
              `const {workerData}=require('node:worker_threads');(async()=>{const {Ledger}=await import(workerData.moduleURL);const ledger=new Ledger(workerData.file);for(let i=0;i<25;i++)ledger.mutate({requestId:crypto.randomUUID(),action:'transaction.save',data:workerData.data});ledger.close();})().catch(e=>{console.error(e);process.exit(1)});`,
              {
                eval: true,
                workerData: {file: f.file, moduleURL, data: f.transaction({amount: '0.01'})}
              }
            );
            worker.on('error', reject);
            worker.on('exit', (code) =>
              code ? reject(new Error('writer exit ' + code)) : resolve()
            );
          })
      )
    );
    const s = f.ledger.snapshot(month);
    assert.equal(s.total, 100);
    assert.equal(s.accounts[0].balance, 100);
    assert.equal(s.revision, 100);
  });
  test('archiving preserves history and cannot hide a nonzero balance', (t) => {
    const f = fixture(t),
      {id} = f.send('transaction.save', f.transaction());
    assert.throws(
      () => f.send('account.archive', {id: f.card.id, version: 1, archived: true}),
      /остаток/
    );
    f.send('transaction.save', f.transaction({kind: 'expense', category: f.expense.id}));
    f.send('account.archive', {id: f.card.id, version: 1, archived: true});
    assert.equal(f.ledger.snapshot(month).total, 2);
    assert.throws(() => f.send('transaction.delete', {id, version: 1}), /восстанови/);
    f.send('account.archive', {id: f.card.id, version: 2, archived: false});
    f.send('transaction.delete', {id, version: 1});
    assert.equal(f.ledger.snapshot(month).accounts[0].balance, -1000);
  });
  test('used accounts retain currency and opening amount; concurrent edits conflict', (t) => {
    const f = fixture(t);
    f.send('transaction.save', f.transaction());
    assert.throws(
      () => f.send('account.save', {...f.card, currency: 'USD', opening: '0'}),
      /не изменяются/
    );
    assert.throws(() => f.send('account.save', {...f.card, opening: '5'}), /не изменяются/);
    f.send('account.save', {...f.card, name: 'Новая карта', opening: '0'});
    assert.throws(
      () => f.send('account.save', {...f.card, name: 'Устаревшая правка', opening: '0'}),
      (e) => e.status === 409
    );
  });
  test('invalid dates, references and categories leave no entries', (t) => {
    const f = fixture(t);
    for (const extra of [
      {date: '2026-02-30'},
      {date: '2026-13-01'},
      {account: 'missing'},
      {kind: 'transfer', target: f.card.id},
      {kind: 'expense', category: f.income.id},
      {amount: '0.001'}
    ])
      assert.throws(() => f.send('transaction.save', f.transaction(extra)));
    f.send('category.archive', {id: f.income.id, version: 1, archived: true});
    assert.throws(() => f.send('transaction.save', f.transaction()), /категорию/);
    assert.equal(f.ledger.snapshot(month).total, 0);
  });
  test('history pagination and month/account filters preserve all entries', (t) => {
    const f = fixture(t);
    for (let i = 0; i < 35; i++) f.send('transaction.save', f.transaction({note: String(i)}));
    f.send('transaction.save', f.transaction({date: '2026-08-31'}));
    assert.equal(f.ledger.snapshot(month).transactions.length, 30);
    assert.equal(
      f.ledger.snapshot(new URLSearchParams({month: '2026-09', offset: '30'})).transactions.length,
      5
    );
    f.send('transaction.save', f.transaction({kind: 'transfer', target: f.savings.id}));
    assert.equal(
      f.ledger.snapshot(new URLSearchParams({month: '2026-09', account: f.savings.id})).total,
      1
    );
    assert.throws(() => f.ledger.snapshot(new URLSearchParams({month: '2026-99'})));
    assert.throws(() => f.ledger.snapshot(new URLSearchParams({month: '2026-09', offset: '-1'})));
  });
  test('corrupt and future database versions are not reset', (t) => {
    const f = fixture(t);
    f.ledger.db.exec('PRAGMA user_version=99');
    f.ledger.close();
    assert.throws(() => new Ledger(f.file), /новая версия/);
    const corrupt = f.dir + '/corrupt.sqlite';
    fs.writeFileSync(corrupt, 'existing unreadable data');
    assert.throws(() => new Ledger(corrupt));
    assert.equal(fs.readFileSync(corrupt, 'utf8'), 'existing unreadable data');
  });
  test('HTTP finance writes enforce auth, CSRF, limits and exactly-once retries', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-http-')),
      module = createModule(dir + '/ledger.sqlite'),
      config = {
        username: 'admin',
        origin: 'https://hub.example.com',
        ...(await passwordHash('password-for-tests-123'))
      };
    const app = createApp({
      config,
      modules: new Map([
        ['balance', {id: 'balance', title: 'Плутос', description: '', ...module, settings}]
      ])
    });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    t.after(async () => {
      app.closeAllConnections();
      await new Promise((r) => app.close(r));
      module.close();
      fs.rmSync(dir, {recursive: true, force: true});
    });
    const base = 'http://127.0.0.1:' + app.address().port,
      login = await fetch(base + '/api/auth/login', {
        method: 'POST',
        redirect: 'manual',
        headers: {Origin: config.origin, 'Content-Type': 'application/x-www-form-urlencoded'},
        body: 'username=admin&password=password-for-tests-123'
      }),
      cookie = login.headers.get('set-cookie').split(';')[0],
      headers = {Cookie: cookie, Origin: config.origin, 'Content-Type': 'application/json'};
    assert.equal((await fetch(base + '/modules/balance/api', {redirect: 'manual'})).status, 303);
    const data = await (await fetch(base + '/modules/balance/api?month=2026-09', {headers})).json(),
      payload = {
        requestId: randomUUID(),
        action: 'transaction.save',
        data: {
          kind: 'income',
          date: '2026-09-12',
          amount: '12.34',
          account: data.accounts[0].id,
          category: data.categories.find((c) => c.kind === 'income').id,
          note: '<img src=x onerror=alert(1)>'
        }
      };
    const post = (body, h = headers) =>
      fetch(base + '/modules/balance/mutate', {
        method: 'POST',
        headers: h,
        body,
        redirect: 'manual'
      });
    assert.equal(
      (await post(JSON.stringify(payload), {...headers, Origin: 'https://evil.example'})).status,
      403
    );
    assert.equal((await post(JSON.stringify(payload), {...headers, Cookie: ''})).status, 401);
    assert.equal((await post('{')).status, 400);
    assert.equal((await post('x'.repeat(9000))).status, 413);
    const responses = await Promise.all(
      Array.from({length: 10}, () => post(JSON.stringify(payload)))
    );
    assert.ok(responses.every((r) => r.status === 200));
    const response = await fetch(base + '/modules/balance/api?month=2026-09', {headers});
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const saved = await response.json();
    assert.equal(saved.total, 1);
    assert.equal(saved.accounts[0].balance, 1234);
    const page = await (await fetch(base + '/settings/?module=balance', {headers})).text();
    assert.match(page, /id="balanceManageAccounts"/);
    assert.doesNotMatch(page, /<img src=x/);
    const summary = await (await fetch(base + '/api/modules', {headers})).json();
    assert.equal(summary.modules[0].summary.items[0].label, 'RUB');
    assert.doesNotMatch(JSON.stringify(summary), /onerror|password|ledger.sqlite/);
    assert.equal(fs.statSync(dir + '/ledger.sqlite').mode & 0o777, 0o600);
  });
}

// 02-hub/tests/chat
{
  const {randomUUID} = await import('node:crypto');
  const {ChatStore, models} = await import('../02-hub/modules/chat/store.mjs');
  const {complete} = await import('../02-hub/src/deepseek.mjs');
  const {createModule, settings} = await import('../02-hub/modules/chat/index.mjs');
  const {createApp} = await import('../02-hub/src/server.mjs');
  const {passwordHash} = await import('../02-hub/src/auth.mjs');
  const key = 'sk-test-only-not-a-real-key';
  const config = {key, model: models[0], maxTokens: 8192, thinking: false};
  function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-')),
      store = new ChatStore(dir);
    t.after(() => {
      store.close();
      fs.rmSync(dir, {recursive: true, force: true});
    });
    return {store, dir};
  }
  const topic = (store) => store.change({action: 'create', id: randomUUID(), title: 'Тема'});
  const input = (t) => ({
    topic: t.id,
    version: t.version,
    requestId: randomUUID(),
    text: 'Привет',
    model: models[0]
  });
  function wire(text = 'Привет!') {
    return (
      'data: ' +
      JSON.stringify({choices: [{delta: {content: text}, finish_reason: null}]}) +
      '\r\n\r\ndata: ' +
      JSON.stringify({
        choices: [{delta: {}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}
      }) +
      '\n\ndata: [DONE]\n\n'
    );
  }
  test('chat keys are write-only, retained on blank save and removable without history loss', (t) => {
    const {store, dir} = fixture(t);
    const x = topic(store);
    store.saveConfig(config);
    assert.equal(store.publicConfig().configured, true);
    assert.ok(!JSON.stringify(store.publicConfig()).includes(key));
    store.saveConfig({...config, key: ''});
    assert.equal(store.config().key, key);
    assert.equal(fs.statSync(dir + '/deepseek.json').mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    store.saveConfig({...config, removeKey: true});
    assert.equal(store.config().key, '');
    assert.equal(store.topic(x.id).title, 'Тема');
    assert.throws(() => store.saveConfig({...config, key: 'bad\nkey'}));
  });
  test('chat retries reuse the saved request and reject changed payload or stale topic', (t) => {
    const {store, dir} = fixture(t),
      x = topic(store),
      data = input(x),
      job = store.begin(data);
    assert.equal(store.begin(data).replay, true);
    assert.equal(store.history(x.id).messages.length, 2);
    assert.throws(() => store.begin({...data, text: 'changed'}), /использован/);
    assert.throws(() => store.begin({...data, requestId: randomUUID()}), /изменилась/);
    store.finish(job, {content: 'Ответ', usage: {total_tokens: 3}});
    assert.equal(store.begin(data).replay, true);
    assert.equal(store.history(x.id).messages[1].content, 'Ответ');
    const other = new ChatStore(dir);
    assert.equal(other.begin(data).replay, true);
    other.close();
  });
  test('chat topic locks prevent concurrent paid requests and deleting a running reply', (t) => {
    const {store} = fixture(t),
      x = topic(store),
      job = store.begin(input(x));
    assert.throws(() => store.begin(input(store.topic(x.id))), /уже создаётся/);
    assert.throws(
      () => store.change({action: 'delete', id: x.id, version: store.topic(x.id).version}),
      /останови/
    );
    store.finish(job, {content: 'Часть', status: 'error', notice: 'Остановлен'});
    const retry = store.begin({requestId: job.id, version: store.topic(x.id).version}, true);
    assert.equal(retry.assistant, job.assistant);
    assert.equal(store.history(x.id).messages.length, 2);
    store.finish(retry, {content: 'Полный ответ'});
    store.change({action: 'delete', id: x.id, version: store.topic(x.id).version});
    assert.equal(store.requests(x.id).length, 0);
  });
  test('chat recovers interrupted replies and paginates without deleting history', (t) => {
    const {store} = fixture(t),
      x = topic(store);
    store.begin(input(x));
    store.recover();
    assert.equal(store.history(x.id).messages[1].status, 'error');
    for (let i = 0; i < 30; i++) {
      const job = store.begin(input(store.topic(x.id)));
      store.finish(job, {content: 'Ответ ' + i});
    }
    const page = store.history(x.id);
    assert.equal(page.messages.length, 50);
    assert.equal(page.more, true);
    assert.equal(store.history(x.id, page.messages[0].id).messages.length, 12);
    assert.throws(() => store.history('../outside'), /не найдена/);
  });
  test('chat bounds context and keeps old conversations intact', (t) => {
    const {store} = fixture(t),
      x = topic(store);
    for (let i = 0; i < 4; i++) {
      const job = store.begin({...input(store.topic(x.id)), text: 'x'.repeat(30000)});
      store.finish(job, {content: 'y'.repeat(30000)});
    }
    const job = store.begin(input(store.topic(x.id))),
      context = store.context(job);
    assert.equal(context.limited, true);
    assert.equal(context.messages[0].role, 'user');
    assert.ok(context.messages.reduce((n, m) => n + m.content.length, 0) <= 96000);
    assert.equal(store.history(x.id).messages.length, 10);
  });
  test('DeepSeek SSE handles split UTF-8, CRLF, usage and never forwards unsafe endpoints', async () => {
    const bytes = new TextEncoder().encode(': keepalive\n' + wire('Привет 🌍'));
    let received;
    const fetcher = async (url, options) => {
      received = {url, ...options};
      return new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
            c.close();
          }
        })
      );
    };
    let text = '';
    const result = await complete({
      ...config,
      messages: [{role: 'user', content: 'Hi'}],
      signal: new AbortController().signal,
      onDelta: (c) => (text += c),
      fetcher
    });
    assert.equal(text, 'Привет 🌍');
    assert.equal(result.content, text);
    assert.equal(result.usage.total_tokens, 15);
    assert.equal(received.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(received.redirect, 'error');
    assert.equal(JSON.parse(received.body).thinking.type, 'disabled');
  });
  test('DeepSeek rejects truncated streams and redacts provider error bodies', async () => {
    const args = {...config, messages: [], onDelta: () => {}, signal: new AbortController().signal};
    await assert.rejects(
      complete({...args, fetcher: async () => new Response(wire().replace('data: [DONE]', ''))}),
      /оборвалось/
    );
    await assert.rejects(
      complete({...args, fetcher: async () => new Response('secret: ' + key, {status: 401})}),
      (error) => !error.message.includes(key) && error.message.includes('отклонил ключ')
    );
  });
  test('HTTP chat enforces auth/CSRF, preserves streaming results, hides keys, and retries only once', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-http-'));
    let calls = 0,
      mode = 'ok';
    const fetcher = async () => {
      calls++;
      return mode === 'ok'
        ? new Response(wire('Ответ'))
        : new Response('secret ' + key, {status: 402});
    };
    const module = createModule(dir, {fetcher}),
      auth = {
        username: 'admin',
        origin: 'https://hub.example.com',
        ...(await passwordHash('chat-password-123'))
      };
    const app = createApp({
      config: auth,
      modules: new Map([['chat', {id: 'chat', title: 'Оракул', ...module, settings}]])
    });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    t.after(async () => {
      app.closeAllConnections();
      await new Promise((r) => app.close(r));
      module.close();
      fs.rmSync(dir, {recursive: true, force: true});
    });
    const base = 'http://127.0.0.1:' + app.address().port;
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      redirect: 'manual',
      headers: {Origin: auth.origin, 'Content-Type': 'application/x-www-form-urlencoded'},
      body: 'username=admin&password=chat-password-123'
    });
    const headers = {
      Cookie: login.headers.get('set-cookie').split(';')[0],
      Origin: auth.origin,
      'Content-Type': 'application/json'
    };
    const post = (route, data, h = headers) =>
      fetch(base + '/modules/chat' + route, {
        method: 'POST',
        headers: h,
        body: JSON.stringify(data),
        redirect: 'manual'
      });
    assert.equal((await post('/config', config, {...headers, Cookie: ''})).status, 401);
    assert.equal(
      (await post('/config', config, {...headers, Origin: 'https://evil.example'})).status,
      403
    );
    assert.equal((await post('/config', config)).status, 200);
    assert.ok(
      !(await (await fetch(base + '/modules/chat/config', {headers})).text()).includes(key)
    );
    const x = await (
        await post('/topic', {action: 'create', id: randomUUID(), title: 'Тест'})
      ).json(),
      data = input(x);
    const result = await post('/send', data);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    const events = (await result.text()).trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).type, 'done');
    assert.equal(calls, 1);
    assert.equal((await (await post('/send', data)).json()).saved, true);
    assert.equal(calls, 1);
    const end = events.at(-1);
    mode = 'error';
    const second = {...input(end.topic), text: 'Второй запрос'};
    const failed = (await (await post('/send', second)).text())
      .trim()
      .split('\n')
      .map(JSON.parse)
      .at(-1);
    assert.equal(failed.type, 'error');
    assert.ok(!JSON.stringify(failed).includes(key));
    mode = 'ok';
    const retried = (
      await (
        await post('/retry', {requestId: second.requestId, version: failed.topic.version})
      ).text()
    )
      .trim()
      .split('\n')
      .map(JSON.parse)
      .at(-1);
    assert.equal(retried.messages.length, 4);
    assert.equal(retried.type, 'done');
    const page = await (await fetch(base + '/modules/chat/', {headers})).text();
    assert.doesNotMatch(page, /id="chatKey"/);
    assert.match(
      await (await fetch(base + '/settings/?module=chat', {headers})).text(),
      /id="chatKey"/
    );
  });
  test('chat cancellation persists partial output and releases the topic for explicit retry', async (t) => {
    const {Readable} = await import('node:stream');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-abort-'));
    const module = createModule(dir, {
      fetcher: async (url, {signal}) =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  'data: ' +
                    JSON.stringify({choices: [{delta: {content: 'Сохранённая часть'}}]}) +
                    '\n\n'
                )
              );
              signal.addEventListener(
                'abort',
                () => c.error(new DOMException('Aborted', 'AbortError')),
                {once: true}
              );
            }
          })
        )
    });
    t.after(() => {
      module.close();
      fs.rmSync(dir, {recursive: true, force: true});
    });
    const request = (route, data, signal) => {
      const request = Readable.from([Buffer.from(JSON.stringify(data))]);
      request.method = 'POST';
      request.headers = {'content-type': 'application/json'};
      return module.handle({request, path: route, user: {username: 'admin'}, signal});
    };
    await request('/config', config);
    const x = await (
      await request('/topic', {action: 'create', id: randomUUID(), title: 'Прерванный'})
    ).json();
    const controller = new AbortController(),
      data = input(x),
      response = await request('/send', data, controller.signal),
      reader = response.body.getReader(),
      decoder = new TextDecoder();
    let output = '';
    while (!output.includes('Сохранённая часть'))
      output += decoder.decode((await reader.read()).value);
    controller.abort();
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      output += decoder.decode(part.value);
    }
    const last = output.trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(last.type, 'error');
    assert.equal(last.messages[1].content, 'Сохранённая часть');
    assert.equal(last.messages[1].status, 'error');
    assert.equal(last.requests[0].status, 'error');
  });
}

// 02-hub/tests/flowmusic
{
  const {randomUUID} = await import('node:crypto');
  const {DatabaseSync} = await import('node:sqlite');
  const {Readable} = await import('node:stream');
  const {FlowSession} = await import('../02-hub/modules/chat/flow-session.mjs');
  const {FlowAudio, audioURL} = await import('../02-hub/modules/chat/flow-audio.mjs');
  const {generate, readEvents, clipIDs} = await import('../02-hub/modules/chat/flowmusic.mjs');
  const {ChatStore, models} = await import('../02-hub/modules/chat/store.mjs');
  const {checkKey} = await import('../02-hub/src/deepseek.mjs');
  const {createModule} = await import('../02-hub/modules/chat/index.mjs');
  const credentials = {
    refreshToken: 'test-refresh-only-not-real',
    anonKey: 'test-anon-only-not-real'
  };
  const tokens = (n = 1) => ({
    access_token: 'test-access-' + n,
    refresh_token: 'test-refresh-' + n,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600
  });
  function directory(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-test-'));
    t.after(() => fs.rmSync(dir, {force: true, recursive: true}));
    return dir;
  }
  const event = (name, data, id) =>
    (id ? 'id: ' + id + '\n' : '') + 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n';
  const sse = (text) => new Response(text, {headers: {'Content-Type': 'text/event-stream'}});
  const payload = (topic) => ({
    topic: topic.id,
    version: topic.version,
    requestId: randomUUID(),
    text: 'Спокойная музыка',
    model: 'producer:standard'
  });
  function setup(t, fetcher) {
    const dir = directory(t),
      store = new ChatStore(dir),
      session = new FlowSession(dir, {fetcher}),
      audio = new FlowAudio(dir, fetcher);
    t.after(() => {
      session.close();
      store.close();
    });
    session.save(credentials);
    const topic = store.change({
      action: 'create',
      id: randomUUID(),
      title: 'Музыка',
      provider: 'flowmusic'
    });
    return {dir, store, session, audio, topic};
  }
  test('FlowMusic rotation is single-flight, durable, private and uses the latest refresh token', async (t) => {
    const dir = directory(t);
    let count = 0,
      release;
    const barrier = new Promise((r) => (release = r)),
      sent = [];
    const session = new FlowSession(dir, {
      fetcher: async (url, options) => {
        assert.equal(url, 'https://sb.flowmusic.app/auth/v1/token?grant_type=refresh_token');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers.apikey, credentials.anonKey);
        sent.push(JSON.parse(options.body).refresh_token);
        count++;
        await barrier;
        return Response.json(tokens(count));
      }
    });
    t.after(() => session.close());
    session.save(credentials);
    const pending = [session.token(), session.token(), session.refresh()];
    release();
    assert.deepEqual(await Promise.all(pending), Array(3).fill('test-access-1'));
    assert.equal(count, 1);
    const disk = JSON.parse(fs.readFileSync(dir + '/flowmusic.json'));
    assert.equal(disk.access_token, 'test-access-1');
    assert.equal(disk.refresh_token, 'test-refresh-1');
    assert.equal(fs.statSync(dir + '/flowmusic.json').mode & 0o777, 0o600);
    assert.doesNotMatch(
      JSON.stringify(session.publicConfig()),
      /test-|anon_key|access_token|refresh_token/
    );
    await session.refresh();
    assert.deepEqual(sent, [credentials.refreshToken, 'test-refresh-1']);
    assert.equal(fs.readdirSync(dir).length, 1);
  });
  test('FlowMusic 401 refreshes once across concurrent requests and retries each HTTP request only once', async (t) => {
    const dir = directory(t);
    let refresh = 0,
      requests = 0,
      force401 = false;
    const session = new FlowSession(dir, {
      fetcher: async (url, options) => {
        if (url.includes('/auth/')) return Response.json(tokens(++refresh));
        requests++;
        if (force401 || options.headers.Authorization === 'Bearer test-access-1')
          return new Response('sensitive provider error', {status: 401});
        return Response.json({ok: true});
      }
    });
    t.after(() => session.close());
    session.save(credentials);
    await session.token();
    const responses = await Promise.all([
      session.request('/clips', {body: {clip_ids: []}}),
      session.request('/clips', {body: {clip_ids: []}})
    ]);
    assert.equal(
      responses.every((r) => r.ok),
      true
    );
    assert.equal(refresh, 2);
    assert.equal(requests, 4);
    force401 = true;
    requests = 0;
    await assert.rejects(session.request('/clips', {body: {clip_ids: []}}), /отклонена/);
    assert.equal(requests, 2);
    assert.equal(refresh, 3);
  });
  test('FlowMusic replacement/removal cannot be overwritten by an in-flight refresh', async (t) => {
    const dir = directory(t);
    let release;
    const session = new FlowSession(dir, {
      fetcher: async () => {
        await new Promise((r) => (release = r));
        return Response.json(tokens());
      }
    });
    t.after(() => session.close());
    session.save(credentials);
    const pending = session.refresh();
    session.save({remove: true});
    release();
    await assert.rejects(pending, /изменена/);
    assert.equal(session.publicConfig().configured, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(dir + '/flowmusic.json')), {});
  });
  test('FlowMusic ambiguous refresh failures require a fresh session and redact provider bodies', async (t) => {
    const dir = directory(t);
    let calls = 0;
    const session = new FlowSession(dir, {
      fetcher: async () => {
        calls++;
        return new Response('SECRET', {status: 400});
      }
    });
    session.save(credentials);
    t.after(() => session.close());
    await assert.rejects(session.refresh(), (e) => !e.message.includes('SECRET'));
    assert.equal(session.publicConfig().needsLogin, true);
    await assert.rejects(session.token(), /новая сессия/);
    assert.equal(calls, 1);
    const restored = new FlowSession(dir);
    assert.equal(restored.publicConfig().needsLogin, true);
    restored.close();
  });
  test('FlowMusic proactive refresh runs before expiry without a generation', async (t) => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const dir = directory(t);
    let calls = 0;
    const session = new FlowSession(dir, {fetcher: async () => Response.json(tokens(++calls))});
    t.after(() => session.close());
    session.save(credentials);
    session.start();
    t.mock.timers.tick(1000);
    await session.pending;
    assert.equal(calls, 1);
    t.mock.timers.tick(3480000);
    await session.pending;
    assert.equal(calls, 2);
  });
  test('FlowMusic parses SSE split UTF-8, IDs, tool clip variants and error frames', async () => {
    const text =
      event(
        'part',
        {index: 0, status: 'start', part: {part_kind: 'text', content: 'Привет 🎵'}},
        '1'
      ) + event('complete', {}, '2');
    const bytes = new TextEncoder().encode(text.replaceAll('\n', '\r\n')),
      events = [];
    await readEvents(
      new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < bytes.length; i += 2) c.enqueue(bytes.slice(i, i + 2));
            c.close();
          }
        }),
        {headers: {'Content-Type': 'text/event-stream'}}
      ),
      (e) => {
        events.push(e);
      }
    );
    assert.equal(events[0].data.part.content, 'Привет 🎵');
    assert.equal(events[1].id, '2');
    assert.deepEqual(
      clipIDs({
        part_kind: 'tool-return',
        content: {clip_id: 'a', clip_id_b: 'b', stems: [{clip_id: 'c'}]}
      }),
      ['a', 'b', 'c']
    );
    assert.deepEqual(clipIDs({part_kind: 'tool-call', content: {clip_id: 'a'}}), []);
    await assert.rejects(
      readEvents(sse('event: part\ndata: bad\n\n'), () => {}),
      /Повреждённое/
    );
    await assert.rejects(
      readEvents(new Response('<html>'), () => {}),
      /формат/
    );
  });
  test('FlowMusic conversation → job stream → clips map → local audio, without leaking provider URLs', async (t) => {
    let launches = 0,
      polls = 0;
    const received = [];
    const clip = {
      title: 'Музыка',
      audio_url: 'https://storage.googleapis.com/producer-app-public/audio/track.mp3?private=secret'
    };
    const fetcher = async (url, options) => {
      received.push({url, options});
      if (url.includes('/auth/')) return Response.json(tokens());
      if (url.endsWith('/conversation')) {
        launches++;
        return Response.json({job_id: 'job-123'});
      }
      if (url.includes('/messages/')) {
        assert.match(url, /\/messages\/job-123\/stream\?last_id=0$/);
        return sse(
          event('conversation_id', {id: 'conversation-456'}, '1') +
            event(
              'part',
              {index: 0, status: 'start', part: {part_kind: 'text', content: 'Готово 🎵'}},
              '2'
            ) +
            event(
              'part',
              {
                index: 1,
                status: 'final',
                part: {part_kind: 'tool-return', content: {clip_id: 'clip-1', clip_id_b: 'clip-2'}}
              },
              '3'
            ) +
            event('complete', {}, '4')
        );
      }
      if (url.endsWith('/clips')) {
        polls++;
        return Response.json({
          clips: polls === 1 ? {'clip-1': {status: 'pending'}} : {'clip-1': clip, 'clip-2': clip}
        });
      }
      assert.equal(options.headers, undefined);
      assert.equal(options.redirect, 'error');
      return new Response('AUDIO-BYTES', {headers: {'Content-Type': 'audio/mpeg'}});
    };
    const f = setup(t, fetcher),
      job = f.store.begin(payload(f.topic)),
      progress = [];
    const result = await generate({
      ...f,
      job,
      signal: AbortSignal.timeout(5000),
      onDelta: () => {},
      onProgress: (s) => progress.push(s),
      poll: 1
    });
    f.store.finish(job, result);
    assert.equal(launches, 1);
    assert.equal(polls, 2);
    assert.equal(result.audio.length, 2);
    assert.equal(f.store.remote(f.topic.id), 'conversation-456');
    assert.doesNotMatch(
      JSON.stringify(f.store.history(f.topic.id)),
      /private=|test-access|conversation-456/
    );
    const audio = result.audio[0];
    const response = f.audio.serve(audio.id, {method: 'GET', headers: {range: 'bytes=2-6'}}, false);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-6/11');
    assert.equal(await response.text(), 'DIO-B');
    assert.equal(
      progress.some((s) => s.includes('Сохраняем')),
      true
    );
    const followup = f.store.begin(payload(f.store.topic(f.topic.id)));
    await generate({
      ...f,
      job: followup,
      signal: AbortSignal.timeout(5000),
      onDelta: () => {},
      onProgress: () => {},
      poll: 1
    });
    const next = JSON.parse(
      received.filter((r) => r.url.endsWith('/conversation'))[1].options.body
    );
    assert.equal(next.conversation_id, 'conversation-456');
    assert.equal(next.client_context.current_song_id, 'clip-1');
  });
  test('FlowMusic interrupted jobs resume by last event ID without a second paid launch', async (t) => {
    let launches = 0,
      phase = 0,
      resumed;
    const f = setup(t, async (url) => {
      if (url.includes('/auth/')) return Response.json(tokens());
      if (url.endsWith('/conversation')) {
        launches++;
        return Response.json({job_id: 'saved-job'});
      }
      if (phase === 0) {
        phase++;
        return sse(
          event(
            'part',
            {index: 0, status: 'start', part: {part_kind: 'text', content: 'Часть'}},
            'one'
          )
        );
      }
      if (phase === 1) throw new Error('network');
      resumed = url;
      return sse(
        event(
          'part',
          {index: 0, status: 'delta', part: {part_kind: 'text'}, delta: ' ответа'},
          'two'
        ) + event('complete', {}, 'three')
      );
    });
    const job = f.store.begin(payload(f.topic));
    const run = (job) =>
      generate({
        ...f,
        job,
        signal: AbortSignal.timeout(5000),
        onDelta: () => {},
        onProgress: () => {},
        poll: 1
      });
    await assert.rejects(run(job), /network/);
    f.store.recover();
    phase = 2;
    const retried = f.store.begin(
      {requestId: job.id, version: f.store.topic(f.topic.id).version},
      true
    );
    assert.equal((await run(retried)).content, 'Часть ответа');
    assert.equal(launches, 1);
    assert.match(resumed, /last_id=one$/);
  });
  test('FlowMusic never resends an ambiguous conversation POST', async (t) => {
    let launches = 0;
    const f = setup(t, async (url) => {
      if (url.includes('/auth/')) return Response.json(tokens());
      launches++;
      throw new Error('timeout after upload');
    });
    const job = f.store.begin(payload(f.topic));
    const run = (job) =>
      generate({
        ...f,
        job,
        signal: AbortSignal.timeout(5000),
        onDelta: () => {},
        onProgress: () => {}
      });
    await assert.rejects(run(job));
    f.store.recover();
    const retry = f.store.begin(
      {requestId: job.id, version: f.store.topic(f.topic.id).version},
      true
    );
    await assert.rejects(run(retry), /мог быть принят/);
    assert.equal(launches, 1);
  });
  test('FlowMusic audio rejects unsafe origins, redirects, HTML and malformed ranges', async (t) => {
    for (const url of [
      'http://127.0.0.1/a',
      'https://169.254.169.254/a',
      'https://storage.googleapis.com.evil.test/a',
      'https://evil@storage.googleapis.com/producer-app-public/a',
      'https://storage.googleapis.com:444/producer-app-public/a'
    ])
      assert.throws(() => audioURL(url));
    const audio = new FlowAudio(
      directory(t),
      async () => new Response('<html>', {headers: {'Content-Type': 'text/html'}})
    );
    await assert.rejects(
      audio.save(
        {audio_url: 'https://storage.googleapis.com/producer-app-public/a'},
        randomUUID(),
        AbortSignal.timeout(1000)
      ),
      /аудиофайл/
    );
    assert.throws(
      () => audio.serve('../private', {headers: {}, method: 'GET'}, false),
      /не найден/
    );
  });
  test('DeepSeek discovers the account model list instead of forcing two choices', async (t) => {
    const result = await checkKey('test-deepseek-key', async () =>
      Response.json({data: [{id: 'deepseek-flash'}]})
    );
    const store = new ChatStore(directory(t));
    t.after(() => store.close());
    store.saveConfig({
      key: 'test-deepseek-key',
      model: models[1],
      maxTokens: 8192,
      thinking: false
    });
    const config = store.saveModels('test-deepseek-key', result.models);
    assert.deepEqual(config.models, ['deepseek-flash']);
    assert.equal(config.model, 'deepseek-flash');
    store.saveConfig({key: 'new-deepseek-key', model: models[0], maxTokens: 8192, thinking: false});
    assert.throws(
      () => store.saveModels('test-deepseek-key', ['deepseek-flash']),
      /Ключ изменился/
    );
    assert.equal(store.publicConfig().models.length, 2);
  });
  test('chat v1 migrates existing DeepSeek history and isolates FlowMusic topics', (t) => {
    const dir = directory(t),
      db = new DatabaseSync(dir + '/chat.sqlite'),
      id = randomUUID();
    db.exec(`CREATE TABLE topics(id TEXT PRIMARY KEY,title TEXT NOT NULL,updated INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE messages(id INTEGER PRIMARY KEY,topic TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,role TEXT NOT NULL,content TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'done',created INTEGER NOT NULL,usage TEXT,notice TEXT NOT NULL DEFAULT '') STRICT;
    CREATE TABLE requests(id TEXT PRIMARY KEY,hash TEXT NOT NULL,topic TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,assistant INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,model TEXT NOT NULL,status TEXT NOT NULL) STRICT; PRAGMA user_version=1;`);
    db.prepare('INSERT INTO topics(id,title,updated) VALUES(?,?,?)').run(
      id,
      'Старая тема',
      Date.now()
    );
    db.prepare(
      "INSERT INTO messages(topic,role,content,created) VALUES(?,'user','Старый текст',?)"
    ).run(id, Date.now());
    db.close();
    const store = new ChatStore(dir);
    t.after(() => store.close());
    assert.equal(store.history(id).messages[0].content, 'Старый текст');
    assert.equal(store.topic(id).provider, 'deepseek');
    const f = store.change({
      action: 'create',
      id: randomUUID(),
      title: 'Flow',
      provider: 'flowmusic'
    });
    assert.throws(() => store.begin({...payload(f), model: models[0]}), /модель/);
    assert.throws(() => store.begin({...payload(store.topic(id))}), /модель/);
  });
  test('chat routes expose only FlowMusic status and reuse saved completed requests', async (t) => {
    const dir = directory(t);
    let calls = 0;
    const module = createModule(dir, {
      flowPoll: 1,
      fetcher: async (url) => {
        if (url.includes('/auth/')) return Response.json(tokens());
        if (url.endsWith('/conversation')) {
          calls++;
          return Response.json({job_id: 'http-job'});
        }
        return sse(
          event(
            'part',
            {index: 0, status: 'start', part: {part_kind: 'text', content: 'Какой жанр?'}},
            '1'
          ) + event('complete', {}, '2')
        );
      }
    });
    t.after(() => module.close());
    const post = (route, data) => {
      const request = Readable.from([Buffer.from(JSON.stringify(data))]);
      request.method = 'POST';
      request.headers = {'content-type': 'application/json'};
      return module.handle({request, path: route, user: {username: 'test'}});
    };
    assert.equal((await post('/flow/config', credentials)).status, 200);
    const topic = await (
      await post('/topic', {
        action: 'create',
        id: randomUUID(),
        title: 'Музыка',
        provider: 'flowmusic'
      })
    ).json();
    const data = payload(topic),
      output = await (await post('/send', data)).text();
    assert.doesNotMatch(output, /test-access|test-refresh|test-anon/);
    assert.equal(output.trim().split('\n').map(JSON.parse).at(-1).type, 'done');
    assert.equal((await (await post('/send', data)).json()).saved, true);
    assert.equal(calls, 1);
    const response = await module.handle({
      request: {method: 'GET', headers: {}},
      path: '/config',
      user: {username: 'test'}
    });
    const publicConfig = await response.text();
    assert.doesNotMatch(publicConfig, /test-access|test-refresh|test-anon/);
  });

  test('FlowMusic incomplete rotation blocks access; interrupted refresh can recover', async (t) => {
    const dir = directory(t);
    const session = new FlowSession(dir, {
      fetcher: async () => Response.json({...tokens(), refresh_token: undefined})
    });
    t.after(() => session.close());
    session.save(credentials);
    await assert.rejects(session.refresh(), /неполную сессию/);
    assert.equal(session.publicConfig().needsLogin, true);
    assert.notEqual(
      JSON.parse(fs.readFileSync(dir + '/flowmusic.json')).access_token,
      'test-access-1'
    );
    fs.writeFileSync(
      dir + '/flowmusic.json',
      JSON.stringify({...tokens(), anon_key: credentials.anonKey, refreshing: true})
    );
    const restarted = new FlowSession(dir, {
      fetcher: async () => Response.json(tokens(2))
    });
    assert.equal(restarted.publicConfig().needsLogin, false);
    assert.equal(await restarted.refresh(), 'test-access-2');
    restarted.close();
  });
  test('HTTP protects FlowMusic settings and audio, serves ranges, and deletes files with the topic', async (t) => {
    const {createApp} = await import('../02-hub/src/server.mjs');
    const {passwordHash} = await import('../02-hub/src/auth.mjs');
    const dir = directory(t),
      id = randomUUID();
    const audio = new FlowAudio(
      dir,
      async () => new Response('AUDIO-BYTES', {headers: {'Content-Type': 'audio/mpeg'}})
    );
    await audio.save(
      {audio_url: 'https://storage.googleapis.com/producer-app-public/a', title: 'Трек'},
      id,
      AbortSignal.timeout(1000)
    );
    const module = createModule(dir);
    const config = {
      username: 'admin',
      origin: 'https://hub.example.com',
      ...(await passwordHash('test-password-123'))
    };
    const app = createApp({
      config,
      modules: new Map([['chat', {id: 'chat', title: 'Оракул', ...module}]])
    });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    t.after(async () => {
      app.closeAllConnections();
      await new Promise((r) => app.close(r));
      module.close();
    });
    const base = 'http://127.0.0.1:' + app.address().port;
    const get = (route, headers = {}) =>
      fetch(base + '/modules/chat' + route, {headers, redirect: 'manual'});
    assert.equal((await get('/audio/' + id)).headers.get('location'), '/login');
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      redirect: 'manual',
      headers: {Origin: config.origin, 'Content-Type': 'application/x-www-form-urlencoded'},
      body: 'username=admin&password=test-password-123'
    });
    const headers = {
      Cookie: login.headers.get('set-cookie').split(';')[0],
      Origin: config.origin,
      'Content-Type': 'application/json'
    };
    const post = (route, data, h = headers) =>
      fetch(base + '/modules/chat' + route, {
        method: 'POST',
        headers: h,
        body: JSON.stringify(data),
        redirect: 'manual'
      });
    assert.equal((await post('/flow/config', credentials, {...headers, Cookie: ''})).status, 401);
    assert.equal(
      (await post('/flow/config', credentials, {...headers, Origin: 'https://evil.example'}))
        .status,
      403
    );
    const media = await get('/audio/' + id + '?download=1', {...headers, Range: 'bytes=0-4'});
    assert.equal(media.status, 206);
    assert.equal(media.headers.get('cache-control'), 'no-store');
    assert.match(media.headers.get('content-disposition'), /attachment/);
    assert.equal(await media.text(), 'AUDIO');
    assert.equal((await get('/audio/' + id, {...headers, Range: 'bytes=100-'})).status, 416);
    const topic = await (
      await post('/topic', {
        action: 'create',
        id: randomUUID(),
        title: 'Музыка',
        provider: 'flowmusic'
      })
    ).json();
    const store = new ChatStore(dir),
      job = store.begin(payload(topic));
    store.checkpoint(job, {audioIds: {clip: id}});
    store.finish(job, {audio: [audio.public(id)]});
    const version = store.topic(topic.id).version;
    store.close();
    assert.equal((await post('/topic', {action: 'delete', id: topic.id, version})).status, 200);
    assert.equal((await get('/audio/' + id, headers)).status, 404);
  });

  test('FlowMusic explicit payment rejection permits retry, ambiguous errors still do not', async (t) => {
    let launches = 0;
    const f = setup(t, async (url) => {
      if (url.includes('/auth/')) return Response.json(tokens());
      if (url.endsWith('/conversation'))
        return ++launches === 1
          ? new Response('private', {status: 402})
          : Response.json({job_id: 'paid-job'});
      return sse(
        event(
          'part',
          {index: 0, status: 'start', part: {part_kind: 'text', content: 'Ответ'}},
          '1'
        ) + event('complete', {}, '2')
      );
    });
    const job = f.store.begin(payload(f.topic));
    const run = (job) =>
      generate({
        ...f,
        job,
        signal: AbortSignal.timeout(5000),
        onDelta: () => {},
        onProgress: () => {}
      });
    await assert.rejects(run(job), /Недостаточно средств/);
    f.store.recover();
    const retry = f.store.begin(
      {requestId: job.id, version: f.store.topic(f.topic.id).version},
      true
    );
    assert.equal((await run(retry)).content, 'Ответ');
    assert.equal(launches, 2);
  });
}

// 02-hub/tests/insights
{
  const {randomUUID} = await import('node:crypto');
  const {Market, parseFiat, parseCrypto, readRemote} = await import(
    '../02-hub/modules/balance/market.mjs'
  );
  const {ChatStore} = await import('../02-hub/modules/chat/store.mjs');
  const {complete} = await import('../02-hub/src/deepseek.mjs');
  const {estimate, normalizeUsage, usageSnapshot} = await import('../02-hub/src/ai-usage.mjs');
  const {createModule} = await import('../02-hub/modules/balance/index.mjs');
  const xml =
    '<ValCurs Date="23.09.2026">' +
    [
      ['USD', 1, 90],
      ['EUR', 1, 100],
      ['KZT', 100, 20],
      ['CNY', 1, 12]
    ]
      .map(
        ([c, n, v]) =>
          `<Valute ID="${c}"><CharCode>${c}</CharCode><Nominal>${n}</Nominal><Value>${v},0000</Value></Valute>`
      )
      .join('') +
    '</ValCurs>';
  const crypto = (now) =>
    Object.fromEntries(
      ['bitcoin', 'ethereum', 'monero', 'the-open-network'].map((id, i) => [
        id,
        {usd: 100 / (i + 1), last_updated_at: now / 1000}
      ])
    );
  function directory(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-insights-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    return dir;
  }
  const usage = {
    prompt_tokens: 1000000,
    completion_tokens: 1000000,
    total_tokens: 2000000,
    prompt_cache_hit_tokens: 500000
  };
  function newJob(store, provider = 'deepseek') {
    const topic = store.change({action: 'create', id: randomUUID(), title: 'Test', provider});
    return store.begin({
      topic: topic.id,
      version: topic.version,
      text: 'test',
      model: provider === 'deepseek' ? 'deepseek-flash' : 'producer:standard',
      requestId: randomUUID()
    });
  }
  test('quotes normalize nominal units and reject incomplete or invalid upstream data', () => {
    assert.equal(parseFiat(xml).prices.KZT, 0.2);
    assert.throws(() => parseFiat(xml.replace('<CharCode>CNY', '<CharCode>ABC')));
    assert.throws(() => parseFiat('<!DOCTYPE x>' + xml));
    assert.throws(() => parseFiat(xml.replace('<Nominal>100', '<Nominal>0')));
    assert.throws(() => parseCrypto({bitcoin: {usd: 1}}, Date.now()));
    assert.throws(() => parseCrypto(crypto(Date.now() + 3600000), Date.now()));
  });
  test('rates singleflight, independent caches and stale source timestamps survive restart', async (t) => {
    const dir = directory(t);
    let now = 1800000000000,
      calls = 0,
      failCrypto = false;
    const fetcher = async (url) => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return url.includes('cbr.ru')
        ? new Response(xml)
        : failCrypto
          ? new Response('', {status: 429})
          : Response.json(crypto(now));
    };
    const market = new Market(dir, {fetcher, now: () => now});
    const [a, b] = await Promise.all([market.rates(), market.rates()]);
    assert.deepEqual(a, b);
    assert.equal(calls, 2);
    assert.equal(a.crypto.stale, false);
    await market.rates();
    assert.equal(calls, 2);
    now += 3600001;
    failCrypto = true;
    const c = await market.rates();
    assert.equal(c.fiat.stale, false);
    assert.equal(c.crypto.stale, true);
    assert.equal(c.crypto.fetchedAt, a.crypto.fetchedAt);
    assert.deepEqual(c.crypto.prices, a.crypto.prices);
    const restart = new Market(dir, {
      fetcher: async () => {
        throw new Error('offline');
      },
      now: () => now
    });
    const d = await restart.rates();
    assert.deepEqual(d.crypto.prices, a.crypto.prices);
    assert.equal(d.crypto.stale, true);
    assert.equal(fs.statSync(path.join(dir, 'rates.json')).mode & 0o777, 0o600);
  });
  test('upstream bodies are bounded and redirects are forbidden', async () => {
    await assert.rejects(
      readRemote('https://example.test', async (url, options) => {
        assert.equal(options.redirect, 'error');
        return new Response('x'.repeat(262145));
      })
    );
  });
  test('CoinGecko key is private, optional, retained on empty save and removable', async (t) => {
    const dir = directory(t);
    let headers;
    const market = new Market(dir, {
      fetcher: async (url, options) => {
        if (url.includes('coingecko')) headers = options.headers;
        return url.includes('cbr.ru') ? new Response(xml) : Response.json(crypto(Date.now()));
      }
    });
    assert.deepEqual(market.saveConfig({key: 'test-only-demo-key'}), {configured: true});
    market.saveConfig({key: ''});
    await market.rates();
    assert.equal(headers['x-cg-demo-api-key'], 'test-only-demo-key');
    assert.equal(JSON.stringify(await market.rates()).includes('test-only-demo-key'), false);
    assert.equal(fs.statSync(path.join(dir, 'market.json')).mode & 0o777, 0o600);
    assert.throws(() => market.saveConfig({key: 'x\nsecret'}));
    assert.deepEqual(market.saveConfig({key: '', removeKey: true}), {configured: false});
  });
  test('DeepSeek credit cache follows the key and does not leak credentials or stale account data', async (t) => {
    const dir = directory(t);
    let calls = 0,
      now = 1800000000000;
    const file = path.join(dir, 'deepseek.json');
    const market = new Market(dir, {
      now: () => now,
      fetcher: async (url, options) => {
        calls++;
        assert.equal(url, 'https://api.deepseek.com/user/balance');
        if (options.headers.Authorization === 'Bearer different-key')
          return new Response('', {status: 401});
        return Response.json({
          balance_infos: [{currency: 'USD', total_balance: '12.3456', secret: 'not-public'}]
        });
      }
    });
    assert.equal((await market.credit(dir)).state, 'unconfigured');
    fs.writeFileSync(file, JSON.stringify({key: 'test-only-key'}));
    const [a, b] = await Promise.all([market.credit(dir), market.credit(dir)]);
    assert.equal(calls, 1);
    assert.deepEqual(a, b);
    assert.equal(a.balances[0].amount, '12.3456');
    assert.equal(JSON.stringify(a).includes('secret'), false);
    fs.writeFileSync(file, JSON.stringify({key: 'different-key'}));
    assert.deepEqual(await market.credit(dir), {state: 'error'});
    assert.equal(calls, 2);
    fs.writeFileSync(file, '{}');
    assert.deepEqual(await market.credit(dir), {state: 'unconfigured'});
  });
  test('cost range includes cache and peak variation; missing or invalid usage is never zero-filled', () => {
    assert.deepEqual(estimate('deepseek-flash', usage), {low: 0.6765, high: 1.353});
    const noCache = {...usage};
    delete noCache.prompt_cache_hit_tokens;
    assert.deepEqual(estimate('deepseek-flash', noCache), {low: 0.603, high: 1.5});
    assert.equal(estimate('unknown-model', usage), null);
    assert.equal(normalizeUsage({total_tokens: 2}), null);
    assert.equal(normalizeUsage({...usage, prompt_tokens: -1}), null);
    assert.equal(
      normalizeUsage({...usage, prompt_cache_hit_tokens: 2000000}).prompt_cache_hit_tokens,
      undefined
    );
  });
  test('in-flight credit responses cannot expose a removed or replaced account', async (t) => {
    const dir = directory(t),
      file = path.join(dir, 'deepseek.json');
    let release;
    const market = new Market(dir, {
      fetcher: () =>
        new Promise((resolve) => {
          release = resolve;
        })
    });
    const reply = () =>
      release(Response.json({balance_infos: [{currency: 'USD', total_balance: '12'}]}));
    for (const replacement of ['', 'new-key']) {
      fs.writeFileSync(file, JSON.stringify({key: 'old-key'}));
      market.creditCache = undefined;
      const first = market.credit(dir),
        second = market.credit(dir);
      fs.writeFileSync(file, JSON.stringify({key: replacement}));
      reply();
      for (const result of await Promise.all([first, second]))
        assert.deepEqual(result, {state: replacement ? 'error' : 'unconfigured'});
    }
  });
  test('usage persists through explicit retries, topic deletion and restart; replays add no expense', (t) => {
    const dir = directory(t),
      store = new ChatStore(dir),
      file = path.join(dir, 'chat.sqlite');
    let job = newJob(store);
    store.recordUsage(job, usage);
    store.finish(job, {status: 'error', content: 'partial'});
    const requestId = job.id;
    const replay = store.begin({
      topic: job.topic,
      version: 0,
      text: 'test',
      model: 'deepseek-flash',
      requestId
    });
    assert.equal(replay.replay, true);
    job = store.begin({requestId, version: store.topic(job.topic).version}, true);
    store.finish(job, {content: 'done', usage});
    let all = usageSnapshot(file).periods.find((p) => p.id === 'all').providers[0];
    assert.equal(all.requests, 2);
    assert.equal(all.measured, 2);
    assert.equal(all.tokens, 4000000);
    assert.equal(all.low, 1.353);
    store.change({action: 'delete', id: job.topic, version: store.topic(job.topic).version});
    store.close();
    const again = new ChatStore(dir);
    again.recover();
    again.close();
    all = usageSnapshot(file).periods.find((p) => p.id === 'all').providers[0];
    assert.equal(all.requests, 2);
  });
  test('FlowMusic resume counts one logical request and never invents monetary charges', (t) => {
    const dir = directory(t),
      store = new ChatStore(dir);
    let job = newJob(store, 'flowmusic');
    store.finish(job, {status: 'error'});
    job = store.begin({requestId: job.id, version: store.topic(job.topic).version}, true);
    store.finish(job, {content: 'done'});
    const all = usageSnapshot(path.join(dir, 'chat.sqlite')).periods.at(-1).providers[0];
    assert.equal(all.requests, 1);
    assert.equal(all.priced, 0);
    assert.equal(all.measured, 0);
    store.close();
  });
  test('pre-upgrade usage migrates once without applying present prices to the past', (t) => {
    const dir = directory(t);
    let store = new ChatStore(dir);
    const job = newJob(store);
    store.finish(job, {content: 'old', usage});
    store.db.exec('DROP TABLE ai_usage');
    store.close();
    store = new ChatStore(dir);
    store.close();
    store = new ChatStore(dir);
    store.close();
    const all = usageSnapshot(path.join(dir, 'chat.sqlite')).periods.at(-1).providers[0];
    assert.equal(all.requests, 1);
    assert.equal(all.tokens, 2000000);
    assert.equal(all.priced, 0);
  });
  test('reported usage is saved even when DeepSeek stream truncates after it', async () => {
    let received;
    await assert.rejects(
      complete({
        key: 'test',
        model: 'deepseek-flash',
        maxTokens: 4096,
        messages: [],
        onDelta: () => {},
        onUsage: (u) => (received = u),
        fetcher: async () => new Response('data: ' + JSON.stringify({usage}) + '\n\n')
      })
    );
    assert.deepEqual(received, usage);
  });
  test('Balance insights work without the optional Chat module or any account mutations', async (t) => {
    const dir = directory(t),
      file = path.join(dir, 'balance', 'ledger.sqlite');
    const mod = createModule(file, {
      chatDirectory: path.join(dir, 'chat'),
      fetcher: async (url) =>
        url.includes('cbr.ru') ? new Response(xml) : Response.json(crypto(Date.now()))
    });
    t.after(() => mod.close());
    const get = async (route) =>
      (await mod.handle({request: {method: 'GET'}, path: route, user: {username: 'test'}})).json();
    assert.equal((await get('/ai')).available, false);
    assert.equal((await get('/credit')).state, 'unconfigured');
    assert.equal((await get('/rates')).fiat.prices.KZT, 0.2);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(path.join(dir, 'chat')), false);
  });
  test('rolling periods exclude old/future requests and interrupted calls remain visibly unmeasured', (t) => {
    const dir = directory(t),
      store = new ChatStore(dir),
      now = Date.now();
    const old = newJob(store);
    store.finish(old, {content: 'old', usage});
    store.db
      .prepare('UPDATE ai_usage SET created=? WHERE id=?')
      .run(now - 2 * 86400000, old.usageId);
    const current = newJob(store);
    store.recover();
    const future = newJob(store);
    store.finish(future, {content: 'future', usage});
    store.db.prepare('UPDATE ai_usage SET created=? WHERE id=?').run(now + 100000, future.usageId);
    const data = usageSnapshot(path.join(dir, 'chat.sqlite'), now + 1000);
    const day = data.periods.find((p) => p.id === 'day').providers[0],
      month = data.periods.find((p) => p.id === 'month').providers[0];
    assert.equal(day.requests, 1);
    assert.equal(day.priced, 0);
    assert.equal(day.running, 0);
    assert.equal(month.requests, 2);
    assert.equal(month.priced, 1);
    store.close();
  });
  test('new insight routes require login; key writes enforce Origin and all responses are private', async (t) => {
    const {createApp} = await import('../02-hub/src/server.mjs'),
      {passwordHash} = await import('../02-hub/src/auth.mjs');
    const dir = directory(t),
      mod = createModule(path.join(dir, 'balance', 'ledger.sqlite'), {
        chatDirectory: path.join(dir, 'chat'),
        fetcher: async (url) =>
          url.includes('cbr.ru') ? new Response(xml) : Response.json(crypto(Date.now()))
      });
    const config = {
      username: 'admin',
      origin: 'https://hub.example.com',
      ...(await passwordHash('test-password-12345'))
    };
    const app = createApp({
      config,
      modules: new Map([['balance', {id: 'balance', title: 'Плутос', ...mod}]])
    });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    t.after(async () => {
      app.closeAllConnections();
      await new Promise((r) => app.close(r));
      mod.close();
    });
    const base = 'http://127.0.0.1:' + app.address().port;
    for (const route of ['rates', 'ai', 'credit', 'market-config'])
      assert.equal(
        (await fetch(base + '/modules/balance/' + route, {redirect: 'manual'})).status,
        303
      );
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      redirect: 'manual',
      headers: {Origin: config.origin, 'Content-Type': 'application/x-www-form-urlencoded'},
      body: 'username=admin&password=test-password-12345'
    });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    const request = {
      method: 'POST',
      headers: {Cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json'},
      body: JSON.stringify({key: 'test-only-demo-key'})
    };
    assert.equal((await fetch(base + '/modules/balance/market-config', request)).status, 403);
    request.headers.Origin = config.origin;
    const saved = await fetch(base + '/modules/balance/market-config', request);
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), {configured: true});
    for (const route of ['rates', 'ai', 'credit', 'market-config']) {
      const response = await fetch(base + '/modules/balance/' + route, {headers: {Cookie}});
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.text()).includes('test-only-demo-key'), false);
    }
  });
}

// 02-hub/tests/pulse
{
  const {mkdtempSync, writeFileSync, rmSync} = await import('node:fs');
  const {createHandler} = await import('../02-hub/modules/pulse/index.mjs');
  const {createApp} = await import('../02-hub/src/server.mjs');
  const {passwordHash} = await import('../02-hub/src/auth.mjs');
  const snapshot = {
    schema: 1,
    generated_at: 100000,
    server: {hostname: 'test'},
    disks: [],
    network: []
  };
  function fixture(t) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'pulse-'));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    return path.join(directory, 'pulse.json');
  }
  const input = (route, method = 'GET') => ({
    request: {method},
    path: route,
    user: {username: 'admin'}
  });
  test('pulse reports freshness, old snapshots and future clock skew', async (t) => {
    const file = fixture(t);
    writeFileSync(file, JSON.stringify(snapshot));
    for (const [now, stale] of [
      [110000, false],
      [125000, true],
      [80000, true]
    ]) {
      const response = await createHandler(file, () => now)(input('/api'));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).stale, stale);
    }
  });
  test('pulse fails clearly on missing, corrupt and oversized snapshots', async (t) => {
    const file = fixture(t),
      handle = createHandler(file);
    assert.equal((await handle(input('/api'))).status, 503);
    for (const content of ['not json', '{}', 'x'.repeat(524289)]) {
      writeFileSync(file, content);
      assert.equal((await handle(input('/api'))).status, 503);
    }
  });
  test('pulse exposes only fixed read-only routes', async (t) => {
    const handle = createHandler(fixture(t));
    for (const route of ['/', '/pulse.css', '/pulse.js'])
      assert.equal((await handle(input(route))).status, 200);
    for (const route of ['/../../config/auth.json', '/manifest.json', '/run'])
      assert.equal((await handle(input(route))).status, 404);
    assert.equal((await handle(input('/api', 'POST'))).status, 405);
    assert.match(await (await handle(input('/'))).text(), /Атлас/);
  });
  test('pulse routes require login; only static assets permit private revalidation', async (t) => {
    const file = fixture(t);
    writeFileSync(file, JSON.stringify({...snapshot, generated_at: Date.now()}));
    const config = {
      username: 'admin',
      origin: 'https://hub.example.com',
      ...(await passwordHash('test-password-123'))
    };
    const app = createApp({
      config,
      modules: new Map([
        ['pulse', {id: 'pulse', title: 'Атлас', description: 'test', handle: createHandler(file)}]
      ])
    });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      app.closeAllConnections();
      await new Promise((resolve) => app.close(resolve));
    });
    const base = `http://127.0.0.1:${app.address().port}`;
    const login = await fetch(base + '/api/auth/login', {
      redirect: 'manual',
      method: 'POST',
      headers: {Origin: config.origin, 'Content-Type': 'application/x-www-form-urlencoded'},
      body: 'username=admin&password=test-password-123'
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    for (const route of ['/', '/api', '/pulse.css', '/pulse.js']) {
      const denied = await fetch(base + '/modules/pulse' + route, {redirect: 'manual'});
      assert.equal(denied.status, 303);
      assert.equal(denied.headers.get('location'), '/login');
      const response = await fetch(base + '/modules/pulse' + route, {headers: {Cookie: cookie}});
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get('cache-control'),
        /\.(css|js)$/.test(route) ? 'private, no-cache' : 'no-store'
      );
    }
    const dashboard = await (await fetch(base, {headers: {Cookie: cookie}})).text();
    assert.match(dashboard, /href="\/modules\/pulse\/"/);
  });

  test('pulse card reports resource values and preserves missing or stale data', async (t) => {
    const {createSummary} = await import('../02-hub/modules/pulse/index.mjs');
    const file = fixture(t);
    let now = 100000;
    const summary = createSummary(createHandler(file, () => now));
    assert.deepEqual(await summary(), {state: 'stale', items: []});
    writeFileSync(
      file,
      JSON.stringify({
        ...snapshot,
        cpu: {percent: 12.4},
        memory: {percent: 40},
        disks: [{mount: '/', percent: 33}]
      })
    );
    assert.deepEqual(await summary(), {
      state: 'ok',
      items: [
        {label: 'CPU', value: '12%'},
        {label: 'RAM', value: '40%'},
        {label: 'Диск', value: '33%'}
      ]
    });
    now += 21000;
    assert.equal((await summary()).state, 'stale');
  });
}

// 02-hub/tests/server
{
  const {mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync} = await import('node:fs');
  const {passwordHash, Sessions, validateAuth, authIdentity} = await import(
    '../02-hub/src/auth.mjs'
  );
  const {createApp} = await import('../02-hub/src/server.mjs');
  const {loadModules} = await import('../02-hub/src/modules.mjs');
  const password = 'correct-password-123';
  const config = {
    username: 'admin',
    origin: 'https://hub.example.com',
    ...(await passwordHash(password))
  };
  async function setup(t, options = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nexus-hub-'));
    const app = createApp({config, sessionsFile: path.join(dir, 'sessions.json'), ...options});
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      app.closeAllConnections();
      await new Promise((resolve) => app.close(resolve));
      rmSync(dir, {recursive: true, force: true});
    });
    const base = `http://127.0.0.1:${app.address().port}`;
    const request = (route, options = {}) => fetch(base + route, {redirect: 'manual', ...options});
    const signin = (pass = password, origin = config.origin) =>
      request('/api/auth/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: origin},
        body: new URLSearchParams({username: 'admin', password: pass})
      });
    return {request, signin, dir};
  }
  const cookie = (response) => response.headers.get('set-cookie').split(';')[0];

  test('image cache revalidates behind authentication and invalidates changed bytes', async (t) => {
    let bytes = 'first-image';
    const handle = ({path: route}) =>
      new Response(route.startsWith('/cover/') ? bytes : '{}', {
        headers: {'Content-Type': route.startsWith('/cover/') ? 'image/png' : 'application/json'}
      });
    const {request, signin} = await setup(t, {
      modules: new Map([['anime', {id: 'anime', title: 'Дионис', handle}]])
    });
    const session = cookie(await signin());
    const route = '/modules/anime/cover/1';
    const first = await request(route, {headers: {Cookie: session}});
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'private, no-cache');
    assert.equal(first.headers.get('vary'), 'Cookie');
    const etag = first.headers.get('etag');
    assert.ok(etag);
    assert.equal(await first.text(), bytes);
    const headers = {Cookie: session, 'If-None-Match': etag};
    const same = await request(route, {headers});
    assert.equal(same.status, 304);
    assert.equal(await same.text(), '');
    const denied = await request(route, {headers: {'If-None-Match': etag}});
    assert.equal(denied.status, 303);
    assert.equal(denied.headers.get('etag'), null);
    bytes = 'changed-image';
    const changed = await request(route, {headers});
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), etag);
    assert.equal(await changed.text(), bytes);
    const api = await request('/modules/anime/api', {headers});
    assert.equal(api.status, 200);
    assert.equal(api.headers.get('cache-control'), 'no-store');
    assert.equal(api.headers.get('etag'), null);
  });
  test('unknown and repeated logout tokens do not write session storage', () => {
    const sessions = new Sessions();
    const token = sessions.create();
    let writes = 0;
    const commit = sessions.commit.bind(sessions);
    sessions.commit = (entries) => {
      writes++;
      commit(entries);
    };
    for (const value of [undefined, '', 'invalid', '0'.repeat(64)]) sessions.revoke(value);
    assert.equal(writes, 0);
    assert.equal(sessions.valid(token), true);
    sessions.revoke(token);
    sessions.revoke(token);
    assert.equal(writes, 1);
    assert.equal(sessions.valid(token), false);
  });

  test('private pages and APIs require login', async (t) => {
    const {request} = await setup(t);
    for (const route of ['/', '/modules/chat/', '/settings/', '/settings/?module=signal']) {
      const r = await request(route);
      assert.equal(r.status, 303);
      assert.equal(r.headers.get('location'), '/login');
    }
    for (const route of ['/api/health', '/api/modules']) {
      const r = await request(route);
      assert.equal(r.status, 401);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
  });
  test('login and PWA assets are public; no chat shortcuts', async (t) => {
    const {request} = await setup(t);
    const text = await (await request('/login')).text();
    assert.match(text, /autocomplete="current-password"/);
    assert.match(text, /rel="manifest"/);
    assert.doesNotMatch(text, /user-scalable=no|fonts.googleapis/);
    const manifest = await (await request('/manifest.json')).json();
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.shortcuts, undefined);
    assert.deepEqual(
      manifest.icons.map((icon) => icon.sizes),
      ['192x192', '512x512', 'any']
    );
    assert.equal((await request('/sw.js')).headers.get('cache-control'), 'no-cache');
  });
  test('cookies are secure and tokens are not stored raw', async (t) => {
    const {request, signin, dir} = await setup(t);
    const response = await signin();
    assert.equal(response.status, 303);
    assert.match(response.headers.get('set-cookie'), /^__Host-nexus_session=/);
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/'])
      assert.ok(response.headers.get('set-cookie').includes(flag));
    const session = cookie(response);
    assert.equal((await request('/', {headers: {Cookie: session}})).status, 200);
    assert.equal((await request('/api/health', {headers: {Cookie: session}})).status, 200);
    assert.ok(
      !readFileSync(path.join(dir, 'sessions.json'), 'utf8').includes(session.split('=')[1])
    );
  });
  test('incorrect credentials and forged origins are rejected', async (t) => {
    const {signin} = await setup(t);
    assert.equal((await signin('incorrect')).status, 401);
    assert.equal((await signin(password, 'https://evil.example')).status, 403);
    assert.equal((await signin(password, '')).status, 403);
  });
  test('logout revokes tokens across restart; csrf cannot log out', async (t) => {
    const {request, signin, dir} = await setup(t);
    const session = cookie(await signin());
    assert.equal(
      (
        await request('/api/auth/logout', {
          method: 'POST',
          headers: {Cookie: session, Origin: 'https://evil.example'}
        })
      ).status,
      403
    );
    assert.equal((await request('/api/health', {headers: {Cookie: session}})).status, 200);
    const response = await request('/api/auth/logout', {
      method: 'POST',
      headers: {Cookie: session, Origin: config.origin}
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await request('/api/health', {headers: {Cookie: session}})).status, 401);
    assert.equal(
      new Sessions(path.join(dir, 'sessions.json'), authIdentity(config)).valid(
        session.split('=')[1]
      ),
      false
    );
  });
  test('sessions survive restart and password changes invalidate them', async (t) => {
    const {signin, dir} = await setup(t);
    const token = cookie(await signin()).split('=')[1];
    assert.ok(new Sessions(path.join(dir, 'sessions.json'), authIdentity(config)).valid(token));
    assert.equal(
      new Sessions(path.join(dir, 'sessions.json'), 'different-password').valid(token),
      false
    );
  });
  test('bad passwords are rate limited', async (t) => {
    const {signin} = await setup(t);
    for (let i = 0; i < 10; i++) assert.equal((await signin('wrong')).status, 401);
    const blocked = await signin();
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get('retry-after'));
  });
  test('oversized login and unsupported content types are rejected', async (t) => {
    const {request} = await setup(t);
    assert.equal(
      (
        await request('/api/auth/login', {
          method: 'POST',
          headers: {Origin: config.origin, 'Content-Type': 'application/x-www-form-urlencoded'},
          body: 'x'.repeat(9000)
        })
      ).status,
      413
    );
    assert.equal(
      (
        await request('/api/auth/login', {
          method: 'POST',
          headers: {Origin: config.origin, 'Content-Type': 'application/json'},
          body: '{}'
        })
      ).status,
      415
    );
  });
  test('empty shell has no built-in chat or functional modules', async (t) => {
    const {request, signin} = await setup(t);
    const headers = {Cookie: cookie(await signin())};
    const text = await (await request('/', {headers})).text();
    assert.match(text, /Пока нет модулей/);
    assert.doesNotMatch(text, /href="\/chat"/);
    assert.deepEqual(await (await request('/api/modules', {headers})).json(), {modules: []});
    assert.equal((await request('/chat', {headers})).status, 404);
  });
  test('modules share auth and cannot issue platform cookies', async (t) => {
    const modules = new Map([
      [
        'example',
        {
          id: 'example',
          title: '<script>alert(1)</script>',
          description: 'test',
          handle: async ({path, user}) =>
            new Response(JSON.stringify({path, username: user.username}), {
              headers: {
                'Content-Type': 'application/json',
                'Set-Cookie': 'injected=1',
                'Cache-Control': 'public'
              }
            })
        }
      ]
    ]);
    const {request, signin} = await setup(t, {modules});
    const headers = {Cookie: cookie(await signin())};
    const text = await (await request('/', {headers})).text();
    assert.match(text, /&lt;script&gt;/);
    assert.doesNotMatch(text, /<script>alert/);
    assert.equal((await request('/modules/example/')).status, 303);
    const response = await request('/modules/example/hello?x=1', {headers});
    assert.deepEqual(await response.json(), {path: '/hello', username: 'admin'});
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(
      (
        await request('/modules/example/', {
          method: 'POST',
          headers: {...headers, Origin: 'https://evil.example'}
        })
      ).status,
      403
    );
  });
  test('discovery loads valid entries and skips disabled ones', async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nexus-modules-'));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    for (const [id, enabled] of [
      ['example', true],
      ['disabled', false]
    ]) {
      mkdirSync(path.join(dir, id));
      writeFileSync(
        path.join(dir, id, 'manifest.json'),
        JSON.stringify({apiVersion: 1, title: id, description: 'test', enabled})
      );
      writeFileSync(
        path.join(dir, id, 'index.mjs'),
        'export async function handle(){ return new Response("module"); } export async function summary(){return {state:"ok",items:[]};} export const settings={title:"Example",content:"<p>Options</p>"};'
      );
    }
    const modules = await loadModules(dir);
    assert.deepEqual([...modules.keys()], ['example']);
    assert.equal(typeof modules.get('example').summary, 'function');
    assert.equal(modules.get('example').settings.title, 'Example');
  });
  test('a failed module startup is isolated and cleaned up before serving the hub', async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nexus-start-'));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    for (const id of ['broken', 'healthy']) {
      mkdirSync(path.join(dir, id));
      writeFileSync(
        path.join(dir, id, 'manifest.json'),
        JSON.stringify({apiVersion: 1, title: id, description: '', enabled: true})
      );
      writeFileSync(
        path.join(dir, id, 'index.mjs'),
        `
      import fs from 'node:fs';
      let ready = false;
      export function start() { ${id === 'broken' ? 'throw new Error("private config detail");' : 'ready = true;'} }
      export function close() { fs.writeFileSync(new URL('./closed', import.meta.url), 'closed'); }
      export function handle() { return new Response(ready ? 'ready' : 'not started'); }
    `
      );
    }
    const messages = [];
    t.mock.method(console, 'error', (...args) => messages.push(args.join(' ')));
    const modules = await loadModules(dir, {start: true});
    assert.deepEqual([...modules.keys()], ['healthy']);
    assert.equal(readFileSync(path.join(dir, 'broken/closed'), 'utf8'), 'closed');
    assert.deepEqual(messages, ['Module not loaded: broken']);
    const {request, signin} = await setup(t, {modules});
    assert.equal((await request('/login')).status, 200);
    const response = await request('/modules/healthy/', {
      headers: {Cookie: cookie(await signin())}
    });
    assert.equal(await response.text(), 'ready');
  });
  test('invalid auth configuration fails closed', () => {
    assert.throws(() => validateAuth({...config, hash: ''}));
    assert.throws(() => validateAuth({...config, origin: 'http://example.com'}));
    assert.throws(() => validateAuth({...config, origin: 'https://example.com/path'}));
  });

  test('service worker changes when cached assets change and stays stable otherwise', async (t) => {
    const {cpSync} = await import('node:fs');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nexus-assets-'));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    cpSync(new URL('../02-hub/public', import.meta.url), dir, {recursive: true});
    const first = await setup(t, {publicDir: dir});
    const worker = await (await first.request('/sw.js')).text();
    assert.doesNotMatch(worker, /__ASSET_HASH__/);
    assert.match(worker, /nexus404-shell-[a-f0-9]{20}/);
    const same = await setup(t, {publicDir: dir});
    assert.equal(await (await same.request('/sw.js')).text(), worker);
    writeFileSync(
      dir + '/app.css',
      readFileSync(dir + '/app.css', 'utf8') + '\nhtml{--revision:2}\n'
    );
    const changed = await setup(t, {publicDir: dir});
    assert.notEqual(await (await changed.request('/sw.js')).text(), worker);
  });
  test('installer and module loader use strict manifest validation', async () => {
    const {validateManifest} = await import('../02-hub/src/modules.mjs');
    const manifest = {apiVersion: 1, title: 'Example', description: '', enabled: false};
    assert.equal(validateManifest(manifest), manifest);
    for (const invalid of [
      null,
      {...manifest, title: ' '},
      {...manifest, enabled: 'false'},
      {...manifest, enabled: undefined}
    ])
      assert.throws(() => validateManifest(invalid));
  });
  test('malformed push payload still produces a generic notification', async () => {
    const {runInNewContext} = await import('node:vm');
    const handlers = {},
      notices = [];
    runInNewContext(readFileSync(new URL('../02-hub/public/sw.js', import.meta.url), 'utf8'), {
      self: {
        addEventListener: (name, handler) => {
          handlers[name] = handler;
        },
        registration: {
          showNotification: async (title, options) => notices.push({title, ...options})
        }
      },
      URL
    });
    for (const value of [null, [], 'bad', 123]) {
      let pending;
      handlers.push({
        data: {json: () => value},
        waitUntil: (p) => {
          pending = p;
        }
      });
      await pending;
    }
    assert.equal(notices.length, 4);
    assert.ok(notices.every((n) => n.title === 'NEXUS404 · Гермес'));
  });

  test('dashboard summaries require login, isolate errors and omit private plugin fields', async (t) => {
    let calls = 0;
    const modules = new Map([
      [
        'live',
        {
          id: 'live',
          title: 'Live',
          description: 'test',
          summary: async () => {
            calls++;
            return {state: 'ok', items: [{label: 'CPU', value: '12%'}], secret: 'private'};
          }
        }
      ],
      [
        'broken',
        {
          id: 'broken',
          title: 'Broken',
          description: 'test',
          summary: async () => {
            throw new Error('private error');
          }
        }
      ],
      ['legacy', {id: 'legacy', title: 'Legacy', description: 'test'}]
    ]);
    const {request, signin} = await setup(t, {modules});
    assert.equal((await request('/api/modules')).status, 401);
    assert.equal(calls, 1); // Prepared on server startup, not by the anonymous request.
    const headers = {Cookie: cookie(await signin())};
    const response = await request('/api/modules', {headers}),
      data = await response.json();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(data.modules[0].summary, {state: 'ok', items: [{label: 'CPU', value: '12%'}]});
    assert.deepEqual(data.modules[1].summary, {state: 'stale', items: []});
    assert.equal(data.modules[2].summary, undefined);
    assert.doesNotMatch(JSON.stringify(data), /private/);
    await Promise.all(Array.from({length: 10}, () => request('/api/modules', {headers})));
    assert.equal(calls, 1);
    assert.equal((await request('/dashboard.json', {headers})).status, 404);
    const html = await (await request('/', {headers})).text();
    assert.doesNotMatch(html, /module-open|открыть/);
    assert.match(html, /data-summary="live"/);
  });
  test('successful module writes refresh the prepared dashboard without waiting for its interval', async (t) => {
    let count = 1,
      calls = 0;
    const module = {
      id: 'balance',
      title: 'Плутос',
      description: '',
      summary: () => {
        calls++;
        return {state: 'ok', items: [{label: 'Сумма', value: count}]};
      },
      handle: async () => {
        count = 2;
        return Response.json({ok: true});
      }
    };
    const {request, signin} = await setup(t, {modules: new Map([['balance', module]])});
    const headers = {
      Cookie: cookie(await signin()),
      Origin: config.origin,
      'Content-Type': 'application/json'
    };
    const before = await (await request('/api/modules', {headers})).json();
    assert.equal(before.modules[0].summary.items[0].value, '1');
    assert.equal(
      (await request('/modules/balance/change', {method: 'POST', headers, body: '{}'})).status,
      200
    );
    const after = await (await request('/api/modules', {headers})).json();
    assert.equal(after.modules[0].summary.items[0].value, '2');
    assert.equal(calls, 2);
  });

  test('unresponsive module summary times out and receives cancellation', async () => {
    const {moduleSummary} = await import('../02-hub/src/modules.mjs');
    let aborted = false;
    const result = await moduleSummary(
      {
        summary: ({signal}) =>
          new Promise(() =>
            signal.addEventListener('abort', () => {
              aborted = true;
            })
          )
      },
      10
    );
    assert.deepEqual(result, {state: 'stale', items: []});
    assert.ok(aborted);
  });

  test('settings render the selected module or core appearance settings, including an empty hub', async (t) => {
    const modules = new Map([
      [
        'first',
        {
          id: 'first',
          title: 'Первый',
          settings: {title: '<Первый>', content: '<p id="first-settings">First</p>'}
        }
      ],
      [
        'second',
        {
          id: 'second',
          title: 'Второй',
          settings: {title: 'Второй', content: '<p id="second-settings">Second</p>'}
        }
      ],
      ['legacy', {id: 'legacy', title: 'Прежний'}]
    ]);
    const {request, signin} = await setup(t, {modules});
    const headers = {Cookie: cookie(await signin())};
    const second = await (await request('/settings/?module=second', {headers})).text();
    assert.match(second, /id="second-settings"/);
    assert.doesNotMatch(second, /id="first-settings"/);
    assert.match(second, /&lt;Первый&gt;/);
    assert.doesNotMatch(second, /Прежний/);
    const fallback = await (await request('/settings/?module=missing', {headers})).text();
    assert.match(fallback, /id="introEnabled"/);
    modules.clear();
    const empty = await (await request('/settings/', {headers})).text();
    assert.match(empty, /id="introEnabled"/);
    const home = await (await request('/', {headers})).text();
    assert.match(home, /href="\/settings\/"/);
    assert.doesNotMatch(home, /module-mark/);
  });
}

// 02-hub/tests/signal
{
  const {createHandler, settings: signalSettings} = await import(
    '../02-hub/modules/signal/index.mjs'
  );
  const {createApp} = await import('../02-hub/src/server.mjs');
  const {passwordHash} = await import('../02-hub/src/auth.mjs');
  const sub = {
    endpoint: 'https://fcm.googleapis.com/wp/example',
    keys: {
      p256dh:
        'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg'
    }
  };
  async function setup(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-api-'));
    const config = {
      username: 'admin',
      origin: 'https://hub.example.com',
      ...(await passwordHash('test-password-123'))
    };
    fs.writeFileSync(dir + '/auth.json', JSON.stringify(config));
    fs.writeFileSync(dir + '/public.json', JSON.stringify({publicKey: 'public'}));
    const handle = createHandler({
      file: dir + '/settings.json',
      feed: dir + '/feed.json',
      publicFile: dir + '/public.json',
      authFile: dir + '/auth.json'
    });
    const app = createApp({
      config,
      auditFile: dir + '/auth-events.jsonl',
      modules: new Map([
        [
          'signal',
          {id: 'signal', title: 'Гермес', description: 'test', handle, settings: signalSettings}
        ]
      ])
    });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    t.after(async () => {
      app.closeAllConnections();
      await new Promise((r) => app.close(r));
      fs.rmSync(dir, {recursive: true, force: true});
    });
    const base = 'http://127.0.0.1:' + app.address().port;
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      redirect: 'manual',
      headers: {Origin: config.origin, 'Content-Type': 'application/x-www-form-urlencoded'},
      body: 'username=admin&password=test-password-123'
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const request = (route, data, headers = {}) =>
      fetch(base + '/modules/signal' + route, {
        method: data === undefined ? 'GET' : 'POST',
        redirect: 'manual',
        headers: {
          Cookie: cookie,
          Origin: config.origin,
          'Content-Type': 'application/json',
          ...headers
        },
        body: data === undefined ? undefined : JSON.stringify(data)
      });
    return {dir, request, base, config, cookie};
  }
  test('signal subscription is protected, private and revocable', async (t) => {
    const {request, dir} = await setup(t);
    let r = await request('/subscribe', {name: 'Phone', subscription: sub});
    assert.equal(r.status, 200);
    const {id} = await r.json();
    assert.equal(fs.statSync(dir + '/settings.json').mode & 0o777, 0o600);
    const response = await request('/api');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json();
    assert.equal(data.devices[0].id, id);
    assert.ok(!JSON.stringify(data).includes(sub.endpoint));
    assert.ok(!JSON.stringify(data).includes(sub.keys.auth));
    assert.equal((await request('/unsubscribe', {id})).status, 200);
    assert.equal((await (await request('/api')).json()).devices.length, 0);
  });
  test('signal refuses anonymous access and forged origins', async (t) => {
    const {request, base} = await setup(t);
    assert.equal((await fetch(base + '/modules/signal/api', {redirect: 'manual'})).status, 303);
    assert.equal(
      (await request('/subscribe', {subscription: sub}, {Origin: 'https://evil.test'})).status,
      403
    );
    assert.equal((await request('/subscribe', {subscription: sub}, {Cookie: ''})).status, 401);
  });
  test('signal rejects SSRF subscription and path traversal', async (t) => {
    const {request} = await setup(t);
    assert.equal(
      (await request('/subscribe', {subscription: {...sub, endpoint: 'https://127.0.0.1/'}}))
        .status,
      400
    );
    assert.equal((await request('/settings.json')).status, 404);
    assert.equal((await request('/test', {id: 'missing'})).status, 400);
  });
  test('push test is queued and limited to one per thirty seconds', async (t) => {
    const {request, dir} = await setup(t);
    const {id} = await (await request('/subscribe', {subscription: sub})).json();
    assert.equal((await request('/test', {id})).status, 200);
    assert.equal((await request('/test', {id})).status, 429);
    assert.ok(JSON.parse(fs.readFileSync(dir + '/settings.json')).devices[0].testAt > 0);
  });
  test('settings save only known categories and valid schedule', async (t) => {
    const {request} = await setup(t);
    const config = {
      categories: {
        resources: false,
        services: true,
        security: true,
        maintenance: true,
        recovery: true,
        summary: false,
        achievements: true
      },
      dailyTime: '22:30',
      detailOnLockScreen: true
    };
    assert.equal((await request('/settings', config)).status, 200);
    assert.deepEqual((await (await request('/api')).json()).settings, config);
    assert.equal((await request('/settings', {...config, dailyTime: '24:30'})).status, 400);
  });
  test('auth event excludes passwords and HTTP credentials', async (t) => {
    const {dir} = await setup(t);
    const text = fs.readFileSync(dir + '/auth-events.jsonl', 'utf8');
    assert.match(text, /security.hub.login_new/);
    assert.doesNotMatch(text, /test-password-123|hash|cookie/i);
  });

  test('signal settings moved to the protected central page, preserving old links', async (t) => {
    const {request, base, cookie} = await setup(t);
    const home = await (await request('/')).text();
    assert.match(home, /id="signalEvents"/);
    assert.doesNotMatch(home, /signal-settings-card|id="signalSettings"|id="deviceName"/);
    const old = await request('/settings/');
    assert.equal(old.status, 303);
    assert.equal(old.headers.get('location'), '/settings/?module=signal');
    const response = await fetch(base + '/settings/?module=signal', {headers: {Cookie: cookie}});
    const settings = await response.text();
    assert.match(settings, /id="signalSettings"/);
    assert.match(settings, /id="deviceName"/);
    assert.doesNotMatch(settings, /id="signalEvents"/);
    const denied = await fetch(base + '/settings/', {redirect: 'manual'});
    assert.equal(denied.status, 303);
    assert.equal(denied.headers.get('location'), '/login');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
  test('signal card shows warnings and active device count without subscription secrets', async (t) => {
    const {createSummary} = await import('../02-hub/modules/signal/index.mjs');
    const {request, dir} = await setup(t);
    const {id} = await (await request('/subscribe', {name: 'Phone', subscription: sub})).json();
    fs.writeFileSync(
      dir + '/feed.json',
      JSON.stringify({
        updatedAt: Date.now(),
        active: [{key: 'disk'}],
        events: [],
        devices: [{id, expired: false}]
      })
    );
    const summary = createSummary(async () => request('/api'));
    assert.deepEqual(await summary(), {
      state: 'warning',
      items: [
        {label: 'Тревоги', value: '1'},
        {label: 'За сутки', value: '0'},
        {label: 'Устройства', value: '1'}
      ]
    });
    fs.writeFileSync(
      dir + '/feed.json',
      JSON.stringify({updatedAt: 0, active: [], events: [], devices: []})
    );
    assert.equal((await summary()).state, 'stale');
  });
}

{
  const {moduleSummary} = await import('../02-hub/src/modules.mjs');
  test('module charts expose only bounded numeric points and known currency metadata', async () => {
    const input = {
      state: 'ok',
      items: [],
      chart: {currency: 'RUB', month: '2026-09', points: [-5, 0, 100], secret: 'private'}
    };
    const summarize = () => moduleSummary({summary: async () => input});
    assert.deepEqual((await summarize()).chart, {
      currency: 'RUB',
      month: '2026-09',
      points: [-5, 0, 100]
    });
    for (const points of [
      Array(32).fill(0),
      [NaN],
      [Infinity],
      ['100'],
      [],
      [Number.MAX_SAFE_INTEGER + 1]
    ]) {
      input.chart.points = points;
      assert.equal((await summarize()).chart, undefined);
    }
    input.chart.points = [0];
    input.chart.currency = '<script>';
    assert.equal((await summarize()).chart, undefined);
  });
}

// tests/trophies
{
  const {TrophiesStore} = await import('../02-hub/modules/trophies/store.mjs');
  const {Provider, steamId, timestamp} = await import('../02-hub/modules/trophies/providers.mjs');
  const {achievementEvents} = await import('../host/signal.mjs');
  function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-trophies-'));
    let now = Date.now();
    const f = {
      dir,
      requests: [],
      unlocked: false,
      hard: false,
      broken: false,
      games: 2,
      now: () => now,
      advance: () => (now += 3600001)
    };
    f.fetcher = async (url) => {
      f.requests.push(new URL(url));
      const p = url.pathname;
      if (f.broken) return new Response('{broken', {status: 200});
      let data;
      if (p.includes('GetPlayerSummaries')) data = {response:{players:[{steamid:'76561198000000000',personaname:'Player'}]}};
      else if (p.includes('GetOwnedGames'))
        data = {
          response: {
            game_count: f.games,
            games: Array.from({length: f.games}, (_, i) => ({
              appid: i + 1,
              name: 'Game ' + (i + 1)
            }))
          }
        };
      else if (p.includes('GetSchemaForGame'))
        data = {
          game: {
            gameName: 'Game',
            availableGameStats: {
              achievements: [{name: 'FIRST', displayName: 'First', description: 'Play'}]
            }
          }
        };
      else if (p.includes('GetPlayerAchievements'))
        data = {
          playerstats: {
            success: true,
            achievements: [
              {
                apiname: 'FIRST',
                achieved: Number(f.unlocked),
                unlocktime: f.unlocked ? Math.floor(now / 1000) : 0
              }
            ]
          }
        };
      else if (p.includes('GetGlobalAchievement'))
        data = {achievementpercentages: {achievements: [{name: 'FIRST', percent: '2.5'}]}};
      else if (p.includes('GetPlayerSummaries'))
        data = {response: {players: [{steamid: '76561198000000000', personaname: 'Player'}]}};
      else if (p.includes('GetUserProfile'))
        data = {ULID: '01J00000000000000000000000', User: 'Player'};
      else if (p.includes('GetUserCompletionProgress'))
        data = {
          Count: 1,
          Total: 1,
          Results: [
            {
              GameID: 1,
              Title: 'Retro Game',
              ImageIcon: '/Images/123.png',
              ConsoleName: 'NES',
              MaxPossible: 1,
              NumAwarded: Number(f.unlocked),
              NumAwardedHardcore: Number(f.hard)
            }
          ]
        };
      else if (p.includes('GetUserAwards'))
        data = {
          HiddenAwardsCount: 1,
          VisibleUserAwards: [
            {
              AwardType: 'Game Beaten',
              AwardData: 1,
              AwardDataExtra: 1,
              Title: 'Retro Game',
              AwardedAt: '2026-01-01T00:00:00Z'
            }
          ]
        };
      else if (p.includes('GetGameInfoAndUserProgress'))
        data = {
          ID: 1,
          NumAchievements: 1,
          NumDistinctPlayersCasual: 100,
          NumDistinctPlayersHardcore: 20,
          Achievements: {
            7: {
              ID: 7,
              Title: 'Rare',
              Description: 'Win',
              Points: 5,
              NumAwarded: 4,
              NumAwardedHardcore: 1,
              ...(f.unlocked ? {DateEarned: new Date(now).toISOString()} : {}),
              ...(f.hard ? {DateEarnedHardcore: new Date(now).toISOString()} : {})
            }
          }
        };
      else throw Error('Unexpected endpoint ' + p);
      return Response.json(data);
    };
    f.options = {now: f.now, fetcher: f.fetcher, sleep: async () => {}};
    f.store = new TrophiesStore(dir, f.options);
    f.store.load();
    f.account = {
      id: '76561198000000000',
      key: 'test-key-not-secret-12345',
      name: 'Player',
      connectedAt: now - 86400000
    };
    f.store.set('steam', {...f.account});
    t.after(async () => {
      await f.store.close();
      fs.rmSync(dir, {recursive: true, force: true});
    });
    return f;
  }
  test('trophies skips one inaccessible Steam game after verifying profile and retains the key', async (t) => {
    const f = fixture(t);
    f.games = 8;
    f.store.options.fetcher = async (url) =>
      url.pathname.includes('GetPlayerAchievements') && url.searchParams.get('appid') === '1'
        ? new Response('', {status: 403})
        : f.fetcher(url);
    await f.store.sync('steam');
    assert.ok(f.store.detail('steam', '1').error);
    assert.equal(f.store.detail('steam', '8').achievements.length, 1);
    assert.equal(f.store.snapshot().games.length, 8);
    assert.equal(f.store.config().steam.syncing, false);
    assert.match(f.store.config().steam.error, /Ключ сохранён/);
    assert.equal(f.store.account('steam').key, f.account.key);
    const directory = f.store.dir;
    await f.store.close();
    f.store = new TrophiesStore(directory, f.options);
    assert.equal(f.store.account('steam').key, f.account.key);
    assert.equal(f.store.config().steam.hasKey, true);
    f.store.options.fetcher = async () => new Response(null, {status: 403});
    await assert.rejects(f.store.connect('steam', f.account.id, 'new-invalid-key-123456'));
    assert.equal(f.store.account('steam').key, f.account.key);
  });
  test('trophies stops repeated game access denials without deleting the Steam key', async t => {
    const f=fixture(t);f.games=8;
    f.store.options.fetcher=async url=>url.pathname.includes('GetPlayerAchievements')?new Response(null,{status:403}):f.fetcher(url);
    await f.store.sync('steam');
    assert.match(f.store.config().steam.error,/три игры подряд/);
    assert.equal(f.store.account('steam').key,f.account.key);
    assert.equal(f.requests.filter(url=>url.pathname.includes('GetPlayerSummaries')).length,1);
    assert.equal(f.store.detail('steam','8').achievements.length,0);
  });
  test('trophies accepted sync survives the initiating request closing', async (t) => {
    const {createModule} = await import('../02-hub/modules/trophies/index.mjs');
    const {Readable} = await import('node:stream');
    const f = fixture(t);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const mod = createModule(f.dir + '/http', {
      ...f.options,
      fetcher: async (url) => {
        if (url.pathname.includes('GetOwnedGames')) await gate;
        return f.fetcher(url);
      }
    });
    t.after(() => mod.close());
    mod.store.load();
    mod.store.set('steam', {...f.account});
    const request = Readable.from([Buffer.from(JSON.stringify({provider: 'steam'}))]);
    request.method = 'POST';
    request.headers = {'content-type': 'application/json'};
    const response = await mod.handle({request, path: '/sync'});
    assert.equal(response.status, 202);
    assert.equal(mod.store.config().steam.syncing, true);
    const job = mod.store.jobs.get('steam');
    request.destroy();
    const during = await mod.handle({request: {method: 'GET'}, path: '/api'});
    assert.equal((await during.json()).config.steam.syncing, true);
    release();
    await job;
    assert.equal(mod.store.config().steam.syncing, false);
    assert.equal(mod.store.snapshot().games.length, 2);
  });
  test('trophies yearly activity includes old unlocks and card retains partial totals', async (t) => {
    const f = fixture(t);
    await f.store.sync('steam');
    const account = f.store.account('steam');
    const game = {
      id: '1',
      title: 'Game',
      achievements: [{id: 'a', soft: true, hard: false, date: f.now() - 200 * 86400000, rarity: 10}]
    };
    f.store.commitGame('steam', account, game);
    const days = f.store.activity().days;
    assert.equal(days[new Date(game.achievements[0].date).toISOString().slice(0, 10)], 1);
    const {createModule} = await import('../02-hub/modules/trophies/index.mjs');
    const mod = createModule(f.dir + '/summary', f.options);
    mod.store.load();
    t.after(() => mod.close());
    mod.store.set('steam', {...account, error: 'Partial failure', lastSync: 0});
    mod.store.commitGame('steam', account, game);
    const summary = await mod.summary();
    assert.equal(summary.state, 'warning');
    assert.equal(summary.items.find((x) => x.label === 'Открыто').value, 1);
  });
  test('Steam confirms games without stats using store categories and shares the metadata request', async () => {
    for (const status of [200, 400, 404]) {
      let calls = 0;
      const p = new Provider(
        'steam',
        {key: 'key'},
        {
          sleep: async () => {},
          fetcher: async (u) => {
            if (u.pathname.includes('GetSchemaForGame'))
              return status === 200 ? Response.json({game: {}}) : new Response(null, {status});
            assert.equal(u.pathname, '/api/appdetails');
            calls++;
            return Response.json({
              1: {success: true, data: {steam_appid: 1, categories: [{id: 2}], is_free: true}}
            });
          }
        }
      );
      const game = await p.game({id: '1'});
      assert.deepEqual(game.achievements, []);
      assert.equal(game.error, null);
      assert.equal((await p.price('1')).priceUsd, 0);
      assert.equal(calls, 1);
      p.close();
    }
  });
  test('Steam empty or denied responses cannot erase known achievements or become false zeroes', async () => {
    for (const data of [
      undefined,
      {steam_appid: 1},
      {steam_appid: 1, categories: [{id: 22}]},
      {steam_appid: 1, categories: [{id: 2}], achievements: {total: 3}}
    ]) {
      const p = new Provider(
        'steam',
        {key: 'key'},
        {
          sleep: async () => {},
          fetcher: async (u) =>
            Response.json(
              u.pathname.includes('GetSchemaForGame') ? {game: {}} : {1: {success: true, data}}
            )
        }
      );
      await assert.rejects(p.game({id: '1'}));
      p.close();
    }
    const p = new Provider(
      'steam',
      {key: 'key'},
      {
        sleep: async () => {},
        fetcher: async (u) =>
          Response.json(
            u.pathname.includes('GetSchemaForGame')
              ? {game: {}}
              : {1: {success: true, data: {steam_appid: 1, categories: [{id: 2}]}}}
          )
      }
    );
    await assert.rejects(p.game({id: '1'}, {achievements: [{id: 'earned', soft: true}]}));
    p.close();
    const denied = new Provider(
      'steam',
      {key: 'key'},
      {
        sleep: async () => {},
        fetcher: async (u) => {
          assert.match(u.pathname, /GetSchemaForGame/);
          return new Response(null, {status: 403});
        }
      }
    );
    await assert.rejects(denied.game({id: '1'}), (e) => e.httpStatus === 403);
    denied.close();
  });
  test('Steam unsupported stats do not count as sync errors after independent confirmation', async (t) => {
    const f = fixture(t);
    f.store.options.fetcher = async (u) =>
      u.pathname.includes('GetSchemaForGame')
        ? Response.json({game: {}})
        : u.pathname === '/api/appdetails'
          ? Response.json({
              [u.searchParams.get('appids')]: {
                success: true,
                data: {
                  steam_appid: Number(u.searchParams.get('appids')),
                  categories: [{id: 2}],
                  is_free: true
                }
              }
            })
          : u.pathname.startsWith('/appreviews/')
            ? Response.json({success: 1, query_summary: {total_reviews: 0, total_positive: 0}})
            : f.fetcher(u);
    await f.store.sync('steam');
    assert.equal(f.store.config().steam.error, null);
    assert.ok(f.store.config().steam.lastSync);
    assert.ok(f.store.snapshot().games.every((g) => g.available && g.total === 0));
  });
  test('Steam hashed covers are resolved, saved and kept through later achievement updates', async (t) => {
    const f = fixture(t);
    await f.store.sync('steam');
    const calls = [],
      cover =
        'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1/abcdef123/header.jpg?t=1';
    f.store.options.fetcher = async (u) => {
      calls.push(u.href);
      if (u.pathname === '/api/appdetails')
        return Response.json({1: {success: true, data: {steam_appid: 1, header_image: cover}}});
      return u.href === cover
        ? new Response('image', {headers: {'content-type': 'image/jpeg'}})
        : new Response(null, {status: 404});
    };
    assert.equal((await f.store.cover('steam', '1')).type, 'image/jpeg');
    assert.equal(calls.length, 4);
    assert.equal(f.store.rows('steam', f.account.id).find((g) => g.id === '1').storeCover, cover);
    f.store.commitGame('steam', f.account, {
      id: '1',
      title: 'Game',
      cover: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1/header.jpg',
      achievements: []
    });
    assert.equal(f.store.rows('steam', f.account.id).find((g) => g.id === '1').storeCover, cover);
    assert.match(f.store.snapshot().games[0].cover, /\?v=/);
    assert.doesNotMatch(JSON.stringify(f.store.snapshot()), /fastly|storeCover/);
    f.store.images.clear();
    fs.rmSync(f.store.coverCache.directory, {recursive: true, force: true});
    calls.length = 0;
    await f.store.cover('steam', '1');
    assert.deepEqual(calls, [cover]);
  });
  test('Steam cover cache follows changed store artwork and does not reuse generic fallback',async t=>{
    const f=fixture(t);await f.store.sync('steam');
    const base='https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1/';
    const save=cover=>f.store.db.prepare("UPDATE games SET data=json_set(data,'$.storeCover',?) WHERE provider='steam' AND id='1'").run(cover);
    const calls=[];f.store.options.fetcher=async url=>{calls.push(url.href);return new Response(url.href,{headers:{'content-type':'image/jpeg'}});};
    save(base+'aaaa/header.jpg');const first=await f.store.cover('steam','1');
    const before=f.store.snapshot().games.find(g=>g.id==='1').cover;
    save(base+'bbbb/header.jpg');const second=await f.store.cover('steam','1');
    assert.notDeepEqual(first.data,second.data);assert.equal(calls.at(-1),base+'bbbb/header.jpg');
    assert.notEqual(before,f.store.snapshot().games.find(g=>g.id==='1').cover);
    save(base+'cccc/header.jpg');calls.length=0;f.store.options.fetcher=async url=>{calls.push(url.href);return new Response(null,{status:404});};
    assert.equal(await f.store.cover('steam','1'),null);
    assert.ok(!calls.some(url=>url===base+'header.jpg'));
  });
  test('Steam cover metadata cannot redirect the server outside the approved CDN and game', async (t) => {
    const {steamImage} = await import('../02-hub/modules/trophies/providers.mjs');
    for (const value of [
      'http://shared.fastly.steamstatic.com/steam/apps/1/header.jpg',
      'https://127.0.0.1/steam/apps/1/header.jpg',
      'https://shared.fastly.steamstatic.com.evil.test/steam/apps/1/header.jpg',
      'https://user:pass@shared.fastly.steamstatic.com/steam/apps/1/header.jpg',
      'https://shared.fastly.steamstatic.com/steam/apps/2/header.jpg'
    ])
      assert.equal(steamImage(value, '1'), '');
    const f = fixture(t);
    await f.store.sync('steam');
    let calls = 0;
    f.store.options.fetcher = async (u) => {
      calls++;
      assert.notEqual(u.hostname, '127.0.0.1');
      return u.pathname === '/api/appdetails'
        ? Response.json({
            1: {success: true, data: {steam_appid: 1, header_image: 'https://127.0.0.1/secret'}}
          })
        : new Response(null, {status: 404});
    };
    assert.equal(await f.store.cover('steam', '1'), null);
    assert.equal(calls, 3);
  });
  test('Steam reports the actual partial failure and retains previous unlocks', async (t) => {
    const f = fixture(t);
    f.unlocked = true;
    await f.store.sync('steam');
    f.advance();
    f.store.options.fetcher = async (u) =>
      u.pathname.includes('GetPlayerAchievements')
        ? new Response(null, {status: 403})
        : f.fetcher(u);
    await f.store.sync('steam', 'full');
    assert.match(f.store.config().steam.error, /Ключ сохранён/);
    assert.match(f.store.config().steam.error, /доступ/);
    assert.equal(f.store.detail('steam', '1').achievements[0].soft, true);
  });
  test('trophies covers fall back to a second Steam CDN and cache the result', async (t) => {
    const f = fixture(t);
    await f.store.sync('steam');
    let calls = 0;
    f.store.options.fetcher = async (url) => {
      calls++;
      return url.hostname === 'shared.akamai.steamstatic.com'
        ? new Response(null, {status: 404})
        : new Response('image', {headers: {'content-type': 'image/jpeg'}});
    };
    assert.equal((await f.store.cover('steam', '1')).type, 'image/jpeg');
    assert.equal(calls, 2);
    await f.store.cover('steam', '1');
    assert.equal(calls, 2);
  });
  test('trophies imports Steam and preserves secret boundaries, schema and rarity cache', async (t) => {
    const f = fixture(t);
    await f.store.sync('steam');
    assert.equal(f.store.snapshot().games.length, 2);
    assert.equal(f.store.detail('steam', '1').achievements[0].rarity, 2.5);
    assert.doesNotMatch(JSON.stringify(f.store.snapshot()), /test-key|schema|76561198000000000/);
    assert.equal(fs.statSync(f.dir + '/trophies.db').mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.dir).mode & 0o777, 0o700);
    f.advance();
    const before = f.requests.length;
    await f.store.sync('steam');
    assert.equal(
      f.requests
        .slice(before)
        .filter((u) => /GetSchemaForGame|GetGlobalAchievement/.test(u.pathname)).length,
      0
    );
  });
  test('trophies notification baseline, durable dedup and Signal dedup survive restart', async (t) => {
    const f = fixture(t);
    await f.store.sync('steam');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.dir + '/notifications.json')), []);
    f.unlocked = true;
    f.advance();
    await f.store.sync('steam');
    const events = JSON.parse(fs.readFileSync(f.dir + '/notifications.json'));
    assert.equal(events.length, 2);
    const state = {};
    assert.equal(achievementEvents(f.dir + '/notifications.json', state, f.now()).length, 2);
    assert.equal(
      achievementEvents(f.dir + '/notifications.json', JSON.parse(JSON.stringify(state)), f.now())
        .length,
      0
    );
    await f.store.close();
    f.store = new TrophiesStore(f.dir, f.options);
    f.advance();
    await f.store.sync('steam');
    assert.equal(JSON.parse(fs.readFileSync(f.dir + '/notifications.json')).length, 2);
    assert.equal(f.store.activity().rare.length, 2);
    assert.equal(
      Object.values(f.store.activity().days).reduce((a, b) => a + b, 0),
      2
    );
  });
  test('trophies initial unlocked achievements stay silent and failed sync keeps prior list', async (t) => {
    const f = fixture(t);
    f.unlocked = true;
    await f.store.sync('steam');
    const old = f.store.snapshot(),
      last = old.config.steam.lastSync;
    assert.equal(JSON.parse(fs.readFileSync(f.dir + '/notifications.json')).length, 0);
    f.broken = true;
    f.advance();
    await f.store.sync('steam');
    const current = f.store.snapshot();
    assert.deepEqual(current.games, old.games);
    assert.equal(current.config.steam.lastSync, last);
    assert.ok(current.config.steam.error);
  });
  test('trophies RA mode counts, separate rarity, awards and HC upgrades', async (t) => {
    const f = fixture(t);
    f.store.set('ra', {...f.account, id: '01J00000000000000000000000'});
    await f.store.sync('ra');
    f.advance();
    f.unlocked = true;
    await f.store.sync('ra');
    let a = f.store.detail('ra', '1').achievements[0];
    assert.equal(a.rarity, 4);
    assert.equal(a.hardRarity, 5);
    assert.equal(a.hard, false);
    assert.equal(f.store.snapshot().games.find((g) => g.provider === 'ra').beatenHard, true);
    f.advance();
    f.hard = true;
    await f.store.sync('ra');
    assert.equal(JSON.parse(fs.readFileSync(f.dir + '/notifications.json')).length, 2);
    assert.equal(f.store.snapshot().games.find((g) => g.provider === 'ra').soft, 1);
    assert.equal(f.store.snapshot().games.find((g) => g.provider === 'ra').hard, 1);
    assert.equal(f.store.activity('hard', 'ra').rare.length, 1);
    f.advance();
    await f.store.sync('ra');
    assert.equal(JSON.parse(fs.readFileSync(f.dir + '/notifications.json')).length, 2);
  });
  test('trophies simultaneous RA soft+hard unlock emits one event', async (t) => {
    const f = fixture(t);
    f.store.set('ra', {...f.account, id: '01J00000000000000000000000'});
    await f.store.sync('ra');
    f.advance();
    f.unlocked = f.hard = true;
    await f.store.sync('ra');
    const events = JSON.parse(fs.readFileSync(f.dir + '/notifications.json'));
    assert.equal(events.length, 1);
    assert.match(events[0].title, /Hardcore/);
  });
  test('trophies manual beaten mark persists through sync and disconnect removes keys', async (t) => {
    const f = fixture(t);
    await f.store.sync('steam');
    f.store.mark('1', true);
    f.advance();
    await f.store.sync('steam');
    assert.equal(f.store.detail('steam', '1').beaten, true);
    f.store.disconnect('steam');
    assert.equal(f.store.account('steam'), null);
    assert.equal(f.store.snapshot().games.length, 0);
  });
  test('trophies single flight and cooldown reject repeated requests', async (t) => {
    const f = fixture(t);
    const first = f.store.sync('steam');
    assert.equal(f.store.sync('steam'), first);
    await first;
    await assert.rejects(f.store.sync('steam'), (e) => e.status === 429);
  });
  test('trophies RA pagination rejects duplicate, missing or truncated records', async () => {
    let pages = 0;
    const provider = new Provider(
      'ra',
      {id: 'x', key: 'key'},
      {
        sleep: async () => {},
        fetcher: async (url) => {
          if (url.pathname.includes('Awards')) return Response.json({VisibleUserAwards: []});
          pages++;
          return Response.json({
            Count: 1,
            Total: 2,
            Results: [{GameID: pages, MaxPossible: 1, Title: 'G'}]
          });
        }
      }
    );
    assert.equal((await provider.library()).items.length, 2);
    assert.equal(pages, 2);
    provider.fetcher = async () => Response.json({Count: 0, Total: 1, Results: []});
    await assert.rejects(provider.library(), /Неполный/);
    provider.fetcher = async () =>
      Response.json({Count: 1, Total: 2, Results: [{GameID: 1, MaxPossible: 1}]});
    await assert.rejects(provider.library(), /Неполный/);
  });
  test('trophies Steam private response is not an empty library', async () => {
    const p = new Provider(
      'steam',
      {id: 'x', key: 'key'},
      {sleep: async () => {}, fetcher: async () => Response.json({response: {}})}
    );
    await assert.rejects(p.library(), /недоступен/);
    p.fetcher = async () => Response.json({response: {game_count: 0}});
    assert.deepEqual((await p.library()).items, []);
  });
  test('trophies honors Retry-After and masks remote error bodies', async () => {
    let calls = 0,
      now = Date.now();
    const waits = [];
    const p = new Provider(
      'steam',
      {key: 'secret'},
      {
        now: () => now,
        sleep: async (ms) => {
          waits.push(ms);
          now += ms;
        },
        fetcher: async () =>
          ++calls === 1
            ? new Response('secret', {status: 429, headers: {'Retry-After': '3'}})
            : Response.json({ok: true})
      }
    );
    await assert.rejects(p.get('test'), e => e.status === 429 && e.retryAt >= now + 900000);
    assert.equal(calls, 1);
    p.fetcher = async () => new Response('secret', {status: 403});
    await assert.rejects(p.get('test'), (e) => !e.message.includes('secret'));
  });
  test('trophies validates profile links, dates and unavailable achievement details', async (t) => {
    assert.equal(
      steamId('https://steamcommunity.com/profiles/76561198000000000/'),
      '76561198000000000'
    );
    assert.throws(() => steamId('https://evil.test/id/user'));
    assert.equal(timestamp(0), null);
    assert.equal(timestamp('bad'), null);
    assert.equal(timestamp('2026-01-01 12:00:00'), Date.parse('2026-01-01T12:00:00Z'));
    const f = fixture(t);
    await f.store.sync('steam');
    const original = f.fetcher;
    f.store.options.fetcher = async (u) =>
      u.pathname.includes('GetPlayerAchievements')
        ? Response.json({playerstats: {success: false}})
        : original(u);
    f.advance();
    await f.store.sync('steam');
    assert.equal(f.store.detail('steam', '1').achievements.length, 1);
    assert.ok(f.store.detail('steam', '1').error);
  });
  test('trophies uses persistent API budget before sending a request', async (t) => {
    const f = fixture(t);
    f.store.set('budget:steam', {day: new Date(f.now()).toISOString().slice(0, 10), count: 20000});
    await f.store.sync('steam');
    assert.equal(f.requests.length, 0);
    assert.match(f.store.config().steam.error, /лимит/);
  });
}

{
  const {Provider} = await import('../02-hub/modules/trophies/providers.mjs');
  test('trophies refreshes an outdated Steam schema when new achievements appear', async () => {
    let schemas = 0;
    const p = new Provider(
      'steam',
      {id: 'user', key: 'key'},
      {
        sleep: async () => {},
        fetcher: async (u) => {
          if (u.pathname.includes('GetSchemaForGame')) {
            schemas++;
            return Response.json({
              game: {availableGameStats: {achievements: [{name: 'OLD'}, {name: 'NEW'}]}}
            });
          }
          if (u.pathname.includes('GetPlayerAchievements'))
            return Response.json({
              playerstats: {
                success: true,
                achievements: [
                  {apiname: 'OLD', achieved: 1, unlocktime: 0},
                  {apiname: 'NEW', achieved: 0, unlocktime: 0}
                ]
              }
            });
          return Response.json({achievementpercentages: {achievements: []}});
        }
      }
    );
    const result = await p.game({id: '1'}, {schema: [{name: 'OLD'}], schemaAt: Date.now()});
    assert.equal(schemas, 1);
    assert.equal(result.achievements.length, 2);
    assert.equal(result.achievements[0].date, null);
    assert.equal(result.achievements[0].rarity, null);
  });
  test('trophies RA malformed progress does not become a locked or empty game', async () => {
    const p = new Provider(
      'ra',
      {id: 'user', key: 'key'},
      {
        sleep: async () => {},
        fetcher: async () => Response.json({ID: 1, NumAchievements: 2, Achievements: {}})
      }
    );
    await assert.rejects(p.game({id: '1'}), /Неполный/);
  });
}

test('dashboard previews allow only bounded public fields for their own modules', async () => {
  const {moduleSummary} = await import('../02-hub/src/modules.mjs');
  const data = {
    state: 'ok',
    items: [],
    covers: [1, '../secret', -1, 2, 3, 4, Infinity],
    preview: [
      {title: 'Event', time: 100, key: 'secret'},
      {title: 'x'.repeat(200), time: 200}
    ],
    token: 'secret'
  };
  const anime = await moduleSummary({id: 'anime', summary: () => data});
  assert.deepEqual(anime.covers, [1, 2, 3]);
  assert.equal(anime.preview, undefined);
  const signal = await moduleSummary({id: 'signal', summary: () => data});
  assert.equal(signal.covers, undefined);
  assert.equal(signal.preview[0].key, undefined);
  assert.equal(signal.preview[1].title.length, 100);
  assert.doesNotMatch(JSON.stringify(signal), /secret|token/);
  const other = await moduleSummary({id: 'chat', summary: () => data});
  assert.equal(other.covers, undefined);
  assert.equal(other.preview, undefined);
});

// tests/sync-recovery
{
  const {FlowSession} = await import('../02-hub/modules/chat/flow-session.mjs');
  const {Provider} = await import('../02-hub/modules/trophies/providers.mjs');
  const {TrophiesStore} = await import('../02-hub/modules/trophies/store.mjs');
  const temp = (t) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-recovery-'));
    t.after(() => fs.rmSync(d, {recursive: true, force: true}));
    return d;
  };
  test('FlowMusic transient failures keep tokens and retry after backoff, even after restart', async (t) => {
    const dir = temp(t);
    let now = Date.now(),
      calls = 0;
    const options = {
      now: () => now,
      fetcher: async () => {
        calls++;
        if (calls === 1) return new Response('private-error', {status: 503});
        return Response.json({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600
        });
      }
    };
    let s = new FlowSession(dir, options);
    s.save({refreshToken: 'current-refresh-token', anonKey: 'public-anon-key'});
    await assert.rejects(s.refresh(), /временно/);
    assert.equal(s.publicConfig().needsLogin, false);
    assert.equal(JSON.parse(fs.readFileSync(s.file)).refresh_token, 'current-refresh-token');
    s.close();
    s = new FlowSession(dir, options);
    t.after(() => s.close());
    await assert.rejects(s.token(), /временно/);
    assert.equal(calls, 1);
    now += 30001;
    assert.equal(await s.token(), 'new-access-token');
    assert.equal(JSON.parse(fs.readFileSync(s.file)).refresh_token, 'new-refresh-token');
    assert.equal(s.publicConfig().error, null);
  });
  test('FlowMusic respects 429 Retry-After and does not leak upstream body', async (t) => {
    let now = Date.now();
    const s = new FlowSession(temp(t), {
      now: () => now,
      fetcher: async () => new Response('secret', {status: 429, headers: {'Retry-After': '120'}})
    });
    t.after(() => s.close());
    s.save({refreshToken: 'current-refresh-token', anonKey: 'public-anon-key'});
    await assert.rejects(s.refresh(), (e) => !e.message.includes('secret'));
    assert.equal(s.publicConfig().nextRetry, now + 120000);
    assert.equal(s.publicConfig().needsLogin, false);
  });
  test('FlowMusic serves an unexpired token through temporary proactive-refresh failure', async (t) => {
    const now = Date.now(),
      dir = temp(t);
    fs.writeFileSync(
      dir + '/flowmusic.json',
      JSON.stringify({
        access_token: 'still-valid-access',
        refresh_token: 'current-refresh-token',
        anon_key: 'public-anon-key',
        expires_at: Math.floor(now / 1000) + 90
      })
    );
    const s = new FlowSession(dir, {
      now: () => now,
      fetcher: async () => {
        throw Error('network');
      }
    });
    t.after(() => s.close());
    assert.equal(await s.token(), 'still-valid-access');
    assert.equal(s.publicConfig().needsLogin, false);
  });
  test('Steam uses only API keys; no credentials for store or rarity', async () => {
    const requests = [];
    const p = new Provider(
      'steam',
      {id: '76561198000000000', key: 'private-api-key'},
      {
        token: async () => 'private-access-token',
        sleep: async () => {},
        fetcher: async (u) => {
          requests.push(new URL(u));
          return Response.json({});
        }
      }
    );
    await p.get('IPlayerService/GetOwnedGames/v1/');
    await p.get('ISteamUserStats/GetPlayerAchievements/v1/');
    await p.get('ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/');
    await p.get('appreviews/10', {}, 'store');
    assert.equal(requests[0].searchParams.get('key'), 'private-api-key');
    assert.equal(requests[0].searchParams.has('access_token'), false);
    assert.equal(requests[1].searchParams.get('key'), 'private-api-key');
    assert.equal(requests[1].searchParams.has('access_token'), false);
    for (const u of requests.slice(2)) assert.doesNotMatch(u.href, /private|access_token|key=/);
    assert.equal(requests[3].hostname, 'store.steampowered.com');
    p.close();
  });
  test('Steam review percentage validates totals and distinguishes no reviews', async () => {
    let summary = {total_reviews: 200, total_positive: 187};
    const p = new Provider(
      'steam',
      {},
      {
        sleep: async () => {},
        fetcher: async () => Response.json({success: 1, query_summary: summary})
      }
    );
    assert.equal((await p.reviews('10')).reviewPercent, 93.5);
    summary = {total_reviews: 0, total_positive: 0};
    assert.equal((await p.reviews('10')).reviewPercent, null);
    summary = {total_reviews: 2, total_positive: 3};
    await assert.rejects(p.reviews('10'), /Отзывы/);
    p.close();
  });
  test('Steam finishes played games before the rest and overlaps metadata with achievements', async t => {
    const store=new TrophiesStore(temp(t));store.load();t.after(()=>store.close());
    store.set('steam',{id:'76561198000000000',key:'test-key',name:'Player'});
    const calls=[];let release, activeStats=false, overlap=false;
    const gate=new Promise(resolve=>release=resolve);
    store.provider=()=>({close(){},library:async()=>({awards:[],items:[{id:'1',title:'Unplayed',minutes:0},{id:'2',title:'Played',minutes:10}]}),
      game:async game=>{calls.push('game:'+game.id);if(game.id==='2'){activeStats=true;await gate;activeStats=false;}return {...game,achievements:[],total:0};},
      reviews:async id=>{calls.push('reviews:'+id);if(id==='2'){overlap=activeStats;release();}return {reviewAt:Date.now()};},
      price:async id=>{calls.push('price:'+id);return {priceAt:Date.now()};}});
    await store.sync('steam');
    assert.equal(overlap,true);
    assert.ok(calls.indexOf('game:1')>calls.indexOf('price:2'));
    assert.ok(calls.indexOf('reviews:1')>calls.indexOf('price:2'));
    assert.equal(store.snapshot().games.length,2);
  });
  test('Steam commits all game fields together before starting the next game', async t => {
    const store=new TrophiesStore(temp(t));store.load();t.after(()=>store.close());
    store.set('steam',{id:'76561198000000000',key:'test-key',name:'Player'});
    let release, entered;
    const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
    const calls=[];
    store.provider=()=>({close(){},library:async()=>({awards:[],items:[{id:'1',title:'First',minutes:2},{id:'2',title:'Second',minutes:0}]}),
      game:async game=>{calls.push(game.id);return {...game,achievements:[{id:'WIN',soft:true}],total:1};},
      reviews:async id=>{if(id==='1'){entered();await gate;}return {reviewPercent:95,reviewCount:100,reviewAt:Date.now()};},
      price:async()=>({priceUsd:10,priceAt:Date.now()})});
    const sync=store.sync('steam');await started;
    assert.equal(store.snapshot().games.find(game=>game.id==='1').soft,null);
    assert.deepEqual(calls,['1']);release();await sync;
    const game=store.snapshot().games.find(game=>game.id==='1');
    assert.equal(game.soft,1);assert.equal(game.reviewPercent,95);assert.equal(game.priceUsd,10);
    assert.deepEqual(calls,['1','2']);
  });
  test('Trophies parallel refresh preserves metadata, unlocks and notifications without duplicates', async (t) => {
    let now = Date.now(),
      active = 0,
      peak = 0,
      unlocked = false,
      storeCalls = 0,
      statsCalls = 0;
    const s = new TrophiesStore(temp(t), {now: () => now});
    s.load();
    t.after(() => s.close());
    s.set('steam', {
      id: '76561198000000000',
      key: 'test-key',
      name: 'Player',
      connectedAt: now - 86400000
    });
    s.provider = () => ({
      close() {},
      library: async () => ({
        items: Array.from({length: 8}, (_, i) => ({
          id: String(i + 1),
          title: 'Game',
          minutes: unlocked ? 2 : 1,
          lastPlayed: now
        })),
        awards: []
      }),
      game: async (g) => {
        statsCalls++;
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return {
          ...g,
          total: 1,
          detailAt: now,
          achievements: [{id: 'WIN', title: 'Win', soft: unlocked, hard: false, date: now}]
        };
      },
      reviews: async () => {
        storeCalls++;
        return {reviewPercent: 95, reviewCount: 100, reviewAt: now};
      },
      price: async () => ({priceUsd: 10, priceAt: now})
    });
    await s.sync('steam');
    assert.equal(peak, 1);
    assert.equal(statsCalls, 8);
    assert.equal(storeCalls, 8);
    assert.ok(s.snapshot().games.every((g) => g.reviewPercent === 95 && g.priceUsd === 10));
    assert.equal(s.get('steam').error, null);
    now += 3600001;
    unlocked = true;
    await s.sync('steam');
    assert.equal(storeCalls, 8);
    assert.ok(s.snapshot().games.every((g) => g.soft === 1));
    assert.equal(s.db.prepare('SELECT count(*) n FROM events').get().n, 8);
    now += 3600001;
    await s.sync('steam', 'full');
    assert.equal(storeCalls, 16);
    assert.equal(s.db.prepare('SELECT count(*) n FROM events').get().n, 8);
  });
  test('Trophies cover queue waits instead of rejecting the seventh image', async (t) => {
    let active = 0,
      peak = 0;
    const s = new TrophiesStore(temp(t), {
      fetcher: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return new Response(new Uint8Array([1, 2, 3]), {headers: {'Content-Type': 'image/png'}});
      }
    });
    s.load();
    t.after(() => s.close());
    const a = {id: 'id', key: 'key'};
    s.set('steam', a);
    for (let i = 1; i <= 12; i++)
      s.commitGame('steam', a, {
        id: String(i),
        cover: 'https://shared.akamai.steamstatic.com/test.png',
        achievements: []
      });
    const result = await Promise.all(
      Array.from({length: 12}, (_, i) => s.cover('steam', String(i + 1)))
    );
    assert.equal(result.filter(Boolean).length, 12);
    assert.equal(peak, 6);
  });
}

// tests/flow-credits
{
  const {FlowSession} = await import('../02-hub/modules/chat/flow-session.mjs');
  const fixture = (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-credits-'));
    let now = Date.now();
    const s = new FlowSession(dir, {now: () => now});
    s.save({refreshToken: 'private-refresh-token', anonKey: 'public-anon-key'});
    t.after(() => {
      s.close();
      fs.rmSync(dir, {recursive: true, force: true});
    });
    return {s, advance: () => (now += 300001)};
  };
  test('FlowMusic credits parse the live web-client shape, cache, track changes and keep zero', async (t) => {
    const f = fixture(t);
    let value = 1200,
      calls = 0;
    f.s.request = async (route) => {
      assert.equal(route, '/billing/credits');
      calls++;
      return Response.json({data: {credits_remaining: value}, private: 'not-exposed'});
    };
    let d = await f.s.credits();
    assert.equal(d.remaining, 1200);
    assert.equal(d.history.length, 1);
    await f.s.credits();
    assert.equal(calls, 1);
    f.advance();
    value = 1180;
    d = await f.s.credits();
    assert.equal(d.history[1].change, -20);
    assert.equal(d.stale, false);
    f.advance();
    value = 0;
    d = await f.s.credits();
    assert.equal(d.remaining, 0);
    assert.equal(d.history[2].change, -1180);
    assert.doesNotMatch(JSON.stringify(d), /private|not-exposed|anon/);
    assert.equal(fs.statSync(f.s.creditFile).mode & 0o777, 0o600);
  });
  test('FlowMusic credits preserve previous data after a malformed reply or outage', async (t) => {
    const f = fixture(t);
    f.s.request = async () => Response.json({data: {credits_remaining: 75}});
    await f.s.credits();
    f.advance();
    f.s.request = async () => Response.json({data: {credits_remaining: '75'}});
    const d = await f.s.credits();
    assert.equal(d.remaining, 75);
    assert.equal(d.stale, true);
    assert.equal(d.history.length, 1);
    f.advance();
    f.s.request = async () => {
      throw Error('PRIVATE_REFRESH');
    };
    const next = await f.s.credits();
    assert.equal(next.remaining, 75);
    assert.doesNotMatch(JSON.stringify(next), /PRIVATE_REFRESH/);
  });
  test('FlowMusic late credit reply cannot restore history after session removal', async (t) => {
    const f = fixture(t);
    let finish;
    f.s.request = () => new Promise((r) => (finish = r));
    const pending = f.s.credits();
    f.s.save({remove: true});
    finish(Response.json({data: {credits_remaining: 777}}));
    await pending;
    assert.equal(f.s.creditSnapshot().remaining, null);
    assert.equal(fs.existsSync(f.s.creditFile), false);
  });
}

test('FlowMusic exports real WAV, MP3 and M4A, caches conversions and removes them', async (t) => {
  const {spawnSync} = await import('node:child_process');
  if (
    spawnSync('ffmpeg', ['-version']).status !== 0 ||
    spawnSync('ffprobe', ['-version']).status !== 0
  ) {
    t.skip('FFmpeg and ffprobe required for codec integration test');
    return;
  }
  const {FlowAudio} = await import('../02-hub/modules/chat/flow-audio.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-export-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const audio = new FlowAudio(dir),
    id = crypto.randomUUID();
  fs.mkdirSync(audio.directory);
  const source = path.join(audio.directory, id);
  const fixture = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-f',
    'wav',
    source
  ]);
  assert.equal(fixture.status, 0, fixture.stderr.toString());
  fs.writeFileSync(source + '.json', JSON.stringify({extension: 'wav', type: 'audio/wav'}));
  const request = {method: 'GET', headers: {}};
  for (const [format, codec, mime] of [
    ['wav', 'pcm_s16le', 'audio/wav'],
    ['mp3', 'mp3', 'audio/mpeg'],
    ['m4a', 'aac', 'audio/mp4']
  ]) {
    const responses = await Promise.all([
      audio.download(id, request, format),
      audio.download(id, request, format)
    ]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), mime);
      assert.ok(response.headers.get('content-disposition').endsWith('.' + format + '"'));
      assert.ok((await response.arrayBuffer()).byteLength > 100);
    }
    const file = format === 'wav' ? source : source + '.' + format;
    const probe = spawnSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_name',
      '-of',
      'json',
      file
    ]);
    assert.equal(probe.status, 0);
    assert.equal(JSON.parse(probe.stdout).streams[0].codec_name, codec);
    const modified = fs.statSync(file).mtimeMs;
    const head = await audio.download(id, {method: 'HEAD', headers: {}}, format);
    assert.equal(head.body, null);
    assert.equal(fs.statSync(file).mtimeMs, modified);
    const range = await audio.download(id, {method: 'GET', headers: {range: 'bytes=0-9'}}, format);
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 10);
  }
  await assert.rejects(audio.download(id, request, 'exe'), (e) => e.status === 400);
  await assert.rejects(audio.download('../secret', request, 'mp3'), (e) => e.status === 400);
  const compressedId = crypto.randomUUID();
  fs.copyFileSync(source + '.mp3', path.join(audio.directory, compressedId));
  fs.writeFileSync(
    path.join(audio.directory, compressedId + '.json'),
    JSON.stringify({extension: 'mp3', type: 'audio/mpeg'})
  );
  const wav = await audio.download(compressedId, request, 'wav');
  const bytes = Buffer.from(await wav.arrayBuffer());
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  const probeWav = spawnSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_name',
    '-of',
    'json',
    path.join(audio.directory, compressedId + '.wav')
  ]);
  assert.equal(JSON.parse(probeWav.stdout).streams[0].codec_name, 'pcm_s16le');
  audio.remove([id, compressedId]);
  assert.deepEqual(fs.readdirSync(audio.directory), []);
});

// Аполлон
{
  const {WaveStore} = await import('../02-hub/modules/wave/store.mjs');
  const {spawnSync} = await import('node:child_process');
  const {Readable} = await import('node:stream');
  const available = spawnSync('ffmpeg', ['-version']).status === 0;
  function waveFixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-test-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    return {dir, store: new WaveStore(path.join(dir, 'wave'))};
  }
  function tone(dir, extension = 'wav') {
    const file = path.join(dir, 'source.' + extension);
    const result = spawnSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-metadata',
      'title=Тишина <ночь>',
      '-metadata',
      'artist=Исполнитель',
      '-metadata',
      'album=Альбом',
      file
    ]);
    assert.equal(result.status, 0, result.stderr.toString());
    return fs.readFileSync(file);
  }
  test(
    'Wave reads actual audio tags, deduplicates, streams ranges and retains original',
    {skip: !available},
    async (t) => {
      const {dir, store} = waveFixture(t);
      const bytes = tone(dir);
      const {track} = await store.upload(Readable.from([bytes]), 'song.wav');
      assert.equal(track.title, 'Тишина <ночь>');
      assert.equal(track.artist, 'Исполнитель');
      assert.equal(track.album, 'Альбом');
      assert.ok(track.duration > 0.9);
      assert.equal(track.extension, '.wav');
      assert.equal((await store.upload(Readable.from([bytes]), 'copy.wav')).duplicate, true);
      assert.equal(store.snapshot().tracks.length, 1);
      const req = {method: 'GET', headers: {range: 'bytes=0-99'}};
      const r = store.serve(track.id, 'audio', req);
      assert.equal(r.status, 206);
      assert.equal(r.headers.get('content-type'), 'audio/mpeg');
      assert.equal((await r.arrayBuffer()).byteLength, 100);
      assert.equal(
        store.serve(track.id, 'audio', {method: 'GET', headers: {range: 'bytes=9999999-'}}).status,
        416
      );
      const original = store.serve(track.id, 'original', {method: 'GET', headers: {}});
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
      assert.equal(store.serve(track.id, 'audio', {method: 'HEAD', headers: {}}).body, null);
      assert.throws(
        () => store.serve('../library.json', 'original', req),
        (e) => e.status === 404
      );
      const resumed = new WaveStore(path.join(dir, 'wave'));
      assert.equal(resumed.snapshot().tracks[0].title, track.title);
    }
  );
  test(
    'Wave favorites and playlist changes persist and deletion cleans references',
    {skip: !available},
    async (t) => {
      const {dir, store} = waveFixture(t);
      const {track} = await store.upload(Readable.from([tone(dir)]), 'song.wav');
      store.change({action: 'favorite', id: track.id, favorite: true});
      store.change({action: 'playlist.create', name: 'Ночь'});
      const p = store.snapshot().playlists[0];
      store.change({action: 'playlist.add', id: p.id, track: track.id});
      store.change({action: 'playlist.add', id: p.id, track: track.id});
      assert.equal(store.snapshot().playlists[0].tracks.length, 1);
      store.change({action: 'playlist.rename', id: p.id, name: 'Тишина'});
      assert.equal(new WaveStore(path.join(dir, 'wave')).snapshot().playlists[0].name, 'Тишина');
      store.change({action: 'delete', id: track.id});
      assert.equal(store.snapshot().tracks.length, 0);
      assert.equal(store.snapshot().playlists[0].tracks.length, 0);
      assert.equal(fs.existsSync(path.join(dir, 'wave', track.id)), false);
    }
  );
  test('Wave rejects malformed files and concurrent imports without leaving partial files', async (t) => {
    const {store} = waveFixture(t);
    await assert.rejects(
      store.upload(Readable.from([Buffer.from('text')]), 'file.html'),
      (e) => e.status === 400
    );
    assert.deepEqual(fs.readdirSync(store.directory), []);
    if (available) {
      await assert.rejects(
        store.upload(Readable.from([Buffer.from('#EXTM3U\nhttp://127.0.0.1/secret')]), 'file.mp3'),
        (e) => e.status === 400
      );
      assert.deepEqual(fs.readdirSync(store.directory), []);
    }
    store.busy = true;
    await assert.rejects(store.upload(Readable.from([]), 'song.mp3'), (e) => e.status === 429);
    await assert.rejects(store.fromFlow(crypto.randomUUID()), (e) => e.status === 429);
  });
  test(
    'Wave imports a durable independent FlowMusic copy and deduplicates it',
    {skip: !available},
    async (t) => {
      const {dir, store} = waveFixture(t);
      const id = crypto.randomUUID(),
        source = path.join(dir, 'chat', 'audio');
      fs.mkdirSync(source, {recursive: true});
      fs.writeFileSync(path.join(source, id), tone(dir, 'mp3'));
      fs.writeFileSync(
        path.join(source, id + '.json'),
        JSON.stringify({title: 'Flow track', extension: 'mp3'})
      );
      const result = await store.fromFlow(id);
      assert.equal(result.duplicate, false);
      assert.equal((await store.fromFlow(id)).duplicate, true);
      fs.rmSync(source, {recursive: true});
      const response = store.serve(result.track.id, 'audio', {method: 'GET', headers: {}});
      assert.ok((await response.arrayBuffer()).byteLength > 100);
      await assert.rejects(store.fromFlow('../x'), (e) => e.status === 400);
    }
  );
  test('Wave accepts the documented first-version audio formats', {skip: !available}, async (t) => {
    const {dir, store} = waveFixture(t);
    for (const extension of ['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm']) {
      const {track} = await store.upload(
        Readable.from([tone(dir, extension)]),
        'song.' + extension
      );
      assert.ok(track.duration > 0);
      const probe = spawnSync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_name',
        '-of',
        'json',
        path.join(store.directory, track.id, 'play.mp3')
      ]);
      assert.equal(JSON.parse(probe.stdout).streams[0].codec_name, 'mp3');
    }
  });
}

test('Wave HTTP routes require login and same-origin writes; shell permits only same-origin frames', async (t) => {
  const {createApp} = await import('../02-hub/src/server.mjs');
  const {passwordHash} = await import('../02-hub/src/auth.mjs');
  const {createModule} = await import('../02-hub/modules/wave/index.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-auth-'));
  const config = {
    username: 'admin',
    origin: 'http://localhost',
    ...(await passwordHash('test-password-123'))
  };
  const wave = createModule(path.join(dir, 'wave'));
  const app = createApp({
    config,
    modules: new Map([['wave', {id: 'wave', title: 'Аполлон', ...wave}]])
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(async () => {
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
    fs.rmSync(dir, {force: true, recursive: true});
  });
  const base = 'http://127.0.0.1:' + app.address().port;
  for (const route of ['/modules/wave/library', '/modules/wave/audio/' + crypto.randomUUID()]) {
    const r = await fetch(base + route, {redirect: 'manual'});
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/login');
  }
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    redirect: 'manual',
    headers: {Origin: config.origin, 'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({username: config.username, password: 'test-password-123'})
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const rejected = await fetch(base + '/modules/wave/change', {
    method: 'POST',
    headers: {Cookie: cookie, Origin: 'https://evil.invalid', 'Content-Type': 'application/json'},
    body: JSON.stringify({action: 'playlist.create', name: 'bad'})
  });
  assert.equal(rejected.status, 403);
  const changed = await fetch(base + '/modules/wave/change', {
    method: 'POST',
    headers: {Cookie: cookie, Origin: config.origin, 'Content-Type': 'application/json'},
    body: JSON.stringify({action: 'playlist.create', name: 'Тишина'})
  });
  assert.equal(changed.status, 200);
  const page = await fetch(base + '/modules/wave/', {headers: {Cookie: cookie}});
  assert.match(await page.text(), /id="hubFrame"/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  const inner = await fetch(base + '/modules/wave/?_view=1', {headers: {Cookie: cookie}});
  const html = await inner.text();
  assert.match(html, /id="wavePage"/);
  assert.doesNotMatch(html, /id="hubFrame"/);
  const signout = await fetch(base + '/api/auth/logout', {
    method: 'POST',
    redirect: 'manual',
    headers: {Cookie: cookie, Origin: config.origin}
  });
  assert.equal(signout.status, 303);
  assert.equal(
    (
      await fetch(base + '/modules/wave/flow', {
        method: 'POST',
        headers: {Cookie: cookie, Origin: config.origin, 'Content-Type': 'application/json'},
        body: '{}'
      })
    ).status,
    401
  );
});

test('Wave catalog groups old libraries, separates namesakes and orders compilation discs', async () => {
  const {catalog, nameKey} = await import('../02-hub/modules/wave/catalog.mjs');
  const tracks = [
    {id: 'a', title: 'Second', artist: 'Artist One', album: 'Night', trackNumber: 2, discNumber: 1},
    {
      id: 'b',
      title: 'First',
      artist: ' artist  one ',
      album: ' NIGHT ',
      trackNumber: 1,
      discNumber: 1
    },
    {id: 'c', title: 'Other', artist: 'Artist Two', album: 'Night'},
    {
      id: 'd',
      title: 'Disc 2',
      artist: 'Artist One',
      album: 'Mix',
      albumArtist: 'Various',
      trackNumber: 1,
      discNumber: 2
    },
    {
      id: 'e',
      title: 'Disc 1',
      artist: 'Artist Two',
      album: 'Mix',
      albumArtist: 'Various',
      trackNumber: 2,
      discNumber: 1
    },
    {id: 'f', title: 'Single', artist: 'Artist One', album: ''}
  ];
  const before = structuredClone(tracks),
    data = catalog(tracks);
  assert.equal(data.artists.length, 2);
  assert.equal(data.albums.length, 3);
  assert.deepEqual(
    data.albums
      .find((a) => a.name === 'Night' && a.artist === 'Artist One')
      .tracks.map((t) => t.id),
    ['b', 'a']
  );
  assert.deepEqual(
    data.albums.find((a) => a.name === 'Mix').tracks.map((t) => t.id),
    ['e', 'd']
  );
  assert.equal(data.artists.find((a) => a.key === nameKey('Artist One')).tracks.length, 4);
  assert.deepEqual(tracks, before);
});

test('Wave tag edits preserve audio and playlists and survive reopening', async (t) => {
  const {WaveStore} = await import('../02-hub/modules/wave/store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-edit-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const store = new WaveStore(dir),
    id = crypto.randomUUID();
  store.data.tracks.push({
    id,
    title: 'Old',
    artist: 'Unknown',
    album: '',
    favorite: true,
    hash: 'original',
    duration: 35
  });
  store.data.playlists.push({id: crypto.randomUUID(), name: 'Saved', tracks: [id]});
  store.persist();
  assert.throws(() => store.change({action: 'track.edit', id, title: '  '}), /название/);
  store.change({
    action: 'track.edit',
    id,
    title: ' New ',
    artist: 'Artist',
    album: 'Album',
    albumArtist: 'Various',
    trackNumber: '2/12'
  });
  const saved = new WaveStore(dir).snapshot();
  assert.equal(saved.tracks[0].title, 'New');
  assert.equal(saved.tracks[0].trackNumber, 2);
  assert.equal(saved.tracks[0].hash, 'original');
  assert.equal(saved.tracks[0].favorite, true);
  assert.deepEqual(saved.playlists[0].tracks, [id]);
  const before = store.snapshot();
  store.persist = () => {
    throw Error('disk full');
  };
  assert.throws(() => store.change({action: 'track.edit', id, title: 'Lost'}), /disk full/);
  assert.deepEqual(store.snapshot(), before);
});

test('Wave distinguishes singles without guessing from the number of album tracks', async () => {
  const {catalog, albumKey} = await import('../02-hub/modules/wave/catalog.mjs');
  const tracks = [
    {id: 'a', title: 'One', artist: 'Band', album: 'Incomplete album'},
    {id: 'b', title: 'Single', artist: 'Band', album: ''},
    {id: 'c', title: 'Side A', artist: 'Band', album: 'Single release', releaseType: 'single'},
    {id: 'd', title: 'Side B', artist: 'Band', album: 'Single release', releaseType: 'single'}
  ];
  const result = catalog(tracks);
  assert.equal(result.albums.length, 1);
  assert.equal(result.singles.length, 2);
  assert.equal(result.singles.find((r) => r.key === albumKey(tracks[2])).tracks.length, 2);
});

test('Wave deletes batches atomically from playlists and disk, including rollback', async (t) => {
  const {WaveStore} = await import('../02-hub/modules/wave/store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-batch-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const store = new WaveStore(dir),
    ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  for (const id of ids) {
    fs.mkdirSync(path.join(dir, id));
    fs.writeFileSync(path.join(dir, id, 'original.mp3'), 'fixture');
    store.data.tracks.push({id, title: 'Song', artist: 'Band', album: ''});
  }
  store.data.playlists.push({id: crypto.randomUUID(), name: 'List', tracks: [...ids]});
  store.persist();
  const persist = store.persist.bind(store);
  store.persist = () => {
    throw Error('full');
  };
  assert.throws(() => store.change({action: 'delete.many', ids: ids.slice(0, 2)}), /full/);
  assert.equal(store.snapshot().tracks.length, 3);
  assert.ok(fs.existsSync(path.join(dir, ids[0], 'original.mp3')));
  store.persist = persist;
  assert.throws(() => store.change({action: 'delete.many', ids: ['../']}));
  store.change({action: 'delete.many', ids: ids.slice(0, 2)});
  assert.deepEqual(new WaveStore(dir).snapshot().playlists[0].tracks, [ids[2]]);
  assert.equal(fs.existsSync(path.join(dir, ids[0])), false);
  assert.ok(fs.existsSync(path.join(dir, ids[2])));
});

test('Wave profiles rename metadata safely, and release type changes the whole release', async (t) => {
  const {WaveStore} = await import('../02-hub/modules/wave/store.mjs');
  const {catalog, albumKey} = await import('../02-hub/modules/wave/catalog.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-profile-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const store = new WaveStore(dir);
  store.data.tracks = [1, 2].map((i) => ({
    id: crypto.randomUUID(),
    title: 'Song ' + i,
    artist: 'Band',
    albumArtist: 'Band',
    album: 'Release'
  }));
  store.persist();
  store.change({action: 'release.type', key: albumKey(store.data.tracks[0]), type: 'single'});
  assert.equal(catalog(store.data.tracks).singles[0].tracks.length, 2);
  store.change({action: 'artist.save', key: ' BAND ', name: 'New Band', bio: 'About the group'});
  const saved = new WaveStore(dir).snapshot();
  assert.ok(saved.tracks.every((t) => t.artist === 'New Band' && t.albumArtist === 'New Band'));
  assert.equal(saved.artistProfiles[0].bio, 'About the group');
  store.data.tracks.push({id: crypto.randomUUID(), title: 'Other', artist: 'Other'});
  assert.throws(
    () => store.change({action: 'artist.save', key: 'new band', name: 'Other'}),
    /уже есть/
  );
});

test('Wave artist photos are validated, independent of album art and preserved on failure', async (t) => {
  const {WaveStore} = await import('../02-hub/modules/wave/store.mjs');
  const {Readable} = await import('node:stream');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-photo-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const store = new WaveStore(dir);
  store.data.tracks = [
    {id: crypto.randomUUID(), title: 'Song', artist: 'Band', album: 'Album', cover: true}
  ];
  store.persist();
  const bytes = fs.readFileSync(new URL('../02-hub/public/icon-192.png', import.meta.url));
  await store.artistPhoto(Readable.from([bytes]), 'band');
  const before = store.snapshot(),
    photo = before.artistProfiles[0].photo;
  assert.equal(
    store.serveArtistPhoto(photo, {method: 'GET'}).headers.get('content-type'),
    'image/jpeg'
  );
  assert.equal(store.serveArtistPhoto('../library.json', {method: 'GET'}).status, 404);
  await assert.rejects(
    () => store.artistPhoto(Readable.from([Buffer.from('<svg></svg>')]), 'band'),
    /JPEG/
  );
  await assert.rejects(
    () => store.artistPhoto(Readable.from([Buffer.alloc(8 * 1024 * 1024 + 1)]), 'band'),
    /8 МБ/
  );
  assert.deepEqual(store.snapshot(), before);
  const persist = store.persist.bind(store);
  store.persist = () => {
    throw Error('full');
  };
  await assert.rejects(() => store.artistPhoto(Readable.from([bytes]), 'band'));
  assert.deepEqual(store.snapshot(), before);
  assert.ok(fs.existsSync(path.join(dir, 'artist-' + photo + '.jpg')));
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.image')).length, 0);
  store.persist = persist;
  store.change({action: 'artist.save', key: 'band', name: 'Band', bio: '', removePhoto: true});
  assert.equal(store.serveArtistPhoto(photo, {method: 'GET'}).status, 404);
  assert.equal(fs.existsSync(path.join(dir, 'artist-' + photo + '.jpg')), false);
  assert.equal(store.snapshot().tracks[0].cover, true);
});

test('Wave release years sort newest first, ignore invalid dates and keep album track order', async () => {
  const {catalog, releaseYear} = await import('../02-hub/modules/wave/catalog.mjs');
  const result = catalog([
    {id: 'a', title: 'Second', artist: 'Band', album: 'New', year: '2024', trackNumber: 2},
    {id: 'b', title: 'First', artist: 'Band', album: 'New', year: '2024-05-01', trackNumber: 1},
    {id: 'c', title: 'Old', artist: 'Band', album: 'Old', year: '2001'},
    {id: 'd', title: 'Unknown', artist: 'Band', album: 'A no year', year: 'garbage'},
    {id: 'e', title: 'Single', artist: 'Band', album: '', year: '2025'}
  ]);
  assert.deepEqual(
    result.albums.map((a) => a.year),
    [2024, 2001, 0]
  );
  assert.deepEqual(
    result.albums[0].tracks.map((t) => t.id),
    ['b', 'a']
  );
  assert.equal(result.releases[0].type, 'single');
  assert.equal(releaseYear('0000'), 0);
  assert.equal(releaseYear('2024junk'), 0);
});

test('Wave edits and clears the year for every track in a release without changing its order', async (t) => {
  const {WaveStore} = await import('../02-hub/modules/wave/store.mjs');
  const {albumKey} = await import('../02-hub/modules/wave/catalog.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-year-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const store = new WaveStore(dir);
  store.data.tracks = [1, 2].map((n) => ({
    id: crypto.randomUUID(),
    title: 'Track ' + n,
    artist: 'Band',
    album: 'Release',
    year: '2000',
    trackNumber: n
  }));
  store.persist();
  const key = albumKey(store.data.tracks[0]);
  const before = store.snapshot();
  assert.throws(
    () => store.change({action: 'release.type', key, type: 'single', year: '2026abc'}),
    /четыре/
  );
  assert.deepEqual(store.snapshot(), before);
  store.change({action: 'release.type', key, type: 'album', year: '2021'});
  assert.ok(new WaveStore(dir).snapshot().tracks.every((t) => t.year === '2021'));
  store.change({action: 'release.type', key, type: 'single'});
  assert.ok(store.snapshot().tracks.every((t) => t.year === '2021'));
  store.change({action: 'release.type', key, type: 'album', year: ''});
  assert.ok(store.snapshot().tracks.every((t) => t.year === ''));
  assert.deepEqual(
    store.snapshot().tracks.map((t) => t.trackNumber),
    [1, 2]
  );
});

// tests/server-cache
{
  const {FileCache} = await import('../02-hub/src/cache.mjs');
  test('server cache survives restart, expires, stays private and prunes by size and count', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cache-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    let now = Date.now();
    const options = {ttl: 100, retention: 1000, maxEntries: 2, maxBytes: 512, now: () => now};
    let cache = new FileCache(directory, options);
    cache.put('https://example.test/one', {type: 'image/png', data: Buffer.from('first')});
    cache = new FileCache(directory, options);
    assert.equal(cache.get('https://example.test/one').data.toString(), 'first');
    assert.equal(cache.get('https://example.test/one').stale, false);
    assert.equal(fs.statSync(cache.file('https://example.test/one')).mode & 0o777, 0o600);
    now += 101;
    assert.equal(cache.get('https://example.test/one').stale, true);
    cache.put('two', {type: 'image/png', data: Buffer.from('second')});
    now++;
    cache.put('three', {type: 'image/png', data: Buffer.from('third')});
    assert.equal(cache.get('https://example.test/one'), null);
    cache.put('oversize', {type: 'image/png', data: Buffer.alloc(1024)});
    assert.equal(cache.get('oversize'), null);
    now += 1001;
    cache.prune();
    assert.equal(fs.readdirSync(directory).length, 0);
  });
  test('persistent cover cache serves a restarted module without another remote request', async (t) => {
    const {TrophiesStore} = await import('../02-hub/modules/trophies/store.mjs');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cover-restart-'));
    let store = new TrophiesStore(directory, {
      fetcher: async () => new Response('image', {headers: {'Content-Type': 'image/png'}})
    });
    t.after(async () => {
      await store.close();
      fs.rmSync(directory, {recursive: true, force: true});
    });
    store.load();
    const account = {id: 'test'};
    store.set('steam', account);
    store.commitGame('steam', account, {
      id: '1',
      cover: 'https://shared.akamai.steamstatic.com/steam/apps/1/header.jpg',
      achievements: []
    });
    await store.cover('steam', '1');
    await store.close();
    store = new TrophiesStore(directory, {
      fetcher: async () => assert.fail('Warm cache must not fetch')
    });
    assert.equal((await store.cover('steam', '1')).data.toString(), 'image');
  });
}

// Главная: обновления без пересоздания неизменившихся карточек.
{
  const {runInNewContext} = await import('node:vm');
  const source = fs.readFileSync(new URL('../02-hub/public/app.js', import.meta.url), 'utf8');
  function frontend() {
    class Node extends EventTarget {
      constructor() {
        super();
        this.children = [];
        this.dataset = {};
        this.attributes = {};
      }
      querySelectorAll(selector) {
        const all = this.children.flatMap(node => [node, ...node.querySelectorAll('*')]);
        return all.filter(node => selector === '*' || (selector.startsWith('.') ? node.className === selector.slice(1) : node.tagName === selector));
      }
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
      append(...nodes) {
        this.children.push(...nodes);
      }
      prepend(...nodes) {
        this.children.unshift(...nodes);
      }
      replaceChildren(...nodes) {
        this.children = nodes;
      }
      setAttribute(key, value) {
        this.attributes[key] = value;
      }
      removeAttribute(key) {
        delete this.attributes[key];
        delete this[key];
      }
      set textContent(value) {
        this.text = value;
        this.children = [];
      }
      get textContent() {
        return this.children.length
          ? this.children.map((n) => n.textContent).join('')
          : (this.text ?? '');
      }
    }
    const card = new Node();
    card.dataset.summary = 'pulse';
    card.textContent = 'Получаем данные…';
    const document = new EventTarget(),
      window = new EventTarget(),
      timers = new Map();
    document.createElement = tag => Object.assign(new Node(), {tagName: tag});
    document.createElementNS = (ns, tag) => document.createElement(tag);
    document.querySelectorAll = () => [card];
    document.hidden = false;
    let next = 0,
      handler = async () => ({
        ok: true,
        json: async () => ({
          modules: [{id: 'pulse', summary: {state: 'ok', items: [{label: 'CPU', value: '12%'}]}}]
        })
      });
    const context = {
      window,
      document,
      navigator: {onLine: true},
      AbortController,
      AbortSignal,
      location: {replace() {}},
      addEventListener: window.addEventListener.bind(window),
      setTimeout: (fn, ms) => {
        timers.set(++next, {fn, ms});
        return next;
      },
      clearTimeout: (id) => timers.delete(id),
      fetch: (...args) => handler(...args)
    };
    runInNewContext(
      source.slice(
        source.indexOf('const summaries ='),
        source.indexOf("addEventListener('keydown'")
      ) + '\nglobalThis.api = {renderSummary, refreshSummaries};',
      context
    );
    return {
      card,
      document,
      window,
      timers,
      context,
      ...context.api,
      setFetch: (fn) => {
        handler = fn;
      }
    };
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  test('dashboard preserves unchanged DOM and last successful data through a failed refresh', async () => {
    const f = frontend();
    await settle();
    const stats = f.card.children[0];
    await f.refreshSummaries();
    assert.equal(f.card.children[0], stats);
    f.setFetch(async () => {
      throw new Error('offline');
    });
    await f.refreshSummaries();
    assert.equal(f.card.children[0], stats);
    assert.equal(f.card.dataset.state, 'stale');
    assert.match(f.card.title, /последние/);
    f.renderSummary(f.card, {state: 'ok', items: [{label: 'CPU', value: '12%'}]});
    assert.equal(f.card.children[0], stats);
    assert.equal(f.card.dataset.state, 'ok');
    assert.equal(f.card.title, undefined);
    f.renderSummary(f.card, {state: 'ok', items: [{label: 'CPU', value: '13%'}]});
    assert.equal(f.card.children[0], stats);
    assert.equal(f.card.querySelector('meter').value, 13);
    assert.match(f.card.textContent, /13%/);
  });
  test('dashboard renders a disk snapshot as stale and timestamp updates do not rebuild its content', async () => {
    const f = frontend();
    await settle();
    const data = {state: 'ok', items: [{label: 'CPU', value: '12%'}]};
    const stats = f.card.children[0];
    f.renderSummary(f.card, data, {stale: true, updatedAt: 100000});
    assert.equal(f.card.children[0], stats);
    assert.equal(f.card.dataset.state, 'stale');
    assert.match(f.card.title, /Данные не обновлены/);
    f.renderSummary(f.card, data, {stale: false, updatedAt: 200000});
    assert.equal(f.card.children[0], stats);
    assert.equal(f.card.dataset.state, 'ok');
    assert.match(f.card.title, /Обновлено:/);
  });
  test('dashboard initial failure replaces loading text and backs off requests', async () => {
    const f = frontend();
    await settle();
    const fresh = new f.card.constructor();
    fresh.textContent = 'Получаем данные…';
    f.renderSummary(fresh, null);
    assert.equal(fresh.textContent, 'Нет свежих данных');
    f.setFetch(async () => {
      throw new Error('unavailable');
    });
    for (const expected of [20000, 40000, 60000, 60000]) {
      await f.refreshSummaries();
      assert.equal([...f.timers.values()][0].ms, expected);
    }
  });
  test('dashboard aborts hidden or departed requests and never overlaps polling', async () => {
    const f = frontend();
    await settle();
    let requests = 0,
      signal;
    f.setFetch(
      (url, options) =>
        new Promise((resolve, reject) => {
          requests++;
          signal = options.signal;
          signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
        })
    );
    const pending = f.refreshSummaries();
    await f.refreshSummaries();
    assert.equal(requests, 1);
    f.document.hidden = true;
    f.document.dispatchEvent(new Event('visibilitychange'));
    await pending;
    assert.equal(signal.aborted, true);
    assert.equal(f.timers.size, 0);
    assert.equal(f.card.dataset.state, 'ok');
    f.document.hidden = false;
    f.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(requests, 2);
    f.window.dispatchEvent(new Event('pagehide'));
    await settle();
    assert.equal(signal.aborted, true);
    assert.equal(f.timers.size, 0);
    await f.refreshSummaries();
    assert.equal(requests, 2);
  });
}

// Серверная сводка главной.
{
  const {DashboardCache} = await import('../02-hub/src/modules.mjs');
  const summary = (value) => ({
    state: 'ok',
    items: [{label: 'Значение', value}],
    secret: 'do-not-save'
  });
  test('dashboard cache returns immediately during refresh and schedules resources separately', async (t) => {
    let now = 100000,
      pulse = 0,
      balance = 0,
      resolve;
    const modules = new Map([
      ['pulse', {id: 'pulse', title: 'Атлас', summary: () => summary(++pulse)}],
      ['balance', {id: 'balance', title: 'Плутос', summary: () => summary(++balance)}]
    ]);
    const cache = new DashboardCache(modules, {now: () => now});
    t.after(() => cache.close());
    await cache.refresh();
    assert.equal(pulse, 1);
    assert.equal(balance, 1);
    now += 10000;
    await cache.refresh();
    assert.equal(pulse, 2);
    assert.equal(balance, 1);
    modules.get('balance').summary = () =>
      new Promise((r) => {
        resolve = r;
      });
    cache.invalidate('balance');
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 100; i++)
      assert.equal(JSON.parse(cache.read()).modules[1].summary.items[0].value, '1');
    resolve(summary(2));
    await cache.refresh();
    assert.equal(JSON.parse(cache.read()).modules[1].summary.items[0].value, '2');
  });
  test('dashboard snapshot survives restart privately, strips secrets and rejects another identity', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dashboard-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const file = path.join(dir, 'dashboard.json'),
      modules = new Map([['balance', {id: 'balance', summary: () => summary(42)}]]);
    const cache = new DashboardCache(modules, {file, identity: 'account-a'});
    await cache.refresh();
    cache.close();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /do-not-save|secret/);
    const restored = new DashboardCache(modules, {file, identity: 'account-a'});
    const record = JSON.parse(restored.read()).modules[0];
    assert.equal(record.summary.items[0].value, '42');
    assert.equal(record.stale, true);
    assert.ok(record.updatedAt > 0);
    const foreign = new DashboardCache(modules, {file, identity: 'account-b'});
    assert.deepEqual(JSON.parse(foreign.read()).modules[0].summary.items, []);
    const expired = new DashboardCache(modules, {
      file,
      identity: 'account-a',
      now: () => Date.now() + 86400001
    });
    assert.deepEqual(JSON.parse(expired.read()).modules[0].summary.items, []);
  });
  test('dashboard keeps prior successful values on timeout and recovers after invalidation', async (t) => {
    let now = 100000;
    const module = {id: 'pulse', summary: () => summary(7)};
    const cache = new DashboardCache(new Map([['pulse', module]]), {now: () => now, timeout: 15});
    t.after(() => cache.close());
    await cache.refresh();
    module.summary = () => new Promise(() => {});
    now += 10000;
    await cache.refresh();
    let record = JSON.parse(cache.read()).modules[0];
    assert.equal(record.stale, true);
    assert.equal(record.summary.items[0].value, '7');
    assert.equal(record.updatedAt, 100000);
    module.summary = () => summary(8);
    cache.invalidate('pulse');
    await cache.refresh();
    record = JSON.parse(cache.read()).modules[0];
    assert.equal(record.stale, false);
    assert.equal(record.summary.items[0].value, '8');
  });
  test('dashboard invalidation during refresh is not lost and concurrent readers do not start jobs', async (t) => {
    let resolve,
      calls = 0;
    const module = {
      id: 'balance',
      summary: () => {
        calls++;
        return calls === 1
          ? new Promise((r) => {
              resolve = r;
            })
          : summary(2);
      }
    };
    const cache = new DashboardCache(new Map([['balance', module]]));
    t.after(() => cache.close());
    const initial = cache.refresh();
    await new Promise((r) => setImmediate(r));
    cache.invalidate('balance');
    cache.refresh();
    assert.equal(calls, 1);
    resolve(summary(1));
    await initial;
    await new Promise((r) => setImmediate(r));
    await cache.refresh();
    assert.equal(calls, 2);
    assert.equal(JSON.parse(cache.read()).modules[0].summary.items[0].value, '2');
  });
  test('dashboard corrupted or unwritable disk never blocks the in-memory response', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dashboard-bad-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const file = path.join(dir, 'broken');
    fs.writeFileSync(file, '{invalid');
    const modules = new Map([['balance', {id: 'balance', summary: () => summary(9)}]]);
    const broken = new DashboardCache(modules, {file});
    await broken.refresh();
    broken.close();
    assert.equal(JSON.parse(broken.read()).modules[0].summary.items[0].value, '9');
    const blocked = new DashboardCache(modules, {file: path.join(file, 'cannot-write')});
    await blocked.refresh();
    blocked.close();
    assert.equal(JSON.parse(blocked.read()).modules[0].summary.items[0].value, '9');
  });
}

// Возврат в мобильную оболочку плеера.
{
  const {runInNewContext} = await import('node:vm');
  const source = fs.readFileSync(
    new URL('../02-hub/modules/wave/player.js', import.meta.url),
    'utf8'
  );
  test('player restores visible viewport geometry without restoring a stale fullscreen history marker', () => {
    const window = new EventTarget(),
      document = new EventTarget(),
      values = {},
      frames = new Map(),
      timers = new Map();
    let next = 0;
    const viewport = new EventTarget();
    Object.assign(viewport, {height: 740, offsetTop: 0, scale: 1});
    window.visualViewport = viewport;
    document.documentElement = {
      style: {
        setProperty: (k, v) => {
          values[k] = v;
        }
      }
    };
    const history = {
      state: {nexusWavePlayer: true, other: 42},
      replaceState(state) {
        this.state = state;
      }
    };
    runInNewContext(
      source.slice(
        source.indexOf('  let overlayHistory = false;'),
        source.indexOf('  function expanded(')
      ),
      {
        window,
        document,
        history,
        innerHeight: 844,
        addEventListener: window.addEventListener.bind(window),
        requestAnimationFrame: (fn) => {
          frames.set(++next, fn);
          return next;
        },
        cancelAnimationFrame: (id) => frames.delete(id),
        setTimeout: (fn) => {
          timers.set(++next, fn);
          return next;
        },
        clearTimeout: (id) => timers.delete(id)
      }
    );
    const draw = () => {
      const jobs = [...frames.values()];
      frames.clear();
      jobs.forEach((fn) => fn());
    };
    draw();
    assert.equal(history.state.nexusWavePlayer, undefined);
    assert.equal(history.state.other, 42);
    assert.equal(values['--wave-viewport-height'], '740px');
    viewport.height = 500;
    viewport.offsetTop = 12;
    viewport.dispatchEvent(new Event('resize'));
    draw();
    assert.equal(values['--wave-viewport-height'], '500px');
    assert.equal(values['--wave-viewport-top'], '12px');
    document.hidden = false;
    viewport.height = 844;
    viewport.offsetTop = 0;
    document.dispatchEvent(new Event('visibilitychange'));
    draw();
    assert.equal(values['--wave-viewport-height'], '844px');
    assert.equal(values['--wave-viewport-top'], '0px');
    viewport.scale = 2;
    viewport.height = 300;
    viewport.dispatchEvent(new Event('resize'));
    draw();
    assert.equal(values['--wave-viewport-height'], '844px');
    window.dispatchEvent(new Event('pagehide'));
    assert.equal(frames.size, 0);
    assert.equal(timers.size, 0);
  });
  test('player never overwrites the restored position before audio metadata arrives', () => {
    const state = {position: 73},
      audio = {currentTime: 0, readyState: 0};
    let saved;
    const ctx = {
      state,
      audio,
      restoring: 73,
      loaded: 'track',
      signingOut: false,
      key: 'test',
      localStorage: {
        setItem: (key, value) => {
          saved = JSON.parse(value);
        }
      },
      note() {}
    };
    runInNewContext(
      source.slice(source.indexOf('  function save()'), source.indexOf('  function paint()')) +
        '\nsave();',
      ctx
    );
    assert.equal(saved.position, 73);
    ctx.restoring = 0;
    runInNewContext('save()', ctx);
    assert.equal(saved.position, 73);
    audio.readyState = 1;
    audio.currentTime = 76;
    runInNewContext('save()', ctx);
    assert.equal(saved.position, 76);
  });
}

// Очередь и непрерывное переключение на одном audio.
{
  const {runInNewContext} = await import('node:vm');
  const source = fs.readFileSync(
    new URL('../02-hub/modules/wave/player.js', import.meta.url),
    'utf8'
  );
  function playerHarness(ids = ['a', 'b', 'c', 'd'], overrides = {}) {
    class Node extends EventTarget {
      constructor() {
        super();
        this.classList = {contains: () => false};
        this.style = {setProperty() {}};
        this.children = [];
      }
      setAttribute() {}
      removeAttribute() {}
      close() {
        this.open = false;
      }
      append(...nodes) {
        this.children.push(...nodes);
      }
      replaceChildren(...nodes) {
        this.children = nodes;
      }
    }
    class Audio extends Node {
      constructor() {
        super();
        this.paused = true;
        this.currentTime = 0;
        this.readyState = 1;
        this.duration = 120;
        this.error = null;
        this.ended = false;
        this.playCalls = 0;
        this.pauseCalls = 0;
        this.loadCalls = 0;
        this.mode = null;
      }
      set src(value) {
        this.url = value;
        this.currentTime = 0;
        this.ended = false;
        this.error = null;
        this.paused = true;
        this.dispatchEvent(new Event('pause'));
      }
      get src() {
        return this.url;
      }
      load() {
        this.loadCalls++;
      }
      pause() {
        this.pauseCalls++;
        this.paused = true;
        this.dispatchEvent(new Event('pause'));
      }
      play() {
        this.playCalls++;
        const mode = this.mode;
        this.mode = null;
        if (mode) return mode();
        this.paused = false;
        this.dispatchEvent(new Event('play'));
        this.dispatchEvent(new Event('playing'));
        return Promise.resolve();
      }
      finish() {
        this.currentTime = this.duration;
        this.ended = true;
        this.paused = true;
        this.dispatchEvent(new Event('pause'));
        this.dispatchEvent(new Event('ended'));
      }
    }
    const audio = new Audio(),
      nodes = new Map(),
      $ = (id) => {
        if (!nodes.has(id)) nodes.set(id, new Node());
        return nodes.get(id);
      };
    const window = new EventTarget(),
      document = new EventTarget(),
      timers = new Map();
    let counter = 0;
    document.createElement = () => new Node();
    const ctx = {
      audio,
      $,
      frame: {contentWindow: {postMessage() {}}, contentDocument: {querySelectorAll: () => []}},
      player: $('wavePlayer'),
      window,
      document,
      navigator: {onLine: true, mediaSession: {setPositionState() {}}},
      location: {origin: 'https://hub.example'},
      localStorage: {getItem: () => null, setItem() {}},
      symbol: () => '',
      expanded() {},
      checkSession() {},
      addEventListener: window.addEventListener.bind(window),
      setTimeout: (fn) => {
        timers.set(++counter, fn);
        return counter;
      },
      clearTimeout: (id) => timers.delete(id),
      ...overrides
    };
    const stateBlock = source.slice(
      source.indexOf("  const key = 'nexus-wave-v1';"),
      source.indexOf('  let transfer =')
    );
    const eventBlock = source.slice(
      source.indexOf("  audio.addEventListener('loadedmetadata'"),
      source.indexOf('  if (navigator.mediaSession) {')
    );
    runInNewContext(
      stateBlock +
        eventBlock +
        `
      library = {tracks: ${JSON.stringify(ids.map((id) => ({id, title: id})))}, playlists: []};
      state.queue = ${JSON.stringify(ids)}; state.order = [...state.queue]; ready = true;
      globalThis.api = {select, resumeFromControl, next, pausePlayback, shuffleTracks, save, preloadQueue, clearAudioCache, cached: () => [...audioCache.keys()], getState: () => state, getIntent: () => intentPlaying};`,
      ctx
    );
    return {audio, $, ctx, timers, ...ctx.api};
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  test('shuffle plays every track once, ends without repeat, and reshuffles without a boundary duplicate', async () => {
    const f = playerHarness(Array.from({length: 20}, (_, i) => String(i)));
    const state = f.getState();
    state.shuffle = true;
    state.queue = f.shuffleTracks(state.queue, '0');
    await f.select();
    const played = [state.queue[state.index]];
    for (let i = 1; i < state.queue.length; i++) {
      f.audio.finish();
      await flush();
      played.push(state.queue[state.index]);
    }
    assert.equal(new Set(played).size, 20);
    assert.equal(f.audio.playCalls, 20);
    assert.equal(f.audio.pauseCalls, 0);
    assert.equal(f.audio.loadCalls, 0);
    f.audio.finish();
    await flush();
    assert.equal(f.getIntent(), false);
    assert.equal(f.audio.playCalls, 20);
    state.repeat = 'all';
    const previous = state.queue[state.index];
    await f.next(1, true);
    assert.notEqual(state.queue[0], previous);
    assert.equal(new Set(state.queue).size, 20);
    const second = [state.queue[0]];
    for (let i = 1; i < 20; i++) {
      f.audio.finish();
      await flush();
      second.push(state.queue[state.index]);
    }
    assert.equal(new Set(second).size, 20);
    const saved = JSON.parse(JSON.stringify(state));
    assert.deepEqual(saved.queue, Array.from(state.queue));
    assert.equal(saved.index, 19);
  });
  test('a superseded play rejection cannot stop the next track or show a false autoplay error', async () => {
    const f = playerHarness();
    let reject;
    f.audio.mode = () =>
      new Promise((resolve, r) => {
        reject = r;
      });
    const first = f.select();
    await f.next();
    reject(Object.assign(new Error('replaced'), {name: 'AbortError'}));
    await first;
    assert.equal(f.getState().index, 1);
    assert.equal(f.getIntent(), true);
    assert.equal(f.$('wavePlayerStatus').textContent, '');
    assert.equal(f.timers.size, 0);
  });
  test('user pause cancels pending start and recovery without advancing the queue', async () => {
    const f = playerHarness();
    let reject;
    f.audio.mode = () =>
      new Promise((resolve, r) => {
        reject = r;
      });
    const started = f.select();
    f.pausePlayback();
    reject(Object.assign(new Error('paused'), {name: 'AbortError'}));
    await started;
    assert.equal(f.getIntent(), false);
    assert.equal(f.timers.size, 0);
    assert.equal(f.getState().index, 0);
  });
  test('network interruption retries the same track at its position with a bounded attempt count', async () => {
    const f = playerHarness();
    await f.select();
    f.audio.currentTime = 37;
    const fail = () => {
      f.audio.error = {code: 2};
      f.audio.dispatchEvent(new Event('error'));
    };
    for (let i = 0; i < 2; i++) {
      fail();
      assert.equal(f.timers.size, 1);
      const [id, fn] = [...f.timers][0];
      f.timers.delete(id);
      fn();
      await flush();
      assert.equal(f.getState().index, 0);
      assert.equal(f.getState().position, 37);
    }
    fail();
    assert.equal(f.timers.size, 0);
    assert.equal(f.getIntent(), false);
    assert.match(f.$('wavePlayerStatus').textContent, /повторить/);
  });
  test('headset play restores the same position after a media error', async () => {
    const f = playerHarness();
    await f.select(); f.audio.currentTime = 47;
    f.audio.error = {code: 2}; f.pausePlayback();
    await f.resumeFromControl();
    f.audio.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(f.audio.currentTime, 47);
    assert.equal(f.getState().index, 0);
    assert.equal(f.getIntent(), true);
  });
  test('headset play after pause does not reload or rewind the current source', async () => {
    const f = playerHarness(); await f.select(); f.audio.currentTime = 53;
    f.pausePlayback(); const source = f.audio.src;
    await f.resumeFromControl();
    assert.equal(f.audio.src, source); assert.equal(f.audio.currentTime, 53);
    assert.equal(f.audio.loadCalls, 0);
  });
  test('actual autoplay denial is reported without an automatic retry loop', async () => {
    const f = playerHarness();
    f.audio.mode = () =>
      Promise.reject(Object.assign(new Error('blocked'), {name: 'NotAllowedError'}));
    await f.select();
    assert.equal(f.getIntent(), false);
    assert.equal(f.timers.size, 0);
    assert.match(f.$('wavePlayerStatus').textContent, /Браузер остановил/);
  });
  test('background interruption resumes at the saved position, but explicit pause stays paused', async () => {
    const f = playerHarness();
    await f.select();
    f.audio.currentTime = 43;
    f.ctx.document.hidden = true;
    f.audio.pause();
    assert.equal(f.getIntent(), false);
    assert.equal(f.audio.playCalls, 1);
    f.ctx.document.hidden = false;
    f.ctx.document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    assert.equal(f.getIntent(), true);
    assert.equal(f.audio.currentTime, 43);
    f.ctx.document.hidden = true;
    f.pausePlayback();
    f.ctx.document.hidden = false;
    f.ctx.window.dispatchEvent(new Event('pageshow'));
    await flush();
    assert.equal(f.getIntent(), false);
    assert.equal(f.audio.playCalls, 2);
  });
  test('network error pause does not cancel recovery and progressing playback resets retry budget', async () => {
    const f = playerHarness();
    await f.select();
    for (let i = 1; i <= 4; i++) {
      f.audio.currentTime = i * 10;
      f.audio.dispatchEvent(new Event('timeupdate'));
      f.audio.error = {code:2};
      f.audio.pause();
      f.audio.dispatchEvent(new Event('error'));
      assert.equal(f.getIntent(), true);
      const [id, fn] = [...f.timers][0];
      f.timers.delete(id); fn(); await flush();
      f.audio.dispatchEvent(new Event('loadedmetadata'));
      assert.equal(f.audio.currentTime, i * 10);
    }
  });
  function cachingPlayer(ids = ['a','b','c','d']) {
    const pending = [], revoked = [], blobs = [];
    class BlobURL extends URL {}
    BlobURL.createObjectURL = blob => { blobs.push(blob); return 'blob:track-' + blobs.length; };
    BlobURL.revokeObjectURL = url => revoked.push(url);
    const f = playerHarness(ids, {URL:BlobURL, Blob, AbortController, AbortSignal,
      fetch:(url, options) => new Promise((resolve,reject) => {
        options.signal.addEventListener('abort', () => reject(Error('aborted')), {once:true});
        pending.push({url, options, resolve, reject});
      })});
    return {...f, pending, revoked, blobs, complete:async (index, response) => {
      pending[index].resolve(response || new Response('audio', {headers:{'content-type':'audio/mpeg','content-length':'5'}}));
      await flush(); await flush();
    }};
  }
  test('audio cache loads current before next, uses ready blobs and evicts past tracks', async () => {
    const f = cachingPlayer();
    await f.select();
    assert.equal(f.pending.length, 1);
    assert.equal(f.pending[0].url, '/modules/wave/audio/a');
    assert.equal(f.audio.src, '/modules/wave/audio/a');
    assert.equal(f.pending[0].options.cache, 'no-store');
    await f.complete(0);
    assert.equal(f.pending.length, 2);
    assert.equal(f.pending[1].url, '/modules/wave/audio/b');
    await f.complete(1);
    assert.deepEqual(Array.from(f.cached()), ['a','b']);
    assert.equal(f.audio.src, '/modules/wave/audio/a');
    f.audio.finish(); await flush();
    assert.equal(f.audio.src, 'blob:track-2');
    assert.equal(f.pending[2].url, '/modules/wave/audio/c');
    assert.deepEqual(f.revoked, ['blob:track-1']);
    await f.complete(2);
    assert.deepEqual(Array.from(f.cached()), ['b','c']);
    f.clearAudioCache();
    assert.equal(f.cached().length, 0);
    assert.equal(f.revoked.length, 3);
  });
  test('rapid skips abort obsolete cache loads and failed or oversized downloads never block playback', async () => {
    const f = cachingPlayer();
    await f.select();
    await f.next();
    assert.equal(f.pending[0].options.signal.aborted, true);
    assert.equal(f.pending[1].url, '/modules/wave/audio/b');
    await f.complete(0);
    assert.equal(f.cached().length, 0);
    await f.complete(1, new Response('large', {headers:{'content-type':'audio/mpeg','content-length':String(33*1024*1024)}}));
    assert.equal(f.pending[2].url, '/modules/wave/audio/c');
    await f.complete(2, new Response('login', {headers:{'content-type':'text/html'}}));
    assert.equal(f.cached().length, 0);
    assert.equal(f.pending.length, 3);
    assert.equal(f.getIntent(), true);
    assert.equal(f.getState().index, 1);
    f.clearAudioCache();
  });
  test('incomplete cached audio is rejected and shuffle wrap plays the prefetched successor', async () => {
    const f = cachingPlayer();
    const state = f.getState();
    state.index = 3; state.shuffle = true; state.repeat = 'all';
    await f.select();
    await f.complete(0, new Response('short',{headers:{'content-type':'audio/mpeg','content-length':'100'}}));
    assert.equal(f.cached().length, 0);
    const next = f.pending[1].url.split('/').at(-1);
    assert.notEqual(next, 'd');
    await f.complete(1);
    f.audio.finish(); await flush();
    assert.equal(state.queue[state.index], next);
    assert.equal(f.audio.src, 'blob:track-1');
    f.clearAudioCache();
  });

}

// Закрытие окон, история и восстановление прокрутки.
{
  const {runInNewContext} = await import('node:vm');
  const source = fs.readFileSync(new URL('../02-hub/public/ui.js', import.meta.url), 'utf8');
  function modalPage(parent) {
    const listeners = new Map(),
      documentListeners = new Map(),
      dialogs = [],
      styles = new Map(),
      classes = new Set();
    let observer,
      x = 0,
      y = 640,
      backCalls = 0;
    const on = (map, name, fn) => map.set(name, [...(map.get(name) || []), fn]);
    const fire = (map, name, event = {}) => {
      let stopped = false;
      const e = {
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopImmediatePropagation() {
          stopped = true;
        },
        ...event
      };
      for (const fn of map.get(name) || []) {
        fn(e);
        if (stopped) break;
      }
      return e;
    };
    const root = {
      classList: {add: (name) => classes.add(name), remove: (name) => classes.delete(name)},
      style: {
        setProperty: (key, value, priority = '') => styles.set(key, {value, priority}),
        getPropertyValue: (key) => styles.get(key)?.value || '',
        getPropertyPriority: (key) => styles.get(key)?.priority || '',
        removeProperty: (key) => styles.delete(key)
      }
    };
    const document = {
      documentElement: root,
      body: {},
      querySelectorAll: () => dialogs.filter((d) => d.open && d.isConnected),
      addEventListener: (name, fn) => on(documentListeners, name, fn)
    };
    const history = {
      state: {},
      pushState(state) {
        this.state = state;
      },
      replaceState(state) {
        this.state = state;
      },
      back() {
        backCalls++;
      }
    };
    const window = {document, history};
    window.parent = parent || window;
    const ctx = {
      window,
      document,
      history,
      location: {href: 'https://hub.test/modules/anime/'},
      Event,
      matchMedia: () => ({matches: false}),
      addEventListener: (name, fn) => on(listeners, name, fn),
      MutationObserver: class {
        constructor(fn) {
          observer = fn;
        }
        observe() {}
      },
      get scrollX() {
        return x;
      },
      get scrollY() {
        return y;
      },
      scrollTo: (sx, sy) => {
        x = sx;
        y = sy;
      },
      innerWidth: 400
    };
    runInNewContext(source, ctx);
    const open = () => {
      const d = {
        open: true,
        isConnected: true,
        ownerDocument: document,
        tagName: 'DIALOG',
        matches: (selector) => selector === ':modal' && d.open,
        querySelector: () => null,
        querySelectorAll: () => [],
        dispatchEvent: () => true,
        close() {
          d.open = false;
        }
      };
      dialogs.push(d);
      observer();
      return d;
    };
    const back = () => {
      history.state = {};
      fire(listeners, 'popstate');
    };
    return {
      window,
      open,
      back,
      styles,
      root,
      document,
      history,
      locked: () => classes.has('nexus-dialog-open'),
      scroll: () => [x, y],
      setScroll: (sx, sy) => {
        x = sx;
        y = sy;
      },
      backCalls: () => backCalls,
      mutate: () => observer(),
      fire: (name, e) => fire(listeners, name, e),
      closeEvent: (d) => fire(documentListeners, 'close', {target: d})
    };
  }
  test('Back closes a scrolled modal and immediately restores background scroll without waiting for an observer', () => {
    const page = modalPage();
    page.root.style.setProperty('--wave-viewport-height', '720px');
    page.root.style.setProperty('scroll-behavior', 'smooth', 'important');
    const dialog = page.open();
    assert.equal(page.locked(), true);
    page.setScroll(0, 0);
    page.root.style.setProperty('--wave-viewport-height', '680px');
    page.back();
    assert.equal(dialog.open, false);
    assert.equal(page.locked(), false);
    assert.deepEqual(page.scroll(), [0, 640]);
    assert.equal(page.root.style.getPropertyValue('--wave-viewport-height'), '680px');
    assert.equal(page.root.style.getPropertyValue('scroll-behavior'), 'smooth');
    assert.equal(page.root.style.getPropertyPriority('scroll-behavior'), 'important');
    assert.equal(page.styles.has('--nexus-dialog-y'), false);
    assert.equal(page.backCalls(), 0);
  });
  test('direct dialog close restores scrolling through the captured close event', () => {
    const page = modalPage(),
      dialog = page.open();
    dialog.close();
    page.closeEvent(dialog);
    assert.equal(page.locked(), false);
    assert.equal(page.backCalls(), 1);
  });
  test('nested dialogs keep the background locked until the final Back', () => {
    const page = modalPage(),
      first = page.open(),
      second = page.open();
    page.back();
    assert.equal(second.open, false);
    assert.equal(first.open, true);
    assert.equal(page.locked(), true);
    page.back();
    assert.equal(first.open, false);
    assert.equal(page.locked(), false);
  });
  test('pagehide unlocks without navigating again; pageshow rechecks the restored modal', () => {
    const page = modalPage(),
      dialog = page.open();
    page.fire('pagehide');
    assert.equal(page.locked(), false);
    assert.equal(page.backCalls(), 0);
    page.mutate();
    assert.equal(page.locked(), false);
    page.fire('pageshow');
    assert.equal(page.locked(), true);
    page.back();
    assert.equal(dialog.open, false);
    assert.equal(page.locked(), false);
  });
  test('removing an open dialog also releases the scroll lock', () => {
    const page = modalPage(),
      dialog = page.open();
    dialog.isConnected = false;
    page.mutate();
    assert.equal(page.locked(), false);
  });
  test('parent Back closes an iframe modal and unlocks its document', () => {
    const shell = modalPage(),
      page = modalPage(shell.window),
      dialog = page.open();
    assert.equal(page.locked(), true);
    shell.back();
    assert.equal(dialog.open, false);
    assert.equal(page.locked(), false);
    assert.equal(shell.backCalls(), 0);
  });
  test('Backspace closes the modal without leaving its page', () => {
    const page = modalPage(),
      dialog = page.open();
    const event = page.fire('keydown', {key: 'Backspace', target: {closest: () => null}});
    assert.equal(event.defaultPrevented, true);
    assert.equal(dialog.open, false);
    assert.equal(page.locked(), false);
    assert.equal(page.backCalls(), 1);
  });
}

// Доступ: криптографические проверки и HTTP-сценарии.
{
  const {generateKeyPairSync, sign, createHash} = await import('node:crypto');
  const {Security} = await import('../02-hub/src/security.mjs');
  const {registerKey, verifyKey} = await import('../02-hub/src/passkeys.mjs');
  const {Sessions, passwordHash, authIdentity} = await import('../02-hub/src/auth.mjs');
  const {createApp} = await import('../02-hub/src/server.mjs');
  const {Rules} = await import('../host/signal-rules.mjs');
  const password = 'test-security-password',
    config = {username: 'admin', origin: 'https://hub.test', ...(await passwordHash(password))};
  const sha = (x) => createHash('sha256').update(x).digest();
  const b64 = (x) => Buffer.from(x).toString('base64url');
  function cbor(value) {
    const prefix = (major, n) =>
      n < 24
        ? Buffer.from([major * 32 + n])
        : n < 256
          ? Buffer.from([major * 32 + 24, n])
          : Buffer.from([major * 32 + 25, n >> 8, n & 255]);
    if (typeof value === 'number') return prefix(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
    if (Buffer.isBuffer(value)) return Buffer.concat([prefix(2, value.length), value]);
    if (typeof value === 'string') {
      const data = Buffer.from(value);
      return Buffer.concat([prefix(3, data.length), data]);
    }
    if (value instanceof Map)
      return Buffer.concat([
        prefix(5, value.size),
        ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])
      ]);
    throw Error('unsupported fixture');
  }
  function authenticator() {
    const pair = generateKeyPairSync('ec', {namedCurve: 'prime256v1'}),
      jwk = pair.publicKey.export({format: 'jwk'});
    const id = Buffer.from('credential-id-for-test'),
      rawId = b64(id);
    const authData = (rp = 'hub.test', flags = 5, count = 0) => {
      const out = Buffer.alloc(37);
      sha(rp).copy(out);
      out[32] = flags;
      out.writeUInt32BE(count, 33);
      return out;
    };
    const client = (challenge, type, extras = {}) =>
      Buffer.from(
        JSON.stringify({type, challenge, origin: config.origin, crossOrigin: false, ...extras})
      );
    return {
      registration(options, extras = {}) {
        const key = cbor(
          new Map([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, Buffer.from(jwk.x, 'base64url')],
            [-3, Buffer.from(jwk.y, 'base64url')]
          ])
        );
        const credential = Buffer.concat([Buffer.alloc(16), Buffer.from([0, id.length]), id, key]);
        const data = Buffer.concat([authData(extras.rp, extras.flags ?? 69), credential]);
        return {
          id: rawId,
          rawId,
          type: 'public-key',
          response: {
            clientDataJSON: b64(client(options.challenge, 'webauthn.create', extras.client)),
            attestationObject: b64(
              cbor(
                new Map([
                  ['fmt', 'none'],
                  ['attStmt', new Map()],
                  ['authData', data]
                ])
              )
            )
          }
        };
      },
      assertion(options, extras = {}) {
        const data = authData(extras.rp, extras.flags ?? 5, extras.count ?? 0),
          json = client(options.challenge, 'webauthn.get', extras.client);
        return {
          id: rawId,
          rawId,
          type: 'public-key',
          response: {
            clientDataJSON: b64(json),
            authenticatorData: b64(data),
            signature: b64(sign('sha256', Buffer.concat([data, sha(json)]), pair.privateKey)),
            ...(extras.userHandle ? {userHandle: extras.userHandle} : {})
          }
        };
      }
    };
  }
  function temp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-security-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    return dir;
  }
  test('passkeys verify real signatures, RP, origin, challenge, UV, counters and user handle', () => {
    const a = authenticator(),
      expected = {
        rpId: 'hub.test',
        origin: config.origin,
        challenge: 'challenge',
        userId: 'dXNlcg'
      };
    const key = registerKey(a.registration(expected), expected);
    assert.equal(verifyKey(a.assertion(expected), expected, key), 0);
    for (const extras of [
      {rp: 'evil.test'},
      {flags: 1},
      {flags: 4},
      {flags: 69},
      {client: {origin: 'https://evil.test'}},
      {client: {challenge: 'other'}},
      {client: {crossOrigin: true}},
      {client: {type: 'webauthn.create'}},
      {userHandle: 'b3RoZXI'}
    ])
      assert.throws(() => verifyKey(a.assertion(expected, extras), expected, key));
    const bad = a.assertion(expected);
    bad.response.signature = b64(Buffer.alloc(64));
    assert.throws(() => verifyKey(bad, expected, key));
    assert.equal(verifyKey(a.assertion(expected, {count: 2}), expected, {...key, count: 1}), 2);
    assert.throws(() => verifyKey(a.assertion(expected, {count: 1}), expected, {...key, count: 1}));
    for (const extras of [
      {rp: 'evil.test'},
      {flags: 65},
      {client: {origin: 'https://evil.test'}},
      {client: {challenge: 'other'}}
    ])
      assert.throws(() => registerKey(a.registration(expected, extras), expected));
    const forged = a.registration(expected);
    forged.rawId = b64('other');
    assert.throws(() => registerKey(forged, expected));
    const malformed = a.registration(expected);
    malformed.response.attestationObject = b64(Buffer.from([0xbf]));
    assert.throws(() => registerKey(malformed, expected));
  });
  test('limits persist after restart; corrupt security storage fails closed', (t) => {
    const file = temp(t) + '/security.json';
    let now = 100000;
    let s = new Security(config, file, {now: () => now});
    for (let i = 0; i < 10; i++) s.limit('192.0.2.1');
    s = new Security(config, file, {now: () => now});
    assert.throws(
      () => s.limit('192.0.2.1'),
      (e) => e.status === 429
    );
    now += 300001;
    s.limit('192.0.2.1');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, '{');
    assert.throws(() => new Security(config, file));
  });
  test('revocation during password hashing cannot commit a new password', async () => {
    const security = new Security(config);
    await assert.rejects(
      security.changePassword('replacement-password', 0, () => false),
      (e) => e.status === 409
    );
    assert.equal(security.state.password, null);
    assert.equal(security.state.epoch, 0);
  });
  test('challenges are one-use, bound to operation and session, expire, and do not survive epoch changes', () => {
    let now = 1000;
    const s = new Security(config, null, {now: () => now}),
      a = authenticator();
    const challenge = s.registration('session');
    assert.throws(() =>
      s.addKey(challenge.id, 'wrong', a.registration(challenge.publicKey), 'Phone')
    );
    assert.throws(() =>
      s.addKey(challenge.id, 'session', a.registration(challenge.publicKey), 'Phone')
    );
    const second = s.registration('session');
    now += 300001;
    assert.throws(() => s.addKey(second.id, 'session', a.registration(second.publicKey), 'Phone'));
    const grant = s.grant('session', 'password');
    assert.throws(() => s.consumeGrant(grant, 'session', 'remove-key'));
    assert.throws(() => s.consumeGrant(grant, 'session', 'password'));
    const pending = s.beginLogin('ip', 'agent');
    s.save({...s.state, epoch: 1});
    assert.throws(() => s.loginPending(pending, 'ip', 'agent'));
  });
  test('sessions migrate, list devices, revoke others, and shorten without extending older expiry', (t) => {
    const file = temp(t) + '/sessions.json',
      identity = authIdentity(config),
      token = 'a'.repeat(64);
    fs.writeFileSync(
      file,
      JSON.stringify({identity, entries: [[sha(token).toString('hex'), Date.now() + 100000]]})
    );
    const sessions = new Sessions(file, identity);
    assert.equal(sessions.valid(token), true);
    const phone = sessions.create({agent: 'Android Chrome/136', ip: '192.0.2.2'}, 86400);
    assert.match(sessions.list(phone).find((s) => s.current).device, /Android.*Chrome/);
    sessions.shorten(3600);
    assert.ok(sessions.get(phone).expires <= sessions.get(phone).created + 3600000);
    sessions.others(phone);
    assert.equal(sessions.valid(token), false);
    assert.equal(sessions.valid(phone), true);
    sessions.revokeId(sessions.list(phone)[0].id);
    assert.equal(new Sessions(file, identity).valid(phone), false);
  });
  async function httpFixture(t) {
    const dir = temp(t),
      sessionsFile = dir + '/sessions.json',
      auditFile = dir + '/auth-events.jsonl';
    let app, base;
    const start = async () => {
      app = createApp({config, sessionsFile, auditFile});
      await new Promise((r) => app.listen(0, '127.0.0.1', r));
      base = 'http://127.0.0.1:' + app.address().port;
    };
    const close = async () => {
      if (!app) return;
      app.closeAllConnections();
      await new Promise((r) => app.close(r));
      app = null;
    };
    await start();
    t.after(close);
    const request = (route, token, data, origin = config.origin) =>
      fetch(base + route, {
        redirect: 'manual',
        method: data ? 'POST' : 'GET',
        headers: {
          ...(token ? {Cookie: token} : {}),
          ...(data ? {Origin: origin, 'Content-Type': 'application/json'} : {}),
          'User-Agent': 'Android Chrome/136'
        },
        ...(data ? {body: JSON.stringify(data)} : {})
      });
    const login = (pass = password, token = '') =>
      fetch(base + '/api/auth/login', {
        redirect: 'manual',
        method: 'POST',
        headers: {
          Origin: config.origin,
          ...(token ? {Cookie: token} : {}),
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Android Chrome/136'
        },
        body: new URLSearchParams({username: config.username, password: pass})
      });
    const cookies = (response) =>
      response.headers
        .getSetCookie()
        .filter((s) => !s.includes('Max-Age=0'))
        .map((s) => s.split(';')[0])
        .join('; ');
    const ok = async (route, token, data) => {
      const response = await request(route, token, data);
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    const authorize = async (token, action, pass = password, a) => {
      let result = await ok('/api/security/authorize', token, {action, password: pass});
      if (!result.grant && a)
        result = await ok('/api/security/authorize/verify', token, {
          id: result.id,
          credential: a.assertion(result.publicKey)
        });
      return result;
    };
    return {
      dir,
      get base() {
        return base;
      },
      whenRequest(route) {
        return new Promise((resolve) => {
          const listener = (request) => {
            if (request.url === route) {
              app.removeListener('request', listener);
              resolve();
            }
          };
          app.on('request', listener);
        });
      },
      request,
      login,
      cookies,
      ok,
      authorize,
      restart: async () => {
        await close();
        await start();
      }
    };
  }
  test('HTTP password change requires current password, revokes sessions and persists through restart', async (t) => {
    const f = await httpFixture(t),
      first = f.cookies(await f.login()),
      second = f.cookies(await f.login());
    assert.equal((await f.request('/api/security')).status, 401);
    assert.equal(
      (await f.request('/api/security/authorize', first, {action: 'password', password: 'bad'}))
        .status,
      401
    );
    assert.equal(
      (await f.request('/api/security/password', first, {password: 'replacement-password'})).status,
      401
    );
    const grant = (await f.authorize(first, 'password')).grant;
    const changed = await f.request('/api/security/password', first, {
      grant,
      password: 'replacement-password'
    });
    assert.equal(changed.status, 200);
    const current = f.cookies(changed);
    assert.equal((await f.request('/api/health', first)).status, 401);
    assert.equal((await f.request('/api/health', second)).status, 401);
    assert.equal((await f.request('/api/health', current)).status, 200);
    await f.restart();
    assert.equal((await f.login()).status, 401);
    assert.equal((await f.login('replacement-password')).status, 303);
    assert.ok(!fs.readFileSync(f.dir + '/security.json', 'utf8').includes('replacement-password'));
    assert.match(
      fs.readFileSync(f.dir + '/auth-events.jsonl', 'utf8'),
      /security.hub.password_changed/
    );
  });
  test('passwordless passkey login enforces signatures, pending purpose, recovery isolation and replay protection', async (t) => {
    const f = await httpFixture(t),
      a = authenticator();
    assert.equal((await f.request('/api/auth/passkey/options', '', {})).status, 404);
    let session = f.cookies(await f.login());
    const grant = (await f.authorize(session, 'add-key')).grant;
    const reg = await f.ok('/api/security/keys/options', session, {grant});
    const registered = await f.request('/api/security/keys/register', session, {
      id: reg.id,
      credential: a.registration(reg.publicKey),
      label: 'Phone'
    });
    const codes = (await registered.json()).codes;
    session = f.cookies(registered);
    await f.request('/api/auth/logout', session, {});
    await f.restart();
    const page = await (await f.request('/login')).text();
    assert.match(page, /id="passkeyLogin" data-auto="1"/);
    assert.match(page, /Войти по отпечатку/);
    assert.match(await (await f.request('/login?password=1')).text(), /data-auto="0"/);
    assert.equal(
      (await f.request('/api/auth/passkey/options', '', {}, 'https://evil.test')).status,
      403
    );
    const begin = await f.request('/api/auth/passkey/options', '', {});
    let pending = f.cookies(begin),
      options = await begin.json();
    assert.deepEqual(options.publicKey.allowCredentials, []);
    assert.equal(options.publicKey.userVerification, 'required');
    assert.equal((await f.request('/api/health', pending)).status, 401);
    assert.equal((await f.request('/api/auth/factor/options', pending, {})).status, 401);
    assert.equal(
      (await f.request('/api/auth/factor/recovery', pending, {code: codes[0]})).status,
      401
    );
    const signed = a.assertion(options.publicKey, {userHandle: reg.publicKey.user.id});
    assert.equal(
      (await f.request('/api/auth/passkey/verify', '', {id: options.id, credential: signed}))
        .status,
      401
    );
    const noHandle = a.assertion(options.publicKey);
    assert.equal(
      (await f.request('/api/auth/passkey/verify', pending, {id: options.id, credential: noHandle}))
        .status,
      401
    );
    const verified = await f.request('/api/auth/passkey/verify', pending, {
      id: options.id,
      credential: signed
    });
    assert.equal(verified.status, 200);
    session = f.cookies(verified);
    assert.equal((await f.request('/api/health', session)).status, 200);
    assert.equal(
      (await f.request('/api/auth/passkey/verify', pending, {id: options.id, credential: signed}))
        .status,
      401
    );
    assert.match(fs.readFileSync(f.dir + '/auth-events.jsonl', 'utf8'), /method=passkey/);
    // A fresh pending login cannot reuse a signature from another challenge.
    const again = await f.request('/api/auth/passkey/options', '', {});
    pending = f.cookies(again);
    options = await again.json();
    assert.equal(
      (await f.request('/api/auth/passkey/verify', pending, {id: options.id, credential: signed}))
        .status,
      401
    );
    const fresh = await f.request('/api/auth/passkey/options', '', {});
    pending = f.cookies(fresh);
    options = await fresh.json();
    const wrong = a.assertion(options.publicKey, {userHandle: reg.publicKey.user.id, flags: 1});
    assert.equal(
      (await f.request('/api/auth/passkey/verify', pending, {id: options.id, credential: wrong}))
        .status,
      401
    );
    const passwordLogin = await f.login();
    const fallback = f.cookies(passwordLogin);
    assert.equal(passwordLogin.headers.get('location'), '/login?factor=1');
    const recovered = await f.request('/api/auth/factor/recovery', fallback, {code: codes[0]});
    assert.equal(recovered.status, 200);
    assert.equal((await f.request('/api/health', session)).status, 401);
    assert.equal((await f.request('/api/health', f.cookies(recovered))).status, 200);
  });
  test('passwordless pending logins are device-bound, expiring and invalidated by security changes', () => {
    let now = 1000;
    const s = new Security(config, null, {now: () => now});
    const token = s.beginLogin('ip', 'phone', 'passkey');
    assert.throws(() => s.loginPending(token, 'ip', 'phone'));
    assert.throws(() => s.loginPending(token, 'other', 'phone', false, 'passkey'));
    assert.throws(() => s.loginPending(token, 'ip', 'other', false, 'passkey'));
    assert.equal(s.loginPending(token, 'ip', 'phone', false, 'passkey').method, 'passkey');
    now += 300001;
    assert.throws(() => s.loginPending(token, 'ip', 'phone', false, 'passkey'));
    const next = s.beginLogin('ip', 'phone', 'passkey');
    s.save({...s.state, epoch: s.state.epoch + 1});
    assert.throws(() => s.loginPending(next, 'ip', 'phone', false, 'passkey'));
  });
  test('repeat password login cannot reuse an existing session to skip passkey verification', async (t) => {
    const f = await httpFixture(t),
      a = authenticator();
    let session = f.cookies(await f.login());
    const grant = (await f.authorize(session, 'add-key')).grant;
    const options = await f.ok('/api/security/keys/options', session, {grant});
    const registered = await f.request('/api/security/keys/register', session, {
      id: options.id,
      credential: a.registration(options.publicKey),
      label: 'Phone'
    });
    assert.equal(registered.status, 200);
    session = f.cookies(registered);
    await f.restart();
    assert.equal((await f.ok('/api/security', session)).enabled, true);
    const repeated = await f.login(password, session);
    assert.equal(repeated.headers.get('location'), '/login?factor=1');
    assert.ok(
      repeated.headers
        .getSetCookie()
        .some((value) => value.startsWith('__Host-nexus_session=;') && value.includes('Max-Age=0'))
    );
    const pending = f.cookies(repeated);
    assert.equal((await f.request('/api/health', session)).status, 401);
    assert.equal((await f.request('/api/health', pending)).status, 401);
    const page = await f.request('/login?factor=1', pending + '; ' + session);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="factorLogin"/);
    const confirm = await f.ok('/api/auth/factor/options', pending, {});
    const verified = await f.request('/api/auth/factor/verify', pending, {
      id: confirm.id,
      credential: a.assertion(confirm.publicKey)
    });
    assert.equal(verified.status, 200);
    const current = f.cookies(verified);
    await f.request('/api/auth/logout', current, {});
    const fresh = await f.login();
    assert.equal(fresh.headers.get('location'), '/login?factor=1');
    assert.equal((await f.request('/api/health', f.cookies(fresh))).status, 401);
  });
  test('HTTP full passkey enrollment, second factor, recovery, removal and security notifications', async (t) => {
    const f = await httpFixture(t),
      a = authenticator();
    let session = f.cookies(await f.login());
    const grant = (await f.authorize(session, 'add-key')).grant;
    const options = await f.ok('/api/security/keys/options', session, {grant});
    const registered = await f.request('/api/security/keys/register', session, {
      id: options.id,
      credential: a.registration(options.publicKey),
      label: 'Phone'
    });
    assert.equal(registered.status, 200);
    const codes = (await registered.json()).codes;
    assert.equal(codes.length, 10);
    assert.equal((await f.request('/api/health', session)).status, 401);
    session = f.cookies(registered);
    const saved = fs.readFileSync(f.dir + '/security.json', 'utf8');
    assert.ok(!saved.includes(codes[0]));
    const passwordStage = await f.login();
    assert.equal(passwordStage.headers.get('location'), '/login?factor=1');
    const pending = f.cookies(passwordStage);
    assert.ok(!pending.includes('__Host-nexus_session='));
    assert.equal((await f.request('/api/health', pending)).status, 401);
    const assertion = await f.ok('/api/auth/factor/options', pending, {});
    const final = await f.request('/api/auth/factor/verify', pending, {
      id: assertion.id,
      credential: a.assertion(assertion.publicKey)
    });
    assert.equal(final.status, 200);
    const second = f.cookies(final);
    assert.equal(
      (
        await f.request('/api/auth/factor/verify', pending, {
          id: assertion.id,
          credential: a.assertion(assertion.publicKey)
        })
      ).status,
      401
    );
    const confirmation = await f.authorize(session, 'recovery');
    assert.ok(confirmation.publicKey);
    const bad = a.assertion(confirmation.publicKey);
    bad.response.signature = b64(Buffer.alloc(64));
    assert.equal(
      (
        await f.request('/api/security/authorize/verify', session, {
          id: confirmation.id,
          credential: bad
        })
      ).status,
      401
    );
    const recoverPending = f.cookies(await f.login());
    const recovered = await f.request('/api/auth/factor/recovery', recoverPending, {
      code: codes[0]
    });
    assert.equal(recovered.status, 200);
    session = f.cookies(recovered);
    assert.equal((await f.request('/api/health', second)).status, 401);
    await f.restart();
    assert.equal((await f.request('/api/health', session)).status, 200);
    const reusedPending = f.cookies(await f.login());
    assert.equal(
      (await f.request('/api/auth/factor/recovery', reusedPending, {code: codes[0]})).status,
      401
    );
    const info = await f.ok('/api/security', session);
    assert.equal(info.recoveryLeft, 9);
    assert.equal(info.recovered, true);
    const remove = await f.authorize(session, 'remove-key');
    assert.ok(remove.grant);
    const removed = await f.request('/api/security/keys/remove', session, {
      grant: remove.grant,
      id: info.keys[0].id
    });
    assert.equal(removed.status, 200);
    assert.equal((await f.login()).headers.get('location'), '/');
    const events = fs
      .readFileSync(f.dir + '/auth-events.jsonl', 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const rules = new Rules({}, Date.now);
    for (const e of events) rules.event(e);
    const notifications = rules.take();
    assert.ok(notifications.some((e) => e.key === 'security.hub.passkey_added'));
    assert.ok(
      notifications.some((e) => e.key === 'security.hub.recovery_used' && e.level === 'critical')
    );
    assert.ok(notifications.some((e) => e.key === 'security.hub.factor_disabled'));
    assert.ok(!JSON.stringify(events).includes(codes[0]));
    assert.ok(!JSON.stringify(events).includes(password));
  });
  test('a request waiting for its body loses permission immediately when its session is revoked', async (t) => {
    const f = await httpFixture(t),
      first = f.cookies(await f.login()),
      second = f.cookies(await f.login());
    const id = (await f.ok('/api/security', first)).sessions.find((s) => s.current).id;
    const {request} = await import('node:http');
    const received = f.whenRequest('/api/security/sessions/others');
    let send;
    const result = new Promise((resolve, reject) => {
      send = request(
        f.base + '/api/security/sessions/others',
        {
          method: 'POST',
          headers: {
            Cookie: first,
            Origin: config.origin,
            'Content-Type': 'application/json',
            'Content-Length': 2
          }
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        }
      );
      send.on('error', reject);
      send.write('{');
    });
    await received;
    await f.ok('/api/security/sessions/revoke', second, {id});
    send.end('}');
    assert.equal(await result, 401);
    assert.equal((await f.request('/api/health', second)).status, 200);
  });
  test('HTTP session management and limits survive restart and reject cross-origin writes', async (t) => {
    const f = await httpFixture(t),
      first = f.cookies(await f.login()),
      second = f.cookies(await f.login());
    const rows = (await f.ok('/api/security', first)).sessions;
    assert.equal(rows.length, 2);
    const other = rows.find((s) => !s.current);
    assert.ok(other.created && other.seen);
    assert.equal(
      (await f.request('/api/security/sessions/revoke', first, {id: other.id}, 'https://evil.test'))
        .status,
      403
    );
    await f.ok('/api/security/sessions/revoke', first, {id: other.id});
    assert.equal((await f.request('/api/health', second)).status, 401);
    const third = f.cookies(await f.login());
    await f.ok('/api/security/sessions/others', first, {});
    assert.equal((await f.request('/api/health', third)).status, 401);
    const grant = (await f.authorize(first, 'ttl')).grant;
    await f.ok('/api/security/ttl', first, {grant, ttl: 3600});
    assert.equal((await f.ok('/api/security', first)).ttl, 3600);
    for (let i = 0; i < 9; i++) assert.equal((await f.login('wrong')).status, 401);
    await f.restart();
    assert.equal((await f.login()).status, 429);
  });
}

{
  const {runInNewContext} = await import('node:vm');
  test('passkey page prompts automatically once, retries on click and cancels for password fallback', async () => {
    const events = {},
      calls = [],
      storage = new Map();
    let cancel = true,
      hold = false,
      requests = 0;
    const button = {disabled: false, closest: () => null};
    const fallback = {
      open: false,
      addEventListener: (name, fn) => {
        events[name] = fn;
      }
    };
    const elements = {
      passkeyLogin: {dataset: {auto: '1'}, querySelectorAll: () => [button]},
      passkeyEnter: button,
      passwordFallback: fallback,
      securityStatus: {textContent: ''}
    };
    const window = {
      PublicKeyCredential: function () {},
      top: {location: {href: '/login'}},
      addEventListener: () => {}
    };
    runInNewContext(
      fs.readFileSync(new URL('../02-hub/public/security.js', import.meta.url), 'utf8'),
      {
        window,
        document: {
          getElementById: (id) => elements[id],
          visibilityState: 'visible',
          removeEventListener: () => {}
        },
        navigator: {
          credentials: {
            get: async ({signal}) => {
              requests++;
              if (hold)
                return new Promise((_, reject) =>
                  signal.addEventListener('abort', () =>
                    reject(Object.assign(Error(), {name: 'AbortError'}))
                  )
                );
              if (cancel) throw Object.assign(Error(), {name: 'NotAllowedError'});
              return {
                id: 'a',
                rawId: new Uint8Array([1]),
                type: 'public-key',
                response: {userHandle: new Uint8Array([2])}
              };
            }
          }
        },
        fetch: async (route) => {
          calls.push(route);
          return {
            ok: true,
            json: async () =>
              route.endsWith('/options')
                ? {id: 'challenge', publicKey: {challenge: 'YQ', allowCredentials: []}}
                : {ok: true}
          };
        },
        sessionStorage: {setItem: (k, v) => storage.set(k, v)},
        AbortSignal,
        AbortController,
        Uint8Array,
        atob,
        btoa
      }
    );
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    await tick();
    assert.equal(requests, 1);
    assert.match(elements.securityStatus.textContent, /отменено/);
    assert.equal(button.disabled, false);
    assert.equal(window.top.location.href, '/login');
    await tick();
    assert.equal(requests, 1);
    hold = true;
    button.onclick();
    await tick();
    assert.equal(button.disabled, true);
    fallback.open = true;
    events.toggle();
    await tick();
    assert.equal(button.disabled, false);
    assert.equal(elements.securityStatus.textContent, '');
    hold = false;
    cancel = false;
    button.onclick();
    await tick();
    assert.equal(window.top.location.href, '/');
    assert.equal(calls.filter((x) => x.endsWith('/verify')).length, 1);
    assert.equal(requests, 3);
    assert.ok(Number(storage.get('nexus-intro-pending')) > 0);
  });
}

// Галерея и статьи: общие файлы, редакции и закрытый доступ.
{
  const {ContentStore, imageType} = await import('../02-hub/src/content-store.mjs');
  const {createContentModule, renderArticle} = await import('../02-hub/src/content-module.mjs');
  const {createApp} = await import('../02-hub/src/server.mjs');
  const {passwordHash} = await import('../02-hub/src/auth.mjs');
  const {execFileSync} = await import('node:child_process');
  const {randomUUID} = await import('node:crypto');
  function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-content-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    return new ContentStore(dir);
  }
  function png(t) {
    const store = fixture(t),
      file = path.join(store.directory, 'fixture.png');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x48',
      '-frames:v',
      '1',
      '-threads',
      '1',
      file
    ]);
    return fs.readFileSync(file);
  }
  test('content images produce real thumbnails, deduplicate and persist exact originals privately', async (t) => {
    const s = fixture(t),
      bytes = png(t),
      image = await s.upload(bytes, 'Скриншот.png');
    assert.equal(image.width, 64);
    assert.equal(image.height, 48);
    assert.deepEqual(fs.readFileSync(s.file(image.id)), bytes);
    assert.equal(fs.readFileSync(s.file(image.id, true)).subarray(8, 12).toString(), 'WEBP');
    assert.equal(fs.statSync(s.file(image.id)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(s.file(image.id, true)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(s.directory, 'catalog.json')).mode & 0o777, 0o600);
    assert.equal((await s.upload(bytes, 'Duplicate')).id, image.id);
    assert.equal(s.images().images.length, 1);
    s.album('Скриншоты');
    s.editImage(image.id, {name: 'Игра', album: 'Скриншоты', tags: ['игра', 'игра']});
    const again = new ContentStore(s.directory);
    assert.deepEqual(again.image(image.id).tags, ['игра']);
    assert.deepEqual(again.images().albums, ['Скриншоты']);
    assert.throws(() => s.file('../catalog.json'));
    assert.throws(() => imageType(Buffer.from('<svg><script>alert(1)</script></svg>')));
    s.deleteImage(image.id);
    assert.equal(fs.existsSync(path.join(s.directory, 'files', image.id + '.original')), false);
  });
  test('content failed image conversion or revoked upload never enters the gallery', async (t) => {
    const s = fixture(t),
      bytes = png(t);
    await assert.rejects(
      s.upload(Buffer.concat([Buffer.from([255, 216, 255]), Buffer.from('broken')]), 'bad.jpg')
    );
    await assert.rejects(
      s.upload(bytes, 'cancelled.png', () => false),
      (e) => e.status === 401
    );
    assert.equal(s.images().images.length, 0);
    assert.deepEqual(fs.readdirSync(path.join(s.directory, 'files')), []);
  });
  test('content revisions restore without losing current text, reject stale writes and survive restart', (t) => {
    const s = fixture(t),
      first = s.saveArticle({
        title: 'Первая',
        body: 'Исходный текст',
        tags: ['личное'],
        status: 'draft'
      });
    const second = s.saveArticle({...first, body: 'Новый текст', status: 'ready'});
    assert.equal(second.version, 2);
    assert.equal(second.history[0].body, 'Исходный текст');
    assert.throws(
      () => s.saveArticle({...first, body: 'Чужая вкладка'}),
      (e) => e.status === 409
    );
    const third = s.restore(second.id, 1, 2);
    assert.equal(third.version, 3);
    assert.equal(third.body, 'Исходный текст');
    assert.equal(third.history[0].body, 'Новый текст');
    assert.equal(new ContentStore(s.directory).article(third.id).body, third.body);
    let item = third;
    for (let i = 0; i < 55; i++) item = s.saveArticle({...item, body: 'Редакция ' + i});
    assert.equal(item.history.length, 50);
    assert.equal(s.articles()[0].body, undefined);
    assert.equal(s.articles()[0].history, undefined);
    assert.throws(
      () => s.saveArticle({...item, body: '![image](media:' + randomUUID() + ')'}),
      (e) => e.status === 404
    );
  });
  test('content keeps images referenced by current articles and retained revisions', async (t) => {
    const s = fixture(t),
      img = await s.upload(png(t), 'image');
    const a = s.saveArticle({
      title: '',
      body: '![Фото](media:' + img.id + ')',
      tags: [],
      status: 'draft'
    });
    assert.throws(
      () => s.deleteImage(img.id),
      (e) => e.status === 409
    );
    s.saveArticle({...a, body: 'Текст без картинки'});
    assert.throws(
      () => s.deleteImage(img.id),
      (e) => e.status === 409
    );
    assert.ok(fs.existsSync(s.file(img.id)));
  });
  test('content preview escapes executable markup and only embeds internal media IDs', () => {
    const id = randomUUID(),
      html = renderArticle(
        '# Заголовок\n<script>alert(1)</script>\n![Фото](media:' +
          id +
          ')\n![x](https://evil.test/pixel)\n```\n<img onerror=evil()>\n```\n**важно**'
      );
    assert.match(html, /<h1>Заголовок<\/h1>/);
    assert.match(html, /<strong>важно<\/strong>/);
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img onerror'));
    assert.equal((html.match(/<img /g) || []).length, 1);
    assert.ok(html.includes('/modules/articles/file/' + id));
    assert.ok(!html.includes('src="https://evil.test'));
  });
  test('content Markdown supports GFM and rejects unsafe links and external embeds', () => {
    const id = randomUUID();
    const html = renderArticle([
      '## Title', '', '- [x] Done', '- Parent', '  - Child', '',
      '| A | B |', '| --- | --- |', '| 1 | 2 |', '',
      '[File](file:' + id + ')', '[Safe](https://example.com/)',
      '[Bad](javascript:alert%281%29)', '[Data](data:text/html,evil)',
      '[Encoded](javascript&#58;alert%281%29)', '<iframe src="https://evil.test"></iframe>',
      '![External](https://evil.test/pixel)', '', '```html', '<script>evil()</script>', '```'
    ].join('\n'));
    assert.match(html, /<table>/);
    assert.match(html, /type="checkbox"/);
    assert.match(html, /disabled/);
    assert.equal((html.match(/<ul>/g) || []).length, 2);
    assert.match(html, new RegExp('href="/modules/storage/file/' + id + '"'));
    assert.match(html, /href="https:\/\/example.com\/"/);
    assert.doesNotMatch(html, /href="(?:javascript|data):|<iframe|<script|<img /i);
  });
  test('content validates reference-style Markdown images and preserves referenced originals', async t => {
    const s = fixture(t), img = await s.upload(png(t), 'Reference');
    const article = s.saveArticle({title:'MD', tags:[], status:'draft',
      body:'![Photo][photo]\n\n[photo]: media:' + img.id});
    assert.match(renderArticle(article.body), new RegExp('/file/' + img.id));
    assert.throws(() => s.deleteImage(img.id), {status:409});
    assert.throws(() => s.saveArticle({...article,
      body:'![Missing][ref]\n\n[ref]: media:' + randomUUID()}), {status:404});
    s.saveArticle({...article, body:'Without image'});
    assert.throws(() => s.deleteImage(img.id), {status:409});
  });
  test('content corrupt metadata fails closed and failed writes keep previous revisions', (t) => {
    const s = fixture(t),
      item = s.saveArticle({title: 'Статья', body: 'Есть текст', tags: [], status: 'draft'});
    const before = fs.readFileSync(path.join(s.directory, 'catalog.json'), 'utf8');
    const directory = s.directory;
    s.directory = path.join(directory, 'missing');
    assert.throws(() => s.saveArticle({...item, body: 'Не записалось'}));
    s.directory = directory;
    assert.equal(s.article(item.id).body, 'Есть текст');
    assert.equal(fs.readFileSync(path.join(directory, 'catalog.json'), 'utf8'), before);
    fs.writeFileSync(path.join(directory, 'catalog.json'), '{');
    assert.throws(
      () => new ContentStore(directory).load(),
      (e) => e.status === 503
    );
  });
  test('content HTTP modules are separate, searchable and protect originals, thumbnails, texts and revisions', async (t) => {
    const s = fixture(t),
      bytes = png(t),
      config = {
        username: 'admin',
        origin: 'https://hub.test',
        ...(await passwordHash('test-content-password'))
      };
    const modules = new Map(
      ['gallery', 'articles'].map((id) => [
        id,
        {id, title: id, description: '', ...createContentModule(id, s)}
      ])
    );
    const app = createApp({config, modules, sessionsFile: path.join(s.directory, 'sessions.json')});
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    t.after(async () => {
      app.closeAllConnections();
      await new Promise((r) => app.close(r));
    });
    const base = 'http://127.0.0.1:' + app.address().port;
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      redirect: 'manual',
      headers: {Origin: config.origin, 'Content-Type': 'application/x-www-form-urlencoded'},
      body: 'username=admin&password=test-content-password'
    });
    const Cookie = login.headers
      .getSetCookie()
      .find((x) => x.startsWith('__Host-nexus_session='))
      .split(';')[0];
    const get = (route, cookie = Cookie) =>
      fetch(base + route, {redirect: 'manual', headers: cookie ? {Cookie: cookie} : {}});
    const post = (route, data, origin = config.origin) =>
      fetch(base + route, {
        method: 'POST',
        headers: {Cookie, Origin: origin, 'Content-Type': 'application/json'},
        body: JSON.stringify(data)
      });
    assert.match(await (await get('/modules/gallery/')).text(), /data-kind="gallery"/);
    assert.match(await (await get('/modules/articles/')).text(), /data-kind="articles"/);
    const upload = await fetch(base + '/modules/gallery/upload', {
      method: 'POST',
      headers: {
        Cookie,
        Origin: config.origin,
        'X-File-Name': encodeURIComponent('Фото.png'),
        'Content-Type': 'application/octet-stream'
      },
      body: bytes
    });
    assert.equal(upload.status, 200);
    const img = await upload.json();
    const image = await get('/modules/articles/file/' + img.id);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
    assert.match(image.headers.get('cache-control'), /no-store/);
    const thumbnail = await get('/modules/gallery/thumb/' + img.id);
    assert.equal(thumbnail.headers.get('content-type'), 'image/webp');
    assert.match(
      (await get('/modules/gallery/file/' + img.id + '?download=1')).headers.get(
        'content-disposition'
      ),
      /^attachment/
    );
    let saved = await post('/modules/articles/save', {
      title: 'Статья',
      body: 'Уникальный текст\n![Фото](media:' + img.id + ')',
      tags: ['личное'],
      status: 'draft'
    });
    assert.equal(saved.status, 200);
    let a = await saved.json();
    const exported = await get('/modules/articles/article/' + a.id + '/export');
    assert.equal(exported.status, 200);
    assert.equal(await exported.text(), a.body);
    assert.match(exported.headers.get('content-type'), /text\/markdown/);
    assert.match(exported.headers.get('content-disposition'), /^attachment;.*filename\*=UTF-8''/);
    assert.equal(exported.headers.get('cache-control'), 'no-store');
    assert.equal(exported.headers.get('x-content-type-options'), 'nosniff');
    a = await (
      await post('/modules/articles/save', {...a, body: 'Уникальный текст: изменено'})
    ).json();
    assert.equal(
      (await (await get('/modules/articles/articles?q=' + encodeURIComponent('Уникальный'))).json())
        .length,
      1
    );
    assert.equal((await (await get('/modules/articles/articles?q=missing')).json()).length, 0);
    assert.equal(
      (await post('/modules/articles/save', {...a, body: 'X'}, 'https://evil.test')).status,
      403
    );
    assert.equal((await post('/modules/gallery/image/delete', {id: img.id})).status, 409);
    for (const route of [
      '/modules/gallery/images',
      '/modules/gallery/thumb/' + img.id,
      '/modules/gallery/file/' + img.id,
      '/modules/articles/file/' + img.id,
      '/modules/articles/articles',
      '/modules/articles/article/' + a.id,
      '/modules/articles/article/' + a.id + '/export'
    ]) {
      const anonymous = await get(route, '');
      assert.equal(anonymous.status, 303);
      assert.equal(anonymous.headers.get('location'), '/login');
    }
    await post('/api/auth/logout', {});
    assert.equal((await get('/modules/articles/article/' + a.id)).status, 303);
    assert.equal(
      (await post('/modules/articles/restore', {id: a.id, revision: 1, version: a.version})).status,
      401
    );
    assert.equal((await get('/modules/gallery/thumb/' + img.id)).status, 303);
  });
}

{
  const {runInNewContext} = await import('node:vm');
  test('content editor serializes navigation, preserves revision conflicts and retains unsaved text', async () => {
    class Element {
      constructor() {
        this.value = '';
        this.textContent = '';
        this.events = {};
        this.dataset = {};
        this.classList = {toggle() {}};
        this.children = [];
      }
      addEventListener(name, fn) {
        this.events[name] = fn;
      }
      replaceChildren(...items) {
        this.children = items;
      }
      append(...items) {
        this.children.push(...items);
      }
      showModal() {}
      focus() {}
      setAttribute() {}
      remove() {}
    }
    const elements = new Map(),
      get = (id) => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      };
    get('contentPage').dataset.kind = 'articles';
    const deferred = [],
      calls = [];
    let timer,
      version = 0,
      fail = false;
    const result = (data) => ({ok: true, json: async () => data});
    const value = (data) => ({
      ...data,
      id: 'article',
      version: ++version,
      created: 1,
      updated: Date.now(),
      history: []
    });
    runInNewContext(
      fs.readFileSync(new URL('../02-hub/public/content.js', import.meta.url), 'utf8'),
      {
        document: {
          getElementById: get,
          createElement: () => new Element(),
          querySelectorAll: () => []
        },
        window: {addEventListener() {}},
        matchMedia: () => ({matches:false}),
        Option: function (label, value) {
          this.label = label;
          this.value = value;
        },
        setTimeout: (fn) => {
          timer = fn;
          return 1;
        },
        clearTimeout: () => {},
        AbortSignal,
        fetch: async (route, options) => {
          if (route.includes('/articles?')) return result([]);
          if (route.endsWith('/preview')) return result({html:'<p>Последний текст</p>'});
          if (route.endsWith('/article/article'))
            return result({id: 'article', version: 99, history: []});
          if (route.endsWith('/save')) {
            const data = JSON.parse(options.body);
            calls.push(data);
            if (!data.id) return result(value(data));
            if (fail) return {ok: false, json: async () => ({error: 'Диск заполнен'})};
            return new Promise((resolve) => deferred.push(() => resolve(result(value(data)))));
          }
          throw Error('unexpected route ' + route);
        }
      }
    );
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    await tick();
    get('articleNew').onclick();
    get('articleNew').onclick();
    assert.equal(get('articleBody').disabled, true);
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(get('articleBody').disabled, false);
    get('articleBody').value = 'Первый текст';
    get('articleBody').events.input();
    timer();
    await tick();
    assert.equal(deferred.length, 1);
    get('articleBody').value = 'Последний текст';
    get('articleBody').events.input();
    deferred.shift()();
    await tick();
    assert.equal(deferred.length, 1);
    assert.equal(calls.at(-1).body, 'Последний текст');
    assert.equal(calls.at(-1).version, 2);
    deferred.shift()();
    await tick();
    assert.match(get('articleSaveState').textContent, /Сохранено/);
    assert.equal(get('articleBody').value, 'Последний текст');
    get('articleState').value = 'ready';
    get('articleState').events.change();
    get('articleSave').onclick();
    await tick();
    deferred.shift()();
    await tick();
    assert.equal(get('articleEditor').hidden, true);
    assert.equal(get('articleReading').hidden, false);
    assert.equal(get('articleReadBody').innerHTML, '<p>Последний текст</p>');
    get('articleEdit').onclick();
    assert.equal(get('articleEditor').hidden, false);
    assert.equal(get('articleReading').hidden, true);
    get('articleHistory').onclick();
    await tick();
    fail = true;
    get('articleBody').value = 'Не потерять';
    get('articleBody').events.input();
    timer();
    await tick();
    assert.match(get('articleSaveState').textContent, /Не сохранено.*Диск заполнен/);
    assert.equal(get('articleBody').value, 'Не потерять');
    assert.equal(
      calls.at(-1).version,
      4,
      'history must not silently accept another device version'
    );
  });
}

// Клио: EPUB/TXT, позиции и закрытые ресурсы.
{
  const {parseBook, archive, reference} = await import('../02-hub/modules/reader/parse.mjs');
  const {ReaderStore} = await import('../02-hub/modules/reader/store.mjs');
  const {createModule: readerModule, settings: readerSettings} = await import(
    '../02-hub/modules/reader/index.mjs'
  );
  const {crc32, deflateRawSync} = await import('node:zlib');
  const {execFileSync} = await import('node:child_process');
  const {createApp} = await import('../02-hub/src/server.mjs');
  const {passwordHash} = await import('../02-hub/src/auth.mjs');
  function zip(entries) {
    const local = [],
      central = [];
    let offset = 0;
    for (const [name, value] of entries) {
      const raw = Buffer.isBuffer(value) ? value : Buffer.from(value),
        filename = Buffer.from(name),
        method = name === 'mimetype' ? 0 : 8,
        data = method ? deflateRawSync(raw) : raw;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x800, 6);
      header.writeUInt16LE(method, 8);
      header.writeUInt32LE(crc32(raw), 14);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(raw.length, 22);
      header.writeUInt16LE(filename.length, 26);
      local.push(header, filename, data);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x800, 8);
      cd.writeUInt16LE(method, 10);
      cd.writeUInt32LE(crc32(raw), 16);
      cd.writeUInt32LE(data.length, 20);
      cd.writeUInt32LE(raw.length, 24);
      cd.writeUInt16LE(filename.length, 28);
      cd.writeUInt32LE(offset, 42);
      central.push(cd, filename);
      offset += header.length + filename.length + data.length;
    }
    const directory = Buffer.concat(central),
      end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, directory, end]);
  }
  function epub({
    body = '<h1>Глава первая</h1><p>Привет &amp; мир.</p><p>Ещё текст.</p>',
    cover,
    extra = []
  } = {}) {
    return zip([
      ['mimetype', 'application/epub+zip'],
      [
        'META-INF/container.xml',
        '<?xml version="1.0"?><container><rootfiles><rootfile full-path="EPUB/book.opf"/></rootfiles></container>'
      ],
      [
        'EPUB/book.opf',
        '<package><metadata><dc:title><![CDATA[Тестовая книга]]></dc:title><dc:creator>Автор</dc:creator></metadata><manifest><item id="one" href="chapter.xhtml" media-type="application/xhtml+xml"/>' +
          (cover
            ? '<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>'
            : '') +
          '</manifest><spine><itemref idref="one"/></spine></package>'
      ],
      [
        'EPUB/chapter.xhtml',
        '<html><head><title>Не текст книги</title><style>body{}</style></head><body>' +
          body +
          '</body></html>'
      ],
      ...(cover ? [['EPUB/cover.png', cover]] : []),
      ...extra
    ]);
  }
  function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-reader-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    return new ReaderStore(directory);
  }
  function cover(t) {
    const s = fixture(t),
      file = path.join(s.directory, 'image.png');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x96',
      '-frames:v',
      '1',
      '-threads',
      '1',
      file
    ]);
    return fs.readFileSync(file);
  }
  test('reader parses EPUB metadata, chapter order and images without executing markup or fetching external resources', (t) => {
    const bytes = epub({
      cover: cover(t),
      body: '<h1>Глава</h1><p>Текст <b>книги</b>.</p><script>alert(1)</script><iframe src="https://evil.test">bad</iframe><img src="cover.png"/><img src="https://evil.test/pixel"/><svg><script>evil()</script></svg>'
    });
    const book = parseBook(bytes, 'book.epub');
    assert.equal(book.title, 'Тестовая книга');
    assert.equal(book.author, 'Автор');
    assert.equal(book.chapters[0].title, 'Глава');
    assert.equal(book.assets.length, 1);
    assert.equal(book.chapters[0].blocks.find((b) => b.type === 'image').width, 64);
    assert.ok(!JSON.stringify(book.chapters).includes('alert'));
    assert.ok(!JSON.stringify(book.chapters).includes('evil'));
    assert.ok(!JSON.stringify(book.chapters).includes('Не текст'));
    assert.equal(reference('OPS/Text/a.xhtml', '../Images/a.png'), 'OPS/Images/a.png');
    assert.equal(reference('a.xhtml', '../../secret'), null);
    assert.equal(reference('a.xhtml', 'https://evil.test'), null);
  });
  test('reader rejects malicious archive paths, CRC failures, encrypted books and dangerous XML declarations', () => {
    assert.throws(() => archive(zip([['../outside', 'x']])));
    assert.throws(() => archive(zip([['/absolute', 'x']])));
    assert.throws(() =>
      archive(
        zip([
          ['same', 'a'],
          ['same', 'b']
        ])
      )
    );
    const corrupted = epub();
    corrupted[38] ^= 1;
    assert.throws(() => parseBook(corrupted, 'book.epub'));
    assert.throws(
      () =>
        parseBook(
          epub({
            extra: [['META-INF/encryption.xml', '<EncryptionMethod Algorithm="https://drm.test"/>']]
          }),
          'book.epub'
        ),
      /DRM/
    );
    assert.throws(
      () =>
        parseBook(
          epub({body: '<!DOCTYPE html [<!ENTITY x SYSTEM "file:///etc/passwd">]><p>&x;</p>'}),
          'book.epub'
        ),
      /XML/
    );
    const bomb = zip([['big', 'small']]);
    const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(0xfffffff0, central + 24);
    assert.throws(() => archive(bomb));
    assert.throws(() => parseBook(Buffer.from('%PDF'), 'book.pdf'), /EPUB и TXT/);
  });
  test('reader handles UTF-8, UTF-16 and Windows-1251 TXT and rejects binary files', () => {
    assert.equal(
      parseBook(Buffer.from('Привет\n\nМир'), 'hello.txt').chapters[0].blocks[0].text,
      'Привет'
    );
    assert.equal(
      parseBook(
        Buffer.concat([Buffer.from([255, 254]), Buffer.from('Текст', 'utf16le')]),
        'book.txt'
      ).chapters[0].blocks[0].text,
      'Текст'
    );
    assert.equal(
      parseBook(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), 'book.txt').chapters[0].blocks[0]
        .text,
      'Привет'
    );
    assert.throws(() => parseBook(Buffer.from([0, 1, 2]), 'binary.txt'));
  });
  test('reader imports a large book in a worker, splits chapters and keeps positions and bookmarks across restarts', async (t) => {
    const s = fixture(t),
      text = 'Большая книга. Строка для проверки чтения.\n\n'.repeat(70000),
      bytes = Buffer.from(text);
    assert.ok(bytes.length > 4 * 1024 * 1024);
    const book = await s.upload(bytes, 'Большая книга.txt');
    assert.ok(book.chapters.length > 100);
    for (let i = 0; i < book.chapters.length; i++) {
      const c = s.chapter(book.id, i);
      assert.ok(c.blocks.length <= 100);
      assert.ok(Buffer.byteLength(JSON.stringify(c)) < 100000);
    }
    assert.equal((await s.upload(bytes, 'Копия.txt')).id, book.id);
    const p = {chapter: 10, block: 2, offset: 0.35},
      first = s.position(book.id, p, 0);
    assert.ok(first.progress > 0);
    assert.equal(first.positionVersion, 1);
    assert.throws(
      () => s.position(book.id, {chapter: 0, block: 0, offset: 0}, 0),
      (e) => e.status === 409
    );
    s.bookmark(book.id, p, 'Вернуться');
    s.settings({size: 24, line: 2, font: 'sans', theme: 'sepia', width: 'wide'});
    const next = new ReaderStore(s.directory);
    assert.deepEqual(next.book(book.id).position, p);
    assert.equal(next.book(book.id).bookmarks[0].label, 'Вернуться');
    assert.equal(next.settings().size, 24);
    const last = book.chapters.length - 1;
    assert.equal(
      next.position(book.id, {chapter: last, block: book.chapters[last].blocks - 1, offset: 1}, 1)
        .progress,
      100
    );
    assert.throws(() => next.position(book.id, {chapter: 999999, block: 0, offset: 0}, 2));
    assert.equal(fs.statSync(path.join(s.directory, book.id, '0.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(s.directory, 'library.json')).mode & 0o777, 0o600);
    next.remove(book.id);
    assert.equal(fs.existsSync(path.join(s.directory, book.id)), false);
  });
  test('reader splits a large EPUB chapter into bounded parts without loading it all on the client', async (t) => {
    const s = fixture(t),
      body =
        '<h1>Большая глава</h1>' +
        '<p>Большая книга: длинный абзац для проверки разбиения и чтения.</p>'.repeat(40000);
    assert.ok(Buffer.byteLength(body) > 4 * 1024 * 1024);
    const book = await s.upload(epub({body}), 'large.epub');
    assert.ok(book.chapters.length >= 400);
    assert.ok(s.chapter(book.id, 0).blocks.length <= 100);
    assert.ok(s.chapter(book.id, book.chapters.length - 1).blocks.length <= 100);
    assert.ok(Buffer.byteLength(JSON.stringify(s.chapter(book.id, 0))) < 30000);
  });
  test('reader EPUB worker stores a real cover and aborts revoked imports without partial library entries', async (t) => {
    const s = fixture(t),
      bytes = epub({cover: cover(t), body: '<h1>Глава</h1><img src="cover.png"/><p>Читаем.</p>'});
    const b = await s.upload(bytes, 'book.epub');
    assert.equal(b.cover, true);
    assert.equal(
      fs
        .readFileSync(path.join(s.directory, b.id, 'cover.webp'))
        .subarray(8, 12)
        .toString(),
      'WEBP'
    );
    await assert.rejects(
      s.upload(Buffer.from('Отменённый импорт'), 'cancelled.txt', () => false),
      (e) => e.status === 401
    );
    assert.equal(s.library().length, 1);
    assert.ok(!fs.readdirSync(s.directory).some((p) => p.startsWith('.import-')));
  });
  test('reader HTTP protects books, chapters, covers and settings and detects stale device positions', async (t) => {
    const s = fixture(t),
      config = {
        username: 'admin',
        origin: 'https://hub.test',
        ...(await passwordHash('test-reader-password'))
      };
    const module = readerModule(s.directory),
      b = await module.store.upload(
        epub({cover: cover(t), body: '<h1>Глава</h1><img src="cover.png"/><p>Секретный текст</p>'}),
        'book.epub'
      );
    const app = createApp({
      config,
      modules: new Map([
        ['reader', {id: 'reader', title: 'Клио', ...module, settings: readerSettings}]
      ]),
      sessionsFile: path.join(s.directory, 'sessions.json')
    });
    await new Promise((r) => app.listen(0, '127.0.0.1', r));
    t.after(async () => {
      app.closeAllConnections();
      await new Promise((r) => app.close(r));
    });
    const base = 'http://127.0.0.1:' + app.address().port;
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      redirect: 'manual',
      headers: {Origin: config.origin, 'Content-Type': 'application/x-www-form-urlencoded'},
      body: 'username=admin&password=test-reader-password'
    });
    const Cookie = login.headers
      .getSetCookie()
      .find((c) => c.startsWith('__Host-nexus_session='))
      .split(';')[0];
    const get = (route, cookie = Cookie) =>
        fetch(base + route, {redirect: 'manual', headers: cookie ? {Cookie: cookie} : {}}),
      post = (route, data, origin = config.origin) =>
        fetch(base + route, {
          method: 'POST',
          headers: {Cookie, Origin: origin, 'Content-Type': 'application/json'},
          body: JSON.stringify(data)
        });
    const readingPage=await (await get('/modules/reader/')).text();
    assert.match(readingPage, /<dialog id="readerReading"/);
    assert.match(readingPage, /id="readerMode"/);
    assert.match(readingPage, /engine\.js/);
    assert.match(await (await get('/settings/?module=reader')).text(), /readerSettingsForm/);
    assert.equal((await (await get('/modules/reader/library')).json())[0].title, 'Тестовая книга');
    const routes = [
      '/modules/reader/library',
      '/modules/reader/engine.js',
      '/modules/reader/settings',
      '/modules/reader/book/' + b.id,
      '/modules/reader/book/' + b.id + '/chapter/0',
      '/modules/reader/cover/' + b.id,
      '/modules/reader/book/' + b.id + '/asset/' + Object.keys(b.assets)[0]
    ];
    for (const route of routes) {
      assert.equal((await get(route)).status, 200);
      assert.equal((await get(route, '')).status, 303);
    }
    const data = {id: b.id, position: {chapter: 0, block: 1, offset: 0.4}, version: 0};
    assert.equal((await post('/modules/reader/position', data, 'https://evil.test')).status, 403);
    const saved = await post('/modules/reader/position', data);
    assert.equal(saved.status, 200);
    assert.ok(Number(saved.headers.get('content-length') || 0) < 1000);
    assert.equal((await post('/modules/reader/position', data)).status, 409);
    assert.deepEqual(
      (await (await get('/modules/reader/book/' + b.id)).json()).position,
      data.position
    );
    await post('/api/auth/logout', {});
    for (const route of routes) assert.equal((await get(route)).status, 303);
    assert.equal(
      (
        await post('/modules/reader/settings', {
          size: 20,
          line: 1.7,
          font: 'serif',
          theme: 'hub',
          width: 'normal'
        })
      ).status,
      401
    );
  });
  test('renamed module titles preserve technical IDs, custom names and disabled state', async () => {
    const {currentManifest} = await import('../02-hub/src/modules.mjs');
    for (const [id, old, title] of [
      ['pulse', 'Пульс', 'Атлас'],
      ['signal', 'Сигнал', 'Гермес'],
      ['balance', 'Баланс', 'Плутос'],
      ['chat', 'Чат', 'Оракул'],
      ['anime', 'Кадр', 'Дионис'],
      ['trophies', 'Трофеи', 'Ника'],
      ['wave', 'Волна', 'Аполлон']
    ]) {
      const m = currentManifest(id, {title: old, enabled: false});
      assert.equal(m.title, title);
      assert.equal(m.enabled, false);
      assert.equal(currentManifest(id, {title: 'Моё имя'}).title, 'Моё имя');
      assert.equal(
        JSON.parse(
          fs.readFileSync(new URL('../02-hub/modules/' + id + '/manifest.json', import.meta.url))
        ).title,
        title
      );
    }
  });
}

{
  const {runInNewContext} = await import('node:vm');
  test('reader client serializes opening, recovers failed chapters and detects device conflicts', async () => {
    const nodes = new Map();
    class Element {
      constructor() {
        this.value = '';
        this.children = [];
        this.dataset = {};
        this.events = {};
        this.textContent = '';
        this.hidden = false;
        this.classList = {add() {}, remove() {}, toggle() {}};
      }
      append(...children) {
        this.children.push(...children);
        children.forEach((n, i) => (n.index = i));
      }
      replaceChildren(...children) {
        this.children = [];
        this.append(...children);
      }
      addEventListener(name, fn) {
        this.events[name] = fn;
      }
      setAttribute() {}
      focus() {}
      showModal() {
        this.open = true;
      }
      close() {
        this.open = false;
        this.events.close?.();
      }
      remove() {}
      getBoundingClientRect() {
        const top = (this.index || 0) * 100 - (nodes.get('readerViewport')?.scrollTop || 0);
        return {top, bottom: top + 100, height: 100};
      }
    }
    const get = (id) => {
      if (id === 'readerSettings') return null;
      if (!nodes.has(id)) nodes.set(id, new Element());
      return nodes.get(id);
    };
    const viewport = get('readerViewport');
    viewport.scrollTop = 0;
    viewport.clientHeight = 100;
    viewport.scrollHeight = 300;
    viewport.getBoundingClientRect = () => ({top: 0, bottom: 150, height: 150});
    let book = {
      id: 'book',
      title: 'Книга',
      author: 'Автор',
      format: 'txt',
      cover: false,
      progress: 0,
      positionVersion: 0,
      position: {chapter: 0, block: 0, offset: 0},
      chapters: [
        {title: 'Один', blocks: 3},
        {title: 'Два', blocks: 3}
      ],
      bookmarks: []
    };
    const calls = [],
      swipes = [];
    let preferences = {size: 20, line: 1.7, font: 'serif', theme: 'hub', width: 'normal'}, failSettings = false;
    let timer,
      bookRequests = 0,
      failChapter = false;
    const result = (data, ok = true, status = 200) => ({ok, status, json: async () => data});
    runInNewContext(
      fs.readFileSync(new URL('../02-hub/public/ui.js', import.meta.url), 'utf8') +
        '\nconst Nexus = window.Nexus;\n' +
        fs.readFileSync(new URL('../02-hub/modules/reader/reader.js', import.meta.url), 'utf8'),
      {
        matchMedia: () => ({matches: false}),
        history: {pushState() {}, replaceState() {}},
        addEventListener() {},
        MutationObserver: class {observe() {}},
        ResizeObserver: class {
          observe() {}
        },
        localStorage: {
          getItem() {
            return null;
          }
        },
        location: {origin: 'https://nexus.test'},
        document: {
          documentElement: {classList: {toggle() {}}},
          getElementById: get,
          createElement: () => new Element(),
          querySelectorAll: () => [],
          addEventListener() {}
        },
        window: {
          addEventListener() {},
          parent: {postMessage() {}},
          getSelection() {
            return {
              toString() {
                return '';
              }
            };
          },
          NexusReaderEngine: class {
            constructor(options) {
              Object.assign(this, options);
              this.viewport.events.scroll = this.onChange;
            }
            async open(p) {
              const data = await this.fetchChapter(p.chapter);
              this.p = p;
              this.text.replaceChildren(
                ...data.blocks.map((b) => {
                  const n = new Element();
                  n.textContent = b.text;
                  return n;
                })
              );
              this.viewport.scrollTop = p.block * 100 + p.offset * 100;
            }
            position() {
              return {
                chapter: this.p.chapter,
                block: Math.floor(viewport.scrollTop / 100),
                offset: (viewport.scrollTop % 100) / 100
              };
            }
            async step(direction) {
              swipes.push(direction);
              viewport.scrollTop += direction * 10;
              return true;
            }
            close() {}
          }
        },
        Option: function (label, value) {
          this.label = label;
          this.value = value;
        },
        AbortSignal,
        requestAnimationFrame: (fn) => setImmediate(fn),
        setTimeout: (fn) => {
          timer = fn;
          return 1;
        },
        clearTimeout() {},
        fetch: async (route, options) => {
          if (route.endsWith('/library')) return result([{...book}]);
          if (route.endsWith('/settings')) {
            if (failSettings) return result({error:'Нет связи'}, false, 503);
            if (options.body) preferences = JSON.parse(options.body);
            return result(preferences);
          }
          if (route.endsWith('/book/book')) {
            bookRequests++;
            return result(structuredClone(book));
          }
          if (route.includes('/chapter/') && failChapter)
            return result({error: 'Нет связи'}, false, 503);
          if (route.includes('/chapter/'))
            return result({
              blocks: [
                {type: 'p', text: 'Первый'},
                {type: 'p', text: 'Второй'},
                {type: 'p', text: 'Третий'}
              ]
            });
          if (route.endsWith('/metadata')) {
            const data=JSON.parse(options.body);book={...book,title:data.title,author:data.author};return result(structuredClone(book));
          }
          if (route.endsWith('/position')) {
            const data = JSON.parse(options.body);
            calls.push(data);
            if (data.version !== book.positionVersion)
              return result({error: 'Позиция изменилась'}, false, 409);
            book = {
              ...book,
              position: data.position,
              positionVersion: book.positionVersion + 1,
              progress: 50
            };
            return result(structuredClone(book));
          }
          throw Error('Unexpected ' + route);
        }
      }
    );
    const tick = () => new Promise((r) => setImmediate(r)),
      settle = async () => {
        for (let i = 0; i < 8; i++) await tick();
      };
    await settle();
    get('readerBooks').children[0].children[1].onclick();
    assert.equal(bookRequests,0);assert.equal(get('readerEditDialog').open,true);
    get('readerAuthorInput').value='Новый автор';get('readerTitleInput').value='Новое название';
    get('readerMetaForm').onsubmit({preventDefault(){}});await settle();
    assert.equal(get('readerEditDialog').open,false);assert.equal(bookRequests,0);
    const edited=get('readerBooks').children[0].children[0];
    assert.equal(edited.children[1].textContent,'Новый автор');assert.equal(edited.children[2].textContent,'Новое название');
    get('readerBooks').children[0].children[0].onclick();
    get('readerBooks').children[0].children[0].onclick();
    await settle();
    assert.equal(bookRequests, 1);
    timer();
    await settle();
    assert.equal(calls.at(-1).version, 0);
    viewport.scrollTop = 150;
    viewport.events.scroll();
    timer();
    await settle();
    assert.deepEqual(calls.at(-1).position, {chapter: 0, block: 1, offset: 0.5});
    get('readerLiveSize').value = '32'; get('readerLiveSize').onchange(); await settle();
    assert.equal(preferences.size, 32);
    assert.equal(viewport.dataset.size, '32');
    assert.equal(viewport.scrollTop, 150, 'font change preserves reading position');
    assert.equal(preferences.font, 'serif');
    failSettings = true;
    get('readerLiveSize').value = '16'; get('readerLiveSize').onchange(); await settle();
    assert.equal(get('readerLiveSize').value, '32');
    assert.equal(viewport.dataset.size, '32');
    assert.equal(get('readerLiveSize').disabled, false);
    failSettings = false;
    failChapter = true;
    get('readerChapter').value = '1';
    get('readerChapter').onchange();
    await settle();
    assert.equal(get('readerChapter').value, '0');
    assert.equal(get('readerText').children[0].textContent, 'Первый');
    failChapter = false;
    book = {...book, positionVersion: 4, position: {chapter: 1, block: 0, offset: 0}};
    viewport.scrollTop = 160;
    viewport.events.scroll();
    timer();
    await settle();
    assert.equal(get('readerConflict').hidden, false);
    failChapter = true;
    get('readerRemote').onclick();
    await settle();
    assert.equal(
      get('readerConflict').hidden,
      false,
      'failed remote chapter must keep the conflict'
    );
    failChapter = false;
    get('readerLocal').onclick();
    await settle();
    assert.equal(calls.at(-1).version, 4);
    assert.equal(calls.at(-1).position.chapter, 0);
    assert.equal(calls.at(-1).position.block, 1);
    assert.equal(get('readerConflict').hidden, true);
    assert.match(get('readerSaved').textContent, /сохранена/);
    get('readerMode').value = 'pages';
    get('readerMode').onchange();
    await settle();
    const savedBeforeSwipe = calls.length;
    viewport.events.touchstart({touches: [{clientX: 200, clientY: 100}]});
    viewport.events.touchend({touches: [], changedTouches: [{clientX: 80, clientY: 103}]});
    await settle();
    assert.deepEqual(swipes, [1]);
    assert.equal(calls.length, savedBeforeSwipe, 'swipe must not await a server save');
    viewport.events.touchstart({touches: [{clientX: 200, clientY: 100}]});
    viewport.events.touchend({touches: [], changedTouches: [{clientX: 190, clientY: 250}]});
    await settle();
    assert.deepEqual(swipes, [1], 'vertical gesture must not turn a page');
    viewport.scrollTop = 175;
    viewport.events.scroll();
    get('readerBack').onclick();
    await settle();
    assert.equal(calls.at(-1).position.offset, 0.75);
    assert.equal(get('readerLibrary').hidden, false);
    assert.equal(get('readerReading').open, false);
  });
}

{
  const {ReaderStore} = await import('../02-hub/modules/reader/store.mjs');
  test('reader reports 100 percent only at the actual end of the book', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-end-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const store = new ReaderStore(dir),
      book = await store.upload(Buffer.from('Книга '.repeat(2000)), 'book.txt');
    const chapter = book.chapters.length - 1,
      block = book.chapters[chapter].blocks - 1;
    const almost = store.position(book.id, {chapter, block, offset: 0.99999}, 0);
    assert.equal(almost.progress, 99.9);
    const end = store.position(book.id, {chapter, block, offset: 1}, 1);
    assert.equal(end.progress, 100);
  });
}

// Непрерывное чтение: измеряемая модель страницы без браузера.
{
  const {runInNewContext} = await import('node:vm');
  function readerEngineFixture(parts, height = 100) {
    let viewport;
    class Element {
      constructor(tag = 'article') {
        this.tagName = tag;
        this.children = [];
        this.dataset = {};
        this.style = {};
        this.events = {};
        this._text = '';
        this.scrollTop = 0;
      }
      set textContent(v) {
        this._text = v;
        this.children = [];
      }
      get textContent() {
        return this._text + this.children.map((n) => n.textContent).join('');
      }
      append(...nodes) {
        for (const n of nodes) {
          n.remove();
          n.parent = this;
          this.children.push(n);
        }
      }
      prepend(n) {
        n.remove();
        n.parent = this;
        this.children.unshift(n);
      }
      replaceChildren(...nodes) {
        for (const n of this.children) n.parent = null;
        this.children = [];
        this._text = '';
        this.append(...nodes);
      }
      remove() {
        if (this.parent) {
          this.parent.children = this.parent.children.filter((n) => n !== this);
          this.parent = null;
        }
      }
      setAttribute() {}
      addEventListener(name, fn) {
        this.events[name] = fn;
      }
      removeEventListener(name) {
        delete this.events[name];
      }
      get clientHeight() {
        return Number.parseFloat(this.style.height) || height;
      }
      get scrollHeight() {
        return Math.max(
          this.clientHeight,
          this.children.reduce((n, c) => n + c.height, 0)
        );
      }
      get height() {
        if (this.tagName === 'figure') return 40;
        if (this.children.length) return this.children.reduce((n, c) => n + c.height, 0);
        return Math.ceil(this._text.length / 20) * 10;
      }
      getBoundingClientRect() {
        let top = 0,
          n = this;
        while (n.parent) {
          const i = n.parent.children.indexOf(n);
          top += n.parent.children.slice(0, i).reduce((h, c) => h + c.height, 0);
          n = n.parent;
        }
        if (this !== viewport) top -= viewport.scrollTop;
        return {top, bottom: top + this.height, height: this.height, width: 400};
      }
      querySelectorAll() {
        return this.children.flatMap((n) =>
          n.dataset.block !== undefined ? [n] : n.querySelectorAll()
        );
      }
      querySelector(selector) {
        const nums = [...selector.matchAll(/="(\d+)"/g)].map((m) => m[1]);
        return this.querySelectorAll().find(
          (n) => n.dataset.chapter === nums[0] && n.dataset.block === nums[1]
        );
      }
    }
    viewport = new Element('viewport');
    viewport.style.height = String(height);
    const text = new Element();
    viewport.append(text);
    const win = {},
      requests = [];
    runInNewContext(
      fs.readFileSync(new URL('../02-hub/modules/reader/engine.js', import.meta.url), 'utf8'),
      {
        window: win,
        setTimeout,
        document: {createElement: (t) => new Element(t)},
        requestAnimationFrame: (fn) => setImmediate(fn),
        cancelAnimationFrame: clearImmediate
      }
    );
    const engine = new win.NexusReaderEngine({
      viewport,
      text,
      book: {id: 'test', chapters: parts.map((p) => ({blocks: p.length}))},
      fetchChapter: async (i) => {
        requests.push(i);
        return {blocks: parts[i]};
      },
      onChange() {},
      onError(e) {
        throw e;
      }
    });
    return {engine, viewport, text, requests};
  }
  test('reader pages cross part boundaries without losing or duplicating text and can go back', async () => {
    const parts = Array.from({length: 8}, (_, i) => [
      {type: 'p', text: ('Часть ' + i + ' текст 📖 ').repeat(19)},
      {type: 'p', text: 'Конец ' + i + '!'}
    ]);
    const {engine, text} = readerEngineFixture(parts);
    const original = parts
      .flat()
      .map((b) => b.text)
      .join('');
    await engine.open({chapter: 0, block: 0, offset: 0}, 'pages');
    const pages = [text.textContent];
    for (let i = 0; i < 200; i++) {
      if (!(await engine.step(1))) break;
      pages.push(text.textContent);
    }
    assert.equal(pages.join(''), original);
    assert.ok(pages.length > 8);
    assert.equal(engine.position().offset, 1);
    const backward = [text.textContent];
    for (let i = 0; i < 200; i++) {
      if (!(await engine.step(-1))) break;
      backward.unshift(text.textContent);
    }
    assert.equal(backward.join(''), original);
    assert.equal(engine.page.start.chapter, 0);
    assert.equal(engine.page.start.block, 0);
    assert.equal(engine.page.start.offset, 0);
    assert.equal(await engine.step(-1), false);
    assert.ok(engine.cache.size <= 12);
    assert.ok(engine.pages.size <= 8);
    engine.close();
  });
  test('reader keeps a bounded scroll window and preserves the anchor when prepending', async () => {
    const parts = Array.from({length: 40}, (_, i) => [
      {type: 'p', text: ('Абзац ' + i + ' ').repeat(150)}
    ]);
    const {engine, viewport, text} = readerEngineFixture(parts, 100);
    await engine.open({chapter: 15, block: 0, offset: 0.4}, 'scroll');
    assert.equal(engine.position().chapter, 15);
    assert.ok(Math.abs(engine.position().offset - 0.4) < 0.01);
    const before = engine.position();
    viewport.scrollTop = 0;
    await engine.extend();
    assert.equal(engine.position().chapter, 14);
    assert.ok(engine.sections.has(13));
    for (let i = 0; i < 22; i++) {
      viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
      await engine.extend();
    }
    assert.ok(engine.sections.size <= 7);
    assert.ok(text.querySelectorAll().length <= 7);
    assert.ok(engine.cache.size <= 12);
    assert.ok(before.chapter === 15);
    engine.close();
  });
  test('reader page prefetch serves the next swipe without another fetch and resize keeps a text anchor', async () => {
    const parts = Array.from({length: 4}, (_, i) => [
      {type: 'p', text: ('Строка ' + i + ' ').repeat(120)}
    ]);
    const {engine, viewport, requests} = readerEngineFixture(parts);
    await engine.open({chapter: 0, block: 0, offset: 0}, 'pages');
    await engine.warming;
    const count = requests.length;
    assert.equal(await engine.step(1), true);
    assert.equal(requests.length, count);
    const p = engine.position();
    viewport.style.height = '160';
    await engine.open(p, 'pages');
    assert.equal(engine.page.start.chapter, p.chapter);
    assert.equal(engine.page.start.block, p.block);
    assert.equal(engine.page.start.offset, p.offset);
    engine.close();
  });
  test('reader keeps the visible page on network failure and permits retry', async () => {
    const {engine, text} = readerEngineFixture([[{type: 'p', text: 'Текст книги '.repeat(200)}]]);
    await engine.open({chapter: 0, block: 0, offset: 0}, 'pages');
    await engine.warming;
    const previous = text.textContent,
      fetcher = engine.fetchChapter;
    engine.pages.clear();
    engine.cache.clear();
    engine.fetchChapter = async () => {
      throw Error('Нет связи');
    };
    await assert.rejects(engine.step(1), /Нет связи/);
    assert.equal(text.textContent, previous);
    assert.equal(engine.busy, false);
    engine.fetchChapter = fetcher;
    assert.equal(await engine.step(1), true);
    engine.close();
  });
}

test('Nika removes legacy QR tokens locally without contacting Steam or losing games', async (t) => {
  const {TrophiesStore} = await import('../02-hub/modules/trophies/store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-migration-'));
  const offline = {fetcher: async () => assert.fail('No account requests during migration or startup')};
  const original = new TrophiesStore(dir, offline);
  original.load();
  original.set('steam', {id: '76561198000000000', name: 'Player', key: 'saved-api-key', refreshToken: 'old-refresh', accessToken: 'old-access', expiresAt: 42});
  original.db.prepare('INSERT INTO games VALUES(?,?,?,?)').run('steam', '76561198000000000', '1', JSON.stringify({id: '1', title: 'Saved game', achievements: [{id: 'WIN', soft: true}]}));
  await original.close();
  const migrated = new TrophiesStore(dir, offline);
  t.after(async () => { await migrated.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  migrated.start();
  await new Promise(resolve => setImmediate(resolve));
  const account = migrated.account('steam');
  assert.equal(account.refreshToken, undefined);
  assert.equal(account.accessToken, undefined);
  assert.equal(account.expiresAt, undefined);
  assert.equal(account.key, 'saved-api-key');
  assert.equal(account.error, null);
  assert.equal(migrated.snapshot().games[0].soft, 1);
  assert.equal(migrated.jobs.size, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'trophies.db')).toString(), /old-refresh|old-access/);
});

test('Nika rejects retired QR endpoints without contacting the provider', async (t) => {
  const {createModule, settings} = await import('../02-hub/modules/trophies/index.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-routes-'));
  const module = createModule(dir, {fetcher: async () => assert.fail('No QR network requests')});
  t.after(async () => { await module.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  assert.doesNotMatch(settings.content, /steamQR|steamStatsKey/);
  for (const route of ['/steam-qr', '/steam/begin', '/steam/poll', '/steam/cancel', '/steam/key']) {
    const result = await module.handle({path: route, request: {method: route === '/steam-qr' ? 'GET' : 'POST'}, user: {username: 'test'}});
    assert.equal(result.status, 404);
  }
});

test('Nika persists Steam Retry-After and does not retry after restart', async (t) => {
  const {TrophiesStore} = await import('../02-hub/modules/trophies/store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-limit-'));
  let calls = 0;
  const now = Date.now();
  const options = {now: () => now, sleep: async () => {}, fetcher: async () => {
    calls++; return new Response('private provider message', {status: 429, headers: {'Retry-After': '7200'}});
  }};
  const original = new TrophiesStore(dir, options);
  original.load(); original.set('steam', {id: '76561198000000000', key: 'local-key'});
  await original.sync('steam');
  assert.equal(calls, 1);
  assert.equal(original.account('steam').nextAttempt, now + 7200000);
  await original.close();
  const restarted = new TrophiesStore(dir, options);
  t.after(async () => { await restarted.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  restarted.start();
  await assert.rejects(restarted.sync('steam'), {status: 429});
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(restarted.config()), /private provider|local-key/);
});

test('shared browser requests preserve payloads, conflicts and cancellation without retries', async () => {
  const {runInNewContext} = await import('node:vm');
  const calls = [], noop = () => {};
  let responder = async () => Response.json({ok: true});
  const context = {
    document: {documentElement: {}, body: {}, querySelectorAll: () => [], addEventListener: noop,
      createElement: tag => ({tagName: tag.toUpperCase()})},
    matchMedia: () => ({matches: false}), history: {pushState: noop, replaceState: noop},
    addEventListener: noop, MutationObserver: class {observe() {}},
    fetch: async (...args) => {calls.push(args); return responder(...args);}
  };
  context.window = context; context.parent = context;
  runInNewContext(fs.readFileSync(new URL('../02-hub/public/ui.js', import.meta.url), 'utf8'), context);
  const {request, node} = context.Nexus;
  await request('/api/example');
  assert.equal(calls[0][1].body, undefined);
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].cache, 'no-store');
  const signal = new AbortController().signal;
  await request('/api/example', {title: 'Афина'}, {signal});
  assert.equal(calls[1][1].signal, signal);
  assert.equal(calls[1][1].method, 'POST');
  assert.equal(calls[1][1].headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(calls[1][1].body).title, 'Афина');
  await request('/api/example', false);
  assert.equal(calls[2][1].body, 'false');
  responder = async () => Response.json({error: 'Изменено в другой вкладке'}, {status: 409});
  await assert.rejects(() => request('/api/example', {}), {status: 409, message: 'Изменено в другой вкладке'});
  responder = async () => ({status: 200, redirected: true, json: () => {throw Error('must not parse login page');}});
  await assert.rejects(() => request('/api/example'), {status: 401});
  responder = async () => new Response('<html>gateway error</html>', {status: 502});
  await assert.rejects(() => request('/api/example'), {status: 502, message: 'Не удалось прочитать ответ сервера'});
  responder = async () => {throw new DOMException('Cancelled', 'AbortError');};
  await assert.rejects(() => request('/api/example'), {name: 'AbortError'});
  assert.equal(calls.length, 7);
  const element = node('span', '<img src=x onerror=alert(1)>', 'label');
  assert.equal(element.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(element.innerHTML, undefined);
  assert.equal(element.className, 'label');
});

test('hub questions accept text, cancel safely, restore focus and prevent duplicate dialogs', async () => {
  const {runInNewContext} = await import('node:vm');
  const elements = [], noop = () => {};
  class Element extends EventTarget {
    constructor(tag) {super();this.tagName=tag;this.children=[];this.dataset={};this.isConnected=true;elements.push(this);}
    append(...children) {this.children.push(...children);}
    setAttribute(name,value) {this[name]=value;}
    focus() {this.focused=true;}
    select() {this.selected=true;}
    showModal() {this.open=true;}
    close() {this.open=false;this.dispatchEvent(new Event('close'));}
    remove() {this.isConnected=false;}
  }
  const previous = new Element('button');
  const context = {
    document:{documentElement:{},body:new Element('body'),activeElement:previous,
      createElement:tag=>new Element(tag),querySelectorAll:()=>[],addEventListener:noop},
    matchMedia:()=>({matches:false}),history:{pushState:noop,replaceState:noop},
    addEventListener:noop,MutationObserver:class {observe() {}}
  };
  context.window=context;context.parent=context;
  runInNewContext(fs.readFileSync(new URL('../02-hub/public/ui.js',import.meta.url),'utf8'),context);
  const prompt=context.Nexus.prompt('Название','старое');
  assert.equal(await context.Nexus.prompt('Повтор'),null);
  const input=elements.findLast(e=>e.tagName==='input');
  assert.equal(input.value,'старое');assert.equal(input.selected,true);
  input.value='<script>только текст</script>';
  elements.findLast(e=>e.tagName==='form').onsubmit({preventDefault:noop});
  assert.equal(await prompt,'<script>только текст</script>');assert.equal(previous.focused,true);
  assert.equal(elements.findLast(e=>e.tagName==='dialog').isConnected,false);
  const cancelled=context.Nexus.confirm('Удалить?');
  elements.findLast(e=>e.tagName==='dialog').close();assert.equal(await cancelled,false);
  const accepted=context.Nexus.confirm('Продолжить?');
  elements.findLast(e=>e.tagName==='form').onsubmit({preventDefault:noop});assert.equal(await accepted,true);
  const notes=context.Nexus.prompt('Заметки','строка 1\nстрока 2',{multiline:true});
  assert.equal(elements.findLast(e=>e.tagName==='textarea').value,'строка 1\nстрока 2');
  elements.findLast(e=>e.tagName==='dialog').close();assert.equal(await notes,null);
});

test('retired APK settings share a revocation-only client and keep empty lists hidden', async () => {
  const {runInNewContext} = await import('node:vm');
  const code = fs.readFileSync(new URL('../02-hub/public/legacy-clients.js', import.meta.url), 'utf8');
  const routes = ['/modules/wave/phone', '/modules/signal/phone', '/modules/storage/api/phone'];
  for (const route of routes) {
    const node = (tag, text) => ({tag, textContent: text ?? '', children: [], append(...items) {this.children.push(...items);}, replaceChildren() {this.children = [];}});
    const status = node('p'), list = node('div'), root = {hidden: true, dataset: {legacyClients: route}, querySelector: key => key.includes('status') ? status : list};
    const calls = []; let active = true;
    runInNewContext(code, {document: {querySelectorAll: () => [root]}, Nexus: {node, confirm: async () => true, request: async (url, data) => {
      calls.push({url, data});
      if (url.endsWith('/revoke')) {active = false; return {};}
      const items = active ? [{id: 'old', name: '<script>not HTML</script>'}] : [];
      return route.includes('storage') ? {items} : items;
    }}});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(root.hidden, false);
    assert.equal(list.children[0].children[0].textContent, '<script>not HTML</script> ');
    await list.children[0].children[1].onclick();
    assert.equal(calls[1].url, route + '/revoke');
    assert.equal(calls[1].data.id, 'old');
    assert.equal(root.hidden, true);
  }
});

test('legacy module mutations reject a session revoked while receiving JSON', async t => {
  const {PassThrough} = await import('node:stream');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revoked-modules-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  for (const [name,route] of [['anime','/disconnect'],['trophies','/disconnect'],['chat','/config'],['wave','/phone/create'],['signal','/phone/create'],['signal','/settings']]) {
    const exported = await import('../02-hub/modules/'+name+'/index.mjs');
    const module = name === 'signal' ? {handle:exported.createHandler({file:path.join(dir,'signal.json'),authFile:path.join(dir,'auth.json')})} : exported.createModule(path.join(dir,name));
    const request = new PassThrough();request.method='POST';request.headers={'content-type':'application/json'};
    let allowed = true;
    const response = module.handle({request,path:route,user:{username:'test'},searchParams:new URLSearchParams(),authorized:()=>allowed});
    request.write('{');allowed=false;request.end('}');
    assert.equal((await response).status,401,name+route);
    await module.close?.();
  }
});

test('music upload revoked mid-stream leaves no track or temporary file', async t => {
  const {WaveStore} = await import('../02-hub/modules/wave/store.mjs');
  const {Readable} = await import('node:stream');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'wave-revoked-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store = new WaveStore(dir);let allowed=true;
  const request = Readable.from((async function*(){yield Buffer.from('partial');allowed=false;yield Buffer.from('rest');})());
  await assert.rejects(store.upload(request,'track.wav',()=>allowed),{status:401});
  assert.equal(store.snapshot().tracks.length,0);
  assert.equal(store.busy,false);
  assert.equal(fs.readdirSync(dir).filter(name=>name.endsWith('.upload')).length,0);
});
