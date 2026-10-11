'use strict';
/* Project Skyline (formerly OrbitWatch) · hackPHS 2026
   Data: CelesTrak GP elements (OMM JSON) → satellite.js SGP4 → three.js globe.
   SignalScope: geometric visibility of internet-constellation satellites from a chosen place (see the SignalScope section).
   Fallback order when live data is unavailable: browser cache → embedded snapshot → labelled demo data. */

// ───────────────────────── constants
const $ = id => document.getElementById(id);
const RS = 6371;          // scene unit = Earth mean radius, km
const REQ = 6378.137;     // equatorial radius, km (perigee/apogee altitudes)
const MU = 398600.4418;   // km³/s²
const D2R = Math.PI / 180, R2D = 180 / Math.PI, TAU = Math.PI * 2;
const HAS_SAT = typeof satellite !== 'undefined' && typeof satellite.json2satrec === 'function';
const HAS_THREE = typeof THREE !== 'undefined';
const EARTH_IMG = '__EARTH__';
const SNAPSHOT = __SNAPSHOT__;  // null, or {fetchedAt, groups:{key:{rows:[…]}}} in the cache format below
const STARS = __STARS__;        // null, or flat [RA×100, Dec×100, Vmag×100, B−V×100, …] from src/stars.json (see ASSETS.md)
const EARTH_MASK = 'textures/ocean-mask-2048.png';   // day / night maps and this mask are served from public/textures; the embedded image is the fallback
const CT = 'https://celestrak.org/NORAD/elements/gp.php';
const CACHE_KEY = 'orbitwatch.v3.cache', INTRO_KEY = 'orbitwatch.v3.introSeen', REFUSED_KEY = 'orbitwatch.v3.refusedAt';
const CACHE_TTL = 2 * 3600e3;   // CelesTrak updates GP data about every 2 hours; don't re-download sooner
// Data sources, in the order they are tried (see README):
//  1. this browser's cache, if younger than CACHE_TTL (skipped by Refresh)
//  2. API_BASE: this site's own API (worker/api.mjs on Cloudflare), which downloads from CelesTrak on a schedule and stores it
//  3. HOSTED_DATA: a static copy on the same website (tools/fetch-celestrak.mjs), for hosts that cannot run a server
//  4. CelesTrak directly from the browser, only if BROWSER_FETCH is true (off: browsers behind one school or
//     hackathon network share an IP, and CelesTrak allows one download per IP per update)
//  5. the newest of: a stale copy from 2-4, a stale browser cache, the SNAPSHOT built into the page
//  6. labelled demo data
const API_BASE = 'api/gp';                   // '' to disable
const HOSTED_DATA = 'data/celestrak.json';   // '' to disable
const HOSTED_FRESH = 3 * 3600e3;
const STALE_AFTER = 3 * 3600e3;              // elements downloaded longer ago than this are flagged as stale
const BROWSER_FETCH = false;
const GROUPS = [
  { key: 'stations', label: 'Space stations', note: 'crewed stations and the vehicles visiting them' },
  { key: 'active', label: 'Active satellites', note: 'payloads CelesTrak lists as operating' },
  { key: 'visual', label: 'Brightest objects', note: 'adds rocket bodies and inactive satellites' },
  { key: 'fengyun-1c-debris', label: 'Fengyun-1C debris', note: '2007 anti-satellite test' },
  { key: 'iridium-33-debris', label: 'Iridium 33 debris', note: '2009 collision' },
  { key: 'cosmos-2251-debris', label: 'Cosmos 2251 debris', note: '2009 collision' },
];
const TYPES = {
  active:   { label: 'Active satellites',  one: 'Active satellite',   color: '#62c6f0', shape: 'dot',     size: 4, tip: 'Payloads on CelesTrak’s list of active satellites' },
  inactive: { label: 'Inactive satellites', one: 'Inactive satellite', color: '#b2bccb', shape: 'ring',    size: 7, tip: 'Payloads that are not on the active list (dead or retired)' },
  rocket:   { label: 'Rocket bodies',       one: 'Rocket body',        color: '#e8c76a', shape: 'square',  size: 6, tip: 'Spent upper stages left in orbit after launch' },
  debris:   { label: 'Debris',              one: 'Debris',             color: '#f08356', shape: 'diamond', size: 5, tip: 'Fragments from breakups, tests and collisions' },
  sim:      { label: 'Simulated fragments', one: 'Simulated fragment', color: '#e86ad0', shape: 'cross',   size: 6, tip: 'Created by the breakup simulator. Not real.' },
};
const TYPE_KEYS = ['active', 'inactive', 'rocket', 'debris', 'sim'];
const REGIMES = {
  LEO: { label: 'LEO · low Earth orbit', tip: 'Up to 2,000 km' },
  MEO: { label: 'MEO · medium Earth orbit', tip: '2,000 to 35,786 km, e.g. GPS' },
  GEO: { label: 'GEO · geostationary belt', tip: 'About 35,786 km over the equator' },
  HEO: { label: 'HEO · highly elliptical', tip: 'Very stretched orbits (eccentricity above 0.25)' },
};
const FEATURED = [
  { key: 'iss', ids: [25544], re: /^ISS \(ZARYA\)|^ISS\b/, label: 'ISS', why: 'Crewed space station' },
  { key: 'css', ids: [48274], re: /^CSS \(TIANHE\)|TIANHE/, label: 'Tiangong', why: 'China’s crewed space station' },
  { key: 'hst', ids: [20580], re: /^HST$/, label: 'Hubble', why: 'Space telescope, launched 1990' },
  { key: 'noaa', ids: [43013], re: /^NOAA 20/, label: 'NOAA-20', why: 'Polar weather satellite' },
  { key: 'gps', ids: [], re: /^GPS B/, label: 'GPS', why: 'Navigation, about 20,200 km up' },
  { key: 'goes', ids: [], re: /^GOES 1[6-9]/, label: 'GOES', why: 'Geostationary weather satellite' },
  { key: 'fy', ids: [], re: /^FENGYUN 1C DEB/, label: 'Fengyun-1C debris', why: 'Fragment from the 2007 test' },
  { key: 'van', ids: [5], re: /^VANGUARD 1$/, label: 'Vanguard 1', why: 'Oldest object still in orbit (1958)' },
];
const SIM_CAP = 1200;

// ───────────────────────── small helpers
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = n => Number(n).toLocaleString('en-US');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const jdOf = ms => ms / 864e5 + 2440587.5;
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = a => Math.hypot(a[0], a[1], a[2]);
const utc = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const localT = ms => new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
function dur(min) { min = Math.abs(min); if (min < 1) return Math.round(min * 60) + ' s'; if (min < 90) return Math.round(min) + ' min'; if (min < 48 * 60) return (min / 60).toFixed(1) + ' h'; return (min / 1440).toFixed(1) + ' days'; }
function age(ms) { const h = ms / 3600e3; return h < 1 ? Math.round(h * 60) + ' min' : h < 48 ? h.toFixed(1) + ' h' : (h / 24).toFixed(1) + ' days'; }
const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
let toastT = 0;
function toast(msg, ms = 3200) { const t = $('toast'); t.textContent = msg; t.classList.remove('show'); void t.offsetWidth; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
};

