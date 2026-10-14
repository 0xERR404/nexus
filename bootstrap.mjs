import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function options(args) {
  const result = {
    repo: '0xERR404/nexus',
    branch: 'main',
    directory: '/opt/nexus404-repo',
    menu: []
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      result.menu = args.slice(i + 1);
      break;
    }
    const key = {'--repo': 'repo', '--branch': 'branch', '--directory': 'directory'}[args[i]];
    if (!key || !args[i + 1]) throw new Error('Неизвестный или неполный параметр: ' + args[i]);
    result[key] = args[++i];
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(result.repo) ||
    /\/(\.|\.\.)$/.test(result.repo)
  )
    throw new Error('Репозиторий: OWNER/REPO, без URL и токенов');
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(result.branch) ||
    result.branch.includes('..') ||
    result.branch.includes('//')
  )
    throw new Error('Некорректная ветка');
  if (!path.isAbsolute(result.directory) || path.resolve(result.directory) === '/')
    throw new Error('Нужен абсолютный каталог проекта, отличный от /');
  result.directory = path.resolve(result.directory);
  result.url = 'https://github.com/' + result.repo + '.git';
  return result;
}

export function git(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
    env: {...process.env, GIT_TERMINAL_PROMPT: '0'}
  });
  if (result.status !== 0)
    throw new Error(result.error?.message || result.stderr?.trim() || 'Git завершился с ошибкой');
  return result.stdout.trim();
}
const sameRemote = (a, b) =>
  a.replace(/\.git\/?$/, '').replace(/\/$/, '') === b.replace(/\.git\/?$/, '').replace(/\/$/, '');
