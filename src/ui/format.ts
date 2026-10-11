/**
 * Formatting helpers for the interface. Values are rendered with tabular
 * numerals and explicit units; anything unknown is shown as an em dash — never
 * as a fabricated number.
 */

export function formatUtc(ms: number, withSeconds = true): string {
  const date = new Date(ms);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const base = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  return withSeconds ? `${base}:${pad(date.getUTCSeconds())}` : base;
}

export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) {
    const h = s / 3600;
    return `${h < 10 ? h.toFixed(1) : Math.round(h)} h ago`;
  }
  const d = s / 86400;
  return `${d < 10 ? d.toFixed(1) : Math.round(d)} d ago`;
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatLatitude(deg: number): string {
  if (!Number.isFinite(deg)) return '—';
  const hemi = deg >= 0 ? 'N' : 'S';
  return `${Math.abs(deg).toFixed(3)}° ${hemi}`;
}

export function formatLongitude(deg: number): string {
  if (!Number.isFinite(deg)) return '—';
  const hemi = deg >= 0 ? 'E' : 'W';
  return `${Math.abs(deg).toFixed(3)}° ${hemi}`;
}

export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes)) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes - h * 60;
  return h > 0 ? `${h} h ${m.toFixed(1)} min` : `${m.toFixed(1)} min`;
}

export function stateLabel(state: string): string {
  switch (state) {
    case 'live':
      return 'Live';
    case 'cached':
      return 'Cached';
    case 'stale':
      return 'Stale';
    case 'snapshot':
      return 'Snapshot';
    case 'unavailable':
      return 'Unavailable';
    case 'degraded':
      return 'Refresh failed';
    default:
      return state;
  }
}