// ───────────────────────── time, Sun and frames (pure functions, tested in test/frames.test.mjs)
// Frames. Orbital positions are ECI (TEME, from SGP4). The scene uses three.js axes: ECI x → scene x, ECI z (Earth's
// axis) → scene y, ECI y → scene −z. The globe mesh is turned about scene y by Greenwich sidereal time
// (earth.rotation.y = gmst), and its texture puts longitude 0 on local +x, 90° E on local −z.
const eciToScene = r => [r[0], r[2], -r[1]];
function geoToScene(latDeg, lonDeg, gmst, k = 1) {
  const f = latDeg * D2R, l = lonDeg * D2R, x = Math.cos(f) * Math.cos(l), y = Math.sin(f), z = -Math.cos(f) * Math.sin(l), c = Math.cos(gmst), s = Math.sin(gmst);
  return [(x * c + z * s) * k, y * k, (-x * s + z * c) * k];
}
// Sun. Geocentric direction from the Astronomical Almanac low-precision formula (good to about 0.01° for 1950–2050),
// as a unit vector in the mean equator and equinox of date, which is close enough to TEME for lighting.
function sunEci(ms) {
  const n = ms / 864e5 + 2440587.5 - 2451545, L = (280.46 + 0.9856474 * n) * D2R, g = (357.528 + 0.9856003 * n) * D2R;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R, eps = (23.439 - 4e-7 * n) * D2R;
  return [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)];
}
// The point on Earth with the Sun straight overhead: the centre of the lit hemisphere, which the terminator surrounds.
function subsolarPoint(ms, gmst) {
  const s = sunEci(ms); let lon = (Math.atan2(s[1], s[0]) - gmst) * R2D;
  lon = ((lon + 540) % 360) - 180;
  return { lat: Math.asin(s[2]) * R2D, lon };
}
// Reference clock for New York. The IANA zone handles EST/EDT; nothing is hard-coded and the viewer's own zone is ignored.
let nyFmt = null;
function nyClock(ms) {
  if (!nyFmt) nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
  const p = {}; for (const x of nyFmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  // engines without abbreviations report "GMT-4" / "GMT-5"; New York only uses these two offsets
  const abbr = /^[A-Z]{3,4}$/.test(p.timeZoneName) ? p.timeZoneName : p.timeZoneName === 'GMT-4' ? 'EDT' : p.timeZoneName === 'GMT-5' ? 'EST' : p.timeZoneName;
  return { time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`, abbr, date: `${p.weekday} ${p.day} ${p.month}` };
}
// Offset of the simulation clock from real time, e.g. "+00:15:00", "−02:03:10", "+3 d 04:00:00"
function fmtSimOffset(ms) {
  const sg = ms < 0 ? '−' : '+', t = Math.round(Math.abs(ms) / 1000), d = Math.floor(t / 86400), h = Math.floor(t / 3600) % 24, m = Math.floor(t / 60) % 60, s = t % 60;
  const pad = v => String(v).padStart(2, '0');
  return `${sg}${d ? d + ' d ' : ''}${pad(h)}:${pad(m)}:${pad(s)}`;
}
// ── end of pure block

// ───────────────────────── orbital mechanics
function gmstAt(ms) {
  if (HAS_SAT) return satellite.gstime(new Date(ms));
  const T = (jdOf(ms) - 2451545) / 36525;
  const s = 67310.54841 + (876600 * 3600 + 8640184.812866) * T + 0.093104 * T * T - 6.2e-6 * T * T * T;
  return (((s % 86400) / 240 * D2R) % TAU + TAU) % TAU;
}
// two-body propagation with universal variables (demo objects and simulated fragments)
function stumpC(z) { if (z > 1e-8) { const s = Math.sqrt(z); return (1 - Math.cos(s)) / z; } if (z < -1e-8) { const s = Math.sqrt(-z); return (Math.cosh(s) - 1) / -z; } return 0.5; }
function stumpS(z) { if (z > 1e-8) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); } if (z < -1e-8) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s); } return 1 / 6; }
function kepler(r0v, v0v, dt) {
  const r0 = len3(r0v), v0 = len3(v0v), vr0 = dot3(r0v, v0v) / r0, alpha = 2 / r0 - v0 * v0 / MU, sm = Math.sqrt(MU);
  if (alpha > 0) { const T = TAU * Math.sqrt(1 / (alpha * alpha * alpha) / MU); dt = ((dt % T) + T) % T; }
  let x = sm * Math.abs(alpha) * dt;
  for (let n = 0; n < 60; n++) {
    const z = alpha * x * x, C = stumpC(z), S = stumpS(z);
    const F = r0 * vr0 / sm * x * x * C + (1 - alpha * r0) * x * x * x * S + r0 * x - sm * dt;
    const dF = r0 * vr0 / sm * x * (1 - alpha * x * x * S) + (1 - alpha * r0) * x * x * C + r0;
    const step = F / dF; x -= step; if (Math.abs(step) < 1e-9) break;
  }
  const z = alpha * x * x, C = stumpC(z), S = stumpS(z);
  const f = 1 - x * x / r0 * C, g = dt - x * x * x / sm * S;
  const r = [f * r0v[0] + g * v0v[0], f * r0v[1] + g * v0v[1], f * r0v[2] + g * v0v[2]], rn = len3(r);
  const fd = sm / (rn * r0) * (alpha * x * x * x * S - x), gd = 1 - x * x / rn * C;
  return { r, v: [fd * r0v[0] + gd * v0v[0], fd * r0v[1] + gd * v0v[1], fd * r0v[2] + gd * v0v[2]] };
}
function circState(altKm, incDeg, raanDeg, uDeg) {
  const a = RS + altKm, i = incDeg * D2R, W = raanDeg * D2R, u = uDeg * D2R, vc = Math.sqrt(MU / a);
  const cW = Math.cos(W), sW = Math.sin(W), ci = Math.cos(i), si = Math.sin(i), cu = Math.cos(u), su = Math.sin(u);
  return { r: [a * (cW * cu - sW * su * ci), a * (sW * cu + cW * su * ci), a * su * si], v: [vc * (-cW * su - sW * cu * ci), vc * (-sW * su + cW * cu * ci), vc * cu * si] };
}
// ECI state (km, km/s) of object o at time ms, or null if it cannot be computed
function eciAt(o, ms) {
  if (o.satrec) {
    let p; try { p = satellite.sgp4(o.satrec, (jdOf(ms) - o.satrec.jdsatepoch) * 1440); } catch (e) { return null; }
    if (!p || !p.position || !isFinite(p.position.x)) return null;
    const r = [p.position.x, p.position.y, p.position.z], d = len3(r);
    // below the surface, or far beyond the orbit's own apogee: SGP4 has diverged (typically an object that has re-entered
    // since its elements were published). Show no position rather than a wrong one.
    if (d < RS - 10 || (o.apogee > 0 && d > (REQ + o.apogee) * 1.5 + 1000)) return null;
    return { r, v: [p.velocity.x, p.velocity.y, p.velocity.z] };
  }
  return kepler(o.r0, o.v0, (ms - o.t0) / 1000);
}
const toScene = (r, out, k) => { out[k] = r[0] / RS; out[k + 1] = r[2] / RS; out[k + 2] = -r[1] / RS; };
function geodetic(r, gmst) {
  if (HAS_SAT) { const g = satellite.eciToGeodetic({ x: r[0], y: r[1], z: r[2] }, gmst); return { lat: g.latitude * R2D, lon: g.longitude * R2D, h: g.height }; }
  let lon = Math.atan2(r[1], r[0]) - gmst; lon = ((lon + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return { lat: Math.atan2(r[2], Math.hypot(r[0], r[1])) * R2D, lon: lon * R2D, h: len3(r) - RS };
}
function regimeOf(o) {
  if (o.ecc > 0.25) return 'HEO';
  const h = o.meanAlt;
  if (h < 2000) return 'LEO';
  if (Math.abs(h - 35786) < 600 && o.inc < 20) return 'GEO';
  return 'MEO';
}
// SGP4 self-test against Vallado et al. (2006) verification case, catalog 00005
let selfTest = null;
function runSelfTest() {
  if (!HAS_SAT) return (selfTest = { ok: false, msg: 'satellite.js did not load, so SGP4 could not be checked.' });
  try {
    const s = satellite.twoline2satrec('1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753', '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667');
    const ref = [[0, 7022.46529266, -1400.08296755, 0.03995155], [360, -7154.03120202, -3783.17682504, -3536.19412294]];
    let worst = 0;
    for (const [t, x, y, z] of ref) { const p = satellite.sgp4(s, t).position; worst = Math.max(worst, Math.hypot(p.x - x, p.y - y, p.z - z) * 1000); }
    selfTest = { ok: worst < 1, msg: worst < 1 ? `SGP4 matches the Vallado reference case (catalog 00005, 0 and 360 min) to within ${worst < 0.01 ? '1 cm' : worst.toFixed(2) + ' m'}.` : `SGP4 differs from the reference case by ${worst.toFixed(1)} m. Treat positions with caution.` };
  } catch (e) { selfTest = { ok: false, msg: 'SGP4 self-test failed to run: ' + e.message }; }
  return selfTest;
}

// ───────────────────────── data: fetch, cache, snapshot, demo
const OMM_FIELDS = ['NORAD_CAT_ID', 'OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];
const toRow = m => OMM_FIELDS.map(f => m[f] ?? null);
const fromRow = r => Object.fromEntries(OMM_FIELDS.map((f, i) => [f, r[i]]));
let loadPromise = null;

// A page whose Content-Security-Policy forbids connecting to celestrak.org (a claude.ai artifact, for one) reports it here.
let cspBlock = null;
document.addEventListener('securitypolicyviolation', e => {
  if (/celestrak\.(org|com)/i.test(e.blockedURI || '')) cspBlock = e.effectiveDirective || e.violatedDirective || 'connect-src';
});
const tick = ms => new Promise(r => setTimeout(r, ms));
// A signal that aborts when `parent` aborts or after `ms`; call done() when finished.
function timed(parent, ms) {
  const c = new AbortController(), t = setTimeout(() => { c.timedOut = true; c.abort(); }, ms), on = () => c.abort();
  parent.addEventListener('abort', on);
  return { signal: c.signal, timedOut: () => !!c.timedOut, done() { clearTimeout(t); parent.removeEventListener('abort', on); } };
}

async function fetchGroup(key, signal) {
  const t = timed(signal, 15000);
  try {
    const res = await fetch(`${CT}?GROUP=${encodeURIComponent(key)}&FORMAT=json`, { signal: t.signal, cache: 'no-cache' });
    if (res.status === 403 || res.status === 429) return { ok: false, http: true, refused: true, reason: `CelesTrak refused the request (HTTP ${res.status}), usually a download limit. Try again in a couple of hours.` };
    if (!res.ok) return { ok: false, http: true, reason: `CelesTrak answered HTTP ${res.status}.` };
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (e) { return { ok: false, http: true, reason: `CelesTrak sent a non-JSON reply: "${text.slice(0, 60).trim()}"` }; }
    if (!Array.isArray(data) || !data.length) return { ok: false, http: true, reason: 'CelesTrak returned no objects for this group.' };
    return { ok: true, rows: data.map(toRow) };
  } catch (e) {
    if (signal.aborted) return { ok: false, http: false, reason: 'You chose demo data while loading.' };
    if (t.timedOut()) return { ok: false, http: false, reason: 'Timed out after 15 s.' };
    await tick(120);   // the policy-violation event arrives just after the failed fetch
    if (cspBlock) return { ok: false, http: false, blocked: true, reason: `This page’s security policy (${cspBlock}) does not allow downloads from celestrak.org. Claude artifacts block all outside downloads; the exported app is not affected.` };
    if (navigator.onLine === false) return { ok: false, http: false, reason: 'This device is offline.' };
    return { ok: false, http: false, reason: 'The browser got no usable reply from celestrak.org. It may be offline, blocked by a network filter, or not allowed for this website (CORS).' };
  } finally { t.done(); }
}
async function fetchAll(signal, onStep) {
  const ds = { fetchedAt: 0, fetchedBy: 'browser', groups: {}, failed: {} };
  for (let k = 0; k < GROUPS.length; k++) {
    const g = GROUPS[k]; onStep(k, g);
    const r = await fetchGroup(g.key, signal);
    if (r.ok) ds.groups[g.key] = { rows: r.rows }; else ds.failed[g.key] = r.reason;
    if (signal.aborted) break;
    if (r.refused) {  // CelesTrak is refusing us: stop instead of hammering it, and don't ask again for a while
      refusedAtMem = Date.now(); store.set(REFUSED_KEY, String(refusedAtMem));
      for (const g2 of GROUPS.slice(k + 1)) ds.failed[g2.key] = 'Skipped after CelesTrak refused a request.';
      break;
    }
    if (!r.ok) {  // CelesTrak asks clients to stop at the first non-200 reply
      for (const g2 of GROUPS.slice(k + 1)) ds.failed[g2.key] = r.blocked ? 'Skipped: this page may not contact celestrak.org.' : 'Skipped after the previous request failed.';
      break;
    }
  }
  ds.fetchedAt = Date.now();   // after the downloads, so the 2-hour wait counts from the last one
  return ds;
}
// This site's own data server (worker/api.mjs). Returns {none, reason} when the site has no such server.
async function fetchApi(signal, onStep) {
  const ds = { fetchedAt: 0, fetchedBy: 'server', src: 'api', groups: {}, failed: {} };
  for (let k = 0; k < GROUPS.length; k++) {
    const g = GROUPS[k]; onStep(k, g);
    let res = null, body = null; const t = timed(signal, 45000);
    try { res = await fetch(`${API_BASE}?group=${encodeURIComponent(g.key)}`, { signal: t.signal, cache: 'no-cache', headers: { Accept: 'application/json' } }); } catch (e) { }
    if (signal.aborted) { t.done(); break; }
    const isJson = res && /json/.test(res.headers.get('content-type') || '');
    if (k === 0 && (!res || !isJson || res.status === 404 || res.status === 405)) return t.done(), { none: true, reason: res && !res.ok ? `This site has no data server (HTTP ${res.status}).` : res ? 'This site has no data server.' : 'This site has no data server, or it did not answer.' };
    if (isJson) try { body = await res.json(); } catch (e) { }
    t.done();
    if (!res || !res.ok || !body) { ds.failed[g.key] = (body && body.error) || (res ? `The data server answered HTTP ${res.status}.` : 'The data server did not answer.'); continue; }
    // the Cloudflare Worker sends CelesTrak's records verbatim ("format": "omm"); the older Node server sent compact rows. Both are validated in useDataset.
    const omm = Array.isArray(body.records);
    const d = normDataset({ fetchedAt: body.fetchedAt, fields: omm ? OMM_FIELDS : body.fields, groups: { [g.key]: { rows: omm ? body.records.filter(m => m && typeof m === 'object').map(toRow) : body.rows } } });
    const rows = d && d.groups[g.key] ? d.groups[g.key].rows : [];
    if (!rows.length) { ds.failed[g.key] = 'The data server returned no objects for this group.'; continue; }
    ds.groups[g.key] = { rows, fetchedAt: body.fetchedAt, stale: !!body.stale, lastError: body.lastError || null };
  }
  const got = Object.values(ds.groups);
  ds.fetchedAt = got.length ? Math.min(...got.map(g => g.fetchedAt)) : Date.now();   // the oldest group decides how fresh the set is
  ds.stale = got.some(g => g.stale);
  return ds;
}
// Accepts the cache/snapshot/hosted format {fetchedAt, groups:{key:{rows}}, fields?}. Rows are re-ordered if `fields` differs.
function normDataset(d) {
  if (!d || typeof d !== 'object' || !d.groups || typeof d.groups !== 'object' || !isFinite(d.fetchedAt)) return null;
  if (Array.isArray(d.fields) && d.fields.join() !== OMM_FIELDS.join()) {
    const idx = OMM_FIELDS.map(f => d.fields.indexOf(f));
    if (idx[0] < 0 || idx[3] < 0 || idx[4] < 0) return null;
    for (const g of Object.values(d.groups)) if (g && Array.isArray(g.rows)) g.rows = g.rows.map(r => idx.map(i => i < 0 ? null : r[i]));
    d.fields = OMM_FIELDS.slice();
  }
  for (const k of Object.keys(d.groups)) if (!d.groups[k] || !Array.isArray(d.groups[k].rows)) delete d.groups[k];
  return d;
}
function embeddedSnapshot() { const d = normDataset(SNAPSHOT); if (d) d.src = 'embedded'; return d; }
function readCache() { const s = store.get(CACHE_KEY); if (!s) return null; try { const d = normDataset(JSON.parse(s)); if (d) d.fromCache = true; return d; } catch (e) { return null; } }
// A static copy on this website (written by tools/fetch-celestrak.mjs). Same-origin, so it works wherever the page itself loads.
async function fetchHosted(signal) {
  if (!HOSTED_DATA || location.protocol === 'file:') return { ds: null, reason: 'No hosted copy (page opened as a file).' };
  const t = timed(signal, 20000);
  try {
    const res = await fetch(HOSTED_DATA, { signal: t.signal, cache: 'no-cache' });
    if (!res.ok) return { ds: null, reason: `No hosted copy (HTTP ${res.status}).` };
    const ds = normDataset(await res.json());
    if (ds) ds.src = 'hosted';
    return ds && Object.keys(ds.groups).length ? { ds } : { ds: null, reason: 'The hosted copy is not in the expected format.' };
  } catch (e) { return { ds: null, reason: t.timedOut() ? 'The hosted copy took too long.' : 'No hosted copy could be read.' }; }
  finally { t.done(); }
}

let loadCtl = null, userChoseDemo = false, refusedAtMem = 0, lastBrowserFetch = 0;
function loadData(opts = {}) {
  if (opts.demo && loadCtl) { userChoseDemo = true; loadCtl.abort(); }   // "use demo data" while a load is running
  if (loadPromise) return loadPromise;   // no duplicate downloads
  loadPromise = (async () => {
    showLoading(true); userChoseDemo = false;
    if (!HAS_SAT) return useDemo('The orbit library (satellite.js) did not load, so real positions cannot be calculated.');
    if (opts.demo) return useDemo('You switched to demo data.');
    loadCtl = new AbortController(); const signal = loadCtl.signal;
    const chose = () => userChoseDemo || signal.aborted;
    const now = Date.now(), cache = readCache(), fresh = (d, ttl) => d && d.fetchedAtKind !== 'newest-epoch' && now - d.fetchedAt < ttl && d.fetchedAt <= now + 6e5;
    if (fresh(cache, CACHE_TTL) && !opts.force) return useDataset(cache, 'cached', 'Loaded from this browser’s cache to avoid re-downloading data that has not changed.');
    const notes = [];
    // 1. this site's data server
    let api = { none: true };
    if (API_BASE && location.protocol !== 'file:') {
      setLoading('Asking this site’s data server for orbital elements…', 0.04);
      api = await fetchApi(signal, (k, g) => setLoading(`Loading ${g.label} from this site’s data server (${k + 1} of ${GROUPS.length})`, (k + 0.5) / GROUPS.length));
      if (chose()) return useDemo('You chose demo data while loading.');
      if (!api.none) {
        if (Object.keys(api.groups).length) {
          if (!store.set(CACHE_KEY, JSON.stringify(api))) console.info('OrbitWatch: data too large for browser cache.');
          const failed = Object.keys(api.failed).length;
          return useDataset(api, api.stale || now - api.fetchedAt > STALE_AFTER ? 'stale' : 'live', failed ? `${failed} group(s) could not be loaded. See the list below.` : '');
        }
        const reasons = [...new Set(Object.values(api.failed))];
        notes.push('The data server has no data yet: ' + reasons[0]);
      }
    }
    // 2. a static copy on this website
    setLoading('Looking for a stored copy of the data on this website…', 0.5);
    const hosted = await fetchHosted(signal);
    if (chose()) return useDemo('You chose demo data while loading.');
    if (fresh(hosted.ds, HOSTED_FRESH)) return useDataset(hosted.ds, 'hosted', notes.join(' '));
    // 3. CelesTrak directly (off by default)
    let ds = null;
    const refusedAt = Math.max(+store.get(REFUSED_KEY) || 0, refusedAtMem);
    if (!BROWSER_FETCH) { if (api.none && !hosted.ds) notes.push(api.reason || 'This site has no data server.'); }
    else if (now - refusedAt < CACHE_TTL) notes.push(`CelesTrak refused a request from this browser at ${utc(refusedAt)}. Not asking again until ${utc(refusedAt + CACHE_TTL)}.`);
    else if (fresh(cache, CACHE_TTL)) {   // Refresh within 2 h of a download: CelesTrak has nothing newer and would refuse
      toast(`Data is ${age(now - cache.fetchedAt)} old. CelesTrak updates about every 2 hours, so no new download is needed yet.`, 5000);
      return useDataset(cache, 'cached', 'Kept the cached copy: CelesTrak has probably not updated yet.');
    }
    else if (now - lastBrowserFetch < CACHE_TTL) notes.push('This browser already downloaded from CelesTrak in the last 2 hours but could not store it, so it is not asking again yet.');
    else {
      ds = await fetchAll(signal, (k, g) => setLoading(`Downloading ${g.label} from CelesTrak (${k + 1} of ${GROUPS.length})`, (k + 0.5) / GROUPS.length));
      if (chose()) return useDemo('You chose demo data while loading.');
      if (Object.keys(ds.groups).length) {
        lastBrowserFetch = Date.now();
        const failed = Object.keys(ds.failed).length;
        if (!store.set(CACHE_KEY, JSON.stringify(ds))) console.info('OrbitWatch: data too large for browser cache.');
        return useDataset(ds, 'live', failed ? `${failed} group(s) could not be loaded. See the list below.` : '');
      }
      notes.push('Live download failed: ' + (Object.values(ds.failed)[0] || 'unknown error.'));
    }
    // 4. the newest copy available
    const fallbacks = [hosted.ds && { d: hosted.ds, m: 'snapshot' },   // a copy stored with the site is a snapshot once it is older than a few hours
       cache && { d: cache, m: now - cache.fetchedAt > STALE_AFTER ? 'stale' : 'cached' }, SNAPSHOT && { d: embeddedSnapshot(), m: 'snapshot' }]
      .filter(f => f && f.d).sort((a, b) => b.d.fetchedAt - a.d.fetchedAt);
    if (fallbacks.length) return useDataset(fallbacks[0].d, fallbacks[0].m, notes.join(' '), true);
    return useDemo('Real orbital data could not be loaded. ' + notes.join(' '));
  })().finally(() => { loadPromise = null; loadCtl = null; showLoading(false); });
  return loadPromise;
}

// ───────────────────────── object store
let objs = [], N = 0, CAP = 0;
let base, vel, stamp, pos, bad, vis, fu, fp;
let data = { mode: 'loading' };
let simCount = 0;

function classify(m, groupKey, activeIds) {
  const n = String(m.OBJECT_NAME || '').toUpperCase();
  if (/\bR\/B\b/.test(n)) return 'rocket';
  if (/\bDEB\b|DEBRIS|\bCOOLANT\b/.test(n) || groupKey.endsWith('-debris')) return 'debris';
  if (activeIds.has(+m.NORAD_CAT_ID) || groupKey === 'stations') return 'active';
  return 'inactive';
}
function validOMM(m) {
  const num = f => m[f] !== null && m[f] !== '' && isFinite(+m[f]);
  return num('NORAD_CAT_ID') && typeof m.EPOCH === 'string' && !isNaN(Date.parse(m.EPOCH.endsWith('Z') ? m.EPOCH : m.EPOCH + 'Z')) && num('MEAN_MOTION') && +m.MEAN_MOTION > 0
    && num('ECCENTRICITY') && +m.ECCENTRICITY >= 0 && +m.ECCENTRICITY < 1 && ['INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY'].every(num);
}
function derive(o, n_revday, ecc, inc) {
  o.period = 1440 / n_revday;
  const a = Math.cbrt(MU * Math.pow(o.period * 60 / TAU, 2));
  o.ecc = ecc; o.inc = inc;
  o.perigee = a * (1 - ecc) - REQ; o.apogee = a * (1 + ecc) - REQ; o.meanAlt = a - REQ;
  o.regime = regimeOf(o);
}
function useDataset(ds, mode, note, fallback) {
  setLoading('Computing orbits with SGP4…', 0.95);
  const activeIds = new Set(((ds.groups.active || {}).rows || []).map(r => +r[0]));
  const byId = new Map(); let skipped = 0, filled = 0;
  for (const g of GROUPS) {
    const grp = ds.groups[g.key]; if (!grp) continue;
    for (const row of grp.rows) {
      const m = fromRow(row);
      if (!validOMM(m)) { skipped++; continue; }
      const id = +m.NORAD_CAT_ID;
      if (byId.has(id)) { byId.get(id).groups.push(g.key); continue; }
      for (const f of ['BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT']) if (m[f] === null || m[f] === '' || !isFinite(+m[f])) { m[f] = 0; filled++; }
      let satrec; try { satrec = satellite.json2satrec(m); } catch (e) { skipped++; continue; }
      if (!satrec || satrec.error) { skipped++; continue; }
      const o = { id, cat: String(id).padStart(5, '0'), name: String(m.OBJECT_NAME || 'UNKNOWN').trim(), intl: m.OBJECT_ID || '', type: classify(m, g.key, activeIds), groups: [g.key],
        epoch: Date.parse(m.EPOCH.endsWith('Z') ? m.EPOCH : m.EPOCH + 'Z'), satrec };
      derive(o, +m.MEAN_MOTION, +m.ECCENTRICITY, +m.INCLINATION);
      byId.set(id, o);
    }
  }
  const list = [...byId.values()];
  if (!list.length) return useDemo('The data that loaded contained no usable orbital elements.');
  if (!ds.groups.active && list.some(o => o.type === 'inactive'))
    note = (note ? note + ' ' : '') + 'The active-satellite list did not load, so only space stations are marked active; other payloads show as inactive and may be wrong.';
  const epochs = list.map(o => o.epoch).sort((a, b) => a - b);
  setObjects(list, {
    mode, note, fetchedAt: ds.fetchedAt, skipped, filled, fallback: !!fallback,
    src: ds.fromCache ? 'browser-cache' : ds.src || (mode === 'live' ? 'browser' : 'embedded'),
    fetchedAtIsEpoch: ds.fetchedAtKind === 'newest-epoch',
    groupsOk: GROUPS.filter(g => ds.groups[g.key]).map(g => { const x = ds.groups[g.key]; return { ...g, n: list.filter(o => o.groups.includes(g.key)).length, at: x.fetchedAt || ds.fetchedAt, stale: !!x.stale, err: x.lastError || null }; }),
    groupsFailed: GROUPS.filter(g => !ds.groups[g.key]).map(g => ({ ...g, reason: (ds.failed || {})[g.key] || (mode === 'live' ? 'Not loaded.' : 'Not included in this copy.') })),
    newestEpoch: epochs[epochs.length - 1], oldestEpoch: epochs[0], medianEpoch: epochs[epochs.length >> 1],
  });
}
function useDemo(reason) {
  let seed = 7; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  const list = [], t0 = Date.now();
  const add = (name, type, alt, inc, raan, u, feat) => {
    const s = circState(alt, inc, raan, u), o = { id: 'D' + (list.length + 1), cat: 'demo', name, intl: '', type, groups: ['demo'], epoch: t0, r0: s.r, v0: s.v, t0, feat };
    derive(o, 1440 / (TAU * Math.sqrt(Math.pow(RS + alt, 3) / MU) / 60) , 0, inc);
    o.perigee = o.apogee = o.meanAlt = alt; o.regime = regimeOf(o); list.push(o);
  };
  add('ISS (demo orbit)', 'active', 420, 51.6, 0, 0, 'iss'); add('Tiangong (demo orbit)', 'active', 390, 41.5, 50, 60, 'css');
  add('Hubble (demo orbit)', 'active', 535, 28.5, 100, 120, 'hst'); add('Polar weather satellite (demo)', 'active', 824, 98.7, 150, 180, 'noaa');
  for (let k = 0; k < 720; k++) add('Broadband constellation sat ' + (k + 1) + ' (demo)', 'active', 550, 53, (k % 36) * 10, ((k / 36) | 0) * 18 + (k % 36) * 7);   // 36 planes × 20, a Walker-like shell
  for (let k = 0; k < 60; k++) add('High LEO constellation sat ' + (k + 1) + ' (demo)', 'active', 1200, 87.9, k % 12 * 15, k * 37 % 360);
  for (let k = 0; k < 24; k++) add('Navigation sat ' + (k + 1) + ' (demo)', 'active', 20200, 55, k % 6 * 60, (k / 6 | 0) * 90 + k % 6 * 15, k ? undefined : 'gps');
  for (let k = 0; k < 30; k++) add('Geostationary sat ' + (k + 1) + ' (demo)', 'active', 35786, 0.1 + rnd() * 0.5, 0, k * 12, k ? undefined : 'goes');
  for (let k = 0; k < 40; k++) add('Earth imaging sat ' + (k + 1) + ' (demo)', 'active', 690 + rnd() * 120, 98.2, rnd() * 360, rnd() * 360);
  for (let k = 0; k < 30; k++) add('Retired satellite ' + (k + 1) + ' (demo)', 'inactive', 600 + rnd() * 900, 50 + rnd() * 50, rnd() * 360, rnd() * 360);
  for (let k = 0; k < 120; k++) add('Fengyun-1C-like debris ' + (k + 1) + ' (demo)', 'debris', 780 + rnd() * 120, 98.8 + (rnd() - 0.5) * 0.8, 150 + rnd() * 60, rnd() * 360, k ? undefined : 'fy');
  for (let k = 0; k < 100; k++) add('Collision debris ' + (k + 1) + ' (demo)', 'debris', 770 + rnd() * 40, k % 2 ? 74 : 86.4, rnd() * 360, rnd() * 360);
  for (let k = 0; k < 60; k++) add('Test debris ' + (k + 1) + ' (demo)', 'debris', 450 + rnd() * 70, 82.6, rnd() * 360, rnd() * 360);
  for (let k = 0; k < 25; k++) add('Rocket body ' + (k + 1) + ' (demo)', 'rocket', 500 + rnd() * 1500, 20 + rnd() * 80, rnd() * 360, rnd() * 360);
  setObjects(list, { mode: 'demo', note: reason, fetchedAt: t0, skipped: 0, filled: 0, groupsOk: [], groupsFailed: [], newestEpoch: t0, oldestEpoch: t0, medianEpoch: t0 });
}

function setObjects(list, info) {
  clearSim(true);
  objs = list; N = list.length; CAP = N + SIM_CAP;
  objs.forEach((o, i) => { o.i = i; o.nameU = o.name.toUpperCase(); });
  base = new Float64Array(CAP * 3); vel = new Float64Array(CAP * 3); stamp = new Float64Array(CAP);
  pos = new Float32Array(CAP * 3); bad = new Uint8Array(CAP); vis = new Uint8Array(CAP); fu = new Float64Array(CAP); fp = new Float64Array(CAP);
  data = info; cursor = 0; issCache = null; passCache = null; cmpResult = null;
  resolveFeatured();
  buildBuffers();
  computeVisibility();
  refreshAll(simMs);
  sel = -1; cmpA = cmpB = -1;
  buildStats(); renderLayers(); renderBadge(); renderSuggestions(); renderSources(); renderCompare(); scopeDataChanged();
  if (scope.on && glOK) for (const t of TYPE_KEYS) { const L = layers[t]; if (L && L.mat) { L.mat.opacity = 0.14; L.mat.alphaTest = 0.01; L.mat.needsUpdate = true; } }
  const start = featured.iss != null ? featured.iss : objs.findIndex(o => o.type === 'active');
  if (start >= 0) select(start, { quiet: true });
  indexIds();
  if (obs) renderSky(true);
  if (!introShown && !store.get(INTRO_KEY)) openIntro();
}

// featured objects (educational highlights + suggestions)
let featured = {};
function resolveFeatured() {
  featured = {};
  for (const f of FEATURED) {
    let i = -1;
    if (data.mode === 'demo') i = objs.findIndex(o => o.feat === f.key);
    else { for (const id of f.ids) { i = objs.findIndex(o => o.id === id); if (i >= 0) break; } if (i < 0) i = objs.findIndex(o => f.re.test(o.nameU)); }
    if (i >= 0) featured[f.key] = i;
  }
}

// ───────────────────────── propagation scheduler
let cursor = 0, budget = 3000;
function refreshOne(i, ms) {
  const s = eciAt(objs[i], ms);
  if (!s) { bad[i] = 1; return; }
  bad[i] = 0; const k = i * 3;
  base[k] = s.r[0]; base[k + 1] = s.r[1]; base[k + 2] = s.r[2];
  vel[k] = s.v[0]; vel[k + 1] = s.v[1]; vel[k + 2] = s.v[2]; stamp[i] = ms;
  const r2 = dot3(s.r, s.r); fu[i] = MU / (r2 * Math.sqrt(r2)); fp[i] = dot3(s.r, s.v) / r2;
}
function refreshAll(ms) { const n = N + simCount; for (let i = 0; i < n; i++) refreshOne(i, ms); extrapolate(ms); }
function stepPositions(ms) {
  const n = N + simCount; if (!n) return;
  if (cursor >= n) cursor = 0;
  const t0 = performance.now(), b = Math.min(budget, n);
  for (let k = 0; k < b; k++) { refreshOne(cursor, ms); cursor = (cursor + 1) % n; }
  const took = performance.now() - t0;
  budget = clamp(Math.round(budget * (took > 0.05 ? 4 / took : 2)), 400, Math.max(400, n));
  extrapolate(ms);
}
function extrapolate(ms) {
  const n = N + simCount;
  for (let i = 0; i < n; i++) {
    const k = i * 3;
    if (bad[i]) { pos[k] = pos[k + 1] = pos[k + 2] = 0; continue; }
    // between SGP4 refreshes: Lagrange f and g series (keeps the dot on its curved path, unlike a straight line)
    const dt = (ms - stamp[i]) / 1000, d2 = dt * dt, u = fu[i], f = 1 - 0.5 * u * d2 + 0.5 * u * fp[i] * d2 * dt, g = dt - u * d2 * dt / 6;
    pos[k] = (f * base[k] + g * vel[k]) / RS; pos[k + 1] = (f * base[k + 2] + g * vel[k + 2]) / RS; pos[k + 2] = -(f * base[k + 1] + g * vel[k + 1]) / RS;
  }
}

// ───────────────────────── filters
const typeOn = { active: true, inactive: true, rocket: true, debris: true, sim: true };
const regOn = { LEO: true, MEO: true, GEO: true, HEO: true };
let band = null;   // [lo, hi] km mean altitude
function computeVisibility() {
  const n = N + simCount;
  for (let i = 0; i < n; i++) {
    const o = objs[i];
    vis[i] = typeOn[o.type] && regOn[o.regime] && (!band || (o.meanAlt >= band[0] && o.meanAlt < band[1])) ? 1 : 0;
  }
  renderFilterPill();
}
function renderFilterPill() {
  const parts = [];
  const offT = TYPE_KEYS.filter(t => !typeOn[t] && (t !== 'sim' || simCount)).map(t => TYPES[t].label.toLowerCase());
  if (offT.length) parts.push('hiding ' + offT.join(', '));
  const offR = Object.keys(regOn).filter(k => !regOn[k]);
  if (offR.length) parts.push('hiding ' + offR.join(', '));
  if (band) parts.push(`only ${band[0]}–${band[1]} km`);
  $('filt').hidden = !parts.length; $('filtTxt').textContent = 'Filters: ' + parts.join('; ');
}

// ───────────────────────── 3D scene
let rd = null, sc, cam, earth, clouds, orbitSel, orbitA, orbitB, linkAB, obsM, caM, sunL, obsG, earthMat, atmoMat, earthTex = 'loading';
const layers = {};
let glOK = false;
function spriteTex(shape) {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.fillStyle = g.strokeStyle = '#fff'; g.lineWidth = 9;
  if (shape === 'dot') { g.beginPath(); g.arc(32, 32, 26, 0, TAU); g.fill(); }
  else if (shape === 'ring') { g.beginPath(); g.arc(32, 32, 24, 0, TAU); g.stroke(); }
  else if (shape === 'square') g.fillRect(10, 10, 44, 44);
  else if (shape === 'diamond') { g.beginPath(); g.moveTo(32, 3); g.lineTo(61, 32); g.lineTo(32, 61); g.lineTo(3, 32); g.closePath(); g.fill(); }
  else if (shape === 'cross') { g.lineWidth = 12; g.beginPath(); g.moveTo(10, 10); g.lineTo(54, 54); g.moveTo(54, 10); g.lineTo(10, 54); g.stroke(); }
  return c;
}
function legendIcon(shape, color) {
  const c = spriteTex(shape); const g = c.getContext('2d'); g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, 64, 64);
  return `<img class="dot" alt="" src="${c.toDataURL()}" style="width:12px;height:12px">`;
}
// Real stars (Hipparcos, to magnitude 6) on a distant sphere in the inertial frame, so they stay fixed while Earth turns.
// J2000 positions: precession since 2000 is about 0.4°, invisible at this scale. Sizes and brightness follow magnitude,
// colour follows B−V. Without the catalogue a faint random field is drawn instead.
function bvColor(bv) {
  const t = clamp((bv + 0.3) / 2.0, 0, 1);   // −0.3 (blue-white) … 1.7 (orange)
  return t < 0.4 ? [0.72 + 0.7 * t, 0.82 + 0.4 * t, 1] : [1, 0.98 - 0.35 * (t - 0.4), 0.98 - 0.6 * (t - 0.4)];
}
function initStars() {
  const tex = new THREE.CanvasTexture(glowTex()), R = 150;
  const bins = [[-2, 1.5, 3.4], [1.5, 3, 2.5], [3, 4.5, 1.8], [4.5, 9, 1.3]];
  const make = (pos, col, size) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3)); g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3)); const p = new THREE.Points(g, new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, map: tex, transparent: true, depthWrite: false })); p.frustumCulled = false; sc.add(p); };
  if (!STARS || !STARS.length) {
    let seed = 3; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647, pos = [], col = [];
    for (let k = 0; k < 600; k++) { const a = rnd() * TAU, b = Math.acos(2 * rnd() - 1), v = 0.25 + 0.4 * rnd(); pos.push(R * Math.sin(b) * Math.cos(a), R * Math.cos(b), R * Math.sin(b) * Math.sin(a)); col.push(v, v, v * 1.05); }
    return make(pos, col, 1.3);
  }
  for (const [lo, hi, size] of bins) {
    const pos = [], col = [];
    for (let k = 0; k < STARS.length; k += 4) {
      const mag = STARS[k + 2] / 100; if (mag < lo || mag >= hi) continue;
      const ra = STARS[k] / 100 * D2R, de = STARS[k + 1] / 100 * D2R, v = eciToScene([Math.cos(de) * Math.cos(ra), Math.cos(de) * Math.sin(ra), Math.sin(de)]);
      const b = clamp(Math.pow(10, -0.4 * (mag - lo)) * 0.95, 0.18, 0.95), c = bvColor(STARS[k + 3] / 100);
      pos.push(v[0] * R, v[1] * R, v[2] * R); col.push(c[0] * b, c[1] * b, c[2] * b);
    }
    make(pos, col, size);
  }
}
function initScene() {
  if (!HAS_THREE) return glFail('The 3D library (three.js) did not load. Check your connection and reload.');
  try {
    rd = new THREE.WebGLRenderer({ canvas: $('c'), antialias: true });
  } catch (e) { return glFail('Your browser could not start WebGL, so the 3D globe cannot be drawn.'); }
  if (!rd.getContext()) return glFail('WebGL is not available on this device.');
  glOK = true;
  rd.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  sc = new THREE.Scene(); cam = new THREE.PerspectiveCamera(45, 1, 0.01, 400);
  // Earth: canvas map first, then the photographic texture once it decodes
  const W = 1024, H = 512, tc = document.createElement('canvas'); tc.width = W; tc.height = H;
  { const g = tc.getContext('2d'); g.fillStyle = '#0e3a6b'; g.fillRect(0, 0, W, H); }
  const tex = new THREE.CanvasTexture(tc);
  // Day/night from the computed Sun direction (uniform sunDir, world axes). Twilight band: Sun 0–6° below the horizon.
  // Surface shading (diffuse floor, city lights fading in past the terminator, masked ocean glint, twilight warmth,
  // limb haze) follows akulbajpai-code/SkyLine src/globe/earth.ts (MIT). Day and night maps: Solar System Scope,
  // CC BY 4.0 (see ASSETS.md). Until they load, or if they can't, the embedded NASA Blue Marble map is drawn, with
  // the ocean picked out by colour and no city lights.
  const one = () => { const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat); t.needsUpdate = true; return t; };
  earthMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, nightMap: { value: one() }, maskMap: { value: one() }, hasNight: { value: 0 }, hasMask: { value: 0 }, sunDir: { value: new THREE.Vector3(1, 0, 0) } },
    vertexShader: 'varying vec2 vUv;varying vec3 vN;varying vec3 vP;void main(){vUv=uv;vN=normalize(mat3(modelMatrix)*normal);vec4 w=modelMatrix*vec4(position,1.);vP=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}',
    fragmentShader: `uniform sampler2D map;uniform sampler2D nightMap;uniform sampler2D maskMap;uniform float hasNight;uniform float hasMask;uniform vec3 sunDir;
      varying vec2 vUv;varying vec3 vN;varying vec3 vP;
      void main(){vec3 c=texture2D(map,vUv).rgb;vec3 n=normalize(vN);float d=dot(n,sunDir);vec3 v=normalize(cameraPosition-vP);
      float day=smoothstep(-0.105,0.03,d);vec3 lit=c*(0.16+0.84*clamp(d,0.,1.))*1.12;vec3 dark=c*mix(0.12,0.05,hasNight)+vec3(0.003,0.006,0.014);
      vec3 col=mix(dark,lit,day);
      float water=hasMask>0.5?texture2D(maskMap,vUv).r:smoothstep(0.04,0.16,c.b-max(c.r,c.g)*0.9);
      vec3 h=normalize(sunDir+v);col+=vec3(1.,.96,.9)*pow(clamp(dot(n,h),0.0001,1.),48.)*0.32*water*clamp(d*4.,0.,1.);
      col+=hasNight*texture2D(nightMap,vUv).rgb*smoothstep(0.08,-0.22,d)*vec3(1.,.86,.62)*1.15;
      col+=vec3(0.34,0.17,0.07)*exp(-pow((d+0.02)/0.08,2.))*0.16;
      col+=vec3(0.16,0.24,0.38)*pow(1.-clamp(dot(n,v),0.,1.),3.)*smoothstep(-0.25,0.35,d)*0.55;
      gl_FragColor=vec4(col,1.);}`,
  });
  earth = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 112), earthMat); sc.add(earth);   // fine enough for a smooth limb in Orbital POV
  const aniso = rd.capabilities.getMaxAnisotropy ? rd.capabilities.getMaxAnisotropy() : 4;
  earthImg.then(img => { if (earthTex === 'loading') { tex.image = img; tex.anisotropy = aniso; tex.needsUpdate = true; earthTex = 'NASA Blue Marble (embedded fallback)'; } })
    .catch(() => { if (earthTex === 'loading') earthTex = 'unavailable (plain ocean colour shown)'; });
  // the default Earth: served by this site, 4096 px on large screens that support it, 2048 px otherwise
  if (location.protocol !== 'file:') {
    const big = rd.capabilities.maxTextureSize >= 4096 && Math.min(innerWidth, innerHeight) >= 700, sz = big ? 4096 : 2048;
    const load = (src, done) => { const im = new Image(); im.onload = () => done(im); im.src = src; };
    load(`textures/earth-day-${sz}.jpg`, im => { tex.image = im; tex.anisotropy = aniso; tex.needsUpdate = true; earthTex = `Solar System Scope ${sz}×${sz / 2}`; });
    load(`textures/earth-night-${sz}.jpg`, im => { const t = new THREE.Texture(im); t.anisotropy = aniso; t.needsUpdate = true; earthMat.uniforms.nightMap.value = t; earthMat.uniforms.hasNight.value = 1; });
    load(EARTH_MASK, im => { const t = new THREE.Texture(im); t.needsUpdate = true; earthMat.uniforms.maskMap.value = t; earthMat.uniforms.hasMask.value = 1; });
  }
  // decorative clouds (not real weather)
  const cc = document.createElement('canvas'); cc.width = 1024; cc.height = 512;
  { const g = cc.getContext('2d'); let seed = 11; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
    for (let k = 0; k < 600; k++) { const x = rnd() * 1024, y = (0.12 + 0.76 * rnd()) * 512, r = 10 + rnd() * 40, gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,255,255,.13)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r); } }
  clouds = new THREE.Mesh(new THREE.SphereGeometry(1.012, 48, 32), new THREE.MeshLambertMaterial({ map: new THREE.CanvasTexture(cc), transparent: true, opacity: 0.8, depthWrite: false })); clouds.visible = false; sc.add(clouds);
  // lights for the decorative cloud layer only; the globe itself is shaded by earthMat from the same Sun direction
  sc.add(new THREE.AmbientLight(0x8094b8, 0.3));
  sunL = new THREE.DirectionalLight(0xfff6ea, 1.0); sunL.position.set(5, 1.5, 2.5); sc.add(sunL);
  // atmospheric limb: a thin rim, brighter on the sunlit side
  atmoMat = new THREE.ShaderMaterial({ uniforms: { sunDir: { value: new THREE.Vector3(1, 0, 0) } }, transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
    vertexShader: 'varying vec3 n;varying vec3 w;void main(){n=normalize(normalMatrix*normal);w=normalize(mat3(modelMatrix)*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: 'uniform vec3 sunDir;varying vec3 n;varying vec3 w;void main(){float i=pow(max(.6-dot(n,vec3(0,0,1.)),0.),3.2);float s=.18+.82*smoothstep(-.3,.3,dot(w,sunDir));gl_FragColor=vec4(.36,.62,1.,1.)*i*1.05*s;}' });
  sc.add(new THREE.Mesh(new THREE.SphereGeometry(1.035, 64, 40), atmoMat));
  initStars();
  const lineMat = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  orbitSel = new THREE.Line(new THREE.BufferGeometry(), lineMat(0xffffff, 0.7)); orbitSel.frustumCulled = false; sc.add(orbitSel);
  orbitA = new THREE.Line(new THREE.BufferGeometry(), lineMat(0x4fe0cf, 0.8)); orbitA.frustumCulled = false; sc.add(orbitA);
  orbitB = new THREE.Line(new THREE.BufferGeometry(), lineMat(0xf0b35e, 0.8)); orbitB.frustumCulled = false; sc.add(orbitB);
  linkAB = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.03, gapSize: 0.02 }));
  linkAB.frustumCulled = false; linkAB.visible = false; sc.add(linkAB);
  caM = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, color: 0xffffff, map: new THREE.CanvasTexture(spriteTex('ring')), transparent: true, alphaTest: 0.3 }));
  caM.frustumCulled = false; caM.visible = false; sc.add(caM);
  obsM = new THREE.Mesh(new THREE.SphereGeometry(0.011, 12, 8), new THREE.MeshBasicMaterial({ color: 0xf0b35e })); obsM.visible = false; earth.add(obsM);
  initScopeScene();
}
function buildBuffers() {
  for (const t of TYPE_KEYS) {
    const members = [];
    for (let i = 0; i < N; i++) if (objs[i].type === t) members.push(i);
    const cap = t === 'sim' ? SIM_CAP : members.length;
    const L = layers[t] = layers[t] || {};
    L.members = members; L.buf = new Float32Array(Math.max(cap, 1) * 3); L.dirty = true;
    if (!glOK) continue;
    if (!L.pts) {
      L.mat = new THREE.PointsMaterial({ size: TYPES[t].size * pointScale(), sizeAttenuation: false, color: new THREE.Color(TYPES[t].color), map: new THREE.CanvasTexture(spriteTex(TYPES[t].shape)), transparent: true, alphaTest: 0.35 });
      L.pts = new THREE.Points(new THREE.BufferGeometry(), L.mat); L.pts.frustumCulled = false; sc.add(L.pts);
    }
    L.attr = new THREE.BufferAttribute(L.buf, 3); L.attr.setUsage(THREE.DynamicDrawUsage);
    L.pts.geometry.setAttribute('position', L.attr); L.pts.geometry.setDrawRange(0, members.length);
  }
}
function writeBuffers() {
  for (const t of TYPE_KEYS) {
    const L = layers[t]; if (!L || !L.attr) continue;
    const m = L.members, b = L.buf;
    for (let k = 0; k < m.length; k++) {
      const i = m[k], j = k * 3, s = i * 3;
      if (vis[i] && !bad[i]) { b[j] = pos[s]; b[j + 1] = pos[s + 1]; b[j + 2] = pos[s + 2]; } else b[j] = b[j + 1] = b[j + 2] = 0;
    }
    L.pts.geometry.setDrawRange(0, m.length); L.attr.needsUpdate = true;
  }
}
function pointScale() { return clamp(Math.min(freeRect.w, freeRect.h) / 640, 0.55, 1); }
function glFail(msg) { $('glfail').hidden = false; $('glfailTxt').textContent = msg + ' Search, statistics, passes and the ground-track map still work.'; $('c').style.display = 'none'; }

// earth image for both the globe and the 2D map
const earthImg = new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = EARTH_IMG; });

// ───────────────────────── camera and input
// az, el, dist and target are where the camera is going; `view` is where it is. Each frame `view` eases toward the
// goal: quickly while the user drags (direct manipulation), more slowly for flights to a satellite or a place.
let az = 0.6, el = 0.35, dist = 4.2, follow = false; const target = [0, 0, 0];
const view = { az: 0.6, el: 0.35, dist: 4.2, t: [0, 0, 0] };
const angDiff = (a, b) => ((a - b + Math.PI) % TAU + TAU) % TAU - Math.PI;
function easeView(dt) {
  const k = reduceMotion ? 1 : 1 - Math.exp(-dt * (ptr.size ? 22 : 5));
  view.az += angDiff(az, view.az) * k; view.el += (el - view.el) * k; view.dist += (dist - view.dist) * k;
  for (let j = 0; j < 3; j++) view.t[j] += (target[j] - view.t[j]) * k;
}
function snapView() { view.az = az; view.el = el; view.dist = dist; view.t = target.slice(); }
let freeRect = { cx: innerWidth / 2, cy: innerHeight / 2, w: innerWidth, h: innerHeight };
function layout() {
  const barH = $('bar').offsetHeight, W = innerWidth, H = innerHeight, root = document.documentElement.style;
  root.setProperty('--bar-top', barH + 'px');
  // the globe is centred in the space the panels leave free; floating controls use the same edges (CSS --free-*)
  const box = id => { const e = $(id); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return r.width || r.height ? r : null; };
  const side = box('side'), insp = box('insp'), dock = scope.on ? box('dock') : null, rail = $('rail').getBoundingClientRect();
  let L, R, T, B;
  if (W <= 720) {
    const tm = box('time'); L = 0; R = W; T = tm ? tm.bottom : barH; B = rail.top;
    for (const r of [side, insp, dock, pov ? box('pov') : null]) if (r) B = Math.min(B, r.top);
  } else { L = side ? side.right : rail.right; R = insp ? insp.left : W; T = barH; B = dock ? dock.top : H - 40; }
  freeRect = { cx: (L + R) / 2, cy: (T + B) / 2, w: Math.max(1, R - L), h: Math.max(1, B - T) };
  root.setProperty('--free-l', L + 'px'); root.setProperty('--free-r', (W - R) + 'px'); root.setProperty('--free-cx', freeRect.cx + 'px');
  if (scope.on) drawDock();
  if (!glOK) return;
  rd.setSize(W, H); cam.aspect = W / H;
  cam.setViewOffset(W, H, W / 2 - freeRect.cx, H / 2 - freeRect.cy, W, H);
  cam.updateProjectionMatrix();
  for (const t of TYPE_KEYS) if (layers[t] && layers[t].mat) layers[t].mat.size = TYPES[t].size * pointScale();
  renderBadge();
}
function fitDist() { const m = Math.max(160, Math.min(freeRect.w, freeRect.h)); return clamp((innerHeight / 2) / (Math.tan(22.5 * D2R) * 0.36 * m), 2.6, 14); }
function camUpdate() {
  if (!glOK) return;
  const t = view.t, d = view.dist;
  cam.position.set(t[0] + d * Math.cos(view.el) * Math.sin(view.az), t[1] + d * Math.sin(view.el), t[2] + d * Math.cos(view.el) * Math.cos(view.az));
  cam.lookAt(t[0], t[1], t[2]);
}
function pan(dx, dy) {
  const k = dist * 0.0012, rx = Math.cos(az), rz = -Math.sin(az);
  target[0] -= dx * k * rx; target[2] -= dx * k * rz; target[1] += dy * k;
  const L = len3(target); if (L > 1.5) for (let j = 0; j < 3; j++) target[j] *= 1.5 / L;
}
const ptr = new Map(); let down = null, pinch = 0, mid = null, dragging = false;
function initInput() {
  const cv = $('c');
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId); ptr.set(e.pointerId, [e.clientX, e.clientY]); down = [e.clientX, e.clientY, e.shiftKey || e.button === 2]; dragging = false;
    if (ptr.size === 2) { const a = [...ptr.values()]; pinch = Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]); mid = [(a[0][0] + a[1][0]) / 2, (a[0][1] + a[1][1]) / 2]; down = null; }
  });
  cv.addEventListener('pointermove', e => {
    if (!ptr.has(e.pointerId)) { hoverAt(e.clientX, e.clientY); return; }
    const p = ptr.get(e.pointerId), dx = e.clientX - p[0], dy = e.clientY - p[1];
    ptr.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptr.size === 1) {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) dragging = true;
      if (!dragging) return;
      if (pov) povLook(-dx * 0.12 * pov.fov / 70, dy * 0.12 * pov.fov / 70);
      else if (down && down[2]) pan(dx, dy);
      else { az -= dx * 0.005 * dist / 4; el = clamp(el + dy * 0.005 * dist / 4, -1.45, 1.45); setFollow(false); scopeUnlock(); }
      hideTip();
    } else if (ptr.size === 2) {
      const a = [...ptr.values()], d = Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]), m = [(a[0][0] + a[1][0]) / 2, (a[0][1] + a[1][1]) / 2];
      if (pinch) { if (pov) povZoom(pinch / d); else dist = clamp(dist * pinch / d, 1.4, 16); } pinch = d;
      if (mid && !pov) pan(m[0] - mid[0], m[1] - mid[1]); mid = m;
    }
  });
  const up = e => {
    ptr.delete(e.pointerId);
    if (down && !dragging && ptr.size === 0) clickAt(e.clientX, e.clientY);
    if (ptr.size < 2) { pinch = 0; mid = null; }
    if (ptr.size === 0) down = null;
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', e => { ptr.delete(e.pointerId); down = null; });
  cv.addEventListener('pointerleave', hideTip);
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('wheel', e => { e.preventDefault(); if (pov) return povZoom(Math.exp(e.deltaY * 0.001)); dist = clamp(dist * Math.exp(e.deltaY * 0.001), 1.4, 16); }, { passive: false });
  cv.addEventListener('keydown', e => {
    const k = e.key, step = 0.08;
    if (pov && (k.startsWith('Arrow') || '+=-_'.includes(k))) {
      e.preventDefault();
      if (k.startsWith('Arrow')) povLook(k === 'ArrowLeft' ? -3 : k === 'ArrowRight' ? 3 : 0, k === 'ArrowUp' ? 3 : k === 'ArrowDown' ? -3 : 0);
      else povZoom(k === '+' || k === '=' ? 0.88 : 1 / 0.88);
      return;
    }
    if (k.startsWith('Arrow')) {
      e.preventDefault();
      const dx = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, dy = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0;
      if (e.shiftKey) pan(-dx * 40, -dy * 40); else { az -= dx * step; el = clamp(el - dy * step, -1.45, 1.45); setFollow(false); scopeUnlock(); }
    } else if (k === '+' || k === '=') dist = clamp(dist * 0.88, 1.4, 16);
    else if (k === '-' || k === '_') dist = clamp(dist / 0.88, 1.4, 16);
  });
}
const vv = HAS_THREE ? new THREE.Vector3() : null;
function hiddenBehindEarth(x, y, z) {
  const c = cam.position, dx = x - c.x, dy = y - c.y, dz = z - c.z, L = dx * dx + dy * dy + dz * dz;
  const t = clamp(-(c.x * dx + c.y * dy + c.z * dz) / L, 0, 1), px = c.x + t * dx, py = c.y + t * dy, pz = c.z + t * dz;
  return px * px + py * py + pz * pz < 1;
}
function screenOf(i) {
  const k = i * 3; vv.set(pos[k], pos[k + 1], pos[k + 2]);
  if (hiddenBehindEarth(vv.x, vv.y, vv.z)) return null;
  vv.project(cam); if (vv.z > 1) return null;
  return [(vv.x + 1) / 2 * innerWidth, (1 - vv.y) / 2 * innerHeight];
}
function pickAt(mx, my, radius) {
  if (!glOK) return -1;
  cam.updateMatrixWorld();
  let best = -1, bd = radius; const n = N + simCount, only = scope.on ? scope.pickable : null;
  for (let i = 0; i < n; i++) {
    if ((only ? !only[i] : !vis[i]) || bad[i]) continue;
    const s = screenOf(i); if (!s) continue;
    const d = Math.hypot(s[0] - mx, s[1] - my); if (d < bd) { bd = d; best = i; }
  }
  return best;
}
function clickAt(mx, my) {
  if (scope.on) return scopeClick(mx, my);
  const j = pickAt(mx, my, 14);
  if (j >= 0) { select(j); openTab('obj'); return; }
  if (nav.sec !== 'missions' || !glOK) return;
  const rc = new THREE.Raycaster(); rc.setFromCamera({ x: mx / innerWidth * 2 - 1, y: -(my / innerHeight * 2 - 1) }, cam);
  const h = rc.intersectObject(earth)[0];
  if (h) { const l = earth.worldToLocal(h.point.clone()); setLocation(Math.asin(clamp(l.y, -1, 1)) * R2D, Math.atan2(-l.z, l.x) * R2D, null); }
}
let hoverReq = 0;
function hoverAt(mx, my) {
  if (hoverReq || !glOK || !N) return;
  hoverReq = requestAnimationFrame(() => {
    hoverReq = 0;
    const j = pickAt(mx, my, 10), tip = $('tip');
    if (j < 0) return hideTip();
    const o = objs[j];
    tip.innerHTML = scope.on ? scopeTip(j) : `<b>${esc(o.name)}</b>${TYPES[o.type].one} · ${o.cat === 'demo' || o.type === 'sim' ? 'no catalog number' : 'catalog #' + o.id} · ~${fmtN(Math.round(o.meanAlt))} km`;
    tip.style.display = 'block';
    tip.style.left = Math.min(mx + 14, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = Math.min(my + 14, innerHeight - tip.offsetHeight - 8) + 'px';
  });
}
function hideTip() { $('tip').style.display = 'none'; }

// ───────────────────────── time
let simMs = Date.now(), speed = 60, lastFrame = performance.now();
const SPEEDS = [[0, '⏸', 'Pause'], [1, '1×', 'Real time'], [60, '60×', 'One minute per second'], [300, '300×', 'Five minutes per second'], [1200, '1200×', 'Twenty minutes per second']];
function renderSpeeds() {
  $('spd').innerHTML = SPEEDS.map(([s, l, t]) => `<button class="btn sm" data-s="${s}" title="${t}" aria-pressed="${s === speed}">${l}</button>`).join('') + '<button class="btn sm" data-now title="Jump to the current time">Now</button>';
}
function setSpeed(s) {
  speed = s; if (s > 0) playSpeed = s;
  [...$('spd').querySelectorAll('[data-s]')].forEach(b => b.setAttribute('aria-pressed', +b.dataset.s === s));
  renderDockControls();
}
let playSpeed = 60;
function jumpNow() { simMs = Date.now(); if (N) refreshAll(simMs); passCache = null; scopeTimeChanged(); }

// ───────────────────────── selection and object panel
let sel = -1, cmpA = -1, cmpB = -1, obs = null, orbitT = 0, passCache = null;
function select(i, opt = {}) {
  sel = i; passCache = null; orbitT = 0;
  renderSelected();
  if (i >= 0 && !opt.quiet && !scope.on) setInsp(true);
  drawGroundTrack();
  if (scope.on) renderScopeLive();
}
function setFollow(on) { follow = on; const b = $('fol'); if (b) b.setAttribute('aria-pressed', on); }
function orbitPoints(o, ms, n = 160) {
  const T = o.period * 60e3, arr = new Float32Array((n + 1) * 3); let ok = 0;
  for (let k = 0; k <= n; k++) { const s = eciAt(o, ms + T * k / n); if (!s) { arr.set(arr.subarray((k - 1) * 3, k * 3), k * 3); continue; } toScene(s.r, arr, k * 3); ok++; }
  return ok > 1 ? arr : null;
}
function setLine(line, arr) { if (!line) return; if (!arr) { line.visible = false; return; } line.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3)); line.geometry.computeBoundingSphere(); line.visible = true; }
function statusOf(o) {
  if (o.type === 'sim') return 'Simulated. Not a real object.';
  if (data.mode === 'demo') return 'Demo object. Not a real satellite.';
  if (o.type === 'active') return 'On CelesTrak’s active satellite list';
  if (o.type === 'inactive') return 'Not on the active list (likely retired)';
  if (o.type === 'rocket') return 'Spent rocket stage (never active as a satellite)';
  return 'Debris, no longer controlled';
}
function groupLabel(k) { const g = GROUPS.find(g => g.key === k); return g ? g.label : k === 'demo' ? 'Demo data' : k === 'sim' ? 'Breakup simulator' : k; }
// Rule of thumb for how far an SGP4 position drifts along the orbit as elements age (not a measurement): low orbits are
// drag-dominated, about 1–4 km a day; higher orbits about 0.15–0.6 km a day. From akulbajpai-code/SkyLine (MIT).
function driftRange(o, ageDays) { if (!(ageDays > 0)) return null; const low = o.period < 103; return [ageDays * (low ? 1 : 0.15), ageDays * (low ? 4 : 0.6)]; }
function renderSelected() {
  const box = $('sel');
  renderPovPick(); renderSimTarget();
  if (sel < 0 || !objs[sel]) { box.innerHTML = ''; setInsp(false); return; }
  const o = objs[sel], T = TYPES[o.type], ageD = (simMs - o.epoch) / 864e5, dr = o.satrec ? driftRange(o, ageD) : null;
  const kind = o.type === 'sim' ? '<span class="tag sim">simulated</span>' : data.mode === 'demo' ? '<span class="tag sim">demo</span>' : '';
  const srcHead = o.type === 'sim' ? 'Simulated fragment <span class="src">two-body orbit from the breakup simulator</span>' : !o.satrec ? 'Demo orbit <span class="src">not a real object</span>' : `Source elements <span class="src">CelesTrak GP</span>`;
  const ageTxt = o.satrec ? `${age(Math.abs(ageD) * 864e5)}${ageD < 0 ? ' ahead' : ''}` : '–';
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px">${legendIcon(T.shape, T.color)}<h3 style="flex:1;min-width:0;overflow-wrap:anywhere">${esc(o.name)}</h3>${kind}</div>
    <h2>${srcHead}</h2>
    <div class="kv">
      <span>Catalog number</span><b>${o.cat === 'demo' || o.type === 'sim' ? '–' : o.id}</b>
      <span>Int'l designator</span><b>${esc(o.intl || '–')}</b>
      <span>Type</span><b class="txt">${T.one}</b>
      <span>Status</span><b class="txt">${statusOf(o)}</b>
      <span>Elements epoch</span><b>${o.satrec ? utc(o.epoch) : '–'}</b>
      <span>Element age</span><b id="sAge" title="${dr ? `Rule of thumb: the position may be ${fmtN(Math.round(dr[0]))}–${fmtN(Math.round(dr[1]))} km off along the orbit at this age. Not a measured uncertainty.` : ''}">${ageTxt}${dr && dr[1] >= 10 ? ` <span class="${Math.abs(ageD) > 7 ? 'warn' : 'dim'}">±${fmtN(Math.round(dr[1]))} km</span>` : ''}</b>
      <span>In groups</span><b class="txt">${o.groups.map(groupLabel).map(esc).join('; ')}</b>
    </div>
    <h2>Propagated position <span class="src" id="sAt"></span></h2>
    <div class="kv">
      <span>Altitude</span><b id="sAlt">–</b>
      <span>Speed</span><b id="sSpd">–</b>
      <span>Sub-point</span><b id="sLL">–</b>
      <span>Sunlight</span><b id="sLit" class="txt">–</b>
    </div>
    <h2>Derived from the elements</h2>
    <div class="kv">
      <span>Perigee / apogee</span><b>${fmtN(Math.round(o.perigee))} / ${fmtN(Math.round(o.apogee))} km</b>
      <span>Inclination</span><b>${o.inc.toFixed(2)}°</b>
      <span>Orbital period</span><b>${o.period.toFixed(1)} min</b>
      <span>Orbit regime</span><b>${o.regime}</b>
    </div>
    <div class="row-btns">
      <button class="btn primary" id="povBtn" ${glOK ? 'title="See Earth from this object’s computed position (P)"' : 'disabled title="Orbital POV needs WebGL"'}>Orbital POV</button>
      <button class="btn" id="fol" aria-pressed="${follow}" title="Keep the camera on this object">Follow</button>
      <button class="btn" id="setA" title="Use as object A in Compare &amp; Data">Compare as A</button>
      <button class="btn" id="setB" title="Use as object B in Compare &amp; Data">Compare as B</button>
    </div>
    <h2>Nearest objects <span class="src" title="Straight-line distance at the shown time only. Not a prediction of a close approach.">distance now</span></h2>
    <div class="list" id="near"></div>
    <h2>Passes over you</h2><div id="pas" class="note"></div>`;
  $('fol').onclick = () => setFollow(!follow);
  $('povBtn').onclick = () => enterPov(sel);
  $('setA').onclick = () => { cmpA = sel; renderCompare(); openTab('saf'); };
  $('setB').onclick = () => { cmpB = sel; renderCompare(); openTab('saf'); };
  $('near').onclick = e => { const b = e.target.closest('[data-j]'); if (b) select(+b.dataset.j); };
  $('pas').onclick = e => { const b = e.target.closest('[data-pass]'); if (b && passCache) startReplay(sel, passCache.list[+b.dataset.pass]); };
  liveSelected(true);
}
const setIfChanged = (el, html) => { if (el && el._html !== html) { el._html = html; el.innerHTML = html; } };
const unit3 = v => { const l = len3(v); return [v[0] / l, v[1] / l, v[2] / l]; };
const LIT = { sunlit: 'Sunlit', penumbra: 'Partly shadowed', shadow: 'In Earth’s shadow' };
function liveSelected(force) {
  if (sel < 0 || !objs[sel]) return;
  const o = objs[sel], s = eciAt(o, simMs), g = gmstAt(simMs);
  $('sAt').textContent = `SGP4 at ${utc(simMs)}`.replace('SGP4', o.satrec ? 'SGP4' : 'two-body');
  if (!s) { $('sAlt').textContent = 'cannot compute (re-entered?)'; $('sSpd').textContent = '–'; $('sLL').textContent = '–'; $('sLit').textContent = '–'; $('near').innerHTML = '<span class="note">Position cannot be computed at this time.</span>'; return; }
  const geo = geodetic(s.r, g);
  $('sAlt').textContent = fmtN(Math.round(geo.h)) + ' km'; $('sSpd').textContent = len3(s.v).toFixed(2) + ' km/s';
  $('sLL').textContent = `${fmtLat(geo.lat)}, ${fmtLon(geo.lon)}`;
  $('sLit').textContent = LIT[illumination(s.r, unit3(sunEci(simMs)))];
  // nearest objects now
  const k = sel * 3, list = [], n = N + simCount;
  for (let i = 0; i < n; i++) { if (i === sel || bad[i] || !vis[i]) continue; const j = i * 3, d = Math.hypot(pos[j] - pos[k], pos[j + 1] - pos[k + 1], pos[j + 2] - pos[k + 2]) * RS; if (list.length < 5 || d < list[4].d) { list.push({ i, d }); list.sort((a, b) => a.d - b.d); if (list.length > 5) list.pop(); } }
  setIfChanged($('near'), list.length ? list.map(h => `<button class="item" data-j="${h.i}"><span>${esc(objs[h.i].name)}<br><small>${TYPES[objs[h.i].type].one}</small></span><span class="r">${fmtN(Math.round(h.d))} km</span></button>`).join('') : '<span class="note">No other visible objects.</span>');
  renderPasses(force);
}
// next passes of object o above 10° for the current observer (WGS-84 look angles, refined rise / peak / set; see src/observer.js)
function passesFor(o, fromMs, hours = 24, max = 3) {
  return predictPasses(t => { const s = eciAt(o, t); return s && s.r; }, gmstAt, obs.ob, fromMs, fromMs + hours * 3600e3, { max });
}
function renderPasses(force) {
  const box = $('pas'); if (!box) return;
  if (!obs) { box.innerHTML = 'Set a location in <a href="#/missions/overhead">Missions</a> to predict passes.'; return; }
  const o = objs[sel];
  if (force || !passCache || passCache.sel !== sel || simMs > passCache.until || simMs < passCache.from) {
    passCache = { sel, from: simMs, list: passesFor(o, simMs) }; passCache.until = passCache.list.length ? passCache.list[0].t1 : simMs + 3600e3;
  }
  const html = passCache.list.map((x, k) => x.t1 < simMs ? '' : `<button class="item" data-pass="${k}" title="Replay this pass: the sky chart, the globe and the readouts follow one clock"><span>${x.t0 <= simMs ? '<b style="color:var(--ok)">Overhead now</b>' : 'in ' + dur((x.t0 - simMs) / 60e3)}<br><small>${localT(x.t0)} your time · ${compass(x.azRise)} → ${compass(x.azSet)}</small></span><span class="r">${Math.max(1, Math.round((x.t1 - x.t0) / 60e3))} min · peak ${Math.round(x.max)}°<br><small>Replay ›</small></span></button>`).join('');
  // rewrite only when the text changes, so a button keeps hover and keyboard focus between updates
  setIfChanged(box, html ? `<div class="list">${html}</div><p class="note">Above 10° elevation, from ${esc(obs.name)}. Geometry only: a pass can happen in daylight or in Earth's shadow.</p>` : 'No passes above 10° in the next 24 hours.');
}

// ───────────────────────── orbit-to-observer pass replay: one clock drives the sky chart, the readouts and the globe
let replay = null;
// ───────────────────────── Orbital POV
// The camera sits at the followed object's position, propagated exactly at simMs every frame (SGP4 for catalogue
// objects, two-body for simulator fragments and demo orbits), in the same inertial scene frame as the dots and stars.
// It is oriented in the object's own orbit frame (src/pov.js). There is no second clock and no Earth-fixed frame.
let pov = null;
const POV_LABEL = { horizon: 'Horizon', nadir: 'Nadir', free: 'Free look' };
function povState(o) {
  const s = eciAt(o, simMs); if (!s) return null;
  const r = [s.r[0] / RS, s.r[2] / RS, -s.r[1] / RS], v = [s.v[0], s.v[2], -s.v[1]], basis = povBasis(r, v);
  return basis && { s, r, basis, alt: len3(s.r) - RS };
}
function enterPov(i, mode = 'horizon', opt = {}) {
  if (!glOK) return toast('Orbital POV needs WebGL, which is not available here. Its details still show this object’s position.');
  if (i == null || i < 0 || !objs[i]) return toast('Select an object first, then choose Orbital POV.');
  const st = povState(objs[i]);
  if (!st) return toast('This object’s position cannot be computed at the shown time (it has probably re-entered), so there is no view from it.');
  if (scope.on) setMode('explore');
  if (!pov) {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    pov = { saved: { az, el, dist, target: target.slice(), follow, clouds: clouds.visible } };
    setFollow(false); hideTip(); clouds.visible = false;
    if (coarse) rd.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    document.body.classList.add('pov'); $('pov').hidden = false; layout();
  }
  Object.assign(pov, { i, byTour: !!opt.byTour });
  if (sel !== i) { select(i); openTab('obj'); }
  setPovMode(mode, st.alt);
  povHud(true);
  if (!opt.quiet) $('povExit').focus({ preventScroll: true });
}
function setPovMode(mode, alt) {
  if (!pov) return;
  if (alt == null) { const st = povState(objs[pov.i]); alt = st ? st.alt : 400; }
  if (mode === 'free' && pov.mode !== 'free') { const a = povAngles(pov.mode || 'horizon', alt, pov.fov || 70); pov.free = { yaw: a.yaw, pitch: a.pitch }; }
  if (mode !== 'free' || pov.fov == null) pov.fov = povDefaultFov(mode, alt);
  pov.mode = mode;
  for (const b of document.querySelectorAll('[data-povm]')) b.setAttribute('aria-pressed', b.dataset.povm === mode);
  $('povFov').textContent = Math.round(pov.fov) + '°';
}
function povLook(dYaw, dPitch) {
  if (!pov) return;
  if (pov.mode !== 'free') setPovMode('free');
  pov.free.yaw = ((pov.free.yaw + dYaw + 540) % 360) - 180; pov.free.pitch = clamp(pov.free.pitch + dPitch, -90, 80);
}
function povZoom(f) { if (!pov) return; pov.fov = clampFov(pov.fov * f); $('povFov').textContent = Math.round(pov.fov) + '°'; }
function exitPov(opt = {}) {
  if (!pov) return;
  const p = pov.saved; pov = null;
  // start the globe view from where the POV camera is, so the eased flight pulls back out to the saved view
  const c = cam.position, r = c.length() || 1;
  view.az = Math.atan2(c.x, c.z); view.el = Math.asin(clamp(c.y / r, -1, 1)); view.dist = r; view.t = [0, 0, 0];
  az = p.az; el = p.el; dist = p.dist; target.splice(0, 3, ...p.target); setFollow(p.follow);
  if (reduceMotion) snapView();
  cam.up.set(0, 1, 0); cam.fov = 45; cam.near = 0.01; cam.updateProjectionMatrix();
  rd.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); clouds.visible = p.clouds;
  document.body.classList.remove('pov'); $('pov').hidden = true; layout();
  if (opt.why) toast(opt.why);
}
const povTmp = HAS_THREE ? new THREE.Vector3() : null;
// one frame: place and aim the camera. Returns false (and leaves POV) if the position can no longer be computed.
function povFrame() {
  const st = povState(objs[pov.i]);
  if (!st) { exitPov({ why: 'Left Orbital POV: this object’s position cannot be computed at the shown time.' }); return false; }
  const a = povAngles(pov.mode, st.alt, pov.fov, pov.free), o = povOrientation(st.basis, a.yaw, a.pitch);
  cam.position.set(st.r[0], st.r[1], st.r[2]); cam.up.set(o.up[0], o.up[1], o.up[2]);
  cam.lookAt(povTmp.set(st.r[0] + o.fwd[0], st.r[1] + o.fwd[1], st.r[2] + o.fwd[2]));
  const near = povClip(st.alt);
  if (cam.fov !== pov.fov || cam.near !== near) { cam.fov = pov.fov; cam.near = near; cam.updateProjectionMatrix(); }
  return true;
}
function povHud(force) {
  if (!pov) return;
  const o = objs[pov.i], st = povState(o); if (!st) return;
  const real = !!o.satrec && o.cat !== 'demo', g = geodetic(st.s.r, gmstAt(simMs)), lit = illumination(st.s.r, unit3(sunEci(simMs)));
  const how = o.type === 'sim' ? 'Two-body orbit from the breakup simulator' : !o.satrec ? 'Demo orbit' : 'SGP4';
  setIfChanged($('povName'), esc(o.name));
  setIfChanged($('povMeta'), (real ? `NORAD ${o.id} · ` : '') + TYPES[o.type].one + (o.type === 'sim' ? ' · <span class="tag sim">simulated</span>' : !real ? ' · <span class="tag sim">demo</span>' : ''));
  const ageTxt = real ? `<span>elements</span> ${age(Math.abs(simMs - o.epoch))} ${simMs >= o.epoch ? 'old' : 'ahead'}` : '';
  $('povTel').innerHTML = `<b><span>alt</span> ${fmtN(Math.round(g.h))} km</b><b><span>speed</span> ${len3(st.s.v).toFixed(2)} km/s</b><b><span>below</span> ${fmtLat(g.lat)}, ${fmtLon(g.lon)}</b>`
    + `<b class="${lit === 'sunlit' ? '' : 'sh'}">${LIT[lit]}</b><b>${ageTxt}</b><b><span>${how} at</span> ${new Date(simMs).toISOString().slice(11, 19)} UTC${speed !== 1 ? ` · ${speed ? speed + '×' : 'paused'}` : ''}</b>`;
  setIfChanged($('povCap'), o.type === 'sim' ? 'Computed view from a simulated fragment’s orbit. Not a real object, not spacecraft imagery.' : !o.satrec ? 'Computed view from a demo orbit. Not a real object, not spacecraft imagery.' : 'Computed view from orbital elements, not spacecraft imagery.');
}
function startReplay(i, pass) {
  if (!pass || !obs || !objs[i]) return;
  if (pov) exitPov();
  replay = { i, pass, obKey: obs.lat + ',' + obs.lon };
  select(i, { quiet: true }); setFollow(false); go('missions', 'passes');
  const p = $('replay'); p.hidden = false;
  const lo = pass.t0 - 120e3, hi = pass.t1 + 120e3, rg = $('rpRange');
  rg.min = lo; rg.max = hi; rg.step = 1000;
  $('rpH').textContent = `${objs[i].name} over ${obs.name}`;
  $('rpSum').textContent = `Rises ${localT(pass.t0)} in the ${compass(pass.azRise)} · peaks ${Math.round(pass.max)}° in the ${compass(pass.azPeak)} at ${hhmm(pass.tPeak)} · sets in the ${compass(pass.azSet)}`;
  replay.path = []; for (let k = 0; k <= 64; k++) { const t = pass.t0 + (pass.t1 - pass.t0) * k / 64, st = eciAt(objs[i], t); if (!st) continue; const g = gmstAt(t); replay.path.push(lookAngles(obs.ob, st.r, Math.cos(g), Math.sin(g))); }
  setSimTime(pass.t0 - 60e3); setSpeed(10); passCache = null;
  replayTick(true); p.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
}
function endReplay() { replay = null; $('replay').hidden = true; }
function replayTick(force) {
  if (!replay) return;
  const { i, pass } = replay, o = objs[i];
  if (!o || !obs || replay.obKey !== obs.lat + ',' + obs.lon) return endReplay();   // the observer changed: this pass no longer applies
  if (speed > 0 && simMs > pass.t1 + 120e3) setSpeed(0);   // stop at the end of the pass
  const rg = $('rpRange'); if (document.activeElement !== rg || force) rg.value = Math.round(simMs);
  const st = eciAt(o, simMs), g = gmstAt(simMs), sun = unit3(sunEci(simMs));
  const la = st ? lookAngles(obs.ob, st.r, Math.cos(g), Math.sin(g)) : null, sa = solarAltitude(obs.ob, sun, g);
  const phase = simMs < pass.t0 ? `Rises in ${dur((pass.t0 - simMs) / 60e3)}` : simMs > pass.t1 ? 'Set' : 'Above 10°';
  $('rpRead').innerHTML = `<span>Time</span><b>${hhmm(simMs)} <small>${new Date(simMs).toISOString().slice(11, 19)} UTC</small></b>
    <span>Status</span><b class="txt">${phase}</b>
    <span>Azimuth</span><b>${la ? `${la.az.toFixed(1)}° ${compass(la.az)}` : '–'}</b>
    <span>Elevation</span><b>${la ? la.el.toFixed(1) + '°' : '–'}</b>
    <span>Range</span><b>${la ? fmtN(Math.round(la.range)) + ' km' : '–'}</b>
    <span>Object</span><b class="txt">${st ? LIT[illumination(st.r, sun)] : '–'}</b>
    <span>Your sky</span><b class="txt">${darknessOf(sa)} <small>Sun ${sa.toFixed(0)}°</small></b>`;
  drawSkyChart(la);
}
function drawSkyChart(now) {
  const cv = $('skyc'); if (!cv || !replay) return;
  const dpr = Math.min(devicePixelRatio || 1, 2), W = cv.clientWidth || 240; if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(W * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, W);
  const c = W / 2, R = W / 2 - 16, xy = (az, el) => { const r = (90 - el) / 90 * R, a = az * D2R; return [c + r * Math.sin(a), c - r * Math.cos(a)]; };
  const css = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
  g.strokeStyle = css('--line-2'); g.lineWidth = 1;
  for (const el of [0, 30, 60]) { g.beginPath(); g.arc(c, c, (90 - el) / 90 * R, 0, TAU); g.stroke(); }
  g.beginPath(); g.moveTo(c - R, c); g.lineTo(c + R, c); g.moveTo(c, c - R); g.lineTo(c, c + R); g.stroke();
  g.fillStyle = css('--dim'); g.font = '10px ' + css('--mono'); g.textAlign = 'center'; g.textBaseline = 'middle';
  [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([l, az]) => { const [x, y] = xy(az, -12); g.fillText(l, x, y); });
  g.textAlign = 'left'; g.fillText('30°', c + 3, c - (60 / 90) * R + 7); g.fillText('60°', c + 3, c - (30 / 90) * R + 7);
  const path = replay.path.filter(p => p.el >= 0);
  if (path.length > 1) { g.strokeStyle = css('--accent'); g.lineWidth = 2; g.beginPath(); path.forEach((p, k) => { const [x, y] = xy(p.az, p.el); k ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); }
  const pk = xy(replay.pass.azPeak, replay.pass.max); g.fillStyle = css('--accent'); g.beginPath(); g.arc(pk[0], pk[1], 2.5, 0, TAU); g.fill();
  if (now && now.el >= 0) { const [x, y] = xy(now.az, now.el); g.fillStyle = css('--amber'); g.beginPath(); g.arc(x, y, 5, 0, TAU); g.fill(); g.strokeStyle = css('--bg'); g.lineWidth = 1.5; g.stroke(); }
}

// ───────────────────────── compare two objects
let cmpResult = null;
function renderCompare() {
  const box = $('cmp'), A = objs[cmpA], B = objs[cmpB];
  const slot = (o, k, cls) => `<div class="item" style="cursor:default;border-left:3px solid var(--c-${cls})"><span><small>Object ${k}</small><br>${o ? esc(o.name) : '<span class="note">Not set</span>'}</span>${o ? `<button class="btn sm" data-goto="${o.i}">Show</button>` : ''}</div>`;
  let html = `<div class="list">${slot(A, 'A', 'a')}${slot(B, 'B', 'b')}</div>
    <div class="row-btns"><button class="btn sm" id="cUseA" ${sel < 0 ? 'disabled' : ''}>Selected → A</button><button class="btn sm" id="cUseB" ${sel < 0 ? 'disabled' : ''}>Selected → B</button><button class="btn sm" id="cSwap">Swap</button><button class="btn sm" id="cClear">Clear</button></div>`;
  if (!A || !B) {
    const iss = featured.iss, css = featured.css;
    html += `<p class="note">Pick two objects to draw both orbits and find their closest geometric pass in the next 24 hours.</p>` + (iss != null && css != null ? `<button class="btn sm" id="cTry">Try the ISS and Tiangong</button>` : '');
  } else if (cmpA === cmpB) html += '<p class="note">Pick two different objects.</p>';
  else {
    if (!cmpResult || cmpResult.a !== cmpA || cmpResult.b !== cmpB || Math.abs(cmpResult.from - simMs) > 6 * 3600e3) cmpResult = closestPass(A, B, simMs);
    const r = cmpResult;
    html += `<div class="card" style="margin-top:10px">
      <div class="kv" style="margin-top:0"><span>Distance now</span><b id="cNow">–</b>
      <span>Closest pass, next 24 h</span><b>${r ? fmtN(r.d < 10 ? +r.d.toFixed(1) : Math.round(r.d)) + ' km' : 'could not compute'}</b>
      ${r ? `<span>When</span><b>${utc(r.t)}<br><small style="font-family:var(--sans)">${r.t > simMs ? 'in ' + dur((r.t - simMs) / 60e3) : 'now'}</small></b><span>Relative speed then</span><b>${r.vrel.toFixed(2)} km/s</b>` : ''}</div>
      <p class="note">Geometric estimate from public orbital elements, with no uncertainty data. Real positions can differ by kilometres, so this is <b>not</b> a collision prediction. Small rings on the globe mark both objects at that moment.</p></div>`;
  }
  box.innerHTML = html;
  $('cUseA').onclick = () => { cmpA = sel; renderCompare(); };
  $('cUseB').onclick = () => { cmpB = sel; renderCompare(); };
  $('cSwap').onclick = () => { [cmpA, cmpB] = [cmpB, cmpA]; renderCompare(); };
  $('cClear').onclick = () => { cmpA = cmpB = -1; cmpResult = null; renderCompare(); };
  const t = $('cTry'); if (t) t.onclick = () => { cmpA = featured.iss; cmpB = featured.css; renderCompare(); };
  box.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => { select(+b.dataset.goto); openTab('obj'); });
  updateCompareScene();
}
function closestPass(A, B, from) {
  const step = 30e3, n = 2880, d = new Float64Array(n + 1);
  for (let k = 0; k <= n; k++) { const a = eciAt(A, from + k * step), b = eciAt(B, from + k * step); d[k] = a && b ? Math.hypot(a.r[0] - b.r[0], a.r[1] - b.r[1], a.r[2] - b.r[2]) : Infinity; }
  const cands = [];
  for (let k = 0; k <= n; k++) if ((k === 0 || d[k] <= d[k - 1]) && (k === n || d[k] < d[k + 1])) cands.push(k);
  cands.sort((x, y) => d[x] - d[y]);
  let best = null;
  for (const k of cands.slice(0, 6)) {
    for (let t = Math.max(0, (k - 1) * step); t <= Math.min(n * step, (k + 1) * step); t += 1000) {
      const a = eciAt(A, from + t), b = eciAt(B, from + t); if (!a || !b) continue;
      const dd = Math.hypot(a.r[0] - b.r[0], a.r[1] - b.r[1], a.r[2] - b.r[2]);
      if (!best || dd < best.d) best = { d: dd, t: from + t, vrel: Math.hypot(a.v[0] - b.v[0], a.v[1] - b.v[1], a.v[2] - b.v[2]), ra: a.r, rb: b.r };
    }
  }
  return best && { ...best, a: A.i, b: B.i, from };
}
function updateCompareScene() {
  if (!glOK) return;
  const A = objs[cmpA], B = objs[cmpB];
  setLine(orbitA, A ? orbitPoints(A, simMs) : null); setLine(orbitB, B ? orbitPoints(B, simMs) : null);
  const r = cmpResult && A && B && cmpResult.a === cmpA && cmpResult.b === cmpB ? cmpResult : null;
  caM.visible = !!r;
  if (r) { const a = caM.geometry.attributes.position; toScene(r.ra, a.array, 0); toScene(r.rb, a.array, 3); a.needsUpdate = true; }
}

// ───────────────────────── breakup simulator (simulated fragments, two-body)
let seedSim = 99; const rndSim = () => (seedSim = seedSim * 16807 % 2147483647) / 2147483647;
function boom() {
  if (sel < 0) return toast('Select an object first.');
  if (simCount + 60 > SIM_CAP) return toast(`Simulation limit reached (${SIM_CAP} fragments). Clear the simulation to start again.`);
  const p = objs[sel], s = eciAt(p, simMs); if (!s) return toast('Cannot compute this object’s position.');
  for (let k = 0; k < 60; k++) {
    const dv = 0.02 + rndSim() * 0.13, th = rndSim() * TAU, ph = Math.acos(2 * rndSim() - 1);
    const v = [s.v[0] + dv * Math.sin(ph) * Math.cos(th), s.v[1] + dv * Math.sin(ph) * Math.sin(th), s.v[2] + dv * Math.cos(ph)];
    const i = N + simCount, o = { i, id: 'S' + (simCount + 1), cat: 'demo', name: `Simulated fragment ${simCount + 1} of ${p.name}`, nameU: '', intl: '', type: 'sim', groups: ['sim'], epoch: simMs, r0: s.r.slice(), v0: v, t0: simMs };
    const rn = len3(s.r), vn = len3(v), a = 1 / (2 / rn - vn * vn / MU), hv = [s.r[1] * v[2] - s.r[2] * v[1], s.r[2] * v[0] - s.r[0] * v[2], s.r[0] * v[1] - s.r[1] * v[0]];
    const e = Math.sqrt(Math.max(0, 1 - dot3(hv, hv) / (MU * a)));
    o.period = TAU * Math.sqrt(a * a * a / MU) / 60; o.ecc = e; o.inc = Math.acos(hv[2] / len3(hv)) * R2D; o.perigee = a * (1 - e) - REQ; o.apogee = a * (1 + e) - REQ; o.meanAlt = a - REQ; o.regime = regimeOf(o);
    objs[i] = o; simCount++; layers.sim.members.push(i); refreshOne(i, simMs); vis[i] = typeOn.sim ? 1 : 0;
  }
  extrapolate(simMs); renderLayers();
  $('bBoomClear').disabled = false;
  $('boomInfo').innerHTML = `<span class="tag sim">simulated</span> ${simCount} fragments in the simulation. Speed up time to watch them spread out: fragments with slightly different speeds get different orbital periods, so the cloud stretches into a ring around Earth. That is how one breakup threatens a whole orbital shell.`;
  toast('Simulated breakup: 60 pretend fragments added.');
}
function clearSim(silent) {
  if (!simCount) return;
  objs.length = N; simCount = 0; cursor = 0; if (layers.sim) layers.sim.members = [];
  $('bBoomClear').disabled = true; $('boomInfo').textContent = '';
  if (pov && pov.i >= N) exitPov({ why: 'Left Orbital POV: the simulated fragment was cleared.' });
  if (sel >= N) sel = -1; if (cmpA >= N) cmpA = -1; if (cmpB >= N) cmpB = -1;
  if (!silent) { renderSelected(); renderCompare(); renderLayers(); toast('Simulation cleared.'); }
}

// ───────────────────────── observer
function setObserver(lat, lon, how) {
  obs = { lat, lon, name: how, ob: observerFrame(lat, lon) }; passCache = null; issCache = null;
  if (obsM) { const f = lat * D2R, l = lon * D2R; obsM.position.set(Math.cos(f) * Math.cos(l), Math.sin(f), -Math.cos(f) * Math.sin(l)).multiplyScalar(1.006); obsM.visible = true; }
  $('where').textContent = `${how}: ${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
  renderSky(true); renderPasses(true); drawGroundTrack(); scopeLocationChanged(); renderN2yoBtn(); loadWeather();
  if ($('abCheck')) $('abCheck').hidden = true;
}
// ───────────────────────── What's above me? (computed by Skyline) and sky conditions
// Everything above the observer's horizon right now, from the propagated positions of the loaded catalogue and the
// same WGS-84 look angles as the pass predictions. No outside service is needed. Being above the horizon is geometry
// only: it does not mean the object can be seen by eye or that it provides any service.
const ABOVE_MIN = 0;
function aboveNow() {
  const g = gmstAt(simMs), c = Math.cos(g), sn = Math.sin(g), list = [], n = N + simCount, byType = {};
  for (let i = 0; i < n; i++) {
    if (bad[i]) continue;
    const k = i * 3, r = [pos[k] * RS, -pos[k + 2] * RS, pos[k + 1] * RS];
    if (lookEl(obs.ob, r, c, sn) <= ABOVE_MIN) continue;
    const e = lookAngles(obs.ob, r, c, sn), t = objs[i].type; byType[t] = (byType[t] || 0) + 1;
    list.push({ i, el: e.el, az: e.az, range: e.range, alt: len3(r) - RS });
  }
  list.sort((a, b) => b.el - a.el);
  return { list, byType, at: simMs };
}
let aboveShowAll = false;
function renderAbove() {
  const a = aboveNow(), hi = a.list.filter(h => h.el > 10).length;
  const src = data.mode === 'demo' ? '<span class="tag sim">demo orbits</span>' : data.mode === 'snapshot' ? `<span class="tag approx">snapshot</span> elements captured ${utc(data.fetchedAt).slice(0, 10)}` : 'CelesTrak elements';
  const types = TYPE_KEYS.filter(t => a.byType[t]).map(t => `${legendIcon(TYPES[t].shape, TYPES[t].color)} ${fmtN(a.byType[t])} ${TYPES[t].label.toLowerCase()}`).join(' · ');
  const rows = (aboveShowAll ? a.list.slice(0, 60) : a.list.slice(0, 8)).map(h => `<button class="item" data-j="${h.i}"><span>${esc(objs[h.i].name)}<br><small>${TYPES[objs[h.i].type].one} · ${fmtN(Math.round(h.alt))} km up</small></span><span class="r">${Math.round(h.el)}° ${compass(h.az)}<br><small>${fmtN(Math.round(h.range))} km away</small></span></button>`).join('');
  setIfChanged($('over'), `<div class="ab-count"><b>${fmtN(a.list.length)}</b> tracked objects above your horizon <small>(${fmtN(hi)} higher than 10°)</small></div>
    <div class="ab-types">${types || 'None of the loaded objects is above your horizon right now.'}</div>
    <div class="ab-src">Computed by Skyline from ${src}, propagated with SGP4 to ${new Date(a.at).toISOString().slice(11, 19)} UTC. Only the ${fmtN(N)} loaded objects are checked.</div>
    <div class="list">${rows}</div>${a.list.length > 8 ? `<button class="btn sm" id="abMore">${aboveShowAll ? 'Show fewer' : `Show ${a.list.length > 60 ? 'the highest 60' : 'all ' + a.list.length}`}</button>` : ''}`);
  return a;
}

// Optional cross-check with N2YO, only when this site's server has a key (never in the browser)
const extras = { health: null, kp: null, wx: null, wxKey: '', above: null };
async function apiJson(p) {
  if (location.protocol === 'file:') return { ok: false, status: 0, json: null };
  try { const r = await fetch(p, { headers: { Accept: 'application/json' }, cache: 'no-cache' }); let j = null; try { j = await r.json(); } catch { } return { ok: r.ok, status: r.status, json: j }; }
  catch { return { ok: false, status: 0, json: null }; }
}
async function loadExtras() {
  const [h, k] = await Promise.all([apiJson('api/health'), apiJson('api/kp')]);
  extras.health = h.ok && h.json ? h.json : null;
  extras.kp = k.ok && k.json && Array.isArray(k.json.samples) ? k.json : { error: (k.json && k.json.error) || (k.status ? `HTTP ${k.status}` : 'This copy of the page has no data server.') };
  renderConditions(); renderN2yoBtn();
}
function renderN2yoBtn() { const b = $('abN2yo'); if (b) b.hidden = !(extras.health && extras.health.n2yo && extras.health.n2yo.configured) || !obs; }
async function crossCheckN2yo() {
  if (!obs) return;
  const box = $('abCheck'), b = $('abN2yo'); b.disabled = true; box.hidden = false; box.textContent = 'Asking N2YO…';
  const r = await apiJson(`api/above?lat=${obs.lat.toFixed(3)}&lon=${obs.lon.toFixed(3)}`); b.disabled = false;
  if (!r.ok || !r.json || !Array.isArray(r.json.above)) { box.innerHTML = `<span class="tag approx">unavailable</span> ${esc((r.json && r.json.error) || 'N2YO could not be reached.')} Skyline’s own list above is unaffected.`; return; }
  const mine = aboveNow(), myIds = new Set(mine.list.map(h => objs[h.i].id)), theirs = r.json.above, inCat = theirs.filter(x => byId.has(x.noradId));
  const both = inCat.filter(x => myIds.has(x.noradId)).length, onlyThem = theirs.filter(x => !byId.has(x.noradId));
  box.innerHTML = `<b>N2YO</b> lists ${fmtN(theirs.length)} objects above the horizon of ${r.json.latitude}°, ${r.json.longitude}° (its location is rounded to 1°) at ${new Date(r.json.retrievedAt).toISOString().slice(11, 16)} UTC.
    ${fmtN(inCat.length)} of them are in Skyline’s loaded data, and Skyline also puts ${fmtN(both)} of those above your horizon now. ${onlyThem.length ? `${fmtN(onlyThem.length)} ${onlyThem.length === 1 ? 'is' : 'are'} from parts of the catalogue Skyline does not load, for example ${onlyThem.slice(0, 3).map(x => esc(x.name)).join(', ')}.` : ''}
    <br><small>Source: <a href="https://www.n2yo.com/" target="_blank" rel="noopener">N2YO.com</a>. Small differences come from the rounded location, a few seconds of time difference and different element sets.</small>`;
}
let byId = new Map();
function indexIds() { byId = new Map(); for (let i = 0; i < N; i++) if (objs[i].cat !== 'demo') byId.set(objs[i].id, i); }

// Sky conditions: NOAA planetary Kp (measured, global) and Open-Meteo cloud cover (forecast, local)
const KP_BANDS = [[9, 'G5 extreme storm'], [8, 'G4 severe storm'], [7, 'G3 strong storm'], [6, 'G2 moderate storm'], [5, 'G1 minor storm'], [4, 'active'], [0, 'quiet']];
const kpBand = kp => KP_BANDS.find(b => kp >= b[0])[1];
async function loadWeather() {
  if (!obs) return;
  const key = `${(Math.round(obs.lat * 4) / 4).toFixed(2)},${(Math.round(obs.lon * 4) / 4).toFixed(2)}`;
  if (extras.wxKey === key && extras.wx && Date.now() - extras.wx.got < 30 * 60e3) return renderConditions();
  extras.wxKey = key; extras.wx = { loading: true, got: Date.now() }; renderConditions();
  const r = await apiJson(`api/weather?lat=${obs.lat.toFixed(3)}&lon=${obs.lon.toFixed(3)}`);
  if (extras.wxKey !== key) return;
  extras.wx = r.ok && r.json && Array.isArray(r.json.hourly) ? { ...r.json, got: Date.now() } : { error: (r.json && r.json.error) || (r.status ? `HTTP ${r.status}` : 'This copy of the page has no data server.'), got: Date.now() };
  renderConditions();
}
function cloudAt(ms) {
  const h = extras.wx && extras.wx.hourly; if (!h) return null;
  let best = null; for (const x of h) { const d = Math.abs(Date.parse(x.time) - ms); if (d <= 90 * 60e3 && (!best || d < best.d)) best = { d, v: x.cloudCoverPercent }; }
  return best && best.v;
}
function renderConditions() {
  const el = $('cond'); if (!el) return;
  const kp = extras.kp, last = kp && kp.samples && kp.samples[kp.samples.length - 1];
  const kpTxt = !kp ? 'Loading…' : kp.error ? `<span class="dim">Not available: ${esc(kp.error)}</span>`
    : `<b>Kp ${last.kp.toFixed(1)}</b>, ${kpBand(last.kp)}${kp.stale ? ' <span class="tag approx">stale</span>' : ''} <small class="dim">3-hour interval from ${new Date(last.time).toISOString().slice(11, 16)} UTC ${new Date(last.time).toISOString().slice(5, 10)}</small>${kpSpark(kp.samples)}`;
  let wxTxt = obs ? 'Loading…' : 'Set a location first.';
  const wx = extras.wx;
  if (obs && wx && wx.error) wxTxt = `<span class="dim">Not available: ${esc(wx.error)}</span>`;
  else if (obs && wx && wx.hourly) {
    const now = cloudAt(simMs), p = issCache && issCache.list && issCache.list.find(x => x.t1 >= simMs), atPass = p ? cloudAt(p.tPeak) : null;
    wxTxt = `${now == null ? 'No forecast for the shown time' : `<b>${Math.round(now)}%</b> cloud cover at the shown time`}${p && atPass != null ? ` · <b>${Math.round(atPass)}%</b> at the next ISS pass (${localT(p.tPeak)})` : ''} <span class="tag approx">forecast</span>`;
  }
  setIfChanged(el, `<div class="kv"><span>Geomagnetic activity</span><b class="txt">${kpTxt}</b><span>Clouds</span><b class="txt">${wxTxt}</b></div>
    <p class="note">Kp: <a href="https://www.swpc.noaa.gov/" target="_blank" rel="noopener">NOAA SWPC</a> planetary index, a global measure of geomagnetic disturbance, not a local aurora forecast. Clouds: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> forecast for your location rounded to 0.25°.</p>`);
}
function kpSpark(samples) {
  const s = samples.slice(-16), W = 128, H = 22, bw = W / s.length;
  return `<svg class="kpsp" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Kp over the last ${s.length * 3} hours, from ${Math.min(...s.map(x => x.kp)).toFixed(1)} to ${Math.max(...s.map(x => x.kp)).toFixed(1)}">${s.map((x, k) => `<rect x="${(k * bw + 1).toFixed(1)}" y="${(H - 2 - x.kp / 9 * (H - 2)).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${Math.max(1, x.kp / 9 * (H - 2)).toFixed(1)}" fill="${x.kp >= 5 ? 'var(--amber)' : 'var(--accent)'}" opacity="${k === s.length - 1 ? 1 : 0.55}"/>`).join('')}</svg>`;
}
let issCache = null;
function renderSky(force) {
  if (!obs) return;
  renderAbove(); renderConditions();
  const iss = featured.iss;
  if (iss == null) { $('issPass').textContent = 'The ISS is not in the loaded data.'; return; }
  if (force || !issCache || simMs > issCache.until || simMs < issCache.from) { const l = passesFor(objs[iss], simMs); issCache = { from: simMs, list: l, until: l.length ? l[0].t1 : simMs + 3600e3 }; }
  const p = issCache.list.find(x => x.t1 >= simMs);
  setIfChanged($('issPass'), p ? `<button class="item" data-replay-iss="${issCache.list.indexOf(p)}" title="Replay this pass"><span>${p.t0 <= simMs ? '<b style="color:var(--ok)">Overhead now</b>' : 'In ' + dur((p.t0 - simMs) / 60e3)}<br><small>${localT(p.t0)} your time · peak ${Math.round(p.max)}°</small></span><span class="r">${Math.max(1, Math.round((p.t1 - p.t0) / 60e3))} min<br><small>Replay ›</small></span></button>` : 'No ISS pass above 10° in the next 24 hours.');
}

// ───────────────────────── ground track (2D, works without WebGL)
function drawGroundTrack() {
  const cv = $('gt'), g = cv.getContext('2d'), W = cv.width, H = cv.height, X = l => (l + 180) / 360 * W, Y = l => (90 - l) / 180 * H;
  g.fillStyle = '#0b2a52'; g.fillRect(0, 0, W, H);
  if (earthReady) g.drawImage(earthReady, 0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
  for (let l = -150; l <= 150; l += 30) { g.beginPath(); g.moveTo(X(l), 0); g.lineTo(X(l), H); g.stroke(); }
  for (let l = -60; l <= 60; l += 30) { g.beginPath(); g.moveTo(0, Y(l)); g.lineTo(W, Y(l)); g.stroke(); }
  if (obs) { g.fillStyle = '#f0b35e'; g.beginPath(); g.arc(X(obs.lon), Y(obs.lat), 6, 0, TAU); g.fill(); }
  const o = objs[sel]; if (!o) return;
  let prev = null, cur = null;
  for (let m = -45; m <= 135; m++) {
    const ms = simMs + m * 60e3, s = eciAt(o, ms); if (!s) { prev = null; continue; }
    const p = geodetic(s.r, gmstAt(ms));
    if (prev && Math.abs(p.lon - prev.lon) < 180) { g.strokeStyle = m <= 0 ? 'rgba(255,255,255,.35)' : '#fff'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(X(prev.lon), Y(prev.lat)); g.lineTo(X(p.lon), Y(p.lat)); g.stroke(); }
    prev = p; if (m === 0) cur = p;
  }
  if (cur) { g.fillStyle = '#fff'; g.strokeStyle = '#ff7a45'; g.lineWidth = 3; g.beginPath(); g.arc(X(cur.lon), Y(cur.lat), 7, 0, TAU); g.fill(); g.stroke(); }
}
let earthReady = null; earthImg.then(im => { earthReady = im; drawGroundTrack(); }).catch(() => {});

// ───────────────────────── stats
let hist = null;
function buildStats() {
  const real = objs.slice(0, N), cnt = t => real.filter(o => o.type === t).length, demo = data.mode === 'demo';
  $('tiles').innerHTML = [[N, 'loaded objects'], [cnt('active'), 'active satellites'], [cnt('inactive'), 'inactive satellites'], [cnt('rocket'), 'rocket bodies'], [cnt('debris'), 'debris']].map(([n, l]) => `<div class="st"><b>${fmtN(n)}</b><span>${l}</span></div>`).join('');
  const failed = (data.groupsFailed || []).length;
  $('countDef').innerHTML = demo
    ? '<span class="tag sim">demo</span> These are generated demo objects, not real counts.'
    : `Counted: every object whose orbital elements loaded from the ${data.groupsOk.length} CelesTrak group${data.groupsOk.length === 1 ? '' : 's'} listed under Data source${failed ? ` (${failed} group${failed === 1 ? '' : 's'} failed)` : ''}, counted once even if it appears in several groups. <b>This is a subset of the catalog:</b> most inactive satellites, rocket bodies and debris are not in these groups.` + (data.skipped ? ` ${fmtN(data.skipped)} record${data.skipped === 1 ? '' : 's'} with missing or invalid fields ${data.skipped === 1 ? 'was' : 'were'} skipped.` : '');
  // histogram: 0–2000 km, 50 km bins, stacked by type
  const B = 40, bins = Array.from({ length: B }, () => ({ active: 0, inactive: 0, rocket: 0, debris: 0 }));
  for (const o of real) { const b = Math.floor(o.meanAlt / 50); if (b >= 0 && b < B && o.regime === 'LEO') bins[b][o.type]++; }
  hist = { bins, B, focus: -1, hover: -1 };
  $('histKey').innerHTML = ['active', 'inactive', 'rocket', 'debris'].map(t => `<span><span class="dot" style="background:${TYPES[t].color};border-radius:2px"></span> ${TYPES[t].label}</span>`).join('');
  drawHist();
  // regimes
  const rc = { LEO: 0, MEO: 0, GEO: 0, HEO: 0 }; real.forEach(o => rc[o.regime]++);
  const mx = Math.max(1, ...Object.values(rc));
  $('regBars').innerHTML = Object.keys(rc).map(k => `<div class="bar-row" title="${REGIMES[k].tip}"><span>${k}</span><div class="track"><div class="fill" style="width:${rc[k] / mx * 100}%"></div></div><span class="n">${fmtN(rc[k])}</span></div>`).join('') +
    '<p class="note">LEO: up to 2,000 km. MEO: 2,000 to 35,786 km (GPS). GEO: the belt at 35,786 km over the equator, where a satellite keeps pace with Earth’s spin. HEO: very stretched orbits. Grouped by each object’s average altitude.</p>';
  // insights derived from the loaded data
  const ins = [];
  let pk = 0; const tot = b => b.active + b.inactive + b.rocket + b.debris;
  bins.forEach((b, i) => { if (tot(b) > tot(bins[pk])) pk = i; });
  const leo = real.filter(o => o.regime === 'LEO').length;
  if (leo) {
    const inBand = real.filter(o => o.regime === 'LEO' && Math.floor(o.meanAlt / 50) === pk), fam = {};
    inBand.forEach(o => { const f = o.nameU.split(/[\s\-(]/)[0]; fam[f] = (fam[f] || 0) + 1; });
    const top = Object.entries(fam).sort((a, b) => b[1] - a[1])[0];
    ins.push(`The most crowded 50 km band is <b>${pk * 50}–${pk * 50 + 50} km</b>, with ${fmtN(tot(bins[pk]))} objects, ${Math.round(tot(bins[pk]) / leo * 100)}% of the low-orbit objects loaded.` + (top && top[1] / inBand.length > 0.5 ? ` ${Math.round(top[1] / inBand.length * 100)}% of them are named ${esc(top[0])}, so one constellation dominates it.` : ''));
  }
  const junk = cnt('debris') + cnt('rocket');
  if (N) ins.push(`<b>${Math.round(junk / N * 100)}%</b> of the loaded objects are debris or rocket bodies: ${fmtN(junk)} pieces of junk next to ${fmtN(cnt('active'))} working satellites.`);
  if (!demo) {
    const fy = real.filter(o => o.groups.includes('fengyun-1c-debris')).length, irid = real.filter(o => o.groups.includes('iridium-33-debris') || o.groups.includes('cosmos-2251-debris')).length;
    if (fy) ins.push(`<b>${fmtN(fy)}</b> tracked fragments from the 2007 Fengyun-1C anti-satellite test are still in orbit in this data, nearly two decades later.`);
    if (irid) ins.push(`<b>${fmtN(irid)}</b> fragments from the 2009 Iridium 33 and Cosmos 2251 collision are still tracked here.`);
    const old = real.filter(o => simMs - o.epoch > 7 * 864e5).length;
    if (old) ins.push(`${fmtN(old)} objects have elements more than a week old, so their positions are less certain.`);
  }
  $('insights').innerHTML = (demo ? '<p class="note"><span class="tag sim">demo</span> These describe the demo set, not the real sky.</p>' : '') + ins.map(t => `<div class="insight">${t}</div>`).join('');
  // freshness
  const now = Date.now();
  $('fresh').innerHTML = demo ? '<span>Data</span><b style="font-family:var(--sans)">Demo, generated in your browser</b>' :
    `<span>${fetchedLabel()}</span><b>${utc(data.fetchedAt)}<br><small style="font-family:var(--sans)">${age(now - data.fetchedAt)} ago</small></b>
     <span>Newest elements</span><b>${utc(data.newestEpoch)}</b><span>Median element age</span><b>${age(now - data.medianEpoch)}</b><span>Oldest elements</span><b>${utc(data.oldestEpoch)}</b>
     <span>Could not propagate</span><b id="badCnt">–</b>`;
}
function histGeom() { const cv = $('hist'), r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2); return { cv, W: Math.max(200, r.width), H: 150, dpr }; }
function drawHist() {
  if (!hist) return;
  const { cv, W, H, dpr } = histGeom(); cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const { bins, B } = hist, padL = 34, padB = 18, pw = W - padL - 4, ph = H - padB - 8;
  const tot = b => b.active + b.inactive + b.rocket + b.debris, mx = Math.max(1, ...bins.map(tot));
  const nice = Math.pow(10, Math.floor(Math.log10(mx))), top = Math.ceil(mx / nice) * nice;
  g.strokeStyle = 'rgba(122,162,255,.14)'; g.fillStyle = '#97a6c4'; g.font = '10px "IBM Plex Mono",monospace'; g.textAlign = 'right';
  for (let k = 0; k <= 2; k++) { const v = top * k / 2, y = 8 + ph - v / top * ph; g.beginPath(); g.moveTo(padL, y); g.lineTo(W - 4, y); g.stroke(); g.fillText(v >= 1000 ? (v / 1000) + 'k' : v, padL - 4, y + 3); }
  const bw = pw / B;
  bins.forEach((b, i) => {
    let y = 8 + ph; const x = padL + i * bw + 1, w = Math.max(1, bw - 2);
    for (const t of ['active', 'inactive', 'rocket', 'debris']) { const h = b[t] / top * ph; g.fillStyle = TYPES[t].color; g.globalAlpha = band && (i * 50 < band[0] || i * 50 >= band[1]) ? 0.3 : 1; g.fillRect(x, y - h, w, h); y -= h; }
    g.globalAlpha = 1;
    if (i === hist.hover || i === hist.focus) { g.strokeStyle = '#fff'; g.lineWidth = 1; g.strokeRect(x - 0.5, 8, w + 1, ph); g.strokeStyle = 'rgba(122,162,255,.14)'; }
  });
  g.fillStyle = '#97a6c4'; g.textAlign = 'center';
  for (const km of [0, 500, 1000, 1500, 2000]) g.fillText(km + (km === 2000 ? ' km' : ''), clamp(padL + km / 50 * bw, padL + 6, W - 22), H - 4);
}
function histInfo(i) {
  const b = hist.bins[i], t = b.active + b.inactive + b.rocket + b.debris;
  $('histInfo').innerHTML = `<b>${i * 50}–${i * 50 + 50} km:</b> ${fmtN(t)} objects (${fmtN(b.active)} active, ${fmtN(b.inactive)} inactive, ${fmtN(b.rocket)} rocket bodies, ${fmtN(b.debris)} debris). ${band && band[0] === i * 50 ? 'Click again to clear the filter.' : 'Click to show only this band.'}`;
}
function histBin(e) { const { cv, W } = histGeom(), r = cv.getBoundingClientRect(), x = e.clientX - r.left, i = Math.floor((x - 34) / ((W - 38) / hist.B)); return i >= 0 && i < hist.B ? i : -1; }
function setBand(i) {
  band = i < 0 || (band && band[0] === i * 50) ? null : [i * 50, i * 50 + 50];
  $('bandChip').style.display = band ? 'flex' : 'none'; if (band) $('bandTxt').textContent = `Showing only ${band[0]}–${band[1]} km (average altitude)`;
  computeVisibility(); drawHist(); if (i >= 0) histInfo(i);
}

// ───────────────────────── layers / legend
function renderLayers() {
  const real = objs.slice(0, N), c = t => real.filter(o => o.type === t).length;
  $('types').innerHTML = TYPE_KEYS.map(t => `<label title="${TYPES[t].tip}"><input type="checkbox" data-t="${t}" ${typeOn[t] ? 'checked' : ''}>${legendIcon(TYPES[t].shape, TYPES[t].color)}<span>${TYPES[t].label}${t === 'sim' ? ' <span class="tag sim">sim</span>' : ''}</span><span class="cnt">${t === 'sim' ? simCount : fmtN(c(t))}</span></label>`).join('');
  const rc = k => real.filter(o => o.regime === k).length;
  $('regimes').innerHTML = Object.keys(REGIMES).map(k => `<label title="${REGIMES[k].tip}"><input type="checkbox" data-r="${k}" ${regOn[k] ? 'checked' : ''}><span>${REGIMES[k].label}</span><span class="cnt">${fmtN(rc(k))}</span></label>`).join('');
  $('lines').innerHTML = [['#ffffff', 'Orbit of the selected object (white ring marks it)'], ['#4fe0cf', 'Comparison object A'], ['#f0b35e', 'Comparison object B'], ['#f0b35e', 'Your location (shared with SignalScope)']].map(([c, l]) => `<div style="display:flex;gap:8px;align-items:center"><span class="sw" style="background:${c}"></span>${l}</div>`).join('');
}

// ───────────────────────── data badge + sources
const isStale = () => data.mode === 'stale' || (['live', 'cached', 'hosted'].includes(data.mode) && Date.now() - data.fetchedAt > STALE_AFTER);
const when = ms => new Date(ms).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10) ? new Date(ms).toISOString().slice(11, 16) + ' UTC' : utc(ms);
// One label per data state. Only data this site's server or this browser fetched from CelesTrak within the last few
// hours is LIVE; a stored snapshot, demo orbits and anything stale never are (test/labels.test.mjs).
function dataLabel(mode, stale) {
  if (mode === 'demo') return { key: 'demo', text: 'DEMO' };
  if (mode === 'snapshot') return { key: 'snapshot', text: 'SNAPSHOT' };
  if (mode === 'loading' || !mode) return { key: 'loading', text: 'LOADING' };
  if (stale || mode === 'stale') return { key: 'stale', text: 'STALE' };
  if (mode === 'live') return { key: 'live', text: 'LIVE' };
  return { key: 'cached', text: 'CACHED' };   // this browser's cache, or a recent copy stored on the site
}
let lastLabel = null;
function renderBadge() {
  const b = $('badge'), m = data.mode, L = dataLabel(m, isStale()); b.dataset.mode = L.key;
  const short = innerWidth <= 720;
  $('badgeTxt').textContent = L.key === 'demo' || L.key === 'loading' ? L.text
    : L.key === 'snapshot' ? `${L.text} · ${short ? utc(data.fetchedAt).slice(5, 10) : utc(data.fetchedAt).slice(0, 10)}`
    : `${L.text} · ${when(data.fetchedAt)}`;
  b.title = `${L.text}: ${dataSourceLine()} Click for details.`;
  b.setAttribute('aria-label', `Data: ${b.title}`);
  // a state that got worse is announced once, instead of a permanent warning line
  if (lastLabel && lastLabel !== L.key && (L.key === 'stale' || (['snapshot', 'demo'].includes(L.key) && data.fallback))) toast(L.key === 'stale' ? `Orbital data is now stale: last updated ${when(data.fetchedAt)}. Positions are less certain.` : L.key === 'snapshot' ? `Fresh data could not be loaded. Showing a CelesTrak snapshot from ${utc(data.fetchedAt).slice(0, 10)}.` : 'Real data could not be loaded. Showing labelled demo orbits.');
  lastLabel = L.key;
  if (!$('dpop').hidden) renderDataPop();
}
function dataSourceLine() {
  const m = data.mode;
  return m === 'demo' ? 'Generated demo orbits, not real objects.'
    : m === 'snapshot' ? `CelesTrak elements captured ${utc(data.fetchedAt)}, stored with this site.`
    : data.src === 'api' ? `CelesTrak elements, downloaded by this site’s server ${when(data.fetchedAt)}.`
    : m === 'loading' ? 'Loading orbital data.' : `CelesTrak elements from ${data.src === 'hosted' ? 'a copy stored on this site' : data.src === 'browser-cache' ? 'this browser’s cache' : 'CelesTrak'}, updated ${when(data.fetchedAt)}.`;
}
// small popover under the chip: source, times, element range, and the way to the full details
function renderDataPop() {
  const m = data.mode, L = dataLabel(m, isStale()), groups = (data.groupsOk || []);
  $('dpop').innerHTML = `<div class="dp-h"><span class="dp-chip" data-mode="${L.key}">${L.text}</span><button class="btn sm" id="dpClose" aria-label="Close">✕</button></div>
    <p>${esc(dataSourceLine())}</p>
    ${m === 'demo' ? '' : `<div class="kv"><span>Positions</span><b class="txt">propagated in your browser (SGP4)</b><span>Newest elements</span><b>${utc(data.newestEpoch)}</b><span>Oldest elements</span><b>${utc(data.oldestEpoch)}</b></div>
    ${groups.length ? `<div class="dp-g">${groups.map(g => `<span title="${esc(g.note || '')}">${esc(g.label)}</span><b>${fmtN(g.n)}${data.fetchedAtIsEpoch ? '' : ' · ' + when(g.at)}${g.err || g.stale ? ' <span class="tag approx">stale</span>' : ''}</b>`).join('')}</div>` : ''}`}
    ${data.note ? `<p class="note">${esc(data.note)}</p>` : ''}
    <div class="row-btns" style="margin-top:8px"><button class="btn sm" id="dpRefresh">Refresh</button><button class="btn sm" id="dpMore">Details and checks</button><button class="btn sm" id="dpLearn">How it works</button></div>`;
  $('dpClose').onclick = closeDataPop;
  $('dpRefresh').onclick = () => { closeDataPop(); loadData({ force: true }); };
  $('dpMore').onclick = () => { closeDataPop(); go('data', 'sources'); };
  $('dpLearn').onclick = () => { closeDataPop(); go('learn', 'l-src'); };
}
function openDataPop() {
  renderDataPop(); const pop = $('dpop'), r = $('badge').getBoundingClientRect(); pop.hidden = false;
  pop.style.left = clamp(r.left, 12, innerWidth - pop.offsetWidth - 12) + 'px'; pop.style.top = r.bottom + 6 + 'px'; $('badge').setAttribute('aria-expanded', 'true'); $('dpClose').focus(); }
function closeDataPop() { if ($('dpop').hidden) return; $('dpop').hidden = true; $('badge').setAttribute('aria-expanded', 'false'); }
const fetchedLabel = () => data.fetchedAtIsEpoch ? 'Snapshot date (newest element)' : data.src === 'hosted' || data.src === 'api' ? 'Last successful update (server)' : 'Last successful update';
function renderSources() {
  const m = data.mode, modeTxt = {
    live: data.src === 'api'
      ? 'Positions are calculated live in your browser with SGP4 from CelesTrak orbital elements that this site’s server downloaded. The server refreshes them every 2 hours; your browser does not contact CelesTrak.'
      : `Positions are calculated live in your browser with SGP4 from orbital elements this browser downloaded from CelesTrak at ${utc(data.fetchedAt)}.`,
    cached: data.fallback
      ? `Live data could not be loaded, so the copy cached in this browser (downloaded ${utc(data.fetchedAt)}) is shown. Accuracy drops as it ages.`
      : 'Positions are calculated live with SGP4 from CelesTrak elements cached in this browser. They were not downloaded again because CelesTrak updates about every 2 hours.',
    stale: data.src === 'api'
      ? 'This site’s data server could not refresh the elements from CelesTrak, so it is serving the last good copy. Positions are still calculated with SGP4, but they are less certain as the elements age.'
      : 'Live data could not be loaded, so the newest copy available is shown. It is more than 3 hours old, so positions are less certain.',
    hosted: 'Positions are calculated live in your browser with SGP4 from CelesTrak elements that this website’s server downloaded (see the time below). Your browser did not contact CelesTrak.',
    snapshot: data.src === 'hosted'
      ? `Positions are calculated live with SGP4 from a copy of CelesTrak elements stored on this website. ${data.fetchedAtIsEpoch ? 'Its download time is unknown, so it is dated by its newest element' : 'The copy is more than 3 hours old, so it is treated as a dated snapshot'}. Accuracy drops as it ages.`
      : 'Positions are calculated live with SGP4 from a snapshot of CelesTrak elements built into this page. The snapshot ages, so accuracy drops over time.',
    demo: 'Demo mode: no real orbital data loaded. Objects are generated in circular orbits that roughly match real populations (stations, a broadband constellation, debris clouds, GPS, GEO). Positions, names and counts are not real.',
  }[m];
  const ok = (data.groupsOk || []).map(g => `<tr><td>${esc(g.label)}${g.note ? `<br><small class="dim">${esc(g.note)}</small>` : ''}${g.err ? `<br><small style="color:var(--warn)">Refresh failed: ${esc(g.err)}</small>` : ''}</td><td class="num">${fmtN(g.n)}</td><td>${data.fetchedAtIsEpoch ? '–' : when(g.at)}${g.stale ? ' <span class="tag approx">stale</span>' : ''}</td><td><a href="${CT}?GROUP=${g.key}&amp;FORMAT=json" target="_blank" rel="noopener">${g.key}</a></td></tr>`).join('');
  const bad_ = (data.groupsFailed || []).map(g => `<tr><td>${esc(g.label)}</td><td colspan="3" style="color:var(--warn)">${esc(g.reason)}</td></tr>`).join('');
  const stale = isStale(), tag = m === 'demo' ? 'sim' : stale ? 'approx' : m === 'live' || m === 'hosted' ? 'real' : 'approx';
  $('srcBody').innerHTML = `<p><span class="tag ${tag}">${m === 'hosted' ? 'server copy' : stale && m !== 'stale' ? m + ', stale' : m}</span> ${modeTxt}</p>` + (data.note ? `<p class="note">${esc(data.note)}</p>` : '') +
    (m !== 'demo' ? `<div class="kv"><span>${fetchedLabel()}</span><b>${utc(data.fetchedAt)}</b><span>Newest elements</span><b>${utc(data.newestEpoch)}</b></div>` : '') +
    (ok || bad_ ? `<h2>CelesTrak groups</h2><div class="tablewrap"><table><tr><th>Group</th><th>Objects</th><th>Updated</th><th>Source</th></tr>${ok}${bad_}</table></div>` : '') +
    `<h2>Checks</h2><p class="note">${esc((selfTest || runSelfTest()).msg)}</p>` +
    (m === 'demo' ? '<p class="note">Real data comes from this site’s Cloudflare Worker (worker/), which downloads CelesTrak every 2 hours, or from the CelesTrak snapshot stored with the site. A claude.ai artifact cannot run the server or contact CelesTrak, so it shows a snapshot or demo data.</p>' : '');
  $('bDemo').textContent = m === 'demo' ? 'Try live data again' : 'Switch to demo data';
  $('srcList').innerHTML = `<ul>
    <li><b>Orbital elements:</b> <a href="https://celestrak.org/NORAD/elements/" target="_blank" rel="noopener">CelesTrak GP data</a> (Dr T.S. Kelso), OMM JSON, groups: ${GROUPS.map(g => g.key).join(', ')}. Your browser downloads them at most once every 2 hours and caches them, or uses a recent copy stored on this website. After a refusal from CelesTrak it waits 2 hours before asking again.</li>
    <li><b>Propagation:</b> SGP4 from <a href="https://github.com/shashwatak/satellite-js" target="_blank" rel="noopener">satellite.js</a> 6.0.2. Checked at load against the published verification case from Vallado et al. (2006), "Revisiting Spacetrack Report #3". ${esc((selfTest || runSelfTest()).msg)}</li>
    <li><b>Frames:</b> SGP4 outputs positions in the TEME frame. The globe is turned by Greenwich sidereal time, which ignores precession and polar motion, a small error at this scale.</li>
    <li><b>Object type:</b> names containing R/B count as rocket bodies, names with DEB and the debris groups count as debris, objects in the active group count as active satellites, and everything else counts as inactive.</li>
    <li><b>Altitudes:</b> the average altitude comes from mean motion (semi-major axis minus Earth’s equatorial radius). Live altitude and sub-point come from the SGP4 position.</li>
    <li><b>Passes and overhead lists:</b> look angles on the WGS-84 ellipsoid, 10° minimum elevation. Rise, peak and set are refined to half a second from SGP4 positions. Whether the object is sunlit is shown in the Object panel; passes are not filtered by it.</li>
    <li><b>3D rendering:</b> <a href="https://threejs.org" target="_blank" rel="noopener">three.js</a> r128. Earth: Solar System Scope day and night maps (CC BY 4.0, based on NASA imagery), cloud-free composites lit by the computed Sun position, not a live picture; the city lights are a fixed composite. The embedded NASA Blue Marble map is the fallback. Stars: Hipparcos catalogue to magnitude 6, fixed in the inertial frame. Optional clouds (Layers, off by default) are decorative.</li>
    <li><b>Sun and lighting:</b> Sun direction from the Astronomical Almanac low-precision formula (about 0.01°) for the <i>simulation</i> time, so day and night follow the clock when you scrub or time-lapse. The terminator is the boundary of that illumination, with a 6° twilight band. City lights on the night side come from a fixed composite map, not tonight’s lights. The subsolar point in the time panel (SUN) is where the Sun is overhead at the simulation time.</li>
    <li><b>New York clock:</b> real current time in America/New_York (EST or EDT from the browser's time-zone data), updated once a second. It is a reference clock only, independent of the simulation time, and does not mean your location is known.</li></ul>`;
  const rows = [
    ['Object names, catalog numbers, orbital elements', m === 'demo' ? ['sim', 'demo'] : ['real', 'real'], 'From CelesTrak.'],
    ['Positions on the globe, altitude, speed', m === 'demo' ? ['sim', 'demo'] : ['approx', 'approx.'], 'SGP4 from public elements. Typically within a few km when fresh.'],
    ['Counts and statistics', m === 'demo' ? ['sim', 'demo'] : ['real', 'real, subset'], 'Only the groups loaded, not the full catalog.'],
    ['Active / inactive status', m === 'demo' ? ['sim', 'demo'] : ['approx', 'approx.'], 'Based on CelesTrak’s active list and object names.'],
    ['Closest pass between two objects', ['approx', 'approx.'], 'Geometric only, with no uncertainty. Not a collision prediction.'],
    ['Passes over you', ['approx', 'approx.'], 'Elevation above 10°, ignores sunlight.'],
    ['Collision probability or risk score', ['no', 'not implemented'], 'Needs validated conjunction data, which is not loaded.'],
    ['Breakup simulator fragments', ['sim', 'simulated'], 'Two-body physics, no drag. Not real objects.'],
    ['Earth surface image', ['approx', 'composite'], 'Solar System Scope maps based on NASA imagery: cloud-free composites, night lights fixed. Not a live view.'],
    ['Day and night on the globe', ['approx', 'computed'], 'Computed Sun direction for the simulation time. Not an observation.'],
    ['Night lights', ['approx', 'composite'], 'A fixed city-lights map (Solar System Scope, based on NASA imagery). Not tonight’s lights.'],
    ['Orbital POV', ['approx', 'computed'], 'Camera at the SGP4 position, looking at texture maps. Not spacecraft imagery.'],
    ['Stars', ['real', 'real catalogue'], 'Hipparcos positions (J2000) and magnitudes.'],
    ['Clouds on the globe (optional)', ['sim', 'decorative'], 'Off by default. Not real weather.'],
  ];
  $('realTbl').innerHTML = '<tr><th>Feature</th><th>Status</th><th>Notes</th></tr>' + rows.map(([f, [c, l], n]) => `<tr><td>${f}</td><td><span class="tag ${c}">${l}</span></td><td>${n}</td></tr>`).join('');
}

// ───────────────────────── suggestions + intro + tour
function suggestionChips() {
  return FEATURED.filter(f => featured[f.key] != null).map(f => `<button class="btn sm" data-j="${featured[f.key]}" title="${esc(f.why)}">${esc(f.label)}</button>`).join('') || '<span class="note">None of the suggested objects are in the loaded data.</span>';
}
function renderSuggestions() { $('sugg').innerHTML = suggestionChips(); }
let introShown = false;
function openIntro() {
  introShown = true;
  $('introData').innerHTML = data.mode === 'demo' ? `<span class="tag sim">demo</span> Live data is not available here, so you are seeing demo data. ${esc(data.note || '')}` : data.mode === 'snapshot' ? `<span class="tag approx">snapshot</span> ${fmtN(N)} objects from a CelesTrak snapshot dated ${utc(data.fetchedAt)}, with positions calculated in your browser.` : data.mode === 'stale' ? `<span class="tag approx">stale</span> ${fmtN(N)} objects from CelesTrak, last updated ${utc(data.fetchedAt)}. Fresh data could not be loaded, so positions are less certain.` : `<span class="tag real">${data.mode === 'hosted' ? 'server copy' : data.mode}</span> ${fmtN(N)} objects loaded from CelesTrak, with positions calculated in your browser.`;
  $('introSugg').innerHTML = suggestionChips();
  openOverlay('intro');
}
function openOverlay(id) { const el = $(id); el.hidden = false; lastFocus = document.activeElement; const f = el.querySelector('button'); if (f) f.focus(); }
function closeOverlay(id) { $(id).hidden = true; if (id === 'intro') store.set(INTRO_KEY, '1'); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
let lastFocus = null;

let tourI = -1;
const TOUR = [
  { t: 'Welcome to Project Skyline', run() { resetView(true); setSpeed(60); }, txt: () => `Each dot is a tracked object. ${data.mode === 'demo' ? 'This is demo data, so the dots are simulated.' : `${fmtN(N)} objects are loaded from CelesTrak, and each position is calculated with the SGP4 orbit model.`} Time runs 60× faster so you can see them move. Drag to rotate and scroll or pinch to zoom.` },
  { t: 'Meet the International Space Station', need: () => featured.iss != null, run() { select(featured.iss); setFollow(true); dist = clamp(fitDist() * 0.75, 2, 16); openTab('obj'); },
    txt: () => { const o = objs[featured.iss]; return `The camera is following the ISS. It orbits about ${fmtN(Math.round(o.meanAlt))} km up and goes around Earth every ${o.period.toFixed(0)} minutes, which is about ${(1440 / o.period).toFixed(1)} times a day.`; } },
  { t: 'Earth from the ISS’s position', pov: true, need: () => glOK && featured.iss != null && !bad[featured.iss], run() { setSpeed(60); enterPov(featured.iss, 'horizon', { byTour: true, quiet: true }); },
    txt: () => 'This is Earth from the ISS’s position, computed from its orbit: not a camera feed. Press 2 or Nadir to look straight down, 3 or Free look to drag the view around. Press Esc to return to the globe.' },
  { t: 'How to inspect a satellite', need: () => sel >= 0, run() { openTab('obj'); flash('insp'); }, txt: () => `The details panel shows its catalog number (its ID in the public catalog), live altitude and speed, and inclination, the tilt of the orbit against the equator. Elements epoch shows when the orbit was last measured: the older it is, the less certain the position.` },
  { t: 'The most crowded orbits', need: () => hist && N, run() { setFollow(false); let pk = 0; const tt = b => b.active + b.inactive + b.rocket + b.debris; hist.bins.forEach((b, i) => { if (tt(b) > tt(hist.bins[pk])) pk = i; }); this.pk = pk; setBand(pk); dist = fitDist(); openTab('sta'); flash('hist'); },
    txt() { const b = hist.bins[this.pk || 0]; return `The globe now shows only objects averaging ${(this.pk || 0) * 50}–${(this.pk || 0) * 50 + 50} km up: ${fmtN(b.active + b.inactive + b.rocket + b.debris)} of them in one thin shell. The chart shows how low orbit is shared out. Click any bar to filter.`; } },
  { t: 'A debris cloud', need: () => featured.fy != null, run() { setBand(-1); for (const t of TYPE_KEYS) typeOn[t] = t === 'debris'; computeVisibility(); renderLayers(); select(featured.fy); dist = fitDist() * 1.1; },
    txt: () => { const n = objs.slice(0, N).filter(o => o.groups.includes('fengyun-1c-debris')).length; return data.mode === 'demo' ? 'Only debris is shown. In 2007 an anti-satellite missile test destroyed the Fengyun-1C weather satellite at about 865 km. The orange cloud here is a demo version of its debris.' : `Only debris is shown. In 2007 an anti-satellite missile test destroyed the Fengyun-1C weather satellite at about 865 km. ${n ? fmtN(n) + ' of its fragments are in this data, still orbiting.' : ''} Each one is a hazard for decades.`; } },
  { t: 'Higher orbits: navigation and weather', need: () => featured.gps != null || featured.goes != null, run() { for (const t of TYPE_KEYS) typeOn[t] = true; computeVisibility(); renderLayers(); select(featured.gps != null ? featured.gps : featured.goes); dist = 12; },
    txt: () => 'Zoomed out to medium Earth orbit. GPS satellites circle about 20,200 km up, twice a day. Further out, the ring at 35,786 km is the geostationary belt, where weather and TV satellites keep pace with Earth’s spin.' },
  { t: 'SignalScope: the invisible infrastructure', need: () => scope.membersAll.length > 0, run() { for (const t of TYPE_KEYS) typeOn[t] = true; computeVisibility(); renderLayers(); setMode('scope'); if (!obs) setLocation(TOUR_PLACE.lat, TOUR_PLACE.lon, TOUR_PLACE.name); else scopeAimNow(); },
    txt: () => `SignalScope counts the tracked internet-constellation satellites above ${scope.el}° from one place${data.mode === 'demo' ? ' (here using demo orbits)' : ''}. Amber dots and lines are satellites above that limit right now. Drag the timeline to see how the count changes over the next hours. It is geometry only: it does not show service or speed.` },
  { t: 'Your turn', run() { go('explore'); resetView(true); setTimeout(() => $('q').focus(), 50); }, txt: () => `Search for any satellite by name or catalog number, or click a dot. The sections ${isPhone() ? 'along the bottom' : 'on the left'} hold the rest: Missions for what is above you and Orbital POV, Simulations for breakups, Compare & Data for comparisons and sources, and Learn for the science.` },
];
function flash(id) { const el = $(id); if (!el) return; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
function tourGo(i) {
  const steps = TOUR.map((s, k) => k).filter(k => !TOUR[k].need || TOUR[k].need());
  if (i < 0 || i >= TOUR.length) return endTour();
  if (!steps.includes(i)) { const next = steps.find(k => k > i); return next == null ? endTour() : tourGo(next); }
  tourI = i; const s = TOUR[i];
  if (pov && !s.pov) exitPov();
  try { s.run(); } catch (e) { console.warn('tour step', e); }
  $('tour').hidden = false;
  $('tourSteps').innerHTML = steps.map(k => `<i class="${k <= i ? 'on' : ''}"></i>`).join('');
  $('tourH').textContent = s.t; $('tourTxt').textContent = s.txt.call(s);
  $('tPrev').disabled = steps[0] === i; $('tNext').textContent = steps[steps.length - 1] === i ? 'Finish' : 'Next';
}
function tourStep(d) { const steps = TOUR.map((s, k) => k).filter(k => !TOUR[k].need || TOUR[k].need()); const p = steps.indexOf(tourI) + d; if (p >= steps.length) return endTour(); tourGo(steps[Math.max(0, p)]); }
function endTour() { tourI = -1; $('tour').hidden = true; if (pov && pov.byTour) exitPov(); }

// ───────────────────────── search
let qItems = [], qSel = -1;
function runSearch() {
  const raw = $('q').value.trim(), box = $('qres');
  if (!raw) { box.hidden = true; $('q').setAttribute('aria-expanded', 'false'); return; }
  const q = raw.toUpperCase(), digits = /^\d{1,9}$/.test(raw), real = objs.slice(0, N + simCount);
  let res = [];
  if (digits) { const o = real.find(o => o.id === +raw); if (o) res = [o]; }
  if (!res.length) {
    for (const o of real) { const k = o.nameU.indexOf(q); if (k >= 0 || (o.intl && o.intl.toUpperCase().startsWith(q))) res.push({ o, k: k < 0 ? 99 : k }); }
    res = res.sort((a, b) => a.k - b.k || a.o.name.length - b.o.name.length).slice(0, 8).map(r => r.o);
  }
  qItems = res; qSel = res.length ? 0 : -1;
  if (!res.length) {
    box.innerHTML = `<li class="empty" role="option" aria-disabled="true">${digits ? `Catalog number ${esc(raw)} is not in the ${fmtN(N)} loaded objects. It may have re-entered, be classified, or belong to a group Project Skyline does not load.` : `No loaded object matches "${esc(raw)}". Try a shorter name, such as ISS, STARLINK or NOAA.`}</li>`;
  } else box.innerHTML = res.map((o, k) => `<li role="option" id="qo${k}" aria-selected="${k === qSel}" data-j="${o.i}"><span>${esc(o.name)}</span><small>${o.cat === 'demo' ? TYPES[o.type].one : '#' + o.id + ' · ' + TYPES[o.type].one}</small>${glOK ? `<button class="qpov" type="button" tabindex="-1" data-pov="${o.i}" title="Orbital POV (Shift+Enter)" aria-label="Orbital POV from ${esc(o.name)}">POV</button>` : ''}</li>`).join('');
  box.hidden = false; $('q').setAttribute('aria-expanded', 'true');
}
function pickSearch(k) { const o = qItems[k]; if (!o) return; $('qres').hidden = true; $('q').value = o.name; $('q').blur(); select(o.i); openTab('obj'); flyTo(o.i); }
function flyTo(i) {
  if (!glOK) return; const k = i * 3, x = pos[k], y = pos[k + 1], z = pos[k + 2], r = Math.hypot(x, y, z) || 1;
  az = Math.atan2(x, z); el = Math.asin(clamp(y / r, -1, 1)); target[0] = target[1] = target[2] = 0; dist = Math.max(fitDist() * 0.85, r + 1.6);
}

// ───────────────────────── navigation
// Six sections, each with an address: #/section, or #/section/view for sections with a sub-nav (Learn takes an article
// id instead). The browser's Back and Forward move between them. The inspector is separate: it opens when an object is
// selected and closes with ×, Esc or by clearing the selection.
const SECTIONS = {
  explore: { t: 'Explore', s: 'Every tracked object on one globe. Choose what is drawn, and pick any object to inspect it.' },
  signalscope: { t: 'SignalScope', s: 'Which internet-constellation satellites are geometrically above a place, and how that changes.' },
  missions: { t: 'Missions', s: 'Your location, what is overhead and when it passes, and Earth seen from an orbit.', subs: [['overhead', 'Overhead'], ['passes', 'Passes'], ['pov', 'Orbital POV']] },
  simulations: { t: 'Simulations', s: 'A pretend breakup, and the real events behind today’s debris clouds.' },
  data: { t: 'Compare & Data', s: 'Compare two objects, see what is loaded, and check where the data comes from.', subs: [['compare', 'Compare'], ['stats', 'Statistics'], ['sources', 'Sources']] },
  learn: { t: 'Learn', s: 'How tracking works, what this data can and cannot tell you, and credits.' },
};
const nav = { sec: null, view: null, anchor: null, views: {}, panel: true, insp: false };
const isPhone = () => innerWidth <= 720, isNarrow = () => innerWidth < 1200;
const navHash = () => '#/' + nav.sec + (nav.view ? '/' + nav.view : nav.anchor ? '/' + nav.anchor : '');
function go(sec, view, opt = {}) {
  if (!SECTIONS[sec]) sec = 'explore';
  const S = SECTIONS[sec]; let anchor = null;
  if (S.subs) { if (!S.subs.some(x => x[0] === view)) view = nav.views[sec] || S.subs[0][0]; nav.views[sec] = view; }
  else { anchor = view && $(view) ? view : null; view = null; }
  const secChanged = nav.sec !== sec, viewChanged = nav.view !== view;
  nav.sec = sec; nav.view = view; nav.anchor = anchor;
  if ((sec === 'signalscope') !== scope.on) setMode(sec === 'signalscope' ? 'scope' : 'explore');
  const pane = $(sec === 'signalscope' ? 'p-scope' : 'p-' + sec);
  for (const p of document.querySelectorAll('#side .pane')) p.hidden = p !== pane;
  for (const a of document.querySelectorAll('#rail .nav')) { if (a.dataset.sec === sec) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  $('secT').textContent = S.t; $('secS').textContent = S.s; $('crumb').innerHTML = `<i>/</i>${esc(S.t)}`;
  for (const k of Object.keys(SECTIONS)) document.body.classList.toggle('sec-' + k, k === sec);
  const sn = $('subnav'); sn.hidden = !S.subs;
  if (S.subs) {
    sn.setAttribute('aria-controls', pane.id);
    sn.innerHTML = S.subs.map(([k, l]) => `<button role="tab" id="sv-${k}" data-view="${k}" aria-selected="${k === view}" tabindex="${k === view ? 0 : -1}">${l}</button>`).join('');
    for (const d of pane.querySelectorAll('.sub')) { const on = d.dataset.sub === view; if (on && !secChanged && viewChanged) enterAnim(d); d.hidden = !on; }
  }
  if (secChanged && !opt.boot) enterAnim(pane);
  if (!opt.keepPanel) setPanel(true, true);
  if (isNarrow() && !opt.keepInsp) setInsp(false, true);
  if (sec === 'missions') { renderSky(); drawGroundTrack(); renderPovPick(); }
  if (sec === 'simulations') renderSimTarget();
  if (sec === 'data') { if (view === 'stats') requestAnimationFrame(drawHist); if (view === 'compare') renderCompare(); if (view === 'sources') renderSources(); }
  if (!opt.fromHash) { const h = navHash(); if (location.hash !== h) try { history[opt.replace ? 'replaceState' : 'pushState'](null, '', h); } catch { } }
  if (anchor) requestAnimationFrame(() => { const t = $(anchor); if (t) { t.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' }); flash(anchor); } });
  else if (secChanged || viewChanged) pane.scrollTop = 0;
  layout();
}
function fromHash() {
  const m = /^#\/([a-z]+)(?:\/([\w-]+))?$/.exec(location.hash || '');
  if (!m) return false;
  if (m[1] === nav.sec && (m[2] || null) === (nav.view || nav.anchor)) return true;
  go(m[1], m[2], { fromHash: true }); return true;
}
// The section panel can be hidden to give the globe the full view (on phones it collapses to its title bar instead)
function setPanel(on, quiet) {
  if (nav.panel === on) return; nav.panel = on;
  document.body.classList.toggle('panel-off', !on);
  const b = $('bPanel'); b.setAttribute('aria-expanded', on); b.setAttribute('aria-label', on ? (isPhone() ? 'Collapse panel' : 'Hide panel') : (isPhone() ? 'Expand panel' : 'Show panel'));
  $('bPanel2').hidden = on;
  if (!quiet) layout();
}
function setInsp(on, quiet) {
  on = !!on && sel >= 0 && !!objs[sel];
  if (nav.insp === on) return; nav.insp = on;
  $('insp').hidden = !on; document.body.classList.toggle('has-insp', on);
  if (on) liveSelected(true);
  if (!quiet) layout();
}
function deselect() {
  if (pov) exitPov();
  sel = -1; passCache = null; setFollow(false);
  if (glOK) setLine(orbitSel, null);
  renderSelected(); drawGroundTrack();
  if (scope.on) renderScopeLive();
}
// Older code and the tour still name the five v6 tabs; map them onto the sections
function openTab(t) {
  if (t === 'obj') { if (scope.on) go('explore', null, { keepInsp: true }); setInsp(true); return; }
  if (t === 'lay') return go('explore');
  if (t === 'sta') return go('data', 'stats');
  if (t === 'saf') return go('data', 'compare');
  if (t === 'sky') return go('missions');
}
function renderPovPick() {
  const iss = featured.iss, oi = iss != null ? objs[iss] : null, o = sel >= 0 ? objs[sel] : null;
  $('povIss').disabled = !glOK || !oi;
  $('povIssTxt').textContent = !oi ? 'The ISS is not in the loaded data' : !glOK ? 'Needs WebGL, which is not available here' : `About ${fmtN(Math.round(oi.meanAlt))} km up, one orbit every ${oi.period.toFixed(0)} minutes`;
  $('povSel').disabled = !glOK || !o;
  $('povSelTxt').textContent = o ? `${o.name} · ${TYPES[o.type].one}` : 'Select an object on the globe or with search first';
}
function renderSimTarget() {
  const o = sel >= 0 ? objs[sel] : null;
  $('boomSel').innerHTML = o ? `<span class="eyebrow">Breaks up</span><b>${esc(o.name)}</b><span class="note">${TYPES[o.type].one} · about ${fmtN(Math.round(o.meanAlt))} km up</span>`
    : '<span class="eyebrow">No object selected</span><span class="note">Pick an object on the globe or with search, then simulate its breakup.</span>';
  $('bBoom').disabled = !o;
}

function enterAnim(el) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }

// ───────────────────────── reset
function resetView(keepTour) {
  if (pov) exitPov();
  az = view.az + angDiff(0.6, view.az); el = 0.35; target[0] = target[1] = target[2] = 0; dist = fitDist(); setFollow(false); scopeUnlock();
  for (const t of TYPE_KEYS) typeOn[t] = true; for (const k in regOn) regOn[k] = true;
  band = null; $('bandChip').style.display = 'none'; computeVisibility(); renderLayers(); drawHist();
  setSpeed(60); jumpNow();
  if (!keepTour) endTour();
}

// ───────────────────────── loading UI
let skipTimer = 0;
function showLoading(on) {
  $('loading').hidden = !on;
  if (on) { setLoading('Starting…', 0.02); $('ldSkip').hidden = true; clearTimeout(skipTimer); skipTimer = setTimeout(() => $('ldSkip').hidden = false, 4000); }
  else clearTimeout(skipTimer);
}
function setLoading(txt, f) { $('ldText').textContent = txt; $('ldBar').style.transform = `scaleX(${clamp(f, 0, 1)})`; }

// ───────────────────────── main loop
let acc = 0, slowAcc = 0;
function frameBody(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.1); lastFrame = now;
  simMs += dt * 1000 * speed; acc += dt; slowAcc += dt;
  const pf0 = performance.now();
  if (N) stepPositions(simMs);
  const g = gmstAt(simMs);
  if (glOK) {
    earth.rotation.y = g; clouds.rotation.y = g * 1.02 + 0.4;
    sunDir(simMs, earthMat.uniforms.sunDir.value); atmoMat.uniforms.sunDir.value.copy(earthMat.uniforms.sunDir.value);
    sunL.position.copy(earthMat.uniforms.sunDir.value).multiplyScalar(5);
    if (N) writeBuffers();
    if (pov && povFrame()) { /* camera placed by Orbital POV */ }
    else if (follow && sel >= 0 && !bad[sel]) {
      const k = sel * 3, x = pos[k], y = pos[k + 1], z = pos[k + 2], r = Math.hypot(x, y, z);
      az = view.az + angDiff(Math.atan2(x, z), view.az); el = Math.asin(clamp(y / r, -1, 1));
    } else if (scope.on && scope.lock && obs) scopeAim();
    if (!pov) { easeView(dt); camUpdate(); } cam.updateMatrixWorld();
    placeMarker($('ring'), sel, sel >= 0 ? objs[sel].name : '');
    placeMarker($('mkA'), cmpA, 'A'); placeMarker($('mkB'), cmpB, 'B');
    if (cmpA >= 0 && cmpB >= 0 && cmpA !== cmpB && !bad[cmpA] && !bad[cmpB]) { const a = linkAB.geometry.attributes.position; a.array.set(pos.subarray(cmpA * 3, cmpA * 3 + 3), 0); a.array.set(pos.subarray(cmpB * 3, cmpB * 3 + 3), 3); a.needsUpdate = true; linkAB.computeLineDistances(); linkAB.visible = true; } else linkAB.visible = false;
    placeHighlights();
    if (scope.on) scopeFrame(now, dt);
    if (now - orbitT > 2000 && sel >= 0) { orbitT = now; setLine(orbitSel, pov && pov.i === sel ? null : orbitPoints(objs[sel], simMs)); if (cmpA >= 0 || cmpB >= 0) updateCompareScene(); }
    const pf1 = performance.now(); rd.render(sc, cam); prof.js = prof.js * 0.95 + (pf1 - pf0) * 0.05; prof.gl = prof.gl * 0.95 + (performance.now() - pf1) * 0.05;
  }
  if (acc > 0.5) {
    acc = 0;
    const live = speed === 1 && Math.abs(simMs - Date.now()) < 5000, tm = $('tmode');
    tm.className = speed === 0 ? 'paused' : live ? 'live' : 'lapse';
    tm.textContent = speed === 0 ? 'PAUSED' : live ? 'REAL TIME' : `TIME-LAPSE ${speed}×`;
    const off = (simMs - Date.now()) / 60e3;
    const iso = new Date(simMs).toISOString(), narrow = innerWidth <= 720;
    if (narrow) tm.textContent = speed === 0 ? 'PAUSED' : live ? 'NOW' : `${speed}×`;
    $('clk').textContent = (narrow ? iso.slice(11, 16) : iso.slice(0, 19).replace('T', ' ')) + ' UTC' + (live || Math.abs(off) < 1 ? '' : ` ${off > 0 ? '+' : '−'}${dur(off)}`);
    { const ss = subsolarPoint(simMs, gmstAt(simMs)); $('sunT').textContent = `${Math.abs(ss.lat).toFixed(1)}°${ss.lat >= 0 ? 'N' : 'S'} ${Math.abs(ss.lon).toFixed(1)}°${ss.lon >= 0 ? 'E' : 'W'}`; }
    if (sel >= 0 && nav.insp) liveSelected(false);
    if (pov) povHud();
    if (nav.sec === 'missions') { renderSky(); drawGroundTrack(); }
    if (replay) replayTick();
    if (scope.on) scopeTick();
    if (cmpA >= 0 && cmpB >= 0 && $('cNow')) { const a = cmpA * 3, b = cmpB * 3; $('cNow').textContent = bad[cmpA] || bad[cmpB] ? 'cannot compute' : fmtN(Math.round(Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]) * RS)) + ' km'; }
  }
  if (slowAcc > 5) { slowAcc = 0; renderBadge(); const bc = $('badCnt'); if (bc) { let n = 0; for (let i = 0; i < N; i++) n += bad[i]; bc.textContent = n ? `${fmtN(n)} objects (likely re-entered)` : 'none'; } if (nav.sec === 'data' && nav.view === 'compare' && cmpA >= 0 && cmpB >= 0 && cmpResult && Math.abs(cmpResult.from - simMs) > 6 * 3600e3) renderCompare(); }
}
let frameErr = false;
function frame(now) {   // one failing frame must not stop the animation loop
  try { frameBody(now); } catch (e) { if (!frameErr) { frameErr = true; console.error('Project Skyline frame error:', e); } }
  requestAnimationFrame(frame);
}
const prof = { js: 0, gl: 0 };
function placeMarker(el, i, label) {
  if (i < 0 || !objs[i] || bad[i] || !vis[i]) { el.style.display = 'none'; return; }
  const s = screenOf(i); if (!s) { el.style.display = 'none'; return; }
  el.style.display = 'block'; el.style.left = s[0] + 'px'; el.style.top = s[1] + 'px'; if (el.firstChild.textContent !== label) el.firstChild.textContent = label;
  el.classList.toggle('left', s[0] > innerWidth - el.firstChild.offsetWidth - 40);
}
const hlEls = {};
function placeHighlights() {
  const on = $('hlOn').checked;
  for (const f of FEATURED) {
    const i = featured[f.key]; let el = hlEls[f.key];
    if (!el) { el = hlEls[f.key] = document.createElement('button'); el.className = 'hl'; el.tabIndex = -1;   // moving labels: keyboard users search instead
      el.textContent = f.label; el.title = f.why; el.onclick = () => { select(featured[f.key]); openTab('obj'); }; $('hls').appendChild(el); }
    if (!on || scope.on || pov || i == null || i === sel || bad[i] || !vis[i]) { el.style.display = 'none'; continue; }
    const s = screenOf(i); if (!s) { el.style.display = 'none'; continue; }
    el.style.display = 'block'; el.style.left = Math.min(s[0], innerWidth - el.offsetWidth - 12) + 'px'; el.style.top = s[1] + 'px';
  }
}

// ───────────────────────── SignalScope
// Which tracked satellites from known internet constellations are geometrically visible from one place, and when.
// An object counts only if its catalog name matches a constellation pattern AND it is on CelesTrak's active list
// (type 'active'). Debris, rocket bodies and unrecognised names are never counted. Visibility is geometry only.
const CONSTELLATIONS = [
  { key: 'starlink', label: 'Starlink', op: 'SpaceX', re: /^STARLINK[-\s]/, on: true },
  { key: 'oneweb', label: 'OneWeb', op: 'Eutelsat OneWeb', re: /^ONEWEB[-\s]/, on: true },
  { key: 'kuiper', label: 'Kuiper', op: 'Amazon Project Kuiper', re: /^KUIPER[-\s]/, on: true },
  { key: 'qianfan', label: 'Qianfan', op: 'Spacesail', re: /^QIANFAN[-\s]/, on: true },
  { key: 'o3b', label: 'O3b mPOWER', op: 'SES, medium Earth orbit', re: /^O3B\b/, on: true },
  { key: 'iridium', label: 'Iridium', op: 'Iridium: narrowband data and voice, not broadband', re: /^IRIDIUM \d+$/, on: false },
  { key: 'demo-bb', label: 'Demo broadband', op: 'Demo orbits, not real satellites', re: /^BROADBAND CONSTELLATION SAT \d+ \(DEMO\)$/, on: true, demo: true },
  { key: 'demo-hl', label: 'Demo high-LEO', op: 'Demo orbits, not real satellites', re: /^HIGH LEO CONSTELLATION SAT \d+ \(DEMO\)$/, on: true, demo: true },
];
const SCOPE_CALLS = 2e6;   // estimated SGP4 evaluations per timeline (about 1.5 s of work, spread across frames); sets the sampling step
const SCOPE_COARSE = 4;    // culling: one coarse sample per 4 fine samples decides whether the fine ones can be visible at all
const SCOPE_CULL_FRAC = 1 / SCOPE_COARSE + 0.12;   // typical share of samples that still need SGP4 after culling
const TRACK_MAX = 24, TRACK_MIN = 6, LOS_MAX = 32;   // tracks: the 24 highest satellites, 6 minutes either side; lines of sight: the 32 highest
// Built-in places, so location search needs no outside service. Coordinates are city centres, rounded to 0.01°.
const CITIES = `Seattle|USA|47.61|-122.33;San Francisco|USA|37.77|-122.42;Los Angeles|USA|34.05|-118.24;Denver|USA|39.74|-104.99;Chicago|USA|41.88|-87.63;New York|USA|40.71|-74.01;Washington|USA|38.91|-77.04;Boston|USA|42.36|-71.06;Philadelphia|USA|39.95|-75.17;Miami|USA|25.76|-80.19;Houston|USA|29.76|-95.37;Anchorage|USA|61.22|-149.9;Honolulu|USA|21.31|-157.86;Toronto|Canada|43.65|-79.38;Vancouver|Canada|49.28|-123.12;Montreal|Canada|45.5|-73.57;Iqaluit|Canada|63.75|-68.52;Mexico City|Mexico|19.43|-99.13;Havana|Cuba|23.11|-82.37;Bogotá|Colombia|4.71|-74.07;Quito|Ecuador|-0.18|-78.47;Lima|Peru|-12.05|-77.04;Manaus|Brazil|-3.12|-60.02;São Paulo|Brazil|-23.55|-46.63;Rio de Janeiro|Brazil|-22.91|-43.17;Buenos Aires|Argentina|-34.6|-58.38;Santiago|Chile|-33.45|-70.67;Ushuaia|Argentina|-54.8|-68.3;London|UK|51.51|-0.13;Dublin|Ireland|53.35|-6.26;Paris|France|48.86|2.35;Madrid|Spain|40.42|-3.7;Lisbon|Portugal|38.72|-9.14;Amsterdam|Netherlands|52.37|4.9;Berlin|Germany|52.52|13.4;Rome|Italy|41.9|12.5;Stockholm|Sweden|59.33|18.07;Oslo|Norway|59.91|10.75;Helsinki|Finland|60.17|24.94;Reykjavík|Iceland|64.15|-21.94;Tromsø|Norway|69.65|18.96;Longyearbyen|Svalbard|78.22|15.65;Warsaw|Poland|52.23|21.01;Kyiv|Ukraine|50.45|30.52;Athens|Greece|37.98|23.73;Istanbul|Türkiye|41.01|28.98;Moscow|Russia|55.76|37.62;Casablanca|Morocco|33.57|-7.59;Cairo|Egypt|30.04|31.24;Dakar|Senegal|14.72|-17.47;Accra|Ghana|5.6|-0.19;Lagos|Nigeria|6.52|3.38;Kinshasa|DR Congo|-4.44|15.27;Addis Ababa|Ethiopia|9.03|38.74;Nairobi|Kenya|-1.29|36.82;Johannesburg|South Africa|-26.2|28.05;Cape Town|South Africa|-33.92|18.42;Dubai|UAE|25.2|55.27;Riyadh|Saudi Arabia|24.71|46.68;Tehran|Iran|35.69|51.39;Karachi|Pakistan|24.86|67.01;Delhi|India|28.61|77.21;Mumbai|India|19.08|72.88;Bengaluru|India|12.97|77.59;Kolkata|India|22.57|88.36;Kathmandu|Nepal|27.72|85.32;Dhaka|Bangladesh|23.81|90.41;Bangkok|Thailand|13.76|100.5;Hanoi|Vietnam|21.03|105.85;Singapore|Singapore|1.35|103.82;Jakarta|Indonesia|-6.21|106.85;Manila|Philippines|14.6|120.98;Hong Kong|China|22.32|114.17;Shanghai|China|31.23|121.47;Beijing|China|39.9|116.41;Ulaanbaatar|Mongolia|47.89|106.91;Seoul|South Korea|37.57|126.98;Taipei|Taiwan|25.03|121.57;Tokyo|Japan|35.68|139.69;Perth|Australia|-31.95|115.86;Alice Springs|Australia|-23.7|133.88;Sydney|Australia|-33.87|151.21;Melbourne|Australia|-37.81|144.96;Auckland|New Zealand|-36.85|174.76;Suva|Fiji|-18.14|178.44;Apia|Samoa|-13.83|-171.76;Nuuk|Greenland|64.18|-51.72;McMurdo Station|Antarctica|-77.85|166.67;Mid-Pacific|open ocean|0|-160;Point Nemo|open ocean|-48.88|-123.39`
  .split(';').map(r => { const [name, country, lat, lon] = r.split('|'); return { name, country, lat: +lat, lon: +lon, key: fold(name + ' ' + country) }; });
function fold(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
const QUICK = ['Nairobi', 'London', 'São Paulo', 'Tokyo', 'Reykjavík', 'Mid-Pacific', 'McMurdo Station'];
const TOUR_PLACE = (() => { const c = CITIES.find(c => c.name === 'Nairobi'); return { lat: c.lat, lon: c.lon, name: 'Nairobi, Kenya' }; })();

const scope = {
  on: false, el: 25, lock: true, consOn: Object.fromEntries(CONSTELLATIONS.map(c => [c.key, c.on])),
  key: null, membersAll: [], totals: {}, pickable: null, ob: null, upLocal: null, hRef: 550,
  win: null, job: 0, visNow: [], countNow: null, setsAt: null, lastHtml: {},
};

// observerFrame, lookAngles and lookEl are in src/observer.js (inlined before this file by tools/build-page.mjs)
const capAngle = (h, e) => Math.acos(RS * Math.cos(e * D2R) / (RS + h)) - e * D2R;
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = az => COMPASS[Math.round(az / 22.5) % 16];
const fmtLat = v => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? 'N' : 'S'}`, fmtLon = v => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? 'E' : 'W'}`;
const hhmm = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function nearestCity(lat, lon) {
  let best = null;
  for (const c of CITIES) {
    const a = Math.sin((c.lat - lat) * D2R / 2) ** 2 + Math.cos(lat * D2R) * Math.cos(c.lat * D2R) * Math.sin((c.lon - lon) * D2R / 2) ** 2, km = 2 * RS * Math.asin(Math.sqrt(a));
    if (!best || km < best.km) best = { c, km };
  }
  return best;
}
// approximate Sun direction (Astronomical Almanac low-precision formula, about 0.01°), written into a THREE.Vector3 in scene axes
function sunDir(ms, out) { const v = eciToScene(sunEci(ms)); return out.set(v[0], v[1], v[2]); }

// ── membership
const memberCons = i => scope.key ? scope.key[i] : -1;
const consEnabled = i => { const k = memberCons(i); return k >= 0 && scope.consOn[CONSTELLATIONS[k].key]; };
function scopeDataChanged() {
  clearTimeout(scope.job); scope.win = null; scope.visNow = []; scope.countNow = null;
  scope.key = new Int8Array(CAP).fill(-1); scope.membersAll = []; scope.totals = {};
  const demo = data.mode === 'demo';
  for (let i = 0; i < N; i++) {
    const o = objs[i]; if (o.type !== 'active') continue;
    for (let k = 0; k < CONSTELLATIONS.length; k++) {
      const c = CONSTELLATIONS[k]; if (!!c.demo !== demo || !c.re.test(o.nameU)) continue;
      scope.key[i] = k; scope.membersAll.push(i); scope.totals[c.key] = (scope.totals[c.key] || 0) + 1; break;
    }
  }
  scope.pickable = new Uint8Array(CAP);
  scopeRefAlt(); buildScopeBuffers(); buildDome();
  if (scope.on && obs) scopeCompute(simMs);
  scopeTick(); renderScope(); drawDock();
}
function scopeRefAlt() {
  const alts = scope.membersAll.filter(consEnabled).map(i => objs[i].meanAlt).filter(h => h < 2000).sort((a, b) => a - b);
  scope.hRef = alts.length ? Math.round(alts[alts.length >> 1] / 10) * 10 : 550;
}

// ── timeline: sample every member's elevation over the window, a slice per frame so the page stays responsive
function scopeCompute(t0) {
  clearTimeout(scope.job);
  const members = scope.membersAll.slice(), M = members.length;
  if (!obs || !M) { scope.win = null; renderScope(); drawDock(); return; }
  const hours = +$('dkRange').value || 6, stepMin = Math.max(1, Math.ceil(M * hours * 60 * SCOPE_CULL_FRAC / SCOPE_CALLS)), step = stepMin * 60e3, S = Math.floor(hours * 60 / stepMin) + 1;
  t0 = Math.floor(t0 / 60e3) * 60e3;
  const cg = new Float64Array(S), sg = new Float64Array(S);
  for (let s = 0; s < S; s++) { const g = gmstAt(t0 + s * step); cg[s] = Math.cos(g); sg[s] = Math.sin(g); }
  const win = { t0, step, S, end: t0 + (S - 1) * step, members, M, el: new Int16Array(M * S), m: 0, done: false, hours, stepMin, at: Date.now(), ob: scope.ob, counts: null, windows: [] };
  scope.win = win;
  // Most of the time a satellite is far from the place. One coarse sample every SCOPE_COARSE steps measures its angle
  // from the place's zenith (seen from Earth's centre); if it is further than the horizon distance for its altitude plus
  // the most it can move in half a coarse interval, the fine samples around it are below the horizon (stored as −90°)
  // and need no SGP4. Samples next to an exact one at or above 0° are always computed exactly, for interpolation.
  const C = SCOPE_COARSE, H = C >> 1, need = new Uint8Array(S), pn = Math.hypot(...win.ob.p), ou = win.ob.p.map(v => v / pn);
  const exact = (o, base, s) => { const st = eciAt(o, t0 + s * step); win.el[base + s] = st ? Math.round(lookEl(win.ob, st.r, cg[s], sg[s]) * 100) : -32768; need[s] = 2; };
  const pump = () => {
    if (scope.win !== win) return;
    const start = performance.now(), stop = start + 24;
    while (win.m < M && performance.now() < stop) {
      const o = objs[members[win.m]], base = win.m * S;
      if (o.ecc > 0.05) { for (let s = 0; s < S; s++) exact(o, base, s); win.m++; continue; }   // fast near perigee: no culling
      const cap = capAngle(Math.max(150, o.apogee), 0) * R2D + 1.5, motion = (360 / o.period + 0.26) * H * stepMin + 0.5;
      need.fill(0);
      for (let s0 = 0; s0 < S; s0 += C) {
        const st = eciAt(o, t0 + s0 * step), lo = Math.max(0, s0 - H), hi = Math.min(S - 1, s0 + H);
        let far = false;
        if (st) {
          const r = st.r, x = cg[s0] * r[0] + sg[s0] * r[1], y = -sg[s0] * r[0] + cg[s0] * r[1];
          far = Math.acos(clamp((x * ou[0] + y * ou[1] + r[2] * ou[2]) / len3(r), -1, 1)) * R2D - motion > cap;
          win.el[base + s0] = Math.round(lookEl(win.ob, r, cg[s0], sg[s0]) * 100); need[s0] = 2;
        }
        if (!far) for (let s = lo; s <= hi; s++) if (need[s] !== 2) need[s] = 1;
      }
      for (let s = 0; s < S; s++) if (need[s] === 1) exact(o, base, s); else if (!need[s]) win.el[base + s] = -9000;
      for (let s = 0; s < S; s++) if (need[s] === 2 && win.el[base + s] >= 0) { if (s && !need[s - 1]) exact(o, base, s - 1); if (s < S - 1 && !need[s + 1]) exact(o, base, s + 1); }
      win.m++;
    }
    win.busy = (win.busy || 0) + performance.now() - start;
    if (win.m < M) { drawDock(); scope.job = setTimeout(pump, 0); }
    else { win.done = true; scopeDerive(); }
  };
  pump(); renderScope(); drawDock();
}
// counts per sample and visibility windows for the current elevation limit and constellation choice (no SGP4 needed)
function scopeDerive() {
  const w = scope.win; if (!w || !w.done) return;
  const { S, M, el, step, t0 } = w, thr = scope.el * 100, counts = new Uint16Array(S), windows = [];
  for (let m = 0; m < M; m++) {
    const i = w.members[m]; if (!consEnabled(i)) continue;
    const base = m * S; let open = null;
    for (let s = 0; s < S; s++) {
      const v = el[base + s];
      if (v >= thr) {
        counts[s]++;
        if (!open) { const p = s ? el[base + s - 1] : -32768; open = { i, t0: s && p > -32768 ? t0 + (s - 1 + (thr - p) / (v - p)) * step : t0 + s * step, cut0: s === 0, peak: v, tPeak: t0 + s * step }; }
        if (v > open.peak) { open.peak = v; open.tPeak = t0 + s * step; }
      } else if (open) {
        const p = el[base + s - 1]; open.t1 = v > -32768 ? t0 + (s - 1 + (p - thr) / (p - v)) * step : t0 + (s - 1) * step; open.peak /= 100; windows.push(open); open = null;
      }
    }
    if (open) { open.t1 = w.end; open.cut1 = true; open.peak /= 100; windows.push(open); }
  }
  windows.sort((a, b) => a.t0 - b.t0);
  let min = Infinity, max = 0, gaps = [], g0 = -1;
  for (let s = 0; s < S; s++) {
    min = Math.min(min, counts[s]); max = Math.max(max, counts[s]);
    if (!counts[s] && g0 < 0) g0 = s;
    if ((counts[s] || s === S - 1) && g0 >= 0) { gaps.push({ t0: t0 + g0 * step, t1: t0 + (counts[s] ? s : s + 1) * step }); g0 = -1; }
  }
  Object.assign(w, { counts, windows, min, max, gaps });
  scope.setsAt = new Map(); scopeTick(); renderScope(); drawDock();
}
const winValid = () => { const w = scope.win; return !!w && !!obs && w.ob === scope.ob; };
const inWindow = ms => { const w = scope.win; return !!w && ms >= w.t0 - 30e3 && ms <= w.end + 30e3; };

// ── the count at the shown time, from the current positions (exact geometry; the timeline is sampled)
function scopeTick() {
  if (!scope.key) return;
  const list = [];
  if (obs && scope.ob && N) {
    const g = gmstAt(simMs), c = Math.cos(g), s = Math.sin(g);
    for (const i of scope.membersAll) {
      if (bad[i] || !consEnabled(i)) continue;
      const k = i * 3, la = lookAngles(scope.ob, [pos[k] * RS, -pos[k + 2] * RS, pos[k + 1] * RS], c, s);
      if (la.el >= scope.el) list.push({ i, el: la.el, az: la.az, range: la.range });
    }
    list.sort((a, b) => b.el - a.el);
  }
  scope.pickable.fill(0); for (const v of list) scope.pickable[v.i] = 1;
  scope.visNow = list; scope.countNow = obs ? list.length : null;
  if (glOK) updateTracks();
  if (scope.on) renderScopeLive();
}
function scopeTimeChanged() { if (!scope.key) return; passCache = null; scopeTick(); drawDock(); }
function windowFor(i, ms) { const w = scope.win; if (!w || !w.done) return null; let cur = null, next = null; for (const x of w.windows) { if (x.i !== i) continue; if (x.t0 <= ms && x.t1 >= ms) cur = x; else if (x.t0 > ms && !next) next = x; } return { cur, next }; }

// ── 3D: constellation dots, visible satellites, their tracks, lines of sight, and the visibility dome at the place
let scAll, scVis, scVisCore, scTrk, scLos, scDome, scRim, scFoot, scSweep, scPulse;
function glowTex() {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return c;
}
function initScopeScene() {
  const add = (o, parent = sc) => { o.frustumCulled = false; o.visible = false; parent.add(o); return o; };
  const dotTex = new THREE.CanvasTexture(spriteTex('dot')), glow = new THREE.CanvasTexture(glowTex());
  scAll = add(new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 3.2, sizeAttenuation: false, color: 0x5fd0df, map: dotTex, transparent: true, opacity: 0.6, alphaTest: 0.05, depthWrite: false })));
  scVis = add(new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 22, sizeAttenuation: false, color: 0xf0b35e, map: glow, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending })));
  scVisCore = add(new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, color: 0xffe2b0, map: dotTex, transparent: true, alphaTest: 0.3 })));
  scTrk = add(new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
  scLos = add(new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ vertexColors: true, dashSize: 0.014, gapSize: 0.01, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
  obsG = new THREE.Group(); obsG.visible = false; earth.add(obsG);
  const cyan = (opacity, extra = {}) => new THREE.MeshBasicMaterial({ color: 0x5fd0df, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, ...extra });
  scDome = new THREE.Mesh(new THREE.BufferGeometry(), cyan(0.055)); scDome.frustumCulled = false; obsG.add(scDome);
  scSweep = new THREE.Mesh(new THREE.BufferGeometry(), cyan(0.16, { color: 0x8ee3ee })); scSweep.frustumCulled = false; scSweep.visible = false; obsG.add(scSweep);   // radar sweep retired in v6: decorative motion that implied scanning
  scRim = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x5fd0df, transparent: true, opacity: 0.6, depthWrite: false })); scRim.frustumCulled = false; obsG.add(scRim);
  scFoot = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0x5fd0df, transparent: true, opacity: 0.45, dashSize: 0.01, gapSize: 0.008, depthWrite: false })); scFoot.frustumCulled = false; obsG.add(scFoot);
  scPulse = new THREE.Mesh(new THREE.RingGeometry(0.014, 0.019, 48), new THREE.MeshBasicMaterial({ color: 0xf0b35e, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  scPulse.rotation.x = -Math.PI / 2; scPulse.position.y = 1.002; obsG.add(scPulse);
}
function buildScopeBuffers() {
  if (!glOK) return;
  const M = Math.max(1, scope.membersAll.length);
  scAll.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(M * 3), 3).setUsage(THREE.DynamicDrawUsage));
  for (const p of [scVis, scVisCore]) p.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(M * 3), 3).setUsage(THREE.DynamicDrawUsage));
  scLos.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(M * 6), 3).setUsage(THREE.DynamicDrawUsage));
  scLos.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(M * 6), 3).setUsage(THREE.DynamicDrawUsage));
  const T = TRACK_MAX * TRACK_MIN * 2 * 2;
  scTrk.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(T * 3), 3).setUsage(THREE.DynamicDrawUsage));
  scTrk.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(T * 3), 3).setUsage(THREE.DynamicDrawUsage));
  for (const o of [scAll, scVis, scVisCore, scLos, scTrk]) o.geometry.setDrawRange(0, 0);
}
function circle(R, lam, n = 96) { const a = new Float32Array(n * 3); for (let k = 0; k < n; k++) { const p = k / n * TAU; a[k * 3] = R * Math.sin(lam) * Math.cos(p); a[k * 3 + 1] = R * Math.cos(lam); a[k * 3 + 2] = R * Math.sin(lam) * Math.sin(p); } return new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(a, 3)); }
function buildDome() {
  if (!glOK || !obs) return;
  const R = 1 + scope.hRef / RS, lam = capAngle(scope.hRef, scope.el);
  for (const m of [scDome, scSweep, scRim, scFoot]) m.geometry.dispose();
  scDome.geometry = new THREE.SphereGeometry(R, 72, 18, 0, TAU, 0, lam);
  scSweep.geometry = new THREE.SphereGeometry(R * 1.001, 6, 18, 0, 0.3, 0, lam);
  scRim.geometry = circle(R, lam); scFoot.geometry = circle(1.0015, lam); scFoot.computeLineDistances();
  const f = obs.lat * D2R, l = obs.lon * D2R;
  scope.upLocal = new THREE.Vector3(Math.cos(f) * Math.cos(l), Math.sin(f), -Math.cos(f) * Math.sin(l));
  obsG.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), scope.upLocal);
  const lg = $('scDomeLg'); if (lg) lg.textContent = `Dome: where a satellite at ${fmtN(scope.hRef)} km (the typical altitude of these satellites) is above ${scope.el}°. Dashed ring: the ground beneath it.`;
}
const obsWorld = (out, k = 1) => { const u = scope.upLocal, g = earth.rotation.y, c = Math.cos(g), s = Math.sin(g); return out.set((u.x * c + u.z * s) * k, u.y * k, (-u.x * s + u.z * c) * k); };
const _ow = HAS_THREE ? new THREE.Vector3() : null;
function updateTracks() {
  const a = scTrk.geometry.attributes.position, col = scTrk.geometry.attributes.color; if (!a) return;
  let v = 0; const tmp = new Float32Array(3), list = scope.visNow.slice(0, TRACK_MAX);
  for (const h of list) {
    const o = objs[h.i]; let prev = null;
    for (let k = -TRACK_MIN; k <= TRACK_MIN; k++) {
      const st = eciAt(o, simMs + k * 60e3); if (!st) { prev = null; continue; }
      toScene(st.r, tmp, 0); const b = Math.pow(1 - Math.abs(k) / (TRACK_MIN + 0.5), 1.4) * 0.95;
      if (prev) { a.array.set(prev.p, v * 3); col.array.set(prev.c, v * 3); v++; a.array.set(tmp, v * 3); col.array.set([0.94 * b, 0.7 * b, 0.37 * b], v * 3); v++; }
      prev = { p: tmp.slice(), c: [0.94 * b, 0.7 * b, 0.37 * b] };
    }
  }
  scTrk.geometry.setDrawRange(0, v); a.needsUpdate = col.needsUpdate = true;
}
function scopeFrame(now, dt) {
  if (!glOK || !scope.key) return;
  const pa = scAll.geometry.attributes.position; let n = 0;
  if (pa) { for (const i of scope.membersAll) { if (bad[i] || !consEnabled(i)) continue; pa.array.set(pos.subarray(i * 3, i * 3 + 3), n * 3); n++; } scAll.geometry.setDrawRange(0, n); pa.needsUpdate = true; }
  const va = scVis.geometry.attributes.position, ca = scVisCore.geometry.attributes.position, la = scLos.geometry.attributes.position, lc = scLos.geometry.attributes.color;
  let m = 0;
  if (va && obs) {
    obsWorld(_ow, 1.002);
    for (const h of scope.visNow) {
      if (bad[h.i]) continue; const p = pos.subarray(h.i * 3, h.i * 3 + 3);
      va.array.set(p, m * 3); ca.array.set(p, m * 3);
      if (m < LOS_MAX) { la.array[m * 6] = _ow.x; la.array[m * 6 + 1] = _ow.y; la.array[m * 6 + 2] = _ow.z; la.array.set(p, m * 6 + 3); lc.array.set([0.25, 0.18, 0.08, 0.85, 0.62, 0.32], m * 6); }
      m++;
    }
  }
  scVis.geometry.setDrawRange(0, m); scVisCore.geometry.setDrawRange(0, m); scLos.geometry.setDrawRange(0, Math.min(m, LOS_MAX) * 2);
  if (va) { va.needsUpdate = ca.needsUpdate = la.needsUpdate = lc.needsUpdate = true; if (m) scLos.computeLineDistances(); }
  if (obs) {
    if (!reduceMotion) { const p = (now / 1600) % 1; scPulse.scale.setScalar(1 + p * 1.6); scPulse.material.opacity = 0.9 * (1 - p); }
    obsWorld(_ow, 1.004); const tag = $('obsTag');
    if (hiddenBehindEarth(_ow.x, _ow.y, _ow.z)) tag.style.display = 'none';
    else { const v = _ow.clone().project(cam); tag.style.display = 'block'; tag.style.left = (v.x + 1) / 2 * innerWidth + 'px'; tag.style.top = (1 - v.y) / 2 * innerHeight + 'px'; }
  }
  // the timeline follows the clock while playing
  const w = scope.win;
  if (w && w.done && speed > 0 && simMs >= w.end && simMs - dt * 1000 * speed < w.end + 1000) { simMs = w.end; setSpeed(0); refreshAll(simMs); scopeTick(); toast('Reached the end of the prediction window. Drag back, or recompute from here.', 4500); }
  if (speed > 0 || scope.scrubbing) drawDock();
  if (now - (scope.clkT || 0) > 120) { scope.clkT = now; renderDockClock(); }
}
function scopeAim() {
  if (!scope.upLocal) return;
  obsWorld(_ow, 1); const ta = Math.atan2(_ow.x, _ow.z), te = Math.asin(clamp(_ow.y, -1, 1));
  // look at a point just below the place, from a little to its south (north in the southern hemisphere's view is fine too),
  // so the dome is seen at an angle and the place sits in the middle of the free area
  az = view.az + angDiff(ta, view.az); el = clamp(te - 0.42, -1.35, 1.35);
  target[0] = _ow.x * 0.72; target[1] = _ow.y * 0.72; target[2] = _ow.z * 0.72;
}
function scopeAimNow() { scope.lock = true; setFollow(false); scopeAim(); dist = clamp(fitDist() * 0.42, 1.25, 5); renderScopeLoc(); }
function scopeUnlock() { if (scope.on && scope.lock) { scope.lock = false; renderScopeLoc(); } }
function scopeClick(mx, my) {
  const j = pickAt(mx, my, 12);
  if (j >= 0) { select(j); renderScope(); return; }
  if (!glOK) return;
  const rc = new THREE.Raycaster(); rc.setFromCamera({ x: mx / innerWidth * 2 - 1, y: -(my / innerHeight * 2 - 1) }, cam);
  const h = rc.intersectObject(earth)[0];
  if (h) { const l = earth.worldToLocal(h.point.clone()); setLocation(Math.asin(clamp(l.y, -1, 1)) * R2D, Math.atan2(-l.z, l.x) * R2D, null); }
}
function scopeTip(j) {
  const o = objs[j], c = CONSTELLATIONS[memberCons(j)], v = scope.visNow.find(h => h.i === j);
  return `<b>${esc(o.name)}</b>${c ? esc(c.label) + ' · ' : ''}${v ? `<span class="vis">${v.el.toFixed(1)}° above the horizon (${compass(v.az)})</span>` : 'below the elevation limit'}`;
}

