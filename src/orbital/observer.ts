/**
 * Observer-relative orbital geometry: look angles, solar conditions, satellite
 * illumination and pass prediction.
 *
 * Every value here is computed from SGP4-propagated positions (TEME), the same
 * GMST rotation used for the globe, and closed-form geodetic math on the WGS-84
 * ellipsoid. Nothing is observed, fitted or estimated from telemetry:
 *
 *   - look angles are pure geometry (satellite ECEF vs. observer ECEF),
 *   - solar altitude reuses the solar ephemeris behind the globe's terminator,
 *   - satellite illumination is a cylindrical-shadow eclipse test,
 *   - passes are found by scanning elevation and refining crossings.
 *
 * Units: kilometres, seconds, degrees. Azimuth is measured clockwise from true
 * north (0° = N, 90° = E); elevation is above the local horizon.
 */
import type { SatRec } from 'satellite.js';
import { propagateState } from './elements';
import { gmstFor, sunDirectionScene } from './frames';
import { EARTH_EQ_RADIUS_WGS84_KM, EARTH_POLAR_RADIUS_WGS84_KM } from './constants';

export interface ObserverLocation {
  latitudeDeg: number;
  longitudeDeg: number;
  /** Height above the WGS-84 ellipsoid, km. Defaults to 0. */
  heightKm?: number;
  /** Display label, e.g. "Princeton, NJ". */
  label?: string;
}

export interface LookAngles {
  /** Milliseconds since the Unix epoch this solution is valid for. */
  timeMs: number;
  /** Clockwise from true north, degrees, in [0, 360). */
  azimuthDeg: number;
  /** Above the local horizon, degrees, in [-90, 90]. */
  elevationDeg: number;
  /** Slant range observer -> satellite, km. */
  rangeKm: number;
  /** Satellite altitude above the WGS-84 ellipsoid, km. */
  altitudeKm: number;
  /** Sub-satellite latitude/longitude, degrees. */
  latitudeDeg: number;
  longitudeDeg: number;
}

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/** WGS-84 first eccentricity squared. */
const WGS84_E2 =
  1 - (EARTH_POLAR_RADIUS_WGS84_KM * EARTH_POLAR_RADIUS_WGS84_KM) /
    (EARTH_EQ_RADIUS_WGS84_KM * EARTH_EQ_RADIUS_WGS84_KM);

/**
 * Closed-form geodetic -> ECEF conversion (WGS-84). Implemented directly rather
 * than via satellite.js so the test suite can cross-check it against
 * `geodeticToEcf` as an independent reference.
 */
export function geodeticToEcefKm(observer: ObserverLocation): { x: number; y: number; z: number } {
  const lat = observer.latitudeDeg * RAD;
  const lon = observer.longitudeDeg * RAD;
  const h = observer.heightKm ?? 0;
  const a = EARTH_EQ_RADIUS_WGS84_KM;
  const sinLat = Math.sin(lat);
  const n = a / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const cosLat = Math.cos(lat);
  return {
    x: (n + h) * cosLat * Math.cos(lon),
    y: (n + h) * cosLat * Math.sin(lon),
    z: (n * (1 - WGS84_E2) + h) * sinLat,
  };
}

/**
 * Observer-relative look angles for a satellite ECEF position (km).
 *
 * The topocentric basis (east, north, up) is built from the observer's
 * geodetic latitude/longitude; the slant vector is satellite minus observer.
 */
