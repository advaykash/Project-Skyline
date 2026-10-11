// Checks the New York clock, the Sun direction and the coordinate frames in src/app.js, without a browser. Run: npm test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
const slice = (from, to) => { const a = app.indexOf(from), b = app.indexOf(to, a); assert.ok(a >= 0 && b > a, `src/app.js: ${from}`); return app.slice(a, b); };
const ctx = { Math, Object, Date, Intl, String };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/vendor/satellite.min.js'), 'utf8'), ctx);
vm.runInContext('const D2R = Math.PI / 180, R2D = 180 / Math.PI, TAU = Math.PI * 2;'
  + slice('// ───────────────────────── time, Sun and frames', '// ── end of pure block')
  + ';this.api = { eciToScene, geoToScene, sunEci, subsolarPoint, nyClock, fmtSimOffset };', ctx);
const { eciToScene, geoToScene, sunEci, subsolarPoint, nyClock, fmtSimOffset } = ctx.api;
const sat = ctx.satellite;
const T = s => Date.parse(s);
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angDeg = (a, b) => Math.acos(Math.min(1, dot(a, b) / Math.hypot(...a) / Math.hypot(...b))) * R2D;
const gmst = ms => sat.gstime(new Date(ms));

test('New York clock: EST in winter, EDT in summer, independent of the machine time zone', () => {
  assert.deepEqual({ ...nyClock(T('2026-01-15T17:00:00Z')) }, { time: '12:00:00', abbr: 'EST', date: 'Thu 15 Jan' });
  assert.deepEqual({ ...nyClock(T('2026-07-01T16:00:00Z')) }, { time: '12:00:00', abbr: 'EDT', date: 'Wed 1 Jul' });
  // date rolls over at New York midnight, not UTC midnight
  assert.equal(nyClock(T('2026-10-12T03:59:59Z')).date, 'Sun 11 Oct');
  assert.equal(nyClock(T('2026-10-12T04:00:00Z')).time, '00:00:00');
});

test('New York clock across the 2026 DST transitions (8 March and 1 November)', () => {
  const at = s => { const c = nyClock(T(s)); return `${c.time} ${c.abbr}`; };
  assert.equal(at('2026-03-08T06:59:59Z'), '01:59:59 EST');
  assert.equal(at('2026-03-08T07:00:00Z'), '03:00:00 EDT');   // 02:00 local is skipped
  assert.equal(at('2026-11-01T05:59:59Z'), '01:59:59 EDT');
  assert.equal(at('2026-11-01T06:00:00Z'), '01:00:00 EST');   // 01:00–01:59 happens twice
  assert.equal(at('2026-11-01T06:30:00Z'), '01:30:00 EST');
  assert.equal(at('2026-11-01T05:30:00Z'), '01:30:00 EDT');
});

test('simulation offset formatting', () => {
  assert.equal(fmtSimOffset(15 * 60e3), '+00:15:00');
  assert.equal(fmtSimOffset(-(2 * 3600e3 + 3 * 60e3 + 10e3)), '−02:03:10');
  assert.equal(fmtSimOffset(3 * 864e5 + 4 * 3600e3), '+3 d 04:00:00');
  assert.equal(fmtSimOffset(400), '+00:00:00');
});

// Reference Sun directions (unit vectors, true equator and equinox of date, aberration included) computed once with
// astronomy-engine 2.1.19 (VSOP87-based, arcsecond accuracy). satellite.js sunPos was not used as the reference: in
// satellite.js 6.0.2 it differs from both this table and the known 2026 solstice time by a steady ~0.35°.
const SUN_REF = [["2000-01-01T12:00:00Z",0.1799825,-0.9025104,-0.391256],["2005-07-04T03:00:00Z",-0.2121222,0.8965928,0.3887488],["2012-12-21T11:11:00Z",-0.0000065,-0.9175053,-0.3977236],["2019-09-23T07:50:00Z",-1,-3e-7,4e-7],["2026-03-08T07:00:00Z",0.9770871,-0.1952785,-0.0846586],["2026-10-11T11:41:00Z",-0.9500916,-0.2862307,-0.1240882],["2033-05-17T22:30:00Z",0.539869,0.7723292,0.3347372],["2040-02-29T00:00:00Z",0.9397289,-0.3137163,-0.1359838]];

