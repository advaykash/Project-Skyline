// ───────────────────────── observer geometry (one implementation for Your sky, passes, replay, Orbital POV and SignalScope)
// Look angles on the WGS-84 ellipsoid, pass prediction with refined rise / peak / set times, solar altitude, darkness and
// satellite illumination. Positions are SGP4 TEME (km); Earth rotation is applied once, by the sidereal angle (GMST).
// Pass search, eclipse test and darkness categories are ported from akulbajpai-code/SkyLine (src/orbital/observer.ts, MIT).
// Plain functions with no page state, so test/observer.test.mjs can load this file on its own. Units: km, ms, degrees.
const WGS_A = 6378.137, WGS_F = 1 / 298.257223563, WGS_E2 = WGS_F * (2 - WGS_F);

// observer on the WGS-84 ellipsoid, Earth-fixed (ECEF) km, with its local east / north / up unit vectors
function observerFrame(lat, lon, hKm = 0) {
  const f = lat * Math.PI / 180, l = lon * Math.PI / 180, sf = Math.sin(f), cf = Math.cos(f), sl = Math.sin(l), cl = Math.cos(l), Nr = WGS_A / Math.sqrt(1 - WGS_E2 * sf * sf);
  return { lat, lon, p: [(Nr + hKm) * cf * cl, (Nr + hKm) * cf * sl, (Nr * (1 - WGS_E2) + hKm) * sf], up: [cf * cl, cf * sl, sf], east: [-sl, cl, 0], north: [-sf * cl, -sf * sl, cf] };
}
// look angles (degrees, km) from observer frame `ob` to TEME position r, given the cosine c and sine s of the sidereal angle
function lookAngles(ob, r, c, s) {
  const x = c * r[0] + s * r[1] - ob.p[0], y = -s * r[0] + c * r[1] - ob.p[1], z = r[2] - ob.p[2], rng = Math.hypot(x, y, z);
  const u = (x * ob.up[0] + y * ob.up[1] + z * ob.up[2]) / rng, e = x * ob.east[0] + y * ob.east[1], n = x * ob.north[0] + y * ob.north[1] + z * ob.north[2];
  return { el: Math.asin(Math.max(-1, Math.min(1, u))) * 180 / Math.PI, az: (Math.atan2(e, n) * 180 / Math.PI + 360) % 360, range: rng };
}
// elevation only: the hot path of SignalScope's timeline
function lookEl(ob, r, c, s) {
  const x = c * r[0] + s * r[1] - ob.p[0], y = -s * r[0] + c * r[1] - ob.p[1], z = r[2] - ob.p[2];
  return Math.asin(Math.max(-1, Math.min(1, (x * ob.up[0] + y * ob.up[1] + z * ob.up[2]) / Math.hypot(x, y, z)))) * 180 / Math.PI;
}

// Sun altitude above the observer's horizon (degrees), from the Sun's TEME unit vector and the sidereal angle
function solarAltitude(ob, sunUnit, gmst) {
  const c = Math.cos(gmst), s = Math.sin(gmst), x = c * sunUnit[0] + s * sunUnit[1], y = -s * sunUnit[0] + c * sunUnit[1], z = sunUnit[2];
  return Math.asin(Math.max(-1, Math.min(1, x * ob.up[0] + y * ob.up[1] + z * ob.up[2]))) * 180 / Math.PI;
}
const DARKNESS = [[0, 'Daylight'], [-6, 'Civil twilight'], [-12, 'Nautical twilight'], [-18, 'Astronomical twilight'], [-Infinity, 'Night']];
const darknessOf = sunAlt => DARKNESS.find(d => sunAlt >= d[0])[1];

// Cylindrical-shadow eclipse test (any inertial frame): 'sunlit', 'penumbra' or 'shadow'. Earth is a sphere of equatorial radius.
function illumination(r, sunUnit) {
  const s = r[0] * sunUnit[0] + r[1] * sunUnit[1] + r[2] * sunUnit[2];
  if (s >= 0) return 'sunlit';
  const perp = Math.sqrt(Math.max(0, r[0] * r[0] + r[1] * r[1] + r[2] * r[2] - s * s)), pen = Math.tan(0.265 * Math.PI / 180) * -s;
  return perp < WGS_A - pen ? 'shadow' : perp < WGS_A + pen ? 'penumbra' : 'sunlit';
}

// Passes of one object over one observer between t0 and t1 (ms). posAt(t) returns TEME r (km) or null; gmstAt(t) the sidereal angle.
// Coarse scan, then bisection for rise and set and golden-section search for the peak, all on real SGP4 evaluations.
// Returns [{t0, t1, tPeak, max, azRise, azPeak, azSet, rangePeak}] in time order; a pass already under way at t0 starts at t0.
function predictPasses(posAt, gmstAt, ob, t0, t1, opt = {}) {
  const minEl = opt.minEl ?? 10, step = (opt.stepS ?? 20) * 1000, max = opt.max ?? 6;
  const look = t => { const r = posAt(t); if (!r) return null; const g = gmstAt(t); return lookAngles(ob, r, Math.cos(g), Math.sin(g)); };
  const elAt = t => { const l = look(t); return l ? l.el : NaN; };
  const cross = (a, b, rising) => {   // bisection to 0.5 s
    for (let k = 0; k < 40 && b - a > 500; k++) { const m = (a + b) / 2, e = elAt(m); if (!Number.isFinite(e)) return null; if ((e >= minEl) === rising) b = m; else a = m; }
    return (a + b) / 2;
  };
  const peak = (a, b) => {   // golden-section search to 0.5 s
    const gr = (Math.sqrt(5) - 1) / 2, v = t => { const e = elAt(t); return Number.isFinite(e) ? e : -Infinity; };
    let c = b - gr * (b - a), d = a + gr * (b - a);
    for (let k = 0; k < 48 && b - a > 500; k++) { if (v(c) < v(d)) a = c; else b = d; c = b - gr * (b - a); d = a + gr * (b - a); }
    return (a + b) / 2;
  };
  const out = []; let prevT = t0, prevE = elAt(t0), riseT = prevE >= minEl ? t0 : null;
  for (let t = t0 + step; t <= t1 + step && out.length < max; t += step) {
    const tt = Math.min(t, t1), e = elAt(tt);
    if (!Number.isFinite(e)) { riseT = null; prevT = tt; prevE = e; if (tt >= t1) break; continue; }   // SGP4 failed: no invented pass
    const was = prevE >= minEl, is = e >= minEl;
    if (!was && is && Number.isFinite(prevE)) riseT = cross(prevT, tt, true);
    if (was && !is && riseT != null) {
      const setT = cross(prevT, tt, false);
      if (setT != null && setT > riseT) {
        const pk = peak(riseT, setT), lr = look(riseT), lp = look(pk), ls = look(setT);
        if (lr && lp && ls) out.push({ t0: riseT, t1: setT, tPeak: pk, max: lp.el, azRise: lr.az, azPeak: lp.az, azSet: ls.az, rangePeak: lp.range });
      }
      riseT = null;
    }
    prevT = tt; prevE = e;
    if (tt >= t1) break;
  }
  return out;
}
