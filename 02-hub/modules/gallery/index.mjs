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
