// What an observer actually sees: refraction and brightness.

import { DEG } from '../orbit/constants.js';
import { norm, sub, dot } from '../orbit/vec.js';

/**
 * Atmospheric refraction: air bends light so objects near the horizon look
 * higher than they geometrically are, by about 34' (more than the Sun's
 * width) at the horizon and about 5' at 10 deg.
 *
 * Saemundsson's formula (Meeus, Astronomical Algorithms, eq. 16.4), for the
 * true (geometric) elevation h in degrees, standard conditions (10 C, 1010 hPa):
 *   R [arcmin] = 1.02 / tan(h + 10.3 / (h + 5.11))
 * The small constant makes R exactly 0 at the zenith.
 *
 * @param {number} trueElevation radians
 * @returns {number} apparent elevation, radians
 */
export function apparentElevation(trueElevation) {
  const h = Math.max(trueElevation / DEG, -1.5); // formula is only meant for h > ~-1 deg
  const arcmin = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * DEG) + 0.0019279;
  return trueElevation + (Math.max(0, arcmin) / 60) * DEG;
}

/**
 * Phase angle at the satellite: the angle between the directions to the Sun
 * and to the observer. 0 = fully lit side facing you ("full"), 180 = backlit.
 */
export function phaseAngle(rSat, rSun, rObserver) {
  const toSun = sub(rSun, rSat), toObs = sub(rObserver, rSat);
  return Math.acos(Math.max(-1, Math.min(1, dot(toSun, toObs) / (norm(toSun) * norm(toObs)))));
}

/**
 * Estimated visual magnitude (smaller = brighter; Venus ~ -4, Sirius ~ -1.5).
 *
 * Model: a diffusely reflecting (Lambertian) sphere. The light it sends
 * towards you scales as F(phi) = sin(phi) + (pi - phi) cos(phi), and as
 * 1/range^2. A satellite's "standard magnitude" is its brightness at 1000 km
 * range and 90 deg phase (half lit), where F = 1, so
 *   m = m_std + 5 log10(range / 1000 km) - 2.5 log10(F(phi))
 *
 * Real satellites aren't spheres: the ISS's solar arrays can make it ~1
 * magnitude brighter or dimmer than this predicts depending on their angle.
 */
export function visualMagnitude(standardMagnitude, rangeKm, phase) {
  const F = Math.sin(phase) + (Math.PI - phase) * Math.cos(phase);
  return standardMagnitude + 5 * Math.log10(rangeKm / 1000) - 2.5 * Math.log10(Math.max(F, 1e-6));
}
