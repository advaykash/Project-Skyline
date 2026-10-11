/**
 * Unit tests for the orbital core: record validation, frame conventions,
 * propagation sanity, and derived-property formulas.
 *
 * These tests assert *physical* properties (bounds, consistency between
 * coordinate representations, known formulas), not implementation details.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSatrec,
  describePropagationFailure,
  propagateState,
  toCatalogObject,
  validateGpRecord,
} from '../src/orbital/elements';
import type { GpRecord } from '../src/orbital/types';
import {
  ecefToScene,
  geodeticToSceneUnit,
  gmstFor,
  sceneToEcef,
  sceneUnitToGeodetic,
  sunDirectionScene,
  surfaceRadiusScene,
} from '../src/orbital/frames';
import {
  apsisAltitudesKm,
  deriveElements,
  elementAgeDays,
  estimatedAlongTrackDriftKm,
  isGeosynchronous,
  orbitalPeriodMinutes,
  orbitRegime,
  semiMajorAxisKm,
} from '../src/orbital/derived';
import { EARTH_EQ_RADIUS_WGS84_KM, EARTH_MEAN_RADIUS_KM } from '../src/orbital/constants';
import samples from './fixtures/gp-samples.json';

const issRecord = samples.items[0].record as Record<string, unknown>;
const iss = validateGpRecord(issRecord);
const nowMs = Date.parse('2026-10-10T12:00:00Z');

/** Narrowed copy of the ISS fixture, for code that needs the validated record. */
const issChecked = ((): GpRecord => {
  if (!iss.ok) throw new Error('ISS fixture invalid');
  return iss.record;
})();

function expectValidationFails(raw: unknown, reasonFragment: string) {
  const result = validateGpRecord(raw);
  expect(result.ok, `expected rejection containing "${reasonFragment}"`).toBe(false);
  if (!result.ok) expect(result.reason).toContain(reasonFragment);
}

describe('GP record validation', () => {
  it('accepts a real CelesTrak record', () => {
    expect(iss.ok).toBe(true);
  });

  it('rejects non-objects and missing names', () => {
    expectValidationFails(null, 'not an object');
    expectValidationFails({}, 'OBJECT_NAME');
    expectValidationFails({ OBJECT_NAME: '   ', EPOCH: '2026-01-01T00:00:00Z' }, 'OBJECT_NAME');
  });

  it('rejects unparseable epochs', () => {
    expectValidationFails({ ...issRecord, EPOCH: 'not-a-date' }, 'EPOCH');
    expectValidationFails({ ...issRecord, EPOCH: undefined }, 'EPOCH');
  });

  it('rejects missing or non-numeric propagation fields', () => {
    expectValidationFails({ ...issRecord, MEAN_MOTION: undefined }, 'MEAN_MOTION');
    expectValidationFails({ ...issRecord, ECCENTRICITY: 'abc' }, 'ECCENTRICITY');
  });

  it('rejects physically impossible element ranges', () => {
    expectValidationFails({ ...issRecord, MEAN_MOTION: -1 }, 'positive');
    expectValidationFails({ ...issRecord, ECCENTRICITY: 1.2 }, 'ECCENTRICITY');
    expectValidationFails({ ...issRecord, INCLINATION: -5 }, 'INCLINATION');
    expectValidationFails({ ...issRecord, INCLINATION: 181 }, 'INCLINATION');
    expectValidationFails({ ...issRecord, EPOCH: '2099-01-01T00:00:00Z' }, 'future');
  });

  it('builds an SGP4 propagator from validated elements', () => {
    const satrec = buildSatrec(issChecked);
    expect(satrec.satnum).toBe('25544');
    // Mean motion in rad/min, sanity: ISS is ~15.49 rev/day -> ~0.0676 rad/min.
    expect(satrec.no).toBeGreaterThan(0.06);
    expect(satrec.no).toBeLessThan(0.075);
  });

  it('describes propagation failures in user language', () => {
    expect(describePropagationFailure('decayed')).toMatch(/decayed/i);
    expect(describePropagationFailure('unknown-error')).toMatch(/SGP4/);
  });
});

