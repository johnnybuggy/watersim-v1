/*
 * Headless smoke test for the browser-only layers (scene.js, controls.js,
 * surface.js): executes them under Node with DOM/WebGL/canvas stubs so a
 * missing helper or a runtime ReferenceError in browser code fails here
 * instead of silently hanging the real page on its loading overlay.
 *
 * Run: node test/scene.smoke.js
 */
'use strict';

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
  if (!ok) failures++;
}

// ---------------------------------------------------------------- fake canvas 2d
function fakeCtx2d() {
  var grad = { addColorStop: function () {} };
  return {
    fillStyle: null, globalAlpha: 1,
    fillRect: function () {}, beginPath: function () {}, arc: function () {},
    fill: function () {}, stroke: function () {},
    createRadialGradient: function () { return grad; },
    createLinearGradient: function () { return grad; }
  };
}
function fakeCanvas() {
  return { width: 0, height: 0, style: {},
    getContext: function (kind) { return kind === '2d' ? fakeCtx2d() : null; } };
}

// ---------------------------------------------------------------- DOM / window
var listeners = {};
global.window = {
  devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 720,
  addEventListener: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
  removeEventListener: function () {},
  performance: performance
};
global.document = {
  createElement: function (tag) {
    return tag === 'canvas' ? fakeCanvas() : { style: {}, appendChild: function () {} };
  },
  createElementNS: function () { return fakeCanvas(); },
  getElementById: function () { return null; },
  addEventListener: function () {}
};
global.self = global.window;

// ---------------------------------------------------------------- THREE
var THREE = require('../vendor/three.min.js');
global.THREE = THREE;

// WebGLRenderer needs a GL context — replace with a stub that records calls
function StubRenderer() {
  this.domElement = {
    style: {}, clientWidth: 1280, clientHeight: 720,
    addEventListener: function () {}, removeEventListener: function () {},
    setPointerCapture: function () {}, getBoundingClientRect: function () {
      return { left: 0, top: 0, width: 1280, height: 720 };
    }
  };
  this.shadowMap = {};
  this.capabilities = { isWebGL2: true, getMaxAnisotropy: function () { return 8; } };
}
StubRenderer.prototype.setPixelRatio = function () {};
StubRenderer.prototype.setSize = function () {};
StubRenderer.prototype.render = function () {};
StubRenderer.prototype.dispose = function () {};
StubRenderer.prototype.getContext = function () { return {}; };
THREE.WebGLRenderer = StubRenderer;
// PMREMGenerator.fromScene would need a GL context; scene.js catches failures
THREE.PMREMGenerator = function () {
  this.fromScene = function () { throw new Error('no GL in headless test'); };
  this.dispose = function () {};
};

// ---------------------------------------------------------------- load scripts
window.MarchingTetrahedra = null;
require('../js/surface.js');
var MarchingTetrahedra = window.MarchingTetrahedra;
if (!MarchingTetrahedra) throw new Error('surface.js did not register MarchingTetrahedra');

window.OrbitMini = null;
require('../js/controls.js');
var OrbitMini = window.OrbitMini;
if (!OrbitMini) throw new Error('controls.js did not register OrbitMini');

require('../js/scene.js');
var WaterScene = window.WaterScene;
if (!WaterScene) throw new Error('scene.js did not register WaterScene');

// ---------------------------------------------------------------- exercise it
var W = 5.1, H = 5.1, D = 5.1;
var sc = new WaterScene({ clientWidth: 1280, clientHeight: 720, appendChild: function () {} },
  W, H, D, { coreR: 1.5, oceanR: 1.95 });
check('WaterScene constructs (planet visuals, sky, stars)', true);
check('atmosphere limb halo is hidden by default',
  sc._haloMesh && sc._haloMesh.visible === false, 'visible=' + sc._haloMesh.visible);

// vectors + lightning smoke (real scene methods, minimal fake solver)
var fakeS = {
  nP: 4, W: W, H: H, D: D, oceanR: 1.95, atmosphereH: 1, maxSpeed: 3.2, vaporCount: 0,
  px: new Float32Array([2.5, 2.6, 2.5, 2.55]), py: new Float32Array([2.5, 2.5, 2.6, 2.5]),
  pz: new Float32Array([2.5, 2.5, 2.5, 2.6]),
  pvx: new Float32Array([0.4, -0.2, 0, 0.1]), pvy: new Float32Array([0, 0.3, 0, 0]),
  pvz: new Float32Array([0, 0, 0.2, 0]), pflag: new Uint8Array(4)
};
sc.setVectorsEnabled(true);
sc.updateVectors(fakeS);
check('velocity vectors build (4 arrows = 8 vertices)', sc.vecLines.geometry.drawRange.count === 8,
  'drawRange=' + sc.vecLines.geometry.drawRange.count);
