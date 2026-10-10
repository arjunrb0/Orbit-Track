// Two-body (Kepler) orbit propagator.
//
// Model: Earth is a point mass and nothing else acts on the satellite. The
// orbit is then a fixed ellipse, and the only thing that changes with time is
// where the satellite is on it. That's the mean anomaly M, which grows at a
// constant rate n.
//
// Pipeline for a time t:
//   M = M0 + n (t - epoch)                     mean anomaly (just a clock)
//   solve  M = E - e sin E   for E             eccentric anomaly (Kepler's equation)
//   E -> nu                                    true anomaly (the real angle from perigee)
//   (a, e, nu) -> r, v in the perifocal frame  (in the orbit's own plane)
//   rotate by omega, i, Omega -> inertial frame
//
// Output frame: the same frame the elements are given in. For CelesTrak data
// that's TEME (True Equator, Mean Equinox), which is also what SGP4 outputs,
// so stage 4 compares like with like. Units: km, km/s, radians.

import { MU_EARTH, TWO_PI, DEG, SECONDS_PER_DAY } from './constants.js';
import { rotateX, rotateZ } from './vec.js';

// ------------------------------------------------------------ core functions

/**
 * Semi-major axis from mean motion, using Kepler's third law: n^2 a^3 = mu.
 * (This is the warm-up from the end of stage 1.)
 *
 * @param {number} nRadPerSec  mean motion in rad/s
 * @param {number} [mu]        gravitational parameter in km^3/s^2
 * @returns {number} semi-major axis a in km
 */
export function semiMajorAxisFromMeanMotion(nRadPerSec, mu = MU_EARTH) {
  // n^2 a^3 = mu  =>  a = (mu / n^2)^(1/3)
  return Math.cbrt(mu / (nRadPerSec * nRadPerSec));
}

/**
 * Solve Kepler's equation  M = E - e sin E  for the eccentric anomaly E,
 * using Newton's method.
 *
 * Must work for any real M (M keeps growing with time, so it can be huge or
 * negative) and for 0 <= e < 1, including e close to 1.
 *
 * @param {number} M     mean anomaly in radians
 * @param {number} e     eccentricity, 0 <= e < 1
 * @param {number} [tol] stop when the Newton step is smaller than this (radians)
 * @returns {number} eccentric anomaly E in radians
 * @throws if it fails to converge
 */
export function solveKepler(M, e, tol = 1e-12) {
  if (!(e >= 0 && e < 1)) throw new Error(`solveKepler needs 0 <= e < 1, got ${e}`);

  // M grows without limit as time passes; reduce it into [0, 2pi). E then
  // lands in [0, 2pi) too, which is all we need since only sin/cos of it are used.
  const Mw = M - TWO_PI * Math.floor(M / TWO_PI);

  // f(E) = E - e sin E - M, f'(E) = 1 - e cos E >= 1 - e > 0, so f is strictly
  // increasing and there is exactly one root.
  // Starting guess: E = M is excellent for near-circular orbits. For e near 1,
  // f' is tiny near perigee and the first Newton step from E = M can fly off;
  // starting at E = pi (where f' is largest) avoids that (Vallado, Algorithm 2).
  let E = e > 0.8 ? Math.PI : Mw;

  for (let iter = 0; iter < 50; iter++) {
    const step = (E - e * Math.sin(E) - Mw) / (1 - e * Math.cos(E));
    E -= step;
    if (Math.abs(step) < tol) return E;
  }
  throw new Error(`solveKepler did not converge (M=${M}, e=${e})`);
}

/**
 * Convert eccentric anomaly E into true anomaly nu.
 * Must give the right quadrant for every E (careful with acos and atan).
 *
 * @param {number} E  eccentric anomaly in radians
 * @param {number} e  eccentricity
 * @returns {number} true anomaly nu in radians
 */
