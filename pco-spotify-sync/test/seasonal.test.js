import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSeasonal, proposeTracks, readSeasonalPlaylist } from '../src/seasonal.js';
import { seasonalPeriod } from '../src/schedule.js';
import { openStore } from '../src/store.js';
const PLAYLIST = '0WAQXaN7S6QynKYvTg0WP9';
const PCO = '343fIBIyCNoLx4aoKoqtPt';
const track = (n, artist = 'Artist A', extra = {}) => ({ id: String(n).padStart(22, '0'), uri: `spotify:track:${String(n).padStart(22, '0')}`, type: 'track', name: `Song ${n}`, artists: [{ name: artist, id: artist }], album: { name: 'Album' }, duration_ms: 180000, ...extra });
function memory() { const data = new Map(); return { get: (k, f = null) => structuredClone(data.has(k) ? data.get(k) : f), set: (k, v) => data.set(k, structuredClone(v)) }; }
function fixture({ count = 2, store = memory() } = {}) {
  let current = Array.from({ length: count }, (_, i) => track(i + 1, i % 2 ? 'Artist B' : 'Artist A'));
  let snapshot = 1, failPost = false;
  const calls = [];
  const spotify = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path.startsWith('playlists/')) assert.ok(path.startsWith(`playlists/${PLAYLIST}`), 'must never read or mutate another playlist');
    if (method !== 'GET') {
      if (method === 'POST' && failPost) throw new Error('ambiguous append failure');
      current = (method === 'PUT' ? [] : current).concat(body.uris.map(uri => track(Number(uri.split(':').at(-1)))));
      snapshot++; return { snapshot_id: String(snapshot) };
    }
    if (path.startsWith('tracks/')) return track(Number(path.slice(7)));
    if (path.startsWith('search?')) return { tracks: { items: [track(101), track(102), track(103)] } };
    if (path.includes('/items')) {
      const offset = Number(new URL(path, 'https://api.spotify.com/v1/').searchParams.get('offset') || 0);
      return { items: current.slice(offset, offset + 50).map(item => ({ item })), next: offset + 50 < current.length ? `playlists/${PLAYLIST}/items?offset=${offset + 50}` : null };
    }
    return { snapshot_id: String(snapshot), name: 'Pre-service' };
  };
  store.set('tokens', { refresh_token: 'test' });
  const config = { playlist: PCO, preServicePlaylist: PLAYLIST };
  const service = createSeasonal(config, store, { spotify });
  return { service, store, config, spotify, calls, revision: () => { const d = service.status().draft; return { id: d.id, revision: d.revision }; }, writes: () => calls.filter(c => c.method !== 'GET'), current: () => structuredClone(current), change: () => { snapshot++; }, failAppend: () => { failPost = true; }, repairAppend: () => { failPost = false; } };
}