test('Sun direction matches a high-precision ephemeris to 0.02° at several UTC timestamps (2000–2040)', () => {
  for (const [s, x, y, z] of SUN_REF) { const e = angDeg(sunEci(T(s)), [x, y, z]); assert.ok(e < 0.02, `${s}: ${e}°`); }
});

test('subsolar latitude at equinox and solstices, and longitude near the Greenwich meridian at 12:00 UTC', () => {
  const eq = subsolarPoint(T('2026-03-20T14:46:00Z'), gmst(T('2026-03-20T14:46:00Z')));
  assert.ok(Math.abs(eq.lat) < 0.05, `equinox lat ${eq.lat}`);
  const js = subsolarPoint(T('2026-06-21T08:24:00Z'), gmst(T('2026-06-21T08:24:00Z')));
  assert.ok(Math.abs(js.lat - 23.436) < 0.03, `June solstice lat ${js.lat}`);
  const ds = subsolarPoint(T('2026-12-21T20:50:00Z'), gmst(T('2026-12-21T20:50:00Z')));
  assert.ok(Math.abs(ds.lat + 23.436) < 0.03, `December solstice lat ${ds.lat}`);
  // at 12:00 UTC the Sun is over longitude −(equation of time in minutes)/4: always within about ±4.1°
  for (const d of ['2026-02-11', '2026-04-15', '2026-07-26', '2026-11-03']) {
    const ms = T(`${d}T12:00:00Z`), p = subsolarPoint(ms, gmst(ms));
    assert.ok(Math.abs(p.lon) < 4.6, `${d} lon ${p.lon}`);
  }
  const nov = T('2026-11-03T12:00:00Z'); assert.ok(Math.abs(subsolarPoint(nov, gmst(nov)).lon - -4.1) < 0.3, 'EoT about +16.4 min on 3 Nov → Sun over ~4.1° W');
  const feb = T('2026-02-11T12:00:00Z'); assert.ok(Math.abs(subsolarPoint(feb, gmst(feb)).lon - 3.55) < 0.3, 'EoT about −14.2 min on 11 Feb → Sun over ~3.55° E');
});

test('terminator moves west about 15° per hour', () => {
  const t0 = T('2026-10-11T00:00:00Z');
  for (let h = 0; h < 24; h++) {
    const a = subsolarPoint(t0 + h * 3600e3, gmst(t0 + h * 3600e3)), b = subsolarPoint(t0 + (h + 1) * 3600e3, gmst(t0 + (h + 1) * 3600e3));
    const dl = ((b.lon - a.lon + 540) % 360) - 180;
    assert.ok(dl < -14.9 && dl > -15.1, `hour ${h}: ${dl}°`);
  }
});

test('frames: subsolar point drawn on the globe lines up with the Sun direction used for lighting', () => {
  for (const s of ['2026-01-01T00:00:00Z', '2026-03-20T06:00:00Z', '2026-06-21T18:30:00Z', '2026-10-11T11:41:00Z']) {
    const ms = T(s), g = gmst(ms), p = subsolarPoint(ms, g);
    const surface = geoToScene(p.lat, p.lon, g), light = eciToScene(sunEci(ms));
    assert.ok(Math.hypot(surface[0] - light[0], surface[1] - light[1], surface[2] - light[2]) < 1e-9, s);
    // the antipode is in full night
    assert.ok(dot(geoToScene(-p.lat, p.lon + 180, g), light) < -0.999999, s);
  }
});

test('frames: geoToScene matches satellite.js ECF→ECI followed by the scene axis swap', () => {
  let seed = 11; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  for (let k = 0; k < 500; k++) {
    const lat = (rnd() * 2 - 1) * 90, lon = (rnd() * 2 - 1) * 180, g = rnd() * 2 * Math.PI;
    // a point on a sphere (geocentric latitude), in Earth-fixed axes
    const ecf = { x: Math.cos(lat * D2R) * Math.cos(lon * D2R), y: Math.cos(lat * D2R) * Math.sin(lon * D2R), z: Math.sin(lat * D2R) };
    const eci = sat.ecfToEci(ecf, g), mine = geoToScene(lat, lon, g);
    const ref = eciToScene([eci.x, eci.y, eci.z]);
    assert.ok(Math.hypot(mine[0] - ref[0], mine[1] - ref[1], mine[2] - ref[2]) < 1e-12, `${lat},${lon},${g}`);
  }
});

