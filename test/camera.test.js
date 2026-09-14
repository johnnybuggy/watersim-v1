/*
 * Headless camera test for OrbitMini (js/controls.js): verifies the FULL
 * polar range — the orbit may pass the equator and look at the planet from
 * below the southern pole — plus damping convergence, zoom limits, and
 * NaN/flip safety of the position math at both poles over a few hundred
 * simulated input events.
 *
 * Run: node test/camera.test.js
 */
'use strict';

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
  if (!ok) failures++;
}

// ---------------------------------------------------------------- DOM / window
// (stubbing preamble mirrors test/scene.smoke.js)
global.window = {
  devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 720,
  addEventListener: function () {},
  removeEventListener: function () {},
  performance: performance
};
global.document = {
  createElement: function () { return { style: {} }; },
  createElementNS: function () { return { style: {} }; },
  getElementById: function () { return null; },
  addEventListener: function () {}
};
global.self = global.window;

// ---------------------------------------------------------------- THREE
var THREE = require('../vendor/three.min.js');
global.THREE = THREE;

// ---------------------------------------------------------------- load script
window.OrbitMini = null;
require('../js/controls.js');
var OrbitMini = window.OrbitMini;
if (!OrbitMini) throw new Error('controls.js did not register OrbitMini');

// ---------------------------------------------------------------- helpers
// Fake event target that records listeners, mirroring the renderer.domElement
// surface OrbitMini touches (addEventListener / setPointerCapture).
function fakeDom() {
  var L = {};
  return {
    listeners: L,
    style: {},
    addEventListener: function (ev, fn) { (L[ev] = L[ev] || []).push(fn); },
    removeEventListener: function () {},
    setPointerCapture: function () {}
  };
}
function fire(dom, ev, e) {
  (dom.listeners[ev] || []).forEach(function (fn) { fn(e); });
}

// A rig with a REAL PerspectiveCamera: exercises three.js lookAt (up vector
// vs. view direction) at the poles — the degenerate case a fake would hide.
function makeRig() {
  var cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 220);
  var dom = fakeDom();
  var target = new THREE.Vector3(2.55, 2.0, 2.55);
  var orbit = new OrbitMini(cam, dom, target);
  return { orbit: orbit, cam: cam, dom: dom, target: target, cursor: { x: 100, y: 100 } };
}

// every matrixWorld element and position component must stay finite
function finiteCamera(cam) {
  cam.updateMatrixWorld();
  var p = cam.position, m = cam.matrixWorld.elements;
  for (var i = 0; i < m.length; i++) if (!isFinite(m[i])) return false;
  return isFinite(p.x) && isFinite(p.y) && isFinite(p.z);
}
function camDist(rig) {
  return Math.sqrt(
    (rig.cam.position.x - rig.target.x) * (rig.cam.position.x - rig.target.x) +
    (rig.cam.position.y - rig.target.y) * (rig.cam.position.y - rig.target.y) +
    (rig.cam.position.z - rig.target.z) * (rig.cam.position.z - rig.target.z));
}
// press, then drag RELATIVE deltas of (dx, dy) px, advancing damping `frames`
// per step — the handler reads movement vs. the previous event position
function press(rig) {
  rig.cursor.x = 100; rig.cursor.y = 100;
  fire(rig.dom, 'pointerdown', { button: 0, clientX: rig.cursor.x, clientY: rig.cursor.y, pointerId: 1 });
}
function dragFrame(rig, dx, dy, frames) {
  rig.cursor.x += dx; rig.cursor.y += dy;
  fire(rig.dom, 'pointermove', { clientX: rig.cursor.x, clientY: rig.cursor.y });
  for (var i = 0; i < (frames || 1); i++) rig.orbit.update();
}
function wheelBy(rig, deltaY, n, frames) {
  for (var i = 0; i < (n || 1); i++) {
    fire(rig.dom, 'wheel', { deltaY: deltaY, preventDefault: function () {} });
  }
  for (var j = 0; j < (frames || 300); j++) rig.orbit.update();   // let damping settle
}

