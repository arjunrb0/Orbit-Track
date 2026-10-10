import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOmm } from '../src/data/elements.js';
import { DEG } from '../src/orbit/constants.js';
import { propagateJ2Drag } from '../src/orbit/j2.js';
import { findPasses, passVisibility } from '../src/passes/passes.js';
import { apparentElevation, visualMagnitude } from '../src/passes/sky.js';
import { CATALOG } from '../src/data/catalog.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected} ± ${tol}, got ${actual}`);
const refractionArcmin = (trueDeg) => (apparentElevation(trueDeg * DEG) / DEG - trueDeg) * 60;

const iss = parseOmm(read('./fixtures/iss-omm.json'));
const ha = read('./fixtures/heavens-above-iss-visible.json');
const obs = { lat: ha.observer.latDeg * DEG, lon: ha.observer.lonDeg * DEG, height: ha.observer.heightM / 1000 };
const ISS_STD_MAG = CATALOG.find((s) => s.noradId === 25544).standardMagnitude;

// ------------------------------------------------------------- refraction

test('refraction matches the standard values: 34\' at the horizon, ~5.3\' at 10 deg, ~1\' at 45 deg, 0 overhead', () => {
  // An object whose apparent position is on the horizon is geometrically ~34.5' (0.575 deg) below it.
  near(apparentElevation(-0.575 * DEG) / DEG, 0, 0.03, 'horizon');
  near(refractionArcmin(10), 5.3, 0.25, 'at 10 deg (arcmin)');
  near(refractionArcmin(45), 1.0, 0.05, 'at 45 deg (arcmin)');
  near(refractionArcmin(90), 0, 0.01, 'at the zenith (arcmin)');
});

test('with refraction, ISS passes appear a few seconds earlier at the horizon', () => {
  const window = { start: iss.epochMs, end: iss.epochMs + 2 * 86400e3, propagate: propagateJ2Drag };
  const geometric = findPasses(iss, obs, window).passes;
  const apparent = findPasses(iss, obs, { ...window, refraction: true }).passes;
  assert.equal(apparent.length, geometric.length);
  apparent.forEach((p, k) => {
    const earlier = (geometric[k].rise.t - p.rise.t) / 1000;
    assert.ok(earlier > 3 && earlier < 25, `rises ${earlier.toFixed(1)} s earlier`);
  });
});

// -------------------------------------------------------------- brightness

test('magnitude model: inverse-square range and Lambert-sphere phase law', () => {
  near(visualMagnitude(-1.8, 1000, Math.PI / 2), -1.8, 1e-12, 'standard conditions');
  near(visualMagnitude(-1.8, 2000, Math.PI / 2), -1.8 + 5 * Math.log10(2), 1e-12, 'twice as far: 1.5 mag fainter');
  near(visualMagnitude(-1.8, 1000, 0), -1.8 - 2.5 * Math.log10(Math.PI), 1e-12, 'fully lit: 1.24 mag brighter');
  assert.ok(visualMagnitude(-1.8, 1000, 2.5) > visualMagnitude(-1.8, 1000, 1.0), 'backlit is fainter');
});

// ------------------------------------------- against Heavens-Above (visible)

const { passes } = findPasses(iss, obs, {
  start: Date.parse('2026-10-10T00:00:00Z'),
  end: Date.parse('2026-10-20T00:00:00Z'),
  minElevationDeg: 10,
  propagate: propagateJ2Drag,
});
const visible = passes
  .map((p) => ({ p, v: passVisibility(iss, obs, p, propagateJ2Drag, 1e3, { standardMagnitude: ISS_STD_MAG }) }))
  .filter((x) => x.v.type === 'visible');
const matched = ha.passes.map((h) => ({ h, x: visible.find((q) => Math.abs(q.p.max.t - Date.parse(h.highestVisible)) < 600e3) }));

test('Heavens-Above visible list: the same 4 passes, with shadow entry/exit within 3 s', () => {
  assert.equal(visible.length, ha.passes.length);
  for (const { h, x } of matched) {
    assert.ok(x, `missing ${h.visibleStart}`);
    near((x.v.from - Date.parse(h.visibleStart)) / 1000, 0, 3, `${h.visibleStart} visible from (s)`);
    near((x.v.to - Date.parse(h.visibleEnd)) / 1000, 0, 3, `${h.visibleStart} visible until (s)`);
  }
});

test('Heavens-Above visible list: magnitudes within 0.75, and the same brightest pass', () => {
  for (const { h, x } of matched) near(x.v.magnitude, h.magnitude, 0.75, `${h.visibleStart} magnitude`);
  const brightest = (arr, mag) => arr.reduce((a, b) => (mag(b) < mag(a) ? b : a));
  const ours = brightest(matched, (m) => m.x.v.magnitude);
  const theirs = brightest(matched, (m) => m.h.magnitude);
  assert.equal(ours.h.visibleStart, theirs.h.visibleStart);
});