describe('frame conventions', () => {
  it('maps Greenwich/ equator to +X, 90E to -Z, north pole to +Y', () => {
    const greenwich = geodeticToSceneUnit(0, 0);
    expect(greenwich.x).toBeCloseTo(1, 12);
    expect(greenwich.y).toBeCloseTo(0, 12);
    expect(greenwich.z).toBeCloseTo(0, 12);

    const east = geodeticToSceneUnit(0, 90);
    expect(east.x).toBeCloseTo(0, 12);
    expect(east.y).toBeCloseTo(0, 12);
    expect(east.z).toBeCloseTo(-1, 12);

    const pole = geodeticToSceneUnit(90, 0);
    expect(pole.x).toBeCloseTo(0, 12);
    expect(pole.y).toBeCloseTo(1, 12);
    expect(pole.z).toBeCloseTo(0, 12);
  });

  it('round-trips scene unit vectors through geodetic coordinates', () => {
    for (const [lat, lon] of [
      [37.7749, -122.4194],
      [-33.8688, 151.2093],
      [0, 180],
      [89.9, -45],
    ] as const) {
      const v = geodeticToSceneUnit(lat, lon);
      const back = sceneUnitToGeodetic(v);
      expect(back.latitudeDeg).toBeCloseTo(lat, 9);
      expect(back.longitudeDeg).toBeCloseTo(lon, 9);
    }
  });

  it('ecef<->scene mapping is norm-preserving and handedness-correct', () => {
    const ecef = { x: 1000, y: 2000, z: 3000 };
    const scene = ecefToScene(ecef);
    expect(scene.x).toBeCloseTo(1000 / EARTH_MEAN_RADIUS_KM, 12);
    expect(scene.y).toBeCloseTo(3000 / EARTH_MEAN_RADIUS_KM, 12);
    expect(scene.z).toBeCloseTo(-2000 / EARTH_MEAN_RADIUS_KM, 12);
    expect(Math.hypot(scene.x, scene.y, scene.z)).toBeCloseTo(Math.hypot(ecef.x, ecef.y, ecef.z) / EARTH_MEAN_RADIUS_KM, 12);
    const roundTrip = sceneToEcef(scene);
    expect(roundTrip.x).toBeCloseTo(ecef.x, 9);
    expect(roundTrip.y).toBeCloseTo(ecef.y, 9);
    expect(roundTrip.z).toBeCloseTo(ecef.z, 9);
  });

  it('keeps longitude sign convention: east-positive in geodetic, -Z in scene', () => {
    // A point 10° east of Greenwich must have negative scene.z and positive scene.x.
    const eastOfGreenwich = geodeticToSceneUnit(0, 10);
    expect(eastOfGreenwich.x).toBeGreaterThan(0);
    expect(eastOfGreenwich.z).toBeLessThan(0);
  });

  it('produces a unit sun direction and a finite surface radius', () => {
    const sun = sunDirectionScene(new Date('2026-10-10T12:00:00Z'));
    expect(Math.hypot(sun.x, sun.y, sun.z)).toBeCloseTo(1, 9);
    expect([sun.x, sun.y, sun.z].every(Number.isFinite)).toBe(true);
    // October: subsolar point in the southern hemisphere.
    expect(sun.y).toBeLessThan(0);
    const r0 = surfaceRadiusScene(0);
    const r90 = surfaceRadiusScene(90);
    expect(r0).toBeGreaterThan(1);
    expect(r90).toBeCloseTo((6356.7523142 / EARTH_MEAN_RADIUS_KM), 5);
    expect(r0).toBeGreaterThan(r90);
  });

  it('gmst is finite and grows with time', () => {
    const a = gmstFor(new Date('2026-01-01T00:00:00Z'));
    const b = gmstFor(new Date('2026-01-01T12:00:00Z'));
    expect(Number.isFinite(a)).toBe(true);
    expect(b).not.toBe(a);
  });
});

