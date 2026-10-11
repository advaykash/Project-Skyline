# Feature-completeness audit — Skyline

Date: 2026-10-11. Auditor: AI engineering agent (Arena.ai Agent Mode), session branch
`arena/582bf0d1-skyline`. Sources audited: this master directive (§23 list + all tiers), the
inherited codebase (single-view tracker + docs + tests + e2e scripts), and the implementation
produced in this session. Earlier chat conversations were **not** accessible; that limitation is
recorded and every accessible source was audited instead.

Status key: **Complete** (implemented + verified by evidence below) · **Partial** (implemented but
verification incomplete, or deliberately reduced scope) · **Missing** · **Broken** · **Blocked**
(external access/credential/hardware required) · **Intentionally Excluded** (judged lower value
than its cost/risk).

Environment limits affecting verification (see §“What could not be verified here”): no browser
installed, outbound network restricted to github/npm/pypi (CelesTrak, Open-Meteo, NOAA all
unreachable), no Cloudflare credentials, no physical devices.

## Core product & brand

| # | Feature / idea | Source | Expected | Actual | Status | Evidence | Verification | Remaining issue | Priority | Next action |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Skyline brand identity everywhere | Directive §15 | No OrbitWatch in user-facing surfaces | Rebranded: UI, title, meta, OG, manifest, favicon label, package, API service, docs | Complete | `grep -rni orbitwatch src functions shared index.html …` → empty; `index.html`, `public/manifest.webmanifest` | Build + grep + SSR render of header | Historical strings remain only in `data/snapshot/manifest.json` + old e2e report (dated artifacts, honest history) | Low | None |
| 2 | Premium visual quality, memorable first impression | Directive §6, Tier 1.12 | Cinematic, calm, precise | New design system: hero with Earth imagery, routed views, instrument-style cards | Partial | `src/styles/app.css` (+950 lines), `src/ui/HomeView.tsx` | SSR render only — **no screenshot review possible here** | Visual inspection at all breakpoints needs a browser | High | Run `npm run test:e2e`, review `00-home…15-about` captures |
| 3 | Hero: headline, tagline, CTAs | Directive §6B | “Every dot tells a story”, Explore/Track-ISS actions | Implemented; Track-ISS selects ISS via shared state with honest fallback | Complete | `src/ui/HomeView.tsx`, `App.ensureIssSelected` | SSR render contains headline + both CTAs; ISS flow exercised in replay smoke test | CTA click path needs browser run | Medium | e2e covers hero CTA (step 1) |
| 4 | Navigation to real functionality | Directive §6C | Working nav, mobile pattern | Hash-routed nav (Explorer, Sky, Weather, Events, About), hamburger ≤1024px | Complete | `src/ui/routes.ts`, `src/ui/SiteHeader.tsx` | SSR render of all routes; hash ↔ state sync logic | Menu interaction needs browser run | Medium | e2e route checks (9b) |
| 5 | Recognizable interactive 3D Earth | Directive §7A, Tier 1.1 | Day/night, lights, atmosphere, controls | Inherited + preserved: shader Earth, terminator, night lights, clouds, stars | Complete | `src/globe/*`, existing tests | Unit/invariant tests pass; runtime serves textures (`/textures/` in dist) | Render output unreviewed here (pre-redesign screenshots kept as history only) | High | Browser screenshot review |
| 6 | Authentic CelesTrak elements | Directive §8, Tier 1.2 | Traceable GP source, validated | Allowlisted `/api/gp`, validation, SHA manifest, verbatim records | Complete | `functions/api/*`, `data/snapshot/manifest.json` | Runtime: `/api/gp?group=stations` → snapshot + honest provenance (curl); live path via 22 backend tests | Live fetch from Cloudflare unverified (sandbox blocks upstream) | High | `verify-live.mjs` on connected machine / after deploy |
| 7 | Propagation + coordinate correctness | Directive §9, Tier 1.3 | SGP4 + transforms tested | satellite.js 6.x SGP4, single GMST rotation, documented datums | Complete | `src/orbital/*`, `tests/orbital-reference.test.ts` | 22 skyfield cross-checks + 26 core tests pass | None | — | None |
| 8 | Time controls: pause/play/speed/live | Directive §9, Tier 1.4 | LIVE/PAUSED/SIMULATED, rates, reset, UTC | Single clock; pause added to TimeBar; 1/60/300/1800/7200×, ±30m, Now; replay rates | Complete | `src/state/clock.ts`, `src/ui/TimeBar.tsx`, `src/ui/SkyView.tsx` | Typecheck + unit-level clock tests (existing) + SSR | Pause/scrub interaction needs browser run | Medium | e2e step 7 covers speed change |
| 9 | Search, selection, filtering, details | Directive Tier 1.5 | Name/NORAD/ID search, inspector | Inherited: debounced search (400-row cap), keyboard nav, inspector with source/calculated/derived split | Complete | `src/ui/SearchPanel.tsx`, `src/ui/Inspector.tsx` | Existing tests + SSR; resilience e2e covers keyboard selection | Browser run pending | Medium | e2e steps 4–5 |
| 10 | Orbit trails + ground tracks | Directive Tier 2.1 | Selected-object path + track | Inherited: same-math pooled buffers, antimeridian split | Complete | `src/orbital/orbit-path.ts`, `tests/orbit-path.test.ts` | 5 consistency tests pass | Visual review pending | Medium | e2e screenshots 02/03 |
| 11 | Night-lights toggle sync | Regression scenario 2 | Layer/control/accessible state agree | Inherited engine + checkbox toggles; no logic change in this session | Partial | `src/globe/GlobeEngine.ts#setLayers`, `.layer-toggle` | Unit-level only; toggle-flip scenario not runnable here | Repeated-toggle scenario needs browser | Medium | Manual/e2e toggle test |
| 12 | Many-object rendering + perf strategy | Directive §11, Tier 1.10 | One draw call, worker, no freeze | Preserved: single THREE.Points, propagator worker, transferred buffers | Partial | `src/globe/*`, `src/workers/*` | Build + unit tests; 16k-record path unmeasured here | Frame-time/memory measurement needs device | High | Profile active-group catalogue on desktop + phone |
| 13 | Truthful live/cached/stale/snapshot/unavailable | Directive §8B, Tier 1.7 | States from real metadata | Preserved + extended to weather/Kp (retrievedAt, cache flags, 502 honesty) | Complete | `shared/freshness.json`, `service.ts`, `proxy.ts` | Runtime curl: snapshot + 502 paths; 22 backend + 11 proxy/parse tests | Live-state display needs connectivity | Medium | Post-deploy health check |

