// TEME -> J2000 (EME2000), the frame NASA publishes the ISS trajectory in.
//
// Earth's spin axis isn't fixed in space:
//  - Precession: it sweeps a cone every ~26,000 years (like a spinning top),
//    so the equinox moves ~50" per year. Since 2000 that's ~0.37 deg, which
//    shifts an ISS position by ~44 km. Must be included.
//  - Nutation: a small wobble on top, ~17" with an 18.6-year period, caused by
//    the Moon's orbit. ~0.5 km at ISS distance.
//
// Steps (Vallado sec. 3.7; Vallado et al. 2006 for TEME):
//   TEME -> TOD   rotate by the equation of the equinoxes   (true equator, true equinox)
//   TOD  -> MOD   undo nutation                              (mean equator, mean equinox of date)
//   MOD  -> J2000 undo precession since 2000
//
// Nutation uses only the four largest IAU-1980 terms, good to ~0.5" (~15 m
// at the ISS). Precession is the full IAU-1976 formula.

import { rotateX, rotateY, rotateZ } from './vec.js';
import { julianDate, JD_J2000 } from './time.js';

const ARCSEC = Math.PI / (180 * 3600);
const DEG = Math.PI / 180;
// Terrestrial Time - UTC = 37 leap seconds + 32.184 s (no leap second since 2017).
const TT_MINUS_UTC_S = 69.184;

/** Nutation in longitude and obliquity, and mean obliquity (radians). */
export function nutation(timeMs) {
  const T = (julianDate(timeMs + TT_MINUS_UTC_S * 1000) - JD_J2000) / 36525;
  const node = (125.04452 - 1934.136261 * T) * DEG; // Moon's ascending node
  const Ls = (280.4665 + 36000.7698 * T) * DEG; // Sun's mean longitude
  const Lm = (218.3165 + 481267.8813 * T) * DEG; // Moon's mean longitude
  const dPsi = (-17.2 * Math.sin(node) - 1.32 * Math.sin(2 * Ls) - 0.23 * Math.sin(2 * Lm) + 0.21 * Math.sin(2 * node)) * ARCSEC;
  const dEps = (9.2 * Math.cos(node) + 0.57 * Math.cos(2 * Ls) + 0.1 * Math.cos(2 * Lm) - 0.09 * Math.cos(2 * node)) * ARCSEC;
  const meanEps = (84381.448 - 46.815 * T - 0.00059 * T * T + 0.001813 * T * T * T) * ARCSEC;
  return { dPsi, dEps, meanEps, T };
}

/** Convert a TEME vector to J2000 at a UTC time (ms). */
export function temeToJ2000(r, timeMs) {
  const { dPsi, dEps, meanEps, T } = nutation(timeMs);
  const trueEps = meanEps + dEps;
  // TEME -> TOD: the equation of the equinoxes, dPsi cos(eps).
  let v = rotateZ(r, dPsi * Math.cos(meanEps));
  // TOD -> MOD: N = ROT1(-meanEps) ROT3(dPsi) ROT1(trueEps), applied right to left.
  // (Vallado's ROTk(a) rotates the axes by a, i.e. the vector by -a.)
  v = rotateX(v, -trueEps);
  v = rotateZ(v, -dPsi);
  v = rotateX(v, meanEps);
  // MOD -> J2000: P = ROT3(zeta) ROT2(-theta) ROT3(z), applied right to left.
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * ARCSEC;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * ARCSEC;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * ARCSEC;
  v = rotateZ(v, -z);
  v = rotateY(v, theta);
  v = rotateZ(v, -zeta);
  return v;
}
