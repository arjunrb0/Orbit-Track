// An independent check on the Kepler propagator: integrate Newton's law of
// gravitation numerically, with no orbital elements and no Kepler's equation.
//
//   d r / dt = v
//   d v / dt = -mu r / |r|^3
//
// If the Kepler solution and this brute-force integration agree, both the
// maths and the code of the analytical propagator are very likely right.

import { MU_EARTH } from '../../src/orbit/constants.js';
import { add, scale, norm, cross, dot } from '../../src/orbit/vec.js';

const accel = (r, mu) => scale(r, -mu / norm(r) ** 3);

/** One classical Runge-Kutta 4 step of size h seconds. */
export function rk4Step(r, v, h, mu = MU_EARTH) {
  const k1r = v, k1v = accel(r, mu);
  const k2r = add(v, scale(k1v, h / 2)), k2v = accel(add(r, scale(k1r, h / 2)), mu);
  const k3r = add(v, scale(k2v, h / 2)), k3v = accel(add(r, scale(k2r, h / 2)), mu);
  const k4r = add(v, scale(k3v, h)), k4v = accel(add(r, scale(k3r, h)), mu);
  const rNext = add(r, scale(add(add(k1r, scale(k2r, 2)), add(scale(k3r, 2), k4r)), h / 6));
  const vNext = add(v, scale(add(add(k1v, scale(k2v, 2)), add(scale(k3v, 2), k4v)), h / 6));
  return { r: rNext, v: vNext };
}

/** Integrate for `duration` seconds with step `h`. */
export function integrate(r, v, duration, h, mu = MU_EARTH) {
  const steps = Math.round(duration / h);
  let s = { r, v };
  for (let k = 0; k < steps; k++) s = rk4Step(s.r, s.v, duration / steps, mu);
  return s;
}

/**
 * Measure the orbital period by integrating until the position vector has
 * swept a full 2 pi, then interpolating the crossing time.
 */
export function measurePeriod(r0, v0, h, mu = MU_EARTH) {
  let s = { r: r0, v: v0 };
  let swept = 0;
  let t = 0;
  for (;;) {
    const next = rk4Step(s.r, s.v, h, mu);
    const dTheta = Math.atan2(norm(cross(s.r, next.r)), dot(s.r, next.r));
    if (swept + dTheta >= 2 * Math.PI) return t + (h * (2 * Math.PI - swept)) / dTheta;
    swept += dTheta;
    t += h;
    s = next;
  }
}