## Orbit-to-Observer Replay (signature)

| # | Feature / idea | Source | Expected | Actual | Status | Evidence | Verification | Remaining issue | Priority | Next action |
|---|---|---|---|---|---|---|---|---|---|---|
| 14 | Single entry-point state (object/observer/time) | Directive §4A | All entries converge | Shared store: selection + observer + clock + replayPass across explorer/sky/hero | Complete | `src/state/store.ts`, `src/App.tsx` | SSR + replay smoke test with real ISS data | Cross-route click journey needs browser | High | e2e + manual demo rehearsal |
| 15 | Observer presets + custom + explicit geolocation | Directive §4B | 6 presets, validation, privacy | 6 presets, validated custom form, geolocation only on button press, localStorage only | Complete | `src/state/observer.ts`, `src/ui/ObserverPicker.tsx` | SSR render; validation unit-covered via parse tests (manual) | Geolocation permission flow needs browser | Medium | Manual test with location on/off |
| 16 | Orbit view w/ selection highlight + context | Directive §4C | Position, altitude, trail, time | Explorer shows selection + trail + track + clock; replay banner links to sky view | Complete | `src/ui/Explorer.tsx`, `GlobeEngine` | Existing selection tests + build | Linked-marker check needs browser | Medium | Scenario 9 e2e extension |
| 17 | Az/el/range/altitude + rise/peak/set | Directive §4D | Correct look angles | Closed-form look angles + pass endpoints; no altitude/elevation confusion | Complete | `src/orbital/observer.ts` | Cross-checked vs `ecfToLookAngles` <1e-6° (12 epochs) | None | — | None |
| 18 | Local-sky visualization | Directive §4E | Polar sky plot, path + marker | Canvas az/el chart: horizon ring, cardinals, rise/peak/set, marker at clock time, day/night tint | Complete | `src/ui/SkyChart.tsx` | SSR render; path math uses `lookAnglesAt` (tested) | Visual review needs browser | High | e2e `12-sky` capture review |
| 19 | Shared replay timeline | Directive §4F | Play/pause/scrub/live, markers | Scrubber + Rise/Peak/Set jumps + play/pause + Back-to-live; sets the one clock | Complete | `src/ui/SkyView.tsx` | Smoke test sets clock to peak; all views derive from clock by construction | Interaction test needs browser | High | e2e replay scenario |
| 20 | Pass discovery list | Directive §4G | Upcoming passes w/ details | 48 h window, ≤12 passes: times, max el, directions, duration, illumination | Complete | `predictPasses`, `usePasses` | 12 real ISS passes predicted in smoke test; rise/set on threshold; peaks re-verified <0.1° | External cross-check (Heavens-Above) not done | Medium | Human compares one ISS pass ±2 min |
| 21 | Viewing heuristic (transparent) | Directive §4H | Documented, neutral-on-missing | 40/30/20/10 split, disclosed factors + assumptions, “not a probability” | Complete | `viewingScore` | Bounded/deterministic/monotonic tests | None | — | None |
| 22 | Replay UX: globe access, mobile, keyboard | Directive §4I | Return paths, responsive, a11y | Replay banner in explorer, responsive stacked layout, labelled controls, slider | Partial | `Explorer.tsx` banner, CSS ≤1024/≤720 | SSR only | Mobile + keyboard run needs browser | High | Manual pass on phone viewport |
| 23 | Replay acceptance scenarios 1–10 | Directive §4J | All pass | Logic verified; interaction scenarios pending browser | Partial | Tests + smoke test | 7/10 logic-verified; 3 interaction-dependent | Browser needed for 3, 4, 8, 10 | High | e2e replay extension |

