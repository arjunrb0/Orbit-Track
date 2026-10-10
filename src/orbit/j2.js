// Two-body propagator plus the secular (steadily growing) effects of J2.
//
// Earth isn't a sphere: it bulges at the equator by ~21 km. The bulge is
// described by the coefficient J2 = 0.001082616. Its extra pull near the
// equator applies a small torque to an inclined orbit, and averaged over an
// orbit that produces three steady drifts:
//
//   dOmega/dt = -(3/2) n J2 (R/p)^2 cos i                        node regression
//   domega/dt =  (3/4) n J2 (R/p)^2 (5 cos^2 i - 1)              perigee rotation
//   dM/dt     =  n [1 + (3/4) J2 (R/p)^2 sqrt(1-e^2) (3 cos^2 i - 1)]
//
// (p = a(1 - e^2), R = Earth's equatorial radius.) These are first-order
// results from averaging Lagrange's planetary equations; see Vallado sec. 9.6
// or Curtis sec. 4.7.
//
// - The node regression is why the ISS's orbit plane swings round by ~5 deg/day.
//   Sun-synchronous satellites pick i ~ 98 deg so the node turns +0.9856 deg/day,
//   keeping pace with Earth's orbit around the Sun.
// - At i = 63.43 deg ("critical inclination") the perigee stops rotating,
//   which is why Molniya orbits use it.
//
// "Un-Kozai" step: the mean motion published in TLEs/OMMs isn't the plain
// Keplerian n. It's a "Kozai" mean motion with part of the J2 effect folded
// in. SGP4 first converts it to the Brouwer mean motion it actually uses. We
// do the same conversion, otherwise the satellite would run slightly fast or
// slow along its orbit, with the error growing every revolution.
//
// What this still leaves out compared with SGP4: J2's short-period
// (within-one-orbit) wobbles of a few km, higher-order terms (J2^2, J3, J4),
// atmospheric drag, and, for high orbits, the Sun and Moon.

import { MU_EARTH, R_EARTH, TWO_PI, DEG, SECONDS_PER_DAY } from './constants.js';
import { semiMajorAxisFromMeanMotion, solveKepler, trueAnomalyFromEccentric, stateFromElements } from './kepler.js';

export const J2 = 0.001082616; // WGS-72 value, as used by SGP4
export const DEEP_SPACE_PERIOD_S = 225 * 60; // SGP4 treats longer periods as "deep space"

/**
 * Convert published (Kozai) mean motion to Brouwer mean motion, following the
 * initialisation step of SGP4 (Hoots & Roehrich 1980, Spacetrack Report #3).
 *
 * @param {number} nKozai  rad/s
 * @param {number} e
 * @param {number} i       rad
 * @param {number} [j2]
 * @returns {number} Brouwer mean motion, rad/s
 */
export function unKozai(nKozai, e, i, j2 = J2) {
  // Work in SGP4's units: Earth radii, so a = (mu / n^2)^(1/3) / R.
  const a1 = semiMajorAxisFromMeanMotion(nKozai) / R_EARTH;
  const cosI = Math.cos(i);
  const beta2 = 1 - e * e;
  const d1 = (0.75 * j2 * (3 * cosI * cosI - 1)) / (Math.sqrt(beta2) * beta2);
  let delta = d1 / (a1 * a1);
  const a0 = a1 * (1 - delta * delta - delta * (1 / 3 + (134 * delta * delta) / 81));
  delta = d1 / (a0 * a0);
  return nKozai / (1 + delta);
}

/**
 * Secular J2 rates for an orbit.
 * @returns {{ n: number, a: number, raanDot: number, argpDot: number, mDot: number }}
 *          Brouwer mean motion (rad/s), semi-major axis (km), rates in rad/s
 */
export function j2Rates(nKozai, e, i, j2 = J2) {
  const n = unKozai(nKozai, e, i, j2);
  const a = semiMajorAxisFromMeanMotion(n);
  const p = a * (1 - e * e);
  const k = j2 * (R_EARTH / p) ** 2;
  const c = Math.cos(i);
  return {
    n,
    a,
    raanDot: -1.5 * n * k * c,
    argpDot: 0.75 * n * k * (5 * c * c - 1),
    mDot: n * (1 + 0.75 * k * Math.sqrt(1 - e * e) * (3 * c * c - 1)),
  };
}

/**
 * Propagate parsed elements with two-body motion plus secular J2 drift.
 * Same output as propagateKepler: TEME r (km) and v (km/s).
 *
 * Velocity note: v comes from the instantaneous ellipse. It ignores the slow
 * turning of the ellipse itself, an error of order n J2 ~ 1e-6 relative.
 */
export function propagateJ2(el, timeMs, { j2 = J2, drag = false } = {}) {
  const nKozai = (el.meanMotionRevPerDay * TWO_PI) / SECONDS_PER_DAY;
  const e = el.eccentricity;
  const i = el.inclinationDeg * DEG;
  const rates = j2Rates(nKozai, e, i, j2);
  const dt = (timeMs - el.epochMs) / 1000;
  const raan = el.raanDeg * DEG + rates.raanDot * dt;
  const argp = el.argPerigeeDeg * DEG + rates.argpDot * dt;
  let M = el.meanAnomalyDeg * DEG + rates.mDot * dt;
  let a = rates.a;
  // Only near-Earth orbits (period < 225 min, SGP4's own dividing line) have
  // air to drag on. At geosynchronous height n-dot is just a fitted number
  // soaking up Sun/Moon effects and station-keeping, so it isn't applied.
  if (drag && TWO_PI / nKozai < DEEP_SPACE_PERIOD_S) {
    // Drag takes energy away, so the orbit sinks and (Kepler's third law) the
    // satellite speeds up: the mean motion grows at a steady n-dot. The element
    // set publishes n-dot/2 in rev/day^2. Integrating n(t) = n0 + n-dot t once
    // more gives the extra mean anomaly: (n-dot/2) t^2 revolutions.
    const days = dt / SECONDS_PER_DAY;
    const nDotHalf = el.meanMotionDotHalf; // rev/day^2
    M += TWO_PI * nDotHalf * days * days;
    // ...and the orbit shrinks to match the faster mean motion.
    const nNow = rates.n + (2 * nDotHalf * days * TWO_PI) / SECONDS_PER_DAY; // rad/s
    a = semiMajorAxisFromMeanMotion(nNow);
  }
  const E = solveKepler(M, e);
  const nu = trueAnomalyFromEccentric(E, e);
  return stateFromElements(a, e, i, raan, argp, nu, MU_EARTH);
}

/**
 * Two-body + J2 secular drift + a simple drag model from the element set's own
 * n-dot. (SGP4 models drag differently, through B*, so this is an independent
 * estimate rather than a copy of SGP4's drag.)
 */
export function propagateJ2Drag(el, timeMs) {
  return propagateJ2(el, timeMs, { drag: true });
}
