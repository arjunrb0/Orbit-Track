import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOmm } from '../src/data/elements.js';
import { DEG, R_EARTH } from '../src/orbit/constants.js';
import { norm } from '../src/orbit/vec.js';
import { sunPosition, isSunlit, AU_KM } from '../src/orbit/sun.js';
import { propagateJ2Drag } from '../src/orbit/j2.js';
import { findPasses, passVisibility } from '../src/passes/passes.js';
// satellite.js's shadow model, used only as a reference to compare against.
import { shadowFraction } from '../node_modules/satellite.js/dist/shadow.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected} ± ${tol}, got ${actual}`);
const declinationDeg = (r) => Math.asin(r[2] / norm(r)) / DEG;

// -------------------------------------------- Sun position vs published events

test('Sun is on the celestial equator at the March 2026 equinox (20 Mar 14:46 UTC)', () => {
  near(declinationDeg(sunPosition(Date.UTC(2026, 2, 20, 14, 46))), 0, 0.02, 'declination (deg)');
});

test('Sun reaches the obliquity (23.44 deg) at the June 2026 solstice (21 Jun 08:24 UTC)', () => {
  near(declinationDeg(sunPosition(Date.UTC(2026, 5, 21, 8, 24))), 23.436, 0.02, 'declination (deg)');
});

test('Earth-Sun distance at 2026 perihelion (3 Jan) and aphelion (6 Jul)', () => {
  near(norm(sunPosition(Date.UTC(2026, 0, 3, 17, 16))) / AU_KM, 0.98330, 0.0003, 'perihelion (AU)');
  near(norm(sunPosition(Date.UTC(2026, 6, 6, 17, 31))) / AU_KM, 1.01664, 0.0003, 'aphelion (AU)');
});

// ------------------------------------------------------------ Earth's shadow

test('shadow geometry: behind Earth is dark, sun side and above the terminator are lit', () => {
  const sun = [AU_KM, 0, 0];
  const r = R_EARTH + 420;
  assert.equal(isSunlit([-r, 0, 0], sun), false, 'directly behind Earth');
  assert.equal(isSunlit([r, 0, 0], sun), true, 'between Earth and Sun');
  assert.equal(isSunlit([0, r, 0], sun), true, 'over the terminator: still sees the Sun');
  // Just inside the shadow edge: angle from anti-Sun direction < asin(R/r)
  const edge = Math.asin(R_EARTH / r);
  assert.equal(isSunlit([-r * Math.cos(edge - 0.01), r * Math.sin(edge - 0.01), 0], sun), false, 'just inside');
  assert.equal(isSunlit([-r * Math.cos(edge + 0.01), r * Math.sin(edge + 0.01), 0], sun), true, 'just outside');
});

test('shadow model agrees with satellite.js everywhere outside the penumbra (ISS, 2 days)', () => {
  const iss = parseOmm(read('./fixtures/iss-omm.json'));
  let compared = 0;
  for (let k = 0; k < 2000; k++) {
    const t = iss.epochMs + k * 97e3;
    const r = propagateJ2Drag(iss, t).r;
    const sun = sunPosition(t);
    const s = sun.map((x) => x / AU_KM);
    const fraction = shadowFraction({ x: s[0], y: s[1], z: s[2] }, { x: r[0], y: r[1], z: r[2] });
    if (fraction > 0.05 && fraction < 0.95) continue; // penumbra: a few seconds per orbit
    compared++;
    assert.equal(isSunlit(r, sun), fraction < 0.5, `t = ${new Date(t).toISOString()}`);
  }
  assert.ok(compared > 1900);
});

// ------------------------------------------- pass visibility vs Heavens-Above

test('visible / daylight / unlit labels match Heavens-Above for all 27 ISS passes', () => {
  // Heavens-Above lists times from 10 deg but labels the whole pass down to
  // the true horizon, so classify the 0 deg pass that contains each listed one.
  const ha = read('./fixtures/heavens-above-iss-bengaluru.json');
  const iss = parseOmm(read('./fixtures/iss-omm.json'));
  const obs = { lat: ha.observer.latDeg * DEG, lon: ha.observer.lonDeg * DEG, height: ha.observer.heightM / 1000 };
  const { passes } = findPasses(iss, obs, {
    start: Date.parse('2026-10-09T23:30:00Z'),
    end: Date.parse('2026-10-20T00:30:00Z'),
    minElevationDeg: 0,
    propagate: propagateJ2Drag,
  });
  for (const h of ha.passes) {
    const p = passes.find((x) => Math.abs(x.max.t - Date.parse(h.max)) < 600e3);
    assert.ok(p, `no pass for ${h.max}`);
    assert.equal(passVisibility(iss, obs, p, propagateJ2Drag).type, h.type, h.max);
  }
});
