// Project Skyline API logic for Cloudflare Workers (static assets + KV + one Cron Trigger). No dependencies.
// worker/index.mjs is the entry point; this module only exports plain functions so tests can import it
// (Workers treat every named export of the entry module as an entry point).
//   GET /api/gp?group=stations   CelesTrak GP elements for one group, CelesTrak's own records verbatim in a small JSON envelope
//   GET /api/health              cache status of every group, Kp, and whether the optional N2YO key is set
//   GET /api/kp                  NOAA SWPC planetary Kp (3-hourly), refreshed by the Cron run into KV
//   GET /api/weather?lat&lon     Open-Meteo hourly cloud-cover forecast, location rounded to 0.25°, cached in memory
//   GET /api/above?lat&lon       optional: N2YO's list of objects above the horizon (only if the N2YO_API_KEY secret is set)
// Everything else is a static file from public/, served by Cloudflare without running this Worker (see wrangler.jsonc).
//
// Why it is built this way (Workers Free: 10 ms of CPU per request and per Cron run):
// - Visitors never cause a CelesTrak download. The Cron run (every 30 min) downloads a group only when it is due:
//   at most once per CelesTrak update (2 h), with back-off after errors, stopping at the first error as CelesTrak asks.
// - Downloads are stored in KV, which is global, so the whole site makes one download per update.
// - Large groups are never parsed here: JSON.parse of the 7 MB "active" list takes about 60 ms of CPU. They get cheap
//   byte checks, and the browser validates every record (validOMM in src/app.js). Small groups are parsed and validated.
// - Requests stream the stored bytes back; waiting on KV and the network does not count as CPU time.

export const GROUPS = ['stations', 'active', 'visual', 'fengyun-1c-debris', 'iridium-33-debris', 'cosmos-2251-debris'];
const MIN = 60e3, HOUR = 3600e3;
const MAX_BYTES = 24 * 1024 * 1024;   // KV values may be up to 25 MiB
const PARSE_MAX = 512 * 1024;         // groups smaller than this are fully parsed and validated (a few ms at most)
export const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'";
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

export function config(env = {}) {
  const num = (k, d) => { const n = Number(env[k]); return Number.isFinite(n) && env[k] !== undefined && env[k] !== '' ? n : d; };
  return {
    upstream: env.CELESTRAK_URL || 'https://celestrak.org/NORAD/elements/gp.php',
    refreshMs: num('REFRESH_MS', 2 * HOUR),   // CelesTrak updates GP data every 2 h and allows one download per update
    staleMs: num('STALE_MS', 3 * HOUR),       // older than this, responses say stale: true
    retryMs: num('RETRY_MS', 30 * MIN),       // wait after a failed download before asking CelesTrak again
    timeoutMs: num('TIMEOUT_MS', 20e3),
    disabled: /^(1|true|yes)$/i.test(env.UPSTREAM_DISABLED || ''),
    kpUrl: env.KP_URL || 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
    kpRefreshMs: num('KP_REFRESH_MS', HOUR), kpStaleMs: num('KP_STALE_MS', 6 * HOUR),
    weatherUrl: env.WEATHER_URL || 'https://api.open-meteo.com/v1/forecast',
    weatherTtlMs: num('WEATHER_TTL_MS', 30 * MIN), weatherPerHour: num('WEATHER_PER_HOUR', 300),
    n2yoUrl: env.N2YO_URL || 'https://api.n2yo.com/rest/v1/satellite',
    aboveTtlMs: num('ABOVE_TTL_MS', 2 * MIN), aboveBudget: num('ABOVE_BUDGET', 90),
  };
}

// same rules as validOMM in src/app.js
const isNum = v => v !== null && v !== '' && v !== undefined && Number.isFinite(+v);
const epochMs = s => (typeof s === 'string' ? Date.parse(s.endsWith('Z') ? s : s + 'Z') : NaN);
export function validOMM(m) {
  return !!m && typeof m === 'object' && isNum(m.NORAD_CAT_ID) && Number.isFinite(epochMs(m.EPOCH)) && isNum(m.MEAN_MOTION) && +m.MEAN_MOTION > 0
    && isNum(m.ECCENTRICITY) && +m.ECCENTRICITY >= 0 && +m.ECCENTRICITY < 1
    && ['INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY'].every(f => isNum(m[f]));
}

