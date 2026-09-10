/*
 * WaterSim — multithreaded solver worker (Web Worker entry, browser).
 *
 * Message-driven mirror of js/mt/node-worker.js: browsers may not
 * Atomics.wait on the main thread, so the browser pool runs the same chunk
 * tasks asynchronously (postMessage dispatch, promise-collected completions)
 * while Node blocks on the mailbox. Same task registry (tasks.js), same
 * SharedArrayBuffer state, same chunk math.
 */
'use strict';
importScripts('../solver.js', 'tasks.js');

var views = null, solver = null, ctx = null, meta = null;

self.onmessage = function (ev) {
  var msg = ev.data;
  if (msg.type === 'init') {
    try {
      var CTOR = [Float32Array, Float64Array, Uint8Array, Int32Array];
      views = {};
      for (var i = 0; i < msg.layout.length; i++) {
        var f = msg.layout[i];
        views[f.name] = new CTOR[f.c](msg.state, f.off, f.len);
      }
      var alloc = function (name, ctor, len) {
        if (Object.prototype.hasOwnProperty.call(views, name)) {
          var v = views[name];
          if (v.constructor !== ctor) throw new Error('MT layout mismatch: ' + name);
          return v;
        }
        return new ctor(len);
      };
      var opts = {};
      for (var k in msg.opts) opts[k] = msg.opts[k];
      opts.alloc = alloc;
      solver = new FluidSolver(opts);
      meta = msg.meta;
      solver.terrain = msg.terrain ?
        MTTasks.makeTerrainProxy(msg.terrain.sab, msg.terrain.scalarsF, msg.terrain.scalarsI) : null;
      solver._staticTypes = views._staticTypes;
      solver._staticTerrain = solver.terrain;
      solver._staticCore = solver.coreR;
      solver._mtTerrainRev = msg.terrain ? msg.terrain.scalarsI[0] | 0 : 0;
      ctx = {
        workerIdx: msg.workerIdx,
        nWorkers: meta.nWorkers,
        uN: meta.uN, vN: meta.vN, wN: meta.wN,
        densC: meta.densC, nCells: meta.nCells,
        f32Stride: meta.f32Stride, i32Stride: meta.i32Stride,
        partialF32: msg.partialF32, partialI32: msg.partialI32,
        counters: msg.counters,
        params: null
      };
      // shared gravity vectors (coordinator rebuilds; workers read)
      if (views._gu) { solver._gu = views._gu; solver._gv = views._gv; solver._gw = views._gw; }
      solver._mtCtx = ctx;
      self.postMessage({ type: 'ready', workerIdx: msg.workerIdx });
    } catch (e) {
      self.postMessage({ type: 'error', message: String(e && e.stack || e) });
    }
    return;
  }
  if (msg.type === 'job') {
    try {
      tasks.applyParams(solver, msg.params);
      var tRev = msg.terrain ? msg.terrain.scalarsI[0] | 0 : 0;
      if (tRev !== solver._mtTerrainRev) {
        solver._mtTerrainRev = tRev;
        solver.terrain = msg.terrain ?
          MTTasks.makeTerrainProxy(msg.terrain.sab, msg.terrain.scalarsF, msg.terrain.scalarsI) : null;
        solver._staticTerrain = solver.terrain;
        solver._staticCore = solver.coreR;
      }
      ctx.params = msg.params;
      for (var t = 0; t < msg.codes.length; t++) {
        if (msg.b > msg.a) tasks.runChunk(solver, msg.codes[t], msg.a, msg.b, ctx);
      }
      self.postMessage({ type: 'done', seq: msg.seq, workerIdx: msg.workerIdx });
    } catch (e) {
      self.postMessage({ type: 'error', seq: msg.seq, message: String(e && e.stack || e) });
    }
  }
};