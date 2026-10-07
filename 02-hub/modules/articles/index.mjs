import {createContentModule} from '../../src/content-module.mjs';
export const {handle, summary} = createContentModule('articles');

import {contentStore} from '../../src/content-store.mjs';
export function home(){const all=contentStore().articles().sort((a,b)=>b.updated-a.updated);return {total:all.length,items:all.slice(0,6).map(a=>({title:a.title,detail:a.excerpt,href:'/modules/articles/?article='+encodeURIComponent(a.id)}))};}
