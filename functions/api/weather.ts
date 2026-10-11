/**
 * GET /api/weather?lat=<deg>&lon=<deg>
 *
 * Cloud-cover forecast context for a chosen observer, via the Open-Meteo
 * forecast API (https://open-meteo.com/). Returns hourly cloud cover for the
 * next ~48 h plus honest retrieval metadata.
 *
 * Status codes:
 *   200  forecast returned (possibly served from the short edge cache)
 *   400  missing or out-of-range `lat`/`lon`
 *   429  rate limited
 *   502  Open-Meteo unreachable or returned an unusable payload
 */
import { checkRateLimit, clientKey } from './_lib/ratelimit';
import { fetchProxiedJson } from './_lib/proxy';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

const OPEN_METEO_PREFIX = 'https://api.open-meteo.com/v1/forecast';
const CACHE_MAX_AGE_MS = 30 * 60_000;
const TIMEOUT_MS = 6000;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

interface OpenMeteoHourly {
  time?: unknown;
  cloud_cover?: unknown;
}

interface OpenMeteoPayload {
  latitude?: unknown;
  longitude?: unknown;
  timezone?: unknown;
  hourly?: OpenMeteoHourly;
}

export interface WeatherHour {
  /** ISO-8601 UTC hour stamp. */
  time: string;
  /** Total cloud cover, 0–100 %. */
  cloudCoverPercent: number;
}

export function parseForecast(body: string): WeatherHour[] | null {
  let payload: OpenMeteoPayload;
  try {
    payload = JSON.parse(body) as OpenMeteoPayload;
  } catch {
    return null;
  }
  const times = payload.hourly?.time;
  const clouds = payload.hourly?.cloud_cover;
  if (!Array.isArray(times) || !Array.isArray(clouds)) return null;
  const hours: WeatherHour[] = [];
  const count = Math.min(times.length, clouds.length, 72);
  for (let i = 0; i < count; i++) {
    const time = times[i];
    const cloud = typeof clouds[i] === 'number' ? (clouds[i] as number) : NaN;
    if (typeof time !== 'string' || !Number.isFinite(cloud)) continue;
    const ms = Date.parse(time.endsWith('Z') ? time : `${time}Z`);
    if (!Number.isFinite(ms)) continue;
    hours.push({
      time: new Date(ms).toISOString(),
      cloudCoverPercent: Math.max(0, Math.min(100, cloud)),
    });
  }
  return hours.length > 0 ? hours : null;
}

export const onRequestGet: PagesFunction = async (context) => {
  const { request } = context;
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return json(
      {
        ok: false,
        error: {
          code: 'bad-request',
          message: 'Query parameter "lat" must be a number between −90 and 90.',
          hint: 'Example: /api/weather?lat=40.357&lon=-74.667',
        },
      },
      400,
    );
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return json(
      {
        ok: false,
        error: {
          code: 'bad-request',
          message: 'Query parameter "lon" must be a number between −180 and 180.',
        },
      },
      400,
    );
  }

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

  // Round to ~1 km so the cache key space stays bounded.
  const rlat = lat.toFixed(2);
  const rlon = lon.toFixed(2);
  const upstreamUrl =
    `${OPEN_METEO_PREFIX}?latitude=${encodeURIComponent(rlat)}` +
    `&longitude=${encodeURIComponent(rlon)}` +
    `&hourly=cloud_cover&forecast_days=3&timezone=UTC`;

  const result = await fetchProxiedJson({
    cacheKey: `weather/${rlat}/${rlon}`,
    url: upstreamUrl,
    allowedPrefixes: [OPEN_METEO_PREFIX],
    maxAgeMs: CACHE_MAX_AGE_MS,
    timeoutMs: TIMEOUT_MS,
  });
  if (!result.ok) {
    return json(
      {
        ok: false,
        error: {
          code: 'upstream-failure',
          message: 'The cloud-cover forecast is currently unavailable.',
          hint: result.error,
        },
      },
      result.status,
    );
  }

  const hours = parseForecast(result.body);
  if (!hours) {
    return json(
      {
        ok: false,
        error: {
          code: 'upstream-failure',
          message: 'The forecast provider returned an unusable response.',
        },
      },
      502,
    );
  }

  return json(
    {
      latitude: Number(rlat),
      longitude: Number(rlon),
      retrievedAt: result.retrievedAt,
      servedFromCache: result.servedFromCache,
      source: 'open-meteo',
      sourceUrl: 'https://open-meteo.com/',
      hourly: hours,
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
