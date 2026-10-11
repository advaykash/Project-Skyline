// Checks src/observer.js (passes, Sun altitude, eclipse) and the app's SGP4 pipeline against an independent implementation.
// Run: npm test. Reference states in test/fixtures/ were generated with python-sgp4 + Skyfield by akulbajpai-code/SkyLine
// (tools/skyfield-reference.py there, MIT) from the CelesTrak records in gp-samples.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
const slice = (from, to) => { const a = app.indexOf(from), b = app.indexOf(to, a); assert.ok(a >= 0 && b > a, `src/app.js: ${from}`); return app.slice(a, b); };
const ctx = { Math, Object, Date, Intl, String, Number, Infinity, NaN };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/vendor/satellite.min.js'), 'utf8'), ctx);
vm.runInContext('const RS = 6371, REQ = 6378.137, MU = 398600.4418, D2R = Math.PI / 180, R2D = 180 / Math.PI, TAU = Math.PI * 2, HAS_SAT = true;'
  + slice('const jdOf =', 'const dot3') + slice('const len3 =', '\n') + '\n'
  + fs.readFileSync(path.join(ROOT, 'src/observer.js'), 'utf8')
  + slice('// ───────────────────────── time, Sun and frames', '// ── end of pure block')
  + slice('function gmstAt(ms) {', 'const toScene') + slice('function geodetic(r, gmst) {', 'function regimeOf')
  + ';this.api = { observerFrame, lookAngles, predictPasses, solarAltitude, darknessOf, illumination, sunEci, subsolarPoint, gmstAt, eciAt, geodetic };', ctx);
const A = ctx.api, sat = ctx.satellite;
const ref = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/reference-states.json'), 'utf8'));
const samples = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/gp-samples.json'), 'utf8'));
const recs = new Map(samples.items.map(x => [Number(x.record.NORAD_CAT_ID), x.record]));
const unit = v => { const l = Math.hypot(...v); return v.map(x => x / l); };

test('SGP4 positions and geodetic coordinates match python-sgp4 + Skyfield (independent implementation)', () => {
  const entries = ref.entries.filter(e => e.temeKm && recs.has(e.noradId));
  assert.ok(entries.length >= 15, `${entries.length} reference states`);
  for (const e of entries) {
    const o = { satrec: sat.json2satrec(recs.get(e.noradId)) }, t = Date.parse(e.instant), s = A.eciAt(o, t);
    assert.ok(s, `${e.name} at ${e.instant}: no state`);
    const d = Math.hypot(s.r[0] - e.temeKm.x, s.r[1] - e.temeKm.y, s.r[2] - e.temeKm.z);
    assert.ok(d < 0.2, `${e.name} at ${e.instant}: TEME position differs by ${d.toFixed(3)} km`);
    const g = A.geodetic(s.r, A.gmstAt(t)), dLon = ((g.lon - e.geodetic.longitudeDeg) + 540) % 360 - 180;
    // satellite.js rotates TEME by GMST only; Skyfield applies the full IAU 2000A rotation (≈0.005° apart)
    assert.ok(Math.abs(g.lat - e.geodetic.latitudeDeg) < 0.01 && Math.abs(dLon) < 0.01, `${e.name} at ${e.instant}: sub-point off`);
    assert.ok(Math.abs(g.h - e.geodetic.altitudeKm) < 1, `${e.name} at ${e.instant}: altitude off`);
  }
});

