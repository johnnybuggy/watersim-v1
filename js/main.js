/*
 * WaterSim — application glue: parameter UI, pointer interaction (stir /
 * orbit), simulation loop, and per-frame surface extraction & rendering.
 */
(function () {
'use strict';
if (typeof document === 'undefined') return; // browser only

var RES_PRESETS = {};
AdaptiveQuality.levels.forEach(function (level) { RES_PRESETS[level.key] = level; });
var activeRes = 'low', calibrating = false, calibrationToken = 0;
var qualityController = null, qualityMessage = '', dirty = true;
var frameMsEma = 1000 / 60, surfaceMs = 0, workMs = 0;
var calibrationResults = [], lastShowParticles = null;
var requestedTarget = 0;
var params = {
  timeScale: 1,
  gravity: 20,
  viscosity: 5e-5,
  pic: 0.05,
  substeps: 1,
  iters: 20,
  iso: 1.8,
  pOpacity: 0.5,
  heatK: 1.2,
  vorticity: 0,
  currents: 0,
  coreR: 11,           // default planet radius (m)
  oceanVolume: 3,       // particle-count multiplier on the active preset (×0.1–×50)
  bumpiness: 0.15,
  waterOpacity: 0.25,
  sunActivity: 0.23,    // drives BOTH solar heating and evaporation
  ceilReflect: 'linear',  // vapor ceiling-bounce probability curve: linear|quadratic|exponential
  atmosphereH: 5.4,
  yearPeriod: 1200,     // seconds for one revolution around the fixed sun (20 min)
  spinPeriod: 300,      // seconds for one turn about the planet's axis (5 min)
  planetColor: '#654321',
  waterColor: '#2ab0f4',   // default water hue RGB(42,176,244)
  showParticles: true,
  showVectors: false,
  tiltDeg: 23.5,
  waterBeads: true,
  cloudSprite: false,   // cloud puffs draw the img/cloud_sprite.png sprite (off by default)
  metaballs: false,     // metaball visualization: water particles fused into a liquid skin
  metaballTension: 0.5, // tension between particles (kernel reach 1.6..3.8 spacings)
  metaballTess: 0.5,    // tessellation detail: field-lattice scale ×0.6..×1.4 (0.5 → ×1.0)
  // Metaball material editor (own material on the metaball skin — the water
  // surface keeps the water controls). The color follows the water picker
  // until one is picked here; the scene seeds the skin to the water look.
  metaballColor: '#2ab0f4',   // skin color (validated hex; mirrors pickWater's default)
  metaballShading: 'physical',  // physical (water look) | matte | unlit
  metaballTexture: 'none',      // none | noise | caustic | stripes (procedural shader layers)
  metaballOpacity: 0.25,        // skin opacity (shipped water default)
  metaballGloss: 0.85,          // skin glossiness (roughness = 1−g, clearcoat = g)
  motionBlur: 0,        // frame-blend damp 0–0.95 (0 = off — normal MSAA render)
  stars: true,
  starBrightness: 1.25,
  thunder: -1,          // log exponent: ×10^-1 = ×0.1 storm rate by default (slider −2…+1 → ×0.01…×10)
  // phase-change thresholds (Clouds & precipitation subsection)
  cloudT: 0.34,         // steam → cloud temperature (needs steam pressure too)
  cloudP: 0.35,         // steam density threshold (particles per neighbouring cell)
  rainT: 0.22,          // steam colder than this rains out (clamped < cloudT)
  snowT: 0.10,          // water/rain colder than this freezes (clamped < rainT)
  iceMeltT: 0.105,      // ice melts back at the melt point (5% above the snow point)
  evapIntensity: 0.05,  // evaporation law coefficient: p ∝ I·exp(3.5·(T−T_freeze)) per second
  particleSpin: true,   // particles rotation (on by default)
  spinColor: false,     // color particles by the spin-velocity vector (off by default)
  stirMode: false
};
// Earth-mode climate controller state (btnEarth)
var earthCtl = null;

var solver = null, scene = null;
var paused = false;
var lastT = 0;
var simMs = 0, fpsEma = 60, statTimer = 0, dryTimer = 11;   // dryTimer: first census fires immediately
var stirring = false, handPos = null, handPrev = null, handVel = [0, 0, 0];
var raycaster = null, stirPlane = null;

function $(id) { return document.getElementById(id); }

function ema(oldV, newV, a) { return oldV + (newV - oldV) * (a === undefined ? 0.1 : a); }

// Self-similar world scaling: every planet dimension hangs off coreR, so the
// 0.5 m … 25 m radius range behaves like the 1.5 m reference world (each helper
// returns the classic shipped constant at coreR = 1.5). Gravity is Froude-
// scaled (g ∝ 1/size) with absolute velocities, which makes splashes, waves
// and hydrostatics proportionally identical at every planet size.
function worldScale() { return params.coreR / 1.5; }
function oceanDepthFor() { return 0.3 * params.coreR; }      // classic: 0.45
function ballRadius() { return 0.2 * params.coreR; }         // classic: 0.3
function gravityScaled() { return params.gravity * (1.5 / params.coreR); }

// Ocean-volume label: multiplier + the resulting particle count for the
// active detail preset (refreshed after every rebuild).
function oceanVFmt(v) {
  var base = (typeof RES_PRESETS !== 'undefined' && RES_PRESETS[activeRes])
    ? RES_PRESETS[activeRes].target : 36000;
  return '\u00D7' + v.toFixed(1) + ' \u2248 ' + Math.round(base * v).toLocaleString();
}

// Fixed sun, moving planet: advance the revolution around the sun ("year")
// and the axial spin ("day"), then hand the solver the sun expressed in the
// planet's rotating frame so day/night follows the spin.
function advanceCelestial(dt) {
  scene.updatePlanetMotion(dt);
  var sl = scene.sunLocal;
  if (!solver.sunPos) solver.sunPos = [0, 0, 0];
  solver.sunPos[0] = sl.x; solver.sunPos[1] = sl.y; solver.sunPos[2] = sl.z;
}

// ------------------------------------------------------------------ solver
function buildSolver(resKey) {
  var p = RES_PRESETS[resKey] || RES_PRESETS.low;
  activeRes = p.key;
  dirty = true;
  dryTimer = 11;
  // ocean-volume label depends on the active preset's particle target
  var ovOut = $('oceanVVal');
  if (ovOut) ovOut.textContent = oceanVFmt(params.oceanVolume);
  // ocean planet: cubic domain around the core sphere — the margin around
  // sea level scales with the planet (classic: 0.6 at coreR 1.5)
  var R2 = params.coreR + oceanDepthFor();
  var dxS = 2 * (R2 + 0.4 * params.coreR) / p.nx;
  var s = new FluidSolver({
    nx: p.nx, ny: p.nx, nz: p.nx, dx: dxS,
    targetParticles: Math.max(1000, Math.round(p.target * params.oceanVolume)),
    mode: 'sphere', coreR: params.coreR, bumpiness: params.bumpiness,
    sunActivity: params.sunActivity, ceilReflect: params.ceilReflect,
    atmosphereH: params.atmosphereH,
    meltT: params.iceMeltT, evapIntensity: params.evapIntensity
  });
  s.resetWater(oceanDepthFor());
  solver = s;
  solver.substeps = params.substeps;
  solver.pressureIters = params.iters;
  solver.gravity = gravityScaled();
  solver.viscosity = params.viscosity;
  solver.pic = params.pic;
  solver.heatK = params.heatK;
  solver.vorticity = params.vorticity;
  solver.currents = params.currents;
  solver.spinOn = params.particleSpin;
  params.iso = solver.iso;
  $('rangeIso').value = params.iso;
  $('isoVal').textContent = params.iso.toFixed(2);
}

// ---------------------------------------------------------------- Earth mode
// One button: nudge sun activity and the phase-change threshold temperatures
// (slowly, proportional to the observed imbalance) until the particle census
// settles at liquid : ice : vapor = 100 : 10 : 1 within ±10% per fraction —
// or 1500 sim steps elapse. Axial tilt is pinned to Earth's 23.5°.
var EARTH_MAX_STEPS = 1500;
function earthClamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function earthSyncUI() {
  var set = function (id, v) { var el = $(id); if (el) el.value = v; };
  set('rangeSunAct', params.sunActivity); $('sunActVal').textContent = params.sunActivity.toFixed(2);
  set('rangeCloudT', params.cloudT); $('cloudTVal').textContent = params.cloudT.toFixed(2);
  set('rangeRainT', params.rainT); $('rainTVal').textContent = params.rainT.toFixed(2);
  set('rangeSnowT', params.snowT); $('snowTVal').textContent = params.snowT.toFixed(2);
  set('rangeIceMelt', params.iceMeltT); $('iceMeltVal').textContent = params.iceMeltT.toFixed(3);
  set('rangeEvapI', params.evapIntensity); $('evapIVal').textContent = Math.round(params.evapIntensity * 100) + '%';
}
function earthFinish(done) {
  if (!earthCtl) return;
  var rep = earthCtl.report;
  earthCtl = null;
  var b = $('btnEarth');
  if (b) b.innerHTML = '&#127758; Earth mode';
  if (rep) {
    b.title = done ? 'Earth climate reached: ' + rep + ' (click to run again)'
                   : 'Earth mode stopped after ' + EARTH_MAX_STEPS + ' steps: ' + rep;
  }
}
function earthCensus() {
  var nP = solver.nP, fl = solver.pflag, nL = 0, nI = 0, nV = 0;
  for (var p = 0; p < nP; p++) {
    var f = fl[p];
    if (f === 0 || f === 1 || f === 4) nL++;
    else if (f === 5) nI++;
    else if (f === 2 || f === 3) nV++;
  }
  var tot = nL + nI + nV;
  return tot > 0 ? { L: nL / tot, I: nI / tot, V: nV / tot } : null;
}
function earthStep() {
  if (!earthCtl || !solver) return;
  if (earthCtl.steps >= EARTH_MAX_STEPS) { earthFinish(false); return; }
  earthCtl.steps++;
  if (earthCtl.steps % 10 !== 1) return;     // measure every ~10 sim steps
  var c = earthCensus();
  if (!c) return;
  var tL = 100 / 111, tI = 10 / 111, tV = 1 / 111;
  earthCtl.report = 'liquid ' + (c.L * 100).toFixed(1) + '% · ice ' +
    (c.I * 100).toFixed(1) + '% · vapor ' + (c.V * 100).toFixed(1) + '%';
  var b = $('btnEarth');
  if (b) b.innerHTML = '&#127758; Earth ' + (EARTH_MAX_STEPS - earthCtl.steps) +
    ' &mdash; ' + Math.round(c.L * 100) + ':' + Math.round(c.I * 100) + ':' + Math.round(c.V * 100);
  if (Math.abs(c.L - tL) <= 0.1 * tL && Math.abs(c.I - tI) <= 0.1 * tI &&
      Math.abs(c.V - tV) <= 0.1 * tV) { earthFinish(true); return; }
  // Proportional nudges, DAMPED — freezing is a hair trigger (the whole sea
  // locks up within a census once the threshold is crossed) while thawing and
  // evaporating are slow, so every knob moves by at most a few hundredths per
  // census. "Slowly" is not cosmetic: overshoot ratchets the climate.
  // vapor deficit → stronger sun (capped rate), then a cooler vapor point
  // (the temperature knobs share the 0…1.2 slider range)
  var dV = earthClamp((tV - c.V) * 1.2, -0.05, 0.05);
  params.sunActivity = earthClamp(params.sunActivity + dV, 0.05, 2);
  if (dV > 0 && params.sunActivity > 1.9) params.evapIntensity = earthClamp(params.evapIntensity + 0.02, 0.01, 1);
  else if (dV < 0) params.evapIntensity = earthClamp(params.evapIntensity - 0.01, 0.01, 1);
  // ice: the freeze point moves inside a narrow band (a runaway high snow
  // point freezes the whole planet); the melt point tracks it (5% above
  // freezing, the solver invariant). Ice can only thaw by WARMING past the
  // melt point, so a big surplus lowers the whole band (the frozen grains
  // then cross it as soon as daylight warms them) and adds thaw heat.
  var dI = earthClamp((tI - c.I) * 0.6, -0.008, 0.008);
  params.snowT = earthClamp(params.snowT + dI, 0.02, 0.35);
  params.iceMeltT = earthClamp(params.snowT * 1.05, 0.03, 1.2);
  if (c.I > 3 * tI) {
    params.snowT = earthClamp(params.snowT - 0.004, 0.02, 0.35);
    params.iceMeltT = earthClamp(params.snowT * 1.05, 0.03, 1.2);
    params.sunActivity = earthClamp(params.sunActivity + 0.02, 0.05, 2);   // thaw heat
  }
  // preserve the ordered chain snow ≤ rain−0.02 ≤ cloud−0.02 (and slider maxima)
  if (params.snowT > params.rainT - 0.02) params.rainT = earthClamp(params.snowT + 0.02, 0.05, 1.2);
  if (params.rainT > params.cloudT - 0.02) params.cloudT = earthClamp(params.rainT + 0.02, 0.1, 1.2);
  earthSyncUI();
}
$('btnEarth').addEventListener('click', function () {
  if (earthCtl) { earthFinish(false); return; }
  earthCtl = { steps: 0, report: '' };
  params.tiltDeg = 23.5;
  var rt = $('rangeTilt'); if (rt) rt.value = '23.5';
  var tv = $('tiltVal'); if (tv) tv.textContent = '23.5°';
  scene.setTilt(23.5);
  this.innerHTML = '&#127758; Earth: tuning…';
});

// Rebuild solver + world visuals after any world/dimension change.
// The atmosphere height drives the solver's physical ceiling (the limb halo
// itself is hidden — see scene.js).
function worldOpts() {
  return {
    coreR: solver.coreR, oceanR: solver.oceanR,
    terrainRhi: solver.terrain ? solver.terrain.Rhi : solver.oceanR,
    atmosphereH: params.atmosphereH
  };
}

function installWorld(key) {
  buildSolver(key);
  scene.setWorld(solver.W, solver.H, solver.D, worldOpts());
  scene.buildTerrain(solver.terrain, params.planetColor);
  scene.setQuality(RES_PRESETS[activeRes]);
  stirPlane.constant = -solver.cy;
  solver.waveImpulse(1.0);
}
function targetFPS() {
  return $('selRes').value === 'auto50' ? 50 : $('selRes').value === 'auto25' ? 25 : 0;
}
// ------------------------------------------------------- temperature chart
// Particle temperature distribution (bottom-right HUD, beside the stats
// block): a histogram of solver.pT over its working range with FIVE series —
// one grouped column per phase class, split out of the solver's pflag codes
// (0 = fluid water, 1 = droplet spray, 2 = steam, 3 = cloud, 4 = rain,
// 5 = snow/frozen):
//   water  pflag 0/1 — condensed liquid (grid-coupled fluid + ballistic spray)
//   vapor  pflag 2   — airborne steam
//   ice    pflag 5   — the solver's frozen-liquid state (snow: frozen in
//                      place, thaws only past the melt point — the same
//                      population the Earth-mode census counts as ice)
//   rain   pflag 4   — falling condensate
//   cloud  pflag 3   — condensed steam riding the winds
// Every series bins by temperature exactly like the original water/vapor
// pair (36 bins over the normalized 0..1.2 scale) and plots the class's
// per-bin share of the particle population (count / nP) on a LOG10 axis:
// column height = plotH · (log10(share) + 4) / 4, i.e. four full decades
// from 10⁰ (full height) down to the 1e-4 floor (baseline) — shares below
// 1e-4 and empty bins clip to the axis bottom. Decade ticks '10⁰' / '10⁻²'
// plus a small 'log₁₀' tag label the scale.
// Redrawn on the 0.3 s stats tick; skips silently when the canvas is absent
// (headless DOM stubs) so tests without a 2D context stay green.
var T_BINS = 36, T_MAX = 1.2, T_FLOOR_DEC = 4;      // log10 floor = 1e-4
// Hoisted histograms + static series table: a redraw only fill()s the bins
// and repaints — no per-tick allocation.
var _tW = new Array(T_BINS).fill(0), _tV = new Array(T_BINS).fill(0),
    _tI = new Array(T_BINS).fill(0), _tR = new Array(T_BINS).fill(0),
    _tC = new Array(T_BINS).fill(0);
var T_SERIES = [                       // draw order in a bin = legend order;
  { label: 'water', h: _tW, bar: 'rgba(96,176,255,0.85)', sw: 'rgba(96,176,255,0.95)' },
  { label: 'vapor', h: _tV, bar: 'rgba(255,196,110,0.9)', sw: 'rgba(255,196,110,0.95)' },
  { label: 'ice',   h: _tI, bar: '#ffffff', sw: '#ffffff' },
  { label: 'rain',  h: _tR, bar: '#1a4a8a', sw: '#1a4a8a' },
  { label: 'cloud', h: _tC, bar: '#9a9a9a', sw: '#9a9a9a' }
];                                     // water/vapor keep their colors; ice/rain
                                       // cloud are white / dark blue / grey
var _tempCtx = null;
function drawTempChart() {
  var cv = $('tempChart');
  if (!cv || cv.hidden) return;
  if (!_tempCtx) {
    if (!cv.getContext) return;   // headless test stub without 2D context
    _tempCtx = cv.getContext('2d');
  }
  var s = solver;
  if (!s || !s.pT || !s.nP || s.pT.length < s.nP) return;
  var w = cv.width, h = cv.height;
  var wW = _tW, wV = _tV, wI = _tI, wR = _tR, wC = _tC;
  wW.fill(0); wV.fill(0); wI.fill(0); wR.fill(0); wC.fill(0);
  var fl = s.pflag, pT = s.pT, nP = s.nP;
  for (var p = 0; p < nP; p++) {
    var t = pT[p]; if (!(t >= 0)) t = 0; else if (t > T_MAX) t = T_MAX;
    var b = (t * T_BINS / T_MAX) | 0; if (b >= T_BINS) b = T_BINS - 1;
    var f = fl ? fl[p] : 0;
    if (f === 2) wV[b]++;            // steam
    else if (f === 3) wC[b]++;       // cloud
    else if (f === 4) wR[b]++;       // rain
    else if (f === 5) wI[b]++;       // snow = frozen liquid (ice)
    else wW[b]++;                    // 0 fluid + 1 spray = condensed water
  }
  var x0 = 36, x1 = w - 8, yBase = h - 16, yTop = 20;
  var plotH = yBase - yTop, yMid = yTop + plotH * 0.5;
  var bw = (x1 - x0) / T_BINS;
  var slot = bw / T_SERIES.length;               // five grouped columns per bin
  var barW = Math.max(1, slot * 0.8);
  var ctx = _tempCtx;
  ctx.clearRect(0, 0, w, h);
  // legend: five short labels with 7 px swatches, fitted to the 238 px width
  ctx.font = '10px system-ui, sans-serif';
  var lx = 4;
  for (var i = 0; i < T_SERIES.length; i++) {
    ctx.fillStyle = T_SERIES[i].sw;
    ctx.fillRect(lx, 7, 7, 8);
    ctx.fillStyle = '#b9d4e6';
    ctx.fillText(T_SERIES[i].label, lx + 10, 14);
    lx += 10 + T_SERIES[i].label.length * 6 + 5;
  }
  // log10 y axis: decade ticks — 10⁰ at the top, 10⁻² midway, the baseline
  // is the 1e-4 floor — plus the scale tag in the left margin
  ctx.fillStyle = '#6f8ba0';
  ctx.fillText('10\u2070', x0 - 5 - 3 * 6, yTop + 4);
  ctx.fillText('10\u207B\u00B2', x0 - 5 - 4 * 6, yMid + 4);
  ctx.fillText('log\u2081\u2080', 4, yBase - plotH * 0.25 + 4);
  ctx.strokeStyle = 'rgba(160,190,210,0.35)';
  ctx.beginPath();
  ctx.moveTo(x0 - 5, yTop + 0.5); ctx.lineTo(x0, yTop + 0.5);
  ctx.moveTo(x0 - 5, yMid + 0.5); ctx.lineTo(x0, yMid + 0.5);
  ctx.stroke();
  // baseline
  ctx.beginPath(); ctx.moveTo(x0, yBase + 0.5); ctx.lineTo(x1, yBase + 0.5); ctx.stroke();
  // grouped columns: per temperature bin, one column per class, height on
  // the log10 share axis (decades above the 1e-4 floor; clipped below it)
  for (i = 0; i < T_BINS; i++) {
    var xs = x0 + i * bw;
    for (var k = 0; k < T_SERIES.length; k++) {
      var c = T_SERIES[k].h[i];
      if (!c) continue;
      var dec = Math.log10(c / nP) + T_FLOOR_DEC;
      if (dec <= 0) continue;                    // below 1e-4: clips to the bottom
      if (dec > T_FLOOR_DEC) dec = T_FLOOR_DEC;
      var hh = Math.round(plotH * dec / T_FLOOR_DEC);
      if (hh <= 0) continue;
      ctx.fillStyle = T_SERIES[k].bar;
      ctx.fillRect(xs + k * slot, yBase - hh, barW, hh);
    }
  }
  // axis labels (normalized temperature, matching the solver's 0..1.15 scale)
  ctx.fillStyle = '#6f8ba0';
  ctx.fillText('0', x0 - 2, h - 4);
  var lbl = String(T_MAX);
  ctx.fillText(lbl, x1 - lbl.length * 6, h - 4);
  ctx.fillText('particle temperature', x1 - 118, h - 4);
  // phase-change threshold marks: cloud / rain / snow points on the same
  // normalized scale — tick above the axis, letter above the tick
  if (typeof params !== 'undefined' && params) {
    var marks = [
      [params.cloudT, 'C', '#cfd4de'],   // cloud point — light grey
      [params.rainT, 'R', '#6fb7ff'],    // rain point — blue
      [params.snowT, 'S', '#ffffff']     // snow point — white
    ];
    var effR = Math.max(0, Math.min(params.rainT, params.cloudT - 0.02));
    var effS = Math.max(0, Math.min(params.snowT, effR - 0.02));
    marks[1][0] = effR; marks[2][0] = effS;
    for (i = 0; i < marks.length; i++) {
      var tM = marks[i][0];
      if (!(tM > 0) || tM > T_MAX) continue;
      var xm = Math.round(x0 + tM / T_MAX * (x1 - x0)) + 0.5;
      ctx.strokeStyle = marks[i][2];
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.moveTo(xm, yBase - 1); ctx.lineTo(xm, yBase - 9); ctx.stroke();
      ctx.fillStyle = marks[i][2];
      ctx.fillText(marks[i][1], xm - 3, yBase - 12);
      ctx.globalAlpha = 1;
    }
  }
}

// Physics-backend label: a fixed single-thread CPU badge (the solver has one
// execution path — a serial FLIP pipeline on the main thread).
function renderBackend() {
  var be = $('stBackend');
  if (be) be.textContent = 'CPU';
  var badge = $('solverBadge');
  if (badge) {
    badge.textContent = 'Physics: CPU · single thread';
    if (badge.classList) {
      badge.classList.remove('gpu');
      badge.classList.remove('mt');
      badge.classList.add('fallback');
    }
  }
}
function qualityStatus() {
  $('stQuality').textContent = qualityMessage || RES_PRESETS[activeRes].label;
  $('btnCalibrate').disabled = !targetFPS();
}
function rebuildWorld() {
  if (calibrating) return;
  if (targetFPS()) { calibrate(targetFPS()); return; }
  qualityController = null; qualityMessage = '';
  installWorld($('selRes').value);
  qualityStatus();
}
function updateSurface() {
  var start = performance.now();
  solver.splatDensity();
  var mesh = MarchingTetrahedra.build(solver.dens, solver.nx, solver.ny, solver.nz, solver.dx, params.iso);
  scene.updateWater(mesh.pos, mesh.nrm, mesh.count);
  surfaceMs = ema(surfaceMs, performance.now() - start, 0.1);
}
// Metaball display pass: Blinn field over the water particles (radius driven
// by the tension slider) contoured with the same marching-tets mesher; the
// skin is drawn with the water's own material by the scene.
// The tessellation slider scales the metaball field's OWN corner lattice
// around the solver lattice (×0.6 coarse … ×1.4 fine); the shipped default
// ×1.0 keeps the lattice the metaballs shipped with. The slider stores the
// raw 0..1 position — the factor is computed here (and in the readout) from
// this one mapping.
function tessFactor(pos) { return 0.6 + 0.8 * pos; }
function updateMetaballSurface() {
  var start = performance.now();
  var mesh = Metaballs.build(solver, params.metaballTension, tessFactor(params.metaballTess));
  scene.updateMetaballs(mesh.pos, mesh.nrm, mesh.count);
  surfaceMs = ema(surfaceMs, performance.now() - start, 0.1);
}
// Calibration is explicit and precedes the new simulation. Never replace an
// evolving ocean to chase FPS: only render scale adapts after calibration.
function calibrate(fps) {
  calibrating = true;
  requestedTarget = fps;
  var token = ++calibrationToken, index = 0, chosen = null;
  var samples = [], warmup = 0, current = null;
  var refreshSamples = [], previousRefresh = 0, testFPS = fps;
  calibrationResults = [];
  $('loading').style.display = 'flex';
  $('loadingText').textContent = 'Measuring detail for ' + fps + ' FPS…';
  $('panel').inert = true;
  qualityController = null;
  // Loading overlay occludes the controls but not keyboard focus; explicitly
  // end an in-flight drag before the temporary calibration worlds are built.
  stirring = false;
  scene.orbit.enabled = false;
  scene.orbit.dragging = false;
  function finish() {
    if (token !== calibrationToken) return;
    var key = chosen || 'eco';
    if (activeRes !== key) installWorld(key);
    else {
      // Refill only the temporary heated calibration water.
      solver.resetWater(oceanDepthFor());
      solver.waveImpulse(1.0);
      params.iso = solver.iso;
      $('rangeIso').value = params.iso;
      $('isoVal').textContent = params.iso.toFixed(2);
    }
    var level = RES_PRESETS[key];
    qualityController = new AdaptiveQuality.Controller(testFPS, Math.min(window.devicePixelRatio || 1, level.pixelRatio));
    qualityMessage = level.label + ' / ' + fps + ' target' + (chosen ? '' : ' (budget exceeded)');
    qualityStatus();
    calibrating = false; dirty = true;
    scene.orbit.enabled = true;
    $('panel').inert = false;
    $('loading').style.display = 'none';
    lastT = performance.now();
    // Read-only diagnostics for reproducible browser checks.
    window.waterSimPerformance = { targetFPS: fps, measuredBudgetFPS: testFPS, level: key, samples: calibrationResults };
  }
  function calibrationGiveUp(error) {
    console.error('Detail calibration failed', error);
    // Restore a known affordable world, not the potentially expensive
    // failing probe. If rendering itself is unavailable, leave controls
    // usable and report that failure rather than retrying indefinitely.
    try {
      installWorld(chosen || 'eco');
      qualityController = new AdaptiveQuality.Controller(testFPS,
        Math.min(window.devicePixelRatio || 1, RES_PRESETS[activeRes].pixelRatio));
    } catch (restoreError) { console.error('World recovery failed', restoreError); }
    calibrating = false;
    scene.orbit.enabled = true;
    $('panel').inert = false;
    $('loading').style.display = 'none';
    calibrationResults = [];
    qualityMessage = RES_PRESETS[activeRes].label + ' / calibration failed';
    qualityStatus();
    dirty = true; lastT = performance.now();
  }
  function sample(now) {
    try {
      var r = measureSample(now);
      if (r && r.then) r.catch(calibrationGiveUp);
    }
    catch (error) {
      calibrationGiveUp(error);
    }
  }
  async function measureSample(now) {
    if (token !== calibrationToken) return;
    if (document.hidden) { previousRefresh = 0; requestAnimationFrame(sample); return; }
    // RAF can only present on display refresh boundaries. On 60 Hz a 20 ms
    // workload may actually present at 30 FPS, not 50: budget for the nearest
    // attainable refresh divisor ABOVE the requested target (60 / 30 here).
    if (refreshSamples.length < 12) {
      if (previousRefresh && now > previousRefresh && now - previousRefresh < 100) refreshSamples.push(now - previousRefresh);
      previousRefresh = now;
      if (refreshSamples.length === 12) {
        var refreshHz = 1000 / AdaptiveQuality.percentile(refreshSamples, 0.2);
        var divisor = Math.max(1, Math.floor(refreshHz / fps + 0.03));
        testFPS = Math.max(fps, Math.round(refreshHz / divisor));
      }
      requestAnimationFrame(sample); return;
    }
    if (!current) {
      current = AdaptiveQuality.levels[index];
      $('loadingText').textContent = 'Testing ' + current.label + ' (' + current.nx + '³) · ' + fps + ' FPS target';
      installWorld(current.key);
      // Exercise atmosphere rendering during calibration rather than only a
      // fresh, cold ocean. Warm a deterministic particle subset so vapor can
      // develop; these temporary particles are discarded when the tier locks.
      for (var p = 0; p < solver.nP; p++) {
        if (p % 5 === 0) solver.pT[p] = 0.9;
      }
      samples = []; warmup = 0;
      requestAnimationFrame(sample); return;
    }
    var start = performance.now();
    advanceCelestial(params.timeScale / testFPS);
    solver.step(params.timeScale / testFPS);
    updateSurface();
    // measure the metaball display pass too when it is enabled — it replaces
    // the beads/surface work in real frames, so calibration must budget it
    if (params.metaballs) updateMetaballSurface();
    scene.updateParticles(solver, params.showParticles);
    scene.syncBalls(solver.balls);
    scene.render(1 / testFPS);
    // Include completed GPU work, not just WebGL command submission. Only
    // calibration synchronizes: normal frames stay pipelined.
    var gl = scene.renderer.getContext();
    if (gl.finish) gl.finish();
    var cost = performance.now() - start;
    if (++warmup > 8) samples.push(cost);
    if (samples.length < 24) { requestAnimationFrame(sample); return; }
    var pass = AdaptiveQuality.fits(samples, testFPS);
    calibrationResults.push({ level: current.key, p90Ms: AdaptiveQuality.percentile(samples, 0.9), passes: pass });
    if (pass) chosen = current.key;
    // Tiers increase grid, particle, and render costs monotonically. Stop at
    // the first failure; testing still larger tiers would only stall startup.
    if (!pass || ++index >= AdaptiveQuality.levels.length) { finish(); return; }
    current = null;
    requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
}

// -------------------------------------------------------------------- init
function init() {
  var container = $('viewport');
  // Auto mode starts with the cheapest placeholder; measured tiers replace it.
  // The fallback must match the shipped #selRes default (Tiny — 22³) so a
  // programmatic boot without a DOM lands on the same tier as the page.
  buildSolver(targetFPS() ? 'eco' : ($('selRes').value || 'tiny'));
  scene = new WaterScene(container, solver.W, solver.H, solver.D, worldOpts());
  scene.setWaterColor(params.waterColor);
  scene.setWaterOpacity(params.waterOpacity);
  scene.setQuality(RES_PRESETS[activeRes]);
  if (!targetFPS()) {
    scene.buildTerrain(solver.terrain, params.planetColor);
    }
  raycaster = new THREE.Raycaster();
  stirPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -solver.cy);

  bindUI();
  bindPointer(container);
  scene.setParticlesOpacity(params.pOpacity);
  // water-beads display mode defaults ON (checkbox state synced in bindUI):
  // the liquid body renders exclusively as glossy ball particles
  scene.setBeadsMode(params.waterBeads);
  scene.setMetaballs(params.metaballs);
  scene.setMotionBlur(params.motionBlur);
  scene.setStars(params.stars, params.starBrightness);
  scene.setCloudSprite(params.cloudSprite);

  // gentle welcome slosh
  solver.waveImpulse(1.1);
  $('loading').style.display = 'none';

  lastT = performance.now();
  requestAnimationFrame(frame);
  qualityStatus();
  if (targetFPS()) calibrate(targetFPS());
}

// --------------------------------------------------------------------- UI
// bindRange wires a range input to a get/set pair. `map` (optional) puts the
// slider on a nonlinear track: the input then moves in "position" space and
// `map.to`/`map.from` convert to/from the real value, so get/set/fmt keep
// working in real units.
function bindRange(id, outId, get, set, fmt, map) {
  var el = $(id);
  if (!el) return;   // headless fake DOMs (smoke harness) may omit newer controls
  var to = map ? map.to : null, from = map ? map.from : null;
  el.value = to ? to(get()) : get();
  var out = $(outId);
  function refresh() {
    var v = parseFloat(el.value);
    out.textContent = fmt(from ? from(v) : v);
  }
  el.addEventListener('input', function () {
    var v = parseFloat(el.value);
    if (from) v = from(v);
    set(v);
    refresh();
  });
  refresh();
}

function bindUI() {
  // collapsible control panel — starts collapsed so phones see the planet;
  // the ☰ toggle (and the ✕ inside, and the Tab key) flip it
  var panel = $('panel'), btnToggle = $('panelToggle'), btnClose = $('panelClose');
  function setPanel(open) {
    if (!panel) return;
    panel.classList.toggle('collapsed', !open);
    if (btnToggle) {
      btnToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      btnToggle.style.visibility = open ? 'hidden' : 'visible';
    }
  }
  if (btnToggle) btnToggle.addEventListener('click', function () { setPanel(true); });
  if (btnClose) btnClose.addEventListener('click', function () { setPanel(false); });
  setPanel(false);   // collapsed by default (mobile-friendly)
  renderBackend();   // badge is correct from the first frame (no 0.3 s wait)

  // ---- tabbed pages: the control panel is one big centered pane split into
  // five logical groups; every group keeps its own page <div> (id page<Key>)
  // under a tab button (id tab<Key>). Switching is a classList toggle only —
  // no element is created or moved at runtime, so headless DOM stubs stay
  // green (the smoke harness lists the ids explicitly; main.test auto-stubs
  // every index.html id).
  var TABS = ['Physics', 'Display', 'Planet', 'Orbit', 'Climate'];
  var activeTab = 'Physics';
  function showTab(name) {
    activeTab = name;
    for (var i = 0; i < TABS.length; i++) {
      var key = TABS[i];
      var tab = $('tab' + key), page = $('page' + key);
      if (tab) tab.classList.toggle('active', key === name);
      if (page) page.classList.toggle('active', key === name);
    }
  }
  TABS.forEach(function (key) {
    var tab = $('tab' + key);
    if (tab) tab.addEventListener('click', function () { showTab(key); });
  });
  showTab(activeTab);

  $('btnPause').addEventListener('click', function () {
    paused = !paused;
    this.textContent = paused ? '\u25B6 Resume' : '\u23F8 Pause';
  });
  $('btnCalibrate').addEventListener('click', function () {
    if (targetFPS()) calibrate(targetFPS());
  });
  document.addEventListener('visibilitychange', function () { lastT = performance.now(); });
  $('btnReset').addEventListener('click', function () {
    dirty = true;
    solver.resetWater(oceanDepthFor());
    scene.buildTerrain(solver.terrain, params.planetColor);
    params.iso = solver.iso;
    $('rangeIso').value = params.iso;
    $('isoVal').textContent = params.iso.toFixed(2);
  });
  // Splash / wave / drop-ball / stir lost their panel buttons (removed from
  // the UI). Splash and ball-drop stay reachable from the keyboard (S / B);
  // Alt+drag keeps stirring without the toggle button.
  function doSplash() {
    // splash over a real ocean column: the terrain may be land anywhere else
    var pt = solver.oceanPoint(0.15 * worldScale());
    var dxr = pt[0] - solver.cx, dyr = pt[1] - solver.cy, dzr = pt[2] - solver.cz;
    var dl = Math.sqrt(dxr * dxr + dyr * dyr + dzr * dzr) || 1;
    solver.applyImpulseSphere(pt[0], pt[1], pt[2], 0.65 * worldScale(),
      dxr / dl * 3.2, dyr / dl * 3.2, dzr / dl * 3.2);
  }
  function dropPoint() {
    var pt = solver.oceanPoint(0.1 * worldScale());
    var dxr = pt[0] - solver.cx, dyr = pt[1] - solver.cy, dzr = pt[2] - solver.cz;
    var dl = Math.sqrt(dxr * dxr + dyr * dyr + dzr * dzr) || 1;
    var rr = solver.oceanR * 1.46;   // classic drop height (oceanR + 0.9), scaled
    return [solver.cx + dxr / dl * rr, solver.cy + dyr / dl * rr, solver.cz + dzr / dl * rr];
  }
  function dropBall(rho) {
    var p3 = dropPoint();
    solver.addBall(p3[0], p3[1], p3[2], ballRadius(), rho);
  }
  $('btnClearBalls').addEventListener('click', function () { solver.balls.length = 0; });

  bindRange('rangeGravity', 'gravityVal', function () { return params.gravity; },
    function (v) { params.gravity = v; }, function (v) { return v.toFixed(2) + ' m/s\u00B2'; });
  bindRange('rangeVisc', 'viscVal', function () { return params.viscosity; },
    function (v) { params.viscosity = v; }, function (v) { return v.toExponential(1) + ' m\u00B2/s'; });
  bindRange('rangePic', 'picVal', function () { return params.pic; },
    function (v) { params.pic = v; }, function (v) { return v.toFixed(2); });
  bindRange('rangeSubsteps', 'subVal', function () { return params.substeps; },
    function (v) { params.substeps = v | 0; }, function (v) { return String(v | 0); });
  bindRange('rangeIters', 'iterVal', function () { return params.iters; },
    function (v) { params.iters = v | 0; }, function (v) { return String(v | 0); });
  bindRange('rangeTime', 'timeVal', function () { return params.timeScale; },
    function (v) { params.timeScale = v; }, function (v) { return v.toFixed(2) + '\u00D7'; });
  bindRange('rangeIso', 'isoVal', function () { return params.iso; },
    function (v) { params.iso = v; dirty = true; }, function (v) { return v.toFixed(2); });
  bindRange('rangeWOpa', 'wOpaVal', function () { return params.waterOpacity; },
    function (v) { params.waterOpacity = v; scene.setWaterOpacity(v); }, function (v) { return Math.round(v * 100) + '%'; });
  // Spray & atmosphere opacity (water particles) — nonlinear track: the bottom
  // HALF of the slider covers 0–0.1 in uniform 0.0002 steps (0.02% per notch,
  // 50× finer than the old 1% steps) so very faint spray/beads/vapor can be
  // dialled in precisely; the top half covers 0.1–1 in 0.18% steps.
  // `t` = raw range-input position, `o` = real opacity.
  function poToSlider(o) { return o <= 0.1 ? o * 5 : 0.5 + (o - 0.1) / 0.9 * 0.5; }
  function poFromSlider(t) {
    var o = t <= 0.5 ? t * 0.2 : 0.1 + (t - 0.5) * 1.8;
    return Math.round(o * 10000) / 10000;      // keep 0.01% precision
  }
  function poFmt(o) {                          // adaptive % readout for fine steps
    var p = o * 100;
    return (p < 1 ? p.toFixed(2) : p < 10 ? p.toFixed(1) : String(Math.round(p))) + '%';
  }
  bindRange('rangePOpa', 'pOpaVal', function () { return params.pOpacity; },
    function (v) {
      params.pOpacity = v;
      scene.setParticlesOpacity(v);
      lastShowParticles = null;
    }, poFmt, { to: poToSlider, from: poFromSlider });
  bindRange('rangeCloudT', 'cloudTVal', function () { return params.cloudT; },
    function (v) { params.cloudT = v; }, function (v) { return v.toFixed(2); });
  bindRange('rangeCloudP', 'cloudPVal', function () { return params.cloudP; },
    function (v) { params.cloudP = v; }, function (v) { return v.toFixed(2); });
  bindRange('rangeRainT', 'rainTVal', function () { return params.rainT; },
    function (v) { params.rainT = v; }, function (v) { return v.toFixed(2); });
  bindRange('rangeSnowT', 'snowTVal', function () { return params.snowT; },
    function (v) { params.snowT = v; }, function (v) { return v.toFixed(2); });
  bindRange('rangeIceMelt', 'iceMeltVal', function () { return params.iceMeltT; },
    function (v) { params.iceMeltT = v; }, function (v) { return v.toFixed(3); });
  bindRange('rangeEvapI', 'evapIVal', function () { return params.evapIntensity; },
    function (v) { params.evapIntensity = v; },
    function (v) { return Math.round(v * 100) + '%'; });

  bindRange('rangeCore', 'coreVal', function () { return params.coreR; },
    function (v) { params.coreR = v; }, function (v) { return v.toFixed(2) + ' m'; });
  bindRange('rangeOceanV', 'oceanVVal', function () { return params.oceanVolume; },
    function (v) { params.oceanVolume = v; }, oceanVFmt);
  bindRange('rangeBump', 'bumpVal', function () { return params.bumpiness; },
    function (v) { params.bumpiness = v; }, function (v) { return '\u00D7' + v.toFixed(2); });
  bindRange('rangeHeatK', 'heatKVal', function () { return params.heatK; },
    function (v) { params.heatK = v; solver.heatK = v; }, function (v) { return v.toFixed(2); });
  bindRange('rangeVort', 'vortVal', function () { return params.vorticity; },
    function (v) { params.vorticity = v; solver.vorticity = v; }, function (v) { return v.toFixed(2); });
  bindRange('rangeCurr', 'currVal', function () { return params.currents; },
    function (v) { params.currents = v; solver.currents = v; }, function (v) { return v.toFixed(2); });
  bindRange('rangeSunAct', 'sunActVal', function () { return params.sunActivity; },
    function (v) { params.sunActivity = v; solver.sunActivity = v; }, function (v) { return v.toFixed(2); });
  bindRange('rangeAtm', 'atmVal', function () { return params.atmosphereH; },
    function (v) { params.atmosphereH = v; solver.atmosphereH = v; scene.setAtmosphereHeight(v); }, function (v) { return v.toFixed(2) + ' m'; });
  // celestial periods: LOGARITHMIC slider positions (0…1) over a wide
  // physical span — day 5 s … 30 min, year 5 s … 360 min — so the short end
  // stays fine-grained (a linear slider over 360× would be unusable).
  // params store SECONDS; the scene consumes seconds directly.
  var logLo = Math.log(5), spinSpan = Math.log(1800) - logLo, yearSpan = Math.log(21600) - logLo;
  function fmtPeriod(v) {
    if (!(v > 0)) return '\u2014';
    if (v < 60) return v.toFixed(v < 10 ? 1 : 0) + ' s';
    if (v < 600) return (v / 60).toFixed(2) + ' min';
    if (v < 3600) return Math.round(v / 60) + ' min';
    return (v / 3600).toFixed(2) + ' h';
  }
  bindRange('rangeYear', 'yearVal', function () { return params.yearPeriod; },
    function (v) { params.yearPeriod = v; scene.setYearPeriod(v); }, fmtPeriod,
    { to: function (s) { return Math.max(0, Math.min(1, (Math.log(s) - logLo) / yearSpan)); },
      from: function (p) { return Math.exp(logLo + p * yearSpan); } });
  bindRange('rangeSpin', 'spinVal', function () { return params.spinPeriod; },
    function (v) { params.spinPeriod = v; scene.setSpinPeriod(v); }, fmtPeriod,
    { to: function (s) { return Math.max(0, Math.min(1, (Math.log(s) - logLo) / spinSpan)); },
      from: function (p) { return Math.exp(logLo + p * spinSpan); } });
  bindRange('rangeTilt', 'tiltVal', function () { return params.tiltDeg; },
    function (v) { params.tiltDeg = v; scene.setTilt(v); }, function (v) { return v.toFixed(1) + '\u00B0'; });

  // thunderstorm intensity: slider is a log exponent −2…+1 → ×0.01…×10,
  // with the shipped default ×0.1 (value −1); the frame loop applies
  // Math.pow(10, params.thunder) to the lightning rates
  bindRange('rangeStorm', 'stormVal', function () { return params.thunder; },
    function (v) { params.thunder = v; }, function (v) {
      var m = Math.pow(10, v);
      return '\u00D7' + (m >= 10 ? m.toFixed(0) : m >= 1 ? m.toFixed(1) : m.toFixed(2));
    });

  // planet surface color (gouraud-shaded voxel terrain)
  var pickPlanet = $('pickPlanet');
  if (pickPlanet) {
    pickPlanet.value = params.planetColor;
    pickPlanet.addEventListener('input', function () {
      params.planetColor = this.value;
      scene.setPlanetColor(this.value);
    });
  }
  // water hue (surface film + cold end of the particle thermal ramp)
  var pickWater = $('pickWater');
  if (pickWater) {
    pickWater.value = params.waterColor;
    pickWater.addEventListener('input', function () {
      params.waterColor = this.value;
      scene.setWaterColor(this.value);
      lastShowParticles = null;
    });
  }
  // planet dimensions / terrain shape commit on release (change)
  ['rangeCore', 'rangeOceanV', 'rangeBump'].forEach(function (id) {
    $(id).addEventListener('change', rebuildWorld);
  });

  $('chkParticles').addEventListener('change', function () { params.showParticles = this.checked; });
  $('chkSpin').addEventListener('change', function () { params.particleSpin = this.checked; });
  $('chkSpinColor').addEventListener('change', function () { params.spinColor = this.checked; });
  // cloud-sprite display mode: cloud puffs sample the img/cloud_sprite.png
  // atlas tile instead of the procedural circle (display-only switch)
  var chkCloudSprite = $('chkCloudSprite');
  if (chkCloudSprite) {
    params.cloudSprite = chkCloudSprite.checked;
    chkCloudSprite.addEventListener('change', function () {
      params.cloudSprite = this.checked;
      scene.setCloudSprite(params.cloudSprite);
    });
  }

  bindRange('rangeBlur', 'blurVal', function () { return params.motionBlur; },
    function (v) {
      params.motionBlur = v;
      scene.setMotionBlur(v);
    }, function (v) { return v <= 0 ? 'off' : Math.round(v * 100) + '%'; });

  var chkStars = $('chkStars');
  if (chkStars) {
    chkStars.checked = params.stars;
    chkStars.addEventListener('change', function () {
      params.stars = this.checked;
      scene.setStars(params.stars, params.starBrightness);
    });
  }
  bindRange('rangeStars', 'starVal', function () { return params.starBrightness; },
    function (v) {
      params.starBrightness = v;
      scene.setStars(params.stars, params.starBrightness);
    }, function (v) { return '×' + v.toFixed(1); });
  $('chkVectors').addEventListener('change', function () {
    params.showVectors = this.checked;
    scene.setVectorsEnabled(params.showVectors);
    if (params.showVectors) scene.updateVectors(solver);
  });
  // water-beads mode: no isosurface — the liquid body renders exclusively as
  // semi-transparent glossy blue ball particles (physics untouched).
  // Enabled by default: sync the param from the checkbox state.
  var chkBeads = $('chkBeads');
  params.waterBeads = chkBeads.checked;
  chkBeads.addEventListener('change', function () {
    params.waterBeads = this.checked;
    scene.setBeadsMode(params.waterBeads);
    dirty = true;
  });
  // metaball visualization: the liquid body renders as the particles' fused
  // metaball skin (Blinn field + marching tets), drawn with the skin's own
  // material (seeded to match the water; editable in the material editor
  // below). The tension slider drives the metaball kernel radius: low tension
  // keeps particles as separate beads, high tension fuses them into liquid blobs.
  var chkMetaballs = $('chkMetaballs');
  params.metaballs = chkMetaballs.checked;
  chkMetaballs.addEventListener('change', function () {
    params.metaballs = this.checked;
    scene.setMetaballs(params.metaballs);
    dirty = true;
  });
  bindRange('rangeMbla', 'mblaVal', function () { return params.metaballTension; },
    function (v) { params.metaballTension = v; dirty = true; },
    function (v) { return Math.round(v * 100) + '%'; });
  // Metaball tessellation detail: the readout shows the resulting lattice
  // FACTOR (×0.60–×1.40), not the raw slider position — default ×1.00.
  bindRange('rangeMblaTess', 'tessVal', function () { return params.metaballTess; },
    function (v) { params.metaballTess = v; dirty = true; },
    function (v) { return '\u00D7' + tessFactor(v).toFixed(2); });
  // Metaball material editor: five controls on the skin's OWN material
  // (scene.metaballMat) — the regular water surface (waterMat) never sees
  // these calls. Material-only edits: no `dirty` needed (no mesh rebuild).
  // The color follows the water picker until a color is picked here (the
  // scene's sync rule — see setMetaballMaterial / setWaterColor in scene.js).
  // Stub DOMs feed bogus values ('0', unknown options): every handler
  // validates and falls back to the shipped default instead of crashing.
  function mblaShade(v) {   // whitelist: physical (water look) | matte | unlit
    return (v === 'matte' || v === 'unlit') ? v : 'physical';
  }
  function mblaTex(v) {     // whitelist: procedural shader-layer types
    return (v === 'noise' || v === 'caustic' || v === 'stripes') ? v : 'none';
  }
  var mblaColorRe = /^#[0-9a-fA-F]{6}$/;
  var pickMbla = $('pickMbla');
  if (pickMbla) {
    if (!mblaColorRe.test(params.metaballColor)) params.metaballColor = params.waterColor;
    pickMbla.value = params.metaballColor;
    pickMbla.addEventListener('input', function () {
      if (!mblaColorRe.test(this.value)) return;   // ignore malformed picker values
      params.metaballColor = this.value;
      scene.setMetaballMaterial({ color: params.metaballColor });
    });
  }
  var selMblaShade = $('selMblaShade');
  if (selMblaShade) {
    params.metaballShading = mblaShade(params.metaballShading);
    selMblaShade.value = params.metaballShading;
    selMblaShade.addEventListener('change', function () {
      params.metaballShading = mblaShade(this.value);
      selMblaShade.value = params.metaballShading;   // keep the widget on the sanitized value
      scene.setMetaballMaterial({ shading: params.metaballShading });
    });
  }
  var selMblaTex = $('selMblaTex');
  if (selMblaTex) {
    params.metaballTexture = mblaTex(params.metaballTexture);
    selMblaTex.value = params.metaballTexture;
    selMblaTex.addEventListener('change', function () {
      params.metaballTexture = mblaTex(this.value);
      selMblaTex.value = params.metaballTexture;
      scene.setMetaballMaterial({ texture: params.metaballTexture });
    });
  }
  bindRange('rangeMblaOpa', 'mblaOpaVal', function () { return params.metaballOpacity; },
    function (v) {
      params.metaballOpacity = isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.25;
      scene.setMetaballMaterial({ opacity: params.metaballOpacity });
    },
    function (v) { return Math.round(v * 100) + '%'; });
  bindRange('rangeMblaGloss', 'mblaGlaVal', function () { return params.metaballGloss; },
    function (v) {
      params.metaballGloss = isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.85;
      scene.setMetaballMaterial({ gloss: params.metaballGloss });
    },
    function (v) { return Math.round(v * 100) + '%'; });
  // vapor ceiling-bounce probability curve (linear / quadratic / exponential)
  $('selCeil').value = params.ceilReflect;
  $('selCeil').addEventListener('change', function () {
    params.ceilReflect = this.value;
    solver.ceilReflect = params.ceilReflect;
  });
  $('selRes').addEventListener('change', function () {
    rebuildWorld();
  });

  window.addEventListener('keydown', function (e) {
    if (calibrating) return;
    if (e.target && /INPUT|SELECT/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); $('btnPause').click(); }
    else if (e.key === 'r' || e.key === 'R') $('btnReset').click();
    else if (e.key === 's' || e.key === 'S') doSplash();
    else if (e.key === 'b' || e.key === 'B') dropBall(350);
    else if (e.key === 'v' || e.key === 'V') {
      var cv = $('chkVectors');
      cv.checked = !cv.checked;
      params.showVectors = cv.checked;
      scene.setVectorsEnabled(params.showVectors);
      if (params.showVectors) scene.updateVectors(solver);
    }
    else if (e.key === 'p' || e.key === 'P') { $('chkParticles').checked = !$('chkParticles').checked; params.showParticles = $('chkParticles').checked; }
    else if (e.key === 'Tab') {
      e.preventDefault();
      var pn = $('panel');
      if (pn) {
        var opening = pn.classList.toggle('collapsed') === false;
        var tg = $('panelToggle');
        if (tg) tg.style.visibility = opening ? 'hidden' : 'visible';
        if (tg) tg.setAttribute('aria-expanded', opening ? 'true' : 'false');
      }
    }
  });
}

// ----------------------------------------------------------- pointer / stir
function bindPointer(container) {
  var dom = scene.renderer.domElement;

  function stirWorldPoint(e) {
    var rect = dom.getBoundingClientRect();
    var ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, scene.camera);
    var out = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(stirPlane, out)) return null;
    // the planet revolves and spins: convert the hit into the moving planet's
    // local frame so the stirring hand stays glued to the ocean
    scene.planetToLocal(out, out.x, out.y, out.z);
    out.x = Math.max(0.2, Math.min(solver.W - 0.2, out.x));
    out.z = Math.max(0.2, Math.min(solver.D - 0.2, out.z));
    return out;
  }

  dom.addEventListener('pointerdown', function (e) {
    var wantStir = params.stirMode || e.altKey;
    if (!wantStir) return;                       // orbit camera handles it
    var p = stirWorldPoint(e);
    if (!p) return;
    stirring = true;
    handPos = p; handPrev = p.clone();
    scene.orbit.enabled = false;
    dom.setPointerCapture && dom.setPointerCapture(e.pointerId);
  });

  dom.addEventListener('pointermove', function (e) {
    if (!stirring) return;
    var p = stirWorldPoint(e);
    if (p) handPos = p;
  });

  function endStir() {
    stirring = false;
    scene.orbit.enabled = true;
    scene.showHandle(false, 0, 0, 0);
  }
  dom.addEventListener('pointerup', endStir);
  dom.addEventListener('pointercancel', endStir);
}