// ── location
function setLocation(lat, lon, name) {
  lat = clamp(lat, -89.99, 89.99); lon = ((lon + 540) % 360) - 180;
  if (!name) { const nc = nearestCity(lat, lon); name = nc && nc.km < 400 ? `Near ${nc.c.name} (${fmtN(Math.round(nc.km / 10) * 10)} km)` : 'Picked point'; }
  setObserver(lat, lon, name);
  if (scope.on) scopeAimNow();
}
function scopeLocationChanged() {
  if (!obs) return;
  scope.ob = obs.ob; scope.win = null; clearTimeout(scope.job);
  if (glOK) { buildDome(); obsG.visible = scope.on; }
  $('obsTag').textContent = '◉ ' + obs.name.replace(/^Near /, '').replace(/ \(\d.*$/, '').replace(/, .*$/, '');
  if (scope.on) scopeCompute(simMs);
  scopeTick(); renderScope(); drawDock();
}

// ── mode
function setMode(m) {
  const on = m === 'scope'; if (on === scope.on) return;
  if (on && pov) exitPov();   // SignalScope aims the camera from its observer
  scope.on = on; document.body.classList.toggle('scope', on);
  $('dock').hidden = !on; $('c').classList.toggle('scope', on); hideTip();
  if (!on) $('obsTag').style.display = 'none';
  if (glOK) {
    for (const o of [scAll, scVis, scVisCore, scTrk, scLos]) o.visible = on;
    obsG.visible = on && !!obs;
    for (const t of TYPE_KEYS) { const L = layers[t]; if (L && L.mat) { L.mat.opacity = on ? 0.14 : 1; L.mat.alphaTest = on ? 0.01 : 0.35; L.mat.needsUpdate = true; } }
  }
  if (on) {
    if (!scope.key) scopeDataChanged();
    setFollow(false);
    if (obs) { if (!winValid() || !inWindow(simMs)) scopeCompute(simMs); scopeAimNow(); }
    else toast('Click anywhere on the globe to choose a place, or search for one in the panel.', 5000);
  } else { scope.lock = false; dist = fitDist(); target[0] = target[1] = target[2] = 0; }
  if (on && nav.sec !== 'signalscope') go('signalscope'); else if (!on && nav.sec === 'signalscope') go('explore');
  if (on) setInsp(false);
  layout();
  scopeTick(); renderScope(); renderDockControls(); drawDock();
}

// ── panel
function setHtml(id, html) { if (scope.lastHtml[id] === html) return; scope.lastHtml[id] = html; $(id).innerHTML = html; }
function renderScope() { if (!scope.on) return; renderScopeLoc(); renderScopeLive(); renderScopeData(); }
function renderScopeLoc() {
  const box = $('scLoc'); if (!box) return;
  box.classList.toggle('empty', !obs);
  setHtml('scLoc', obs
    ? `<span class="pin"></span><span style="flex:1;min-width:0"><b>${esc(obs.name)}</b><span class="mono">${fmtLat(obs.lat)}, ${fmtLon(obs.lon)}</span></span><button class="btn sm" id="scCentre" ${scope.lock && scope.on ? 'aria-pressed="true"' : ''} title="Keep the view centred on this place">${scope.lock && scope.on ? 'Centred' : 'Centre'}</button>`
    : '<span class="pin"></span><span><b>No location selected</b><span class="mono">Click the globe or search for a place</span></span>');
}
function timeTag(ms) {
  const d = (ms - Date.now()) / 60e3;
  if (Math.abs(d) < 1) return ['NOW', 'live', 'Calculated for the current time from orbital elements'];
  return d > 0 ? [`FORECAST +${dur(d)}`, 'fc', 'A prediction from orbital elements, not an observation'] : [`PAST −${dur(d)}`, 'paused', 'Calculated for an earlier time'];
}
function renderScopeLive() {
  if (!scope.on) return;
  const cnt = $('scCount'), w = scope.win, M = scope.membersAll.length;
  const txt = scope.countNow == null ? '–' : String(scope.countNow);
  if (cnt.textContent !== txt) { cnt.textContent = txt; cnt.classList.remove('tick'); void cnt.offsetWidth; cnt.classList.add('tick'); }
  const [tag, cls, tip] = timeTag(simMs);
  setHtml('scWhen', obs ? `<span class="tmode ${cls}" title="${tip}">${tag}</span><span>${hhmm(simMs)} your time</span><span>above ${scope.el}°</span>` : '<span>Choose a place to start counting.</span>');
  // constellation chips with how many of each are visible now
  const byC = {}; for (const v of scope.visNow) { const k = CONSTELLATIONS[memberCons(v.i)].key; byC[k] = (byC[k] || 0) + 1; }
  setHtml('scCons', CONSTELLATIONS.filter(c => scope.totals[c.key]).map(c => `<button data-cons="${c.key}" aria-pressed="${!!scope.consOn[c.key]}" title="${esc(c.op)}: ${fmtN(scope.totals[c.key])} tracked. Click to ${scope.consOn[c.key] ? 'leave out of' : 'include in'} the count.">${esc(c.label)} <b>${scope.consOn[c.key] && obs ? byC[c.key] || 0 : '·'}</b></button>`).join(''));
  // selected satellite
  let sh;
  if (sel >= 0 && objs[sel] && memberCons(sel) >= 0) {
    const o = objs[sel], c = CONSTELLATIONS[memberCons(sel)], st = obs && eciAt(o, simMs);
    if (!obs) sh = `<div class="card"><b>${esc(o.name)}</b><p class="note">${esc(c.label)}. Choose a place to see its elevation.</p></div>`;
    else if (!st) sh = `<div class="card"><b>${esc(o.name)}</b><p class="note">Its position cannot be computed at this time.</p></div>`;
    else {
      const g = gmstAt(simMs), la = lookAngles(scope.ob, st.r, Math.cos(g), Math.sin(g)), up = la.el >= scope.el, wf = windowFor(sel, simMs);
      const when = wf ? (wf.cur ? (wf.cur.cut1 ? `Above ${scope.el}° until after this window ends at ${hhmm(wf.cur.t1)}` : `Above ${scope.el}° until ${hhmm(wf.cur.t1)}, ${dur((wf.cur.t1 - simMs) / 60e3)} from now`) + ` (peak ${Math.round(wf.cur.peak)}°)` : wf.next ? `Next above ${scope.el}° at ${hhmm(wf.next.t0)}, in ${dur((wf.next.t0 - simMs) / 60e3)} (peak ${Math.round(wf.next.peak)}°)` : `Not above ${scope.el}° again in this window`) : '';
      sh = `<div class="card"><div style="display:flex;gap:8px;align-items:center"><b style="flex:1;min-width:0;overflow-wrap:anywhere">${esc(o.name)}</b><span class="tag ${up ? 'vis' : 'no'}">${up ? 'visible' : 'below limit'}</span></div>
        <div class="kv"><span>Elevation</span><b style="color:${up ? 'var(--amber)' : 'inherit'}">${la.el.toFixed(1)}°</b><span>Azimuth</span><b>${Math.round(la.az)}° ${compass(la.az)}</b><span>Range</span><b>${fmtN(Math.round(la.range))} km</b><span>Constellation</span><b style="font-family:var(--sans)">${esc(c.label)}</b></div>
        ${when ? `<p class="note" style="margin-top:8px">${when}</p>` : ''}</div>`;
    }
  } else sh = `<div class="empty-state">${obs ? 'Click an amber satellite on the globe, or one in the lists below, to see its elevation, direction and range.' : 'Choose a place first.'}</div>`;
  setHtml('scSel', sh);
  // visible now
  const visHtml = !obs ? '<div class="empty-state">Choose a place to list the satellites above it.</div>'
    : !M ? '<div class="empty-state">No internet-constellation satellites are in the loaded data.</div>'
    : !scope.visNow.length ? `<div class="empty-state"><b>None above ${scope.el}° at this moment</b>No tracked satellite from the selected constellations meets the elevation limit here at the shown time. Try a lower limit, or move along the timeline.</div>`
    : '<div class="list">' + scope.visNow.slice(0, 8).map(v => { const wf = windowFor(v.i, simMs), end = wf && wf.cur ? (wf.cur.cut1 ? 'past window end' : 'sets in ' + dur((wf.cur.t1 - simMs) / 60e3)) : ''; return `<button class="item" data-sj="${v.i}" ${v.i === sel ? 'aria-current="true"' : ''}><span>${esc(objs[v.i].name)}<br><small>${esc(CONSTELLATIONS[memberCons(v.i)].label)}${end ? ' · ' + end : ''}</small></span><span class="r" style="color:var(--amber)">${v.el.toFixed(0)}° ${compass(v.az)}</span></button>`; }).join('') + '</div>' + (scope.visNow.length > 8 ? `<p class="note">and ${fmtN(scope.visNow.length - 8)} more, lower in the sky.</p>` : '');
  setHtml('scVis', visHtml);
  // upcoming windows
  let wh;
  if (!obs) wh = '<div class="empty-state">Choose a place to predict when satellites rise above it.</div>';
  else if (!M) wh = '<div class="empty-state">Nothing to predict: no internet-constellation satellites are loaded.</div>';
  else if (!w || !w.done) wh = '<div class="skel" style="width:90%"></div><div class="skel" style="width:70%"></div><div class="skel" style="width:80%"></div>';
  else if (!inWindow(simMs)) wh = '<div class="empty-state">The shown time is outside the computed window. Use "Recompute" under the timeline.</div>';
  else {
    const next = w.windows.filter(x => x.t0 > simMs).slice(0, 6), gapsAhead = w.gaps.filter(g => g.t1 > simMs);
    const longest = w.gaps.reduce((m, g) => Math.max(m, g.t1 - g.t0), 0);
    const summary = w.gaps.length ? `<p class="note"><b style="color:var(--warn)">${w.gaps.length} gap${w.gaps.length === 1 ? '' : 's'}</b> with none above ${scope.el}° in this ${w.hours} h window (longest about ${dur(longest / 60e3)})${gapsAhead.length ? `, next at ${hhmm(Math.max(simMs, gapsAhead[0].t0))}` : ''}.</p>`
      : `<p class="note">At least <b style="color:var(--amber)">${fmtN(w.min)}</b> above ${scope.el}° at every sampled moment in this ${w.hours} h window (up to ${fmtN(w.max)}).</p>`;
    wh = summary + (next.length ? '<div class="list">' + next.map(x => `<button class="item" data-sj="${x.i}"><span>${esc(objs[x.i].name)}<br><small>rises ${hhmm(x.t0)} · ${x.cut1 ? 'still up at window end' : 'for ' + dur((x.t1 - x.t0) / 60e3)}</small></span><span class="r">in ${dur((x.t0 - simMs) / 60e3)}<br><small>peak ${Math.round(x.peak)}°</small></span></button>`).join('') + '</div>' : `<div class="empty-state">No more rises above ${scope.el}° before the window ends at ${hhmm(w.end)}.</div>`);
  }
  setHtml('scWin', wh);
}
function renderScopeData() {
  const M = scope.membersAll.length, demo = data.mode === 'demo', w = scope.win;
  if (!data || data.mode === 'loading') return setHtml('scData', '<div class="skel"></div><div class="skel" style="width:60%"></div>');
  const ages = scope.membersAll.map(i => simMs - objs[i].epoch).sort((a, b) => a - b), med = ages.length ? ages[ages.length >> 1] : 0, old = ages.length ? ages[ages.length - 1] : 0;
  const stale = isStale(), fcls = demo ? 'demo' : stale || med > 3 * 864e5 ? 'bad' : med > 864e5 || data.fallback ? 'warn' : 'ok';
  const ftxt = demo ? 'Demo orbits' : stale ? 'Stale' : med > 3 * 864e5 ? 'Old elements' : data.fallback ? 'Fallback copy' : med > 864e5 ? 'Ageing' : 'Fresh';
  let why = '';
  if (!M) why = demo ? '' : !(data.groupsOk || []).some(g => g.key === 'active') ? 'The active-satellite list did not load, so no satellite can be confirmed as an active member of an internet constellation. None are counted.' : 'No satellites with recognised internet-constellation names are on the active list in this data.';
  const src = demo ? 'Demo data generated in your browser. These are not real satellites.' : { live: 'CelesTrak, through this site’s data server', cached: 'CelesTrak, cached in this browser', hosted: 'CelesTrak, a copy stored on this site', stale: 'CelesTrak, last good copy', snapshot: 'CelesTrak snapshot' }[data.mode] || 'CelesTrak';
  setHtml('scData', (why ? `<div class="empty-state" style="margin-bottom:10px"><b>No constellation satellites to count</b>${esc(why)}</div>` : '') +
    `<div style="display:flex;align-items:center;gap:10px"><span class="fresh ${fcls}"><i></i>${ftxt}</span><button class="btn sm ghost" id="scSrc" style="margin-left:auto">Data details</button></div>
    <div class="kv"><span>Source</span><b style="font-family:var(--sans);font-weight:400">${esc(src)}</b>
    ${demo ? '' : `<span>${fetchedLabel()}</span><b>${utc(data.fetchedAt)}</b>`}
    <span>Satellites identified</span><b>${fmtN(M)}</b>
    ${M && !demo ? `<span>Median element age</span><b>${age(med)}</b><span>Oldest elements</span><b>${age(old)}</b>` : ''}
    ${w ? `<span>Timeline</span><b>${hhmm(w.t0)} to ${hhmm(w.end)}, every ${w.stepMin} min</b>` : ''}</div>` +
    (!demo && M && med > 3 * 864e5 ? `<div class="warnbox" style="margin-top:10px">Half of these elements are more than ${age(med)} old. Predictions get less certain the further they are from the element epoch, so treat future windows with caution.</div>` : '') +
    (demo ? '<p class="note" style="margin-top:8px"><span class="tag sim">demo</span> Real satellites load when the site runs with its data server and CelesTrak is reachable.</p>' : ''));
}

// ── timeline dock
const DOCK_SPEEDS = [[1, '1×', 'Real time'], [60, '60×', 'One minute per second'], [300, '300×', 'Five minutes per second'], [1200, '1200×', 'Twenty minutes per second']];
function renderDockControls() {
  const b = $('dkPlay'); if (!b) return;
  const playing = speed > 0;
  b.setAttribute('aria-pressed', playing); b.setAttribute('aria-label', playing ? 'Pause' : 'Play the prediction');
  b.innerHTML = playing ? '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.5h2.6v9H2.5zM6.9 1.5h2.6v9H6.9z" fill="currentColor"/></svg>' : '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.5v9l8-4.5z" fill="currentColor"/></svg>';
  $('dkSpd').innerHTML = DOCK_SPEEDS.map(([s, l, t]) => `<button class="btn sm" data-ds="${s}" title="${t}" aria-pressed="${s === playSpeed}">${l}</button>`).join('');
}
function renderDockClock() {
  const [tag, cls, tip] = timeTag(simMs), m = $('dkMode');
  if (m.textContent !== tag) { m.textContent = tag; m.className = 'tmode ' + cls; m.title = tip; }
  const t = `${hhmm(simMs)} <small>${new Date(simMs).toISOString().slice(0, 16).replace('T', ' ')} UTC</small>`;
  if ($('dkClock').innerHTML !== t) $('dkClock').innerHTML = t;
  const w = scope.win, tr = $('dkTrack');
  if (w) { const f = clamp((simMs - w.t0) / (w.end - w.t0), 0, 1); tr.setAttribute('aria-valuenow', Math.round(f * 100)); tr.setAttribute('aria-valuetext', `${hhmm(simMs)}, ${scope.countNow == null ? 'no count' : scope.countNow + ' visible'}`); }
  const out = w && w.done && !inWindow(simMs); $('dkRecalc').hidden = !(out || (obs && !w && scope.membersAll.length));
  const info = $('dkInfo');
  const txt = !obs ? 'Choose a place on the globe to compute its visibility timeline.'
    : !scope.membersAll.length ? 'No internet-constellation satellites are loaded, so there is nothing to plot.'
    : !w ? 'No timeline yet.' : !w.done ? `Computing visibility for ${fmtN(w.M)} satellites… ${Math.round(w.m / w.M * 100)}%`
    : out ? 'The shown time is outside this prediction window.'
    : `Predicted from orbital elements, not observed · sampled every ${w.stepMin} min · ${fmtN(w.min)}–${fmtN(w.max)} visible across the window${w.gaps.length ? ` · ${w.gaps.length} gap${w.gaps.length === 1 ? '' : 's'}` : ''}`;
  if (info.textContent !== txt) info.textContent = txt;
  info.classList.toggle('warn', !!out);
}
function dockGeom() { const cv = $('dkCv'), r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2); return { cv, W: Math.max(120, r.width), H: Math.max(30, r.height), dpr, padL: 30, padR: 6, padT: 6, padB: 16 }; }
function drawDock() {
  if (!scope.on) return;
  const G = dockGeom(), { cv, W, H, dpr, padL, padR, padT, padB } = G;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const pw = W - padL - padR, ph = H - padT - padB, w = scope.win;
  g.font = '10px "Geist Mono","IBM Plex Mono",monospace'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(255,255,255,.03)'; g.fillRect(padL, padT, pw, ph);
  const msg = t => { g.fillStyle = '#93a2b6'; g.textAlign = 'center'; g.fillText(t, padL + pw / 2, padT + ph / 2); };
  if (!obs) { renderDockClock(); return msg('Choose a place on the globe'); }
  if (!w) { renderDockClock(); return msg(scope.membersAll.length ? 'No timeline yet' : 'No constellation satellites loaded'); }
  const X = t => padL + (t - w.t0) / (w.end - w.t0) * pw;
  if (!w.done) {
    const f = w.m / Math.max(1, w.M);
    g.fillStyle = 'rgba(95,208,223,.16)'; g.fillRect(padL, padT + ph - 3, pw * f, 3);
    renderDockClock(); return msg(`Computing visibility… ${Math.round(f * 100)}%`);
  }
  const c = w.counts, top = Math.max(1, w.max) * 1.15, Y = v => padT + ph - v / top * ph;
  // gaps (no satellite above the limit)
  g.fillStyle = 'rgba(255,116,134,.16)'; for (const gp of w.gaps) g.fillRect(X(gp.t0), padT, Math.max(1, X(gp.t1) - X(gp.t0)), ph);
  // count area
  const grad = g.createLinearGradient(0, padT, 0, padT + ph); grad.addColorStop(0, 'rgba(95,208,223,.38)'); grad.addColorStop(1, 'rgba(95,208,223,.02)');
  g.beginPath(); g.moveTo(X(w.t0), Y(0));
  for (let s = 0; s < w.S; s++) { const x = X(w.t0 + s * w.step); g.lineTo(x, Y(c[s])); if (s < w.S - 1) g.lineTo(X(w.t0 + (s + 1) * w.step), Y(c[s])); }
  g.lineTo(X(w.end), Y(0)); g.closePath(); g.fillStyle = grad; g.fill();
  g.beginPath(); for (let s = 0; s < w.S; s++) { const x0 = X(w.t0 + s * w.step), x1 = X(w.t0 + Math.min(s + 1, w.S - 1) * w.step); if (!s) g.moveTo(x0, Y(c[s])); else g.lineTo(x0, Y(c[s])); g.lineTo(x1, Y(c[s])); }
  g.strokeStyle = 'rgba(142,227,238,.9)'; g.lineWidth = 1.25; g.stroke();
  // axis: max count and hour ticks
  g.fillStyle = '#637186'; g.textAlign = 'right'; g.fillText(fmtN(w.max), padL - 6, Y(w.max)); g.fillText('0', padL - 6, Y(0));
  g.strokeStyle = 'rgba(160,200,230,.12)'; g.beginPath(); g.moveTo(padL, Y(w.max) + 0.5); g.lineTo(padL + pw, Y(w.max) + 0.5); g.stroke();
  const hourStep = Math.max(1, Math.ceil(64 / (pw / w.hours))); g.textAlign = 'center';   // labels at least 64 px apart
  for (let t = Math.ceil(w.t0 / 3600e3) * 3600e3; t <= w.end; t += 3600e3) {
    const hr = new Date(t).getHours(); if (hr % hourStep) continue;
    const x = X(t); g.strokeStyle = 'rgba(160,200,230,.1)'; g.beginPath(); g.moveTo(x + 0.5, padT); g.lineTo(x + 0.5, padT + ph); g.stroke();
    if (x > padL + 14 && x < W - 18) { g.fillStyle = '#637186'; g.fillText(hhmm(t), x, H - 7); }
  }
  // the real current time
  const now = Date.now();
  if (now >= w.t0 && now <= w.end) { const x = X(now); g.setLineDash([2, 3]); g.strokeStyle = 'rgba(231,238,246,.5)'; g.beginPath(); g.moveTo(x + 0.5, padT); g.lineTo(x + 0.5, padT + ph); g.stroke(); g.setLineDash([]); g.fillStyle = 'rgba(231,238,246,.65)'; g.textAlign = 'left'; g.fillText('now', x + 4, padT + 7); }
  // hover and cursor
  if (scope.hoverT != null) { const x = X(scope.hoverT); g.strokeStyle = 'rgba(231,238,246,.25)'; g.beginPath(); g.moveTo(x + 0.5, padT); g.lineTo(x + 0.5, padT + ph); g.stroke(); }
  if (inWindow(simMs)) {
    const x = X(clamp(simMs, w.t0, w.end)), s = clamp(Math.floor((simMs - w.t0) / w.step), 0, w.S - 1);
    g.strokeStyle = '#f0b35e'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, padT - 2); g.lineTo(x, padT + ph); g.stroke();
    g.fillStyle = '#f0b35e'; g.beginPath(); g.arc(x, Y(c[s]), 3.5, 0, TAU); g.fill();
    g.beginPath(); g.moveTo(x - 5, padT - 4); g.lineTo(x + 5, padT - 4); g.lineTo(x, padT + 2); g.closePath(); g.fill();
  }
  renderDockClock();
}
function dockTimeAt(clientX) { const w = scope.win, G = dockGeom(), r = G.cv.getBoundingClientRect(); return clamp(w.t0 + (clientX - r.left - G.padL) / (G.W - G.padL - G.padR) * (w.end - w.t0), w.t0, w.end); }
let scrubReq = 0;
function setSimTime(t) {
  simMs = t; if (scrubReq) return;
  scrubReq = requestAnimationFrame(() => { scrubReq = 0; if (N) refreshAll(simMs); scopeTimeChanged(); if (sel >= 0) orbitT = 0; });
}