// ───────────────────────── status (one KV key, so /api/health is one read)
const STATUS_KEY = 'status';
const blankStatus = () => ({ groups: {}, pausedUntil: 0, pauseReason: null });
async function readStatus(kv) {
  try { const s = await kv.get(STATUS_KEY, 'json'); if (s && typeof s === 'object' && s.groups) return s; } catch { }
  return blankStatus();
}
const gs = (status, g) => (status.groups[g] ||= { fetchedAt: 0, count: null, bytes: 0, lastAttemptAt: 0, lastError: null, nextAttemptAt: 0 });

class UpstreamError extends Error { constructor(msg, backoff, all) { super(msg); this.backoff = backoff; this.all = all; } }

// Cheap checks on the raw bytes: no JSON.parse for large groups.
function checkBody(buf, g) {
  const bytes = new Uint8Array(buf), n = bytes.length;
  if (n > MAX_BYTES) return `CelesTrak sent ${(n / 1048576).toFixed(1)} MB for GROUP=${g}, more than can be stored.`;
  let a = 0, b = n - 1; const ws = c => c === 32 || c === 9 || c === 10 || c === 13 || c === 0xef || c === 0xbb || c === 0xbf;
  while (a < n && ws(bytes[a])) a++; while (b > a && ws(bytes[b])) b--;
  const head = new TextDecoder().decode(bytes.subarray(a, Math.min(n, a + 160))).replace(/\s+/g, ' ').trim();
  if (bytes[a] !== 0x5b || bytes[b] !== 0x5d) return `CelesTrak sent a reply that is not JSON: "${head.slice(0, 120)}"`;
  if (b - a < 2 || /^\[\s*\]$/.test(head)) return `CelesTrak returned no objects for GROUP=${g}.`;
  const start = new TextDecoder().decode(bytes.subarray(a, Math.min(n, a + 4096)));
  if (!/"NORAD_CAT_ID"/.test(start) || !/"EPOCH"/.test(start) || !/"MEAN_MOTION"/.test(start)) return 'CelesTrak sent JSON that does not look like GP orbital elements.';
  return null;
}

// Downloads one group into KV. Throws UpstreamError on any problem; never touches the stored copy then.
async function download(g, env, cfg, deps) {
  let res;
  try {
    res = await deps.fetch(`${cfg.upstream}?GROUP=${encodeURIComponent(g)}&FORMAT=json`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Project Skyline (student project; caches each group for 2 h)' },
      signal: AbortSignal.timeout(cfg.timeoutMs), redirect: 'manual',
    });
  } catch (e) {
    throw new UpstreamError(e && e.name === 'TimeoutError' ? `CelesTrak did not answer within ${cfg.timeoutMs / 1000} s.` : `Could not connect to CelesTrak (${(e && e.message) || e}).`, cfg.retryMs, true);
  }
  let buf;
  try { buf = await res.arrayBuffer(); }
  catch (e) { throw new UpstreamError(e && e.name === 'TimeoutError' ? `CelesTrak did not answer within ${cfg.timeoutMs / 1000} s.` : `The download from CelesTrak broke off (${(e && e.message) || e}).`, cfg.retryMs, true); }
  const snip = () => new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 400))).replace(/\s+/g, ' ').trim().slice(0, 160);
  // "GP data has not updated since your last successful download" concerns only this group; other refusals concern this site
  if (res.status === 403 || res.status === 429) { const t = snip(); throw new UpstreamError(`CelesTrak refused the request (HTTP ${res.status}): ${t}`, cfg.refreshMs, !/not updated/i.test(t)); }
  if (res.status !== 200) { const t = snip(); throw new UpstreamError(`CelesTrak answered HTTP ${res.status}${t ? ': ' + t : ''}`, cfg.retryMs, true); }
  const bad = checkBody(buf, g);
  if (bad) throw new UpstreamError(bad, cfg.retryMs, false);
  let count = null, skipped = 0;
  if (buf.byteLength <= PARSE_MAX) {
    let list; try { list = JSON.parse(new TextDecoder().decode(buf)); } catch { throw new UpstreamError(`CelesTrak sent a reply that is not JSON: "${snip()}"`, cfg.retryMs, false); }
    if (!Array.isArray(list)) throw new UpstreamError('CelesTrak sent JSON that is not a list of objects.', cfg.retryMs, false);
    count = 0; for (const m of list) validOMM(m) ? count++ : skipped++;
    if (!count) throw new UpstreamError(list.length ? `None of the ${list.length} records CelesTrak sent were valid.` : `CelesTrak returned no objects for GROUP=${g}.`, cfg.retryMs, false);
  }
  const fetchedAt = deps.now();
  await env.SKYLINE_KV.put(`gp:${g}`, buf, { metadata: { fetchedAt, bytes: buf.byteLength, count } });
  return { fetchedAt, bytes: buf.byteLength, count, skipped };
}

