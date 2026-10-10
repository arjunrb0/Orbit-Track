// Live 3D view of the orbits in the inertial (TEME) frame, drawn on a Canvas.
//
// Projection: orthographic. A world point is rotated by the camera's yaw
// (about z) and pitch (about x); then screen x = world x, screen up = world z,
// and world y is depth (positive = behind Earth's centre). A point is hidden
// when it's behind the centre AND inside Earth's disc on screen.
//
// Continents are fixed to the Earth, so to draw them in this inertial view
// they are rotated by GMST (Earth's rotation angle) at the displayed time.
// Sped up, you can watch Earth turn underneath orbits that stay put.

import { R_EARTH, TWO_PI } from '../orbit/constants.js';
import { rotateX, rotateZ, norm } from '../orbit/vec.js';
import { toKeplerian } from '../orbit/kepler.js';
import { gmst } from '../orbit/time.js';
import { landRings } from '../data/land.js';

const ORBIT_SAMPLES = 240;

export function createOrbitView(canvas, satellites, { getTime, onSelect, propagate }) {
  const ctx = canvas.getContext('2d');
  const state = {
    yaw: -0.6,
    pitch: 0.42,
    viewRadius: 10500, // km shown from centre to the shorter canvas edge
    targetViewRadius: 10500,
    selected: satellites[0]?.el.noradId ?? null,
    hover: null,
    screenPositions: [],
  };

  // Land outlines as Earth-fixed points on a sphere (flattening is invisible at this scale).
  const land = landRings().map((ring) =>
    ring.map(([lon, lat]) => {
      const la = lat * (Math.PI / 180), lo = lon * (Math.PI / 180);
      return [R_EARTH * Math.cos(la) * Math.cos(lo), R_EARTH * Math.cos(la) * Math.sin(lo), R_EARTH * Math.sin(la)];
    }),
  );

  // Orbit outlines: one period starting now. With pure Kepler the ellipse is
  // fixed; with J2 it slowly turns, so resample a few times a second.
  let lastPathReal = -Infinity;
  function computePaths(t) {
    for (const sat of satellites) {
      const periodMs = (TWO_PI / toKeplerian(sat.el).n) * 1000;
      sat.path = Array.from({ length: ORBIT_SAMPLES + 1 }, (_, k) =>
        propagate(sat.el, t + (periodMs * k) / ORBIT_SAMPLES).r,
      );
    }
  }

  // ---------------------------------------------------------------- sizing
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

  // ------------------------------------------------------------ projection
  const project = (p) => {
    const q = rotateX(rotateZ(p, state.yaw), state.pitch);
    const s = Math.min(width, height) / 2 / state.viewRadius;
    return { x: width / 2 + q[0] * s, y: height / 2 - q[2] * s, depth: q[1], rx: q[0], rz: q[2] };
  };
  const hidden = (pr) => pr.depth > 0 && Math.hypot(pr.rx, pr.rz) < R_EARTH;

  // ---------------------------------------------------------------- drawing
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function drawStars() {
    // Fixed pseudo-random starfield, rotated with the camera for a sense of depth.
    ctx.fillStyle = css('--star');
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 220; k++) {
      const lon = rand() * TWO_PI, z = rand() * 2 - 1, rr = Math.sqrt(1 - z * z);
      const dir = [rr * Math.cos(lon), rr * Math.sin(lon), z];
      const q = rotateX(rotateZ(dir, state.yaw), state.pitch);
      if (q[1] < 0) continue; // only the sky behind Earth
      const size = rand() < 0.1 ? 1.4 : 0.8;
      ctx.globalAlpha = 0.25 + rand() * 0.5;
      ctx.fillRect(width / 2 + q[0] * width * 0.6, height / 2 - q[2] * height * 0.6, size, size);
    }
    ctx.globalAlpha = 1;
  }

  function drawLand(t) {
    // Points on the far side are pushed out to the visible edge of the disc,
    // so a continent half way round the limb still fills correctly.
    const theta = gmst(t);
    const s = Math.min(width, height) / 2 / state.viewRadius;
    ctx.beginPath();
    for (const ring of land) {
      ring.forEach((p, k) => {
        const pr = project(rotateZ(p, theta));
        let { rx, rz } = pr;
        if (pr.depth > 0) {
          const f = R_EARTH / Math.hypot(rx, rz);
          rx *= f;
          rz *= f;
        }
        const x = width / 2 + rx * s, y = height / 2 - rz * s;
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath();
    }
    ctx.fillStyle = css('--globe-land');
    ctx.fill('evenodd');
  }

  function drawEarth(t) {
    const c = project([0, 0, 0]);
    const r = (Math.min(width, height) / 2) * (R_EARTH / state.viewRadius);
    const g = ctx.createRadialGradient(c.x - r * 0.35, c.y - r * 0.4, r * 0.1, c.x, c.y, r);
    g.addColorStop(0, css('--earth-light'));
    g.addColorStop(1, css('--earth-dark'));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, TWO_PI);
    ctx.fill();
    drawLand(t);

    // Graticule (Earth-fixed, so it turns with GMST too), front side only.
    const theta = gmst(t);
    ctx.strokeStyle = css('--grid');
    ctx.lineWidth = 1;
    const ring = (fn) => {
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k <= 96; k++) {
        const pr = project(rotateZ(fn((k / 96) * TWO_PI), theta));
        if (pr.depth > 0) { pen = false; continue; }
        pen ? ctx.lineTo(pr.x, pr.y) : ctx.moveTo(pr.x, pr.y);
        pen = true;
      }
      ctx.stroke();
    };
    for (const lat of [-60, -30, 0, 30, 60]) {
      const z = R_EARTH * Math.sin((lat * Math.PI) / 180);
      const rr = R_EARTH * Math.cos((lat * Math.PI) / 180);
      ring((t) => [rr * Math.cos(t), rr * Math.sin(t), z]);
    }
    for (let m = 0; m < 12; m++) {
      const lon = (m / 12) * TWO_PI;
      ring((t) => [R_EARTH * Math.cos(t) * Math.cos(lon), R_EARTH * Math.cos(t) * Math.sin(lon), R_EARTH * Math.sin(t)]);
    }
  }

  function drawAxes() {
    // Inertial x axis points at the vernal equinox; z at the north celestial pole.
    const len = R_EARTH * 1.6;
    ctx.font = '11px system-ui, sans-serif';
    for (const [vec, label] of [[[len, 0, 0], '♈ x'], [[0, 0, len], 'N']]) {
      const a = project(vec.map((v) => (v / len) * R_EARTH)), b = project(vec);
      ctx.strokeStyle = css('--axis');
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = css('--axis');
      ctx.fillText(label, b.x + 4, b.y - 4);
    }
  }

  function drawPath(sat, front) {
    const isSel = sat.el.noradId === state.selected;
    ctx.strokeStyle = sat.color;
    ctx.lineWidth = isSel ? 2.4 : 1.2;
    ctx.globalAlpha = front ? (isSel ? 0.95 : 0.55) : (isSel ? 0.3 : 0.14);
    ctx.beginPath();
    let pen = false;
    for (const p of sat.path) {
      const pr = project(p);
      if (hidden(pr) === front) { pen = false; continue; }
      pen ? ctx.lineTo(pr.x, pr.y) : ctx.moveTo(pr.x, pr.y);
      pen = true;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawSatellite(sat, t) {
    const { r } = propagate(sat.el, t);
    const pr = project(r);
    const isSel = sat.el.noradId === state.selected;
    const isHover = sat.el.noradId === state.hover;
    const behind = hidden(pr);
    state.screenPositions.push({ id: sat.el.noradId, x: pr.x, y: pr.y });

    ctx.globalAlpha = behind ? 0.35 : 1;
    if (isSel && !behind) {
      ctx.fillStyle = sat.color;
      ctx.globalAlpha = 0.25;
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, 11, 0, TWO_PI);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = sat.color;
    ctx.strokeStyle = css('--bg');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pr.x, pr.y, isSel || isHover ? 5.5 : 4, 0, TWO_PI);
    ctx.fill();
    ctx.stroke();
    // When zoomed out, low-orbit labels would pile up on Earth: only label the
    // selected/hovered one.
    const crowded = state.viewRadius > 25000 && norm(r) < 2 * R_EARTH;
    if (isSel || isHover || (!behind && !crowded)) {
      ctx.font = `${isSel ? 600 : 500} 12px system-ui, sans-serif`;
      ctx.fillStyle = css('--text');
      ctx.globalAlpha = behind ? 0.5 : isSel || isHover ? 1 : 0.75;
      ctx.fillText(sat.label, pr.x + 9, pr.y + 4);
    }
    ctx.globalAlpha = 1;
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!canvas.offsetParent) return; // hidden tab: skip drawing
    state.viewRadius += (state.targetViewRadius - state.viewRadius) * 0.15;
    const t = getTime();
    if (performance.now() - lastPathReal > 250) {
      computePaths(t);
      lastPathReal = performance.now();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    state.screenPositions = [];

    drawStars();
    for (const sat of satellites) drawPath(sat, false); // far side first
    drawEarth(t);
    drawAxes();
    for (const sat of satellites) drawPath(sat, true);
    const order = [...satellites].sort((a, b) => (a.el.noradId === state.selected) - (b.el.noradId === state.selected));
    for (const sat of order) drawSatellite(sat, t);
  }
  requestAnimationFrame(frame);

  // ---------------------------------------------------------- interaction
  const nearest = (x, y) => {
    let best = null, bestD = 14;
    for (const p of state.screenPositions) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { best = p.id; bestD = d; }
    }
    return best;
  };

  let drag = null;
  canvas.addEventListener('pointerdown', (ev) => {
    drag = { x: ev.clientX, y: ev.clientY, moved: false };
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointermove', (ev) => {
    const rect = canvas.getBoundingClientRect();
    if (drag) {
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      state.yaw += dx * 0.008;
      state.pitch = Math.max(-1.5, Math.min(1.5, state.pitch + dy * 0.008));
      drag.x = ev.clientX;
      drag.y = ev.clientY;
    } else {
      state.hover = nearest(ev.clientX - rect.left, ev.clientY - rect.top);
      canvas.style.cursor = state.hover ? 'pointer' : 'grab';
    }
  });
  canvas.addEventListener('pointerup', (ev) => {
    if (drag && !drag.moved) {
      const rect = canvas.getBoundingClientRect();
      const id = nearest(ev.clientX - rect.left, ev.clientY - rect.top);
      if (id) onSelect(id);
    }
    drag = null;
  });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    state.targetViewRadius = Math.max(7000, Math.min(60000, state.targetViewRadius * Math.exp(ev.deltaY * 0.001)));
  }, { passive: false });

  return {
    select(id) { state.selected = id; },
    zoomTo(radiusKm) { state.targetViewRadius = radiusKm; },
    refresh() { lastPathReal = -Infinity; },
  };
}