describe('propagation sanity (ISS)', () => {
  const satrec = buildSatrec(issChecked);

  it('produces a physically plausible state at the element epoch', () => {
    const state = propagateState(satrec, 25544, new Date('2026-10-09T22:48:38.797Z'));
    expect(state.error).toBeNull();

    // Altitude band: ISS orbits at roughly 400-450 km.
    expect(state.geodetic.altitudeKm).toBeGreaterThan(350);
    expect(state.geodetic.altitudeKm).toBeLessThan(500);
    // Speed band: circular LEO at ~420 km is ~7.66 km/s.
    expect(state.speedKmS).toBeGreaterThan(7.3);
    expect(state.speedKmS).toBeLessThan(8.0);
    // Inclination bound: geodetic latitude can never exceed inclination (51.64°).
    expect(Math.abs(state.geodetic.latitudeDeg)).toBeLessThanOrEqual(51.64 + 0.5);
    // Longitude normalisation.
    expect(Math.abs(state.geodetic.longitudeDeg)).toBeLessThanOrEqual(180);
  });

  it('keeps the rendered scene position consistent with the geodetic readout', () => {
    const date = new Date('2026-10-10T03:17:00Z');
    const state = propagateState(satrec, 25544, date);
    expect(state.error).toBeNull();

    // The scene position must have the same length as the ECEF position.
    const sceneRadius = Math.hypot(state.scene.x, state.scene.y, state.scene.z);
    const ecefRadius = Math.hypot(state.positionEcefKm.x, state.positionEcefKm.y, state.positionEcefKm.z);
    expect(sceneRadius * EARTH_MEAN_RADIUS_KM).toBeCloseTo(ecefRadius, 6);

    // Direction of the scene marker must agree with the geodetic sub-satellite
    // point. Geodetic latitude is ellipsoid-normal based while the marker uses
    // the true geocentric direction, so an angular difference of up to ~0.2° is
    // the known flattening effect — anything larger is a real mapping bug.
    const fromGeodetic = geodeticToSceneUnit(
      state.geodetic.latitudeDeg,
      state.geodetic.longitudeDeg,
      1,
    );
    const norm = sceneRadius;
    const fromEcef = { x: state.scene.x / norm, y: state.scene.y / norm, z: state.scene.z / norm };
    const dot = fromGeodetic.x * fromEcef.x + fromGeodetic.y * fromEcef.y + fromGeodetic.z * fromEcef.z;
    const angleDeg = (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
    expect(angleDeg).toBeLessThan(0.25);

    // Altitude above the WGS-84 ellipsoid must match the geocentric radius
    // within the same flattening effect (about 21 km at 45° latitude).
    const altFromRadius = ecefRadius - EARTH_EQ_RADIUS_WGS84_KM;
    expect(Math.abs(altFromRadius - state.geodetic.altitudeKm)).toBeLessThan(25);
  });

  it('returns error states rather than invented coordinates for invalid inputs', () => {
    // A SatRec forced into a non-physical state must not yield a silent position.
    const bad = buildSatrec(iss.record);
    bad.no = -1; // deliberately corrupt the mean motion
    const state = propagateState(bad, 25544, new Date('2026-10-10T12:00:00Z'));
    // Either an explicit error or NaN coordinates — never a plausible-looking lie.
    if (state.error === null) {
      expect([state.scene.x, state.scene.y, state.scene.z].every(Number.isFinite)).toBe(false);
    } else {
      expect(state.scene.x).toBeNaN();
    }
  });

  it('never exceeds the inclination bound in latitude over an orbit', () => {
    const t0 = Date.parse('2026-10-10T00:00:00Z');
    for (let i = 0; i < 40; i += 1) {
      const state = propagateState(satrec, 25544, new Date(t0 + i * 150_000));
      expect(state.error).toBeNull();
      expect(Math.abs(state.geodetic.latitudeDeg)).toBeLessThanOrEqual(51.64 + 0.5);
    }
  });
});

describe('derived properties', () => {
  it('derives the ISS period, semi-major axis and apsis altitudes', () => {
    const object = toCatalogObject(issChecked, 0, nowMs);
    const derived = deriveElements(object);
    // Published ISS mean motion 15.4879 rev/day -> 92.98 min.
    expect(derived.periodMinutes).toBeGreaterThan(92.5);
    expect(derived.periodMinutes).toBeLessThan(93.5);
    // Semi-major axis of a 420 km circular orbit: ~6795 km.
    expect(derived.semiMajorAxisKm).toBeGreaterThan(6700);
    expect(derived.semiMajorAxisKm).toBeLessThan(6900);
    // Near-circular: apogee and perigee differ by only a few kilometres.
    expect(Math.abs(derived.apogeeKm - derived.perigeeKm)).toBeLessThan(20);
    expect(derived.regime).toBe('LEO');
    expect(derived.isGeosynchronous).toBe(false);
  });

  it('computes period and semi-major axis from published formulas', () => {
    expect(orbitalPeriodMinutes(15.4879578)).toBeCloseTo(1440 / 15.4879578, 9);
    const a = semiMajorAxisKm(15.4879578);
    const nRadPerSec = (15.4879578 * 2 * Math.PI) / 86400;
    expect(a).toBeCloseTo(Math.cbrt(398600.8 / nRadPerSec ** 2), 9);
    const apsides = apsisAltitudesKm(15.4879578, 0.00066723);
    expect(apsides.apogeeKm).toBeCloseTo(a * (1 + 0.00066723) - EARTH_EQ_RADIUS_WGS84_KM, 9);
    expect(apsides.perigeeKm).toBeCloseTo(a * (1 - 0.00066723) - EARTH_EQ_RADIUS_WGS84_KM, 9);
  });

  it('classifies regimes and geosynchrony', () => {
    expect(isGeosynchronous(1.0027)).toBe(true);
    expect(isGeosynchronous(15.488)).toBe(false);
    expect(orbitRegime(1.0027, 0.0001)).toBe('GEO');
    expect(orbitRegime(2.0, 0.001)).toBe('MEO');
    expect(orbitRegime(15.488, 0.0001)).toBe('LEO');
    expect(orbitRegime(2.0, 0.7)).toBe('HEO');
  });

  it('reports element age and a conservative drift estimate', () => {
    const object = toCatalogObject(issChecked, 0, nowMs);
    const age = elementAgeDays(object, nowMs);
    expect(age).toBeGreaterThan(0);
    expect(age).toBeLessThan(2);
    const drift = estimatedAlongTrackDriftKm(15.4879578, 3);
    expect(drift).not.toBeNull();
    if (drift) {
      expect(drift.lowKm).toBeGreaterThan(0);
      expect(drift.highKm).toBeGreaterThan(drift.lowKm);
      expect(drift.highKm).toBeLessThan(20);
    }
    // Fresh elements: no drift claimed.
    expect(estimatedAlongTrackDriftKm(15.4879578, 0)).toEqual({ lowKm: 0, highKm: 0 });
  });
});

describe('marker density scaling (rendering contract)', () => {
  it('shrinks and de-glares markers as catalogues grow, so 16k objects cannot cover the Earth', async () => {
    const { createSatellitePoints, paintCategory } = await import('../src/globe/satellitePoints');

    // Sparse catalogue: larger, softer markers.
    const sparse = createSatellitePoints(22);
    sparse.geometry.userData.shaderUniforms = sparse.material.uniforms;
    paintCategory(sparse.geometry, 22, 'crewed');
    const sparseSizes = sparse.geometry.getAttribute('pointSize') as { getX(i: number): number };
    expect(sparseSizes.getX(0)).toBeGreaterThan(1.8);
    expect((sparse.material.uniforms.glow as { value: number }).value).toBeCloseTo(1, 5);

    // 16k catalogue: crisp, small markers; glow nearly off.
    const dense = createSatellitePoints(16468);
    dense.geometry.userData.shaderUniforms = dense.material.uniforms;
    paintCategory(dense.geometry, 16468, 'catalog');
    const denseSizes = dense.geometry.getAttribute('pointSize') as { getX(i: number): number };
    let maxSize = 0;
    for (let i = 0; i < 200; i += 1) maxSize = Math.max(maxSize, denseSizes.getX(i));
    expect(maxSize).toBeLessThan(1.2);
    expect((dense.material.uniforms.glow as { value: number }).value).toBeLessThan(0.3);
    expect((dense.material.uniforms.maxSize as { value: number }).value).toBeLessThan(7);
    expect((sparse.material.uniforms.maxSize as { value: number }).value).toBeCloseTo(13, 5);

    sparse.geometry.dispose();
    sparse.material.dispose();
    dense.geometry.dispose();
    dense.material.dispose();
  });
});