sc.updateVectors(fakeS);
sc.setVectorsEnabled(false);
check('vectors disable clears the draw range', sc.vecLines.geometry.drawRange.count === 0);

// moving-average regression: arrows show the MEAN velocity of the last 5
// sampled simulation steps, not the instantaneous value (fresh scene = clean ring)
var scV = new WaterScene({ clientWidth: 320, clientHeight: 200, appendChild: function () {} },
  W, H, D, { coreR: 1.5, oceanR: 1.95 });
var fakeV = {
  nP: 2, W: W, H: H, D: D, oceanR: 1.95, atmosphereH: 1, maxSpeed: 3.2,
  px: new Float32Array([2.5, 2.6]), py: new Float32Array([2.5, 2.5]), pz: new Float32Array([2.5, 2.5]),
  pvx: new Float32Array([1, 0]), pvy: new Float32Array(2), pvz: new Float32Array(2),
  pflag: new Uint8Array(2)
};
scV.setVectorsEnabled(true);
for (var vs = 0; vs < 5; vs++) scV.updateVectors(fakeV);   // five steps at u = +1
fakeV.pvx[0] = 0;                                          // a sixth, calm step
scV.updateVectors(fakeV);
// mean of the last five steps = (1+1+1+1+0)/5 = 0.8; arrow length = mean·kLen
// with kLen = 0.4 per m/s at oceanR 1.95 (world scale 1)
var vAvgDx = scV.vVecPos[3] - scV.vVecPos[0];
check('vector arrows average the last 5 sim steps', Math.abs(vAvgDx - 0.8 * 0.4) < 1e-6,
  'dx=' + vAvgDx.toFixed(4));
scV.setVectorsEnabled(false);
sc.updateLightning(fakeS, 1 / 60, true);
sc.updateLightning(fakeS, 0, true);
sc.updateLightning(null, 1 / 60, false);
sc.updateLightning(fakeS, 1 / 60, true, 10);
sc.updateLightning(fakeS, 1 / 60, true, 0.1);
sc.updateLightning(fakeS, 1 / 60, true, 0.01);
check('lightning update runs (on / paused / off / ×10 / ×0.1 / ×0.01)', true);
check('each flash slot carries a bright-blue bolt channel',
  sc._flashes.length > 0 && sc._flashes.every(function (fl) {
    return fl.bolt && fl.bolt.material.color.getHex() === 0x8fd4ff &&
      fl.bolt.geometry.getAttribute('position').count === sc._BOLT_PTS;
  }),
  'slots=' + sc._flashes.length);
// regression: the flash sprite must carry the soft glow texture — a
// SpriteMaterial without a map renders as an untextured white square
check('flash sprite carries the soft radial glow texture (no bare white square)',
  sc._flashes.length > 0 && sc._flashes.every(function (fl) {
    return fl.sprite.material.map && fl.sprite.material.map.isTexture &&
      fl.sprite.material.blending === THREE.AdditiveBlending;
  }),
  'slots=' + sc._flashes.length);
// bolt geometry: from the pocket down to the ground beneath it
(function () {
  var scB = new WaterScene({ clientWidth: 320, clientHeight: 200, appendChild: function () {} },
    W, H, D, { coreR: 1.5, oceanR: 1.95 });
  var fakeSv = { nP: 1, W: W, H: H, D: D, oceanR: 1.95, atmosphereH: 1,
    terrainRadiusAt: function () { return 1.6; } };   // spherical rock at 1.6 m
  var f = scB._flashes[0];
  scB._strikeBolt(f, W / 2 + 0.9, H / 2 + 2.4, D / 2, fakeSv);
  var pos = f.bolt.geometry.getAttribute('position').array;
  var topR = Math.hypot(pos[0] - W / 2, pos[1] - H / 2, pos[2] - D / 2);
  var botR = Math.hypot(pos[24] - W / 2, pos[25] - H / 2, pos[26] - D / 2);
  var expTop = Math.hypot(0.9, 2.4);                  // exactly the pocket radius
  var expBot = Math.max(1.6, 1.95) + 0.02 * 1.95;     // ground (sea level here) + skim
  check('bolt runs from the vapor pocket to the ground under it',
    f.bolt.visible && Math.abs(topR - expTop) < 1e-6 && Math.abs(botR - expBot) < 1e-6,
    'top=' + topR.toFixed(3) + ' bottom=' + botR.toFixed(3));
})();

