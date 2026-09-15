/* Deterministic application-loop integration: no browser/GPU needed. */
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const Q = require('../js/quality.js');
let clock = 0, queue = [], stepCalls = 0, surfaceCalls = 0, particleCalls = 0, mbCalls = 0, mbDetail = null;
const mblaMatCalls = [];   // setMetaballMaterial calls received by the scene stub
const cloudSpriteCalls = [];   // setCloudSprite calls received by the scene stub
const elements = {}, winListeners = {};
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const chartCalls = { fillRect: 0, fillText: 0, clearRect: 0, strokes: 0, texts: [], styles: new Set() };
const chartStore = {};
const chartCtx = new Proxy(chartStore, {
  get(_, prop) {
    if (prop === 'fillStyle' || prop === 'strokeStyle' || prop === 'font') return chartStore[prop] || 'x';
    if (prop === 'fillRect') return (x, y, w, h) => {
      if (w > 0 && h > 0) { chartCalls.fillRect++; chartCalls.styles.add(chartStore.fillStyle); } };
    if (prop === 'fillText') return (t) => { chartCalls.fillText++; chartCalls.texts.push(String(t)); };
    if (prop === 'clearRect') return () => chartCalls.clearRect++;
    if (prop === 'beginPath') return () => {};
    if (prop === 'moveTo' || prop === 'lineTo') return () => {};
    if (prop === 'stroke') return () => chartCalls.strokes++;
    return () => {};
  },
  set(_, prop, v) { chartStore[prop] = v; return true; }
});
for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
  elements[id] = { value: id === 'selRes' ? 'auto50' : '0', style: {}, checked: true, textContent: '',
    width: 238, height: 126, hidden: false,
    handlers: {}, classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    setAttribute() {}, getAttribute() { return null; },
    click() { if (this.handlers.click) this.handlers.click.call(this); } };
  if (id === 'tempChart') elements[id].getContext = () => chartCtx;
}
// shipped HTML default: the metaball display checkbox is unchecked
elements.chkMetaballs.checked = false;
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
}
class Solver {
  constructor(o) { Object.assign(this, o); this.W = this.H = this.D = o.nx * o.dx;
    this.cx = this.cy = this.cz = this.W / 2; this.balls = []; this.nP = 10;
    this.pT = new Float32Array([0.05, 0.12, 0.2, 0.32, 0.45, 0.58, 0.7, 0.85, 1.0, 1.1]);
    // one particle of every phase class so all five histogram series have
    // columns: 0 water, 2 steam/vapor, 3 cloud, 4 rain, 5 snow/frozen (ice)
    this.pflag = new Int8Array(10); this.pflag[2] = 2; this.pflag[3] = 3;
    this.pflag[4] = 4; this.pflag[5] = 5; this.pflag[6] = 5; this.pflag[7] = 2;
    this.dens = []; this.umax = 0; this.dtLast = 0.01; this.airborneCount = 0; }
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
  setTilt() {} setBeadsMode() {} setMetaballs() {} setMotionBlur() {} setStars() {}
  setCloudSprite(on) { cloudSpriteCalls.push(on); }
  updateVectors() {} updateLightning() {} setVectorsEnabled() {} updateMetaballs() {}
  setMetaballMaterial(o) { mblaMatCalls.push(Object.assign({}, o)); }
}
const context = { document: { hidden: false, getElementById: id => elements[id], addEventListener() {} },
  window: { devicePixelRatio: 1, addEventListener(type, fn) { winListeners[type] = fn; } },
  console, performance: { now: () => clock }, requestAnimationFrame: cb => queue.push(cb),
  AdaptiveQuality: Q, FluidSolver: Solver, WaterScene: Scene,
  MarchingTetrahedra: { build() { return { pos: [], nrm: [], count: 0 }; } },
  Metaballs: { build(s, t, d) { mbCalls++; mbDetail = d; return { pos: [], nrm: [], count: 0 }; }, iso() { return 3.29; } },
  THREE: { Vector3, Raycaster: class {}, Plane: class { constructor() { this.constant = 0; } } } };
vm.runInNewContext(fs.readFileSync(require.resolve('../js/main.js'), 'utf8'), context);
function tick(ms = 1000 / 60) { clock += ms; const callbacks = queue; queue = []; const now = clock; callbacks.forEach(cb => cb(now)); }
function calibrated() {
  for (let i = 0; i < 500 && (!context.window.waterSimPerformance || elements.loading.style.display !== 'none'); i++) tick();
  assert(context.window.waterSimPerformance, 'calibration finishes');
}
winListeners.DOMContentLoaded();
// Shipped default resolution: index.html marks Tiny (22³) selected and Medium
// no longer carries the attribute (this stub overrides selRes to 'auto50' for
// the calibration assertions, so the shipped default is asserted on the HTML).
assert.match(html, /<option value="tiny" selected>/, 'shipped #selRes default is tiny');
assert.doesNotMatch(html, /<option value="medium" selected>/, 'medium is not the shipped default');
assert.match(html, /<input type="range" id="rangeMblaTess" min="0" max="1" step="0.01" value="0.5">/,
  'shipped #rangeMblaTess default is 0.5 (tessellation factor ×1.00)');
