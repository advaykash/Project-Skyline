/**
 * Tests for the secondary data sources: NOAA Kp feed parsing, the allowlisted
 * proxy cache behaviour, and the cloud-cover lookup helper.
 *
 * Fixtures are synthetic *test doubles* shaped like the provider payloads —
 * they never appear as production data.
 */
import { describe, expect, it } from 'vitest';
import { parseKpFeed } from '../functions/api/kp';
import { parseForecast } from '../functions/api/weather';
import {
  createProxyMemoryCache,
  fetchProxiedJson,
} from '../functions/api/_lib/proxy';
import { cloudCoverAt, type WeatherForecast } from '../src/data/weather';

const KP_FEED = JSON.stringify([
  ['time_tag', 'kp', 'observed', 'noaa_scale'],
  ['2026-10-10 00:00:00', '1.33', 'observed', 'G0'],
  ['2026-10-10 03:00:00', '2.00', 'observed', 'G0'],
  ['2026-10-10 06:00:00', '5.33', 'observed', 'G1'],
  ['2026-10-10 09:00:00', 'bogus', 'observed', 'G0'],
  ['not-a-date', '3.00', 'observed', 'G0'],
  ['2026-10-10 12:00:00', '12.00', 'observed', 'G9'],
]);

describe('parseKpFeed', () => {
  it('parses valid rows and skips malformed ones', () => {
    const samples = parseKpFeed(KP_FEED);
    expect(samples).not.toBeNull();
    expect(samples).toHaveLength(3);
    expect(samples![0]).toEqual({ time: '2026-10-10T00:00:00.000Z', kp: 1.33 });
    expect(samples![2]).toEqual({ time: '2026-10-10T06:00:00.000Z', kp: 5.33 });
  });

  it('sorts samples chronologically', () => {
    const reversed = JSON.stringify([
      ['time_tag', 'kp'],
      ['2026-10-10 06:00:00', '2'],
      ['2026-10-10 00:00:00', '1'],
    ]);
    const samples = parseKpFeed(reversed);
    expect(samples!.map((s) => s.time)).toEqual([
      '2026-10-10T00:00:00.000Z',
      '2026-10-10T06:00:00.000Z',
    ]);
  });

  it('rejects unusable payloads with null (never invented values)', () => {
    expect(parseKpFeed('not json')).toBeNull();
    expect(parseKpFeed('{"a":1}')).toBeNull();
    expect(parseKpFeed('[["time_tag","kp"]]')).toBeNull();
    expect(parseKpFeed(JSON.stringify([['time_tag', 'kp'], ['x', 'y']]))).toBeNull();
  });
});

describe('fetchProxiedJson', () => {
  const opts = (fetchImpl: typeof fetch, cache = createProxyMemoryCache(), nowMs = 1_000_000) => ({
    cacheKey: 'test/key',
    url: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
    allowedPrefixes: ['https://services.swpc.noaa.gov/products/'],
    maxAgeMs: 60_000,
    timeoutMs: 1000,
    fetchImpl,
    cache,
    nowMs,
  });

  it('refuses non-allowlisted URLs without fetching', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('{}');
    }) as typeof fetch;
    const result = await fetchProxiedJson({
      ...opts(fetchImpl),
      url: 'https://evil.example.com/data.json',
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it('caches fresh entries and refetches after expiry', async () => {
    let calls = 0;
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ n: ++calls }))) as unknown as typeof fetch;
    const cache = createProxyMemoryCache();
    const first = await fetchProxiedJson(opts(fetchImpl, cache, 1_000_000));
    expect(first.ok && first.servedFromCache).toBe(false);
    const second = await fetchProxiedJson(opts(fetchImpl, cache, 1_030_000));
    expect(second.ok && second.servedFromCache).toBe(true);
    expect(calls).toBe(1);
    const third = await fetchProxiedJson(opts(fetchImpl, cache, 2_000_000));
    expect(third.ok && third.servedFromCache).toBe(false);
    expect(calls).toBe(2);
  });

  it('reports upstream failures without throwing', async () => {
    const failing = (async () => new Response('err', { status: 500 })) as unknown as typeof fetch;
    const result = await fetchProxiedJson(opts(failing));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
  });
});

describe('cloudCoverAt', () => {
  const forecast: WeatherForecast = {
    latitude: 40.36,
    longitude: -74.67,
    retrievedAt: '2026-10-10T00:00:00.000Z',
    servedFromCache: false,
    source: 'open-meteo',
    sourceUrl: 'https://open-meteo.com/',
    hourly: [
      { time: '2026-10-10T00:00:00.000Z', cloudCoverPercent: 10 },
      { time: '2026-10-10T01:00:00.000Z', cloudCoverPercent: 80 },
    ],
  };

  it('returns the nearest hour within tolerance', () => {
    expect(cloudCoverAt(forecast, Date.parse('2026-10-10T00:10:00.000Z'))).toBe(10);
    expect(cloudCoverAt(forecast, Date.parse('2026-10-10T01:20:00.000Z'))).toBe(80);
  });

  it('returns null outside coverage instead of extrapolating', () => {
    expect(cloudCoverAt(forecast, Date.parse('2026-10-11T00:00:00.000Z'))).toBeNull();
  });
});

describe('parseForecast', () => {
  const payload = JSON.stringify({
    latitude: 40.36,
    longitude: -74.67,
    timezone: 'UTC',
    hourly: {
      time: ['2026-10-10T00:00', '2026-10-10T01:00', 'not-a-time'],
      cloud_cover: [12, 88, 50],
    },
  });

  it('parses hourly cloud cover and skips bad rows', () => {
    const hours = parseForecast(payload);
    expect(hours).not.toBeNull();
    expect(hours).toHaveLength(2);
    expect(hours![0]).toEqual({ time: '2026-10-10T00:00:00.000Z', cloudCoverPercent: 12 });
    expect(hours![1]).toEqual({ time: '2026-10-10T01:00:00.000Z', cloudCoverPercent: 88 });
  });

  it('clamps cloud cover into 0–100', () => {
    const hours = parseForecast(
      JSON.stringify({ hourly: { time: ['2026-10-10T00:00'], cloud_cover: [140] } }),
    );
    expect(hours![0].cloudCoverPercent).toBe(100);
  });

  it('rejects unusable payloads with null', () => {
    expect(parseForecast('nope')).toBeNull();
    expect(parseForecast('{"hourly":{}}')).toBeNull();
    expect(parseForecast(JSON.stringify({ hourly: { time: [], cloud_cover: [] } }))).toBeNull();
  });
});
