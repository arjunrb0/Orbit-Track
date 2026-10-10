// World map with ground tracks, drawn on a Canvas.
//
// Projection: equirectangular (longitude -> x, latitude -> y, both linear).
// Simple, and it makes ground tracks easy to read: a satellite's maximum
// latitude equals its inclination, and each orbit shifts west by the angle
// Earth turns during one period.
//
// A ground track is where the satellite is directly overhead over time:
// propagate in TEME -> rotate to Earth-fixed by GMST -> geodetic lat/lon.

import { DEG, R_EARTH, TWO_PI } from '../orbit/constants.js';
import { toKeplerian } from '../orbit/kepler.js';
import { subSatellitePoint, temeToEcef } from '../orbit/frames.js';
import { sunPosition } from '../orbit/sun.js';
import { landRings } from '../data/land.js';

const TRACK_SAMPLES = 360;
const TRACK_REFRESH_MS = 200; // recompute tracks at most this often (real time)

export function createMapView(canvas, satellites, { getTime, getObserver, onSelect, propagate }) {
  const ctx = canvas.getContext('2d');
  const land = landRings();
  const state = { highlight: null, selected: null, hover: null, screenPositions: [], tracks: new Map(), lastTrackReal: -Infinity };

  for (const sat of satellites) sat.periodMs = (TWO_PI / toKeplerian(sat.el).n) * 1000;

  let width = 0, height = 0, dpr = 1;
  const resize = () => {
    dpr = window.devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  // Fit a 2:1 map inside the canvas.
  const box = () => {
    const w = Math.min(width, height * 2);
    return { x0: (width - w) / 2, y0: (height - w / 2) / 2, w, h: w / 2 };
  };
  const toXY = (lonDeg, latDeg, b) => [b.x0 + ((lonDeg + 180) / 360) * b.w, b.y0 + ((90 - latDeg) / 180) * b.h];
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Polyline in lon/lat, broken wherever it wraps across the 180 deg meridian.
  function polyline(points, b) {
    ctx.beginPath();
    let prevLon = null;
    for (const [lon, lat] of points) {
      const [x, y] = toXY(lon, lat, b);
      if (prevLon === null || Math.abs(lon - prevLon) > 180) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      prevLon = lon;
    }
    ctx.stroke();
  }

  function computeTracks(t) {
    for (const sat of satellites) {
      const isSel = sat.el.noradId === state.selected;
      // Selected: half an orbit behind, 1.5 ahead. Others: one orbit ahead.
      // High orbits (period ~1 day) get one full period, which shows the
      // figure-of-eight of an inclined geosynchronous satellite.
      const leo = sat.periodMs < 4 * 3600e3;
      const back = isSel && leo ? 0.5 : 0;
      const ahead = leo ? (isSel ? 1.5 : 1) : 1;
      const pts = [];
      for (let k = 0; k <= TRACK_SAMPLES; k++) {
        const tk = t + sat.periodMs * (-back + ((back + ahead) * k) / TRACK_SAMPLES);
        const p = subSatellitePoint(propagate(sat.el, tk).r, tk);
        pts.push([p.lonDeg, p.latDeg, tk]);
      }
      state.tracks.set(sat.el.noradId, pts);
    }
  }

  // Region of Earth that can see the satellite (elevation > 0): a circle of
  // angular radius acos(R / (R + h)) around the sub-satellite point.
  function footprint(latDeg, lonDeg, heightKm) {
    const rho = Math.acos(R_EARTH / (R_EARTH + heightKm));
    const lat1 = latDeg * DEG, lon1 = lonDeg * DEG;
    const pts = [];
    for (let k = 0; k <= 120; k++) {
      const bearing = (k / 120) * TWO_PI;
      const lat2 = Math.asin(Math.sin(lat1) * Math.cos(rho) + Math.cos(lat1) * Math.sin(rho) * Math.cos(bearing));
      const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(rho) * Math.cos(lat1), Math.cos(rho) - Math.sin(lat1) * Math.sin(lat2));
      pts.push([((((lon2 / DEG + 180) % 360) + 360) % 360) - 180, lat2 / DEG]);
    }
    return pts;
  }

  function drawBase(b) {
    ctx.fillStyle = css('--ocean');
    ctx.fillRect(b.x0, b.y0, b.w, b.h);
    // Graticule
    ctx.strokeStyle = css('--grid');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let lon = -180; lon <= 180; lon += 30) {
      const [x] = toXY(lon, 0, b);
      ctx.moveTo(x, b.y0);
      ctx.lineTo(x, b.y0 + b.h);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const [, y] = toXY(0, lat, b);
      ctx.moveTo(b.x0, y);
      ctx.lineTo(b.x0 + b.w, y);
    }
    ctx.stroke();
    // Land
    ctx.fillStyle = css('--land');
    ctx.strokeStyle = css('--coast');
    ctx.beginPath();
    for (const ring of land) {
      ring.forEach(([lon, lat], k) => {
        const [x, y] = toXY(lon, lat, b);
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath();
    }
    ctx.fill('evenodd');
    ctx.stroke();
    // Equator, slightly stronger
    ctx.strokeStyle = css('--axis');
    ctx.setLineDash([2, 4]);
    polyline([[-180, 0], [180, 0]], b);
    ctx.setLineDash([]);
  }

  // Night side: everything more than 90 deg from the point where the Sun is
  // overhead. The boundary (terminator) is a great circle, so for each
  // longitude its latitude is  tan(lat) = -cos(lon - lonSun) / tan(decSun).
  function drawNight(b, t) {
    const s = temeToEcef(sunPosition(t), t);
    const lonSun = Math.atan2(s[1], s[0]);
    let dec = Math.asin(s[2] / Math.hypot(...s));
    if (Math.abs(dec) < 1e-4) dec = 1e-4 * Math.sign(dec || 1); // equinox: avoid dividing by ~0
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 2) {
      pts.push(toXY(lon, Math.atan(-Math.cos(lon * DEG - lonSun) / Math.tan(dec)) / DEG, b));
    }
    // With the Sun north of the equator the south pole is in night, and vice versa.
    const poleY = dec > 0 ? b.y0 + b.h : b.y0;
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.lineTo(b.x0 + b.w, poleY);
    ctx.lineTo(b.x0, poleY);
    ctx.closePath();
    ctx.fillStyle = css('--night');
    ctx.fill();
    // Sun marker at the sub-solar point
    const [sx, sy] = toXY(lonSun / DEG, dec / DEG, b);
    ctx.fillStyle = '#ffd166';
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, TWO_PI);
    ctx.fill();
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TWO_PI;
      ctx.moveTo(sx + 8 * Math.cos(a), sy + 8 * Math.sin(a));
      ctx.lineTo(sx + 11 * Math.cos(a), sy + 11 * Math.sin(a));
    }
    ctx.stroke();
  }

  function drawObserver(b) {
    const obs = getObserver();
    if (!obs) return;
    const [x, y] = toXY(obs.lon / DEG, obs.lat / DEG, b);
    ctx.strokeStyle = css('--text');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y);
    ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, TWO_PI);
    ctx.stroke();
  }

  // The chosen pass from the pass list: the part of the ground track during
  // which the satellite is above the observer's horizon.
  function drawHighlight(b) {
    const h = state.highlight;
    if (!h || h.sat.el.noradId !== state.selected) return;
    const { rise, set } = h.pass;
    if (!h.points) {
      h.points = [];
      for (let t = rise.t; t <= set.t + 1; t += Math.max(5e3, (set.t - rise.t) / 120)) {
        const p = subSatellitePoint(propagate(h.sat.el, t).r, t);
        h.points.push([p.lonDeg, p.latDeg]);
      }
    }
    ctx.lineCap = 'round';
    ctx.strokeStyle = css('--bg');
    ctx.lineWidth = 7;
    polyline(h.points, b);
    ctx.strokeStyle = css('--text');
    ctx.lineWidth = 3.5;
    polyline(h.points, b);
    ctx.lineCap = 'butt';
    const [first, last] = [h.points[0], h.points.at(-1)];
    ctx.font = '600 11px system-ui, sans-serif';
    for (const [pt, label] of [[first, 'rise'], [last, 'set']]) {
      const [x, y] = toXY(pt[0], pt[1], b);
      ctx.fillStyle = css('--text');
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, TWO_PI);
      ctx.fill();
      ctx.fillStyle = css('--text');
      ctx.fillText(label, x + 6, y + 12);
    }
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!canvas.offsetParent) return; // hidden tab: skip drawing
    const t = getTime();
    const now = performance.now();
    if (now - state.lastTrackReal > TRACK_REFRESH_MS) {
      computeTracks(t);
      state.lastTrackReal = now;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const b = box();
    drawBase(b);
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x0, b.y0, b.w, b.h);
    ctx.clip();
    drawNight(b, t);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x0, b.y0, b.w, b.h);
    ctx.clip();

    // Tracks: unselected first, faint; selected on top, past part dashed.
    const ordered = [...satellites].sort((a, c) => (a.el.noradId === state.selected) - (c.el.noradId === state.selected));
    for (const sat of ordered) {
      const pts = state.tracks.get(sat.el.noradId);
      if (!pts) continue;
      const isSel = sat.el.noradId === state.selected;
      ctx.strokeStyle = sat.color;
      ctx.lineWidth = isSel ? 2 : 1;
      ctx.globalAlpha = isSel ? 0.95 : 0.3;
      const past = pts.filter((p) => p[2] <= t), future = pts.filter((p) => p[2] >= t);
      if (past.length > 1) {
        ctx.setLineDash([4, 4]);
        ctx.globalAlpha = 0.5;
        polyline(past, b);
        ctx.setLineDash([]);
        ctx.globalAlpha = isSel ? 0.95 : 0.3;
      }
      polyline(future, b);
    }
    ctx.globalAlpha = 1;

    // Satellites and the selected one's visibility footprint
    state.screenPositions = [];
    for (const sat of ordered) {
      const p = subSatellitePoint(propagate(sat.el, t).r, t);
      const [x, y] = toXY(p.lonDeg, p.latDeg, b);
      const isSel = sat.el.noradId === state.selected;
      const isHover = sat.el.noradId === state.hover;
      state.screenPositions.push({ id: sat.el.noradId, x, y });
      if (isSel) {
        ctx.strokeStyle = sat.color;
        ctx.fillStyle = sat.color;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.7;
        ctx.setLineDash([3, 3]);
        polyline(footprint(p.latDeg, p.lonDeg, p.height), b);
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.22;
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, TWO_PI);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = sat.color;
      ctx.strokeStyle = css('--bg');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, isSel || isHover ? 5.5 : 4, 0, TWO_PI);
      ctx.fill();
      ctx.stroke();
      if (isSel || isHover || b.w > 700) {
        ctx.font = `${isSel ? 600 : 500} 12px system-ui, sans-serif`;
        ctx.fillStyle = css('--text');
        ctx.globalAlpha = isSel || isHover ? 1 : 0.7;
        ctx.fillText(sat.label, x + 8, y - 7);
        ctx.globalAlpha = 1;
      }
    }
    drawHighlight(b);
    drawObserver(b);
    ctx.restore();
  }
  requestAnimationFrame(frame);

  // ------------------------------------------------------------ interaction
  const nearest = (x, y) => {
    let best = null, bestD = 14;
    for (const p of state.screenPositions) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { best = p.id; bestD = d; }
    }
    return best;
  };
  canvas.addEventListener('pointermove', (ev) => {
    const r = canvas.getBoundingClientRect();
    state.hover = nearest(ev.clientX - r.left, ev.clientY - r.top);
    canvas.style.cursor = state.hover ? 'pointer' : 'default';
  });
  canvas.addEventListener('click', (ev) => {
    const r = canvas.getBoundingClientRect();
    const id = nearest(ev.clientX - r.left, ev.clientY - r.top);
    if (id) onSelect(id);
  });

  return {
    select(id) {
      state.selected = id;
      state.lastTrackReal = -Infinity; // selected track spans differ; recompute
    },
    refresh() { state.lastTrackReal = -Infinity; },
    highlightPass(choice) { state.highlight = choice ? { ...choice } : null; },
  };
}
