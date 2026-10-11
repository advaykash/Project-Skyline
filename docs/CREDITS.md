# Data & asset credits

## Orbital data — CelesTrak

All satellite records are **CelesTrak General Perturbations (GP/OMM) data**, retrieved from
`https://celestrak.org/NORAD/elements/gp.php` (or captured from a public mirror of the same data —
see `data/snapshot/manifest.json`, which records the exact endpoint, capture time and SHA-256 of
every bundled group file).

- Provider: Center for Space Standards & Innovation / CelesTrak — https://celestrak.org
- GP data format documentation: https://celestrak.org/NORAD/documentation/gp-data-formats.php
- Usage policy: https://celestrak.org/usage-policy.php

CelesTrak publishes GP data for public use and asks consumers to fetch each group at most once every
two hours — Skyline's refresh policy implements that guidance (`shared/freshness.json`).

Records are reproduced verbatim. Skyline is not affiliated with CelesTrak.

## Propagation

- [satellite.js](https://github.com/shashwatak/satellite-js) — SGP4/SDP4 implementation (MIT),
  the JavaScript port of Vallado's reference code. Derived quantities use WGS-72 μ = 398600.8 km³/s²
  exactly as that library initialises SGP4.
- Independent verification tooling: [python-sgp4](https://github.com/brandon-rhodes/sgp4) and
  [skyfield](https://github.com/skyfielders/python-skyfield) (MIT), used only in `tools/` to
  generate reference fixtures.

## Earth textures

Bundled locally in `public/textures/`, taken from the [three.js](https://github.com/mrdoob/three.js)
example assets (`examples/textures/planets/`), which derive from NASA **Blue Marble** and
**Black Marble** imagery:

| File | Content | Source |
|---|---|---|
| `earth-day.jpg` | daytime surface (4096×2048) | NASA Blue Marble, via three.js examples |
| `earth-night.jpg` | night lights (4096×2048) | NASA Black Marble / VIIRS, via three.js examples |
| `earth-specular.jpg` | ocean/land mask (2048×1024) | three.js examples |
| `earth-normal.jpg` | surface normal map | three.js examples |
| `earth-clouds.png` | illustrative static cloud layer (1024×512) | three.js examples — not current weather |

NASA Earth imagery is in the public domain (NASA media usage guidelines). Credit: "NASA Visible
Earth / Blue Marble & Black Marble". Retextured at reduced resolution for bundle size.

If any texture fails to load, Skyline renders a plausible solid surface and continues — the
application never depends on a remote texture host.

## Space weather — NOAA

Planetary Kp measurements come from the NOAA Space Weather Prediction Center feed
(`https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json`), proxied with retrieval
timestamps and this attribution. US government data, public domain. Skyline is not affiliated
with NOAA.

## Cloud forecasts — Open-Meteo

Hourly cloud-cover context comes from the [Open-Meteo](https://open-meteo.com/) forecast API
(free for non-commercial use, attribution required — given in the app and here). Forecast model
output, not observation.

## Software

- three.js (MIT) — rendering
- React (MIT), Vite (MIT), TypeScript (Apache-2.0)
- Cloudflare Pages Functions runtime (deployment target)
- Vitest (MIT), ESLint (MIT), puppeteer-core (Apache-2.0) — testing only
