/**
 * Catalogue service — the orchestration layer used by the Cloudflare Pages
 * Functions (and by the tests, against the same code).
 *
 * DATA STATE MODEL (states are derived from metadata, never hardcoded):
 *
 *   live     payload came from CelesTrak within `liveMs` (2 h)
 *   cached   genuine CelesTrak payload, retrieved between `liveMs` and `cachedMs` ago
 *   stale    genuine CelesTrak payload older than `cachedMs`, still served, clearly marked
 *   snapshot the bundled offline dataset — genuine records, but never current;
 *            used when upstream retrieval is impossible
 *
 * Failure rules:
 *   • A failed upstream refresh never discards valid cached data.
 *   • A failed upstream refresh with no cache falls back to the snapshot with
 *     `state: "snapshot"` and `degraded: true`.
 *   • If the snapshot is also unavailable, the API returns an honest 502 — it
 *     never fabricates records.
 */
import type {
  CatalogProvenance,
  DataState,
  FreshnessPolicy,
  GpResponse,
  GroupStatus,
  HealthResponse,
  ApiError,
} from '../../../shared/contracts';
import { ALL_GROUPS, getGroup, upstreamGpUrl } from './groups';
import { validateGpPayload } from './validate';
import type { CatalogCache } from './cache';
import type { UpstreamClient } from './upstream';
import { loadSnapshotGroup, loadSnapshotManifest, type AssetLoader } from './snapshot';

export interface ServiceContext {
  assets: AssetLoader;
  cache: CatalogCache;
  upstream: UpstreamClient;
  freshness: FreshnessPolicy;
  runtime: string;
  now?: () => number;
}

export type CatalogResult =
  | { ok: true; response: GpResponse; httpStatus: number }
  | { ok: false; error: ApiError; httpStatus: number };

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

function stateForAge(ageSeconds: number, freshness: FreshnessPolicy): DataState {
  const ageMs = ageSeconds * 1000;
  if (ageMs <= freshness.liveMs) return 'live';
  if (ageMs <= freshness.cachedMs) return 'cached';
  return 'stale';
}

function humanAge(ageSeconds: number): string {
  if (ageSeconds < 3600) return `${Math.max(1, Math.round(ageSeconds / 60))} min old`;
  if (ageSeconds < 86400) return `${(ageSeconds / 3600).toFixed(1)} h old`;
  return `${(ageSeconds / 86400).toFixed(1)} days old`;
}

export async function getCatalog(ctx: ServiceContext, group: string): Promise<CatalogResult> {
  const nowMs = (ctx.now ?? Date.now)();
  const definition = getGroup(group);
  if (!definition) {
    return {
      ok: false,
      httpStatus: 400,
      error: {
        ok: false,
        error: {
          code: 'unknown-group',
          message: `Unknown catalogue group "${group}".`,
          hint: `Supported groups: ${ALL_GROUPS.map((g) => g.id).join(', ')}.`,
        },
      },
    };
  }

  const cached = await ctx.cache.get(group);
  const cachedAgeSeconds = cached ? (nowMs - Date.parse(cached.retrievedAt)) / 1000 : null;

  // Serve a recent cache without touching the upstream at all: CelesTrak asks
  // consumers to fetch each group at most once every two hours.
  const cacheIsRecentEnough =
    cached !== null &&
    cachedAgeSeconds !== null &&
    cachedAgeSeconds >= 0 &&
    cachedAgeSeconds * 1000 <= ctx.freshness.refreshIntervalMs;

  if (!cacheIsRecentEnough) {
    const result = await ctx.upstream.fetchGroup(group);
    if (result.ok) {
      const check = validateGpPayload(result.text);
      if (check.ok) {
        const payload = {
          body: result.text,
          retrievedAt: result.retrievedAt,
          sha256: await sha256(result.text),
          epochRange: check.epochRange,
          source: 'celestrak' as const,
          group,
        };
        await ctx.cache.put(group, payload);
        const provenance: CatalogProvenance & { payloadSha256: string } = {
          group,
          state: 'live',
          source: 'celestrak',
          sourceUrl: upstreamGpUrl(ctx.upstream.baseUrl, group),
          provider: 'CelesTrak',
          retrievedAt: payload.retrievedAt,
          ageSeconds: 0,
          degraded: false,
          note: 'Retrieved from CelesTrak on this request.',
          epochRange: payload.epochRange,
          recordCount: check.records.length,
          payloadSha256: payload.sha256,
        };
        return {
          ok: true,
          httpStatus: 200,
          response: {
            group,
            state: 'live',
            provenance,
            recordCount: check.records.length,
            records: JSON.parse(payload.body) as unknown[],
          },
        };
      }
      // Upstream answered, but with unusable data: fall through to cached or
      // snapshot, and say exactly what was wrong with it.
      const reason = check.reason;
      if (!cached) return fallbackToSnapshot(ctx, group, nowMs, `CelesTrak payload rejected: ${reason}`);
      return serveCached(ctx, group, cached, cachedAgeSeconds!, true, `CelesTrak payload rejected: ${reason}`);
    }

    // Upstream failed: keep serving genuine prior data where we have it.
    if (cached) {
      return serveCached(ctx, group, cached, cachedAgeSeconds!, true, result.error);
    }
    return fallbackToSnapshot(ctx, group, nowMs, result.error);
  }

  return serveCached(ctx, group, cached!, cachedAgeSeconds!, false, null);
}

