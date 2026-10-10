// Checks on the committed data files in public/data/. The daily fetch Action
// runs these before committing, and the deploy runs them before publishing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { CATALOG } from '../src/data/catalog.js';
import { parseOmm, parseTleText, validateElements } from '../src/data/elements.js';

const read = (name) => readFileSync(new URL(`../public/data/${name}`, import.meta.url), 'utf8');
const omm = JSON.parse(read('omm.json'));
const fromOmm = omm.satellites.map(parseOmm);
const fromTle = parseTleText(read('tle.txt'));

test('data file has a fetch timestamp', () => {
  assert.ok(Number.isFinite(Date.parse(omm.fetchedAt)));
});

test('every catalogue satellite is present exactly once', () => {
  const ids = fromOmm.map((e) => e.noradId).sort();
  assert.deepEqual(ids, CATALOG.map((s) => s.noradId).sort());
});

test('every element set passes validation', () => {
  for (const el of fromOmm) assert.deepEqual(validateElements(el), [], el.name);
});

test('TLE file matches the OMM file', () => {
  assert.equal(fromTle.length, fromOmm.length);
  for (const t of fromTle) {
    const o = fromOmm.find((e) => e.noradId === t.noradId);
    assert.ok(o, `no OMM for ${t.noradId}`);
    assert.ok(Math.abs(o.epochMs - t.epochMs) < 1, `${t.name} epoch`);
    assert.equal(o.inclinationDeg, t.inclinationDeg, `${t.name} inclination`);
  }
});

test('NASA ISS ephemeris (if present) is EME2000, time-ordered and physically plausible', { skip: !existsSync(new URL('../public/data/iss-oem.json', import.meta.url)) }, () => {
  const oem = JSON.parse(read('iss-oem.json'));
  assert.equal(oem.frame, 'EME2000');
  assert.equal(oem.timeSystem, 'UTC');
  let prev = -Infinity;
  for (const [time, x, y, z, vx, vy, vz] of oem.states) {
    const t = Date.parse(time);
    assert.ok(t > prev, `time order at ${time}`);
    prev = t;
    const r = Math.hypot(x, y, z), v = Math.hypot(vx, vy, vz);
    assert.ok(r > 6550 && r < 7000, `radius ${r} at ${time}`);
    assert.ok(v > 7.4 && v < 7.9, `speed ${v} at ${time}`);
  }
});
