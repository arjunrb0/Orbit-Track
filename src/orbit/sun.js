// Where is the Sun, and is a satellite in Earth's shadow?
//
// Sun position: the Astronomical Almanac's low-precision formula (Vallado,
// Algorithm 29). Accurate to about 0.01 deg between 1950 and 2050, far better
// than needed to decide whether a sky is dark or a satellite is sunlit.
//
//   T   = Julian centuries since J2000
//   L   = 280.460 + 36000.771 T                  mean longitude of the Sun
//   M   = 357.529 + 35999.050 T                  mean anomaly of Earth's orbit
//   lam = L + 1.915 sin M + 0.020 sin 2M         ecliptic longitude (Kepler's equation, to first order in e)
//   r   = 1.00014 - 0.01671 cos M - 0.00014 cos 2M   distance in AU
//   eps = 23.439 - 0.013 T                       tilt of Earth's axis (obliquity)
// then rotate from the ecliptic into the equatorial frame by eps.
//
// The result is in the mean-equator-of-date frame, which differs from TEME
// by well under 0.01 deg.

import { DEG, R_EARTH } from './constants.js';
import { julianDate, JD_J2000 } from './time.js';
import { norm, dot, sub } from './vec.js';

export const AU_KM = 149597870.7;

/** Sun position (km) in the inertial frame at a UTC time in ms. */
export function sunPosition(timeMs) {
  const T = (julianDate(timeMs) - JD_J2000) / 36525;
  const L = 280.46 + 36000.771 * T;
  const M = (357.5291092 + 35999.05034 * T) * DEG;
  const lambda = (L + 1.914666471 * Math.sin(M) + 0.019994643 * Math.sin(2 * M)) * DEG;
  const rAu = 1.000140612 - 0.016708617 * Math.cos(M) - 0.000139589 * Math.cos(2 * M);
  const eps = (23.439291 - 0.0130042 * T) * DEG;
  const r = rAu * AU_KM;
  return [r * Math.cos(lambda), r * Math.cos(eps) * Math.sin(lambda), r * Math.sin(eps) * Math.sin(lambda)];
}

/**
 * Is a satellite in sunlight? Seen from the satellite, Earth is a disc of
 * angular radius asin(R / |r|) centred on the direction -r. The satellite is
 * in shadow when the Sun's centre is behind that disc.
 * (Ignores the ~10 s of penumbra and the atmosphere's thickness.)
 */
export function isSunlit(rSat, rSun) {
  const toEarth = rSat.map((x) => -x);
  const toSun = sub(rSun, rSat);
  const angle = Math.acos(dot(toEarth, toSun) / (norm(toEarth) * norm(toSun)));
  return angle > Math.asin(R_EARTH / norm(rSat));
}