test('pass times are refined: elevation is 10° at rise and set and highest at the peak (checked against a 1 s scan)', () => {
  const iss = { satrec: sat.json2satrec(recs.get(25544)) }, ob = A.observerFrame(40.357, -74.667);
  const posAt = t => { const s = A.eciAt(iss, t); return s && s.r; };
  const el = t => { const g = A.gmstAt(t); return A.lookAngles(ob, posAt(t), Math.cos(g), Math.sin(g)).el; };
  const t0 = Date.parse('2026-10-10T00:00:00Z'), passes = A.predictPasses(posAt, A.gmstAt, ob, t0, t0 + 36 * 3600e3, { max: 10 });
  assert.ok(passes.length >= 2, `${passes.length} ISS passes over Princeton in 36 h`);
  for (const p of passes) {
    assert.ok(Math.abs(el(p.t0) - 10) < 0.05 && Math.abs(el(p.t1) - 10) < 0.05, 'rise and set at 10°');
    let best = -90; for (let t = p.t0; t <= p.t1; t += 1000) best = Math.max(best, el(t));
    assert.ok(Math.abs(best - p.max) < 0.02, `peak ${p.max.toFixed(2)}° vs scan ${best.toFixed(2)}°`);
    assert.ok(p.t0 < p.tPeak && p.tPeak < p.t1 && p.t1 - p.t0 < 15 * 60e3);
  }
  for (let k = 1; k < passes.length; k++) assert.ok(passes[k].t0 > passes[k - 1].t1, 'in time order, not overlapping');
});

test('a failed propagation never produces a pass', () => {
  const ob = A.observerFrame(0, 0);
  assert.deepEqual([...A.predictPasses(() => null, A.gmstAt, ob, 0, 3 * 3600e3)], []);
});

test('Sun altitude: about 90° at the subsolar point, about −90° opposite it, darkness names follow the standard limits', () => {
  for (const iso of ['2026-03-20T12:00:00Z', '2026-06-21T03:30:00Z', '2026-10-11T18:00:00Z']) {
    const t = Date.parse(iso), g = A.gmstAt(t), sp = A.subsolarPoint(t, g), sun = unit(A.sunEci(t));
    assert.ok(A.solarAltitude(A.observerFrame(sp.lat, sp.lon), sun, g) > 89.5, iso);
    assert.ok(A.solarAltitude(A.observerFrame(-sp.lat, sp.lon + 180), sun, g) < -89.5, iso);
  }
  assert.equal(A.darknessOf(5), 'Daylight'); assert.equal(A.darknessOf(-3), 'Civil twilight'); assert.equal(A.darknessOf(-9), 'Nautical twilight');
  assert.equal(A.darknessOf(-15), 'Astronomical twilight'); assert.equal(A.darknessOf(-30), 'Night');
});

test('eclipse test: sunlit on the day side, in shadow directly behind Earth, sunlit far off the shadow axis', () => {
  const sun = [1, 0, 0];
  assert.equal(A.illumination([7000, 0, 0], sun), 'sunlit');
  assert.equal(A.illumination([-7000, 0, 0], sun), 'shadow');
  assert.equal(A.illumination([-7000, 6500, 0], sun), 'sunlit');
  assert.equal(A.illumination([-7000, 6378.137 + 1, 0], sun), 'penumbra');
});

test('a position far beyond the orbit\'s own apogee (SGP4 diverged, e.g. after re-entry) is reported as unknown, not drawn', () => {
  const rec = recs.get(25544), t = Date.parse('2026-10-10T00:00:00Z');
  assert.ok(A.eciAt({ satrec: sat.json2satrec(rec), apogee: 430 }, t), 'a normal ISS state is kept');
  // SGP4 returning a point 380,000 km out for a low orbit (seen with month-old Starlink elements): rejected
  const real = sat.sgp4;
  sat.sgp4 = () => ({ position: { x: 380000, y: 0, z: 0 }, velocity: { x: 0, y: 1, z: 0 } });
  try { assert.equal(A.eciAt({ satrec: sat.json2satrec(rec), apogee: 430 }, t), null); } finally { sat.sgp4 = real; }
});

test('pass replay has no clock of its own: it moves the shared simulation clock and ends when the observer changes', () => {
  const code = slice('let replay = null;', 'function drawSkyChart');
  assert.ok(!/Date\.now\(\)|performance\.now\(\)|setInterval/.test(code), 'replay must not keep its own time');
  assert.match(code, /setSimTime\(pass\.t0 - 60e3\)/);
  assert.match(code, /replay\.obKey !== obs\.lat \+ ',' \+ obs\.lon\) return endReplay\(\)/);
});
