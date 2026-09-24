import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// tests/anime
{
  const {AnimeStore, save, normalize, posterURL} = await import('./02-hub/modules/anime/store.mjs');
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
    const {createModule, settings} = await import('./02-hub/modules/anime/index.mjs');
    const {createApp} = await import('./02-hub/src/server.mjs');
    const {passwordHash} = await import('./02-hub/src/auth.mjs');
    const mod = createModule(f.dir, f.options),
      config = {
        username: 'admin',
        origin: 'https://hub.example.com',
        ...(await passwordHash('test-password-123'))
      };
    const app = createApp({
      config,
      modules: new Map([['anime', {id: 'anime', title: 'Кадр', description: '', ...mod, settings}]])
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
  const {options, syncRepository, launchMenu, projectFiles} = await import('./bootstrap.mjs');
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
    const {checkProject} = await import('./bootstrap.mjs');
    checkProject(new URL('./', import.meta.url).pathname);
  });
}

// tests/host
{
  const {validPort, validUser, validTime, withLock, atomic} = await import('./host/common.mjs');
  const {
    cpuCounters,
    cpuUsage,
    memoryUsage,
    networkCounters,
    networkUsage,
    mountpoints,
    diskUsage,
    Collector
  } = await import('./host/metrics.mjs');
  const {clearPorts, parseSSH} = await import('./host/ssh.mjs');
  const {validDomain, validUpstream, renderCaddy, preflight} = await import('./host/platform.mjs');
  const {warnSchedule} = await import('./host/maintenance.mjs');
  const {sshEvent} = await import('./host/events.mjs');
  const {portFindings, loopback} = await import('./host/security.mjs');
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
    const {runtimeRelease} = await import('./host/runtime.mjs');
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
  const {job, installSchedules, warnSchedule} = await import('./host/maintenance.mjs');
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
    const {waitForSSHJail} = await import('./host/maintenance.mjs');
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
    const {waitForSSHJail} = await import('./host/maintenance.mjs');
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
    const {waitForSSHJail} = await import('./host/maintenance.mjs');
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
  const {installModules, modulesMenu, modules} = await import('./menu.mjs');
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
    assert.ok(screen.lines.some((t) => t.includes('Готово: Пульс')));
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
  const {moduleFiles} = await import('./host/platform.mjs');

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
    const manifest = {apiVersion: 1, title: 'Баланс', description: '', enabled: true};
    fs.writeFileSync(source + '/manifest.json', JSON.stringify(manifest));
    fs.writeFileSync(source + '/index.mjs', 'new code');
    fs.writeFileSync(source + '/balance.js', 'new UI');
    if (installed) {
      fs.mkdirSync(target, {recursive: true});
      fs.writeFileSync(target + '/index.mjs', 'old code');
      fs.writeFileSync(target + '/obsolete.js', 'old UI');
      fs.writeFileSync(target + '/manifest.json', JSON.stringify({...manifest, enabled: false}));
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
  const {exec, apt, installHost, saveJSON} = await import('./host/common.mjs');
  const {updateHubOrigin} = await import('./host/platform.mjs');
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
  const {Rules, defaultSettings} = await import('./host/signal-rules.mjs');
  const {Signal, readEvents, readSettings} = await import('./host/signal.mjs');
  const {vapidKeys, subscriptionId} = await import('./host/webpush.mjs');
  const {saveJSON} = await import('./host/common.mjs');
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
  const {SSH, rollback, migrateManagedSSH} = await import('./host/ssh.mjs');
  const {exec, read} = await import('./host/common.mjs');
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
    './host/webpush.mjs'
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
      readFileSync(new URL('./02-hub/modules/balance/balance.js', import.meta.url), 'utf8'),
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
  const {Ledger, money} = await import('./02-hub/modules/balance/store.mjs');
  const {createModule, settings} = await import('./02-hub/modules/balance/index.mjs');
  const {createApp} = await import('./02-hub/src/server.mjs');
  const {passwordHash} = await import('./02-hub/src/auth.mjs');
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
      moduleURL = new URL('./02-hub/modules/balance/store.mjs', import.meta.url).href;
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
        ['balance', {id: 'balance', title: 'Баланс', description: '', ...module, settings}]
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
  const {ChatStore, models} = await import('./02-hub/modules/chat/store.mjs');
  const {complete} = await import('./02-hub/modules/chat/deepseek.mjs');
  const {createModule, settings} = await import('./02-hub/modules/chat/index.mjs');
  const {createApp} = await import('./02-hub/src/server.mjs');
  const {passwordHash} = await import('./02-hub/src/auth.mjs');
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
      modules: new Map([['chat', {id: 'chat', title: 'Чат', ...module, settings}]])
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
  const {FlowSession} = await import('./02-hub/modules/chat/flow-session.mjs');
  const {FlowAudio, audioURL} = await import('./02-hub/modules/chat/flow-audio.mjs');
  const {generate, readEvents, clipIDs} = await import('./02-hub/modules/chat/flowmusic.mjs');
  const {ChatStore, models} = await import('./02-hub/modules/chat/store.mjs');
  const {checkKey} = await import('./02-hub/modules/chat/deepseek.mjs');
  const {createModule} = await import('./02-hub/modules/chat/index.mjs');
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
    const {createApp} = await import('./02-hub/src/server.mjs');
    const {passwordHash} = await import('./02-hub/src/auth.mjs');
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
      modules: new Map([['chat', {id: 'chat', title: 'Чат', ...module}]])
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
    './02-hub/modules/balance/market.mjs'
  );
  const {ChatStore} = await import('./02-hub/modules/chat/store.mjs');
  const {complete} = await import('./02-hub/modules/chat/deepseek.mjs');
  const {estimate, normalizeUsage, usageSnapshot} = await import('./02-hub/src/ai-usage.mjs');
  const {createModule} = await import('./02-hub/modules/balance/index.mjs');
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
    const {createApp} = await import('./02-hub/src/server.mjs'),
      {passwordHash} = await import('./02-hub/src/auth.mjs');
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
      modules: new Map([['balance', {id: 'balance', title: 'Баланс', ...mod}]])
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
  const {createHandler} = await import('./02-hub/modules/pulse/index.mjs');
  const {createApp} = await import('./02-hub/src/server.mjs');
  const {passwordHash} = await import('./02-hub/src/auth.mjs');
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
    assert.match(await (await handle(input('/'))).text(), /Пульс/);
  });
  test('pulse page, assets and metrics require hub login and remain uncached', async (t) => {
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
        ['pulse', {id: 'pulse', title: 'Пульс', description: 'test', handle: createHandler(file)}]
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
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const dashboard = await (await fetch(base, {headers: {Cookie: cookie}})).text();
    assert.match(dashboard, /href="\/modules\/pulse\/"/);
  });

  test('pulse card reports resource values and preserves missing or stale data', async (t) => {
    const {createSummary} = await import('./02-hub/modules/pulse/index.mjs');
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
    './02-hub/src/auth.mjs'
  );
  const {createApp} = await import('./02-hub/src/server.mjs');
  const {loadModules} = await import('./02-hub/src/modules.mjs');
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
    cpSync(new URL('./02-hub/public', import.meta.url), dir, {recursive: true});
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
    const {validateManifest} = await import('./02-hub/src/modules.mjs');
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
    runInNewContext(readFileSync(new URL('./02-hub/public/sw.js', import.meta.url), 'utf8'), {
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
    assert.ok(notices.every((n) => n.title === 'NEXUS404 · Сигнал'));
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
    assert.equal(calls, 0);
    const headers = {Cookie: cookie(await signin())};
    const response = await request('/api/modules', {headers}),
      data = await response.json();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(data.modules[0].summary, {state: 'ok', items: [{label: 'CPU', value: '12%'}]});
    assert.deepEqual(data.modules[1].summary, {state: 'stale', items: []});
    assert.equal(data.modules[2].summary, undefined);
    assert.doesNotMatch(JSON.stringify(data), /private/);
    const html = await (await request('/', {headers})).text();
    assert.doesNotMatch(html, /module-open|открыть/);
    assert.match(html, /data-summary="live"/);
  });
  test('unresponsive module summary times out and receives cancellation', async () => {
    const {moduleSummary} = await import('./02-hub/src/modules.mjs');
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

  test('settings render only the selected installed module and support an empty hub', async (t) => {
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
    assert.match(fallback, /id="first-settings"/);
    modules.clear();
    const empty = await (await request('/settings/', {headers})).text();
    assert.match(empty, /пока не добавили настройки/);
    const home = await (await request('/', {headers})).text();
    assert.match(home, /href="\/settings\/"/);
    assert.doesNotMatch(home, /module-mark/);
  });
}

// 02-hub/tests/signal
{
  const {createHandler, settings: signalSettings} = await import(
    './02-hub/modules/signal/index.mjs'
  );
  const {createApp} = await import('./02-hub/src/server.mjs');
  const {passwordHash} = await import('./02-hub/src/auth.mjs');
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
          {id: 'signal', title: 'Сигнал', description: 'test', handle, settings: signalSettings}
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
    const {createSummary} = await import('./02-hub/modules/signal/index.mjs');
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
  const {moduleSummary} = await import('./02-hub/src/modules.mjs');
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
  const {TrophiesStore} = await import('./02-hub/modules/trophies/store.mjs');
  const {Provider, steamId, timestamp} = await import('./02-hub/modules/trophies/providers.mjs');
  const {achievementEvents} = await import('./host/signal.mjs');
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
      if (p.includes('GetOwnedGames'))
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
  test('trophies keeps loading other games after a per-game Steam 403', async (t) => {
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
    assert.match(f.store.config().steam.error, /Не обновлено игр: 1/);
  });
  test('trophies accepted sync survives the initiating request closing', async (t) => {
    const {createModule} = await import('./02-hub/modules/trophies/index.mjs');
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
    const {createModule} = await import('./02-hub/modules/trophies/index.mjs');
    const mod = createModule(f.dir + '/summary', f.options);
    mod.store.load();
    t.after(() => mod.close());
    mod.store.set('steam', {...account, error: 'Partial failure', lastSync: 0});
    mod.store.commitGame('steam', account, game);
    const summary = await mod.summary();
    assert.equal(summary.state, 'warning');
    assert.equal(summary.items.find((x) => x.label === 'Открыто').value, 1);
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
    assert.deepEqual(await p.get('test'), {ok: true});
    assert.ok(waits.includes(3000));
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
  const {Provider} = await import('./02-hub/modules/trophies/providers.mjs');
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
  const {moduleSummary} = await import('./02-hub/src/modules.mjs');
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

// tests/steam-qr
{
  const {SteamAuth, message, fields, tokenInfo, challenge, qrSVG} = await import(
    './02-hub/modules/trophies/steam-auth.mjs'
  );
  const {TrophiesStore} = await import('./02-hub/modules/trophies/store.mjs');
  const {Provider} = await import('./02-hub/modules/trophies/providers.mjs');
  const id = '76561198000000000';
  const jwt = (refresh, owner = id, seconds = 3600) =>
    'eyJhbGciOiJSUzI1NiJ9.' +
    Buffer.from(
      JSON.stringify({
        sub: owner,
        exp: Math.floor(Date.now() / 1000) + seconds,
        aud: refresh ? ['web', 'mobile', 'derive'] : ['web', 'mobile']
      })
    ).toString('base64url') +
    '.dGVzdHNpZw';
  const reply = (data) => new Response(message(data), {headers: {'x-eresult': '1'}});
  const initial = () =>
    reply([
      [1, 0, '18446744073709550000'],
      [2, 2, 'https://s.team/q/1/18446744073709550000'],
      [3, 2, 'private-request-id']
    ]);
  test('Steam protobuf keeps uint64 exact and rejects truncated wire data', () => {
    const data = fields(
      message([
        [1, 0, '18446744073709551615'],
        [2, 1, id],
        [3, 2, 'hello']
      ])
    );
    assert.equal(data.get(1), '18446744073709551615');
    assert.equal(data.get(2), id);
    assert.equal(data.get(3).toString(), 'hello');
    assert.throws(() => fields(Buffer.from([10, 255])));
    assert.throws(() => fields(Buffer.from([0])));
  });
  test('Steam QR challenges are fixed-host links and render no arbitrary markup', () => {
    assert.throws(() => challenge('https://evil.test/q/1/123'));
    assert.throws(() => challenge('https://s.team/q/1/123?x=1'));
    const svg = qrSVG(challenge('https://s.team/q/1/123'));
    assert.match(svg, /viewBox="0 0 41 41"/);
    assert.doesNotMatch(svg, /script|href|https:\/\/s.team/);
    assert.throws(() => qrSVG('x'.repeat(79)));
  });
  test('Steam QR status never exposes routing secrets and enforces timeout/cancel', async () => {
    let now = Date.now();
    const a = new SteamAuth({now: () => now, fetcher: async () => initial()});
    const p = await a.begin();
    assert.doesNotMatch(JSON.stringify(p), /private-request|184467/);
    await assert.rejects(a.begin(), (e) => e.status === 429);
    assert.equal(a.require(p.attempt).request.toString(), 'private-request-id');
    now += 120001;
    assert.throws(
      () => a.require(p.attempt),
      (e) => e.status === 410
    );
    const next = await a.begin();
    a.cancel(next.attempt);
    assert.equal(a.status(), null);
    a.close();
  });
  test('Steam QR polling handles challenge rotation and receives account tokens', async () => {
    let now = Date.now(),
      polls = 0;
    const a = new SteamAuth({
      now: () => now,
      fetcher: async (u, opts) => {
        const sent = fields(Buffer.from(opts.body.get('input_protobuf_encoded'), 'base64'));
        if (u.includes('BeginAuth')) return initial();
        assert.equal(sent.get(2).toString(), 'private-request-id');
        if (++polls === 1)
          return reply([
            [1, 0, '1234'],
            [2, 2, 'https://s.team/q/1/1234'],
            [5, 0, 1]
          ]);
        assert.equal(sent.get(1), '1234');
        return reply([
          [3, 2, jwt(true)],
          [4, 2, jwt(false)],
          [6, 2, 'Player']
        ]);
      }
    });
    const p = await a.begin();
    const first = await a.poll(p.attempt);
    assert.equal(first.scanned, true);
    assert.equal(first.revision, 1);
    await a.poll(p.attempt);
    assert.equal(polls, 1);
    now += 6000;
    const done = await a.poll(p.attempt);
    assert.equal(done.tokens.id, id);
    assert.equal(done.tokens.name, 'Player');
    a.close();
  });
  test('Steam token renewal validates account and keeps an unchanged refresh token', async () => {
    const refresh = jwt(true);
    const a = new SteamAuth({
      fetcher: async (u, opts) => {
        const sent = fields(Buffer.from(opts.body.get('input_protobuf_encoded'), 'base64'));
        assert.equal(sent.get(2), id);
        return reply([[1, 2, jwt(false)]]);
      }
    });
    assert.equal((await a.refresh(refresh, id)).refreshToken, refresh);
    a.fetcher = async () => reply([[1, 2, jwt(false, '76561198000000001')]]);
    await assert.rejects(a.refresh(refresh, id), /Некорректная/);
    assert.throws(() => tokenInfo(jwt(true)), /неподдерживаемую/);
    a.close();
  });
  test('Steam auth errors do not echo provider secrets', async () => {
    const a = new SteamAuth({
      fetcher: async () => new Response('SECRET-BODY', {status: 401, headers: {'x-eresult': '15'}})
    });
    await assert.rejects(a.begin(), (e) => e.status === 401 && !e.message.includes('SECRET'));
    a.close();
  });
  test('QR connection stores private tokens atomically and uses them for owned games', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-steam-qr-'));
    let libraries = 0;
    const store = new TrophiesStore(dir, {
      sleep: async () => {},
      fetcher: async (u) => {
        const url = String(u);
        if (url.includes('BeginAuth')) return initial();
        if (url.includes('PollAuth'))
          return reply([
            [3, 2, jwt(true)],
            [4, 2, jwt(false)],
            [6, 2, 'Player']
          ]);
        if (url.includes('GetOwnedGames')) {
          const q = new URL(url).searchParams;
          assert.equal(q.get('access_token'), jwt(false));
          assert.equal(q.get('skip_unvetted_apps'), '0');
          assert.equal(q.get('include_free_sub'), '1');
          libraries++;
          return Response.json({response: {game_count: 0}});
        }
        throw Error('Unexpected request');
      }
    });
    t.after(async () => {
      await store.close();
      fs.rmSync(dir, {recursive: true, force: true});
    });
    const p = await store.qrBegin();
    const result = await store.qrPoll(p.attempt);
    assert.equal(result.connected, true);
    await Promise.all([...store.jobs.values()]);
    assert.equal(libraries, 1);
    assert.equal(store.account('steam').refreshToken, jwt(true));
    assert.doesNotMatch(JSON.stringify(store.snapshot()), /accessToken|refreshToken|eyJhbGci/);
    assert.equal(store.config().steam.mode, 'qr');
    assert.equal(fs.statSync(dir + '/trophies.db').mode & 0o777, 0o600);
    store.disconnect('steam');
    assert.equal(store.account('steam'), null);
  });
  test('Steam API refreshes once on authorization failure and retries with the new token', async () => {
    const seen = [],
      refresh = [];
    const p = new Provider(
      'steam',
      {id},
      {
        sleep: async () => {},
        token: async (force) => {
          refresh.push(force);
          return force ? 'new-token' : 'old-token';
        },
        fetcher: async (u) => {
          seen.push(u.searchParams.get('access_token'));
          return seen.length === 1
            ? new Response('', {status: 401})
            : Response.json({response: {game_count: 0}});
        }
      }
    );
    await p.library();
    assert.deepEqual(seen, ['old-token', 'new-token']);
    assert.deepEqual(refresh, [false, true]);
    seen.length = refresh.length = 0;
    p.fetcher = async (u) => {
      seen.push(u.searchParams.get('access_token'));
      return new Response('', {status: 401});
    };
    await assert.rejects(p.library(), (e) => e.status === 401);
    assert.equal(seen.length, 2);
    assert.deepEqual(refresh, [false, true]);
  });
  test('Steam late confirmation cannot connect an already cancelled QR attempt', async () => {
    let resolve;
    const a = new SteamAuth({
      fetcher: async (u) =>
        u.includes('BeginAuth') ? initial() : new Promise((r) => (resolve = r))
    });
    const p = await a.begin(),
      poll = a.poll(p.attempt);
    await Promise.resolve();
    a.cancel(p.attempt);
    resolve(
      reply([
        [3, 2, jwt(true)],
        [4, 2, jwt(false)]
      ])
    );
    await assert.rejects(poll, (e) => e.status === 410);
    a.close();
  });
}

// tests/sync-recovery
{
  const {FlowSession} = await import('./02-hub/modules/chat/flow-session.mjs');
  const {Provider} = await import('./02-hub/modules/trophies/providers.mjs');
  const {TrophiesStore} = await import('./02-hub/modules/trophies/store.mjs');
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
  test('Steam QR is used for library, API key for statistics, no secrets for store or rarity', async () => {
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
    assert.equal(requests[0].searchParams.get('access_token'), 'private-access-token');
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
  test('Steam key update keeps the QR session and library intact', async (t) => {
    const s = new TrophiesStore(temp(t), {
      sleep: async () => {},
      fetcher: async () =>
        Response.json({
          response: {players: [{steamid: '76561198000000000', personaname: 'Player'}]}
        })
    });
    s.load();
    t.after(() => s.close());
    s.set('steam', {
      id: '76561198000000000',
      name: 'Player',
      refreshToken: 'retained-refresh',
      accessToken: 'retained-access',
      expiresAt: Date.now() + 3600000
    });
    let synced = false;
    s.sync = async () => {
      synced = true;
    };
    await s.steamKey('new-api-key-123456789');
    assert.equal(s.account('steam').refreshToken, 'retained-refresh');
    assert.equal(s.account('steam').key, 'new-api-key-123456789');
    assert.ok(synced);
    assert.doesNotMatch(JSON.stringify(s.config()), /retained-|new-api-key/);
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
    assert.equal(peak, 4);
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
  test('Missing statistics key stops promptly and keeps the QR library', async (t) => {
    const s = new TrophiesStore(temp(t));
    s.load();
    t.after(() => s.close());
    s.set('steam', {id: '76561198000000000', refreshToken: 'kept-token'});
    s.provider = () => ({
      close() {},
      library: async () => ({items: [{id: '1', title: 'Library game'}], awards: []}),
      game: async () => assert.fail('No unsupported statistics request'),
      reviews: async () => assert.fail('No lengthy store queue')
    });
    await s.sync('steam');
    assert.equal(s.snapshot().games.length, 1);
    assert.match(s.config().steam.error, /Web API key/);
    assert.equal(s.account('steam').refreshToken, 'kept-token');
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
  const {FlowSession} = await import('./02-hub/modules/chat/flow-session.mjs');
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
