// Checks the data-state labels in src/app.js: each state maps to one label, and only fresh downloaded data is LIVE.
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
const ctx = {}; vm.createContext(ctx);
vm.runInContext(slice('function dataLabel(', 'let lastLabel') + ';this.dataLabel = dataLabel;', ctx);
const { dataLabel } = ctx;

test('each data state maps to exactly one label', () => {
  const want = { live: 'LIVE', cached: 'CACHED', hosted: 'CACHED', stale: 'STALE', snapshot: 'SNAPSHOT', demo: 'DEMO', loading: 'LOADING' };
  for (const [mode, text] of Object.entries(want)) assert.equal(dataLabel(mode, false).text, text, mode);
});

test('snapshot, demo, cached and stale data are never labelled LIVE', () => {
  for (const mode of ['snapshot', 'demo', 'stale', 'cached', 'hosted', 'loading', undefined, 'anything-else'])
    for (const stale of [false, true]) assert.notEqual(dataLabel(mode, stale).text, 'LIVE', `${mode}, stale=${stale}`);
  assert.equal(dataLabel('live', true).text, 'STALE', 'live data past its freshness limit is STALE');
  assert.equal(dataLabel('snapshot', true).text, 'SNAPSHOT');
  assert.equal(dataLabel('demo', true).text, 'DEMO');
});

test('the clock never says LIVE (a real-time clock is not live data), and SignalScope keeps its geometry-only line', () => {
  assert.ok(!/live \? 'LIVE'/.test(app), 'time-mode tag must not use the word LIVE');
  assert.match(app, /live \? 'REAL TIME'/);
  assert.ok(!/>LIVE</.test(tpl), 'no hard-coded LIVE in the page');
  assert.match(tpl, /geometry only|Line-of-sight geometry/i);
});
