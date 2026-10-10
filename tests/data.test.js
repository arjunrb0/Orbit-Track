// Checks on the committed data files in public/data/. The daily fetch Action
// runs these before committing, and the deploy runs them before publishing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