// ── controls
function scopeSearch() {
  const raw = $('scQ').value.trim(), box = $('scRes');
  if (!raw) { box.hidden = true; $('scQ').setAttribute('aria-expanded', 'false'); return; }
  const items = [], m = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])?\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])?\s*$/);
  if (m) {
    let lat = +m[1], lon = +m[3]; if (m[2] && /s/i.test(m[2])) lat = -Math.abs(lat); if (m[4] && /w/i.test(m[4])) lon = -Math.abs(lon);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) items.push({ name: 'Coordinates', label: `${fmtLat(lat)}, ${fmtLon(lon)}`, lat, lon });
  }
  const q = fold(raw);
  const hits = CITIES.map(c => ({ c, k: c.key.indexOf(q) })).filter(h => h.k >= 0).sort((a, b) => (a.k ? 1 : 0) - (b.k ? 1 : 0) || a.c.name.length - b.c.name.length).slice(0, 7);
  for (const h of hits) items.push({ name: `${h.c.name}, ${h.c.country}`, label: `${fmtLat(h.c.lat)}, ${fmtLon(h.c.lon)}`, lat: h.c.lat, lon: h.c.lon });
  scope.qItems = items; scope.qSel = items.length ? 0 : -1;
  box.innerHTML = items.length ? items.map((it, k) => `<li role="option" id="sco${k}" aria-selected="${k === 0}" data-k="${k}"><span>${esc(it.name)}</span><small>${it.label}</small></li>`).join('')
    : `<li class="empty" role="option" aria-disabled="true">No built-in place matches "${esc(raw)}". Type coordinates such as 47.61, -122.33, or click the globe.</li>`;
  box.hidden = false; $('scQ').setAttribute('aria-expanded', 'true');
}
function scopePick(k) {
  const it = (scope.qItems || [])[k]; if (!it) return;
  $('scRes').hidden = true; $('scQ').value = ''; $('scQ').setAttribute('aria-expanded', 'false');
  setLocation(it.lat, it.lon, it.name === 'Coordinates' ? null : it.name);
}
function wireScope() {
  $('scQuick').innerHTML = QUICK.map(n => { const c = CITIES.find(c => c.name === n); return `<button class="btn sm" data-city="${esc(n)}" title="${fmtLat(c.lat)}, ${fmtLon(c.lon)}">${esc(n)}</button>`; }).join('');
  $('scQuick').onclick = e => { const b = e.target.closest('[data-city]'); if (!b) return; const c = CITIES.find(c => c.name === b.dataset.city); setLocation(c.lat, c.lon, `${c.name}${c.country === 'open ocean' ? ' (open ocean)' : ', ' + c.country}`); };
  $('scQ').addEventListener('input', scopeSearch);
  $('scQ').addEventListener('keydown', e => {
    const it = scope.qItems || [];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!it.length) return; scope.qSel = (scope.qSel + (e.key === 'ArrowDown' ? 1 : it.length - 1)) % it.length; [...$('scRes').children].forEach((li, k) => li.setAttribute('aria-selected', k === scope.qSel)); $('scQ').setAttribute('aria-activedescendant', 'sco' + scope.qSel); }
    else if (e.key === 'Enter') { e.preventDefault(); if (scope.qSel >= 0) scopePick(scope.qSel); }
    else if (e.key === 'Escape') { $('scRes').hidden = true; }
  });
  $('scRes').onclick = e => { const li = e.target.closest('li[data-k]'); if (li) scopePick(+li.dataset.k); };
  document.addEventListener('click', e => { if (!e.target.closest('.loc-search')) $('scRes').hidden = true; });
  $('scEl').oninput = () => { scope.el = +$('scEl').value; $('scElOut').textContent = scope.el + '°'; buildDome(); scopeDerive(); scopeTick(); renderScope(); drawDock(); };
  $('p-scope').addEventListener('click', e => {
    const b = e.target.closest('[data-sj]'); if (b) { select(+b.dataset.sj); renderScope(); return; }
    const c = e.target.closest('[data-cons]'); if (c) { scope.consOn[c.dataset.cons] = !scope.consOn[c.dataset.cons]; scopeRefAlt(); buildDome(); scopeDerive(); scopeTick(); renderScope(); drawDock(); return; }
    if (e.target.closest('#scCentre')) { if (obs) scopeAimNow(); return; }
    if (e.target.closest('#scSrc')) go('data', 'sources');
  });
  $('dkPlay').onclick = () => {
    if (speed > 0) return setSpeed(0);
    const w = scope.win; if (w && w.done && simMs >= w.end - 1000) setSimTime(w.t0);
    setSpeed(playSpeed);
  };
  $('dkSpd').onclick = e => { const b = e.target.closest('[data-ds]'); if (!b) return; playSpeed = +b.dataset.ds; setSpeed(playSpeed); };
  $('dkNow').onclick = () => { jumpNow(); setSpeed(1); if (obs && !inWindow(simMs)) scopeCompute(simMs); };
  $('dkRange').onchange = () => { if (obs) scopeCompute(scope.win ? scope.win.t0 : simMs); };
  $('dkRecalc').onclick = () => scopeCompute(simMs);
  const tr = $('dkTrack');
  const ok = () => scope.win && scope.win.done;
  tr.addEventListener('pointerdown', e => { if (!ok()) return; tr.setPointerCapture(e.pointerId); scope.scrubbing = true; setSpeed(0); setSimTime(dockTimeAt(e.clientX)); });
  tr.addEventListener('pointermove', e => {
    if (!ok()) return; const t = dockTimeAt(e.clientX), w = scope.win;
    if (scope.scrubbing) setSimTime(t);
    scope.hoverT = t; const s = clamp(Math.floor((t - w.t0) / w.step), 0, w.S - 1), hv = $('dkHover');
    hv.hidden = false; hv.textContent = `${hhmm(t)} · ${w.counts[s]} visible`; hv.style.left = clamp(e.clientX - tr.getBoundingClientRect().left, 40, tr.clientWidth - 40) + 'px';
    if (!scope.scrubbing) drawDock();
  });
  const end = () => { scope.scrubbing = false; };
  tr.addEventListener('pointerup', end); tr.addEventListener('pointercancel', end);
  tr.addEventListener('pointerleave', () => { scope.hoverT = null; $('dkHover').hidden = true; drawDock(); });
  tr.addEventListener('keydown', e => {
    if (!ok()) return; const w = scope.win, k = e.key;
    const d = k === 'ArrowRight' ? w.step : k === 'ArrowLeft' ? -w.step : k === 'PageUp' ? 30 * 60e3 : k === 'PageDown' ? -30 * 60e3 : 0;
    if (d || k === 'Home' || k === 'End') { e.preventDefault(); setSpeed(0); setSimTime(k === 'Home' ? w.t0 : k === 'End' ? w.end : clamp(simMs + d, w.t0, w.end)); }
    else if (k === ' ') { e.preventDefault(); $('dkPlay').click(); }
  });
  renderDockControls();
}

