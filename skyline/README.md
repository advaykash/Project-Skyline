# Project Skyline

A 3D globe of tracked satellites and space debris, made for hackPHS 2026 ("Into the Skies"). It merges the original
Project Skyline (OrbitWatch) with akulbajpai-code/SkyLine. Positions are calculated in your browser with SGP4
(satellite.js 6.0.2) from [CelesTrak](https://celestrak.org) orbital elements. A Cloudflare Worker downloads and
stores those elements on a schedule.

What you can do:

- **Explore** about 19,000 tracked objects on a globe lit by the real Sun position. Inspect any object, follow it, or
  compare two.
- **Orbital POV.** See Earth from an object's calculated position, in Horizon, Nadir or Free look. This is a computed
  view, not spacecraft imagery.
- **What's above me?** See every loaded object above your horizon right now. Skyline calculates this itself; an
  optional N2YO cross-check is available if the site has a key.
- **Your sky.** Get the next ISS pass with a replay, a cloud-cover forecast (Open-Meteo) and geomagnetic activity
  (NOAA Kp).
- **SignalScope.** Pick a place and see which internet-constellation satellites are geometrically above a chosen
  elevation, and how that changes. This is geometry only, not service or speed.
- **Breakup simulator, Stats, Compare, a guided tour and Learn.**

No React or other framework. There are no runtime dependencies, and the browser loads everything from this site
except the Geist fonts from Google Fonts. `wrangler` is the only dev dependency, and it is only used to run and deploy.

## How the data gets to the page

```
celestrak.org ──(Cron, at most once per group per 2 h)──▶ Worker ──▶ KV (global store)
                                                                       │
browser ◀──── /api/gp?group=… (streams the stored copy) ───────────────┘
   └── SGP4, three.js, look angles, passes, POV: all in the browser
```

Fallback order in the page:
1. This site's Worker (`/api/gp`). The data chip shows **LIVE** if the copy is under 3 hours old, otherwise
   **STALE**.
2. The browser's own cache (**CACHED**).
3. The CelesTrak snapshot stored with the site, `public/data/celestrak.json` (**SNAPSHOT**, with its capture date).
4. Demo orbits (**DEMO**). These are clearly labelled and never shown as real.

Snapshot, demo and stale data are never labelled LIVE, and `test/labels.test.mjs` checks this.

## Run it locally (Windows, macOS or Linux)

You need Node.js 20 or newer (on Windows: `winget install OpenJS.NodeJS.LTS`, then reopen the terminal).

```
npm install          # installs wrangler (the only dev dependency)
npm test             # 52 tests; should end with "fail 0"
npm run dev          # builds the page and starts a local Worker at http://localhost:8787
```

The local Worker starts with an empty store, so the page shows SNAPSHOT at first. To run the scheduled download
once, open <http://localhost:8787/cdn-cgi/handler/scheduled> and then reload the page.

If PowerShell says "running scripts is disabled", use Command Prompt, or type `npm.cmd` instead of `npm`.

## Deploy on Cloudflare (free plan)

Do this once:

```
npm install
npx wrangler login                              # opens the browser; sign in or create a free Cloudflare account
npx wrangler kv namespace create SKYLINE_KV     # prints an id
```

Paste that id into `wrangler.jsonc` in place of `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`. Then:

```
npm run fetch-data      # optional but recommended: refreshes the stored snapshot from CelesTrak (needs internet)
npm run deploy          # builds the page and deploys; prints https://project-skyline.<you>.workers.dev
```

Optional: to turn on the N2YO cross-check, run `npx wrangler secret put N2YO_API_KEY` and paste the key when it asks.
Don't put the key in any file or chat. Without it, What's above me? still works with Skyline's own calculation.

Then check the live site:

```
node tools/verify-deploy.mjs https://project-skyline.<you>.workers.dev
```

The first scheduled download happens within 30 minutes of deploying. Until then the API answers 503 and the page shows
SNAPSHOT. To trigger it sooner, wait for the first Cron run, or redeploy later and run the check again.

### What the free plan allows, and how the site stays inside it

| Limit (Workers Free) | How Skyline uses it |
|---|---|
| 10 ms CPU per request and per Cron run | The Worker never parses the large CelesTrak lists (parsing `active` alone takes about 60 ms). It byte-checks and streams them. The browser parses them. |
| 100,000 Worker requests a day | Only `/api/*` runs the Worker. The page, textures and libraries are static assets, which are free and not counted. |
| KV: 1,000 writes and 100,000 reads a day | About 170 writes a day: up to 72 for the elements, up to 48 for status and up to 48 for Kp. Cloud forecasts and N2YO answers are kept in memory, not in KV. |
| 5 Cron Triggers | 1 is used (every 30 minutes; each group is downloaded only when due). |
| Static assets: 20,000 files, 25 MiB each | 18 files, the largest 2.8 MB. |

No paid feature is used. If CelesTrak refuses Cloudflare's addresses, the page shows STALE or SNAPSHOT honestly. You
can only find this out after deploying; `/api/health` shows each group's last error.

## API

| Request | Response |
|---|---|
| `GET /api/gp?group=stations` | `200` with `{group, fetchedAt, count, bytes, stale, lastError, lastAttemptAt, refreshMinutes, format: "omm", records}`. `records` is CelesTrak's OMM JSON, unchanged. Supports `ETag`/`304` and `HEAD`. `400` for an unknown group. `503` with `Retry-After` before the first download. |
| `GET /api/health` | Each group's `fetchedAt`, `count`, `lastAttemptAt`, `lastError` and `nextAttemptAt`, plus Kp status and `n2yo.configured` (never the key). |
| `GET /api/kp` | NOAA SWPC planetary Kp, last 24 three-hour values: `{retrievedAt, stale, source, feedUrl, samples: [{time, kp}]}`. `503` before the first download. |
| `GET /api/weather?lat=&lon=` | Open-Meteo hourly cloud cover for the location rounded to 0.25°: `{latitude, longitude, retrievedAt, kind: "forecast", hourly: [{time, cloudCoverPercent}]}`. `400` for bad coordinates, `502` if the provider fails. |
| `GET /api/above?lat=&lon=` | Only if `N2YO_API_KEY` is set: N2YO's objects above the horizon of the 1° cell. It is cached for 2 minutes and stops at 90 calls an hour (N2YO allows 100). `404` when not set up. |

Groups: `stations`, `active`, `visual`, `fengyun-1c-debris`, `iridium-33-debris`, `cosmos-2251-debris`.

Worker settings are in `wrangler.jsonc` `vars`. They are all optional: `REFRESH_MS`, `STALE_MS`, `RETRY_MS`,
`TIMEOUT_MS`, `UPSTREAM_DISABLED`, `KP_REFRESH_MS`, `WEATHER_PER_HOUR`, and the upstream URLs, which the tests use to
point at stand-ins.

## Files

```
worker/index.mjs        Cloudflare entry point (fetch + scheduled)
worker/api.mjs          all Worker logic: Cron download, /api/gp, /api/health, /api/kp, /api/weather, /api/above
wrangler.jsonc          Worker, static assets, KV and Cron configuration
public/                 everything the browser loads (static assets)
  index.html            the whole app, built from src/
  _headers              security headers (CSP, nosniff, no referrer) for static files
  data/celestrak.json   CelesTrak snapshot (fallback)
  textures/             Earth day, night and ocean-mask maps (see ASSETS.md)
  vendor/               three.js r128 and satellite.js 6.0.2 with their licences
src/                    page source: edit, then npm run build:page
  template.html, app.js, observer.js (look angles, passes, eclipse), pov.js (Orbital POV geometry), earth.datauri, stars.json
tools/                  build-page, fetch-celestrak, make-earth-textures.py, verify-deploy
test/                   52 tests (node --test): Worker, build, frames and textures, SignalScope, observer maths against Skyfield, POV, labels
legacy/                 the old Node server and DigitalOcean spec; delete after the Cloudflare deploy is verified
```

## Credits and licences

- **Orbital data:** [CelesTrak](https://celestrak.org) GP data (Dr T.S. Kelso).
- **Earth day and night maps:** [Solar System Scope](https://www.solarsystemscope.com/textures/), CC BY 4.0, based on
  NASA imagery. The fallback Earth is NASA Blue Marble Next Generation (NASA Earth Observatory). See `ASSETS.md`.
- **Stars:** ESA Hipparcos (XHIP via d3-celestial, BSD-3-Clause).
- **Space weather:** NOAA Space Weather Prediction Center. **Cloud cover:** [Open-Meteo](https://open-meteo.com/),
  free for non-commercial use with attribution. **Optional cross-check:** [N2YO.com](https://www.n2yo.com/).
- **Merged code:** observer maths, pass search, eclipse test, snapshot, reference fixtures and Earth shader ideas from
  akulbajpai-code/SkyLine (MIT).
- **Libraries:** three.js r128 and satellite.js 6.0.2 (MIT). **Fonts:** Geist (SIL OFL), from Google Fonts.

No NASA, ESA, NOAA or company logos are used, and nothing implies endorsement.
