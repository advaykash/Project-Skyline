# AI-use log

Truthful record of AI assistance on Skyline. The repository owner directed the work, reviewed the
results and remains responsible for the submission.

## Sessions

### Session 1 — Foundation (prior work, "OrbitWatch" phase)

- AI assistance produced the initial working application: CelesTrak GP ingestion through
  Cloudflare Pages Functions, SGP4 propagation (worker + main thread), the Three.js globe, search,
  inspector, orbit/ground-track generation, simulation clock, snapshot fallback, and the first 75
  unit/integration tests with an independent skyfield reference check.
- Human direction: product scope, honesty rules, architecture review, test witnessing.

### Session 2 — Skyline transformation (this session, 2026-10-11)

AI coding agent (Arena.ai Agent Mode) working autonomously under a master engineering directive:

- **Rebrand** OrbitWatch → Skyline (UI, metadata, package, API service name, docs).
- **New science**: `src/orbital/observer.ts` — closed-form look angles, solar altitude, darkness
  categories, cylindrical-shadow eclipse test, bisection/golden-section pass search, transparent
  viewing heuristic; cross-checked against satellite.js reference functions.
- **New API**: `/api/weather` (Open-Meteo proxy) and `/api/kp` (NOAA proxy) with allowlisted
  upstreams, validation, short edge caches and honest 502s.
- **New experience**: hash-routed app shell (Home, Explorer, Sky & Passes, Space Weather, Debris
  Events, How It Works), Orbit-to-Observer Replay with canvas sky chart, observer presets/custom/
  geolocation, Kp chart, historical event education, hero and design system.
- **Quality**: 31 new tests (106 total), propagated-types strictness, lint-clean, SSR render smoke
  tests, full replay-path smoke test on real snapshot data, e2e scripts updated for the new UI,
  production build verified in the real Pages runtime (`wrangler pages dev`), endpoint behaviour
  verified with curl (snapshot + validation + honest-failure paths).
- **Docs**: README, START_HERE, CREDITS, this log, demo/architecture/testing updates, and
  `FEATURE_COMPLETENESS_AUDIT.md`.
- Human direction: the master directive itself; deployment credentials and the public-site
  verification remain human actions (see `docs/DEPLOY.md` and the audit).

## What AI did not do

- No credentials were created, requested or stored; no deployment was published (no Cloudflare
  access from the sandbox).
- No browser testing was performed here (no browser installed; outbound network restricted) —
  recorded honestly in the audit as requiring a machine with Chrome + internet.
- No live-data claims beyond what was actually observed: upstream fetches fail in this sandbox,
  so live paths were verified via deterministic tests and injected-fetch doubles, and the bundled
  snapshot path was verified in the real runtime.

## Disclosure

Hackathon judges can verify every claim: run `npm test`, `npm run build`, serve `dist/` with
`wrangler pages dev`, and compare the audit file against the running app.
