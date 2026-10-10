// Reading NASA's ISS ephemeris files (CCSDS OEM, plain-text form).

export const NASA_ISS_OEM_CURRENT = 'https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt';
export const NASA_BUCKET = 'https://nasa-public-data.s3.amazonaws.com';

/**
 * Parse an OEM text file. Returns the header fields we rely on and the states
 * as [isoTimeZ, x, y, z, vx, vy, vz] (km, km/s), every `every`-th line.
 */
export function parseOem(text, every = 1) {
  const header = (key) => new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm').exec(text)?.[1].trim();
  const frame = header('REF_FRAME');
  const timeSystem = header('TIME_SYSTEM');
  if (frame !== 'EME2000' || timeSystem !== 'UTC') {
    throw new Error(`unexpected frame/time system: ${frame} / ${timeSystem}`);
  }
  const states = text.split('\n')
    .filter((line) => /^\d{4}-\d{2}-\d{2}T/.test(line))
    .map((line) => line.trim().split(/\s+/))
    .filter((_, k) => k % every === 0)
    .map(([time, ...nums]) => [
      `${time}Z`,
      ...nums.slice(0, 3).map((x) => Number(Number(x).toFixed(4))),
      ...nums.slice(3, 6).map((x) => Number(Number(x).toFixed(7))),
    ]);
  for (const [time, x, y, z] of states) {
    const r = Math.hypot(x, y, z);
    if (!(r > 6550 && r < 7000)) throw new Error(`implausible ISS radius ${r} km at ${time}`);
  }
  return { creationDate: `${header('CREATION_DATE')}Z`, frame, timeSystem, states };
}

/** List archived OEM files in NASA's bucket (dated folders), oldest first. */
export async function listArchivedOems(prefix = 'iss-coords/20') {
  const keys = [];
  let token = null;
  do {
    const url = `${NASA_BUCKET}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
    const xml = await (await fetch(url)).text();
    keys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).filter((k) => /\/ISS(_OEM|\.OEM_J2K_EPH)\/ISS\.OEM_J2K_EPH\.txt$/.test(k)));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)</.exec(xml)?.[1] : null;
  } while (token);
  return keys.sort();
}
