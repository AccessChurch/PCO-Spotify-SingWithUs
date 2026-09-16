const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function request(url, options = {}) {
  const method = options.method || 'GET';
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000), redirect: 'error' });
    if ((response.status === 429 || (method === 'GET' && response.status >= 500)) && attempt < 3) {
      const seconds = Number(response.headers.get('retry-after') || 2 ** attempt);
      if (!Number.isFinite(seconds) || seconds > 60) throw new Error('API rate limit: retry later');
      await sleep(Math.max(1, seconds) * 1000); continue;
    }
    if (!response.ok) { const error = new Error(`API ${new URL(url).hostname} returned HTTP ${response.status}`); error.status = response.status; throw error; }
    if (response.status === 204) return {};
    return response.json();
  }
}
export async function collectSongs(pco, serviceType, now = new Date()) {
  const cutoff = now.getTime() - 180 * 86400000;
  const songs = new Map();
  let next = `/services/v2/service_types/${serviceType}/plans?order=-sort_date&per_page=100`;
  const seen = new Set();
  while (next) {
    if (seen.has(next)) throw new Error('PCO pagination loop'); seen.add(next);
    const page = await pco(next);
    if (!Array.isArray(page.data)) throw new Error('Invalid PCO plans response');
    let reachedCutoff = false;
    for (const plan of page.data) {
      const time = Date.parse(plan.attributes.sort_date);
      if (!Number.isFinite(time)) throw new Error('Plan has invalid sort_date');
      if (time < cutoff) { reachedCutoff = true; continue; }
      if (time > now.getTime()) continue;
      if (plan.attributes.can_view_order === false) throw new Error('PCO plan order is inaccessible');
      let itemsNext = `/services/v2/service_types/${serviceType}/plans/${plan.id}/items?include=song&per_page=100`;
      const itemPages = new Set();
      while (itemsNext) {
        if (itemPages.has(itemsNext)) throw new Error('PCO item pagination loop'); itemPages.add(itemsNext);
        const items = await pco(itemsNext);
        if (!Array.isArray(items.data)) throw new Error('Invalid PCO items response');
        for (const item of items.data) {
          const id = item.relationships?.song?.data?.id;
          if (!id) { if (item.attributes?.item_type === 'song') throw new Error('Song item has no PCO Song ID'); continue; }
          const meta = items.included?.find(x => x.type === 'Song' && x.id === id)?.attributes;
          if (!songs.has(id)) songs.set(id, { id, title: meta?.title || item.attributes.title, author: meta?.author || '', lastUsed: new Date(time).toISOString() });
        }
        itemsNext = items.links?.next;
      }
    }
    next = reachedCutoff ? null : page.links?.next;
  }
  return [...songs.values()].sort((a,b) => b.lastUsed.localeCompare(a.lastUsed) || a.id.localeCompare(b.id));
}
export function makeClients(config, store) {
  let refreshPromise;
  async function tokenGrant(params) {
    const result = await request('https://accounts.spotify.com/api/token', { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${config.spotifyId}:${config.spotifySecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    const previous = store.get('tokens', {});
    store.set('tokens', { ...previous, ...result, refresh_token: result.refresh_token || previous.refresh_token, expiresAt: Date.now() + result.expires_in * 1000 });
    return result.access_token;
  }
  async function accessToken(force = false) {
    const tokens = store.get('tokens');
    if (!tokens?.refresh_token) throw new Error('Connect Spotify first');
    if (!force && tokens.expiresAt > Date.now() + 60000) return tokens.access_token;
    if (!refreshPromise) refreshPromise = tokenGrant({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).finally(() => { refreshPromise = null; });
    return refreshPromise;
  }
  return {
    tokenGrant,
    pco(path) {
      const url = new URL(path, 'https://api.planningcenteronline.com');
      if (url.origin !== 'https://api.planningcenteronline.com') throw new Error('Invalid PCO pagination URL');
      return request(url, { headers: { Authorization: `Basic ${Buffer.from(`${config.pcoId}:${config.pcoSecret}`).toString('base64')}`, 'X-PCO-API-Version': '2018-11-01' } });
    },
    async spotify(path, method = 'GET', body) {
      const url = new URL(path, 'https://api.spotify.com/v1/');
      if (url.origin !== 'https://api.spotify.com' || !url.pathname.startsWith('/v1/')) throw new Error('Invalid Spotify URL');
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return await request(url, { method, headers: { Authorization: `Bearer ${await accessToken(attempt > 0)}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
        catch (error) { if (error.status !== 401 || attempt) throw error; }
      }
    }
  };
}
