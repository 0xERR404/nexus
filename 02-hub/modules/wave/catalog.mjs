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
export const releaseYear = (value) => {
  const match = /^([1-9]\d{3})(?:$|[-/])/.exec(String(value ?? '').trim());
  return match ? Number(match[1]) : 0;
};
export const releaseOrder = (a, b) =>
  (b.year || 0) - (a.year || 0) || a.name.localeCompare(b.name, 'ru');
export const trackYearOrder = (a, b) =>
  releaseYear(b.year) - releaseYear(a.year) ||
  albumKey(a).localeCompare(albumKey(b), 'ru') ||
  albumOrder(a, b);
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
    const years = group.tracks.map((t) => releaseYear(t.year)).filter(Boolean);
    group.year = years.length ? Math.min(...years) : 0;
    group.type = group.tracks.some((t) => t.releaseType === 'single' || !nameKey(t.album))
      ? 'single'
      : 'album';
  }
  return {
    artists: [...artists.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    releases: [...albums.values()].sort(releaseOrder),
    albums: [...albums.values()].filter((a) => a.type === 'album').sort(releaseOrder),
    singles: [...albums.values()].filter((a) => a.type === 'single').sort(releaseOrder)
  };
}
