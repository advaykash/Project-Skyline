/**
 * Skyline — physical constants and frame conventions.
 *
 * FRAME AND UNIT CONVENTIONS (used consistently everywhere in this codebase)
 * ---------------------------------------------------------------------------
 * 1. Source elements are CelesTrak GP (OMM) records. `satellite.js` initialises
 *    an SGP4 propagator from them and returns positions in **TEME** (True
 *    Equator, Mean Equinox) — the native frame of SGP4. We call this frame
 *    "ECI" throughout the UI, and it is inertial (non-rotating).
 * 2. `eciToEcf(position, gmst)` rotates TEME -> **ECEF/PEF** (Earth-Centered,
 *    Earth-Fixed) using Greenwich Mean Sidereal Time. Earth rotation is applied
 *    exactly once, here. Nothing downstream rotates by GMST again.
 * 3. The Three.js scene frame is a right-handed, Y-up, **Earth-fixed** frame.
 *    The Earth mesh never rotates; satellites move with the Earth.
 *
 *        scene.x =  ecef.x
 *        scene.y =  ecef.z          (north pole is +Y)
 *        scene.z = -ecef.y
 *
 *    This is an even permutation of (X, Y, Z) -> right-handed, matching
 *    Three.js conventions. Checked in tests/orbital-frames.test.ts:
 *      - lon 0°,   lat 0°   -> (+1, 0, 0)   (Greenwich on the equator)
 *      - lon 90°E, lat 0°   -> ( 0, 0,-1)
 *      - north pole         -> ( 0,+1, 0)
 * 4. Scene length unit = 1 = EARTH_MEAN_RADIUS_KM (6371.0 km). A satellite at
 *    400 km altitude therefore sits at radius ~1.063.
 *
 * TWO DATUMS APPEAR IN THIS CODEBASE, AND THEY ARE NOT INTERCHANGEABLE:
 *   - SGP4 itself (and therefore semi-major axis, drag and mean motion) is
 *     defined on the **WGS-72** ellipsoid: a = 6378.135 km, mu = 398600.8 km^3/s^2.
 *     satellite.js initialises SGP4 with exactly these constants.
 *   - satellite.js's geodetic transforms (`eciToGeodetic`, `geodeticToEcf`) use
 *     **WGS-84**: a = 6378.137 km, b = 6356.7523142 km. Reported latitudes and
 *     altitudes are therefore WGS-84 geodetic, while orbit shape parameters
 *     (period, apogee, perigee) follow WGS-72.
 *     The difference is ~2 m in radius and is negligible at display precision,
 *     but it is stated here so that derived values can be audited.
 */

/** Scene length unit / mean Earth radius, km. Used to scale the 3D scene. */
export const EARTH_MEAN_RADIUS_KM = 6371.0;

/** WGS-72 equatorial radius (km) — the ellipsoid SGP4 is defined on. */
export const EARTH_EQ_RADIUS_WGS72_KM = 6378.135;

/** WGS-84 equatorial radius (km) — used by satellite.js geodetic transforms. */
export const EARTH_EQ_RADIUS_WGS84_KM = 6378.137;

/** WGS-84 polar radius (km) — used by satellite.js geodetic transforms. */
export const EARTH_POLAR_RADIUS_WGS84_KM = 6356.7523142;

/**
 * Earth gravitational parameter, km^3/s^2 — the WGS-72 value satellite.js uses
 * inside SGP4. Required for deriving semi-major axis and periods from mean motion.
 */
export const EARTH_MU_KM3_S2 = 398600.8;

/** Sidereal day, minutes — the period of a geosynchronous orbit. */
export const SIDEREAL_DAY_MIN = 1436.0682;

/** Scale factor: scene units per kilometre. */
export const SCENE_UNITS_PER_KM = 1 / EARTH_MEAN_RADIUS_KM;

/** Kilometres per scene unit. */
export const KM_PER_SCENE_UNIT = EARTH_MEAN_RADIUS_KM;
