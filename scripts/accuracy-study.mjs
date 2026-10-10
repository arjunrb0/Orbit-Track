// A growing study of ISS position accuracy against NASA's trajectory.
//
// One element set, one week is a single data point. This script, run by the
// daily GitHub Action, turns it into a study:
//
// 1. Archive every new ISS element set (data/history/iss-elements.json).
// 2. Build a best-estimate "truth" trajectory (data/history/iss-truth.json)
//    by splicing NASA's ephemerides: for each moment, keep the state from the
//    newest NASA file that covers it. NASA's predictions drift as they age
//    (see docs/data/nasa-consistency.json), so newer is better.
// 3. For every archived element set, measure the worst error of SGP4 and of
//    this project's models within 1, 3 and 7 days, against that truth.
//    A window counts as final only when every truth state in it came from a
//    NASA file at most TRUTH_MAX_AGE_DAYS old; until then it is provisional
//    and gets recomputed on later runs as fresher NASA files arrive.
//
// Writes public/data/accuracy-study.json for the website.
// Run with `npm run study`.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseOmm } from '../src/data/elements.js';
import { MODELS, sgp4Reference, ricError } from '../src/analysis/compare.js';
import { temeToJ2000 } from '../src/orbit/precession.js';

const DAY = 86400e3;
export const TRUTH_MAX_AGE_DAYS = 4;
const HORIZONS_DAYS = [1, 3, 7];
const ISS = 25544;
const root = new URL('../', import.meta.url);
const path = (p) => new URL(p, root);
const readJson = async (p, fallback) => (existsSync(path(p)) ? JSON.parse(await readFile(path(p), 'utf8')) : fallback);

/** Add the current ISS element set to the archive if it is new. */
export function archiveElements(archive, omm) {
  if (!archive.some((r) => r.EPOCH === omm.EPOCH)) archive.push(omm);
  archive.sort((a, b) => a.EPOCH.localeCompare(b.EPOCH));
  return archive;
}

/**
 * Splice a NASA ephemeris into the truth archive: states at or after the new
 * file's first state are replaced by the new file's (it is the fresher prediction).
 */
export function spliceTruth(truth, oem) {
  if (truth.sources.some((s) => s.creationDate === oem.creationDate)) return truth;
  const source = truth.sources.length;
  truth.sources.push({ creationDate: oem.creationDate, start: oem.states[0][0], end: oem.states.at(-1)[0] });
  const start = Date.parse(oem.states[0][0]);
  truth.states = truth.states.filter((s) => Date.parse(s[0]) < start).concat(oem.states.map((s) => [...s, source]));
  return truth;
}

/** Worst errors per model within each horizon, plus whether the truth used was fresh enough. */
export function evaluate(omm, truth) {
  const el = parseOmm(omm);
  const sgp4 = sgp4Reference(omm);
  const models = { ...Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, m.propagate])), sgp4: (_, t) => sgp4(t) };
  const created = truth.sources.map((s) => Date.parse(s.creationDate.endsWith('Z') ? s.creationDate : `${s.creationDate}Z`));
  const lastTruth = Date.parse(truth.states.at(-1)?.[0] ?? 0);
  const result = { epoch: omm.EPOCH, horizons: {} };
  for (const days of HORIZONS_DAYS) {
    const end = el.epochMs + days * DAY;
    if (lastTruth < end) continue; // NASA data doesn't reach that far yet
    const worst = Object.fromEntries(Object.keys(models).map((k) => [k, 0]));
    let maxAge = 0, n = 0;
    for (const [time, x, y, z, vx, vy, vz, src] of truth.states) {
      const t = Date.parse(time);
      if (t < el.epochMs || t > end) continue;
      n++;
      maxAge = Math.max(maxAge, (t - created[src]) / DAY);
      const ref = { r: [x, y, z], v: [vx, vy, vz] };
      for (const [k, f] of Object.entries(models)) {
        const s = f(el, t);
        worst[k] = Math.max(worst[k], ricError({ r: temeToJ2000(s.r, t), v: temeToJ2000(s.v, t) }, ref).total);
      }
    }
    if (n < days * 24) continue; // gaps in the truth: skip rather than report a misleading number
    result.horizons[`${days}d`] = { ...Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, Number(v.toFixed(2))])), truthMaxAgeDays: Number(maxAge.toFixed(2)), final: maxAge <= TRUTH_MAX_AGE_DAYS };
  }
  return result;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

/** Medians, ranges and head-to-head counts over final results only. */
export function summarise(records) {
  const out = {};
  for (const days of HORIZONS_DAYS) {
    const key = `${days}d`;
    const final = records.map((r) => r.horizons[key]).filter((h) => h?.final);
    const keys = ['sgp4', ...Object.keys(MODELS)];
    out[key] = {
      n: final.length,
      median: Object.fromEntries(keys.map((k) => [k, median(final.map((h) => h[k]))])),
      min: Object.fromEntries(keys.map((k) => [k, final.length ? Math.min(...final.map((h) => h[k])) : null])),
      max: Object.fromEntries(keys.map((k) => [k, final.length ? Math.max(...final.map((h) => h[k])) : null])),
      beatsSgp4: Object.fromEntries(Object.keys(MODELS).map((k) => [k, final.filter((h) => h[k] < h.sgp4).length])),
    };
  }
  return out;
}

async function main() {
  await mkdir(path('data/history/'), { recursive: true });
  const elements = await readJson('data/history/iss-elements.json', []);
  const truth = await readJson('data/history/iss-truth.json', { sources: [], states: [] });

  const current = (await readJson('public/data/omm.json', { satellites: [] })).satellites.find((s) => s.NORAD_CAT_ID === ISS);
  if (current) archiveElements(elements, current);
  const oem = await readJson('public/data/iss-oem.json', null);
  if (oem) spliceTruth(truth, { ...oem, creationDate: oem.creationDate.endsWith('Z') ? oem.creationDate : `${oem.creationDate}Z` });

  await writeFile(path('data/history/iss-elements.json'), JSON.stringify(elements, null, 1) + '\n');
  await writeFile(path('data/history/iss-truth.json'), JSON.stringify(truth) + '\n');

  const records = elements.map((omm) => evaluate(omm, truth));
  const consistency = await readJson('docs/data/nasa-consistency.json', null);
  const study = {
    updated: new Date().toISOString(),
    truthMaxAgeDays: TRUTH_MAX_AGE_DAYS,
    elementSets: elements.length,
    nasaFiles: truth.sources.length,
    summary: summarise(records),
    records,
    nasaConsistency: consistency?.bins ?? null,
  };
  await writeFile(path('public/data/accuracy-study.json'), JSON.stringify(study) + '\n');
  const s = study.summary;
  console.log(`Study: ${elements.length} ISS element sets, ${truth.sources.length} NASA files.`);
  for (const k of Object.keys(s)) console.log(`  ${k}: ${s[k].n} final; median SGP4 ${s[k].median.sgp4 ?? '–'}, J2 ${s[k].median.j2 ?? '–'}, J2+drag ${s[k].median.drag ?? '–'} km`);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
