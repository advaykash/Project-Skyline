/**
 * Planetary Kp client (same-origin `/api/kp`, backed by NOAA SWPC).
 *
 * Kp is a 3-hourly planetary geomagnetic index — a measurement of global
 * disturbance, not a local aurora forecast. Failures surface as typed errors
 * so the UI renders stale/unavailable states instead of fabricated values.
 */
import { ApiRequestError } from './api';

export interface KpSample {
  time: string;
  kp: number;
}

export interface KpSeries {
  retrievedAt: string;
  servedFromCache: boolean;
  source: 'noaa-swpc';
  sourceUrl: string;
  feedUrl: string;
  samples: KpSample[];
}

function isSeries(payload: unknown): payload is KpSeries {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.retrievedAt === 'string' &&
    typeof p.feedUrl === 'string' &&
    Array.isArray(p.samples) &&
    p.samples.every(
      (s) =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as Record<string, unknown>).time === 'string' &&
        typeof (s as Record<string, unknown>).kp === 'number' &&
        Number.isFinite((s as Record<string, unknown>).kp as number),
    )
  );
}

export async function fetchKpSeries(signal?: AbortSignal): Promise<KpSeries> {
  let response: Response;
  try {
    response = await fetch('/api/kp', {
      headers: { accept: 'application/json' },
      signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiRequestError('The space-weather endpoint could not be reached.', {
      code: 'network',
      status: 0,
    });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError('The space-weather endpoint returned a malformed response.', {
      code: 'malformed',
      status: response.status,
    });
  }
  if (!response.ok || !isSeries(payload)) {
    const message =
      typeof payload === 'object' && payload !== null
        ? ((payload as { error?: { message?: string } }).error?.message ?? undefined)
        : undefined;
    throw new ApiRequestError(message ?? 'NOAA Kp data is unavailable.', {
      code: 'unavailable',
      status: response.status,
    });
  }
  return payload;
}

/** Plain-language band for a Kp value (G-scale wording follows NOAA). */
export function kpBand(kp: number): { label: string; detail: string } {
  if (kp < 4) return { label: 'Quiet', detail: 'Kp below 4 — no geomagnetic storm.' };
  if (kp < 5) return { label: 'Active', detail: 'Kp 4 — active conditions, below storm level.' };
  if (kp < 6) return { label: 'G1 · Minor storm', detail: 'Kp 5 — minor geomagnetic storm (NOAA G1).' };
  if (kp < 7) return { label: 'G2 · Moderate storm', detail: 'Kp 6 — moderate storm (NOAA G2).' };
  if (kp < 8) return { label: 'G3 · Strong storm', detail: 'Kp 7 — strong storm (NOAA G3).' };
  if (kp < 9) return { label: 'G4 · Severe storm', detail: 'Kp 8 — severe storm (NOAA G4).' };
  return { label: 'G5 · Extreme storm', detail: 'Kp 9 — extreme storm (NOAA G5).' };
}