// The Cron run. Returns what it did (for logs and tests).
export async function refreshDue(env, deps = {}) {
  deps = { fetch: (...a) => fetch(...a), now: Date.now, log: (...a) => console.log(...a), ...deps };
  const cfg = config(env), kv = env.SKYLINE_KV;
  if (!kv) throw new Error('SKYLINE_KV binding is missing (see wrangler.jsonc).');
  const status = await readStatus(kv), done = [];
  if (cfg.disabled) return { done, skipped: 'UPSTREAM_DISABLED is set' };
  for (const g of GROUPS) {
    const s = gs(status, g), now = deps.now();
    if (!(now >= Math.max(s.nextAttemptAt || 0, status.pausedUntil || 0))) continue;
    s.lastAttemptAt = now;
    try {
      const r = await download(g, env, cfg, deps);
      Object.assign(s, { fetchedAt: r.fetchedAt, count: r.count, bytes: r.bytes, lastError: null, nextAttemptAt: r.fetchedAt + cfg.refreshMs });
      deps.log(`${g}: stored ${(r.bytes / 1024).toFixed(0)} KB${r.count != null ? `, ${r.count} objects` : ''}${r.skipped ? `, ${r.skipped} invalid` : ''}`);
      done.push({ g, ok: true });
    } catch (e) {
      s.lastError = e instanceof UpstreamError ? e.message : `Unexpected error: ${e && e.message}`;
      s.nextAttemptAt = deps.now() + ((e && e.backoff) || cfg.retryMs);
      deps.log(`${g}: ${s.lastError} Keeping ${s.fetchedAt ? `the copy from ${new Date(s.fetchedAt).toISOString()}` : 'no data'}.`);
      done.push({ g, ok: false, error: s.lastError });
      if (e && e.all) {   // CelesTrak asks clients to stop at the first error
        status.pausedUntil = Math.max(status.pausedUntil || 0, s.nextAttemptAt);
        status.pauseReason = `Not asking CelesTrak until ${new Date(status.pausedUntil).toISOString()} after an error on ${g}: ${s.lastError}`;
        break;
      }
    }
  }
  if (done.length) await kv.put(STATUS_KEY, JSON.stringify(status));   // only when something was attempted (KV free: 1,000 writes a day)
  const kp = await refreshKp(env, cfg, deps);
  return { done, kp };
}