// ───────────────────────── New York reference clock: real time, once a second, independent of the simulation clock
let nyTimer = 0;
const show0 = off => Math.abs(off) >= 1000 && !(speed === 1 && Math.abs(off) < 5000);
function tickNy() {
  const now = Date.now(), c = nyClock(now), off = simMs - now;
  $('nyT').textContent = c.time; $('nyZ').textContent = c.abbr; $('nyD').textContent = c.date;
  $('dkNyT').textContent = `${c.time} ${c.abbr}${show0(off) ? ' · SIM ' + fmtSimOffset(off) : ''}`;
  const show = show0(off); $('simOff').hidden = !show; if (show) $('simOffT').textContent = fmtSimOffset(off);
}
function startNy() { if (!nyTimer) { tickNy(); nyTimer = setInterval(tickNy, 1000); } }
function stopNy() { clearInterval(nyTimer); nyTimer = 0; }
document.addEventListener('visibilitychange', () => document.hidden ? stopNy() : startNy());
addEventListener('pagehide', stopNy);
addEventListener('pageshow', startNy);

// ───────────────────────── wire up UI
function wire() {
  $('rpClose').onclick = endReplay;
  $('rpRange').oninput = e => { setSpeed(0); setSimTime(+e.target.value); replayTick(); };
  $('rpPlay').onclick = () => { if (!replay) return; setSimTime(replay.pass.t0 - 60e3); setSpeed(10); replayTick(true); };
  $('rpPause').onclick = () => setSpeed(0);
  $('over').addEventListener('click', e => { if (e.target.closest('#abMore')) { aboveShowAll = !aboveShowAll; renderAbove(); } });
  $('abN2yo').onclick = crossCheckN2yo;
  $('p-simulations').addEventListener('click', e => {
    const b = e.target.closest('[data-evgroup]'); if (!b) return;
    const g = b.dataset.evgroup, first = objs.slice(0, N).findIndex(o => o.groups.includes(g));
    if (first < 0) return toast('These fragments are not in the loaded data.');
    if (pov) exitPov();
    setBand(-1); for (const t of TYPE_KEYS) typeOn[t] = t === 'debris'; computeVisibility(); renderLayers();
    select(first); openTab('obj'); dist = fitDist() * 1.1; toast(`Showing debris only. ${fmtN(objs.slice(0, N).filter(o => o.groups.includes(g)).length)} fragments from this event are in the data. Reset shows everything again.`);
  });
  $('issPass').onclick = e => { const b = e.target.closest('[data-replay-iss]'); if (b && issCache && featured.iss != null) startReplay(featured.iss, issCache.list[+b.dataset.replayIss]); };
  renderSpeeds();
  $('spd').onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.now !== undefined) { jumpNow(); toast('Jumped to the current time.'); return; } setSpeed(+b.dataset.s); if (+b.dataset.s === 1 && Math.abs(simMs - Date.now()) > 5000) jumpNow(); };
  $('subnav').onclick = e => { const b = e.target.closest('[data-view]'); if (b) go(nav.sec, b.dataset.view); };
  $('subnav').onkeydown = e => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return; const subs = SECTIONS[nav.sec].subs; if (!subs) return;
    const k = subs.findIndex(x => x[0] === nav.view), n = subs[(k + (e.key === 'ArrowRight' ? 1 : subs.length - 1)) % subs.length][0];
    go(nav.sec, n); $('sv-' + n).focus();
  };
  $('bPanel').onclick = () => setPanel(!nav.panel);
  $('bPanel2').onclick = () => setPanel(true);
  $('inspX').onclick = () => deselect();
  $('povIss').onclick = () => enterPov(featured.iss);
  $('povSel').onclick = () => enterPov(sel);
  addEventListener('hashchange', fromHash); addEventListener('popstate', fromHash);
  document.addEventListener('click', e => {
    const j = e.target.closest('[data-j]'); if (j && !j.closest('#qres')) { select(+j.dataset.j); openTab('obj'); if (j.closest('#intro')) { closeOverlay('intro'); flyTo(+j.dataset.j); } else if (j.closest('#sugg')) flyTo(+j.dataset.j); }
    const tl = e.target.closest('[data-tab]'); if (tl) { e.preventDefault(); openTab(tl.dataset.tab); }
    const c = e.target.closest('[data-close]'); if (c) closeOverlay(c.closest('.overlay').id);
    if (!e.target.closest('.search')) $('qres').hidden = true;
  });
  document.querySelectorAll('.overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) closeOverlay(o.id); }));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { const o = [...document.querySelectorAll('.overlay')].find(o => !o.hidden); if (!$('dpop').hidden) { closeDataPop(); $('badge').focus(); } else if (o) closeOverlay(o.id); else if (pov) exitPov(); else if (!$('tour').hidden) endTour(); else if (nav.insp && !e.target.closest('input,select,textarea')) deselect(); return; }
    // P toggles Orbital POV for the selected object; 1, 2 and 3 pick its view. Not while typing or with a dialog open.
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input,textarea,select,[contenteditable]') || document.querySelector('.overlay:not([hidden])')) return;
    if (e.key === 'p' || e.key === 'P') { e.preventDefault(); if (pov) exitPov(); else enterPov(sel); }
    else if (e.key === '/') { e.preventDefault(); $('q').focus(); }
    else if (pov && ['1', '2', '3'].includes(e.key)) setPovMode(['horizon', 'nadir', 'free'][+e.key - 1]);
  });
  for (const b of document.querySelectorAll('[data-povm]')) b.onclick = () => setPovMode(b.dataset.povm);
  $('povZin').onclick = () => povZoom(0.85); $('povZout').onclick = () => povZoom(1 / 0.85); $('povExit').onclick = () => exitPov();
  $('types').onchange = e => { const t = e.target.dataset.t; if (t) { typeOn[t] = e.target.checked; computeVisibility(); } };
  $('regimes').onchange = e => { const r = e.target.dataset.r; if (r) { regOn[r] = e.target.checked; computeVisibility(); } };
  $('bandClear').onclick = () => setBand(-1);
  $('filtClear').onclick = () => { for (const t of TYPE_KEYS) typeOn[t] = true; for (const k in regOn) regOn[k] = true; band = null; $('bandChip').style.display = 'none'; computeVisibility(); renderLayers(); drawHist(); };
  $('q').addEventListener('input', runSearch);
  $('q').addEventListener('focus', () => { if ($('q').value.trim()) runSearch(); });
  $('q').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!qItems.length) return; qSel = (qSel + (e.key === 'ArrowDown' ? 1 : qItems.length - 1)) % qItems.length; [...$('qres').children].forEach((li, k) => li.setAttribute('aria-selected', k === qSel)); $('q').setAttribute('aria-activedescendant', 'qo' + qSel); }
    else if (e.key === 'Enter') { e.preventDefault(); if (qSel >= 0) { const o = qItems[qSel]; pickSearch(qSel); if (e.shiftKey && o) enterPov(o.i); } }
    else if (e.key === 'Escape') { $('qres').hidden = true; }
  });
  $('qres').onclick = e => { const pb = e.target.closest('[data-pov]'); if (pb) { const j = +pb.dataset.pov; pickSearch(qItems.findIndex(o => o.i === j)); return enterPov(j); } const li = e.target.closest('li[data-j]'); if (li) pickSearch(qItems.findIndex(o => o.i === +li.dataset.j)); };
  $('bTour').onclick = () => { closeOverlay('intro'); tourGo(0); };
  $('iTour').onclick = () => { closeOverlay('intro'); tourGo(0); };
  $('iClose').onclick = () => closeOverlay('intro');
  $('tNext').onclick = () => tourStep(1); $('tPrev').onclick = () => tourStep(-1); $('tEnd').onclick = endTour;
  $('bMethod').onclick = () => go('learn', 'l-src');
  $('badge').onclick = e => { e.stopPropagation(); if ($('dpop').hidden) openDataPop(); else closeDataPop(); };
  document.addEventListener('pointerdown', e => { if (!e.target.closest('#dpop,#badge')) closeDataPop(); });
  $('bReset').onclick = () => { resetView(); toast('View reset.'); };
  $('bRefresh').onclick = () => loadData({ force: true });
  $('bDemo').onclick = () => loadData({ demo: data.mode !== 'demo' });
  $('bSkip').onclick = () => loadData({ demo: true });
  $('bBoom').onclick = boom; $('bBoomClear').onclick = () => clearSim(false);
  $('hlOn').onchange = () => {};
  $('cloudOn').onchange = e => { if (clouds) clouds.visible = e.target.checked; };
  $('geo').onclick = () => {
    if (!navigator.geolocation) return toast('Location is not available here. Click the globe instead.');
    navigator.geolocation.getCurrentPosition(p => setObserver(p.coords.latitude, p.coords.longitude, 'From your device'), () => toast('Location was blocked. Click the globe to set it instead.', 4500), { timeout: 8000 });
  };
  const hc = $('hist');
  hc.addEventListener('pointermove', e => { if (!hist) return; const i = histBin(e); if (i !== hist.hover) { hist.hover = i; drawHist(); if (i >= 0) histInfo(i); } });
  hc.addEventListener('pointerleave', () => { if (hist) { hist.hover = -1; drawHist(); } });
  hc.addEventListener('click', e => { const i = histBin(e); if (i >= 0) setBand(i); });
  hc.addEventListener('keydown', e => { if (!hist) return; if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); hist.focus = clamp((hist.focus < 0 ? 9 : hist.focus) + (e.key === 'ArrowRight' ? 1 : -1), 0, hist.B - 1); drawHist(); histInfo(hist.focus); } else if (e.key === 'Enter' && hist.focus >= 0) setBand(hist.focus); });
  addEventListener('resize', () => { layout(); drawHist(); });
  $('iScope').onclick = () => { closeOverlay('intro'); go('signalscope'); };
  wireScope();
}

// ───────────────────────── boot
runSelfTest();
initScene();
wire();
layout(); dist = fitDist(); snapView(); view.dist = dist * 2.4; view.az = az - 0.9; if (reduceMotion) snapView();   // a slow fly-in on first load
if (!fromHash()) go('explore', null, { replace: true, boot: true });
if (isPhone() && nav.sec === 'explore') setPanel(false);   // phones open on the globe; the Explore sheet waits as a title bar
if (glOK) initInput();
requestAnimationFrame(t => { lastFrame = t; requestAnimationFrame(frame); });
startNy();
loadData();
loadExtras();
