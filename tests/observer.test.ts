/**
 * Tests for observer-relative geometry: geodetic conversion, look angles,
 * solar altitude, eclipse classification, pass prediction and the viewing
 * heuristic.
 *
 * Wherever possible the reference is an *independent* implementation inside
 * satellite.js itself (`geodeticToEcf`, `ecfToLookAngles`), so these tests
 * cross-check Skyline's closed-form math rather than re-asserting it.
 */
import { describe, expect, it } from 'vitest';
import { ecfToLookAngles, geodeticToEcf, twoline2satrec } from 'satellite.js';
import { buildSatrec, parseEpochMs, propagateState, validateGpRecord } from '../src/orbital/elements';
import {
  compassPoint,
  darknessCategory,
  geodeticToEcefKm,
  lookAnglesAt,
  lookAnglesFromEcef,
  predictPasses,
  satelliteIllumination,
  solarAltitudeDeg,
  sunDirectionEcef,
  viewingScore,
  type ObserverLocation,
} from '../src/orbital/observer';
import { gmstFor, subsolarPoint } from '../src/orbital/frames';
import samples from './fixtures/gp-samples.json';

const issChecked = (() => {
  const result = validateGpRecord(samples.items[0].record);
  if (!result.ok) throw new Error('ISS fixture invalid');
  return result.record;
})();

const PRINCETON: ObserverLocation = { latitudeDeg: 40.3573, longitudeDeg: -74.6672, label: 'Princeton, NJ' };
// Near the ISS element epoch so SGP4 accuracy is at its best.
const REF_MS = parseEpochMs(issChecked.EPOCH) + 3 * 3600_000;

function angularDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

describe('geodeticToEcefKm', () => {
  it('agrees with satellite.js geodeticToEcf to millimetres', () => {
    const cases: ObserverLocation[] = [
      PRINCETON,
      { latitudeDeg: 0, longitudeDeg: 0 },
      { latitudeDeg: -33.8688, longitudeDeg: 151.2093 },
      { latitudeDeg: 64.1466, longitudeDeg: -21.9426 },
      { latitudeDeg: 89.9, longitudeDeg: 45 },
      { latitudeDeg: 40.3573, longitudeDeg: -74.6672, heightKm: 0.05 },
    ];
    for (const obs of cases) {
      const ours = geodeticToEcefKm(obs);
      const ref = geodeticToEcf({
        latitude: (obs.latitudeDeg * Math.PI) / 180,
        longitude: (obs.longitudeDeg * Math.PI) / 180,
        height: obs.heightKm ?? 0,
      });
      expect(Math.hypot(ours.x - ref.x, ours.y - ref.y, ours.z - ref.z)).toBeLessThan(1e-6);
    }
  });
});

describe('lookAnglesFromEcef', () => {
  it('agrees with satellite.js ecfToLookAngles', () => {
    const satrec = buildSatrec(issChecked);
    for (let k = 0; k < 12; k++) {
      const t = REF_MS + k * 9 * 60_000;
      const date = new Date(t);
      const state = propagateState(satrec, 25544, date, gmstFor(date));
      expect(state.error).toBeNull();
      const ours = lookAnglesFromEcef(state.positionEcefKm, PRINCETON, t);
      const ref = ecfToLookAngles(
        { latitude: (PRINCETON.latitudeDeg * Math.PI) / 180, longitude: (PRINCETON.longitudeDeg * Math.PI) / 180, height: 0 },
        state.positionEcefKm,
      );
      const refAz = (ref.azimuth * 180) / Math.PI;
      const refEl = (ref.elevation * 180) / Math.PI;
      expect(angularDiff(ours.azimuthDeg, refAz)).toBeLessThan(1e-6);
      expect(Math.abs(ours.elevationDeg - refEl)).toBeLessThan(1e-6);
      expect(Math.abs(ours.rangeKm - ref.rangeSat)).toBeLessThan(1e-6);
    }
  });

  it('reports the zenith as elevation ~90°', () => {
    const satrec = buildSatrec(issChecked);
    const date = new Date(REF_MS);
    const state = propagateState(satrec, 25544, date, gmstFor(date));
    expect(state.error).toBeNull();
    // Stand at the sub-satellite point: the satellite must be overhead.
    const obs: ObserverLocation = {
      latitudeDeg: state.geodetic.latitudeDeg,
      longitudeDeg: state.geodetic.longitudeDeg,
    };
    const look = lookAnglesFromEcef(state.positionEcefKm, obs, REF_MS);
    expect(look.elevationDeg).toBeGreaterThan(89.9);
    expect(look.rangeKm).toBeCloseTo(state.geodetic.altitudeKm, 0);
  });
});

