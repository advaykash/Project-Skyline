// Tests for worker/api.mjs (the Cloudflare Worker API) with an in-memory KV and a stand-in for CelesTrak. Run: npm test.
// The stand-in serves made-up TEST records; nothing here is real orbital data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, refreshDue, GROUPS, CSP, parseKp, parseCloud, _resetMemory } from '../worker/api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── in-memory stand-in for a KV namespace (the parts of the API the Worker uses)
function memKV() {
  const m = new Map(); let writes = 0;
  const bytes = v => (typeof v === 'string' ? new TextEncoder().encode(v) : new Uint8Array(v instanceof ArrayBuffer ? v : v.buffer));
  return {
    m, get writes() { return writes; },
    async get(k, type) { const e = m.get(k); if (!e) return null; const t = new TextDecoder().decode(e.v); return type === 'json' ? JSON.parse(t) : t; },
    async getWithMetadata(k, opt) {
      const e = m.get(k); if (!e) return { value: null, metadata: null };
      if (opt && opt.type === 'stream') { const b = e.v; return { value: new ReadableStream({ start(c) { for (let i = 0; i < b.length; i += 7000) c.enqueue(b.slice(i, i + 7000)); c.close(); } }), metadata: e.meta }; }
      return { value: new TextDecoder().decode(e.v), metadata: e.meta };
    },
    async put(k, v, opt = {}) { writes++; m.set(k, { v: bytes(v), meta: opt.metadata || null }); },
  };
}

// ── stand-in for celestrak.org/NORAD/elements/gp.php
const rec = (name, id) => ({ OBJECT_NAME: name, OBJECT_ID: '1998-067A', EPOCH: new Date(Date.now() - 3600e3).toISOString().replace('Z', ''), MEAN_MOTION: 15.5, ECCENTRICITY: 0.0005,
  INCLINATION: 51.64, RA_OF_ASC_NODE: 120, ARG_OF_PERICENTER: 80, MEAN_ANOMALY: 10, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: id, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1, BSTAR: 0.0002, MEAN_MOTION_DOT: 0.0001, MEAN_MOTION_DDOT: 0 });
