# Skyline

**Everything moving above our world. Every dot tells a story.**

Skyline is an interactive 3D Earth and orbital-object explorer built on **genuine CelesTrak
General Perturbations data** with **SGP4** propagation. Explore real satellites, orbital motion,
space debris, historical fragmentation events — and replay a satellite's pass across *your* sky,
with honest labels on every number.

Built for the PHS Hackathon (repository: `akulbajpai-code/SkyLine`).

---

## Quick start

Requirements: Node.js ≥ 20 (tested on 22).

```bash
npm install
npm run build          # typecheck + production build into dist/
npx wrangler pages dev dist --port 8788 --ip 0.0.0.0
# open http://localhost:8788
```

That single `wrangler pages dev` process serves the frontend **and** the real Cloudflare Pages
Functions API — the same runtime that ships to production.

For frontend iteration you can instead run the Vite dev server (`npm run dev`) with the API
separately (`npm run dev:api`); the dev server proxies `/api` to the Pages runtime on port 8788.

New here? Read [`START_HERE.md`](START_HERE.md) for the guided tour.

## What it does

- **Interactive 3D Earth** (Three.js) with a real day/night terminator, night lights, ocean
  specular, illustrative clouds, atmospheric limb and a procedural starfield. Bundled NASA-derived
  textures; graceful fallback if any asset fails.
- **Real catalogues** — 9 CelesTrak groups bundled offline (~30,500 objects: stations, brightest,
  active, Starlink, weather, science and three debris clouds), plus 4 additional groups served live
  when CelesTrak is reachable.
- **Search** over every loaded record: names, NORAD IDs, international designators, keyboard
  navigation.
- **Satellite inspector** separating **source elements** (CelesTrak GP), **calculated position**
  (SGP4 at a stated instant) and **derived properties** (documented formulas), with units, datum
  notes and element-age warnings.
- **Orbit path & ground track** from the same propagation + frame transforms as the markers, with
  the antimeridian handled correctly.
- **Orbit-to-Observer Replay** — the signature workflow. Select an object and an observer, predict
  overhead passes, then scrub one shared clock through the pass while the globe marker, the
  local-sky chart, azimuth/elevation/range readouts and observing conditions move together.
- **Sky Conditions** — observer presets (Princeton NJ, New York, London, Tokyo, Sydney, Reykjavík),
  custom coordinates, explicit-only browser geolocation, solar altitude, darkness category,
  Open-Meteo cloud context and a transparent observing-opportunity heuristic.
- **Space Weather** — NOAA planetary Kp measurements with history chart, plain-language G-scale
  explanation and honest stale/unavailable states.
- **Debris events** — documented 2007 Fengyun-1C, 2009 Iridium 33 / Cosmos 2251 and 2021 Cosmos
  1408 explainers with explorable debris clouds where published groups exist, and explicit
  "current data, not time travel" labelling.
- **How It Works** — the three-stage pipeline, a real-vs-estimated ledger, limitations and full
  attribution.
- **Honest data states**: `live` / `cached` / `stale` / `snapshot`, derived from actual retrieval
  metadata — never hardcoded. Failures say what failed and what is shown instead.

## Architecture

```
CelesTrak GP JSON ──► Cloudflare Pages Function /api/gp ──► cache (Cache API)
        │                     │  validation · allowlist · timeout · retry      │
        │                     ▼                                                ▼
        │              catalog records (verbatim) ──► propagation worker (SGP4)
        │                     │                            │
        └── offline snapshot  │                            ▼
            (data/snapshot)   ▼                     TEME ──gmst──► ECEF ──► Three.js scene
                     └─ served as `snapshot`? ──► one browser-direct CelesTrak
                        attempt, same validation, labelled `live` only if real
                          React UI (search · inspector · replay · sky · health · time)

Open-Meteo ──► /api/weather (lat/lon validated, 30-min cache) ──► cloud context
NOAA SWPC  ──► /api/kp (15-min cache) ──► Kp chart
```

| Layer | Where | Notes |
|---|---|---|
| Frontend | `src/` (React + Vite) | Small observable store (`src/state/`), hash routing (`src/ui/routes.ts`) |
| 3D scene | `src/globe/` | Three.js; one draw call for the whole catalogue |
| Orbital math | `src/orbital/` | SGP4; frames, derived values, orbit/ground-track generation |
| Observer math | `src/orbital/observer.ts` | Look angles, eclipse, solar conditions, pass search, viewing heuristic |
| Propagation worker | `src/workers/propagator.worker.ts` | Off-main-thread catalogue propagation |
| API | `functions/api/` (Pages Functions) | `/api/health`, `/api/gp`, `/api/weather`, `/api/kp`; unit-tested |
| Data | `data/snapshot/` | Verbatim CelesTrak GP JSON + SHA-256 provenance manifest |
| Shared contracts | `shared/` | Group registry, freshness policy, API types |