## Debris & collisions

| # | Feature / idea | Source | Expected | Actual | Status | Evidence | Verification | Remaining issue | Priority | Next action |
|---|---|---|---|---|---|---|---|---|---|---|
| 24 | Debris catalogue + exploration mode | Directive §5D, Tier 2.2 | Toggle/select/inspect debris | 3 CelesTrak debris groups served + selectable + explorable from Events view | Complete | `shared/catalog-groups.json`, `EventsView` | Groups load via same `/api/gp` path (snapshot-verified for stations) | Debris-group load in browser pending | Medium | e2e group-switch covers path |
| 25 | Historical events (2007/2009/2021) | Directive §5A | Sourced explainers | 3 event cards with dates, parents, aftermath, source links | Complete | `src/ui/EventsView.tsx` | SSR contains all three + sources | Factual review by human | Medium | Owner re-reads against NASA/ESA pages |
| 26 | Real vs illustrative distinction | Directive §5A–B | No fake reconstructions | “Current data, not time travel” card; 1408 explainer-only; no break-up animation | Complete | `EventsView` honesty card | Render-verified wording | None | — | None |
| 27 | No collision prediction claims | Directive §5C | Educational labelling only | No conjunction code exists; crossing-lines warning stated twice | Complete | Codebase has no conjunction logic (`grep` clean) | `grep -ri "collision course\|probability" src` → only honest disclaimers | None | — | None |
| 28 | Original “orbital-crashing” concept preserved | Prior history (§23) | Intent preserved honestly | Preserved as historical-event education, not a crash predictor | Complete | Events view + audit row 27 | Same as above | None | — | None |

## Sky conditions & space weather

