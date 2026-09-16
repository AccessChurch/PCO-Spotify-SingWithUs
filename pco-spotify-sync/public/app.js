let state;
const $ = id => document.getElementById(id);
const text = (tag, value, className) => { const el = document.createElement(tag); el.textContent = value; if (className) el.className = className; return el; };
async function api(path, data) {
  const response = await fetch(`/api/${path}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify(data) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
}
async function action(fn) {
  document.querySelectorAll('button').forEach(b => b.disabled = true);
  $('message').textContent = 'Working…';
  try { await fn(); await load(); $('message').textContent = 'Done. Review status below.'; }
  catch (error) { $('message').textContent = error.message; }
  finally { document.querySelectorAll('button').forEach(b => b.disabled = false); }
}
function button(label, fn) { const b = text('button', label); b.onclick = () => action(fn); return b; }
async function load() {
  state = await api('status');
  $('status').textContent = `${state.target} · Spotify ${state.connected ? 'connected' : 'not connected'} · Monthly publishing ${state.enabled ? 'enabled' : 'disabled'} at ${state.schedule} · ${state.songs.length} PCO songs. Last run: ${JSON.stringify(state.lastRun)}`;
  $('enable').textContent = state.enabled ? 'Disable monthly publishing' : 'Enable monthly publishing';
  $('recovery').hidden = !state.recovery;
  $('songs').replaceChildren();
  for (const song of state.songs) {
    const card = text('section', '', 'song'), mapping = state.mappings[song.id];
    card.append(text('h2', song.title), text('p', `PCO #${song.id} · ${song.author || 'Author unspecified'} · Last used ${song.lastUsed.slice(0, 10)}`, 'meta'));
    if (mapping) {
      card.append(text('p', `Approved: ${mapping.name} — ${mapping.artists}`, 'approved'), button('Revoke approval', () => api('revoke', { songId: song.id })));
    } else {
      const query = document.createElement('input'); query.value = song.title; query.setAttribute('aria-label', `Search recordings for ${song.title}`);
      const results = document.createElement('div');
      const search = text('button', 'Search Spotify');
      search.onclick = async () => { search.disabled = true; try { const tracks = await api('search', {query:query.value}); results.replaceChildren(); if (!tracks.length) results.append(text('p','No results. Try another query.')); for (const track of tracks) { const row=text('div','','result'); const link=text('a',`${track.name} — ${track.artists.map(a=>a.name).join(', ')} · ${track.album.name}`); link.href=`https://open.spotify.com/track/${track.id}`; link.target='_blank'; link.rel='noopener noreferrer'; row.append(link,button('Approve recording',()=>api('approve',{songId:song.id,track:track.uri}))); results.append(row); } } catch(error) { $('message').textContent=error.message; } finally {search.disabled=false;} };
      const manual = document.createElement('input'); manual.placeholder = 'Spotify track URL, URI, or ID'; manual.setAttribute('aria-label', `Exact recording for ${song.title}`);
      const label = text('label', 'Or choose an exact recording:');
      card.append(query, search, results, label, manual, button('Approve exact track', () => api('approve', { songId: song.id, track: manual.value.trim() })));
    }
    $('songs').append(card);
  }
}
$('connect').onclick = () => action(async () => { const result = await api('connect', {}); window.location.assign(result.url); });
$('discover').onclick = () => action(() => api('discover', {}));
$('sync').onclick = () => action(() => api('sync', {}));
$('enable').onclick = () => action(async () => { if (!state.enabled && !confirm('Enable replacement of the target playlist once all current songs are approved?')) return; await api('enable', { enabled: !state.enabled }); });
$('recover').onclick = () => action(() => api('recover', {}));
load().then(() => { $('message').textContent = 'Start by connecting Spotify and refreshing PCO songs. Publishing starts disabled.'; }).catch(error => { $('message').textContent = error.message; });
