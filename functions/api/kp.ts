/**
 * GET /api/kp
 *
 * Latest NOAA Space Weather Prediction Center planetary Kp measurements
 * (https://www.swpc.noaa.gov/), proxied with a short edge cache. Returns the
 * recent 3-hourly Kp series plus honest retrieval metadata.
 *
 * Status codes:
 *   200  measurements returned
 *   429  rate limited
 *   502  NOAA unreachable or returned an unusable payload
 */
import { checkRateLimit, clientKey } from './_lib/ratelimit';
import { fetchProxiedJson } from './_lib/proxy';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

const NOAA_KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
const CACHE_MAX_AGE_MS = 15 * 60_000;
const TIMEOUT_MS = 6000;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

export interface KpSample {
  /** ISO-8601 UTC timestamp of the 3-hour interval start. */
  time: string;
  /** Planetary Kp index, 0–9. */
  kp: number;
}

/**
 * Parse the NOAA Kp JSON feed. The feed is an array whose first row is a
 * header (["time_tag","kp",...]) followed by data rows. Rows that do not
 * parse are skipped; null means the whole payload is unusable.
 */
export function parseKpFeed(body: string): KpSample[] | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(payload) || payload.length < 2) return null;
  const samples: KpSample[] = [];
  for (let i = 1; i < payload.length; i++) {
    const row = payload[i];
    if (!Array.isArray(row) || row.length < 2) continue;
    const timeRaw = row[0];
    const kpRaw = row[1];
    if (typeof timeRaw !== 'string') continue;
    const kp = typeof kpRaw === 'number' ? kpRaw : Number(kpRaw);
    const ms = Date.parse(timeRaw.endsWith('Z') ? timeRaw.replace(' ', 'T') : `${timeRaw.replace(' ', 'T')}Z`);
    if (!Number.isFinite(ms) || !Number.isFinite(kp)) continue;
    if (kp < 0 || kp > 9) continue;
    samples.push({ time: new Date(ms).toISOString(), kp });
  }
  if (samples.length === 0) return null;
  samples.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return samples;
}

export const onRequestGet: PagesFunction = async (context) => {
  const { request } = context;
  const rate = checkRateLimit(clientKey(request), Date.now());
  if (!rate.allowed) {
    return json(
      {
        ok: false,
        error: {
          code: 'rate-limited',
          message: 'Too many requests from this client.',
          hint: `Retry in ${rate.retryAfterSeconds} seconds.`,
        },
      },
      429,
    );
  }

  const result = await fetchProxiedJson({
    cacheKey: 'kp/planetary',
    url: NOAA_KP_URL,
    allowedPrefixes: ['https://services.swpc.noaa.gov/products/'],
    maxAgeMs: CACHE_MAX_AGE_MS,
    timeoutMs: TIMEOUT_MS,
  });
  if (!result.ok) {
    return json(
      {
        ok: false,
        error: {
          code: 'upstream-failure',
          message: 'NOAA space-weather data is currently unavailable.',
          hint: result.error,
        },
      },
      result.status,
    );
  }

  const samples = parseKpFeed(result.body);
  if (!samples) {
    return json(
      {
        ok: false,
        error: {
          code: 'upstream-failure',
          message: 'NOAA returned an unusable Kp response.',
        },
      },
      502,
    );
  }

  return json(
    {
      retrievedAt: result.retrievedAt,
      servedFromCache: result.servedFromCache,
      source: 'noaa-swpc',
      sourceUrl: 'https://www.swpc.noaa.gov/',
      feedUrl: NOAA_KP_URL,
      samples,
    },
    200,
  );
};

type PagesFunction<Env = unknown> = (context: {
  request: Request;
  env: Env;
  params: Record<string, string>;
  waitUntil: (promise: Promise<unknown>) => void;
  next: () => Promise<Response>;
}) => Response | Promise<Response>;
