/**
 * Parsing and validation of untrusted CelesTrak GP records, and construction of
 * SGP4 propagators from them.
 *
 * Every field that SGP4 needs is validated. A record that fails validation is
 * rejected with a reason — it is never silently repaired, and never replaced by
 * synthesised values.
 */
import { eciToGeodetic, json2satrec, propagate, SatRecError, type SatRec } from 'satellite.js';
import type { CatalogObject, GpRecord, PropagationFailure, SatelliteState } from './types';

export type { GpRecord, SatelliteState, PropagationFailure } from './types';
import { ecefToScene, eciToEcef, gmstFor } from './frames';

const REQUIRED_NUMERIC_FIELDS = [
  'MEAN_MOTION',
  'ECCENTRICITY',
  'INCLINATION',
  'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER',
  'MEAN_ANOMALY',
  'NORAD_CAT_ID',
] as const;

export type ValidationResult =
  | { ok: true; record: GpRecord }
  | { ok: false; reason: string };

/**
 * Matches an explicit timezone designator at the end of an ISO-8601 timestamp:
 * `Z`, `+HH:MM`, `-HHMM`, …
 */
const EPOCH_ZONE_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse a CelesTrak `EPOCH` string as UTC.
 *
 * CelesTrak GP JSON publishes element epochs without a timezone designator
 * (`"2026-08-31T01:02:28.311936"`). ECMAScript parses such a string in the
 * *host's local zone*, which would shift every displayed epoch, element age and
 * derived path by the viewer's UTC offset. The absence of a designator is
 * therefore normalised to UTC before parsing — the same convention satellite.js
 * applies inside `json2satrec`, so the propagator and the interface agree.
 *
 * Returns NaN for an unparseable value; callers decide whether that is fatal.
 */
export function parseEpochMs(epoch: string): number {
  const value = String(epoch).trim();
  if (value === '') return NaN;
  // Tolerate the space-separated form ("2026-08-31 01:02:28") by making it ISO.
  const iso = value.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:)/, '$1T$2');
  return Date.parse(EPOCH_ZONE_SUFFIX.test(iso) ? iso : `${iso}Z`);
}

/** Structural + range validation of one GP record. */
export function validateGpRecord(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'record is not an object' };
  const rec = raw as Record<string, unknown>;

  if (typeof rec.OBJECT_NAME !== 'string' || rec.OBJECT_NAME.trim() === '') {
    return { ok: false, reason: 'missing OBJECT_NAME' };
  }
  if (typeof rec.EPOCH !== 'string' || Number.isNaN(parseEpochMs(rec.EPOCH))) {
    return { ok: false, reason: 'missing or unparseable EPOCH' };
  }
  for (const field of REQUIRED_NUMERIC_FIELDS) {
    const value = typeof rec[field] === 'string' ? Number(rec[field]) : rec[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, reason: `missing or non-numeric ${field}` };
    }
  }

  const meanMotion = Number(rec.MEAN_MOTION);
  const eccentricity = Number(rec.ECCENTRICITY);
  const inclination = Number(rec.INCLINATION);

  if (meanMotion <= 0) return { ok: false, reason: 'MEAN_MOTION must be positive' };
  if (eccentricity < 0 || eccentricity >= 1) return { ok: false, reason: 'ECCENTRICITY out of range [0,1)' };
  if (inclination < 0 || inclination > 180) return { ok: false, reason: 'INCLINATION out of range [0,180]' };

  const epochMs = parseEpochMs(rec.EPOCH);
  // Reject elements dated absurdly far in the future: they indicate corrupt data.
  if (epochMs > Date.now() + 400 * 86_400_000) {
    return { ok: false, reason: 'EPOCH is more than 400 days in the future' };
  }

  return { ok: true, record: raw as GpRecord };
}

/** Build the display/identity projection of a validated record. */
export function toCatalogObject(record: GpRecord, index: number, nowMs: number): CatalogObject {
  const epochMs = parseEpochMs(record.EPOCH);
  const num = (v: unknown, fallback = 0) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  };
  return {
    index,
    noradId: num(record.NORAD_CAT_ID),
    name: String(record.OBJECT_NAME).trim(),
    objectId: typeof record.OBJECT_ID === 'string' ? record.OBJECT_ID : '',
    epochMs,
    epochAgeDays: (nowMs - epochMs) / 86_400_000,
    elements: {
      meanMotionRevPerDay: num(record.MEAN_MOTION),
      eccentricity: num(record.ECCENTRICITY),
      inclinationDeg: num(record.INCLINATION),
      raanDeg: num(record.RA_OF_ASC_NODE),
      argPerigeeDeg: num(record.ARG_OF_PERICENTER),
      meanAnomalyDeg: num(record.MEAN_ANOMALY),
      bstar: num(record.BSTAR),
      meanMotionDot: num(record.MEAN_MOTION_DOT),
      meanMotionDdot: num(record.MEAN_MOTION_DDOT),
      elementSetNo: num(record.ELEMENT_SET_NO),
      revolutionAtEpoch: num(record.REV_AT_EPOCH),
      classification: typeof record.CLASSIFICATION_TYPE === 'string' ? record.CLASSIFICATION_TYPE : 'U',
      ephemerisType: num(record.EPHEMERIS_TYPE),
    },
  };
}

/** Initialise an SGP4 propagator. Throws if the elements cannot initialise. */
export function buildSatrec(record: GpRecord): SatRec {
  const satrec = json2satrec(record as never);
  if (!satrec || typeof satrec.no !== 'number' || !Number.isFinite(satrec.no) || satrec.no <= 0) {
    throw new Error('SGP4 initialisation failed: non-physical mean motion');
  }
  return satrec;
}

