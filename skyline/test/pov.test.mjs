// Checks Orbital POV: the geometry in src/pov.js and how src/app.js places the camera. Run: npm test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
const tpl = fs.readFileSync(path.join(ROOT, 'src/template.html'), 'utf8');
const slice = (from, to) => { const a = app.indexOf(from), b = app.indexOf(to, a); assert.ok(a >= 0 && b > a, `src/app.js: ${from}`); return app.slice(a, b); };
const ctx = { Math, Object, Date, Number, Infinity, NaN };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/vendor/satellite.min.js'), 'utf8'), ctx);
vm.runInContext('var simMs = 0; const RS = 6371, REQ = 6378.137, MU = 398600.4418, D2R = Math.PI / 180, R2D = 180 / Math.PI, TAU = Math.PI * 2;'
  + slice('const jdOf =', 'const dot3') + slice('const dot3 =', '\n') + '\n' + slice('const len3 =', '\n') + '\n'
  + slice('function stumpC(', 'const toScene')
  + fs.readFileSync(path.join(ROOT, 'src/pov.js'), 'utf8')
  + slice('function povState(o) {', 'function enterPov(')
  + ';this.api = { povBasis, horizonDip, diskRadius, povDefaultFov, povAngles, povOrientation, povClip, clampFov, povState, eciAt, v3 };', ctx);
const A = ctx.api;
const samples = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/gp-samples.json'), 'utf8'));
const rec = id => samples.items.find(x => Number(x.record.NORAD_CAT_ID) === id).record;
const T0 = Date.parse('2026-10-10T00:00:00Z');
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], len = a => Math.hypot(...a);

test('orbit basis is orthonormal and right-handed: up is the radial direction, along-track is horizontal', () => {
  let seed = 5; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647 * 2 - 1;
  for (let k = 0; k < 200; k++) {
    const r = [rnd() * 7, rnd() * 7, rnd() * 7], v = [rnd() * 8, rnd() * 8, rnd() * 8], b = A.povBasis(r, v);
    if (!b) continue;
    for (const u of [b.up, b.along, b.right]) near(len(u), 1, 1e-12, 'unit length');
    near(dot(b.up, b.along), 0, 1e-12, 'up ⟂ along'); near(dot(b.up, b.right), 0, 1e-12, 'up ⟂ right'); near(dot(b.along, b.right), 0, 1e-12, 'along ⟂ right');
    const ru = r.map(x => x / len(r)); for (let j = 0; j < 3; j++) near(b.up[j], ru[j], 1e-12, 'up = r̂');
    near(dot(A.v3.cross(b.right, b.along), b.up), 1, 1e-12, 'right × along = up');
    assert.ok(dot(b.along, v) > 0, 'along-track points the way the object moves');
  }
  assert.equal(A.povBasis([1, 0, 0], [2, 0, 0]), null, 'purely radial velocity has no along-track direction');
});

test('horizon dip at 420 km is about 20.3°, and the limb ray at that pitch just grazes the Earth', () => {
  near(A.horizonDip(420), 20.3, 0.05, 'dip at 420 km');
  near(A.horizonDip(35786), 81.3, 0.1, 'dip at GEO');
  for (const h of [200, 420, 800, 1200, 20200]) {
    const r = [0, 1 + h / 6371, 0], b = A.povBasis(r, [7, 0, 0]), o = A.povOrientation(b, 0, -A.horizonDip(h));
    const t = -dot(r, o.fwd), closest = [r[0] + t * o.fwd[0], r[1] + t * o.fwd[1], r[2] + t * o.fwd[2]];
    near(len(closest), 1, 1e-9, `limb tangent at ${h} km`);
  }
});

test('views: nadir looks straight down with along-track at the top; horizon puts the limb a third of the way down', () => {
  const r = [0.3, 0.9, -0.5].map(x => x * 1.066 / Math.hypot(0.3, 0.9, -0.5)), b = A.povBasis(r, [0.2, 0.4, 7]);
  const nadir = A.povAngles('nadir', 420, 90), o = A.povOrientation(b, nadir.yaw, nadir.pitch);
  for (let j = 0; j < 3; j++) { near(o.fwd[j], -b.up[j], 1e-12, 'nadir = −r̂'); near(o.up[j], b.along[j], 1e-12, 'screen up = along-track'); }
  const fov = A.povDefaultFov('horizon', 420), hz = A.povAngles('horizon', 420, fov);
  // the limb is above the centre by a sixth of the field of view, i.e. a third of the way down from the top
  near(-A.horizonDip(420) - hz.pitch, fov / 6, 1e-9, 'limb a sixth of the field of view above the centre');
  assert.ok(hz.pitch < -A.horizonDip(420), 'centre of the frame is on the Earth, below the limb');
  const fw = A.povOrientation(b, 0, 0).fwd; for (let j = 0; j < 3; j++) near(fw[j], b.along[j], 1e-12, 'yaw 0, pitch 0 = along-track');
  // high orbits see the whole disk: both modes look at it, with the disk filling most of the frame
  assert.equal(A.povAngles('horizon', 35786, 30).pitch, -90);
  const geoFov = A.povDefaultFov('nadir', 35786); assert.ok(geoFov >= 2 * A.diskRadius(35786) && geoFov <= 100, `GEO fov ${geoFov}`);
  // free look: kept within limits
  assert.equal(A.povAngles('free', 420, 70, { yaw: 30, pitch: 120 }).pitch, 80);
  assert.equal(A.clampFov(5), 25); assert.equal(A.clampFov(500), 100);
});

