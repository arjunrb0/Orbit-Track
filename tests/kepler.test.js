import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOmm } from '../src/data/elements.js';
import { MU_EARTH, R_EARTH, DEG, TWO_PI } from '../src/orbit/constants.js';
import { norm, dot, cross, sub } from '../src/orbit/vec.js';
import {
  semiMajorAxisFromMeanMotion,
  solveKepler,
  trueAnomalyFromEccentric,
  stateFromElements,
  toKeplerian,
  propagateKepler,
} from '../src/orbit/kepler.js';
import { integrate, measurePeriod } from './helpers/newton-rk4.js';

const iss = parseOmm(JSON.parse(readFileSync(new URL('./fixtures/iss-omm.json', import.meta.url), 'utf8')));
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected} ± ${tol}, got ${actual}`);
// Wrap an angle into (-pi, pi]
const wrap = (x) => x - TWO_PI * Math.round(x / TWO_PI);

// ---------------------------------------------------------- semi-major axis

test('ISS semi-major axis gives the published ~420 km altitude', () => {
  const a = toKeplerian(iss).a;
  near(a - R_EARTH, 420, 15, 'ISS altitude (km)');
});

test('one sidereal day period gives the geostationary radius, 42 164 km', () => {
  const n = TWO_PI / 86164.0905; // rad/s
  near(semiMajorAxisFromMeanMotion(n), 42164, 1, 'GEO radius (km)');
});

// ------------------------------------------------------------ Kepler solver

test('Kepler: Vallado Example 2-1 (M = 235.4 deg, e = 0.4)', () => {
  near(solveKepler(235.4 * DEG, 0.4) / DEG, 220.512074767522, 1e-9, 'E (deg)');
});

test('Kepler: circular orbit means E = M', () => {
  for (const M of [0, 1, 3, 5]) near(solveKepler(M, 0), M, 1e-12);
});

test('Kepler: satisfies the equation across M and e, including e close to 1', () => {
  for (const e of [0, 0.0007, 0.1, 0.5, 0.9, 0.99, 0.999]) {
    for (let k = 0; k < 360; k += 7.5) {
      const M = k * DEG;
      const E = solveKepler(M, e);
      near(wrap(E - e * Math.sin(E) - M), 0, 1e-10, `e=${e} M=${k}deg`);
    }
  }
});

test('Kepler: handles large and negative M (M grows with time)', () => {
  for (const M of [-0.3, -50, 100, 1e5]) {
    const E = solveKepler(M, 0.3);
    near(wrap(E - 0.3 * Math.sin(E) - M), 0, 1e-9, `M=${M}`);
  }
});

// ------------------------------------------------------------ true anomaly

test('true anomaly: perigee and apogee', () => {
  near(trueAnomalyFromEccentric(0, 0.5), 0, 1e-12);
  near(Math.abs(wrap(trueAnomalyFromEccentric(Math.PI, 0.5))), Math.PI, 1e-12);
});

test('true anomaly: right quadrant, and radius agrees both ways round', () => {
  // Two independent formulas for the radius: r = a(1 - e cos E) from the
  // auxiliary circle, and r = a(1 - e^2)/(1 + e cos nu) from the conic equation.
  const a = 10000;
  for (const e of [0.01, 0.3, 0.8]) {
    for (let k = 5; k < 360; k += 10) {
      const E = k * DEG;
      const nu = trueAnomalyFromEccentric(E, e);
      near(a * (1 - e * Math.cos(E)), (a * (1 - e * e)) / (1 + e * Math.cos(nu)), 1e-6, `e=${e} E=${k}`);
      // nu and E are always on the same side of the major axis
      assert.equal(Math.sign(Math.sin(nu)), Math.sign(Math.sin(E)), `quadrant e=${e} E=${k}`);
    }
  }
});

// -------------------------------------------------------- state from elements

test('state: Vallado Example 2-6 (COE to r, v)', () => {
  const p = 11067.79, e = 0.83285;
  const { r, v } = stateFromElements(p / (1 - e * e), e, 87.87 * DEG, 227.89 * DEG, 53.38 * DEG, 92.335 * DEG, 398600.4418);
  const rRef = [6525.368, 6861.532, 6449.119];
  const vRef = [4.902279, 5.53314, -1.97571];
  for (let k = 0; k < 3; k++) {
    near(r[k], rRef[k], 0.002, `r[${k}]`);
    near(v[k], vRef[k], 2e-6, `v[${k}]`);
  }
});

test('state: circular equatorial orbit at nu = 0 points along x, moving along y', () => {
  const a = 7000;
  const { r, v } = stateFromElements(a, 0, 0, 0, 0, 0);
  for (const [k, ref] of [a, 0, 0].entries()) near(r[k], ref, 1e-9);
  for (const [k, ref] of [0, Math.sqrt(MU_EARTH / a), 0].entries()) near(v[k], ref, 1e-12);
});

test('state: energy and angular momentum match their textbook formulas', () => {
  const a = 26560, e = 0.7, i = 63.4 * DEG; // a Molniya-like orbit
  for (let k = 0; k < 360; k += 15) {
    const { r, v } = stateFromElements(a, e, i, 1.2, 4.7, k * DEG);
    // vis-viva: v^2/2 - mu/r = -mu/(2a)
    near(dot(v, v) / 2 - MU_EARTH / norm(r), -MU_EARTH / (2 * a), 1e-9, `energy nu=${k}`);
    // |h| = sqrt(mu a (1 - e^2)), and h is tilted from the z axis by i
    const h = cross(r, v);
    near(norm(h), Math.sqrt(MU_EARTH * a * (1 - e * e)), 1e-6, `|h| nu=${k}`);
    near(Math.acos(h[2] / norm(h)), i, 1e-12, `inclination nu=${k}`);
  }
});

// ---------------------------------------------------------------- propagator

test('propagator: matches direct integration of Newton\'s law over 6 hours (ISS)', () => {
  const s0 = propagateKepler(iss, iss.epochMs);
  const dt = 6 * 3600;
  const kepler = propagateKepler(iss, iss.epochMs + dt * 1000);
  const newton = integrate(s0.r, s0.v, dt, 1);
  near(norm(sub(kepler.r, newton.r)), 0, 0.001, 'position difference (km)');
});

test('propagator: matches Newton for a highly eccentric orbit over 2 days', () => {
  const molniya = { ...iss, meanMotionRevPerDay: 2.006, eccentricity: 0.72, inclinationDeg: 63.4, argPerigeeDeg: 270 };
  const s0 = propagateKepler(molniya, molniya.epochMs);
  const dt = 2 * 86400;
  const kepler = propagateKepler(molniya, molniya.epochMs + dt * 1000);
  const newton = integrate(s0.r, s0.v, dt, 1);
  near(norm(sub(kepler.r, newton.r)), 0, 0.01, 'position difference (km)');
});

test('propagator: period measured from Newton\'s law matches Kepler\'s third law', () => {
  const { a } = toKeplerian(iss);
  const kepler3 = TWO_PI * Math.sqrt(a ** 3 / MU_EARTH);
  const s0 = propagateKepler(iss, iss.epochMs);
  near(measurePeriod(s0.r, s0.v, 1), kepler3, 0.01, 'period (s)');
});

test('propagator: after exactly one period the state repeats', () => {
  const { n } = toKeplerian(iss);
  const periodMs = (TWO_PI / n) * 1000;
  const t0 = iss.epochMs + 12_345_000;
  const a = propagateKepler(iss, t0);
  const b = propagateKepler(iss, t0 + 3 * periodMs);
  near(norm(sub(a.r, b.r)), 0, 1e-6, 'position (km)');
  near(norm(sub(a.v, b.v)), 0, 1e-9, 'velocity (km/s)');
});
