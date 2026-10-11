/**
 * Backend service tests.
 *
 * Deterministic mocks are used for the upstream and the clock so every failure
 * mode can be exercised: cache miss, fresh cache, stale cache, failed refresh
 * with valid prior data, invalid payloads, timeouts, and concurrent requests.
 * These tests prove the *behaviour contract* of the service; a separate manual
 * procedure in docs/TESTING.md covers the live CelesTrak path, which cannot run
 * in an offline sandbox.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { getCatalog, getHealth, type ServiceContext } from '../functions/api/_lib/service';
import { createMemoryCache, type CachedPayload } from '../functions/api/_lib/cache';
import { createUpstreamClient, type UpstreamClient } from '../functions/api/_lib/upstream';
import type { AssetLoader } from '../functions/api/_lib/snapshot';
import { checkRateLimit, resetRateLimits } from '../functions/api/_lib/ratelimit';
import { isKnownGroup, upstreamGpUrl, ALL_GROUPS } from '../functions/api/_lib/groups';
import { validateGpPayload } from '../functions/api/_lib/validate';
import freshness from '../shared/freshness.json';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Asset loader backed by the committed snapshot. The runtime serves the
 * snapshot at `/snapshot/…` (copied there by the build); on disk it lives in
 * `data/snapshot/…`, so the mapping happens here exactly as the build does.
 */
const fileAssets: AssetLoader = async (assetPath) => {
  const mapped = assetPath.replace(/^\/snapshot\//, 'data/snapshot/');
  try {
    return await readFile(path.join(ROOT, mapped), 'utf8');
  } catch {
    return null;
  }
};

interface FakeUpstreamOptions {
  status?: number;
  body?: string;
  delayMs?: number;
  throwMessage?: string;
}

function fakeFetch(options: FakeUpstreamOptions = {}): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (options.delayMs) {
      // Honour AbortSignal like a real fetch, so timeout tests are genuine.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), options.delayMs);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          },
          { once: true },
        );
      });
    }
    if (options.throwMessage) throw new Error(options.throwMessage);
    return new Response(options.body ?? '[]', {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const validBody = JSON.stringify([
  {
    OBJECT_NAME: 'TEST SAT',
    OBJECT_ID: '2024-001A',
    EPOCH: '2026-10-10T00:00:00.000000',
    MEAN_MOTION: 15.5,
    ECCENTRICITY: 0.001,
    INCLINATION: 51.6,
    RA_OF_ASC_NODE: 100,
    ARG_OF_PERICENTER: 20,
    MEAN_ANOMALY: 30,
    NORAD_CAT_ID: 90000,
    BSTAR: 0.0001,
    MEAN_MOTION_DOT: 0.00001,
    MEAN_MOTION_DDOT: 0,
    ELEMENT_SET_NO: 999,
  },
]);

interface MakeContextOptions {
  fetchImpl?: typeof fetch;
  nowMs?: number;
  cache?: ReturnType<typeof createMemoryCache>;
  disabled?: boolean;
  timeoutMs?: number;
}

function makeContext(options: MakeContextOptions = {}): ServiceContext & { upstream: UpstreamClient } {
  const upstream = createUpstreamClient({
    baseUrl: 'https://celestrak.org',
    timeoutMs: options.timeoutMs ?? 1000,
    disabled: options.disabled ?? false,
    fetchImpl: options.fetchImpl ?? (fakeFetch({ body: validBody }).fetchImpl),
    sleep: async () => {},
  });
  return {
    assets: fileAssets,
    cache: options.cache ?? createMemoryCache(),
    upstream,
    freshness,
    runtime: 'test',
    now: () => options.nowMs ?? Date.now(),
  };
}

function seedCache(
  group: string,
  retrievedAt: string,
  body = validBody,
): CachedPayload {
  return {
    body,
    retrievedAt,
    sha256: 'deadbeef',
    epochRange: { min: '2026-10-10T00:00:00.000000', max: '2026-10-10T00:00:00.000000' },
    source: 'celestrak',
    group,
  };
}

const NOW = Date.parse('2026-10-10T12:00:00Z');
const HOUR = 3_600_000;

describe('group allowlist and upstream URL construction', () => {
  it('knows only the registered groups', () => {
    expect(isKnownGroup('stations')).toBe(true);
    expect(isKnownGroup('active')).toBe(true);
    expect(isKnownGroup('../../etc/passwd')).toBe(false);
    expect(isKnownGroup('cosmos-1408-debris')).toBe(false); // not reintroduced
    expect(isKnownGroup('')).toBe(false);
  });

  it('builds fixed upstream URLs — no open proxy', () => {
    expect(upstreamGpUrl('https://celestrak.org', 'stations')).toBe(
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json',
    );
    // Even a hostile group id cannot escape the endpoint.
    const url = upstreamGpUrl('https://celestrak.org/', 'a&b=c');
    expect(url).toBe('https://celestrak.org/NORAD/elements/gp.php?GROUP=a%26b%3Dc&FORMAT=json');
  });

  it('registers every group the snapshot bundles', () => {
    const bundled = ALL_GROUPS.filter((g) => g.bundle).map((g) => g.id);
    expect(bundled).toContain('stations');
    expect(bundled).toContain('active');
  });
});

describe('upstream payload validation', () => {
  it('accepts a genuine GP payload and reports the epoch range', () => {
    const result = validateGpPayload(validBody);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records).toHaveLength(1);
      expect(result.epochRange.min).toBe('2026-10-10T00:00:00.000000');
    }
  });

  it('rejects HTML error pages, invalid JSON, empty arrays and bad fields', () => {
    expect(validateGpPayload('<html>503</html>').ok).toBe(false);
    expect(validateGpPayload('not json').ok).toBe(false);
    expect(validateGpPayload('{"OBJECT_NAME":"x"}').ok).toBe(false);
    expect(validateGpPayload('[]').ok).toBe(false);
    expect(validateGpPayload(JSON.stringify([{ OBJECT_NAME: 'x' }])).ok).toBe(false);
    expect(
      validateGpPayload(JSON.stringify([{ ...JSON.parse(validBody)[0], ECCENTRICITY: 1.5 }])).ok,
    ).toBe(false);
    expect(
      validateGpPayload(JSON.stringify([{ ...JSON.parse(validBody)[0], MEAN_MOTION: -3 }])).ok,
    ).toBe(false);
    expect(validateGpPayload(JSON.stringify([{ ...JSON.parse(validBody)[0], EPOCH: '???'}])).ok).toBe(false);
  });
});