// ---------------------------------------------------------------- 1. limits
console.log('polar limits:');
(function () {
  var rig = makeRig();
  check('full polar range installed (minPhi ≈ +0, maxPhi ≈ π−)',
    rig.orbit.minPhi === 0.01 && Math.abs(rig.orbit.maxPhi - (Math.PI - 0.01)) < 1e-12,
    'minPhi=' + rig.orbit.minPhi + ' maxPhi=' + rig.orbit.maxPhi.toFixed(4));
  check('theta stays unrestricted (tTheta tracks raw drags)', (function () {
    var t0 = rig.orbit.tTheta;
    press(rig);
    for (var i = 0; i < 40; i++) dragFrame(rig, -30, 0, 0);
    fire(rig.dom, 'pointerup', {});
    return rig.orbit.tTheta > t0 + 1;          // 40 × 30 px × 0.0055 ≈ 6.6 rad past full circle, no clamp
  })(), 'tTheta=' + rig.orbit.tTheta.toFixed(3));
})();

// ------------------------------------------------- 2. under the south pole
console.log('full polar sweep:');
(function () {
  var rig = makeRig();
  press(rig);
  // drag UP hard: dy < 0 pushes phi toward π (below the southern pole)
  for (var i = 0; i < 60; i++) dragFrame(rig, 0, -20, 2);
  var below = rig.cam.position.y - rig.target.y < -0.9 * rig.orbit.radius;
  check('dragging reaches phi ≈ π — camera looks up from UNDER the south pole',
    rig.orbit.tPhi === rig.orbit.maxPhi && rig.orbit.phi > Math.PI - 0.05 && below,
    'phi=' + rig.orbit.phi.toFixed(5) + ' (max ' + rig.orbit.maxPhi.toFixed(4) + ')' +
    ' camY−targetY=' + (rig.cam.position.y - rig.target.y).toFixed(3) + ' radius=' + rig.orbit.radius.toFixed(2));
  check('camera math stays finite at the south pole (real lookAt, matrixWorld)',
    finiteCamera(rig.cam) && Math.abs(camDist(rig) - rig.orbit.radius) < 1e-6,
    'dist=' + camDist(rig).toFixed(6) + ' target radius=' + rig.orbit.radius.toFixed(3));
  check('horizontal drift at the pole stays tiny (spherical basis not degenerate)',
    Math.hypot(rig.cam.position.x - rig.target.x, rig.cam.position.z - rig.target.z) < 0.2 * rig.orbit.radius);

  // sweep all the way back to the north pole, sampling every frame
  var sawNaN = false, minSeen = Infinity, maxSeen = -Infinity;
  for (var s = 0; s < 120; s++) {
    dragFrame(rig, s % 3, 30, 2);              // dy > 0 pulls phi toward 0
    if (!finiteCamera(rig.cam)) sawNaN = true;
    minSeen = Math.min(minSeen, rig.orbit.phi);
    maxSeen = Math.max(maxSeen, rig.orbit.phi);
  }
  var above = rig.cam.position.y - rig.target.y > 0.9 * rig.orbit.radius;
  check('full sweep south→north crosses the equator without NaN',
    !sawNaN && rig.orbit.tPhi === rig.orbit.minPhi && above,
    'phi=' + rig.orbit.phi.toFixed(5) + ' camY−targetY=' + (rig.cam.position.y - rig.target.y).toFixed(3));
  check('sampled phi stayed inside (0, π) the whole way',
    minSeen > 0 && maxSeen < Math.PI && isFinite(minSeen) && isFinite(maxSeen),
    'min=' + minSeen.toFixed(4) + ' max=' + maxSeen.toFixed(4));
  fire(rig.dom, 'pointerup', {});
})();

