// "How far does the propagator drift from SGP4?" chart for one satellite.
//
// Log-scale y axis because the two models differ by 100x after a day: on a
// linear axis the J2 line would be flat along the bottom.
//
// The raw error rises and falls within every orbit (~90 min for low orbits),
// which reads as noise at this scale. So each plotted point is the worst error
// within a 2-hour window: the same "worst case" measure as the summary tiles.

import { errorSeries, summarise, MODELS } from '../analysis/compare.js';

const DAY = 86400e3;
const SAMPLE_MS = 5 * 60e3;
const WINDOW_MS = 2 * 3600e3;
const HORIZONS = [3600e3, DAY, 7 * DAY];
const HORIZON_LABELS = ['After 1 hour', 'After 1 day', 'After 1 week'];
// Validated (dataviz palette checker) on the dark panel surface: lightness band,
// colour-blind separation and contrast all pass.
export const MODEL_COLORS = { kepler: '#dd6a35', j2: '#2f94d0' };

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, text) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
};
const fmtKm = (km) => (km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString('en-GB')} km`);

/** Worst error per window, per model. Plotted at the window's end time; t = 0 kept as the epoch error. */
function windowMax(raw) {
  const out = [raw[0]];
  for (let end = WINDOW_MS; end <= raw.at(-1).t; end += WINDOW_MS) {
    const rows = raw.filter((r) => r.t > end - WINDOW_MS && r.t <= end);
    const point = { t: end };
    for (const key of Object.keys(MODELS)) {
      point[key] = rows.reduce((a, b) => (b[key].total > a[key].total ? b : a))[key];
    }
    out.push(point);
  }
  return out;
}

export function createAccuracyChart(root) {
  const chartBox = root.querySelector('.acc-chart');
  const tiles = root.querySelector('.acc-tiles');
  const tooltip = root.querySelector('.acc-tooltip');
  let current = null; // { series, name }

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function renderTiles(summary) {
    tiles.innerHTML = '';
    summary.forEach((row, k) => {
      const tile = document.createElement('div');
      tile.className = 'acc-tile';
      const factor = row.kepler / row.j2;
      tile.innerHTML = `
        <div class="acc-tile-label">${HORIZON_LABELS[k]}</div>
        <div class="acc-tile-row"><span class="swatch" style="background:${MODEL_COLORS.kepler}"></span>Kepler<b>${fmtKm(row.kepler)}</b></div>
        <div class="acc-tile-row"><span class="swatch" style="background:${MODEL_COLORS.j2}"></span>+ J2<b>${fmtKm(row.j2)}</b></div>
        <div class="acc-tile-note">${factor >= 1.5 ? `J2 is ${factor >= 10 ? Math.round(factor) : factor.toFixed(1)}× closer` : factor <= 1 / 1.5 ? 'J2 is worse here' : 'about the same'}</div>`;
      tiles.append(tile);
    });
  }

  function renderChart() {
    if (!current) return;
    const { series } = current;
    const width = chartBox.clientWidth;
    const height = 240;
    const m = { top: 14, right: 118, bottom: 30, left: 74 };
    const w = Math.max(50, width - m.left - m.right);
    const h = height - m.top - m.bottom;

    const values = series.flatMap((r) => [r.kepler.total, r.j2.total]).filter((v) => v > 0);
    const lo = Math.floor(Math.log10(Math.max(0.1, Math.min(...values))));
    const hi = Math.ceil(Math.log10(Math.max(...values)));
    const maxT = series.at(-1).t;
    const x = (t) => m.left + (t / maxT) * w;
    const y = (km) => m.top + h - ((Math.log10(Math.max(km, 10 ** lo)) - lo) / (hi - lo)) * h;

    const svg = svgEl('svg', { width, height, role: 'img', 'aria-label': `Position error versus SGP4 over 7 days for ${current.name}` });
    // Gridlines and y labels at each power of ten (recessive)
    for (let p = lo; p <= hi; p++) {
      svg.append(svgEl('line', { x1: m.left, x2: m.left + w, y1: y(10 ** p), y2: y(10 ** p), stroke: css('--grid'), 'stroke-width': 1 }));
      const label = 10 ** p >= 1 ? `${(10 ** p).toLocaleString('en-GB')} km` : `${10 ** p} km`;
      svg.append(svgEl('text', { x: m.left - 8, y: y(10 ** p) + 4, 'text-anchor': 'end', class: 'acc-axis' }, label));
    }
    for (let d = 0; d <= Math.round(maxT / DAY); d++) {
      svg.append(svgEl('text', { x: x(d * DAY), y: m.top + h + 20, 'text-anchor': 'middle', class: 'acc-axis' }, d === 0 ? 'epoch' : `day ${d}`));
    }
    // Lines
    for (const key of Object.keys(MODELS)) {
      const d = series.map((r, k) => `${k ? 'L' : 'M'}${x(r.t).toFixed(1)},${y(r[key].total).toFixed(1)}`).join('');
      svg.append(svgEl('path', { d, fill: 'none', stroke: MODEL_COLORS[key], 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    }
    // Direct labels at the right end, in text ink with a coloured dot for identity
    const ends = Object.keys(MODELS).map((key) => ({ key, v: series.at(-1)[key].total }));
    ends.sort((a, b) => b.v - a.v);
    let lastY = -Infinity;
    for (const { key, v } of ends) {
      const ly = Math.max(y(v), lastY + 30);
      lastY = ly;
      svg.append(svgEl('circle', { cx: x(maxT), cy: y(v), r: 4, fill: MODEL_COLORS[key], stroke: css('--panel'), 'stroke-width': 2 }));
      svg.append(svgEl('text', { x: x(maxT) + 10, y: ly - 2, class: 'acc-end-label' }, key === 'kepler' ? 'Kepler' : 'Kepler + J2'));
      svg.append(svgEl('text', { x: x(maxT) + 10, y: ly + 12, class: 'acc-end-value' }, fmtKm(v)));
    }
    // Hover layer: crosshair + tooltip
    const cross = svgEl('line', { y1: m.top, y2: m.top + h, stroke: css('--axis'), 'stroke-width': 1, visibility: 'hidden' });
    const dots = Object.keys(MODELS).map((key) => svgEl('circle', { r: 4.5, fill: MODEL_COLORS[key], stroke: css('--panel'), 'stroke-width': 2, visibility: 'hidden' }));
    svg.append(cross, ...dots);
    const hit = svgEl('rect', { x: m.left, y: m.top, width: w, height: h, fill: 'transparent' });
    svg.append(hit);
    hit.addEventListener('pointermove', (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const t = Math.min(maxT, Math.max(0, ((px - m.left) / w) * maxT));
      const row = series.reduce((best, r) => (Math.abs(r.t - t) < Math.abs(best.t - t) ? r : best));
      const cx = x(row.t);
      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      cross.setAttribute('visibility', 'visible');
      Object.keys(MODELS).forEach((key, k) => {
        dots[k].setAttribute('cx', cx);
        dots[k].setAttribute('cy', y(row[key].total));
        dots[k].setAttribute('visibility', 'visible');
      });
      const hours = row.t / 3600e3;
      const when = (hrs) => (hrs < 48 ? `${hrs.toFixed(0)} h` : `${(hrs / 24).toFixed(1)} days`);
      tooltip.innerHTML = `<div class="acc-tt-time">${row.t === 0 ? 'At epoch' : `Worst error, ${when(Math.max(0, hours - 2))}–${when(hours)} after epoch`}</div>
        ${Object.keys(MODELS).map((key) => `<div class="acc-tt-row"><span class="swatch" style="background:${MODEL_COLORS[key]}"></span>${MODELS[key].label}<b>${fmtKm(row[key].total)}</b></div>`).join('')}
        <div class="acc-tt-sub">J2 error: along-track ${fmtKm(Math.abs(row.j2.along))}, cross-track ${fmtKm(Math.abs(row.j2.cross))}</div>`;
      tooltip.hidden = false;
      const boxRect = chartBox.getBoundingClientRect();
      const left = Math.min(cx + 14, boxRect.width - tooltip.offsetWidth - 4);
      tooltip.style.left = `${cx + 14 + tooltip.offsetWidth > boxRect.width ? cx - tooltip.offsetWidth - 14 : left}px`;
      tooltip.style.top = `${m.top}px`;
    });
    hit.addEventListener('pointerleave', () => {
      cross.setAttribute('visibility', 'hidden');
      dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
      tooltip.hidden = true;
    });

    chartBox.querySelector('svg')?.remove();
    chartBox.prepend(svg);
  }

  new ResizeObserver(renderChart).observe(chartBox);

  return {
    show(sat) {
      const raw = errorSeries(sat.el, sat.omm, 7 * DAY, SAMPLE_MS);
      current = { series: windowMax(raw), name: sat.label };
      root.querySelector('.acc-name').textContent = sat.label;
      renderTiles(summarise(raw, HORIZONS));
      renderChart();
    },
  };
}