// ───────────────────────── NOAA planetary Kp (a few KB; fetched by the Cron run at most hourly, one KV write per attempt)
// NOAA has served this feed both as rows with a header (["time_tag","Kp",…]) and as objects ({time_tag, Kp, …}); accept both.
export function parseKp(text) {
  let rows; try { rows = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const out = [];
  for (const row of rows) {
    const t = Array.isArray(row) ? row[0] : row && row.time_tag, v = Array.isArray(row) ? row[1] : row && (row.Kp ?? row.kp);
    if (typeof t !== 'string' || t === 'time_tag') continue;
    const ms = Date.parse(t.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? '' : 'Z')), kp = Number(v);
    if (Number.isFinite(ms) && Number.isFinite(kp) && kp >= 0 && kp <= 9 && v !== null && v !== '') out.push({ time: new Date(ms).toISOString(), kp });
  }
  out.sort((a, b) => (a.time < b.time ? -1 : 1));
  return out.length ? out.slice(-24) : null;
}
async function refreshKp(env, cfg, deps) {
  const kv = env.SKYLINE_KV; let cur = null;
  try { cur = await kv.get('kp', 'json'); } catch { }
  cur = cur && typeof cur === 'object' ? cur : { fetchedAt: 0, samples: null, lastAttemptAt: 0, lastError: null };
  const now = deps.now();
  if (cfg.disabled || now - (cur.fetchedAt || 0) < cfg.kpRefreshMs || now - (cur.lastAttemptAt || 0) < cfg.retryMs) return 'not due';
  cur.lastAttemptAt = now;
  try {
    const res = await deps.fetch(cfg.kpUrl, { headers: { Accept: 'application/json', 'User-Agent': 'Project Skyline (student project; hourly)' }, signal: AbortSignal.timeout(Math.min(cfg.timeoutMs, 10e3)), redirect: 'manual' });
    if (res.status !== 200) throw new Error(`NOAA answered HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 512 * 1024) throw new Error('NOAA sent an unexpectedly large reply');
    const samples = parseKp(text);
    if (!samples) throw new Error('NOAA sent a reply with no usable Kp values');
    Object.assign(cur, { fetchedAt: now, samples, lastError: null });
  } catch (e) {
    cur.lastError = e && e.name === 'TimeoutError' ? 'NOAA did not answer in time.' : String((e && e.message) || e);
  }
  await kv.put('kp', JSON.stringify(cur));
  return cur.lastError ? 'failed: ' + cur.lastError : 'stored';
}

// ───────────────────────── Open-Meteo cloud cover (free API, non-commercial use with attribution)
// Cached per rounded location in this Worker instance's memory, and in Cloudflare's edge cache when the site runs on a
// custom domain. No KV writes, so it cannot use up the KV write allowance. A per-instance hourly cap keeps it polite.
const mem = { weather: new Map(), above: new Map(), wxCalls: [], aboveCalls: [], aboveTx: 0, aboveTxAt: 0 };
const round = (v, step) => Math.round(v / step) * step;
function latLon(url) {
  const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
  if (url.searchParams.get('lat') === null || !Number.isFinite(lat) || lat < -90 || lat > 90) return 'Query parameter "lat" must be a number between -90 and 90.';
  if (url.searchParams.get('lon') === null || !Number.isFinite(lon) || lon < -180 || lon > 180) return 'Query parameter "lon" must be a number between -180 and 180.';
  return { lat, lon };
}
const remember = (map, key, value, max = 500) => { if (map.size >= max) map.delete(map.keys().next().value); map.set(key, value); };
const underCap = (calls, now, cap) => { while (calls.length && now - calls[0] > HOUR) calls.shift(); return calls.length < cap; };
export function parseCloud(text) {
  let j; try { j = JSON.parse(text); } catch { return null; }
  const t = j && j.hourly && j.hourly.time, c = j && j.hourly && j.hourly.cloud_cover;
  if (!Array.isArray(t) || !Array.isArray(c)) return null;
  const out = [];
  for (let k = 0; k < Math.min(t.length, c.length, 72); k++) {
    const ms = typeof t[k] === 'string' ? Date.parse(/Z$/.test(t[k]) ? t[k] : t[k] + 'Z') : NaN;
    if (Number.isFinite(ms) && typeof c[k] === 'number' && Number.isFinite(c[k])) out.push({ time: new Date(ms).toISOString(), cloudCoverPercent: Math.max(0, Math.min(100, c[k])) });
  }
  return out.length ? out : null;
}
async function handleWeather(url, cfg, now, deps) {
  const p = latLon(url); if (typeof p === 'string') return json(400, { error: p });
  const lat = round(p.lat, 0.25), lon = round(p.lon, 0.25), key = `${lat},${lon}`;
  const hit = mem.weather.get(key);
  if (hit && now - hit.at < cfg.weatherTtlMs) return json(200, { ...hit.body, servedFromCache: true });
  if (cfg.disabled || !underCap(mem.wxCalls, now, cfg.weatherPerHour)) return json(503, { error: 'The cloud forecast is not available right now.' }, { 'Retry-After': '600' });
  mem.wxCalls.push(now);
  try {
    const res = await deps.fetch(`${cfg.weatherUrl}?latitude=${lat}&longitude=${lon}&hourly=cloud_cover&forecast_days=3&timezone=UTC`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8e3), redirect: 'manual' });
    if (res.status !== 200) return json(502, { error: `The forecast provider answered HTTP ${res.status}.` });
    const hourly = parseCloud(await res.text());
    if (!hourly) return json(502, { error: 'The forecast provider sent an unusable reply.' });
    const body = { latitude: lat, longitude: lon, retrievedAt: new Date(now).toISOString(), source: 'open-meteo', sourceUrl: 'https://open-meteo.com/', kind: 'forecast', hourly };
    remember(mem.weather, key, { at: now, body });
    return json(200, { ...body, servedFromCache: false });
  } catch (e) {
    return json(502, { error: e && e.name === 'TimeoutError' ? 'The forecast provider did not answer in time.' : 'The forecast provider could not be reached.' });
  }
}

async function handleKp(env, cfg, now) {
  let cur = null; try { cur = await env.SKYLINE_KV.get('kp', 'json'); } catch { }
  if (!cur || !Array.isArray(cur.samples) || !cur.samples.length) return json(503, { error: (cur && cur.lastError) || 'No Kp data has been downloaded yet. The site asks NOAA once an hour.' }, { 'Retry-After': '1800' });
  return json(200, { retrievedAt: new Date(cur.fetchedAt).toISOString(), stale: now - cur.fetchedAt > cfg.kpStaleMs, lastError: cur.lastError || null, source: 'noaa-swpc', sourceUrl: 'https://www.swpc.noaa.gov/', feedUrl: cfg.kpUrl, samples: cur.samples });
}

// ───────────────────────── N2YO "above" (optional cross-check; the key never leaves the Worker)
// N2YO allows 100 "above" calls an hour per key and asks that the endpoint be used sparingly. Locations are rounded to
// 1°, answers are reused for 2 minutes, and calls stop for the rest of the hour once N2YO's own counter reaches 90.
async function handleAbove(url, env, cfg, now, deps) {
  const key = env.N2YO_API_KEY;
  if (!key) return json(404, { error: 'The N2YO cross-check is not set up on this site.', configured: false });
  const p = latLon(url); if (typeof p === 'string') return json(400, { error: p });
  const lat = round(p.lat, 1), lon = round(p.lon, 1), ck = `${lat},${lon}`;
  const hit = mem.above.get(ck);
  if (hit && now - hit.at < cfg.aboveTtlMs) return json(200, { ...hit.body, servedFromCache: true });
  const hourStart = now - (now % HOUR);
  if (mem.aboveTxAt < hourStart) { mem.aboveTx = 0; mem.aboveTxAt = hourStart; }
  if (mem.aboveTx >= cfg.aboveBudget || !underCap(mem.aboveCalls, now, cfg.aboveBudget)) return json(503, { error: 'The N2YO allowance for this hour is used up. Skyline’s own calculation is unaffected.', configured: true }, { 'Retry-After': String(Math.ceil((hourStart + HOUR - now) / 1000)) });
  mem.aboveCalls.push(now);
  const redact = m => String(m || '').split(key).join('***');
  try {
    const res = await deps.fetch(`${cfg.n2yoUrl}/above/${lat}/${lon}/0/90/0/&apiKey=${encodeURIComponent(key)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10e3), redirect: 'manual' });
    if (res.status !== 200) return json(502, { error: `N2YO answered HTTP ${res.status}.`, configured: true });
    let j; try { j = JSON.parse(await res.text()); } catch { return json(502, { error: 'N2YO sent a reply that is not JSON.', configured: true }); }
    if (!j || typeof j !== 'object' || j.error) return json(502, { error: `N2YO refused the request: ${redact(j && j.error).slice(0, 160)}`, configured: true });
    const info = j.info || {}, list = Array.isArray(j.above) ? j.above : [];
    if (Number.isFinite(info.transactionscount)) { mem.aboveTx = info.transactionscount; mem.aboveTxAt = hourStart; }
    const above = list.filter(a => a && Number.isFinite(+a.satid)).map(a => ({ noradId: +a.satid, name: String(a.satname || '').slice(0, 80), intl: String(a.intDesignator || '').slice(0, 20), lat: +a.satlat, lon: +a.satlng, altKm: +a.satalt }));
    const body = { source: 'n2yo', sourceUrl: 'https://www.n2yo.com/', retrievedAt: new Date(now).toISOString(), latitude: lat, longitude: lon, radiusDeg: 90, count: above.length, above, configured: true };
    remember(mem.above, ck, { at: now, body }, 200);
    return json(200, { ...body, servedFromCache: false });
  } catch (e) {
    return json(502, { error: e && e.name === 'TimeoutError' ? 'N2YO did not answer in time.' : `Could not reach N2YO (${redact(e && e.message).slice(0, 120)}).`, configured: true });
  }
}
export const _resetMemory = () => { mem.weather.clear(); mem.above.clear(); mem.wxCalls.length = 0; mem.aboveCalls.length = 0; mem.aboveTx = 0; mem.aboveTxAt = 0; };