// --------------------------------------------------- 3. damping convergence
console.log('damping:');
(function () {
  var rig = makeRig();
  press(rig);
  dragFrame(rig, -45, 25, 1);                  // new targets mid-drag
  wheelBy(rig, -300, 3);
  fire(rig.dom, 'pointerup', {});
  for (var i = 0; i < 200; i++) rig.orbit.update();   // no further input
  var dPhi = Math.abs(rig.orbit.phi - rig.orbit.tPhi);
  var dTheta = Math.abs(rig.orbit.theta - rig.orbit.tTheta);
  var dRad = Math.abs(rig.orbit.radius - rig.orbit.tRadius);
  check('angles + radius converge to their targets (inertia feel preserved)',
    dPhi < 1e-6 && dTheta < 1e-6 && dRad < 1e-6,
    'dPhi=' + dPhi.toExponential(1) + ' dTheta=' + dTheta.toExponential(1) + ' dRad=' + dRad.toExponential(1));
  var px = rig.cam.position.x, py = rig.cam.position.y, pz = rig.cam.position.z;
  rig.orbit.update();
  var settled = Math.abs(rig.cam.position.x - px) + Math.abs(rig.cam.position.y - py) +
    Math.abs(rig.cam.position.z - pz) < 1e-9;
  check('camera position settles (no residual drift / jitter)', settled && finiteCamera(rig.cam));
})();

// --------------------------------------------------------- 4. zoom limits
console.log('zoom:');
(function () {
  var rig = makeRig();
  wheelBy(rig, -250, 90);                      // zoom in hard
  check('zoom-in clamps at minRadius', rig.orbit.tRadius === rig.orbit.minRadius &&
    Math.abs(rig.orbit.radius - rig.orbit.minRadius) < 1e-6,
    'tRadius=' + rig.orbit.tRadius.toFixed(4) + ' min=' + rig.orbit.minRadius);
  wheelBy(rig, 250, 140);                      // zoom out hard
  check('zoom-out clamps at maxRadius', rig.orbit.tRadius === rig.orbit.maxRadius &&
    Math.abs(rig.orbit.radius - rig.orbit.maxRadius) < 1e-6,
    'tRadius=' + rig.orbit.tRadius.toFixed(4) + ' max=' + rig.orbit.maxRadius);
  // scene.js rescales the limits per world (planet 0.5–25 m): new limits must
  // be honored immediately, including approaching closer than the old floor
  rig.orbit.minRadius = 0.9; rig.orbit.maxRadius = 30;
  wheelBy(rig, 400, 1);
  check('widened maxRadius responds (pull away from small planets)', rig.orbit.tRadius > 16,
    'tRadius=' + rig.orbit.tRadius.toFixed(3));
  wheelBy(rig, -4000, 1);
  check('shrunk minRadius responds (approach small planets)', rig.orbit.tRadius === 0.9,
    'tRadius=' + rig.orbit.tRadius.toFixed(3));
  check('camera finite at the new limits', finiteCamera(rig.cam));
})();

// ------------------------------------- 5. degenerate-limit position guard
console.log('degenerate guards:');
(function () {
  var rig = makeRig();
  // external code (or a future edit) sets the limits to the EXACT axis: the
  // update() must clamp the effective phi off 0/π so the basis never dies
  rig.orbit.minPhi = 0; rig.orbit.maxPhi = Math.PI;
  rig.orbit.tPhi = 0;
  for (var i = 0; i < 80; i++) rig.orbit.update();
  var d = camDist(rig);
  check('phi = 0 exactly still yields finite, correct-radius camera math',
    finiteCamera(rig.cam) && Math.abs(d - rig.orbit.radius) < 1e-6 &&
      Math.abs(rig.cam.position.y - rig.target.y) > 0.99 * rig.orbit.radius,
    'dist=' + d.toFixed(6) + ' radius=' + rig.orbit.radius.toFixed(3));
  rig.orbit.tPhi = Math.PI;
  for (var j = 0; j < 80; j++) rig.orbit.update();
  check('phi = π exactly still yields finite, correct-radius camera math',
    finiteCamera(rig.cam) && Math.abs(camDist(rig) - rig.orbit.radius) < 1e-6 &&
      Math.abs(rig.cam.position.y - rig.target.y) > 0.99 * rig.orbit.radius,
    'dist=' + camDist(rig).toFixed(6));
  // NaN wheel delta must not poison the state
  var r2 = makeRig();
  fire(r2.dom, 'wheel', { deltaY: NaN, preventDefault: function () {} });
  r2.orbit.update();
  check('NaN wheel delta is ignored (radius stays finite)',
    isFinite(r2.orbit.tRadius) && isFinite(r2.orbit.radius) && finiteCamera(r2.cam),
    'tRadius=' + String(r2.orbit.tRadius));
})();

