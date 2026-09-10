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
  gravity: 9.81,
  viscosity: 5e-5,
  pic: 0.05,
  substeps: 1,
  iters: 20,
  iso: 1.8,
  pOpacity: 0.5,
  heatK: 0.6,
  vorticity: 0,
  currents: 0,
  coreR: 11,           // default planet radius (m)
  oceanVolume: 3,       // particle-count multiplier on the active preset (×0.1–×50)
  bumpiness: 0.25,
  waterOpacity: 0.25,
  sunActivity: 0.23,    // drives BOTH solar heating and evaporation
  ceilReflect: 'linear',  // vapor ceiling-bounce probability curve: linear|quadratic|exponential
  atmosphereH: 1.65,
  yearPeriod: 20,       // minutes for one revolution around the fixed sun
  spinPeriod: 5,        // minutes for one turn about the planet's axis
  planetColor: '#654321',
  waterColor: '#9fd4ee',
  showParticles: true,
  showVectors: false,
  tiltDeg: 30,
  waterBeads: true,
  thunder: -1,          // log exponent: ×10^-1 = ×0.1 storm rate by default (slider −2…+1 → ×0.01…×10)
  gpuSim: false,        // experimental WebGPU solver — off by default, CPU fallback runs
  mt: true,             // multithreaded CPU solver (worker pool); off when GPU sim is on
  stirMode: false
};

