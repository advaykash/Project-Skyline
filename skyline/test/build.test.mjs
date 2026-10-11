// Checks that the project is complete and consistent: the built page matches src/, the bundled libraries are the
// expected versions, and the page, Worker and tools agree on the data source. Run: npm test (Node 20+).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildPage } from '../tools/build-page.mjs';
import { GROUPS } from '../worker/api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const PAGE = read('public/index.html');
// three.js r128 (npm three@0.128.0) and satellite.js 6.0.2, byte-identical to the npm packages
const VENDOR = {
  'public/vendor/three.min.js': '9274bbcec8d96168626c732b5d31c775aa8cfb7eaa0599bec0c175908a2c1ce2',
  'public/vendor/satellite.min.js': '14488fc910920924e6616f07f950ba307586e08fbb837407d8fe04c939b2059f',
};

test('public/index.html is up to date with src/ (run "npm run build:page" after editing src/)', () => {
  assert.ok(buildPage().html === PAGE, 'public/index.html differs from a fresh build of src/');
});

test('every inline script in the page compiles (a syntax error would leave a blank page that unit tests miss)', () => {
  const scripts = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length >= 1 && scripts.some(s => s.includes('function enterPov(')), 'app script inlined');
  for (const s of scripts) assert.doesNotThrow(() => new vm.Script(s), 'inline script must parse');
});

test('the page loads its libraries from this site, and they are the expected versions', () => {
  const scripts = [...PAGE.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(scripts, ['vendor/three.min.js', 'vendor/satellite.min.js']);
  for (const [f, sha] of Object.entries(VENDOR))
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex'), sha, f);
  for (const f of ['public/vendor/three.LICENSE.txt', 'public/vendor/satellite.js.LICENSE.txt']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test('the page asks this site for data, never CelesTrak directly', () => {
  assert.match(PAGE, /const API_BASE = 'api\/gp';/);
  assert.match(PAGE, /const BROWSER_FETCH = false;/);
  assert.ok(PAGE.includes('data:image/'), 'the Earth texture is embedded in the page');
});

test('page, Worker and fetch tool use the same six CelesTrak groups', () => {
  const six = ['stations', 'active', 'visual', 'fengyun-1c-debris', 'iridium-33-debris', 'cosmos-2251-debris'];
  assert.deepEqual(GROUPS, six);
  const app = read('src/app.js'), block = app.slice(app.indexOf('const GROUPS = ['), app.indexOf('];', app.indexOf('const GROUPS = [')));
  assert.deepEqual([...block.matchAll(/key: '([^']+)'/g)].map(m => m[1]), six);
  assert.match(read('tools/fetch-celestrak.mjs'), new RegExp(`const GROUPS = \\[${six.map(g => `'${g}'`).join(', ')}\\];`));
  for (const f of ['src/app.js', 'worker/api.mjs', 'tools/fetch-celestrak.mjs']) assert.ok(!read(f).includes('cosmos-1408'), f);
});

test('public/ fits Cloudflare static assets: under 20,000 files, each under 25 MiB, nothing secret', () => {
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } };
  walk(path.join(ROOT, 'public'));
  assert.ok(files.length < 20000, `${files.length} files`);
  for (const f of files) assert.ok(fs.statSync(f).size < 25 * 1024 * 1024, `${path.relative(ROOT, f)} is too large for Cloudflare static assets`);
  for (const f of files) assert.ok(!/\.(env|pem|key)$|wrangler|\.dev\.vars/i.test(path.basename(f)), `${path.relative(ROOT, f)} should not be published`);
  assert.ok(files.some(f => f.endsWith(path.join('public', 'index.html'))));
});

test('the snapshot stored with the site is real CelesTrak data with a capture time for every group', () => {
  const p = path.join(ROOT, 'public', 'data', 'celestrak.json');
  if (!fs.existsSync(p)) return;   // optional: without it the app falls back to demo orbits
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(d.format, 'orbitwatch-gp/1');
  assert.ok(['captured', 'newest-epoch', undefined].includes(d.fetchedAtKind));
  assert.deepEqual(d.fields.slice(0, 4), ['NORAD_CAT_ID', 'OBJECT_NAME', 'OBJECT_ID', 'EPOCH']);
  for (const [g, x] of Object.entries(d.groups)) {
    assert.ok(GROUPS.includes(g), g);
    assert.ok(x.rows.length > 0, g);
    if (d.fetchedAtKind === 'captured') assert.ok(Number.isFinite(x.fetchedAt) && x.fetchedAt <= Date.now(), `${g}: capture time`);
    for (const r of x.rows.slice(0, 50)) assert.ok(Number.isFinite(+r[0]) && !/demo/i.test(r[1]), `${g}: ${r[1]}`);
  }
  // once the site is older than a few hours, a stored copy is shown as a snapshot, never as live
  assert.match(read('src/app.js'), /hosted\.ds && \{ d: hosted\.ds, m: 'snapshot' \}/);
});
