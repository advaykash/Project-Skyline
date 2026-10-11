#!/usr/bin/env node
/**
 * build-snapshot.mjs — build the bundled offline dataset in `data/snapshot/`.
 *
 * Source modes:
 *   1. Live CelesTrak (preferred; needs egress to celestrak.org):
 *        SKYLINE_SNAPSHOT_SOURCE=celestrak node scripts/build-snapshot.mjs
 *   2. A local directory of verbatim `gp.php?FORMAT=json` payloads laid out as
 *      `<dir>/celestrak/json/<group>.json`, optionally with an upstream
 *      `manifest.json` carrying per-group capture times:
 *        SKYLINE_SNAPSHOT_SOURCE=/path/to/mirror node scripts/build-snapshot.mjs
 *
 * Output:
 *   data/snapshot/groups/<group>.json   verbatim upstream records (unmodified)
 *   data/snapshot/manifest.json         provenance + per-group integrity metadata
 *
 * Records are never edited, synthesised, reordered or re-typed: each group file
 * is the upstream payload exactly as received, and its SHA-256 is recorded in the
 * manifest so the committed snapshot can be audited against the upstream source.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data', 'snapshot');
const GROUPS_FILE = path.join(ROOT, 'shared', 'catalog-groups.json');

/** CelesTrak GP endpoint (documented parameters: GROUP, FORMAT). */
const CELESTRAK_GP = 'https://celestrak.org/NORAD/elements/gp.php';

const source = process.env.SKYLINE_SNAPSHOT_SOURCE ?? 'celestrak';
const allGroups = JSON.parse(await readFile(GROUPS_FILE, 'utf8'));
const bundledGroups = allGroups.filter((g) => g.bundle).map((g) => g.id);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Structural validation of an upstream GP payload. */
function validateRecords(group, text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${group}: upstream payload is not valid JSON (${err.message})`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${group}: payload is not a JSON array`);
  if (parsed.length === 0) throw new Error(`${group}: payload contains no records`);
  const required = ['OBJECT_NAME', 'NORAD_CAT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION'];
  for (const [i, rec] of parsed.entries()) {
    for (const key of required) {
      if (rec[key] === undefined || rec[key] === null || rec[key] === '') {
        throw new Error(`${group}: record #${i} is missing required field ${key}`);
      }
    }
  }
  return parsed;
}

const epochRange = (records) => {
  const epochs = records.map((r) => r.EPOCH).sort();
  return { min: epochs[0], max: epochs[epochs.length - 1] };
};

async function readSource(group) {
  if (source === 'celestrak') {
    const url = `${CELESTRAK_GP}?GROUP=${encodeURIComponent(group)}&FORMAT=json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Skyline snapshot builder (+https://github.com/akulbajpai-code/SkyLine)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${group}: CelesTrak responded HTTP ${res.status}`);
    return { text: await res.text(), url, capturedAt: new Date().toISOString(), via: 'celestrak.org (direct)' };
  }

  const candidates = [
    path.join(source, 'celestrak', 'json', `${group}.json`),
    path.join(source, `${group}.json`),
  ];
  const file = candidates.find(existsSync);
  if (!file) throw new Error(`${group}: no source file found in ${source}`);
  const text = await readFile(file, 'utf8');

  let capturedAt = null;
  const manifestPath = path.join(source, 'manifest.json');
  if (existsSync(manifestPath)) {
    const m = JSON.parse(await readFile(manifestPath, 'utf8'));
    capturedAt = m?.groups?.[group]?.updatedAt ?? m?.generatedAt ?? null;
  }
  return {
    text,
    url: `${CELESTRAK_GP}?GROUP=${group}&FORMAT=json`,
    capturedAt: capturedAt ?? new Date().toISOString(),
    via: `local mirror directory ${path.resolve(source)}`,
  };
}

async function main() {
  await rm(path.join(OUT_DIR, 'groups'), { recursive: true, force: true });
  await mkdir(path.join(OUT_DIR, 'groups'), { recursive: true });

  const manifestGroups = {};
  for (const group of bundledGroups) {
    const { text, url, capturedAt, via } = await readSource(group);
    const records = validateRecords(group, text);
    await writeFile(path.join(OUT_DIR, 'groups', `${group}.json`), text);
    manifestGroups[group] = {
      recordCount: records.length,
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
      capturedAt,
      sourceUrl: url,
      via,
      epochRange: epochRange(records),
    };
    console.log(
      `• ${group.padEnd(22)} ${String(records.length).padStart(6)} records  ` +
        `${(Buffer.byteLength(text) / 1024).toFixed(0).padStart(6)} KiB  captured ${capturedAt}`,
    );
  }

  const manifest = {
    schema: 'skyline.snapshot/1',
    generatedAt: new Date().toISOString(),
    generatedBy: `scripts/build-snapshot.mjs (SKYLINE_SNAPSHOT_SOURCE=${source})`,
    provider: 'CelesTrak — https://celestrak.org',
    providerEndpoint: CELESTRAK_GP,
    providerDocs: 'https://celestrak.org/NORAD/documentation/gp-data-formats.php',
    usagePolicy: 'https://celestrak.org/usage-policy.php',
    note:
      'Verbatim CelesTrak GP JSON captured for offline and demonstration operation. Records are unmodified ' +
      'upstream payloads; epochs are the propagation reference times. Snapshot data is always labelled as a ' +
      'snapshot in the application and is never presented as live data.',
    groups: manifestGroups,
  };
  await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const total = Object.values(manifestGroups).reduce((n, g) => n + g.recordCount, 0);
  console.log(`\nWrote ${bundledGroups.length} groups / ${total} records to data/snapshot/.`);
}

await main();