// Minimal PNG reader for the 8-bit greyscale ocean mask (no dependencies): inflate the IDAT stream and undo the row filters.
function readGreyPng(file) {
  const b = fs.readFileSync(file), idat = [];
  let w = 0, h = 0;
  for (let o = 8; o < b.length;) {
    const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); assert.equal(d[8], 8); assert.equal(d[9], 0, 'greyscale'); assert.equal(d[12], 0, 'not interlaced'); }
    if (type === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (w + 1)], row = raw.subarray(y * (w + 1) + 1, (y + 1) * (w + 1));
    for (let x = 0; x < w; x++) {
      const a = x ? px[y * w + x - 1] : 0, up = y ? px[(y - 1) * w + x] : 0, c = x && y ? px[(y - 1) * w + x - 1] : 0;
      const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
      const pred = [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : c][f];
      px[y * w + x] = (row[x] + pred) & 255;
    }
  }
  return { w, h, px };
}

test('Earth texture lines up with the frames: a place drawn on the globe samples its own spot on the map', () => {
  // The globe is THREE.SphereGeometry(1) turned by earth.rotation.y = GMST. Undo that turn, then apply SphereGeometry's
  // own vertex formula (x = −cos(2πu)·sinθ, y = cosθ, z = sin(2πu)·sinθ, texture row from the top = θ/π) to find the
  // texel each place lands on, and check it against the ocean mask made from the day map.
  const m = readGreyPng(path.join(ROOT, 'public/textures/ocean-mask-2048.png'));
  const texel = (lat, lon, g) => {
    const [X, Y, Z] = geoToScene(lat, lon, g), c = Math.cos(g), s = Math.sin(g);
    const x = X * c - Z * s, z = X * s + Z * c, th = Math.acos(Math.max(-1, Math.min(1, Y)));
    const u = ((Math.atan2(z, -x) / (2 * Math.PI)) % 1 + 1) % 1;
    return m.px[Math.min(m.h - 1, Math.floor(th / Math.PI * m.h)) * m.w + Math.min(m.w - 1, Math.floor(u * m.w))];
  };
  const land = [['Sahara', 23, 10], ['Amazon', -5, -62], ['Siberia', 62, 100], ['central Australia', -24, 133], ['Great Plains', 40, -100], ['Tibet', 33, 88]];
  const sea = [['mid-Atlantic', 0, -30], ['central Pacific', 0, -150], ['Indian Ocean', -20, 80], ['North Pacific', 35, 170], ['Gulf of Guinea', 2, 3], ['Tasman Sea', -40, 160]];
  for (const g of [0, 1.234, 4.5]) {
    for (const [name, lat, lon] of land) assert.ok(texel(lat, lon, g) < 40, `${name} should be land`);
    for (const [name, lat, lon] of sea) assert.ok(texel(lat, lon, g) > 215, `${name} should be water`);
  }
});

test('Earth textures: served at both sizes, day and night maps match the documented source files', () => {
  const tex = f => path.join(ROOT, 'public/textures', f), sha = f => crypto.createHash('sha256').update(fs.readFileSync(tex(f))).digest('hex');
  // Solar System Scope 4096 maps, byte-identical to three.js examples/textures/planets/earth_{day,night}_4096.jpg (see ASSETS.md)
  assert.equal(sha('earth-day-4096.jpg'), 'cd7712d3e891425d9948ea5ac18d3bb1e7e834ea038188587897e689a7b35d0f');
  assert.equal(sha('earth-night-4096.jpg'), '17a868f79c7be40fa1f557e6114d7889d907f18f7a3fce51f33b0b830ef50242');
  for (const f of ['earth-day-2048.jpg', 'earth-night-2048.jpg', 'ocean-mask-2048.png']) assert.ok(fs.statSync(tex(f)).size > 50e3, f);
  for (const f of ['earth-day', 'earth-night']) assert.match(app, new RegExp(`textures/${f}-\\$\\{sz\\}\\.jpg`));
  assert.match(app, /EARTH_MASK = 'textures\/ocean-mask-2048\.png'/);
});
