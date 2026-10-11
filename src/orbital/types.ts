/**
 * Types describing source catalogue records and computed satellite state.
 *
 * CelesTrak GP payloads are treated as **untrusted input**: every field is
 * validated in `parseRecord` before an SGP4 propagator is built from it.
 */

/** A single CelesTrak GP (OMM v3 style) record, as received. */
export interface GpRecord {
  OBJECT_NAME: string;
  OBJECT_ID: string;
  /** ISO-8601 UTC element epoch, e.g. "2026-10-09T22:48:38.797056". */
  EPOCH: string;
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  INCLINATION: number;
  RA_OF_ASC_NODE: number;
  ARG_OF_PERICENTER: number;
  MEAN_ANOMALY: number;
  NORAD_CAT_ID: number;
  ELEMENT_SET_NO?: number;
  REV_AT_EPOCH?: number;
  BSTAR?: number;
  MEAN_MOTION_DOT?: number;
  MEAN_MOTION_DDOT?: number;
  CLASSIFICATION_TYPE?: string;
  EPHEMERIS_TYPE?: number;
  [key: string]: unknown;
}

/** A validated catalogue entry: source record plus derived identity fields. */
export interface CatalogObject {
  /** Position of the object in the loaded catalogue array. */
  index: number;
  noradId: number;
  name: string;
  /** International designator, e.g. "1998-067A". */
  objectId: string;
  /** Element epoch, milliseconds since the Unix epoch (UTC). */
  epochMs: number;
  /** Epoch age at load time, in days. */
  epochAgeDays: number;
  /** Source orbital elements, in their published units. */
  elements: {
    meanMotionRevPerDay: number;
    eccentricity: number;
    inclinationDeg: number;
    raanDeg: number;
    argPerigeeDeg: number;
    meanAnomalyDeg: number;
    bstar: number;
    meanMotionDot: number;
    meanMotionDdot: number;
    elementSetNo: number;
    revolutionAtEpoch: number;
    classification: string;
    ephemerisType: number;
  };
}

/** Why a propagation attempt did not produce a usable state vector. */
export type PropagationFailure =
  | 'mean-eccentricity-out-of-range'
  | 'mean-motion-below-zero'
  | 'perturbed-eccentricity-out-of-range'
  | 'semi-latus-rectum-below-zero'
  | 'decayed'
  | 'unknown-error'
  | 'invalid-input';

/** Result of propagating one object to one instant. */
export interface SatelliteState {
  noradId: number;
  /** Milliseconds since the Unix epoch for which this state was computed. */
  timeMs: number;
  /** TEME frame position, km. */
  positionEciKm: { x: number; y: number; z: number };
  /** TEME frame velocity, km/s. */
  velocityEciKmS: { x: number; y: number; z: number };
  /** ECEF frame position, km. */
  positionEcefKm: { x: number; y: number; z: number };
  /** Geodetic sub-satellite point, WGS-84 datum; altitude is height above that ellipsoid. */
  geodetic: { latitudeDeg: number; longitudeDeg: number; altitudeKm: number };
  /** Earth-fixed scene position, scene units (Earth mean radius = 1). */
  scene: { x: number; y: number; z: number };
  /** Speed magnitude, km/s (frame-independent). */
  speedKmS: number;
  /** Total geocentric distance from the Earth's centre, km. */
  radiusKm: number;
  error: PropagationFailure | null;
}

// Data-provenance contracts live in shared/contracts.ts so the backend and the
// frontend cannot drift apart.
export type { CatalogProvenance, DataState, FreshnessPolicy } from '../../shared/contracts';
