import { test } from 'node:test';
import assert from 'node:assert/strict';
import { landRings } from '../src/data/land.js';

// Point-in-polygon by ray casting, to check the decoded coastlines are in the right place.
const inside = ([x, y], ring) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};
const onLand = (lonLat, rings) => rings.filter((r) => inside(lonLat, r)).length % 2 === 1;

test('decoded coastlines put cities on land and oceans on water', () => {
  const rings = landRings();
  assert.ok(rings.length > 100);
  for (const r of rings) for (const [lon, lat] of r) assert.ok(Math.abs(lon) <= 180 && Math.abs(lat) <= 90);
  assert.ok(onLand([77.59, 12.97], rings), 'Bengaluru');
  assert.ok(onLand([-0.13, 51.51], rings), 'London');
  assert.ok(onLand([-74.0, 40.7], rings) || onLand([-74.2, 40.8], rings), 'New York');
  assert.ok(!onLand([-30, 0], rings), 'mid-Atlantic');
  assert.ok(!onLand([80, -10], rings), 'Indian Ocean');
  assert.ok(!onLand([-150, 20], rings), 'Pacific');
});
