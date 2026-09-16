# Web Deployment

OpenFit ships in two shapes from one codebase:

| | Desktop (Electron) | Web (this document) |
|---|---|---|
| Data backend | Electron main process | Stateless BFF in `server/` |
| Providers | Google Health v4, Fitbit legacy | Google Health v4 only |
| Credentials | Entered by the user, OS keychain | Server environment variables |
| Health cache | Encrypted file, survives restarts | Browser tab (`sessionStorage`) |
| AI assistant | Claude / Codex CLI | Not available |
| Persistence | Three encrypted JSON files | **None** |

The React app is identical in both. Only the bridge behind it changes.

## Why there is no database

The server keeps nothing. A sign-in produces one AES-256-GCM sealed cookie that
holds a single value — the Google refresh token. Every sync exchanges that
refresh token for a short-lived access token, calls Google, and returns the
payload straight to the browser. Nothing is written to disk, so the process is
disposable and horizontally scalable, and a server compromise exposes no
historical health data.

Health payloads live only in the browser tab that requested them, in
`sessionStorage`, so switching days does not re-run a 30-request sync. Closing
the tab discards them.

## Architecture

```text
Browser (static SPA)                   BFF (server/, stateless)         Google
  fitbitBridge ──fetch──▶  /api/status
                           /api/auth/start   ──302──▶ accounts.google.com
                           /api/auth/callback ──────▶ oauth2.googleapis.com/token
                           /api/sync          ──────▶ health.googleapis.com/v4
                     ◀── RawFitbitPayload ───
  normalizeFitbitData() ──▶ DashboardData ──▶ views
```

`server/` reuses `electron/google-health-service.cjs` unchanged — that module
depends only on `node:crypto` and global `fetch`, never on Electron. The sync
quality gate in `server/health-sync.mjs` is ported from `electron/main.cjs`.

The server has **no third-party runtime dependencies**; it is Node builtins only.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /api/status` | Connection state. Never returns the client id or any token. |
| `GET /api/auth/start` | Generates `state` + PKCE into a 10-minute sealed cookie, redirects to Google. |
| `GET /api/auth/callback` | Validates `state`, exchanges the code, sets the session cookie, redirects to `/?auth=ok`. |
| `POST /api/sync` | `{date}` → `RawFitbitPayload`. Refreshes the access token per request. |
| `POST /api/auth/disconnect` | Revokes upstream (best effort) and clears the cookie. |

## Google Cloud setup

The existing OAuth client already works — it is a **Web application** client with
a client secret (see `GOOGLE_HEALTH_SETUP.md`). You only need to **add** this
deployment's callback alongside the desktop one:

```text
http://127.0.0.1:42813/oauth/callback              (desktop, keep it)
https://your-deployment.example.com/api/auth/callback   (add this)
```

Scopes are unchanged: the nine `googlehealth.*.readonly` scopes plus `openid`
and `profile`.

## Running it

```bash
cp .env.example .env          # fill in the three required values
npm ci
npm run build:web             # emits dist-web/
npm start                     # serves dist-web/ and /api on PORT
```

Local development with live reload:

```bash
npm run dev:web-app           # vite dev server + BFF, /api proxied
```

Without Google credentials, run against generated data:

```bash
MOCK_HEALTH=1 SESSION_SECRET=$(openssl rand -hex 32) npm start
```

`MOCK_HEALTH=1` auto-approves the OAuth flow and serves a payload shaped exactly
like a real Google sync, so the entire path — bridge, quality gate,
normalization, every view — runs without network access.

### Deploying to Fly.io

`fly.toml` is committed; secrets are not, and must never be. From a checkout:

```bash
fly launch --no-deploy --copy-config --name <your-app-name>

fly secrets set \
  GOOGLE_CLIENT_ID=... \
  GOOGLE_CLIENT_SECRET=... \
  SESSION_SECRET="$(openssl rand -hex 32)" \
  OAUTH_REDIRECT_URI=https://<your-app-name>.fly.dev/api/auth/callback

fly deploy
```

Then add that same callback to the Google OAuth client's **Authorized redirect
URIs**, alongside the desktop one — both can live on the one client:

```text
http://127.0.0.1:42813/oauth/callback                 ← desktop, keep
https://<your-app-name>.fly.dev/api/auth/callback     ← add
```

`OAUTH_REDIRECT_URI` and the registered URI must match character for character,
including the scheme and the `/api/auth/callback` path.

Two notes on the config: `min_machines_running = 1` keeps a machine warm,
because a cold start in the middle of a 10–20 second sync is a poor first
impression; and `TRUST_PROXY=1` is required because Fly terminates TLS at the
edge — without it the session cookie never gets its `Secure` attribute.

### There is no application login

The app authenticates you to *Google*; it has no account system of its own.
Anyone who finds the URL sees the demo dashboard, and pressing connect sends
them to their own Google account — which, while the Cloud project is in
*Testing*, only returns data for accounts registered as test users. Each visitor
gets their own cookie and their own data, so this is not a leak. If you would
rather nobody else even sees the demo, put basic auth at the edge or keep the
machine on a private network.

Docker:

```bash
docker build -t openfit-web .
docker run -p 42814:42814 --env-file .env openfit-web
```

## Security

- Session and OAuth-flow cookies are `HttpOnly; Secure; SameSite=Lax`. `Lax`
  rather than `Strict` because the cookie must survive Google's redirect back.
- No access token, refresh token, or client secret ever reaches the browser.
- `state` and the PKCE verifier are validated server-side; the verifier is never
  sent to the client.
- CSP is stricter than the desktop app's: `connect-src 'self'` only, because the
  browser never calls Google directly.
- Static file paths are resolved and then confirmed to be inside `dist-web/`, so
  `../` traversal falls back to `index.html` instead of leaking files.
- `SESSION_SECRET` must be a real 32-byte key; a short password is rejected at
  startup rather than silently stretched.

## Derived scores on the web

The derived scores behave slightly differently here, because they read a
multi-day archive that the desktop app keeps encrypted on disk and the web app
keeps in `sessionStorage` — which starts empty in every new tab.

| Score | Web behaviour |
|---|---|
| Recovery, Day Strain, Sleep Performance, Sleep Debt, Sleep Need | Available from the first sync — they read `data.trends`, which carries 14 days in every payload. |
| Sleep Consistency, Weekly Assessment, Max Heart Rate | Hidden until the tab has synced enough days, since they need sleep timestamps and readings that only the archive holds. |

They fill in as you browse back through days. Pre-syncing a week on connect
would fix it, but multiplies a 10–20 second sync by fourteen, so the scores stay
honestly hidden instead.

## Known limits

1. **Refresh tokens expire after 7 days while the Google project is in
   *Testing* mode**, so users must reconnect weekly. Moving to production with
   health scopes requires Google verification and a third-party security
   review. This is the main blocker for distributing the web app beyond
   personal use, and it is not a technical one.
2. **Cold start cost.** With no server cache, the first sync in a new tab runs
   ~30 upstream requests and takes roughly 10–20 seconds. Subsequent day changes
   in the same tab are served from `sessionStorage`.
3. **Per-endpoint sync progress is not reported.** The BFF returns one response,
   so the UI shows an indeterminate spinner. Adding SSE would restore the
   detailed progress bar.
4. **Fitbit legacy is desktop-only.** `electron/fitbit-legacy-service.cjs` is not
   wired into the web app.
5. **Shared API quota.** All web users authenticate through one OAuth client, so
   they share its Google Health rate limit, and each must be a registered test
   user while the project stays in *Testing*.
