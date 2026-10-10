// Against NASA's own ISS trajectory (EME2000/J2000), rather than SGP4.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOmm } from '../src/data/elements.js';
import { temeToJ2000 } from '../src/orbit/precession.js';
import { sgp4Reference, ricError } from '../src/analysis/compare.js';
import { propagateKepler } from '../src/orbit/kepler.js';
import { propagateJ2, propagateJ2Drag } from '../src/orbit/j2.js';
import { norm, sub } from '../src/orbit/vec.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const issOmm = read('./fixtures/iss-omm.json');
const iss = parseOmm(issOmm);
const oem = read('./fixtures/iss-oem-nasa.json');
const sgp4 = sgp4Reference(issOmm);
const DAY = 86400e3;

test('TEME -> J2000 reproduces Vallado et al. (2006) to 1 m', () => {
  const t = Date.UTC(2004, 3, 6, 7, 51, 28) + 386.009;
  const r = temeToJ2000([5094.1801621, 6127.6446595, 6380.3445327], t);
  assert.ok(norm(sub(r, [5102.5089579, 6123.0114007, 6378.1369282])) < 0.001);
});

/** Worst error vs NASA within `days` of the element-set epoch, for a TEME propagator. */
function worstVsNasa(propagate, days) {
  let worst = 0;
  for (const [time, ...state] of oem.states) {
    const t = Date.parse(time);
    if (t < iss.epochMs || t > iss.epochMs + days * DAY) continue;
    const s = propagate(iss, t);
    const e = ricError({ r: temeToJ2000(s.r, t), v: temeToJ2000(s.v, t) }, { r: state.slice(0, 3), v: state.slice(3) });
    worst = Math.max(worst, e.total);
  }
  return worst;
}

test('frames check on real data: SGP4 and NASA agree radially and cross-track to 0.2 km at epoch', () => {
  const [time, ...state] = oem.states.find(([time]) => Date.parse(time) >= iss.epochMs);
  const t = Date.parse(time);
  const s = sgp4(t);
  const e = ricError({ r: temeToJ2000(s.r, t), v: temeToJ2000(s.v, t) }, { r: state.slice(0, 3), v: state.slice(3) });
  // A frame mistake (e.g. missing precession, ~44 km) would show up here.
  assert.ok(Math.abs(e.radial) < 0.2 && Math.abs(e.cross) < 0.2, `R ${e.radial.toFixed(3)} C ${e.cross.toFixed(3)} km`);
});

test('vs NASA: SGP4 itself is within 10 km for a day and ~60 km after a week', () => {
  assert.ok(worstVsNasa((_, t) => sgp4(t), 1) < 10);
  assert.ok(worstVsNasa((_, t) => sgp4(t), 7) < 70);
});

test('vs NASA: the J2 models stay within ~2x of SGP4\'s own error; pure Kepler does not', () => {
  assert.ok(worstVsNasa(propagateKepler, 1) > 400, 'Kepler after 1 day');
  for (const [name, f] of [['J2', propagateJ2], ['J2 + drag', propagateJ2Drag]]) {
    assert.ok(worstVsNasa(f, 1) < 25, `${name}, 1 day`);
    assert.ok(worstVsNasa(f, 3) < 40, `${name}, 3 days`);
    assert.ok(worstVsNasa(f, 7) < 100, `${name}, 7 days`);
  }
});