describe('getCatalog — success paths', () => {
  it('returns live records with honest provenance on a successful fetch', async () => {
    const ctx = makeContext();
    const result = await getCatalog(ctx, 'stations');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.httpStatus).toBe(200);
    expect(result.response.state).toBe('live');
    expect(result.response.recordCount).toBe(1);
    expect(result.response.provenance.source).toBe('celestrak');
    expect(result.response.provenance.provider).toBe('CelesTrak');
    expect(result.response.provenance.retrievedAt).toBeTruthy();
    expect(result.response.provenance.ageSeconds).toBe(0);
    expect(result.response.provenance.degraded).toBe(false);
    expect(result.response.provenance.note).toMatch(/CelesTrak/);
  });

  it('serves a fresh cache without calling the upstream (2 h policy)', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: validBody });
    const cache = createMemoryCache();
    cache.put('stations', seedCache('stations', new Date(NOW - 30 * 60_000).toISOString()));
    const ctx = makeContext({ fetchImpl, cache, nowMs: NOW });
    const result = await getCatalog(ctx, 'stations');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.response.state).toBe('live');
    expect(calls).toHaveLength(0);
  });

  it('marks a 5-hour-old cache as cached, and a 2-day-old cache as stale', async () => {
    // A refresh is attempted for any cache older than 2 h. With the upstream
    // unavailable, the genuine cached payload is served and labelled by age.
    const failing = () => fakeFetch({ status: 503 }).fetchImpl;

    const cache5h = createMemoryCache();
    cache5h.put('stations', seedCache('stations', new Date(NOW - 5 * HOUR).toISOString()));
    const cached = await getCatalog(makeContext({ cache: cache5h, nowMs: NOW, fetchImpl: failing() }), 'stations');
    expect(cached.ok && cached.response.state).toBe('cached');
    if (cached.ok) expect(cached.response.provenance.degraded).toBe(true);

    const cache2d = createMemoryCache();
    cache2d.put('stations', seedCache('stations', new Date(NOW - 50 * HOUR).toISOString()));
    const stale = await getCatalog(makeContext({ cache: cache2d, nowMs: NOW, fetchImpl: failing() }), 'stations');
    expect(stale.ok && stale.response.state).toBe('stale');
    if (stale.ok) {
      expect(stale.response.provenance.ageSeconds).toBeGreaterThan(24 * 3600 - 60);
      expect(stale.response.provenance.note).toMatch(/older than/i);
    }

    // With a *working* upstream, an old cache is refreshed and reported live —
    // the label always reflects the newest genuine data actually served.
    const cache5hB = createMemoryCache();
    cache5hB.put('stations', seedCache('stations', new Date(NOW - 5 * HOUR).toISOString()));
    const refreshed = await getCatalog(makeContext({ cache: cache5hB, nowMs: NOW }), 'stations');
    expect(refreshed.ok && refreshed.response.state).toBe('live');
  });
});