describe('solarAltitudeDeg', () => {
  it('places the Sun overhead at the sub-solar point', () => {
    // At the March equinox noon UTC the sub-solar point is near (0°, 0°)-ish;
    // rather than hardcode ephemeris values, verify internal consistency: the
    // altitude at the sub-solar point must be ~90° whatever the date.
    const date = new Date('2026-03-20T12:00:00Z');
    // Sub-solar point from the same ephemeris: altitude there must be 90°.
    const sub = subsolarPoint(date);
    const alt = solarAltitudeDeg({ latitudeDeg: sub.latitudeDeg, longitudeDeg: sub.longitudeDeg }, date);
    expect(alt).toBeCloseTo(90, 0);
    // The antipode must be in full night.
    const anti = solarAltitudeDeg(
      { latitudeDeg: -sub.latitudeDeg, longitudeDeg: sub.longitudeDeg + 180 },
      date,
    );
    expect(anti).toBeCloseTo(-90, 0);
  });

  it('classifies darkness by standard solar-depression boundaries', () => {
    expect(darknessCategory(10)).toBe('daylight');
    expect(darknessCategory(0)).toBe('daylight');
    expect(darknessCategory(-3)).toBe('civil-twilight');
    expect(darknessCategory(-6)).toBe('civil-twilight');
    expect(darknessCategory(-9)).toBe('nautical-twilight');
    expect(darknessCategory(-12)).toBe('nautical-twilight');
    expect(darknessCategory(-15)).toBe('astronomical-night');
  });
});

describe('satelliteIllumination', () => {
  it('never reports an eclipse on the day side', () => {
    const satrec = buildSatrec(issChecked);
    for (let k = 0; k < 24; k++) {
      const t = REF_MS + k * 15 * 60_000;
      const date = new Date(t);
      const state = propagateState(satrec, 25544, date, gmstFor(date));
      if (state.error) continue;
      const sun = sunDirectionEcef(date);
      const illum = satelliteIllumination(state.positionEcefKm, sun);
      const s = state.positionEcefKm.x * sun.x + state.positionEcefKm.y * sun.y + state.positionEcefKm.z * sun.z;
      if (s >= 0) expect(illum).toBe('sunlit');
      else expect(['sunlit', 'penumbra', 'umbra']).toContain(illum);
    }
  });

  it('finds both sunlight and shadow across a day of ISS flight', () => {
    const satrec = buildSatrec(issChecked);
    const seen = new Set<string>();
    for (let k = 0; k < 96; k++) {
      const t = REF_MS + k * 15 * 60_000;
      const date = new Date(t);
      const state = propagateState(satrec, 25544, date, gmstFor(date));
      if (state.error) continue;
      seen.add(satelliteIllumination(state.positionEcefKm, sunDirectionEcef(date)));
    }
    expect(seen.has('sunlit')).toBe(true);
    // The ISS orbit must cross Earth's shadow at some point in 24 h.
    expect(seen.has('umbra') || seen.has('penumbra')).toBe(true);
  });
});

