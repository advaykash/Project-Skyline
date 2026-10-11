/**
 * verify-live.mjs — prove the genuine CelesTrak live-data path.
 *
 * The unit and integration tests in this repository use deterministic mocks (and
 * the bundled snapshot) because CI sandboxes usually cannot reach celestrak.org.
 * This script is the counterpart: it must be run on a machine with internet
 * access, and it verifies the *real* retrieval path end to end.
 *
 * Usage:
 *   node scripts/verify-live.mjs [baseURL]        # default http://127.0.0.1:8788
 *
 * It exits 0 only if every check passes. A snapshot-labelled response is a
 * failure here — that is the whole point of this script.
 */

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:8788';
const checks = [];

function record(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log(`Skyline live-data verification against ${BASE_URL}\n`);

  // 1. Health
  const health = await (await fetch(`${BASE_URL}/api/health`)).json();
  record('GET /api/health responds', health.ok === true, `runtime=${health.runtime}`);
  record('upstream is enabled', health.upstream.disabled === false);

  // 2. Live catalogue retrieval
  const start = Date.now();
  const gp = await (await fetch(`${BASE_URL}/api/gp?group=stations`)).json();
  const elapsedMs = Date.now() - start;
  record('GET /api/gp?group=stations returns records', gp.recordCount > 0, `${gp.recordCount} records in ${elapsedMs} ms`);
  record(
    'data state is LIVE (CelesTrak reachable within freshness window)',
    gp.state === 'live',
    `state=${gp.state}; if this says "snapshot", the host running the API cannot reach celestrak.org — ` +
      `note: ${gp.provenance.note}`,
  );
  record('provenance says source=celestrak', gp.provenance.source === 'celestrak', gp.provenance.source);
  const retrievedAt = Date.parse(gp.provenance.retrievedAt);
  record(
    'retrieval timestamp is recent (< 2 h)',
    Number.isFinite(retrievedAt) && Date.now() - retrievedAt < 2 * 3600 * 1000,
    gp.provenance.retrievedAt,
  );

  // 3. Cross-check a known object: ISS (ZARYA), NORAD 25544.
  const iss = gp.records.find((r) => Number(r.NORAD_CAT_ID) === 25544);
  record('ISS (NORAD 25544) is present in the catalogue', Boolean(iss), iss?.OBJECT_NAME);
  if (iss) {
    record('ISS name is recognisable', /ISS/i.test(iss.OBJECT_NAME), iss.OBJECT_NAME);
    record(
      'ISS element epoch is within 3 days (CelesTrak stations freshness)',
      Math.abs(Date.now() - Date.parse(iss.EPOCH)) < 3 * 86400_000,
      iss.EPOCH,
    );
    record(
      'ISS mean motion is physically plausible (15.4–15.6 rev/day)',
      iss.MEAN_MOTION > 15.4 && iss.MEAN_MOTION < 15.6,
      String(iss.MEAN_MOTION),
    );
  }

  // 4. Epoch range reported in provenance matches the payload.
  const epochs = gp.records.map((r) => r.EPOCH).sort();
  const rangeMatches =
    gp.provenance.epochRange &&
    gp.provenance.epochRange.min === epochs[0] &&
    gp.provenance.epochRange.max === epochs[epochs.length - 1];
  record('provenance epochRange matches the payload', Boolean(rangeMatches), JSON.stringify(gp.provenance.epochRange));

  // 5. A second, larger group also comes back live.
  const active = await (await fetch(`${BASE_URL}/api/gp?group=visual`)).json();
  record('second group (visual) also live', active.state === 'live', `state=${active.state}, ${active.recordCount} records`);

  // 6. Validation still enforced.
  const bad = await fetch(`${BASE_URL}/api/gp?group=not-a-group`);
  record('unknown group rejected with 400', bad.status === 400);

  // 7. Freshness metadata honesty: the health endpoint agrees with the payloads.
  const health2 = await (await fetch(`${BASE_URL}/api/health`)).json();
  const stationsStatus = health2.groups.find((g) => g.id === 'stations');
  record('health reports the same live state for the group', stationsStatus?.state === 'live', stationsStatus?.state);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n=== ${checks.length - failed.length}/${checks.length} live checks passed ===`);
  if (failed.length > 0) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log('\nLive data path verified against genuine CelesTrak.');
  }
}

main().catch((err) => {
  console.error('verify-live failed to run:', err);
  process.exit(1);
});
