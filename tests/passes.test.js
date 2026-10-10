import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOmm } from '../src/data/elements.js';
import { DEG, R_EARTH } from '../src/orbit/constants.js';
import { propagateKepler } from '../src/orbit/kepler.js';
import { propagateJ2, propagateJ2Drag } from '../src/orbit/j2.js';
import { subSatellitePoint } from '../src/orbit/frames.js';
import { sgp4Reference } from '../src/analysis/compare.js';
import { findPasses, lookAt } from '../src/passes/passes.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const issOmm = read('./fixtures/iss-omm.json');
const iss = parseOmm(issOmm);
const ha = read('./fixtures/heavens-above-iss-bengaluru.json');
const data = read('../public/data/omm.json');
const bySat = (id) => {
  const omm = data.satellites.find((s) => s.NORAD_CAT_ID === id);
  return parseOmm(omm);
};
const bengaluru = { lat: ha.observer.latDeg * DEG, lon: ha.observer.lonDeg * DEG, height: ha.observer.heightM / 1000 };
const london = { lat: 51.5072 * DEG, lon: -0.1276 * DEG, height: 0 };
const START = Date.parse('2026-10-10T00:00:00Z');
const END = Date.parse('2026-10-20T00:00:00Z');
const sgp4 = sgp4Reference(issOmm);

/** Match each Heavens-Above pass to ours; returns time differences (s) and max-altitude differences (deg). */
function compareWithHeavensAbove(propagate) {
  const { passes } = findPasses(iss, bengaluru, { start: START, end: END, minElevationDeg: 10, propagate });
  return ha.passes.map((h) => {
    const p = passes.find((x) => Math.abs(x.max.t - Date.parse(h.max)) < 15 * 60e3);
    if (!p) return { missing: true, day: h.max.slice(0, 10) };
    return {
      day: h.max.slice(0, 10),
      dt: [p.rise.t - Date.parse(h.start), p.max.t - Date.parse(h.max), p.set.t - Date.parse(h.end)].map((x) => x / 1000),
      dAlt: p.max.elDeg - h.maxAltDeg,
    };
  });
}

// ---------------------------------------------------- against Heavens-Above
// Heavens-Above (retrieved 2026-10-10) used the same ISS element set, with
// SGP4. Running *my* pass search and coordinate code with SGP4 underneath
// therefore tests everything except my propagator.

test('Heavens-Above: with SGP4 underneath, my pass search reproduces all 27 passes to within 3 s', () => {
  const rows = compareWithHeavensAbove((_, t) => sgp4(t));
  for (const r of rows) {
    assert.ok(!r.missing, `missing pass on ${r.day}`);
    for (const d of r.dt) assert.ok(Math.abs(d) <= 3, `${r.day}: ${d} s`);
    assert.ok(Math.abs(r.dAlt) <= 0.6, `${r.day}: max altitude off by ${r.dAlt.toFixed(2)} deg`); // H-A rounds to 1 deg
  }
});

test('Heavens-Above: my J2 propagator gets every pass within a minute over 10 days', () => {
  const rows = compareWithHeavensAbove(propagateJ2);
  for (const r of rows) {
    assert.ok(!r.missing, `missing pass on ${r.day}`);
    for (const d of r.dt) assert.ok(Math.abs(d) <= 60, `${r.day}: ${d} s`);
    assert.ok(Math.abs(r.dAlt) <= 1.5, `${r.day}: max altitude off by ${r.dAlt.toFixed(2)} deg`);
  }
  // Within the first 3 days (fresh data), much tighter.
  for (const r of rows.filter((x) => x.day < '2026-10-13')) {
    for (const d of r.dt) assert.ok(Math.abs(d) <= 10, `${r.day}: ${d} s`);
  }
});

test('Heavens-Above: with the n-dot drag term, every pass is within 5 s for all 10 days', () => {
  for (const r of compareWithHeavensAbove(propagateJ2Drag)) {
    assert.ok(!r.missing, `missing pass on ${r.day}`);
    for (const d of r.dt) assert.ok(Math.abs(d) <= 5, `${r.day}: ${d} s`);
    assert.ok(Math.abs(r.dAlt) <= 1, `${r.day}: max altitude off by ${r.dAlt.toFixed(2)} deg`);
  }
});

test('Heavens-Above: pure Kepler loses most passes within 10 days (why J2 is needed)', () => {
  const rows = compareWithHeavensAbove(propagateKepler);
  const ok = rows.filter((r) => !r.missing && r.dt.every((d) => Math.abs(d) <= 60)).length;
  assert.ok(ok < ha.passes.length / 2, `${ok} of ${ha.passes.length} within a minute`);
});

