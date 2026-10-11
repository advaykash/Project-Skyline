# Project Skyline v6: aerospace visual fidelity

This is a refinement in `orbitwatch/skyline/`, not a rewrite. Explore, SignalScope, orbital calculations, the timeline,
CelesTrak fetching and caching, the server API and every existing control still work. v5 is described in
`REPORT-skyline.md`. Preview with labelled demo orbits: https://claude.ai/artifact/7iQCwLvbDoKzdGPE7ChC7H

## What changed

**Earth**
- New texture: NASA Blue Marble Next Generation (topography and bathymetry). It replaces a texture whose source was unknown.
- The embedded 2048×1024 copy always works. Large screens also load a 4096×2048 copy served by this site, and if that
  fails the embedded copy stays.
- Shader lighting:
  - day and night from the computed Sun;
  - a 6° twilight band;
  - the night side is the day image darkened and cooled (no city lights);
  - a faint sun glint on oceans.
- The atmosphere is a thin limb, brighter on the sunlit side. There is no bloom or neon.

**Sun**
- Direction from the Astronomical Almanac low-precision formula, in the TEME / equator-of-date frame, swapped to scene axes.
- It is the direction of illumination, not the Sun as seen from a place.
- Lighting follows the **simulation** clock. The telemetry row says so ("lit for sim time") and shows the subsolar point.

**Stars**
- 5,044 real stars from Hipparcos (to magnitude 6), in the inertial frame. They replace the random field.
- Size and brightness follow magnitude, and colour follows B−V.

**Clouds**
- The old procedural clouds are now a Layers checkbox, **off by default**, labelled "Decorative clouds (not real weather)".

**NEW YORK clock**
- Shows `NEW YORK 07:48:01 EDT Sun 11 Oct` using `Intl.DateTimeFormat` with `America/New_York`.
- Updates every 1 s. The timer stops when the tab is hidden or the page is left, and restarts when the page comes back.
- When the sim clock differs from real time, it also shows `SIM +00:15:00`.
- It also appears in the SignalScope dock. It never claims to know where you are.

**Data badge**
- Live, server copy, cached, snapshot, stale, demo and loading now differ by border style and text colour as well as
  the dot, and the text always names the state.
- The logic that decides the state is unchanged, so "LIVE" appears only when CelesTrak data actually loaded and is fresh.

**Visual system**
- More opaque panels and half the blur.
- Flat near-black background instead of a gradient glow.
- Tighter radii, a lighter shadow and smaller hero numbers.
- The SignalScope radar sweep is removed: it was decorative motion that implied scanning.

**Credits**
- A line on the globe reads: "Imagery: NASA Earth Observatory (Blue Marble) · Star data: ESA Hipparcos · Orbits: CelesTrak".
- Learn → Credits gives the full attribution and says no endorsement is implied.
- No logos are used.

**Methodology text** (Learn, Sources, and the "What is real" table) now covers the Earth image, lighting, night lights,
stars and the clock.

## Files

**Changed:**
- `src/app.js`
- `src/template.html`
- `tools/build-page.mjs` (injects `src/stars.json`)
- `package.json` and `package-lock.json` (version 6.0.0, test script)
- `README.md`
- `public/index.html` (rebuilt)

**New:**
- `src/stars.json`
- `src/earth.datauri` (replaced)
- `public/textures/earth-bmng-4096.jpg`
- `public/textures/basemap-data.LICENSE.mit.txt`
- `public/vendor/d3-celestial.LICENSE.txt`
- `ASSETS.md`
- `test/frames.test.mjs`
- this report

## Assets and licences (full detail in `ASSETS.md`)

**Blue Marble**
- NASA imagery is not copyrighted in the US; the credit is "NASA Earth Observatory".
- The file was taken from the `basemap-data` PyPI package (MIT), because NASA's servers are blocked from this workspace.

**Hipparcos**
- XHIP via `d3-celestial` (BSD-3-Clause). The catalogue is free to use with acknowledgement.

**Hosting:** nothing is hotlinked; everything is in the folder.

## Tests

`npm test` passes 26 of 26: the 18 existing tests plus 8 new ones in `test/frames.test.mjs`. The new tests check:
- **New York clock:** EST in winter and EDT in summer, and the date changes at New York midnight.
- **DST in 2026:** 8 March (02:00 local is skipped) and 1 November (01:00–01:59 local happens twice).
- **SIM offset formatting.**
- **Sun direction:** within 0.02° of a high-precision ephemeris at 8 timestamps from 2000 to 2040. The reference values
  were computed once with astronomy-engine and stored in the test. satellite.js `sunPos` was found to be off by a
  steady ~0.35°, so it was not used as the reference.
- **Subsolar latitude:** at the 2026 equinox and both solstices.
- **Subsolar longitude:** matches the equation of time at 12:00 UTC.
- **Terminator:** moves west by 15° per hour (checked for 24 hours).
- **Frames:**
  - the subsolar point drawn on the globe lines up with the lighting direction;
  - the antipode is in full night;
  - geographic → scene matches satellite.js `ecfToEci` on 500 random cases.

**Browser checks (headless Chromium, software GL)**
- Ran at desktop 1440×900 and phone 390×844, with normal and reduced motion. No page errors.
- The walkthrough covered: intro, Explore, SignalScope, quick pick, timeline compute, scrub, elevation limit,
  selection, play, search, all tabs and the tour.
- The only console errors were the expected 503/404s from having no CelesTrak access.

## Limitations

- **Live CelesTrak was not verified.** This workspace can't reach CelesTrak. All checks used demo data or made-up
  records. On first deploy, check that the badge reads LIVE.
- **No city lights or real clouds:** no licensed images were reachable from here.
- **Blue Marble** is a 2004 cloud-free composite, not a current view.
- **Lighting simplifications:** lighting uses TEME ≈ equator of date and ignores precession of the stars (about 0.4°).
  Neither is visible at this scale.
- **On phones**, the dock's NEW YORK clock and the telemetry date and Sun readout are hidden to save space, and the
  credits line is hidden too (credits are in Learn).
- **Not tested on a real GPU or phone.** Only software rendering was tested. The 4096 texture loads only on screens of
  at least 700 px whose GPU supports it.