export function lookAnglesFromEcef(
  satEcefKm: { x: number; y: number; z: number },
  observer: ObserverLocation,
  timeMs: number,
  altitudeKm = NaN,
  subLatitudeDeg = NaN,
  subLongitudeDeg = NaN,
): LookAngles {
  const obs = geodeticToEcefKm(observer);
  const dx = satEcefKm.x - obs.x;
  const dy = satEcefKm.y - obs.y;
  const dz = satEcefKm.z - obs.z;

  const lat = observer.latitudeDeg * RAD;
  const lon = observer.longitudeDeg * RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);

  // ECEF -> topocentric (south, east, up), then derive azimuth/elevation.
  const south = sinLat * cosLon * dx + sinLat * sinLon * dy - cosLat * dz;
  const east = -sinLon * dx + cosLon * dy;
  const up = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;

  const rangeKm = Math.hypot(dx, dy, dz);
  const elevationDeg = Math.asin(Math.max(-1, Math.min(1, up / (rangeKm || 1)))) * DEG;
  let azimuthDeg = Math.atan2(east, -south) * DEG;
  if (azimuthDeg < 0) azimuthDeg += 360;

  return {
    timeMs,
    azimuthDeg,
    elevationDeg,
    rangeKm,
    altitudeKm,
    latitudeDeg: subLatitudeDeg,
    longitudeDeg: subLongitudeDeg,
  };
}

/**
 * Propagate one object and solve the observer-relative geometry at one instant.
 * Returns null when SGP4 cannot produce a state (never invented coordinates).
 */
export function lookAnglesAt(
  satrec: SatRec,
  noradId: number,
  observer: ObserverLocation,
  timeMs: number,
): LookAngles | null {
  const date = new Date(timeMs);
  const state = propagateState(satrec, noradId, date, gmstFor(date));
  if (state.error) return null;
  return lookAnglesFromEcef(
    state.positionEcefKm,
    observer,
    timeMs,
    state.geodetic.altitudeKm,
    state.geodetic.latitudeDeg,
    state.geodetic.longitudeDeg,
  );
}

/* ------------------------------------------------------- solar conditions */

/**
 * Solar altitude above the observer's horizon, in degrees.
 *
 * Derived from the same solar ephemeris that positions the globe's day/night
 * terminator: the Sun's Earth-fixed unit vector dotted with the observer's
 * local up vector. Positive = Sun above the horizon.
 */
export function solarAltitudeDeg(observer: ObserverLocation, date: Date): number {
  const sun = sunDirectionScene(date); // scene frame, unit length
  // Observer's geocentric unit vector in the scene frame (spherical Earth is
  // more than adequate: the ellipsoid correction is < 0.2°).
  const lat = observer.latitudeDeg * RAD;
  const lon = observer.longitudeDeg * RAD;
  const up = {
    x: Math.cos(lat) * Math.cos(lon),
    y: Math.sin(lat),
    z: -Math.cos(lat) * Math.sin(lon),
  };
  const sinAlt = sun.x * up.x + sun.y * up.y + sun.z * up.z;
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) * DEG;
}

export type DarknessCategory =
  | 'daylight'
  | 'civil-twilight'
  | 'nautical-twilight'
  | 'astronomical-night';

/** Standard solar-depression boundaries, in degrees. */
export function darknessCategory(sunAltitudeDeg: number): DarknessCategory {
  if (sunAltitudeDeg >= 0) return 'daylight';
  if (sunAltitudeDeg >= -6) return 'civil-twilight';
  if (sunAltitudeDeg >= -12) return 'nautical-twilight';
  return 'astronomical-night';
}

export function darknessLabel(category: DarknessCategory): string {
  switch (category) {
    case 'daylight':
      return 'Daylight';
    case 'civil-twilight':
      return 'Civil twilight';
    case 'nautical-twilight':
      return 'Nautical twilight';
    case 'astronomical-night':
      return 'Astronomical night';
  }
}

/* ------------------------------------------- satellite illumination (eclipse) */

export type Illumination = 'sunlit' | 'penumbra' | 'umbra';

export function illuminationLabel(state: Illumination): string {
  switch (state) {
    case 'sunlit':
      return 'Sunlit';
    case 'penumbra':
      return 'Penumbra (partial shadow)';
    case 'umbra':
      return 'Eclipsed (Earth shadow)';
  }
}

/**
 * Cylindrical-shadow eclipse test for a satellite ECEF position.
 *
 * The satellite is in shadow when it is on the night side of Earth (negative
 * projection onto the Sun direction) and its perpendicular distance from the
 * Sun line is within Earth's radius. A penumbra band of one solar angular
 * radius (~0.265°) separates full sunlight from umbra. Earth is treated as a
 * sphere of equatorial radius — conservative by at most ~20 km, which only
 * widens the shadow slightly near the poles.
 */
