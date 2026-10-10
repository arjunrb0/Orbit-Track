import { CATALOG } from './data/catalog.js';
import { parseOmm, epochAgeDays } from './data/elements.js';
import { propagateKepler, toKeplerian } from './orbit/kepler.js';
import { propagateJ2, propagateJ2Drag } from './orbit/j2.js';
import { createAccuracyChart } from './ui/accuracy-chart.js';
import { createPassPanel, nextPassSummary } from './ui/pass-panel.js';
import { norm } from './orbit/vec.js';
import { R_EARTH, TWO_PI, DEG } from './orbit/constants.js';
import { temeToEcef, lookAngles } from './orbit/frames.js';
import { apparentElevation } from './passes/sky.js';
import { createOrbitView } from './ui/orbit-view.js';
import { createMapView } from './ui/map-view.js';

// Element sets older than this are flagged; two-body error grows with age.
const STALE_DAYS = 3;
const COLORS = ['#5cc8ff', '#ff8f5c', '#ffd166', '#7ee081', '#c792ea', '#ff6b9a', '#4fd1c5', '#a3b4ff'];

// ------------------------------------------------------- simulation clock
// Real time by default; 60x and 600x let you watch an ISS orbit in ~90 s or ~9 s.
const clock = { baseSim: Date.now(), baseReal: performance.now(), speed: 1 };
const simTime = () => clock.baseSim + (performance.now() - clock.baseReal) * clock.speed;
function setSpeed(speed, resetToNow = false) {
  clock.baseSim = resetToNow ? Date.now() : simTime();
  clock.baseReal = performance.now();
  clock.speed = speed;
}

// -------------------------------------------------------------- propagator
// Which propagator drives the map, globe, cards and passes. J2 + drag by
// default: it is the closest to SGP4 and to Heavens-Above (docs/RESULTS.md).
const PROPAGATORS = { drag: propagateJ2Drag, j2: propagateJ2, kepler: propagateKepler };
let activeModel = 'drag';
const propagate = (el, t) => PROPAGATORS[activeModel](el, t);
// Passes count from this elevation. 10 deg by default, like Heavens-Above:
// the lowest few degrees are usually hidden by trees and buildings.
let minElevationDeg = 10;

// ---------------------------------------------------------------- observer
// Default: Bengaluru (ISRO headquarters). Remembered in this browser only.
const DEFAULT_OBSERVER = { latDeg: 12.9716, lonDeg: 77.5946, heightKm: 0.92, name: 'Bengaluru (default)' };
const OBSERVER_KEY = 'spt-observer';
function loadObserver() {
  try {
    const saved = JSON.parse(localStorage.getItem(OBSERVER_KEY));
    if (saved && Number.isFinite(saved.latDeg) && Number.isFinite(saved.lonDeg)) return saved;
  } catch {
    // storage unavailable or corrupt: fall back to the default
  }
  return DEFAULT_OBSERVER;
}
let observer = loadObserver();
const observerRad = () => ({ lat: observer.latDeg * DEG, lon: observer.lonDeg * DEG, height: observer.heightKm ?? 0 });
let onObserverChange = () => {};
function setObserver(next) {
  observer = next;
  onObserverChange();
  try {
    localStorage.setItem(OBSERVER_KEY, JSON.stringify(next));
  } catch {
    // not persisted; fine
  }
  showObserver();
}
function showObserver() {
  document.getElementById('obs-lat').value = observer.latDeg.toFixed(4);
  document.getElementById('obs-lon').value = observer.lonDeg.toFixed(4);
  document.getElementById('obs-note').textContent = observer.name ?? '';
}

const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];

async function loadElements() {
  const res = await fetch(`${import.meta.env.BASE_URL}data/omm.json`);
  if (!res.ok) throw new Error(`Could not load orbital data (${res.status})`);
  const data = await res.json();
  return { fetchedAt: data.fetchedAt, elements: data.satellites.map(parseOmm), omms: data.satellites };
}

