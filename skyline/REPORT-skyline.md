# Project Skyline (v5): UI polish, motion and SignalScope

Source: `orbitwatch/skyline/` is a copy of `orbitwatch/site/` with these changes. Same structure, same server, same deploy
steps. It can be merged back into `site/` once the other thread working on `site/` is done.
Preview (labelled demo orbits): https://claude.ai/artifact/7iQCwLvbDoKzdGPE7ChC7H

## 1. UI and visual design

Skills used: Emil Kowalski motion skill for the motion pass, and taste-skill's redesign-skill for the audit and critique.
No skill called "Impeccable" is installed, so redesign-skill stood in for it.

- **Name:** OrbitWatch is now Project Skyline everywhere a user sees it (title, toolbar, intro, tour, Learn, server logs).
- **Design system** (tokens at the top of `src/template.html`): tinted near-black surfaces with blur, one cyan accent for
  the interface and amber reserved for "visible / signal". Geist and Geist Mono (Google Fonts, IBM Plex and system
  fallbacks). One radius scale, one shadow, one z-index scale, one motion timing set.
- **Less clutter:** borders removed from list items, cards and stat tiles (fill and an inner highlight instead); section
  labels are small mono eyebrows; warnings are a left-edge stripe instead of a boxed card; toolbar actions are quiet.
- **Toolbar:** logo mark, an Explore / SignalScope mode switch with a sliding indicator, data badge, search, tools.
- **Globe:** lit by the computed Sun direction, so day and night are real (it used to be a fixed light). Softer
  atmosphere, dimmer stars. In SignalScope every non-constellation object is dimmed so the subject stands out.
- **States:** empty states for "nothing selected", "no place chosen", "none visible", "no constellation data";
  shimmer placeholders while the timeline computes; the loading bar animates with a transform; the badge dot blinks
  while loading. Stale, demo and error states are unchanged in logic and still show their reasons.
- **Phones:** tools sit on the first toolbar row; in SignalScope the sheet shrinks to 40% and the dock collapses to
  one row (play, time tag, clock, window length, Now) and a compact strip.

## 2. Motion

All in one language: 140–320 ms, one ease-out curve, transform and opacity only. Everything respects
`prefers-reduced-motion` (CSS rule, plus the camera snaps and the radar sweep and pulse stop).

- **Camera:** the camera now eases toward its goal every frame: fast while you drag (feels direct), slower for flights.
  Search results, suggestions, Reset, the tour and SignalScope all fly instead of jumping. A slow fly-in on first load.
- **Panels:** tab content fades up; the tab underline and mode switch slide; dialogs rise; toasts slide in; the dock
  slides up when SignalScope opens.
- **State-linked motion:** the selection ring pulses; the SignalScope count ticks when it changes; the timeline cursor
  moves with the app clock; the radar sweep turns inside the visibility dome; the place marker pulses.

## 3. SignalScope

Open it from the toolbar, the intro, or the tour. Pick a place by clicking the globe, choosing a quick pick, searching
92 built-in places, or typing coordinates (`47.61, -122.33`, `33.9 S, 18.4 E`). Your real location is never needed.

- **Membership:** name pattern AND on CelesTrak's active list. Starlink, OneWeb, Kuiper, Qianfan, O3b mPOWER on by
  default; Iridium available but off (narrowband). Debris, rocket bodies and unknown names never count. Each
  constellation has a toggle with its live count.
- **Geometry:** observer on the WGS-84 ellipsoid; SGP4 (TEME) position rotated to Earth-fixed by sidereal time;
  elevation against the local vertical. Elevation limit slider, 0–60°, default 25°.
- **Count:** "geometrically visible tracked internet-constellation satellites", calculated from the current positions
  at the shown time, labelled NOW / FORECAST +x / PAST.
- **Timeline dock:** play, pause, four speeds, drag to scrub, hover readout, keyboard (arrows, Page Up/Down, Home,
  End, Space), 3/6/12 h windows, Now, Recompute. The strip shows the count over the window, red bands for gaps with
  none visible, hour ticks, a "now" marker and the amber cursor.
- **Panel:** place and coordinates, Centre button, count with time tag, constellation toggles, elevation limit,
  selected satellite (elevation, azimuth with compass point, range, current or next window), next rises (time, peak,
  duration), gaps summary, visible list (sets in x min), data source and timestamp, freshness indicator, element ages,
  what the number does and does not mean, internet performance block, legend.