describe('getCatalog — failure paths', () => {
  it('rejects unknown groups with a helpful message', async () => {
    const result = await getCatalog(makeContext(), 'definitely-not-a-group');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.httpStatus).toBe(400);
    expect(result.error.error.code).toBe('unknown-group');
    expect(result.error.error.hint).toContain('stations');
  });

  it('keeps serving genuine cached data when the refresh fails', async () => {
    const cache = createMemoryCache();
    cache.put('stations', seedCache('stations', new Date(NOW - 3 * HOUR).toISOString()));
    const ctx = makeContext({
      cache,
      nowMs: NOW,
      fetchImpl: fakeFetch({ status: 503, body: 'Service Unavailable' }).fetchImpl,
    });
    const result = await getCatalog(ctx, 'stations');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.httpStatus).toBe(200);
    expect(result.response.state).toBe('cached');
    expect(result.response.provenance.degraded).toBe(true);
    expect(result.response.provenance.note).toMatch(/refresh failed/i);
    expect(result.response.recordCount).toBe(1);
  });

  it('falls back to the bundled snapshot, clearly labelled, when upstream and cache are both empty', async () => {
    const ctx = makeContext({
      fetchImpl: fakeFetch({ throwMessage: 'network unreachable' }).fetchImpl,
      nowMs: NOW,
    });
    const result = await getCatalog(ctx, 'stations');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.state).toBe('snapshot');
    expect(result.response.provenance.source).toBe('snapshot');
    expect(result.response.provenance.degraded).toBe(true);
    expect(result.response.provenance.retrievedAt).toBeTruthy(); // real capture time
    expect(result.response.provenance.note).toMatch(/snapshot/i);
    expect(result.response.provenance.note).toMatch(/not live/i);
    expect(result.response.recordCount).toBeGreaterThan(0);
  });

  it('rejects invalid upstream payloads instead of serving them', async () => {
    const cache = createMemoryCache();
    cache.put('stations', seedCache('stations', new Date(NOW - 3 * HOUR).toISOString()));
    const ctx = makeContext({
      cache,
      nowMs: NOW,
      fetchImpl: fakeFetch({ body: '<html>oops</html>' }).fetchImpl,
    });
    const result = await getCatalog(ctx, 'stations');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The HTML payload was rejected; the genuine cache was preserved and served.
    expect(result.response.provenance.degraded).toBe(true);
    expect(result.response.provenance.note).toMatch(/rejected/i);
    expect(result.response.provenance.source).toBe('celestrak');
    expect(result.response.recordCount).toBe(1);
  });

  it('returns an honest 502 when nothing genuine is available at all', async () => {
    const ctx = makeContext({
      fetchImpl: fakeFetch({ status: 500 }).fetchImpl,
      nowMs: NOW,
    });
    // 'gps-ops' is not bundled offline: no cache + no snapshot = honest failure.
    const result = await getCatalog(ctx, 'gps-ops');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.httpStatus).toBe(502);
    expect(result.error.error.code).toBe('upstream-failure');
    expect(result.error.error.message).toMatch(/no offline data/i);
  });

  it('times out a hanging upstream and falls back to the snapshot', async () => {
    const ctx = makeContext({
      timeoutMs: 20,
      fetchImpl: fakeFetch({ delayMs: 500, body: validBody }).fetchImpl,
      nowMs: NOW,
    });
    const result = await getCatalog(ctx, 'stations');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.state).toBe('snapshot');
      expect(result.response.provenance.note).toMatch(/timed out/i);
    }
  });

  it('honours UPSTREAM_DISABLED as explicit configuration, not a silent fallback', async () => {
    const ctx = makeContext({ disabled: true, nowMs: NOW });
    const result = await getCatalog(ctx, 'stations');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.state).toBe('snapshot');
      expect(result.response.provenance.note).toMatch(/disabled by configuration/i);
    }
  });

  it('coalesces concurrent requests for the same group into one upstream fetch', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: validBody, delayMs: 30 });
    const ctx = makeContext({ fetchImpl });
    const [a, b, c] = await Promise.all([
      getCatalog(ctx, 'stations'),
      getCatalog(ctx, 'stations'),
      getCatalog(ctx, 'stations'),
    ]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('upstream client behaviour', () => {
  it('retries once after a failure, then reports the error', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 500 });
    const client = createUpstreamClient({
      baseUrl: 'https://celestrak.org',
      timeoutMs: 500,
      fetchImpl,
      sleep: async () => {},
    });
    const result = await client.fetchGroup('stations');
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(2); // initial attempt + one retry
    const telemetry = client.telemetry();
    expect(telemetry.lastError).toMatch(/HTTP 500/);
    expect(telemetry.lastAttemptAt).toBeTruthy();
  });

  it('records success telemetry and clears the error', async () => {
    const client = createUpstreamClient({
      baseUrl: 'https://celestrak.org',
      timeoutMs: 500,
      fetchImpl: fakeFetch({ body: validBody }).fetchImpl,
      sleep: async () => {},
    });
    await client.fetchGroup('stations');
    expect(client.telemetry().lastSuccessAt).toBeTruthy();
    expect(client.telemetry().lastError).toBeNull();
  });
});

