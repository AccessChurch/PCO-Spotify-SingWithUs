# Planning Center → Spotify

Railway-ready Node.js 24 service for **PCO service type 10670** → **Spotify playlist 343fIBIyCNoLx4aoKoqtPt**. No npm dependencies.

## Behavior

- Reads plans in descending `sort_date` order and includes dates in `[now − 180 × 24 hours, now]`. Future plans are excluded. This uses PCO's first-service-time `sort_date`, not plan creation date; multi-day plans are included according to that first time.
- Paginates plans and items; deduplicates by **PCO Song ID**, never by title. Orders songs by most recent use. If two approved PCO IDs map to the same Spotify recording, includes that URI only once.
- Search results are suggestions only. Each recording must be explicitly approved, using search or a pasted Spotify track URL/URI/ID. Approved mappings survive restarts and remain available when songs return in later months.
- **Monthly on the last Wednesday at 10:00 a.m. America/New_York**, with DST handling. Change `SYNC_TIMEZONE` and `SYNC_HOUR` if needed. Uses an in-process scheduler on a continuously running Railway service, not a Railway cron job. It records one attempt per calendar month and catches up after downtime within that month. Failed/blocked attempts require a manual Sync now or wait until next month; the UI shows the outcome.
- Publishing starts **disabled**. Enable it only after reviewing the mappings. Any missing approval, source API failure, or empty result blocks all playlist writes. Discovery and approvals alone never change Spotify.
- Successful publishing replaces playlist contents, removing songs outside the rolling window. It backs up the existing ordered URIs and snapshot before writing, uses batches of at most 100, and verifies the result. No empty clearing request is sent.
- Spotify does not provide atomic multi-request replacement. An interrupted or ambiguous write can leave a partial playlist; a durable recovery flag blocks subsequent writes. Open Latest playlist backup, inspect Spotify, and acknowledge the interruption. This disables publishing; re-enable and Sync now to rebuild the approved collection, or restore the backup manually. Download a backup before acknowledging if you want to retain it: the next write replaces the latest backup. Local/unavailable playlist items block publishing because they cannot be safely backed up. Avoid concurrent manual playlist edits during sync.

## Railway deployment

1. Upload this project to a Git repository and create a Railway service from it. The included Dockerfile and `railway.json` configure startup and `/health` checks.
2. Attach a **persistent volume at `/data`**. Keep **one replica**, disable sleeping/serverless mode, and leave the service running so the scheduler can execute. Do not configure Railway's cron schedule for this web service.
3. Generate a public HTTPS domain. Set the variables below in Railway. Docker sets `DATA_DIR=/data`; Railway supplies `PORT`.
4. In your Spotify developer app, register the exact callback `https://YOUR-DOMAIN/oauth/callback`.
5. Open the service URL. Sign in with username **admin** and your `ADMIN_PASSWORD`. Connect Spotify as an account able to modify the target playlist.
6. Refresh PCO songs, review and approve the recording for every song, then enable monthly publishing. Use Sync now for the initial approved update if desired.

| Variable | Value |
| --- | --- |
| `BASE_URL` | Your HTTPS origin, e.g. `https://your-app.up.railway.app` |
| `ADMIN_PASSWORD` | A random password of at least 24 characters |
| `PCO_APP_ID` | Planning Center Personal Access Token application ID |
| `PCO_SECRET` | Planning Center Personal Access Token secret |
| `SPOTIFY_CLIENT_ID` | Spotify developer application client ID |
| `SPOTIFY_CLIENT_SECRET` | Spotify developer application client secret |
| `PCO_SERVICE_TYPE_ID` | Defaults to `10670` |
| `SPOTIFY_PLAYLIST_ID` | Defaults to `343fIBIyCNoLx4aoKoqtPt` |
| `DATA_DIR` | `/data` on Railway; `./data` locally |
| `SYNC_TIMEZONE` | Defaults to `America/New_York` |
| `SYNC_HOUR` | Defaults to `10`, local hour 0–23 |

Create the PCO personal access token through the [PCO developer account](https://api.planningcenteronline.com/oauth/applications). Its user must be able to read the service type and plan orders. Create the Spotify application through the [Spotify dashboard](https://developer.spotify.com/dashboard). Spotify Development Mode currently requires the app owner to have Premium and the connecting account to be permitted by the app; playlist item reads are limited to owned/collaborative playlists. See the [current migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).

OAuth uses authorization code flow, expiring browser-bound state, and persistent refresh tokens with rotation support. UI mutations require Basic authentication, same-origin requests, and a CSRF token. `/health` is public; all other endpoints require authentication. Treat the SQLite volume and backups as sensitive: tokens are stored there in plaintext under a private data directory. Do not commit `.env` or `data`. Enable Railway volume backups for disaster recovery. The database is bound to the configured PCO/playlist target to prevent accidentally publishing to a new target after an environment change.

## Local development

Requires Node 24+ (Docker uses Node 24 LTS).

```sh
cp .env.example .env
# Fill credentials; use BASE_URL=http://127.0.0.1:3000
# Register http://127.0.0.1:3000/oauth/callback in Spotify.
npm start
npm test
```

Open `http://127.0.0.1:3000`. No install step is necessary. Spotify accepts explicit loopback IP HTTP redirects for local development, not `localhost`.

## API references checked September 16, 2026

- [PCO plans: sort_date, pagination and ordering](https://api.planningcenteronline.com/docs/apps/services/versions/2018-11-01/vertices/plan)
- [PCO items and included Song relationships](https://api.planningcenteronline.com/docs/apps/services/versions/2018-11-01/vertices/item)
- [Spotify authorization code flow](https://developer.spotify.com/documentation/web-api/tutorials/code-flow)
- [Spotify playlist items](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items)
- [Replace playlist items](https://developer.spotify.com/documentation/web-api/reference/reorder-or-replace-playlists-items) and [add playlist items](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist): current `/v1/playlists/{id}/items` routes
- [Railway persistent volumes](https://docs.railway.com/volumes)

Tests use simulated APIs. A live end-to-end OAuth and playlist write requires your credentials and approved mappings; no real playlist has been modified during development.
