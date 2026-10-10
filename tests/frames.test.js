import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOmm } from '../src/data/elements.js';
import { DEG, TWO_PI } from '../src/orbit/constants.js';
import { julianDate, gmst } from '../src/orbit/time.js';
import {
  temeToEcef,
  ecefToTeme,
  geodeticToEcef,
  ecefToGeodetic,
  lookAngles,
  subSatellitePoint,
  WGS84_A,
} from '../src/orbit/frames.js';
import { propagateKepler, toKeplerian } from '../src/orbit/kepler.js';
import { norm, sub } from '../src/orbit/vec.js';

const iss = parseOmm(JSON.parse(readFileSync(new URL('./fixtures/iss-omm.json', import.meta.url), 'utf8')));
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected} ± ${tol}, got ${actual}`);
const wrapDeg = (x) => x - 360 * Math.round(x / 360);

// -------------------------------------------------------------------- time

test('Julian date: Unix epoch, J2000, and Vallado Example 3-4', () => {
  assert.equal(julianDate(0), 2440587.5);
  assert.equal(julianDate(Date.UTC(2000, 0, 1, 12)), 2451545.0);
  near(julianDate(Date.UTC(1996, 9, 26, 14, 20)), 2450383.09722222, 1e-8);
});

test('GMST: Vallado Example 3-5 (1992-08-20 12:14 UT1 -> 152.578787886 deg)', () => {
  near(gmst(Date.UTC(1992, 7, 20, 12, 14)) / DEG, 152.578787886, 1e-6);
});

test('GMST: Earth turns once per sidereal day (23 h 56 m 4.0905 s)', () => {
  const t = Date.UTC(2026, 9, 10);
  near(wrapDeg((gmst(t + 86164.0905e3) - gmst(t)) / DEG), 0, 1e-4, 'deg after one sidereal day');
  // ...and gains ~0.9856 deg on the Sun each solar day
  near(wrapDeg((gmst(t + 86400e3) - gmst(t)) / DEG), 0.9856, 0.0005, 'deg per solar day');
});

// ---------------------------------------------------------- TEME <-> ECEF

test('TEME -> Earth-fixed: Vallado (2006) worked example', () => {
  // 2004-04-06 07:51:28.386009 UTC, with UT1 - UTC = -0.4399619 s supplied by
  // shifting the time. Published result in the pseudo-Earth-fixed frame (no polar motion).
  const tUt1 = Date.UTC(2004, 3, 6, 7, 51, 28) + 386.009 - 439.9619;
  const r = temeToEcef([5094.1801621, 6127.6446595, 6380.3445327], tUt1);
  const ref = [-1033.4750313, 7901.3055856, 6380.3445327];
  for (let k = 0; k < 3; k++) near(r[k], ref[k], 1e-4, `r[${k}] km`);
});

test('TEME <-> ECEF round trip', () => {
  const r = [1234.5, -6543.2, 2345.6];
  const t = Date.UTC(2026, 9, 10, 8, 30);
  near(norm(sub(ecefToTeme(temeToEcef(r, t), t), r)), 0, 1e-9);
});

// ------------------------------------------------------ geodetic <-> ECEF

test('geodetic -> ECEF: equator and the WGS-84 polar radius', () => {
  const eq = geodeticToEcef(0, 0, 0);
  near(eq[0], WGS84_A, 1e-9);
  const pole = geodeticToEcef(90 * DEG, 0, 0);
  near(pole[2], 6356.752314245, 1e-6, 'polar radius b (km)');
  near(Math.hypot(pole[0], pole[1]), 0, 1e-9);
});

test('ECEF -> geodetic: Vallado Example 3-3', () => {
  const g = ecefToGeodetic([6524.834, 6862.875, 6448.296]);
  near(g.lat / DEG, 34.352496, 1e-6);
  near(g.lon / DEG, 46.4464, 1e-4);
  near(g.height, 5085.22, 0.01);
});

test('geodetic round trip from the ground to GEO, including the poles', () => {
  for (const latDeg of [-90, -89.9, -45, 0, 12.97, 51.6, 89.99, 90]) {
    for (const lonDeg of [-179.9, -77.6, 0, 77.6, 180]) {
      for (const h of [0, 0.92, 420, 35786]) {
        const g = ecefToGeodetic(geodeticToEcef(latDeg * DEG, lonDeg * DEG, h));
        near(g.lat / DEG, latDeg, 1e-9, `lat ${latDeg},${lonDeg},${h}`);
        near(g.height, h, 1e-6, `height ${latDeg},${lonDeg},${h}`);
        if (Math.abs(latDeg) < 90) near(wrapDeg(g.lon / DEG - lonDeg), 0, 1e-9, `lon ${latDeg},${lonDeg},${h}`);
      }
    }
  }
});

// ------------------------------------------------------------ look angles

test('look angles: straight up, due north on the horizon, due east', () => {
  const obs = { lat: 0, lon: 0, height: 0 };
  const up = lookAngles([WGS84_A + 500, 0, 0], obs);
  near(up.elevation / DEG, 90, 1e-9);
  near(up.range, 500, 1e-9);
  const north = lookAngles([WGS84_A, 0, 1000], obs);
  near(north.azimuth / DEG, 0, 1e-9);
  near(north.elevation / DEG, 0, 1e-9);
  const east = lookAngles([WGS84_A, 1000, 0], obs);
  near(east.azimuth / DEG, 90, 1e-9);
});

test('look angles: "up" is the ellipsoid normal, not the line to Earth\'s centre', () => {
  // A point directly above a mid-latitude observer along the local vertical
  // must be at exactly 90 deg elevation. Using the geocentric direction instead
  // would be off by up to ~0.19 deg at 45 deg latitude.
  const obs = { lat: 12.9716 * DEG, lon: 77.5946 * DEG, height: 0.92 };
  const overhead = geodeticToEcef(obs.lat, obs.lon, 500);
  near(lookAngles(overhead, obs).elevation / DEG, 90, 1e-7);
});

// --------------------------------------------------------- ground tracks

test('ISS ground track reaches a maximum latitude equal to its inclination', () => {
  let maxLat = 0;
  for (let s = 0; s < 6000; s += 10) {
    const { r } = propagateKepler(iss, iss.epochMs + s * 1000);
    maxLat = Math.max(maxLat, subSatellitePoint(r, iss.epochMs + s * 1000).latDeg);
  }
  // Geodetic latitude runs slightly above the geocentric 51.63 deg.
  near(maxLat, 51.7, 0.15, 'max latitude (deg)');
});

test('each ISS orbit lands ~23.3 deg further west (Earth turns under it)', () => {
  // Find two successive northward equator crossings and compare longitudes.
  const crossings = [];
  let prev = null;
  for (let s = 0; crossings.length < 2; s += 5) {
    const t = iss.epochMs + s * 1000;
    const p = subSatellitePoint(propagateKepler(iss, t).r, t);
    if (prev && prev.latDeg < 0 && p.latDeg >= 0) crossings.push(p.lonDeg);
    prev = p;
  }
  const periodS = TWO_PI / toKeplerian(iss).n;
  const expected = -(360 * periodS) / 86164.0905; // Earth's rotation during one orbit
  near(wrapDeg(crossings[1] - crossings[0]), expected, 0.1, 'longitude shift (deg)');
});