export function trueAnomalyFromEccentric(E, e) {
  // Position relative to Earth (the focus), perigee along x:
  //   x = a (cos E - e),   y = b sin E = a sqrt(1 - e^2) sin E
  // nu is the angle of (x, y). atan2 gets the quadrant right everywhere;
  // acos can't tell the outbound half of the orbit from the inbound half.
  // The common factor a cancels.
  return Math.atan2(Math.sqrt(1 - e * e) * Math.sin(E), Math.cos(E) - e);
}

/**
 * Position and velocity from classical orbital elements.
 * Step 1: r and v in the perifocal frame (x towards perigee, y 90 degrees
 *         ahead in the direction of motion, z along the angular momentum).
 * Step 2: rotate into the inertial frame using omega, i and Omega.
 *         Use rotateX and rotateZ from vec.js.
 *
 * @param {number} a     semi-major axis, km
 * @param {number} e     eccentricity
 * @param {number} i     inclination, rad
 * @param {number} raan  right ascension of the ascending node (Omega), rad
 * @param {number} argp  argument of perigee (omega), rad
 * @param {number} nu    true anomaly, rad
 * @param {number} [mu]  gravitational parameter, km^3/s^2
 * @returns {{ r: number[], v: number[] }} position (km) and velocity (km/s)
 */
export function stateFromElements(a, e, i, raan, argp, nu, mu = MU_EARTH) {
  // Step 1: perifocal frame.
  const p = a * (1 - e * e); // semi-latus rectum
  const r = p / (1 + e * Math.cos(nu)); // conic equation
  // Velocity = radial part (mu/h) e sin nu along r-hat = (cos nu, sin nu)
  //          + sideways part (mu/h)(1 + e cos nu) along theta-hat = (-sin nu, cos nu),
  // with h = sqrt(mu p). Adding the x and y components and simplifying:
  const k = Math.sqrt(mu / p); // = mu / h
  const rPqw = [r * Math.cos(nu), r * Math.sin(nu), 0];
  const vPqw = [-k * Math.sin(nu), k * (e + Math.cos(nu)), 0];

  // Step 2: rotate into the inertial frame. Start with the orbit flat in the
  // equatorial plane and the node line along x, then:
  //   rotate by omega about z  (put perigee omega ahead of the node)
  //   rotate by i about x      (tilt the plane about the node line, still on x)
  //   rotate by Omega about z  (swing the node round to its right ascension)
  const toInertial = (vec) => rotateZ(rotateX(rotateZ(vec, argp), i), raan);
  return { r: toInertial(rPqw), v: toInertial(vPqw) };
}

// ---------------------------------------------------------------- plumbing

/**
 * Convert parsed elements (stage 1 shape: degrees, rev/day) into the units the
 * propagator uses (radians, rad/s, km).
 */
export function toKeplerian(el) {
  const n = (el.meanMotionRevPerDay * TWO_PI) / SECONDS_PER_DAY; // rad/s
  return {
    epochMs: el.epochMs,
    n,
    a: semiMajorAxisFromMeanMotion(n),
    e: el.eccentricity,
    i: el.inclinationDeg * DEG,
    raan: el.raanDeg * DEG,
    argp: el.argPerigeeDeg * DEG,
    M0: el.meanAnomalyDeg * DEG,
  };
}

/**
 * Propagate parsed elements to a time with the pure two-body model.
 *
 * @param {object} el      parsed elements (from parseOmm / parseTle)
 * @param {number} timeMs  UTC time, ms since 1970
 * @returns {{ r: number[], v: number[] }} TEME position (km) and velocity (km/s)
 */
export function propagateKepler(el, timeMs) {
  const k = toKeplerian(el);
  const dt = (timeMs - k.epochMs) / 1000; // seconds since epoch
  const M = k.M0 + k.n * dt;
  const E = solveKepler(M, k.e);
  const nu = trueAnomalyFromEccentric(E, k.e);
  return stateFromElements(k.a, k.e, k.i, k.raan, k.argp, nu);
}
