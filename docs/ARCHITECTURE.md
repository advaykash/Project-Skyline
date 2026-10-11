# OrbitWatch architecture

## Data pipeline (end to end)

```
CelesTrak GP JSON  (gp.php?GROUP=<g>&FORMAT=json)
        │
        ▼
functions/api/gp.ts  ──  group allowlist (shared/catalog-groups.json)
        │                payload validation (JSON array, required fields, ranges)
        │                bounded timeout (6 s) + one retry + per-isolate coalescing
        ▼
Cache API entry  ──/__orbitwatch-cache/gp/<group>──  body + retrieval-time + SHA-256
        │
        │  (cache older than 2 h → refresh; refresh failure → keep last genuine payload;
        │   no payload at all → bundled snapshot in dist/snapshot/, labelled "snapshot")
        ▼
GET /api/gp response: { group, state, provenance, recordCount, records[] }
        │
        │  state === 'snapshot' only → one browser-direct attempt at CelesTrak
        │  (src/data/api.ts, 5 s budget, same validation); success replaces the
        │  snapshot and is labelled live, failure keeps the snapshot untouched
        ▼
src/workers/propagator.worker.ts   SGP4 propagators built once per catalogue (satellite.js)
        │   tick(timeMs) → Float32Array of scene-space positions (transferred)
        ▼
src/globe/GlobeEngine.ts   one THREE.Points draw call for the whole catalogue
        │
        └── selection: buildSatrec + propagateState on the main thread (1 object/frame)
            → marker highlight and its buffer vertex, DOM label, orbit path, ground track
src/ui/Inspector.tsx       the same propagateState path, one SGP4 call per 200 ms tick,
                           stamped with the instant it was computed for
```

## Frames, units and datums (the audit trail)

Defined once in `src/orbital/constants.ts`, enforced by tests:

1. **TEME** — SGP4's native inertial frame; `satellite.js` `propagate()` output.
2. **ECEF/PEF** — TEME rotated by GMST, *exactly once*, in `frames.ts#eciToEcef`.
3. **Scene** — Earth-fixed, right-handed, Y = north pole: `scene = (ecef.x, ecef.z, −ecef.y)`;
   1 scene unit = 6371 km (mean Earth radius). The Earth mesh never rotates.
4. Geodetic lat/lon/altitude: WGS-84 (satellite.js `eciToGeodetic`), labelled as such.
   Orbit-shape parameters (a, apogee, perigee, period): WGS-72 (µ = 398600.8 km³/s²), the
   datum SGP4 itself is defined on. Both are stated in the UI's datum notes.

The scene↔geodetic mapping is invariant-tested (Greenwich → +X, 90° E → −Z, pole → +Y), and
`tests/orbital-reference.test.ts` compares the entire chain against an independent
implementation (python `sgp4` + skyfield; see `docs/TESTING.md`).

## Simulation clock

`src/state/clock.ts` is the single time authority. Exactly one pump advances it — the globe
engine's animation loop when WebGL is running (a 100 ms fallback timer otherwise). Every
rendered position and every displayed timestamp comes from `getTimeMs()`, so the globe, the
markers, the orbit path and the inspector can never disagree about "now".

## Caching & data states

| Age of the served payload | State shown |
|---|---|
| ≤ 2 h (`liveMs`) | **live** |
| ≤ 24 h (`cachedMs`) | **cached** (with `degraded` if a refresh failed) |
| > 24 h | **stale** |
| bundled snapshot | **snapshot** (with its real capture time) |

States are computed in `functions/api/_lib/service.ts` from retrieval metadata only. The
frontend never labels anything itself. The refresh cadence (2 h) follows CelesTrak's usage
guidance; `shared/freshness.json` is the single source of these numbers.

Failure ladder on every `/api/gp` request:

1. cache fresh enough → serve it (no upstream call);
2. else try CelesTrak → validate → cache → serve `live`;
3. upstream failed/invalid → serve last genuine cache (degraded + reason);
4. no cache → bundled snapshot (labelled with capture time);
5. no snapshot → **502 with an explicit "no records were invented" message**.

## Rendering

- Earth: custom ShaderMaterial — day/night mixing with a real solar terminator (sun direction
  from `satellite.js`'s low-precision solar ephemeris), night lights, ocean specular, limb haze,
  twilight warmth; separate cloud and additive atmosphere shells. Every texture slot that fails
  to load binds a 1×1 `DataTexture` fallback and clears its `has*` uniform, so the layer is
  skipped instead of the sampler being unbound. All `pow()` bases are clamped to
  `[0.0001, 1.0]` — denormal or negative bases flicker (or produce NaN) on mobile GPUs.
- Catalogue: one `THREE.Points` buffer; positions written in place from the worker; marker size
  and glow scale with catalogue density (pinned by unit test). A failed propagation keeps the
  `(0, 0, 0)` placeholder, which the vertex shader discards
  (`dot(position, position) < 0.25`) — no NaN ever reaches the GPU, and the picking pass skips
  the same slots.
- Orbit path and ground track are computed from the same `propagateState` path as markers (a
  test asserts the first path vertex equals the marker position at the same instant); the
  ground track is split at the antimeridian. Both are pre-allocated pooled buffers redrawn with
  `setDrawRange`, so a periodic rebuild never allocates or disposes a geometry or material.
  The selected object's own marker vertex is refreshed every frame, so the highlight never
  leads the marker during a slow catalogue tick.
- Camera: opens on the terminator plane (perpendicular to the Sun), the vertical field of view
  widens on portrait viewports to hold the globe, and `controls.target` stays at the Earth's
  centre for both focus and follow.
- Disposal: engine `dispose()` terminates the worker, cancels frames/listeners and disposes
  every geometry/material/texture. `webglcontextlost` is `preventDefault()`ed so the browser
  will fire `webglcontextrestored`; rendering pauses meanwhile while the clock keeps running.

## Backend deployment model

Cloudflare Pages: static `dist/` + `functions/` on one origin. No Node.js server at runtime.
Caching uses the Cache API (per data centre, best-effort — documented); no KV/Durable Objects,
so the deployment stays within the free tier. Rate limiting is a per-isolate sliding window
(documented backstop). Configuration (`CELESTRAK_BASE`, `UPSTREAM_TIMEOUT_MS`,
`UPSTREAM_DISABLED`) comes from environment bindings only — never from request input, so the
API cannot be used as an open proxy.
