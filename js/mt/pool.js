/*
 * WaterSim — multithreaded solver worker pool (main-thread side).
 *
 * Spawns one worker per core (minus the coordinator) and dispatches chunked
 * solver stages over SharedArrayBuffer state. Two transports:
 *
 *   • Node (worker_threads): a lock-free mailbox (Atomics.wait/notify) so the
 *     whole solver step stays SYNCHRONOUS — the headless test suite runs the
 *     multithreaded path unchanged.
 *   • Browser (Web Workers): the main thread may not Atomics.wait, so the
 *     same dispatches run asynchronously; the pool hands back promises and
 *     the solver exposes *Async step entry points.
 *
 * The coordinator is executor 0: it runs its own chunk inline while the
 * workers take the remaining chunks, so all hardware cores are busy.
 *
 * Browser: window.MTPool (requires js/mt/tasks.js loaded first).
 * Node: module.exports.
 */
(function (global) {
'use strict';

var tasks = global.MTTasks ||
  (typeof require === 'function' ? require('./tasks') : null);

var IMPL = null; // 'node' | 'web'
function impl() {
  if (IMPL) return IMPL;
  if (typeof SharedArrayBuffer === 'undefined') return null;
  // some engines expose the global but block construction when the page is
  // not cross-origin isolated — probe constructibility, not just the name
  try { new SharedArrayBuffer(8); } catch (e) { return null; }
  if (typeof module !== 'undefined' && module.exports &&
      typeof process !== 'undefined' && process.versions && process.versions.node) {
    try { require('worker_threads'); IMPL = 'node'; } catch (e) { IMPL = null; }
    return IMPL;
  }
  if (typeof Worker !== 'undefined' && typeof location !== 'undefined' &&
      location.protocol !== 'file:') {
    IMPL = 'web';
    return IMPL;
  }
  return null;
}

function coreCount() {
  var kind = impl();
  if (kind === 'node') {
    var os = require('os');
    return Math.max(1, os.availableParallelism ? os.availableParallelism() : os.cpus().length);
  }
  if (kind === 'web' && typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    return navigator.hardwareConcurrency;
  }
  return 1;
}

// ---- shared-buffer bookkeeping -----------------------------------------------
// Partial slab layout (per worker w, floats): [ u uW? no — u v w uW vW wW (2F)
// | dens splat (densC) | umax, Tmin, Tmax (3) ]
function computeMeta(solver, nWorkers) {
  var uN = solver.uN, vN = solver.vN, wN = solver.wN;
  var F = uN + vN + wN;
  var densC = (solver.nx + 1) * (solver.ny + 1) * (solver.nz + 1);
  var nCells = solver.nCells;
  return {
    nWorkers: nWorkers,
    uN: uN, vN: vN, wN: wN, F: F,
    densC: densC, nCells: nCells,
    f32Stride: 2 * F + densC + 3,
    i32Stride: nCells + 4
  };
}

// ---- terrain slab --------------------------------------------------------------
// [ scalarsI: Int32 × 8 | scalarsF: Float64 × 8 | R: F32 n³ | solid: U8 n³ ]
function makeTerrainSlab(terrain) {
  var n = terrain.n, n3 = n * n * n;
  var byteLen = 8 * 4 + 8 * 8 + n3 * 4 + n3;
  byteLen = (byteLen + 15) & ~15;
  var sab = new SharedArrayBuffer(byteLen);
  var scalarsI = new Int32Array(sab, 0, 8);
  var scalarsF = new Float64Array(sab, 32, 8);
  var R = new Float32Array(sab, 96, n3);
  var solid = new Uint8Array(sab, 96 + n3 * 4, n3);
  scalarsF[0] = n; scalarsF[1] = terrain.dv;
  scalarsF[2] = terrain.Rlo || 0; scalarsF[3] = terrain.Rhi || 0;
  scalarsF[4] = terrain.Rlo2 || 0; scalarsF[5] = terrain.Rhi2 || 0;
  scalarsF[6] = terrain.landFrac || 0; scalarsF[7] = terrain.seed || 0;
  R.set(terrain.R); solid.set(terrain.solid);
  return { sab: sab, scalarsI: scalarsI, scalarsF: scalarsF, R: R, solid: solid, n: n };
}
function syncTerrainSlab(slab, terrain) {
  slab.scalarsF[0] = terrain.n; slab.scalarsF[1] = terrain.dv;
  slab.scalarsF[2] = terrain.Rlo || 0; slab.scalarsF[3] = terrain.Rhi || 0;
  slab.scalarsF[4] = terrain.Rlo2 || 0; slab.scalarsF[5] = terrain.Rhi2 || 0;
  slab.scalarsF[6] = terrain.landFrac || 0; slab.scalarsF[7] = terrain.seed || 0;
  slab.R.set(terrain.R); slab.solid.set(terrain.solid);
  Atomics.add(slab.scalarsI, 0, 1);   // bump revision (workers rebuild proxies)
}

// ---- pool ----------------------------------------------------------------------
function create(solver, desc) {
  var kind = impl();
  if (!kind) return null;
  var tasks = global.MTTasks || require('./tasks');
  var nWorkers = Math.max(2, desc.threads + 1);   // + coordinator (executor 0)
  var meta = computeMeta(solver, nWorkers);
  var uN = meta.uN, vN = meta.vN, wN = meta.wN, F = meta.F;

  var partialF32 = new SharedArrayBuffer(meta.f32Stride * nWorkers * 4);
  var partialI32 = new SharedArrayBuffer(meta.i32Stride * nWorkers * 4);
  var counters = new Int32Array(new SharedArrayBuffer(256));  // shared reduce counters (G2P air, EVAP)
  var ctl = new Int32Array(new SharedArrayBuffer(2048));  // 512 cells: ranges + codes
  var params = new Float32Array(
    new SharedArrayBuffer(tasks.PARAM_TOTAL * 4));

  var JOB = 0, DONE = 1, QUIT = 2, NTASKS = 3, ERR = 4, READY = 5;
  var RANGES = 8;                        // per-worker i0/i1
  var TASKS = 8 + 2 * 64;                // task codes (max 64 per job)

  var workers = [];
  var ready = kind === 'node' ? 0 : 0;
  var faultMsg = null;
  var tick = 0;
  var pending = null;   // async bookkeeping

  function workerOpts() {
    var o = {};
    for (var k in desc.opts) o[k] = desc.opts[k];
    return o;
  }

  function onWorkerFault(msg) {
    faultMsg = msg || 'worker fault';
  }

  // ---- spawn ------------------------------------------------------------------
  if (kind === 'node') {
    var worker_threads = require('worker_threads');
    var path = require('path');
    for (var w = 1; w < nWorkers; w++) {
      var wk = new worker_threads.Worker(path.join(__dirname, 'node-worker.js'), {
        workerData: {
          solverPath: desc.solverPath,
          tasksPath: path.join(__dirname, 'tasks.js'),
          opts: workerOpts(),
          layout: desc.layout,
          state: desc.state,
          terrain: desc.terrain ? { sab: desc.terrain.sab, scalarsI: desc.terrain.scalarsI, scalarsF: desc.terrain.scalarsF } : null,
          partialF32: new Float32Array(partialF32), partialI32: new Int32Array(partialI32),
          counters: counters, ctl: ctl, params: params,
          meta: meta, workerIdx: w
        }
      });
      (function (idx) {
        wk.on('message', function (m) {
          if (pending && m.seq === pending.seq) {
            pending.got[idx] = true;
            pending.count++;
            if (pending.count >= pending.expect) { var r = pending.resolve; pending = null; r(); }
          }
        });
        wk.on('error', function (e) { onWorkerFault(String(e)); });
      })(w);
      workers.push(wk);
    }
  } else {
    var url = (function () {
      // js/mt/pool.js sibling of web-worker.js — resolve from this script's src
      if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) {
        return document.currentScript.src.replace(/pool\.js$/, 'web-worker.js');
      }
      return 'js/mt/web-worker.js';
    })();
    for (var w2 = 1; w2 < nWorkers; w2++) {
      (function (idx) {
        var wk = new Worker(url);
        workers.push(wk);
        wk.onmessage = function (ev) {
          var m = ev.data;
          if (m.type === 'ready') {
            ready++;
            return;
          }
          if (m.type === 'done' && pending && m.seq === pending.seq) {
            pending.count++;
            if (pending.count >= pending.expect) { var r = pending.resolve; pending = null; r(); }
          } else if (m.type === 'error') {
            onWorkerFault(m.message);
            if (pending) { var r2 = pending.resolve; pending = null; r2(); }
          }
        };
        wk.onerror = function (e) { onWorkerFault(String(e.message || e)); };
        wk.postMessage({
          type: 'init', workerIdx: idx, layout: desc.layout, opts: workerOpts(),
          state: desc.state,
          terrain: desc.terrain ? { sab: desc.terrain.sab, scalarsI: desc.terrain.scalarsI, scalarsF: desc.terrain.scalarsF } : null,
          partialF32: new Float32Array(partialF32), partialI32: new Int32Array(partialI32),
          counters: counters, meta: meta
        });
      })(w2);
    }
  }

  // ---- main-thread executor context (worker slot 0) ----------------------------
  var mainCtx = {
    workerIdx: 0,
    nWorkers: nWorkers,
    uN: uN, vN: vN, wN: wN,
    densC: meta.densC, nCells: meta.nCells,
    f32Stride: meta.f32Stride, i32Stride: meta.i32Stride,
    partialF32: new Float32Array(partialF32), partialI32: new Int32Array(partialI32),
    counters: counters,
    params: params
  };

  // ---- dispatch ---------------------------------------------------------------
  function rangesFor(nItems, mode) {
    var items = mode === 'kslab' ? solver.nz : nItems;
    return tasks.partition(items, nWorkers);
  }

  function writeJob(codes, ranges, dt, gScale, extras) {
    var i;
    Atomics.store(ctl, NTASKS, codes.length);
    for (i = 0; i < codes.length; i++) Atomics.store(ctl, TASKS + i, codes[i]);
    for (i = 0; i < nWorkers; i++) {
      Atomics.store(ctl, RANGES + i * 2, ranges[i][0]);
      Atomics.store(ctl, RANGES + i * 2 + 1, ranges[i][1]);
    }
    var p = tasks.encodeParams(solver, dt, gScale, ++tick);
    params.set(p);
    if (extras) {
      if (extras.tmin !== undefined) params[tasks.IDX_TMIN] = extras.tmin;
      if (extras.tmax !== undefined) params[tasks.IDX_TMAX] = extras.tmax;
    }
  }

  function runMainChunks(codes, ranges) {
    var r0 = ranges[0];
    if (r0[1] <= r0[0]) return;
    for (var i = 0; i < codes.length; i++) {
      tasks.runChunk(solver, codes[i], r0[0], r0[1], mainCtx);
    }
  }

  // SYNCHRONOUS dispatch (Node): blocks until every worker finished its chunk.
  function runSync(codes, nItems, mode, dt, gScale, extras) {
    if (faultMsg) throw new Error('MT pool fault: ' + faultMsg);
    var ranges = rangesFor(nItems, mode);
    writeJob(codes, ranges, dt, gScale, extras);
    var seq = Atomics.add(ctl, JOB, 1) + 1;   // add() returns the OLD value
    Atomics.notify(ctl, JOB, Infinity);
    runMainChunks(codes, ranges);
    var target = seq * (nWorkers - 1);
    var t0 = Date.now();
    var spins = 0;
    while (Atomics.load(ctl, DONE) < target) {
      if (faultMsg) throw new Error('MT pool fault: ' + faultMsg);
      // hybrid barrier: spin through the short completion window (workers
      // typically finish in tens of µs; a main-thread Atomics.wait wake costs
      // milliseconds on macOS), then park bounded so the watchdog can fire
      if (++spins < 65536) continue;
      if (Date.now() - t0 > 5000) {
        throw new Error('MT barrier timeout: target=' + target + ' done=' + Atomics.load(ctl, DONE) +
          ' err=' + Atomics.load(ctl, ERR) + ' job=' + Atomics.load(ctl, JOB) +
          ' tasks=' + codes.join(','));
      }
      Atomics.wait(ctl, DONE, Atomics.load(ctl, DONE), 250);
    }
    if (Atomics.load(ctl, ERR)) {
      var mlen = Atomics.load(ctl, 199), msg = '';
      if (mlen > 0 && mlen < 256) {
        for (var ci = 0; ci < mlen; ci++) {
          msg += String.fromCharCode((Atomics.load(ctl, 200 + (ci >> 2)) >> ((ci & 3) * 8)) & 0xff);
        }
      }
      throw new Error('MT worker fault in task ' + codes.join(',') + (msg ? ': ' + msg : ''));
    }
  }

  // ASYNCHRONOUS dispatch (browser): posts jobs and resolves when all replied.
  // In Node the sync mailbox is used and the promise resolves immediately
  // (await-sequencing of the async orchestration stays testable headlessly).
  function runAsync(codes, nItems, mode, dt, gScale, extras) {
    if (kind !== 'web') {
      runSync(codes, nItems, mode, dt, gScale, extras);
      return Promise.resolve();
    }
    if (faultMsg) return Promise.reject(new Error('MT pool fault: ' + faultMsg));
    var ranges = rangesFor(nItems, mode);
    writeJob(codes, ranges, dt, gScale, extras);
    runMainChunks(codes, ranges);
    var seq = ++tick;
    return new Promise(function (resolve, reject) {
      pending = { seq: seq, count: 0, expect: nWorkers - 1, resolve: resolve, got: {} };
      var p = params.slice();
      for (var w = 1; w < nWorkers; w++) {
        workers[w - 1].postMessage({
          type: 'job', seq: seq, codes: codes,
          a: ranges[w][0], b: ranges[w][1],
          params: p, workerIdx: w,
          terrainRev: desc.terrain ? desc.terrain.scalarsI[0] : 0,
          terrainScalars: desc.terrain ? desc.terrain.scalarsF : null,
          terrainSlab: desc.terrain ? desc.terrain.R : null
        });
      }
    });
  }

  function destroy() {
    Atomics.store(ctl, QUIT, 1);
    Atomics.notify(ctl, JOB, Infinity);
    for (var i = 0; i < workers.length; i++) {
      try { workers[i].terminate(); } catch (e) {}
    }
    workers.length = 0;
  }

  return {
    sync: kind === 'node',
    async: kind !== 'node',
    kind: kind,
    threads: nWorkers - 1,
    nWorkers: nWorkers,
    run: runSync,
    runAsync: runAsync,
    destroy: destroy,
    counters: counters,
    ctl: ctl,
    meta: meta,
    mainCtx: mainCtx,
    zeroI32Slabs: function () {
      for (var w = 0; w < nWorkers; w++) {
        new Int32Array(partialI32, w * meta.i32Stride * 4, meta.i32Stride).fill(0);
      }
    },
    heatCountView: function (w) {
      return new Int32Array(partialI32, meta.i32Stride * w * 4, meta.nCells);
    },
    slotView: function (w, which) {
      var base = meta.f32Stride * w + 2 * F + meta.densC;
      return new Float32Array(partialF32, base * 4 + which * 4, 1);
    },
    umaxReduce: function () {
      var m = 0;
      for (var w = 0; w < nWorkers; w++) {
        var v = this.slotView(w, 0)[0];
        if (v > m) m = v;
      }
      return m;
    },
    evapRangeReduce: function () {
      var tmin = Infinity, tmax = -Infinity;
      for (var w = 0; w < nWorkers; w++) {
        var a = this.slotView(w, 1)[0], b = this.slotView(w, 2)[0];
        if (a < tmin) tmin = a;
        if (b > tmax) tmax = b;
      }
      return [tmin, tmax];
    },
    ready: function () { return ready; }
  };
}

global.MTPool = {
  impl: impl,
  supported: function () { return !!impl(); },
  coreCount: coreCount,
  makeTerrainSlab: makeTerrainSlab,
  syncTerrainSlab: syncTerrainSlab,
  create: create
};
if (typeof module !== 'undefined' && module.exports) module.exports = global.MTPool;
})(typeof window !== 'undefined' ? window : globalThis);