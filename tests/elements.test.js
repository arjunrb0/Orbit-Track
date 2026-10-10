import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseOmm,
  parseOmmEpoch,
  parseTle,
  parseTleText,
  parseTleEpoch,
  parseImpliedExponent,
  tleChecksum,
  validateElements,
} from '../src/data/elements.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

// The same ISS element set, downloaded from CelesTrak in both formats on 2026-10-10.
const issOmm = parseOmm(JSON.parse(fixture('iss-omm.json')));
const [issTle] = parseTleText(fixture('iss.tle'));

// Vanguard 1, a standard test case from Vallado et al. (2006), "Revisiting
// Spacetrack Report #3". High eccentricity and a year-2000 epoch.
const VANGUARD = [
  '1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753',
  '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667',
];

test('OMM epoch is read as UTC, not local time, and keeps microseconds', () => {
  const ms = parseOmmEpoch('2026-10-09T19:42:49.139712');
  assert.equal(Math.floor(ms), Date.UTC(2026, 9, 9, 19, 42, 49, 139));
  // A double near 1.8e12 can only resolve ~0.0002 ms, so check to 1 microsecond.
  assert.ok(Math.abs(ms - Math.floor(ms) - 0.712) < 1e-3);
});

test('OMM epoch rejects malformed strings', () => {
  assert.throws(() => parseOmmEpoch('09/10/2026 19:42'));
});

test('TLE epoch: two-digit year rule and fractional day of year', () => {
  assert.equal(parseTleEpoch('98001.50000000'), Date.UTC(1998, 0, 1, 12)); // >= 57 -> 1900s
  assert.equal(parseTleEpoch('00001.00000000'), Date.UTC(2000, 0, 1)); // < 57 -> 2000s
  // Day 282 of 2026 (not a leap year) is 9 October.
  assert.equal(new Date(parseTleEpoch('26282.00000000')).toISOString(), '2026-10-09T00:00:00.000Z');
});

test('TLE checksums of real lines match their final digit', () => {
  const lines = fixture('iss.tle').trim().split('\n').slice(1).concat(VANGUARD);
  for (const line of lines) assert.equal(tleChecksum(line), Number(line[68]), line);
});

test('a corrupted TLE line fails its checksum', () => {
  const bad = VANGUARD[1].replace('34.2682', '34.2683');
  assert.throws(() => parseTle('VANGUARD 1', VANGUARD[0], bad), /checksum/);
});

test('implied-decimal exponent notation', () => {
  assert.equal(parseImpliedExponent(' 12652-3'), 0.12652e-3);
  assert.equal(parseImpliedExponent('-11606-4'), -0.11606e-4);
  assert.equal(parseImpliedExponent(' 00000+0'), 0);
  assert.equal(parseImpliedExponent(' 00000-0'), 0);
});

test('Vanguard 1 TLE parses to the published values', () => {
  const el = parseTle('VANGUARD 1', ...VANGUARD);
  assert.equal(el.noradId, 5);
  assert.equal(el.intlDesignator, '1958-002B');
  assert.equal(el.eccentricity, 0.1859667);
  assert.equal(el.inclinationDeg, 34.2682);
  assert.equal(el.raanDeg, 348.7242);
  assert.equal(el.argPerigeeDeg, 331.7664);
  assert.equal(el.meanAnomalyDeg, 19.3264);
  assert.equal(el.meanMotionRevPerDay, 10.82419157);
  assert.equal(el.bstar, 0.28098e-4);
  assert.equal(el.revAtEpoch, 41366);
  assert.deepEqual(validateElements(el), []);
});

test('ISS: OMM and TLE of the same element set agree to TLE precision', () => {
  assert.equal(issTle.noradId, issOmm.noradId);
  assert.equal(issTle.intlDesignator, issOmm.intlDesignator);
  // TLE epoch has 8 decimal places of a day, i.e. ~0.86 ms resolution.
  assert.ok(Math.abs(issTle.epochMs - issOmm.epochMs) < 1);
  assert.equal(issTle.inclinationDeg, issOmm.inclinationDeg);
  assert.equal(issTle.raanDeg, issOmm.raanDeg);
  assert.equal(issTle.argPerigeeDeg, issOmm.argPerigeeDeg);
  assert.equal(issTle.meanAnomalyDeg, issOmm.meanAnomalyDeg);
  assert.equal(issTle.meanMotionRevPerDay, issOmm.meanMotionRevPerDay);
  assert.equal(issTle.meanMotionDotHalf, issOmm.meanMotionDotHalf);
  // The TLE only has room for 7 digits of eccentricity and 5 of B*, so it is
  // rounded: this is one concrete reason to prefer OMM. Tolerance = one unit in
  // the TLE's last digit (half a unit sits on a floating-point knife edge).
  assert.ok(Math.abs(issTle.eccentricity - issOmm.eccentricity) <= 1e-7);
  assert.ok(Math.abs(issTle.bstar - issOmm.bstar) <= 1e-8);
  assert.notEqual(issTle.eccentricity, issOmm.eccentricity);
});

test('validateElements flags impossible values', () => {
  assert.deepEqual(validateElements(issOmm), []);
  const broken = { ...issOmm, eccentricity: 1.2, raanDeg: 400, meanMotionRevPerDay: 0 };
  assert.deepEqual(validateElements(broken).sort(), ['eccentricity', 'meanMotion', 'raan']);
});
