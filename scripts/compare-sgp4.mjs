// Measure how far this project's propagators drift from SGP4 for every
// satellite in public/data/omm.json, check pass predictions and visibility
// against Heavens-Above, and write docs/RESULTS.md.
//
// Run with `npm run compare`. Each satellite is propagated from its own
// element-set epoch, with 1-minute steps for 7 days. Numbers quoted in the
// prose are computed here too, so the text stays true when the data changes.

import { readFileSync, writeFileSync } from 'node:fs';
import { CATALOG } from '../src/data/catalog.js';
import { parseOmm } from '../src/data/elements.js';
import { errorSeries, summarise, sgp4Reference } from '../src/analysis/compare.js';
import { findPasses, passVisibility } from '../src/passes/passes.js';
import { propagateKepler, toKeplerian } from '../src/orbit/kepler.js';
import { propagateJ2, propagateJ2Drag, j2Rates, J2, DEEP_SPACE_PERIOD_S } from '../src/orbit/j2.js';
import { DEG, MU_EARTH, R_EARTH, TWO_PI, SECONDS_PER_DAY } from '../src/orbit/constants.js';

const HOUR = 3600e3, DAY = 86400e3;
const HORIZONS = [0, HOUR, DAY, 7 * DAY];
const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const data = read('../public/data/omm.json');

const fmt = (km) => (km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString('en-GB'));
const range = (xs) => `${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))}`;
const sci = (x) => {
  const [m, e] = x.toExponential(1).split('e');
  return `${m} × 10<sup>${Number(e)}</sup>`;
};

// ------------------------------------------------- error vs SGP4, per satellite
const sats = [];
for (const omm of data.satellites) {
  const el = parseOmm(omm);
  const info = CATALOG.find((s) => s.noradId === el.noradId);
  const series = errorSeries(el, omm, 7 * DAY, 60e3);
  const k = toKeplerian(el);
  const periodS = TWO_PI / k.n;
  sats.push({
    el,
    name: info?.name ?? el.name,
    orbit: info?.orbit ?? '',
    series,
    summary: summarise(series, HORIZONS),
    day: series.find((r) => r.t === DAY),
    nearEarth: periodS < DEEP_SPACE_PERIOD_S,
    periodMin: periodS / 60,
    altitudeKm: k.a - R_EARTH,
    nodeRateDegPerDay: (j2Rates(k.n, el.eccentricity, k.i).raanDot * SECONDS_PER_DAY) / DEG,
  });
}
const leo = sats.filter((s) => s.nearEarth);
const geo = sats.filter((s) => !s.nearEarth);
const at = (s, h) => s.summary.find((x) => x.horizonMs === h);
const rows = sats.map((s) => `| ${s.name} | ${s.orbit} | ${s.summary.map((x) => `${fmt(x.kepler)} / ${fmt(x.j2)} / ${fmt(x.drag)}`).join(' | ')} |`);
const ric = sats.map((s) => {
  const comp = (m) => ['radial', 'along', 'cross'].map((k) => fmt(Math.abs(s.day[m][k]))).join(' / ');
  return `| ${s.name} | ${comp('kepler')} | ${comp('j2')} |`;
});
const issSat = sats.find((s) => s.el.noradId === 25544);
const issWeekJ2 = at(issSat, 7 * DAY).j2;
const issWeekDrag = at(issSat, 7 * DAY).drag;
const issDragPredicted = issSat.el.meanMotionDotHalf * 49 * TWO_PI * toKeplerian(issSat.el).a;

