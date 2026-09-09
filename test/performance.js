/* Reproducible whole-step benchmark; node test/performance.js [solver-path]
 * Compare the same Node version, preset, warmup, and no other busy jobs.
 * Results are CPU timings, not browser FPS. */
'use strict';
const path = require('node:path');
const Solver = require(process.argv[2] ? path.resolve(process.argv[2]) : '../js/solver.js');
global.MarchingTetrahedra = require('../js/surface.js');
const presets = [{ key: 'tiny', n: 22, p: 18000 }, { key: 'low', n: 30, p: 36000 }, { key: 'medium', n: 40, p: 65000 }];
for (const { key, n, p } of presets) {
  const solver = new Solver({ nx: n, ny: n, nz: n, dx: 5.1 / n, targetParticles: p,
    mode: 'sphere', coreR: 1.5, bumpiness: 0.65, evaporation: 0.6, atmosphereH: 1 });
  const startFill = performance.now();
  solver.resetWater(0.45);
  const fillMs = performance.now() - startFill;
  solver.sunPos = [9, 4, 4]; solver.pic = 0.05; solver.viscosity = 5e-5;
  for (let i = 0; i < 30; i++) { solver.step(1 / 60); solver.splatDensity(); }
  const times = [], meshTimes = [];
  for (let i = 0; i < 90; i++) {
    let t = performance.now(); solver.step(1 / 60); times.push(performance.now() - t);
    t = performance.now(); solver.splatDensity();
    global.MarchingTetrahedra.build(solver.dens, n, n, n, solver.dx, solver.iso);
    meshTimes.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ preset: key, particles: solver.nP, fillMs: +fillMs.toFixed(2),
    meanStepMs: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2),
    medianStepMs: +times[45].toFixed(2), p90StepMs: +times[81].toFixed(2),
    meanSurfaceMs: +(meshTimes.reduce((a, b) => a + b, 0) / meshTimes.length).toFixed(2) }));
}
