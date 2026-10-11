/**
 * Orbit path and ground-track generation tests.
 *
 * The invariant under test: paths are produced by the same propagation and
 * frame transforms as markers, so a path vertex and a marker at the same
 * instant must coincide.
 */
import { describe, expect, it } from 'vitest';
import { buildSatrec, propagateState, validateGpRecord } from '../src/orbital/elements';
import { computeGroundTrack, computeOrbitPath } from '../src/orbital/orbit-path';
import { geodeticToSceneUnit, surfaceRadiusScene } from '../src/orbital/frames';
import samples from './fixtures/gp-samples.json';

const issSample = samples.items[0].record;
const issValidation = validateGpRecord(issSample);
if (!issValidation.ok) throw new Error('ISS fixture invalid');
const issRecord = issValidation.record;
const satrec = buildSatrec(issRecord);
const atMs = Date.parse('2026-10-10T12:00:00Z');

describe('orbit path', () => {
  it('produces one full period of contiguous, finite scene-space vertices', () => {
    const path = computeOrbitPath(satrec, 25544, atMs, issRecord.MEAN_MOTION, 240);
    expect(path).not.toBeNull();
    if (!path) return;

    expect(path.count).toBe(241);
    expect(path.positions.length).toBe(path.count * 3);
    for (let i = 0; i < path.positions.length; i += 1) {
      expect(Number.isFinite(path.positions[i])).toBe(true);
    }

    // Vertices must be densely spaced: a 240-step period walk means each step
    // is ~1/240 of an orbit (~280 km for the ISS) — well under 0.06 scene units.
    let maxStep = 0;
    for (let i = 1; i < path.count; i += 1) {
      const dx = path.positions[i * 3] - path.positions[(i - 1) * 3];
      const dy = path.positions[i * 3 + 1] - path.positions[(i - 1) * 3 + 1];
      const dz = path.positions[i * 3 + 2] - path.positions[(i - 1) * 3 + 2];
      maxStep = Math.max(maxStep, Math.hypot(dx, dy, dz));
    }
    expect(maxStep).toBeLessThan(0.06);

    // Every vertex sits above the Earth's surface (scene radius > 1.03 for the ISS).
    for (let i = 0; i < path.count; i += 1) {
      const r = Math.hypot(path.positions[i * 3], path.positions[i * 3 + 1], path.positions[i * 3 + 2]);
      expect(r).toBeGreaterThan(1.02);
      expect(r).toBeLessThan(1.15);
    }

    // The path's first vertex is the marker position at the same instant.
    const state = propagateState(satrec, 25544, new Date(atMs));
    expect(path.positions[0]).toBeCloseTo(state.scene.x, 6);
    expect(path.positions[1]).toBeCloseTo(state.scene.y, 6);
    expect(path.positions[2]).toBeCloseTo(state.scene.z, 6);

    // Window spans exactly one orbital period (~93 min).
    const spanMin = (path.endMs - path.startMs) / 60_000;
    expect(spanMin).toBeGreaterThan(90);
    expect(spanMin).toBeLessThan(96);
  });

  it("tracks the Earth's rotation: one period of ground track drifts west by ~23°", () => {
    // Inertially the satellite returns near its starting point after one period,
    // but the Earth has rotated ~23° underneath it, so the Earth-fixed ground
    // track drifts west by that amount. This is exactly the effect a naive
    // "inertial straight line" rendering would miss, so it is asserted directly.
    const track = computeGroundTrack(satrec, 25544, atMs, issRecord.MEAN_MOTION, 1, 360);
    if (!track) throw new Error('track missing');
    const points = track.segments.flatMap((s) => s.geodetic);
    expect(points.length).toBeGreaterThan(300);

    const first = points[0];
    const last = points[points.length - 1];
    let driftDeg = last.lonDeg - first.lonDeg;
    if (driftDeg > 180) driftDeg -= 360;
    if (driftDeg < -180) driftDeg += 360;

    // Westward (negative) drift of roughly one orbit's worth of Earth rotation:
    // 93 min / 1436.07 min-per-rotation * 360° ≈ 23.3°.
    expect(driftDeg, `longitude drift was ${driftDeg.toFixed(2)}°`).toBeLessThan(-18);
    expect(driftDeg).toBeGreaterThan(-28);
  });
});

describe('ground track', () => {
  it('projects the sub-satellite point onto the surface and splits at the date line', () => {
    const track = computeGroundTrack(satrec, 25544, atMs, issRecord.MEAN_MOTION, 1, 360);
    expect(track).not.toBeNull();
    if (!track) return;

    expect(track.segments.length).toBeGreaterThanOrEqual(1);
    for (const segment of track.segments) {
      expect(segment.count).toBe(segment.geodetic.length);
      for (let i = 0; i < segment.count; i += 1) {
        const g = segment.geodetic[i];
        expect(Math.abs(g.latDeg)).toBeLessThanOrEqual(51.64 + 0.5);
        expect(Math.abs(g.lonDeg)).toBeLessThanOrEqual(180);

        // Vertex must sit just above the ellipsoid surface at that latitude.
        const x = segment.positions[i * 3];
        const y = segment.positions[i * 3 + 1];
        const z = segment.positions[i * 3 + 2];
        const r = Math.hypot(x, y, z);
        expect(r).toBeGreaterThan(surfaceRadiusScene(g.latDeg));
        expect(r).toBeLessThan(surfaceRadiusScene(g.latDeg) * 1.02);

        // And it must point in the direction of its own geodetic coordinates.
        const expected = geodeticToSceneUnit(g.latDeg, g.lonDeg);
        const dot = x * expected.x + y * expected.y + z * expected.z;
        expect(dot / r).toBeGreaterThan(0.999);
      }

      // No segment may contain a date-line jump: a jump would draw a false
      // straight line across the globe.
      for (let i = 1; i < segment.count; i += 1) {
        const jump = Math.abs(segment.geodetic[i].lonDeg - segment.geodetic[i - 1].lonDeg);
        expect(jump).toBeLessThanOrEqual(180);
      }
    }
  });

  it('samples a symmetric window around the requested instant', () => {
    const track = computeGroundTrack(satrec, 25544, atMs, issRecord.MEAN_MOTION, 1, 120);
    if (!track) throw new Error('track missing');
    const half = (track.endMs - track.startMs) / 2;
    expect(track.startMs + half).toBeCloseTo(atMs, -2);
  });

  it('returns null instead of a fake path for non-physical elements', () => {
    expect(computeOrbitPath(satrec, 25544, atMs, 0, 10)).toBeNull();
    expect(computeGroundTrack(satrec, 25544, atMs, -1, 1, 10)).toBeNull();
  });
});