test('near clipping plane stays inside the altitude, so the surface below is never clipped', () => {
  for (const h of [160, 300, 420, 800, 1500, 20200, 35786]) {
    const n = A.povClip(h); assert.ok(n >= 0.001 && n <= 0.01, `near ${n}`); assert.ok(n < 0.5 * h / 6371, `near ${n} at ${h} km`);
  }
});

test('the camera is the object’s propagated position at the sim time, in the scene frame, the same way for satellites, debris and simulator fragments', () => {
  const objs = [{ satrec: ctx.satellite.json2satrec(rec(25544)), apogee: 430 }, { satrec: ctx.satellite.json2satrec(rec(25730)), apogee: 900 }];
  const s0 = A.eciAt(objs[0], T0); objs.push({ r0: s0.r.slice(), v0: [s0.v[0] + 0.05, s0.v[1], s0.v[2]], t0: T0 });   // a breakup fragment
  for (const o of objs) for (const t of [T0, T0 + 600e3, T0 + 5400e3]) {
    vm.runInContext('simMs = ' + t, ctx);
    const st = A.povState(o), s = A.eciAt(o, t);
    assert.ok(st && s);
    const want = [s.r[0] / 6371, s.r[2] / 6371, -s.r[1] / 6371];   // toScene
    for (let j = 0; j < 3; j++) near(st.r[j], want[j], 1e-12, 'camera = toScene(eciAt(o, simMs))');
    near(st.alt, Math.hypot(...s.r) - 6371, 1e-9, 'altitude');
    const vs = [s.v[0], s.v[2], -s.v[1]]; assert.ok(dot(st.basis.along, vs) > 0.999 * len(vs) * Math.sqrt(1 - (dot(vs, st.basis.up) / len(vs)) ** 2), 'along-track from the same velocity');
  }
  // SGP4 fails (e.g. re-entered): no state, so no view
  const real = ctx.satellite.sgp4; ctx.satellite.sgp4 = () => ({ position: false, velocity: false });
  try { assert.equal(A.povState(objs[0]), null); } finally { ctx.satellite.sgp4 = real; }
});

test('POV has no clock of its own and no type-specific path; exit restores the saved globe camera', () => {
  const code = slice('let pov = null;', 'function povHud(');
  assert.ok(!/Date\.now\(\)|performance\.now\(\)|setInterval|setTimeout/.test(code), 'POV must read simMs only');
  assert.match(code, /const s = eciAt\(o, simMs\)/);
  assert.ok(!/o\.type ===|\.cat ===|satrec \?/.test(slice('function povState(o) {', 'function enterPov(')), 'one propagation path for every object');
  const exit = slice('function exitPov(', 'const povTmp');
  for (const re of [/az = p\.az/, /el = p\.el/, /dist = p\.dist/, /target\.splice\(0, 3, \.\.\.p\.target\)/, /setFollow\(p\.follow\)/, /cam\.up\.set\(0, 1, 0\)/, /cam\.fov = 45/, /clouds\.visible = p\.clouds/]) assert.match(exit, re);
  assert.match(slice('function enterPov(', 'function setPovMode('), /saved: \{ az, el, dist, target: target\.slice\(\), follow, clouds: clouds\.visible \}/);
  // Escape leaves POV before it ends the tour; SignalScope and Reset leave POV
  assert.match(app, /else if \(pov\) exitPov\(\); else if \(!\$\('tour'\)\.hidden\) endTour\(\)/);
  assert.match(slice('function setMode(m) {', '\n}'), /if \(on && pov\) exitPov\(\)/);
  assert.match(slice('function resetView(', '\n}'), /if \(pov\) exitPov\(\)/);
});

test('POV never presents itself as camera footage', () => {
  assert.match(tpl, /Computed view from orbital elements, not spacecraft imagery\./);
  const hud = slice('function povHud(', '\n}');
  assert.match(hud, /not spacecraft imagery/); assert.match(hud, /simulated/); assert.match(hud, /demo/);
  assert.ok(!/live (view|feed|camera)|onboard|camera feed/i.test(tpl.slice(tpl.indexOf('<div id="pov"'), tpl.indexOf('<div id="time"'))), 'no live-camera wording in the HUD');
  assert.match(app, /computed from its orbit: not a camera feed/);
});