function serveCached(
  ctx: ServiceContext,
  group: string,
  cached: { body: string; retrievedAt: string; sha256: string; epochRange: { min: string; max: string } | null },
  ageSeconds: number,
  degraded: boolean,
  upstreamError: string | null,
): CatalogResult {
  const state = stateForAge(ageSeconds, ctx.freshness);
  const records = JSON.parse(cached.body) as unknown[];
  const stalePolicyHours = ctx.freshness.cachedMs / 3_600_000;
  const staleClause =
    state === 'stale'
      ? ` It is older than the ${stalePolicyHours} h cache policy.`
      : '';
  const note = degraded
    ? `Serving the last genuine CelesTrak payload from ${cached.retrievedAt} (${humanAge(ageSeconds)}) because the refresh failed: ${upstreamError}.${staleClause}`
    : `Genuine CelesTrak payload retrieved ${cached.retrievedAt} (${humanAge(ageSeconds)}).${staleClause}`;

  const provenance: CatalogProvenance & { payloadSha256: string } = {
    group,
    state,
    source: 'celestrak',
    sourceUrl: upstreamGpUrl(ctx.upstream.baseUrl, group),
    provider: 'CelesTrak',
    retrievedAt: cached.retrievedAt,
    ageSeconds: Math.round(ageSeconds),
    degraded,
    note,
    epochRange: cached.epochRange,
    recordCount: records.length,
    payloadSha256: cached.sha256,
  };
  return { ok: true, httpStatus: 200, response: { group, state, provenance, recordCount: records.length, records } };
}

async function fallbackToSnapshot(
  ctx: ServiceContext,
  group: string,
  nowMs: number,
  upstreamError: string,
): Promise<CatalogResult> {
  const manifest = await loadSnapshotManifest(ctx.assets);
  const snapshot = manifest ? await loadSnapshotGroup(ctx.assets, manifest, group) : null;
  if (!snapshot) {
    return {
      ok: false,
      httpStatus: 502,
      error: {
        ok: false,
        error: {
          code: 'upstream-failure',
          message: `CelesTrak is unreachable and no offline data is available for group "${group}".`,
          hint: 'No records were invented. Try again shortly, or choose a group that is bundled offline.',
          details: { group, upstreamError },
        },
      },
    };
  }

  const records = JSON.parse(snapshot.text) as unknown[];
  const capturedAtMs = Date.parse(snapshot.manifest.capturedAt);
  const ageSeconds = Number.isFinite(capturedAtMs) ? (nowMs - capturedAtMs) / 1000 : null;
  const provenance: CatalogProvenance & { payloadSha256: string } = {
    group,
    state: 'snapshot',
    source: 'snapshot',
    sourceUrl: snapshot.manifest.sourceUrl,
    provider: 'CelesTrak',
    retrievedAt: snapshot.manifest.capturedAt,
    ageSeconds: ageSeconds === null ? null : Math.round(ageSeconds),
    degraded: true,
    note:
      `Offline snapshot captured ${snapshot.manifest.capturedAt}` +
      (ageSeconds !== null ? ` (${humanAge(ageSeconds)})` : '') +
      `. CelesTrak could not be reached: ${upstreamError}. These are genuine CelesTrak records, but they are not live.`,
    epochRange: snapshot.manifest.epochRange,
    recordCount: records.length,
    payloadSha256: snapshot.manifest.sha256,
  };
  return {
    ok: true,
    httpStatus: 200,
    response: {
      group,
      state: 'snapshot',
      provenance,
      recordCount: records.length,
      records,
    },
  };
}

