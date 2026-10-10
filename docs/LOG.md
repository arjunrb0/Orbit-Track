# Development log

An honest record of what was built, what went wrong and what is still limited.

## Stage 1: project setup and orbital data (2026-10-10)

**Built**
- Vite project, no frameworks. Node's built-in test runner.
- `src/data/catalog.js`: 8 satellites (ISS + 7 ISRO), NORAD IDs checked against CelesTrak.
  Covers sun-synchronous LEO, 37° LEO, near-equatorial LEO (ASTROSAT), GEO (INSAT-3DR)
  and inclined geosynchronous (IRNSS-1I).
- `src/data/elements.js`: parsers for OMM JSON and TLE into one common shape, plus validation.
- `scripts/fetch-data.mjs`: downloads both formats, validates, cross-checks the epochs,
  and writes `public/data/` only if every satellite passes.
- GitHub Actions: test → build → deploy to Pages; daily data fetch that commits only when
  the elements actually changed.

**Validation**
- TLE checksums verified on real ISS lines and on the Vanguard 1 test case from
  Vallado et al. (2006).
- The same ISS element set in OMM and TLE form agrees to within TLE precision.
- Sanity check: INSAT-3DR's period from its mean motion is 1436.1 min, matching one sidereal
  day (1436.07 min), as a geostationary satellite should.

**Bugs and surprises**
- OMM epochs have no `Z`, and `new Date("2026-10-09T19:42:49")` parses that as *local*
  time. Parsed manually as UTC instead. Test added.
- First version of the precision test was too strict: a JavaScript timestamp (~1.8×10¹² ms)
  can only resolve about 0.0002 ms in a 64-bit double. 1 µs is the realistic bound.
- TLE eccentricity is rounded to 7 digits (ISS: OMM 0.00067745 vs TLE 0.0006774).

**Limitations**
- IRNSS-1I's elements were 5.4 days old when fetched; GEO/IGSO objects are updated less often.
- ASTROSAT (6° inclination) and INSAT-3DR (GEO) will never produce rise/set "passes" for most
  observers. They're there for the orbit-type comparison, and pass prediction will need to
  handle "always up / never up".

## Stage 2: two-body propagator (2026-10-10)

