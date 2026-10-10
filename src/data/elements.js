// Parsing orbital element sets (OMM JSON and TLE) into one common shape.
//
// Both formats describe the same thing: SGP4 "mean elements" at an epoch.
// Units are kept exactly as published (degrees, revolutions per day) and the
// unit is in every field name. Conversion to radians and SI units happens
// later, inside the propagator, so there's one obvious place to look for it.
//
// Common shape returned by parseOmm and parseTle:
// {
//   name, noradId, intlDesignator,
//   epochMs,               // UTC epoch, milliseconds since 1970-01-01 (may be fractional)
//   meanMotionRevPerDay,   // n
//   eccentricity,          // e (dimensionless)
//   inclinationDeg,        // i
//   raanDeg,               // Ω, right ascension of the ascending node
//   argPerigeeDeg,         // ω, argument of perigee
//   meanAnomalyDeg,        // M at epoch
//   bstar,                 // SGP4 drag term (1 / Earth radii)
//   meanMotionDotHalf,     // ṅ/2 in rev/day² (the TLE field is half the derivative; OMM copies it)
//   meanMotionDdotSixth,   // n̈/6 in rev/day³
//   revAtEpoch,
// }

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------- OMM (JSON)

/**
 * Parse an OMM epoch string such as "2026-10-09T19:42:49.139712" into UTC ms.
 *
 * Two traps here:
 *  1. The string has no "Z", and `new Date()` treats an ISO date-time without
 *     an offset as *local* time. For an observer in India that's a 5.5 hour
 *     error, roughly 2.4 orbits of the ISS.
 *  2. The fraction has microseconds, but Date only stores whole milliseconds.
 *     We keep the sub-millisecond part so the epoch isn't silently truncated.
 */
export function parseOmmEpoch(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z?$/.exec(text);
  if (!m) throw new Error(`Unrecognised OMM epoch: "${text}"`);
  const [, y, mo, d, h, mi, s, frac] = m;
  const wholeMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  return wholeMs + (frac ? parseFloat(frac) * 1000 : 0);
}

/** Convert one CelesTrak OMM JSON record into the common element shape. */
export function parseOmm(record) {
  return {
    name: record.OBJECT_NAME.trim(),
    noradId: Number(record.NORAD_CAT_ID),
    intlDesignator: record.OBJECT_ID,
    epochMs: parseOmmEpoch(record.EPOCH),
    meanMotionRevPerDay: Number(record.MEAN_MOTION),
    eccentricity: Number(record.ECCENTRICITY),
    inclinationDeg: Number(record.INCLINATION),
    raanDeg: Number(record.RA_OF_ASC_NODE),
    argPerigeeDeg: Number(record.ARG_OF_PERICENTER),
    meanAnomalyDeg: Number(record.MEAN_ANOMALY),
    bstar: Number(record.BSTAR),
    meanMotionDotHalf: Number(record.MEAN_MOTION_DOT),
    meanMotionDdotSixth: Number(record.MEAN_MOTION_DDOT),
    revAtEpoch: Number(record.REV_AT_EPOCH),
  };
}

// ----------------------------------------------------------------------- TLE

/**
 * TLE checksum: add up every digit on the line (first 68 characters), count
 * each minus sign as 1, ignore everything else, and take the result mod 10.
 * It catches single-character transmission errors - a relic of punched cards.
 */
export function tleChecksum(line) {
  let sum = 0;
  for (const ch of line.slice(0, 68)) {
    if (ch >= '0' && ch <= '9') sum += ch.charCodeAt(0) - 48;
    else if (ch === '-') sum += 1;
  }
  return sum % 10;
}

/**
 * Parse TLE "implied decimal with exponent" notation, e.g.
 *   " 12652-3" -> 0.12652e-3,  "-11606-4" -> -0.11606e-4,  " 00000+0" -> 0
 */
export function parseImpliedExponent(field) {
  const s = field.trim();
  if (s === '' || /^[+-]?0+[+-]0$/.test(s)) return 0;
  const m = /^([+-]?)(\d+)([+-]\d)$/.exec(s);
  if (!m) throw new Error(`Bad TLE exponent field: "${field}"`);
  const [, sign, mantissa, exp] = m;
  return Number(`${sign}0.${mantissa}e${exp}`);
}

