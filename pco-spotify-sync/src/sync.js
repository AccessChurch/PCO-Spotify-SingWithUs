import { collectSongs } from './api.js';
export function desiredTracks(songs, mappings) {
  if (!songs.length) throw new Error('Empty source: playlist preserved');
  const missing = songs.filter(song => !mappings[song.id]?.approvedAt);
  if (missing.length) throw new Error(`${missing.length} songs await approval: playlist preserved`);
  const uris = songs.map(song => mappings[song.id].uri);
  if (uris.some(uri => !/^spotify:track:[A-Za-z0-9]{22}$/.test(uri))) throw new Error('Invalid approved mapping');
  return [...new Set(uris)];
}
export function createSync(config, store, clients) {
  let busy = false;
  async function exclusive(fn) {
    if (busy) throw new Error('Another operation is running');
    busy = true; try { return await fn(); } finally { busy = false; }
  }
  async function discover() {
    const songs = await collectSongs(clients.pco, config.serviceType);
    store.set('songs', songs); store.set('discoveredAt', new Date().toISOString()); return songs;
  }
  async function readPlaylist() {
    const before = await clients.spotify(`playlists/${config.playlist}`);
    const uris = []; let path = `playlists/${config.playlist}/items?limit=50`; const seen = new Set();
    while (path) {
      if (seen.has(path)) throw new Error('Spotify pagination loop'); seen.add(path);
      const page = await clients.spotify(path);
      if (!Array.isArray(page.items)) throw new Error('Playlist items unavailable');
      for (const row of page.items) {
        const item = row.item ?? row.track;
        if (!item?.uri || row.is_local || item.is_local) throw new Error('Playlist contains unavailable/local items; cannot safely back up');
        uris.push(item.uri);
      }
      path = page.next;
    }
    const after = await clients.spotify(`playlists/${config.playlist}`);
    if (!before.snapshot_id || before.snapshot_id !== after.snapshot_id) throw new Error('Playlist changed during read; retry');
    return { snapshot: after.snapshot_id, uris };
  }
  async function run() {
    return exclusive(async () => {
      try {
        const songs = await discover();
        const uris = desiredTracks(songs, store.get('mappings', {}));
        if (!store.get('enabled', false)) throw new Error('Monthly publishing disabled: playlist preserved');
        if (store.get('writeInProgress')) throw new Error('Previous write incomplete; inspect backup and acknowledge recovery before retry');
        const before = await readPlaylist();
        if (JSON.stringify(before.uris) === JSON.stringify(uris)) { store.set('lastRun', { at: new Date().toISOString(), status: 'unchanged' }); return; }
        store.set('backup', { ...before, at: new Date().toISOString(), playlist: config.playlist });
        store.set('writeInProgress', { desired: uris, at: new Date().toISOString() });
        // PUT first; never clear the playlist. POST batches are never retried after ambiguous failures.
        await clients.spotify(`playlists/${config.playlist}/items`, 'PUT', { uris: uris.slice(0, 100) });
        for (let i = 100; i < uris.length; i += 100) await clients.spotify(`playlists/${config.playlist}/items`, 'POST', { uris: uris.slice(i, i + 100) });
        const actual = await readPlaylist();
        if (JSON.stringify(actual.uris) !== JSON.stringify(uris)) throw new Error('Playlist verification failed');
        store.set('writeInProgress', null);
        store.set('lastRun', { at: new Date().toISOString(), status: 'synced', tracks: uris.length });
      } catch (error) { store.set('lastRun', { at: new Date().toISOString(), status: 'blocked/error', message: error.message }); throw error; }
    });
  }
  return { exclusive, discover, run, get busy() { return busy; } };
}
