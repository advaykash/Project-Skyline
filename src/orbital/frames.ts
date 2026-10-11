/**
 * Coordinate frames and the single place where frame conversion happens.
 *
 * TEME (SGP4 "ECI")  --gmst-->  ECEF/PEF  --even permutation-->  Three.js scene
 *
 * Nothing else in the codebase applies Earth rotation. If a position looks
 * rotated by the wrong amount, the bug is here or in a caller that bypassed it.
 */
import { eciToEcf, gstime, sunPos, jday } from 'satellite.js';
import {
  EARTH_EQ_RADIUS_WGS84_KM,
  EARTH_MEAN_RADIUS_KM,
  EARTH_POLAR_RADIUS_WGS84_KM,
  SCENE_UNITS_PER_KM,
} from './constants';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Convert an ECEF (Earth-Centered Earth-Fixed) position in kilometres to the
 * Three.js scene frame (Earth-fixed, Y = north pole, unit = mean Earth radius).
 *
 *   scene.x =  ecef.x
 *   scene.y =  ecef.z
 *   scene.z = -ecef.y
 *
 * This is an even permutation of the axes, so handedness is preserved.
 */
export function ecefToScene(ecef: Vec3): Vec3 {
  return {
    x: ecef.x * SCENE_UNITS_PER_KM,
    y: ecef.z * SCENE_UNITS_PER_KM,
    z: -ecef.y * SCENE_UNITS_PER_KM,
  };
}

/** Inverse of {@link ecefToScene}: scene units back to ECEF kilometres. */
export function sceneToEcef(scene: Vec3): Vec3 {
  return {
    x: scene.x * EARTH_MEAN_RADIUS_KM,
    y: -scene.z * EARTH_MEAN_RADIUS_KM,
    z: scene.y * EARTH_MEAN_RADIUS_KM,
  };
}

/** Rotate a TEME (inertial) position to ECEF using the supplied GMST. */
export function eciToEcef(eci: Vec3, gmst: number): Vec3 {
  const ecf = eciToEcf(eci, gmst);
  return { x: ecf.x, y: ecf.y, z: ecf.z };
}

/** Greenwich Mean Sidereal Time for a date, in radians. */
export function gmstFor(date: Date): number {
  return gstime(date);
}

/**
 * Unit vector on the Earth-fixed sphere for a geodetic latitude/longitude pair,
 * returned in scene coordinates. Used for camera anchoring, place labels and
 * ground-track geometry — never for satellite positions, which come from SGP4.
 */
export function geodeticToSceneUnit(latDeg: number, lonDeg: number, radius = 1): Vec3 {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const cosLat = Math.cos(lat);
  return {
    x: radius * cosLat * Math.cos(lon),
    y: radius * Math.sin(lat),
    z: -radius * cosLat * Math.sin(lon),
  };
}

/** Inverse of {@link geodeticToSceneUnit} for a scene-space vector. */
export function sceneUnitToGeodetic(v: Vec3): { latitudeDeg: number; longitudeDeg: number } {
  const r = Math.hypot(v.x, v.y, v.z) || 1;
  const latitudeDeg = (Math.asin(v.y / r) * 180) / Math.PI;
  const longitudeDeg = (Math.atan2(-v.z, v.x) * 180) / Math.PI;
  return { latitudeDeg, longitudeDeg };
}

/**
 * Direction *from the Earth's centre towards the Sun*, expressed in the
 * Earth-fixed scene frame. Low-precision solar ephemeris via satellite.js
 * `sunPos` (~0.01° accurate, far better than the terminator resolution of any
 * display). Used for day/night shading only, never for orbit computation.
 */
export function sunDirectionScene(date: Date): Vec3 {
  const jd = jday(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds() + date.getUTCMilliseconds() / 1000,
  );
  const { rsun } = sunPos(jd);
  const eci = { x: rsun[0], y: rsun[1], z: rsun[2] };
  const gmst = gstime(date);
  const ecef = eciToEcef(eci, gmst);
  const norm = Math.hypot(ecef.x, ecef.y, ecef.z) || 1;
  const unitEcef = { x: ecef.x / norm, y: ecef.y / norm, z: ecef.z / norm };
  const scene = ecefToScene(unitEcef);
  const len = Math.hypot(scene.x, scene.y, scene.z) || 1;
  return { x: scene.x / len, y: scene.y / len, z: scene.z / len };
}

/**
 * Latitude/longitude of the sub-solar point (the point where the Sun is
 * directly overhead), derived from the solar ephemeris. Purely informational —
 * it is shown in the interface so the terminator's position can be checked
 * against the clock.
 */
export function subsolarPoint(date: Date): { latitudeDeg: number; longitudeDeg: number } {
  const dir = sunDirectionScene(date);
  const geocentricRadius = Math.hypot(dir.x, dir.y, dir.z) || 1;
  // Sub-solar latitude is the solar declination; the reference ellipsoid vs
  // sphere distinction is immaterial for a display-only readout.
  const latitudeDeg = (Math.asin(dir.y / geocentricRadius) * 180) / Math.PI;
  let longitudeDeg = (Math.atan2(-dir.z, dir.x) * 180) / Math.PI;
  // Normalise into [-180, 180).
  longitudeDeg = ((((longitudeDeg + 180) % 360) + 360) % 360) - 180;
  return { latitudeDeg, longitudeDeg };
}

/**
 * Radius of the Earth's surface in scene units at a given geodetic latitude,
 * on the WGS-84 ellipsoid used by satellite.js's geodetic transforms — the same
 * datum the reported altitudes refer to, so the two stay consistent.
 */
export function surfaceRadiusScene(latDeg: number): number {
  const lat = (latDeg * Math.PI) / 180;
  const a = EARTH_EQ_RADIUS_WGS84_KM;
  const f = (a - EARTH_POLAR_RADIUS_WGS84_KM) / a;
  const e2 = 2 * f - f * f;
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) * Math.sin(lat));
  // Geocentric radius of the ellipsoid surface at this geodetic latitude.
  const r = n * Math.sqrt(Math.cos(lat) ** 2 + (1 - e2) ** 2 * Math.sin(lat) ** 2);
  return r * SCENE_UNITS_PER_KM;
}