export const projectFiles = [
  'README.md',
  'CHANGELOG.md',
  'package.json',
  'package-lock.json',
  "03-modules/vpn/flags/ad.svg",
  "03-modules/vpn/flags/ae.svg",
  "03-modules/vpn/flags/af.svg",
  "03-modules/vpn/flags/ag.svg",
  "03-modules/vpn/flags/ai.svg",
  "03-modules/vpn/flags/al.svg",
  "03-modules/vpn/flags/am.svg",
  "03-modules/vpn/flags/ao.svg",
  "03-modules/vpn/flags/aq.svg",
  "03-modules/vpn/flags/ar.svg",
  "03-modules/vpn/flags/as.svg",
  "03-modules/vpn/flags/at.svg",
  "03-modules/vpn/flags/au.svg",
  "03-modules/vpn/flags/aw.svg",
  "03-modules/vpn/flags/ax.svg",
  "03-modules/vpn/flags/az.svg",
  "03-modules/vpn/flags/ba.svg",
  "03-modules/vpn/flags/bb.svg",
  "03-modules/vpn/flags/bd.svg",
  "03-modules/vpn/flags/be.svg",
  "03-modules/vpn/flags/bf.svg",
  "03-modules/vpn/flags/bg.svg",
  "03-modules/vpn/flags/bh.svg",
  "03-modules/vpn/flags/bi.svg",
  "03-modules/vpn/flags/bj.svg",
  "03-modules/vpn/flags/bl.svg",
  "03-modules/vpn/flags/bm.svg",
  "03-modules/vpn/flags/bn.svg",
  "03-modules/vpn/flags/bo.svg",
  "03-modules/vpn/flags/bq.svg",
  "03-modules/vpn/flags/br.svg",
  "03-modules/vpn/flags/bs.svg",
  "03-modules/vpn/flags/bt.svg",
  "03-modules/vpn/flags/bv.svg",
  "03-modules/vpn/flags/bw.svg",
  "03-modules/vpn/flags/by.svg",
  "03-modules/vpn/flags/bz.svg",
  "03-modules/vpn/flags/ca.svg",
  "03-modules/vpn/flags/cc.svg",
  "03-modules/vpn/flags/cd.svg",
  "03-modules/vpn/flags/cf.svg",
  "03-modules/vpn/flags/cg.svg",
  "03-modules/vpn/flags/ch.svg",
  "03-modules/vpn/flags/ci.svg",
  "03-modules/vpn/flags/ck.svg",
  "03-modules/vpn/flags/cl.svg",
  "03-modules/vpn/flags/cm.svg",
  "03-modules/vpn/flags/cn.svg",
  "03-modules/vpn/flags/co.svg",
  "03-modules/vpn/flags/cr.svg",
  "03-modules/vpn/flags/cu.svg",
  "03-modules/vpn/flags/cv.svg",
  "03-modules/vpn/flags/cw.svg",
  "03-modules/vpn/flags/cx.svg",
  "03-modules/vpn/flags/cy.svg",
  "03-modules/vpn/flags/cz.svg",
  "03-modules/vpn/flags/de.svg",
  "03-modules/vpn/flags/dj.svg",
  "03-modules/vpn/flags/dk.svg",
  "03-modules/vpn/flags/dm.svg",
  "03-modules/vpn/flags/do.svg",
  "03-modules/vpn/flags/dz.svg",
  "03-modules/vpn/flags/ec.svg",
  "03-modules/vpn/flags/ee.svg",
  "03-modules/vpn/flags/eg.svg",
  "03-modules/vpn/flags/eh.svg",
  "03-modules/vpn/flags/er.svg",
  "03-modules/vpn/flags/es.svg",
  "03-modules/vpn/flags/et.svg",
  "03-modules/vpn/flags/fi.svg",
  "03-modules/vpn/flags/fj.svg",
  "03-modules/vpn/flags/fk.svg",
  "03-modules/vpn/flags/fm.svg",
  "03-modules/vpn/flags/fo.svg",
  "03-modules/vpn/flags/fr.svg",
  "03-modules/vpn/flags/ga.svg",
  "03-modules/vpn/flags/gb.svg",
  "03-modules/vpn/flags/gd.svg",
  "03-modules/vpn/flags/ge.svg",
  "03-modules/vpn/flags/gf.svg",
  "03-modules/vpn/flags/gg.svg",
  "03-modules/vpn/flags/gh.svg",
  "03-modules/vpn/flags/gi.svg",
  "03-modules/vpn/flags/gl.svg",
  "03-modules/vpn/flags/gm.svg",
  "03-modules/vpn/flags/gn.svg",
  "03-modules/vpn/flags/gp.svg",
  "03-modules/vpn/flags/gq.svg",
  "03-modules/vpn/flags/gr.svg",
  "03-modules/vpn/flags/gs.svg",
  "03-modules/vpn/flags/gt.svg",
  "03-modules/vpn/flags/gu.svg",
  "03-modules/vpn/flags/gw.svg",
  "03-modules/vpn/flags/gy.svg",
  "03-modules/vpn/flags/hk.svg",
  "03-modules/vpn/flags/hm.svg",
  "03-modules/vpn/flags/hn.svg",
  "03-modules/vpn/flags/hr.svg",
  "03-modules/vpn/flags/ht.svg",
  "03-modules/vpn/flags/hu.svg",
  "03-modules/vpn/flags/id.svg",
  "03-modules/vpn/flags/ie.svg",
  "03-modules/vpn/flags/il.svg",
  "03-modules/vpn/flags/im.svg",
  "03-modules/vpn/flags/in.svg",
  "03-modules/vpn/flags/io.svg",
  "03-modules/vpn/flags/iq.svg",
  "03-modules/vpn/flags/ir.svg",
  "03-modules/vpn/flags/is.svg",
  "03-modules/vpn/flags/it.svg",
  "03-modules/vpn/flags/je.svg",
  "03-modules/vpn/flags/jm.svg",
  "03-modules/vpn/flags/jo.svg",
  "03-modules/vpn/flags/jp.svg",
  "03-modules/vpn/flags/ke.svg",
  "03-modules/vpn/flags/kg.svg",
  "03-modules/vpn/flags/kh.svg",
  "03-modules/vpn/flags/ki.svg",
  "03-modules/vpn/flags/km.svg",
  "03-modules/vpn/flags/kn.svg",
  "03-modules/vpn/flags/kp.svg",
  "03-modules/vpn/flags/kr.svg",
  "03-modules/vpn/flags/kw.svg",
  "03-modules/vpn/flags/ky.svg",
  "03-modules/vpn/flags/kz.svg",
  "03-modules/vpn/flags/la.svg",
  "03-modules/vpn/flags/lb.svg",
  "03-modules/vpn/flags/lc.svg",
  "03-modules/vpn/flags/li.svg",
  "03-modules/vpn/flags/lk.svg",
  "03-modules/vpn/flags/lr.svg",
  "03-modules/vpn/flags/ls.svg",
  "03-modules/vpn/flags/lt.svg",
  "03-modules/vpn/flags/lu.svg",
  "03-modules/vpn/flags/lv.svg",
  "03-modules/vpn/flags/ly.svg",
  "03-modules/vpn/flags/ma.svg",
  "03-modules/vpn/flags/mc.svg",
  "03-modules/vpn/flags/md.svg",
  "03-modules/vpn/flags/me.svg",
  "03-modules/vpn/flags/mf.svg",
  "03-modules/vpn/flags/mg.svg",
  "03-modules/vpn/flags/mh.svg",
  "03-modules/vpn/flags/mk.svg",
  "03-modules/vpn/flags/ml.svg",
  "03-modules/vpn/flags/mm.svg",
  "03-modules/vpn/flags/mn.svg",
  "03-modules/vpn/flags/mo.svg",
  "03-modules/vpn/flags/mp.svg",
  "03-modules/vpn/flags/mq.svg",
  "03-modules/vpn/flags/mr.svg",
  "03-modules/vpn/flags/ms.svg",
  "03-modules/vpn/flags/mt.svg",
  "03-modules/vpn/flags/mu.svg",
  "03-modules/vpn/flags/mv.svg",
  "03-modules/vpn/flags/mw.svg",
  "03-modules/vpn/flags/mx.svg",
  "03-modules/vpn/flags/my.svg",
  "03-modules/vpn/flags/mz.svg",
  "03-modules/vpn/flags/na.svg",
  "03-modules/vpn/flags/nc.svg",
  "03-modules/vpn/flags/ne.svg",
  "03-modules/vpn/flags/nf.svg",
  "03-modules/vpn/flags/ng.svg",
  "03-modules/vpn/flags/ni.svg",
  "03-modules/vpn/flags/nl.svg",
  "03-modules/vpn/flags/no.svg",
  "03-modules/vpn/flags/np.svg",
  "03-modules/vpn/flags/nr.svg",
  "03-modules/vpn/flags/nu.svg",
  "03-modules/vpn/flags/nz.svg",
  "03-modules/vpn/flags/om.svg",
  "03-modules/vpn/flags/pa.svg",
  "03-modules/vpn/flags/pe.svg",
  "03-modules/vpn/flags/pf.svg",
  "03-modules/vpn/flags/pg.svg",
  "03-modules/vpn/flags/ph.svg",
  "03-modules/vpn/flags/pk.svg",
  "03-modules/vpn/flags/pl.svg",
  "03-modules/vpn/flags/pm.svg",
  "03-modules/vpn/flags/pn.svg",
  "03-modules/vpn/flags/pr.svg",
  "03-modules/vpn/flags/ps.svg",
  "03-modules/vpn/flags/pt.svg",
  "03-modules/vpn/flags/pw.svg",
  "03-modules/vpn/flags/py.svg",
  "03-modules/vpn/flags/qa.svg",
  "03-modules/vpn/flags/re.svg",
  "03-modules/vpn/flags/ro.svg",
  "03-modules/vpn/flags/rs.svg",
  "03-modules/vpn/flags/ru.svg",
  "03-modules/vpn/flags/rw.svg",
  "03-modules/vpn/flags/sa.svg",
  "03-modules/vpn/flags/sb.svg",
  "03-modules/vpn/flags/sc.svg",
  "03-modules/vpn/flags/sd.svg",
  "03-modules/vpn/flags/se.svg",
  "03-modules/vpn/flags/sg.svg",
  "03-modules/vpn/flags/sh.svg",
  "03-modules/vpn/flags/si.svg",
  "03-modules/vpn/flags/sj.svg",
  "03-modules/vpn/flags/sk.svg",
  "03-modules/vpn/flags/sl.svg",
  "03-modules/vpn/flags/sm.svg",
  "03-modules/vpn/flags/sn.svg",
  "03-modules/vpn/flags/so.svg",
  "03-modules/vpn/flags/sr.svg",
  "03-modules/vpn/flags/ss.svg",
  "03-modules/vpn/flags/st.svg",
  "03-modules/vpn/flags/sv.svg",
  "03-modules/vpn/flags/sx.svg",
  "03-modules/vpn/flags/sy.svg",
  "03-modules/vpn/flags/sz.svg",
  "03-modules/vpn/flags/tc.svg",
  "03-modules/vpn/flags/td.svg",
  "03-modules/vpn/flags/tf.svg",
  "03-modules/vpn/flags/tg.svg",
  "03-modules/vpn/flags/th.svg",
  "03-modules/vpn/flags/tj.svg",
  "03-modules/vpn/flags/tk.svg",
  "03-modules/vpn/flags/tl.svg",
  "03-modules/vpn/flags/tm.svg",
  "03-modules/vpn/flags/tn.svg",
  "03-modules/vpn/flags/to.svg",
  "03-modules/vpn/flags/tr.svg",
  "03-modules/vpn/flags/tt.svg",
  "03-modules/vpn/flags/tv.svg",
  "03-modules/vpn/flags/tw.svg",
  "03-modules/vpn/flags/tz.svg",
  "03-modules/vpn/flags/ua.svg",
  "03-modules/vpn/flags/ug.svg",
  "03-modules/vpn/flags/um.svg",
  "03-modules/vpn/flags/us.svg",
  "03-modules/vpn/flags/uy.svg",
  "03-modules/vpn/flags/uz.svg",
  "03-modules/vpn/flags/va.svg",
  "03-modules/vpn/flags/vc.svg",
  "03-modules/vpn/flags/ve.svg",
  "03-modules/vpn/flags/vg.svg",
  "03-modules/vpn/flags/vi.svg",
  "03-modules/vpn/flags/vn.svg",
  "03-modules/vpn/flags/vu.svg",
  "03-modules/vpn/flags/wf.svg",
  "03-modules/vpn/flags/ws.svg",
  "03-modules/vpn/flags/ye.svg",
  "03-modules/vpn/flags/yt.svg",
  "03-modules/vpn/flags/za.svg",
  "03-modules/vpn/flags/zm.svg",
  "03-modules/vpn/flags/zw.svg",
  "03-modules/vpn/flags/LICENSE.txt",
  "02-hub/src/vpn-protocol.mjs",
  "02-hub/src/vpn-hysteria.mjs",
  "02-hub/src/vpn-transport.mjs",
  "03-modules/vpn/hysteria-fields.js",
  "host/vpn-ports.mjs",
  "host/vpn-node.mjs",
  "host/vpn-network.mjs",
  "host/vpn-diagnose.mjs",
  "host/vpn-install.mjs",
  "host/vpn-acme.mjs",
  "host/vpn-cert.mjs",
  "03-modules/vpn/app.js",
  "03-modules/vpn/cloudflare-fields.js",
  "03-modules/vpn/diagnostics.mjs",
  "03-modules/vpn/diagnostics.js",
  "03-modules/vpn/diagnostic-stats.js",
  "03-modules/vpn/routing-fields.js",
  "03-modules/vpn/countries.mjs",
  "03-modules/vpn/country-picker.js",
  "03-modules/vpn/index.mjs",
  "03-modules/vpn/manifest.json",
  "03-modules/vpn/qr.mjs",
  "03-modules/vpn/store.mjs",
  "03-modules/vpn/style.css",
  "03-modules/vpn/subscriptions.mjs",
  "03-modules/vpn/xray-client.mjs",
  '02-hub/src/agent-protocol.mjs',
  '02-hub/src/agents.mjs',
  '02-hub/src/diagnostics.mjs',
  '02-hub/public/servers.css',
  '02-hub/public/servers.js',
  'host/agent.mjs',
  'host/agent-control.mjs',
  'host/agent-jobs.mjs',
  'host/agent-install.mjs',
  'host/agent-http.mjs',
  'host/remote-install.mjs',
  'host/event-reader.mjs',

  '02-hub/public/card-layout.css',
  '02-hub/public/settings.css',
  '02-hub/public/settings.js',
  '02-hub/public/backgrounds/code-reference.webp',
  '02-hub/public/backgrounds/network-reference.webp',
  '02-hub/public/backgrounds/scanner-reference.webp',

  '01-caddy-docker/docker-compose.yml',
  '02-hub/Dockerfile',
  '02-hub/docker-compose.yml',
  '03-modules/anime/anime.css',
  '03-modules/anime/anime.js',
  '03-modules/anime/index.mjs',
  '03-modules/anime/manifest.json',
  '03-modules/anime/store.mjs',
  '03-modules/articles/index.mjs',
  '03-modules/articles/manifest.json',
  '03-modules/balance/balance.css',
  '03-modules/balance/balance.js',
  '03-modules/balance/bank.js',
  '03-modules/balance/bank.mjs',
  '03-modules/balance/companion.apk',
  '03-modules/balance/companion.json',
  '03-modules/balance/index.mjs',
  '03-modules/balance/manifest.json',
  '03-modules/balance/market.mjs',
  '03-modules/balance/store.mjs',
  '03-modules/chat/chat.css',
  '03-modules/chat/chat.js',
  '03-modules/chat/flow-audio.mjs',
  '03-modules/chat/flow-session.mjs',
  '03-modules/chat/flowmusic.mjs',
  '03-modules/chat/index.mjs',
  '03-modules/chat/manifest.json',
  '03-modules/chat/store.mjs',
  '03-modules/cinema/cinema.css',
  '03-modules/cinema/cinema.js',
  '03-modules/cinema/index.mjs',
  '03-modules/cinema/manifest.json',
  '03-modules/cinema/store.mjs',
  '03-modules/gallery/index.mjs',
  '03-modules/gallery/manifest.json',
  '03-modules/kanban/index.mjs',
  '03-modules/kanban/archive.mjs',
  '03-modules/kanban/kanban.css',
  '03-modules/kanban/kanban.js',
  '03-modules/kanban/manifest.json',
  '03-modules/kanban/store.mjs',
  '03-modules/projects/index.mjs',
  '03-modules/projects/manifest.json',
  '03-modules/projects/projects.css',
  '03-modules/projects/projects.js',
  '03-modules/projects/store.mjs',
  '03-modules/projects/zip.mjs',
  '03-modules/pulse/index.mjs',
  '03-modules/pulse/history.mjs',
  '03-modules/pulse/manifest.json',
  '03-modules/pulse/pulse.css',
  '03-modules/pulse/pulse.js',
  '03-modules/reader/engine.js',
  '03-modules/reader/index.mjs',
  '03-modules/reader/manifest.json',
  '03-modules/reader/parse.mjs',
  '03-modules/reader/reader.css',
  '03-modules/reader/reader.js',
  '03-modules/reader/store.mjs',
  '03-modules/rhythm/analysis.mjs',
  '03-modules/rhythm/index.mjs',
  '03-modules/rhythm/manifest.json',
  '03-modules/rhythm/refresh.mjs',
  '03-modules/rhythm/reports.mjs',
  '03-modules/rhythm/rhythm.css',
  '03-modules/rhythm/rhythm.js',
  '03-modules/rhythm/store.mjs',
  '03-modules/rhythm/summary.mjs',
  '03-modules/rhythm/wake.mjs',
  '03-modules/signal/index.mjs',
  '03-modules/signal/manifest.json',
  '03-modules/signal/phone.mjs',
  '03-modules/signal/signal.css',
  '03-modules/signal/signal.js',
  '03-modules/statistics/index.mjs',
  '03-modules/statistics/manifest.json',
  '03-modules/storage/index.mjs',
  '03-modules/storage/manifest.json',
  '03-modules/storage/phone.mjs',
  '03-modules/storage/storage.css',
  '03-modules/storage/storage.js',
  '03-modules/storage/store.mjs',
  '03-modules/trophies/index.mjs',
  '03-modules/trophies/manifest.json',
  '03-modules/trophies/providers.mjs',
  '03-modules/trophies/store.mjs',
  '03-modules/trophies/trophies.css',
  '03-modules/trophies/trophies.js',
  '03-modules/wave/catalog.mjs',
  '03-modules/wave/index.mjs',
  '03-modules/wave/manifest.json',
  '03-modules/wave/phone.mjs',
  '03-modules/wave/player.js',
  '03-modules/wave/store.mjs',
  '03-modules/wave/wave.css',
  '03-modules/wave/wave.js',
  '02-hub/package-lock.json',
  '02-hub/package.json',
  '02-hub/public/activity-views.js',
  '02-hub/public/activity.css',
  '02-hub/public/activity.js',
  '02-hub/public/app.css',
  '02-hub/public/app.js',
  '02-hub/public/apple-touch-icon.png',
  '02-hub/public/content.css',
  '02-hub/public/content.js',
  '02-hub/public/markdown-edit.js',
  '02-hub/public/fonts/JetBrainsMono-LICENSE.txt',
  '02-hub/public/fonts/SpaceGrotesk-LICENSE.txt',
  '02-hub/public/fonts/jetbrains-mono.woff2',
  '02-hub/public/fonts/space-grotesk.woff2',
  '02-hub/public/icon-192.png',
  '02-hub/public/icon-512.png',
  '02-hub/public/icon.svg',
  '02-hub/public/intro-voice.mp3',
  '02-hub/public/intro.css',
  '02-hub/public/intro.js',
  '02-hub/public/legacy-clients.js',
  '02-hub/public/manifest.json',
  '02-hub/public/mark.svg',
  '02-hub/public/offline.html',
  '02-hub/public/overview.css',
  '02-hub/public/overview.js',
  '02-hub/public/workspace.css',
  '02-hub/public/workspace.js',
  '02-hub/public/appearance.js',
  '02-hub/public/pulse-history.js',
  '02-hub/public/install.js',
  '02-hub/public/home.js',
  '02-hub/public/performance.js',
  '02-hub/public/security.css',
  '02-hub/public/maintenance.js',
  '02-hub/public/maintenance.css',
  '02-hub/public/security.js',
  '02-hub/public/sw.js',
  '02-hub/public/ui.js',
  '02-hub/src/activity.mjs',
  '02-hub/src/ai-usage.mjs',
  '02-hub/src/auth.mjs',
  '02-hub/src/cache.mjs',
  '02-hub/src/companion.mjs',
  '02-hub/src/content-module.mjs',
  '02-hub/src/content-store.mjs',
  '02-hub/src/deepseek.mjs',
  '02-hub/src/input.mjs',
  '02-hub/src/modules.mjs',
  '02-hub/src/notices.mjs',
  '02-hub/src/overview-views.mjs',
  '02-hub/src/overview.mjs',
  '02-hub/src/passkeys.mjs',
  '02-hub/src/security.mjs',
  '02-hub/src/maintenance.mjs',
  '02-hub/src/maintenance-schema.mjs',
  '02-hub/src/server.mjs',
  '02-hub/src/vendor/marked.LICENSE.md',
  '02-hub/src/vendor/marked.mjs',
  '02-hub/src/views.mjs',
  '02-hub/src/groups.mjs',
  '02-hub/src/webpush.mjs',
  '03-modules/pulse/deploy/docker-compose.override.yml',
  '03-modules/pulse/deploy/nexus404-pulse.service',
  '03-modules/signal/deploy/nexus404-signal.service',
  'bootstrap.mjs',
  'host/base.mjs',
  'host/common.mjs',
  'host/events.mjs',
  'host/info.mjs',
  'host/maintenance-control.mjs',
  'host/maintenance.mjs',
  'host/metrics.mjs',
  'host/module-events.mjs',
  'host/platform.mjs',
  'host/runtime.mjs',
  'host/security.mjs',
  'host/signal-rules.mjs',
  'host/signal.mjs',
  'host/ssh.mjs',
  'host/ui.mjs',
  'host/webpush.mjs',
  'menu.mjs',
  'menu.sh',
  'tools/backup/backup-schedule.mjs',
  'tools/backup/backup.mjs',
  'tools/backup/restore-check.mjs',
  'tools/backup/restore-smoke.mjs'
];
export function checkRevision(directory, ref, run = git) {
  const entries = new Map(
    run(['-C', directory, 'ls-tree', '-r', ref])
      .split('\n')
      .map((row) => {
        const [meta, file] = row.split('\t');
        return [file, meta];
      })
  );
  for (const file of projectFiles)
    if (!/^100(?:644|755) blob /.test(entries.get(file) ?? ''))
      throw new Error('Неполное обновление: ' + file);
}
export function checkProject(directory) {
  for (const file of projectFiles) {
    const parts = file.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const stat = fs.lstatSync(path.join(directory, ...parts.slice(0, i)), {
        throwIfNoEntry: false
      });
      if (!(i === parts.length ? stat?.isFile() : stat?.isDirectory()))
        throw new Error('Неполный проект: ' + file + '. Загрузи весь архив в корень репозитория.');
    }
  }
}