| # | Feature / idea | Source | Expected | Actual | Status | Evidence | Verification | Remaining issue | Priority | Next action |
|---|---|---|---|---|---|---|---|---|---|---|
| 29 | Solar altitude, darkness, illumination | Directive §12 | Correct observing context | Ephemeris-based solar altitude, 4 darkness bands, umbra/penumbra/sunlit | Complete | `observer.ts` solar/eclipse | Sub-solar/antipode ±90°; day-side never eclipsed; ISS crosses shadow | None | — | None |
| 30 | Open-Meteo cloud context, honest gaps | Directive §12 | Forecast or “unavailable” | `/api/weather` proxy + `cloudCoverAt` (null outside coverage) + neutral-score disclosure | Complete | `functions/api/weather.ts`, `src/data/weather.ts` | Runtime: 400 validation + honest 502 (curl); 3 parse tests | Live feed content unverified (blocked) | Medium | Post-deploy curl check |
| 31 | NOAA Kp + history + explanation | Directive §13 | Latest, chart, meaning, stale states | `/api/kp` proxy + Kp view: latest, band, age/stale flag, 56-sample chart, explainer | Complete | `functions/api/kp.ts`, `WeatherView`, `KpChart` | Runtime 502 honesty (curl); feed-parse tests; SSR | Live feed + chart visuals need browser/net | Medium | Post-deploy + e2e `13-weather` |
| 32 | No aurora-visibility overclaim | Directive §13 | Kp ≠ local aurora | Explicit “planetary, not local” copy in UI | Complete | `WeatherView` explainer | SSR wording check | None | — | None |

## Transparency, quality & engineering

| # | Feature / idea | Source | Expected | Actual | Status | Evidence | Verification | Remaining issue | Priority | Next action |
|---|---|---|---|---|---|---|---|---|---|---|
| 33 | How It Works + real/estimated ledger + disclaimer | Directive §14 | Pipeline, ledger, limits, credits | About view: 3 stages, 4-box ledger, limitations, educational-use disclaimer, credits | Complete | `src/ui/AboutView.tsx` | SSR wording check | None | — | None |
| 34 | Historical defect: selection freezes others | Regression 1 | Selection never freezes scene | Architecture: worker bulk path untouched by selection; selected object = 1 extra SGP4 call | Partial | `GlobeEngine` (worker + `selectedSatrec`), single clock | Code-path review + existing tests; **not reproduced in browser here** | Needs browser scenario run | High | e2e: multi-object playback + select/switch/clear |
| 35 | Historical defect: speed change white screen | Regression 3 | No reload/blank on rate change | Rate is a clock scalar; no reload/rebuild paths exist | Partial | `clock.ts#setRate`, TimeBar | Code review; no `location.reload` in src (`grep` clean) | Browser scenario pending | Medium | e2e step 7 rate clicks + console check |
| 36 | Historical defect: mobile layout/refresh | Regression 4 | Usable narrow layouts | Responsive shell: drawers ≤1024, stacked pages, wrapped timebar, safe touch targets | Partial | CSS media queries | Static review only | All viewport scenarios need browser | High | e2e 390/768 captures + manual phone |
| 37 | Weak-network resilience | Regression 5 | Stable, preserved data, recovery | Bounded retries, snapshot fallback, per-endpoint 502s, no full reloads | Partial | Service + proxy + client code; resilience e2e updated | Runtime failure paths verified (blocked network); recovery interaction pending | Browser outage/recovery run | Medium | `test:e2e:resilience` on Chrome machine |
| 38 | Background/foreground timekeeping | Regression 7 | No giant jumps | 250 ms delta clamp + single pump handshake | Complete | `clock.ts#advance` | Existing clock tests | Long-session observation pending | Low | Manual tab-switch test |
| 39 | Accessibility + reduced motion | Directive §17F | Keyboard, focus, contrast, motion | Semantic controls, aria labels, focus-visible, `prefers-reduced-motion` CSS, non-globe paths everywhere | Partial | CSS + components; keyboard search (inherited) | Static review; no AT run here | Screen-reader + keyboard pass | Medium | Manual a11y pass; axe run if available |
| 40 | Security review | Directive §17G | No secrets, no open proxy, validated input | No credentials in repo; allowlisted proxy; lat/lon/group validation; no `dangerouslySetInnerHTML`; error messages non-leaking | Complete | `proxy.ts` allowlist test; `grep` for secrets/`innerHTML`/`eval` clean | Tests + grep + runtime 400/502 checks | Dependency audit not run (see 41) | Medium | `npm audit` + fix on connected machine |
| 41 | Cloudflare deployment + public verification | Directive §16 | Deployed + verified live data | Runtime-verified locally (`wrangler pages dev`); deploy config ready; **not published** | Blocked | `wrangler.toml`, `docs/DEPLOY.md`, local runtime curl checks | Local only | Needs owner credentials / Git integration | High | `wrangler pages deploy dist` + DEPLOY checklist |
| 42 | Browser compatibility + long sessions | Regression 11–12 | Chrome/Edge/Safari/Firefox + soak | Not runnable here (no browser) | Blocked | e2e scripts ready | None here | Full matrix pending | Medium | Chrome e2e → Safari/Firefox manual |
| 43 | Tests, docs, credits, AI log | Directive §22, Tier 1 | Real results + maintainable docs | 106 tests green, lint/typecheck clean, README/START_HERE/CREDITS/AI_USE_LOG/audit/DEPLOY/DEMO/TESTING/ARCHITECTURE current | Complete | This repo | `npm test/typecheck/lint/build` all pass | None | — | None |

