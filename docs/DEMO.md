# Skyline — 3-minute demo script

*For judges. The honest data-state model means the demo works even when CelesTrak is unreachable —
the header chip says exactly what you are looking at.*

1. **Home: the pitch (20 s).** *"Skyline — everything moving above our world. Every dot tells a
   story."* Two buttons: **Explore the globe**, **Track the ISS**. Click **Track the ISS**.

2. **Explorer: real data on a real globe (60 s).** The globe selects the ISS: orbit path, ground
   track, inspector with *calculated position* (lat/lon/altitude/speed, stamped with the SGP4
   instant), *source elements* (published CelesTrak GP + element age) and *provenance*. Point at
   the header chip: `live` means CelesTrak was fetched within 2 hours; `snapshot` means the
   bundled offline copy with its real capture time. Drag to 300× — satellite and terminator move
   together on one clock.

3. **Sky & Passes: the signature (70 s).** Open **Sky & Passes**. Observer: Princeton NJ. The pass
   list shows upcoming ISS passes with peak time, max elevation and rise/set directions. Select
   one: scrub the timeline and show the **sky chart** marker, the azimuth/elevation/range readouts
   and the observing context (darkness, illumination, cloud cover, heuristic score) moving as one.
   Click **View on globe** — the explorer shows the same object at the same replay instant.

4. **Debris + weather (30 s).** **Debris Events**: the 2009 collision card → *explore Cosmos-2251
   fragments* renders the surviving cloud. **Space Weather**: latest NOAA Kp with its timestamp.

**The honest pitch:** a satellite explorer where every visible number has a stated source, every
position is SGP4-propagated from genuine elements, pass predictions and the sky view share one
clock, and the app tells you exactly how fresh — or how stale — its data is. The pipeline is
independently verified against a second SGP4 implementation (see `docs/TESTING.md`).