calibrated();
assert.equal(context.window.waterSimPerformance.level, 'low', '50fps chooses highest passing refresh-safe tier');
assert.equal(context.window.waterSimPerformance.measuredBudgetFPS, 60, '50fps budgets for 60Hz presentation');
assert.equal(elements.panel.inert, false, 'calibration unlocks controls');
assert.equal(context.window.waterSimPerformance.samples.length, 5, 'calibration stops after first failing tier');
for (let i = 0; i < 80; i++) tick();   // regular frames → 0.3 s stats tick → chart
// five-series log histogram: the 10 stub particles land in 10 distinct bins →
// ≥10 particle columns + 5 legend swatches per redraw (≥15 fillRects total)
assert.ok(chartCalls.fillRect >= 15, 'temperature chart draws all five series of columns');
assert.ok(chartCalls.fillText >= 8, 'temperature chart draws legend + axis labels');
for (const bar of ['rgba(96,176,255,0.85)', 'rgba(255,196,110,0.9)',
                   '#ffffff', '#1a4a8a', '#9a9a9a']) {
  assert.ok(chartCalls.styles.has(bar), 'chart paints a series in ' + bar);
}
for (const lbl of ['water', 'vapor', 'ice', 'rain', 'cloud']) {
  assert.ok(chartCalls.texts.includes(lbl), 'chart legend labels ' + lbl);
}
assert.ok(chartCalls.texts.includes('10\u2070') && chartCalls.texts.includes('10\u207B\u00B2'),
  'log10 axis shows the 10^0 / 10^-2 decade ticks');
