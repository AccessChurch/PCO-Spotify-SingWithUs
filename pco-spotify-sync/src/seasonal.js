import { randomUUID } from 'node:crypto';
import { seasonalPeriod } from './schedule.js';

const TRACK = /^spotify:track:[A-Za-z0-9]{22}$/;
const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const trackKey = track => `${track.name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')}:${track.artists.map(a => a.name.toLowerCase()).sort().join('|')}`;
function compactTrack(track) {
  if (track?.type !== 'track' || !TRACK.test(track.uri) || track.is_local || track.is_playable === false || track.restrictions) throw new Error('Track is unavailable or is not a Spotify song');
  return { uri: track.uri, name: track.name, artists: track.artists.map(a => ({ name: a.name, id: a.id })), album: track.album?.name || '', explicit: !!track.explicit, durationMs: track.duration_ms || 0 };
}
export function parseTrack(value) {
  const match = String(value).trim().match(/^(?:spotify:track:|https:\/\/open\.spotify\.com\/track\/)?([A-Za-z0-9]{22})(?:\?[^\s]*)?$/);
  if (!match) throw new Error('Enter a Spotify track URL, URI, or ID');
  return match[1];
}
export async function readSeasonalPlaylist(spotify, playlist) {
  const before = await spotify(`playlists/${playlist}`);
  const tracks = [], seen = new Set();
  let path = `playlists/${playlist}/items?limit=50`;
  while (path) {
    if (seen.has(path)) throw new Error('Spotify pagination loop');
    seen.add(path);
    const page = await spotify(path);
    if (!Array.isArray(page.items)) throw new Error('Playlist items unavailable');
    for (const row of page.items) {
      if (row.is_local) throw new Error('Local playlist tracks cannot be backed up');
      tracks.push(compactTrack(row.item ?? row.track));
    }
    path = page.next;
  }
  const after = await spotify(`playlists/${playlist}`);
  if (!before.snapshot_id || before.snapshot_id !== after.snapshot_id) throw new Error('Playlist changed during read; retry');
  return { playlist, name: after.name || 'Pre-service', snapshot: after.snapshot_id, tracks };
}

// Search-based suggestions, not Spotify's Recommendations or audio-features APIs.
export async function proposeTracks(spotify, reference, now = new Date()) {
  const artistCounts = new Map();
  for (const track of reference) for (const artist of track.artists) artistCounts.set(artist.name, (artistCounts.get(artist.name) || 0) + 1);
  const artists = [...artistCounts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name]) => name);
  const seen = new Set(reference.map(t => t.uri)), titles = new Set(reference.map(trackKey));
  const buckets = [], queries = [];
  for (const artist of artists) {
    const bucket = [];
    for (const query of [`artist:"${artist.replaceAll('"', '')}" year:${now.getUTCFullYear() - 2}-${now.getUTCFullYear()}`, `artist:"${artist.replaceAll('"', '')}"`]) {
      queries.push(query);
      const result = await spotify(`search?${new URLSearchParams({ q: query, type: 'track', limit: '10' })}`);
      if (!Array.isArray(result.tracks?.items)) throw new Error('Spotify search response unavailable');
      for (const raw of result.tracks.items) {
        let track; try { track = compactTrack(raw); } catch { continue; }
        if (track.explicit || seen.has(track.uri) || titles.has(trackKey(track))) continue;
        seen.add(track.uri); titles.add(trackKey(track)); bucket.push({ ...track, reason: `Found by artist search: ${artist}` });
      }
    }
    buckets.push(bucket);
  }
  // Interleave artist buckets to avoid placing every recording from one artist together.
  const candidates = [];
  while (buckets.some(bucket => bucket.length)) for (const bucket of buckets) if (bucket.length) candidates.push(bucket.shift());
  return { tracks: candidates.slice(0, reference.length), candidates, queries, artists };
}

