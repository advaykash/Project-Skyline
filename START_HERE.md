# START HERE — Skyline in 10 minutes

Welcome! Skyline turns public satellite data into a 3D explorer you can open in a browser.
This file takes you from zero to running, testing and demoing the project.

## 1. Run it (2 minutes)

Requirements: Node.js ≥ 20.

```bash
npm install
npm run build
npx wrangler pages dev dist --port 8788 --ip 0.0.0.0
# open http://localhost:8788
```

You should see the Skyline home page. Click **Explore the globe**, then **Track the ISS** from
the home page on a second visit — the globe selects the space station.

> No internet? The app still works: it serves the bundled offline snapshot of genuine CelesTrak
> records and labels it `snapshot` with its real capture time.

## 2. The 3-minute tour

1. **Home (`#/`)** — the pitch: *Every dot tells a story.*
2. **Explorer (`#/explorer`)** — drag the globe, search "ISS", click a marker, toggle orbit path /
   ground track / night lights, change time speed in the footer bar.
3. **Sky & Passes (`#/sky`)** — pick the ISS + Princeton NJ, choose a predicted pass, press Play
   and scrub. The sky chart, the readouts and (back in the explorer) the globe marker all follow
   one clock.
4. **Space Weather (`#/weather`)** — the latest NOAA Kp measurement and its history.
5. **Debris Events (`#/events`)** — the 2007, 2009 and 2021 break-ups; open a debris cloud on
   the globe.
6. **How It Works (`#/about`)** — the pipeline, the honesty ledger and credits.

Demo script for judges: [`docs/DEMO.md`](docs/DEMO.md).

## 3. How the code fits together (3 minutes)

```
Browser                              Cloudflare Pages
────────────────────────             ──────────────────────────────
React UI (src/ui/)                   functions/api/
  Explorer · Sky · Weather             /api/gp      CelesTrak GP (+ cache,
  Events · About · Home                /api/weather  snapshot fallback)
  small store (src/state/)             /api/kp
       │                              Open-Meteo · NOAA (cached proxy)
       ▼
SGP4 in a worker (src/workers/) ◄── real orbital elements (never invented)
       │
       ▼
Three.js globe (src/globe/) — one draw call for the whole catalogue
```

Key rule: **every position comes from a published element set + SGP4, or it is not drawn.**
Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full pipeline, then
[`FEATURE_COMPLETENESS_AUDIT.md`](FEATURE_COMPLETENESS_AUDIT.md) to see what is implemented,
with evidence, and what remains.

## 4. Test it (2 minutes)

```bash
npm test          # 106 unit/integration tests
npm run typecheck # strict TypeScript
npm run lint      # eslint
npm run build     # production build into dist/
```

With Chrome and internet: `CHROME_PATH=… npm run test:e2e` drives the running app in a real
browser and captures screenshots into `docs/screenshots/`.

## 5. Deploy it (1 minute)

```bash
npm run build
npx wrangler pages deploy dist
```

…from a machine with Cloudflare credentials, or connect the repo in the Cloudflare Pages
dashboard (build: `npm run build`, output: `dist`). Full guide: [`docs/DEPLOY.md`](docs/DEPLOY.md).

## 6. If something breaks

| Symptom | First check |
|---|---|
| `snapshot` chip instead of `live` | Normal without internet — the snapshot is genuine data with a real capture time. |
| Space Weather / cloud context unavailable | Open-Meteo or NOAA unreachable; everything else keeps working. |
| Blank globe | Check the console; without WebGL the app falls back to list + inspector mode. |
| Build fails | `npm run typecheck` and `npm run lint` point at the exact file. |

Data, science and honesty rules: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the
*How It Works* page in the app. Credits: [`CREDITS.md`](CREDITS.md).
AI assistance record: [`AI_USE_LOG.md`](AI_USE_LOG.md).
