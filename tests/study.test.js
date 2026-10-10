import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { archiveElements, spliceTruth, evaluate, summarise, TRUTH_MAX_AGE_DAYS } from '../scripts/accuracy-study.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const issOmm = read('./fixtures/iss-omm.json');
const oem = read('./fixtures/iss-oem-nasa.json');
const asOem = (creationDate, states) => ({ creationDate, states });

test('element archive: adds new element sets once, in epoch order', () => {
  const archive = [];
  archiveElements(archive, { EPOCH: '2026-10-10T00:00:00' });
  archiveElements(archive, { EPOCH: '2026-10-09T00:00:00' });
  archiveElements(archive, { EPOCH: '2026-10-10T00:00:00' });
  assert.deepEqual(archive.map((r) => r.EPOCH), ['2026-10-09T00:00:00', '2026-10-10T00:00:00']);
});

test('truth splice: a newer NASA file replaces everything from its first state on', () => {
  const truth = { sources: [], states: [] };
  spliceTruth(truth, asOem('2026-10-07T21:00:00Z', oem.states.slice(0, 100)));
  const newer = oem.states.slice(50, 150).map((s) => [s[0], s[1] + 1, ...s.slice(2)]);
  spliceTruth(truth, asOem('2026-10-11T00:00:00Z', newer));
  spliceTruth(truth, asOem('2026-10-11T00:00:00Z', newer)); // same file again: ignored
  assert.equal(truth.sources.length, 2);
  assert.equal(truth.states.length, 150);
  assert.equal(truth.states[49].at(-1), 0, 'before the newer file: from the older one');
  assert.equal(truth.states[50].at(-1), 1, 'from the newer file on');
  assert.equal(truth.states[50][1], oem.states[50][1] + 1);
});

test('evaluate: windows count as final only when the truth is fresh enough', () => {
  const truth = { sources: [], states: [] };
  spliceTruth(truth, asOem(oem.creationDate + 'Z', oem.states));
  const r = evaluate(issOmm, truth);
  // NASA file made 7 Oct; the element set is from 9 Oct 19:42. Within 1 day the
  // truth is under 4 days old; by day 3 it is older.
  assert.equal(r.horizons['1d'].final, true);
  assert.ok(r.horizons['1d'].truthMaxAgeDays <= TRUTH_MAX_AGE_DAYS);
  assert.equal(r.horizons['3d'].final, false);
  assert.ok(r.horizons['1d'].sgp4 < 12 && r.horizons['1d'].j2 < 25);
  const s = summarise([r]);
  assert.equal(s['1d'].n, 1);
  assert.equal(s['3d'].n, 0, 'provisional results are left out of the summary');
});