export function createSeasonal(config, store, clients, exclusive) {
  const playlist = config.preServicePlaylist;
  if (!/^[A-Za-z0-9]{22}$/.test(playlist) || playlist === config.playlist) throw new Error('Pre-service playlist must be a valid, separate Spotify playlist');
  if (store.get('seasonalTarget') && store.get('seasonalTarget') !== playlist) throw new Error('Pre-service data belongs to another playlist; do not change its target');
  store.set('seasonalTarget', playlist);
  const key = 'seasonal';
  const get = () => clone(store.get(key, { draft: null, backups: [], recovery: null, due: null, lastRun: null }));
  const save = state => store.set(key, state);
  let localBusy = false;
  const lock = exclusive || (async fn => { if (localBusy) throw new Error('Another operation is running'); localBusy = true; try { return await fn(); } finally { localBusy = false; } });
  const timestamp = () => new Date().toISOString();
  const read = () => readSeasonalPlaylist(clients.spotify, playlist);
  function editable(state, input) {
    const draft = state.draft;
    if (!draft || draft.id !== input.id || draft.revision !== input.revision) throw new Error('Review changed; reload before continuing');
    if (state.recovery) throw new Error('An interrupted write needs restoration before editing');
    if (!['draft', 'approved'].includes(draft.status)) throw new Error('Create a new review first');
    return draft;
  }
  async function create(state, period = null) {
    if (state.recovery) throw new Error('Restore the interrupted write before creating a review');
    if (state.draft && ['draft', 'approved'].includes(state.draft.status)) throw new Error('An open review already exists; publish or discard it first');
    const reference = await read();
    if (!reference.tracks.length) throw new Error('The pre-service playlist is empty; add style-reference songs in Spotify first');
    const proposal = await proposeTracks(clients.spotify, reference.tracks);
    state.draft = { id: randomUUID(), revision: 1, status: 'draft', createdAt: timestamp(), period, reference, ...proposal, approvedAt: null };
    if (period) { state.completedPeriod = period; state.due = null; }
    state.lastRun = { at: timestamp(), status: 'review ready', proposed: proposal.tracks.length, target: reference.tracks.length };
    save(state);
    return state.draft;
  }
  async function replace(state, tracks, before, operation) {
    const uris = tracks.map(t => t.uri);
    if (uris.some(uri => !TRACK.test(uri))) throw new Error('Invalid playlist track');
    const backup = { ...before, id: randomUUID(), at: timestamp(), operation };
    state.backups.push(backup);
    state.recovery = { operation, backupId: backup.id, at: timestamp(), desired: tracks };
    state.restorePreview = null;
    save(state); // Durable before the first external mutation; retained on any ambiguous failure.
    try {
      await clients.spotify(`playlists/${playlist}/items`, 'PUT', { uris: uris.slice(0, 100) });
      for (let i = 100; i < uris.length; i += 100) await clients.spotify(`playlists/${playlist}/items`, 'POST', { uris: uris.slice(i, i + 100) });
      const actual = await read();
      if (!same(actual.tracks.map(t => t.uri), uris)) throw new Error('Playlist verification failed');
      state.recovery = null;
      if (state.draft) { state.draft.status = operation === 'publish' ? 'published' : 'restored'; state.draft.approvedAt = null; }
      state.lastRun = { at: timestamp(), status: operation === 'publish' ? 'published' : 'restored', tracks: tracks.length };
      save(state);
    } catch (error) {
      state.lastRun = { at: timestamp(), status: 'recovery required', message: error.message }; save(state); throw error;
    }
  }
  return {
    status: () => ({ ...get(), playlist, schedule: 'Second Wednesday of January and May; last Wednesday of July, 10:00 America/New_York' }),
    create: () => lock(() => { const state = get(); return create(state, state.due); }),
    edit: input => lock(async () => {
      const state = get(), draft = editable(state, input);
      if (input.action === 'add') {
        const track = compactTrack(await clients.spotify(`tracks/${parseTrack(input.track)}`));
        if (draft.tracks.some(t => t.uri === track.uri)) throw new Error('That recording is already in the proposal');
        if (draft.tracks.length >= 1000) throw new Error('Proposal limit is 1000 tracks');
        draft.tracks.push(track);
      } else if (input.action === 'remove') {
        if (!draft.tracks.some(t => t.uri === input.uri)) throw new Error('Track is not in this proposal');
        draft.tracks = draft.tracks.filter(t => t.uri !== input.uri);
      } else if (input.action === 'move') {
        const from = draft.tracks.findIndex(t => t.uri === input.uri), to = input.index;
        if (from < 0 || !Number.isInteger(to) || to < 0 || to >= draft.tracks.length) throw new Error('Invalid track position');
        const [track] = draft.tracks.splice(from, 1); draft.tracks.splice(to, 0, track);
      } else throw new Error('Unknown review edit');
      draft.revision++; draft.status = 'draft'; draft.approvedAt = null; save(state);
    }),
    discard: input => lock(async () => { const state = get(); editable(state, input); state.draft.status = 'discarded'; state.draft.approvedAt = null; save(state); }),
    approve: input => lock(async () => {
      const state = get(), draft = editable(state, input);
      if (!draft.tracks.length) throw new Error('Cannot approve an empty proposal');
      draft.status = 'approved'; draft.approvedAt = timestamp(); save(state);
    }),
    publish: input => lock(async () => {
      const state = get(), draft = editable(state, input);
      if (draft.status !== 'approved' || !draft.approvedAt || !draft.tracks.length) throw new Error('Approve the complete ordered proposal before publishing');
      const before = await read();
      if (before.snapshot !== draft.reference.snapshot) throw new Error('Spotify playlist changed since this review was created. Discard it and create a fresh review.');
      await replace(state, draft.tracks, before, 'publish');
    }),
    previewRestore: input => lock(async () => {
      const state = get(), backup = state.backups.find(b => b.id === input.backupId);
      if (!backup || backup.playlist !== playlist) throw new Error('Backup not found for this playlist');
      const before = await read();
      const preview = { id: randomUUID(), backupId: backup.id, before, tracks: backup.tracks, expiresAt: Date.now() + 600000 };
      state.restorePreview = preview; save(state); return preview;
    }),
    restore: input => lock(async () => {
      const state = get(), preview = state.restorePreview;
      if (!preview || preview.id !== input.previewId || preview.expiresAt < Date.now()) throw new Error('Preview the restore again before confirming');
      const before = await read();
      if (before.snapshot !== preview.before.snapshot) throw new Error('Playlist changed after restore preview; preview again');
      await replace(state, preview.tracks, before, 'restore');
    }),
    tick: (now = new Date()) => lock(async () => {
      const period = seasonalPeriod(now), state = get();
      if (period && state.completedPeriod !== period && state.due !== period) { state.due = period; save(state); }
      if (!state.due || state.recovery || ['draft', 'approved'].includes(state.draft?.status)) return;
      if (!store.get('tokens')?.refresh_token) return;
      const day = now.toISOString().slice(0, 10);
      if (state.attemptDay === day) return;
      state.attemptDay = day; save(state);
      try { await create(state, state.due); }
      catch (error) { state.lastRun = { at: timestamp(), status: 'review creation failed', message: error.message }; save(state); }
    })
  };
}