assert.ok(chartCalls.texts.includes('log\u2081\u2080'), 'chart carries the log10 axis tag');
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
elements.chkMetaballs.checked = true; elements.chkMetaballs.handlers.change.call(elements.chkMetaballs); tick();
assert.equal(mbCalls, 1, 'enabling metaballs builds the metaball skin');
assert.equal(mbDetail, 1, 'shipped tessellation default maps to factor ×1.00 (0.6 + 0.8·0.5)');
assert.equal(surfaceCalls, surfaces + 1, 'metaball mode replaces the surface pass (no rebuild)');
elements.chkBeads.checked = true; elements.chkBeads.handlers.change.call(elements.chkBeads); tick();
assert.equal(mbCalls, 2, 'dirty frame in metaball mode rebuilds the metaball skin');
assert.equal(surfaceCalls, surfaces + 1, 'beads toggle never runs the surface pass in metaball mode');
elements.rangeMbla.value = '0.8'; elements.rangeMbla.handlers.input(); tick();
assert.equal(mbCalls, 3, 'tension slider rebuilds the metaball skin');
elements.rangeMblaTess.value = '0.8'; elements.rangeMblaTess.handlers.input(); tick();
assert.equal(mbCalls, 4, 'tessellation slider rebuilds the metaball skin');
assert.equal(mbDetail, 0.6 + 0.8 * 0.8, 'tessellation slider position 0.8 maps to factor 1.24');
assert.equal(elements.tessVal.textContent, '\u00D71.24', 'tessellation readout shows the factor, not the raw position');
assert.equal(context.window.waterSimDebug.params.metaballTess, 0.8, 'slider stores the raw 0..1 position');
elements.chkMetaballs.checked = false; elements.chkMetaballs.handlers.change.call(elements.chkMetaballs); tick();
assert.equal(mbCalls, 4, 'disabling metaballs stops the metaball pass');
assert.equal(surfaceCalls, surfaces + 1, 'metaball off + beads on skips the hidden surface pass');
elements.selRes.value = 'tiny'; elements.selRes.handlers.change(); tick();
assert.equal(context.window.waterSimStats.level, 'tiny', 'manual tier works after auto');
assert(elements.btnCalibrate.disabled, 'manual mode disables recalibration button');
// ---------------------------------------- metaball material editor wiring
// The boot itself already exercised the stub-value tolerance: every element
// was stubbed with value '0' / unknown options and bindUI sanitized them.
const dbgParams = context.window.waterSimDebug.params;
assert.equal(dbgParams.metaballShading, 'physical', 'stub select value sanitized to the shipped shading default');
assert.equal(dbgParams.metaballTexture, 'none', 'stub select value sanitized to the shipped texture default');
assert.equal(dbgParams.metaballOpacity, 0.25, 'shipped editor opacity default');
assert.equal(dbgParams.metaballGloss, 0.85, 'shipped editor gloss default');
assert.match(dbgParams.metaballColor, /^#[0-9a-fA-F]{6}$/, 'shipped editor color default is a validated hex');
assert.equal(mblaMatCalls.length, 0, 'boot pushes no editor call — the skin keeps its water-matched seed');
// color picker: valid hex reaches params + the scene; malformed values are ignored
elements.pickMbla.value = '#ff8800'; elements.pickMbla.handlers.input.call(elements.pickMbla);
assert.equal(dbgParams.metaballColor, '#ff8800', 'color picker updates params.metaballColor');
assert.deepEqual(mblaMatCalls.at(-1), { color: '#ff8800' }, 'color picker calls setMetaballMaterial({color})');
elements.pickMbla.value = '0'; elements.pickMbla.handlers.input.call(elements.pickMbla);   // stub-style garbage
assert.equal(dbgParams.metaballColor, '#ff8800', 'malformed picker value does not clobber the param');
assert.equal(mblaMatCalls.length, 1, 'malformed picker value fires no editor call');
// shading model select: known values pass through, unknown fall back
elements.selMblaShade.value = 'matte'; elements.selMblaShade.handlers.change.call(elements.selMblaShade);
assert.equal(dbgParams.metaballShading, 'matte', 'shading select updates params');
assert.deepEqual(mblaMatCalls.at(-1), { shading: 'matte' }, 'shading select calls setMetaballMaterial({shading})');
elements.selMblaShade.value = 'glossy'; elements.selMblaShade.handlers.change.call(elements.selMblaShade);
assert.equal(dbgParams.metaballShading, 'physical', 'unknown shading value falls back to physical');
assert.deepEqual(mblaMatCalls.at(-1), { shading: 'physical' }, 'fallback still informs the scene');
assert.equal(elements.selMblaShade.value, 'physical', 'widget stays on the sanitized value');
// texture type select: known + unknown
elements.selMblaTex.value = 'caustic'; elements.selMblaTex.handlers.change.call(elements.selMblaTex);
assert.equal(dbgParams.metaballTexture, 'caustic', 'texture select updates params');
assert.deepEqual(mblaMatCalls.at(-1), { texture: 'caustic' }, 'texture select calls setMetaballMaterial({texture})');
elements.selMblaTex.value = '0'; elements.selMblaTex.handlers.change.call(elements.selMblaTex);
assert.equal(dbgParams.metaballTexture, 'none', 'stub/unknown texture value falls back to none');
// opacity + gloss sliders: params + scene call + percent readouts
elements.rangeMblaOpa.value = '0.4'; elements.rangeMblaOpa.handlers.input();
assert.equal(dbgParams.metaballOpacity, 0.4, 'opacity slider updates params');
assert.deepEqual(mblaMatCalls.at(-1), { opacity: 0.4 }, 'opacity slider calls setMetaballMaterial({opacity})');
assert.equal(elements.mblaOpaVal.textContent, '40%', 'opacity readout shows percent');
elements.rangeMblaGloss.value = '0.3'; elements.rangeMblaGloss.handlers.input();
assert.equal(dbgParams.metaballGloss, 0.3, 'gloss slider updates params');
assert.deepEqual(mblaMatCalls.at(-1), { gloss: 0.3 }, 'gloss slider calls setMetaballMaterial({gloss})');
assert.equal(elements.mblaGlaVal.textContent, '30%', 'gloss readout shows percent');
assert.equal(mblaMatCalls.length, 7, 'every editor interaction reached the scene exactly once');
// cloud-sprite display checkbox: param store + scene call (boot applied the
// stub's checked:true default first, so the call log already holds one entry)
elements.chkCloudSprite.checked = false; elements.chkCloudSprite.handlers.change.call(elements.chkCloudSprite);
assert.equal(dbgParams.cloudSprite, false, 'cloud-sprite checkbox stores the param');
assert.equal(cloudSpriteCalls.at(-1), false, 'cloud-sprite toggle off reaches the scene');
elements.chkCloudSprite.checked = true; elements.chkCloudSprite.handlers.change.call(elements.chkCloudSprite);
assert.equal(dbgParams.cloudSprite, true, 'cloud-sprite checkbox stores the re-enabled param');
assert.equal(cloudSpriteCalls.at(-1), true, 'cloud-sprite toggle on reaches the scene');
console.log('ALL APPLICATION LOOP TESTS PASSED');