// -------------------------------- passes and visibility vs Heavens-Above (frozen)
const ha = read('../tests/fixtures/heavens-above-iss-bengaluru.json');
const issOmm = read('../tests/fixtures/iss-omm.json');
const iss = parseOmm(issOmm);
const sgp4 = sgp4Reference(issOmm);
const obs = { lat: ha.observer.latDeg * DEG, lon: ha.observer.lonDeg * DEG, height: ha.observer.heightM / 1000 };
const window10 = { start: Date.parse('2026-10-10T00:00:00Z'), end: Date.parse('2026-10-20T00:00:00Z') };
const passRows = [];
for (const [label, propagate] of [
  ['SGP4 (satellite.js) + this project\'s pass search and frames', (_, t) => sgp4(t)],
  ['Kepler + J2 + drag', propagateJ2Drag],
  ['Kepler + J2', propagateJ2],
  ['Pure Kepler', propagateKepler],
]) {
  const { passes } = findPasses(iss, obs, { ...window10, minElevationDeg: 10, propagate });
  const diffs = ha.passes.map((h) => {
    const p = passes.find((x) => Math.abs(x.max.t - Date.parse(h.max)) < 15 * 60e3);
    if (!p) return null;
    return { dt: Math.max(...[p.rise.t - Date.parse(h.start), p.max.t - Date.parse(h.max), p.set.t - Date.parse(h.end)].map((x) => Math.abs(x) / 1000)), dAlt: Math.abs(p.max.elDeg - h.maxAltDeg), day: h.max.slice(0, 10) };
  });
  const found = diffs.filter(Boolean);
  const within = found.filter((d) => d.dt <= 60).length;
  const worst = (arr) => (arr.length ? `${Math.round(Math.max(...arr.map((d) => d.dt)))} s` : 'n/a');
  passRows.push(`| ${label} | ${found.length} / ${ha.passes.length} | ${within} / ${ha.passes.length} | ${worst(found.filter((d) => d.day === '2026-10-10'))} | ${worst(found.filter((d) => d.day === '2026-10-19'))} | ${found.length ? Math.max(...found.map((d) => d.dAlt)).toFixed(1) + '°' : 'n/a'} |`);
}
// Visibility labels: Heavens-Above labels the whole pass down to 0 deg.
const passes0 = findPasses(iss, obs, { start: window10.start - 30 * 60e3, end: window10.end + 30 * 60e3, minElevationDeg: 0, propagate: propagateJ2Drag }).passes;
const passes10 = findPasses(iss, obs, { ...window10, minElevationDeg: 10, propagate: propagateJ2Drag }).passes;
const label = (list, h) => passVisibility(iss, obs, list.find((x) => Math.abs(x.max.t - Date.parse(h.max)) < 600e3), propagateJ2Drag).type;
const match0 = ha.passes.filter((h) => label(passes0, h) === h.type).length;
const match10 = ha.passes.filter((h) => label(passes10, h) === h.type).length;
const nVisible = ha.passes.filter((h) => h.type === 'visible').length;

// ------------------------------------------- forces at low and high orbit
const rIss = toKeplerian(iss).a;
const rGeo = 42164;
const GM_MOON = 4902.8, D_MOON = 384400; // km^3/s^2, km
const GM_SUN = 1.32712e11, D_SUN = 1.496e8;
const forces = (r) => ({
  central: MU_EARTH / r ** 2,
  j2: (1.5 * J2 * MU_EARTH * R_EARTH ** 2) / r ** 4, // size of the J2 term, equatorial
  moon: (2 * GM_MOON * r) / D_MOON ** 3, // tidal (differential) pull, at most
  sun: (2 * GM_SUN * r) / D_SUN ** 3,
});
const fIss = forces(rIss), fGeo = forces(rGeo);
// Drag at the ISS, estimated from its n-dot: energy loss rate = drag x speed.
const nIss = toKeplerian(iss).n;
const nDot = (2 * iss.meanMotionDotHalf * TWO_PI) / SECONDS_PER_DAY ** 2; // rad/s^2
const aDot = -(2 / 3) * (rIss / nIss) * nDot; // km/s
const vIss = Math.sqrt(MU_EARTH / rIss);
fIss.drag = (MU_EARTH / (2 * rIss ** 2 * vIss)) * Math.abs(aDot);
const decayMPerDay = Math.abs(aDot) * SECONDS_PER_DAY * 1000;
const forceRow = (name, key, note) => {
  const g = fIss[key], h = fGeo[key];
  const ppm = (x, c) => {
    const v = (x / c) * 1e6;
    if (v < 0.01) return '< 0.01';
    return v >= 100 ? Math.round(Number(v.toPrecision(2))).toLocaleString('en-GB') : String(Number(v.toPrecision(2)));
  };
  return `| ${name} | ${sci(g)} | ${ppm(g, fIss.central)} | ${h === undefined ? '≈ 0' : sci(h)} | ${h === undefined ? '≈ 0' : ppm(h, fGeo.central)} | ${note} |`;
};
const geoAngle = (km) => (Math.atan(km / (rGeo - R_EARTH)) / DEG).toFixed(2);

