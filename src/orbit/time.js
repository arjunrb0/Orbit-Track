// Time scales for orbit work.
//
// Julian Date (JD): a continuous count of days since noon, 1 January 4713 BC.
// Astronomers use it because it has no months, leap years or time zones, so
// "how many days between two instants" is just a subtraction. The Unix epoch
// (1970-01-01 00:00 UTC) is JD 2440587.5; J2000.0 (2000-01-01 12:00) is 2451545.0.
//
// Precision note: a JD near 2.46 million stored in a double resolves about
// 40 microseconds, which moves the ISS 0.3 m. Fine for this project.
//
// UTC vs UT1: Earth's rotation angle really depends on UT1 (time kept by the
// spinning Earth), which differs from UTC by up to 0.9 s. We use UTC as an
// approximation. At the equator that's up to ~0.4 km of ground error.

import { TWO_PI } from './constants.js';

export const JD_UNIX_EPOCH = 2440587.5;
export const JD_J2000 = 2451545.0;
const MS_PER_DAY = 86_400_000;

/** Julian Date for a time in ms since 1970 (UTC, used as an approximation to UT1). */
export function julianDate(timeMs) {
  return timeMs / MS_PER_DAY + JD_UNIX_EPOCH;
}

/**
 * Greenwich Mean Sidereal Time: the angle between the vernal equinox
 * direction (the inertial x axis) and the Greenwich meridian.
 *
 * A sidereal day (one rotation relative to the stars) is 23 h 56 m 4 s, about
 * 4 minutes shorter than a solar day, because Earth also moves ~1 degree along
 * its orbit each day. So GMST gains ~360.9856 degrees per solar day.
 *
 * Formula: IAU-82 (Vallado eq. 3-47), the one SGP4 and the TEME frame are
 * defined with:
 *   GMST(s) = 67310.54841 + (876600 h + 8640184.812866) T
 *             + 0.093104 T^2 - 6.2e-6 T^3,      T = Julian centuries since J2000
 *
 * @param {number} timeMs  UTC time, ms since 1970
 * @returns {number} GMST in radians, in [0, 2pi)
 */
export function gmst(timeMs) {
  const T = (julianDate(timeMs) - JD_J2000) / 36525;
  const seconds =
    67310.54841 + (876600 * 3600 + 8640184.812866) * T + 0.093104 * T * T - 6.2e-6 * T * T * T;
  // 86400 sidereal-time seconds make a full turn.
  const angle = ((seconds % 86400) / 86400) * TWO_PI;
  return angle < 0 ? angle + TWO_PI : angle;
}
