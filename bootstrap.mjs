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
  "02-hub/modules/vpn/flags/ad.svg",
  "02-hub/modules/vpn/flags/ae.svg",
  "02-hub/modules/vpn/flags/af.svg",
  "02-hub/modules/vpn/flags/ag.svg",
  "02-hub/modules/vpn/flags/ai.svg",
  "02-hub/modules/vpn/flags/al.svg",
  "02-hub/modules/vpn/flags/am.svg",
  "02-hub/modules/vpn/flags/ao.svg",
  "02-hub/modules/vpn/flags/aq.svg",
  "02-hub/modules/vpn/flags/ar.svg",
  "02-hub/modules/vpn/flags/as.svg",
  "02-hub/modules/vpn/flags/at.svg",
  "02-hub/modules/vpn/flags/au.svg",
  "02-hub/modules/vpn/flags/aw.svg",
  "02-hub/modules/vpn/flags/ax.svg",
  "02-hub/modules/vpn/flags/az.svg",
  "02-hub/modules/vpn/flags/ba.svg",
  "02-hub/modules/vpn/flags/bb.svg",
  "02-hub/modules/vpn/flags/bd.svg",
  "02-hub/modules/vpn/flags/be.svg",
  "02-hub/modules/vpn/flags/bf.svg",
  "02-hub/modules/vpn/flags/bg.svg",
  "02-hub/modules/vpn/flags/bh.svg",
  "02-hub/modules/vpn/flags/bi.svg",
  "02-hub/modules/vpn/flags/bj.svg",
  "02-hub/modules/vpn/flags/bl.svg",
  "02-hub/modules/vpn/flags/bm.svg",
  "02-hub/modules/vpn/flags/bn.svg",
  "02-hub/modules/vpn/flags/bo.svg",
  "02-hub/modules/vpn/flags/bq.svg",
  "02-hub/modules/vpn/flags/br.svg",
  "02-hub/modules/vpn/flags/bs.svg",
  "02-hub/modules/vpn/flags/bt.svg",
  "02-hub/modules/vpn/flags/bv.svg",
  "02-hub/modules/vpn/flags/bw.svg",
  "02-hub/modules/vpn/flags/by.svg",
  "02-hub/modules/vpn/flags/bz.svg",
  "02-hub/modules/vpn/flags/ca.svg",
  "02-hub/modules/vpn/flags/cc.svg",
  "02-hub/modules/vpn/flags/cd.svg",
  "02-hub/modules/vpn/flags/cf.svg",
  "02-hub/modules/vpn/flags/cg.svg",
  "02-hub/modules/vpn/flags/ch.svg",
  "02-hub/modules/vpn/flags/ci.svg",
  "02-hub/modules/vpn/flags/ck.svg",
  "02-hub/modules/vpn/flags/cl.svg",
  "02-hub/modules/vpn/flags/cm.svg",
  "02-hub/modules/vpn/flags/cn.svg",
  "02-hub/modules/vpn/flags/co.svg",
  "02-hub/modules/vpn/flags/cr.svg",
  "02-hub/modules/vpn/flags/cu.svg",
  "02-hub/modules/vpn/flags/cv.svg",
  "02-hub/modules/vpn/flags/cw.svg",
  "02-hub/modules/vpn/flags/cx.svg",
  "02-hub/modules/vpn/flags/cy.svg",
  "02-hub/modules/vpn/flags/cz.svg",
  "02-hub/modules/vpn/flags/de.svg",
  "02-hub/modules/vpn/flags/dj.svg",
  "02-hub/modules/vpn/flags/dk.svg",
  "02-hub/modules/vpn/flags/dm.svg",
  "02-hub/modules/vpn/flags/do.svg",
  "02-hub/modules/vpn/flags/dz.svg",
  "02-hub/modules/vpn/flags/ec.svg",
  "02-hub/modules/vpn/flags/ee.svg",
  "02-hub/modules/vpn/flags/eg.svg",
  "02-hub/modules/vpn/flags/eh.svg",
  "02-hub/modules/vpn/flags/er.svg",
  "02-hub/modules/vpn/flags/es.svg",
  "02-hub/modules/vpn/flags/et.svg",
  "02-hub/modules/vpn/flags/fi.svg",
  "02-hub/modules/vpn/flags/fj.svg",
  "02-hub/modules/vpn/flags/fk.svg",
  "02-hub/modules/vpn/flags/fm.svg",
  "02-hub/modules/vpn/flags/fo.svg",
  "02-hub/modules/vpn/flags/fr.svg",
  "02-hub/modules/vpn/flags/ga.svg",
  "02-hub/modules/vpn/flags/gb.svg",
  "02-hub/modules/vpn/flags/gd.svg",
  "02-hub/modules/vpn/flags/ge.svg",
  "02-hub/modules/vpn/flags/gf.svg",
  "02-hub/modules/vpn/flags/gg.svg",
  "02-hub/modules/vpn/flags/gh.svg",
  "02-hub/modules/vpn/flags/gi.svg",
  "02-hub/modules/vpn/flags/gl.svg",
  "02-hub/modules/vpn/flags/gm.svg",
  "02-hub/modules/vpn/flags/gn.svg",
  "02-hub/modules/vpn/flags/gp.svg",
  "02-hub/modules/vpn/flags/gq.svg",
  "02-hub/modules/vpn/flags/gr.svg",
  "02-hub/modules/vpn/flags/gs.svg",
  "02-hub/modules/vpn/flags/gt.svg",
  "02-hub/modules/vpn/flags/gu.svg",
  "02-hub/modules/vpn/flags/gw.svg",
  "02-hub/modules/vpn/flags/gy.svg",
  "02-hub/modules/vpn/flags/hk.svg",
  "02-hub/modules/vpn/flags/hm.svg",
  "02-hub/modules/vpn/flags/hn.svg",
  "02-hub/modules/vpn/flags/hr.svg",
  "02-hub/modules/vpn/flags/ht.svg",
  "02-hub/modules/vpn/flags/hu.svg",
  "02-hub/modules/vpn/flags/id.svg",
  "02-hub/modules/vpn/flags/ie.svg",
  "02-hub/modules/vpn/flags/il.svg",
  "02-hub/modules/vpn/flags/im.svg",
  "02-hub/modules/vpn/flags/in.svg",
  "02-hub/modules/vpn/flags/io.svg",
  "02-hub/modules/vpn/flags/iq.svg",
  "02-hub/modules/vpn/flags/ir.svg",
  "02-hub/modules/vpn/flags/is.svg",
  "02-hub/modules/vpn/flags/it.svg",
  "02-hub/modules/vpn/flags/je.svg",
  "02-hub/modules/vpn/flags/jm.svg",
  "02-hub/modules/vpn/flags/jo.svg",
  "02-hub/modules/vpn/flags/jp.svg",
  "02-hub/modules/vpn/flags/ke.svg",
  "02-hub/modules/vpn/flags/kg.svg",
  "02-hub/modules/vpn/flags/kh.svg",
  "02-hub/modules/vpn/flags/ki.svg",
  "02-hub/modules/vpn/flags/km.svg",
  "02-hub/modules/vpn/flags/kn.svg",
  "02-hub/modules/vpn/flags/kp.svg",
  "02-hub/modules/vpn/flags/kr.svg",
  "02-hub/modules/vpn/flags/kw.svg",
  "02-hub/modules/vpn/flags/ky.svg",
  "02-hub/modules/vpn/flags/kz.svg",
  "02-hub/modules/vpn/flags/la.svg",
  "02-hub/modules/vpn/flags/lb.svg",
  "02-hub/modules/vpn/flags/lc.svg",
  "02-hub/modules/vpn/flags/li.svg",
  "02-hub/modules/vpn/flags/lk.svg",
  "02-hub/modules/vpn/flags/lr.svg",
  "02-hub/modules/vpn/flags/ls.svg",
  "02-hub/modules/vpn/flags/lt.svg",
  "02-hub/modules/vpn/flags/lu.svg",
  "02-hub/modules/vpn/flags/lv.svg",
  "02-hub/modules/vpn/flags/ly.svg",
  "02-hub/modules/vpn/flags/ma.svg",
  "02-hub/modules/vpn/flags/mc.svg",
  "02-hub/modules/vpn/flags/md.svg",
  "02-hub/modules/vpn/flags/me.svg",
  "02-hub/modules/vpn/flags/mf.svg",
  "02-hub/modules/vpn/flags/mg.svg",
  "02-hub/modules/vpn/flags/mh.svg",
  "02-hub/modules/vpn/flags/mk.svg",
  "02-hub/modules/vpn/flags/ml.svg",
  "02-hub/modules/vpn/flags/mm.svg",
  "02-hub/modules/vpn/flags/mn.svg",
  "02-hub/modules/vpn/flags/mo.svg",
  "02-hub/modules/vpn/flags/mp.svg",
  "02-hub/modules/vpn/flags/mq.svg",
  "02-hub/modules/vpn/flags/mr.svg",
  "02-hub/modules/vpn/flags/ms.svg",
  "02-hub/modules/vpn/flags/mt.svg",
  "02-hub/modules/vpn/flags/mu.svg",
  "02-hub/modules/vpn/flags/mv.svg",
  "02-hub/modules/vpn/flags/mw.svg",
  "02-hub/modules/vpn/flags/mx.svg",
  "02-hub/modules/vpn/flags/my.svg",
  "02-hub/modules/vpn/flags/mz.svg",
  "02-hub/modules/vpn/flags/na.svg",
  "02-hub/modules/vpn/flags/nc.svg",
  "02-hub/modules/vpn/flags/ne.svg",
  "02-hub/modules/vpn/flags/nf.svg",
  "02-hub/modules/vpn/flags/ng.svg",
  "02-hub/modules/vpn/flags/ni.svg",
  "02-hub/modules/vpn/flags/nl.svg",
  "02-hub/modules/vpn/flags/no.svg",
  "02-hub/modules/vpn/flags/np.svg",
  "02-hub/modules/vpn/flags/nr.svg",
  "02-hub/modules/vpn/flags/nu.svg",
  "02-hub/modules/vpn/flags/nz.svg",
  "02-hub/modules/vpn/flags/om.svg",
  "02-hub/modules/vpn/flags/pa.svg",
  "02-hub/modules/vpn/flags/pe.svg",
  "02-hub/modules/vpn/flags/pf.svg",
  "02-hub/modules/vpn/flags/pg.svg",
  "02-hub/modules/vpn/flags/ph.svg",
  "02-hub/modules/vpn/flags/pk.svg",
  "02-hub/modules/vpn/flags/pl.svg",
  "02-hub/modules/vpn/flags/pm.svg",
  "02-hub/modules/vpn/flags/pn.svg",
  "02-hub/modules/vpn/flags/pr.svg",
  "02-hub/modules/vpn/flags/ps.svg",
  "02-hub/modules/vpn/flags/pt.svg",
  "02-hub/modules/vpn/flags/pw.svg",
  "02-hub/modules/vpn/flags/py.svg",
  "02-hub/modules/vpn/flags/qa.svg",
  "02-hub/modules/vpn/flags/re.svg",
  "02-hub/modules/vpn/flags/ro.svg",
  "02-hub/modules/vpn/flags/rs.svg",
  "02-hub/modules/vpn/flags/ru.svg",
  "02-hub/modules/vpn/flags/rw.svg",
  "02-hub/modules/vpn/flags/sa.svg",
  "02-hub/modules/vpn/flags/sb.svg",
  "02-hub/modules/vpn/flags/sc.svg",
  "02-hub/modules/vpn/flags/sd.svg",
  "02-hub/modules/vpn/flags/se.svg",
  "02-hub/modules/vpn/flags/sg.svg",
  "02-hub/modules/vpn/flags/sh.svg",
  "02-hub/modules/vpn/flags/si.svg",
  "02-hub/modules/vpn/flags/sj.svg",
  "02-hub/modules/vpn/flags/sk.svg",
  "02-hub/modules/vpn/flags/sl.svg",
  "02-hub/modules/vpn/flags/sm.svg",
  "02-hub/modules/vpn/flags/sn.svg",
  "02-hub/modules/vpn/flags/so.svg",
  "02-hub/modules/vpn/flags/sr.svg",
  "02-hub/modules/vpn/flags/ss.svg",
  "02-hub/modules/vpn/flags/st.svg",
  "02-hub/modules/vpn/flags/sv.svg",
  "02-hub/modules/vpn/flags/sx.svg",
  "02-hub/modules/vpn/flags/sy.svg",
  "02-hub/modules/vpn/flags/sz.svg",
  "02-hub/modules/vpn/flags/tc.svg",
  "02-hub/modules/vpn/flags/td.svg",
  "02-hub/modules/vpn/flags/tf.svg",
  "02-hub/modules/vpn/flags/tg.svg",
  "02-hub/modules/vpn/flags/th.svg",
  "02-hub/modules/vpn/flags/tj.svg",
  "02-hub/modules/vpn/flags/tk.svg",
  "02-hub/modules/vpn/flags/tl.svg",
  "02-hub/modules/vpn/flags/tm.svg",
  "02-hub/modules/vpn/flags/tn.svg",
  "02-hub/modules/vpn/flags/to.svg",
  "02-hub/modules/vpn/flags/tr.svg",
  "02-hub/modules/vpn/flags/tt.svg",
  "02-hub/modules/vpn/flags/tv.svg",
  "02-hub/modules/vpn/flags/tw.svg",
  "02-hub/modules/vpn/flags/tz.svg",
  "02-hub/modules/vpn/flags/ua.svg",
  "02-hub/modules/vpn/flags/ug.svg",
  "02-hub/modules/vpn/flags/um.svg",
  "02-hub/modules/vpn/flags/us.svg",
  "02-hub/modules/vpn/flags/uy.svg",
  "02-hub/modules/vpn/flags/uz.svg",
  "02-hub/modules/vpn/flags/va.svg",
  "02-hub/modules/vpn/flags/vc.svg",
  "02-hub/modules/vpn/flags/ve.svg",
  "02-hub/modules/vpn/flags/vg.svg",
  "02-hub/modules/vpn/flags/vi.svg",
  "02-hub/modules/vpn/flags/vn.svg",
  "02-hub/modules/vpn/flags/vu.svg",
  "02-hub/modules/vpn/flags/wf.svg",
  "02-hub/modules/vpn/flags/ws.svg",
  "02-hub/modules/vpn/flags/ye.svg",
  "02-hub/modules/vpn/flags/yt.svg",
  "02-hub/modules/vpn/flags/za.svg",
  "02-hub/modules/vpn/flags/zm.svg",
  "02-hub/modules/vpn/flags/zw.svg",
  "02-hub/modules/vpn/flags/LICENSE.txt",
  "02-hub/src/vpn-protocol.mjs",
  "host/vpn-node.mjs",
  "host/vpn-diagnose.mjs",
  "host/vpn-install.mjs",
  "host/vpn-acme.mjs",
  "host/vpn-cert.mjs",
  "02-hub/modules/vpn/app.js",
  "02-hub/modules/vpn/routing-fields.js",
  "02-hub/modules/vpn/countries.mjs",
  "02-hub/modules/vpn/country-picker.js",
  "02-hub/modules/vpn/index.mjs",
  "02-hub/modules/vpn/manifest.json",
  "02-hub/modules/vpn/qr.mjs",
  "02-hub/modules/vpn/store.mjs",
  "02-hub/modules/vpn/style.css",
  "02-hub/modules/vpn/subscriptions.mjs",
  "02-hub/modules/vpn/xray-client.mjs",
  '02-hub/src/agent-protocol.mjs',
  '02-hub/src/agents.mjs',
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
  '02-hub/modules/anime/anime.css',
  '02-hub/modules/anime/anime.js',
  '02-hub/modules/anime/index.mjs',
  '02-hub/modules/anime/manifest.json',
  '02-hub/modules/anime/store.mjs',
  '02-hub/modules/articles/index.mjs',
  '02-hub/modules/articles/manifest.json',
  '02-hub/modules/balance/balance.css',
  '02-hub/modules/balance/balance.js',
  '02-hub/modules/balance/bank.js',
  '02-hub/modules/balance/bank.mjs',
  '02-hub/modules/balance/companion.apk',
  '02-hub/modules/balance/companion.json',
  '02-hub/modules/balance/index.mjs',
  '02-hub/modules/balance/manifest.json',
  '02-hub/modules/balance/market.mjs',
  '02-hub/modules/balance/store.mjs',
  '02-hub/modules/chat/chat.css',
  '02-hub/modules/chat/chat.js',
  '02-hub/modules/chat/flow-audio.mjs',
  '02-hub/modules/chat/flow-session.mjs',
  '02-hub/modules/chat/flowmusic.mjs',
  '02-hub/modules/chat/index.mjs',
  '02-hub/modules/chat/manifest.json',
  '02-hub/modules/chat/store.mjs',
  '02-hub/modules/cinema/cinema.css',
  '02-hub/modules/cinema/cinema.js',
  '02-hub/modules/cinema/index.mjs',
  '02-hub/modules/cinema/manifest.json',
  '02-hub/modules/cinema/store.mjs',
  '02-hub/modules/gallery/index.mjs',
  '02-hub/modules/gallery/manifest.json',
  '02-hub/modules/kanban/index.mjs',
  '02-hub/modules/kanban/kanban.css',
  '02-hub/modules/kanban/kanban.js',
  '02-hub/modules/kanban/manifest.json',
  '02-hub/modules/kanban/store.mjs',
  '02-hub/modules/projects/index.mjs',
  '02-hub/modules/projects/manifest.json',
  '02-hub/modules/projects/projects.css',
  '02-hub/modules/projects/projects.js',
  '02-hub/modules/projects/store.mjs',
  '02-hub/modules/projects/zip.mjs',
  '02-hub/modules/pulse/index.mjs',
  '02-hub/modules/pulse/history.mjs',
  '02-hub/modules/pulse/manifest.json',
  '02-hub/modules/pulse/pulse.css',
  '02-hub/modules/pulse/pulse.js',
  '02-hub/modules/reader/engine.js',
  '02-hub/modules/reader/index.mjs',
  '02-hub/modules/reader/manifest.json',
  '02-hub/modules/reader/parse.mjs',
  '02-hub/modules/reader/reader.css',
  '02-hub/modules/reader/reader.js',
  '02-hub/modules/reader/store.mjs',
  '02-hub/modules/rhythm/analysis.mjs',
  '02-hub/modules/rhythm/index.mjs',
  '02-hub/modules/rhythm/manifest.json',
  '02-hub/modules/rhythm/refresh.mjs',
  '02-hub/modules/rhythm/reports.mjs',
  '02-hub/modules/rhythm/rhythm.css',
  '02-hub/modules/rhythm/rhythm.js',
  '02-hub/modules/rhythm/store.mjs',
  '02-hub/modules/rhythm/summary.mjs',
  '02-hub/modules/rhythm/wake.mjs',
  '02-hub/modules/signal/index.mjs',
  '02-hub/modules/signal/manifest.json',
  '02-hub/modules/signal/phone.mjs',
  '02-hub/modules/signal/signal.css',
  '02-hub/modules/signal/signal.js',
  '02-hub/modules/statistics/index.mjs',
  '02-hub/modules/statistics/manifest.json',
  '02-hub/modules/storage/index.mjs',
  '02-hub/modules/storage/manifest.json',
  '02-hub/modules/storage/phone.mjs',
  '02-hub/modules/storage/storage.css',
  '02-hub/modules/storage/storage.js',
  '02-hub/modules/storage/store.mjs',
  '02-hub/modules/trophies/index.mjs',
  '02-hub/modules/trophies/manifest.json',
  '02-hub/modules/trophies/providers.mjs',
  '02-hub/modules/trophies/store.mjs',
  '02-hub/modules/trophies/trophies.css',
  '02-hub/modules/trophies/trophies.js',
  '02-hub/modules/wave/catalog.mjs',
  '02-hub/modules/wave/index.mjs',
  '02-hub/modules/wave/manifest.json',
  '02-hub/modules/wave/phone.mjs',
  '02-hub/modules/wave/player.js',
  '02-hub/modules/wave/store.mjs',
  '02-hub/modules/wave/wave.css',
  '02-hub/modules/wave/wave.js',
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
  '03-modules/pulse/docker-compose.override.yml',
  '03-modules/pulse/nexus404-pulse.service',
  '03-modules/signal/nexus404-signal.service',
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