// ───────────────────────── HTTP
const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC, ...extra } });

async function handleGp(url, request, env, cfg, now) {
  const g = url.searchParams.get('group');
  if (!GROUPS.includes(g)) return json(400, { error: `Unknown group. Use one of: ${GROUPS.join(', ')}.` });
  const kv = env.SKYLINE_KV;
  const [status, stored] = await Promise.all([readStatus(kv), kv.getWithMetadata(`gp:${g}`, { type: 'stream' })]);
  const s = gs(status, g), m = stored && stored.value ? stored.metadata || {} : null;
  if (!m || !Number.isFinite(m.fetchedAt)) {
    const until = Math.max(s.nextAttemptAt || 0, status.pausedUntil || 0);
    const wait = Math.max(60, Math.ceil((until - now) / 1000));
    if (stored && stored.value) stored.value.cancel();
    return json(503, { group: g, error: s.lastError || (now < (status.pausedUntil || 0) && status.pauseReason) || 'No data has been downloaded yet. The site downloads from CelesTrak on a schedule (every 30 minutes when due).', lastAttemptAt: s.lastAttemptAt || null, retryAfterSeconds: wait }, { 'Retry-After': String(wait) });
  }
  const stale = now - m.fetchedAt > cfg.staleMs;
  const meta = { group: g, fetchedAt: m.fetchedAt, count: m.count ?? null, bytes: m.bytes ?? null, stale, lastError: s.lastError, lastAttemptAt: s.lastAttemptAt || null, refreshMinutes: cfg.refreshMs / MIN, format: 'omm' };
  const etag = `"${g}-${m.fetchedAt}-${stale ? 1 : 0}-${s.lastAttemptAt || 0}"`;
  const head = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: etag, ...SEC };
  if ((request.headers.get('If-None-Match') || '') === etag) { stored.value.cancel(); return new Response(null, { status: 304, headers: head }); }
  if (request.method === 'HEAD') { stored.value.cancel(); return new Response(null, { status: 200, headers: head }); }
  // {...meta, "records": <CelesTrak's bytes>} without parsing them
  const enc = new TextEncoder(), prefix = enc.encode(JSON.stringify(meta).slice(0, -1) + ',"records":'), suffix = enc.encode('}');
  const reader = stored.value.getReader();
  let stage = 0;
  const body = new ReadableStream({
    async pull(c) {
      if (stage === 0) { stage = 1; c.enqueue(prefix); return; }
      if (stage === 1) { const { done, value } = await reader.read(); if (!done) { c.enqueue(value); return; } stage = 2; }
      c.enqueue(suffix); c.close();
    },
    cancel(r) { return reader.cancel(r); },
  });
  return new Response(body, { status: 200, headers: head });
}

