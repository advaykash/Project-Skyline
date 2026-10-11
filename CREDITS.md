# Credits

## Data

- **Orbital elements** — [CelesTrak](https://celestrak.org/) General Perturbations (GP) data,
  retrieved verbatim through documented JSON endpoints. Refresh policy (2 h) follows the
  [CelesTrak usage guidance](https://celestrak.org/usage-policy.php). Snapshot provenance (capture
  times, SHA-256) is recorded in `data/snapshot/manifest.json`.
- **Planetary Kp** — [NOAA Space Weather Prediction Center](https://www.swpc.noaa.gov/),
  `noaa-planetary-k-index.json` feed, proxied with attribution and retrieval timestamps.
- **Cloud forecasts** — [Open-Meteo](https://open-meteo.com/) forecast API (hourly `cloud_cover`),
  used as advisory observing context with attribution.

## Imagery

- **Earth day / night / specular / normal imagery** — NASA Visible Earth and NASA Earth Observatory
  (Blue Marble, Black Marble-derived night lights), bundled under `public/textures/`. See
  [`docs/CREDITS.md`](docs/CREDITS.md) for per-file sources and usage terms.

## Software

- [satellite.js](https://github.com/shashwatak/satellite-js) (SGP4 propagation)
- [Three.js](https://threejs.org/) (3D rendering)
- [React](https://react.dev/), [Vite](https://vitejs.dev/), [Vitest](https://vitest.dev/)
- [Cloudflare Pages + Pages Functions](https://developers.cloudflare.com/pages/) (hosting & API)
- Reference validation: [python-sgp4](https://github.com/brandon-rhodes/python-sgp4) and
  [Skyfield](https://rhodesmill.org/skyfield/) (`tools/skyfield-reference.py`)

## Project

Skyline was built for the PHS Hackathon by the repository owner with AI engineering assistance.
The AI-use record is in [`AI_USE_LOG.md`](AI_USE_LOG.md).

Skyline is an independent project and is not affiliated with NASA, ESA, NOAA, CelesTrak,
Open-Meteo or Cloudflare.