export function syncRepository({url, branch, directory}, run = git) {
  run(['check-ref-format', '--branch', branch]);
  if (fs.lstatSync(directory, {throwIfNoEntry: false})) {
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.existsSync(path.join(directory, '.git')))
      throw new Error('Каталог занят и не является Git-копией: ' + directory);
    if (path.resolve(run(['-C', directory, 'rev-parse', '--show-toplevel'])) !== directory)
      throw new Error('Найден другой корень Git');
    const remote = run(['-C', directory, 'remote', 'get-url', 'origin']);
    if (!sameRemote(remote, url))
      throw new Error('В каталоге другой origin. Укажи отдельный NEXUS_DIRECTORY.');
    if (run(['-C', directory, 'status', '--porcelain']))
      throw new Error('Есть локальные изменения. Сохрани их коммитом перед обновлением.');
    if (run(['-C', directory, 'symbolic-ref', '--quiet', '--short', 'HEAD']) !== branch)
      throw new Error('В каталоге другая ветка. Выбери её явно или отдельный NEXUS_DIRECTORY.');
    run(['-C', directory, 'fetch', '--no-tags', 'origin', branch]);
    checkRevision(directory, 'FETCH_HEAD', run);
    run(['-C', directory, 'merge', '--ff-only', 'FETCH_HEAD']);
    checkProject(directory);
    return 'updated';
  }
  const parent = path.dirname(directory);
  fs.mkdirSync(parent, {recursive: true});
  const stage = fs.mkdtempSync(path.join(parent, '.nexus404-download-'));
  try {
    run(['clone', '--depth', '1', '--single-branch', '--branch', branch, '--', url, stage]);
    checkProject(stage);
    fs.chmodSync(stage, 0o755);
    fs.renameSync(stage, directory);
  } finally {
    fs.rmSync(stage, {recursive: true, force: true});
  }
  return 'cloned';
}

async function lock(file) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const child = spawn(
    'flock',
    [
      '-n',
      '-x',
      file,
      process.execPath,
      '-e',
      "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"
    ],
    {stdio: ['pipe', 'pipe', 'pipe']}
  );
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Установка или обновление уже выполняется.')));
    child.stdout.once('data', resolve);
  });
  return async () => {
    if (child.exitCode !== null) return;
    await new Promise((resolve) => {
      child.once('close', resolve);
      child.stdin.end();
    });
  };
}

export function launchMenu(directory, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(directory, 'menu.mjs'), ...args], {
      cwd: directory,
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
async function main() {
  const config = options(process.argv.slice(2));
  if (process.getuid?.() !== 0) throw new Error('Запусти загрузчик через sudo.');
  const release = await lock('/run/lock/nexus404-setup.lock');
  try {
    console.log('[*] GitHub: ' + config.repo + ' · ветка ' + config.branch);
    const result = syncRepository(config);
    console.log(
      '[✓] ' + (result === 'cloned' ? 'Проект загружен: ' : 'Проект обновлён: ') + config.directory
    );
  } finally {
    await release();
  }
  process.exitCode = await launchMenu(config.directory, config.menu);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error('[!] ' + error.message);
    process.exitCode = 1;
  });
