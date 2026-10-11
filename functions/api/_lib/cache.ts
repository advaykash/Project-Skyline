/**
 * Catalogue cache abstraction.
 *
 * The production implementation uses the Cloudflare Cache API (`caches.default`)
 * with metadata carried in the cached response headers. The test implementation
 * is an in-memory map so failure modes (miss, fresh, stale, failed refresh with
 * prior data) can be exercised deterministically.
 *
 * DOCUMENTED LIMITATION: the Cache API is per-data-centre and best-effort — it
 * is not a distributed lock and does not guarantee global consistency. A cold
 * cache simply means a new upstream fetch, and the bundled snapshot covers the
 * cold-start-upstream-failure case.
 */

export interface CachedPayload {
  /** Verbatim upstream payload (GP JSON text). */
  body: string;
  /** ISO-8601 UTC timestamp of the successful upstream retrieval. */
  retrievedAt: string;
  /** SHA-256 of `body`, recorded so integrity can be reported and audited. */
  sha256: string;
  epochRange: { min: string; max: string } | null;
  source: 'celestrak';
  group: string;
}

export interface CatalogCache {
  get(group: string): Promise<CachedPayload | null>;
  put(group: string, payload: CachedPayload): Promise<void>;
}

const HEADER_PREFIX = 'x-skyline-';

export function createCacheApiCache(cache: Cache, baseOrigin: string): CatalogCache {
  const keyFor = (group: string) => new URL(`/__skyline-cache/gp/${encodeURIComponent(group)}`, baseOrigin).toString();

  return {
    async get(group) {
      const match = await cache.match(keyFor(group));
      if (!match) return null;
      const retrievedAt = match.headers.get(`${HEADER_PREFIX}retrieved-at`);
      const sha256 = match.headers.get(`${HEADER_PREFIX}sha256`);
      const epochMin = match.headers.get(`${HEADER_PREFIX}epoch-min`);
      const epochMax = match.headers.get(`${HEADER_PREFIX}epoch-max`);
      if (!retrievedAt || !sha256) return null;
      return {
        body: await match.text(),
        retrievedAt,
        sha256,
        epochRange: epochMin && epochMax ? { min: epochMin, max: epochMax } : null,
        source: 'celestrak',
        group,
      };
    },
    async put(group, payload) {
      const headers = new Headers({
        'content-type': 'application/json; charset=utf-8',
        [`${HEADER_PREFIX}retrieved-at`]: payload.retrievedAt,
        [`${HEADER_PREFIX}sha256`]: payload.sha256,
        [`${HEADER_PREFIX}group`]: group,
      });
      if (payload.epochRange) {
        headers.set(`${HEADER_PREFIX}epoch-min`, payload.epochRange.min);
        headers.set(`${HEADER_PREFIX}epoch-max`, payload.epochRange.max);
      }
      await cache.put(
        keyFor(group),
        new Response(payload.body, { headers }),
      );
    },
  };
}

/** Deterministic cache used by tests and by runtimes without the Cache API. */
export function createMemoryCache(): CatalogCache {
  const map = new Map<string, CachedPayload>();
  return {
    async get(group) {
      return map.get(group) ?? null;
    },
    async put(group, payload) {
      map.set(group, payload);
    },
  };
}
