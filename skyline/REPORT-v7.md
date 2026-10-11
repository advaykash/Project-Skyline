# Project Skyline v7: merge report

The original Project Skyline (OrbitWatch v6) and akulbajpai-code/SkyLine are merged into one app, built in the
`skyline/` folder in ten stages, each a commit. The plan is `merge-audit/MERGE-PLAN-v2.md` (approved by Mals with
"friend's Earth"), plus "What's Above Me?", which was added later.

## What was verified, and how

| Check | Result | How |
|---|---|---|
| Unit and integration tests | **52 of 52 pass** | `npm test` (Node's test runner, no other tools) |
| Observer maths against an independent implementation | TEME within 0.2 km, sub-point within 0.01°, altitude within 1 km | Skyfield + python-sgp4 reference states from the friend's repo (`test/observer.test.mjs`) |
| Worker in the real Workers runtime | Cron stored all 6 groups; `/api/gp`, `/api/health`, `/api/kp`, `/api/weather`, `/api/above` answered; CSP header on `/` | `wrangler dev` (workerd) locally. Upstreams were stand-ins: a replay of the friend's saved CelesTrak files, and made-up Kp, cloud and N2YO values. |
| Deploy bundle | builds; 18 static files; bindings as expected | `wrangler deploy --dry-run` |
| Browser | Page loads with no script errors; LIVE (local stand-in), SNAPSHOT (empty store) and no-WebGL fallback all behave; POV horizon and nadir orientation checked numerically; tour step enters and leaves POV; 390 px layout has no horizontal scroll; reduced motion makes POV exit instant | Headless Chromium (SwiftShader) driving the local Worker |
| Production deploy | **Not done.** Claude's workspace has no Cloudflare account, and CelesTrak, NOAA, Open-Meteo and N2YO are blocked from it. | The steps are below; `tools/verify-deploy.mjs` checks the live site. |

Nothing here was checked against live CelesTrak, NOAA, Open-Meteo or N2YO. The first real check of those is your deploy.

## What changed, by stage

1. **Cloudflare Worker.** `worker/api.mjs` and `worker/index.mjs`, `wrangler.jsonc`, `public/_headers`. The Node
   server and the DigitalOcean spec moved to `legacy/`. The `/api/gp` and `/api/health` contracts are kept; `records`
   now carries CelesTrak's OMM JSON unchanged.
2. **Snapshot fallback.** `public/data/celestrak.json` comes from the friend's real CelesTrak snapshot (19,323 records,
   captured 31 Aug and 10 Oct 2026), with a capture time for each group.
3. **Observer maths.** New `src/observer.js` (WGS-84 look angles, refined pass search, solar altitude and darkness,
   eclipse test), ported from the friend's `observer.ts`. SignalScope, passes and Your sky now share it. An SGP4
   divergence guard hides objects whose month-old elements give impossible positions.
4. **Inspector and pass replay.** Source elements, propagated position and derived values are shown separately, with
   a drift estimate from element age. Orbit-to-Observer replay has a sky chart and uses the shared clock.
5. **Friend's Earth.** Solar System Scope day and night maps (4096, with 2048 for small screens) and an ocean mask
   made from the day map. The friend's surface shading (night lights, glint, twilight, limb haze) is ported. The
   embedded NASA Blue Marble stays as the fallback.
6. **Orbital POV.** New `src/pov.js`. The camera sits at the selected object's SGP4 position at the sim time, in the
   inertial frame, with Horizon, Nadir and Free look views and a 25–100° field of view. The HUD shows name, NORAD id,
   altitude, speed, sub-point, sunlight, element age and time, with the fixed caption "Computed view from orbital
   elements, not spacecraft imagery."
   - Ways in: the inspector, search results (POV button or Shift+Enter), the P key, and tour step 3.
   - Ways out: Exit, Esc or P.
   - Satellites, debris and simulator fragments work the same way.
   - On phones the HUD is a bottom sheet with a 1.5× pixel-ratio cap.
   - Without WebGL the buttons are disabled with a reason.
7. **Status labels.** One chip (LIVE, CACHED, STALE, SNAPSHOT, DEMO) opens a popover with the source, times and
   element range. The warning line became a single toast. The clock's "LIVE" became "REAL TIME", so it can't be read
   as live data. Out-of-date methodology text was corrected (city lights, WGS-84, Worker).
8. **Kp, clouds and What's Above Me?**
   - **Kp:** `/api/kp`. NOAA Kp is fetched by the Cron run hourly into KV.
   - **Clouds:** `/api/weather`. Open-Meteo, rounded to 0.25°, cached in memory, so it uses no KV writes.
   - **What's Above Me?:** computed from the loaded catalogue, with counts by type and a list sorted by elevation. It
     has a top-bar "Above me" button.
   - **N2YO:** an optional "Cross-check with N2YO" button. It works only if `N2YO_API_KEY` is a Worker secret, and the
     key never reaches the browser (tested).