**Frame & unit conventions** (full statement in `src/orbital/constants.ts`): SGP4 outputs TEME;
Earth rotation is applied exactly once (GMST) to reach ECEF; the Three.js scene is Earth-fixed
with `scene = (ecef.x, ecef.z, −ecef.y)`, one scene unit = 6371 km. Latitudes/altitudes are WGS-84
geodetic; orbit-shape parameters follow the WGS-72 constants SGP4 is defined on. Azimuth is
clockwise from true north; elevation is above the local horizon.

## Data model & honesty rules

The API derives one of four states from metadata (see `shared/freshness.json`):

| State | Meaning |
|---|---|
| **live** | CelesTrak fetched within the freshness window (2 h) |
| **cached** | genuine CelesTrak data ≤ 24 h old (a refresh was attempted and failed) |
| **stale** | genuine CelesTrak data older than 24 h, still served, clearly marked |
| **snapshot** | the bundled offline dataset — genuine records, never current |

- Records are never edited, synthesised or reordered. Each group file's SHA-256 is recorded in
  `data/snapshot/manifest.json`.
- A failed propagation produces **no position** — never invented coordinates.
- Positions are SGP4 **predictions** from published elements; the inspector states element age and
  an along-track drift estimate so users can judge prediction quality.
- Pass predictions are geometric; the observing score is a disclosed heuristic, not a probability.
- Skyline is an **educational visualization**, not an operational space-safety system.

## Testing

```bash
npm test               # 106 unit/integration tests (vitest)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run build          # production build
CHROME_PATH=/path/to/chromium npm run test:e2e   # real-browser end-to-end (needs a running server)
node scripts/verify-live.mjs                      # genuine CelesTrak connectivity check (needs internet)
```

The scientific core is verified against **independent implementations**: `tools/skyfield-reference.py`
re-propagates the same element sets with Python's canonical Vallado SGP4 and skyfield's geodetic
solution; `tests/orbital-reference.test.ts` compares this application's pipeline against those
reference states. Look-angle math is cross-checked against satellite.js's own `ecfToLookAngles` in
`tests/observer.test.ts`. See `docs/TESTING.md` for the full matrix and the live-path verification
procedure.

## Deployment (Cloudflare Pages)

```bash
npm run build
npx wrangler pages deploy dist        # from a machine with Cloudflare credentials
```

or connect the repository in the Cloudflare Pages dashboard: build command `npm run build`, output
directory `dist`. The `functions/` directory is deployed automatically. No paid resources are required
(no KV, no Durable Objects — caching uses the Cache API). Full guide: `docs/DEPLOY.md`.

## Documentation

- `START_HERE.md` — guided tour for new contributors
- `docs/ARCHITECTURE.md` — data pipeline, frames/units, cache & refresh policy
- `docs/DEPLOY.md` — Cloudflare setup, environment variables, production verification
- `docs/TESTING.md` — test matrix, tolerances, live-path procedure
- `docs/CREDITS.md` — data and texture attribution/licensing
- `docs/DEMO.md` — 3-minute demo script for judges
- `CREDITS.md` — project credits and AI-use summary pointer
- `AI_USE_LOG.md` — truthful record of AI assistance
- `FEATURE_COMPLETENESS_AUDIT.md` — requirement-by-requirement audit with evidence

## Limitations (honest)

- Positions are SGP4 predictions, not tracking observations. Accuracy degrades with element age
  (shown in the UI) and space weather.
- The bundled snapshot groups were captured at different times (see `data/snapshot/manifest.json`);
  groups marked **snapshot** are not current.
- The API rate limit is per-isolate (documented backstop, not a global quota).
- Cache API storage is per-data-centre and best-effort; a cold cache simply triggers a fresh fetch.
- Open-Meteo and NOAA feeds are advisory; when unreachable, the UI shows unavailable states and
  everything else keeps working.
- In the development sandbox used for this build, outbound access to `celestrak.org`,
  `api.open-meteo.com` and `services.swpc.noaa.gov` is blocked and no browser is installed, so the
  live-retrieval paths were verified with deterministic tests, injected-fetch tests and a real Pages
  runtime, while browser end-to-end and genuine-connectivity checks remain for a machine with
  internet access and Chrome (see `FEATURE_COMPLETENESS_AUDIT.md` for exactly what was and was not
  verified here).

## Licence

Application code: MIT. Data: CelesTrak GP (public data, see usage policy). Textures: NASA-derived,
see `docs/CREDITS.md`.
