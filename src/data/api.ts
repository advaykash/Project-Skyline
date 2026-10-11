/**
 * API client for the same-origin OrbitWatch API.
 *
 * Everything the interface displays about data provenance comes from these
 * responses — the client never guesses freshness and never labels anything
 * "live" on its own.
 *
 * When the server can only answer from the bundled offline snapshot, the client
 * makes one browser-direct attempt against CelesTrak itself. The published GP
 * endpoint allows cross-origin reads, so a laptop on a working network can still
 * show live elements even when the deployed runtime cannot reach CelesTrak. That
 * upgrade is only ever reported as `live` when the request really succeeded and
 * the records really came from CelesTrak; otherwise the snapshot response — with
 * its own, honest provenance — is returned untouched.
 */
import type { CatalogProvenance, GpResponse, HealthResponse, ApiError } from '../../shared/contracts';
import { parseEpochMs, validateGpRecord } from '../orbital/elements';
import type { GpRecord } from '../orbital/types';

export class ApiRequestError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly status: number;

  constructor(message: string, options: { code: string; hint?: string; status: number }) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = options.code;
    this.hint = options.hint;
    this.status = options.status;
  }
}

async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { accept: 'application/json' },
      signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiRequestError('The application API could not be reached.', {
      code: 'network',
      hint: 'Check that the API process is running, then retry.',
      status: 0,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError('The application API returned a malformed response.', {
      code: 'malformed',
      status: response.status,
    });
  }

  if (!response.ok) {
    const error = (payload as ApiError).error;
    throw new ApiRequestError(error?.message ?? `Request failed with HTTP ${response.status}.`, {
      code: error?.code ?? 'http-error',
      hint: error?.hint,
      status: response.status,
    });
  }
  return payload as T;
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return requestJson<HealthResponse>('/api/health', signal);
}

/** The published CelesTrak GP endpoint, used by the browser-direct fallback. */
export const CELESTRAK_GP_ENDPOINT = 'https://celestrak.org/NORAD/elements/gp.php';

export function celestrakDirectUrl(group: string): string {
  return `${CELESTRAK_GP_ENDPOINT}?GROUP=${encodeURIComponent(group)}&FORMAT=json`;
}

/** Hard cap on the browser-direct attempt, so a blackholed connection cannot
 *  hold up the catalogue the server already returned. */
const DIRECT_FETCH_TIMEOUT_MS = 5_000;

/**
 * An abort signal that fires on the caller's signal or after `timeoutMs`,
 * whichever comes first. Implemented explicitly rather than with
 * `AbortSignal.any`/`AbortSignal.timeout` so older browsers keep working.
 */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forward);
  }
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    },
  };
}

/**
 * Verify and trim a browser-direct CelesTrak payload into catalogue records.
 * Records that fail the same validation the backend applies are dropped, never
 * repaired; an empty result means "no usable live data" and the caller keeps the
 * snapshot.
 */
function pickValidRecords(payload: unknown): GpRecord[] {
  if (!Array.isArray(payload)) return [];
  const records: GpRecord[] = [];
  for (const raw of payload) {
    const check = validateGpRecord(raw);
    if (check.ok) records.push(check.record);
  }
  return records;
}

function epochRangeOf(records: GpRecord[]): { min: string; max: string } | null {
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    const ms = parseEpochMs(String(record.EPOCH));
    if (!Number.isFinite(ms)) continue;
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return null;
  return { min: new Date(minMs).toISOString(), max: new Date(maxMs).toISOString() };
}

/**
 * One browser-direct attempt at CelesTrak. Returns null — never throwing, never
 * inventing records — when the network, CORS policy or payload makes it
 * unusable, so the caller can fall back to the API response it already has.
 */
async function fetchCatalogDirectFromCelesTrak(
  group: string,
  signal?: AbortSignal,
): Promise<GpResponse | null> {
  const url = celestrakDirectUrl(group);
  const budget = withTimeout(signal, DIRECT_FETCH_TIMEOUT_MS);
  let payload: unknown;
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: budget.signal,
    });
    if (!response.ok) return null;
    payload = await response.json();
  } catch {
    // Offline, blocked by CORS, timed out or aborted: keep the snapshot.
    return null;
  } finally {
    budget.cleanup();
  }

  const records = pickValidRecords(payload);
  if (records.length === 0) return null;

  const retrievedAt = new Date().toISOString();
  const provenance: CatalogProvenance = {
    group,
    state: 'live',
    source: 'celestrak',
    sourceUrl: url,
    provider: 'CelesTrak',
    retrievedAt,
    ageSeconds: 0,
    degraded: false,
    note: 'Retrieved directly by this browser from CelesTrak; the server had only snapshot data for this group.',
    epochRange: epochRangeOf(records),
    recordCount: records.length,
  };

  return {
    group,
    state: 'live',
    provenance,
    recordCount: records.length,
    records,
  };
}

/**
 * Fetch one catalogue group from the application API. If the API can only serve
 * the bundled snapshot, try CelesTrak directly from the browser first and use
 * those genuinely live records when they arrive.
 */
export async function fetchCatalog(group: string, signal?: AbortSignal): Promise<GpResponse> {
  const response = await requestJson<GpResponse>(`/api/gp?group=${encodeURIComponent(group)}`, signal);
  if (response.state !== 'snapshot') return response;

  const direct = await fetchCatalogDirectFromCelesTrak(group, signal);
  return direct ?? response;
}
