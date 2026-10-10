// Pass list + sky plot for the selected satellite.
//
// Sky plot: a polar chart of the sky as seen from the observer. The centre is
// straight up (zenith), the outer ring is the horizon, and the distance from
// the centre is 90 - elevation. North is at the top and east to the right,
// like a map. (Star charts held overhead put east on the left; this one is
// meant to be read like a map of the sky's directions.)

import { findPasses, passVisibility, lookAt, compass16 } from '../passes/passes.js';
import { DEG } from '../orbit/constants.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, text) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
};

const tzName = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
  .formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? '';
export const fmtTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fmtDay = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDuration = (s) => `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;

const SEARCH_DAYS = 7;
const VIS_LABEL = { visible: 'Visible', daylight: 'Daylight', unlit: 'In shadow' };
const VIS_HELP = {
  visible: 'Sunlit against a dark sky: you can see it with the naked eye',
  daylight: 'Not visible: the sky is too bright',
  unlit: "Not visible: the sky is dark but the satellite is in Earth's shadow",
};
const RECOMPUTE_AFTER_MS = 30 * 60e3; // simulated time

export function createPassPanel(root, { getTime, getObserver, getPropagate, getMinElevation, onChoose = () => {} }) {
  const list = root.querySelector('.pass-list tbody');
  const statusEl = root.querySelector('.pass-status');
  const sky = root.querySelector('.sky');
  const skyCaption = root.querySelector('.sky-caption');
  const countdown = root.querySelector('.pass-countdown');
  root.querySelector('.tz').textContent = tzName;

  let sat = null;
  let result = null;
  let computedAt = -Infinity;
  let chosen = null; // index (into `shown`) of the pass in the sky plot
  let shown = []; // passes after the "visible only" filter
  let visibleOnly = false;
  let liveDot = null;
  let skySize = 0;

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function compute() {
    const now = getTime();
    computedAt = now;
    result = findPasses(sat.el, getObserver(), {
      start: now,
      end: now + SEARCH_DAYS * 86400e3,
      minElevationDeg: getMinElevation(),
      propagate: getPropagate(),
    });
    // Label every pass: visible / daylight / in Earth's shadow.
    for (const p of result.passes) p.vis = passVisibility(sat.el, getObserver(), p, getPropagate(), 5e3);
    applyFilter();
  }

  function applyFilter() {
    shown = visibleOnly ? result.passes.filter((p) => p.vis.type === 'visible') : result.passes;
    chosen = shown.length ? 0 : null;
    renderList();
    renderSky();
    onChoose(chosen !== null ? { sat, pass: shown[chosen] } : null);
  }

  function renderList() {
    list.innerHTML = '';
    const minEl = getMinElevation();
    if (result.status === 'always-up') {
      statusEl.textContent = `${sat.label} stays above ${minEl}° all the time from here: no rising or setting.`;
    } else if (result.status === 'never-up') {
      statusEl.textContent = `${sat.label} never gets above ${minEl}° from here in the next ${SEARCH_DAYS} days.`;
    } else {
      const nVisible = result.passes.filter((p) => p.vis.type === 'visible').length;
      statusEl.textContent = `${result.passes.length} passes above ${minEl}° in the next ${SEARCH_DAYS} days, ${nVisible} visible to the eye.`;
    }
    shown.forEach((p, k) => {
      const tr = document.createElement('tr');
      tr.tabIndex = 0;
      if (k === chosen) tr.className = 'chosen';
      const cells = [
        fmtDay(p.rise.t),
        `${fmtTime(p.rise.t)} ${compass16(p.rise.azDeg)}`,
        `${fmtTime(p.max.t)}`,
        `${p.max.elDeg.toFixed(0)}° ${compass16(p.max.azDeg)}`,
        `${fmtTime(p.set.t)} ${compass16(p.set.azDeg)}`,
        fmtDuration(p.durationS),
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      const vis = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `vis vis-${p.vis.type}`;
      badge.textContent = VIS_LABEL[p.vis.type];
      badge.title = VIS_HELP[p.vis.type];
      vis.append(badge);
      tr.append(vis);
      // Rise time as hh:mm plus seconds in a span that phones hide to save space.
      const riseText = fmtTime(p.rise.t);
      const secs = document.createElement('span');
      secs.className = 'secs';
      secs.textContent = riseText.slice(5);
      tr.cells[1].replaceChildren(riseText.slice(0, 5), secs, ` ${compass16(p.rise.azDeg)}`);
      if (p.partial) tr.cells[1].textContent = 'in progress';
      const pick = () => {
        chosen = k;
        for (const row of list.children) row.classList.toggle('chosen', row === tr);
        renderSky();
        onChoose({ sat, pass: p });
      };
      tr.addEventListener('click', pick);
      tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
      list.append(tr);
    });
  }

  const polar = (azDeg, elDeg, R, c) => {
    const r = (R * (90 - Math.max(0, elDeg))) / 90;
    return [c + r * Math.sin(azDeg * DEG), c - r * Math.cos(azDeg * DEG)];
  };

  function renderSky() {
    sky.innerHTML = '';
    liveDot = null;
    // Clamp: the box can briefly measure ~0 px wide during layout, which would
    // give negative radii.
    skySize = Math.max(220, Math.min(sky.clientWidth || 280, 320));
    const size = skySize, c = size / 2, R = c - 22;
    const svg = svgEl('svg', { width: size, height: size, role: 'img', 'aria-label': 'Sky plot of the selected pass' });
    // Elevation rings at 0, 30 and 60 degrees, and cross-hairs
    for (const elv of [0, 30, 60]) {
      const r = (R * (90 - elv)) / 90;
      svg.append(svgEl('circle', { cx: c, cy: c, r, fill: elv === 0 ? css('--panel-2') : 'none', stroke: css('--grid'), 'stroke-width': elv === 0 ? 1.5 : 1 }));
      if (elv) svg.append(svgEl('text', { x: c + 3, y: c - r - 3, class: 'sky-ring' }, `${elv}°`));
    }
    svg.append(svgEl('line', { x1: c - R, x2: c + R, y1: c, y2: c, stroke: css('--grid') }));
    svg.append(svgEl('line', { x1: c, x2: c, y1: c - R, y2: c + R, stroke: css('--grid') }));
    for (const [label, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
      const [x, y] = polar(az, -9, R, c);
      svg.append(svgEl('text', { x, y: y + 4, 'text-anchor': 'middle', class: 'sky-dir' }, label));
    }

    const p = chosen !== null ? shown[chosen] : null;
    if (!p) {
      skyCaption.textContent = result?.status === 'always-up'
        ? 'Always above the horizon: see the live position.'
        : visibleOnly && result?.passes.length ? 'No visible passes in the next 7 days.' : 'No pass to show.';
      // For an always-up satellite, show where it sits in the sky.
      if (result?.status === 'always-up') {
        liveDot = svgEl('circle', { r: 6, fill: sat.color, stroke: css('--bg'), 'stroke-width': 2 });
        svg.append(liveDot);
      }
      sky.append(svg);
      updateLive();
      return;
    }
    // Track: solid where the satellite is sunlit, dashed and faint where it is
    // in Earth's shadow (and so invisible, even on a dark night).
    const track = p.vis.track;
    let run = [];
    const flush = (lit) => {
      if (run.length < 2) return;
      const d = run.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
      svg.append(svgEl('path', lit
        ? { d, fill: 'none', stroke: sat.color, 'stroke-width': 2.5, 'stroke-linecap': 'round' }
        : { d, fill: 'none', stroke: sat.color, 'stroke-width': 1.5, 'stroke-dasharray': '3 4', opacity: 0.55 }));
    };
    track.forEach((q, k) => {
      const pt = polar(q.azDeg, q.elDeg, R, c);
      if (k && q.sunlit !== track[k - 1].sunlit) {
        run.push(pt); // join the two styles at the shadow boundary
        flush(track[k - 1].sunlit);
        run = [];
      }
      run.push(pt);
    });
    flush(track.at(-1).sunlit);
    // Direction arrow near the end of the track
    const a = track.at(-4) ?? track[0], b = track.at(-1);
    const [ax, ay] = polar(a.azDeg, a.elDeg, R, c), [bx, by] = polar(b.azDeg, b.elDeg, R, c);
    const ang = Math.atan2(by - ay, bx - ax);
    const head = (s) => `${bx + 9 * Math.cos(ang + s)},${by + 9 * Math.sin(ang + s)}`;
    svg.append(svgEl('polygon', { points: `${bx},${by} ${head(Math.PI * 0.85)} ${head(-Math.PI * 0.85)}`, fill: sat.color }));
    // Rise / max / set markers
    for (const [q, label] of [[p.rise, 'Rise'], [p.max, 'Max'], [p.set, 'Set']]) {
      const [x, y] = polar(q.azDeg, q.elDeg, R, c);
      svg.append(svgEl('circle', { cx: x, cy: y, r: 4, fill: css('--text'), stroke: css('--bg'), 'stroke-width': 2 }));
      const right = x < c;
      svg.append(svgEl('text', { x: x + (right ? 8 : -8), y: y - 6, 'text-anchor': right ? 'start' : 'end', class: 'sky-label' }, `${label} ${fmtTime(q.t).slice(0, 5)}`));
    }
    liveDot = svgEl('circle', { r: 6, fill: sat.color, stroke: css('--bg'), 'stroke-width': 2, visibility: 'hidden' });
    svg.append(liveDot);
    sky.append(svg);
    const path = `rises ${compass16(p.rise.azDeg)}, highest ${p.max.elDeg.toFixed(0)}° in the ${compass16(p.max.azDeg)}, sets ${compass16(p.set.azDeg)}.`;
    let seeIt = '';
    if (p.vis.type === 'visible') {
      const enters = p.vis.to < p.set.t - 10e3 ? ', then it enters Earth\'s shadow' : '';
      const leaves = p.vis.from > p.rise.t + 10e3 ? ' (after leaving Earth\'s shadow)' : '';
      seeIt = ` Visible ${fmtTime(p.vis.from).slice(0, 5)}–${fmtTime(p.vis.to).slice(0, 5)}${leaves}${enters}.`;
    } else {
      seeIt = ` ${VIS_HELP[p.vis.type]}.`;
    }
    skyCaption.textContent = `${fmtDay(p.rise.t)}: ${path}${seeIt} Dashed = in Earth's shadow.`;
    updateLive();
  }

  /** "Next pass in 3 h 12 m" / "Up now, sets in 4 m 10 s". */
  function updateCountdown(t) {
    const next = result.passes.find((p) => p.set.t > t);
    if (!next) {
      countdown.textContent = result.status === 'always-up' ? 'Always up' : '';
      countdown.className = 'pass-countdown';
      return;
    }
    const span = (ms) => {
      const s = Math.max(0, Math.round(ms / 1000));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      return h ? `${h} h ${m} m` : `${m} m ${String(s % 60).padStart(2, '0')} s`;
    };
    const up = t >= next.rise.t;
    countdown.textContent = up ? `Up now · sets in ${span(next.set.t - t)}` : `Next pass in ${span(next.rise.t - t)}`;
    countdown.className = `pass-countdown${up ? ' up' : ''}`;
  }

  /** Move the live dot when the satellite is up; recompute when the list goes stale. */
  function updateLive() {
    if (!sat || !result) return;
    const t = getTime();
    updateCountdown(t);
    if (t - computedAt > RECOMPUTE_AFTER_MS || t < computedAt || (result.passes[0] && t > result.passes[0].set.t)) {
      compute();
      return;
    }
    if (!liveDot) return;
    const l = lookAt(sat.el, getObserver(), t, getPropagate());
    const up = l.elevation > 0;
    const c = skySize / 2, R = c - 22;
    const [x, y] = polar(l.azimuth / DEG, l.elevation / DEG, R, c);
    liveDot.setAttribute('cx', x);
    liveDot.setAttribute('cy', y);
    liveDot.setAttribute('visibility', up ? 'visible' : 'hidden');
  }

  new ResizeObserver(() => { if (result) renderSky(); }).observe(sky);

  return {
    setSatellite(s) {
      sat = s;
      root.querySelector('.pass-name').textContent = s.label;
      compute();
    },
    refresh() { if (sat) compute(); },
    setVisibleOnly(on) {
      visibleOnly = on;
      if (result) applyFilter();
    },
    tick: updateLive,
  };
}

/** Next pass (or "up now") for a satellite card. */
export function nextPassSummary(sat, observer, now, propagate, minElevationDeg) {
  const r = findPasses(sat.el, observer, { start: now, end: now + 2 * 86400e3, minElevationDeg, propagate, stepMs: 60e3 });
  if (r.status === 'always-up') return { text: 'Always above the horizon', up: true };
  if (r.status === 'never-up') return { text: 'No passes in the next 2 days', up: false };
  const p = r.passes[0];
  const visible = passVisibility(sat.el, observer, p, propagate, 10e3).type === 'visible' ? ' · visible' : '';
  if (p.partial) return { text: `Passing now, until ${fmtTime(p.set.t).slice(0, 5)}${visible}`, up: true, until: p.set.t };
  return { text: `Next pass ${fmtDay(p.rise.t)} ${fmtTime(p.rise.t).slice(0, 5)}, max ${p.max.elDeg.toFixed(0)}°${visible}`, up: false, until: p.rise.t };
}
