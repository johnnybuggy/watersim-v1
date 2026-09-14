/*
 * Headless orbit-geometry test: the sun sits IN the orbital plane so that
 * with axial tilt 0 the irradiation is symmetric between the poles, and
 * with tilt > 0 the sun latitude over the planet oscillates ±tilt (seasons).
 *
 * Run: node test/orbit.test.js
 */
'use strict';

var assert = require('node:assert/strict');

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
THREE.PMREMGenerator = function () {
  this.fromScene = function () { throw new Error('no GL in headless test'); };
  this.dispose = function () {};
};

// ---------------------------------------------------------------- load scripts
window.MarchingTetrahedra = null;
require('../js/surface.js');
if (!window.MarchingTetrahedra) throw new Error('surface.js did not register MarchingTetrahedra');

window.OrbitMini = null;
require('../js/controls.js');
if (!window.OrbitMini) throw new Error('controls.js did not register OrbitMini');

require('../js/scene.js');
var WaterScene = window.WaterScene;
if (!WaterScene) throw new Error('scene.js did not register WaterScene');

// ---------------------------------------------------------------- helpers
var W = 5.1, H = 5.1, D = 5.1;
function makeScene() {
  return new WaterScene({ clientWidth: 320, clientHeight: 200, appendChild: function () {} },
    W, H, D, { coreR: 1.5, oceanR: 1.95 });
}
var YEAR = 1200, DAY = 40;   // seconds; defaults main.js uses are 1200 / 40

function wrapPi(a) {
  a = a % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

var passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
  if (ok) passed++; else failed++;
}

// ---------------------------------------------------------------- (a) tilt 0: sun in equatorial plane
(function () {
  var sc = makeScene();
  sc.setTilt(0);
  sc.setYearPeriod(YEAR);
  sc.setSpinPeriod(DAY);
  var maxAbsY = 0, dists = [];
  var N = 720, step = YEAR / N;
  for (var i = 0; i <= N; i++) {
    sc.updatePlanetMotion(i === 0 ? 0 : step);   // full sampled orbit period
    maxAbsY = Math.max(maxAbsY, Math.abs(sc._sunDirLocal.y));
    var d = sc.sunPos.distanceTo(sc._planetWorld);
    dists.push(d);
  }
  check('tilt 0: sun direction stays in the equatorial plane (_sunDirLocal.y ≈ 0)',
    maxAbsY < 1e-6, 'max|y|=' + maxAbsY.toExponential(2));
  // the planet-sun distance must stay constant (circular orbit at oceanR·3.4)
  var dMin = Math.min.apply(null, dists), dMax = Math.max.apply(null, dists);
  check('tilt 0: orbit is circular at oceanR * 3.4',
    Math.abs(dMin - 1.95 * 3.4) < 1e-6 && Math.abs(dMax - dMin) < 1e-6,
    'dist=' + dMin.toFixed(4) + '…' + dMax.toFixed(4));
})();

// ---------------------------------------------------------------- (b) azimuth sweeps the full circle
(function () {
  var sc = makeScene();
  sc.setTilt(0);
  sc.setYearPeriod(YEAR);
  sc.setSpinPeriod(DAY);
  var N = 720, step = YEAR / N;
  var bins = new Array(360);           // one-degree azimuth coverage bins
  for (var i = 0; i <= N; i++) {
    sc.updatePlanetMotion(i === 0 ? 0 : step);
    var wx = sc.sunPos.x - sc._planetWorld.x,
        wz = sc.sunPos.z - sc._planetWorld.z;
    var az = Math.atan2(wz, wx);
    var bin = Math.floor((az + Math.PI) / (2 * Math.PI) * 360) % 360;
    bins[bin] = true;
  }
  var covered = bins.filter(Boolean).length;
  check('tilt 0: sun azimuth sweeps the full circle (360 one-degree bins hit)',
    covered === 360, 'bins=' + covered + '/360');
})();

// ---------------------------------------------------------------- (c) tilt 23.5°: seasons ±23.5°
(function () {
  var sc = makeScene();
  var TILT = 23.5 * Math.PI / 180;
  sc.setTilt(23.5);
  sc.setYearPeriod(YEAR);
  sc.setSpinPeriod(DAY);
  var N = 1440, step = YEAR / N, latMin = 9, latMax = -9;
  for (var i = 0; i <= N; i++) {
    sc.updatePlanetMotion(i === 0 ? 0 : step);
    var y = sc._sunDirLocal.y;
    var lat = Math.asin(Math.max(-1, Math.min(1, y)));
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
  }
  check('tilt 23.5°: sun latitude oscillates ±23.5° over a year (seasons)',
    Math.abs(latMin + TILT) < 0.01 && Math.abs(latMax - TILT) < 0.01,
    'lat=' + (latMin * 180 / Math.PI).toFixed(2) + '°…' + (latMax * 180 / Math.PI).toFixed(2) + '°');
  // symmetry: the extremes are reached (sun crosses the equator twice a year)
  check('tilt 23.5°: sun crosses the equator (lat 0 is within the swing)',
    latMin < 0 && latMax > 0);
})();

