# Testing Skyline

## Commands

| Command | What it proves |
|---|---|
| `npm test` | 106 tests: GP-record validation, frame conventions, propagation sanity, derived formulas, orbit/ground-track consistency, observer geometry (look angles, eclipse, passes, viewing heuristic), NOAA/Open-Meteo parsing + proxy behaviour, backend success+failure paths, rate limiting, snapshot integrity, clock ownership/transitions |
| `npm run typecheck` | strict TypeScript across frontend, workers, Functions and tests |
| `npm run lint` | eslint (incl. React purity rules) |
| `npm run build` | production build (typecheck + vite) |
| `CHROME_PATH=… npm run test:e2e` | real-browser end-to-end against a running server |
| `node scripts/verify-live.mjs` | genuine CelesTrak connectivity + live-data path (needs internet) |

## Scientific verification (the important one)

`tools/skyfield-reference.py` regenerates `tests/fixtures/reference-states.json` from the committed
GP fixtures using:

- **python `sgp4`** — Brandon Rhodes' transcription of Vallado's canonical reference SGP4 (AIAA 2006-6753), and
- **skyfield** — an independent WGS-84 geodetic solution.

The generator verifies its own OMM→TLE round-trip (inclination, RAAN, eccentricity, argument of
perigee, mean anomaly, mean motion and B* all checked against the published values with stated
tolerances) and refuses to emit reference data if any element drifts.

`tests/orbital-reference.test.ts` then propagates the **same element sets at the same instants**
through this application's pipeline (satellite.js + our frame transforms) and compares:

| Quantity | Tolerance | Why this bound |
|---|---|---|
| TEME position | 0.2 km | both sides use identical elements; residual is epoch microsecond truncation (metres). 200 m still fails instantly on any degrees/radians, frame or time bug (those are 10³–10⁶ m) |
| Speed | 1 mm/s | frame-independent magnitude |
| Geodetic lat/lon | 0.01° | satellite.js rotates with GMST only; skyfield applies full IAU 2000A. Residual (equation of the equinoxes + precession) ≈ 0.005°, i.e. ~550 m |
| Altitude | 1 km | ellipsoid-constant differences are metres |

Observer-relative geometry is covered in `tests/observer.test.ts`:

- `geodeticToEcefKm` agrees with satellite.js `geodeticToEcf` to < 1 mm
- look angles agree with satellite.js `ecfToLookAngles` to < 1e-6° (12 epochs)
- zenith sanity: standing at the sub-satellite point gives elevation ≈ 90°
- solar altitude is 90° at the sub-solar point, −90° at the antipode
- eclipse classifier never reports shadow on the day side; the ISS orbit crosses the shadow within 24 h
- ISS passes over Princeton: rise/set sit on the 10° threshold, peaks match independent re-propagation to < 0.1°, passes are chronological and non-overlapping
- empty windows return `[]` (never an invented pass); nonsense windows rejected
- viewing score is bounded 0–100, deterministic, discloses the missing-cloud assumption, and rewards clearer skies monotonically

Secondary sources are covered in `tests/secondary-sources.test.ts`: NOAA Kp feed parsing (valid
rows kept, malformed rows skipped, chronological sort, unusable payloads → null), Open-Meteo
forecast parsing (clamping, bad-row skipping, null on unusable payloads), proxy allowlist refusal,
cache-then-refetch behaviour and failure-without-throwing.

Other geometry invariants covered in `tests/orbital-core.test.ts` / `tests/orbit-path.test.ts`:

- Greenwich/0° → scene +X, 90°E → scene −Z, north pole → +Y; scene↔geodetic round-trips
- marker direction vs geodetic sub-satellite point agree within 0.25° (the WGS-84 flattening bound)
- ISS altitude 350–500 km and speed 7.3–8.0 km/s at epoch; latitude never exceeds inclination ±0.5°
- orbit-path first vertex equals the marker position at the same instant (path/marker consistency)
- one period of ground track drifts west by 18–28° (Earth rotation), segments split at the date line

## Backend tests (deterministic mocks, real service code)

`tests/backend-service.test.ts` exercises `functions/api/_lib/service.ts` — the exact code the Pages
Functions call — with mocked upstream/clock and the real file-backed snapshot:

valid groups · unknown/missing group → 400 · HTML/invalid JSON/empty/bad-field payloads rejected ·
fresh cache (no upstream call) · cached (5 h) · stale (50 h) · failed refresh keeps serving genuine
cache (degraded) · upstream failure with empty cache → snapshot with real capture time · snapshot
never mixed into a live payload · timeout → snapshot · `UPSTREAM_DISABLED` honoured · concurrent
requests coalesced to one fetch · retry-with-backoff telemetry · per-client rate limit · health
per-group states · snapshot SHA-256 matches the manifest.

These mocks prove the *behaviour contract*. They do not prove CelesTrak is reachable from a given
network — that is `scripts/verify-live.mjs`'s job:

```bash
node scripts/verify-live.mjs                    # against a local wrangler pages dev
node scripts/verify-live.mjs https://<deployed> # against production
```

It checks `/api/health`, fetches `stations`, verifies `state == 'live'`, real record counts,
fresh retrieval timestamps, and cross-checks a known object (ISS, NORAD 25544) by name and ID.
It exits non-zero and prints exactly what failed otherwise — it never reports success for a
snapshot-labelled response.

## End-to-end (real browser)

`tests/e2e/run.mjs` drives Chrome/Chromium (including software WebGL via SwiftShader) through the
main journey: home hero → Explore the globe → WebGL active → health + gp endpoints → catalogue
renders → search "ISS" → select → inspector shows geodetic position/altitude/velocity + source
elements + provenance → label renders on the globe → layer toggle → camera drag → time controls
→ group switch → 390×844 and 768×1024 layouts → sky / weather / events / about routes render →
console/network hygiene. It writes screenshots and `e2e-report.json` to `docs/screenshots/`.

`tests/e2e/resilience.mjs` (`npm run test:e2e:resilience`) covers the failure and accessibility
scenarios: keyboard-only selection (Tab → type → ArrowDown → Enter → Escape), visible focus
indicators, accessible names for icon-only buttons, the Earth-texture failure fallback (app must
still start), and an API outage followed by a working Retry recovery.

If no browser binary is found these scripts exit with code 2 and say so — they never pretend to have run.

## Regenerating fixtures

```bash
node scripts/make-test-fixtures.mjs     # extract GP fixtures from data/snapshot
python3 tools/skyfield-reference.py     # regenerate reference states (pip install skyfield sgp4)
SKYLINE_SNAPSHOT_SOURCE=/path/to/mirror node scripts/build-snapshot.mjs   # rebuild the offline snapshot
```

## Simulation clock

`tests/clock.test.ts` covers the single-pump handshake (exactly one owner; non-owner advances
ignored), rate scaling, pause-at-zero, the 250 ms tab-gap clamp, throttled subscriber
notification, seek semantics and return-to-live.
