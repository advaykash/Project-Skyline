/**
 * Builds the service context for a request inside the Cloudflare Pages runtime.
 *
 * Module-level state (upstream client, cache wrapper) is shared per isolate so
 * request coalescing and telemetry work across requests. Configuration comes
 * from environment bindings only — never from request input.
 */
import freshness from '../../../shared/freshness.json';
import type { FreshnessPolicy } from '../../../shared/contracts';
import { createCacheApiCache, createMemoryCache, type CatalogCache } from './cache';
import { createUpstreamClient, type UpstreamClient } from './upstream';
import type { ServiceContext } from './service';
import type { AssetLoader } from './snapshot';

/** Structural type for the Cloudflare Pages static-asset binding. */
interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface RuntimeEnv {
  ASSETS?: AssetFetcher;
  CELESTRAK_BASE?: string;
  UPSTREAM_TIMEOUT_MS?: string;
  UPSTREAM_DISABLED?: string;
}

const policy: FreshnessPolicy = freshness;

function envFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function envInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Static-asset loader backed by the Pages `ASSETS` binding. */
export function createAssetsLoader(env: RuntimeEnv): AssetLoader {
  return async (path: string) => {
    const assets = env.ASSETS;
    if (!assets) return null;
    try {
      const url = new URL(path, 'https://orbitwatch.pages.dev');
      const response = await assets.fetch(new Request(url.toString()));
      if (!response.ok) return null;
      return await response.text();
    } catch {
      return null;
    }
  };
}

let sharedCache: CatalogCache | null = null;
let sharedUpstream: UpstreamClient | null = null;

export function buildServiceContext(env: RuntimeEnv, overrides?: Partial<ServiceContext>): ServiceContext {
  const baseUrl = (env.CELESTRAK_BASE ?? 'https://celestrak.org').trim() || 'https://celestrak.org';
  const timeoutMs = envInt(env.UPSTREAM_TIMEOUT_MS, policy.upstreamTimeoutMs);
  const disabled = envFlag(env.UPSTREAM_DISABLED);

  if (!sharedCache) {
    // `caches.default` exists in the Workers runtime; fall back to an in-memory
    // map in runtimes without it (the behaviour contract is identical).
    const cacheApi = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
    sharedCache = cacheApi ? createCacheApiCache(cacheApi, 'https://orbitwatch.internal') : createMemoryCache();
  }
  if (!sharedUpstream) {
    sharedUpstream = createUpstreamClient({ baseUrl, timeoutMs, disabled });
  }

  return {
    assets: createAssetsLoader(env),
    cache: sharedCache,
    upstream: sharedUpstream,
    freshness: policy,
    runtime: 'cloudflare-pages-functions',
    ...overrides,
  };
}

export { policy as freshnessPolicy };