var solver = null, scene = null;
var paused = false;
var stepBusy = false;   // an async (multithreaded) step is in flight
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
  // tear down the outgoing solver's worker pool before it is abandoned
  // (calibration rebuilds worlds several times — stray pools would linger)
  if (solver && solver.mtStatus && solver.mtStatus().active) {
    mtPending = false;
    solver.disableMultithreading();
  }
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
    atmosphereH: params.atmosphereH
  });
  s.resetWater(oceanDepthFor());
  solver = s;
  applyMt();
  solver.substeps = params.substeps;
  solver.pressureIters = params.iters;
  solver.gravity = gravityScaled();
  solver.viscosity = params.viscosity;
  solver.pic = params.pic;
  solver.heatK = params.heatK;
  solver.vorticity = params.vorticity;
  solver.currents = params.currents;
  ensureGpu(s);
  params.iso = solver.iso;
  $('rangeIso').value = params.iso;
  $('isoVal').textContent = params.iso.toFixed(2);
}

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
  if (gpuSim && gpuSim.ready && gpuSim.solver === solver && params.gpuSim) gpuSim.queueImpulse(4, 0, 0, 0, 0, 1.0, 0, 0, 0);
  else solver.waveImpulse(1.0);
}
function targetFPS() {
  return $('selRes').value === 'auto50' ? 50 : $('selRes').value === 'auto25' ? 25 : 0;
}
// ------------------------------------------------------ multithreaded solver
// Worker-pool CPU multithreading (SharedArrayBuffer + workers). The pool
// re-binds the solver's fields to shared memory; the serial path stays the
// physics reference. Disabled while the experimental GPU solver owns stepping.
// Why the worker pool isn't running despite the checkbox — shown on the badge
// so an unsupported environment isn't a silent no-op.
var mtNote = '';
var mtPending = false;   // a switch was requested while a step is in flight
function applyMt() {
  if (!solver) return;
  var supported = typeof MTPool !== 'undefined' && MTPool.supported();
  var want = params.mt && !params.gpuSim && supported;
  var st = solver.mtStatus ? solver.mtStatus() : null;
  mtNote = '';
  if (params.mt && !params.gpuSim && !supported) {
    mtNote = 'SharedArrayBuffer unavailable — serve with `python3 serve.py`';
    if (typeof MTPool === 'undefined') mtNote = 'mt/pool.js not loaded';
  }
  if (want && !(st && st.active)) {
    if (stepBusy) { mtPending = true; renderBackend(); return; }   // apply after the in-flight step
    try {
      solver.enableMultithreading(MTPool.coreCount() - 1);
      st = solver.mtStatus();
      if (!(st && st.active)) mtNote = mtNote || 'worker pool failed to start';
    } catch (e) {
      console.warn('Multithreading unavailable:', e.message);
      mtNote = 'worker pool unavailable: ' + (e.message || e);
      params.mt = false;
      var chk = $('chkMt');
      if (chk) chk.checked = false;
      solver._mtFailed = String(e.message || e);
    }
  } else if (!want && st && st.active) {
    if (stepBusy) { mtPending = false; renderBackend(); return; }  // apply after the in-flight step
    solver.disableMultithreading();
  }
  renderBackend();
}
// ------------------------------------------------------------- GPU solver
// The compute-shader host takes over per-frame dynamics when WebGPU is
// available and the toggle is on. Calibration stays on the CPU (deterministic
// probe worlds); the GPU adopts whichever solver is current when init lands.
var gpuSim = null, gpuToken = 0;
async function ensureGpu(s) {
  if (!params.gpuSim) { gpuNotice('disabled'); return; }
  if (!window.GpuSim) { gpuNotice('unavailable'); return; }
  var token = ++gpuToken;
  try {
    if (!gpuSim) {
      gpuNotice('starting');
      var g = await GpuSim.create();
      if (!g) { params.gpuSim = false; gpuNotice('unavailable'); return; }
      gpuSim = g;
    }
    await gpuSim.initFromSolver(s, params);
    if (token !== gpuToken) { gpuSim.ready = false; return; }  // world changed mid-init
    gpuNotice('WebGPU');
  } catch (e) {
    console.error('GPU solver init failed', e);
    params.gpuSim = false;
    gpuNotice('failed: ' + (e.message || e));
  }
}
// Explicit physics-backend label: the badge always states what integrates the
// solver this frame — WebGPU compute or the fallback CPU solver (and why).
// `backendNote` persists the fallback reason so the 0.3 s stats refresh can't
// overwrite it the way the old one-word stBackend update did. GPU starts off
// (experimental), so the boot note already matches the disabled state.
var backendNote = 'GPU solver disabled in the panel';
function gpuNotice(state) {
  if (state === 'WebGPU') backendNote = '';
  else if (state === 'unavailable') backendNote = 'WebGPU unavailable in this browser';
  else if (state === 'starting') backendNote = 'starting WebGPU…';
  else if (state === 'disabled') backendNote = 'GPU solver disabled in the panel';
  else if (state === 'step failed') backendNote = 'WebGPU step failed — see console';
  else if (state.indexOf('failed') === 0) backendNote = 'WebGPU init failed — see console';
  else backendNote = state;
  renderBackend();
}
function renderBackend() {
  var onGpu = !!(gpuSim && gpuSim.ready && gpuSim.solver === solver && params.gpuSim);
  var st = solver && solver.mtStatus ? solver.mtStatus() : null;
  var onMt = !!(!onGpu && st && st.active);
  var badge = $('solverBadge'), be = $('stBackend');
  if (be) be.textContent = onGpu ? 'GPU · WebGPU' : onMt ? 'CPU · ' + st.threads + ' threads' : 'CPU · single thread';
  if (badge) {
    var note = backendNote || mtNote;
    badge.textContent = onGpu ? 'Physics: GPU · WebGPU compute'
                       : onMt ? 'Physics: CPU · ' + st.threads + ' threads'
                              : 'Physics: CPU · single thread' + (note ? ' · ' + note : '');
    if (badge.classList) {
      badge.classList.toggle('gpu', onGpu);
      badge.classList.toggle('mt', onMt);
      badge.classList.toggle('fallback', !onGpu && !onMt);
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
  // GPU mode: the density field was already read back into solver.dens this frame
  if (!(gpuSim && gpuSim.ready && gpuSim.solver === solver && params.gpuSim)) solver.splatDensity();
  var mesh = MarchingTetrahedra.build(solver.dens, solver.nx, solver.ny, solver.nz, solver.dx, params.iso);
  scene.updateWater(mesh.pos, mesh.nrm, mesh.count);
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
      // Reuse terrain/GPU geometry when the final probe is also the winner;
      // refill only the temporary heated calibration water.
      solver.resetWater(oceanDepthFor());
      solver.waveImpulse(1.0);
      if (gpuSim && gpuSim.solver === solver) gpuSim.reset();
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
    // The multithreaded solver returns a promise (async worker dispatch):
    // calibration measures the FULL physics cost, so await it.
    var stepResult = solver.step(params.timeScale / testFPS);
    if (stepResult && stepResult.then) await stepResult;
    updateSurface();
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
  buildSolver(targetFPS() ? 'eco' : ($('selRes').value || 'medium'));
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
    if (gpuSim && gpuSim.solver === solver) { gpuSim.reset(); }
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
    if (gpuSim && gpuSim.ready && gpuSim.solver === solver && params.gpuSim) {
      gpuSim.queueImpulse(1, pt[0], pt[1], pt[2], 0.65 * worldScale(),
        dxr / dl * 3.2, dyr / dl * 3.2, dzr / dl * 3.2, 0);
    } else {
      solver.applyImpulseSphere(pt[0], pt[1], pt[2], 0.65 * worldScale(),
        dxr / dl * 3.2, dyr / dl * 3.2, dzr / dl * 3.2);
    }
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
  // celestial periods: sliders are in minutes, the scene works in seconds
  bindRange('rangeYear', 'yearVal', function () { return params.yearPeriod; },
    function (v) { params.yearPeriod = v; scene.setYearPeriod(v * 60); }, function (v) { return v.toFixed(1) + ' min'; });
  bindRange('rangeSpin', 'spinVal', function () { return params.spinPeriod; },
    function (v) { params.spinPeriod = v; scene.setSpinPeriod(v * 60); }, function (v) { return v.toFixed(1) + ' min'; });
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
  var chkGpu = $('chkGpu');
  if (chkGpu) {
    params.gpuSim = chkGpu.checked;
    chkGpu.addEventListener('change', function () {
      params.gpuSim = this.checked;
      gpuNotice(params.gpuSim ? 'starting' : 'disabled');
      if (params.gpuSim && !gpuSim && solver) ensureGpu(solver);
      applyMt();   // GPU owns stepping → release the CPU worker pool (and back)
    });
  }
  var chkMt = $('chkMt');
  if (chkMt) {
    var mtSupported = typeof MTPool !== 'undefined' && MTPool.supported();
    if (!mtSupported) {
      // No usable SharedArrayBuffer (file:// or a server without COOP/COEP):
      // the toggle would be a silent no-op — disable it and say why, twice
      // (inline hint for the eye, console line for the why).
      chkMt.checked = false;
      chkMt.disabled = true;
      var proto = (typeof location !== 'undefined' && location.protocol) || '';
      var why = typeof MTPool === 'undefined' ? 'mt/pool.js not loaded'
        : (proto === 'file:' ? 'file:// has no SharedArrayBuffer'
           : 'page is not cross-origin isolated (server sends no COOP/COEP headers)');
      var fix = proto === 'file:'
        ? 'Run `python3 serve.py` locally, or deploy with COOP/COEP headers (README "Deploying").'
        : 'coi-sw.js should add them after a page reload; otherwise set COOP/COEP on the server (README "Deploying").';
      chkMt.title = 'Multithreading needs SharedArrayBuffer — ' + why + ' ' + fix;
      var hint = $('mtHint');
      if (hint) {
        hint.style.display = 'block';
        hint.textContent = 'Needs SharedArrayBuffer — ' + why + ' ' + fix;
      }
      console.warn('Multithreaded solver unavailable: ' + why + ' ' + fix);
      params.mt = false;
    } else {
      chkMt.checked = params.mt;
    }
    chkMt.addEventListener('change', function () {
      if (this.disabled) { this.checked = false; return; }
      params.mt = this.checked;
      applyMt();
    });
  }
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
  if (gpuSim && gpuSim.ready && gpuSim.solver === solver && params.gpuSim) {
    gpuSim.queueImpulse(2, handPos.x, handPos.y - 0.25 * worldScale(), handPos.z,
      0.48 * worldScale(), handVel[0], handVel[1], handVel[2], dt);
  } else {
    solver.stirAt(handPos.x, handPos.y - 0.25 * worldScale(), handPos.z,
      handVel[0], handVel[1], handVel[2], 0.48 * worldScale(), dt);
  }
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

  if (!paused && dt > 0 && !stepBusy) {
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

    var t0 = performance.now();
    if (gpuSim && gpuSim.ready && gpuSim.solver === solver && params.gpuSim) {
      // GPU readback carries no per-particle exposure: drop the CPU-computed
      // mirror so the scene shades particles with the hemispheric fallback.
      if (solver.pLight) solver.pLight = null;
      gpuSim.step(dt * params.timeScale).then(function () { dirty = true; })
        .catch(function (e) { console.error('GPU step failed', e); params.gpuSim = false; gpuNotice('step failed'); });
    } else {
      // multithreaded CPU path steps asynchronously (worker pool + shared
      // memory): the promise resolves when every worker finished this frame;
      // rendering waits for the next tick's dirty flag.
      var r = solver.step(dt * params.timeScale);
      if (r && r.then) {
        stepBusy = true;
        r.then(function () {
          dirty = true; stepBusy = false;
          if (mtPending) { mtPending = false; applyMt(); }   // deferred checkbox switch
        })
         .catch(function (e) {
           console.error('MT step failed', e);
           stepBusy = false; dirty = true;
           if (mtPending) { mtPending = false; applyMt(); }
           // pool faulted mid-run: fall back to serial once instead of
           // error-spamming every frame — the app keeps running
           if (solver && solver.mtStatus && solver.mtStatus().active) {
             mtNote = 'worker pool fault — back to single thread';
             solver.disableMultithreading();
             var chk = $('chkMt');
             if (chk) chk.checked = false;
             params.mt = false;
             renderBackend();
           }
         });
      } else {
        dirty = true;
      }
    }
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
    // beads mode skips the marching-tetrahedra pass entirely (no surface to build)
    if (!params.waterBeads) updateSurface();
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
    // renderBackend owns both backend labels (GPU / MT threads / serial + why);
    // the old hard-coded 'CPU · fallback' here overwrote it every 0.3 s and
    // never reflected the worker pool — the badge seemed stuck on fallback.
    renderBackend();
    $('stParticles').textContent = solver.nP.toLocaleString();
    $('stAir').textContent = solver.airborneCount;
    $('stVapor').textContent = (solver.vaporCount || 0) + ' / ' + (solver.nightVaporCount || 0);
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
  get gpuSim() { return gpuSim; },
  get activeRes() { return activeRes; },
  RES_PRESETS: RES_PRESETS
};

window.addEventListener('DOMContentLoaded', init);
})();