describe('rate limiting', () => {
  beforeEach(() => resetRateLimits());

  it('allows the configured budget and then blocks with a retry hint', () => {
    const now = 1_000_000;
    for (let i = 0; i < 10; i += 1) {
      expect(checkRateLimit('ip-a', now + i, 10, 60_000).allowed).toBe(true);
    }
    const blocked = checkRateLimit('ip-a', now + 10, 10, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    // A different client is unaffected.
    expect(checkRateLimit('ip-b', now + 10, 10, 60_000).allowed).toBe(true);
  });
});

describe('getHealth', () => {
  it('reports structured health with per-group states derived from real metadata', async () => {
    const cache = createMemoryCache();
    cache.put('stations', seedCache('stations', new Date(NOW - HOUR).toISOString()));
    const ctx = makeContext({ cache, nowMs: NOW });
    const health = await getHealth(ctx);

    expect(health.ok).toBe(true);
    expect(health.provider).toBe('CelesTrak');
    expect(health.freshness.liveMs).toBe(7_200_000);
    expect(health.upstream.timeoutMs).toBeGreaterThan(0);
    expect(health.snapshot.generatedAt).toBeTruthy();

    const stations = health.groups.find((g) => g.id === 'stations');
    expect(stations?.state).toBe('live');
    expect(stations?.recordCount).toBe(1);
    expect(stations?.source).toBe('celestrak');

    // A group with no cache falls back to snapshot state with the real capture time.
    const visual = health.groups.find((g) => g.id === 'visual');
    expect(visual?.state).toBe('snapshot');
    expect(visual?.retrievedAt).toBeTruthy();
    expect(visual?.source).toBe('snapshot');

    // A non-bundled group with no cache is honestly unavailable.
    const gps = health.groups.find((g) => g.id === 'gps-ops');
    expect(gps?.state).toBe('unavailable');
    expect(gps?.note).toMatch(/requires CelesTrak/i);
  });
});

describe('snapshot integrity', () => {
  it('serves snapshot records whose manifest metadata matches the fixture file', async () => {
    const ctx = makeContext({ fetchImpl: fakeFetch({ throwMessage: 'offline' }).fetchImpl, nowMs: NOW });
    const result = await getCatalog(ctx, 'stations');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const provenance = result.response.provenance;
    const manifest = JSON.parse(await readFile(path.join(ROOT, 'data/snapshot/manifest.json'), 'utf8'));
    const entry = manifest.groups.stations;
    expect(provenance.payloadSha256).toBe(entry.sha256);
    expect(provenance.retrievedAt).toBe(entry.capturedAt);
    expect(provenance.recordCount).toBe(entry.recordCount);
  });

  it('never mixes snapshot records into a live payload', async () => {
    const ctx = makeContext();
    const result = await getCatalog(ctx, 'stations');
    if (!result.ok) throw new Error('expected success');
    const liveCount = result.response.recordCount;
    expect(liveCount).toBe(1); // exactly the mocked upstream record
    const names = (result.response.records as Array<{ OBJECT_NAME: string }>).map((r) => r.OBJECT_NAME);
    expect(names).toEqual(['TEST SAT']);
  });
});