/** TLE epochs are "YYDDD.DDDDDDDD": two-digit year, then fractional day-of-year (Jan 1 00:00 = day 1.0). */
export function parseTleEpoch(field) {
  const yy = Number(field.slice(0, 2));
  const dayOfYear = Number(field.slice(2));
  const year = yy < 57 ? 2000 + yy : 1900 + yy; // Sputnik launched in 1957
  return Date.UTC(year, 0, 1) + (dayOfYear - 1) * MS_PER_DAY;
}

// Column positions are fixed. These are 0-indexed [start, end) slices of the
// official 1-indexed columns, e.g. line 2 inclination is columns 9-16.
const col = (line, start1, end1) => line.slice(start1 - 1, end1);

/** Parse a name line plus the two 69-character TLE lines into the common element shape. */
export function parseTle(name, line1, line2) {
  for (const [n, line] of [[1, line1], [2, line2]]) {
    if (line.length < 69 || line[0] !== String(n)) throw new Error(`TLE line ${n} is malformed`);
    const expected = Number(line[68]);
    if (tleChecksum(line) !== expected) throw new Error(`TLE line ${n} checksum mismatch`);
  }
  const id1 = Number(col(line1, 3, 7));
  const id2 = Number(col(line2, 3, 7));
  if (id1 !== id2) throw new Error(`TLE lines refer to different satellites (${id1} vs ${id2})`);

  // International designator "98067A" -> "1998-067A"
  const desig = col(line1, 10, 17).trim();
  const yy = Number(desig.slice(0, 2));
  const intlDesignator = desig ? `${yy < 57 ? 2000 + yy : 1900 + yy}-${desig.slice(2)}` : '';

  return {
    name: (name ?? '').trim(),
    noradId: id1,
    intlDesignator,
    epochMs: parseTleEpoch(col(line1, 19, 32)),
    meanMotionRevPerDay: Number(col(line2, 53, 63)),
    eccentricity: Number(`0.${col(line2, 27, 33).trim()}`), // leading "0." is implied
    inclinationDeg: Number(col(line2, 9, 16)),
    raanDeg: Number(col(line2, 18, 25)),
    argPerigeeDeg: Number(col(line2, 35, 42)),
    meanAnomalyDeg: Number(col(line2, 44, 51)),
    bstar: parseImpliedExponent(col(line1, 54, 61)),
    meanMotionDotHalf: Number(col(line1, 34, 43)),
    meanMotionDdotSixth: parseImpliedExponent(col(line1, 45, 52)),
    revAtEpoch: Number(col(line2, 64, 68)),
  };
}

/** Split a block of 3-line TLE text (name, line 1, line 2, ...) into parsed elements. */
export function parseTleText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
  if (lines.length % 3 !== 0) throw new Error('Expected TLE text in 3-line (name + 2 lines) groups');
  const out = [];
  for (let i = 0; i < lines.length; i += 3) out.push(parseTle(lines[i], lines[i + 1], lines[i + 2]));
  return out;
}

// ---------------------------------------------------------------- validation

/**
 * Sanity-check parsed elements. Returns a list of problems (empty = OK).
 * Used by the daily fetch so that bad data never gets committed.
 */
export function validateElements(el) {
  const problems = [];
  const angle = (v) => Number.isFinite(v) && v >= 0 && v < 360;
  if (!Number.isInteger(el.noradId) || el.noradId <= 0) problems.push('noradId');
  if (!Number.isFinite(el.epochMs)) problems.push('epoch');
  // A satellite below ~100 km can't complete an orbit, which caps n at about 16.5 rev/day.
  if (!(el.meanMotionRevPerDay > 0 && el.meanMotionRevPerDay < 17)) problems.push('meanMotion');
  if (!(el.eccentricity >= 0 && el.eccentricity < 1)) problems.push('eccentricity');
  if (!(el.inclinationDeg >= 0 && el.inclinationDeg <= 180)) problems.push('inclination');
  if (!angle(el.raanDeg)) problems.push('raan');
  if (!angle(el.argPerigeeDeg)) problems.push('argPerigee');
  if (!angle(el.meanAnomalyDeg)) problems.push('meanAnomaly');
  if (!Number.isFinite(el.bstar)) problems.push('bstar');
  return problems;
}

/** Age of an element set in days at a given time. Accuracy degrades as this grows. */
export function epochAgeDays(el, nowMs = Date.now()) {
  return (nowMs - el.epochMs) / MS_PER_DAY;
}
