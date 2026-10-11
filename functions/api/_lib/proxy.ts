/**
 * Small allowlisted JSON proxy helper for Skyline's secondary data sources
 * (Open-Meteo cloud forecasts, NOAA planetary Kp).
 *
 * Guarantees:
 *   • the upstream URL is constructed from fixed allowlisted hosts plus
 *     validated scalar parameters — a client can never turn this endpoint
 *     into an open proxy;
 *   • bounded timeout, no retries (these are advisory data sources; a failure
 *     surfaces as "unavailable", and the caller keeps working without them);
 *   • short Cache API / in-memory caching so repeated page loads do not
 *     hammer the providers.
 */

export interface ProxyCacheEntry {
  body: string;
  retrievedAt: string;
  sourceUrl: string;
}

export interface ProxyCache {
  get(key: string): Promise<ProxyCacheEntry | null>;
  put(key: string, entry: ProxyCacheEntry): Promise<void>;
}

export function createProxyMemoryCache(): ProxyCache {
  const map = new Map<string, ProxyCacheEntry>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async put(key, entry) {
      map.set(key, entry);
    },
  };
}

export function createProxyCacheApiCache(cache: Cache, baseOrigin: string): ProxyCache {
  return {
    async get(key) {
      const match = await cache.match(new URL(`/__skyline-cache/proxy/${key}`, baseOrigin).toString());
      if (!match) return null;
      const retrievedAt = match.headers.get('x-skyline-retrieved-at');
      const sourceUrl = match.headers.get('x-skyline-source-url');
      if (!retrievedAt || !sourceUrl) return null;
      return { body: await match.text(), retrievedAt, sourceUrl };
    },
    async put(key, entry) {
      await cache.put(
        new URL(`/__skyline-cache/proxy/${key}`, baseOrigin).toString(),
        new Response(entry.body, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'x-skyline-retrieved-at': entry.retrievedAt,
            'x-skyline-source-url': entry.sourceUrl,
          },
        }),
      );
    },
  };
}

/** Shared proxy cache for this isolate (Cache API when available). */
let sharedProxyCache: ProxyCache | null = null;

export function proxyCache(): ProxyCache {
  if (!sharedProxyCache) {
    const cacheApi = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
    sharedProxyCache =
      cacheApi != null
        ? createProxyCacheApiCache(cacheApi, 'https://skyline.internal')
        : createProxyMemoryCache();
  }
  return sharedProxyCache;
}

export type ProxyResult =
  | { ok: true; body: string; retrievedAt: string; sourceUrl: string; servedFromCache: boolean }
  | { ok: false; error: string; status: number; sourceUrl: string };

export interface ProxyOptions {
  /** Stable cache key segment (already validated/encoded by the caller). */
  cacheKey: string;
  /** Exact upstream URL. Must start with one of `allowedPrefixes`. */
  url: string;
  allowedPrefixes: string[];
  /** Freshness window for the cached entry, ms. */
  maxAgeMs: number;
  /** Upstream timeout, ms. */
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  cache?: ProxyCache;
  nowMs?: number;
}

/**
 * Fetch an allowlisted JSON document with caching. Returns the cached entry
 * when fresh; otherwise attempts one upstream fetch and caches success.
 * Failures never throw and never synthesise a body.
 */
export async function fetchProxiedJson(options: ProxyOptions): Promise<ProxyResult> {
  const nowMs = options.nowMs ?? Date.now();
  const cache = options.cache ?? proxyCache();

  if (!options.allowedPrefixes.some((prefix) => options.url.startsWith(prefix))) {
    return { ok: false, error: 'Upstream URL is not allowlisted.', status: 500, sourceUrl: options.url };
  }

  const cached = await cache.get(options.cacheKey);
  if (cached) {
    const ageMs = nowMs - Date.parse(cached.retrievedAt);
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= options.maxAgeMs) {
      return {
        ok: true,
        body: cached.body,
        retrievedAt: cached.retrievedAt,
        sourceUrl: cached.sourceUrl,
        servedFromCache: true,
      };
    }
  }

  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(options.url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'Skyline/1.0 (+https://github.com/akulbajpai-code/SkyLine)',
      },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      return {
        ok: false,
        error: `Upstream responded HTTP ${response.status}.`,
        status: 502,
        sourceUrl: options.url,
      };
    }
    const body = await response.text();
    const retrievedAt = new Date(nowMs).toISOString();
    await cache.put(options.cacheKey, { body, retrievedAt, sourceUrl: options.url });
    return { ok: true, body, retrievedAt, sourceUrl: options.url, servedFromCache: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = /timeout|abort/i.test(message)
      ? `Upstream request timed out after ${options.timeoutMs} ms.`
      : `Upstream request failed: ${message}`;
    return { ok: false, error, status: 502, sourceUrl: options.url };
  }
}
