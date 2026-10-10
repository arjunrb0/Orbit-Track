// Physical constants. Units throughout the orbit code: km, s, radians.
//
// We use WGS-72 rather than the newer WGS-84 because the TLE/OMM elements
// were fitted with WGS-72 inside SGP4. Converting mean motion to semi-major
// axis with a different mu would introduce a (small) inconsistency before
// we even start. The difference: mu differs by ~0.4 km^3/s^2 in 398600, which
// changes the ISS's semi-major axis by about 2 m.

export const MU_EARTH = 398600.8; // km^3/s^2, WGS-72 gravitational parameter (G * M_earth)
export const R_EARTH = 6378.135; // km, WGS-72 equatorial radius

export const TWO_PI = 2 * Math.PI;
export const DEG = Math.PI / 180; // multiply degrees by this to get radians
export const SECONDS_PER_DAY = 86400;