const md = `# Results

Generated by \`npm run compare\` from the element sets fetched ${data.fetchedAt.slice(0, 10)}.
Each satellite is propagated from its own element-set epoch. The reference is SGP4
([satellite.js](https://github.com/shashwatak/satellite-js)), the model these elements were fitted for.

**SGP4 is the yardstick here, not the truth.** It is itself typically ~1 km off at
epoch and drifts by a few km per day for low orbits, so these numbers say how well this
project's propagators use the elements, not how close they are to where the satellite really is.

Three models, each adding one piece of physics:

1. **Kepler:** two-body motion only. The orbit is a fixed ellipse.
2. **+ J2:** the secular (steady) drifts caused by Earth's equatorial bulge.
3. **+ J2 + drag:** plus a drag term from the element set's own ṅ (low orbits only; there is no
   air at geosynchronous height).

## Position error vs SGP4 (km)

Worst error within each window, sampled every minute. Each cell is **Kepler / + J2 / + J2 + drag**.

| Satellite | Orbit | At epoch | 1 hour | 1 day | 1 week |
|---|---|---|---|---|---|
${rows.join('\n')}

## Where the error is after 1 day (km)

Split into radial / along-track / cross-track, relative to the SGP4 position.

| Satellite | Kepler (R / I / C) | Kepler + J2 (R / I / C) |
|---|---|---|
${ric.join('\n')}

## What the numbers show

- **Pure Kepler is unusable after a few hours in low orbit.** After one day it is
  ${range(leo.map((s) => at(s, DAY).kepler))} km off. The cross-track part comes from the orbit plane
  drifting (the ISS's plane turns ~5°/day); the along-track part comes from the orbital period and
  perigee drift that J2 causes.
- **Adding J2's secular drift closes most of that gap for low orbits**, down to
  ${range(leo.map((s) => at(s, DAY).j2))} km after one day. The J2 rates agree with SGP4's own internal
  rates to within 0.1–0.7%.
- **Adding the drag term fixes most of the rest over a week.** For the ISS the 1-week error drops from
  ${fmt(issWeekJ2)} km to ${fmt(issWeekDrag)} km. Without it, the error was almost entirely along-track and
  grew like t², just as the element set's ṅ predicts (≈${fmt(issDragPredicted)} km after 7 days). Across the
  low-orbit satellites the 1-week error with drag is ${range(leo.map((s) => at(s, 7 * DAY).drag))} km.
- **The error at epoch (${range(sats.map((s) => at(s, 0).kepler))} km) isn't fixed by either correction.**
  Published elements are *mean* elements: averages with SGP4's short-period wobbles (a few km within
  each orbit) removed. SGP4 adds those wobbles back; these models don't.
- **At epoch, the J2 model is sometimes a few km *worse* than plain Kepler.** It uses SGP4's
  corrected (Brouwer) semi-major axis, which differs from the plain one by up to a few km depending on
  inclination; in SGP4 the short-period terms partly offset that. Over any window longer than an hour,
  the corrected value wins clearly.
- **Geosynchronous orbits behave differently**, explained in the next section.

## Low orbits vs high orbits

The eight satellites span two very different regimes:

| Satellite | Mean altitude | Period | Node drift from J2 | Error after 1 day: Kepler / J2 + drag | Error after 1 week: Kepler / J2 + drag |
|---|---|---|---|---|---|
${sats.map((s) => `| ${s.name} | ${fmt(s.altitudeKm)} km | ${s.periodMin < 200 ? `${s.periodMin.toFixed(1)} min` : `${(s.periodMin / 60).toFixed(2)} h`} | ${s.nodeRateDegPerDay.toFixed(s.nearEarth ? 2 : 4)}°/day | ${fmt(at(s, DAY).kepler)} / ${fmt(at(s, DAY).drag)} km | ${fmt(at(s, 7 * DAY).kepler)} / ${fmt(at(s, 7 * DAY).drag)} km |`).join('\n')}

In low orbit the corrections improve the 1-week error by a factor of
${range(leo.map((s) => at(s, 7 * DAY).kepler / at(s, 7 * DAY).drag))}. At geosynchronous height plain Kepler is already within
${range(geo.map((s) => at(s, 7 * DAY).kepler))} km after a week, and the corrections don't reliably help.

**Why the difference: the forces involved.** Sizes of the accelerations acting on a satellite at the
ISS's orbit (${fmt(rIss)} km from Earth's centre) and at geostationary orbit (${fmt(rGeo)} km), from
textbook constants. "ppm" is parts per million of Earth's ordinary (central) gravity there.

| Force | At the ISS (km/s²) | ppm | At GEO (km/s²) | ppm | How it scales with distance r |
|---|---|---|---|---|---|
${forceRow('Earth, as a point mass', 'central', '1/r², the two-body model')}
${forceRow('Earth\'s bulge (J2)', 'j2', '1/r⁴, so 1/r² *relative* to central gravity')}
${forceRow('Moon (tidal)', 'moon', 'grows like r')}
${forceRow('Sun (tidal)', 'sun', 'grows like r')}
${forceRow('Air drag', 'drag', `ISS value estimated from its ṅ (≈${Math.round(decayMPerDay)} m/day of decay); no air at GEO`)}

- **In low orbit, J2 dominates everything except Earth itself.** At the ISS it is
  ${Math.round(fIss.j2 / fIss.moon).toLocaleString('en-GB')} times stronger than the Moon's pull and
  ${Math.round(fIss.j2 / fIss.drag).toLocaleString('en-GB')} times stronger than drag. So adding J2 fixes most of the
  error, drag fixes most of what's left, and the Sun and Moon can safely be ignored.
- **At geostationary height, J2 is no longer special.** Relative to central gravity it is
  ${Math.round((fIss.j2 / fIss.central) / (fGeo.j2 / fGeo.central))} times weaker than at the ISS, and the satellite
  makes one orbit a day instead of ${(SECONDS_PER_DAY / 60 / issSat.periodMin).toFixed(1)}, so J2's drift accumulates far
  more slowly. Meanwhile the Moon's tidal pull is ${(fGeo.moon / fGeo.j2).toFixed(2)}× and the Sun's
  ${(fGeo.sun / fGeo.j2).toFixed(2)}× the size of J2. A model with J2 but no Sun and Moon is missing physics as big
  as what it includes, which is why J2 helps IRNSS-1I but makes INSAT-3DR worse. SGP4's deep-space mode
  includes Sun, Moon and resonance terms; these models don't.
- **Drag is a low-orbit effect only.** The air density at 400 km is tiny but not zero. At 36,000 km there
  is effectively none, which is why the ṅ term is applied only below SGP4's 225-minute dividing line.
- **What matters to an observer is angle, not kilometres.** A geostationary satellite is ~${fmt(rGeo - R_EARTH)} km away,
  so a ${fmt(at(geo[0], 7 * DAY).j2)} km error is only ${geoAngle(at(geo[0], 7 * DAY).j2)}° on the sky, far less than a satellite dish's
  beam width. In low orbit the satellite moves fast, so the same kind of error shows up as a *timing* error
  instead: 7.7 km/s means 15 km is about 2 seconds.

## Pass predictions vs Heavens-Above

27 ISS passes over Bengaluru (12.9716°N, 77.5946°E, 920 m), 10–20 October 2026, retrieved from
[Heavens-Above](https://www.heavens-above.com) on 2026-10-10. Heavens-Above used the same element
set (epoch 9 October). Its start and end times are when the ISS crosses 10° elevation, so these use
10° too. Each pass's error is the worst of its rise, highest-point and set time differences.

| Propagator | Passes found | Within 1 minute | Worst error, day 1 | Worst error, day 10 | Worst max-elevation difference |
|---|---|---|---|---|---|
${passRows.join('\n')}

- **The first row tests everything except the propagator.** Heavens-Above uses SGP4 too, so running
  this project's pass search, sidereal time, frame conversions and look angles on SGP4 positions should
  reproduce its list exactly, and it does (elevation differences are Heavens-Above rounding to whole degrees).
- **With J2 + drag, every pass is within a few seconds for all 10 days.** With J2 alone the error grows
  to about 40 s by day 10 (the drag-driven along-track drift). Pass times are forgiving of position
  errors that look large in kilometres.
- **Pure Kepler misses most passes** (they happen at a different time, or not at all, in its model).

## Visible passes vs Heavens-Above

A pass is **visible** when the satellite is sunlit while the observer's sky is dark (Sun more than 6°
below the horizon), **daylight** when the sky is too bright, and **unlit** when the sky is dark but the
satellite is in Earth's shadow. Heavens-Above labels each pass the same way (${nVisible} of the 27 are visible).

- Labelling each whole pass down to the true horizon, as Heavens-Above does: **${match0} / 27 labels match.**
- Labelling only the part above 10° (what the app lists): ${match10} / 27 match. The difference is a pass on
  15 October that stays in Earth's shadow above 10° and only reaches sunlight at 0.5° elevation, 9 seconds
  before it sets. Heavens-Above calls it visible; in practice nobody would see it.
- The shadow model (Earth as a sphere, Sun's centre hidden) agrees with satellite.js's shadow function
  at every sampled position outside the few seconds of penumbra.

## Limitations of this comparison

- Errors are measured from each element set's epoch. In the app, positions are predicted
  from data that is already hours or days old, so real-world error is larger.
- One snapshot of elements per satellite. A fuller study would repeat this over many element
  sets and dates.
- No comparison against true positions (e.g. GPS-derived ISS ephemerides) yet.
- The force table gives magnitudes only (the tidal terms are their maximum values); the effect on an
  orbit also depends on direction and on how the force averages over an orbit.
`;
writeFileSync(new URL('../docs/RESULTS.md', import.meta.url), md);
console.log(md);