export async function getHealth(ctx: ServiceContext): Promise<HealthResponse> {
  const nowMs = (ctx.now ?? Date.now)();
  const manifest = await loadSnapshotManifest(ctx.assets);
  const telemetry = ctx.upstream.telemetry();

  const groups: GroupStatus[] = [];
  for (const definition of ALL_GROUPS) {
    const cached = await ctx.cache.get(definition.id);
    let state: GroupStatus['state'];
    let recordCount: number | null = null;
    let retrievedAt: string | null = null;
    let ageSeconds: number | null = null;
    let epochRange: GroupStatus['epochRange'] = null;
    let source: GroupStatus['source'] = null;
    let note = '';

    if (cached) {
      ageSeconds = Math.round((nowMs - Date.parse(cached.retrievedAt)) / 1000);
      state = stateForAge(ageSeconds, ctx.freshness);
      recordCount = JSON.parse(cached.body).length as number;
      retrievedAt = cached.retrievedAt;
      epochRange = cached.epochRange;
      source = 'celestrak';
      note = `Cached CelesTrak payload, ${humanAge(ageSeconds)}.`;
    } else if (manifest?.groups[definition.id]) {
      const entry = manifest.groups[definition.id];
      state = 'snapshot';
      recordCount = entry.recordCount;
      retrievedAt = entry.capturedAt;
      ageSeconds = Math.round((nowMs - Date.parse(entry.capturedAt)) / 1000);
      epochRange = entry.epochRange;
      source = 'snapshot';
      note = `Bundled snapshot captured ${entry.capturedAt}; no live cache in this data centre.`;
    } else {
      state = 'unavailable';
      note = definition.bundle
        ? 'No cached data and no bundled snapshot entry.'
        : 'Not bundled offline; requires CelesTrak connectivity.';
    }

    groups.push({
      id: definition.id,
      label: definition.label,
      description: definition.description,
      category: definition.category,
      bundled: definition.bundle,
      state,
      recordCount,
      retrievedAt,
      ageSeconds,
      epochRange,
      source,
      note,
    });
  }

  return {
    ok: true,
    service: 'skyline-api',
    runtime: ctx.runtime,
    provider: 'CelesTrak',
    providerUrl: 'https://celestrak.org/NORAD/elements/gp-data-formats.php',
    freshness: ctx.freshness,
    upstream: {
      url: ctx.upstream.baseUrl,
      timeoutMs: ctx.upstream.timeoutMs,
      disabled: ctx.upstream.disabled,
      lastAttemptAt: telemetry.lastAttemptAt,
      lastSuccessAt: telemetry.lastSuccessAt,
      lastError: telemetry.lastError,
    },
    snapshot: {
      generatedAt: manifest?.generatedAt ?? null,
      groups: Object.fromEntries(
        Object.entries(manifest?.groups ?? {}).map(([id, entry]) => [
          id,
          { recordCount: entry.recordCount, capturedAt: entry.capturedAt, sha256: entry.sha256 },
        ]),
      ),
    },
    groups,
    generatedAt: new Date(nowMs).toISOString(),
  };
}