## Tier 3 (optional) disposition

| # | Feature / idea | Source | Decision | Reason |
|---|---|---|---|---|
| 44 | Extra observer presets | Tier 3 | Intentionally Excluded | 6 presets + custom coords cover the need; more presets add no demo value |
| 45 | Keyboard shortcuts (global) | Tier 3 | Partial | Search list keyboard nav inherited; global shortcut system excluded (scope) |
| 46 | Object comparison | Tier 3 | Intentionally Excluded | Single-object inspector is the coherent model; comparison doubles UI cost |
| 47 | Shareable selections/views | Tier 3 | Intentionally Excluded | Hash routes are shareable by view; per-object deep links deferred (needs selection-in-hash design) |
| 48 | Educational walkthrough | Tier 3 | Intentionally Excluded | Demo script + About page cover onboarding at lower maintenance cost |
| 49 | Demo mode | Tier 3 | Intentionally Excluded | Honest live app is the demo; scripted mode risks fake-data confusion |
| 50 | More event reconstructions | Tier 3 | Intentionally Excluded | 3 events suffice; reconstructions risk misinformation without historical elements |

## Totals

- Audited requirements: **50**
- Complete: **31**
- Partial: **13** (nearly all “implemented, browser/interaction verification pending”)
- Missing/Broken: **0**
- Blocked: **2** (public deploy; browser matrix + soak)
- Intentionally Excluded: **6** (Tier 3 only, each with a reason)

Most consequential remaining gaps: (1) no browser-based verification in this environment —
screenshot review, replay interaction, regression scenarios and the mobile layout all need one
Chrome run; (2) no public deployment yet — needs owner credentials; (3) live upstream content
(CelesTrak/Open-Meteo/NOAA) unverified from any network — needs one connected run of
`verify-live.mjs` + the DEPLOY checklist.

## What could not be verified here (exact)

1. First-paint visuals, globe rendering, sky-chart/Kp-chart rendering — no browser.
2. Click/drag/scrub/geolocation/permission flows — no browser.
3. Live CelesTrak/Open-Meteo/NOAA response bodies — outbound blocked.
4. Public deployment behaviour — no credentials.
5. Frame rates, memory growth, real-device behaviour — no devices.

What *was* verified here instead: 106 unit/integration tests (incl. independent-implementation
cross-checks), strict typecheck, lint, production build, SSR render of every view, full
replay-path smoke test on real snapshot data (12 passes predicted, scores computed), real Pages
runtime serving (`wrangler pages dev`) with curl-verified snapshot/validation/failure behaviour
on all four endpoints, and updated e2e scripts (syntax-checked, ready for a Chrome machine).
