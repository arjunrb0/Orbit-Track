// Download current orbital elements from CelesTrak and save them to public/data/.
//
// Run with `npm run fetch-data`. The scheduled GitHub Action runs this once a
// day and commits the result, so the website reads a static file instead of
// hitting CelesTrak on every page load.
//
// We save both formats:
//   omm.json - the primary source the app uses (full precision, JSON)
//   tle.txt  - classic TLEs, kept for cross-checking and for satellite.js
//
// If any record fails validation, nothing is written and the script exits
// non-zero, so the Action fails loudly instead of committing bad data.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG } from '../src/data/catalog.js';
import { parseOmm, parseTleText, validateElements } from '../src/data/elements.js';
import { parseOem, NASA_ISS_OEM_CURRENT } from './lib/oem.mjs';

const BASE = 'https://celestrak.org/NORAD/elements/gp.php';
const OUT_DIR = fileURLToPath(new URL('../public/data/', import.meta.url));
const HEADERS = { 'User-Agent': 'satellite-pass-tracker (student project; daily fetch)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

async function fetchOne(noradId) {
  const ommText = await get(`${BASE}?CATNR=${noradId}&FORMAT=json`);
  await sleep(500); // be polite to a free service
  const tleText = await get(`${BASE}?CATNR=${noradId}&FORMAT=tle`);

  let records;
  try {
    records = JSON.parse(ommText);
  } catch {
    // CelesTrak answers with plain text such as "No GP data found" for unknown IDs.
    throw new Error(`CelesTrak returned non-JSON for ${noradId}: ${ommText.slice(0, 80)}`);
  }
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error(`Expected exactly one OMM record for ${noradId}, got ${records.length}`);
  }
  return { omm: records[0], tleText: tleText.trim() };
}

async function main() {
  const omms = [];
  const tles = [];
  const errors = [];

  for (const sat of CATALOG) {
    try {
      const { omm, tleText } = await fetchOne(sat.noradId);
      const fromOmm = parseOmm(omm);
      const [fromTle] = parseTleText(tleText);

      const problems = validateElements(fromOmm);
      if (problems.length) throw new Error(`invalid fields: ${problems.join(', ')}`);

      // Both downloads should be the same element set. If CelesTrak updated
      // between our two requests the epochs differ - flag it rather than mix them.
      if (Math.abs(fromOmm.epochMs - fromTle.epochMs) > 1) {
        throw new Error('OMM and TLE epochs differ; rerun the fetch');
      }

      omms.push(omm);
      tles.push(tleText);
      const ageDays = (Date.now() - fromOmm.epochMs) / 86_400_000;
      console.log(`ok   ${String(sat.noradId).padStart(5)}  ${fromOmm.name.padEnd(22)} epoch age ${ageDays.toFixed(2)} d`);
    } catch (err) {
      errors.push(`${sat.noradId} ${sat.name}: ${err.message}`);
      console.error(`FAIL ${sat.noradId} ${sat.name}: ${err.message}`);
    }
    await sleep(500);
  }

  if (errors.length) {
    console.error(`\n${errors.length} satellite(s) failed; not writing any files.`);
    process.exit(1);
  }

  const fetchedAt = new Date().toISOString();
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    join(OUT_DIR, 'omm.json'),
    JSON.stringify({ source: BASE, fetchedAt, satellites: omms }, null, 2) + '\n',
  );
  await writeFile(join(OUT_DIR, 'tle.txt'), tles.join('\n') + '\n');
  console.log(`\nWrote ${omms.length} satellites to public/data/ at ${fetchedAt}`);

  // NASA's own ISS trajectory, used in the app as an independent check on
  // both SGP4 and this project's propagators. Optional: if NASA's server is
  // unavailable, keep the previous file rather than failing the update.
  try {
    await fetchIssEphemeris();
  } catch (err) {
    console.warn(`NASA ISS ephemeris not updated: ${err.message}`);
  }
}

/** Download NASA's ISS OEM (EME2000, UTC), keep every 5th state (~20 min), save as JSON. */
async function fetchIssEphemeris() {
  const oem = parseOem(await get(NASA_ISS_OEM_CURRENT), 5);
  if (oem.states.length < 100) throw new Error(`only ${oem.states.length} states`);
  const doc = { source: NASA_ISS_OEM_CURRENT, creationDate: oem.creationDate.replace(/Z$/, ''), frame: oem.frame, timeSystem: oem.timeSystem, units: 'km, km/s', states: oem.states };
  await writeFile(join(OUT_DIR, 'iss-oem.json'), JSON.stringify(doc) + '\n');
  console.log(`Wrote NASA ISS ephemeris: ${oem.states.length} states, ${oem.states[0][0]} to ${oem.states.at(-1)[0]} (created ${doc.creationDate})`);
  return oem;
}