**Built**
- `src/orbit/kepler.js`: mean motion → semi-major axis (Kepler's third law), Kepler's equation
  solved by Newton's method, eccentric → true anomaly, perifocal r/v rotated into the TEME frame.
- WGS-72 constants (the ones the CelesTrak elements were fitted with).
- New page: live 3D orbit view on Canvas (drag/zoom, 1×/60×/600× time), satellite cards with
  live altitude and speed from the propagator.

**Validation** (28 tests pass)
- Vallado Example 2-1 (Kepler's equation) and Example 2-6 (elements → r, v), both checked to the
  published digits.
- Kepler's equation residual < 1e-10 rad for e from 0 to 0.999, and for large/negative M.
- Energy (vis-viva) and angular momentum match their textbook formulas around a Molniya-type orbit.
- Independent check: numerically integrating Newton's law (RK4, 1 s step) from the same start
  agrees with the Kepler solution to ~0.01 mm after 6 h (ISS) and ~0.02 mm after 2 days (e = 0.72).
- Period measured from the Newton integration matches Kepler's third law to < 0.01 s.
- ISS: a = 6798.4 km → mean altitude 420 km (perigee 416, apogee 425), matching published values.
- The tests were mutation-checked: a wrong velocity formula and an acos-based true anomaly
  were each caught.

**Limitations**
- Pure two-body: no J2 (Earth's equatorial bulge), no drag, no Sun/Moon. The orbit is a fixed
  ellipse, which the real orbits are not; the ISS's plane actually swings round by about 5° a day.
  Size of this error is measured in stage 4.
- The CelesTrak elements are SGP4 *mean* elements, not osculating ones, so even at the epoch the
  Kepler position won't exactly match SGP4.
- The Newton/RK4 test can't detect a wrong orbit orientation (any rigid rotation of a valid orbit
  is still a valid orbit); the Vallado 2-6 and inclination tests cover that.
- The 3D view has no continents yet: drawing them needs Earth's rotation angle (stage 3).

## Stage 3: time and coordinate frames (2026-10-10)

**Built**
- `src/orbit/time.js`: Julian dates and GMST (IAU-82, the formula TEME is defined with).
- `src/orbit/frames.js`: TEME ↔ Earth-fixed (rotate by GMST), geodetic ↔ Earth-fixed on the
  WGS-84 ellipsoid (iterative latitude), and azimuth/elevation/range via East-North-Up.
- `src/data/land.js`: decoder for Natural Earth coastlines (TopoJSON, from the world-atlas package).
- UI: world map with ground tracks and the selected satellite's visibility footprint, continents
  on the 3D globe (rotated by GMST), observer location (default Bengaluru, manual entry or browser
  geolocation), and live azimuth/elevation on each satellite card.

**Validation** (41 tests pass)
- Vallado Examples 3-4 (Julian date), 3-5 (GMST, to 1e-6°) and 3-3 (ECEF → lat/lon/height).
- TEME → Earth-fixed reproduces the worked example in Vallado et al. (2006) to 0.1 m.
- WGS-84 polar radius (6356.752 km) and equator point; geodetic round trip from 0 km to GEO,
  including the poles, to 1e-9°.
- Look angles: overhead / due north / due east cases, and "up" follows the ellipsoid normal.
- ISS ground track: maximum latitude ≈ inclination; successive equator crossings shift west by
  the angle Earth turns in one orbit (≈ 23.3°).
- Coastline decoder puts Bengaluru, London and New York on land and three ocean points in water.
- Visual check: INSAT-3DR appears at ~74°E and IRNSS-1I near 55°E, their published orbital
  slots.

**Bugs and surprises**
- A textbook value for one example (Vallado 3-1), recalled from memory, didn't reproduce, so it
  wasn't used. Independent facts (the WGS-84 polar radius) were used instead. Lesson: check reference values before
  trusting them.
- Node needs `with { type: 'json' }` to import JSON; Vite accepts the same syntax.

**Limitations**
- UTC is used in place of UT1 (|UT1 − UTC| < 0.9 s): up to ~0.4 km of error along the
  ground. Polar motion (~10–15 m) is ignored.
- Ground tracks inherit all the two-body limitations from stage 2. In particular, without J2,
  successive tracks shift by Earth's rotation only, not by the orbit plane's own drift.
- Nothing here has been compared against SGP4 or a real pass prediction yet (stages 4 and 5).

## Stage 4: comparison with SGP4, and the J2 correction (2026-10-10)

**Built**
- `src/orbit/j2.js`: two-body + J2 secular drift (node regression, perigee rotation, mean-anomaly
  rate), plus SGP4's "un-Kozai" mean-motion conversion.
- `src/analysis/compare.js`: error vs SGP4 (satellite.js, used only as a reference), split into
  radial / along-track / cross-track.
- `npm run compare` writes [RESULTS.md](RESULTS.md) for all 8 satellites.
- UI: accuracy panel (chart + 1 h / 1 day / 1 week tiles) for the selected satellite, and a
  switch for which propagator drives the map/globe/cards (J2 by default).

**Headline results** (full table in [RESULTS.md](RESULTS.md))
- Low orbits after 1 day: Kepler 414–868 km from SGP4; with J2, 12–19 km (over 95% of the gap closed).
- After 1 week: Kepler 2,875–5,916 km; with J2, 29–150 km.
- Geosynchronous: mixed. J2 helps IRNSS-1I (60 → 38 km at 1 week) but makes INSAT-3DR worse
  (27 → 50 km).

**Validation** (49 tests pass)
- Un-Kozai mean motion equals SGP4's internal value to 1e-10 (ISS, Vanguard 1).
- J2 rates match SGP4's internal secular rates to 0.1–0.7% for all 8 satellites (to 4 decimals for GEO).
- ISS node regression −4.95°/day (published: about −5°/day). The three sun-synchronous ISRO
  satellites come out at +0.985 to +0.990°/day (design value 0.9856°/day).
- Perigee rotation is zero at the critical inclination 63.43°.
- ISS 7-day remaining error is along-track and matches the drag prediction from the element
  set's own ṅ/2 (predicted ≈135 km, measured ≈150 km).

**Bugs and surprises**
- Initially attributed the J2 model's worse epoch error to a "~7 km" semi-major-axis change.
  Measured: 0.5 km (ISS) to 6.2 km (ASTROSAT). Corrected before publishing.
- First chart draft sampled every 20 min, which aliased the within-orbit oscillation into noise.
  Now plots the worst error per 2-hour window.
- **Production build broke** while the dev server worked: satellite.js v7's package root also
  exports a WebAssembly build that Vite can't bundle. Fixed by importing the two plain-JS
  files we need (`src/analysis/sgp4-lib.js`), then checked the built site in a browser. Lesson:
  run `npm run build` before calling a stage done. CI would have blocked the deploy anyway.

**Limitations**
- Measured against SGP4, not true positions. SGP4 itself drifts a few km/day.
- One element set per satellite; errors measured from epoch, not from "now".
- Not modelled: drag, J2 short-period terms, J3/J4, Sun/Moon. That explains the ISS week-long
  error (drag) and the GEO behaviour (Sun/Moon, resonance).

## Stage 5: pass prediction (2026-10-10)

**Built**
- `src/passes/passes.js`: coarse 60 s scan → bisection for rise/set (to 0.1 s) → golden-section
  search for the maximum. Also catches grazing passes that peak between two samples, and reports
  "always up" / "never up" for satellites that don't rise and set.
- UI: pass list for the selected satellite (next 7 days, local time), a sky plot of the chosen pass
  with a live position dot, a 0°/10° minimum-elevation switch, and "next pass" on every card.

**Validation against Heavens-Above** (27 ISS passes over Bengaluru, 10–20 Oct, same element set;
details in [RESULTS.md](RESULTS.md))
- SGP4 positions + this project's pass search and coordinate code: all 27 passes within 1 s, peak elevation
  within 0.5° (Heavens-Above rounds to whole degrees). This independently confirms the GMST,
  frame, look-angle and search code.
- J2 propagator: all 27 within a minute; 1–2 s on day 1, growing to 40 s by day 10 (drag).
- Pure Kepler propagator: finds only 8 of 27.

**Other tests** (57 pass in total)
- Rise/set are true horizon crossings; the maximum is the true maximum (1 s scan).
- Pass duration never exceeds the geometric limit (11.2 min for the ISS here), and the longest
  predicted pass (10.9 min) comes within 5% of it.
- Same passes with a 240 s scan step as with 60 s, including a 2.8° grazing pass.
- INSAT-3DR is "always up" from Bengaluru at the elevation an independent spherical-Earth formula
  gives (≈74°); ASTROSAT is "never up" from London.

**Bugs and surprises**
- The first pass-duration bound assumed Earth's rotation lengthens a pass by at most 3%. It is
  ~7% at Bengaluru for passes heading east (10.9 min observed vs a 10.6 min "limit"). The test
  caught a wrong physics assumption in the test, not a code bug. Fixed the bound with the proper factor
  1/(1 − v_surface/v_ground-track).
- Pass times are forgiving: 150 km of along-track error is only ~20 s at 7.7 km/s.

**Limitations**
- A pass shorter than the 60 s scan step that also peaks more than 3° below the threshold between
  samples could be missed. This is irrelevant for real low-orbit passes, which last minutes.
- Atmospheric refraction (which lifts objects near the horizon by ~0.5°) is not modelled.
  Heavens-Above lists passes from 10°, where refraction is small.
- "Passes" here are geometric. Whether you can *see* the satellite (sunlit, dark sky) is a stretch goal.

## Stages 6 and 7: visualisation polish, README, deployment (2026-10-10)

**Built**
- The selected pass's ground track is highlighted on the map (rise to set), with a live
  "next pass in …" / "up now, sets in …" countdown.
- Place presets (including ISRO's Sriharikota launch site), keyboard-accessible satellite cards,
  favicon and page description.
- Full README with results, validation table and limitations; screenshot in `docs/`.
- Results and log reworded to neutral voice ("this project's propagator").

**Bugs**
- The sky plot could render while its box measured ~0 px wide, giving negative SVG radii (seen as
  console errors). Fixed by clamping the plot size.

## Stretch goals: drag, visible passes, low vs high orbits (2026-10-10)

**Built**
- Drag term from the element set's ṅ (`propagateJ2Drag`): extra mean anomaly 2π(ṅ/2)Δt² and a
  matching shrinking orbit. Applied only below SGP4's 225-minute "deep space" line, since there is
  no air at geosynchronous height. Now the app's default propagator.
- Sun position (Astronomical Almanac low-precision formula), Earth-shadow test, and pass visibility
  (visible / daylight / unlit). The pass list has a visibility column and a "Visible only" filter; the
  sky plot draws the in-shadow part of a pass dashed; the map and globe show day and night.
- Low vs high orbit analysis in [RESULTS.md](RESULTS.md), including a force-by-force table computed
  from textbook constants.

**Results**
- ISS 1-week error vs SGP4: 150 km (J2) → 15 km (J2 + drag). Low-orbit range with drag: 15–47 km.
- ISS passes vs Heavens-Above: every pass within 3 s for all 10 days (was 40 s by day 10 with J2 only).
- Visibility labels match Heavens-Above for 27/27 passes (labelling down to 0°, as Heavens-Above does).
- Shadow model agrees with satellite.js's shadow function at all ~2,000 sampled positions outside penumbra.
- Sun position matches the 2026 equinox and solstice declinations and the perihelion/aphelion distances.

**Bugs and surprises**
- First drag version also applied ṅ to the geosynchronous satellites, which helped one and hurt the
  other. At that height ṅ isn't drag but a fitted number absorbing Sun/Moon effects and
  station-keeping. Restricted to near-Earth orbits.
- One visibility label (15 Oct) initially disagreed with Heavens-Above. Investigation showed it wasn't
  a borderline shadow case: the ISS stays 8° deep in shadow above 10° and only reaches sunlight at 0.5°
  elevation, 9 s before setting. Heavens-Above labels the whole pass down to 0°. A definition difference,
  documented rather than "fixed".
- An early draft of the orbit-regime table claimed a "best model" that, for INSAT-3DR, was worse than plain
  Kepler. Replaced with Kepler vs J2 + drag side by side.

**Limitations**
- Drag uses a constant ṅ; real drag changes with solar activity, and the ISS reboosts.
- No brightness (magnitude) estimate; no penumbra; no atmospheric refraction.
