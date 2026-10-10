// Coordinate frames.
//
//  TEME   inertial-ish frame the propagator works in: z = Earth's spin axis,
//         x = towards the vernal equinox. Fixed relative to the stars.
//  ECEF   Earth-centred, Earth-fixed: same z, but x through the Greenwich
//         meridian, so it spins with the Earth. Lat/lon live here.
//  ENU    East/North/Up, centred on an observer. Azimuth/elevation live here.
//
// Positions are [x, y, z] arrays in km. Angles in radians unless named *Deg.

import { DEG, TWO_PI } from './constants.js';
import { rotateZ, sub, norm } from './vec.js';
import { gmst } from './time.js';

// WGS-84 ellipsoid: the shape GPS latitudes/longitudes refer to. (The orbit
// constants are WGS-72 to match SGP4. Earth's *shape* for mapping is WGS-84,
// and the difference between the two ellipsoids is a few metres.)
export const WGS84_A = 6378.137; // km, equatorial radius
export const WGS84_F = 1 / 298.257223563; // flattening
export const WGS84_E2 = WGS84_F * (2 - WGS84_F); // eccentricity squared

/**
 * TEME -> ECEF. The Earth has turned by GMST since its x axis lined up with
 * the equinox, so un-rotate by that angle about z. This ignores polar motion
 * (Earth's axis wobbling by ~10 m at the surface), which is negligible here.
 */
export function temeToEcef(rTeme, timeMs) {
  return rotateZ(rTeme, -gmst(timeMs));
}

/** ECEF -> TEME, the inverse rotation. */
export function ecefToTeme(rEcef, timeMs) {
  return rotateZ(rEcef, gmst(timeMs));
}

/**
 * Geodetic latitude/longitude/height -> ECEF.
 * N is the "prime vertical radius of curvature": the distance from the
 * surface point to the z axis along the local vertical (the normal to the
 * ellipsoid). Because Earth is flattened, the vertical doesn't pass through
 * the centre, which is why the z formula has the (1 - e^2) factor.
 */
export function geodeticToEcef(latRad, lonRad, heightKm = 0) {
  const sinLat = Math.sin(latRad);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const xy = (N + heightKm) * Math.cos(latRad);
  return [xy * Math.cos(lonRad), xy * Math.sin(lonRad), (N * (1 - WGS84_E2) + heightKm) * sinLat];
}

/**
 * ECEF -> geodetic latitude/longitude/height (iterative, Vallado Algorithm 12 style).
 * Longitude is direct. Latitude has no closed form on an ellipsoid, but the
 * fixed-point iteration below converges to sub-millimetre in ~4 rounds, from
 * the ground up to GEO.
 *
 * @returns {{ lat: number, lon: number, height: number }} radians, radians, km
 */
export function ecefToGeodetic([x, y, z]) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - WGS84_E2)); // good first guess
  let N = WGS84_A;
  let height = 0;
  for (let k = 0; k < 10; k++) {
    const sinLat = Math.sin(lat);
    N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    // This height formula stays accurate near the poles, where p/cos(lat) blows up.
    height = p * Math.cos(lat) + (z + WGS84_E2 * N * sinLat) * sinLat - N;
    const next = Math.atan2(z, p * (1 - (WGS84_E2 * N) / (N + height)));
    if (Math.abs(next - lat) < 1e-13) { lat = next; break; }
    lat = next;
  }
  return { lat, lon, height };
}

/**
 * Look angles from an observer to a satellite.
 * 1. Relative position rho = satellite - observer (both ECEF).
 * 2. Project rho onto the observer's local East, North and Up unit vectors.
 * 3. Azimuth = compass bearing (from north, clockwise towards east);
 *    elevation = angle above the horizon.
 *
 * @param {number[]} satEcef  satellite position, ECEF km
 * @param {{lat:number, lon:number, height:number}} observer  geodetic, radians and km
 * @returns {{ azimuth: number, elevation: number, range: number }} radians, radians, km
 */
export function lookAngles(satEcef, observer) {
  const obsEcef = geodeticToEcef(observer.lat, observer.lon, observer.height ?? 0);
  const [dx, dy, dz] = sub(satEcef, obsEcef);
  const sLat = Math.sin(observer.lat), cLat = Math.cos(observer.lat);
  const sLon = Math.sin(observer.lon), cLon = Math.cos(observer.lon);
  const east = -sLon * dx + cLon * dy;
  const north = -sLat * cLon * dx - sLat * sLon * dy + cLat * dz;
  const up = cLat * cLon * dx + cLat * sLon * dy + sLat * dz;
  let azimuth = Math.atan2(east, north);
  if (azimuth < 0) azimuth += TWO_PI;
  return { azimuth, elevation: Math.atan2(up, Math.hypot(east, north)), range: norm([dx, dy, dz]) };
}

/** Convenience: sub-satellite point (lat/lon in degrees, height in km) from a TEME position. */
export function subSatellitePoint(rTeme, timeMs) {
  const g = ecefToGeodetic(temeToEcef(rTeme, timeMs));
  return { latDeg: g.lat / DEG, lonDeg: g.lon / DEG, height: g.height };
}