async function handleHealth(env, now) {
  const status = await readStatus(env.SKYLINE_KV), groups = {};
  const iso = t => (t ? new Date(t).toISOString() : null);
  for (const g of GROUPS) {
    const s = gs(status, g);
    groups[g] = { fetchedAt: iso(s.fetchedAt), count: s.count, bytes: s.bytes || 0, lastAttemptAt: iso(s.lastAttemptAt), lastError: s.lastError,
      nextAttemptAt: s.lastAttemptAt || s.fetchedAt ? iso(Math.max(s.nextAttemptAt || 0, status.pausedUntil || 0)) : 'at the next scheduled run' };
  }
  let kp = null; try { kp = await env.SKYLINE_KV.get('kp', 'json'); } catch { }
  return json(200, { ok: true, time: new Date(now).toISOString(), runtime: 'cloudflare-workers', groups,
    kp: kp ? { fetchedAt: iso(kp.fetchedAt), lastAttemptAt: iso(kp.lastAttemptAt), lastError: kp.lastError || null } : null,
    n2yo: { configured: !!env.N2YO_API_KEY } });
}

export async function handle(request, env, deps = {}) {
  deps = { fetch: (...a) => fetch(...a), ...deps };
  const now = (deps.now || Date.now)(), cfg = config(env);
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404, headers: SEC });
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
  if (!env.SKYLINE_KV) return json(500, { error: 'The SKYLINE_KV binding is missing (see wrangler.jsonc).' });
  try {
    if (url.pathname === '/api/gp') return await handleGp(url, request, env, cfg, now);
    if (url.pathname === '/api/health') return await handleHealth(env, now);
    if (url.pathname === '/api/kp') return await handleKp(env, cfg, now);
    if (url.pathname === '/api/weather') return await handleWeather(url, cfg, now, deps);
    if (url.pathname === '/api/above') return await handleAbove(url, env, cfg, now, deps);
    return json(404, { error: 'Unknown API path.' });
  } catch (e) {
    console.error('api error', e && e.stack || e);
    return json(500, { error: 'Internal error.' });
  }
}
