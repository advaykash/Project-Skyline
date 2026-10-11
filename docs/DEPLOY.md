# Deploying OrbitWatch to Cloudflare Pages

OrbitWatch's backend is implemented as **Cloudflare Pages Functions** (`functions/api/*`) and the
frontend is a static Vite build (`dist/`). Both are served from the same origin — no CORS, no
separate backend host, no Node.js server.

## One-time setup

1. Create a Cloudflare Pages project (dashboard or `wrangler pages project create orbitwatch`).
2. Either connect the Git repository or deploy directly:

**Option A — Git integration (recommended)**

| Setting | Value |
|---|---|
| Production branch | `main` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | *(repository root)* |

Pages detects `functions/` automatically. The repository ships `.nvmrc` (Node 22) and an
`engines` field, so Pages selects a compatible Node version without extra configuration.

**Option B — Direct upload**

```bash
npm install
npm run build
npx wrangler pages deploy dist --project-name orbitwatch
```

Requires Cloudflare credentials (`wrangler login` or `CLOUDFLARE_API_TOKEN`). Never commit
credentials to this repository.

## Runtime configuration

`wrangler.toml` pins the compatibility date and the output directory. Environment variables
consumed by `functions/api/_lib/context.ts`:

| Variable | Default | Purpose |
|---|---|---|
| `CELESTRAK_BASE` | `https://celestrak.org` | Upstream base URL. Configuration only — **never** taken from a request. Point it at a test double in CI. |
| `UPSTREAM_TIMEOUT_MS` | `6000` | Bounded upstream request timeout. |
| `UPSTREAM_DISABLED` | *(unset)* | `1`/`true` disables upstream fetching entirely; the API then serves the offline snapshot and says so. |

No secrets are required at runtime. The application never sends credentials anywhere.

## What the deployment contains

- `dist/assets/*` — hashed JS/CSS bundles (three.js chunked separately from React)
- `dist/textures/*` — bundled Earth textures (no runtime CDN dependency)
- `dist/snapshot/*` — the offline CelesTrak GP dataset + provenance manifest (copied by the build)
- `functions/api/health.ts` → `GET /api/health`
- `functions/api/gp.ts` → `GET /api/gp?group=<id>`

## Caching & refresh policy

- Per-group Cache API entries under `/__orbitwatch-cache/gp/<group>`, carrying retrieval-time and
  SHA-256 metadata in headers.
- Upstream is contacted at most once per group per 2 hours per data centre (CelesTrak's guidance),
  or after a cache miss/expiry. Failed refreshes keep serving the last genuine payload.
- Documented limitation: the Cache API is per-data-centre and best-effort; it is not a distributed
  lock. The bundled snapshot covers cold-start + upstream-outage.

## Production verification checklist

Run these against the deployed URL (`https://<project>.pages.dev`):

```bash
# 1. Health: structured metadata, per-group states
curl -s https://<project>.pages.dev/api/health | python3 -m json.tool | head -40

# 2. Catalogue: real records + explicit provenance
curl -s "https://<project>.pages.dev/api/gp?group=stations" | python3 -c \
  "import json,sys; d=json.load(sys.stdin); print(d['state'], d['recordCount'], d['provenance']['retrievedAt'], d['provenance']['note'][:80])"

# 3. Input validation
curl -s -o /dev/null -w '%{http_code}\n' "https://<project>.pages.dev/api/gp"            # expect 400
curl -s -o /dev/null -w '%{http_code}\n' "https://<project>.pages.dev/api/gp?group=x"    # expect 400

# 4. End-to-end UI (from any machine with Chrome + npm):
CHROME_PATH=/usr/bin/google-chrome node tests/e2e/run.mjs https://<project>.pages.dev screenshots-prod
```

In production the expected state is `live` for every group (CelesTrak is reachable from Cloudflare),
and `x-orbitwatch-state: live` on `/api/gp` responses. If the deployment reports `snapshot`, the
upstream fetch is failing — check the `upstream.lastError` field of `/api/health`.

## Direct navigation & refresh

The site is a single-page app with no client-side routes: direct navigation and refresh both load
`index.html` and re-fetch the catalogue. No rewrite rules are required.
