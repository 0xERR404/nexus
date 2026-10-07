import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export const noticeCodes = Object.freeze({
  summary: 'Источник требует внимания', home: 'Данные карточки недоступны',
  request: 'Запрос не выполнен', task: 'Изменение задачи не сохранено',
  history: 'История ресурсов не обновляется', connection: 'Соединение с хабом прерывалось'
});
export function readNotices(file) {
  try {
    if (fs.statSync(file).size > 262144) throw Error('Notice store too large');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.schema !== 1 || !Array.isArray(value.events)) throw Error('Invalid notices');
    return value.events.slice(0, 200).filter(e => typeof e.id === 'string' && typeof e.key === 'string' &&
      typeof e.title === 'string' && Number.isFinite(e.time) && typeof e.active === 'boolean');
  } catch (e) { if (e.code === 'ENOENT' || !file) return []; throw e; }
}
export class Notices {
  constructor(file, {now = Date.now} = {}) {
    this.file = file; this.now = now; this.events = file ? readNotices(file) : [];
  }
  report(source, title, code, active = true) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(source) || !Object.hasOwn(noticeCodes, code)) return false;
    const original = this.events;
    this.events = structuredClone(original);
    try { return this.update(source,title,code,active); }
    catch (error) { this.events = original; throw error; }
  }
  update(source,title,code,active) {
    const key = `hub.${source}.${code}`, previous = this.events.find(e => e.key === key);
    if (!active) {
      if (!previous?.active) return false;
      previous.active = false; this.save(); return true;
    }
    // One incident until recovery. User actions can be reported again after five minutes.
    if (previous?.active && (!['task','request','connection'].includes(code) || this.now()-previous.time < 300000)) return false;
    this.events.unshift({id:randomUUID(), key, source, code, title:`${String(title).slice(0,64)} · ${noticeCodes[code]}`,
      body: code === 'task' ? 'Действие не подтверждено сервером. Повтори его после восстановления связи.' : 'Проверь подключение и настройки источника. ',
      category:'services', level:'warning', time:this.now(), active:true});
    // Retain the journal, but only the latest incident for a key remains active.
    if (previous) previous.active = false;
    this.events = this.events.slice(0,200); this.save(); return true;
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), {recursive:true,mode:0o700});
    const tmp=this.file+'.'+randomUUID()+'.tmp';
    try { fs.writeFileSync(tmp,JSON.stringify({schema:1,events:this.events}),{mode:0o600,flag:'wx'});fs.renameSync(tmp,this.file); }
    finally { fs.rmSync(tmp,{force:true}); }
  }
}
