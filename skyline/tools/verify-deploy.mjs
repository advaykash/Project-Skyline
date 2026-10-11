#!/usr/bin/env node
// Checks a deployed Project Skyline site and prints what it finds. Nothing is changed.
// Usage: node tools/verify-deploy.mjs https://project-skyline.<your-subdomain>.workers.dev
// Exit code 0 only if every required check passes. Optional extras (Kp, clouds, N2YO) are reported but never fail it.
const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) { console.error('Usage: node tools/verify-deploy.mjs https://your-site.workers.dev'); process.exit(2); }
let failed = 0;
const ok = (good, label, detail = '') => { if (!good) failed++; console.log(`${good ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); };
const info = (label, detail) => console.log(`info  ${label}  ${detail}`);
async function get(p) {
  const t0 = Date.now();
  try { const r = await fetch(base + p, { headers: { Accept: '*/*' }, signal: AbortSignal.timeout(30e3) }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { } return { r, text, json, ms: Date.now() - t0 }; }
  catch (e) { return { r: null, text: '', json: null, err: String(e && e.message || e), ms: Date.now() - t0 }; }
}

const page = await get('/');
ok(page.r && page.r.status === 200 && page.text.includes('Project Skyline'), 'page loads', page.r ? `HTTP ${page.r.status}, ${(page.text.length / 1024).toFixed(0)} KB` : page.err);
ok(!!(page.r && /default-src 'self'/.test(page.r.headers.get('content-security-policy') || '')), 'page has the Content-Security-Policy header');
for (const f of ['vendor/three.min.js', 'vendor/satellite.min.js', 'textures/earth-day-4096.jpg', 'textures/earth-night-2048.jpg', 'textures/ocean-mask-2048.png', 'data/celestrak.json']) {
  const r = await get('/' + f); ok(r.r && r.r.status === 200, `static file ${f}`, r.r ? `HTTP ${r.r.status}` : r.err);
}

const h = await get('/api/health');
ok(h.r && h.r.status === 200 && h.json && h.json.runtime === 'cloudflare-workers', '/api/health answers from the Worker', h.r ? `HTTP ${h.r.status}` : h.err);
if (h.json && h.json.groups) {
  for (const [g, s] of Object.entries(h.json.groups)) info(`group ${g}`, `fetched ${s.fetchedAt || 'never'}, ${s.count ?? '?'} objects, ${s.lastError ? 'last error: ' + s.lastError : 'no error'}`);
  const have = Object.values(h.json.groups).filter(s => s.fetchedAt).length;
  ok(have === Object.keys(h.json.groups).length, 'every CelesTrak group has been downloaded by the Cron run', `${have} of ${Object.keys(h.json.groups).length}${have ? '' : ' (the first run happens within 30 minutes of deploying)'}`);
}

const gp = await get('/api/gp?group=stations');
const recs = gp.json && Array.isArray(gp.json.records) ? gp.json.records : [];
ok(gp.r && gp.r.status === 200 && recs.length > 0 && recs.some(r => +r.NORAD_CAT_ID === 25544), '/api/gp?group=stations returns real elements including the ISS', gp.r ? `HTTP ${gp.r.status}, ${recs.length} records, fetchedAt ${gp.json && gp.json.fetchedAt ? new Date(gp.json.fetchedAt).toISOString() : '–'}, stale ${gp.json && gp.json.stale}` : gp.err);
if (gp.json && gp.json.fetchedAt) info('age of stations data', `${((Date.now() - gp.json.fetchedAt) / 3600e3).toFixed(1)} h (LIVE in the app needs under 3 h)`);
const bad = await get('/api/gp?group=nope');
ok(bad.r && bad.r.status === 400, 'unknown group is refused with 400');
ok(!/apiKey=|N2YO_API_KEY/.test(page.text), 'no API key in the page');

const kp = await get('/api/kp');
info('/api/kp (optional)', kp.r && kp.r.status === 200 ? `Kp ${kp.json.samples.at(-1).kp} at ${kp.json.samples.at(-1).time}, retrieved ${kp.json.retrievedAt}` : `HTTP ${kp.r ? kp.r.status : 0}: ${(kp.json && kp.json.error) || kp.err || ''}`);
const wx = await get('/api/weather?lat=40.357&lon=-74.667');
info('/api/weather (optional)', wx.r && wx.r.status === 200 ? `${wx.json.hourly.length} forecast hours from Open-Meteo` : `HTTP ${wx.r ? wx.r.status : 0}: ${(wx.json && wx.json.error) || wx.err || ''}`);
if (h.json && h.json.n2yo && h.json.n2yo.configured) {
  const ab = await get('/api/above?lat=40.357&lon=-74.667');
  info('/api/above (N2YO, optional)', ab.r && ab.r.status === 200 ? `${ab.json.count} objects above 40°, -75°` : `HTTP ${ab.r ? ab.r.status : 0}: ${(ab.json && ab.json.error) || ab.err || ''}`);
  ok(!(ab.text || '').includes('apiKey'), 'N2YO key not exposed by /api/above');
} else info('/api/above (N2YO, optional)', 'no N2YO_API_KEY secret set; the app uses its own calculation only');

console.log(failed ? `\n${failed} required check(s) failed.` : '\nAll required checks passed.');
process.exit(failed ? 1 : 0);
