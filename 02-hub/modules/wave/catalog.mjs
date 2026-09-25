export const nameKey = (value) =>
  String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('ru');
export const albumKey = (track) =>
  nameKey(track.album)
    ? JSON.stringify([nameKey(track.albumArtist || track.artist), nameKey(track.album)])
    : 'single:' + track.id;
export const albumOrder = (a, b) =>
  (a.discNumber || 1) - (b.discNumber || 1) ||
  (a.trackNumber || 9999) - (b.trackNumber || 9999) ||
  a.title.localeCompare(b.title, 'ru');
export function catalog(tracks) {
  const artists = new Map(),
    albums = new Map();
  for (const track of tracks) {
    const name = track.artist || 'Неизвестный исполнитель',
      key = nameKey(name);
    if (!artists.has(key)) artists.set(key, {key, name, tracks: [], albums: new Set()});
    const artist = artists.get(key);
    artist.tracks.push(track);
    const id = albumKey(track);
    if (!albums.has(id))
      albums.set(id, {
        key: id,
        name: track.album || track.title,
        artist: track.albumArtist || name,
        tracks: [],
        type: 'album'
      });
    albums.get(id).tracks.push(track);
    artist.albums.add(id);
  }
  for (const group of albums.values()) {
    group.tracks.sort(albumOrder);
    group.type = group.tracks.some((t) => t.releaseType === 'single' || !nameKey(t.album))
      ? 'single'
      : 'album';
  }
  return {
    artists: [...artists.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    releases: [...albums.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    albums: [...albums.values()]
      .filter((a) => a.type === 'album')
      .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    singles: [...albums.values()]
      .filter((a) => a.type === 'single')
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  };
}
