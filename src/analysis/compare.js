// Compare our propagators against SGP4 (satellite.js, used only as a reference).
//
// Important framing: SGP4 is the model the TLE/OMM elements were *fitted*
// for, so it's the right yardstick for "how well does my propagator use
// these elements". It is not ground truth. SGP4 itself is typically ~1 km off
// at epoch and drifts by a few km per day for low orbits.
//
// Errors are split into the satellite's own frame (taken from the SGP4 state):
//   radial       R: along r (up/down)
//   along-track  I: along the direction of motion (early/late)
//   cross-track  C: perpendicular to the orbit plane (left/right)
// This shows *why* a model is wrong. A wrong orbital period shows up
// along-track; a wrongly oriented plane (e.g. missing node drift) shows up
// cross-track.

import { json2satrec, sgp4 } from './sgp4-lib.js';
import { propagateKepler } from '../orbit/kepler.js';
import { propagateJ2, propagateJ2Drag } from '../orbit/j2.js';
import { sub, dot, cross, norm, scale } from '../orbit/vec.js';
import { JD_UNIX_EPOCH } from '../orbit/time.js';
import { temeToJ2000 } from '../orbit/precession.js';

export const MODELS = {
  kepler: { label: 'Two-body (Kepler)', propagate: propagateKepler },
  j2: { label: 'Two-body + J2 secular', propagate: propagateJ2 },
  drag: { label: 'Two-body + J2 + drag (n-dot)', propagate: propagateJ2Drag },
};

/** Build an SGP4 propagator for an OMM record: (timeMs) -> { r, v } in TEME, or null on failure. */
export function sgp4Reference(omm) {
  const rec = json2satrec(omm);
  if (rec.error) throw new Error(`SGP4 init failed for ${omm.OBJECT_NAME} (code ${rec.error})`);
  const epochMs = (rec.jdsatepoch + (rec.jdsatepochF ?? 0) - JD_UNIX_EPOCH) * 86_400_000;
  return (timeMs) => {
    const out = sgp4(rec, (timeMs - epochMs) / 60_000);
    if (!out || !out.position || rec.error) return null;
    const { position: p, velocity: v } = out;
    return { r: [p.x, p.y, p.z], v: [v.x, v.y, v.z] };
  };
}

/** Error of `test` relative to `ref`, total and in radial / along-track / cross-track components (km). */
export function ricError(test, ref) {
  const d = sub(test.r, ref.r);
  const R = scale(ref.r, 1 / norm(ref.r));
  const h = cross(ref.r, ref.v);
  const C = scale(h, 1 / norm(h));
  const I = cross(C, R);
  return { total: norm(d), radial: dot(d, R), along: dot(d, I), cross: dot(d, C) };
}

/**
 * Error time series for one satellite.
 * @param {object} el    parsed elements (parseOmm)
 * @param {object} omm   the raw OMM record (for SGP4)
 * @param {number} durationMs
 * @param {number} stepMs
 * @param {number} [startMs]  defaults to the element epoch
 * @returns {Array<{ t: number, kepler: object, j2: object }>}  t in ms since start
 */
export function errorSeries(el, omm, durationMs, stepMs, startMs = el.epochMs) {
  const ref = sgp4Reference(omm);
  const out = [];
  for (let t = 0; t <= durationMs; t += stepMs) {
    const truth = ref(startMs + t);
    if (!truth) break;
    const row = { t };
    for (const [key, model] of Object.entries(MODELS)) row[key] = ricError(model.propagate(el, startMs + t), truth);
    out.push(row);
  }
  return out;
}

/**
 * Error time series against NASA's ISS trajectory (EME2000/J2000 states),
 * for this project's models and for SGP4 itself. Each model's TEME output is
 * converted to J2000 first (precession and nutation since 2000).
 *
 * @param {Array} states  [[isoTime, x, y, z, vx, vy, vz], ...] in km, km/s
 * @returns {Array<{ t, kepler, j2, drag, sgp4 }>}  t in ms since the element epoch
 */
export function errorSeriesVsTruth(el, omm, states, durationMs = 7 * 86400e3) {
  const sgp4 = sgp4Reference(omm);
  const models = { ...Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, m.propagate])), sgp4: (_, t) => sgp4(t) };
  const out = [];
  for (const [time, ...state] of states) {
    const t = Date.parse(time);
    if (t < el.epochMs || t > el.epochMs + durationMs) continue;
    const truth = { r: state.slice(0, 3), v: state.slice(3, 6) };
    const row = { t: t - el.epochMs };
    for (const [key, propagate] of Object.entries(models)) {
      const s = propagate(el, t);
      if (!s) return out;
      row[key] = ricError({ r: temeToJ2000(s.r, t), v: temeToJ2000(s.v, t) }, truth);
    }
    out.push(row);
  }
  return out;
}

/**
 * Summary numbers for a series: the worst error seen within each horizon,
 * which is fairer than the error at one instant (errors oscillate within an orbit).
 */
export function summarise(series, horizonsMs, keys = Object.keys(MODELS)) {
  return horizonsMs.map((h) => {
    const inWindow = series.filter((row) => row.t <= h);
    const result = { horizonMs: h };
    for (const key of keys) {
      result[key] = inWindow.length ? Math.max(...inWindow.map((row) => row[key].total)) : NaN;
    }
    return result;
  });
}
