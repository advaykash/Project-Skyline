/**
 * CelesTrak upstream client.
 *
 * Responsibilities:
 *   • bounded request timeout,
 *   • one retry with a short backoff,
 *   • per-isolate request coalescing so concurrent callers share one fetch,
 *   • telemetry (last attempt / success / failure) for the health endpoint,
 *   • explicit, non-leaking error messages.
 *
 * The client can be pointed at a different base URL for integration testing
 * (`CELESTRAK_BASE`), or disabled entirely (`UPSTREAM_DISABLED=1`) so the
 * snapshot-fallback path can be demonstrated without network access. It can
 * never be pointed at an arbitrary user-supplied URL: the base is configuration,
 * not request input.
 */

export type UpstreamResult =
  | { ok: true; text: string; retrievedAt: string; url: string }
  | { ok: false; error: string; url: string };

export interface UpstreamTelemetry {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface UpstreamClient {
  fetchGroup(group: string): Promise<UpstreamResult>;
  telemetry(): UpstreamTelemetry;
  readonly timeoutMs: number;
  readonly disabled: boolean;
  readonly baseUrl: string;
}

export interface UpstreamOptions {
  baseUrl: string;
  timeoutMs: number;
  disabled?: boolean;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to real timers. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createUpstreamClient(options: UpstreamOptions): UpstreamClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? defaultSleep;
  const telemetry: UpstreamTelemetry = { lastAttemptAt: null, lastSuccessAt: null, lastError: null };
  const inflight = new Map<string, Promise<UpstreamResult>>();

  async function attempt(url: string): Promise<UpstreamResult> {
    telemetry.lastAttemptAt = new Date().toISOString();
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          // Identify the consumer per CelesTrak usage policy.
          'user-agent': 'OrbitWatch/1.0 (+https://github.com/akulbajpai-code/SkyLine)',
        },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (!response.ok) {
        const error = `CelesTrak responded HTTP ${response.status}`;
        telemetry.lastError = error;
        return { ok: false, error, url };
      }
      const text = await response.text();
      telemetry.lastSuccessAt = new Date().toISOString();
      telemetry.lastError = null;
      return { ok: true, text, retrievedAt: telemetry.lastSuccessAt, url };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const error = /timeout|abort/i.test(message)
        ? `CelesTrak request timed out after ${options.timeoutMs} ms`
        : `CelesTrak request failed: ${message}`;
      telemetry.lastError = error;
      return { ok: false, error, url };
    }
  }

  return {
    get disabled() {
      return Boolean(options.disabled);
    },
    get timeoutMs() {
      return options.timeoutMs;
    },
    get baseUrl() {
      return options.baseUrl;
    },
    telemetry: () => ({ ...telemetry }),
    async fetchGroup(group: string) {
      const url = `${options.baseUrl.replace(/\/+$/, '')}/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=json`;
      if (options.disabled) {
        const error = 'upstream retrieval is disabled by configuration';
        telemetry.lastError = error;
        telemetry.lastAttemptAt = new Date().toISOString();
        return { ok: false, error, url };
      }

      // Coalesce concurrent requests for the same group within this isolate.
      const existing = inflight.get(group);
      if (existing) return existing;

      const run = (async (): Promise<UpstreamResult> => {
        const first = await attempt(url);
        if (first.ok) return first;
        // One retry, short backoff — enough to ride out a transient refusal
        // without amplifying load on a provider that is clearly unavailable.
        await sleep(400);
        return attempt(url);
      })().finally(() => inflight.delete(group));

      inflight.set(group, run);
      return run;
    },
  };
}