test('seasonal dates: second Jan/May Wednesday, last July Wednesday, DST and non-season months', () => {
  for (const [before, at, period] of [
    ['2026-01-14T14:59:59Z', '2026-01-14T15:00:00Z', '2026-01'],
    ['2026-05-13T13:59:59Z', '2026-05-13T14:00:00Z', '2026-05'],
    ['2026-07-29T13:59:59Z', '2026-07-29T14:00:00Z', '2026-07'],
    ['2027-01-13T14:59:59Z', '2027-01-13T15:00:00Z', '2027-01']
  ]) { assert.equal(seasonalPeriod(new Date(before)), null); assert.equal(seasonalPeriod(new Date(at)), period); }
  assert.equal(seasonalPeriod(new Date('2026-07-31T18:00:00Z')), '2026-07');
  for (const date of ['2026-01-07', '2026-05-06', '2026-07-22', '2026-08-01', '2026-12-30']) assert.equal(seasonalPeriod(new Date(`${date}T18:00:00Z`)), null);
});
test('seasonal target cannot equal PCO target or change on existing storage', () => {
  const f = fixture();
  assert.throws(() => createSeasonal({ playlist: PCO, preServicePlaylist: PCO }, f.store, {}), /separate/);
  assert.throws(() => createSeasonal({ playlist: PCO, preServicePlaylist: '1234567890123456789012' }, f.store, {}), /another playlist/);
});
test('proposal excludes current songs, duplicate reissues, explicit/unavailable results and interleaves artists', async () => {
  const reference = [track(1), track(2, 'Artist B')];
  const source = reference.map(t => ({ ...t, album: t.album.name }));
  const proposal = await proposeTracks(async path => {
    assert.ok(path.startsWith('search?')); assert.equal(new URL(path, 'https://test/').searchParams.get('limit'), '10');
    const b = decodeURIComponent(path).includes('Artist+B');
    return { tracks: { items: b ? [track(30, 'Artist B')] : [track(1), track(20), track(21, 'Artist A', { name: 'Song 20' }), track(22, 'Artist A', { explicit: true }), track(23, 'Artist A', { is_playable: false }), track(24)] } };
  }, source);
  assert.deepEqual(proposal.tracks.map(t => t.uri), [track(20).uri, track(30).uri]);
  assert.equal(proposal.candidates.length, 3);
});
test('creating, editing and approving never write Spotify; changing order invalidates approval', async () => {
  const f = fixture(); await f.service.create();
  const first = f.revision();
  await assert.rejects(f.service.publish(first), /Approve/);
  await f.service.approve(first);
  await f.service.edit({ ...first, action: 'move', uri: track(101).uri, index: 1 });
  assert.equal(f.service.status().draft.status, 'draft');
  await assert.rejects(f.service.publish(f.revision()), /Approve/);
  await assert.rejects(f.service.approve(first), /changed/);
  await f.service.edit({ ...f.revision(), action: 'add', track: `https://open.spotify.com/track/${track(999).id}?si=test` });
  await assert.rejects(f.service.edit({ ...f.revision(), action: 'add', track: track(999).uri }), /already/);
  await f.service.edit({ ...f.revision(), action: 'remove', uri: track(999).uri });
  assert.equal(f.writes().length, 0);
});
test('publish requires unchanged reference snapshot; explicit approval publishes only seasonal playlist and saves backup', async () => {
  const f = fixture(); f.store.set('mappings', { pco: 'untouched' }); f.store.set('enabled', true); f.store.set('backup', { pco: 'untouched' });
  await f.service.create(); await f.service.approve(f.revision());
  await f.service.publish(f.revision());
  assert.deepEqual(f.current().map(t => t.uri), [track(101).uri, track(102).uri]);
  assert.deepEqual(f.service.status().backups[0].tracks.map(t => t.uri), [track(1).uri, track(2).uri]);
  assert.equal(f.service.status().draft.status, 'published');
  assert.deepEqual(f.store.get('mappings'), { pco: 'untouched' }); assert.deepEqual(f.store.get('backup'), { pco: 'untouched' }); assert.equal(f.store.get('enabled'), true);
  await assert.rejects(f.service.publish(f.revision()), /new review/); assert.equal(f.writes().length, 1);
  const g = fixture(); await g.service.create(); await g.service.approve(g.revision()); g.change();
  await assert.rejects(g.service.publish(g.revision()), /changed since/); assert.equal(g.writes().length, 0);
});
test('restoration is previewed, confirms the exact snapshot, and saves an undo backup', async () => {
  const f = fixture(); await f.service.create(); await f.service.approve(f.revision()); await f.service.publish(f.revision());
  const backup = f.service.status().backups[0];
  await assert.rejects(f.service.restore({ previewId: 'missing' }), /Preview/);
  const preview = await f.service.previewRestore({ backupId: backup.id }); assert.equal(f.writes().length, 1);
  f.change(); await assert.rejects(f.service.restore({ previewId: preview.id }), /changed after/);
  const second = await f.service.previewRestore({ backupId: backup.id });
  await f.service.restore({ previewId: second.id });
  assert.deepEqual(f.current().map(t => t.uri), [track(1).uri, track(2).uri]);
  assert.equal(f.service.status().backups.length, 2); assert.equal(f.service.status().draft.status, 'restored');
  await assert.rejects(f.service.restore({ previewId: second.id }), /Preview/);
});
test('partial multi-batch write remains recoverable after restart and blocks repeat publication', async () => {
  const f = fixture(); await f.service.create();
  for (let i = 200; i < 300; i++) await f.service.edit({ ...f.revision(), action: 'add', track: track(i).uri });
  await f.service.approve(f.revision()); f.failAppend();
  await assert.rejects(f.service.publish(f.revision()), /ambiguous/);
  assert.equal(f.current().length, 100); assert.ok(f.service.status().recovery);
  const restarted = createSeasonal(f.config, f.store, { spotify: f.spotify });
  await assert.rejects(restarted.publish(f.revision()), /interrupted/);
  await assert.rejects(restarted.discard(f.revision()), /interrupted/);
  f.repairAppend(); const preview = await restarted.previewRestore({ backupId: restarted.status().recovery.backupId });
  await restarted.restore({ previewId: preview.id });
  assert.deepEqual(f.current().map(t => t.uri), [track(1).uri, track(2).uri]); assert.equal(restarted.status().recovery, null);
});
test('empty proposals cannot be approved or published; failed search preserves earlier review data', async () => {
  const f = fixture(); await f.service.create();
  for (const t of f.service.status().draft.tracks) await f.service.edit({ ...f.revision(), action: 'remove', uri: t.uri });
  await assert.rejects(f.service.approve(f.revision()), /empty/); assert.equal(f.writes().length, 0);
  await f.service.discard(f.revision());
  const failed = createSeasonal(f.config, f.store, { spotify: async (...args) => { if (args[0].startsWith('search')) throw new Error('rate limit'); return f.spotify(...args); } });
  await assert.rejects(failed.create(), /rate limit/); assert.equal(failed.status().draft.status, 'discarded');
});
test('schedule creates only reviews, persists once-per-season success, preserves open reviews, queues next season', async () => {
  const f = fixture(); const jan = new Date('2026-01-14T15:00:00Z');
  await f.service.tick(jan); const first = f.service.status().draft.id;
  await f.service.tick(jan); assert.equal(f.service.status().draft.id, first); assert.equal(f.writes().length, 0);
  await f.service.tick(new Date('2026-05-13T14:00:00Z'));
  assert.equal(f.service.status().draft.id, first); assert.equal(f.service.status().due, '2026-05');
  await f.service.discard(f.revision()); await f.service.tick(new Date('2026-06-01T14:00:00Z'));
  assert.notEqual(f.service.status().draft.id, first); assert.equal(f.service.status().draft.period, '2026-05'); assert.equal(f.writes().length, 0);
});
test('scheduler waits for OAuth and retries failed proposal creation next day', async () => {
  const f = fixture(); f.store.set('tokens', null);
  await f.service.tick(new Date('2026-05-13T14:00:00Z')); assert.equal(f.service.status().due, '2026-05'); assert.equal(f.calls.length, 0);
  f.store.set('tokens', { refresh_token: 'test' }); let fail = true, attempts = 0;
  const service = createSeasonal(f.config, f.store, { spotify: async (...args) => { attempts++; if (fail) throw new Error('temporary error'); return f.spotify(...args); } });
  await service.tick(new Date('2026-05-13T14:01:00Z')); assert.match(service.status().lastRun.status, /failed/);
  await service.tick(new Date('2026-05-13T15:00:00Z')); assert.equal(attempts, 1);
  fail = false; await service.tick(new Date('2026-05-14T14:00:00Z')); assert.ok(service.status().draft); assert.equal(f.writes().length, 0);
});
test('seasonal drafts and backups persist in SQLite across restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seasonal-')); let store = openStore(dir);
  try {
    const f = fixture({ store }); await f.service.create(); await f.service.approve(f.revision()); await f.service.publish(f.revision()); store.close(); store = openStore(dir);
    const restarted = createSeasonal(f.config, store, { spotify: f.spotify });
    assert.equal(restarted.status().draft.status, 'published'); assert.equal(restarted.status().backups.length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('reference reader handles pagination, rejects local/unavailable items and detects concurrent changes', async () => {
  const f = fixture({ count: 101 }); assert.equal((await readSeasonalPlaylist(f.spotify, PLAYLIST)).tracks.length, 101);
  await assert.rejects(readSeasonalPlaylist(async path => path.includes('/items') ? { items: [{ item: null }] } : { snapshot_id: '1' }, PLAYLIST), /unavailable/);
  let reads = 0;
  await assert.rejects(readSeasonalPlaylist(async path => path.includes('/items') ? { items: [] } : { snapshot_id: String(++reads) }, PLAYLIST), /changed during/);
});