function upstream(mode = 'ok', opts = {}) {
  const hits = [], other = [];
  const f = async (url, init) => {
    if (!/GROUP=/.test(url)) { other.push(url); return opts.other ? opts.other(url, init) : new Response(JSON.stringify([{ time_tag: '2026-10-11T09:00:00', Kp: 2.33 }]), { status: 200 }); }   // NOAA Kp, Open-Meteo, N2YO
    const g = new URL(url).searchParams.get('GROUP'); hits.push(g);
    const m = typeof mode === 'function' ? mode(g) : mode;
    // AbortSignal.timeout() does not keep Node running, so hold the event loop open until the Worker gives up
    if (m === 'hang') return new Promise((_, rej) => { const keep = setTimeout(() => { }, 10e3); init.signal.addEventListener('abort', () => { clearTimeout(keep); rej(init.signal.reason); }); });
    if (m === 'down') throw new TypeError('fetch failed');
    if (m === '403') return new Response(`GP data has not updated since your last successful download of GROUP=${g}`, { status: 403 });
    if (m === '403-block') return new Response('Access denied', { status: 403 });
    if (m === '500') return new Response('oops', { status: 500 });
    if (m === 'html') return new Response('<html>maintenance</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (m === 'empty') return new Response('[]', { status: 200 });
    if (m === 'invalid') return new Response(JSON.stringify([{ OBJECT_NAME: 'BAD', NORAD_CAT_ID: 1, EPOCH: 'nope', MEAN_MOTION: 1 }]), { status: 200 });
    if (m === 'big') return new Response(JSON.stringify(Array.from({ length: opts.n || 4000 }, (_, i) => rec('TEST BIG ' + i, 70000 + i))), { status: 200 });
    return new Response(JSON.stringify([rec('TEST STATION A', 25544), rec('TEST STATION B', 48274), { OBJECT_NAME: 'BROKEN', NORAD_CAT_ID: 9 }]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  f.hits = hits; f.other = other; return f;
}
const clock = (t = Date.parse('2026-10-11T12:00:00Z')) => { const c = () => c.t; c.t = t; return c; };
const env0 = (extra = {}) => ({ SKYLINE_KV: memKV(), TIMEOUT_MS: '200', ...extra });
const quiet = { log: () => { } };
async function get(env, p, now, headers = {}, method = 'GET') {
  const r = await handle(new Request('https://skyline.example' + p, { method, headers }), env, { now });
  const text = method === 'HEAD' || r.status === 304 ? '' : await r.text(); let json = null; try { json = JSON.parse(text); } catch { }
  return { r, text, json };
}

test('the Cron run downloads every group once and requests are served from KV without contacting CelesTrak', async () => {
  const env = env0(), now = clock(), up = upstream();
  const run = await refreshDue(env, { fetch: up, now, ...quiet });
  assert.deepEqual(up.hits, GROUPS);
  assert.ok(run.done.every(d => d.ok));
  const a = await get(env, '/api/gp?group=stations', now);
  assert.equal(a.r.status, 200);
  assert.equal(a.json.group, 'stations'); assert.equal(a.json.format, 'omm');
  assert.equal(a.json.records.length, 3, 'records are passed through verbatim (the browser validates them)');
  assert.equal(a.json.records[0].NORAD_CAT_ID, 25544);
  assert.equal(a.json.count, 2, 'small groups are validated: the BROKEN record is not counted');
  assert.equal(a.json.stale, false); assert.equal(a.json.lastError, null); assert.equal(a.json.fetchedAt, now.t);
  assert.equal(a.r.headers.get('x-content-type-options'), 'nosniff');
  const c = await get(env, '/api/gp?group=stations', now, { 'If-None-Match': a.r.headers.get('etag') });
  assert.equal(c.r.status, 304);
  // a second Cron run inside the 2-hour window does nothing and writes nothing
  const writes = env.SKYLINE_KV.writes; now.t += 30 * 60e3;
  const run2 = await refreshDue(env, { fetch: up, now, ...quiet });
  assert.equal(run2.done.length, 0); assert.equal(up.hits.length, GROUPS.length); assert.equal(env.SKYLINE_KV.writes, writes);
  // after 2 hours it downloads again
  now.t += 95 * 60e3; await refreshDue(env, { fetch: up, now, ...quiet });
  assert.equal(up.hits.length, GROUPS.length * 2);
});

test('large groups are stored without JSON.parse, and the response streams them back intact', async () => {
  const env = env0(), now = clock(), up = upstream(g => (g === 'active' ? 'big' : 'ok'), { n: 4000 });
  const realParse = JSON.parse; let parsedBig = false;
  JSON.parse = function (t, ...r) { if (typeof t === 'string' && t.length > 512 * 1024) parsedBig = true; return realParse.call(this, t, ...r); };
  try { await refreshDue(env, { fetch: up, now, ...quiet }); } finally { JSON.parse = realParse; }
  assert.equal(parsedBig, false, 'the Worker must not parse a large group (10 ms CPU limit)');
  const a = await get(env, '/api/gp?group=active', now);
  assert.equal(a.r.status, 200); assert.equal(a.json.count, null); assert.ok(a.json.bytes > 512 * 1024);
  assert.equal(a.json.records.length, 4000); assert.equal(a.json.records[3999].OBJECT_NAME, 'TEST BIG 3999');
});

test('rejects unknown groups, unknown paths and other methods without contacting CelesTrak', async () => {
  const env = env0(), now = clock();
  for (const q of ['?group=cosmos-1408-debris', '?group=../../etc', '']) {
    const r = await get(env, '/api/gp' + q, now); assert.equal(r.r.status, 400); assert.match(r.json.error, /Unknown group/);
  }
  assert.equal((await get(env, '/api/nope', now)).r.status, 404);
  assert.equal((await get(env, '/api/gp?group=stations', now, {}, 'POST')).r.status, 405);
});

test('with no data yet, /api/gp answers 503 with a reason and Retry-After', async () => {
  const env = env0(), now = clock();
  const a = await get(env, '/api/gp?group=active', now);
  assert.equal(a.r.status, 503); assert.match(a.json.error, /No data has been downloaded yet/); assert.ok(+a.r.headers.get('retry-after') >= 60);
  await refreshDue(env, { fetch: upstream('403-block'), now, ...quiet });
  const b = await get(env, '/api/gp?group=active', now);
  assert.equal(b.r.status, 503); assert.match(b.json.error, /refused the request \(HTTP 403\)|Not asking CelesTrak/);
});

test('an HTTP error pauses every group, but a "not updated" refusal affects only its group', async () => {
  const env = env0(), now = clock();
  const up = upstream('500'); await refreshDue(env, { fetch: up, now, ...quiet });
  assert.deepEqual(up.hits, ['stations'], 'stop at the first error, as CelesTrak asks');
  now.t += 10 * 60e3; const up2 = upstream(); await refreshDue(env, { fetch: up2, now, ...quiet });
  assert.deepEqual(up2.hits, [], 'no requests during the 30-minute pause');
  const h = await get(env, '/api/health', now);
  assert.match(h.json.groups.stations.lastError, /HTTP 500/);
  const env2 = env0(), up3 = upstream('403'); await refreshDue(env2, { fetch: up3, now, ...quiet });
  assert.deepEqual(up3.hits, GROUPS, '"not updated" concerns only that group');
  const env3 = env0(), up4 = upstream('down'); await refreshDue(env3, { fetch: up4, now, ...quiet });
  assert.deepEqual(up4.hits, ['stations']);
});

test('timeouts, HTML, empty and invalid replies are errors that never replace the last good copy', async () => {
  const env = env0({ REFRESH_MS: '0', RETRY_MS: '0', STALE_MS: '0' }), now = clock();
  await refreshDue(env, { fetch: upstream(), now, ...quiet });
  const good = await get(env, '/api/gp?group=stations', now);
  for (const [mode, re] of [['hang', /did not answer within 0.2 s/], ['html', /not JSON/], ['empty', /no objects/], ['invalid', /None of the 1 records/], ['500', /HTTP 500/], ['403', /HTTP 403/]]) {
    now.t += 1000;
    await refreshDue(env, { fetch: upstream(g => (g === 'stations' ? mode : 'ok')), now, ...quiet });
    const r = await get(env, '/api/gp?group=stations', now);
    assert.equal(r.r.status, 200, mode);
    assert.equal(r.json.fetchedAt, good.json.fetchedAt, `${mode}: the stored copy must be kept`);
    assert.equal(r.json.records.length, 3);
    assert.equal(r.json.stale, true);
    assert.match(r.json.lastError, re, mode);
  }
});

test('/api/health reports every group from one KV read', async () => {
  const env = env0(), now = clock();
  const before = await get(env, '/api/health', now);
  assert.equal(before.json.ok, true); assert.equal(before.json.runtime, 'cloudflare-workers');
  assert.equal(before.json.groups.active.nextAttemptAt, 'at the next scheduled run');
  await refreshDue(env, { fetch: upstream(), now, ...quiet });
  const after = await get(env, '/api/health', now);
  assert.equal(after.json.groups.stations.count, 2); assert.equal(after.json.groups.stations.fetchedAt, new Date(now.t).toISOString());
});

test('UPSTREAM_DISABLED stops all downloads', async () => {
  const env = env0({ UPSTREAM_DISABLED: 'true' }), up = upstream();
  const r = await refreshDue(env, { fetch: up, now: clock(), ...quiet });
  assert.equal(up.hits.length, 0); assert.match(r.skipped, /UPSTREAM_DISABLED/);
});

test('static files keep the same CSP and security headers through public/_headers', () => {
  const h = fs.readFileSync(path.join(ROOT, 'public', '_headers'), 'utf8');
  assert.ok(h.includes(`Content-Security-Policy: ${CSP}`), 'the page CSP in _headers must match the Worker');
  assert.match(CSP, /connect-src 'self'/);
  assert.match(h, /X-Content-Type-Options: nosniff/);
  const cfg = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
  assert.match(cfg, /"run_worker_first":\s*\[\s*"\/api\/\*"\s*\]/);
  assert.match(cfg, /"binding":\s*"SKYLINE_KV"/);
  assert.match(cfg, /"crons":\s*\[\s*"\*\/30 \* \* \* \*"\s*\]/);
});

// ── extras: NOAA Kp, Open-Meteo cloud cover, optional N2YO cross-check (stand-ins only; nothing here is real data)
const withFetch = (fn) => { const calls = []; const f = async (url, init) => { calls.push(url); return fn(url, init); }; f.calls = calls; return f; };
async function call(env, p, now, fetchFn) {
  const r = await handle(new Request('https://skyline.example' + p), env, { now, fetch: fetchFn });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { }
  return { r, text, json };
}

test('Kp: both NOAA feed layouts parse; bad rows are skipped; values outside 0–9 are rejected', () => {
  const rows = parseKp(JSON.stringify([['time_tag', 'Kp', 'a_running', 'station_count'], ['2026-10-11 06:00:00.000', '1.67', '6', '8'], ['2026-10-11 09:00:00.000', '12', '1', '1'], ['bad', 'x']]));
  assert.deepEqual(rows, [{ time: '2026-10-11T06:00:00.000Z', kp: 1.67 }]);
  const objs = parseKp(JSON.stringify([{ time_tag: '2026-10-11T09:00:00', Kp: 2.33 }, { time_tag: '2026-10-11T06:00:00', Kp: null }]));
  assert.deepEqual(objs, [{ time: '2026-10-11T09:00:00.000Z', kp: 2.33 }]);
  assert.equal(parseKp('<html>'), null); assert.equal(parseKp('[]'), null);
});

test('Kp: the Cron run stores it at most hourly, a failure keeps the last good values, and /api/kp says where it came from', async () => {
  const env = env0(), now = clock();
  assert.equal((await call(env, '/api/kp', now)).r.status, 503, 'nothing stored yet');
  let mode = 'ok';
  const up = upstream('ok', { other: () => mode === 'ok' ? new Response(JSON.stringify([['time_tag', 'Kp'], ['2026-10-11 09:00:00.000', '3.00']]), { status: 200 }) : new Response('down', { status: 500 }) });
  await refreshDue(env, { fetch: up, now, ...quiet });
  let k = await call(env, '/api/kp', now);
  assert.equal(k.r.status, 200); assert.equal(k.json.source, 'noaa-swpc'); assert.deepEqual(k.json.samples, [{ time: '2026-10-11T09:00:00.000Z', kp: 3 }]); assert.equal(k.json.stale, false);
  const n = up.other.length; now.t += 30 * 60e3; await refreshDue(env, { fetch: up, now, ...quiet });
  assert.equal(up.other.length, n, 'not asked again within the hour');
  mode = 'down'; now.t += 31 * 60e3; await refreshDue(env, { fetch: up, now, ...quiet });
  k = await call(env, '/api/kp', now);
  assert.equal(k.r.status, 200); assert.equal(k.json.samples[0].kp, 3, 'last good values kept'); assert.match(k.json.lastError, /HTTP 500/);
  now.t += 7 * 3600e3; assert.equal((await call(env, '/api/kp', now)).json.stale, true);
});

test('cloud cover: location is rounded to 0.25°, answers are reused for 30 minutes, failures are honest 502s', async () => {
  _resetMemory();
  const env = env0(), now = clock();
  const ok = withFetch(() => new Response(JSON.stringify({ hourly: { time: ['2026-10-11T12:00', '2026-10-11T13:00'], cloud_cover: [35, 120] } }), { status: 200 }));
  assert.equal((await call(env, '/api/weather?lat=95&lon=0', now, ok)).r.status, 400);
  assert.equal((await call(env, '/api/weather?lon=0', now, ok)).r.status, 400);
  let w = await call(env, '/api/weather?lat=40.357&lon=-74.667', now, ok);
  assert.equal(w.r.status, 200); assert.match(ok.calls[0], /latitude=40\.25&longitude=-74\.75&hourly=cloud_cover/);
  assert.deepEqual(w.json.hourly, [{ time: '2026-10-11T12:00:00.000Z', cloudCoverPercent: 35 }, { time: '2026-10-11T13:00:00.000Z', cloudCoverPercent: 100 }]);
  assert.equal(w.json.source, 'open-meteo'); assert.equal(w.json.kind, 'forecast');
  w = await call(env, '/api/weather?lat=40.3&lon=-74.7', now, ok);
  assert.equal(ok.calls.length, 1, 'same 0.25° cell: reused'); assert.equal(w.json.servedFromCache, true);
  now.t += 31 * 60e3; await call(env, '/api/weather?lat=40.3&lon=-74.7', now, ok); assert.equal(ok.calls.length, 2, 'refreshed after 30 minutes');
  const bad = withFetch(() => new Response('oops', { status: 500 }));
  w = await call(env, '/api/weather?lat=10&lon=10', now, bad); assert.equal(w.r.status, 502); assert.ok(!('hourly' in w.json), 'no made-up forecast');
  assert.equal(parseCloud('{"hourly":{}}'), null);
});

test('N2YO cross-check: off without the secret; the key never appears in any response; cached, rounded and budgeted', async () => {
  _resetMemory();
  const KEY = 'TEST-KEY-1234567890';
  assert.equal((await call(env0(), '/api/above?lat=40&lon=-74', clock())).r.status, 404, 'no key: not configured');
  let health = await call(env0({ N2YO_API_KEY: KEY }), '/api/health', clock());
  assert.equal(health.json.n2yo.configured, true); assert.ok(!health.text.includes(KEY));
  const env = env0({ N2YO_API_KEY: KEY }), now = clock(); let tx = 10;
  const n2yo = withFetch(url => new Response(JSON.stringify({ info: { category: 'ANY', transactionscount: tx++, satcount: 2 }, above: [
    { satid: 25544, satname: 'ISS (ZARYA)', intDesignator: '1998-067A', launchDate: '1998-11-20', satlat: 41, satlng: -73, satalt: 420 },
    { satid: 'x' }] }), { status: 200 }));
  let a = await call(env, '/api/above?lat=40.357&lon=-74.667', now, n2yo);
  assert.equal(a.r.status, 200); assert.match(n2yo.calls[0], /\/above\/40\/-75\/0\/90\/0\/&apiKey=TEST-KEY/);
  assert.deepEqual(a.json.above, [{ noradId: 25544, name: 'ISS (ZARYA)', intl: '1998-067A', lat: 41, lon: -73, altKm: 420 }]);
  assert.equal(a.json.source, 'n2yo'); assert.ok(!a.text.includes(KEY), 'key not in the response');
  a = await call(env, '/api/above?lat=40.2&lon=-75.3', now, n2yo); assert.equal(n2yo.calls.length, 1, 'same 1° cell within 2 minutes: reused');
  tx = 90; now.t += 3 * 60e3; await call(env, '/api/above?lat=10&lon=10', now, n2yo);
  a = await call(env, '/api/above?lat=20&lon=20', now, n2yo); assert.equal(a.r.status, 503, 'stops at 90 calls this hour'); assert.equal(n2yo.calls.length, 2);
  // errors from N2YO that echo the key are redacted
  _resetMemory();
  const echo = withFetch(() => new Response(JSON.stringify({ error: `Invalid API Key: ${KEY}` }), { status: 200 }));
  a = await call(env, '/api/above?lat=1&lon=1', now, echo); assert.equal(a.r.status, 502); assert.ok(!a.text.includes(KEY), a.text);
  const thrown = withFetch(() => { throw new TypeError(`fetch failed for ${KEY}`); });
  a = await call(env, '/api/above?lat=2&lon=2', now, thrown); assert.equal(a.r.status, 502); assert.ok(!a.text.includes(KEY), a.text);
});

test('the browser page never contains an API key and only calls this site', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.ok(!/apiKey=|N2YO_API_KEY|api\.n2yo\.com|open-meteo\.com\/v1|swpc\.noaa\.gov\/products/.test(page), 'third-party API calls go through the Worker');
});