describe('predictPasses', () => {
  it('finds ISS passes over Princeton with self-consistent geometry', () => {
    const satrec = buildSatrec(issChecked);
    const start = REF_MS;
    const end = REF_MS + 48 * 3600_000;
    const passes = predictPasses(satrec, 25544, PRINCETON, start, end, {
      minElevationDeg: 10,
      stepSeconds: 30,
      maxPasses: 12,
    });
    expect(passes.length).toBeGreaterThan(0);
    for (const pass of passes) {
      expect(pass.set.timeMs).toBeGreaterThan(pass.rise.timeMs);
      expect(pass.peak.timeMs).toBeGreaterThanOrEqual(pass.rise.timeMs);
      expect(pass.peak.timeMs).toBeLessThanOrEqual(pass.set.timeMs);
      // Rise/set sit on the 10° threshold (bisection tolerance).
      expect(Math.abs(pass.rise.elevationDeg - 10)).toBeLessThan(0.5);
      expect(Math.abs(pass.set.elevationDeg - 10)).toBeLessThan(0.5);
      expect(pass.maxElevationDeg).toBeGreaterThanOrEqual(10);
      // The reported peak matches an independent propagation at the peak time.
      const check = lookAnglesAt(satrec, 25544, PRINCETON, pass.peak.timeMs);
      expect(check).not.toBeNull();
      expect(Math.abs((check as NonNullable<typeof check>).elevationDeg - pass.maxElevationDeg)).toBeLessThan(0.1);
      expect(
        angularDiff((check as NonNullable<typeof check>).azimuthDeg, pass.peak.azimuthDeg),
      ).toBeLessThan(0.5);
    }
    // Chronological, non-overlapping.
    for (let k = 1; k < passes.length; k++) {
      expect(passes[k].rise.timeMs).toBeGreaterThanOrEqual(passes[k - 1].set.timeMs);
    }
  });

  it('returns an empty list — never an invented pass — when nothing rises', () => {
    // A geostationary satellite never rises above 10° for a high-latitude
    // observer looking at the wrong longitude; use a GEO TLE for the test.
    const geo = twoline2satrec(
      '1 99999U 24001A   26010.00000000  .00000000  00000-0  00000-0 0  0001',
      '2 99999   0.0200 100.0000 0001000  90.0000 270.0000  1.00270000    10',
    );
    const northPole: ObserverLocation = { latitudeDeg: 85, longitudeDeg: 0 };
    const passes = predictPasses(geo, 99999, northPole, REF_MS, REF_MS + 24 * 3600_000, {
      minElevationDeg: 10,
      stepSeconds: 60,
    });
    expect(passes).toEqual([]);
  });

  it('rejects nonsense windows', () => {
    const satrec = buildSatrec(issChecked);
    expect(predictPasses(satrec, 25544, PRINCETON, REF_MS, REF_MS)).toEqual([]);
    expect(predictPasses(satrec, 25544, PRINCETON, REF_MS + 1000, REF_MS)).toEqual([]);
  });
});

describe('viewingScore', () => {
  it('is bounded, deterministic and discloses the cloud assumption', () => {
    const satrec = buildSatrec(issChecked);
    const passes = predictPasses(satrec, 25544, PRINCETON, REF_MS, REF_MS + 48 * 3600_000, {
      minElevationDeg: 10,
      stepSeconds: 30,
      maxPasses: 3,
    });
    expect(passes.length).toBeGreaterThan(0);
    for (const pass of passes) {
      const withClouds = viewingScore({ pass, cloudCoverPercent: 20 });
      const withoutClouds = viewingScore({ pass, cloudCoverPercent: null });
      for (const s of [withClouds, withoutClouds]) {
        expect(s.score).toBeGreaterThanOrEqual(0);
        expect(s.score).toBeLessThanOrEqual(100);
        expect(s.factors.reduce((n, f) => n + f.points, 0)).toBe(s.score);
      }
      // Same inputs -> same score.
      expect(viewingScore({ pass, cloudCoverPercent: 20 }).score).toBe(withClouds.score);
      // Missing forecast is disclosed, not silently filled.
      expect(withoutClouds.assumptions.length).toBeGreaterThan(0);
      expect(withClouds.assumptions).toEqual([]);
      // Clearer skies never score worse, all else equal.
      const overcast = viewingScore({ pass, cloudCoverPercent: 100 });
      expect(withClouds.score).toBeGreaterThanOrEqual(overcast.score);
    }
  });
});

describe('compassPoint', () => {
  it('maps azimuths to 16-wind compass points', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(90)).toBe('E');
    expect(compassPoint(180)).toBe('S');
    expect(compassPoint(270)).toBe('W');
    expect(compassPoint(23)).toBe('NNE');
    expect(compassPoint(359)).toBe('N');
  });
});

