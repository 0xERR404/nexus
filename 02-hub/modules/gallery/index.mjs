import {createContentModule} from '../../src/content-module.mjs';
export const {handle, summary} = createContentModule('gallery');

import {contentStore} from '../../src/content-store.mjs';
export const uploads = () =>
  contentStore()
    .images()
    .images.map((i) => ({
      id: i.id,
      name: i.name,
      folders: [i.album || 'Без альбома'],
      size: i.size,
      kind: 'Изображение',
      href: '/modules/gallery/'
    }));
export const removeUpload = (id) => contentStore().deleteImage(id);

export function home(){const all=contentStore().images().images;return {total:all.length,items:[...all].sort((a,b)=>(b.created||0)-(a.created||0)).slice(0,6).map(i=>({title:i.name,detail:i.album||'Без альбома',href:'/modules/gallery/?image='+encodeURIComponent(i.id),image:'/modules/gallery/thumb/'+encodeURIComponent(i.id)}))};}
