/*
 * WaterSim — multithreaded solver tests.
 *
 * Covers the worker-pool MT mode end to end:
 *   1. pool smoke — enable/disable, status, worker lifecycle
 *   2. parity — full-pipeline MT (particle + grid slicing) vs the serial
 *      reference over many frames (the serial path is the physics contract)
 *   3. determinism — two MT runs at a fixed thread count are bit-identical
 *   4. thermal — heat/evaporation MT ticks match serial
 *   5. invariants — NaN-free, contained, energies bounded on the MT path
 *
 * Run: node test/mt.test.js
 * (Requires SharedArrayBuffer + worker_threads; skips otherwise.)
 */
'use strict';
var path = require('path');
var Solver = require('../js/solver.js');
var MTPOOL = require('../js/mt/pool.js');

var PASS = 0, FAIL = 0;
function check(name, ok, detail) {
  if (ok) { PASS++; console.log('  PASS ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { FAIL++; console.log('  FAIL ' + name + (detail ? '  [' + detail + ']' : '')); }
}
function section(t) { console.log('test: ' + t); }

var SEED_D = 0.25, WATER = 0.4;
function makeSolver(threads) {
  var s = new Solver({ nx: 16, ny: 16, nz: 16, dx: SEED_D, mode: 'sphere', coreR: 0.5, targetParticles: 12000 });
  s.resetWater(WATER);
  s.sunPos = [1, 2, 1];
  if (threads) s.enableMultithreading(threads);
  return s;
}
function stats(s) {
  return { KE: s.kineticEnergy(), umax: s.umax, pvx: s.pvx[0] };
}
function maxAbs(a) { var m = 0; for (var i = 0; i < a.length; i++) { var d = Math.abs(a[i]); if (d > m) m = d; } return m; }
function runSteps(s, n) { for (var i = 0; i < n; i++) s.step(1 / 60); }

if (!MTPOOL.supported()) {
  console.log('SharedArrayBuffer/workers unavailable — MT tests skipped');
  process.exit(0);
}

// ---------------------------------------------------------------------------
section('pool lifecycle');
(function () {
  var s = makeSolver(0);
  var st = s.mtStatus();
  check('inactive before enable', st.active === false);
  s.enableMultithreading(4);
  st = s.mtStatus();
  check('active after enable', st.active === true && st.threads === 4, 'threads=' + st.threads);
  check('state is shared', s.pvx.buffer !== undefined && s.u.BYTES_PER_ELEMENT === 4);
  var KE1 = s.kineticEnergy();
  s.step(1 / 60);
  check('MT step runs', isFinite(s.kineticEnergy()), 'KE=' + s.kineticEnergy().toFixed(3) + ' (was ' + KE1.toFixed(3) + ')');
  s.disableMultithreading();
  st = s.mtStatus();
  check('inactive after disable', st.active === false);
  var KE2 = s.kineticEnergy();
  for (var k = 0; k < 5; k++) s.step(1 / 60);
  // regression guard: an explicit disable must WIN over step()'s lazy
  // re-enable — the UI toggle used to bounce straight back to the pool
  check('stays serial after disable (no lazy re-enable)', s.mtStatus().active === false, 'active=' + s.mtStatus().active);
  check('serial step still runs after disable', isFinite(s.kineticEnergy()), 'KE=' + s.kineticEnergy().toFixed(3) + ' (was ' + KE2.toFixed(3) + ')');
})();

// ---------------------------------------------------------------------------
section('parity — full-pipeline MT vs serial reference (120 frames)');
(function () {
  var ref = makeSolver(0);
  runSteps(ref, 120);

  var mt = makeSolver(4);
  runSteps(mt, 120);
  var a = stats(ref), b = stats(mt);
  var keOk = Math.abs(a.KE - b.KE) < 0.02 * Math.max(1, a.KE);
  var uOk = Math.abs(a.umax - b.umax) < 0.02 * Math.max(0.05, a.umax);
  check('kinetic energy matches serial', keOk, 'serial=' + a.KE.toFixed(2) + ' MT=' + b.KE.toFixed(2));
  check('umax matches serial', uOk, 'serial=' + a.umax.toFixed(3) + ' MT=' + b.umax.toFixed(3));
  // particle velocities: stochastic streams are seeded per (task, worker,
  // tick), so advection diverges from serial at float-roundoff scale only —
  // assert closeness, not bit equality (grid fields ARE bit-identical)
  var dvMax = 0;
  for (var i = 0; i < mt.nP; i++) {
    var d = Math.max(Math.abs(mt.pvx[i] - ref.pvx[i]), Math.abs(mt.pvy[i] - ref.pvy[i]), Math.abs(mt.pvz[i] - ref.pvz[i]));
    if (d > dvMax) dvMax = d;
  }
  check('particle velocities track serial (roundoff only)', dvMax < 1e-4, 'max|dv|=' + dvMax.toExponential(2));
  check('particle count preserved', mt.nP === ref.nP, 'nP=' + mt.nP);
  // grid-MT (default) and particle-MT (grid=serial) both match the reference
  var pmt = makeSolver(4);
  pmt._mtGrid = false;
  runSteps(pmt, 120);
  var c = stats(pmt);
  check('particle-MT (grid=serial) matches serial', Math.abs(c.KE - a.KE) < 0.02 * Math.max(1, a.KE), 'KE=' + c.KE.toFixed(2));
  pmt.disableMultithreading();
  mt.disableMultithreading();
})();

// ---------------------------------------------------------------------------
section('determinism — same thread count, two runs, bit-identical');
(function () {
  var A = makeSolver(4), B = makeSolver(4);
  runSteps(A, 30); runSteps(B, 30);
  var same = true;
  for (var i = 0; i < A.nP; i++) {
    if (A.pvx[i] !== B.pvx[i] || A.pvy[i] !== B.pvy[i] || A.pvz[i] !== B.pvz[i]) { same = false; break; }
  }
  check('particle state bit-identical', same, 'nP=' + A.nP);
  same = true;
  for (i = 0; i < A.u.length; i++) if (A.u[i] !== B.u[i] || A.v[i] !== B.v[i] || A.w[i] !== B.w[i]) { same = false; break; }
  check('grid state bit-identical', same);
  A.disableMultithreading(); B.disableMultithreading();
})();

// ---------------------------------------------------------------------------
section('thermal — heat + evaporation MT parity');
(function () {
  var ref = makeSolver(0), mt = makeSolver(4);
  // strong thermal forcing so heat/evap ticks do real work
  ref.heatK = mt.heatK = 4.0;
  ref.sunPos = mt.sunPos = [2, 3, 1];
  runSteps(ref, 60); runSteps(mt, 60);
  var dT = 0, i;
  for (i = 0; i < mt.pT.length; i++) if (Math.abs(mt.pT[i] - ref.pT[i]) > 1e-6) dT++;
  check('particle temperatures match serial', dT === 0, 'diffs=' + dT + '/' + mt.nP);
  check('vapor counts match', mt.vaporCount === ref.vaporCount, 'MT=' + mt.vaporCount + ' serial=' + ref.vaporCount);
  mt.disableMultithreading();
})();

// ---------------------------------------------------------------------------
section('invariants — NaN-free, contained, finite');
(function () {
  var mt = makeSolver(4);
  runSteps(mt, 90);
  var bad = 0, out = 0, i;
  // containment is planet-relative: the shell (ocean + atmosphere ceiling)
  var R = mt.oceanR + mt.atmosphereH + 0.05, cx = mt.cx, cy = mt.cy, cz = mt.cz;
  for (i = 0; i < mt.nP; i++) {
    if (!isFinite(mt.px[i]) || !isFinite(mt.py[i]) || !isFinite(mt.pz[i]) ||
        !isFinite(mt.pvx[i]) || !isFinite(mt.pvy[i]) || !isFinite(mt.pvz[i])) bad++;
    var dx = mt.px[i] - cx, dy = mt.py[i] - cy, dz = mt.pz[i] - cz;
    if (dx * dx + dy * dy + dz * dz > R * R) out++;
  }
  check('no NaN/Inf particles', bad === 0, 'bad=' + bad);
  check('particles contained', out === 0, 'out=' + out + '/' + mt.nP);
  check('grid velocities finite', isFinite(maxAbs(mt.u)) && isFinite(maxAbs(mt.v)) && isFinite(maxAbs(mt.w)),
    'umax=' + mt.umax.toFixed(3));
  mt.disableMultithreading();
})();

// ---------------------------------------------------------------------------
console.log('');
if (FAIL === 0) console.log('ALL MT TESTS PASSED (' + PASS + ' checks)');
else { console.log('MT TESTS FAILED: ' + FAIL + ' of ' + (PASS + FAIL)); process.exit(1); }
