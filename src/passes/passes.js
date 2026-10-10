// Pass prediction: when does a satellite rise above, peak in, and set below
// an observer's sky?
//
// The satellite's elevation e(t) is a smooth function of time. A pass is an
// interval where e(t) > min elevation. To find them:
//
// 1. Coarse scan: sample e(t) every `step` (60 s by default) and look for
//    sign changes of f(t) = e(t) - minElevation.
// 2. Bisection: a sign change between t_a and t_b brackets a root. Halve the
//    bracket, keep the half where the sign still changes, repeat. Each round
//    halves the uncertainty, so 60 s -> 0.1 s takes 10 rounds. Slow but it
//    can't fail, which is what you want for a time printed in a pass list.
// 3. Maximum elevation: e(t) has a single hump during a pass, so golden-section
//    search (like bisection, but for the peak of a hump) narrows it down.
// 4. Grazing passes: a low pass can peak *between* two samples that are both
//    below the horizon, so no sign change is seen. Any sampled local maximum
//    close to the threshold is refined, and if its true peak clears the
//    threshold it becomes a pass.
//
// Geostationary satellites don't rise or set at all, so the result also says
// whether the satellite was always up or never up in the window.

import { DEG } from '../orbit/constants.js';
import { propagateJ2 } from '../orbit/j2.js';
import { temeToEcef, lookAngles } from '../orbit/frames.js';

const BISECT_TOLERANCE_MS = 100;
const GOLDEN = (Math.sqrt(5) - 1) / 2; // 0.618...
// How far below the threshold a sampled peak can be and still be worth
// refining. A 60 s step on a low-orbit satellite near the horizon misses at
// most a few degrees.
const GRAZE_MARGIN = 3 * DEG;

/** Azimuth, elevation (radians) and range (km) of the satellite from the observer at time t. */
export function lookAt(el, observer, t, propagate = propagateJ2) {
  return lookAngles(temeToEcef(propagate(el, t).r, t), observer);
}

function bisect(f, a, b) {
  // Invariant: sign(f(a)) != sign(f(b))
  let fa = f(a);
  while (b - a > BISECT_TOLERANCE_MS) {
    const mid = (a + b) / 2;
    const fm = f(mid);
    if (Math.sign(fm) === Math.sign(fa)) {
      a = mid;
      fa = fm;
    } else {
      b = mid;
    }
  }
  return (a + b) / 2;
}

function goldenMax(f, a, b) {
  let c = b - GOLDEN * (b - a), d = a + GOLDEN * (b - a);
  let fc = f(c), fd = f(d);
  while (b - a > BISECT_TOLERANCE_MS) {
    if (fc > fd) {
      b = d; d = c; fd = fc;
      c = b - GOLDEN * (b - a); fc = f(c);
    } else {
      a = c; c = d; fc = fd;
      d = a + GOLDEN * (b - a); fd = f(d);
    }
  }
  return (a + b) / 2;
}

/**
 * Find passes in [start, end].
 *
 * @param {object} el        parsed elements
 * @param {{lat:number, lon:number, height:number}} observer  radians, km
 * @param {object} opts
 * @param {number} opts.start            ms
 * @param {number} opts.end              ms
 * @param {number} [opts.stepMs]         coarse scan step
 * @param {number} [opts.minElevationDeg] horizon threshold (0 = geometric horizon)
 * @param {Function} [opts.propagate]    (el, t) -> { r, v } in TEME
 * @returns {{ status: 'passes'|'always-up'|'never-up', passes: Array<object> }}
 *   Each pass: { rise, max, set, durationS, partial } where rise/max/set are
 *   { t, azDeg, elDeg }. `partial` is set if the pass was already in progress
 *   at `start` (rise is then the window start) or still going at `end`.
 */
export function findPasses(el, observer, { start, end, stepMs = 60e3, minElevationDeg = 0, propagate = propagateJ2 }) {
  const minEl = minElevationDeg * DEG;
  const look = (t) => lookAt(el, observer, t, propagate);
  const f = (t) => look(t).elevation - minEl;
  const point = (t) => {
    const l = look(t);
    return { t, azDeg: l.azimuth / DEG, elDeg: l.elevation / DEG };
  };

  const samples = [];
  for (let t = start; t < end; t += stepMs) samples.push({ t, f: f(t) });
  samples.push({ t: end, f: f(end) });

  if (samples.every((s) => s.f > 0)) return { status: 'always-up', passes: [] };

  const passes = [];
  const finish = (riseT, setT, partial) => {
    const tMax = goldenMax(f, riseT, setT);
    passes.push({
      rise: point(riseT),
      max: point(tMax),
      set: point(setT),
      durationS: (setT - riseT) / 1000,
      partial,
    });
  };

  let riseT = samples[0].f > 0 ? start : null;
  let partialStart = samples[0].f > 0;
  for (let k = 1; k < samples.length; k++) {
    const prev = samples[k - 1], cur = samples[k];
    if (prev.f <= 0 && cur.f > 0) {
      riseT = bisect(f, prev.t, cur.t);
    } else if (prev.f > 0 && cur.f <= 0 && riseT !== null) {
      finish(riseT, bisect(f, prev.t, cur.t), partialStart);
      riseT = null;
      partialStart = false;
    } else if (
      // Grazing check: a sampled local maximum that is below, but near, the threshold.
      k + 1 < samples.length && cur.f <= 0 && cur.f > -GRAZE_MARGIN &&
      cur.f >= prev.f && cur.f >= samples[k + 1].f
    ) {
      const next = samples[k + 1];
      const tPeak = goldenMax(f, prev.t, next.t);
      if (f(tPeak) > 0) finish(bisect(f, prev.t, tPeak), bisect(f, tPeak, next.t), false);
    }
  }
  if (riseT !== null) finish(riseT, end, true); // still up at the end of the window

  return { status: passes.length ? 'passes' : 'never-up', passes };
}

/** Points along a pass for drawing a sky plot: [{ t, azDeg, elDeg }]. */
export function passTrack(el, observer, pass, stepMs = 10e3, propagate = propagateJ2) {
  const out = [];
  for (let t = pass.rise.t; t < pass.set.t; t += stepMs) {
    const l = lookAt(el, observer, t, propagate);
    out.push({ t, azDeg: l.azimuth / DEG, elDeg: l.elevation / DEG });
  }
  const l = lookAt(el, observer, pass.set.t, propagate);
  out.push({ t: pass.set.t, azDeg: l.azimuth / DEG, elDeg: l.elevation / DEG });
  return out;
}

/** 16-point compass name for an azimuth in degrees. */
export function compass16(azDeg) {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16];
}