// axial tilt smoke: the tilt group carries the fixed angle, the planet still
// spins inside it, and the sun stays a fixed distance away in the local frame
sc.setTilt(23.5);
sc.updatePlanetMotion(1 / 60);
check('axial tilt 23.5° lands on the tilt group',
  Math.abs(sc.tiltGroup.rotation.z - 23.5 * Math.PI / 180) < 1e-9 &&
  Math.abs(sc.planetGroup.rotation.y - sc.spinAngle) < 1e-9 &&
  Math.abs(sc.tiltGroup.position.x - sc._planetWorld.x) < 1e-9,
  'tiltZ=' + sc.tiltGroup.rotation.z.toFixed(4));
sc.setTilt(0);
sc.updatePlanetMotion(1 / 60);
check('tilt 0 restores the classic upright spin', sc.tiltGroup.rotation.z === 0);

// combined particle system smoke: one sorted draw list with per-class sprite
// tiles, per-particle alpha, and camera-relative ordering
sc.setBeadsMode(true);
check('droplet mode hides the surface mesh', sc.waterMesh.visible === false);
var fakeSolver = { nP: 2, px: new Float32Array([2.5, 2.6]), py: new Float32Array([2.5, 2.7]),
  pz: new Float32Array([2.5, 2.5]), pvx: new Float32Array(2), pvy: new Float32Array(2),
  pvz: new Float32Array(2), pflag: new Uint8Array(2), spacing: 0.06, pT: new Float32Array([0.3, 0.3]) };
sc.updateParticles(fakeSolver, true);
check('updateParticles runs', true);
sc.setBeadsMode(false);
sc.updateParticles(fakeSolver, true);
check('liquid particles are represented by the surface, not bead sprites',
  sc._classCounts.beads === 0 && sc._classCounts.spray === 0, 'counts=' + JSON.stringify(sc._classCounts));
sc.setBeadsMode(true);

// circles draw call + water-surface opacity coupling + exposure shading
sc.setBeadsMode(true);
fakeSolver.pLight = new Float32Array([0.9, 0.1]);   // solver-computed sun exposure
// straddle the terminator along the scene's default sun direction
// _sunDirLocal ≈ (0.912, 0.410, 0): bead 0 = night hemisphere, bead 1 = day
fakeSolver.px = new Float32Array([2.55 - 0.5 * 0.912, 2.55 + 0.5 * 0.912]);
fakeSolver.py = new Float32Array([2.55 - 0.5 * 0.410, 2.55 + 0.5 * 0.410]);
fakeSolver.pz = new Float32Array([2.5, 2.5]);
sc.updateParticles(fakeSolver, true);
check('in droplet mode liquid particles draw as flat circles (sprite tile 0)',
  sc.allGeo.drawRange.count === 2 && sc._classCounts.beads === 2 &&
  sc.allSprite[0] === 0 && sc.allSprite[1] === 0 && sc.allAlpha[0] === sc.waterOpa,
  'drawn=' + sc.allGeo.drawRange.count + ' sprite0=' + sc.allSprite[0] + ' alpha0=' + sc.allAlpha[0].toFixed(2));
// exposure shading bakes into the circle colors on the NIGHT side only: the
// night bead (expo 0.1) renders dark, while the day-side bead keeps its
// NORMAL color (sunny-side water is never exposure-darkened)
var dayB = Math.max(sc.allCol[0], sc.allCol[3]), nightB = Math.min(sc.allCol[0], sc.allCol[3]);
check('night-side circles shade darker than day-side ones (planet shadow)',
  Math.abs(nightB / dayB - (0.12 + 0.88 * 0.1)) < 0.05,
  'ratio=' + (nightB / dayB).toFixed(3));
sc.setWaterOpacity(0.3);
sc.updateParticles(fakeSolver, true);
check('circle transparency follows the water-surface opacity slider',
  Math.abs(sc.allAlpha[0] - 0.3) < 1e-6, 'alpha=' + sc.allAlpha[0]);
check('atlas texture is a single combined sprite sheet', sc.atlasTex && sc.allMat.uniforms.uAtlas.value === sc.atlasTex);
// regression: flipY must stay OFF or the shader's aSprite → cell mapping
// samples the mirrored row (snow rendered as the glossy bead = spheres,
// vapor sampled the empty cell and vanished)
check('atlas sampling is row-major (flipY off) so every class gets its own tile',
  sc.atlasTex && sc.atlasTex.flipY === false, 'flipY=' + (sc.atlasTex && sc.atlasTex.flipY));