function mapError(code: SatRecError | number): PropagationFailure {
  switch (code) {
    case SatRecError.MeanEccentricityOutOfRange:
      return 'mean-eccentricity-out-of-range';
    case SatRecError.MeanMotionBelowZero:
      return 'mean-motion-below-zero';
    case SatRecError.PerturbedEccentricityOutOfRange:
      return 'perturbed-eccentricity-out-of-range';
    case SatRecError.SemiLatusRectumBelowZero:
      return 'semi-latus-rectum-below-zero';
    case SatRecError.Decayed:
      return 'decayed';
    default:
      return 'unknown-error';
  }
}

/** Human-readable explanation of a propagation failure, for the interface. */
export function describePropagationFailure(failure: PropagationFailure): string {
  switch (failure) {
    case 'decayed':
      return 'SGP4 reports this object has decayed — the propagated position is below the Earth’s surface.';
    case 'mean-eccentricity-out-of-range':
      return 'The element set’s mean eccentricity is outside the range SGP4 can propagate.';
    case 'perturbed-eccentricity-out-of-range':
      return 'The perturbed eccentricity left the valid range for this element set.';
    case 'mean-motion-below-zero':
      return 'The element set’s mean motion became non-physical (below zero).';
    case 'semi-latus-rectum-below-zero':
      return 'The orbit’s semi-latus rectum became negative — the elements are not physically consistent.';
    case 'invalid-input':
      return 'The element set is incomplete or could not be parsed.';
    default:
      return 'SGP4 did not return a usable position for this element set and time.';
  }
}

/**
 * Lean hot-path propagation used by the worker: returns only the scene-space
 * position for one object, or null when SGP4 cannot produce one. Uses exactly
 * the same propagate -> ECEF -> scene sequence as `propagateState`, so a worker
 * buffer entry and a main-thread marker can never disagree.
 */
export function propagateScenePosition(
  satrec: SatRec,
  date: Date,
  gmst: number,
): { x: number; y: number; z: number } | null {
  const result = propagate(satrec, date);
  if (!result || !result.position || typeof result.position === 'boolean') return null;
  const eci = result.position;
  if (![eci.x, eci.y, eci.z].every(Number.isFinite)) return null;
  const ecef = eciToEcef({ x: eci.x, y: eci.y, z: eci.z }, gmst);
  const scene = ecefToScene(ecef);
  if (![scene.x, scene.y, scene.z].every(Number.isFinite)) return null;
  return scene;
}

/**
 * Propagate one object to one instant, returning ECI, ECEF, geodetic and scene
 * coordinates. On failure `error` is set and the position fields are NaN — no
 * substitute coordinates are ever invented.
 */
export function propagateState(
  satrec: SatRec,
  noradId: number,
  date: Date,
  gmst = gmstFor(date),
): SatelliteState {
  const failures: SatelliteState = {
    noradId,
    timeMs: date.getTime(),
    positionEciKm: { x: NaN, y: NaN, z: NaN },
    velocityEciKmS: { x: NaN, y: NaN, z: NaN },
    positionEcefKm: { x: NaN, y: NaN, z: NaN },
    geodetic: { latitudeDeg: NaN, longitudeDeg: NaN, altitudeKm: NaN },
    scene: { x: NaN, y: NaN, z: NaN },
    speedKmS: NaN,
    radiusKm: NaN,
    error: 'unknown-error',
  };

  const result = propagate(satrec, date);
  if (!result || !result.position || typeof result.position === 'boolean') {
    failures.error = mapError(satrec.error ?? SatRecError.None);
    return failures;
  }

  const { position, velocity } = result;
  const eci = { x: position.x, y: position.y, z: position.z };
  const vel = { x: velocity.x, y: velocity.y, z: velocity.z };
  if (![eci.x, eci.y, eci.z, vel.x, vel.y, vel.z].every(Number.isFinite)) {
    failures.error = mapError(satrec.error ?? SatRecError.None);
    return failures;
  }

  const ecef = eciToEcef(eci, gmst);
  const scene = ecefToScene(ecef);
  const radiusKm = Math.hypot(ecef.x, ecef.y, ecef.z);

  return {
    noradId,
    timeMs: date.getTime(),
    positionEciKm: eci,
    velocityEciKmS: vel,
    positionEcefKm: ecef,
    // Conversion on the next line is a pure rotation; the flattening required
    // for geodetic latitude is applied by satellite.js's `eciToGeodetic`.
    geodetic: geodeticFromEcef(ecef),
    scene,
    speedKmS: Math.hypot(vel.x, vel.y, vel.z),
    radiusKm,
    error: null,
  };
}


/**
 * Convert an ECEF position (km) to geodetic latitude/longitude/height on the
 * WGS-84 ellipsoid used by satellite.js.
 *
 * `eciToGeodetic(eci, gmst)` rotates by `-gmst` internally, so passing an
 * already-Earth-fixed vector with gmst = 0 performs no rotation and solves the
 * geodetic latitude/height iteration for that ECEF position directly. This keeps
 * the displayed sub-satellite point and the propagated ECEF position derived
 * from one and the same vector.
 */
export function geodeticFromEcef(ecef: { x: number; y: number; z: number }): {
  latitudeDeg: number;
  longitudeDeg: number;
  altitudeKm: number;
} {
  const g = eciToGeodetic(ecef as never, 0);
  const latitudeDeg = (g.latitude * 180) / Math.PI;
  const longitudeDeg = (g.longitude * 180) / Math.PI;
  return {
    latitudeDeg,
    // Normalise longitude into [-180, 180).
    longitudeDeg: ((((longitudeDeg + 180) % 360) + 360) % 360) - 180,
    altitudeKm: g.height,
  };
}
