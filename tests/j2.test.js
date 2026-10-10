import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { json2satrec, twoline2satrec } from '../src/analysis/sgp4-lib.js';
import { parseOmm, parseTle } from '../src/data/elements.js';
import { DEG, TWO_PI, SECONDS_PER_DAY } from '../src/orbit/constants.js';
import { unKozai, j2Rates, propagateJ2, propagateJ2Drag } from '../src/orbit/j2.js';
import { propagateKepler, toKeplerian } from '../src/orbit/kepler.js';
import { errorSeries, summarise } from '../src/analysis/compare.js';
import { norm, sub } from '../src/orbit/vec.js';

const issOmm = JSON.parse(readFileSync(new URL('./fixtures/iss-omm.json', import.meta.url), 'utf8'));
const iss = parseOmm(issOmm);
const data = JSON.parse(readFileSync(new URL('../public/data/omm.json', import.meta.url), 'utf8'));
const VANGUARD = [
  '1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753',
  '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667',
];
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected} ± ${tol}, got ${actual}`);
const nKozai = (el) => (el.meanMotionRevPerDay * TWO_PI) / SECONDS_PER_DAY;
const radPerSecToDegPerDay = (x) => (x * SECONDS_PER_DAY) / DEG;
const rates = (el) => j2Rates(nKozai(el), el.eccentricity, el.inclinationDeg * DEG);

// ------------------------------------------------- against SGP4's internals

test('un-Kozai mean motion matches SGP4 initialisation (ISS and Vanguard 1)', () => {
  const cases = [
    [iss, json2satrec(issOmm)],
    [parseTle('VANGUARD 1', ...VANGUARD), twoline2satrec(...VANGUARD)],
  ];
  for (const [el, rec] of cases) {
    const ours = unKozai(nKozai(el), el.eccentricity, el.inclinationDeg * DEG) * 60; // rad/min, like SGP4
    near(ours / rec.no, 1, 1e-10, el.name);
  }
});

test('J2 secular rates match SGP4 to within 1% (SGP4 adds J2^2 and J4 terms)', () => {
  const rec = json2satrec(issOmm);
  const r = rates(iss);
  const perMin = (x) => x * 60;
  near(perMin(r.raanDot) / rec.nodedot, 1, 0.01, 'node rate');
  near(perMin(r.argpDot) / rec.argpdot, 1, 0.01, 'perigee rate');
  near(perMin(r.mDot - r.n) / (rec.mdot - rec.no), 1, 0.01, 'mean anomaly rate correction');
});

// -------------------------------------------------- against physical facts

test('ISS orbit plane regresses about 5 degrees per day', () => {
  near(radPerSecToDegPerDay(rates(iss).raanDot), -5.0, 0.1, 'deg/day');
});

test('sun-synchronous satellites precess 360 deg per year (0.9856 deg/day)', () => {
  for (const id of [44804, 51656, 54361]) {
    const el = parseOmm(data.satellites.find((s) => s.NORAD_CAT_ID === id));
    near(radPerSecToDegPerDay(rates(el).raanDot), 360 / 365.2422, 0.01, el.name);
  }
});

test('perigee stops rotating at the critical inclination, 63.43 deg', () => {
  const r = j2Rates(nKozai({ meanMotionRevPerDay: 2.006 }), 0.72, Math.acos(Math.sqrt(1 / 5)));
  near(r.argpDot, 0, 1e-15);
  assert.ok(j2Rates(nKozai(iss), 0.001, 50 * DEG).argpDot > 0, 'below critical: perigee advances');
  assert.ok(j2Rates(nKozai(iss), 0.001, 70 * DEG).argpDot < 0, 'above critical: perigee regresses');
});

test('with J2 switched off, the J2 propagator is exactly the Kepler propagator', () => {
  for (const hours of [0, 1, 30]) {
    const t = iss.epochMs + hours * 3600e3;
    near(norm(sub(propagateJ2(iss, t, { j2: 0 }).r, propagateKepler(iss, t).r)), 0, 1e-9);
  }
});

// ------------------------------------------- measured accuracy (regression)
// These pin down the results reported in docs/RESULTS.md for the frozen ISS
// fixture, so a future change that makes things worse is caught.

const HOUR = 3600e3, DAY = 86400e3;
const series = errorSeries(iss, issOmm, 7 * DAY, 10 * 60e3);
const [h1, d1, w1] = summarise(series, [HOUR, DAY, 7 * DAY]);

test('ISS vs SGP4: J2 cuts the 1-day error from hundreds of km to under 20 km', () => {
  assert.ok(d1.kepler > 300, `Kepler 1-day error ${d1.kepler.toFixed(1)} km`);
  assert.ok(d1.j2 < 20, `J2 1-day error ${d1.j2.toFixed(1)} km`);
  assert.ok(h1.j2 < 15, `J2 1-hour error ${h1.j2.toFixed(1)} km`);
});

test('ISS vs SGP4 after a week: remaining error is drag, along-track, as predicted by n-dot', () => {
  const end = series.at(-1).j2;
  assert.ok(Math.abs(end.along) > 5 * Math.max(Math.abs(end.radial), Math.abs(end.cross)), 'mostly along-track');
  // Drag makes the mean motion grow: extra angle = (n-dot/2) t^2 revolutions.
  const days = 7;
  const predicted = iss.meanMotionDotHalf * days * days * TWO_PI * toKeplerian(iss).a;
  near(Math.abs(end.along), predicted, 0.25 * predicted, 'along-track km vs n-dot prediction');
  assert.ok(w1.j2 < w1.kepler / 10, 'J2 still at least 10x better than Kepler at 1 week');
});

// ------------------------------------------------------------ drag (n-dot)

test('drag term: with n-dot = 0 it is exactly the J2 model', () => {
  const noDrag = { ...iss, meanMotionDotHalf: 0 };
  const t = iss.epochMs + 5 * DAY;
  near(norm(sub(propagateJ2Drag(noDrag, t).r, propagateJ2(noDrag, t).r)), 0, 1e-9);
});

test('drag term: not applied to deep-space (geosynchronous) orbits, which have no air', () => {
  const insat = parseOmm(data.satellites.find((s) => s.NORAD_CAT_ID === 41752));
  const t = insat.epochMs + 7 * DAY;
  near(norm(sub(propagateJ2Drag(insat, t).r, propagateJ2(insat, t).r)), 0, 1e-9);
});

test('ISS vs SGP4 after a week: the n-dot drag term cuts the error about tenfold', () => {
  const [week] = summarise(series, [7 * DAY]);
  assert.ok(week.drag < 25, `J2 + drag 1-week error ${week.drag.toFixed(1)} km`);
  assert.ok(week.drag < week.j2 / 5, `J2 ${week.j2.toFixed(1)} km vs J2 + drag ${week.drag.toFixed(1)} km`);
});