sc.setBeadsMode(false);
check('leaving droplet mode restores the surface mesh', sc.waterMesh.visible === true);
sc.setBeadsMode(false);
fakeSolver.pflag = new Uint8Array([0, 4]);
fakeSolver.px = new Float32Array([2.5, 2.6]);
sc.updateParticles(fakeSolver, true);
check('leaving beads mode empties the bead draw and restores the surface',
  sc._classCounts.beads === 0 && sc._classCounts.spray === 1 && sc.waterMesh.visible === true,
  'beads=' + sc._classCounts.beads + ' spray=' + sc._classCounts.spray +
  ' rainTile=' + sc.allSprite[0]);
sc.setWaterOpacity(0.68);   // mid-range opacity for the translucent-surface check
check('water surface is glossy and translucent', sc.waterMat.opacity > 0.4 && sc.waterMat.opacity < 0.9 && sc.waterMat.roughness < 0.12);
sc.setQuality({ pixelRatio: 0.8, shadowSize: 512 });
sc.setQuality({ pixelRatio: 0.7 });
check('partial quality updates preserve shadow detail', sc.sun.shadow.mapSize.x === 512);
sc.setAtmosphereHeight(0.7);
check('atmosphere height updates without rebuilding world', sc._haloMesh.scale.x > 0);
// vapor cloudlets are bigger but far fainter than spray droplets
fakeSolver.pflag = new Uint8Array([2, 4]);
fakeSolver.pT = new Float32Array([0.3, 0.3]);
sc.updateParticles(fakeSolver, true);
var vapI = sc.allSprite[0] === 2 ? 0 : 1;
check('vapor renders as broad low-opacity cloudlets (bigger, fainter)',
  sc._classCounts.vapor === 1 && sc.allSprite[vapI] === 2 &&
  sc.allSize[vapI] > 0.1 && sc.allAlpha[vapI] < 0.3,
  'vapor size=' + sc.allSize[vapI].toFixed(3) + ' alpha=' + sc.allAlpha[vapI].toFixed(3));

sc.syncBalls([{ x: 2.55, y: 3.4, z: 2.55, r: 0.3 }]);
check('syncBalls runs', true);

sc.setParticlesOpacity(0.5);
sc.showHandle(false, 0, 0, 0);
sc.render(1 / 60);
check('render frame runs (stubbed GL)', true);

// terrain isosurface mesh — a tiny synthetic rock cube, given as the corner
// lattice field the solver builds (field[c] = R(c) − |c − centre|)
var tn = 8, tdv = 0.4, tsolid = new Uint8Array(tn * tn * tn);
var tfield = new Float32Array((tn + 1) * (tn + 1) * (tn + 1));
for (var tk = 2; tk < 6; tk++) for (var tj = 2; tj < 6; tj++) for (var ti = 2; ti < 6; ti++) {
  tsolid[(tk * tn + tj) * tn + ti] = 1;
  tfield[((tk + 1) * (tn + 1) + (tj + 1)) * (tn + 1) + ti] = 1;   // inside rock
}
for (var fc = 0; fc < tfield.length; fc++) if (tfield[fc] === 0) tfield[fc] = -1;
sc.buildTerrain({ n: tn, dv: tdv, solid: tsolid, R: new Float32Array(tn * tn * tn),
  field: tfield, Rsl: 1.9, Rlo: 1.1, Rhi: 2.2, landFrac: 0.27, seed: 1 });
check('terrain isosurface mesh runs', !!sc._terrainMesh && sc._terrainMesh.userData.vcount > 0,
  'verts=' + (sc._terrainMesh ? sc._terrainMesh.userData.vcount : 0));
sc.setPlanetColor('#123456');
// the picker drives the vertex palette now; the material stays a white
// multiplier so the palette hues (green waterline, snow) read true
var tc = sc._terrainMesh.geometry.getAttribute('color');
check('setPlanetColor runs (palette recolored, material white)',
  sc._terrainMesh.material.color.getHexString() === 'ffffff' && tc && tc.count > 0);
sc.render(1 / 60);
check('render with terrain runs', true);

sc.setWorld(W, H, D, { coreR: 1.2, oceanR: 1.65 });   // rebuild path
check('setWorld rebuild runs', true);
sc.render(1 / 60);
check('render after rebuild runs', true);

