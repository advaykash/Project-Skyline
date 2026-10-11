// Checks SignalScope's geometry and constellation matching against satellite.js, without a browser. Run: npm test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
const slice = (from, to) => { const a = app.indexOf(from), b = app.indexOf(to, a); assert.ok(a >= 0 && b > a, `src/app.js: ${from}`); return app.slice(a, b); };
// a context with satellite.js and the few helpers the SignalScope code uses
const ctx = { Math, Object };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/vendor/satellite.min.js'), 'utf8'), ctx);
vm.runInContext('const RS = 6371, D2R = Math.PI / 180, R2D = 180 / Math.PI, TAU = Math.PI * 2; const clamp = (x, a, b) => Math.max(a, Math.min(b, x));'
  + fs.readFileSync(path.join(ROOT, 'src/observer.js'), 'utf8')
  + slice('const CONSTELLATIONS = [', 'const SCOPE_CALLS')
  + slice('const capAngle', 'const COMPASS')
  + ';this.api = { CONSTELLATIONS, observerFrame, lookAngles, lookEl, capAngle };', ctx);
const { CONSTELLATIONS, observerFrame, lookAngles, lookEl, capAngle } = ctx.api;
const sat = ctx.satellite;

test('elevation and azimuth match satellite.js ecfToLookAngles (WGS-84 observer, curvature included)', () => {
  let seed = 5; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  let worstEl = 0, worstAz = 0;
  for (let k = 0; k < 2000; k++) {
    const lat = (rnd() * 2 - 1) * 89, lon = (rnd() * 2 - 1) * 180, gmst = rnd() * Math.PI * 2;
    const rr = 6371 + 300 + rnd() * 2000, th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1);
    const r = [rr * Math.sin(ph) * Math.cos(th), rr * Math.sin(ph) * Math.sin(th), rr * Math.cos(ph)];
    const ob = observerFrame(lat, lon), mine = lookAngles(ob, r, Math.cos(gmst), Math.sin(gmst));
    const ref = sat.ecfToLookAngles({ latitude: lat * Math.PI / 180, longitude: lon * Math.PI / 180, height: 0 }, sat.eciToEcf({ x: r[0], y: r[1], z: r[2] }, gmst));
    worstEl = Math.max(worstEl, Math.abs(mine.el - ref.elevation * 180 / Math.PI));
    if (Math.abs(mine.el) < 85) worstAz = Math.max(worstAz, Math.abs(((mine.az - ref.azimuth * 180 / Math.PI) + 540) % 360 - 180));
    assert.ok(Math.abs(lookEl(ob, r, Math.cos(gmst), Math.sin(gmst)) - mine.el) < 1e-9);
  }
  assert.ok(worstEl < 1e-6, `elevation differs by ${worstEl}°`);
  assert.ok(worstAz < 1e-6, `azimuth differs by ${worstAz}°`);
});

test('a satellite straight overhead is at 90°, and one on the far side of Earth is below the horizon', () => {
  const ob = observerFrame(0, 0);
  assert.ok(Math.abs(lookAngles(ob, [7000, 0, 0], 1, 0).el - 90) < 1e-9);
  assert.ok(lookAngles(ob, [-7000, 0, 0], 1, 0).el < -80);
});

test('the visibility dome angle follows spherical geometry', () => {
  // at 550 km and 25° elevation the ground radius is about 940 km (8.45° of arc); at 0° it is the horizon distance
  assert.ok(Math.abs(capAngle(550, 25) * 180 / Math.PI - 8.45) < 0.02);
  assert.ok(Math.abs(capAngle(550, 0) - Math.acos(6371 / 6921)) < 1e-12);
});

test('constellation patterns match only the intended catalog names', () => {
  const match = n => (CONSTELLATIONS.find(c => !c.demo && c.re.test(n)) || {}).key || null;
  assert.equal(match('STARLINK-1007'), 'starlink');
  assert.equal(match('STARLINK-31452'), 'starlink');
  assert.equal(match('ONEWEB-0012'), 'oneweb');
  assert.equal(match('KUIPER-00010'), 'kuiper');
  assert.equal(match('O3B MPOWER F3'), 'o3b');
  assert.equal(match('IRIDIUM 106'), 'iridium');
  for (const n of ['IRIDIUM 33 DEB', 'ISS (ZARYA)', 'STARLINKX', 'NOAA 20', 'COSMOS 2251 DEB', 'BROADBAND CONSTELLATION SAT 1 (DEMO)']) assert.equal(match(n), null, n);
  // the debris guard is the object type: names like "STARLINK-1234 DEB" are classified as debris before matching
  assert.match(app, /if \(o\.type !== 'active'\) continue;/);
});
