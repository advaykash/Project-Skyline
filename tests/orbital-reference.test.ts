/**
 * Independent scientific verification.
 *
 * `tests/fixtures/reference-states.json` is produced by
 * `tools/skyfield-reference.py` using a separately implemented SGP4
 * (python `sgp4`, the canonical Vallado transcription) and a separate geodetic
 * solution (`skyfield`, WGS-84). This suite replays those exact element sets
 * and instants through the application's own pipeline and compares.
 *
 * TOLERANCES are justified by the known, documented differences between the two
 * chains — they are not fitted to make failures disappear:
 *
 *   • TEME position: both implementations use identical elements (the fixture
 *     generator verifies its TLE round-trip to 1e-4 deg / 1e-7 ecc). Remaining
 *     differences are microsecond-level epoch truncation, which translate to
 *     metres along-track. 200 m is a generous bound that still fails instantly
 *     on any degrees/radians, frame, or time-standard bug (those show up as
 *     tens to thousands of kilometres).
 *
 *   • Geodetic lat/lon: satellite.js rotates TEME->ECEF with GMST only, while
 *     skyfield applies a full IAU 2000A rotation. The residual (equation of the
 *     equinoxes + precession) is bounded by ~0.005°, i.e. ~550 m on the ground.
 *     0.01° is the stated tolerance; altitude differs only by ellipsoid
 *     constants, so 1 km is generous.
 */
import { describe, expect, it } from 'vitest';
import reference from './fixtures/reference-states.json';
import { buildSatrec, propagateState } from '../src/orbital/elements';
import type { GpRecord } from '../src/orbital/types';

const TEME_POSITION_TOLERANCE_KM = 0.2;
const GEODETIC_TOLERANCE_DEG = 0.01;
const ALTITUDE_TOLERANCE_KM = 1.0;

const sample = (noradId: number) => {
  const item = reference.entries.find((e) => e.noradId === noradId && 'temeKm' in e);
  if (!item) throw new Error(`no reference state for NORAD ${noradId}`);
  return item;
};

// Load the source elements the fixture generator used, from the same committed
// fixture file, so the two sides propagate identical records.
import samples from './fixtures/gp-samples.json';

const recordsByNorad = new Map<number, GpRecord>(
  samples.items.map((item) => [Number(item.record.NORAD_CAT_ID), item.record as GpRecord]),
);

describe('independent SGP4 reference verification (python sgp4 / skyfield)', () => {
  const withState = reference.entries.filter((e) => 'temeKm' in e) as Array<
    (typeof reference.entries)[number] & { temeKm: { x: number; y: number; z: number }; temeKmS: { x: number; y: number; z: number }; geodetic: { latitudeDeg: number; longitudeDeg: number; altitudeKm: number }; noradId: number; instant: string }
  >;

  it('has reference states to compare against', () => {
    expect(withState.length).toBeGreaterThanOrEqual(15);
    expect(new Set(withState.map((e) => e.noradId)).size).toBeGreaterThanOrEqual(5);
  });

  for (const entry of withState) {
    it(`NORAD ${entry.noradId} at ${entry.instant} matches the reference implementation`, () => {
      const record = recordsByNorad.get(entry.noradId);
      if (!record) throw new Error(`source record for NORAD ${entry.noradId} missing from gp-samples`);
      const satrec = buildSatrec(record);
      const date = new Date(entry.instant);
      const state = propagateState(satrec, entry.noradId, date);

      expect(state.error).toBeNull();

      // --- TEME position against the canonical Vallado implementation ---
      const dx = state.positionEciKm.x - entry.temeKm.x;
      const dy = state.positionEciKm.y - entry.temeKm.y;
      const dz = state.positionEciKm.z - entry.temeKm.z;
      const temeErrorKm = Math.hypot(dx, dy, dz);
      expect(
        temeErrorKm,
        `TEME position error ${temeErrorKm.toFixed(6)} km exceeds ${TEME_POSITION_TOLERANCE_KM} km ` +
          `(${entry.noradId} @ ${entry.instant})`,
      ).toBeLessThan(TEME_POSITION_TOLERANCE_KM);

      // --- Velocity magnitude (frame-independent) ---
      const speedRef = Math.hypot(entry.temeKmS.x, entry.temeKmS.y, entry.temeKmS.z);
      expect(state.speedKmS).toBeCloseTo(speedRef, 3);

      // --- Geodetic sub-satellite point against skyfield ---
      const dLat = Math.abs(state.geodetic.latitudeDeg - entry.geodetic.latitudeDeg);
      let dLon = Math.abs(state.geodetic.longitudeDeg - entry.geodetic.longitudeDeg);
      if (dLon > 180) dLon = 360 - dLon;
      expect(
        dLat,
        `latitude error ${dLat.toFixed(5)}° (${entry.noradId} @ ${entry.instant})`,
      ).toBeLessThan(GEODETIC_TOLERANCE_DEG);
      expect(
        dLon,
        `longitude error ${dLon.toFixed(5)}° (${entry.noradId} @ ${entry.instant})`,
      ).toBeLessThan(GEODETIC_TOLERANCE_DEG);
      expect(
        Math.abs(state.geodetic.altitudeKm - entry.geodetic.altitudeKm),
        `altitude error (${entry.noradId} @ ${entry.instant})`,
      ).toBeLessThan(ALTITUDE_TOLERANCE_KM);
    });
  }

  it('reports the propagation instant and epoch that were actually used', () => {
    const entry = sample(25544);
    const record = recordsByNorad.get(25544);
    if (!record) throw new Error('ISS record missing');
    const satrec = buildSatrec(record);
    const date = new Date(entry.instant);
    const state = propagateState(satrec, 25544, date);
    expect(state.timeMs).toBe(date.getTime());
    // The element epoch from the fixture must be the one the propagator used.
    expect(satrec.jdsatepoch).toBeGreaterThan(2461300);
  });
});