// ------------------------------------------------- main.js full-boot smoke
// Fake DOM with every element the app touches, then fire DOMContentLoaded and
// run two frames. If anything in the real startup path throws, this fails.
var IDS = ['stVapor','stQuality','loadingText','btnCalibrate','rangeWOpa','wOpaVal','btnClearBalls','btnPause','btnReset',
  'chkBeads','chkParticles','coreVal','gravityVal','hdr','isoVal','iterVal',
  'heatKVal','currVal','vortVal','rangeCurr','rangeVort','loading','oceanVVal','pOpaVal','panel',
  'pickPlanet','pickWater','rangeBump','bumpVal','rangeSunAct','sunActVal','rangeAtm','atmVal','stDry',
  'picVal','rangeHeatK','rangeCore','rangeGravity','rangeIso','viscVal',
  'rangeIters','rangeOceanV','rangePOpa','rangePic','rangeStorm','rangeSubsteps','rangeTime',
  'rangeTilt','rangeVisc','selRes','selCeil','stAir','stDt','stFps','stParticles','stSim','stUmax','stats',
  'stormVal','subVal','timeVal','tiltVal','viewport','rangeYear','yearVal','rangeSpin','spinVal','chkVectors',
  'stBackend','solverBadge',
  'panelToggle','panelClose','rangeCloudT','cloudTVal','rangeCloudP','cloudPVal',
  'rangeRainT','rainTVal','rangeSnowT','snowTVal',
  'rangeIceMelt','iceMeltVal','rangeEvapT','evapTVal','btnEarth',
  'rangeBlur','blurVal','chkStars','rangeStars','starVal','chkSpin'];
var elements = {};
IDS.forEach(function (id) {
  elements[id] = {
    id: id, style: {}, value: id === 'selRes' ? 'medium' : '0',
    textContent: '', checked: false,
    classList: { toggle: function () {}, add: function () {}, remove: function () {} },
    setAttribute: function () {}, getAttribute: function () { return null; },
    addEventListener: function () {}, removeEventListener: function () {},
    appendChild: function () {},
    clientWidth: 1280, clientHeight: 720
  };
});
var domListeners = {};
global.document.getElementById = function (id) {
  if (!elements[id]) console.error('  [harness] missing fake element: #' + id);
  return elements[id] || null;
};
global.document.addEventListener = function (ev, fn) { (domListeners[ev] = domListeners[ev] || []).push(fn); };

var rafQueue = [];
global.requestAnimationFrame = function (cb) { rafQueue.push(cb); };
global.window.requestAnimationFrame = global.requestAnimationFrame;

// mirror the browser-global registrations onto Node's globalThis
// (solver.js/scene.js register on `window`, which the stub shadows)
global.FluidSolver = window.FluidSolver || require('../js/solver.js');
global.WaterScene = window.WaterScene;
global.MarchingTetrahedra = window.MarchingTetrahedra;
global.OrbitMini = window.OrbitMini;

global.AdaptiveQuality = require('../js/quality.js');
require('../js/main.js');

var bootListeners = (listeners.DOMContentLoaded || []).concat(domListeners.DOMContentLoaded || []);
if (!bootListeners.length) {
  check('main.js registered DOMContentLoaded listener', false);
} else {
  try {
    bootListeners[0]();
    check('main.js init() completes (loading overlay would hide)', elements.loading.style.display === 'none',
      'loading display=' + JSON.stringify(elements.loading.style.display));
    // Run real monotonic timestamps (not 16 ms since process start).
    var frameStart = performance.now();
    for (var fi = 0; fi < 2; fi++) {
      var q2 = rafQueue; rafQueue = [];
      q2.forEach(function (cb) { cb(frameStart + 16 * (fi + 1)); });
    }
    check('two frames step without throwing', rafQueue.length > 0,
      'stats: ' + elements.stFps.textContent + ' fps, ' + elements.stParticles.textContent + ' particles');
    check('physics-backend badge states the active solver explicitly',
      elements.solverBadge.textContent.indexOf('Physics:') === 0 &&
      elements.solverBadge.textContent.indexOf('CPU') !== -1 &&
      elements.solverBadge.textContent.indexOf('single thread') !== -1,
      JSON.stringify(elements.solverBadge.textContent));
    check('stats row names the physics solver', elements.stBackend.textContent.indexOf('CPU') !== -1,
      JSON.stringify(elements.stBackend.textContent));
    var dbg = global.window.waterSimDebug;
    check('shipped boot uses the 11 m default planet on the manual Medium tier',
      dbg && dbg.params.coreR === 11 && dbg.activeRes === 'medium' &&
      dbg.solver && Math.abs(dbg.solver.coreR - 11) < 1e-9,
      'coreR=' + (dbg ? dbg.params.coreR : '-') + ' res=' + (dbg ? dbg.activeRes : '-'));
  } catch (err) {
    console.error(err.stack);
    check('main.js boot runs', false, err.message);
  }
}

console.log('');
if (failures === 0) {
  console.log('ALL SMOKE TESTS PASSED');
} else {
  console.log(failures + ' SMOKE TEST(S) FAILED');
  process.exit(1);
}
