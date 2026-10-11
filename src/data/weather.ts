/**
 * Cloud-cover forecast client (same-origin `/api/weather`, backed by Open-Meteo).
 *
 * Forecasts are advisory context for pass planning — never measurements. A
 * failure yields a typed null result so callers render "unavailable" instead
 * of guessing.
 */
import { ApiRequestError } from './api';

export interface WeatherHour {
  time: string;
  cloudCoverPercent: number;
}

export interface WeatherForecast {
  latitude: number;
  longitude: number;
  retrievedAt: string;
  servedFromCache: boolean;
  source: 'open-meteo';
  sourceUrl: string;
  hourly: WeatherHour[];
}

function isForecast(payload: unknown): payload is WeatherForecast {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.retrievedAt === 'string' &&
    Array.isArray(p.hourly) &&
    p.hourly.every(
      (h) =>
        typeof h === 'object' &&
        h !== null &&
        typeof (h as Record<string, unknown>).time === 'string' &&
        typeof (h as Record<string, unknown>).cloudCoverPercent === 'number',
    )
  );
}

export async function fetchWeatherForecast(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<WeatherForecast> {
  let response: Response;
  try {
    response = await fetch(`/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`, {
      headers: { accept: 'application/json' },
      signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiRequestError('The weather endpoint could not be reached.', {
      code: 'network',
      status: 0,
    });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError('The weather endpoint returned a malformed response.', {
      code: 'malformed',
      status: response.status,
    });
  }
  if (!response.ok || !isForecast(payload)) {
    const message =
      typeof payload === 'object' && payload !== null
        ? ((payload as { error?: { message?: string } }).error?.message ?? undefined)
        : undefined;
    throw new ApiRequestError(message ?? 'The cloud-cover forecast is unavailable.', {
      code: 'unavailable',
      status: response.status,
    });
  }
  return payload;
}

/**
 * Cloud cover nearest to a timestamp, or null when the forecast does not cover
 * it (callers must render "unavailable", never extrapolate).
 */
export function cloudCoverAt(forecast: WeatherForecast, timeMs: number): number | null {
  let best: WeatherHour | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const hour of forecast.hourly) {
    const ms = Date.parse(hour.time);
    if (!Number.isFinite(ms)) continue;
    const delta = Math.abs(ms - timeMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = hour;
    }
  }
  // Hourly steps: accept a sample within 45 minutes of the requested time.
  if (!best || bestDelta > 45 * 60_000) return null;
  return best.cloudCoverPercent;
}