// -------------------------------------------------- the search algorithm

const twoDays = findPasses(iss, bengaluru, { start: START, end: START + 2 * 86400e3 });

test('rise and set are where the elevation crosses the horizon; max really is the maximum', () => {
  assert.ok(twoDays.passes.length >= 6);
  const el = (t) => lookAt(iss, bengaluru, t).elevation / DEG;
  for (const p of twoDays.passes) {
    assert.ok(Math.abs(p.rise.elDeg) < 0.01 && Math.abs(p.set.elDeg) < 0.01, 'crossing at 0 deg');
    assert.ok(el(p.rise.t - 2000) < 0 && el(p.rise.t + 2000) > 0, 'rising through the horizon');
    assert.ok(el(p.set.t - 2000) > 0 && el(p.set.t + 2000) < 0, 'setting through the horizon');
    for (let t = p.rise.t; t <= p.set.t; t += 1000) assert.ok(el(t) <= p.max.elDeg + 1e-3, 'nothing higher than max');
  }
});

test('ISS passes never last longer than the geometric limit (~11.2 min)', () => {
  // Overhead pass at apogee height (425 km): the satellite crosses a cap of
  // angular radius acos(R/(R+h)) either side of the observer, at 360 deg per
  // orbit relative to Earth's centre. A pass heading roughly east lasts longer,
  // because the ground under it moves the same way: at most by a factor
  // 1 / (1 - v_ground_rotation / v_ground_track).
  const periodMin = 92.98;
  const capDeg = Math.acos(R_EARTH / (R_EARTH + 425)) / DEG;
  const groundTrackSpeed = (2 * Math.PI * R_EARTH) / (periodMin * 60); // km/s
  const surfaceSpeed = 0.4651 * Math.cos(bengaluru.lat); // km/s, Earth's rotation at this latitude
  const limitMin = ((2 * capDeg) / 360) * periodMin / (1 - surfaceSpeed / groundTrackSpeed);
  for (const p of twoDays.passes) assert.ok(p.durationS / 60 <= limitMin, `${(p.durationS / 60).toFixed(1)} min vs limit ${limitMin.toFixed(2)}`);
  assert.ok(Math.max(...twoDays.passes.map((p) => p.durationS / 60)) > 0.95 * limitMin, 'an overhead pass gets close to the limit');
});

test('result does not depend on the scan step, including a low grazing pass', () => {
  const coarse = findPasses(iss, bengaluru, { start: START, end: START + 2 * 86400e3, stepMs: 240e3 });
  assert.equal(coarse.passes.length, twoDays.passes.length);
  assert.ok(twoDays.passes.some((p) => p.max.elDeg < 5), 'test set includes a grazing pass');
  coarse.passes.forEach((p, k) => {
    assert.ok(Math.abs(p.rise.t - twoDays.passes[k].rise.t) < 500);
    assert.ok(Math.abs(p.set.t - twoDays.passes[k].set.t) < 500);
  });
});

// ------------------------------------------------- satellites that don't pass

test('INSAT-3DR (geostationary) is always up from Bengaluru, at the textbook elevation', () => {
  const insat = bySat(41752);
  const now = insat.epochMs;
  const result = findPasses(insat, bengaluru, { start: now, end: now + 86400e3 });
  assert.equal(result.status, 'always-up');
  // Independent spherical-Earth formula for a geostationary satellite:
  //   cos(g) = cos(lat) cos(dLon),  el = atan((cos g - R/r) / sin g)
  const sub = subSatellitePoint(propagateJ2(insat, now).r, now);
  const g = Math.acos(Math.cos(bengaluru.lat) * Math.cos((sub.lonDeg - 77.5946) * DEG));
  const expected = Math.atan((Math.cos(g) - R_EARTH / (R_EARTH + sub.height)) / Math.sin(g)) / DEG;
  const actual = lookAt(insat, bengaluru, now).elevation / DEG;
  assert.ok(Math.abs(actual - expected) < 0.5, `elevation ${actual.toFixed(2)} vs ${expected.toFixed(2)}`);
});

test('ASTROSAT (6 deg inclination) never rises over London (51.5 deg N)', () => {
  const astrosat = bySat(40930);
  const result = findPasses(astrosat, london, { start: astrosat.epochMs, end: astrosat.epochMs + 2 * 86400e3 });
  assert.equal(result.status, 'never-up');
});
