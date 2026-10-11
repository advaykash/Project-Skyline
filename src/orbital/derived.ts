/**
 * Derived orbital properties.
 *
 * Every value here is either (a) read directly from the published element set,
 * or (b) computed with a documented formula from those elements. Nothing is
 * estimated, interpolated from telemetry, or invented.
 *
 * UNIT CONVENTIONS
 *   mean motion    revolutions per day (as published)
 *   period         minutes
 *   semi-major a   km
 *   apogee/perigee km of altitude above the WGS-84 equatorial radius (6378.137 km)
 *   velocity       km/s
 */
import { EARTH_EQ_RADIUS_WGS84_KM, EARTH_MU_KM3_S2, SIDEREAL_DAY_MIN } from './constants';
import type { CatalogObject } from './types';

const TWO_PI = Math.PI * 2;

/** Orbital period in minutes, from the published mean motion. */
export function orbitalPeriodMinutes(meanMotionRevPerDay: number): number {
  if (!(meanMotionRevPerDay > 0)) return NaN;
  return 1440 / meanMotionRevPerDay;
}

/**
 * Semi-major axis in km from mean motion, via Kepler's third law
 * a = (mu / n^2)^(1/3), with n converted from rev/day to rad/s.
 *
 * This is the *SGP4 mean* semi-major axis: it differs slightly from the
 * osculating value because SGP4's mean motion includes secular drag effects.
 */
export function semiMajorAxisKm(meanMotionRevPerDay: number): number {
  if (!(meanMotionRevPerDay > 0)) return NaN;
  const nRadPerSec = (meanMotionRevPerDay * TWO_PI) / 86400;
  return Math.cbrt(EARTH_MU_KM3_S2 / (nRadPerSec * nRadPerSec));
}

/**
 * Mean apogee and perigee altitudes in km. These are taken from the mean
 * elements, so they are approximate for any single revolution: SGP4 applies
 * short-period perturbations of up to a few tens of kilometres, and drag makes
 * the real apogee drift between element updates.
 */
export function apsisAltitudesKm(
  meanMotionRevPerDay: number,
  eccentricity: number,
): { apogeeKm: number; perigeeKm: number; semiMajorAxisKm: number } {
  const a = semiMajorAxisKm(meanMotionRevPerDay);
  if (!Number.isFinite(a)) return { apogeeKm: NaN, perigeeKm: NaN, semiMajorAxisKm: NaN };
  return {
    apogeeKm: a * (1 + eccentricity) - EARTH_EQ_RADIUS_WGS84_KM,
    perigeeKm: a * (1 - eccentricity) - EARTH_EQ_RADIUS_WGS84_KM,
    semiMajorAxisKm: a,
  };
}

/** True when the object's mean motion matches a geosynchronous period. */
export function isGeosynchronous(meanMotionRevPerDay: number): boolean {
  const period = orbitalPeriodMinutes(meanMotionRevPerDay);
  return Number.isFinite(period) && Math.abs(period - SIDEREAL_DAY_MIN) < 10;
}

/** Orbit regime classification from the mean elements — descriptive only. */
export function orbitRegime(
  meanMotionRevPerDay: number,
  eccentricity: number,
): 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'unknown' {
  const a = semiMajorAxisKm(meanMotionRevPerDay);
  if (!Number.isFinite(a)) return 'unknown';
  if (eccentricity > 0.25) return 'HEO';
  if (a < 8000) return 'LEO';
  if (isGeosynchronous(meanMotionRevPerDay)) return 'GEO';
  if (a < 35000) return 'MEO';
  return 'GEO';
}

/**
 * Age of the element set at a given instant, in days. Positive means the
 * propagation time is after the element epoch (the normal case). SGP4 is
 * generally used within a few days of epoch; accuracy degrades as this grows —
 * the interface displays it so users can judge the prediction honestly.
 */
export function elementAgeDays(object: CatalogObject, atMs: number): number {
  return (atMs - object.epochMs) / 86_400_000;
}

/**
 * Estimate the along-track error accumulated by propagating an element set
 * `ageDays` beyond its epoch.
 *
 * This is a deliberately conservative rule of thumb, NOT a measurement: real
 * error depends on the object's area-to-mass ratio, atmospheric density and
 * solar activity. LEO drag-dominated objects typically accumulate on the order
 * of 1–3 km/day along-track; we surface a range rather than a false-precision
 * single number.
 */
export function estimatedAlongTrackDriftKm(
  meanMotionRevPerDay: number,
  ageDays: number,
): { lowKm: number; highKm: number } | null {
  if (!Number.isFinite(meanMotionRevPerDay) || !Number.isFinite(ageDays)) return null;
  if (ageDays <= 0) return { lowKm: 0, highKm: 0 };
  // Objects below ~850 km mean altitude sit in the denser thermosphere and are
  // drag-dominated; higher objects drift much more slowly.
  const period = orbitalPeriodMinutes(meanMotionRevPerDay);
  const lowAltitudeRegime = period < 103; // ~< 900 km circular
  const perDayLow = lowAltitudeRegime ? 1 : 0.15;
  const perDayHigh = lowAltitudeRegime ? 4 : 0.6;
  return { lowKm: ageDays * perDayLow, highKm: ageDays * perDayHigh };
}

/** Format helpers shared by the interface (kept here so they are unit-tested). */
export function formatDurationMinutes(minutes: number): string {
  if (!Number.isFinite(minutes)) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes - h * 60;
  if (h === 0) return `${m.toFixed(1)} min`;
  return `${h} h ${m.toFixed(1)} min`;
}

export interface DerivedElements {
  periodMinutes: number;
  semiMajorAxisKm: number;
  apogeeKm: number;
  perigeeKm: number;
  regime: ReturnType<typeof orbitRegime>;
  isGeosynchronous: boolean;
}

/** Compute the full derived set for an object from its published elements. */
export function deriveElements(object: CatalogObject): DerivedElements {
  const { meanMotionRevPerDay, eccentricity } = object.elements;
  const apsides = apsisAltitudesKm(meanMotionRevPerDay, eccentricity);
  return {
    periodMinutes: orbitalPeriodMinutes(meanMotionRevPerDay),
    semiMajorAxisKm: apsides.semiMajorAxisKm,
    apogeeKm: apsides.apogeeKm,
    perigeeKm: apsides.perigeeKm,
    regime: orbitRegime(meanMotionRevPerDay, eccentricity),
    isGeosynchronous: isGeosynchronous(meanMotionRevPerDay),
  };
}
