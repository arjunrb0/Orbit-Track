// The satellites this app tracks, chosen to cover a range of orbit types.
// NORAD catalogue IDs verified against CelesTrak on 2026-10-10.
//
// The mix is deliberate: low orbits at different inclinations (where drag and
// J2 matter most), plus two ISRO satellites at geosynchronous altitude, which
// will be useful for the low-vs-high orbit comparison later.

export const CATALOG = [
  { noradId: 25544, name: 'ISS (ZARYA)', operator: 'International', orbit: 'LEO, 51.6°' },
  { noradId: 44804, name: 'CARTOSAT-3', operator: 'ISRO', orbit: 'LEO, sun-synchronous' },
  { noradId: 51656, name: 'EOS-04', operator: 'ISRO', orbit: 'LEO, sun-synchronous' },
  { noradId: 54361, name: 'EOS-06 (OCEANSAT-3)', operator: 'ISRO', orbit: 'LEO, sun-synchronous' },
  { noradId: 44233, name: 'RISAT-2B', operator: 'ISRO', orbit: 'LEO, 37°' },
  { noradId: 40930, name: 'ASTROSAT', operator: 'ISRO', orbit: 'LEO, 6° (near-equatorial)' },
  { noradId: 41752, name: 'INSAT-3DR', operator: 'ISRO', orbit: 'GEO' },
  { noradId: 43286, name: 'IRNSS-1I (NavIC)', operator: 'ISRO', orbit: 'Inclined geosynchronous, 29°' },
];
