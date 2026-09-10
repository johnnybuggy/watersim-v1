/*
 * WaterSim — multithreaded solver worker (Node worker_threads entry).
 *
 * Lives in a busy-wait mailbox loop over a small SharedArrayBuffer control
 * region: the pool writes one job (task codes + per-worker range + scalar
 * params), bumps JOB and notifies; the worker executes its chunk against the
 * shared solver state and increments DONE. This keeps the whole solver step
 * SYNCHRONOUS on the main thread (Atomics.wait), so the existing headless
 * tests exercise the multithreaded path unchanged.
 */
'use strict';
var worker_threads = require('worker_threads');
var D = worker_threads.workerData;

var tasks = require(D.tasksPath);
var FluidSolver = require(D.solverPath);

// ---- build views over the shared buffers ------------------------------------
function buildViews(layout, sab) {
  var CTOR = [Float32Array, Float64Array, Uint8Array, Int32Array];
  var out = {};
  for (var i = 0; i < layout.length; i++) {
    var f = layout[i];
    out[f.name] = new CTOR[f.c](sab, f.off, f.len);
  }
  return out;
}

var views = buildViews(D.layout, D.state);
var meta = D.meta;

// ---- the worker solver --------------------------------------------------------
// The alloc hook resolves SHARED fields to the same SAB addresses the main
// thread uses; anything not in the layout (private scratch) is fresh.
var alloc = function (name, ctor, len) {
  if (Object.prototype.hasOwnProperty.call(views, name)) {
    var v = views[name];
    if (v.constructor !== ctor) throw new Error('MT layout mismatch: ' + name);
    return v;
  }
  return new ctor(len);
};
var opts = {};
for (var k in D.opts) opts[k] = D.opts[k];
opts.alloc = alloc;
var solver = new FluidSolver(opts);

// terrain proxy (rebuilt whenever the pool bumps the terrain revision)
var terrain = null;
function syncTerrain() {
  if (!D.terrain) { terrain = null; return; }
  terrain = tasks.makeTerrainProxy(D.terrain.sab, D.terrain.scalarsF, D.terrain.scalarsI);
  solver.terrain = terrain;
  // _rockCellAt fast path: static cell types live in the shared slab and the
  // proxy identity pins the cache
  solver._staticTypes = views._staticTypes;
  solver._staticTerrain = terrain;
  solver._staticCore = solver.coreR;
}
syncTerrain();
// gravity direction vectors live in the shared state (rebuilt on the
// coordinator, e.g. after resetWater) — workers only read them
if (views._gu) { solver._gu = views._gu; solver._gv = views._gv; solver._gw = views._gw; }
solver._mtTerrainRev = D.terrain ? D.terrain.scalarsI[0] | 0 : 0;

// worker-private execution context (its own slab slice + shared reduce inputs)
var ctx = {
  workerIdx: D.workerIdx,
  nWorkers: meta.nWorkers,
  uN: meta.uN, vN: meta.vN, wN: meta.wN,
  densC: meta.densC, nCells: meta.nCells,
  f32Stride: meta.f32Stride, i32Stride: meta.i32Stride,
  partialF32: D.partialF32, partialI32: D.partialI32,
  counters: D.counters,
  params: null
};
solver._mtCtx = ctx;

// ---- mailbox ------------------------------------------------------------------
var ctl = D.ctl;
var JOB = 0, DONE = 1, QUIT = 2, NTASKS = 3, ERR = 4, READY = 5;
var RANGES = 8;          // ctl[8 + w*2] / ctl[9 + w*2]: i0, i1 for worker w
var TASKS = 8 + 2 * 64;  // task codes start here (max 64 tasks per job)

Atomics.add(ctl, 3, 0);
Atomics.add(ctl, 5, 1);            // ready count
Atomics.notify(ctl, 5, Infinity);

var lastSeq = 0;
var codes = [];
// adaptive mailbox poll: spin through the burst window (jobs arrive in
// substep batches tens of µs apart; a futex wake costs ~0.1 ms), then back
// off to longer sleeps while idle so an idle pool burns ~no CPU
var spins = 0, backoff = 1;
while (true) {
  if (Atomics.load(ctl, QUIT)) break;
  var seq = Atomics.load(ctl, JOB);
  if (seq === lastSeq) {
    if (++spins < 32768) continue;
    spins = 0;
    Atomics.wait(ctl, JOB, lastSeq, backoff);
    if (backoff < 32) backoff <<= 1;   // 1 → 32 ms while idle
    continue;
  }
  lastSeq = seq;
  spins = 0; backoff = 1;
  if (Atomics.load(ctl, QUIT)) break;
  try {
    var nT = Atomics.load(ctl, NTASKS);
    var w = D.workerIdx;
    var a = Atomics.load(ctl, RANGES + w * 2);
    var b = Atomics.load(ctl, RANGES + w * 2 + 1);
    tasks.applyParams(solver, D.params);
    // terrain revision changed? refresh the proxy scalars (slab already copied)
    var tRev = D.terrain ? D.terrain.scalarsI[0] | 0 : 0;
    if (tRev !== solver._mtTerrainRev) {
      solver._mtTerrainRev = tRev;
      syncTerrain();
    }
    ctx.params = D.params;
    for (var t = 0; t < nT; t++) {
      var code = Atomics.load(ctl, TASKS + t);
      if (b > a) tasks.runChunk(solver, code, a, b, ctx);
    }
  } catch (e) {
    Atomics.store(ctl, ERR, 1);
    // pack the message into ctl[200..263] (4 chars/cell) — worker console
    // output races process.exit on the main side, shared memory does not
    // (ctl[199] holds the length; cells 200..263 hold 4 packed chars each)
    try {
      var msg = String((e && e.message) || e).slice(0, 256);
      for (var ci = 0; ci < msg.length; ci++) {
        var cell = 200 + (ci >> 2), sh = (ci & 3) * 8;
        Atomics.store(ctl, cell, (Atomics.load(ctl, cell) & ~(0xff << sh)) | (msg.charCodeAt(ci) & 0xff) << sh);
      }
      Atomics.store(ctl, 199, msg.length);
    } catch (_) {}
    try { console.error('MT worker fault:', e && e.stack || e); } catch (_) {}
  }
  Atomics.add(ctl, DONE, 1);
  Atomics.notify(ctl, DONE, Infinity);
}