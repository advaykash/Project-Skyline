/**
 * Orbit path and ground-track generation.
 *
 * Both are produced by propagating the real SGP4 element set with the same
 * transforms the marker uses (`propagateState`), so a path can never disagree
 * with a marker position. Two clearly distinct products:
 *
 *   • Orbit path  — the 3D trajectory in the Earth-fixed scene frame over one
 *     orbital period, centred on the current time. Samples are rotated into
 *     ECEF, so the path correctly shows the westward drift of successive
 *     revolutions and the Earth's rotation beneath the orbit.
 *
 *   • Ground track — the sub-satellite point projected onto the Earth's surface
 *     over a window of time, either as geodetic lat/lon pairs (for the 2D
 *     readout and export) or as scene-space points at surface radius (for the
 *     on-globe projection). The track is split at the antimeridian so it is
 *     never drawn as a false straight line across the globe.
 */
import type { SatRec } from 'satellite.js';
import { geodeticToSceneUnit, gmstFor, sunDirectionScene } from './frames';
import { propagateState } from './elements';
import { orbitalPeriodMinutes } from './derived';
import { surfaceRadiusScene } from './frames';
import type { GpRecord } from './types';

export interface OrbitPath {
  /** Scene-space points of the trajectory, in chronological order. */
  positions: Float32Array;
  /** Sample timestamps (ms since epoch), one per vertex. */
  timesMs: Float64Array;
  /** Number of vertices (positions.length / 3). */
  count: number;
  /** Start/end of the sampled window. */
  startMs: number;
  endMs: number;
}

export interface GroundTrackSegment {
  /** Scene-space points at surface radius. */
  positions: Float32Array;
  /** Geodetic coordinates for the same vertices. */
  geodetic: Array<{ latDeg: number; lonDeg: number }>;
  count: number;
}

export interface GroundTrack {
  /** One or more contiguous segments; a new segment starts at each date line crossing. */
  segments: GroundTrackSegment[];
  startMs: number;
  endMs: number;
}

/**
 * Sample the orbit over one period.
 *
 * @param stepsPerPeriod vertex count; 240 gives a smooth curve at every zoom
 *        level the camera allows while staying cheap to rebuild.
 * @param includeFullPeriod true: sample epoch -> epoch + period (one full
 *        revolution forward). false: centre the window on `atMs`.
 */
export function computeOrbitPath(
  satrec: SatRec,
  noradId: number,
  atMs: number,
  meanMotionRevPerDay: number,
  stepsPerPeriod = 240,
): OrbitPath | null {
  const periodMin = orbitalPeriodMinutes(meanMotionRevPerDay);
  if (!Number.isFinite(periodMin) || periodMin <= 0) return null;

  const periodMs = periodMin * 60_000;
  const startMs = atMs;
  const positions = new Float32Array((stepsPerPeriod + 1) * 3);
  const timesMs = new Float64Array(stepsPerPeriod + 1);

  let written = 0;
  for (let i = 0; i <= stepsPerPeriod; i += 1) {
    const t = startMs + (periodMs * i) / stepsPerPeriod;
    const state = propagateState(satrec, noradId, new Date(t));
    timesMs[i] = t;
    if (state.error) {
      // A failure partway through the orbit still yields a valid partial arc;
      // stop the walk rather than connecting across a gap.
      break;
    }
    positions[written * 3] = state.scene.x;
    positions[written * 3 + 1] = state.scene.y;
    positions[written * 3 + 2] = state.scene.z;
    written += 1;
  }
  if (written < 2) return null;

  return {
    positions: positions.subarray(0, written * 3),
    timesMs: timesMs.subarray(0, written),
    count: written,
    startMs,
    endMs: timesMs[written - 1],
  };
}

/**
 * Sub-satellite ground track over a window centred on the current time.
 *
 * The window defaults to one orbital period, which is the intuitive unit for a
 * tracker. `directionMs` shifts the window forwards (positive) or backwards.
 */
export function computeGroundTrack(
  satrec: SatRec,
  noradId: number,
  atMs: number,
  meanMotionRevPerDay: number,
  windowPeriods = 1,
  steps = 180,
): GroundTrack | null {
  const periodMin = orbitalPeriodMinutes(meanMotionRevPerDay);
  if (!Number.isFinite(periodMin) || periodMin <= 0) return null;
  const halfWindowMs = (periodMin * 60_000 * windowPeriods) / 2;
  const startMs = atMs - halfWindowMs;
  const endMs = atMs + halfWindowMs;

  const segments: GroundTrackSegment[] = [];
  let currentPositions: number[] = [];
  let currentGeodetic: Array<{ latDeg: number; lonDeg: number }> = [];

  const previousLon: { value: number | null } = { value: null };

  const flush = () => {
    if (currentPositions.length >= 6) {
      segments.push({
        positions: new Float32Array(currentPositions),
        geodetic: currentGeodetic,
        count: currentPositions.length / 3,
      });
    }
    currentPositions = [];
    currentGeodetic = [];
  };

  for (let i = 0; i <= steps; i += 1) {
    const t = startMs + ((endMs - startMs) * i) / steps;
    const state = propagateState(satrec, noradId, new Date(t));
    if (state.error) {
      flush();
      previousLon.value = null;
      continue;
    }
    const { latitudeDeg, longitudeDeg } = state.geodetic;
    if (
      previousLon.value !== null &&
      Math.abs(longitudeDeg - previousLon.value) > 180 // date line crossing
    ) {
      flush();
    }
    const radius = surfaceRadiusScene(latitudeDeg) * 1.002; // lift slightly off the surface
    const p = geodeticToSceneUnit(latitudeDeg, longitudeDeg, radius);
    currentPositions.push(p.x, p.y, p.z);
    currentGeodetic.push({ latDeg: latitudeDeg, lonDeg: longitudeDeg });
    previousLon.value = longitudeDeg;
  }
  flush();

  return { segments, startMs, endMs };
}

/**
 * Build a propagator-input-agnostic helper used by the inspector: the current
 * sub-satellite point, the solar direction and the element age, in one call.
 * Kept here so path generation and marker placement share one time base.
 */
export function timeContext(atMs: number): {
  date: Date;
  gmst: number;
  sunDirectionScene: { x: number; y: number; z: number };
} {
  const date = new Date(atMs);
  return { date, gmst: gmstFor(date), sunDirectionScene: sunDirectionScene(date) };
}

/** Convenience re-export so callers do not need to reach into frames directly. */
export type { GpRecord };