// ------------------------------------- 6. plain-object camera contract
console.log('camera contract:');
(function () {
  var got = null, look = null;
  var stub = {
    position: { set: function (x, y, z) { got = [x, y, z]; } },
    lookAt: function (v) { look = v; }
  };
  var o = new OrbitMini(stub, fakeDom(), new THREE.Vector3(0, 0, 0));  // explicit target
  o.tPhi = o.maxPhi;
  for (var i = 0; i < 200; i++) o.update();    // let damping carry phi to the pole
  check('a bare {position.set, lookAt} camera works below the south pole',
    got && got.every(isFinite) && look !== null && Math.abs(got[1] + o.radius) < 0.01 * o.radius,
    'pos=' + JSON.stringify(got));
  got = null;
  var o2 = new OrbitMini(stub, fakeDom());     // default target path (THREE.Vector3)
  o2.update();
  check('constructor default target still works', got && got.every(isFinite));
})();

// ------------------------------------- 7. fuzz: a few hundred input events
console.log('fuzz (300 events):');
(function () {
  var rig = makeRig();
  var seed = 42;
  function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  var bad = 0, threw = null;
  try {
    for (var i = 0; i < 300; i++) {
      var kind = (rnd() * 5) | 0;
      if (kind === 0) {
        fire(rig.dom, 'pointerdown', { button: rnd() < 0.9 ? 0 : 1, clientX: rnd() * 1280, clientY: rnd() * 720, pointerId: 1 });
      } else if (kind === 1) {
        fire(rig.dom, 'pointermove', { clientX: rnd() * 1280, clientY: rnd() * 720 });
      } else if (kind === 2) {
        fire(rig.dom, rnd() < 0.5 ? 'pointerup' : 'pointercancel', {});
      } else if (kind === 3) {
        fire(rig.dom, 'wheel', { deltaY: (rnd() - 0.5) * 600, preventDefault: function () {} });
      } else {
        fire(rig.dom, 'pointerleave', {});
      }
      rig.orbit.update();
      if (!finiteCamera(rig.cam)) bad++;
      if (!(rig.orbit.tPhi >= rig.orbit.minPhi - 1e-12 && rig.orbit.tPhi <= rig.orbit.maxPhi + 1e-12)) bad++;
      if (!(rig.orbit.phi >= rig.orbit.minPhi - 1e-12 && rig.orbit.phi <= rig.orbit.maxPhi + 1e-12)) bad++;
      if (!(rig.orbit.radius >= Math.min(rig.orbit.minRadius, rig.orbit.maxRadius) - 1e-9 &&
            rig.orbit.radius <= Math.max(rig.orbit.minRadius, rig.orbit.maxRadius) + 1e-9)) bad++;
    }
  } catch (err) { threw = err; }
  check('300 mixed input events: no exception, state in range, camera finite',
    threw === null && bad === 0, threw ? threw.message : 'violations=' + bad);
  // keep damping toward wherever the fuzz left the targets
  for (var k = 0; k < 300; k++) rig.orbit.update();
  check('state converges after the storm', finiteCamera(rig.cam) &&
    Math.abs(rig.orbit.phi - rig.orbit.tPhi) < 1e-6 &&
    Math.abs(rig.orbit.radius - rig.orbit.tRadius) < 1e-6);
})();

// ---------------------------------------------------------------- summary
console.log('');
if (failures === 0) {
  console.log('ALL CAMERA TESTS PASSED');
} else {
  console.log(failures + ' CAMERA TEST(S) FAILED');
  process.exit(1);
}
