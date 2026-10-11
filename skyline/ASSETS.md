# Assets and their sources

Everything the page needs is in this folder. Nothing is loaded from an image host at runtime.

| File | What it is | Source | Licence |
|---|---|---|---|
| `public/textures/earth-day-4096.jpg`, `earth-night-4096.jpg` (4096×2048) and `earth-day-2048.jpg`, `earth-night-2048.jpg` | **Default Earth.** Day surface and night lights, equirectangular, 180° W at the left edge, north up | Solar System Scope textures (solarsystemscope.com/textures), which are based on NASA Blue Marble and NASA night-lights imagery. Taken from akulbajpai-code/SkyLine `public/textures/earth-day.jpg` and `earth-night.jpg`; these are byte-identical (SHA-256 checked in `test/frames.test.mjs`) to three.js `examples/textures/planets/earth_day_4096.jpg` and `earth_night_4096.jpg`, which three.js credits to Solar System Scope. **Changes:** renamed; the 2048 versions are Lanczos resizes at JPEG quality 86, made by `tools/make-earth-textures.py`. | CC BY 4.0, Solar System Scope (creativecommons.org/licenses/by/4.0). Attribution is shown in the credits line and in Learn → Credits. |
| `public/textures/ocean-mask-2048.png` (2048×1024, greyscale) | Where the Sun glint may appear (white = water) | Derived from the day map above by `tools/make-earth-textures.py`: water is where blue clearly exceeds red and green; lightly blurred | Derivative of the CC BY 4.0 day map; same attribution |
| `src/earth.datauri` (2048×1024 JPEG, embedded in the page) | **Fallback Earth**, drawn until the default maps load, and if they can't (offline copy, file://, blocked request). Also the 2D ground-track map. NASA Blue Marble Next Generation with topography and bathymetry (December 2004, "world.topo.bathy") | NASA Earth Observatory / Visible Earth (Reto Stöckli, NASA GSFC). From `mpl_toolkits/basemap_data/bmng.jpg` (5400×2700) in the PyPI package `basemap-data` 2.0.0, which redistributes it from visibleearth.nasa.gov. Resized with Lanczos, JPEG quality 84. | NASA imagery is not copyrighted in the United States (NASA media usage guidelines); credit "NASA Earth Observatory". basemap-data is MIT: `public/textures/basemap-data.LICENSE.mit.txt`. |
| `src/stars.json` (embedded in the page) | 5,044 stars to visual magnitude 6.0: right ascension, declination (J2000), V magnitude, B−V colour | XHIP: An Extended Hipparcos Compilation (Anderson & Francis 2012, VizieR catalogue V/137D), as packaged in `data/stars.6.json` of the npm package `d3-celestial` 0.7.35. Rounded to 0.01°. | d3-celestial is BSD-3-Clause (Olaf Frohn): `public/vendor/d3-celestial.LICENSE.txt`. VizieR catalogue data is free for use with acknowledgement of the catalogue. |
| `public/vendor/three.min.js`, `public/vendor/satellite.min.js` | three.js r128, satellite.js 6.0.2 | npm | MIT (licence files alongside) |

The earlier Earth texture (from the original prototype, source unknown) was replaced in v6. The 4096 px Blue Marble copy
that v6 served is no longer shipped; the embedded 2048 px Blue Marble stays as the fallback.

Not included, on purpose:
- **The friend's specular, normal and cloud maps** (`earth-specular.jpg`, `earth-normal.jpg`, `earth-clouds.png` in
  akulbajpai-code/SkyLine). Their source and licence are not documented anywhere, so they are not used. The ocean glint
  uses the mask above instead of the specular map.
- **Real clouds.** No cloud image with a documented licence was available. The old procedural clouds are still in the
  Layers tab, off by default and labelled decorative.

Both Earth images are cloud-free composites from many dates. Neither is a live picture, and the night lights are a
fixed composite, not tonight's lights.

## Credits shown in the app

The globe view shows a credits line ("Earth: Solar System Scope (CC BY 4.0), based on NASA Blue Marble · Stars: ESA
Hipparcos · Orbits: CelesTrak"), and Learn → Credits gives the full attribution. No NASA or ESA logos are used, and the app doesn't
claim endorsement by either agency.