// ---------------------------------------------------------------- (d) planetToLocal inverts the group transform
(function () {
  var sc = makeScene();
  sc.setTilt(23.5);
  sc.setYearPeriod(YEAR);
  sc.setSpinPeriod(DAY);
  var out = new THREE.Vector3();
  var pts = [
    [W * 0.5, H * 0.5, D * 0.5],
    [W * 0.5 + 1.2, H * 0.5, D * 0.5],
    [W * 0.5, H * 0.5 + 0.8, D * 0.5 - 0.7],
    [W * 0.5 - 1.0, H * 0.5 + 0.3, D * 0.5 + 0.9]
  ];
  var times = [0, YEAR * 0.13, YEAR * 0.5, YEAR * 0.87];
  var worst = 0;
  for (var ti = 0; ti < times.length; ti++) {
    sc.updatePlanetMotion(times[ti]);
    var t = sc._tiltRad, ct = Math.cos(t), st = Math.sin(t);
    var cs = Math.cos(sc.spinAngle), sn = Math.sin(sc.spinAngle);
    for (var pi = 0; pi < pts.length; pi++) {
      // forward: local d → world = planetWorld + rotZ(tilt)·rotY(spin)·(d − c)
      // (matches the scene's group transform: planetGroup.position = −rotY(spin)·c)
      var dx = pts[pi][0] - W * 0.5, dy = pts[pi][1] - H * 0.5, dz = pts[pi][2] - D * 0.5;
      var sx = dx * cs + dz * sn, sy = dy, sz = -dx * sn + dz * cs;
      var wxd = sc._planetWorld.x + sx * ct - sy * st,
          wyd = sc._planetWorld.y + sx * st + sy * ct,
          wzd = sc._planetWorld.z + sz;
      sc.planetToLocal(out, wxd, wyd, wzd);
      worst = Math.max(worst,
        Math.hypot(out.x - pts[pi][0], out.y - pts[pi][1], out.z - pts[pi][2]));
    }
  }
  check('planetToLocal inverts tilt+spin for sampled orbit poses',
    worst < 1e-6, 'worst=' + worst.toExponential(2));
})();

// ---------------------------------------------------------------- (e) huge dt wraps canonically
(function () {
  var sc = makeScene();
  sc.setYearPeriod(YEAR);
  sc.setSpinPeriod(DAY);
  sc.updatePlanetMotion(1 / 60);
  var o0 = sc.orbitAngle, s0 = sc.spinAngle;
  sc.updatePlanetMotion(3600);   // 3 years + 90 spins in one step
  var o1 = sc.orbitAngle, s1 = sc.spinAngle;
  var okRange = o1 >= 0 && o1 < 2 * Math.PI && s1 >= 0 && s1 < 2 * Math.PI;
  var okMod = Math.abs(o1 - (o0 + 3600 * 2 * Math.PI / YEAR) % (2 * Math.PI)) < 1e-9 &&
              Math.abs(s1 - (s0 + 3600 * 2 * Math.PI / DAY) % (2 * Math.PI)) < 1e-9;
  check('huge dt (3600 s) keeps orbit/spin angles canonical', okRange && okMod,
    'orbit=' + o1.toFixed(6) + ' spin=' + s1.toFixed(6));
})();

// ---------------------------------------------------------------- sun sprite / shadow frustum sanity
(function () {
  var sc = makeScene();
  sc.setTilt(0);
  sc.updatePlanetMotion(0);
  var ext = Math.max(6, sc.oceanR * 2.2);
  check('shadow frustum still spans the planet after the orbit fix',
    sc.sun.shadow.camera.left === -ext && sc.sun.shadow.camera.right === ext &&
    sc.sun.shadow.camera.top === ext && sc.sun.shadow.camera.bottom === -ext &&
    Math.abs(sc.sun.shadow.camera.near - (sc._sunDist - sc.oceanR * 2)) < 1e-6,
    'ext=' + ext + ' near=' + sc.sun.shadow.camera.near.toFixed(3));
  var d = sc.sunPos.distanceTo(sc._planetWorld);
  var expScale = Math.max(2.2, sc._sunDist * 0.5);
  check('sun sprite apparent size still keys off the planet-sun distance',
    sc.sunSprite.scale.x === expScale && Math.abs(d - sc._sunDist) < 1e-6,
    'dist=' + d.toFixed(3) + ' scale=' + sc.sunSprite.scale.x.toFixed(3));
})();

console.log('');
if (failed === 0) {
  console.log('ALL ORBIT TESTS PASSED (' + passed + ' checks)');
} else {
  console.log(failed + ' ORBIT TEST(S) FAILED (' + passed + ' passed)');
  process.exit(1);
}