function applyStir(dt) {
  if (!handPos) return;
  if (dt > 0) {
    var inv = 1 / Math.max(dt, 1 / 120);
    var vx = (handPos.x - handPrev.x) * inv;
    var vy = (handPos.y - handPrev.y) * inv;
    var vz = (handPos.z - handPrev.z) * inv;
    var sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    var cap = 3.5 * worldScale();
    if (sp > cap) { var sc = cap / sp; vx *= sc; vy *= sc; vz *= sc; }
    handVel[0] = ema(handVel[0], vx, 0.5);
    handVel[1] = ema(handVel[1], vy, 0.5);
    handVel[2] = ema(handVel[2], vz, 0.5);
  }
  handPrev.copy(handPos);
  solver.stirAt(handPos.x, handPos.y - 0.25 * worldScale(), handPos.z,
    handVel[0], handVel[1], handVel[2], 0.48 * worldScale(), dt);
  scene.showHandle(true, handPos.x, handPos.y, handPos.z);
}

// ---------------------------------------------------------------- main loop
function frame(now) {
  requestAnimationFrame(frame);
  var rawMs = Math.max(0, now - lastT);
  lastT = now;
  if (calibrating || document.hidden) return;
  var startFrame = performance.now();
  // Display actual wall-clock FPS. Cap only the PHYSICS delta after tab stalls.
  var dt = Math.min(rawMs / 1000, 0.05);
  if (rawMs > 0 && rawMs < 1000) frameMsEma = ema(frameMsEma, rawMs, 0.05);
  fpsEma = 1000 / Math.max(frameMsEma, 0.01);
  if (qualityController && !paused && qualityController.ratio <= 0.66 && fpsEma < qualityController.fps * 0.85) {
    qualityMessage = RES_PRESETS[activeRes].label + ' / ' + requestedTarget + ' target (recalibrate)';
  } else if (qualityController && calibrationResults.length && calibrationResults[0].passes) {
    qualityMessage = RES_PRESETS[activeRes].label + ' / ' + requestedTarget + ' target';
  }

  if (stirring && !paused) applyStir(dt);

  // celestial mechanics: the sun is fixed, the planet revolves around it
  // ("year" slider) and spins about its vertical axis ("day" slider).
  // Time scale drives EVERYTHING equally — solver steps and celestial motion
  // alike — so speeding up time spins the planet faster too.
  advanceCelestial(paused ? 0 : dt * params.timeScale);

  if (!paused && dt > 0) {
    solver.gravity = gravityScaled();
    solver.viscosity = params.viscosity;
    solver.pic = params.pic;
    solver.substeps = params.substeps;
    solver.pressureIters = params.iters;
    solver.vorticity = params.vorticity;
    solver.currents = params.currents;
    solver.sunActivity = params.sunActivity;
    solver.ceilReflect = params.ceilReflect;
    solver.atmosphereH = params.atmosphereH;
    solver.cloudT = params.cloudT;
    solver.cloudP = params.cloudP;
    solver.rainT = params.rainT;
    solver.snowT = params.snowT;
    solver.meltT = params.iceMeltT;
    solver.evapIntensity = params.evapIntensity;
    solver.spinOn = params.particleSpin;
    scene.spinColor = params.spinColor;

    var t0 = performance.now();
    solver.step(dt * params.timeScale);
    earthStep();                    // Earth-mode climate controller (btnEarth)
    dirty = true;
    simMs = ema(simMs, performance.now() - t0, 0.1);

    // dry-surface census: recompute every 10 s of simulated time
    dryTimer += dt * params.timeScale;
    if (dryTimer >= 10) {
      dryTimer = 0;
      $('stDry').textContent = (solver.dryLandFraction() * 100).toFixed(1) + '%';
    }
  }

  // Surface and particle buffers only change with physics or display edits.
  if (dirty || lastShowParticles !== params.showParticles) {
    scene.updateParticles(solver, params.showParticles);
    lastShowParticles = params.showParticles;
  }
  if (dirty) {
    // metaball mode replaces the water body: the liquid renders as the
    // particles' fused metaball skin. Otherwise beads mode skips the
    // marching-tetrahedra pass entirely (no surface to build).
    if (params.metaballs) updateMetaballSurface();
    else if (!params.waterBeads) updateSurface();
    dirty = false;
  }
  // water velocity vectors (Display checkbox) — only while enabled
  if (params.showVectors) scene.updateVectors(solver);
  // lightning over dense vapor pockets; dt=0 freezes the show while paused.
  // Storm intensity = ×10^thunder (log slider −2…+1 → ×0.01…×10, default ×0.1)
  scene.updateLightning(solver, paused ? 0 : dt, params.showParticles && params.pOpacity > 0.01,
    Math.pow(10, params.thunder));
  scene.syncBalls(solver.balls);
  if (!stirring) scene.showHandle(false, 0, 0, 0);
  scene.render(paused ? 0 : dt);
  workMs = performance.now() - startFrame;
  if (qualityController) {
    var ratio = qualityController.observe(rawMs, workMs, !paused && !stirring);
    if (ratio !== null) scene.setQuality({ pixelRatio: ratio });
  }
  window.waterSimStats = { fps: fpsEma, simMs: simMs, surfaceMs: surfaceMs, workMs: workMs,
    level: activeRes, particles: solver.nP, vapor: solver.vaporCount || 0, nightVapor: solver.nightVaporCount || 0 };

  // stats
  statTimer += dt;
  if (statTimer > 0.3) {
    statTimer = 0;
    qualityStatus();
    $('stFps').textContent = fpsEma.toFixed(0);
    $('stSim').textContent = simMs.toFixed(1);
    renderBackend();
    $('stParticles').textContent = solver.nP.toLocaleString();
    $('stAir').textContent = solver.airborneCount;
    $('stVapor').textContent = (solver.vaporCount || 0) + ' / ' + (solver.nightVaporCount || 0);
    drawTempChart();
    $('stUmax').textContent = solver.umax.toFixed(2);
    $('stDt').textContent = (solver.dtLast * 1000).toFixed(2);
  }
}

// Test/inspection hook: live internals for headless probes and the console.
// The application itself never reads this.
window.waterSimDebug = {
  get scene() { return scene; },
  get solver() { return solver; },
  get params() { return params; },
  get activeRes() { return activeRes; },
  RES_PRESETS: RES_PRESETS
};

window.addEventListener('DOMContentLoaded', init);
})();
