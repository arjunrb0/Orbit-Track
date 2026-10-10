// "Across many element sets": the growing ISS accuracy study, built daily by
// scripts/accuracy-study.mjs (public/data/accuracy-study.json).
//
// One dot per archived ISS element set: its worst error within the chosen
// horizon, against NASA's trajectory. Hollow dots are provisional (the NASA
// data covering them was more than a few days old, so they'll be recomputed
// when fresher NASA files arrive).

import { MODEL_COLORS } from './accuracy-chart.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, text) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
};
const SERIES = [
  ['sgp4', 'SGP4'],
  ['j2', '+ J2'],
  ['drag', '+ J2 + drag'],
];
const fmtKm = (km) => (km == null ? '–' : km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString('en-GB')} km`);
// Element-set epochs are UTC; show their UTC date so it matches the data.
const fmtDate = (iso) => new Date(`${iso}Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function createStudyPanel(root, study) {
  const chartBox = root.querySelector('.study-chart');
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const colorOf = (key) => MODEL_COLORS[key] ?? css('--muted');
  let horizon = '1d';

  function renderText() {
    const s = study.summary[horizon];
    const n = study.records.filter((r) => r.horizons[horizon]).length;
    const first = study.records[0]?.epoch;
    root.querySelector('.study-count').textContent =
      `${plural(study.elementSets, 'ISS element set', 'ISS element sets')} since ${first ? fmtDate(first) : '–'} (UTC), ${plural(study.nasaFiles, 'NASA ephemeris', 'NASA ephemerides')}. ` +
      `${n} have NASA data reaching ${horizon.replace('d', horizon === '1d' ? ' day' : ' days')} past their epoch; ${s.n} of those are final.`;
    root.querySelector('.study-summary').textContent = s.n
      ? `Median of final results: SGP4 ${fmtKm(s.median.sgp4)}, + J2 ${fmtKm(s.median.j2)}, + J2 + drag ${fmtKm(s.median.drag)}. ` +
        `Closer than SGP4: + J2 in ${s.beatsSgp4.j2} of ${s.n}, + J2 + drag in ${s.beatsSgp4.drag} of ${s.n}.`
      : 'No final results at this horizon yet: they appear once NASA publishes ephemerides covering the full window.';
    const c = study.nasaConsistency;
    root.querySelector('.study-truth').textContent = c
      ? `How good is the reference? NASA's own predictions drift as they age: median ${c.slice(0, 3).map((b) => `${b.median.toFixed(0)} km at ${b.ageDays[0]}–${b.ageDays[1]} days`).join(', ')}` +
        ` (from ${c.reduce((a, b) => a + b.n, 0).toLocaleString('en-GB')} comparisons between NASA's archived files). That's why results use NASA data at most ${study.truthMaxAgeDays} days old.`
      : '';
  }

  function renderChart() {
    chartBox.innerHTML = '';
    const points = study.records.filter((r) => r.horizons[horizon]).map((r) => ({ t: Date.parse(`${r.epoch}Z`), h: r.horizons[horizon] }));
    const width = chartBox.clientWidth || 600, height = 180;
    const m = { top: 12, right: 16, bottom: 26, left: 64 };
    const w = width - m.left - m.right, h = height - m.top - m.bottom;
    const svg = svgEl('svg', { width, height, role: 'img', 'aria-label': `Worst ISS position error within ${horizon} for each element set` });
    if (!points.length) {
      svg.append(svgEl('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'acc-axis' }, 'No element sets with enough NASA data yet'));
      chartBox.append(svg);
      return;
    }
    const DAY = 86400e3;
    let t0 = Math.min(...points.map((p) => p.t)), t1 = Math.max(...points.map((p) => p.t));
    if (t1 - t0 < 4 * DAY) { const mid = (t0 + t1) / 2; t0 = mid - 2 * DAY; t1 = mid + 2 * DAY; }
    const vals = points.flatMap((p) => SERIES.map(([k]) => p.h[k]));
    const lo = Math.floor(Math.log10(Math.max(0.5, Math.min(...vals)))), hi = Math.ceil(Math.log10(Math.max(...vals)));
    const x = (t) => m.left + ((t - t0) / (t1 - t0)) * w;
    const y = (km) => m.top + h - ((Math.log10(Math.max(km, 10 ** lo)) - lo) / Math.max(1, hi - lo)) * h;
    for (let p = lo; p <= hi; p++) {
      svg.append(svgEl('line', { x1: m.left, x2: m.left + w, y1: y(10 ** p), y2: y(10 ** p), stroke: css('--grid') }));
      svg.append(svgEl('text', { x: m.left - 8, y: y(10 ** p) + 4, 'text-anchor': 'end', class: 'acc-axis' }, `${(10 ** p).toLocaleString('en-GB')} km`));
    }
    // Ticks on whole UTC days, spaced at least ~70 px apart.
    const pxPerDay = (w * DAY) / (t1 - t0);
    const stepDays = Math.max(1, Math.ceil(70 / pxPerDay));
    for (let t = Math.ceil(t0 / DAY) * DAY; t <= t1; t += stepDays * DAY) {
      svg.append(svgEl('text', { x: x(t), y: m.top + h + 18, 'text-anchor': 'middle', class: 'acc-axis' }, new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })));
    }
    SERIES.forEach(([key], k) => {
      const dx = (k - 1) * 5; // nudge the three models apart so dots don't hide each other
      for (const p of points) {
        const final = p.h.final;
        const dot = svgEl('circle', {
          cx: x(p.t) + dx, cy: y(p.h[key]), r: 4.5,
          fill: final ? colorOf(key) : css('--panel'), stroke: colorOf(key), 'stroke-width': 2,
        });
        dot.append(svgEl('title', {}, `${new Date(p.t).toUTCString().slice(5, 22)} UTC element set — ${SERIES[k][1]}: ${fmtKm(p.h[key])} (${final ? 'final' : `provisional: NASA data up to ${p.h.truthMaxAgeDays.toFixed(1)} days old`})`));
        svg.append(dot);
      }
    });
    chartBox.append(svg);
  }

  for (const btn of root.querySelectorAll('[data-horizon]')) {
    btn.addEventListener('click', () => {
      horizon = btn.dataset.horizon;
      for (const b of root.querySelectorAll('[data-horizon]')) b.classList.toggle('active', b === btn);
      renderText();
      renderChart();
    });
  }
  new ResizeObserver(renderChart).observe(chartBox);
  renderText();
  renderChart();
}
