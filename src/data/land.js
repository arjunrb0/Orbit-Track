// World coastlines from Natural Earth (public domain), via the world-atlas
// package, which stores them as TopoJSON.
//
// TopoJSON saves space by storing each shared boundary ("arc") once, as
// integer coordinates that are delta-encoded (each point is the change from
// the previous one) and quantised by a scale/translate transform. Polygons
// are then lists of arc indices; a negative index ~k means "arc k reversed".
// This decoder turns that back into plain rings of [lonDeg, latDeg].

import topology from 'world-atlas/land-110m.json' with { type: 'json' };

function decodeArcs({ arcs, transform }) {
  const [sx, sy] = transform.scale;
  const [tx, ty] = transform.translate;
  return arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty];
    });
  });
}

function ringFromArcs(indices, arcs) {
  const ring = [];
  for (const index of indices) {
    const arc = index >= 0 ? arcs[index] : arcs[~index].slice().reverse();
    // Consecutive arcs share their joining point; don't repeat it.
    ring.push(...(ring.length ? arc.slice(1) : arc));
  }
  return ring;
}

/** @returns {number[][][]} list of rings, each a list of [lonDeg, latDeg] */
export function landRings() {
  const arcs = decodeArcs(topology);
  const rings = [];
  for (const geom of topology.objects.land.geometries) {
    const polygons = geom.type === 'Polygon' ? [geom.arcs] : geom.arcs;
    for (const polygon of polygons) for (const ring of polygon) rings.push(ringFromArcs(ring, arcs));
  }
  return rings;
}
