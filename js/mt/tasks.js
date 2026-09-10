/*
 * WaterSim — multithreaded solver task registry (shared by main thread and
 * workers). A "task" is one chunked solver stage: it runs the stage's math for
 * the particle/face/cell range [i0, i1) against the SHARED simulation state
 * (SharedArrayBuffer-backed solver arrays) plus a worker-private scratch slab
 * for scatter stages (P2G momentum, density splat, cell heat counts).
 *
 * No DOM / no Node APIs — loaded identically in Web Workers, Node
 * worker_threads, and the main thread (which executes chunk 0 inline so all
 * cores stay busy without an idle coordinator).
 *
 * Browser: window.MTTasks. Node: module.exports.
 */
(function (global) {
'use strict';

// ---- task codes (fixed wire format for the mailbox / messages) -------------
var TASK = {
  MARK: 1,          // rasterize: particles mark fluid cells + ceiling guards
  PUSH_BALLS: 2,    // particle-ball push-out (per-particle over all balls)
  P2G: 3,           // particle->grid momentum scatter into a partial slab
  P2G_REDUCE: 4,    // reduce all partial slabs into the shared grids + normalize
  G2P: 5,           // grid->particle FLIP/PIC update (counts airborne)
  ADVECT: 6,        // RK2 advection + ballistic droplets + vapor parcels
  BC: 7,            // boundary conditions, k-slab slice
  GRAVITY: 8,       // planet radial gravity, k-slab slice
  PROJECT: 9,       // pressure projection onto faces, k-slab slice
  CLAMP_UMAX: 10,   // grid velocity ceiling + local umax reduction
  HEAT_BIN_COUNT: 11,   // thermal: count particles per cell (partial slab)
  HEAT_BIN_FILL: 12,    // thermal: fill the cell bin order (atomic increment)
  HEAT_SHADOW: 13,      // thermal: sun exposure + heating + dissipation
  HEAT_MEANS: 14,       // thermal: per-cell mean temperature (cell slice)
  HEAT_APPLY: 15,       // thermal: apply conduction deltas (cell slice)
  HEAT_CONVECT: 16,     // thermal: radial buoyancy convection
  EVAP_RANGE: 17,       // evaporation: live water Tmin/Tmax (partial slab)
  EVAP: 18,             // evaporation: Maxwell-Boltzmann surface ejection
  CURR_APPLY: 19,       // subsurface currents: relax particles to the field
  PUSH_SURFACE: 20,     // frame-end embedded-particle rescue
  SPLAT: 21,            // density splat into a partial slab
  SPLAT_REDUCE: 22      // reduce all density partials into the shared field
};

// ---- per-dispatch scalar table ---------------------------------------------
// Float32 slot names (fixed order — the pool writes, the workers read).
var PARAMS = [
  'nP', 'dt', 'dtLast', 'gravity', 'pic', 'maxSpeed', 'spacing',
  'oceanR', 'coreR', 'atmosphereH', 'domainR', 'cx', 'cy', 'cz',
  'waterTopY', 'Tamb', 'sunActivity', 'heatK', 'currents', 'simTime',
  'sunX', 'sunY', 'sunZ', 'sunFlag', 'terrainRev', 'rngTick',
  'gScale', 'ballCount', 'ceilReflect', 'mtSeed'
];
var PARAM_N = PARAMS.length;
var MAX_BALLS = 8;                 // more balls -> main-thread serial fallback
var BALL_FLOATS = 8;               // x y z vx vy vz r rho
var FLOATS_PER_WORKER_EXTRA = 3;   // umax slot + Tmin slot + Tmax slot
var IDX_RNGTICK = 25, IDX_GSCALE = 26, IDX_MTSEED = 29;  // slots runChunk reads
// Tail slots past the ball block, written by the main thread right before the
// EVAP dispatch (writeJob re-encodes params each dispatch, so these ride in
// via the extras argument of pool.run, not persistent state).
var IDX_TMIN = PARAM_N + MAX_BALLS * BALL_FLOATS;
var IDX_TMAX = IDX_TMIN + 1;
var PARAM_TOTAL = IDX_TMIN + 2;

// LCG hash for per-chunk deterministic RNG streams (mirrors the solver's
// seeded streams; a chunk is a stream, so N threads re-seed per chunk —
// statistically equivalent to the serial consumption order, like the GPU path).
function hash4(a, b, c, d) {
  var s = (a ^ (b * 0x9e3779b9) ^ (c * 0x85ebca6b) ^ (d * 0xc2b2ae35)) >>> 0;
  s = (s * 1664525 + 1013904223) >>> 0;
  s ^= s >>> 13; s = (s * 0x5bd1e995) >>> 0; s ^= s >>> 15;
  return s >>> 0;
}

// ---- chunk partitioning -----------------------------------------------------
// Contiguous, near-equal ranges; identical on the main thread and workers
// (the pool sends the range, so workers never repartition).
function partition(n, parts) {
  var out = [], i;
  for (i = 0; i < parts; i++) {
    var a = Math.floor(n * i / parts), b = Math.floor(n * (i + 1) / parts);
    out.push([a, b]);
  }
  return out;
}

// ---- worker context ----------------------------------------------------------
// ctx = {
//   stateSAB, terrainSAB, partialF32 (SAB), partialI32 (SAB), counters (Int32 SAB),
//   f32Stride (per-worker float slot stride), i32Stride, nWorkers, workerIdx,
//   uN, vN, wN, densC, nCells, mtSeed
// }
function f32Slab(ctx, w) { return ctx.f32Stride * w; }

// Per-worker partial views for the P2G scatter: [u, v, w, uW, vW, wW].
function p2gViews(ctx, w) {
  var base = f32Slab(ctx, w);
  var F = ctx.uN + ctx.vN + ctx.wN;
  var ab = ctx.partialF32.byteOffset;
  return {
    u:  new Float32Array(ctx.partialF32.buffer, ab + (base) * 4, ctx.uN),
    v:  new Float32Array(ctx.partialF32.buffer, ab + (base + ctx.uN) * 4, ctx.vN),
    w:  new Float32Array(ctx.partialF32.buffer, ab + (base + ctx.uN + ctx.vN) * 4, ctx.wN),
    uW: new Float32Array(ctx.partialF32.buffer, ab + (base + F) * 4, ctx.uN),
    vW: new Float32Array(ctx.partialF32.buffer, ab + (base + F + ctx.uN) * 4, ctx.vN),
    wW: new Float32Array(ctx.partialF32.buffer, ab + (base + F + ctx.uN + ctx.vN) * 4, ctx.wN)
  };
}
// Per-worker slots after the P2G slab: [umax, Tmin, Tmax] then the splat slab.
function slotView(ctx, w, which) {
  var F = ctx.uN + ctx.vN + ctx.wN;
  var base = f32Slab(ctx, w) + 2 * F + ctx.densC;
  return new Float32Array(ctx.partialF32.buffer, ctx.partialF32.byteOffset + (base + which) * 4, 1);
}
function splatView(ctx, w) {
  var F = ctx.uN + ctx.vN + ctx.wN;
  var base = f32Slab(ctx, w) + 2 * F;
  return new Float32Array(ctx.partialF32.buffer, ctx.partialF32.byteOffset + base * 4, ctx.densC);
}
function heatCountView(ctx, w) {
  return new Int32Array(ctx.partialI32.buffer, ctx.partialI32.byteOffset + ctx.i32Stride * w * 4, ctx.nCells);
}

// ---- task execution ---------------------------------------------------------
// Runs one task's chunk [a, b) for worker w. RNG-driven stages are seeded per
// (seed, task, worker, tick) so a run is bit-reproducible for a fixed layout.
function runChunk(solver, code, a, b, ctx) {
  var w = ctx.workerIdx;
  switch (code) {
    case TASK.MARK:
      solver._markFluidCells(a, b);
      break;
    case TASK.PUSH_BALLS:
      solver._pushBallsChunk(a, b);
      break;
    case TASK.P2G: {
      // the partial slab is an accumulator — clear this worker's region first
      var f0 = f32Slab(ctx, w);
      ctx.partialF32.fill(0, f0, f0 + ctx.f32Stride);
      var P = p2gViews(ctx, w);
      solver._p2gInto(a, b, P.u, P.v, P.w, P.uW, P.vW, P.wW);
      break;
    }
    case TASK.P2G_REDUCE:
      solver._p2gReduceNorm(a, b);
      break;
    case TASK.G2P: {
      var air = solver._g2pChunk(a, b, ctx.params ? ctx.params[1] : 0);
      Atomics.add(ctx.counters, 0, air);
      break;
    }
    case TASK.ADVECT:
      // per-chunk deterministic streams for the stochastic vapor rules
      solver._cfS = hash4(ctx.params ? ctx.params[IDX_MTSEED] : 0, TASK.ADVECT, w, ctx.params ? ctx.params[IDX_RNGTICK] : 0) | 0;
      solver._bfS = hash4(ctx.params ? ctx.params[IDX_MTSEED] : 0, 0xBF00 + TASK.ADVECT, w, ctx.params ? ctx.params[IDX_RNGTICK] : 0) | 0;
      solver._advectChunk(a, b, ctx.params ? ctx.params[1] : 0);
      break;
    case TASK.BC:
      solver._applyBCSlice(a, b);
      break;
    case TASK.GRAVITY:
      solver._applyPlanetGravitySlice(a, b, ctx.params ? ctx.params[1] : 0, ctx.params ? ctx.params[IDX_GSCALE] : 1);
      break;
    case TASK.PROJECT:
      solver._projectSlice(a, b);
      break;
    case TASK.CLAMP_UMAX:
      slotView(ctx, w, 0)[0] = solver._clampUmSlice(a, b);
      break;
    case TASK.HEAT_BIN_COUNT: {
      solver._heatBinCount(a, b, heatCountView(ctx, w));
      break;
    }
    case TASK.HEAT_BIN_FILL:
      solver._heatBinFill(a, b);
      break;
    case TASK.HEAT_SHADOW:
      solver._heatShadowChunk(a, b, ctx.params ? ctx.params[1] : 0);
      break;
    case TASK.HEAT_MEANS:
      solver._heatMeansSlice(a, b);
      break;
    case TASK.HEAT_APPLY:
      solver._heatApplySlice(a, b);
      break;
    case TASK.HEAT_CONVECT:
      solver._heatConvectChunk(a, b, ctx.params ? ctx.params[1] : 0);
      break;
    case TASK.EVAP_RANGE: {
      var r = solver._evapRangeChunk(a, b);
      slotView(ctx, w, 1)[0] = r[0];
      slotView(ctx, w, 2)[0] = r[1];
      break;
    }
    case TASK.EVAP: {
      solver._evS = hash4(ctx.params ? ctx.params[IDX_MTSEED] : 0, TASK.EVAP, w, ctx.params ? ctx.params[IDX_RNGTICK] : 0) | 0;
      var n = solver._evapChunk(a, b, ctx.params ? ctx.params[1] : 0,
        ctx.params ? ctx.params[IDX_TMIN] : 0, ctx.params ? ctx.params[IDX_TMAX] : 0);
      Atomics.add(ctx.counters, 1, n);
      break;
    }
    case TASK.CURR_APPLY:
      solver._currentsChunk(a, b, ctx.params ? ctx.params[1] : 0);
      break;
    case TASK.PUSH_SURFACE:
      solver._pushSurfaceChunk(a, b);
      break;
    case TASK.SPLAT: {
      var fs0 = f32Slab(ctx, w) + 2 * (ctx.uN + ctx.vN + ctx.wN);
      ctx.partialF32.fill(0, fs0, fs0 + ctx.densC);
      solver._splatInto(a, b, splatView(ctx, w));
      break;
    }
    case TASK.SPLAT_REDUCE:
      solver._splatReduceSlice(a, b);
      break;
    default:
      throw new Error('MT: unknown task ' + code);
  }
}

// ---- params encoding ---------------------------------------------------------
var _encBuf = null;
function encodeParams(solver, dt, gScale, rngTick) {
  var f = _encBuf || (_encBuf = new Float32Array(PARAM_TOTAL));
  var i = 0;
  f[i++] = solver.nP;
  f[i++] = dt || 0;
  f[i++] = solver.dtLast || 0;
  f[i++] = solver.gravity;
  f[i++] = solver.pic;
  f[i++] = solver.maxSpeed;
  f[i++] = solver.spacing;
  f[i++] = solver.oceanR;
  f[i++] = solver.coreR;
  f[i++] = solver.atmosphereH;
  f[i++] = solver.domainR;
  f[i++] = solver.cx;
  f[i++] = solver.cy;
  f[i++] = solver.cz;
  f[i++] = solver.waterTopY;
  f[i++] = solver.Tamb;
  f[i++] = solver.sunActivity;
  f[i++] = solver.heatK;
  f[i++] = solver.currents;
  f[i++] = solver._simTime || 0;
  f[i++] = solver.sunPos ? solver.sunPos[0] : 0;
  f[i++] = solver.sunPos ? solver.sunPos[1] : 0;
  f[i++] = solver.sunPos ? solver.sunPos[2] : 0;
  f[i++] = solver.sunPos ? 1 : 0;
  f[i++] = solver._mtTerrainRev || 0;
  f[i++] = rngTick || 0;
  f[i++] = gScale === undefined ? 1 : gScale;
  var balls = solver.balls || [];
  f[i++] = Math.min(balls.length, MAX_BALLS);
  f[i++] = solver.ceilReflect === 'quadratic' ? 1 :
           solver.ceilReflect === 'exponential' ? 2 : 0;
  f[i++] = solver._mtSeed || 0;
  for (var b = 0; b < Math.min(balls.length, MAX_BALLS); b++) {
    var bl = balls[b];
    f[i++] = bl.x; f[i++] = bl.y; f[i++] = bl.z;
    f[i++] = bl.vx; f[i++] = bl.vy; f[i++] = bl.vz;
    f[i++] = bl.r; f[i++] = bl.rho;
  }
  return f;
}

// Build a chunk-executing solver context on a worker (or the main thread's
// slot 0). `views` maps layout names to SharedArrayBuffer-backed views that
// BOTH the worker solver and the partial slabs live in.
function applyParams(solver, f) {
  solver.nP = f[0] | 0;
  solver.dtLast = f[2];
  solver.gravity = f[3];
  solver.pic = f[4];
  solver.maxSpeed = f[5];
  solver.spacing = f[6];
  solver.oceanR = f[7];
  solver.coreR = f[8];
  solver.atmosphereH = f[9];
  solver.domainR = f[10];
  solver.cx = f[11]; solver.cy = f[12]; solver.cz = f[13];
  solver.waterTopY = f[14];
  solver.Tamb = f[15];
  solver.sunActivity = f[16];
  solver.heatK = f[17];
  solver.currents = f[18];
  solver._simTime = f[19];
  solver._mtTerrainRev = f[24] | 0;
  var reflect = f[28] | 0;
  solver.ceilReflect = reflect === 1 ? 'quadratic' : reflect === 2 ? 'exponential' : 'linear';
  if (f[23] > 0) solver.sunPos = [f[20], f[21], f[22]];
  else solver.sunPos = null;
  // balls (lightweight stand-ins; the chunk math only reads them)
  var nB = f[27] | 0;
  if (nB > 0 && nB <= MAX_BALLS) {
    var balls = [], i = PARAM_N;
    for (var b = 0; b < nB; b++) {
      balls.push({
        x: f[i++], y: f[i++], z: f[i++],
        vx: f[i++], vy: f[i++], vz: f[i++],
        r: f[i++], rho: f[i++]
      });
    }
    solver.balls = balls;
  } else {
    solver.balls = [];
  }
}

function makeCtx(stateViews, buffers, workerIdx, layoutMeta) {
  var ctx = {
    stateViews: stateViews,
    workerIdx: workerIdx,
    nWorkers: layoutMeta.nWorkers,
    uN: layoutMeta.uN, vN: layoutMeta.vN, wN: layoutMeta.wN,
    densC: layoutMeta.densC, nCells: layoutMeta.nCells,
    f32Stride: layoutMeta.f32Stride, i32Stride: layoutMeta.i32Stride,
    partialF32: layoutMeta.partialF32, partialI32: layoutMeta.partialI32,
    counters: layoutMeta.counters,
    params: null
  };
  return ctx;
}

// Terrain proxy for workers: the R/solid arrays are views over the terrain
// SAB, the scalars live in a small header region the pool refreshes and bumps
// a revision counter on whenever the planet regenerates.
function makeTerrainProxy(tSab, scalarsF, scalarsI) {
  var n = scalarsF[0] | 0, n3 = n * n * n;
  return {
    n: n, dv: scalarsF[1],
    R: new Float32Array(tSab, 96, n3),
    solid: new Uint8Array(tSab, 96 + n3 * 4, n3),
    Rlo: scalarsF[2], Rhi: scalarsF[3], Rlo2: scalarsF[4], Rhi2: scalarsF[5],
    landFrac: scalarsF[6], seed: scalarsF[7],
    rev: scalarsI ? scalarsI[0] : 0
  };
}

global.MTTasks = {
  TASK: TASK,
  PARAMS: PARAMS,
  PARAM_N: PARAM_N,
  MAX_BALLS: MAX_BALLS,
  BALL_FLOATS: BALL_FLOATS,
  hash4: hash4,
  partition: partition,
  runChunk: runChunk,
  encodeParams: encodeParams,
  IDX_TMIN: IDX_TMIN, IDX_TMAX: IDX_TMAX, PARAM_TOTAL: PARAM_TOTAL,
  applyParams: applyParams,
  makeCtx: makeCtx,
  makeTerrainProxy: makeTerrainProxy,
  p2gViews: p2gViews,
  slotView: slotView,
  splatView: splatView,
  heatCountView: heatCountView
};
if (typeof module !== 'undefined' && module.exports) module.exports = global.MTTasks;
})(typeof window !== 'undefined' ? window : globalThis);