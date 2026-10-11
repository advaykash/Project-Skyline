/**
 * Contracts shared by the Cloudflare Pages Functions, the local development API
 * and the frontend client. One definition — if a field changes here it changes
 * everywhere.
 */

/** Data-provenance state of a served catalogue payload. */
export type DataState = 'live' | 'cached' | 'stale' | 'snapshot';

/** Freshness policy, in milliseconds. Canonical values live in shared/freshness.json. */
export interface FreshnessPolicy {
  liveMs: number;
  cachedMs: number;
  refreshIntervalMs: number;
  upstreamTimeoutMs: number;
  note: string;
}

/** Metadata describing how a catalogue payload was obtained. */
export interface CatalogProvenance {
  group: string;
  state: DataState;
  /** Where the records came from: the CelesTrak endpoint or the bundled snapshot. */
  source: 'celestrak' | 'snapshot';
  sourceUrl: string;
  provider: 'CelesTrak';
  /** When this payload was retrieved from the provider (ISO-8601), if known. */
  retrievedAt: string | null;
  /** Age of the payload in seconds at response time. */
  ageSeconds: number | null;
  /** True when an upstream refresh was attempted and failed. */
  degraded: boolean;
  /** Human-readable note about the payload state. */
  note: string;
  /** Element epoch range across the payload (ISO-8601). */
  epochRange: { min: string; max: string } | null;
  recordCount: number;
  /** SHA-256 of the served payload, when known (snapshot or cached retrieval). */
  payloadSha256?: string;
}

export interface GroupStatus {
  id: string;
  label: string;
  description: string;
  category: string;
  /** Whether this group's records are bundled in the offline snapshot. */
  bundled: boolean;
  state: DataState | 'unavailable';
  recordCount: number | null;
  retrievedAt: string | null;
  ageSeconds: number | null;
  epochRange: { min: string; max: string } | null;
  source: 'celestrak' | 'snapshot' | null;
  note: string;
}

export interface HealthResponse {
  ok: true;
  service: 'skyline-api';
  runtime: string;
  provider: 'CelesTrak';
  providerUrl: string;
  freshness: FreshnessPolicy;
  upstream: {
    url: string;
    timeoutMs: number;
    disabled: boolean;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
  };
  snapshot: {
    generatedAt: string | null;
    groups: Record<string, { recordCount: number; capturedAt: string; sha256: string }>;
  };
  groups: GroupStatus[];
  generatedAt: string;
}

export interface GpResponse {
  group: string;
  state: DataState;
  provenance: CatalogProvenance;
  recordCount: number;
  /** Verbatim CelesTrak GP records — never edited, never synthesised. */
  records: unknown[];
}

export interface ApiError {
  ok: false;
  error: {
    code: 'unknown-group' | 'bad-request' | 'upstream-failure' | 'rate-limited' | 'not-found' | 'internal';
    message: string;
    hint?: string;
    details?: Record<string, string | number | null>;
  };
}
