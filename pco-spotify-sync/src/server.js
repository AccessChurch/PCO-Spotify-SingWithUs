import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openStore } from './store.js';
import { makeClients } from './api.js';
import { createSync } from './sync.js';
import { schedulePeriod } from './schedule.js';
const env = process.env;
for (const key of ['BASE_URL', 'ADMIN_PASSWORD', 'PCO_APP_ID', 'PCO_SECRET', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET']) {
  if (!env[key]) throw new Error(`Missing ${key}; see .env.example`);
}
if (env.ADMIN_PASSWORD.length < 24) throw new Error('ADMIN_PASSWORD must have at least 24 characters');
const base = new URL(env.BASE_URL);
if (base.protocol !== 'https:' && !(base.protocol === 'http:' && base.hostname === '127.0.0.1')) throw new Error('BASE_URL must use HTTPS (or http://127.0.0.1 for development)');
const config = { serviceType: env.PCO_SERVICE_TYPE_ID || '10670', playlist: env.SPOTIFY_PLAYLIST_ID || '343fIBIyCNoLx4aoKoqtPt', pcoId: env.PCO_APP_ID, pcoSecret: env.PCO_SECRET, spotifyId: env.SPOTIFY_CLIENT_ID, spotifySecret: env.SPOTIFY_CLIENT_SECRET };
if (!/^\d+$/.test(config.serviceType) || !/^[a-zA-Z0-9]{22}$/.test(config.playlist)) throw new Error('Invalid target ID');
const schedule = { timeZone: env.SYNC_TIMEZONE || 'America/New_York', hour: Number(env.SYNC_HOUR ?? 10) };
if (!Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23) throw new Error('SYNC_HOUR must be 0–23');
schedulePeriod(new Date(), schedule); // Validate timezone at startup.
const store = openStore(env.DATA_DIR || './data');
const target = `${config.serviceType}:${config.playlist}`;
if (store.get('target') && store.get('target') !== target) throw new Error('Persistent database belongs to a different target; use a separate volume');
store.set('target', target);
const clients = makeClients(config, store), sync = createSync(config, store, clients);
const callback = `${base.origin}/oauth/callback`;
const csrf = randomBytes(32).toString('hex');
const scopes = 'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private';
const html = readFileSync(new URL('../public/index.html', import.meta.url));
const js = readFileSync(new URL('../public/app.js', import.meta.url));
function equal(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function authorized(req) {
  const encoded = req.headers.authorization?.match(/^Basic (.+)$/)?.[1];
  return encoded && equal(Buffer.from(encoded, 'base64').toString(), `admin:${env.ADMIN_PASSWORD}`);
}
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 16384) throw new Error('Request too large'); }
  return JSON.parse(text || '{}');
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const redirect = location => { res.writeHead(302, { Location: location }); res.end(); };
  try {
    const url = new URL(req.url, base);
    if (req.method === 'GET' && url.pathname === '/health') return send({ ok: true });
    if (!authorized(req)) { res.setHeader('WWW-Authenticate', 'Basic realm="PCO Spotify Sync"'); return send({ error: 'Authentication required' }, 401); }
    if (req.method === 'POST') {
      if (req.headers.origin !== base.origin || !equal(String(req.headers['x-csrf-token'] || ''), csrf)) return send({ error: 'Invalid request origin or CSRF token' }, 403);
    }
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); }
    if (req.method === 'GET' && url.pathname === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(js); }
    if (req.method === 'GET' && url.pathname === '/api/status') return send({ csrf, target, songs: store.get('songs', []), mappings: store.get('mappings', {}), connected: !!store.get('tokens')?.refresh_token, enabled: store.get('enabled', false), discoveredAt: store.get('discoveredAt'), lastRun: store.get('lastRun'), recovery: store.get('writeInProgress'), busy: sync.busy, schedule: `last Wednesday each month at ${String(schedule.hour).padStart(2, '0')}:00 ${schedule.timeZone}` });
    if (req.method === 'GET' && url.pathname === '/api/backup') return send(store.get('backup'));
    if (req.method === 'POST' && url.pathname === '/api/connect') {
      const state = randomBytes(32).toString('hex');
      store.set('oauthState', { state, expires: Date.now() + 600000 });
      res.setHeader('Set-Cookie', `oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/oauth/callback; Max-Age=600${base.protocol === 'https:' ? '; Secure' : ''}`);
      return send({ url: `https://accounts.spotify.com/authorize?${new URLSearchParams({ client_id: config.spotifyId, response_type: 'code', redirect_uri: callback, state, scope: scopes })}` });
    }
    if (req.method === 'GET' && url.pathname === '/oauth/callback') {
      const saved = store.get('oauthState');
      const cookie = req.headers.cookie?.split('; ').find(x => x.startsWith('oauth_state='))?.slice(12);
      if (!saved || saved.expires < Date.now() || !equal(url.searchParams.get('state') || '', saved.state) || !equal(cookie || '', saved.state)) throw new Error('Invalid or expired OAuth state; reconnect');
      store.set('oauthState', null);
      res.setHeader('Set-Cookie', `oauth_state=; HttpOnly; SameSite=Lax; Path=/oauth/callback; Max-Age=0${base.protocol === 'https:' ? '; Secure' : ''}`);
      if (!url.searchParams.get('code') || url.searchParams.has('error')) throw new Error('Spotify authorization was not completed');
      await clients.tokenGrant({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: callback });
      return redirect('/');
    }
    if (req.method === 'POST' && url.pathname === '/api/discover') { await sync.exclusive(sync.discover); return send({ ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/search') {
      const { query } = await body(req);
      if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('Enter a search query');
      const result = await clients.spotify(`search?${new URLSearchParams({ q: query, type: 'track', limit: '10' })}`);
      return send(result.tracks?.items || []);
    }
    if (req.method === 'POST' && url.pathname === '/api/approve') {
      const { songId, track } = await body(req);
      await sync.exclusive(async () => {
        if (!store.get('songs', []).some(x => x.id === songId)) throw new Error('Unknown PCO Song ID; discover first');
        const match = String(track).match(/^(?:spotify:track:|https:\/\/open\.spotify\.com\/track\/)?([A-Za-z0-9]{22})(?:\?[^\s]*)?$/);
        if (!match) throw new Error('Enter a Spotify track URL, URI, or ID');
        const item = await clients.spotify(`tracks/${match[1]}`);
        if (item.type !== 'track' || item.is_local || item.is_playable === false || item.restrictions || !item.uri) throw new Error('Track is unavailable');
        const mappings = store.get('mappings', {});
        mappings[songId] = { uri: item.uri, name: item.name, artists: item.artists.map(x => x.name).join(', '), approvedAt: new Date().toISOString() };
        store.set('mappings', mappings);
      }); return send({ ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/revoke') {
      const { songId } = await body(req);
      await sync.exclusive(async () => { const mappings = store.get('mappings', {}); delete mappings[songId]; store.set('mappings', mappings); }); return send({ ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/enable') {
      const { enabled } = await body(req);
      if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
      await sync.exclusive(async () => store.set('enabled', enabled)); return send({ ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/recover') {
      await sync.exclusive(async () => { store.set('enabled', false); store.set('writeInProgress', null); }); return send({ ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/sync') { await sync.run(); return send({ ok: true }); }
    send({ error: 'Not found' }, 404);
  } catch (error) { send({ error: error.message }, 400); }
});
// One persistent attempt per month. Catch up on restart after this month's due time.
async function tick() {
  const period = schedulePeriod(new Date(), schedule);
  if (!period || store.get('scheduledPeriod') === period || sync.busy) return;
  store.set('scheduledPeriod', period);
  try { await sync.run(); } catch (error) { console.error('Scheduled sync:', error.message); }
}
server.listen(Number(env.PORT || 3000), '0.0.0.0', () => { console.log(`Listening; monthly sync on last Wednesday at ${schedule.hour}:00 ${schedule.timeZone}`); void tick(); });
const timer = setInterval(() => void tick(), 60000);
process.on('SIGTERM', () => { clearInterval(timer); server.close(() => process.exit(0)); });