/** NASA's ISS trajectory, if the daily fetch saved one. Optional. */
async function loadIssEphemeris() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/iss-oem.json`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function buildCard(sat) {
  const li = el('li', 'sat');
  li.dataset.id = sat.el.noradId;
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  const dot = el('span', 'dot');
  dot.style.background = sat.color;
  dot.style.boxShadow = `0 0 10px ${sat.color}`;
  li.append(dot, el('span', 'name', sat.label));
  li.append(el('span', `tag ${sat.info?.operator === 'ISRO' ? 'isro' : ''}`, sat.info?.operator ?? ''));
  const orbit = el('span', 'orbit', sat.info?.orbit ?? '');
  const age = epochAgeDays(sat.el);
  if (age > STALE_DAYS) orbit.append(' · ', el('span', 'stale', `data ${age.toFixed(1)} d old`));
  li.append(orbit);
  const stats = el('div', 'stats');
  sat.live = {};
  for (const [key, label] of [['alt', 'Altitude'], ['speed', 'Speed'], ['period', 'Period']]) {
    const s = el('div', 'stat');
    s.append(el('div', 'k', label));
    sat.live[key] = el('div', 'v', '–');
    s.append(sat.live[key]);
    stats.append(s);
  }
  li.append(stats);
  sat.live.look = el('div', 'look', '');
  sat.live.next = el('div', 'next', '');
  li.append(sat.live.look, sat.live.next);
  li.title = `NORAD ${sat.el.noradId} · elements ${epochAgeDays(sat.el).toFixed(1)} days old`;
  return li;
}

function buildTable(satellites) {
  const tbody = document.querySelector('#elements tbody');
  for (const { el: e } of satellites) {
    const tr = document.createElement('tr');
    const cells = [
      e.name,
      new Date(e.epochMs).toISOString().slice(0, 19).replace('T', ' '),
      e.meanMotionRevPerDay.toFixed(5),
      e.eccentricity.toFixed(6),
      e.inclinationDeg.toFixed(3),
      e.raanDeg.toFixed(3),
      e.argPerigeeDeg.toFixed(3),
      e.meanAnomalyDeg.toFixed(3),
      toKeplerian(e).a.toFixed(1),
    ];
    for (const c of cells) tr.append(el('td', '', c));
    tbody.append(tr);
  }
}

function formatPeriod(minutes) {
  if (minutes < 120) return `${minutes.toFixed(1)} min`;
  const h = Math.floor(minutes / 60);
  return `${h} h ${Math.round(minutes - h * 60)} m`;
}

async function main() {
  const status = document.getElementById('status');
  let satellites;
  try {
    const { fetchedAt, elements, omms } = await loadElements();
    satellites = elements.map((e, k) => {
      const info = CATALOG.find((s) => s.noradId === e.noradId);
      return { el: e, omm: omms[k], info, label: info?.name ?? e.name, color: COLORS[k % COLORS.length] };
    });
    status.textContent = `data ${new Date(fetchedAt).toISOString().slice(0, 10)}`;
    status.title = `Fetched from CelesTrak ${new Date(fetchedAt).toUTCString()}`;
  } catch (err) {
    status.textContent = err.message;
    return;
  }

  const list = document.getElementById('sat-list');
  for (const sat of satellites) {
    const { n } = toKeplerian(sat.el);
    sat.periodMin = TWO_PI / n / 60;
    list.append(buildCard(sat));
  }
  buildTable(satellites);

  const accuracy = createAccuracyChart(document.getElementById('accuracy'));
  const issEphemeris = await loadIssEphemeris();
  let accReference = 'sgp4';
  const ACC_DESC = {
    SGP4: 'How far this project\'s propagators drift from SGP4 (satellite.js), starting from the element-set epoch. SGP4 is the reference these elements were made for, not ground truth.',
    "NASA's ISS trajectory": `Against NASA's own high-precision ISS trajectory (created ${issEphemeris?.creationDate?.slice(0, 10) ?? '?'}, converted from J2000), the closest thing to the ISS's true position that is public. SGP4's own error is the dashed line.`,
  };
  const showAccuracy = (sat) => {
    const isIss = sat.el.noradId === 25544 && issEphemeris;
    document.getElementById('acc-ref-toggle').hidden = !isIss;
    const reference = accuracy.show(sat, isIss && accReference === 'nasa' ? issEphemeris.states : null);
    document.querySelector('.acc-desc').textContent = ACC_DESC[reference];
    document.querySelector('.legend-sgp4').hidden = reference === 'SGP4';
  };
  const passPanel = createPassPanel(document.getElementById('passes'), {
    getTime: simTime,
    getObserver: observerRad,
    getPropagate: () => PROPAGATORS[activeModel],
    getMinElevation: () => minElevationDeg,
    onChoose: (choice) => map.highlightPass(choice),
  });
  // "Next pass" lines on the cards are cached and recomputed only when needed.
  const nextPassCache = new Map();
  const invalidatePasses = () => {
    nextPassCache.clear();
    passPanel.refresh();
  };
  onObserverChange = invalidatePasses;
  let selectedSat = null;
  const select = (id) => {
    view.select(id);
    map.select(id);
    const sat = satellites.find((s) => s.el.noradId === id);
    selectedSat = sat;
    showAccuracy(sat);
    passPanel.setSatellite(sat);
    for (const li of list.children) {
      li.classList.toggle('selected', Number(li.dataset.id) === id);
      li.setAttribute('aria-pressed', String(Number(li.dataset.id) === id));
    }
    list.querySelector('.selected')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const view = createOrbitView(document.getElementById('orbit-canvas'), satellites, {
    getTime: simTime,
    onSelect: select,
    propagate,
  });
  const map = createMapView(document.getElementById('map-canvas'), satellites, {
    getTime: simTime,
    getObserver: observerRad,
    onSelect: select,
    propagate,
  });
  list.addEventListener('click', (ev) => {
    const li = ev.target.closest('.sat');
    if (li) select(Number(li.dataset.id));
  });
  list.addEventListener('keydown', (ev) => {
    const li = ev.target.closest('.sat');
    if (li && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      select(Number(li.dataset.id));
    }
  });
  select(satellites[0].el.noradId);

  // Controls
  const wireSegmented = (selector, onPick) => {
    for (const btn of document.querySelectorAll(selector)) {
      btn.addEventListener('click', () => {
        onPick(btn);
        if (!btn.hasAttribute('data-now')) {
          for (const b of btn.parentElement.children) b.classList.toggle('active', b === btn);
        }
      });
    }
  };
  wireSegmented('[data-speed], [data-now]', (btn) => {
    if (btn.hasAttribute('data-now')) {
      setSpeed(1, true);
      for (const b of btn.parentElement.querySelectorAll('[data-speed]')) b.classList.toggle('active', b.dataset.speed === '1');
    } else {
      setSpeed(Number(btn.dataset.speed));
    }
  });
  wireSegmented('[data-model]', (btn) => {
    activeModel = btn.dataset.model;
    map.refresh();
    view.refresh();
    invalidatePasses();
    tick();
  });
  wireSegmented('[data-accref]', (btn) => {
    accReference = btn.dataset.accref;
    if (selectedSat) showAccuracy(selectedSat);
  });
  wireSegmented('[data-visfilter]', (btn) => passPanel.setVisibleOnly(btn.dataset.visfilter === 'visible'));
  wireSegmented('[data-minel]', (btn) => {
    minElevationDeg = Number(btn.dataset.minel);
    invalidatePasses();
  });
  wireSegmented('[data-zoom]', (btn) => view.zoomTo(Number(btn.dataset.zoom)));
  wireSegmented('[data-view]', (btn) => {
    const which = btn.dataset.view;
    document.querySelector('.viewer').dataset.view = which;
    document.getElementById('map-canvas').hidden = which !== 'map';
    document.getElementById('orbit-canvas').hidden = which !== 'globe';
    for (const node of document.querySelectorAll('[data-for]')) node.hidden = node.dataset.for !== which;
  });

  // Observer controls
  showObserver();
  document.getElementById('observer-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const latDeg = Number(document.getElementById('obs-lat').value);
    const lonDeg = Number(document.getElementById('obs-lon').value);
    if (Math.abs(latDeg) <= 90 && Math.abs(lonDeg) <= 180) setObserver({ latDeg, lonDeg, heightKm: 0, name: 'Custom location' });
  });
  document.getElementById('obs-preset').addEventListener('change', (ev) => {
    const opt = ev.target.selectedOptions[0];
    if (!opt.value) return;
    const [latDeg, lonDeg, heightKm] = opt.value.split(',').map(Number);
    setObserver({ latDeg, lonDeg, heightKm, name: opt.textContent });
    ev.target.value = '';
  });
  document.getElementById('geolocate').addEventListener('click', () => {
    const note = document.getElementById('obs-note');
    if (!navigator.geolocation) {
      note.textContent = 'Location not available in this browser.';
      return;
    }
    note.textContent = 'Asking the browser for your location…';
    navigator.geolocation.getCurrentPosition(
      (pos) => setObserver({
        latDeg: pos.coords.latitude,
        lonDeg: pos.coords.longitude,
        heightKm: (pos.coords.altitude ?? 0) / 1000,
        name: `Your location (±${Math.round(pos.coords.accuracy)} m)`,
      }),
      (err) => { note.textContent = `Couldn't get location: ${err.message}`; },
      { timeout: 10000 },
    );
  });

  // Live numbers, a few times a second (the canvas animates every frame).
  const clockEl = document.getElementById('clock');
  const tick = () => {
    const t = simTime();
    clockEl.textContent = `${new Date(t).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
    for (const sat of satellites) {
      const { r, v } = propagate(sat.el, t);
      sat.live.alt.textContent = `${Math.round(norm(r) - R_EARTH).toLocaleString()} km`;
      sat.live.speed.textContent = `${norm(v).toFixed(2)} km/s`;
      sat.live.period.textContent = formatPeriod(sat.periodMin);
      const look = lookAngles(temeToEcef(r, t), observerRad());
      const az = look.azimuth / DEG, elev = apparentElevation(look.elevation) / DEG;
      const up = elev > 0;
      sat.live.look.innerHTML = '';
      sat.live.look.append(
        el('span', up ? 'up' : '', up ? 'Above horizon' : 'Below horizon'),
        ` · az ${az.toFixed(0)}° ${compass(az)} · el ${elev.toFixed(1)}°`,
      );
      let next = nextPassCache.get(sat.el.noradId);
      if (!next || t < next.computedAt || t - next.computedAt > 10 * 60e3 || (next.until && t > next.until)) {
        next = { ...nextPassSummary(sat, observerRad(), t, PROPAGATORS[activeModel], minElevationDeg), computedAt: t };
        nextPassCache.set(sat.el.noradId, next);
      }
      sat.live.next.textContent = next.text;
      sat.live.next.className = `next${next.up ? ' up' : ''}`;
    }
    passPanel.tick();
  };
  tick();
  setInterval(tick, 250);
}

main();