- **Globe:** cyan dots for constellation members, amber glow for visible ones, fading tracks (6 min either side) for the
  highest 24, dashed lines of sight for the highest 32, a dome showing where a satellite at the constellation's typical
  altitude clears the limit, its ground ring, a radar sweep and a pulsing marker. The view follows the place as Earth
  turns until you drag; Centre brings it back.
- **No fabricated performance:** the panel separates geometric visibility (computed), modelled estimates (none) and
  measured performance ("Actual internet performance data unavailable").

## 4. How synchronisation works

There is one clock (`simMs`). Play, speeds and scrubbing all change it, and the globe, the count, the tracks, the
lines of sight, the panel and the dock cursor all read it.

- When a place is chosen, every member's elevation is sampled over the window (1 min steps, coarser only above about
  2 million SGP4 calls) and stored as compact integers. The work runs in 24 ms slices so the page keeps animating.
- **Culling:** one coarse sample in four checks whether a satellite is anywhere near the place; samples it can't
  possibly be visible in are skipped. On 518,396 checked samples this changed nothing (0 mismatches, 0 missed).
- Changing the elevation limit or constellations re-uses the samples (about 20–50 ms for 10,000 satellites).
- Windows are interpolated between samples. The big count is exact at the shown time; the strip is sampled, so
  between samples it can differ (regular shells make the count oscillate faster than one minute).

## 5. Files changed (in `skyline/`)

- `src/template.html`: rewritten styles (tokens, components, dock, responsive), new toolbar, SignalScope panel, dock,
  intro and Learn text.
- `src/app.js`: rename strings, palette, camera easing, Sun lighting, tab and mode indicators, toast and loading
  motion, shared location, demo broadband shell (now 720 satellites in 36 planes), SignalScope module.
- `public/index.html`: rebuilt.
- `test/scope.test.mjs`: new, 4 tests. `package.json`, `package-lock.json`: name `project-skyline`, version 5.0.0,
  test script. `README.md`: name, SignalScope section, test count. `server/server.mjs`, `tools/fetch-celestrak.mjs`:
  name in comments, log line and User-Agent. `.do/app.yaml`: comment only (app name stays `orbitwatch`).

## 6. Tests and checks

- `npm test`: 18 pass, 0 fail (14 existing + 4 new).
- New tests: elevation and azimuth match satellite.js `ecfToLookAngles` to under 1e-6° on 2,000 random cases;
  overhead and far-side sanity; dome angle; constellation names (debris and look-alike names rejected).
- Headless Chromium walkthrough, desktop 1440×900 and phone 390×844, normal and reduced motion: intro, Explore,
  SignalScope empty state, quick pick, timeline compute, scrub, 12 timeline samples where sampled count equals the live
  count, elevation limit change, selecting a visible satellite, play, keyboard Home, city search, coordinate search,
  back to Explore, ISS search, all tabs, full tour including the SignalScope step. No page errors. The only console
  errors are the expected 503/404 from the data server having no CelesTrak access.
- Starlink-scale check against a stand-in CelesTrak serving 12,048 made-up TEST records (9,200 Starlink-named,
  648 OneWeb, 200 Kuiper): 10,048 members found, debris named STARLINK-1234 DEB excluded, live count equals a direct
  SGP4 count, compute work 0.94 s (12.7 s wall clock in the software renderer here; a real GPU should be much
  faster), per-frame SignalScope cost about 3 ms.

## 7. Data and freshness limits

- Real CelesTrak data has still never loaded here; the workspace can't reach CelesTrak. All checks used demo data or
  made-up records. On the first deploy, check that the badge reads LIVE and SignalScope counts Starlink.
- Membership depends on CelesTrak naming. Qianfan and Kuiper patterns are assumptions (`QIANFAN-…`, `KUIPER-…`); if
  CelesTrak names them differently they simply won't appear.
- Predictions degrade with element age; the panel warns when the median member's elements are over 3 days old.
- The dome uses a spherical Earth and one reference altitude; the counting itself uses WGS-84 and each satellite's
  real position.

## 8. Needs more data or future work

- Measured performance (speed, latency, usage) needs a trustworthy, location-specific source with its period and
  resolution shown. None is loaded.
- Service area, licensing, ground stations and beam coverage are not modelled.
- The visibility timeline does not include terrain or buildings (a horizon mask) or sunlight.
- The demo constellation changed from 300 random to 720 structured satellites, so demo stats differ from before.
- Not yet checked on a real GPU or a real phone.
