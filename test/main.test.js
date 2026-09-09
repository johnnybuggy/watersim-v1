/* Deterministic application-loop integration: no browser/GPU needed. */
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const Q = require('../js/quality.js');
let clock = 0, queue = [], stepCalls = 0, surfaceCalls = 0, particleCalls = 0;
const elements = {}, winListeners = {};
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
  elements[id] = { value: id === 'selRes' ? 'auto50' : '0', style: {}, checked: true, textContent: '',
    handlers: {}, classList: { toggle() {} }, addEventListener(type, fn) { this.handlers[type] = fn; },
    click() { if (this.handlers.click) this.handlers.click.call(this); } };
}
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
}
class Solver {
  constructor(o) { Object.assign(this, o); this.W = this.H = this.D = o.nx * o.dx;
    this.cx = this.cy = this.cz = this.W / 2; this.balls = []; this.nP = 10;
    this.pT = new Float32Array(10); this.dens = []; this.umax = 0; this.dtLast = 0.01; this.airborneCount = 0; }
  resetWater(d) { this.oceanR = this.coreR + d; this.iso = 1.8; this.terrain = {}; }
  step() { clock += this.nx / 3; stepCalls++; }
  waveImpulse() {} splatDensity() { clock += 1; surfaceCalls++; }
  dryLandFraction() { return 0.27; }
}
class Scene {
  constructor() { this.renderer = { domElement: { style: {}, addEventListener() {} }, getContext() { return { finish() {} }; } };
    this.orbit = { enabled: true }; this.sunLocal = new Vector3(3, 3, 3); }
  setWorld() {} buildTerrain() {} setQuality() {} setWaterColor() {}
  setWaterOpacity() {} setParticlesOpacity() {} setSun() {} updateWater() {} updateParticles() { particleCalls++; }
  syncBalls() {} showHandle() {} render() { clock += 1; }
  updatePlanetMotion() {} setYearPeriod() {} setSpinPeriod() {} planetToLocal(out) { return out; }
  setTilt() {} setBeadsMode() {}
  updateVectors() {} updateLightning() {} setVectorsEnabled() {}
}
const context = { document: { hidden: false, getElementById: id => elements[id], addEventListener() {} },
  window: { devicePixelRatio: 1, addEventListener(type, fn) { winListeners[type] = fn; } },
  console, performance: { now: () => clock }, requestAnimationFrame: cb => queue.push(cb),
  AdaptiveQuality: Q, FluidSolver: Solver, WaterScene: Scene,
  MarchingTetrahedra: { build() { return { pos: [], nrm: [], count: 0 }; } },
  THREE: { Vector3, Raycaster: class {}, Plane: class { constructor() { this.constant = 0; } } } };
vm.runInNewContext(fs.readFileSync(require.resolve('../js/main.js'), 'utf8'), context);
function tick(ms = 1000 / 60) { clock += ms; const callbacks = queue; queue = []; const now = clock; callbacks.forEach(cb => cb(now)); }
function calibrated() {
  for (let i = 0; i < 500 && (!context.window.waterSimPerformance || elements.loading.style.display !== 'none'); i++) tick();
  assert(context.window.waterSimPerformance, 'calibration finishes');
}
winListeners.DOMContentLoaded();
calibrated();
assert.equal(context.window.waterSimPerformance.level, 'low', '50fps chooses highest passing refresh-safe tier');
assert.equal(context.window.waterSimPerformance.measuredBudgetFPS, 60, '50fps budgets for 60Hz presentation');
assert.equal(elements.panel.inert, false, 'calibration unlocks controls');
assert.equal(context.window.waterSimPerformance.samples.length, 5, 'calibration stops after first failing tier');
context.window.waterSimPerformance = null;
elements.selRes.value = 'auto25'; elements.selRes.handlers.change();
calibrated();
assert.equal(context.window.waterSimPerformance.level, 'extreme', '25fps permits more detail');
elements.btnPause.click();
tick();
const before = stepCalls, surfaces = surfaceCalls, particles = particleCalls;
for (let i = 0; i < 50; i++) tick(50);
assert.equal(stepCalls, before, 'paused loop does not step');
assert.equal(surfaceCalls, surfaces, 'paused loop reuses mesh');
assert.equal(particleCalls, particles, 'paused loop reuses particle buffers');
elements.chkParticles.checked = false; elements.chkParticles.handlers.change(); tick(50);
assert.equal(particleCalls, particles + 1, 'paused particle toggle updates immediately');
assert(context.window.waterSimStats.fps < 25, 'FPS uses real 50ms intervals, not clamped 30fps');
elements.rangeIso.value = '1.4'; elements.rangeIso.handlers.input(); tick();
assert.equal(surfaceCalls, surfaces, 'beads mode (shipped default) skips surface rebuild while paused');
elements.chkBeads.checked = false; elements.chkBeads.handlers.change(); tick();
assert.equal(surfaceCalls, surfaces + 1, 'leaving beads mode rebuilds the paused surface');
elements.selRes.value = 'tiny'; elements.selRes.handlers.change(); tick();
assert.equal(context.window.waterSimStats.level, 'tiny', 'manual tier works after auto');
assert(elements.btnCalibrate.disabled, 'manual mode disables recalibration button');
console.log('ALL APPLICATION LOOP TESTS PASSED');