9. **Design pass, done by hand (no design skill or plugin was used):**
   - dimmed text raised to at least 4.5:1 contrast;
   - shorter group names;
   - a favicon (the console 404);
   - credits and moving labels taken out of the tab order;
   - an `aria-label` on the icon-only button.
10. **Docs.** README rewritten for Cloudflare. Added `tools/verify-deploy.mjs` and this report.

## Interface redesign (after the merge)

The two competing navigations (an Explore/SignalScope switch and five panel tabs) are replaced by one application
shell:

- **Navigation rail** (a bottom bar on phones) with six sections: Explore, SignalScope, Missions (Overhead, Passes,
  Orbital POV), Simulations, Compare & Data (Compare, Statistics, Sources) and Learn.
- **Slim top bar:** search and the data chip.
- **Inspector:** opens on the right only when an object is selected.
- **One time bar** under the globe.
- **A new colour and control style.**
- **Addresses for every section,** such as `#/missions/passes`. Back and Forward work.

Learn and Sources are no longer pop-up dialogs. All features were kept and moved; none were removed.

**How it was checked:**
- Headless Chromium clicked every section and sub-view, checked Back and Forward and five direct links (including an
  unknown one, which falls back to Explore), and ran the pass replay, POV from Missions, the breakup simulator, a
  historic event, Compare, the data-chip links, collapsing the panel and the full tour.
- On a 390 px phone it checked that the page has no horizontal scroll.
- No script errors. The only failed requests were the local `/api/*` calls, because that test server has no Worker.
- 52 of 52 tests pass.

## Components

- **Kept from Skyline:** SignalScope, breakup simulator, Compare, Stats, tour, Learn, Hipparcos stars, NEW YORK clock,
  real Sun lighting, inertial-frame scene, the single sim clock, and NASA Blue Marble (as the fallback).
- **Ported from the friend's repo (MIT):** observer maths and pass search, eclipse test, darkness categories, the
  snapshot, Skyfield reference fixtures, Earth day and night textures and shading, Kp and cloud-cover endpoints and
  their contracts, and the debris notes.
- **Not used:**
  - The friend's React/Vite UI and Earth-fixed scene. Skyline's inertial scene was kept.
  - Their specular, normal and cloud textures, which have no documented source or licence.
  - Their Pages Functions Cache-API proxy. It is replaced by KV plus Cron, because the Cache API only works on
    custom domains.
- **Retired:** the 4096 px Blue Marble that v6 served (the embedded 2048 copy remains), and the permanent yellow data
  warning line (now a toast plus the chip). No feature was removed.

## Dependencies

- **Runtime:** none new. three.js r128 and satellite.js 6.0.2 are vendored and SHA-checked.
- **Dev:** `wrangler` 4.145.0 only.
- **Services:** all free tier:
  - Cloudflare Workers Free, KV free, 1 Cron Trigger;
  - CelesTrak;
  - NOAA SWPC;
  - Open-Meteo (free for non-commercial use with attribution);
  - N2YO, optional.

## Assets and licences

See `ASSETS.md`:
- **Earth:** Solar System Scope (CC BY 4.0). The day and night maps are byte-identical to three.js's
  `earth_day_4096` and `earth_night_4096`, checked by a test. Attribution and changes are listed.
- **Fallback Earth:** NASA Blue Marble.
- **Stars:** Hipparcos via d3-celestial (BSD-3-Clause).

Credits are shown on the globe and in Learn.

## Known issues and limits

- **Not deployed or live-tested.** CelesTrak may refuse Cloudflare's IP addresses. If it does, the site shows STALE
  or SNAPSHOT honestly, and `/api/health` shows why.
- **The 10 ms CPU limit is designed for but not measured on Cloudflare.** Check Workers → Metrics after the deploy.
  If the Cron run goes over, remove `active` from `GROUPS` and serve it from the snapshot.
- **The browser parses 6.9 MB of OMM JSON for `active`.** That is fine on laptops and slower on older phones.
- **The 4K Earth is soft in Nadir view at low altitude** (about 10 km per pixel).
- **Weather and N2YO caches are per Worker instance** (in memory), so two instances may each call the provider once.
  The hourly caps still apply per instance.
- **N2YO's Terms of Use page could not be read from here.** Please check it covers a hackathon project.
- **`legacy/` should be deleted** once the Cloudflare deploy is verified.

## Deploy steps

```
npm install
npx wrangler login
npx wrangler kv namespace create SKYLINE_KV      # paste the printed id into wrangler.jsonc
npm run fetch-data                               # optional: fresh snapshot from CelesTrak
npm run deploy
npx wrangler secret put N2YO_API_KEY             # optional; paste the key at the prompt
node tools/verify-deploy.mjs https://project-skyline.<you>.workers.dev
```

The first Cron run is within 30 minutes. Before it, `/api/gp` answers 503 and the page shows SNAPSHOT.
