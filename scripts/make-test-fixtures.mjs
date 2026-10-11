#!/usr/bin/env node
/**
 * make-test-fixtures.mjs — extract small GP fixtures from the committed snapshot
 * so the unit test suite never has to load a 13 MB dataset.
 *
 * Output: tests/fixtures/gp-samples.json { source, items: [{group, record, note}] }
 * Records are copied verbatim from data/snapshot/groups/*.json.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(ROOT, p), 'utf8');

const stations = JSON.parse(await read('data/snapshot/groups/stations.json'));
const science = JSON.parse(await read('data/snapshot/groups/science.json'));
const fengyun = JSON.parse(await read('data/snapshot/groups/fengyun-1c-debris.json'));
const weather = JSON.parse(await read('data/snapshot/groups/weather.json'));

const pick = (records, noradId) => {
  const rec = records.find((r) => Number(r.NORAD_CAT_ID) === noradId);
  if (!rec) throw new Error(`NORAD ${noradId} not found in snapshot group`);
  return rec;
};

const items = [
  { group: 'stations', note: 'ISS — primary reference object', record: pick(stations, 25544) },
  { group: 'stations', note: 'Second space-station object for multi-object tests', record: pick(stations, 36086) },
  { group: 'science', note: 'Low-eccentricity science mission', record: science[0] },
  { group: 'fengyun-1c-debris', note: 'Debris fragment — high mean motion', record: fengyun[0] },
  { group: 'weather', note: 'Sun-synchronous weather satellite', record: weather[0] },
];

await mkdir(path.join(ROOT, 'tests', 'fixtures'), { recursive: true });
await writeFile(
  path.join(ROOT, 'tests', 'fixtures', 'gp-samples.json'),
  JSON.stringify(
    {
      source: 'data/snapshot/groups/*.json (verbatim CelesTrak GP records; see data/snapshot/manifest.json)',
      copies: 'Records below are byte-identical copies of the corresponding snapshot records.',
      items,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Wrote ${items.length} GP fixtures to tests/fixtures/gp-samples.json`);