export function satelliteIllumination(
  satEcefKm: { x: number; y: number; z: number },
  sunEcefUnit: { x: number; y: number; z: number },
): Illumination {
  const r = Math.hypot(satEcefKm.x, satEcefKm.y, satEcefKm.z);
  const s = satEcefKm.x * sunEcefUnit.x + satEcefKm.y * sunEcefUnit.y + satEcefKm.z * sunEcefUnit.z;
  if (s >= 0) return 'sunlit'; // day side of the terminator plane
  const perp = Math.sqrt(Math.max(0, r * r - s * s));
  const earthR = EARTH_EQ_RADIUS_WGS84_KM;
  // Penumbra width at the satellite's distance past the terminator plane.
  const penumbraKm = Math.tan(0.265 * RAD) * -s;
  if (perp < earthR - penumbraKm) return 'umbra';
  if (perp < earthR + penumbraKm) return 'penumbra';
  return 'sunlit';
}

/**
 * Sun direction (Earth centre -> Sun) as an ECEF unit vector. The solar
 * ephemeris natively yields scene-frame coordinates; scene -> ECEF is the
 * inverse of the even permutation in `frames.ts` (ecef = (x, -z, y)).
 */
export function sunDirectionEcef(date: Date): { x: number; y: number; z: number } {
  const s = sunDirectionScene(date);
  const v = { x: s.x, y: -s.z, z: s.y };
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/* ------------------------------------------------------------- pass search */

export interface PassPoint {
  timeMs: number;
  azimuthDeg: number;
  elevationDeg: number;
  rangeKm: number;
  altitudeKm: number;
  illumination: Illumination;
  sunAltitudeDeg: number;
}

export interface PredictedPass {
  noradId: number;
  rise: PassPoint;
  peak: PassPoint;
  set: PassPoint;
  /** Peak elevation, degrees. */
  maxElevationDeg: number;
  /** End minus start, milliseconds. */
  durationMs: number;
}

export interface PassSearchOptions {
  /** Elevation threshold defining rise/set, degrees. Default 10. */
  minElevationDeg?: number;
  /** Coarse scan step, seconds. Default 20. */
  stepSeconds?: number;
  /** Maximum passes returned. Default 12. */
  maxPasses?: number;
}

interface Sample {
  t: number;
  el: number;
}

/**
 * Predict overhead passes of one object for one observer over [startMs, endMs].
 *
 * Method: sample elevation on a coarse grid, bracket each above-threshold
 * interval, refine rise/set by bisection on the elevation function and the peak
 * by golden-section search. All times are refined against real SGP4 evaluations
 * — never interpolated ephemerides. Returns passes in chronological order.
 *
 * An empty array means "no pass above the threshold in this window" — never a
 * reason to invent one. Callers should offer a longer window or another object.
 */
export function predictPasses(
  satrec: SatRec,
  noradId: number,
  observer: ObserverLocation,
  startMs: number,
  endMs: number,
  options: PassSearchOptions = {},
): PredictedPass[] {
  const minEl = options.minElevationDeg ?? 10;
  const stepMs = (options.stepSeconds ?? 20) * 1000;
  const maxPasses = options.maxPasses ?? 12;
  if (!(endMs > startMs) || stepMs <= 0 || maxPasses <= 0) return [];

  const elevationAt = (t: number): number | null => {
    const look = lookAnglesAt(satrec, noradId, observer, t);
    return look ? look.elevationDeg : null;
  };

  // Coarse scan.
  const samples: Sample[] = [];
  for (let t = startMs; t <= endMs; t += stepMs) {
    const el = elevationAt(t);
    samples.push({ t, el: el ?? Number.NaN });
  }
  // Always include the exact window end.
  if (samples.length === 0 || samples[samples.length - 1].t < endMs) {
    const el = elevationAt(endMs);
    samples.push({ t: endMs, el: el ?? Number.NaN });
  }

  const above = (s: Sample): boolean => Number.isFinite(s.el) && s.el >= minEl;
  const passes: PredictedPass[] = [];

  let i = 0;
  while (i < samples.length - 1 && passes.length < maxPasses) {
    if (!above(samples[i]) && above(samples[i + 1])) {
      // Rising edge: find the falling edge.
      let j = i + 1;
      while (j + 1 < samples.length && above(samples[j + 1])) j++;
      const hasSet = j + 1 < samples.length && !above(samples[j + 1]);
      const riseT = refineCrossing(elevationAt, samples[i].t, samples[i + 1].t, true, minEl);
      const setT = hasSet ? refineCrossing(elevationAt, samples[j].t, samples[j + 1].t, false, minEl) : null;
      if (riseT !== null && setT !== null && setT > riseT) {
        const peakT = refinePeak(elevationAt, riseT, setT);
        const pass = buildPass(satrec, noradId, observer, riseT, peakT, setT);
        if (pass) passes.push(pass);
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return passes;
}

/** Bisect an elevation threshold crossing between two bracketing times. */
function refineCrossing(
  elevationAt: (t: number) => number | null,
  lo: number,
  hi: number,
  rising: boolean,
  threshold?: number,
): number | null {
  const limit = threshold ?? 10;
  const target = (t: number): number | null => {
    const el = elevationAt(t);
    return el === null ? null : el - limit;
  };
  // NOTE: the threshold actually used is resolved by the caller — this helper
  // receives it implicitly through `elevationAt`. See `predictPasses`, which
  // passes the configured minimum elevation.
  let a = lo;
  let b = hi;
  let fa = target(a);
  if (fa === null) return null;
  for (let k = 0; k < 40; k++) {
    const m = (a + b) / 2;
    const fm = target(m);
    if (fm === null) return null;
    const wantLeft = rising ? fm < 0 : fm > 0;
    if (wantLeft) {
      a = m;
      fa = fm;
    } else {
      b = m;
    }
    if (b - a < 500) break; // 0.5 s resolution is plenty for a pass listing
  }
  void fa;
  return (a + b) / 2;
}

/** Golden-section search for peak elevation within a pass interval. */
function refinePeak(elevationAt: (t: number) => number | null, lo: number, hi: number): number {
  const gr = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  const value = (t: number): number => elevationAt(t) ?? Number.NEGATIVE_INFINITY;
  for (let k = 0; k < 48; k++) {
    if (value(c) < value(d)) a = c;
    else b = d;
    c = b - gr * (b - a);
    d = a + gr * (b - a);
    if (b - a < 500) break;
  }
  return (a + b) / 2;
}

function buildPass(
  satrec: SatRec,
  noradId: number,
  observer: ObserverLocation,
  riseT: number,
  peakT: number,
  setT: number,
): PredictedPass | null {
  const at = (t: number): PassPoint | null => {
    const look = lookAnglesAt(satrec, noradId, observer, t);
    if (!look) return null;
    const date = new Date(t);
    const sunEcef = sunDirectionEcef(date);
    // Propagate for the exact state vector so illumination uses the true
    // ECEF position rather than a value re-derived from the look solution.
    const state = propagateState(satrec, noradId, date, gmstFor(date));
    if (state.error) return null;
    return {
      timeMs: t,
      azimuthDeg: look.azimuthDeg,
      elevationDeg: look.elevationDeg,
      rangeKm: look.rangeKm,
      altitudeKm: look.altitudeKm,
      illumination: satelliteIllumination(state.positionEcefKm, sunEcef),
      sunAltitudeDeg: solarAltitudeDeg(observer, date),
    };
  };
  const rise = at(riseT);
  const peak = at(peakT);
  const set = at(setT);
  if (!rise || !peak || !set) return null;
  return {
    noradId,
    rise,
    peak,
    set,
    maxElevationDeg: peak.elevationDeg,
    durationMs: set.timeMs - rise.timeMs,
  };
}

/* ---------------------------------------------------- viewing-score heuristic */

export interface ViewingScoreInput {
  pass: PredictedPass;
  /** Cloud cover 0–100 %, or null when no forecast is available. */
  cloudCoverPercent: number | null;
}

export interface ViewingScore {
  /** 0–100. A heuristic for comparing opportunities — never a probability. */
  score: number;
  grade: 'excellent' | 'good' | 'fair' | 'poor';
  /** Human-readable contribution of each factor. */
  factors: Array<{ name: string; detail: string; points: number; maxPoints: number }>;
  /** Assumptions applied because a data source was unavailable. */
  assumptions: string[];
}

/**
 * Transparent heuristic for comparing potential observing opportunities.
 *
 * Weights (documented in the UI alongside the score):
 *   - peak elevation: 0–40 (higher passes clear more horizon clutter),
 *   - darkness at peak: 0–30 (astronomical night scores full marks),
 *   - cloud cover at peak: 0–20 (clear skies score full marks),
 *   - satellite sunlit at peak: 0–10 (an eclipsed satellite reflects no light).
 *
 * When the cloud forecast is unavailable the cloud factor is scored neutrally
 * (10/20) and the assumption is disclosed — the score visibly stops claiming
 * knowledge it does not have.
 */
export function viewingScore(input: ViewingScoreInput): ViewingScore {
  const { pass, cloudCoverPercent } = input;
  const factors: ViewingScore['factors'] = [];
  const assumptions: string[] = [];

  const peakEl = pass.maxElevationDeg;
  const elPoints = Math.max(0, Math.min(40, Math.round((peakEl / 90) * 40)));
  factors.push({
    name: 'Peak elevation',
    detail: `Pass peaks at ${peakEl.toFixed(1)}° above the horizon.`,
    points: elPoints,
    maxPoints: 40,
  });

  const sunAlt = pass.peak.sunAltitudeDeg;
  const darkPoints = sunAlt >= 0 ? 0 : sunAlt >= -6 ? 10 : sunAlt >= -12 ? 20 : 30;
  factors.push({
    name: 'Sky darkness',
    detail: `Sun is ${Math.abs(sunAlt).toFixed(1)}° ${sunAlt >= 0 ? 'above' : 'below'} the horizon at peak (${darknessLabel(darknessCategory(sunAlt)).toLowerCase()}).`,
    points: darkPoints,
    maxPoints: 30,
  });

  if (cloudCoverPercent === null) {
    factors.push({
      name: 'Cloud cover',
      detail: 'No cloud forecast available — scored neutrally (10/20).',
      points: 10,
      maxPoints: 20,
    });
    assumptions.push('Cloud cover unknown; the cloud factor was scored neutrally instead of guessed.');
  } else {
    const clamped = Math.max(0, Math.min(100, cloudCoverPercent));
    const cloudPoints = Math.round(((100 - clamped) / 100) * 20);
    factors.push({
      name: 'Cloud cover',
      detail: `Forecast cloud cover near peak: ${clamped.toFixed(0)}%.`,
      points: cloudPoints,
      maxPoints: 20,
    });
  }

  const lit = pass.peak.illumination === 'sunlit';
  const partial = pass.peak.illumination === 'penumbra';
  factors.push({
    name: 'Satellite illumination',
    detail: `Satellite is ${illuminationLabel(pass.peak.illumination).toLowerCase()} at peak.`,
    points: lit ? 10 : partial ? 5 : 0,
    maxPoints: 10,
  });

  const score = factors.reduce((sum, f) => sum + f.points, 0);
  const grade = score >= 75 ? 'excellent' : score >= 55 ? 'good' : score >= 35 ? 'fair' : 'poor';
  return { score, grade, factors, assumptions };
}

/** Compass point for an azimuth, e.g. 23° -> "NNE". */
export function compassPoint(azimuthDeg: number): string {
  const points = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
  ];
  const index = Math.round((((azimuthDeg % 360) + 360) % 360) / 22.5) % 16;
  return points[index];
}
