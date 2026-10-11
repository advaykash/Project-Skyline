/**
 * Minimal per-isolate request rate limiting.
 *
 * Purpose: keep a single client from amplifying load on the API and, through it,
 * on CelesTrak. This is a *per-isolate* sliding window held in module state.
 *
 * DOCUMENTED LIMITATION: Cloudflare isolates do not share memory, so this is not
 * a global rate limit and a determined caller can exceed it by hitting many
 * isolates. It is a backstop, not a security boundary. A global limit would
 * require a distributed counter (e.g. KV/Durable Objects), which is deliberately
 * out of scope for this project to keep the deployment free of paid resources.
 */

interface Window {
  timestamps: number[];
}

const buckets = new Map<string, Window>();
let lastSweep = 0;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSeconds: number;
}

export function checkRateLimit(
  key: string,
  nowMs: number,
  limit = 60,
  windowMs = 60_000,
): RateLimitResult {
  // Sweep stale buckets occasionally so memory cannot grow without bound.
  if (nowMs - lastSweep > windowMs) {
    for (const [k, w] of buckets) {
      if (w.timestamps.length === 0 || nowMs - w.timestamps[w.timestamps.length - 1] > windowMs) {
        buckets.delete(k);
      }
    }
    lastSweep = nowMs;
  }

  let window = buckets.get(key);
  if (!window) {
    window = { timestamps: [] };
    buckets.set(key, window);
  }
  const cutoff = nowMs - windowMs;
  while (window.timestamps.length > 0 && window.timestamps[0] <= cutoff) {
    window.timestamps.shift();
  }
  if (window.timestamps.length >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((window.timestamps[0] + windowMs - nowMs) / 1000));
    return { allowed: false, remaining: 0, limit, retryAfterSeconds };
  }
  window.timestamps.push(nowMs);
  return {
    allowed: true,
    remaining: limit - window.timestamps.length,
    limit,
    retryAfterSeconds: 0,
  };
}

/** The client identity used for rate limiting (best effort). */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for');
  return forwarded ? forwarded.split(',')[0].trim() : 'unknown';
}

/** Test helper: clear all state. */
export function resetRateLimits(): void {
  buckets.clear();
  lastSweep = 0;
}
