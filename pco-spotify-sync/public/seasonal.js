let state, running = false;
const $ = id => document.getElementById(id);
function element(tag, value, className) {
  const el = document.createElement(tag); el.textContent = value;
  if (className) el.className = className; return el;
}
async function api(route = '', data) {
  const response = await fetch(`/api/seasonal${route ? `/${route}` : ''}`, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error); return result;
}
const revision = () => ({ id: state.draft.id, revision: state.draft.revision });
function activeDraft() { return !state.recovery && ['draft', 'approved'].includes(state.draft?.status); }
function controls() {
  const active = activeDraft();
  $('create').disabled = running || !state.connected || active || !!state.recovery;
  $('approve').disabled = running || !active || !state.draft.tracks.length || state.draft.status === 'approved';
  $('publish').disabled = running || !active || state.draft.status !== 'approved';
  $('discard').disabled = running || !active;
  $('search').disabled = $('add').disabled = running || !active;
  $('refresh').disabled = running;
  $('restore').disabled = running || !state.restorePreview || state.restorePreview.expiresAt < Date.now();
}
async function action(fn, message = 'Saved. Spotify changes only when you publish or restore.') {
  if (running) return;
  running = true; document.querySelectorAll('button').forEach(b => b.disabled = true);
  $('message').textContent = 'Working…';
  try { await fn(); $('message').textContent = message; }
  catch (error) { $('message').textContent = error.message; }
  finally {
    try { await load(); } catch (error) { $('message').textContent += `\nCould not refresh: ${error.message}`; }
    running = false; document.querySelectorAll('button').forEach(b => b.disabled = false); controls();
  }
}
function button(label, fn) { const b = element('button', label); b.onclick = () => action(fn); return b; }
function trackRow(track, index, mode) {
  const row = element('div', '', 'track'), info = element('div', '');
  const link = element('a', `${index === null ? '' : `${index + 1}. `}${track.name}${track.explicit ? ' [Explicit]' : ''}`);
  link.href = `https://open.spotify.com/track/${track.uri.split(':').at(-1)}`;
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  info.append(link, element('p', `${track.artists.map(a => a.name).join(', ')} · ${track.album || 'Album unspecified'}`, 'meta'));
  if (track.reason) info.append(element('p', track.reason, 'meta'));
  row.append(info);
  const bar = element('div', '', 'toolbar');
  if (mode === 'edit') {
    if (index > 0) bar.append(button('↑ Up', () => api('edit', { ...revision(), action: 'move', uri: track.uri, index: index - 1 })));
    if (index < state.draft.tracks.length - 1) bar.append(button('↓ Down', () => api('edit', { ...revision(), action: 'move', uri: track.uri, index: index + 1 })));
    bar.append(button('Remove', () => api('edit', { ...revision(), action: 'remove', uri: track.uri })));
  } else if (mode === 'add' && activeDraft()) {
    if (state.draft.tracks.some(t => t.uri === track.uri)) bar.append(element('span', 'In proposal', 'badge'));
    else bar.append(button('Add to proposal', () => api('edit', { ...revision(), action: 'add', track: track.uri })));
  }
  row.append(bar); return row;
}
async function load() {
  state = await api();
  $('playlist-link').href = `https://open.spotify.com/playlist/${state.playlist}`;
  $('status').textContent = `Spotify ${state.connected ? 'connected' : 'not connected'} · ${state.playlist}${state.due ? ` · Review due: ${state.due}` : ''}${state.lastRun ? ` · ${state.lastRun.status} (${state.lastRun.at})${state.lastRun.message ? `: ${state.lastRun.message}` : ''}` : ''}`;
  $('recovery').hidden = !state.recovery;
  $('review').hidden = !state.draft;
  if (state.draft) {
    const draft = state.draft, originalUris = new Set(draft.reference.tracks.map(t => t.uri)), selectedUris = new Set(draft.tracks.map(t => t.uri));
    $('draft-state').textContent = draft.status;
    const added = draft.tracks.filter(t => !originalUris.has(t.uri)).length;
    const removed = draft.reference.tracks.filter(t => !selectedUris.has(t.uri)).length;
    $('draft-summary').textContent = `${draft.tracks.length} proposed tracks · ${added} additions · ${removed} removals · Revision ${draft.revision}${draft.period ? ` · ${draft.period} seasonal review` : ''}`;
    $('shortfall').hidden = draft.tracks.length >= draft.reference.tracks.length;
    $('shortfall').textContent = `This proposal has ${draft.tracks.length} tracks; the current reference has ${draft.reference.tracks.length}. Add recordings below or approve the shorter playlist intentionally.`;
    $('proposal').replaceChildren(...draft.tracks.map((t, i) => trackRow(t, i, activeDraft() ? 'edit' : 'view')));
    if (!draft.tracks.length) $('proposal').append(element('p', 'No tracks selected. Search or add a track URL to begin.'));
    $('editor').hidden = !activeDraft();
    $('candidates').replaceChildren(...draft.candidates.map(t => trackRow(t, null, 'add')));
    $('reference-info').textContent = `${draft.reference.name} · ${draft.reference.tracks.length} tracks · Imported ${draft.createdAt}. Search seeds: ${draft.artists.join(', ') || 'none'}.`;
    $('reference').replaceChildren(...draft.reference.tracks.map((t, i) => trackRow(t, i, 'add')));
  }
  $('backups').replaceChildren();
  for (const backup of [...state.backups].reverse()) {
    const row = element('div', '', 'track');
    row.append(element('p', `${backup.at} · ${backup.tracks.length} tracks · Before ${backup.operation}`), button('Preview restore', () => api('preview-restore', { backupId: backup.id })));
    $('backups').append(row);
  }
  if (!state.backups.length) $('backups').append(element('p', 'Your first backup will appear when you publish.'));
  const preview = state.restorePreview;
  $('restore-preview').hidden = !preview;
  if (preview) {
    $('restore-summary').textContent = `Replace the current ${preview.before.tracks.length} tracks with these ${preview.tracks.length} saved tracks. This preview expires after 10 minutes.${preview.tracks.length ? '' : ' This restores an EMPTY playlist.'}`;
    $('restore-tracks').replaceChildren(...preview.tracks.map((t, i) => trackRow(t, i, 'view')));
  }
  controls();
}
$('create').onclick = () => action(() => api('create', {}), 'Review created. Listen and edit before approving.');
$('refresh').onclick = () => action(async () => {}, 'Status refreshed.');
$('approve').onclick = () => action(() => api('approve', revision()), 'This order is approved. Click Publish approved playlist when ready.');
$('publish').onclick = () => {
  if (confirm(`Replace all songs in the pre-service playlist with these ${state.draft.tracks.length} approved tracks? A backup will be saved first.`)) action(() => api('publish', revision()), 'Pre-service playlist published and verified.');
};
$('discard').onclick = () => { if (confirm('Discard this proposal? Spotify will remain unchanged.')) action(() => api('discard', revision()), 'Review discarded.'); };
$('add').onclick = () => action(async () => { await api('edit', { ...revision(), action: 'add', track: $('manual').value }); $('manual').value = ''; });
$('search').onclick = () => action(async () => {
  const response = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify({ query: $('query').value }) });
  const tracks = await response.json(); if (!response.ok) throw new Error(tracks.error);
  $('search-results').replaceChildren();
  for (const track of tracks) if (track.type === 'track' && track.uri) $('search-results').append(trackRow({ ...track, album: track.album?.name || '' }, null, 'add'));
  if (!tracks.length) $('search-results').append(element('p', 'No recordings found. Try a different search.'));
}, 'Search complete. Add the recordings you want.');
$('restore').onclick = () => {
  if (confirm(`Restore these ${state.restorePreview.tracks.length} saved tracks? This replaces the current pre-service playlist.`)) action(() => api('restore', { previewId: state.restorePreview.id }), 'Backup restored and verified.');
};
load().then(() => { $('message').textContent = 'Create a seasonal review to start. Spotify stays unchanged until you approve and publish.'; }).catch(error => { $('message').textContent = error.message; });
