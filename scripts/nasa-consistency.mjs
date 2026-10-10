// How good is NASA's ISS trajectory as a "truth" reference?
//
// NASA publishes a new ISS ephemeris about three times a week, each one a
// prediction from that day's tracking. Comparing an older file's prediction
// with a newer file (used only within a day of its creation, when it is
// freshest) shows how fast NASA's own predictions drift with age. That is the
// error bar on every "vs NASA" number in this project.
//
// Run with `npm run nasa-consistency`. Downloads archived files from NASA's
// public bucket into .cache/ (not committed) and writes
// docs/data/nasa-consistency.json.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { listArchivedOems, parseOem, NASA_BUCKET } from './lib/oem.mjs';
import { sub, norm, dot, cross, scale } from '../src/orbit/vec.js';

const SINCE = process.argv[2] ?? '2026-06-01';
const CACHE = new URL('../.cache/nasa-oem/', import.meta.url);
const OUT = new URL('../docs/data/nasa-consistency.json', import.meta.url);
const DAY = 86400e3;

async function load(key) {
  const file = new URL(key.replaceAll('/', '_'), CACHE);
  if (!existsSync(file)) {
    const res = await fetch(`${NASA_BUCKET}/${key}`);
    if (!res.ok) throw new Error(`${res.status} for ${key}`);
    await writeFile(file, await res.text());
  }
  const oem = parseOem(await readFile(file, 'utf8'));
  return { key, created: Date.parse(oem.creationDate), states: oem.states.map(([t, ...s]) => ({ t: Date.parse(t), r: s.slice(0, 3), v: s.slice(3) })) };
}

/** Cubic Hermite interpolation of position from the two states either side of t. */
function interpolate(states, t) {
  let lo = 0, hi = states.length - 1;
  if (t < states[lo].t || t > states[hi].t) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (states[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = states[lo], b = states[hi];
  const h = (b.t - a.t) / 1000; // s
  if (h === 0) return a.r;
  const s = (t - a.t) / 1000 / h;
  const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s;
  const h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
  return [0, 1, 2].map((k) => h00 * a.r[k] + h10 * h * a.v[k] + h01 * b.r[k] + h11 * h * b.v[k]);
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  await mkdir(new URL('./', OUT), { recursive: true });
  const keys = (await listArchivedOems('iss-coords/20')).filter((k) => k.split('/')[1] >= SINCE);
  console.log(`${keys.length} archived ephemerides since ${SINCE}`);
  const files = [];
  for (const key of keys) {
    try {
      files.push(await load(key));
    } catch (err) {
      console.warn(`skipped ${key}: ${err.message}`);
    }
  }
  files.sort((a, b) => a.created - b.created);
  // The archive sometimes holds the same file under two dates: keep one per creation time.
  const unique = files.filter((f, k) => k === 0 || f.created !== files[k - 1].created);
  console.log(`${unique.length} distinct ephemerides (${files.length - unique.length} duplicates removed)`);
  files.length = 0;
  files.push(...unique);

  const samples = []; // { ageDays, total, along }
  for (let i = 0; i + 1 < files.length; i++) {
    const older = files[i];
    // Every newer file, as long as it's fresh (within a day of creation).
    for (const newer of files.slice(i + 1)) {
      for (const s of newer.states) {
        if (s.t < newer.created || s.t > newer.created + DAY) continue;
        const predicted = interpolate(older.states, s.t);
        if (!predicted) continue;
        const d = sub(predicted, s.r);
        const along = scale(cross(cross(s.r, s.v), s.r), 1 / norm(cross(cross(s.r, s.v), s.r)));
        samples.push({ ageDays: (s.t - older.created) / DAY, total: norm(d), along: dot(d, along) });
      }
    }
  }

  const bins = [];
  for (let day = 0; day < 10; day++) {
    const inBin = samples.filter((x) => x.ageDays >= day && x.ageDays < day + 1).map((x) => x.total).sort((a, b) => a - b);
    if (inBin.length < 20) continue;
    const q = (p) => inBin[Math.min(inBin.length - 1, Math.floor(p * inBin.length))];
    bins.push({ ageDays: [day, day + 1], n: inBin.length, median: q(0.5), p90: q(0.9), max: inBin.at(-1) });
  }
  const doc = {
    description: 'Error of NASA ISS ephemeris predictions vs later NASA ephemerides (within 1 day of their creation), by prediction age. km.',
    files: files.length,
    pairs: 'each older file vs every newer file, newer file used only within 1 day of its creation',
    from: files[0] && new Date(files[0].created).toISOString(),
    to: files.at(-1) && new Date(files.at(-1).created).toISOString(),
    bins,
  };
  await writeFile(OUT, JSON.stringify(doc, null, 1) + '\n');
  console.log('Prediction age | samples | median km | 90th percentile km | max km');
  for (const b of bins) console.log(`${b.ageDays[0]}-${b.ageDays[1]} days | ${b.n} | ${b.median.toFixed(2)} | ${b.p90.toFixed(2)} | ${b.max.toFixed(1)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
