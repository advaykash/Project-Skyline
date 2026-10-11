/**
 * Observer locations: presets, validation and local persistence.
 *
 * The observer is shared by pass prediction, the local-sky view, sky darkness
 * and cloud context. Coordinates are stored only in this browser's
 * localStorage — never sent to analytics or unrelated services. Browser
 * geolocation is used solely after an explicit user action.
 */
import type { ObserverLocation } from '../orbital/observer';

export interface ObserverPreset extends ObserverLocation {
  id: string;
  label: string;
}

export const OBSERVER_PRESETS: ObserverPreset[] = [
  { id: 'princeton', label: 'Princeton, NJ', latitudeDeg: 40.3573, longitudeDeg: -74.6672 },
  { id: 'new-york', label: 'New York', latitudeDeg: 40.7128, longitudeDeg: -74.006 },
  { id: 'london', label: 'London', latitudeDeg: 51.5074, longitudeDeg: -0.1278 },
  { id: 'tokyo', label: 'Tokyo', latitudeDeg: 35.6762, longitudeDeg: 139.6503 },
  { id: 'sydney', label: 'Sydney', latitudeDeg: -33.8688, longitudeDeg: 151.2093 },
  { id: 'reykjavik', label: 'Reykjavík', latitudeDeg: 64.1466, longitudeDeg: -21.9426 },
];

export const DEFAULT_OBSERVER: ObserverLocation = {
  latitudeDeg: OBSERVER_PRESETS[0].latitudeDeg,
  longitudeDeg: OBSERVER_PRESETS[0].longitudeDeg,
  label: OBSERVER_PRESETS[0].label,
};

const STORAGE_KEY = 'skyline.observer.v1';

export function isValidLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

/** Parse user-entered coordinates; returns an error message or the location. */
export function parseCustomObserver(
  latText: string,
  lonText: string,
): { ok: true; observer: ObserverLocation } | { ok: false; error: string } {
  // Tolerate the typographic minus users may paste from formatted coordinates.
  const lat = Number(latText.trim().replace(/[−–]/g, '-'));
  const lon = Number(lonText.trim().replace(/[−–]/g, '-'));
  if (latText.trim() === '' || !Number.isFinite(lat)) {
    return { ok: false, error: 'Latitude must be a number between −90 and 90.' };
  }
  if (lonText.trim() === '' || !Number.isFinite(lon)) {
    return { ok: false, error: 'Longitude must be a number between −180 and 180.' };
  }
  if (!isValidLatitude(lat)) return { ok: false, error: 'Latitude must be between −90 and 90 degrees.' };
  if (!isValidLongitude(lon)) {
    return { ok: false, error: 'Longitude must be between −180 and 180 degrees.' };
  }
  return {
    ok: true,
    observer: {
      latitudeDeg: lat,
      longitudeDeg: lon,
      label: `Custom · ${lat.toFixed(3)}°, ${lon.toFixed(3)}°`,
    },
  };
}

export function loadStoredObserver(): ObserverLocation {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_OBSERVER;
    const parsed = JSON.parse(raw) as Partial<ObserverLocation>;
    if (
      typeof parsed.latitudeDeg === 'number' &&
      typeof parsed.longitudeDeg === 'number' &&
      isValidLatitude(parsed.latitudeDeg) &&
      isValidLongitude(parsed.longitudeDeg)
    ) {
      return {
        latitudeDeg: parsed.latitudeDeg,
        longitudeDeg: parsed.longitudeDeg,
        label: typeof parsed.label === 'string' ? parsed.label : 'Stored location',
      };
    }
  } catch {
    // Corrupt or unavailable storage: fall through to the default.
  }
  return DEFAULT_OBSERVER;
}

export function storeObserver(observer: ObserverLocation): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        latitudeDeg: observer.latitudeDeg,
        longitudeDeg: observer.longitudeDeg,
        label: observer.label ?? 'Custom location',
      }),
    );
  } catch {
    // Private mode etc: the observer still works for this session.
  }
}

export function formatObserver(observer: ObserverLocation): string {
  const lat = `${Math.abs(observer.latitudeDeg).toFixed(3)}° ${observer.latitudeDeg >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(observer.longitudeDeg).toFixed(3)}° ${observer.longitudeDeg >= 0 ? 'E' : 'W'}`;
  return `${lat}, ${lon}`;
}
