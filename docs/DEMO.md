# OrbitWatch — 3-minute demo script

*For judges. Every step below was verified in this repository; the honest data-state model means
the demo works even when CelesTrak is unreachable.*

1. **Open the application.** The globe is the product: a real terminator (check the day/night
   boundary against the UTC clock in the header), night lights on the dark side, stars. The left
   panel is the catalogue, the right is the inspector.

2. **Point at the data status.** The header chip shows the catalogue's data state — `live` in
   normal deployment, `snapshot` when offline. Open **Data & sources** (left panel, bottom): every
   group lists its own state, retrieval/capture time and element-epoch range. This is computed from
   retrieval metadata, not hardcoded.

3. **Search `ISS`.** The list filters the *actually loaded* catalogue (2 of 22 space-station
   objects). Select **ISS (ZARYA)**.

4. **The inspector proves the pipeline.**
   - *Calculated position* — latitude, longitude, altitude (≈420 km) and speed (≈7.66 km/s), with
     the exact SGP4 propagation instant stamped next to the heading.
   - *Source elements · CelesTrak GP* — the published element set, element epoch and **element age**.
   - *Derived properties* — period (≈93 min), semi-major axis, mean apogee/perigee, with the
     formulas' assumptions stated.
   - *Data provenance* — where these records came from, when they were retrieved, and their SHA-256.

5. **Click `Focus camera`** — the camera glides to the satellite (double-click on the globe does
   this too). The blue **orbit path** is one real orbital period; the yellow **ground track** is the
   sub-satellite projection, split at the date line. Toggle them from the globe's layer controls or
   the inspector buttons — they genuinely show/hide.

6. **Time controls** (bottom bar): switch to 300× and watch the satellite and terminator move
   together; press **Now** to return. The globe, the marker, the orbit and the clock always share
   one simulation instant.

7. **(If internet is available)** The same app switches to `live` automatically: say
   "the chip says LIVE — that means CelesTrak was fetched within the last two hours".

**The honest pitch:** a satellite tracker where every visible number has a stated source, every
position is SGP4-propagated from genuine elements, and the app tells you exactly how fresh — or how
stale — its data is. The propagation pipeline is independently verified against a second SGP4
implementation (20 reference states; see `docs/TESTING.md`).
