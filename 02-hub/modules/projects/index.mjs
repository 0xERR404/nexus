import {readJSON} from '../../src/input.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {modulePage} from '../../src/views.mjs';
import {Projects, fail} from './store.mjs';

const directory = path.join(process.env.DATA_DIR ?? '/app/data', 'projects');
export const projects = new Projects(directory);
const page = `<link rel="stylesheet" href="/modules/projects/projects.css"><script src="/modules/projects/projects.js" defer></script>
<section class="projects-app"><div class="projects-toolbar"><button id="projectNew">＋ Проект</button><input id="projectSearch" type="search" placeholder="Поиск проектов" aria-label="Поиск проектов"></div>
<p id="projectStatus" role="status"></p><div id="projectList"></div><section id="projectDetail" hidden><div class="projects-toolbar"><h2 id="projectTitle"></h2><button id="projectEdit" type="button">Изменить</button><button id="projectDelete" type="button">Удалить</button></div><p id="projectDescription"></p>
<div class="projects-toolbar"><label>Версия<input id="releaseVersion" maxlength="40" placeholder="1.0.0"></label><label>Изменения<textarea id="releaseNotes" maxlength="4000"></textarea></label><label class="projects-upload">＋ ZIP<input id="releaseFile" type="file" accept=".zip" hidden></label></div><p id="releaseProgress" role="status"></p>
<div class="projects-toolbar"><label>Выдаваемая версия<select id="selectedRelease"></select></label><label class="projects-toggle"><input id="installEnabled" type="checkbox"> Разрешить установку</label></div>
<div id="installAccess" hidden><p>Установочная ссылка</p><input id="installLink" readonly><p>Команда curl</p><textarea id="installCommand" readonly rows="2"></textarea><button id="copyInstall">Копировать команду</button><p id="releaseHash"></p></div>
<h3>Версии</h3><div id="releaseList"></div><h3>Журнал выдачи</h3><p class="muted">Передача файла не подтверждает успешную установку.</p><div id="deliveryList"></div></section></section>`;

export async function summary() {
  const all = projects.list();
  return {
    state: 'ok',
    items: [
      {label: 'Проектов', value: all.length},
      {label: 'Установка', value: all.filter((p) => p.enabled).length}
    ]
  };
}

export async function handle({
  request,
  path: route,
  user,
  searchParams,
  signal,
  authorized = () => true
}) {
  try {
    if (!authorized()) throw fail('Нужен вход', 401);
    if (['GET', 'HEAD'].includes(request.method)) {
      if (route === '/')
        return new Response(modulePage({embedded: user.embedded, username: user.username, title: 'Дедал', content: page}), {
          headers: {'Content-Type': 'text/html; charset=utf-8'}
        });
      if (route === '/projects.js' || route === '/projects.css')
        return new Response(fs.readFileSync(new URL('.' + route, import.meta.url)), {
          headers: {'Content-Type': route.endsWith('.js') ? 'text/javascript' : 'text/css'}
        });
      if (route === '/api') return Response.json(projects.list());
      const files = /^\/api\/([a-f0-9-]+)\/files\/([a-f0-9-]+)$/.exec(route);
      if (files) return Response.json(await projects.files(files[1], files[2]));
      const detail = /^\/api\/([a-f0-9-]+)$/.exec(route);
      if (detail) return Response.json(projects.detail(detail[1]));
    }
    if (request.method === 'POST') {
      const upload = /^\/api\/([a-f0-9-]+)\/upload$/.exec(route);
      if (upload) {
        const version = request.headers['x-release-version'];
        return Response.json(
          await projects.upload(
            request,
            upload[1],
            version,
            '',
            () => authorized() && !signal?.aborted
          ),
          {status: 201}
        );
      }
      const value = await readJSON(request);
      if (!authorized() || signal?.aborted) throw fail('Сессия завершена', 401);
      if (route === '/api')
        return Response.json(projects.create(value.name, value.description), {status: 201});
      const action = /^\/api\/([a-f0-9-]+)\/(select|access|notes|launch|edit|delete)$/.exec(route);
      if (action) {
        const id = action[1];
        if (action[2] === 'delete') return Response.json(projects.remove(id));
        if (action[2] === 'edit') projects.edit(id, value.name, value.description);
        if (action[2] === 'launch')
          await projects.launch(id, value.release, value.entrypoint, value.runner);
        if (action[2] === 'select') projects.select(id, value.release);
        if (action[2] === 'notes') projects.notes(id, value.release, value.notes);
        if (action[2] === 'access') projects.access(id, value.enabled);
        return Response.json(projects.detail(id));
      }
    }
    throw fail('Не найдено', 404);
  } catch (e) {
    return Response.json(
      {error: e.status ? e.message : 'Ошибка проектов'},
      {status: e.status ?? (e.code === 'ENOSPC' ? 507 : 500)}
    );
  }
}

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'"
};
export function publicHandle({token, action, method, origin}) {
  try {
    const {project, release} = projects.resolve(token);
    if (action === 'script') {
      if (method === 'GET') projects.log(project.id, release.version, 'script');
      const url = `${origin}/install/${token}/archive`;
      const entrypoint = release.entrypoint;
      if (!entrypoint) throw fail('Установщик не выбран', 404);
      const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
      const script = `#!/bin/sh\nset -eu\ntmp="$(mktemp -d)"\ntrap 'rm -rf "$tmp"' EXIT\ncurl -fsSL '${url}' -o "$tmp/release.zip"\nprintf '%s  %s\\n' '${release.sha256}' "$tmp/release.zip" | sha256sum -c -\nmkdir "$tmp/release"\nunzip -q "$tmp/release.zip" -d "$tmp/release"\ncd "$tmp/release"\ncd ${quote('./' + path.posix.dirname(entrypoint))}\n${quote(release.runner)} ${quote('./' + path.posix.basename(entrypoint))}\n`;
      return new Response(method === 'HEAD' ? null : script, {
        headers: {...securityHeaders, 'Content-Type': 'text/x-shellscript; charset=utf-8'}
      });
    }
    if (action === 'archive') {
      const file = projects.releasePath(release.id);
      const headers = {
        ...securityHeaders,
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="release-${release.version}.zip"`,
        'Content-Length': String(release.size)
      };
      if (method === 'HEAD') return new Response(null, {headers});
      const stream = fs.createReadStream(file);
      const log = (result) => {
        try {
          projects.log(project.id, release.version, result);
        } catch {
          console.error('Cannot write project delivery log');
        }
      };
      let ended = false;
      stream.once('end', () => {
        ended = true;
        log('streamed');
      });
      stream.once('close', () => {
        if (!ended) log('aborted');
      });
      return new Response(Readable.toWeb(stream), {headers});
    }
    throw fail('Не найдено', 404);
  } catch {
    return new Response('Не найдено', {status: 404, headers: securityHeaders});
  }
}

export function uploads() {
  projects.load();
  return projects.db
    .prepare(
      'SELECT r.id,r.version,r.size,p.id project,p.name FROM releases r JOIN projects p ON p.id=r.project'
    )
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name + ' · ' + r.version + '.zip',
      folders: [r.name],
      size: r.size,
      kind: 'Архив версии',
      href: '/modules/projects/?project=' + r.project
    }));
}
export const removeUpload = (id) => projects.removeRelease(id);

export function home(){const all=projects.list();return {total:all.length,items:all.slice(0,6).map(p=>({title:p.name,detail:p.description?.slice(0,150)||'',href:'/modules/projects/?project='+encodeURIComponent(p.id)}))};}
