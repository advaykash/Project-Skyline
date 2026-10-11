// ───────────────────────── Orbital POV geometry
// A camera at an object's propagated position, oriented in that object's local orbit frame. Plain functions with no
// page state, so test/pov.test.mjs can load this file on its own. Vectors are in the scene frame (inertial, Earth radius
// = 1, see toScene in app.js); altitudes in km; angles in degrees unless a name says otherwise.
const POV_RE = 6371;   // the same Earth radius the scene uses (RS in app.js)
const POV_FOV = { min: 25, max: 100 };
const v3 = {
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  unit: a => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; },
  comb: (p, a, q, b) => [p * a[0] + q * b[0], p * a[1] + q * b[1], p * a[2] + q * b[2]],
};

// Local orbit frame from position r and velocity v (any common frame): up = r̂ (away from Earth's centre), along =
// the velocity with its radial part removed, right = along × up. Returns null if r or v can't define a frame.
function povBasis(r, v) {
  const rl = Math.hypot(r[0], r[1], r[2]); if (!(rl > 0)) return null;
  const up = [r[0] / rl, r[1] / rl, r[2] / rl], h = v3.comb(1, v, -v3.dot(v, up), up), hl = Math.hypot(h[0], h[1], h[2]);
  if (!(hl > 1e-9)) return null;
  const along = [h[0] / hl, h[1] / hl, h[2] / hl];
  return { up, along, right: v3.cross(along, up) };
}

// How far below the local horizontal the Earth's limb appears from altitude h (km): acos(R / (R + h)).
const horizonDip = altKm => Math.acos(POV_RE / (POV_RE + Math.max(0, altKm))) * 180 / Math.PI;
// Angular radius of the whole Earth disk seen from altitude h (km): asin(R / (R + h)).
const diskRadius = altKm => Math.asin(POV_RE / (POV_RE + Math.max(0, altKm))) * 180 / Math.PI;

// Default field of view (vertical, degrees) for each mode at altitude h (km)
function povDefaultFov(mode, altKm) {
  if (mode === 'nadir') return Math.min(90, Math.max(POV_FOV.min, 2.3 * diskRadius(altKm)));
  return altKm > 3000 ? Math.min(POV_FOV.max, Math.max(POV_FOV.min, 2.6 * diskRadius(altKm))) : 70;
}

// Yaw and pitch (degrees, relative to the along-track direction and the local horizontal) for each mode.
// Horizon: pitched down to the limb and then a sixth of the field of view further, so the horizon sits a third of the
// way down the frame (Earth below it, space above). Nadir: straight down. Free: what the viewer chose.
function povAngles(mode, altKm, fov, free) {
  if (mode === 'nadir') return { yaw: 0, pitch: -90 };
  if (mode === 'free' && free) return { yaw: free.yaw, pitch: Math.max(-90, Math.min(80, free.pitch)) };
  if (altKm > 3000) return { yaw: 0, pitch: -90 };   // high orbits see the whole disk: look at it
  return { yaw: 0, pitch: -horizonDip(altKm) - fov / 6 };
}

// Camera forward and up vectors in the frame of `basis` for a yaw (to the right) and pitch (up), in degrees.
// At pitch −90° the camera looks straight down with the along-track direction at the top of the screen.
function povOrientation(basis, yaw, pitch) {
  const y = yaw * Math.PI / 180, p = pitch * Math.PI / 180;
  const h = v3.comb(Math.cos(y), basis.along, Math.sin(y), basis.right);   // horizontal heading
  return { fwd: v3.comb(Math.cos(p), h, Math.sin(p), basis.up), up: v3.comb(-Math.sin(p), h, Math.cos(p), basis.up) };
}

// Near clipping plane (scene units) for a camera at altitude h (km): 15 % of the altitude, between 0.001 and 0.01.
// Small enough for the surface, large enough to avoid depth fighting between the surface and the atmosphere shell.
const povClip = altKm => Math.min(0.01, Math.max(0.001, 0.15 * altKm / POV_RE));

const clampFov = f => Math.max(POV_FOV.min, Math.min(POV_FOV.max, f));
