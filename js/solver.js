/*
 * WaterSim — 3D incompressible Navier–Stokes solver for water in a pool.
 *
 * Method: Eulerian staggered (MAC) grid for velocity/pressure, Lagrangian
 * FLIP/PIC particles (Zhu & Bridson 2005) for the liquid volume. Each substep
 * is operator-split into:
 *
 *   1. rasterize particles -> cell types (air / fluid / solid)
 *   2. particle->grid (P2G) momentum transfer (trilinear splat)
 *   3. boundary conditions: no-flow walls, moving solid = balls
 *   4. forces: gravity g; optional viscous diffusion (Newton's viscosity)
 *   5. pressure projection: solve  laplacian(phi) = div(u)  (7-point Poisson,
 *      SOR Gauss-Seidel). Free surface: p = p_atm (phi = 0) at air cells.
 *      Walls/balls: Neumann (no normal flow). Then  u <- u - grad(phi)
 *      which enforces div u = 0 (incompressibility / mass conservation).
 *   6. grid->particle (G2P): FLIP  v += u_new - u_old, blended with PIC
 *   7. advect particles (RK2 through the divergence-free field); airborne
 *      droplets fly ballistically (spray), rejoining the liquid on splashdown
 *   8. ocean dynamics: vorticity confinement (swirl keeper) applied to the
 *      projected grid; subsurface curl-noise currents relax deep particles
 *      toward slow wandering tangential streams (divergence-free exactly)
 *   9. rigid balls: Archimedes buoyancy  F = rho_f * V_sub * g, quadratic
 *      drag, two-way coupling (ball cells are moving solids in the solver)
 *
 * Continuous form:
 *      du/dt + (u . grad) u = -grad(p)/rho + nu*lap(u) + g,   div u = 0
 *
 * No dependencies. Browser: window.FluidSolver. Node: module.exports.
 */
(function (global) {
'use strict';

var AIR = 0, FLUID = 1, SOLID = 2;

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

function FluidSolver(opts) {
  opts = opts || {};
  // Field allocator hook: `alloc(name, ctor, len)` returning undefined falls
  // back to a plain private array (tests may supply pooled buffers).
  this._alloc = opts.alloc || function (name, ctor, len) { return new ctor(len); };
  this.nx = opts.nx | 0;
  this.ny = opts.ny | 0;
  this.nz = opts.nz | 0;
  this.dx = opts.dx;

  // tunable parameters
  this.substeps = 1;
  this.cfl = 3.0;
  this.pic = 0.15;            // PIC blend
                              // 0 = pure FLIP, 1 = pure PIC. Fixed gravity keeps the
                              // redirect ratchet away, so low PIC stays stable.
  this.gravity = 9.81;
  this.viscosity = 5e-4;      // kinematic, m^2/s
  this.pressureIters = 20;
  this.omega = 1.55;
  this.maxSpeed = 3.2;        // m/s safety clamp — pool scale: v=3.2 rises 0.52 m,
                              // so surface water can NEVER reach the spray line
                              // (y ≈ H-0.55): grid-coupled water cannot demote
                              // en masse, which starves the redirect ratchet
                              // that otherwise sustains endless fountains
  // ocean dynamics (off by default in the library; the browser UI enables them)
  this.vorticity = opts.vorticity || 0;  // confinement strength: re-injects the
                                         // small eddies grid diffusion smears out
  this.currents = opts.currents || 0;    // subsurface stream strength (planet)
  this.shadeCool = 0.035;                // extra radiative cooling out of the sun
  this.targetParticles = opts.targetParticles || 110000;

  // world geometry: 'pool' = box pool with downward gravity;
  // 'sphere' = ocean planet — water wrapped around a solid core sphere,
  // gravity pointing at the sphere center (radial body force)
  this.mode = opts.mode === 'sphere' ? 'sphere' : 'pool';
  this.coreR = opts.coreR || 0;          // solid core radius (sphere mode)
  this.oceanR = 0;                        // outer free-surface radius

  var nx = this.nx, ny = this.ny, nz = this.nz;
  this.W = nx * this.dx; this.H = ny * this.dx; this.D = nz * this.dx;
  this.cx = this.W / 2; this.cy = this.H / 2; this.cz = this.D / 2;
  this.domainR = 0.5 * Math.min(this.W, this.H, this.D) - this.dx; // usable radius
  this.nCells = nx * ny * nz;
  this.uN = (nx + 1) * ny * nz;
  this.vN = nx * (ny + 1) * nz;
  this.wN = nx * ny * (nz + 1);

  // cell-centered fields
  this.cellType = this._alloc('cellType', Uint8Array, this.nCells);
  this.svx = this._alloc('svx', Float32Array, this.nCells);
  this.svy = this._alloc('svy', Float32Array, this.nCells);
  this.svz = this._alloc('svz', Float32Array, this.nCells);
  this.cellPhi = this._alloc('cellPhi', Float32Array, this.nCells);

  // face-centered fields (MAC)
  this.u = this._alloc('u', Float32Array, this.uN); this.v = this._alloc('v', Float32Array, this.vN); this.w = this._alloc('w', Float32Array, this.wN);
  this.uW = this._alloc('uW', Float32Array, this.uN); this.vW = this._alloc('vW', Float32Array, this.vN); this.wW = this._alloc('wW', Float32Array, this.wN);
  this.uO = this._alloc('uO', Float32Array, this.uN); this.vO = this._alloc('vO', Float32Array, this.vN); this.wO = this._alloc('wO', Float32Array, this.wN);
  this.validU = this._alloc('validU', Uint8Array, this.uN); this.validV = this._alloc('validV', Uint8Array, this.vN); this.validW = this._alloc('validW', Uint8Array, this.wN);

  // pressure system (cell-indexed; q persists across substeps as a warm start)
  this.nb = this._alloc('nb', Int32Array, this.nCells * 6);
  this.diag = this._alloc('diag', Float32Array, this.nCells);
  this.rhs = this._alloc('rhs', Float32Array, this.nCells);
  this.q = this._alloc('q', Float32Array, this.nCells);

  // corner density field for surface meshing
  this.dens = this._alloc('dens', Float32Array, (nx + 1) * (ny + 1) * (nz + 1));

  this.balls = [];
  this.nP = 0;
  this.capacity = 0;
  this.px = this._alloc('px', Float32Array, 1); this.py = this._alloc('py', Float32Array, 1); this.pz = this._alloc('pz', Float32Array, 1);
  this.pvx = this._alloc('pvx', Float32Array, 1); this.pvy = this._alloc('pvy', Float32Array, 1); this.pvz = this._alloc('pvz', Float32Array, 1);
  this.pflag = this._alloc('pflag', Uint8Array, 1);
  this.pcool = this._alloc('pcool', Uint8Array, 1);
  this.pT = this._alloc('pT', Float32Array, 1);    // per-particle temperature (0 cold .. 1 hot)
  this.pAir = this._alloc('pAir', Float32Array, 1);  // time spent evaporated (s) — vapor age
  this.pLight = this._alloc('pLight', Float32Array, 1); // per-particle sun exposure 0 (shade) .. 1 (lit) — display shading
  this.pDepth = this._alloc('pDepth', Uint8Array, 1);  // water cells stacked over each particle (0 = at/above the surface, 4 = deep) — beads cull
  this.pWx = this._alloc('pWx', Float32Array, 1); this.pWy = this._alloc('pWy', Float32Array, 1); this.pWz = this._alloc('pWz', Float32Array, 1);
  // angular-velocity vector of evaporated particles (rad/s, axis × speed in
  // one vector) + accumulated spin phase (rendering twinkle cue)
  this.pPh = this._alloc('pPh', Float32Array, 1);
  this.spinOn = false;               // "Particles rotation" checkbox (UI)
  // particle status codes in pflag: 0 = fluid (grid-coupled), 1 = droplet
  // (ballistic spray), 2 = evaporated steam (levitating vapor), 3 = cloud
  // (condensed steam, rides the winds), 4 = rain (falling condensate),
  // 5 = snow (frozen — does not move)
  this.terrain = null;              // sphere world: voxel terrain {n,dv,solid,R,Rsl,Rlo,Rhi,Rlo2,Rhi2,landFrac,seed}
  this._terrainKey = null;          // (coreR, sea level, seed) of the built terrain
  this.terrainSeed = (opts.terrainSeed || 20260114) >>> 0;
  this.bumpiness = opts.bumpiness === undefined ? 1 : Math.max(0, Math.min(opts.bumpiness, 2.5));
  this.evaporation = opts.evaporation || 0;        // legacy knob name; sunActivity supersedes
  // sun activity: one fine-grained knob for the whole water cycle — scales
  // solar heating AND the evaporation rate together.
  // 0 = dormant sun .. 0.6 = default daylight .. 2 = storm.
  this.sunActivity = opts.sunActivity !== undefined ? opts.sunActivity
    : (opts.evaporation !== undefined ? opts.evaporation : 0);
  this.atmosphereH = opts.atmosphereH || 0.35;     // max flight height above sea level
  // vapor ceiling-bounce profile ('linear' | 'quadratic' | 'exponential'):
  // a rising parcel reflects with probability = curve(height), height
  // normalized 0 at sea level → 1 at the atmosphere ceiling (the hard cap
  // at the ceiling itself always contains the atmosphere).
  this.ceilReflect = opts.ceilReflect || 'linear';
  this._evS = 0x51ab3c77;           // seeded PRNG for vapor wander (deterministic)
  this._cfS = 0x2f6e2b1;            // seeded PRNG for ceiling bounces
  this._bfS = 0x7f4a7c15;           // seeded PRNG for buoyant-floor bounce vs rejoin
  this._vIdx = [];                  // scratch: airborne-vapor indices for collisions
  this._gRamp = 1e9;                // planet gravity ramp-in timer (s)
  this.sunPos = null;               // world-space sun position [x,y,z] (null = no sun)
  this.heatK = 0.6;                 // particle-particle heat conductivity
  this.Tamb = 0.32;                 // ambient ocean temperature
  // ---- phase-change thresholds (UI: "Clouds & precipitation") ------------
  // steam → cloud needs BOTH: T ≤ cloudT and local steam density (steam
  // particles per neighbouring cell) ≥ cloudP, above the cloud base
  // (30% of the atmosphere height — the barometric profile is bottom-heavy,
  // so without the gate clouds would condense as fog on the sea surface).
  // steam → rain at T ≤ rainT (ordering-clamped below cloudT); water/rain →
  // snow at T ≤ snowT (clamped below rainT); melt-back reverses snow.
  this.cloudT = opts.cloudT !== undefined ? opts.cloudT : 0.34;
  this.cloudP = opts.cloudP !== undefined ? opts.cloudP : 0.35;
  this.rainT = opts.rainT !== undefined ? opts.rainT : 0.22;
  this.snowT = opts.snowT !== undefined ? opts.snowT : 0.10;
  // melt / evaporate conversion points (Clouds & precipitation sliders).
  // Conversion needs 5% MORE heat than the phase-equilibrium point: ice
  // melts at snowT×1.05 (the melt slider may raise it), water evaporates at
  // evapT×1.05 (evapT 0.40 ≈ the hot-day surface band at shipped sun).
  this.meltT = opts.meltT !== undefined ? opts.meltT : this.snowT * 1.05;
  this.evapT = opts.evapT !== undefined ? opts.evapT : 0.40;
  this._steamCnt = new Int32Array(this.nCells);   // steam density scratch grid
  this._iceIdx = [];                              // snow contact sweep scratch
  this._hCnt = this._alloc('_hCnt', Int32Array, 1); this._hStart = this._alloc('_hStart', Int32Array, 1);
  this._hCur = this._alloc('_hCur', Int32Array, 1); this._hOrd = this._alloc('_hOrd', Int32Array, 1);
  this._advU = this._alloc('_advU', Float64Array, 1); this._advV = this._alloc('_advV', Float64Array, 1); this._advW = this._alloc('_advW', Float64Array, 1);
  this._heatMean = this._alloc('_heatMean', Float64Array, 1); this._heatDelta = this._alloc('_heatDelta', Float64Array, 1);
  this._cfx = this._alloc('_cfx', Float32Array, 1); this._cfy = this._alloc('_cfy', Float32Array, 1); this._cfz = this._alloc('_cfz', Float32Array, 1);
  this._staticTypes = this._alloc('_staticTypes', Uint8Array, 1);   // rasterized static base types (terrain cache)

  this.umax = 0;
  this.dtLast = 0;
  this._simTime = 0;          // sim wall-clock; drives the current field phases
  this.spacing = this.dx * 0.5;
  this.particleVolume = this.spacing * this.spacing * this.spacing;
  this.iso = 1.8;
  this.waterTopY = this.dx + 1;
  this.airborneCount = 0;

  this._tmpV = [0, 0, 0];
  this._tmpV2 = [0, 0, 0];
  this.substepsLast = 0;      // substeps consumed by the last step() frame
  this._gridSampleValid = false;
}

FluidSolver.prototype._allocParticles = function (cap) {
  if (this.capacity >= cap) return;
  this.capacity = cap;
  this.px = this._alloc('px', Float32Array, cap); this.py = this._alloc('py', Float32Array, cap); this.pz = this._alloc('pz', Float32Array, cap);
  this.pvx = this._alloc('pvx', Float32Array, cap); this.pvy = this._alloc('pvy', Float32Array, cap); this.pvz = this._alloc('pvz', Float32Array, cap);
  this.pflag = this._alloc('pflag', Uint8Array, cap);
  this.pcool = this._alloc('pcool', Uint8Array, cap);
  this.pT = this._alloc('pT', Float32Array, cap);
  this.pAir = this._alloc('pAir', Float32Array, cap);
  this.pLight = this._alloc('pLight', Float32Array, cap);
  this.pDepth = this._alloc('pDepth', Uint8Array, cap);
  this.pWx = this._alloc('pWx', Float32Array, cap); this.pWy = this._alloc('pWy', Float32Array, cap); this.pWz = this._alloc('pWz', Float32Array, cap);
  this.pPh = this._alloc('pPh', Float32Array, cap);
};

// ----------------------------------------------------------------- terrain
// Seeded 3D value noise (trilinear over a shuffled hash lattice, quintic
// fade) — the raw material for the planet's eroded surface.
function _terrainNoise(seed) {
  var s = seed >>> 0, perm = new Uint8Array(512), base = new Uint8Array(256);
  var i, j, t;
  for (i = 0; i < 256; i++) base[i] = i;
  for (i = 255; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    j = (s >>> 8) % (i + 1);
    t = base[i]; base[i] = base[j]; base[j] = t;
  }
  for (i = 0; i < 512; i++) perm[i] = base[i & 255];
  function h(ix, iy, iz) {
    return perm[(perm[(perm[ix & 255] + iy) & 255] + iz) & 255] / 255;
  }
  function fade(u) { return u * u * u * (u * (u * 6 - 15) + 10); }
  return function (x, y, z) {
    var ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    var u = fade(x - ix), v = fade(y - iy), w = fade(z - iz);
    var a = h(ix, iy, iz), b = h(ix + 1, iy, iz);
    var c = h(ix, iy + 1, iz), d = h(ix + 1, iy + 1, iz);
    var e = h(ix, iy, iz + 1), f = h(ix + 1, iy, iz + 1);
    var g = h(ix, iy + 1, iz + 1), hh = h(ix + 1, iy + 1, iz + 1);
    var x1 = a + (b - a) * u, x2 = c + (d - c) * u;
    var x3 = e + (f - e) * u, x4 = g + (hh - g) * u;
    var y1 = x1 + (x2 - x1) * v, y2 = x3 + (x4 - x3) * v;
    return y1 + (y2 - y1) * w;
  };
}

// Build the voxel planet: an eroded radial height field — domain-warped
// continent fbm, ridged mountain belts and fine detail, shaped and offset so
// ~27% of the surface stands above sea level (the "sea level" argument).
// Fills `this.terrain`:
//   solid — Uint8 voxel rock field (1 = rock), lattice dv = dx/2
//   R     — Float32 terrain radius sampled on the same lattice, so per-
//           particle terrain queries are a cheap trilinear lookup
//   landFrac — measured on the voxels: fraction of directions above sea level
FluidSolver.prototype.generateTerrain = function (seed, seaLevel) {
  var R1 = this.coreR, Rsl = seaLevel;
  var bump = this.bumpiness === undefined ? 1 : this.bumpiness;
  // Relief scales with the WORLD so any planet radius looks self-similar:
  // basins reach 1.889 ocean-depths below sea level (or 45% of the core
  // radius on small planets), peaks 0.778 ocean-depths above sea level
  // (inside the domain, below the demote limit). At the default world
  // (coreR 1.5, depth 0.45) these are exactly the classic 1.1 / 2.3.
  var depthW = Math.max(Rsl - R1, 1e-4);
  var Rlo = Math.max(R1 * 0.55, Rsl - 1.8889 * depthW);   // deepest ocean floor
  var Rhi = Rsl + 0.7778 * depthW;                        // tallest peaks
  var span = Rhi - Rlo;
  // bumpiness scales ALL relief: near 0 the planet morphs into a smooth
  // voxel sphere wrapped in a uniform shallow sea (the sim stays alive),
  // and from ~0.3 up it opens into continents with scaled roughness
  var mW = Math.min(1, bump / 0.3);           // sphere -> terrain blend
  var Rsph = Rsl - Math.min(0.4 * depthW, 0.45 * (Rsl - Rlo));
  var nf = _terrainNoise(seed);

  // warped fbm continents + ridged mountain ranges + fine erosion detail
  function rawHeight(dx, dy, dz) {
    var wx = nf(dx * 0.9 + 17.3, dy * 0.9 + 9.1, dz * 0.9 + 4.7) - 0.5;
    var wy = nf(dx * 0.9 + 71.9, dy * 0.9 + 33.7, dz * 0.9 + 21.3) - 0.5;
    var wz = nf(dx * 0.9 + 123.4, dy * 0.9 + 87.2, dz * 0.9 + 55.8) - 0.5;
    var qx = dx + 0.35 * wx, qy = dy + 0.35 * wy, qz = dz + 0.35 * wz;
    var h = 0, amp = 1, fr = 1.15, tot = 0, o, v;
    for (o = 0; o < 4; o++) {
      h += amp * nf(qx * fr + 3.1, qy * fr + 7.7, qz * fr + 11.9);
      tot += amp; amp *= 0.5; fr *= 2.1;
    }
    h /= tot;
    var r = 0; amp = 1; fr = 2.6; tot = 0;
    for (o = 0; o < 3; o++) {
      v = nf(qx * fr + 41.2, qy * fr + 23.8, qz * fr + 66.1);
      r += amp * (1 - Math.abs(2 * v - 1));
      tot += amp; amp *= 0.55; fr *= 2.3;
    }
    r /= tot;
    var det = nf(qx * 6.5 + 91.7, qy * 6.5 + 12.4, qz * 6.5 + 78.3);
    // bumpiness scales the roughness (ridges + erosion), not the continents
    return h + 0.45 * bump * (r - 0.5) + 0.14 * bump * (det - 0.5);
  }

  // calibrate on a fixed quasi-uniform direction set: normalize the height,
  // sharpen peaks a little, then offset until 27% of directions clear sea level
  var CALN = 8192, cal = new Float32Array(CALN);
  var cs = seed >>> 0;
  function crnd() { cs = (cs * 1664525 + 1013904223) >>> 0; return cs / 4294967296; }
  var cMin = 1e9, cMax = -1e9;
  for (var ci = 0; ci < CALN; ci++) {
    var u1 = crnd() * 2 - 1, th = crnd() * 6.2831853;
    var sq = Math.sqrt(1 - u1 * u1);
    var hv = rawHeight(sq * Math.cos(th), u1, sq * Math.sin(th));
    cal[ci] = hv;
    if (hv < cMin) cMin = hv; else if (hv > cMax) cMax = hv;
  }
  var cSpan = (cMax - cMin) || 1;
  var hSl = (Rsl - Rlo) / span;             // sea level in height units
  var lo = -1, hi = 1, delta = 0, it, cnt;
  for (it = 0; it < 48; it++) {             // binary-search the offset
    delta = 0.5 * (lo + hi);
    cnt = 0;
    for (ci = 0; ci < CALN; ci++) {
      var h01 = (cal[ci] - cMin) / cSpan;
      var hs = h01 + delta; if (hs < 0) hs = 0; else if (hs > 1) hs = 1;
      if (Math.pow(hs, 1.25) > hSl) cnt++;
    }
    if (cnt > 0.27 * CALN) hi = delta; else lo = delta;
  }
  var offs = delta;
  function terrainR(dx, dy, dz) {           // unit direction -> terrain radius
    if (mW <= 0) return Rsph;               // perfect sphere (voxel steps only)
    var hv = rawHeight(dx, dy, dz);
    var h01 = (hv - cMin) / cSpan + offs;
    if (h01 < 0) h01 = 0; else if (h01 > 1) h01 = 1;
    var rv = Rlo + Math.pow(h01, 1.25) * span;
    return Rsph + (rv - Rsph) * mW;         // blend toward the smooth sphere
  }

  // voxelize onto a lattice twice the solver resolution
  var dv = this.dx / 2;
  var n = Math.ceil(this.W / dv);
  var solid = new Uint8Array(n * n * n);
  var R = new Float32Array(n * n * n);
  var cx = this.cx, cy = this.cy, cz = this.cz;
  var x0 = 0, iv, jv, kv, idx;
  for (kv = 0; kv < n; kv++) {
    var pz0 = (kv + 0.5) * dv - cz;
    for (jv = 0; jv < n; jv++) {
      var py0 = (jv + 0.5) * dv - cy;
      for (iv = 0; iv < n; iv++) {
        var px0 = (iv + 0.5) * dv - cx;
        var rr = Math.sqrt(px0 * px0 + py0 * py0 + pz0 * pz0);
        idx = (kv * n + jv) * n + iv;
        if (rr < 1e-6) { R[idx] = Rlo; solid[idx] = 1; continue; }
        var rv = terrainR(px0 / rr, py0 / rr, pz0 / rr);
        R[idx] = rv;
        if (rr <= rv) solid[idx] = 1;
      }
    }
  }

  // ---- slope smoothing (post-process) ---------------------------------------
  // The raw radius field follows the noise exactly; the contoured surface
  // then shows rough terraced steps. A few Laplacian passes over the radius
  // field relax the high-frequency terracing into smooth slopes (volume
  // preserved by rescaling the mean radius), and the solid mask is rebuilt
  // from the smoothed field so every physics query (_rockCellAt, fill
  // placement, pushout) agrees with the drawn surface.
  // relaxation strength scales with lattice resolution: a coarse lattice
  // (small planets) samples each slope with few voxels, so the same blend
  // would flatten real landforms — the land fraction must survive.
  var PASSES = n < 48 ? 1 : (n < 64 ? 2 : 3);
  var BLEND = n < 48 ? 0.15 : (n < 64 ? 0.35 : 0.5);
  var sN = n, sN2 = n * n;
  for (var ps = 0; ps < PASSES; ps++) {
    for (kv = 1; kv < sN - 1; kv++) {
      var zBase = kv * sN2, zBaseL = (kv - 1) * sN2, zBaseU = (kv + 1) * sN2;
      for (jv = 1; jv < sN - 1; jv++) {
        var yBase = zBase + jv * sN, yBaseL = zBaseL + (jv - 1) * sN, yBaseU = zBaseL + (jv + 1) * sN;
        var yBase2 = zBaseU + (jv - 1) * sN, yBase3 = zBaseU + jv * sN, yBase4 = zBaseU + (jv + 1) * sN;
        var yBaseL2 = zBase + (jv - 1) * sN, yBaseU2 = zBase + (jv + 1) * sN;
        for (iv = 1; iv < sN - 1; iv++) {
          var iR = yBase + iv;
          var avg = (R[iR - 1] + R[iR + 1] + R[yBaseL2 + iv] + R[yBaseU2 + iv] +
                     R[yBaseL + iv] + R[yBase2 + iv] + R[yBase3 + iv] + R[yBase4 + iv] +
                     R[yBaseL + iv - 1] + R[yBaseL + iv + 1] + R[yBase2 + iv - 1] + R[yBase2 + iv + 1] +
                     R[yBaseU + iv] + R[yBase3 + iv - 1] + R[yBase3 + iv + 1] + R[yBase4 + iv] +
                     R[yBaseL2 + iv - 1] + R[yBaseL2 + iv + 1]) * (1 / 18);
          R[iR] += (avg - R[iR]) * BLEND;
        }
      }
    }
  }
  // volume preservation: keep the mean radius the smoothing started with
  var mean0 = 0, mean1 = 0, cntR = 0;
  for (idx = 0; idx < R.length; idx += 7) { mean0 += R[idx]; cntR++; }
  mean0 /= cntR;
  for (var ps2 = 0; ps2 < PASSES; ps2++) {
    for (kv = 1; kv < sN - 1; kv++) for (jv = 1; jv < sN - 1; jv++) {
      var rowS = (kv * sN2 + jv * sN);
      for (iv = 1; iv < sN - 1; iv++) {
        var iS = rowS + iv;
        var avg2 = (R[iS - 1] + R[iS + 1] + R[iS - sN] + R[iS + sN] +
                    R[iS - sN2] + R[iS + sN2]) * (1 / 6);
        R[iS] += (avg2 - R[iS]) * BLEND;
      }
    }
  }
  for (idx = 0; idx < R.length; idx += 7) mean1 += R[idx];
  mean1 /= cntR;
  if (mean1 > 1e-9) {
    var rScale = mean0 / mean1;
    for (idx = 0; idx < R.length; idx++) R[idx] *= rScale;
  }
  // rebuild the solid mask from the SMOOTHED radius (the raw fill used the
  // unsmoothed radius), and build the renderer's isosurface field on the
  // CORNER lattice ((n+1)³): field[c] = R_trilinear(c) − |c − centre|. The
  // renderer contours it with marching tetrahedra at iso 0, so the drawn
  // surface IS the physics surface (terrainRadiusAt trilinear) — the visual
  // slopes and every collision query agree exactly.
  var field = new Float32Array((n + 1) * (n + 1) * (n + 1));
  var nnF = n + 1, invDv = 1 / dv;
  for (kv = 0; kv < n; kv++) {
    var pzS = (kv + 0.5) * dv - cz;
    for (jv = 0; jv < n; jv++) {
      var pyS = (jv + 0.5) * dv - cy;
      var rowS2 = (kv * n + jv) * n;
      for (iv = 0; iv < n; iv++) {
        var pxS = (iv + 0.5) * dv - cx;
        var rrS = Math.sqrt(pxS * pxS + pyS * pyS + pzS * pzS);
        idx = rowS2 + iv;
        solid[idx] = rrS <= R[idx] ? 1 : 0;
      }
    }
  }
  for (kv = 0; kv <= n; kv++) {
    var pzF = kv * dv - cz;
    var fk = kv * dv * invDv - 0.5;
    var k0 = Math.floor(fk), tz = fk - k0;
    if (k0 < 0) { k0 = 0; tz = 0; } else if (k0 > n - 2) { k0 = n - 2; tz = 1; }
    var rowF0 = kv * nnF * nnF;
    for (jv = 0; jv <= n; jv++) {
      var pyF = jv * dv - cy;
      var fj = jv * dv * invDv - 0.5;
      var j0 = Math.floor(fj), ty = fj - j0;
      if (j0 < 0) { j0 = 0; ty = 0; } else if (j0 > n - 2) { j0 = n - 2; ty = 1; }
      var j1 = j0 + 1, k1 = k0 + 1;
      var rowF = rowF0 + jv * nnF;
      var rowJ0 = (k0 * n + j0) * n, rowJ1 = (k0 * n + j1) * n;
      var rowK0 = ((k0 + 1) * n + j0) * n;
      var rowK1 = ((k0 + 1) * n + j1) * n;
      for (iv = 0; iv <= n; iv++) {
        var pxF = iv * dv - cx;
        var rrF = Math.sqrt(pxF * pxF + pyF * pyF + pzF * pzF);
        var fi = iv * dv * invDv - 0.5;
        var i0 = Math.floor(fi), tx = fi - i0;
        if (i0 < 0) { i0 = 0; tx = 0; } else if (i0 > n - 2) { i0 = n - 2; tx = 1; }
        var i1 = i0 + 1;
        // 8 surrounding nodes, trilinear blend of the SMOOTHED radius
        var rA = R[rowJ0 + i0] * (1 - tx) + R[rowJ0 + i1] * tx;
        var rB = R[rowJ1 + i0] * (1 - tx) + R[rowJ1 + i1] * tx;
        var rC2 = R[rowK0 + i0] * (1 - tx) + R[rowK0 + i1] * tx;
        var rD = R[rowK1 + i0] * (1 - tx) + R[rowK1 + i1] * tx;
        var rIJ = rA * (1 - ty) + rB * ty;
        var rKL = rC2 * (1 - ty) + rD * ty;
        field[rowF0 + jv * nnF + iv] = (rIJ * (1 - tz) + rKL * tz) - rrF;
      }
    }
  }

  // land fraction measured on the actual voxels (radial march per direction)
  var LANDN = 4000, land = 0;
  for (ci = 0; ci < LANDN; ci++) {
    var lu = crnd() * 2 - 1, lth = crnd() * 6.2831853;
    var lsq = Math.sqrt(1 - lu * lu);
    var ldx = lsq * Math.cos(lth), ldy = lu, ldz = lsq * Math.sin(lth);
    for (var rr2 = Rhi + dv; rr2 > Rlo - dv; rr2 -= dv * 0.5) {
      var sx = (cx + ldx * rr2) / dv | 0, sy = (cy + ldy * rr2) / dv | 0, sz = (cz + ldz * rr2) / dv | 0;
      if (sx < 0 || sy < 0 || sz < 0 || sx >= n || sy >= n || sz >= n) continue;
      if (solid[(sz * n + sy) * n + sx]) {
        if (rr2 > Rsl) land++;
        break;
      }
    }
  }

  this.terrain = {
    n: n, dv: dv, solid: solid, R: R, field: field,
    Rsl: Rsl, Rlo: Rlo, Rhi: Rhi,
    Rlo2: Rlo * Rlo, Rhi2: Rhi * Rhi,
    landFrac: land / LANDN, seed: seed
  };
  this.landFrac = this.terrain.landFrac;
  this._terrainKey = R1 + '|' + Rsl + '|' + seed + '|' + bump;
  return this.terrain;
};

// Terrain radius at a world point: trilinear lookup in the precomputed
// radius field (O(8) reads instead of re-evaluating the noise).
FluidSolver.prototype.terrainRadiusAt = function (x, y, z) {
  var t = this.terrain;
  if (!t) return this.coreR;
  var n = t.n, dv = t.dv, R = t.R;
  var gx = x / dv - 0.5, gy = y / dv - 0.5, gz = z / dv - 0.5;
  var i = gx | 0, j = gy | 0, k = gz | 0;
  if (i < 0) i = 0; else if (i > n - 2) i = n - 2;
  if (j < 0) j = 0; else if (j > n - 2) j = n - 2;
  if (k < 0) k = 0; else if (k > n - 2) k = n - 2;
  var fx = gx - i, fy = gy - j, fz = gz - k;
  if (fx < 0) fx = 0; else if (fx > 1) fx = 1;
  if (fy < 0) fy = 0; else if (fy > 1) fy = 1;
  if (fz < 0) fz = 0; else if (fz > 1) fz = 1;
  var b000 = (k * n + j) * n + i;
  var s7 = n * n;
  var v000 = R[b000], v100 = R[b000 + 1];
  var v010 = R[b000 + n], v110 = R[b000 + n + 1];
  var v001 = R[b000 + s7], v101 = R[b000 + s7 + 1];
  var v011 = R[b000 + s7 + n], v111 = R[b000 + s7 + n + 1];
  var a0 = v000 + (v100 - v000) * fx, a1 = v010 + (v110 - v010) * fx;
  var a2 = v001 + (v101 - v001) * fx, a3 = v011 + (v111 - v011) * fx;
  var b0 = a0 + (a1 - a0) * fy, b1 = a2 + (a3 - a2) * fy;
  return b0 + (b1 - b0) * fz;
};

// True if the solver cell containing this world point rasterizes SOLID from
// the terrain (the exact rule _rasterize uses, voxel at the cell center).
// All particle placement and pushout is expressed in these terms so the
// water always agrees with the rasterized world — no volume mismatch, no
// startup compression kick.
FluidSolver.prototype._rockCellAt = function (x, y, z) {
  var t = this.terrain;
  if (!t) return false;
  var dx = this.dx, nx = this.nx, ny = this.ny, nz = this.nz;
  var i = (x / dx) | 0, j = (y / dx) | 0, k = (z / dx) | 0;
  if (i < 1) i = 1; else if (i > nx - 2) i = nx - 2;
  if (j < 1) j = 1; else if (j > ny - 2) j = ny - 2;
  if (k < 1) k = 1; else if (k > nz - 2) k = nz - 2;
  if (this._staticTypes && this._staticTerrain === t && this._staticCore === this.coreR) {
    return this._staticTypes[(k * ny + j) * nx + i] === SOLID;
  }
  var tvn = t.n, tvd = t.dv, tvs = t.solid;
  var vx = ((i + 0.5) * dx / tvd) | 0, vy = ((j + 0.5) * dx / tvd) | 0, vz = ((k + 0.5) * dx / tvd) | 0;
  if (vx < 0) vx = 0; else if (vx >= tvn) vx = tvn - 1;
  if (vy < 0) vy = 0; else if (vy >= tvn) vy = tvn - 1;
  if (vz < 0) vz = 0; else if (vz >= tvn) vz = tvn - 1;
  return tvs[(vz * tvn + vy) * tvn + vx] === 1;
};

// True if the EXACT voxel containing this point is solid — finer than the
// cell-center rule above. The drawn terrain mesh is the voxel surface, so
// fill-time placement uses this to guarantee no water particle is ever
// generated visually inside the planet.
FluidSolver.prototype._voxelRockAt = function (x, y, z) {
  var t = this.terrain;
  if (!t) return false;
  var n = t.n, dv = t.dv;
  var i = (x / dv) | 0, j = (y / dv) | 0, k = (z / dv) | 0;
  if (i < 0) i = 0; else if (i > n - 1) i = n - 1;
  if (j < 0) j = 0; else if (j > n - 1) j = n - 1;
  if (k < 0) k = 0; else if (k > n - 1) k = n - 1;
  return t.solid[(k * n + j) * n + i] === 1;
};

// Is terrain rock within one cell BELOW this point (along the local radial
// "down")? Used by the G2P demotion test: puddle particles resting on the
// rock (mountain tops, shores) stay grid-coupled instead of flipping to
// ballistic spray every substep — that flip-flop made water particles
// visibly blink on the peaks.
FluidSolver.prototype._onRockBelow = function (x, y, z) {
  if (this.mode !== 'sphere' || !this.terrain) return false;
  var ex = x - this.cx, ey = y - this.cy, ez = z - this.cz;
  var el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-9;
  var s = this.dx * 0.9 / el;
  return this._rockCellAt(x - ex * s, y - ey * s, z - ez * s);
};

// A random point over a deep-enough ocean column, between the terrain
// surface and the sea level — where splashes and dropped balls belong.
FluidSolver.prototype.oceanPoint = function (minDepth) {
  var need = minDepth || 0.12, t = this.terrain;
  var cx = this.cx, cy = this.cy, cz = this.cz;
  var best = null, bestD = -1;
  for (var att = 0; att < 64; att++) {
    var u1 = Math.random() * 2 - 1, th = Math.random() * 6.2831853;
    var sq = Math.sqrt(1 - u1 * u1);
    var dxn = sq * Math.cos(th), dyn = u1, dzn = sq * Math.sin(th);
    var Rt = this.terrainRadiusAt(cx + dxn * t.Rhi, cy + dyn * t.Rhi, cz + dzn * t.Rhi);
    var dpt = this.oceanR - Rt;
    if (dpt > need) {
      var rm = (Rt + this.oceanR) * 0.5;
      return [cx + dxn * rm, cy + dyn * rm, cz + dzn * rm];
    }
    if (dpt > bestD) { bestD = dpt; best = [cx + dxn * (Rt + this.oceanR) * 0.5, cy + dyn * (Rt + this.oceanR) * 0.5, cz + dzn * (Rt + this.oceanR) * 0.5]; }
  }
  return best || [cx, cy + this.oceanR, cz];
};

// ------------------------------------------------------------------ water fill
FluidSolver.prototype.resetWater = function (depth) {
  this.balls.length = 0;
  if (this.mode === 'sphere') return this._resetWaterSphere(depth);
  var nx = this.nx, dx = this.dx;
  var x0 = dx, x1 = (nx - 1) * dx, z0 = dx, z1 = (this.nz - 1) * dx;
  var Vw = (x1 - x0) * (z1 - z0) * depth;
  var s = Math.cbrt(Vw / this.targetParticles);
  this.spacing = s;
  this.particleVolume = s * s * s;
  var m = 0.6 * s;

  this._allocParticles(this.targetParticles + 8192);
  var px = this.px, py = this.py, pz = this.pz;
  var pvx = this.pvx, pvy = this.pvy, pvz = this.pvz, fl = this.pflag;
  var pcool = this.pcool;
  var n = 0, cap = this.capacity;
  for (var y = dx + m; y < dx + depth - 0.4 * m; y += s) {
    for (var z = z0 + m; z < z1 - 0.6 * m; z += s) {
      for (var x = x0 + m; x < x1 - 0.6 * m; x += s) {
        if (n >= cap) break;
        px[n] = x + (Math.random() - 0.5) * s * 0.3;
        py[n] = y + (Math.random() - 0.5) * s * 0.3;
        pz[n] = z + (Math.random() - 0.5) * s * 0.3;
        pvx[n] = 0; pvy[n] = 0; pvz[n] = 0; fl[n] = 0; pcool[n] = 0;
        n++;
      }
    }
  }
  this.nP = n;
  this.waterTopY = dx + depth;
  this.splatDensity();
  this.iso = this.autotuneIso();
  this.umax = 0;
  this.airborneCount = 0;
};

// Sphere-world fill: the ocean pools in the terrain's basins up to sea level
// (coreR + depth). The voxel terrain is generated once per (coreR, sea level,
// seed) and cached, so pressing reset only refills the water. Water volume
// for the particle spacing comes from a Monte-Carlo sample of the basin shell.
FluidSolver.prototype._resetWaterSphere = function (depth) {
  this.balls.length = 0;
  var R1 = this.coreR, R2 = R1 + depth;
  this.oceanR = R2;
  var seed = this.terrainSeed;
  var key = R1 + '|' + R2 + '|' + seed + '|' + this.bumpiness;
  if (!this.terrain || this._terrainKey !== key) this.generateTerrain(seed, R2);
  var cx = this.cx, cy = this.cy, cz = this.cz;
  var t = this.terrain;

  // Monte-Carlo water volume: fraction of the [Rlo, sea level] shell that is
  // actually water (above the rock) — cheap and exact enough for spacing
  var Vshell = 4 / 3 * Math.PI * (R2 * R2 * R2 - t.Rlo * t.Rlo * t.Rlo);
  // water volume from the same rule the rasterizer uses (cell not solid) —
  // fill and physics agree exactly, so the first substep has nothing to fix
  var MC = 20000, hits = 0, mcS = (seed ^ 0x9e3779b9) >>> 0;
  function mcRnd() { mcS = (mcS * 1664525 + 1013904223) >>> 0; return mcS / 4294967296; }
  for (var mi = 0; mi < MC; mi++) {
    var u1 = mcRnd() * 2 - 1, th = mcRnd() * 6.2831853;
    var sq = Math.sqrt(1 - u1 * u1);
    var rr = Math.cbrt(t.Rlo * t.Rlo * t.Rlo + mcRnd() * (R2 * R2 * R2 - t.Rlo * t.Rlo * t.Rlo));
    var qx = cx + sq * Math.cos(th) * rr, qy = cy + u1 * rr, qz = cz + sq * Math.sin(th) * rr;
    if (!this._rockCellAt(qx, qy, qz)) hits++;
  }
  var Vw = Vshell * hits / MC;
  var s = Math.cbrt(Vw / this.targetParticles);
  this.spacing = s;
  this.particleVolume = s * s * s;
  var rHi = R2 - 0.4 * s;

  this._allocParticles(this.targetParticles + 8192);
  var px = this.px, py = this.py, pz = this.pz;
  var pvx = this.pvx, pvy = this.pvy, pvz = this.pvz, fl = this.pflag;
  var pcool = this.pcool, pT = this.pT;
  // seeded placement jitter: identical fills every run, so headless tests
  // (and A/B calibrations) are exactly reproducible
  var fjS = (seed ^ 0x51ab3c77) >>> 0;
  function fRnd() { fjS = (fjS * 1664525 + 1013904223) >>> 0; return fjS / 4294967296; }
  var n = 0, cap = this.capacity;
  for (var y = cy - R2; y <= cy + R2; y += s) {
    for (var z = cz - R2; z <= cz + R2; z += s) {
      for (var x = cx - R2; x <= cx + R2; x += s) {
        if (n >= cap) break;
        var ex = x - cx, ey = y - cy, ez = z - cz;
        var r2 = ex * ex + ey * ey + ez * ez;
        if (r2 > rHi * rHi) continue;
        // jitter FIRST, then vet the jittered point: the rock tests must see
        // the exact position that will be stored, or a nudge across a cell
        // boundary plants water inside the rock.
        // Never birth water inside the planet: reject anything inside the
        // rasterized rock — cell rule AND exact voxel rule (the drawn terrain
        // mesh is the voxel surface, so clearing every solid voxel guarantees
        // no particle is ever generated inside the planet). No position is
        // moved, so the fill stays mirror-calm.
        var jx = x + (fRnd() - 0.5) * s * 0.3;
        var jy = y + (fRnd() - 0.5) * s * 0.3;
        var jz = z + (fRnd() - 0.5) * s * 0.3;
        if (this._rockCellAt(jx, jy, jz) || this._voxelRockAt(jx, jy, jz)) continue;
        px[n] = jx;
        py[n] = jy;
        pz[n] = jz;
        pvx[n] = 0; pvy[n] = 0; pvz[n] = 0; fl[n] = 0; pcool[n] = 0;
        pT[n] = this.Tamb;
        n++;
      }
    }
  }
  this.nP = n;
  this.pAir.fill(0);
  this.q.fill(0);
  this._heatAcc = 0;
  this.vaporCount = this.nightVaporCount = 0;
  this._gridSampleValid = false;
  this.waterTopY = cy + R2;   // pool-mode sea level (vapor ceiling anchor)
  this._buildPlanetGravity(); // radial gravity faces for the new sea level
  this._gRamp = 0;            // ease gravity in: no startup ring
  this.splatDensity();
  this.iso = this.autotuneIso();
  this.umax = 0;
  this.airborneCount = 0;
};

// ------------------------------------------------------------------- sampling
// Face-grid coords for component 0=u (offsets 0,.5,.5), 1=v (.5,0,.5), 2=w.
// Fills shared temp _fc; face-grid logical dims: u:(nx+1,ny,nz) etc.
var _fc = { i0: 0, j0: 0, k0: 0, tx: 0, ty: 0, tz: 0 };
FluidSolver.prototype._faceCoords = function (comp, x, y, z) {
  var dx = this.dx, a, b, c;
  if (comp === 0)      { a = x / dx;        b = y / dx - 0.5;  c = z / dx - 0.5; }
  else if (comp === 1) { a = x / dx - 0.5;  b = y / dx;        c = z / dx - 0.5; }
  else                 { a = x / dx - 0.5;  b = y / dx - 0.5;  c = z / dx; }
  var i0 = Math.floor(a), j0 = Math.floor(b), k0 = Math.floor(c), tx, ty, tz;
  if (i0 < 0) { i0 = 0; tx = 0; } else if (i0 > this.nx - 1) { i0 = this.nx - 1; tx = 1; } else tx = a - i0;
  if (j0 < 0) { j0 = 0; ty = 0; } else if (j0 > this.ny - 2) { j0 = this.ny - 2; ty = 1; } else ty = b - j0;
  if (k0 < 0) { k0 = 0; tz = 0; } else if (k0 > this.nz - 2) { k0 = this.nz - 2; tz = 1; } else tz = c - k0;
  _fc.i0 = i0; _fc.j0 = j0; _fc.k0 = k0; _fc.tx = tx; _fc.ty = ty; _fc.tz = tz;
  return _fc;
};

FluidSolver.prototype._sampleFace = function (arr, comp, x, y, z) {
  // coordinates inlined (the old _faceCoords call + shared-object roundtrip
  // showed up as the single largest profile entry); identical clamps per comp
  var dx = this.dx, nx = this.nx, ny = this.ny, nz = this.nz;
  var a, b, c, i0, j0, k0, tx, ty, tz, sj, sk, idx;
  if (comp === 0) {
    a = x / dx; b = y / dx - 0.5; c = z / dx - 0.5;
    i0 = Math.floor(a); j0 = Math.floor(b); k0 = Math.floor(c);
    if (i0 < 0) { i0 = 0; tx = 0; } else if (i0 > nx - 1) { i0 = nx - 1; tx = 1; } else tx = a - i0;
    if (j0 < 0) { j0 = 0; ty = 0; } else if (j0 > ny - 2) { j0 = ny - 2; ty = 1; } else ty = b - j0;
    if (k0 < 0) { k0 = 0; tz = 0; } else if (k0 > nz - 2) { k0 = nz - 2; tz = 1; } else tz = c - k0;
    sj = nx + 1; sk = ny * sj; idx = (k0 * ny + j0) * sj + i0;
  } else if (comp === 1) {
    a = x / dx - 0.5; b = y / dx; c = z / dx - 0.5;
    i0 = Math.floor(a); j0 = Math.floor(b); k0 = Math.floor(c);
    if (i0 < 0) { i0 = 0; tx = 0; } else if (i0 > nx - 1) { i0 = nx - 1; tx = 1; } else tx = a - i0;
    if (j0 < 0) { j0 = 0; ty = 0; } else if (j0 > ny - 2) { j0 = ny - 2; ty = 1; } else ty = b - j0;
    if (k0 < 0) { k0 = 0; tz = 0; } else if (k0 > nz - 2) { k0 = nz - 2; tz = 1; } else tz = c - k0;
    sj = nx; sk = (ny + 1) * nx; idx = (k0 * (ny + 1) + j0) * nx + i0;
  } else {
    a = x / dx - 0.5; b = y / dx - 0.5; c = z / dx;
    i0 = Math.floor(a); j0 = Math.floor(b); k0 = Math.floor(c);
    if (i0 < 0) { i0 = 0; tx = 0; } else if (i0 > nx - 1) { i0 = nx - 1; tx = 1; } else tx = a - i0;
    if (j0 < 0) { j0 = 0; ty = 0; } else if (j0 > ny - 2) { j0 = ny - 2; ty = 1; } else ty = b - j0;
    if (k0 < 0) { k0 = 0; tz = 0; } else if (k0 > nz - 2) { k0 = nz - 2; tz = 1; } else tz = c - k0;
    sj = nx; sk = ny * nx; idx = (k0 * ny + j0) * nx + i0;
  }
  var s0 = 1 - tx, s1 = tx, t0 = 1 - ty, t1 = ty, r0 = 1 - tz, r1 = tz;
  var v00 = arr[idx] * s0 + arr[idx + 1] * s1;
  var v10 = arr[idx + sj] * s0 + arr[idx + sj + 1] * s1;
  var v01 = arr[idx + sk] * s0 + arr[idx + sk + 1] * s1;
  var v11 = arr[idx + sk + sj] * s0 + arr[idx + sk + sj + 1] * s1;
  return (v00 * t0 + v10 * t1) * r0 + (v01 * t0 + v11 * t1) * r1;
};

// sample the same face position from TWO grids (old & new) with one set of
// coordinates — used by the FLIP G2P transfer (halves coordinate math)
var _pair = [0, 0];
FluidSolver.prototype._sampleFacePair = function (arrA, arrB, comp, x, y, z) {
  var f = this._faceCoords(comp, x, y, z);
  var i0 = f.i0, j0 = f.j0, k0 = f.k0;
  var s0 = 1 - f.tx, s1 = f.tx, t0 = 1 - f.ty, t1 = f.ty, r0 = 1 - f.tz, r1 = f.tz;
  var idx, sj, sk;
  if (comp === 0) {
    sj = this.nx + 1; sk = this.ny * sj;
    idx = (k0 * this.ny + j0) * sj + i0;
  } else if (comp === 1) {
    sj = this.nx; sk = (this.ny + 1) * this.nx;
    idx = (k0 * (this.ny + 1) + j0) * this.nx + i0;
  } else {
    sj = this.nx; sk = this.ny * this.nx;
    idx = (k0 * this.ny + j0) * this.nx + i0;
  }
  var o1 = idx + sj, o2 = idx + sk, o3 = o2 + sj;
  _pair[0] = ((arrA[idx] * s0 + arrA[idx + 1] * s1) * t0 + (arrA[o1] * s0 + arrA[o1 + 1] * s1) * t1) * r0
           + ((arrA[o2] * s0 + arrA[o2 + 1] * s1) * t0 + (arrA[o3] * s0 + arrA[o3 + 1] * s1) * t1) * r1;
  _pair[1] = ((arrB[idx] * s0 + arrB[idx + 1] * s1) * t0 + (arrB[o1] * s0 + arrB[o1 + 1] * s1) * t1) * r0
           + ((arrB[o2] * s0 + arrB[o2 + 1] * s1) * t0 + (arrB[o3] * s0 + arrB[o3 + 1] * s1) * t1) * r1;
  return _pair;
};

FluidSolver.prototype.sampleVel = function (x, y, z, out) {
  return this._sampleVel3(x, y, z, out || [0, 0, 0]);
};

// Sample all three face components at one point with one shared coordinate
// skeleton (the three face grids repeat the same floor/frac math up to
// half-cell offsets). One call replaces three _sampleFace calls — the fused
// form is the hot sampler for advection, G2P cooldown and ball coupling.
// Coordinate clamps match _faceCoords exactly, so results are bit-identical.
FluidSolver.prototype._sampleVel3 = function (x, y, z, out) {
  var dx = this.dx, nx = this.nx, ny = this.ny, nz = this.nz;
  var i0, j0, k0, tx, ty, tz, a, b, c;
  // ---- u faces (nx+1, ny, nz), offsets (0, .5, .5)
  a = x / dx; b = y / dx - 0.5; c = z / dx - 0.5;
  i0 = Math.floor(a); j0 = Math.floor(b); k0 = Math.floor(c);
  if (i0 < 0) { i0 = 0; tx = 0; } else if (i0 > nx - 1) { i0 = nx - 1; tx = 1; } else tx = a - i0;
  if (j0 < 0) { j0 = 0; ty = 0; } else if (j0 > ny - 2) { j0 = ny - 2; ty = 1; } else ty = b - j0;
  if (k0 < 0) { k0 = 0; tz = 0; } else if (k0 > nz - 2) { k0 = nz - 2; tz = 1; } else tz = c - k0;
  var s0 = 1 - tx, s1 = tx, t0 = 1 - ty, t1 = ty, r0 = 1 - tz, r1 = tz;
  var u = this.u, sj = nx + 1, sk = ny * sj, idx = (k0 * ny + j0) * sj + i0;
  out[0] = ((u[idx] * s0 + u[idx + 1] * s1) * t0 + (u[idx + sj] * s0 + u[idx + sj + 1] * s1) * t1) * r0
         + ((u[idx + sk] * s0 + u[idx + sk + 1] * s1) * t0 + (u[idx + sk + sj] * s0 + u[idx + sk + sj + 1] * s1) * t1) * r1;
  // ---- v faces (nx, ny+1, nz), offsets (.5, 0, .5)
  a = x / dx - 0.5; b = y / dx; c = z / dx - 0.5;
  i0 = Math.floor(a); j0 = Math.floor(b); k0 = Math.floor(c);
  if (i0 < 0) { i0 = 0; tx = 0; } else if (i0 > nx - 1) { i0 = nx - 1; tx = 1; } else tx = a - i0;
  if (j0 < 0) { j0 = 0; ty = 0; } else if (j0 > ny - 2) { j0 = ny - 2; ty = 1; } else ty = b - j0;
  if (k0 < 0) { k0 = 0; tz = 0; } else if (k0 > nz - 2) { k0 = nz - 2; tz = 1; } else tz = c - k0;
  s0 = 1 - tx; s1 = tx; t0 = 1 - ty; t1 = ty; r0 = 1 - tz; r1 = tz;
  var v = this.v; sj = nx; sk = (ny + 1) * nx; idx = (k0 * (ny + 1) + j0) * nx + i0;
  out[1] = ((v[idx] * s0 + v[idx + 1] * s1) * t0 + (v[idx + sj] * s0 + v[idx + sj + 1] * s1) * t1) * r0
         + ((v[idx + sk] * s0 + v[idx + sk + 1] * s1) * t0 + (v[idx + sk + sj] * s0 + v[idx + sk + sj + 1] * s1) * t1) * r1;
  // ---- w faces (nx, ny, nz+1), offsets (.5, .5, 0)
  a = x / dx - 0.5; b = y / dx - 0.5; c = z / dx;
  i0 = Math.floor(a); j0 = Math.floor(b); k0 = Math.floor(c);
  if (i0 < 0) { i0 = 0; tx = 0; } else if (i0 > nx - 1) { i0 = nx - 1; tx = 1; } else tx = a - i0;
  if (j0 < 0) { j0 = 0; ty = 0; } else if (j0 > ny - 2) { j0 = ny - 2; ty = 1; } else ty = b - j0;
  if (k0 < 0) { k0 = 0; tz = 0; } else if (k0 > nz - 2) { k0 = nz - 2; tz = 1; } else tz = c - k0;
  s0 = 1 - tx; s1 = tx; t0 = 1 - ty; t1 = ty; r0 = 1 - tz; r1 = tz;
  var w = this.w; sj = nx; sk = ny * nx; idx = (k0 * ny + j0) * nx + i0;
  out[2] = ((w[idx] * s0 + w[idx + 1] * s1) * t0 + (w[idx + sj] * s0 + w[idx + sj + 1] * s1) * t1) * r0
         + ((w[idx + sk] * s0 + w[idx + sk + 1] * s1) * t0 + (w[idx + sk + sj] * s0 + w[idx + sk + sj + 1] * s1) * t1) * r1;
  return out;
};

// ------------------------------------------------------------- rasterize
// Static world (terrain rock + shell + balls -> SOLID cells, moving-solid
// velocities). The particle marking pass is a separate method so callers can
// re-mark without re-rasterizing the static world.
FluidSolver.prototype._rasterize = function () {
  this._rasterizeStatic();
  this._markFluidCells(0, this.nP);
};

FluidSolver.prototype._rasterizeStatic = function () {
  var nx = this.nx, ny = this.ny, nz = this.nz, type = this.cellType;
  var i, j, k;
  if (this._staticTypes && this._staticTypes.length >= this.nCells &&
      this._staticTerrain === this.terrain && this._staticCore === this.coreR) {
    type.set(this._staticTypes);
  } else {
  if (this.mode === 'sphere') {
    // ocean planet: voxel terrain rock + closed domain shell, air elsewhere
    var dxr = this.dx;
    var tv = this.terrain, tvn = tv ? tv.n : 0, tvd = tv ? tv.dv : 1, tvs = tv ? tv.solid : null;
    var coreR2 = this.coreR * this.coreR;
    var cx = this.cx, cy = this.cy, cz = this.cz;
    for (k = 0; k < nz; k++) {
      var dz2 = (k + 0.5) * dxr - cz; dz2 *= dz2;
      for (j = 0; j < ny; j++) {
        var row = (k * ny + j) * nx;
        var dy2 = (j + 0.5) * dxr - cy; dy2 *= dy2;
        var shell = (j === 0 || j === ny - 1 || k === 0 || k === nz - 1);
        for (i = 0; i < nx; i++) {
          var rock = false;
          if (tvs) {
            // sample the terrain voxel containing this cell's center
            var vx = ((i + 0.5) * dxr / tvd) | 0, vy = ((j + 0.5) * dxr / tvd) | 0, vz = ((k + 0.5) * dxr / tvd) | 0;
            if (vx < 0) vx = 0; else if (vx >= tvn) vx = tvn - 1;
            if (vy < 0) vy = 0; else if (vy >= tvn) vy = tvn - 1;
            if (vz < 0) vz = 0; else if (vz >= tvn) vz = tvn - 1;
            rock = tvs[(vz * tvn + vy) * tvn + vx] === 1;
          } else {
            var dx2 = (i + 0.5) * dxr - cx; dx2 *= dx2;
            rock = dx2 + dy2 + dz2 < coreR2;
          }
          type[row + i] = (shell || i === 0 || i === nx - 1 || rock) ? SOLID : AIR;
        }
      }
    }
  } else {
    for (k = 0; k < nz; k++) {
      for (j = 0; j < ny; j++) {
        var row = (k * ny + j) * nx;
        var solid = (j === 0 || j === ny - 1 || k === 0 || k === nz - 1);
        for (i = 0; i < nx; i++) {
          type[row + i] = (solid || i === 0 || i === nx - 1) ? SOLID : AIR;
        }
      }
    }
  }
    if (!this._staticTypes || this._staticTypes.length < this.nCells) {
      this._staticTypes = this._alloc('_staticTypes', Uint8Array, this.nCells);
    }
    this._staticTypes.set(type);
    this._staticTerrain = this.terrain; this._staticCore = this.coreR;
  }
  if (this.balls.length || this._hadSolidVelocity) {
    this.svx.fill(0); this.svy.fill(0); this.svz.fill(0);
  }
  this._hadSolidVelocity = this.balls.length > 0;

  // balls become moving solids
  var dx = this.dx;
  for (var n = 0; n < this.balls.length; n++) {
    var b = this.balls[n], r = b.r, rr = (r + 0.4 * dx) * (r + 0.4 * dx);
    var i0 = clamp(Math.floor((b.x - r) / dx), 1, nx - 2), i1 = clamp(Math.ceil((b.x + r) / dx), 1, nx - 2);
    var j0 = clamp(Math.floor((b.y - r) / dx), 1, ny - 2), j1 = clamp(Math.ceil((b.y + r) / dx), 1, ny - 2);
    var k0 = clamp(Math.floor((b.z - r) / dx), 1, nz - 2), k1 = clamp(Math.ceil((b.z + r) / dx), 1, nz - 2);
    for (k = k0; k <= k1; k++) for (j = j0; j <= j1; j++) for (i = i0; i <= i1; i++) {
      var cx = (i + 0.5) * dx - b.x, cy = (j + 0.5) * dx - b.y, cz = (k + 0.5) * dx - b.z;
      if (cx * cx + cy * cy + cz * cz <= rr) {
        var ci = (k * ny + j) * nx + i;
        this.cellType[ci] = SOLID;
        this.svx[ci] = b.vx; this.svy[ci] = b.vy; this.svz[ci] = b.vz;
      }
    }
  }
};

// Particles mark fluid cells (airborne droplets stay ballistic — they must
// not form pseudo-fluid layers that stick to the ceiling). Chunkable:
// particles are independent; the AIR->FLUID byte upgrade is idempotent under
// concurrent writers, demotions write per-particle flags only.
FluidSolver.prototype._markFluidCells = function (p0, p1) {
  var px = this.px, py = this.py, pz = this.pz, nP = this.nP;
  var flg = this.pflag;
  var dx = this.dx, nx = this.nx, ny = this.ny, nz = this.nz;
  var i, j, k;
  // ceiling guard: fluid pressed against the ceiling shell would be pressure-
  // supported forever ("water under a lid"). maxSpeed keeps normal surface
  // water well below this line, so it can never act as a suspension shelf.
  var jTop = ny - 2;
  for (var p = p0; p < p1; p++) {
    if (flg[p] !== 0) continue;   // droplets and vapor never mark cells
    // A stray re-entered parcel cannot create a pressure-supported sea in
    // the sky. Terrain puddles are retained; genuinely airborne water rains.
    if (this.mode === 'sphere') {
      var rx = px[p] - this.cx, ry = py[p] - this.cy, rz = pz[p] - this.cz;
      var radius2 = rx * rx + ry * ry + rz * rz;
      // rock-cell exemption: a bead sitting in a peak cell near the domain
      // shell is resting on terrain, not flying — demoting it made summit
      // particles flap between spray and puddle (visible blinking)
      if (radius2 > (this.oceanR + 0.3) * (this.oceanR + 0.3) &&
          Math.sqrt(radius2) - this.terrainRadiusAt(px[p], py[p], pz[p]) > 0.3 &&
          !this._rockCellAt(px[p], py[p], pz[p])) {
        flg[p] = 1; continue;
      }
    }
    i = clamp(Math.floor(px[p] / dx), 0, nx - 1);
    j = clamp(Math.floor(py[p] / dx), 0, ny - 1);
    k = clamp(Math.floor(pz[p] / dx), 0, nz - 1);
    if (j >= jTop) {
      // Ceiling guard ("water under a lid"). In pool mode the box top is the
      // water surface limit — demote anything pressed into it. On the planet
      // the box top is just empty space over the north pole, and polar seas /
      // summit puddles legitimately reach it: demoting them made particles
      // blink on the mountain tops (spray ⇄ puddle every substep). There,
      // demote only water genuinely flying high above the ground.
      if (this.mode === 'sphere') {
        var jx = px[p] - this.cx, jy = py[p] - this.cy, jz = pz[p] - this.cz;
        if (Math.sqrt(jx * jx + jy * jy + jz * jz) - this.terrainRadiusAt(px[p], py[p], pz[p]) > 0.3) {
          flg[p] = 1; // demote to spray; it rains back down
          continue;
        }
      } else {
        flg[p] = 1;   // demote to spray; it rains back down
        continue;
      }
    }
    var idx = (k * ny + j) * nx + i;
    if (this.cellType[idx] === AIR) this.cellType[idx] = FLUID;
  }
};

// ------------------------------------------------------- particle-ball coupling
// Chunked over particles with all balls inside: each particle meets the balls
// in the same order as the serial path, so chunked results are identical.
FluidSolver.prototype._pushOutOfBalls = function () {
  this._pushBallsChunk(0, this.nP);
};

FluidSolver.prototype._pushBallsChunk = function (p0, p1) {
  var px = this.px, py = this.py, pz = this.pz, pvx = this.pvx, pvy = this.pvy, pvz = this.pvz;
  for (var n = 0; n < this.balls.length; n++) {
    var b = this.balls[n], rr = b.r + 0.002;
    for (var p = p0; p < p1; p++) {
      var ex = px[p] - b.x, ey = py[p] - b.y, ez = pz[p] - b.z;
      var d2 = ex * ex + ey * ey + ez * ez;
      if (d2 < rr * rr) {
        var d = Math.sqrt(d2) || 1e-9, inv = 1 / d;
        var nxn = ex * inv, nyn = ey * inv, nzn = ez * inv;
        px[p] = b.x + nxn * rr; py[p] = b.y + nyn * rr; pz[p] = b.z + nzn * rr;
        var rvx = pvx[p] - b.vx, rvy = pvy[p] - b.vy, rvz = pvz[p] - b.vz;
        var vn = rvx * nxn + rvy * nyn + rvz * nzn;
        if (vn < 0) { pvx[p] -= nxn * vn; pvy[p] -= nyn * vn; pvz[p] -= nzn * vn; }
      }
    }
  }
};

// ---------------------------------------------------------------------- P2G
// Scatter into the grids, then normalize by weights (one call).
FluidSolver.prototype._p2g = function () {
  this._p2gInto(0, this.nP, this.u, this.v, this.w, this.uW, this.vW, this.wW);
  this._p2gNormalizeFace(0, this.uN + this.vN + this.wN);
};

FluidSolver.prototype._p2gInto = function (p0, p1, u, v, w, uW, vW, wW) {
  var px = this.px, py = this.py, pz = this.pz, pvx = this.pvx, pvy = this.pvy, pvz = this.pvz;
  // strides hoisted out of the loop; face coordinates inlined per component
  // (three _faceCoords calls per particle were a top-3 profile entry)
  var nx = this.nx, ny = this.ny, nz = this.nz, dx = this.dx;
  var sjU = nx + 1, skU = ny * sjU;
  var sjV = nx, skV = (ny + 1) * nx;
  var sjW = nx, skW = ny * nx;
  var i0, j0, k0, tx, ty, tz, a, b, c, idx, o1, o2, o3;
  var s0, s1, t0, t1, r0, r1;

  for (var p = p0; p < p1; p++) {
    if (this.pflag[p] !== 0) continue; // droplets/vapor are ballistic; momentum
                                       // transfers when they splash back in
    var x = px[p], y = py[p], z = pz[p], vx = pvx[p], vy = pvy[p], vz = pvz[p];

    // ---- u faces: logical grid (nx+1, ny, nz), offsets (0, .5, .5)
    a = x / dx; b = y / dx - 0.5; c = z / dx - 0.5;
    i0 = Math.floor(a); j0 = Math.floor(b); k0 = Math.floor(c);
    if (i0 < 0) { i0 = 0; tx = 0; } else if (i0 > nx - 1) { i0 = nx - 1; tx = 1; } else tx = a - i0;
    if (j0 < 0) { j0 = 0; ty = 0; } else if (j0 > ny - 2) { j0 = ny - 2; ty = 1; } else ty = b - j0;
    if (k0 < 0) { k0 = 0; tz = 0; } else if (k0 > nz - 2) { k0 = nz - 2; tz = 1; } else tz = c - k0;
    s0 = 1 - tx; s1 = tx; t0 = 1 - ty; t1 = ty; r0 = 1 - tz; r1 = tz;
    idx = (k0 * ny + j0) * sjU + i0;
    var wA = s0 * t0, wB = s1 * t0, wC = s0 * t1, wD = s1 * t1;
    u[idx] += wA * r0 * vx; uW[idx] += wA * r0;
    u[idx + 1] += wB * r0 * vx; uW[idx + 1] += wB * r0;
    u[idx + sjU] += wC * r0 * vx; uW[idx + sjU] += wC * r0;
    u[idx + sjU + 1] += wD * r0 * vx; uW[idx + sjU + 1] += wD * r0;
    u[idx + skU] += wA * r1 * vx; uW[idx + skU] += wA * r1;
    u[idx + skU + 1] += wB * r1 * vx; uW[idx + skU + 1] += wB * r1;
    u[idx + skU + sjU] += wC * r1 * vx; uW[idx + skU + sjU] += wC * r1;
    u[idx + skU + sjU + 1] += wD * r1 * vx; uW[idx + skU + sjU + 1] += wD * r1;

    // ---- v faces: logical grid (nx, ny+1, nz), offsets (.5, 0, .5)
    a = x / dx - 0.5; b = y / dx; c = z / dx - 0.5;
    i0 = Math.floor(a); j0 = Math.floor(b); k0 = Math.floor(c);
    if (i0 < 0) { i0 = 0; tx = 0; } else if (i0 > nx - 1) { i0 = nx - 1; tx = 1; } else tx = a - i0;
    if (j0 < 0) { j0 = 0; ty = 0; } else if (j0 > ny - 2) { j0 = ny - 2; ty = 1; } else ty = b - j0;
    if (k0 < 0) { k0 = 0; tz = 0; } else if (k0 > nz - 2) { k0 = nz - 2; tz = 1; } else tz = c - k0;
    s0 = 1 - tx; s1 = tx; t0 = 1 - ty; t1 = ty; r0 = 1 - tz; r1 = tz;
    idx = (k0 * (ny + 1) + j0) * nx + i0;
    wA = s0 * t0; wB = s1 * t0; wC = s0 * t1; wD = s1 * t1;
    v[idx] += wA * r0 * vy; vW[idx] += wA * r0;
    v[idx + 1] += wB * r0 * vy; vW[idx + 1] += wB * r0;
    v[idx + sjV] += wC * r0 * vy; vW[idx + sjV] += wC * r0;
    v[idx + sjV + 1] += wD * r0 * vy; vW[idx + sjV + 1] += wD * r0;
    v[idx + skV] += wA * r1 * vy; vW[idx + skV] += wA * r1;
    v[idx + skV + 1] += wB * r1 * vy; vW[idx + skV + 1] += wB * r1;
    v[idx + skV + sjV] += wC * r1 * vy; vW[idx + skV + sjV] += wC * r1;
    v[idx + skV + sjV + 1] += wD * r1 * vy; vW[idx + skV + sjV + 1] += wD * r1;

    // ---- w faces: logical grid (nx, ny, nz+1), offsets (.5, .5, 0)
    a = x / dx - 0.5; b = y / dx - 0.5; c = z / dx;
    i0 = Math.floor(a); j0 = Math.floor(b); k0 = Math.floor(c);
    if (i0 < 0) { i0 = 0; tx = 0; } else if (i0 > nx - 1) { i0 = nx - 1; tx = 1; } else tx = a - i0;
    if (j0 < 0) { j0 = 0; ty = 0; } else if (j0 > ny - 2) { j0 = ny - 2; ty = 1; } else ty = b - j0;
    if (k0 < 0) { k0 = 0; tz = 0; } else if (k0 > nz - 2) { k0 = nz - 2; tz = 1; } else tz = c - k0;
    s0 = 1 - tx; s1 = tx; t0 = 1 - ty; t1 = ty; r0 = 1 - tz; r1 = tz;
    idx = (k0 * ny + j0) * nx + i0;
    wA = s0 * t0; wB = s1 * t0; wC = s0 * t1; wD = s1 * t1;
    w[idx] += wA * r0 * vz; wW[idx] += wA * r0;
    w[idx + 1] += wB * r0 * vz; wW[idx + 1] += wB * r0;
    w[idx + sjW] += wC * r0 * vz; wW[idx + sjW] += wC * r0;
    w[idx + sjW + 1] += wD * r0 * vz; wW[idx + sjW + 1] += wD * r0;
    w[idx + skW] += wA * r1 * vz; wW[idx + skW] += wA * r1;
    w[idx + skW + 1] += wB * r1 * vz; wW[idx + skW + 1] += wB * r1;
    w[idx + skW + sjW] += wC * r1 * vz; wW[idx + skW + sjW] += wC * r1;
    w[idx + skW + sjW + 1] += wD * r1 * vz; wW[idx + skW + sjW + 1] += wD * r1;
  }
};

// Normalize accumulated face momenta by their accumulated weights over the
// combined face range [f0, f1) (0..uN u, then v, then w).
FluidSolver.prototype._p2gNormalizeFace = function (f0, f1) {
  var u = this.u, v = this.v, w = this.w, uW = this.uW, vW = this.vW, wW = this.wW;
  var uN = this.uN, vN = this.vN, F = uN + vN + this.wN;
  var i, ie;
  ie = f1 < uN ? f1 : uN;
  for (i = f0 > 0 ? f0 : 0; i < ie; i++) if (uW[i] > 1e-8) u[i] /= uW[i];
  var vEnd = uN + vN;
  ie = f1 < vEnd ? f1 : vEnd;
  for (i = f0 > uN ? f0 : uN; i < ie; i++) if (vW[i - uN] > 1e-8) v[i - uN] /= vW[i - uN];
  ie = f1 < F ? f1 : F;
  for (i = f0 > vEnd ? f0 : vEnd; i < ie; i++) if (wW[i - vEnd] > 1e-8) w[i - vEnd] /= wW[i - vEnd];
};

// ---------------------------------------------------------- boundary conditions
FluidSolver.prototype._applyBC = function () {
  this._applyBCSlice(0, this.nz);
};

// k-slab slice of the boundary conditions: per-k domain planes plus the
// solid-adjacent face loops for k in [k0, k1). Faces in disjoint k slabs are
// independent, so this parallelizes across workers.
FluidSolver.prototype._applyBCSlice = function (k0, k1) {
  var u = this.u, v = this.v, w = this.w;
  var nx = this.nx, ny = this.ny, nz = this.nz;
  var type = this.cellType, svx = this.svx, svy = this.svy, svz = this.svz;
  var i, j, k, cL, cR, idx;

  // domain boundary faces are walls (no normal flow)
  for (k = k0; k < k1; k++) for (j = 0; j < ny; j++) {
    u[(k * ny + j) * (nx + 1)] = 0;               // i = 0
    u[(k * ny + j) * (nx + 1) + nx] = 0;          // i = nx
  }
  for (k = k0; k < k1; k++) for (i = 0; i < nx; i++) {
    v[(k * (ny + 1)) * nx + i] = 0;               // j = 0
    v[(k * (ny + 1) + ny) * nx + i] = 0;          // j = ny
  }
  if (k0 <= 0) for (j = 0; j < ny; j++) for (i = 0; i < nx; i++) {
    w[(0 * ny + j) * nx + i] = 0;                 // k = 0
  }
  if (k1 >= nz) for (j = 0; j < ny; j++) for (i = 0; i < nx; i++) {
    w[(nz * ny + j) * nx + i] = 0;                // k = nz
  }

  // faces adjacent to solids take the solid velocity (wall: 0, ball: v_ball)
  for (k = k0; k < k1; k++) for (j = 0; j < ny; j++) for (i = 1; i < nx; i++) {
    cL = type[(k * ny + j) * nx + i - 1]; cR = type[(k * ny + j) * nx + i];
    idx = (k * ny + j) * (nx + 1) + i;
    if (cL === SOLID) u[idx] = svx[(k * ny + j) * nx + i - 1];
    else if (cR === SOLID) u[idx] = svx[(k * ny + j) * nx + i];
  }
  for (k = k0; k < k1; k++) for (j = 1; j < ny; j++) for (i = 0; i < nx; i++) {
    cL = type[(k * ny + j - 1) * nx + i]; cR = type[(k * ny + j) * nx + i];
    idx = (k * (ny + 1) + j) * nx + i;
    if (cL === SOLID) v[idx] = svy[(k * ny + j - 1) * nx + i];
    else if (cR === SOLID) v[idx] = svy[(k * ny + j) * nx + i];
  }
  for (k = k0 > 1 ? k0 : 1; k < k1; k++) for (j = 0; j < ny; j++) for (i = 0; i < nx; i++) {
    cL = type[((k - 1) * ny + j) * nx + i]; cR = type[(k * ny + j) * nx + i];
    idx = (k * ny + j) * nx + i;
    if (cL === SOLID) w[idx] = svz[((k - 1) * ny + j) * nx + i];
    else if (cR === SOLID) w[idx] = svz[(k * ny + j) * nx + i];
  }
};

// ------------------------------------------- planet gravity on the grid
// Precompute the radial gravitational acceleration on every staggered face:
// a = -g (oceanR/r)^2 r̂ (the same inverse-square law the droplets and balls
// feel). Rebuilt with the terrain since it depends on the sea level.
FluidSolver.prototype._buildPlanetGravity = function () {
  var nx = this.nx, ny = this.ny, nz = this.nz, dx = this.dx;
  var cx = this.cx, cy = this.cy, cz = this.cz;
  var g0 = this.oceanR * this.oceanR; // unit-g geometry; slider scales at application
  var gu = this._alloc('_gu', Float32Array, this.u.length);
  var gv = this._alloc('_gv', Float32Array, this.v.length);
  var gw = this._alloc('_gw', Float32Array, this.w.length);
  var i, j, k, idx;
  for (k = 0; k < nz; k++) for (j = 0; j < ny; j++) {
    var ey = (j + 0.5) * dx - cy, ez = (k + 0.5) * dx - cz;
    for (i = 0; i <= nx; i++) {
      var ex = i * dx - cx;
      var r3 = Math.pow(ex * ex + ey * ey + ez * ez, 1.5) || 1e-9;
      gu[(k * ny + j) * (nx + 1) + i] = -g0 * ex / r3;
    }
  }
  for (k = 0; k < nz; k++) for (j = 0; j <= ny; j++) {
    var ey2 = j * dx - cy, ez2 = (k + 0.5) * dx - cz;
    for (i = 0; i < nx; i++) {
      var exx = (i + 0.5) * dx - cx;
      var r32 = Math.pow(exx * exx + ey2 * ey2 + ez2 * ez2, 1.5) || 1e-9;
      gv[(k * (ny + 1) + j) * nx + i] = -g0 * ey2 / r32;
    }
  }
  for (k = 0; k <= nz; k++) for (j = 0; j < ny; j++) {
    var ey3 = (j + 0.5) * dx - cy, ez3 = k * dx - cz;
    for (i = 0; i < nx; i++) {
      var ex3 = (i + 0.5) * dx - cx;
      var r33 = Math.pow(ex3 * ex3 + ey3 * ey3 + ez3 * ez3, 1.5) || 1e-9;
      gw[(k * ny + j) * nx + i] = -g0 * ez3 / r33;
    }
  }
  this._gu = gu; this._gv = gv; this._gw = gw;
};

// Add radial gravity to every face with at least one fluid neighbor (the
// following _applyBC then zeroes the solid-adjacent ones). Air-region faces
// stay clean so extrapolation cannot spread phantom currents. After a fill
// the strength ramps in over ~1.5 s — snapping full gravity onto a fresh
// lattice makes the whole ocean ring while the pressure field catches up.
FluidSolver.prototype._applyPlanetGravity = function (dt) {
  var gu = this._gu;
  if (!gu) return;
  var gs = this._gRamp / 1.5; if (gs > 1) gs = 1;
  this._gRamp += dt;
  if (gs <= 0) return;
  gs *= this.gravity;
  this._applyPlanetGravitySlice(0, this.nz, dt, gs);
};

// k-slab slice; the caller owns the ramp/scale (gs) so workers never mutate
// the ramp timer concurrently.
FluidSolver.prototype._applyPlanetGravitySlice = function (k0, k1, dt, gs) {
  var gu = this._gu;
  if (!gu || gs <= 0) return;
  var u = this.u, v = this.v, w = this.w, gv = this._gv, gw = this._gw;
  var nx = this.nx, ny = this.ny, nz = this.nz, type = this.cellType;
  var FL = FLUID, i, j, k, cL, cR, idx;
  for (k = k0; k < k1; k++) for (j = 0; j < ny; j++) {
    var base = k * ny + j, row = base * nx;
    for (i = 1; i < nx; i++) {
      cL = type[row + i - 1]; cR = type[row + i];
      if (cL === FL || cR === FL) { idx = base * (nx + 1) + i; u[idx] += gu[idx] * dt * gs; }
    }
  }
  for (k = k0; k < k1; k++) for (j = 1; j < ny; j++) {
    var base2 = k * (ny + 1) + j, row2 = base2 * nx;
    for (i = 0; i < nx; i++) {
      cL = type[(k * ny + j - 1) * nx + i]; cR = type[(k * ny + j) * nx + i];
      if (cL === FL || cR === FL) { idx = row2 + i; v[idx] += gv[idx] * dt * gs; }
    }
  }
  for (k = k0 > 1 ? k0 : 1; k < k1; k++) for (j = 0; j < ny; j++) {
    var row3 = (k * ny + j) * nx;
    for (i = 0; i < nx; i++) {
      cL = type[((k - 1) * ny + j) * nx + i]; cR = type[row3 + i];
      if (cL === FL || cR === FL) { idx = row3 + i; w[idx] += gw[idx] * dt * gs; }
    }
  }
};

// ------------------------------------------------------------------ viscosity
FluidSolver.prototype._viscosity = function (dt) {
  var nu = this.viscosity;
  if (nu <= 1e-6) return;
  var nx = this.nx, ny = this.ny, nz = this.nz, dx = this.dx, type = this.cellType;
  // explicit diffusion; clamp for stability: nu*dt/dx^2 <= 0.24
  var coef = Math.min(nu * dt / (dx * dx), 0.24);
  var u = this.u, v = this.v, w = this.w;
  var i, j, k, idx, idxl, val;

  for (k = 0; k < nz; k++) for (j = 0; j < ny; j++) for (i = 1; i < nx; i++) {
    if (type[(k * ny + j) * nx + i - 1] !== FLUID || type[(k * ny + j) * nx + i] !== FLUID) continue;
    idx = (k * ny + j) * (nx + 1) + i;
    val = u[idx] * 6;
    idxl = idx - 1;           val -= (i - 1 >= 0) ? u[idxl] : u[idx];
    idxl = idx + 1;           val -= (i + 1 <= nx) ? u[idxl] : u[idx];
    idxl = idx - (nx + 1);    val -= (j - 1 >= 0) ? u[idxl] : u[idx];
    idxl = idx + (nx + 1);    val -= (j + 1 < ny) ? u[idxl] : u[idx];
    idxl = idx - ny * (nx + 1); val -= (k - 1 >= 0) ? u[idxl] : u[idx];
    idxl = idx + ny * (nx + 1); val -= (k + 1 < nz) ? u[idxl] : u[idx];
    u[idx] += coef * val;
  }
  for (k = 0; k < nz; k++) for (j = 1; j < ny; j++) for (i = 0; i < nx; i++) {
    if (type[(k * ny + j - 1) * nx + i] !== FLUID || type[(k * ny + j) * nx + i] !== FLUID) continue;
    idx = (k * (ny + 1) + j) * nx + i;
    val = v[idx] * 6;
    idxl = idx - 1;              val -= (i - 1 >= 0) ? v[idxl] : v[idx];
    idxl = idx + 1;              val -= (i + 1 < nx) ? v[idxl] : v[idx];
    idxl = idx - nx;             val -= (j - 1 >= 0) ? v[idxl] : v[idx];
    idxl = idx + nx;             val -= (j + 1 <= ny) ? v[idxl] : v[idx];
    idxl = idx - (ny + 1) * nx;  val -= (k - 1 >= 0) ? v[idxl] : v[idx];
    idxl = idx + (ny + 1) * nx;  val -= (k + 1 < nz) ? v[idxl] : v[idx];
    v[idx] += coef * val;
  }
  for (k = 1; k < nz; k++) for (j = 0; j < ny; j++) for (i = 0; i < nx; i++) {
    if (type[((k - 1) * ny + j) * nx + i] !== FLUID || type[(k * ny + j) * nx + i] !== FLUID) continue;
    idx = (k * ny + j) * nx + i;
    val = w[idx] * 6;
    idxl = idx - 1;          val -= (i - 1 >= 0) ? w[idxl] : w[idx];
    idxl = idx + 1;          val -= (i + 1 < nx) ? w[idxl] : w[idx];
    idxl = idx - nx;         val -= (j - 1 >= 0) ? w[idxl] : w[idx];
    idxl = idx + nx;         val -= (j + 1 < ny) ? w[idxl] : w[idx];
    idxl = idx - ny * nx;    val -= (k - 1 >= 0) ? w[idxl] : w[idx];
    idxl = idx + ny * nx;    val -= (k + 1 <= nz) ? w[idxl] : w[idx];
    w[idx] += coef * val;
  }
};

// ----------------------------------------------------------- pressure solve
// Solves  (Nf + Na) * phi_c - sum_fluid phi_n = -dx^2 * div_c  over fluid
// cells with SOR Gauss-Seidel. Air neighbors are Dirichlet phi = 0 (free
// surface, p = p_atm); solid neighbors are Neumann (their face velocities
// already carry the solid motion). The solution q is kept per CELL (not per
// compressed row) so it warm-starts the next substep's solve.
FluidSolver.prototype._pressureSolve = function () {
  var nx = this.nx, ny = this.ny, nz = this.nz, dx = this.dx;
  var type = this.cellType, u = this.u, v = this.v, w = this.w;
  var nb = this.nb, diag = this.diag, rhs = this.rhs, q = this.q;
  var nF = 0, i, j, k, c, fi;

  if (!this.fluidList) this.fluidList = new Int32Array(this.nCells);
  var fluidList = this.fluidList;

  // pass 1: collect fluid cells; non-fluid cells keep q = 0 (p = p_atm)
  for (k = 0; k < nz; k++) for (j = 0; j < ny; j++) {
    var row = k * ny + j;
    for (i = 0; i < nx; i++) {
      c = row * nx + i;
      if (type[c] !== FLUID) { q[c] = 0; continue; }
      fluidList[nF++] = c;
    }
  }
  if (nF === 0) { this.cellPhi.set(q); return; }   // copy: leave q intact
  this.nFluid = nF;

  // pass 2: assemble rows
  //   diag[c] = Nf + Na;  off-diag = fluid neighbor cell id (or -1);
  //   rhs[c] = -dx^2 * div_c  (solid faces already carry the solid velocity)
  var nxy = nx * ny;
  for (fi = 0; fi < nF; fi++) {
    c = fluidList[fi];
    i = c % nx;
    j = ((c / nx) | 0) % ny;
    k = (c / nxy) | 0;
    var r6 = c * 6, Nf = 0, Na = 0;

    var cm = i > 0 ? c - 1 : -1;          // -x neighbor
    var cp = i < nx - 1 ? c + 1 : -1;     // +x neighbor
    var cd = j > 0 ? c - nx : -1;         // -y neighbor
    var cu = j < ny - 1 ? c + nx : -1;    // +y neighbor
    var cb = k > 0 ? c - nxy : -1;        // -z neighbor
    var cf = k < nz - 1 ? c + nxy : -1;   // +z neighbor

    var n, t;
    for (var d = 0; d < 6; d++) {
      n = d === 0 ? cm : d === 1 ? cp : d === 2 ? cd : d === 3 ? cu : d === 4 ? cb : cf;
      if (n < 0) { nb[r6 + d] = -1; continue; }
      t = type[n];
      if (t === FLUID) { nb[r6 + d] = n; Nf++; }
      else if (t === AIR) { nb[r6 + d] = -1; Na++; }
      else { nb[r6 + d] = -1; }
    }

    diag[c] = Nf + Na;
    var div = (u[(k * ny + j) * (nx + 1) + i + 1] - u[(k * ny + j) * (nx + 1) + i] +
               v[(k * (ny + 1) + j + 1) * nx + i] - v[(k * (ny + 1) + j) * nx + i] +
               w[((k + 1) * ny + j) * nx + i] - w[(k * ny + j) * nx + i]) / dx;
    rhs[c] = -dx * dx * div;
  }

  // SOR Gauss-Seidel, warm-started from the previous substep's q.
  // Iterates over a compact CSR adjacency (fluid neighbors only, built once
  // per substep): the hot loop does packed reads instead of six
  // branch-guarded nb[] lookups, and the relaxation coefficients are
  // precomputed per row. Math is identical to q += omega*(qn - q):
  //   q <- (1-omega) q + (omega/diag)(rhs + sum),   qn = (rhs+sum)/diag
  // with diag == 0 rows held at q = 0 exactly as before (qn = 0).
  var omega = this.omega, iters = this.pressureIters;
  var om1 = 1 - omega;
  var pStart = this._pStart, pAdj = this._pAdj, pW = this._pW;
  if (!pStart || pStart.length < nF + 1) {
    pStart = this._pStart = new Int32Array(nF + 1);
    pAdj = this._pAdj = new Int32Array(6 * nF);
    pW = this._pW = new Float32Array(nF);
  }
  var na = 0, d2;
  for (fi = 0; fi < nF; fi++) {
    pStart[fi] = na;
    c = fluidList[fi];
    var r6 = c * 6;
    for (d2 = 0; d2 < 6; d2++) {
      var nn = nb[r6 + d2];
      if (nn >= 0) pAdj[na++] = nn;
    }
    var dgW = diag[c];
    pW[fi] = dgW > 0 ? omega / dgW : 0;
  }
  pStart[nF] = na;

  for (var it = 0; it < iters; it++) {
    for (fi = 0; fi < nF; fi++) {
      var sum = 0;
      for (var ai = pStart[fi], ae = pStart[fi + 1]; ai < ae; ai++) sum += q[pAdj[ai]];
      c = fluidList[fi];
      q[c] = q[c] * om1 + pW[fi] * (rhs[c] + sum);
    }
  }

  // project() reads cellPhi; q is cell-indexed with q = 0 at non-fluid cells.
  // COPY (not rebind): q is scratch the caller may keep referencing
  // their own view of it and a rebind would leave them reading stale zeros.
  this.cellPhi.set(q);
};

FluidSolver.prototype._project = function () {
  this._projectSlice(0, this.nz);
};

// k-slab slice of the projection (faces in disjoint k slabs are independent).
FluidSolver.prototype._projectSlice = function (k0, k1) {
  var nx = this.nx, ny = this.ny, nz = this.nz, dx = this.dx, inv = 1 / dx;
  var type = this.cellType, phi = this.cellPhi, u = this.u, v = this.v, w = this.w;
  var i, j, k, cL, cR, idx, pL, pR;

  for (k = k0; k < k1; k++) for (j = 0; j < ny; j++) for (i = 1; i < nx; i++) {
    cL = type[(k * ny + j) * nx + i - 1]; cR = type[(k * ny + j) * nx + i];
    if (cL === SOLID || cR === SOLID) continue;
    pL = cL === FLUID ? phi[(k * ny + j) * nx + i - 1] : 0;
    pR = cR === FLUID ? phi[(k * ny + j) * nx + i] : 0;
    u[(k * ny + j) * (nx + 1) + i] -= (pR - pL) * inv;
  }
  for (k = k0; k < k1; k++) for (j = 1; j < ny; j++) for (i = 0; i < nx; i++) {
    cL = type[(k * ny + j - 1) * nx + i]; cR = type[(k * ny + j) * nx + i];
    if (cL === SOLID || cR === SOLID) continue;
    pL = cL === FLUID ? phi[(k * ny + j - 1) * nx + i] : 0;
    pR = cR === FLUID ? phi[(k * ny + j) * nx + i] : 0;
    v[(k * (ny + 1) + j) * nx + i] -= (pR - pL) * inv;
  }
  for (k = k0 > 1 ? k0 : 1; k < k1; k++) for (j = 0; j < ny; j++) for (i = 0; i < nx; i++) {
    cL = type[((k - 1) * ny + j) * nx + i]; cR = type[(k * ny + j) * nx + i];
    if (cL === SOLID || cR === SOLID) continue;
    pL = cL === FLUID ? phi[((k - 1) * ny + j) * nx + i] : 0;
    pR = cR === FLUID ? phi[(k * ny + j) * nx + i] : 0;
    w[(k * ny + j) * nx + i] -= (pR - pL) * inv;
  }
};

// ------------------------------------------------------- vorticity confinement
// Small eddies are the first casualty of a coarse MAC grid: numerical
// diffusion smears their spin into uniform flow. Vorticity confinement
// (Fedkiw/Stam/Jensen 2001) measures the surviving vorticity omega = curl(u),
// finds each vorticity maximum (N = grad|omega|, normalized) and adds a force
// f = eps (N x omega) that swirls fluid AROUND the eddy core — shear layers
// roll up into whirlpools, splash crowns curl, wakes persist. Hard-capped in
// acceleration and applied only between fluid cells, it can never outrun the
// global velocity clamp.
FluidSolver.prototype._vorticityConfinement = function (dt) {
  var eps = this.vorticity;
  if (!(eps > 0)) return;
  var nx = this.nx, ny = this.ny, nz = this.nz, nCells = this.nCells;
  var type = this.cellType, u = this.u, v = this.v, w = this.w;
  var nxy = nx * ny;

  var cx = this._vcx, cy = this._vcy, cz = this._vcz;
  var omg = this._omg, ox = this._omx, oy = this._omy, oz = this._omz;
  if (!cx || cx.length !== nCells) {
    cx = this._vcx = new Float32Array(nCells);   // first centered velocities,
    cy = this._vcy = new Float32Array(nCells);   // then reused as the force
    cz = this._vcz = new Float32Array(nCells);
    omg = this._omg = new Float32Array(nCells);
    ox = this._omx = new Float32Array(nCells);
    oy = this._omy = new Float32Array(nCells);
    oz = this._omz = new Float32Array(nCells);
  }

  // cell-centered velocities — faces carry values everywhere after P2G/BC
  // (air faces far from fluid are 0), so the free-surface shear is the real one
  var i, j, k, c;
  for (k = 0; k < nz; k++) {
    for (j = 0; j < ny; j++) {
      var rowC = (k * ny + j) * nx, rowU = (k * ny + j) * (nx + 1);
      var rowV = (k * (ny + 1) + j) * nx;
      for (i = 0; i < nx; i++) {
        c = rowC + i;
        cx[c] = 0.5 * (u[rowU + i] + u[rowU + i + 1]);
        cy[c] = 0.5 * (v[rowV + i] + v[rowV + nx + i]);
        cz[c] = 0.5 * (w[rowC + i] + w[rowC + nxy + i]);
      }
    }
  }

  // vorticity at cell centers (central differences)
  var inv2 = 0.5 / this.dx;
  for (k = 0; k < nz; k++) {
    for (j = 0; j < ny; j++) {
      var row = (k * ny + j) * nx;
      for (i = 0; i < nx; i++) {
        c = row + i;
        var im = i > 0 ? c - 1 : c, ip = i < nx - 1 ? c + 1 : c;
        var jm = j > 0 ? c - nx : c, jp = j < ny - 1 ? c + nx : c;
        var km = k > 0 ? c - nxy : c, kp = k < nz - 1 ? c + nxy : c;
        var wx = (cz[jp] - cz[jm] - (cy[kp] - cy[km])) * inv2;
        var wy = (cx[kp] - cx[km] - (cz[ip] - cz[im])) * inv2;
        var wz = (cy[ip] - cy[im] - (cx[jp] - cx[jm])) * inv2;
        ox[c] = wx; oy[c] = wy; oz[c] = wz;
        omg[c] = Math.sqrt(wx * wx + wy * wy + wz * wz);
      }
    }
  }

  // confinement force per cell: f = eps (N x omega), N = grad|omega|/|grad|
  // Two gates keep it honest:
  //  - INTERIOR fluid cells only (all 6 neighbors fluid): the free-surface
  //    skin carries a huge fake shear (still air vs moving water) that would
  //    let confinement feed on itself — swirl, more shear, more swirl.
  //  - A vorticity floor: only actual eddies (|omega| above noise level) are
  //    confined, so the force can never amplify numerical noise into a slow
  //    energy ratchet; dying eddies sink below the floor and dissipate.
  // Walked over the pressure solve's fluid list (this substep's fluid cells)
  // instead of the whole grid; air neighbors keep their centered velocities
  // from the pass above, which the vorticity stencil below still reads.
  var fCap = 6.0;                        // m/s^2 — swirl never outruns gravity
  var omFloor = 0.35;                    // rad/s — noise stays unconfined
  var fluidList = this.fluidList, nF = this.nFluid | 0, fi;
  for (fi = 0; fi < nF; fi++) {
    c = fluidList[fi];
    i = c % nx; j = ((c / nx) | 0) % ny; k = (c / nxy) | 0;
    if (omg[c] < omFloor ||
        (i > 0 && type[c - 1] !== FLUID) || (i < nx - 1 && type[c + 1] !== FLUID) ||
        (j > 0 && type[c - nx] !== FLUID) || (j < ny - 1 && type[c + nx] !== FLUID) ||
        (k > 0 && type[c - nxy] !== FLUID) || (k < nz - 1 && type[c + nxy] !== FLUID)) {
      cx[c] = 0; cy[c] = 0; cz[c] = 0; continue;
    }
    var gx = omg[i < nx - 1 ? c + 1 : c] - omg[i > 0 ? c - 1 : c],
        gy = omg[j < ny - 1 ? c + nx : c] - omg[j > 0 ? c - nx : c],
        gz = omg[k < nz - 1 ? c + nxy : c] - omg[k > 0 ? c - nxy : c];
    var g2 = gx * gx + gy * gy + gz * gz;
    if (g2 < 1e-12) { cx[c] = 0; cy[c] = 0; cz[c] = 0; continue; }
    var inv = 1 / Math.sqrt(g2);
    var Nx = gx * inv, Ny = gy * inv, Nz = gz * inv;
    var fx = eps * (Ny * oz[c] - Nz * oy[c]);
    var fy = eps * (Nz * ox[c] - Nx * oz[c]);
    var fz = eps * (Nx * oy[c] - Ny * ox[c]);
    var f2 = fx * fx + fy * fy + fz * fz;
    if (f2 > fCap * fCap) { var fs = fCap / Math.sqrt(f2); fx *= fs; fy *= fs; fz *= fs; }
    cx[c] = fx * dt; cy[c] = fy * dt; cz[c] = fz * dt;   // velocity deltas
  }

  // splat the delta onto faces between two fluid cells — every such face is
  // the +x/+y/+z face of exactly one fluid cell, so one fluid-list walk
  // covers the same faces as the three full-grid sweeps it replaces
  for (fi = 0; fi < nF; fi++) {
    c = fluidList[fi];
    i = c % nx; j = ((c / nx) | 0) % ny; k = (c / nxy) | 0;
    if (i < nx - 1 && type[c + 1] === FLUID)
      u[(k * ny + j) * (nx + 1) + i + 1] += 0.5 * (cx[c] + cx[c + 1]);
    if (j < ny - 1 && type[c + nx] === FLUID)
      v[(k * (ny + 1) + j + 1) * nx + i] += 0.5 * (cy[c] + cy[c + nx]);
    if (k < nz - 1 && type[c + nxy] === FLUID)
      w[((k + 1) * ny + j) * nx + i] += 0.5 * (cz[c] + cz[c + nxy]);
  }
};

// -------------------------------------------- velocity extension into air
FluidSolver.prototype._extrapolate = function () {
  var passes = 1;
  var comps = [
    [this.u, this.uW, this.validU, this.nx + 1, this.ny, this.nz],
    [this.v, this.vW, this.validV, this.nx, this.ny + 1, this.nz],
    [this.w, this.wW, this.validW, this.nx, this.ny, this.nz + 1]
  ];
  for (var ci = 0; ci < 3; ci++) {
    var arr = comps[ci][0], wgt = comps[ci][1], valid = comps[ci][2];
    var d0 = comps[ci][3], d1 = comps[ci][4], d2 = comps[ci][5];
    var type = this.cellType, nx = this.nx, ny = this.ny, nz = this.nz, nxy = nx * ny;
    var i, j, k, idx, N = arr.length;
    // valid: P2G-weighted faces, or faces on a solid boundary (BC values are
    // meaningful sources and must never be overwritten by extension).
    // Cell neighbors are walked incrementally instead of being rebuilt from
    // (k,j,i) for every face — identical marks, a third of the arithmetic.
    for (k = 0; k < d2; k++) {
      var kc = k * ny;
      for (j = 0; j < d1; j++) {
        var base = (k * d1 + j) * d0;
        var rowC = (kc + j) * nx;
        if (ci === 0) {
          for (i = 0; i < d0; i++) {
            idx = base + i;
            var solidAdj = i === 0 || i === nx;
            if (!solidAdj) {
              var cl = rowC + i - 1;
              solidAdj = type[cl] === SOLID || type[cl + 1] === SOLID;
            }
            valid[idx] = (wgt[idx] > 1e-8 || solidAdj) ? 1 : 0;
          }
        } else if (ci === 1) {
          var rowUp = rowC - nx;
          for (i = 0; i < d0; i++) {
            idx = base + i;
            var solidAdjV = j === 0 || j === ny;
            if (!solidAdjV) solidAdjV = type[rowUp + i] === SOLID || type[rowC + i] === SOLID;
            valid[idx] = (wgt[idx] > 1e-8 || solidAdjV) ? 1 : 0;
          }
        } else {
          var rowBack = rowC - nxy;
          for (i = 0; i < d0; i++) {
            idx = base + i;
            var solidAdjW = k === 0 || k === nz;
            if (!solidAdjW) solidAdjW = type[rowBack + i] === SOLID || type[rowC + i] === SOLID;
            valid[idx] = (wgt[idx] > 1e-8 || solidAdjW) ? 1 : 0;
          }
        }
      }
    }
    var sK = d0 * d1;
    for (var p = 0; p < passes; p++) {
      for (k = 0; k < d2; k++) {
        var kLo = k > 0, kHi = k < d2 - 1;
        for (j = 0; j < d1; j++) {
          var base2 = (k * d1 + j) * d0;
          var jLo = j > 0, jHi = j < d1 - 1;
          for (i = 0; i < d0; i++) {
            idx = base2 + i;
            if (valid[idx]) continue;
            var sum = 0, cnt = 0;
            if (i > 0 && valid[idx - 1]) { sum += arr[idx - 1]; cnt++; }
            if (i < d0 - 1 && valid[idx + 1]) { sum += arr[idx + 1]; cnt++; }
            if (jLo && valid[idx - d0]) { sum += arr[idx - d0]; cnt++; }
            if (jHi && valid[idx + d0]) { sum += arr[idx + d0]; cnt++; }
            if (kLo && valid[idx - sK]) { sum += arr[idx - sK]; cnt++; }
            if (kHi && valid[idx + sK]) { sum += arr[idx + sK]; cnt++; }
            if (cnt > 0) { arr[idx] = sum / cnt; valid[idx] = 2; } // mark new
          }
        }
      }
      for (idx = 0; idx < N; idx++) if (valid[idx] === 2) valid[idx] = 1;
    }
  }
};

// ---------------------------------------------------------------------- G2P
FluidSolver.prototype._g2p = function (dt) {
  this.airborneCount = this._g2pChunk(0, this.nP, dt);
  this._gridSampleValid = true;
};

// Chunkable G2P: particles read the (read-only) grid and write only their own
// arrays — fully parallel. Returns the chunk's airborne count.
FluidSolver.prototype._g2pChunk = function (p0, p1, dt) {
  var px = this.px, py = this.py, pz = this.pz, pvx = this.pvx, pvy = this.pvy, pvz = this.pvz;
  var u = this.u, v = this.v, w = this.w, uO = this.uO, vO = this.vO, wO = this.wO;
  var pic = this.pic, nP = this.nP, dx = this.dx;
  var nx = this.nx, ny = this.ny, nz = this.nz, type = this.cellType;
  var fl = this.pflag;
  var pcool = this.pcool;
  var airCount = 0;
  if (!this._advU || this._advU.length < nP) {
    this._advU = this._alloc('_advU', Float64Array, this.capacity);
    this._advV = this._alloc('_advV', Float64Array, this.capacity);
    this._advW = this._alloc('_advW', Float64Array, this.capacity);
  }
  var advU = this._advU, advV = this._advV, advW = this._advW;
  var sjU = nx + 1, skU = ny * sjU;
  var sjV = nx, skV = (ny + 1) * nx;
  var sjW = nx, skW = ny * nx;

  for (var p = p0; p < p1; p++) {
    if (fl[p] !== 0) { airCount++; continue; }   // droplets/vapor stay ballistic
    if (pcool[p] > 0) {
      // merge cooldown: fresh splash-back skips the FLIP delta so the
      // redirect ratchet cannot re-launch it. Short (3 substeps): just the
      // impact substeps. Gravity still integrates so cooled mass cannot
      // freeze into a supporting lid.
      pcool[p]--;
      pvy[p] -= this.gravity * (dt || this.dtLast || 0.01);
      this._sampleVel3(px[p], py[p], pz[p], this._tmpV);
      advU[p] = this._tmpV[0]; advV[p] = this._tmpV[1]; advW[p] = this._tmpV[2];
      continue;
    }
    var x = px[p], y = py[p], z = pz[p];

    // One coordinate skeleton per component samples old AND new grids (FLIP
    // delta) — pair sampling fully inlined: the three _faceCoords roundtrips
    // per particle were the single largest profile entry.
    var ou, nu, ov, nv, ow, nw;
    var i0, j0, k0, tx, ty, tz, idx, o1, o2, o3, s0, s1, t0, t1, r0, r1, fa, fb, fc;
    // ---- u faces (nx+1, ny, nz), offsets (0, .5, .5)
    fa = x / dx; fb = y / dx - 0.5; fc = z / dx - 0.5;
    i0 = Math.floor(fa); j0 = Math.floor(fb); k0 = Math.floor(fc);
    if (i0 < 0) { i0 = 0; tx = 0; } else if (i0 > nx - 1) { i0 = nx - 1; tx = 1; } else tx = fa - i0;
    if (j0 < 0) { j0 = 0; ty = 0; } else if (j0 > ny - 2) { j0 = ny - 2; ty = 1; } else ty = fb - j0;
    if (k0 < 0) { k0 = 0; tz = 0; } else if (k0 > nz - 2) { k0 = nz - 2; tz = 1; } else tz = fc - k0;
    s0 = 1 - tx; s1 = tx; t0 = 1 - ty; t1 = ty; r0 = 1 - tz; r1 = tz;
    idx = (k0 * ny + j0) * sjU + i0;
    o1 = idx + sjU; o2 = idx + skU; o3 = o2 + sjU;
    ou = ((uO[idx] * s0 + uO[idx + 1] * s1) * t0 + (uO[o1] * s0 + uO[o1 + 1] * s1) * t1) * r0
       + ((uO[o2] * s0 + uO[o2 + 1] * s1) * t0 + (uO[o3] * s0 + uO[o3 + 1] * s1) * t1) * r1;
    nu = ((u[idx] * s0 + u[idx + 1] * s1) * t0 + (u[o1] * s0 + u[o1 + 1] * s1) * t1) * r0
       + ((u[o2] * s0 + u[o2 + 1] * s1) * t0 + (u[o3] * s0 + u[o3 + 1] * s1) * t1) * r1;
    // ---- v faces (nx, ny+1, nz), offsets (.5, 0, .5)
    fa = x / dx - 0.5; fb = y / dx; fc = z / dx - 0.5;
    i0 = Math.floor(fa); j0 = Math.floor(fb); k0 = Math.floor(fc);
    if (i0 < 0) { i0 = 0; tx = 0; } else if (i0 > nx - 1) { i0 = nx - 1; tx = 1; } else tx = fa - i0;
    if (j0 < 0) { j0 = 0; ty = 0; } else if (j0 > ny - 2) { j0 = ny - 2; ty = 1; } else ty = fb - j0;
    if (k0 < 0) { k0 = 0; tz = 0; } else if (k0 > nz - 2) { k0 = nz - 2; tz = 1; } else tz = fc - k0;
    s0 = 1 - tx; s1 = tx; t0 = 1 - ty; t1 = ty; r0 = 1 - tz; r1 = tz;
    idx = (k0 * (ny + 1) + j0) * nx + i0;
    o1 = idx + sjV; o2 = idx + skV; o3 = o2 + sjV;
    ov = ((vO[idx] * s0 + vO[idx + 1] * s1) * t0 + (vO[o1] * s0 + vO[o1 + 1] * s1) * t1) * r0
       + ((vO[o2] * s0 + vO[o2 + 1] * s1) * t0 + (vO[o3] * s0 + vO[o3 + 1] * s1) * t1) * r1;
    nv = ((v[idx] * s0 + v[idx + 1] * s1) * t0 + (v[o1] * s0 + v[o1 + 1] * s1) * t1) * r0
       + ((v[o2] * s0 + v[o2 + 1] * s1) * t0 + (v[o3] * s0 + v[o3 + 1] * s1) * t1) * r1;
    // ---- w faces (nx, ny, nz+1), offsets (.5, .5, 0)
    fa = x / dx - 0.5; fb = y / dx - 0.5; fc = z / dx;
    i0 = Math.floor(fa); j0 = Math.floor(fb); k0 = Math.floor(fc);
    if (i0 < 0) { i0 = 0; tx = 0; } else if (i0 > nx - 1) { i0 = nx - 1; tx = 1; } else tx = fa - i0;
    if (j0 < 0) { j0 = 0; ty = 0; } else if (j0 > ny - 2) { j0 = ny - 2; ty = 1; } else ty = fb - j0;
    if (k0 < 0) { k0 = 0; tz = 0; } else if (k0 > nz - 2) { k0 = nz - 2; tz = 1; } else tz = fc - k0;
    s0 = 1 - tx; s1 = tx; t0 = 1 - ty; t1 = ty; r0 = 1 - tz; r1 = tz;
    idx = (k0 * ny + j0) * nx + i0;
    o1 = idx + sjW; o2 = idx + skW; o3 = o2 + sjW;
    ow = ((wO[idx] * s0 + wO[idx + 1] * s1) * t0 + (wO[o1] * s0 + wO[o1 + 1] * s1) * t1) * r0
       + ((wO[o2] * s0 + wO[o2 + 1] * s1) * t0 + (wO[o3] * s0 + wO[o3 + 1] * s1) * t1) * r1;
    nw = ((w[idx] * s0 + w[idx + 1] * s1) * t0 + (w[o1] * s0 + w[o1 + 1] * s1) * t1) * r0
       + ((w[o2] * s0 + w[o2 + 1] * s1) * t0 + (w[o3] * s0 + w[o3 + 1] * s1) * t1) * r1;
    // Advection samples this exact position on the unchanged grid next.
    // Reuse these doubles instead of three more trilinear interpolations.
    advU[p] = nu; advV[p] = nv; advW[p] = nw;

    // FLIP: v += (u_new - u_old);  PIC: v = u_new;  blended
    pvx[p] = (pvx[p] + nu - ou) * (1 - pic) + nu * pic;
    pvy[p] = (pvy[p] + nv - ov) * (1 - pic) + nv * pic;
    pvz[p] = (pvz[p] + nw - ow) * (1 - pic) + nw * pic;

    // hard clamp on particle velocity (FLIP deltas can accumulate past the
    // advection clamp in chaotic splashes)
    var pv2 = pvx[p] * pvx[p] + pvy[p] * pvy[p] + pvz[p] * pvz[p];
    if (pv2 > this.maxSpeed * this.maxSpeed) {
      var psc = this.maxSpeed / Math.sqrt(pv2);
      pvx[p] *= psc; pvy[p] *= psc; pvz[p] *= psc;
    }

    // launch as droplet if fully surrounded by air — UNLESS the particle
    // rests on terrain (a bead/puddle on a peak): those stay grid-coupled,
    // demoting them made summit particles blink between spray and puddle
    var ci = clamp(Math.floor(x / dx), 0, nx - 1);
    var cj = clamp(Math.floor(y / dx), 0, ny - 1);
    var ck = clamp(Math.floor(z / dx), 0, nz - 1);
    var c = (ck * ny + cj) * nx + ci;
    if (type[c] === AIR) {
      var fluidNbr =
        (ci > 0 && type[c - 1] === FLUID) || (ci < nx - 1 && type[c + 1] === FLUID) ||
        (cj > 0 && type[c - nx] === FLUID) || (cj < ny - 1 && type[c + nx] === FLUID) ||
        (ck > 0 && type[c - nx * ny] === FLUID) || (ck < nz - 1 && type[c + nx * ny] === FLUID);
      if (!fluidNbr && !this._onRockBelow(x, y, z)) { fl[p] = 1; airCount++; }
    }
  }
  return airCount;
};

// ------------------------------------------------------------------ advection
FluidSolver.prototype._advect = function (dt) {
  this._advectChunk(0, this.nP, dt);
  this._gridSampleValid = false;
  // ball collisions after advection
  this._pushOutOfBalls();
};

// Chunkable advection: per-particle physics only (grid reads are read-only;
// RNG streams are re-seeded per chunk). Balls are pushed out
// by the caller afterwards (see _pushBallsChunk).
FluidSolver.prototype._advectChunk = function (p0, p1, dt) {
  var px = this.px, py = this.py, pz = this.pz, pvx = this.pvx, pvy = this.pvy, pvz = this.pvz;
  var nP = this.nP, dx = this.dx, g = this.gravity;
  var nx = this.nx, ny = this.ny, nz = this.nz, type = this.cellType, fl = this.pflag;
  var pcool = this.pcool, pAir = this.pAir;
  var W = this.W, H = this.H, D = this.D;
  var xLo = dx * 1.02, xHi = W - dx * 1.02;
  var yLo = dx * 1.02, yHi = H - dx * 1.02;
  var zLo = dx * 1.02, zHi = D - dx * 1.02;
  var tmp = this._tmpV;
  var tmp2 = this._tmpV2;
  var sphere = this.mode === 'sphere';
  var cx = this.cx, cy = this.cy, cz = this.cz;
  var domHi = this.domainR - dx * 0.02;            // sphere-mode outer limit
  var coreLo = this.coreR + dx * 1.02;             // sphere fallback (no terrain)
  var hasTerr = !!this.terrain;
  var windSun = this.sunPos, windSX = 1, windSY = 0, windSZ = 0;
  if (windSun) {
    windSX = windSun[0] - cx; windSY = windSun[1] - cy; windSZ = windSun[2] - cz;
    var windLen = Math.sqrt(windSX * windSX + windSY * windSY + windSZ * windSZ) || 1;
    windSX /= windLen; windSY /= windLen; windSZ /= windLen;
  }

  var rainTe = Math.min(this.rainT, this.cloudT - 0.02); if (rainTe < 0) rainTe = 0;
  for (var p = p0; p < p1; p++) {
    var x = px[p], y = py[p], z = pz[p];
    var vx = pvx[p], vy = pvy[p], vz = pvz[p];

    if (fl[p] === 5) {
      // ice: STUCK grains (sea ice, snow pack — pAir 1) hold position and
      // never move again; FREE grains (freezing rain, pAir 0) flutter down
      // under gravity with strong drag until they touch terrain (→ stick),
      // the liquid (→ melt and merge) or another grain (see _iceContacts)
      if (pAir[p] === 1 || !this.terrain && this.mode === 'sphere') {
        pvx[p] = 0; pvy[p] = 0; pvz[p] = 0;
        continue;
      }
      var dragK = 12;                      // snow terminal ≈ 0.6·g/dragK
      var gI = this.gravity || 9.81;
      var axI = 0, ayI = -gI * 0.6, azI = 0;
      if (this.mode !== 'sphere') ayI = -gI * 0.6;
      else {
        var exI = x - this.cx, eyI = y - this.cy, ezI = z - this.cz;
        var elI = Math.sqrt(exI * exI + eyI * eyI + ezI * ezI) || 1e-9;
        axI = -gI * 0.6 * exI / elI; ayI = -gI * 0.6 * eyI / elI; azI = -gI * 0.6 * ezI / elI;
      }
      pvx[p] += (axI - dragK * pvx[p]) * dt;
      pvy[p] += (ayI - dragK * pvy[p]) * dt;
      pvz[p] += (azI - dragK * pvz[p]) * dt;
      x += pvx[p] * dt; y += pvy[p] * dt; z += pvz[p] * dt;
      var rrI;
      if (this.mode === 'sphere') {
        rrI = Math.sqrt((x - this.cx) * (x - this.cx) + (y - this.cy) * (y - this.cy) + (z - this.cz) * (z - this.cz));
        if (rrI > this.oceanR + this.atmosphereH) {
          var scI = (this.oceanR + this.atmosphereH) / rrI;
          x = this.cx + (x - this.cx) * scI; y = this.cy + (y - this.cy) * scI; z = this.cz + (z - this.cz) * scI;
          pvx[p] *= 0.5; pvy[p] *= 0.5; pvz[p] *= 0.5;
        }
        if (this._rockCellAt(x, y, z)) {
          // terrain contact: freeze to the spot for good
          pAir[p] = 1; pvx[p] = pvy[p] = pvz[p] = 0;
          px[p] = x; py[p] = y; pz[p] = z;
          continue;
        }
        var ciI = Math.floor(x / dx), cjI = Math.floor(y / dx), ckI = Math.floor(z / dx);
        if (ciI >= 0 && cjI >= 0 && ckI >= 0 && ciI < nx && cjI < ny && ckI < nz &&
            type[(ckI * ny + cjI) * nx + ciI] === FLUID) {
          // ice is buoyant: it CANNOT sink into the liquid. Raft it to the
          // water surface along the radial (march outward until the cell is
          // no longer fluid), park it there as a floating raft (stuck — it
          // still melts back per the melt point), and never let it descend.
          var miI = ciI, mjI = cjI, mkI = ckI;
          var exF = x - this.cx, eyF = y - this.cy, ezF = z - this.cz;
          var elF = Math.sqrt(exF * exF + eyF * eyF + ezF * ezF) || 1e-9;
          var stepF = dx * 0.5, surfR = 0;
          for (var mf = 0; mf < 12; mf++) {
            var qxI = x + exF / elF * stepF, qyI = y + eyF / elF * stepF, qzI = z + ezF / elF * stepF;
            var qiI = Math.floor(qxI / dx), qjI = Math.floor(qyI / dx), qkI = Math.floor(qzI / dx);
            if (qiI < 0 || qjI < 0 || qkI < 0 || qiI >= nx || qjI >= ny || qkI >= nz) break;
            if (type[(qkI * ny + qjI) * nx + qiI] !== FLUID) { surfR = 1; break; }
            x = qxI; y = qyI; z = qzI;
            miI = qiI; mjI = qjI; mkI = qkI;
          }
          miI = miI;   // (cell indices kept for clarity — position is what matters)
          pAir[p] = 1; pvx[p] = pvy[p] = pvz[p] = 0;   // float: stuck at the surface
          if (this.pWx && this.pWx.length > p) { this.pWx[p] = 0; this.pWy[p] = 0; this.pWz[p] = 0; }
        }
      } else {
        if (y > this.yHi) { y = this.yHi; pvy[p] = -Math.abs(pvy[p]) * 0.2; }
        if (y <= this.yLo + 0.001) {   // floor: sticks
          y = this.yLo + 0.001; pAir[p] = 1; pvx[p] = pvy[p] = pvz[p] = 0;
        }
      }
      px[p] = x; py[p] = y; pz[p] = z;
      continue;
    }
    if (fl[p] === 1 || fl[p] === 4) {
      // ballistic droplet (spray + rain): gravity + air drag, capped at
      // terminal speed
      if (sphere) {
        // same inverse-square planet law as the grid: a = -g·(R2/r)²·r̂
        var gx = x - cx, gy = y - cy, gz = z - cz;
        var gr2 = gx * gx + gy * gy + gz * gz;
        var ga = g * this.oceanR * this.oceanR * dt / (gr2 * Math.sqrt(gr2));
        pvx[p] = vx - gx * ga; pvy[p] = vy - gy * ga; pvz[p] = vz - gz * ga;
      } else {
        pvy[p] = vy - g * dt;
      }
      var dr = 1 - 2.5 * dt; if (dr < 0) dr = 0; // air drag drains spray energy
      pvx[p] *= dr; pvy[p] *= dr; pvz[p] *= dr;
      var dsp = Math.sqrt(pvx[p] * pvx[p] + pvy[p] * pvy[p] + pvz[p] * pvz[p]);
      if (dsp > this.maxSpeed) {
        var dsc = this.maxSpeed / dsp;
        pvx[p] *= dsc; pvy[p] *= dsc; pvz[p] *= dsc;
      }
      x += pvx[p] * dt; y += pvy[p] * dt; z += pvz[p] * dt;
      if (sphere) {
        var bx = x - cx, by = y - cy, bz = z - cz;
        var br = Math.sqrt(bx * bx + by * by + bz * bz) || 1e-9;
        // Airborne water may rise the FULL atmosphere the slider promises:
        // the ceiling is exactly oceanR + atmosphereH — the simulation shell
        // only has to contain the ocean and its terrain, and never extends
        // the sky on big planets where the grid box is taller than the air.
        var skyHi = this.oceanR + this.atmosphereH;
        if (br > skyHi) {
          var sc0 = skyHi / br;
          x = cx + bx * sc0; y = cy + by * sc0; z = cz + bz * sc0;
          var vr0 = (pvx[p] * bx + pvy[p] * by + pvz[p] * bz) / br;
          if (vr0 > 0) { // reflect radially inward, damped
            pvx[p] -= bx / br * vr0 * 1.15; pvy[p] -= by / br * vr0 * 1.15; pvz[p] -= bz / br * vr0 * 1.15;
          }
        } else if (br <= domHi) {
          // terrain contact: walk out of any solid cell and die down instead
          // of re-splashing. Beached droplets settle as grid-coupled water —
          // gravity keeps them there as puddles that run back down the slope.
          var tries0 = 0;
          while (hasTerr && this._rockCellAt(x, y, z) && tries0 < 8) {
            // never walk past the domain shell: on very tall peaks the rock-cell
            // band reaches the shell — a bead pinned there LANDS (below) instead
            // of ping-ponging through the shell clamp forever
            var rW0 = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy) + (z - cz) * (z - cz));
            var stW0 = Math.min(dx * 0.5, domHi - rW0);
            if (stW0 <= 1e-5) { tries0 = 8; break; }
            x += bx / br * stW0; y += by / br * stW0; z += bz / br * stW0;
            tries0++;
          }
          if (!hasTerr && br < coreLo) {          // bare-core fallback
            var sc1 = coreLo / br;
            x = cx + bx * sc1; y = cy + by * sc1; z = cz + bz * sc1;
            tries0 = 1;
          }
          if (tries0 > 0) {
            var vr1 = (pvx[p] * bx + pvy[p] * by + pvz[p] * bz) / br;
            pvx[p] -= bx / br * vr1; pvy[p] -= by / br * vr1; pvz[p] -= bz / br * vr1;
            pvx[p] *= 0.3; pvy[p] *= 0.3; pvz[p] *= 0.3;
            fl[p] = 0;
          }
        }
      } else {
        if (x < xLo) { x = xLo; pvx[p] = Math.abs(vx) * 0.35; }
        else if (x > xHi) { x = xHi; pvx[p] = -Math.abs(vx) * 0.35; }
        if (z < zLo) { z = zLo; pvz[p] = Math.abs(vz) * 0.35; }
        else if (z > zHi) { z = zHi; pvz[p] = -Math.abs(vz) * 0.35; }
        if (y > yHi) { y = yHi; pvy[p] = -Math.abs(pvy[p]) * 0.15; }
        if (y <= yLo + 0.001) {
          // floor film: die down instead of re-splashing forever
          y = yLo; pvy[p] = 0; pvx[p] *= 0.3; pvz[p] *= 0.3; fl[p] = 0;
        }
      }
      px[p] = x; py[p] = y; pz[p] = z;

      // re-entry into the liquid: droplets lose most of their momentum on
      // impact (fragmentation/merging). The deleted momentum is what drains
      // spray energy — injecting it back (or merging into the local flow)
      // lets the redirect ratchet re-launch the rain forever.
      var ci = clamp(Math.floor(x / dx), 0, nx - 1), cj = clamp(Math.floor(y / dx), 0, ny - 1), ck = clamp(Math.floor(z / dx), 0, nz - 1);
      var c = (ck * ny + cj) * nx + ci;
      if (type[c] === FLUID) {
        pvx[p] *= 0.45; pvy[p] *= 0.45; pvz[p] *= 0.45;
        if (pvy[p] > 0.5) pvy[p] = 0.5;
        pcool[p] = 2; // merge cooldown (substeps)
        fl[p] = 0;
      }
      continue;
    }

    if (fl[p] === 2 || fl[p] === 3) {
      // Atmospheric parcels (steam + cloud droplets): coherent circulating
      // winds and buoyant lift,
      // terrain/ceiling contact, vapor collisions and thermal condensation.
      var Tv = this.pT[p];
      this.pAir[p] += dt;
      var gv = this.gravity * 0.06;                // slight gravity
      if (sphere) {
        var vEx = x - cx, vEy = y - cy, vEz = z - cz;
        var vEr = Math.sqrt(vEx * vEx + vEy * vEy + vEz * vEz) || 1e-9;
        // Coherent zonal flow plus an upper day-to-night return current.
        // Free parcels feel only the slight atmospheric gravity, so the
        // Maxwell–Boltzmann escape spectrum settles into a bottom-heavy
        // barometric height profile (dense at the surface, thin aloft) — the
        // old fixed-altitude buoyant spring pinned every parcel to one
        // mid-height band instead. Cold parcels still condense and rain
        // under gravity; the buoyant floor reflector (below) keeps the
        // population aloft long enough to ride the winds.
        var ux = vEx / vEr, uy = vEy / vEr, uz = vEz / vEr;
        var exposure = ux * windSX + uy * windSY + uz * windSZ;
        // wind speeds keep the classic values at the default world (oceanR
        // 1.95) but are capped by the solver speed limit so giant planets
        // get strong — yet physical — circulation instead of 18 m/s gales
        var jet = Math.min(this.oceanR * 0.58, this.maxSpeed * 0.45);
        var returnFlow = Math.min(this.oceanR * 0.32, this.maxSpeed * 0.25);
        var vr = vx * ux + vy * uy + vz * uz;
        var radial = -this.gravity * 0.06;
        var wx = -uz * jet - (windSX - exposure * ux) * returnFlow;
        var wy = -(windSY - exposure * uy) * returnFlow;
        var wz = ux * jet - (windSZ - exposure * uz) * returnFlow;
        var relax = Math.min(1, dt * 1.3);
        pvx[p] = vx + (wx - (vx - vr * ux)) * relax + ux * radial * dt;
        pvy[p] = vy + (wy - (vy - vr * uy)) * relax + uy * radial * dt;
        pvz[p] = vz + (wz - (vz - vr * uz)) * relax + uz * radial * dt;
      } else {
        pvy[p] = vy - gv * dt;                     // pool: down is -y
        pvx[p] = vx; pvz[p] = vz;
      }
      // hard clamp so no atmospheric parcel ever exceeds the solver speed
      // limit (the wind targets above are bounded; this guards the sum of
      // wind + buoyant spring + leftover velocity)
      var svv = pvx[p] * pvx[p] + pvy[p] * pvy[p] + pvz[p] * pvz[p];
      if (svv > this.maxSpeed * this.maxSpeed) {
        var svs = this.maxSpeed / Math.sqrt(svv);
        pvx[p] *= svs; pvy[p] *= svs; pvz[p] *= svs;
      }
      x += pvx[p] * dt; y += pvy[p] * dt; z += pvz[p] * dt;
      var backToSea = false;
      if (sphere) {
        var vCx = x - cx, vCy = y - cy, vCz = z - cz;
        var vCr = Math.sqrt(vCx * vCx + vCy * vCy + vCz * vCz) || 1e-9;
        // a thousandth of a cell INSIDE the hard cap: repositioning exactly to
        // the cap radius roundoffs a few ulps above it, and a parcel pinning
        // against the ceiling (fast MB tail on small planets) would then
        // measure as escaped
        var ceilR = this.oceanR + this.atmosphereH - 1e-3 * dx;   // atmosphere thickness
        if (hasTerr) {
          // the cap follows the ground: vapor may not fly through mountains
          var RtE = this.terrainRadiusAt(x, y, z);
          if (RtE + 0.02 > ceilR) ceilR = RtE + 0.02;
        }
        if (vCr > ceilR) {
          var scE = ceilR / vCr;
          x = cx + vCx * scE; y = cy + vCy * scE; z = cz + vCz * scE;
          var vrE = (pvx[p] * vCx + pvy[p] * vCy + pvz[p] * vCz) / vCr;
          if (vrE > 0) {
            // elastic reflection: reverse the outward velocity component
            pvx[p] -= vCx / vCr * vrE * 2; pvy[p] -= vCy / vCr * vrE * 2; pvz[p] -= vCz / vCr * vrE * 2;
          }
        }
        // Stochastic ceiling bounce: a rising parcel may ALSO reflect below
        // the cap, with probability = curve(normalized height) per second —
        // 0 at sea level growing to 1 at the atmosphere ceiling (the hard cap
        // above contains everything regardless). The GUI picker chooses the
        // curve: linear spreads bounces through the whole sky, quadratic and
        // exponential concentrate them near the top. Seeded → deterministic.
        var vrC2 = (pvx[p] * vCx + pvy[p] * vCy + pvz[p] * vCz) / vCr;
        if (vrC2 > 0 && vCr > this.oceanR) {
          var hh = (vCr - this.oceanR) / (this.atmosphereH > 1e-4 ? this.atmosphereH : 1e-4);
          if (hh > 1) hh = 1;
          var prf = this.ceilReflect === 'quadratic' ? hh * hh :
            this.ceilReflect === 'exponential' ? (Math.exp(3 * hh) - 1) * 0.0523957 : hh;
          if (prf > 0) {
            this._cfS = (this._cfS * 1664525 + 1013904223) >>> 0;
            if (this._cfS / 4294967296 < prf * dt * 4) {
              pvx[p] -= vCx / vCr * vrC2 * 2;
              pvy[p] -= vCy / vCr * vrC2 * 2;
              pvz[p] -= vCz / vCr * vrC2 * 2;
            }
          }
        }
        // Buoyant floor reflector at the re-absorption gate radius: descending
        // parcels bounce off the warm boundary layer instead of drowning —
        // elastically (an elastic floor is what turns the free-flight MB
        // ensemble into the barometric profile), with a seeded fraction
        // sticking to the sea and condensing. Bounced parcels are repositioned
        // just OUTSIDE the gate radius: inside it, the backToSea gate would
        // re-absorb slow-rising bounces the same substep (a parcel hovering at
        // the apex of a small arc grazes vr = 0 for several substeps) and the
        // whole slow half of the MB spectrum would die on first contact.
        var fCx = x - cx, fCy = y - cy, fCz = z - cz;
        var fCr = Math.sqrt(fCx * fCx + fCy * fCy + fCz * fCz) || 1e-9;
        var floorR = this.oceanR + 0.15 * dx;            // = the backToSea gate radius
        if (fCr < floorR) {
          var vrF = (pvx[p] * fCx + pvy[p] * fCy + pvz[p] * fCz) / fCr;
          if (vrF < 0) {
            this._bfS = (this._bfS * 1664525 + 1013904223) >>> 0;
            if (this._bfS / 4294967296 < 0.07) {         // few stick to the sea and
              var scF = floorR / fCr;                    // condense — the rest stay
              x = cx + fCx * scF; y = cy + fCy * scF; z = cz + fCz * scF;  // aloft
              pvx[p] -= fCx / fCr * vrF * 2; pvy[p] -= fCy / fCr * vrF * 2; pvz[p] -= fCz / fCr * vrF * 2;
            } else {
              var scB = (floorR + 0.02 * dx) / fCr;      // bounce out beyond the gate
              x = cx + fCx * scB; y = cy + fCy * scB; z = cz + fCz * scB;
              pvx[p] -= fCx / fCr * vrF * 2; pvy[p] -= fCy / fCr * vrF * 2; pvz[p] -= fCz / fCr * vrF * 2;
            }
          }
        }
        var triesE = 0;                                  // never sink into rock
        var rNow3 = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy) + (z - cz) * (z - cz));
        while (hasTerr && rNow3 < this.domainR && this._rockCellAt(x, y, z) && triesE < 8) {
          // capped at the domain shell — over tall peaks the ceiling clamp
          // above already contains the parcel; above the grid there is no
          // terrain at all (the cell test would only see the clamped shell)
          var rW3 = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy) + (z - cz) * (z - cz));
          var stW3 = Math.min(dx * 0.5, domHi - rW3);
          if (stW3 <= 1e-5) break;
          x += vCx / vCr * stW3; y += vCy / vCr * stW3; z += vCz / vCr * stW3;
          triesE++;
        }
        if (triesE > 0) {
          // bounce off the terrain: reflect the inward radial velocity with
          // 50% restitution plus a little friction — vapor puffs ricochet off
          // peaks and shorelines instead of sliding through the rock
          var vrT = (pvx[p] * vCx + pvy[p] * vCy + pvz[p] * vCz) / vCr;
          if (vrT < 0) {
            var bT = 1.5 * vrT / vCr;                    // v_r → −0.5·v_r
            pvx[p] -= vCx * bT; pvy[p] -= vCy * bT; pvz[p] -= vCz * bT;
          }
          pvx[p] *= 0.92; pvy[p] *= 0.92; pvz[p] *= 0.92;
        }
        var ciV = clamp(Math.floor(x / dx), 0, nx - 1);
        var cjV = clamp(Math.floor(y / dx), 0, ny - 1);
        var ckV = clamp(Math.floor(z / dx), 0, nz - 1);
        backToSea = type[(ckV * ny + cjV) * nx + ciV] === FLUID;
        if (backToSea) {
          // Positional gate: cells straddle the surface (a cell can hold both
          // seawater and airspace), so a fluid mark alone is not enough —
          // the mote must be essentially at the fill line. Moving-up vapor
          // never re-enters either, or it would re-launch as an airborne
          // fluid blob.
          var bx2 = x - cx, by2 = y - cy, bz2 = z - cz;
          var br2 = Math.sqrt(bx2 * bx2 + by2 * by2 + bz2 * bz2) || 1e-9;
          if (br2 > this.oceanR + 0.15 * dx) backToSea = false;
          else if ((pvx[p] * bx2 + pvy[p] * by2 + pvz[p] * bz2) / br2 > 0.02) backToSea = false;
        }
      } else {
        var ceilY = this.waterTopY + this.atmosphereH;
        if (y > ceilY) {
          y = ceilY;
          if (pvy[p] > 0) pvy[p] = -pvy[p];              // elastic reflect
        }
        if (y < yLo + 0.001) { y = yLo + 0.001; if (pvy[p] < 0) pvy[p] = -pvy[p]; }
        if (x < xLo) { x = xLo; pvx[p] = -pvx[p]; }
        else if (x > xHi) { x = xHi; pvx[p] = -pvx[p]; }
        if (z < zLo) { z = zLo; pvz[p] = -pvz[p]; }
        else if (z > zHi) { z = zHi; pvz[p] = -pvz[p]; }
        var ciW = clamp(Math.floor(x / dx), 0, nx - 1);
        var cjW = clamp(Math.floor(y / dx), 0, ny - 1);
        var ckW = clamp(Math.floor(z / dx), 0, nz - 1);
        backToSea = type[(ckW * ny + cjW) * nx + ciW] === FLUID;
        if (backToSea && (pvy[p] > 0.02 || y > this.waterTopY + 0.25 * dx)) backToSea = false;
      }
      px[p] = x; py[p] = y; pz[p] = z;
      if (backToSea) {
        // touched liquid again: condense straight back into the ocean. The
        // sea absorbs the mote entirely — zero its velocity so the
        // re-joined fluid particle can neither launch itself out of the
        // surface nor ride along it as a floating blob.
        pvx[p] = 0; pvy[p] = 0; pvz[p] = 0;
        this.pAir[p] = 0;
        fl[p] = 0;
      } else if (fl[p] === 2 && (Tv < rainTe || this.pAir[p] > 40)) {
        // cold (or stale) steam rains out mid-air: sheds its speed and
        // free-falls; gravity and the spray rules take over. Cloud droplets
        // are exempt — only steam produces rain (the phase pass owns the
        // transitions), so clouds persist until warmed or absorbed.
        pvx[p] = 0; pvy[p] = 0; pvz[p] = 0;
        this.pAir[p] = 0;
        fl[p] = 4;
      }
      continue;
    }

    // RK2 through the (divergence-free) grid velocity field; slow particles
    // (most of the pool at rest) take the cheaper RK1 step
    if (this._gridSampleValid) {
      tmp[0] = this._advU[p]; tmp[1] = this._advV[p]; tmp[2] = this._advW[p];
    } else this.sampleVel(x, y, z, tmp);
    var sp2 = tmp[0] * tmp[0] + tmp[1] * tmp[1] + tmp[2] * tmp[2];
    var v2x = tmp[0], v2y = tmp[1], v2z = tmp[2];
    if (sp2 > 0.25) {
      var mx = clamp(x + 0.5 * dt * tmp[0], xLo, xHi);
      var my = clamp(y + 0.5 * dt * tmp[1], yLo, yHi);
      var mz = clamp(z + 0.5 * dt * tmp[2], zLo, zHi);
      this._sampleVel3(mx, my, mz, tmp2);       // one fused call, not three
      v2x = tmp2[0]; v2y = tmp2[1]; v2z = tmp2[2];
    }

    // speed clamp for stability
    var sp2 = v2x * v2x + v2y * v2y + v2z * v2z;
    if (sp2 > this.maxSpeed * this.maxSpeed) {
      var sc = this.maxSpeed / Math.sqrt(sp2);
      v2x *= sc; v2y *= sc; v2z *= sc;
      pvx[p] *= sc; pvy[p] *= sc; pvz[p] *= sc;
    }

    x += v2x * dt; y += v2y * dt; z += v2z * dt;

    if (sphere) {
      // radial boundaries: keep normal particles inside the ocean domain and
      // out of the core; hitting the outer shell demotes to falling spray
      var nx2 = x - cx, ny2 = y - cy, nz2 = z - cz;
      var nr = Math.sqrt(nx2 * nx2 + ny2 * ny2 + nz2 * nz2) || 1e-9;
      if (nr > domHi) {
        var sc2 = domHi / nr;
        x = cx + nx2 * sc2; y = cy + ny2 * sc2; z = cz + nz2 * sc2;
        pvy[p] = -Math.abs(pvy[p]) * 0.1 - 0.3;
        fl[p] = 1;
      }
      if (nr < domHi) {
        // terrain: if the particle ended up in a cell that rasterizes solid,
        // walk it radially out onto the stairstep, killing inward motion.
        // Cell-based (not continuous) so the water always agrees with the
        // rasterized rock — no phantom gap, no compression transient.
        var tries = 0;
        while (hasTerr && this._rockCellAt(x, y, z) && tries < 8) {
          // capped at the domain shell (same peak/shell band as the spray
          // branch): a pinned particle just gets its inward motion killed
          var rW2 = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy) + (z - cz) * (z - cz));
          var stW2 = Math.min(dx * 0.5, domHi - rW2);
          if (stW2 <= 1e-5) { tries = 8; break; }
          x += nx2 / nr * stW2; y += ny2 / nr * stW2; z += nz2 / nr * stW2;
          tries++;
        }
        if (tries > 0) {
          var vr2 = (pvx[p] * nx2 + pvy[p] * ny2 + pvz[p] * nz2) / nr;
          if (vr2 < 0) {
            pvx[p] -= nx2 / nr * vr2; pvy[p] -= ny2 / nr * vr2; pvz[p] -= nz2 / nr * vr2;
          }
        }
        // shallow-water bottom friction right above the rock: damps the
        // stairstep creep a coarse solid boundary pumps into the ocean
        if (hasTerr && (tries > 0 ||
            this._rockCellAt(x - nx2 / nr * dx, y - ny2 / nr * dx, z - nz2 / nr * dx))) {
          var fr0 = 1 - 0.6 * dt; if (fr0 < 0) fr0 = 0;
          pvx[p] *= fr0; pvy[p] *= fr0; pvz[p] *= fr0;
        }
      }
      var sx = x - cx, sy = y - cy, sz = z - cz;
      var sr2 = sx * sx + sy * sy + sz * sz;
      var sr = Math.sqrt(sr2) || 1e-9;
      // radial drag: shorelines dissipate swell in the real ocean; pure
      // inviscid slosh would ring forever here. At rest the force is exactly
      // zero, and tangential motion (streams, whirlpools) has no radial
      // part, so the swirl dynamics are untouched. Gravity itself now acts
      // on the grid (see _applyPlanetGravity), not per particle.
      var vrad = (pvx[p] * sx + pvy[p] * sy + pvz[p] * sz) / sr;
      var da = 1.0 * dt; if (da > 0.5) da = 0.5;
      pvx[p] -= sx / sr * vrad * da; pvy[p] -= sy / sr * vrad * da; pvz[p] -= sz / sr * vrad * da;
      // gentle bulk drag: a curved free surface on a Cartesian grid leaves a
      // little coherent pressure noise every substep, and with no viscosity
      // that swell would never die. Real oceans dissipate as well; spray
      // (handled above) is exempt so splashes stay lively.
      var dg = 1 - 0.42 * dt; if (dg < 0) dg = 0;
      pvx[p] *= dg; pvy[p] *= dg; pvz[p] *= dg;
    } else {
      // walls
      if (x < xLo) { x = xLo; pvx[p] = Math.abs(pvx[p]) * 0.1; }
      else if (x > xHi) { x = xHi; pvx[p] = -Math.abs(pvx[p]) * 0.1; }
      if (z < zLo) { z = zLo; pvz[p] = Math.abs(pvz[p]) * 0.1; }
      else if (z > zHi) { z = zHi; pvz[p] = -Math.abs(pvz[p]) * 0.1; }
      if (y < yLo) { y = yLo; pvy[p] = Math.abs(pvy[p]) * 0.1; }
      else if (y > yHi) {
        // hit the pool ceiling: become a falling droplet instead of sticking
        // to it as a pseudo-fluid layer
        y = yHi; pvy[p] = -Math.abs(pvy[p]) * 0.1 - 0.3;
        fl[p] = 1;
      }
    }

    px[p] = x; py[p] = y; pz[p] = z;
  }
};

// ---------------------------------------------------------------------- balls
// Sphere-world: resolve a ball against the voxel terrain. Scans the solid
// voxels overlapping the ball's bounding box, finds the deepest penetration
// against a voxel face and pushes out along it, killing inward velocity with
// a little tangential friction — balls rest on the rock and roll down slopes.
FluidSolver.prototype._ballVsTerrain = function (b) {
  var t = this.terrain, n = t.n, dv = t.dv, solid = t.solid;
  var i0 = ((b.x - b.r) / dv) | 0, i1 = ((b.x + b.r) / dv) | 0;
  var j0 = ((b.y - b.r) / dv) | 0, j1 = ((b.y + b.r) / dv) | 0;
  var k0 = ((b.z - b.r) / dv) | 0, k1 = ((b.z + b.r) / dv) | 0;
  if (i0 < 0) i0 = 0; if (j0 < 0) j0 = 0; if (k0 < 0) k0 = 0;
  if (i1 > n - 1) i1 = n - 1; if (j1 > n - 1) j1 = n - 1; if (k1 > n - 1) k1 = n - 1;
  var bestPen = 0, bpx = 0, bpy = 0, bpz = 0, i, j, k;
  for (k = k0; k <= k1; k++) {
    for (j = j0; j <= j1; j++) {
      var rowB = (k * n + j) * n;
      for (i = i0; i <= i1; i++) {
        if (!solid[rowB + i]) continue;
        // closest point on the voxel cube to the ball center
        var qx = b.x, qy = b.y, qz = b.z;
        var vx0 = i * dv, vy0 = j * dv, vz0 = k * dv;
        if (qx < vx0) qx = vx0; else if (qx > vx0 + dv) qx = vx0 + dv;
        if (qy < vy0) qy = vy0; else if (qy > vy0 + dv) qy = vy0 + dv;
        if (qz < vz0) qz = vz0; else if (qz > vz0 + dv) qz = vz0 + dv;
        var ddx = b.x - qx, ddy = b.y - qy, ddz = b.z - qz;
        var dd = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        var pen = b.r - dd;
        if (pen > bestPen) {
          if (dd > 1e-6) {
            bestPen = pen; bpx = ddx / dd; bpy = ddy / dd; bpz = ddz / dd;
          } else {
            // center inside the voxel: push radially out from the planet
            var rx = b.x - this.cx, ry = b.y - this.cy, rz = b.z - this.cz;
            var rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1e-9;
            bestPen = pen; bpx = rx / rl; bpy = ry / rl; bpz = rz / rl;
          }
        }
      }
    }
  }
  if (bestPen > 0) {
    b.x += bpx * (bestPen + 0.002); b.y += bpy * (bestPen + 0.002); b.z += bpz * (bestPen + 0.002);
    var vn = b.vx * bpx + b.vy * bpy + b.vz * bpz;
    if (vn < 0) {   // kill inward motion, keep tangential slide (rolling)
      b.vx -= bpx * vn; b.vy -= bpy * vn; b.vz -= bpz * vn;
      b.vx *= 0.985; b.vy *= 0.985; b.vz *= 0.985;
    }
  }
};

FluidSolver.prototype._updateBalls = function (dt) {
  var dx = this.dx, type = this.cellType;
  var rhoF = 1000; // water density, kg/m^3
  var Cd = 0.5;
  var tmp = this._tmpV;
  var W = this.W, H = this.H, D = this.D;

  // local free-surface height near each ball, from the particles themselves
  // (the ball's own cells are rasterized SOLID, so they cannot be used).
  // Robust estimate: 75th percentile of particle heights in a far-field
  // annulus (1.4r - 3r horizontally) — immune to splash columns, the mound
  // climbing the ball, and particles trapped between ball and ceiling.
  var px = this.px, py = this.py, pz = this.pz, fl = this.pflag;
  var nb = this.balls.length;
  if (nb > 0) {
    var HIST = 24, HGT = this.H;
    var sphere = this.mode === 'sphere';
    var bcx = this.cx, bcy = this.cy, bcz = this.cz;
    // histogram level: height above the floor (pool) or radius (planet)
    var hLo = 0, hSpan = this.H;
    if (sphere) {
      hLo = this.coreR;
      hSpan = (this.oceanR - this.coreR) * 1.5;
    }
    if (!this._surfY || this._surfY.length !== nb) this._surfY = new Float32Array(nb);
    if (!this._hist || this._hist.length !== nb * HIST) this._hist = new Float32Array(nb * HIST);
    if (!this._histC || this._histC.length !== nb) this._histC = new Int32Array(nb);
    var hist = this._hist, histC = this._histC;
    hist.fill(0); histC.fill(0);
    for (var p = 0; p < this.nP; p++) {
      if (fl[p] !== 0) continue;
      var ppx = px[p], ppy = py[p], ppz = pz[p];
      var level;
      if (sphere) {
        var ldx = ppx - bcx, ldy = ppy - bcy, ldz = ppz - bcz;
        level = Math.sqrt(ldx * ldx + ldy * ldy + ldz * ldz);   // distance from center
      } else {
        level = ppy;                                            // height above floor
      }
      for (var sb2 = 0; sb2 < nb; sb2++) {
        var bb = this.balls[sb2];
        var dh2;
        if (sphere) {
          var bdx = ppx - bb.x, bdy = ppy - bb.y, bdz = ppz - bb.z;
          dh2 = bdx * bdx + bdy * bdy + bdz * bdz;              // full 3D shell
        } else {
          var exx = ppx - bb.x, ezz = ppz - bb.z;
          dh2 = exx * exx + ezz * ezz;                          // vertical annulus
        }
        // sample undisturbed water: start the shell OUTSIDE the cavity the
        // ball itself carves, otherwise the waterline reads the cavity edge
        // and floating balls ride artificially high
        var r1 = (sphere ? 2.2 : 1.4) * bb.r, r2 = (sphere ? 3.2 : 3.0) * bb.r;
        if (dh2 < r1 * r1 || dh2 > r2 * r2) continue;
        var bucket = Math.floor(((level - hLo) / hSpan) * HIST);
        if (bucket < 0) bucket = 0; else if (bucket >= HIST) bucket = HIST - 1;
        hist[sb2 * HIST + bucket]++;
        histC[sb2]++;
      }
    }
    for (var sb3 = 0; sb3 < nb; sb3++) {
      var total = histC[sb3], wl = -Infinity;
      if (total > 20) {
        // scan buckets from the top for the free-surface level: on the planet
        // the surface is the OUTER edge of the radial distribution, so use a
        // high percentile (90th); the pool's vertical histogram reads the top
        // quartile the same way.
        var acc = 0, target = total * (sphere ? 0.10 : 0.25);
        for (var bkt = HIST - 1; bkt >= 0; bkt--) {
          acc += hist[sb3 * HIST + bkt];
          if (acc >= target) { wl = hLo + (bkt + 0.5) / HIST * hSpan; break; }
        }
        // thin sample (shallow shelf or basin rim): the histogram is too
        // coarse to place a waterline — fall back to the global sea level,
        // which is exactly what the projection enforces everywhere else
        if (sphere && (wl === -Infinity || total < 140)) wl = this.oceanR;
        // the waterline cannot live in the spray zone: clamp to the splash
        // mound scale so churn aloft can't pin a ball against the ceiling
        var wlMax = sphere
          ? this.oceanR + (this.oceanR - this.coreR) * 0.3
          : Math.min(HGT - 0.9, this.waterTopY + 0.3);
        if (wl > wlMax) wl = wlMax;
        if (sphere && wl < this.coreR) wl = this.coreR;
      } else if (sphere) {
        wl = this.oceanR;        // no sample at all: assume undisturbed sea
      }
      this._surfY[sb3] = wl;
    }
  }

  for (var n = 0; n < this.balls.length; n++) {
    var b = this.balls[n];
    var m = b.rho * 4 / 3 * Math.PI * b.r * b.r * b.r;
    var area = Math.PI * b.r * b.r;

    // submerged volume (Archimedes) as a spherical cap of depth h below the
    // local free surface. "Down" is +y in the pool and -r̂ on the planet:
    // in both worlds the free surface sits at `surf` and the ball's inner
    // face at `inner`, so h = surf - inner.
    var surf = (this._surfY && this._surfY[n] !== undefined) ? this._surfY[n] : -Infinity;
    var bR = sphere ? Math.sqrt((b.x - this.cx) * (b.x - this.cx) + (b.y - this.cy) * (b.y - this.cy) + (b.z - this.cz) * (b.z - this.cz)) : b.y;
    var inner = bR - b.r;
    var h = surf - inner;
    if (!(h > 0)) h = 0;
    if (h > 2 * b.r) h = 2 * b.r;
    var Vs = Math.PI * h * h * (3 * b.r - h) / 3;
    b.submerged = Vs / (4 / 3 * Math.PI * b.r * b.r * b.r);

    // forces: buoyancy + weight act along "up" (pool: +y; planet: outward r̂).
    // Local gravity on the planet follows the same linear law as the grid.
    var upx = 0, upy = 1, upz = 0;
    var gEff = this.gravity;
    if (sphere && bR > 1e-6) {
      upx = (b.x - this.cx) / bR; upy = (b.y - this.cy) / bR; upz = (b.z - this.cz) / bR;
      gEff = this.gravity * (this.oceanR * this.oceanR) / (bR * bR);
    }
    var Fb = (rhoF * Vs - m) * gEff;           // buoyancy + weight (along up)
    // quadratic drag vs. local fluid velocity
    this.sampleVel(b.x, b.y, b.z, tmp);
    var rvx = b.vx - tmp[0], rvy = b.vy - tmp[1], rvz = b.vz - tmp[2];
    var vr = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz);
    var kd = 0.5 * rhoF * Cd * area * vr;
    var Fx = -kd * rvx + upx * Fb, Fz = -kd * rvz + upz * Fb, Fyd = -kd * rvy + upy * Fb;
    // clamp the drag reaction: a transient jet (or a numerical artifact) must
    // not kick the ball at rocket acceleration. The drag component along "up"
    // stays BELOW gravity so drag alone can never hold a ball aloft —
    // buoyancy decides.
    var FdmaxX = 0.5 * m * this.gravity, FdmaxY = 0.8 * m * this.gravity;
    if (sphere) {
      // single vector clamp on the drag part (up-direction is radial)
      var fdx = Fx - upx * Fb, fdy = Fyd - upy * Fb, fdz = Fz - upz * Fb;
      var fdm = Math.sqrt(fdx * fdx + fdy * fdy + fdz * fdz);
      var fdmMax = 0.8 * m * this.gravity;
      if (fdm > fdmMax) {
        var fdc = fdmMax / fdm;
        Fx = upx * Fb + fdx * fdc; Fyd = upy * Fb + fdy * fdc; Fz = upz * Fb + fdz * fdc;
      }
    } else {
      if (Fx > FdmaxX) Fx = FdmaxX; else if (Fx < -FdmaxX) Fx = -FdmaxX;
      if (Fz > FdmaxX) Fz = FdmaxX; else if (Fz < -FdmaxX) Fz = -FdmaxX;
      if (Fyd > FdmaxY) Fyd = FdmaxY; else if (Fyd < -FdmaxY) Fyd = -FdmaxY;
    }

    // added mass: accelerating a sphere drags ~half its displaced fluid
    var mEff = m + 0.5 * rhoF * Vs;
    b.vx += (Fx / mEff) * dt;
    b.vz += (Fz / mEff) * dt;
    b.vy += (Fyd / mEff) * dt;
    b.vx *= 0.999; b.vy *= 0.999; b.vz *= 0.999;
    // safety clamps: a ball slamming into the water must not pump absurd
    // velocities into the projection (which is what launched spray "to the
    // cosmos")
    var bvmax = 4;
    if (b.vx > bvmax) b.vx = bvmax; else if (b.vx < -bvmax) b.vx = -bvmax;
    if (b.vz > bvmax) b.vz = bvmax; else if (b.vz < -bvmax) b.vz = -bvmax;
    if (b.vy > bvmax) b.vy = bvmax; else if (b.vy < -bvmax) b.vy = -bvmax;

    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;

    if (sphere) {
      // radial constraints: rest on the terrain, stay inside the domain
      if (this.terrain) {
        this._ballVsTerrain(b);
      } else {
        var cbx = b.x - this.cx, cby = b.y - this.cy, cbz = b.z - this.cz;
        var cbr = Math.sqrt(cbx * cbx + cby * cby + cbz * cbz) || 1e-9;
        if (cbr < this.coreR + b.r) {
          var rnx0 = cbx / cbr, rny0 = cby / cbr, rnz0 = cbz / cbr;
          var rr0 = this.coreR + b.r;
          b.x = this.cx + rnx0 * rr0; b.y = this.cy + rny0 * rr0; b.z = this.cz + rnz0 * rr0;
          var vn0 = b.vx * rnx0 + b.vy * rny0 + b.vz * rnz0;
          if (vn0 < 0) { // kill inward motion, keep some tangential slide
            b.vx -= rnx0 * vn0 * 1.3; b.vy -= rny0 * vn0 * 1.3; b.vz -= rnz0 * vn0 * 1.3;
            b.vx *= 0.98; b.vy *= 0.98; b.vz *= 0.98;
          }
        }
      }
      var sbx = b.x - this.cx, sby = b.y - this.cy, sbz = b.z - this.cz;
      var sbr = Math.sqrt(sbx * sbx + sby * sby + sbz * sbz) || 1e-9;
      var rnx = sbx / sbr, rny = sby / sbr, rnz = sbz / sbr;
      if (sbr > this.domainR - b.r) {
        var rr1 = this.domainR - b.r;
        b.x = this.cx + rnx * rr1; b.y = this.cy + rny * rr1; b.z = this.cz + rnz * rr1;
        var vn1 = b.vx * rnx + b.vy * rny + b.vz * rnz;
        if (vn1 > 0) { b.vx -= rnx * vn1 * 1.3; b.vy -= rny * vn1 * 1.3; b.vz -= rnz * vn1 * 1.3; }
      }
    } else {
      // pool walls
      var lo = dx + b.r, hi;
      hi = this.W - dx - b.r;
      if (b.x < lo) { b.x = lo; b.vx = Math.abs(b.vx) * 0.35; } else if (b.x > hi) { b.x = hi; b.vx = -Math.abs(b.vx) * 0.35; }
      hi = this.D - dx - b.r;
      if (b.z < lo) { b.z = lo; b.vz = Math.abs(b.vz) * 0.35; } else if (b.z > hi) { b.z = hi; b.vz = -Math.abs(b.vz) * 0.35; }
      lo = dx + b.r; hi = this.H - dx - b.r;
      if (b.y < lo) { b.y = lo; b.vy = Math.abs(b.vy) * 0.3; b.vx *= 0.98; b.vz *= 0.98; }
      else if (b.y > hi) { b.y = hi; b.vy = -Math.abs(b.vy) * 0.3; }
    }
  }

  // ball-ball collisions (elastic-ish)
  for (var a = 0; a < this.balls.length; a++) {
    for (var b2 = a + 1; b2 < this.balls.length; b2++) {
      var A = this.balls[a], B = this.balls[b2];
      var ex = B.x - A.x, ey = B.y - A.y, ez = B.z - A.z;
      var d2 = ex * ex + ey * ey + ez * ez, rSum = A.r + B.r;
      if (d2 > rSum * rSum || d2 < 1e-12) continue;
      var d = Math.sqrt(d2), nxn = ex / d, nyn = ey / d, nzn = ez / d;
      var overlap = rSum - d;
      var mA = A.rho * A.r * A.r * A.r, mB = B.rho * B.r * B.r * B.r;
      var tA = mB / (mA + mB), tB = mA / (mA + mB);
      A.x -= nxn * overlap * tA; A.y -= nyn * overlap * tA; A.z -= nzn * overlap * tA;
      B.x += nxn * overlap * tB; B.y += nyn * overlap * tB; B.z += nzn * overlap * tB;
      var rvn = (B.vx - A.vx) * nxn + (B.vy - A.vy) * nyn + (B.vz - A.vz) * nzn;
      if (rvn < 0) {
        var jimp = -(1 + 0.3) * rvn / (1 / mA + 1 / mB);
        A.vx -= nxn * jimp / mA; A.vy -= nyn * jimp / mA; A.vz -= nzn * jimp / mA;
        B.vx += nxn * jimp / mB; B.vy += nyn * jimp / mB; B.vz += nzn * jimp / mB;
      }
    }
  }
};

// -------------------------------------------------------------------- substep
// One operator-split substep (serial CPU path — the physics reference).
FluidSolver.prototype._substep = function (dt) {
  this.u.fill(0); this.v.fill(0); this.w.fill(0);
  this.uW.fill(0); this.vW.fill(0); this.wW.fill(0);

  this._rasterizeStatic();
  this._markFluidCells(0, this.nP);
  this._pushOutOfBalls();
  this._p2g();
  this._applyBC();

  // snapshot pre-projection velocities for the FLIP update
  this.uO.set(this.u); this.vO.set(this.v); this.wO.set(this.w);

  this._viscosity(dt);

  if (this.mode !== 'sphere') {
    // gravity (body force): +y is up, so gravity SUBTRACTS from v.
    for (var i = 0, N = this.v.length; i < N; i++) this.v[i] -= this.gravity * dt;
    // re-enforce solid/boundary BC (gravity must not pump fluid through walls)
    this._applyBC();
  } else {
    // planet gravity as a GRID body force, added after the FLIP snapshot so
    // the projection balances it within the same substep: at rest the solve
    // returns the exact hydrostatic pressure and the FLIP delta vanishes (a
    // per-particle force instead leaks coherently through the P2G/G2P
    // transfer and pumps energy into the resting ocean, KE ~ dt²). Slopes
    // emerge at the stairstep terrain — the projection cannot remove
    // gravity's tangential part there — so water runs downhill and pools to
    // a level sea.
    this._applyPlanetGravity(dt);
    this._applyBC();
  }
  // re-zero boundary planes
  var nx = this.nx, ny = this.ny, nz = this.nz;
  if (this.mode !== 'sphere') {
    for (var k = 0; k < nz; k++) for (var i2 = 0; i2 < nx; i2++) {
      this.v[(k * (ny + 1)) * nx + i2] = 0;
      this.v[(k * (ny + 1) + ny) * nx + i2] = 0;
    }
  }

  this._pressureSolve();
  this._project();
  // ocean dynamics: swirl keeper on the projected field — the FLIP delta then
  // hands the re-injected eddies to the particles (see _vorticityConfinement)
  if (this.vorticity > 0) this._vorticityConfinement(dt);
  // grid velocity ceiling: the free-surface projection can concentrate
  // momentum into a few faces; uncapped it re-launches splash-back forever
  // (the "redirect ratchet"). Legit flow stays under maxSpeed anyway.
  this.umax = this._clampUmSlice(0, this.uN + this.vN + this.wN);
  this._extrapolate();
  this._g2p(dt);
  this._advect(dt);
  this._gridSampleValid = false;
  this._updateBalls(dt);
  this.dtLast = dt;
};

// Clamp grid velocities to the safety ceiling over the combined face range
// [f0, f1) (u|v|w linear index) and return the chunk's max |v| — the
// coordinator reduces the per-chunk maxima into this.umax.
FluidSolver.prototype._clampUmSlice = function (f0, f1) {
  var vcap = this.maxSpeed * 1.1;
  var u = this.u, v = this.v, w = this.w;
  var uN = this.uN, vN = this.vN, F = uN + vN + this.wN;
  var um = 0, av, i, ie, vi;
  ie = f1 < uN ? f1 : uN;
  for (i = f0 > 0 ? f0 : 0; i < ie; i++) {
    if (u[i] > vcap) u[i] = vcap; else if (u[i] < -vcap) u[i] = -vcap;
    av = u[i]; if (av > um) um = av; else if (-av > um) um = -av;
  }
  var vEnd = uN + vN;
  ie = f1 < vEnd ? f1 : vEnd;
  for (i = f0 > uN ? f0 : uN; i < ie; i++) {
    vi = i - uN;
    if (v[vi] > vcap) v[vi] = vcap; else if (v[vi] < -vcap) v[vi] = -vcap;
    av = v[vi]; if (av > um) um = av; else if (-av > um) um = -av;
  }
  ie = f1 < F ? f1 : F;
  for (i = f0 > vEnd ? f0 : vEnd; i < ie; i++) {
    vi = i - vEnd;
    if (w[vi] > vcap) w[vi] = vcap; else if (w[vi] < -vcap) w[vi] = -vcap;
    av = w[vi]; if (av > um) um = av; else if (-av > um) um = -av;
  }
  return um;
};

// planet gravity: serial wrapper owns the startup ramp.
FluidSolver.prototype._applyPlanetGravity = function (dt) {
  var gs = this._gRamp / 1.5; if (gs > 1) gs = 1;
  this._gRamp += dt;
  if (gs <= 0) return;
  gs *= this.gravity;
  this._applyPlanetGravitySlice(0, this.nz, dt, gs);
};
FluidSolver.prototype.step = function (dtFrame) {
  this._stepSync(dtFrame);
};

// Synchronous step (the physics reference): thermal + currents run at ~25 Hz,
// the CFL-limited substeps integrate the fluid, then the inter-particle and
// phase passes run once per frame.
FluidSolver.prototype._stepSync = function (dtFrame) {
  this._simTime += dtFrame;
  if (this.mode === 'sphere' && this.pT.length > 1) {
    this._heatAcc = (this._heatAcc || 0) + dtFrame;
    if (this._heatAcc >= 1 / 25) {           // thermal + currents run at ~25 Hz
      var dtTick = Math.min(this._heatAcc, 1 / 12);
      this._updateHeat(dtTick);
      if (this.sunActivity > 0) this._updateEvaporation(dtTick);
      if (this.currents > 0) this._updateCurrents(dtTick);
      this._heatAcc = 0;
    }
  }
  var remaining = dtFrame, guard = 0, nSub = 0;
  var base = dtFrame / Math.max(1, this.substeps);
  while (remaining > 1e-6 && guard < 10) {
    // 1/60 hard clamp: one substep per 60 Hz frame. The CFL term only binds
    // for violent frames (u ~ 24 m/s at pool dx), and gravity/advection stay
    // stable at this dt — the old 1/100 clamp forced 2 substeps every frame
    // and doubled the per-frame cost for no stability gain.
    var dt = Math.min(base, (this.cfl * this.dx) / Math.max(this.umax, 0.08), 1 / 100);
    if (dt < 1e-5) dt = 1e-5;
    this._substep(dt);
    remaining -= dt;
    guard++; nSub++;
  }
  this.substepsLast = nSub;
  this._vaporCollisions();
  this._updatePhaseChanges(dtFrame);
  this._iceContacts();
  this._pushSurfaceParticles();
};

// ------------------------------------------------------------- heat & sunlight
// Per-frame thermal update (ocean planet):
//   1. Shadows: a particle is lit only if the ray from it to the sun clears
//      the core sphere (analytic test — the night side gets nothing) and is
//      not buried under water. Burial is measured as optical depth by
//      marching the density field (already built for the surface mesh)
//      toward the sun — every water layer halves the light.
//   2. Sun heating: dT = sunPower · exposure · dt.
//   3. Dissipation: slow radiative cooling toward the ambient temperature.
//   4. Conduction: symmetric heat exchange with neighbors found through a
//      uniform hash grid (conserves total heat exactly).
//   5. Convection: warm water is buoyant — a radial push outward for hot
//      particles, inward for cold ones, so hot water rises and cold sinks.
FluidSolver.prototype._updateHeat = function (dt) {
  if (this.nP < 1) return;
  this._heatDt = dt;
  this._heatAlpha = Math.min(this.heatK * dt * 0.15, 0.14);
  this._heatBinScanSerial();
  this._heatBinFill(0, this.nP);
  this._heatShadowChunk(0, this.nP, dt);
  if (this.heatK > 0) {
    this._heatMeansSlice(0, this.nCells);
    this._heatConductFlux();
    this._heatApplySlice(0, this.nCells);
  }
  this._heatConvectChunk(0, this.nP, dt);
};

// ---- thermal binning (counting sort of particles into cells) ----------------
FluidSolver.prototype._heatBinScanSerial = function () {
  var nP = this.nP;
  var px = this.px, py = this.py, pz = this.pz;
  var nx = this.nx, ny = this.ny, nz = this.nz, dx = this.dx;
  var nCells = this.nCells;
  var hCnt = this._hCnt, hStart = this._hStart, hCur = this._hCur, hOrd = this._hOrd;
  if (hCnt.length !== nCells) {
    hCnt = this._hCnt = this._alloc('_hCnt', Int32Array, nCells);
    hStart = this._hStart = this._alloc('_hStart', Int32Array, nCells + 1);
    hCur = this._hCur = this._alloc('_hCur', Int32Array, nCells);
  }
  if (hOrd.length < nP) hOrd = this._hOrd = this._alloc('_hOrd', Int32Array, nP * 2);
  hCnt.fill(0);
  var gx, gy, gz, c, p;
  for (p = 0; p < nP; p++) {
    gx = px[p] / dx | 0; if (gx < 0) gx = 0; else if (gx >= nx) gx = nx - 1;
    gy = py[p] / dx | 0; if (gy < 0) gy = 0; else if (gy >= ny) gy = ny - 1;
    gz = pz[p] / dx | 0; if (gz < 0) gz = 0; else if (gz >= nz) gz = nz - 1;
    hCnt[(gz * ny + gy) * nx + gx]++;
  }
  var acc = 0;
  for (c = 0; c < nCells; c++) { hStart[c] = acc; acc += hCnt[c]; }
  hStart[nCells] = acc;
  hCur.set(hStart.subarray(0, nCells));
};

// Bin-fill: particles land in their cell's bin (index order — deterministic).
FluidSolver.prototype._heatBinFill = function (p0, p1) {
  var px = this.px, py = this.py, pz = this.pz;
  var nx = this.nx, ny = this.ny, nz = this.nz, dx = this.dx;
  var hCur = this._hCur, hOrd = this._hOrd;
  var p, gx, gy, gz, c;
  for (p = p0; p < p1; p++) {
    gx = px[p] / dx | 0; if (gx < 0) gx = 0; else if (gx >= nx) gx = nx - 1;
    gy = py[p] / dx | 0; if (gy < 0) gy = 0; else if (gy >= ny) gy = ny - 1;
    gz = pz[p] / dx | 0; if (gz < 0) gz = 0; else if (gz >= nz) gz = nz - 1;
    c = (gz * ny + gy) * nx + gx;
    hOrd[hCur[c]++] = p;
  }
};

// ---- heating with shadows + dissipation (per particle, chunkable) -----------
FluidSolver.prototype._heatShadowChunk = function (p0, p1, dt) {
  var nP = this.nP;
  var px = this.px, py = this.py, pz = this.pz, pT = this.pT, fl = this.pflag;
  var pLight = this.pLight;   // exposure mirror for the renderer (shading)
  if ((!pLight || pLight.length < nP)) {
    pLight = this.pLight = this._alloc('pLight', Float32Array, nP);
  }
  var pDepth = this.pDepth;   // water cells stacked over each particle (beads cull)
  if ((!pDepth || pDepth.length < nP)) {
    pDepth = this.pDepth = this._alloc('pDepth', Uint8Array, nP);
  }
  var nx = this.nx, ny = this.ny, nz = this.nz, dx = this.dx;
  var cx = this.cx, cy = this.cy, cz = this.cz, coreR2 = this.coreR * this.coreR;
  var dens = this.dens, sj = nx + 1, sk = (ny + 1) * sj;
  var sun = this.sunPos, Tamb = this.Tamb;
  var p, i, j, k;

  var sunPow = this.sunActivity / 3, dissip = 0.045;   // activity 0.6 → legacy 0.2
  var shadeCool = this.shadeCool;   // extra radiative loss out of the sun
  var half = dx, marchMax = 0.55, marchMaxN = 6, absK = 1.1;
  var type = this.cellType;
  for (p = p0; p < p1; p++) {
    var lit = sun ? 1 : 0;          // no sun at all = night for everyone
    // how much water sits over this particle (march outward): 0 = at/above
    // the local surface, 4+ = deep interior. Mirrored for the renderer, which
    // skips beads for interior water (invisible under the surface anyway —
    // drawing them shaded-to-black showed as dark speckle through the body).
    var dwx = px[p] - cx, dwy = py[p] - cy, dwz = pz[p] - cz;
    var dwl = Math.sqrt(dwx * dwx + dwy * dwy + dwz * dwz) || 1e-9;
    var stpU = dx / dwl, above = 0;
    for (var stU = 1; stU <= 4; stU++) {
      var qxU = px[p] + dwx * stpU * stU, qyU = py[p] + dwy * stpU * stU, qzU = pz[p] + dwz * stpU * stU;
      var qiU = qxU / dx | 0, qjU = qyU / dx | 0, qkU = qzU / dx | 0;
      if (qiU < 0 || qjU < 0 || qkU < 0 || qiU >= nx || qjU >= ny || qkU >= nz) break;
      if (type[(qkU * ny + qjU) * nx + qiU] !== FLUID) break;
      above++;
    }
    pDepth[p] = above;
    if (sun) {
      // deep-water fast path: four fluid cells stacked overhead mean optically
      // thick water above — the shadow and optical-depth marches below can
      // only return "opaque", so lit = 0 without walking up to 26 voxel steps
      // (this cull carries most of the ocean; surface-band particles skip it
      // and take the full shadow path, and airborne vapor never qualifies).
      if (above >= 4) lit = 0;
      else {
      var lx = sun[0] - px[p], ly = sun[1] - py[p], lz = sun[2] - pz[p];
      var ld = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1e-9;
      var dxn = lx / ld, dyn = ly / ld, dzn = lz / ld;
      // planet shadow (night side): a ray that dives inside the deep rock
      // body is analytic; everything else marches the voxel terrain, so
      // mountains and crater rims cast real shade across the ocean
      var ex = cx - px[p], ey = cy - py[p], ez = cz - pz[p];
      var b = ex * dxn + ey * dyn + ez * dzn;
      var tt = this.terrain;
      if (tt) {
        var d2c = ex * ex + ey * ey + ez * ez - b * b;
        if (b > 0 && d2c < tt.Rlo2 * 0.96) {
          lit = 0;                                   // buries in the rock body
        } else if (b > 0 || d2c < tt.Rhi2 * 1.1) {
          var stp = dx * 1.5, mx = px[p], my = py[p], mz = pz[p];
          var esc2 = (tt.Rhi + 0.1) * (tt.Rhi + 0.1);
          var tvn = tt.n, tvd = tt.dv, tvs = tt.solid;
          for (var st2 = 0; st2 < 26; st2++) {
            mx += dxn * stp; my += dyn * stp; mz += dzn * stp;
            var rex = mx - cx, rey = my - cy, rez = mz - cz;
            if (rex * rex + rey * rey + rez * rez > esc2) break;   // open sky
            var ivx = mx / tvd | 0; if (ivx < 0 || ivx >= tvn) break;
            var ivy = my / tvd | 0; if (ivy < 0 || ivy >= tvn) break;
            var ivz = mz / tvd | 0; if (ivz < 0 || ivz >= tvn) break;
            if (tvs[(ivz * tvn + ivy) * tvn + ivx]) { lit = 0; break; }
          }
        }
      } else if (b > 0) {
        var d2c2 = ex * ex + ey * ey + ez * ez - b * b;
        if (d2c2 < coreR2) lit = 0;
      }
      if (lit) {
        // water-column optical depth: march the density field toward the sun
        var od = 0, sx = px[p], sy = py[p], sz = pz[p];
        for (var st = 0; st < marchMaxN && st * half < marchMax; st++) {
          sx += dxn * half; sy += dyn * half; sz += dzn * half;
          // nearest-corner density sample (smooth field — plenty for depth)
          var i0 = sx / dx | 0, j0 = sy / dx | 0, k0 = sz / dx | 0;
          if (i0 < 0 || j0 < 0 || k0 < 0 || i0 >= nx || j0 >= ny || k0 >= nz) break;
          var v = dens[k0 * sk + j0 * sj + i0];
          od += v * half * absK;
          if (od > 3.5) break;    // effectively opaque water above
        }
        if (od < 3.5) lit = Math.exp(-od);
        else lit = 0;
      }
      }
    }
    // mirror the exposure for the renderer: water, droplets and vapor all
    // render shaded wherever this says the sun is not seen (night side,
    // terrain shade, buried under optically thick water)
    pLight[p] = lit;
    // radiative exchange with space: darkness cools faster — the night side
    // and buried water sink toward ambient quicker than lit surface water.
    // Vapor (pflag 2) lives in the open air: it sheds heat much faster and
    // its ambient is the sky itself — mild by day, freezing on the night
    // side — so airborne water condenses in shade and after sundown.
    var T;
    if (fl[p] === 2) {
      var airAmb = lit > 0.05 ? Tamb + 0.18 : 0.06;
      // Latent-heat residence: shaded parcels cool over several seconds,
      // enough for the upper circulation to carry moisture onto the night side.
      var airK = sun ? 0.16 + (1 - lit) * 0.20 : 1.2;
      T = pT[p] + (airAmb - pT[p]) * airK * dt;
      if (lit > 0) T += sunPow * 0.6 * lit * dt;
    } else if (fl[p] === 3) {
      // cloud droplets: same sky ambient as steam, milder coupling (the
      // condensate holds its latent heat longer), gentler solar gain
      var cldAmb = lit > 0.05 ? Tamb + 0.18 : 0.06;
      var cldK = sun ? 0.10 + (1 - lit) * 0.12 : 0.9;
      T = pT[p] + (cldAmb - pT[p]) * cldK * dt;
      if (lit > 0) T += sunPow * 0.35 * lit * dt;
    } else {
      // liquid (and freezing rain / snow): the relaxation target is the sun
      // state — lit water rides the ocean ambient, but water seeing NO sun
      // radiation (night side, terrain shade, depth) radiates to space and
      // cools all the way to 0. Warm neighbours still share heat through the
      // conservative conduction below, so sheltered water stays warm exactly
      // as long as its surroundings do.
      var watAmb = lit > 0.05 ? Tamb : 0;
      T = pT[p] + (watAmb - pT[p]) * (dissip + (1 - lit) * shadeCool) * dt;
      if (lit > 0) T += sunPow * lit * dt;
    }
    if (T > 1.15) T = 1.15; else if (T < 0) T = 0;
    pT[p] = T;
  }
};

// ---- conservative cell-aggregate conduction ---------------------------------
FluidSolver.prototype._heatMeansSlice = function (c0, c1) {
  var pT = this.pT, hCnt = this._hCnt, hStart = this._hStart, hOrd = this._hOrd;
  if (!this._heatMean || this._heatMean.length !== this.nCells) {
    this._heatMean = this._alloc('_heatMean', Float64Array, this.nCells);
    this._heatDelta = this._alloc('_heatDelta', Float64Array, this.nCells);
  }
  var means = this._heatMean;
  var c, e, sumT;
  for (c = c0; c < c1; c++) {
    sumT = 0;
    for (e = hStart[c]; e < hStart[c + 1]; e++) sumT += pT[hOrd[e]];
    means[c] = hCnt[c] ? sumT / hCnt[c] : 0;
  }
};

// Flux pass: equal/opposite neighbor-cell energy exchange (serial on the
// coordinator — O(nCells), read-only inputs, no partials needed).
FluidSolver.prototype._heatConductFlux = function () {
  if (this.heatK <= 0) return;
  var nP = this.nP;
  if (nP < 1) return;
  var nx = this.nx, ny = this.ny, nz = this.nz;
  if (!this._heatDelta || this._heatDelta.length !== this.nCells) {
    this._heatMean = this._alloc('_heatMean', Float64Array, this.nCells);
    this._heatDelta = this._alloc('_heatDelta', Float64Array, this.nCells);
  }
  var hCnt = this._hCnt, means = this._heatMean, changes = this._heatDelta;
  var dt = this._heatDt || 0;
  changes.fill(0);
  var alpha = Math.min(this.heatK * dt * 0.15, 0.14);
  var nxyH = nx * ny;
  var i, j, k, c, axis, neighbor, energy;
  for (k = 0; k < nz; k++) for (j = 0; j < ny; j++) for (i = 0; i < nx; i++) {
    c = (k * ny + j) * nx + i;
    if (!hCnt[c]) continue;
    for (axis = 0; axis < 3; axis++) {
      if ((axis === 0 && i === nx - 1) || (axis === 1 && j === ny - 1) || (axis === 2 && k === nz - 1)) continue;
      neighbor = c + (axis === 0 ? 1 : axis === 1 ? nx : nxyH);
      if (!hCnt[neighbor]) continue;
      energy = alpha * Math.min(hCnt[c], hCnt[neighbor]) * (means[neighbor] - means[c]);
      changes[c] += energy; changes[neighbor] -= energy;
    }
  }
};

FluidSolver.prototype._heatApplySlice = function (c0, c1) {
  var pT = this.pT, hCnt = this._hCnt, hStart = this._hStart, hOrd = this._hOrd;
  var means = this._heatMean, changes = this._heatDelta;
  var alpha = this._heatAlpha || 0;
  var c, e, p, deltaT;
  for (c = c0; c < c1; c++) {
    if (!hCnt[c]) continue;
    deltaT = changes[c] / hCnt[c];
    for (e = hStart[c]; e < hStart[c + 1]; e++) {
      p = hOrd[e];
      pT[p] += alpha * (means[c] - pT[p]) + deltaT;
    }
  }
};

// ---- convection: buoyancy along the radial ----------------------------------
FluidSolver.prototype._heatConvectChunk = function (p0, p1, dt) {
  var px = this.px, py = this.py, pz = this.pz, pT = this.pT, fl = this.pflag;
  var pvx = this.pvx, pvy = this.pvy, pvz = this.pvz;
  var cx = this.cx, cy = this.cy, cz = this.cz, Tamb = this.Tamb;
  var beta = 3.0;
  for (var p = p0; p < p1; p++) {
    if (fl[p] !== 0) continue;                        // droplets/vapor are ballistic
    var rx = px[p] - cx, ry = py[p] - cy, rz = pz[p] - cz;
    var rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1e-9;
    var ab = beta * (pT[p] - Tamb) * dt / rl;
    pvx[p] += rx * ab; pvy[p] += ry * ab; pvz[p] += rz * ab;
  }
};

// ------------------------------------------------------------- evaporation
// Surface water leaves the liquid: a fluid particle whose cell has no fluid
// above it (along local "up") may evaporate into levitating vapor (pflag 2) —
// on the sunlit side AND on the dark side. The probability is interpolated as
// an EXPONENTIAL GROWTH curve across the live water temperature range:
// τ = (T − Tmin)/(Tmax − Tmin) over all current water, p ∝ exp(C·(τ − 1)),
// so the hottest water steams ~e^C (≈150×) faster than the coldest. Sun-warm
// day water therefore evaporates fast while cold night water only seeps —
// the dark side is never fully dry. The escape kick is MAXWELL–BOLTZMANN
// (thermal speed spectrum, σ scaled by τ), which under the slight atmospheric
// gravity gives the vapor a bottom-heavy barometric height profile. Sun
// activity scales the whole curve; the seeded PRNG keeps every run
// deterministic.
FluidSolver.prototype._updateEvaporation = function (dt) {
  var rate = this.sunActivity;
  if (rate <= 0) return;
  var range = this._evapRangeChunk(0, this.nP);
  var Tmin = range[0], Tmax = range[1];
  if (!isFinite(Tmin) || !isFinite(Tmax)) return;
  this.evapCount = this._evapChunk(0, this.nP, dt, Tmin, Tmax);
};

// Live water temperature range over the EVAPORATION-ELIGIBLE population
// (above the evaporation point) — the ejection probability curve is
// normalized across the water that can actually leave. Serial helper.
FluidSolver.prototype._evapRangeChunk = function (p0, p1) {
  var pT = this.pT, fl = this.pflag;
  var evapGate = this.evapT * 1.05;
  var Tmin = Infinity, Tmax = -Infinity, T, q;
  for (q = p0; q < p1; q++) {
    if (fl[q] === 2) continue;
    T = pT[q];
    if (T < evapGate) continue;   // below the evaporation point: ineligible
    if (T < Tmin) Tmin = T;
    if (T > Tmax) Tmax = T;
  }
  return [Tmin, Tmax];
};

// Surface ejection pass (per particle, chunkable; the RNG stream is re-seeded
// per chunk). Returns the chunk's evaporation count. Water only leaves for
// the sky once heated 5% ABOVE the evaporating point (the vapor point
// slider; the rain point is the same phase equilibrium seen from the air
// side) — colder surface water stays put however sunny it is.
FluidSolver.prototype._evapChunk = function (p0, p1, dt, Tmin, Tmax) {
  var rate = this.sunActivity;
  if (rate <= 0) return 0;
  var evapGate = this.evapT * 1.05;
  var px = this.px, py = this.py, pz = this.pz, pT = this.pT;
  var fl = this.pflag, pAir = this.pAir;
  var pvx = this.pvx, pvy = this.pvy, pvz = this.pvz;
  var type = this.cellType, nx = this.nx, ny = this.ny, nz = this.nz, dx = this.dx;
  var sphere = this.mode === 'sphere';
  var cx = this.cx, cy = this.cy, cz = this.cz;
  var evapN = 0, T;
  var span = Tmax - Tmin; if (span < 0.15) span = 0.15;   // degenerate guard
  var C = 5;                                    // exponential steepness
  var invSpan = 1 / span;
  for (var p = p0; p < p1; p++) {
    if (fl[p] !== 0) continue;
    T = pT[p];
    var i = px[p] / dx | 0, j = py[p] / dx | 0, k = pz[p] / dx | 0;
    if (i < 1) i = 1; else if (i > nx - 2) i = nx - 2;
    if (j < 1) j = 1; else if (j > ny - 2) j = ny - 2;
    if (k < 1) k = 1; else if (k > nz - 2) k = nz - 2;
    var c = (k * ny + j) * nx + i;
    if (type[c] !== FLUID) continue;
    if (T < evapGate) continue;   // below the evaporation point: no take-off
    // surface-top: no fluid in the neighbouring cell along local "up"
    if (sphere) {
      var ex = px[p] - cx, ey = py[p] - cy, ez = pz[p] - cz;
      var el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-9;
      var ui = (px[p] + ex / el * dx) / dx | 0;
      var uj = (py[p] + ey / el * dx) / dx | 0;
      var uk = (pz[p] + ez / el * dx) / dx | 0;
      if (ui < 0 || uj < 0 || uk < 0 || ui >= nx || uj >= ny || uk >= nz) continue;
      if (type[(uk * ny + uj) * nx + ui] === FLUID) continue;
    } else if (j + 1 <= ny - 2 && type[c + nx] === FLUID) {
      continue;
    }
    // exponential heat-gated probability (seeded, deterministic). τ is
    // measured DOWN from the hottest eligible water so the hottest surface
    // parcel always sits at τ = 1 (full probability) even when the eligible
    // band is narrow or degenerate (single eligible particle).
    var tau = 1 - (Tmax - T) * invSpan;
    if (tau < 0) tau = 0; else if (tau > 1) tau = 1;
    var prob = rate * 1.6 * dt * Math.exp(C * (tau - 1));
    this._evS = (this._evS * 1664525 + 1013904223) >>> 0;
    var rnd = this._evS / 4294967296;
    if (rnd > prob) continue;
    // evaporate: leave the liquid with a MAXWELL–BOLTZMANN kick — three
    // independent Gaussian velocity components (Box–Muller from the seeded
    // LCG), giving the thermal escape spectrum f(v) ∝ v²·exp(−v²/2σ²) whose
    // mean energy balances gravity into a barometric vapor profile. σ (one
    // component's spread) grows with the normalized heat (σ ∝ √T physically):
    // warm day water boils off energetic parcels, cold night water seeps out
    // slow ones. Mirroring the radial component above the local horizon keeps
    // fresh vapor leaving the water and — a pure sign flip — preserves the
    // MB speed distribution exactly.
    fl[p] = 2; pAir[p] = 0;
    var sig = 0.30 + 0.32 * Math.sqrt(tau);      // per-component σ (m/s), heat-scaled
    var kx = sig * this._evGauss(), ky = sig * this._evGauss(), kz = sig * this._evGauss();
    if (sphere) {
      var ex2 = px[p] - cx, ey2 = py[p] - cy, ez2 = pz[p] - cz;
      var el2 = ex2 * ex2 + ey2 * ey2 + ez2 * ez2;
      var elL = Math.sqrt(el2) || 1e-9;
      var kUp = (kx * ex2 + ky * ey2 + kz * ez2) / el2;   // radial component
      if (kUp < 0) {                                       // mirror to the sky
        kx -= 2 * kUp * ex2 / elL; ky -= 2 * kUp * ey2 / elL; kz -= 2 * kUp * ez2 / elL;
      }
      // no-slip leave-taking: the fresh parcel keeps the surface's normal
      // motion and adopts the local TANGENTIAL flow of the surface it leaves
      // (MAC-grid velocity sampled at the generation site, projected onto
      // the tangent plane) — then the MB thermal kick on top
      var guS = this.u.length ? this.u[(k * ny + j) * (nx + 1) + i] : 0;
      var gvS = this.v.length ? this.v[(k * (ny + 1) + j) * nx + i] : 0;
      var gwS = this.w.length ? this.w[(k * ny + j) * nx + i] : 0;
      var nl2 = 1 / el2, vN = (pvx[p] * ex2 + pvy[p] * ey2 + pvz[p] * ez2) * nl2;
      var vNx = vN * ex2, vNy = vN * ey2, vNz = vN * ez2;           // normal part (kept)
      var gN = (guS * ex2 + gvS * ey2 + gwS * ez2) * nl2;
      var vtx = guS - gN * ex2, vty = gvS - gN * ey2, vtz = gwS - gN * ez2;   // tangential flow
      pvx[p] = vNx + vtx + kx; pvy[p] = vNy + vty + ky; pvz[p] = vNz + vtz + kz;
    } else {
      if (ky < 0) ky = -ky;                                // pool: up is +y
      // no-slip: horizontal components adopt the local surface flow
      var guB = this.u.length ? this.u[(k * ny + j) * (nx + 1) + i] : 0;
      var gwB = this.w.length ? this.w[(k * ny + j) * nx + i] : 0;
      pvx[p] = guB + kx; pvy[p] += ky; pvz[p] = gwB + kz;
    }
    evapN++;
  }
  return evapN;
};

// One standard-normal draw (Box–Muller) from the seeded evaporation LCG —
// the Maxwell–Boltzmann ejection sampler; deterministic run to run.
FluidSolver.prototype._evGauss = function () {
  var u1;
  do { this._evS = (this._evS * 1664525 + 1013904223) >>> 0; u1 = this._evS / 4294967296; } while (u1 < 1e-9);
  this._evS = (this._evS * 1664525 + 1013904223) >>> 0;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(6.283185306 * (this._evS / 4294967296));
};

// --------------------------------------------------------- phase changes
// Substates of the evaporated particle, evaluated once per frame (serial on
// the coordinator, like _vaporCollisions — the 27-cell steam density scan is
// cheap next to the collision sweep):
//   steam (2) → rain (4)      T ≤ rainT            (only steam rains out)
//   steam (2) → cloud (3)     T ≤ cloudT AND local steam density ≥ cloudP,
//                             above the cloud base (30% of the atmosphere)
//   cloud (3) → steam (2)     T ≥ cloudT + 0.05    (sun-warmed clouds burn off)
//   water (0)/rain (4) → snow (5)   T ≤ snowT      (frozen — stops moving)
//   snow (5) → water (0)      T ≥ meltT (5% above the snow point) and inside
//                             the liquid
//   snow (5) → rain (4)       T ≥ meltT, airborne (falls, then lands)
// rainT/snowT are ordering-clamped below cloudT/rainT so slider combinations
// can never invert the chain.
// Per-particle deterministic hash — the
// spin seeder must produce IDENTICAL values across runs so the
// parity contract holds.
FluidSolver.prototype._spinHash = function (a, b, c) {
  var s = (a ^ (b * 0x9e3779b9) ^ (c * 0x85ebca6b) ^ (0x51ab3c77 * 0xc2b2ae35)) >>> 0;
  s = (s * 1664525 + 1013904223) >>> 0;
  s ^= s >>> 13; s = (s * 0x5bd1e995) >>> 0; s ^= s >>> 15;
  return s >>> 0;
};

FluidSolver.prototype._updatePhaseChanges = function (dt) {
  var nP = this.nP, fl = this.pflag, pT = this.pT;
  var px = this.px, py = this.py, pz = this.pz;
  var nx = this.nx, ny = this.ny, nz = this.nz, dx = this.dx;
  var cnt = this._steamCnt;
  cnt.fill(0);
  var p, i, j, k, c;
  for (p = 0; p < nP; p++) {
    if (fl[p] !== 2) continue;
    i = px[p] / dx | 0; j = py[p] / dx | 0; k = pz[p] / dx | 0;
    if (i < 0) i = 0; else if (i >= nx) i = nx - 1;
    if (j < 0) j = 0; else if (j >= ny) j = ny - 1;
    if (k < 0) k = 0; else if (k >= nz) k = nz - 1;
    cnt[(k * ny + j) * nx + i]++;
  }
  var cloudT = this.cloudT, cloudP = this.cloudP;
  var rainT = Math.min(this.rainT, cloudT - 0.02); if (rainT < 0) rainT = 0;
  var snowT = Math.min(this.snowT, rainT - 0.02); if (snowT < 0) snowT = 0;
  // ice must be heated 5% ABOVE the freezing point to melt back (the UI
  // slider can raise it further; the +5% band is the invariant minimum so
  // freezing and melting can never chatter at the same temperature)
  var meltT = this.meltT > snowT * 1.05 ? this.meltT : snowT * 1.05;
  var type = this.cellType, FL = FLUID;
  var sphere = this.mode === 'sphere';
  var cloudBase = sphere ? this.oceanR + 0.3 * this.atmosphereH
                         : this.waterTopY + 0.3 * this.atmosphereH;
  var cx = this.cx, cy = this.cy, cz = this.cz;
  for (p = 0; p < nP; p++) {
    var f = fl[p];
    // pT === 0 marks "thermal never ran" (box-mode tests, first frame) —
    // never treat it as absolute-zero cold. Water freezes only at a
    // fluid–air interface (sea/pond surface): deep water cannot shed its
    // latent heat to the sky, and freezing mid-ocean would strand the
    // embedded-particle rescue.
    if (f === 0) {
      if (pT[p] <= snowT && pT[p] > 1e-3) {
        i = px[p] / dx | 0; j = py[p] / dx | 0; k = pz[p] / dx | 0;
        if (i < 0) i = 0; else if (i >= nx) i = nx - 1;
        if (j < 0) j = 0; else if (j >= ny) j = ny - 1;
        if (k < 0) k = 0; else if (k >= nz) k = nz - 1;
        var cB = (k * ny + j) * nx + i;
        var atSurf = (k > 0 && type[cB - nx * ny] !== FL) || (k < nz - 1 && type[cB + nx * ny] !== FL) ||
                     (j > 0 && type[cB - nx] !== FL) || (j < ny - 1 && type[cB + nx] !== FL) ||
                     (i > 0 && type[cB - 1] !== FL) || (i < nx - 1 && type[cB + 1] !== FL);
        if (atSurf) {
          fl[p] = 5; this.pvx[p] = this.pvy[p] = this.pvz[p] = 0;
          this.pAir[p] = 1;   // sea/pond ice: already resting at the surface → stuck
        }
      }
      continue;
    }
    if (f === 5) {
      if (pT[p] >= meltT) {
        i = px[p] / dx | 0; j = py[p] / dx | 0; k = pz[p] / dx | 0;
        if (i < 0) i = 0; else if (i >= nx) i = nx - 1;
        if (j < 0) j = 0; else if (j >= ny) j = ny - 1;
        if (k < 0) k = 0; else if (k >= nz) k = nz - 1;
        fl[p] = type[(k * ny + j) * nx + i] === FL ? 0 : 4;
        this.pAir[p] = 0;
        this.pWx[p] = this.pWy[p] = this.pWz[p] = 0;
      }
      continue;
    }
    var T = pT[p];
    if (T <= 1e-3) continue;                                      // thermal not live
    if (f === 2) {
      if (T <= rainT) { fl[p] = 4; this.pAir[p] = 0; this.pWx[p] = this.pWy[p] = this.pWz[p] = 0; continue; }   // rains out
      if (T > cloudT) continue;                                     // too warm for cloud
      if (sphere) {
        if (Math.sqrt((px[p] - cx) * (px[p] - cx) + (py[p] - cy) * (py[p] - cy) + (pz[p] - cz) * (pz[p] - cz)) < cloudBase) continue;
      } else if (py[p] < cloudBase) continue;
      // steam density: count in the 3×3×3 cell neighbourhood (pressure proxy)
      i = px[p] / dx | 0; j = py[p] / dx | 0; k = pz[p] / dx | 0;
      var i0 = i > 0 ? i - 1 : 0, i1 = i < nx - 1 ? i + 1 : nx - 1;
      var j0 = j > 0 ? j - 1 : 0, j1 = j < ny - 1 ? j + 1 : ny - 1;
      var k0 = k > 0 ? k - 1 : 0, k1 = k < nz - 1 ? k + 1 : nz - 1;
      var sum = 0;
      for (var kk = k0; kk <= k1; kk++) for (var jj = j0; jj <= j1; jj++) {
        var row = (kk * ny + jj) * nx;
        for (var ii = i0; ii <= i1; ii++) sum += cnt[row + ii];
      }
      if (sum / 27 >= cloudP) { fl[p] = 3; this.pAir[p] = 0; }
      continue;
    }
    if (f === 3) {
      if (T >= cloudT + 0.05) fl[p] = 2;   // burned off by the sun
      continue;
    }
    // f === 4 (rain): freezes into snow when even colder; landing rules
    // (FLUID contact / terrain / floor film) absorb it back into the liquid.
    // Freezing rain stays FREE (pAir 0) — it falls as ice until it touches
    // terrain or another ice particle (see _iceContacts / the motion pass).
    if (T <= snowT) { fl[p] = 5; this.pvx[p] = this.pvy[p] = this.pvz[p] = 0; this.pAir[p] = 0; this.pWx[p] = this.pWy[p] = this.pWz[p] = 0; }
  }
  // ---- particle rotation bookkeeping (airborne family, fl 2/3) ----------
  // Fresh steam (pAir 0 — just ejected by the MB sampler) is seeded with a
  // thermally excited spin: random axis, speed σ·√T. Spin then damps gently
  // in the air and advances the render phase. Deterministic per (seed, p, tick).
  if (this.spinOn && this.pWx && this.pWx.length >= nP && dt > 0) {
    var pWx = this.pWx, pWy = this.pWy, pWz = this.pWz, pPh = this.pPh;
    var tick = (this._simTime * 60) | 0, sd = 0x51ab3c77;
    var damp = dt > 0 ? Math.max(0, 1 - 0.12 * dt) : 1;
    for (p = 0; p < nP; p++) {
      f = fl[p];
      if (f !== 2 && f !== 3) continue;
      if (f === 2 && this.pAir[p] <= 1e-6 && pWx[p] === 0 && pWy[p] === 0 && pWz[p] === 0) {
        // thermal spin seed: uniform random axis (z–θ parametrization)
        var h1 = this._spinHash(sd, p, tick) / 4294967296;
        var h2 = this._spinHash(sd + 1, p, tick) / 4294967296;
        var h3 = this._spinHash(sd + 2, p, tick) / 4294967296;
        var zz = 2 * h2 - 1, rr = Math.sqrt(Math.max(0, 1 - zz * zz)), th = 6.283185306 * h1;
        var Tp = pT[p]; if (!(Tp > 0.05)) Tp = 0.05; else if (Tp > 1.15) Tp = 1.15;
        var wSpd = 3.0 * Math.sqrt(Tp) * (0.5 + h3);
        pWx[p] = rr * Math.cos(th) * wSpd; pWy[p] = zz * wSpd; pWz[p] = rr * Math.sin(th) * wSpd;
      }
      var wm = Math.sqrt(pWx[p] * pWx[p] + pWy[p] * pWy[p] + pWz[p] * pWz[p]);
      if (wm > 1e-6) pPh[p] += wm * dt;
      pWx[p] *= damp; pWy[p] *= damp; pWz[p] *= damp;
    }
  }
};

// ---------------------------------------------------- ice contact sweep
// Ice is adhesive: a FREE (falling) snow particle that touches TERRAIN stops
// for good (the motion pass handles that), and one that touches an already
// STUCK particle aggregates onto the pack. Two FREE particles that touch
// each other stick to one another — equal masses adopt the mean velocity
// (perfectly inelastic pairing), then keep falling as a pair. Serial sweep
// with the same sorted-x slab strategy as _vaporCollisions.
FluidSolver.prototype._iceContacts = function () {
  var fl = this.pflag, nP = this.nP, pAir = this.pAir;
  var nI = 0, iceIdx = this._iceIdx;
  var px = this.px, py = this.py, pz = this.pz;
  for (var p = 0; p < nP; p++) {
    if (fl[p] !== 5) continue;
    if (iceIdx.length <= nI) iceIdx.push(0);
    iceIdx[nI++] = p;
  }
  if (nI < 2) return;
  var pvx = this.pvx, pvy = this.pvy, pvz = this.pvz;
  var rad = this.spacing * 0.7, rad2 = rad * rad;
  iceIdx.length = nI;
  iceIdx.sort(function (a, b) { return px[a] - px[b] || a - b; });
  for (var a = 0; a < nI; a++) {
    var i = iceIdx[a];
    var stuckI = pAir[i] === 1;
    for (var b = a + 1; b < nI; b++) {
      var j = iceIdx[b];
      if (px[j] - px[i] >= rad) break;
      var ddx = px[j] - px[i], ddy = py[j] - py[i], ddz = pz[j] - pz[i];
      if (ddx * ddx + ddy * ddy + ddz * ddz >= rad2) continue;
      var stuckJ = pAir[j] === 1;
      if (stuckI && stuckJ) continue;
      if (stuckJ) {          // free i lands on the pack at j
        pAir[i] = 1; pvx[i] = pvy[i] = pvz[i] = 0; stuckI = true;
      } else if (stuckI) {   // free j lands on the pack at i
        pAir[j] = 1; pvx[j] = pvy[j] = pvz[j] = 0;
      } else {               // two free grains: inelastic pairing (mean velocity)
        var mx = (pvx[i] + pvx[j]) * 0.5, my = (pvy[i] + pvy[j]) * 0.5, mz = (pvz[i] + pvz[j]) * 0.5;
        pvx[i] = pvx[j] = mx; pvy[i] = pvy[j] = my; pvz[i] = pvz[j] = mz;
      }
    }
  }
};

// ------------------------------------------------- embedded particle rescue
// Realistic collisions between airborne particles. Steam/cloud pairs collide
// with each other (below); every airborne parcel additionally collides with
// LIQUID particles it touches — ocean surface skin, spray and rain. The
// liquid body acts as a moving boundary (a droplet is nothing next to the
// sea): the parcel reflects off the LOCAL water velocity with restitution
// 0.4, overlap separates by displacing only the parcel, and a soft buoyant
// kick keeps vapor resting ON the sea instead of sinking into it. The water
// itself is never pushed — the FLIP grid owns the ocean's momentum.

// Realistic collisions between airborne vapor particles: approaching pairs
// closer than a particle diameter exchange their velocity component along
// the contact normal (the equal-mass elastic collision solution); ALL
// overlapping pairs are additionally separated and pushed apart by a soft
// repulsion impulse, so dense vapor actively spreads instead of clumping.
// Solved once per frame over the vapor population; deterministic (index
// order), so the sim stays reproducible. An x-axis spatial sweep prunes
// separated pairs without disabling collisions when the atmosphere gets
// crowded.
FluidSolver.prototype._vaporCollisions = function () {
  var fl = this.pflag, nP = this.nP;
  var nV = 0, vIdx = this._vIdx, night = 0, nSteam = 0;
  var sun = this.sunPos;
  var sx = sun ? sun[0] - this.cx : 0, sy = sun ? sun[1] - this.cy : 0, sz = sun ? sun[2] - this.cz : 0;
  for (var p = 0; p < nP; p++) {
    var fp = fl[p];
    if (fp !== 2 && fp !== 3) continue;   // steam + cloud droplets both collide
    if (vIdx.length <= nV) vIdx.push(0);
    vIdx[nV++] = p;
    if (fp === 2) {                        // the census stays steam-only
      nSteam++;
      if (!sun || (this.px[p] - this.cx) * sx + (this.py[p] - this.cy) * sy + (this.pz[p] - this.cz) * sz < 0) night++;
    }
  }
  this.vaporCount = nSteam; this.nightVaporCount = night;
  if (nV < 2) return;
  var px = this.px, py = this.py, pz = this.pz;
  var pvx = this.pvx, pvy = this.pvy, pvz = this.pvz;
  var pWx = this.pWx, pWy = this.pWy, pWz = this.pWz;
  var spinOn = this.spinOn && pWx && pWx.length >= nP;
  var rad = this.spacing * 0.6, rad2 = rad * rad;
  // Sort once along x, then sweep only overlapping slabs. Unlike the old
  // quadratic all-pairs scan, a crowded atmosphere never disables collisions.
  vIdx.length = nV;
  vIdx.sort(function (a, b) { return px[a] - px[b] || a - b; });
  for (var a = 0; a < nV; a++) {
    var i = vIdx[a];
    for (var b = a + 1; b < nV; b++) {
      var j = vIdx[b];
      if (px[j] - px[i] >= rad) break;
      var ddx = px[j] - px[i], ddy = py[j] - py[i], ddz = pz[j] - pz[i];
      var d2 = ddx * ddx + ddy * ddy + ddz * ddz;
      if (d2 >= rad2) continue;
      var d = Math.sqrt(d2) || 1e-9;
      var nX = ddx / d, nY = ddy / d, nZ = ddz / d;
      var vRel = (pvx[i] - pvx[j]) * nX + (pvy[i] - pvy[j]) * nY + (pvz[i] - pvz[j]) * nZ;
      if (vRel > 0) {
        // approaching: equal masses swap the normal component (elastic
        // collision), tangential motion kept
        pvx[i] -= vRel * nX; pvy[i] -= vRel * nY; pvz[i] -= vRel * nZ;
        pvx[j] += vRel * nX; pvy[j] += vRel * nY; pvz[j] += vRel * nZ;
      }
      // overlapping parcels ALWAYS repel: separate out of overlap positionally
      // and exchange a soft separating impulse, so dense vapor actively pushes
      // itself apart instead of clumping into beads
      var half = (rad - d) * 0.5;
      px[i] -= nX * half; py[i] -= nY * half; pz[i] -= nZ * half;
      px[j] += nX * half; py[j] += nY * half; pz[j] += nZ * half;
      var kick = (rad - d) * 2;
      pvx[i] -= nX * kick; pvy[i] -= nY * kick; pvz[i] -= nZ * kick;
      pvx[j] += nX * kick; pvy[j] += nY * kick; pvz[j] += nZ * kick;
      if (!spinOn) continue;
      // ---- rotational coupling (equal solid spheres, m = 1, I = 2/5·R²) --
      // Surface slip at the contact point u = (v_i − v_j) + R·(ω_i+ω_j)×n̂
      // drives a friction impulse that opposes the slip: linear energy
      // drains into rotation (and a Coulomb-capped remainder dissipates) —
      // the natural billiard-ball redistribution, applied per contact.
      var R = rad * 0.5;
      var wSx = pWx[i] + pWx[j], wSy = pWy[i] + pWy[j], wSz = pWz[i] + pWz[j];
      var usx = (pvx[i] - pvx[j]) + R * (wSy * nZ - wSz * nY);
      var usy = (pvy[i] - pvy[j]) + R * (wSz * nX - wSx * nZ);
      var usz = (pvz[i] - pvz[j]) + R * (wSx * nY - wSy * nX);
      var uN = usx * nX + usy * nY + usz * nZ;
      var utx = usx - uN * nX, uty = usy - uN * nY, utz = usz - uN * nZ;
      var utM = Math.sqrt(utx * utx + uty * uty + utz * utz);
      if (utM < 1e-9) continue;
      // slip-killing impulse for solid spheres is |u_t|/7 (Δu_t = 7·J_t);
      // Coulomb: friction can never exceed μ × the normal impulse (vRel)
      var jt = utM / 7;
      if (vRel > 0) { var mu = 0.25 * vRel; if (jt > mu) jt = mu; }
      var jx = -utx / utM * jt, jy = -uty / utM * jt, jz = -utz / utM * jt;
      pvx[i] += jx; pvy[i] += jy; pvz[i] += jz;
      pvx[j] -= jx; pvy[j] -= jy; pvz[j] -= jz;
      // Δω_i = (R·n̂ × J)/I and the same for j (opposite arm × opposite
      // impulse — the pair co-rotates, verified against the gear intuition)
      var invI = 1 / (0.4 * R * R);
      var dwx = R * (nY * jz - nZ * jy) * invI;
      var dwy = R * (nZ * jx - nX * jz) * invI;
      var dwz = R * (nX * jy - nY * jx) * invI;
      pWx[i] += dwx; pWy[i] += dwy; pWz[i] += dwz;
      pWx[j] += dwx; pWy[j] += dwy; pWz[j] += dwz;
    }
  }
  // ---- airborne × liquid contacts -------------------------------------------
  // Walk the LIQUID population (ocean surface band, spray, rain) against the
  // sorted vapor list: binary search the x-window, test the pair distance,
  // resolve as a parcel-vs-boundary contact. Runs in O(W·log V + hits).
  if (nV < 1) return;
  var dxc = this.dx;
  var sphere2 = this.mode === 'sphere';
  var band = this.oceanR - dxc * 2, bandLo2 = band * band;
  var topY = this.waterTopY - dxc * 2;
  var radW = rad, radW2 = rad2;
  for (p = 0; p < nP; p++) {
    var fw = fl[p];
    if (fw !== 0 && fw !== 1 && fw !== 4) continue;
    var wx = px[p], wy = py[p], wz = pz[p];
    if (fw === 0) {   // liquid: only the surface band ever meets the air
      if (sphere2) {
        var dwx2 = wx - this.cx, dwy2 = wy - this.cy, dwz2 = wz - this.cz;
        if (dwx2 * dwx2 + dwy2 * dwy2 + dwz2 * dwz2 < bandLo2) continue;
      } else if (wy < topY) continue;
    }
    // binary search the sorted vapor list for the x window
    var lo = 0, hi = nV;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (px[vIdx[mid]] < wx - radW) lo = mid + 1; else hi = mid; }
    for (var b2 = lo; b2 < nV; b2++) {
      var j2 = vIdx[b2];
      var ddx2 = px[j2] - wx;
      if (ddx2 >= radW) break;
      var ddy2 = py[j2] - wy, ddz2 = pz[j2] - wz;
      var dd2 = ddx2 * ddx2 + ddy2 * ddy2 + ddz2 * ddz2;
      if (dd2 >= radW2 || dd2 < 1e-12) continue;
      var dd = Math.sqrt(dd2);
      var nX2 = ddx2 / dd, nY2 = ddy2 / dd, nZ2 = ddz2 / dd;
      // relative normal velocity of the PARCEL against the local water
      // (n̂ points water → vapor; approaching = negative)
      var vR2 = (pvx[j2] - pvx[p]) * nX2 + (pvy[j2] - pvy[p]) * nY2 + (pvz[j2] - pvz[p]) * nZ2;
      if (vR2 < 0) {
        // reflect the parcel's normal motion off the moving surface with
        // restitution 0.4 — a wet splash, not a billiard shot
        var vB = vR2 * (1 + 0.4);
        pvx[j2] -= vB * nX2; pvy[j2] -= vB * nY2; pvz[j2] -= vB * nZ2;
      }
      // separate the overlap — only the parcel moves (the sea is immovable
      // at droplet scale); displace it fully out of the liquid
      var ov2 = radW - dd;
      px[j2] += nX2 * ov2; py[j2] += nY2 * ov2; pz[j2] += nZ2 * ov2;
      // soft buoyant kick: vapor resting on the sea rides upward, never sinks
      var kk2 = ov2 * 2;
      pvx[j2] += nX2 * kk2; pvy[j2] += nY2 * kk2; pvz[j2] += nZ2 * kk2;
    }
  }
};

// Frame-end guarantee: no water particle sits below the terrain surface.
// Particles in cells that rasterize solid are walked out radially (the same
// rule advection uses); particles more than half a cell under the continuous
// surface are lifted back to it. Inward velocity is killed so the rescue
// never injects energy — it only corrects embedding.
FluidSolver.prototype._pushSurfaceParticles = function () {
  this._pushSurfaceChunk(0, this.nP);
};

// Frame-end guarantee: no water particle sits below the terrain surface.
// Per-particle (chunkable): reads the rasterized world, writes only its own
// particle. Particles in cells that rasterize solid are walked out radially
// (the same rule advection uses); particles more than half a cell under the
// continuous surface are lifted back to it. Inward velocity is killed so the
// rescue never injects energy — it only corrects embedding.
FluidSolver.prototype._pushSurfaceChunk = function (p0, p1) {
  if (this.mode !== 'sphere' || !this.terrain) return;
  var px = this.px, py = this.py, pz = this.pz;
  var pvx = this.pvx, pvy = this.pvy, pvz = this.pvz, fl = this.pflag;
  var cx = this.cx, cy = this.cy, cz = this.cz, dx = this.dx;
  for (var p = p0; p < p1; p++) {
    if (fl[p] === 5) continue;   // snow is frozen — never repositioned
    var x = px[p], y = py[p], z = pz[p];
    var ex = x - cx, ey = y - cy, ez = z - cz;
    var er = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-9;
    var fixed = false, rockFixed = false;
    // Airborne water (spray/vapor) may ride the FULL atmosphere the slider
    // promises — above the simulation grid. The domain clamp is for
    // grid-coupled fluid only, and there is no terrain above the grid (the
    // cell test would only see the clamped shell, so skip it up there).
    var outer = this.domainR - dx * 0.02;
    // a thousandth of a cell inside the cap (see the advection ceiling clamp):
    // repositioning exactly to the cap radius can roundoff above it
    var skyHi = this.oceanR + this.atmosphereH - 1e-3 * dx;
    if (er > skyHi) {
      x = cx + ex / er * skyHi; y = cy + ey / er * skyHi; z = cz + ez / er * skyHi;
      var outward = (pvx[p] * ex + pvy[p] * ey + pvz[p] * ez) / er;
      if (outward > 0) {
        pvx[p] -= ex / er * outward; pvy[p] -= ey / er * outward; pvz[p] -= ez / er * outward;
      }
      px[p] = x; py[p] = y; pz[p] = z;
      ex = x - cx; ey = y - cy; ez = z - cz; er = skyHi;
      fixed = true;
    }
    if (er <= this.domainR && this._rockCellAt(x, y, z)) {
      rockFixed = true;
      var tries = 0;
      while (this._rockCellAt(x, y, z) && tries < this.nx * 2) {
        x += ex / er * dx * 0.5; y += ey / er * dx * 0.5; z += ez / er * dx * 0.5;
        tries++;
      }
      fixed = true;
    } else if (fl[p] === 0 && er <= this.domainR) {
      var Rt = this.terrainRadiusAt(x, y, z);
      if (er < Rt - dx * 0.5) {                // buried under the smooth surface
        rockFixed = true;
        var t2 = 0;
        x = cx + ex / er * (Rt + dx * 0.05);
        y = cy + ey / er * (Rt + dx * 0.05);
        z = cz + ez / er * (Rt + dx * 0.05);
        while (this._rockCellAt(x, y, z) && t2 < 8) {   // stairstep: keep walking
          x += ex / er * dx * 0.5; y += ey / er * dx * 0.5; z += ez / er * dx * 0.5;
          t2++;
        }
        fixed = true;
      }
    }
    // Terrain push-out must also respect the ceiling: fluid stays inside the
    // domain shell, airborne water is capped at the atmosphere top (never
    // escape, never fly through rock).
    var finalR = Math.sqrt((x-cx)*(x-cx)+(y-cy)*(y-cy)+(z-cz)*(z-cz));
    var capR = fl[p] === 0 ? outer : skyHi;
    if (finalR > capR) {
      x = cx + (x-cx) * capR / finalR; y = cy + (y-cy) * capR / finalR; z = cz + (z-cz) * capR / finalR;
      fixed = true;
    }
    if (fixed) {
      px[p] = x; py[p] = y; pz[p] = z;
      var vr = (pvx[p] * ex + pvy[p] * ey + pvz[p] * ez) / er;
      if (rockFixed && vr < 0) { pvx[p] -= ex / er * vr; pvy[p] -= ey / er * vr; pvz[p] -= ez / er * vr; }
    }
  }
};

// ------------------------------------------------------------- surface census
// Fraction of the planet's surface that is dry land: directions whose terrain
// stands above sea level AND has no fluid cell sitting on it (beached puddles
// and lakes count as wet). ~1200 voxel rays, cheap enough to poll.
FluidSolver.prototype.dryLandFraction = function () {
  if (this.mode !== 'sphere' || !this.terrain) return 0;
  var cx = this.cx, cy = this.cy, cz = this.cz, dx = this.dx;
  var type = this.cellType, nx = this.nx, ny = this.ny, nz = this.nz;
  var t = this.terrain, n = t.n, dv = t.dv, solid = t.solid;
  var N = 1200, dry = 0;
  for (var i = 0; i < N; i++) {
    var a = i * 2.399963, u = 1 - 2 * (i + 0.5) / N;
    var sq = Math.sqrt(1 - u * u);
    var ldx = sq * Math.cos(a), ldy = u, ldz = sq * Math.sin(a);
    var Rt = -1;                               // rock surface along this ray
    for (var rr = t.Rhi + dv; rr > t.Rlo - dv; rr -= dv * 0.5) {
      var sx = (cx + ldx * rr) / dv | 0, sy = (cy + ldy * rr) / dv | 0, sz = (cz + ldz * rr) / dv | 0;
      if (sx < 0 || sy < 0 || sz < 0 || sx >= n || sy >= n || sz >= n) continue;
      if (solid[(sz * n + sy) * n + sx]) { Rt = rr; break; }
    }
    if (Rt < 0 || Rt <= this.oceanR) continue;           // ocean floor: wet
    var wet = false;
    for (var st = 1; st <= 4; st++) {          // water sitting on the surface?
      var rp = Rt + st * dx * 0.55;
      var ii = (cx + ldx * rp) / dx | 0, jj = (cy + ldy * rp) / dx | 0, kk = (cz + ldz * rp) / dx | 0;
      if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) break;
      var ct = type[(kk * ny + jj) * nx + ii];
      if (ct === SOLID) continue;
      if (ct === FLUID) wet = true;
      break;                                   // first open cell decides
    }
    if (!wet) dry++;
  }
  return dry / N;
};

// ---------------------------------------------------------- subsurface currents
// A wandering, exactly divergence-free current field (the analytic curl of a
// drifting sum-of-sines vector potential — Bridson curl noise) drives slow
// tangential streams through the ocean interior. The field is resampled on a
// coarse lattice (~4 cells, rebuilt each tick at ~25 Hz) and every deep
// particle relaxes toward the local current; the top band of the shell is
// excluded so the free surface stays glassy while the water beneath streams.
// The streams are tangential only: no radial pumping, so the coated-shell
// hydrostatic rest state stays an exact fixed point.
var _currWaves = null;
function _buildCurrWaves() {
  var seed = 1234567;
  function rnd() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
  var oct = [
    { K: 1.5, amp: 0.10, drift: 0.021 },   // planet-scale gyres  (λ ≈ 4.2 m)
    { K: 4.0, amp: 0.085, drift: 0.05 },   // streams             (λ ≈ 1.6 m)
    { K: 9.0, amp: 0.05, drift: 0.11 }     // whirling detail     (λ ≈ 0.7 m)
  ];
  var waves = [];
  for (var o = 0; o < 3; o++) {
    var set = [];
    for (var cmp = 0; cmp < 3; cmp++) {    // one wave per potential component
      var rx = rnd() * 2 - 1, ry = rnd() * 2 - 1, rz = rnd() * 2 - 1;
      var L = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
      set.push({ kx: rx / L * oct[o].K, ky: ry / L * oct[o].K, kz: rz / L * oct[o].K,
                 A: oct[o].amp / oct[o].K, ph: rnd() * 6.283 });
    }
    set.drift = oct[o].drift;              // each octave wanders at its own rate
    waves.push(set);
  }
  return waves;
}

FluidSolver.prototype._updateCurrents = function (dt) {
  var strength = this.currents;
  var shell = this.oceanR - this.coreR;
  if (!(strength > 0) || !(shell > 0)) return;
  this._ensureCurrentsBuffers();
  this._buildCurrentField();
  this._currentsChunk(0, this.nP, dt);
};

// Coarse lattice buffers of the current field (stride 4 cells, ~0.5 m apart).
FluidSolver.prototype._ensureCurrentsBuffers = function () {
  var stride = 4;
  var gnx = ((this.nx / stride) | 0) + 2, gny = ((this.ny / stride) | 0) + 2;
  var gnz = ((this.nz / stride) | 0) + 2;
  var gN = gnx * gny * gnz;
  if (!this._cfx || this._cfx.length !== gN) {
    this._cfx = this._alloc('_cfx', Float32Array, gN);
    this._cfy = this._alloc('_cfy', Float32Array, gN);
    this._cfz = this._alloc('_cfz', Float32Array, gN);
  }
};

// Build the divergence-free curl-noise field on the coarse lattice (cheap:
// O(gN) trig — runs on the coordinator; workers only sample it).
FluidSolver.prototype._buildCurrentField = function () {
  var strength = this.currents;
  if (!(strength > 0) || !(this.oceanR - this.coreR > 0)) return;
  if (!_currWaves) _currWaves = _buildCurrWaves();
  var stride = 4, sx = this.dx * stride;
  var gnx = ((this.nx / stride) | 0) + 2, gny = ((this.ny / stride) | 0) + 2;
  var gnz = ((this.nz / stride) | 0) + 2;
  var cfx = this._cfx, cfy = this._cfy, cfz = this._cfz;
  var t = this._simTime || 0, waves = _currWaves;
  // the drag stack (bulk drag, bottom friction) eats much of the drive on the
  // eroded terrain — scale the field so streams stay visible at GUI defaults
  var amp = strength * 2;
  var kk, jj, ii, o, wv;
  for (kk = 0; kk < gnz; kk++) {
    var wz2 = kk * sx;
    for (jj = 0; jj < gny; jj++) {
      var wy2 = jj * sx;
      var rowG = (kk * gny + jj) * gnx;
      for (ii = 0; ii < gnx; ii++) {
        var wx2 = ii * sx;
        var ux = 0, uy = 0, uz = 0;
        for (o = 0; o < 3; o++) {
          var wset = waves[o];
          var dph = wset.drift * t;
          wv = wset[0];
          var thx = wv.kx * wx2 + wv.ky * wy2 + wv.kz * wz2 + dph + wv.ph;
          wv = wset[1];
          var thy = wv.kx * wx2 + wv.ky * wy2 + wv.kz * wz2 + dph + wv.ph;
          wv = wset[2];
          var thz = wv.kx * wx2 + wv.ky * wy2 + wv.kz * wz2 + dph + wv.ph;
          // U = curl(psi):  Ux = dPsi_z/dy - dPsi_y/dz, and cyclic
          ux += wset[2].A * wset[2].ky * Math.cos(thz) - wset[1].A * wset[1].kz * Math.cos(thy);
          uy += wset[0].A * wset[0].kz * Math.cos(thx) - wset[2].A * wset[2].kx * Math.cos(thz);
          uz += wset[1].A * wset[1].kx * Math.cos(thy) - wset[0].A * wset[0].ky * Math.cos(thx);
        }
        var gi = rowG + ii;
        cfx[gi] = ux * amp; cfy[gi] = uy * amp; cfz[gi] = uz * amp;
      }
    }
  }
};

// Relax deep particles toward the local (tangential) current — per particle,
// chunkable.
FluidSolver.prototype._currentsChunk = function (p0, p1, dt) {
  var strength = this.currents;
  var shell = this.oceanR - this.coreR;
  if (!(strength > 0) || !(shell > 0)) return;
  var px = this.px, py = this.py, pz = this.pz;
  var pvx = this.pvx, pvy = this.pvy, pvz = this.pvz, fl = this.pflag;
  var ccx = this.cx, ccy = this.cy, ccz = this.cz;
  var oceanR = this.oceanR;
  var cfx = this._cfx, cfy = this._cfy, cfz = this._cfz;
  var relax = 2.2 * dt; if (relax > 0.35) relax = 0.35;
  var dvCap = 0.15;                       // m/s per tick — no sharp yanks
  var stride = 4, invS = 1 / (this.dx * stride);
  var gnx = ((this.nx / stride) | 0) + 2, gny = ((this.ny / stride) | 0) + 2;
  var gxy = gnx * gny;
  for (var p = p0; p < p1; p++) {
    if (fl[p] !== 0) continue;            // spray/vapor stay ballistic
    var rx = px[p] - ccx, ry = py[p] - ccy, rz = pz[p] - ccz;
    var rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1e-9;
    var dpt = (oceanR - rl) / shell;      // 0 at the free surface .. 1 at the core
    var wgt = (dpt - 0.06) * 4.0;         // streams live below the top band
    if (wgt <= 0) continue;
    if (wgt > 1) wgt = 1;
    // trilinear sample of the coarse field
    var qa = px[p] * invS, qb = py[p] * invS, qc = pz[p] * invS;
    var i0 = qa | 0, j0 = qb | 0, k0 = qc | 0;
    if (i0 > gnx - 2) i0 = gnx - 2; else if (i0 < 0) i0 = 0;
    if (j0 > gny - 2) j0 = gny - 2; else if (j0 < 0) j0 = 0;
    if (k0 > ((this.nz / stride) | 0)) k0 = ((this.nz / stride) | 0); else if (k0 < 0) k0 = 0;
    var ta = qa - i0; if (ta > 1) ta = 1; else if (ta < 0) ta = 0;
    var tb = qb - j0; if (tb > 1) tb = 1; else if (tb < 0) tb = 0;
    var tc = qc - k0; if (tc > 1) tc = 1; else if (tc < 0) tc = 0;
    var g000 = (k0 * gny + j0) * gnx + i0;
    var a0 = 1 - ta, a1 = ta, b0 = 1 - tb, b1 = tb, c0 = 1 - tc, c1 = tc;
    var Ux = (cfx[g000] * a0 + cfx[g000 + 1] * a1) * b0 * c0
           + (cfx[g000 + gnx] * a0 + cfx[g000 + gnx + 1] * a1) * b1 * c0
           + (cfx[g000 + gxy] * a0 + cfx[g000 + gxy + 1] * a1) * b0 * c1
           + (cfx[g000 + gxy + gnx] * a0 + cfx[g000 + gxy + gnx + 1] * a1) * b1 * c1;
    var Uy = (cfy[g000] * a0 + cfy[g000 + 1] * a1) * b0 * c0
           + (cfy[g000 + gnx] * a0 + cfy[g000 + gnx + 1] * a1) * b1 * c0
           + (cfy[g000 + gxy] * a0 + cfy[g000 + gxy + 1] * a1) * b0 * c1
           + (cfy[g000 + gxy + gnx] * a0 + cfy[g000 + gxy + gnx + 1] * a1) * b1 * c1;
    var Uz = (cfz[g000] * a0 + cfz[g000 + 1] * a1) * b0 * c0
           + (cfz[g000 + gnx] * a0 + cfz[g000 + gnx + 1] * a1) * b1 * c0
           + (cfz[g000 + gxy] * a0 + cfz[g000 + gxy + 1] * a1) * b0 * c1
           + (cfz[g000 + gxy + gnx] * a0 + cfz[g000 + gxy + gnx + 1] * a1) * b1 * c1;
    // strip the radial part: streams flow ALONG the shell, never across it
    var ir = 1 / rl;
    var Ur = (Ux * rx + Uy * ry + Uz * rz) * ir;
    var Tx = (Ux - rx * ir * Ur) * wgt, Ty = (Uy - ry * ir * Ur) * wgt, Tz = (Uz - rz * ir * Ur) * wgt;
    var vr = (pvx[p] * rx + pvy[p] * ry + pvz[p] * rz) * ir;
    var vx = pvx[p] - rx * ir * vr, vy = pvy[p] - ry * ir * vr, vz = pvz[p] - rz * ir * vr;
    var ex = relax * (Tx - vx), ey = relax * (Ty - vy), ez = relax * (Tz - vz);
    var e2 = ex * ex + ey * ey + ez * ez;
    if (e2 > dvCap * dvCap) { var es = dvCap / Math.sqrt(e2); ex *= es; ey *= es; ez *= es; }
    pvx[p] += ex; pvy[p] += ey; pvz[p] += ez;
  }
};

// ------------------------------------------------------------- surface field
FluidSolver.prototype.splatDensity = function () {
  this.dens.fill(0);
  this._splatInto(0, this.nP, this.dens);
};

// Per-particle kernel splat into `dens` (workers write their own partial
// slab; the coordinator splats directly into the shared field).
FluidSolver.prototype._splatInto = function (p0, p1, dens) {
  var px = this.px, py = this.py, pz = this.pz, fl = this.pflag;
  var nx = this.nx, ny = this.ny, nz = this.nz, dx = this.dx;
  var r = 1.6 * this.spacing, r2 = r * r;
  var sj = nx + 1, sk = (ny + 1) * sj;

  for (var p = p0; p < p1; p++) {
    if (fl[p] !== 0) continue; // droplets/vapor excluded from the main surface
    var gx = px[p] / dx, gy = py[p] / dx, gz = pz[p] / dx;
    var i0 = Math.floor(gx), j0 = Math.floor(gy), k0 = Math.floor(gz);
    var tx = gx - i0, ty = gy - j0, tz = gz - k0;
    i0 = clamp(i0, 0, nx - 1); j0 = clamp(j0, 0, ny - 1); k0 = clamp(k0, 0, nz - 1);
    var fx = px[p] - i0 * dx, fy = py[p] - j0 * dx, fz = pz[p] - k0 * dx;
    for (var kk = 0; kk < 2; kk++) {
      var cz = (kk === 0) ? fz : fz - dx;
      for (var jj = 0; jj < 2; jj++) {
        var cy = (jj === 0) ? fy : fy - dx;
        for (var ii = 0; ii < 2; ii++) {
          var cx = (ii === 0) ? fx : fx - dx;
          var d2 = cx * cx + cy * cy + cz * cz;
          if (d2 >= r2) continue;
          var ww = 1 - d2 / r2;
          ww = ww * ww;
          dens[(k0 + kk) * sk + (j0 + jj) * sj + (i0 + ii)] += ww;
        }
      }
    }
  }
};

// Reduce every worker's density partial over the corner range [f0, f1).
FluidSolver.prototype._splatReduceSlice = function (f0, f1) {
  var ctx = this._mtCtx;
  var dens = this.dens;
  var nW = ctx.nWorkers, stride = ctx.f32Stride, P = ctx.partialF32;
  var base0 = 2 * (ctx.uN + ctx.vN + ctx.wN);   // splat slab offset in each slot
  var i, q, acc;
  for (i = f0; i < f1; i++) {
    acc = 0;
    for (q = 0; q < nW; q++) acc += P[q * stride + base0 + i];
    dens[i] = acc;
  }
};

// Adaptive surface threshold: pick iso so the meshed volume matches the
// actual water volume (binary search using the marching-tetrahedra mesher).
FluidSolver.prototype.autotuneIso = function () {
  if (typeof global.MarchingTetrahedra === 'undefined') return this.iso;
  var Vt = this.nP * this.particleVolume;
  var lo = 0.3, hi = 3.0;
  for (var it = 0; it < 8; it++) {
    var mid = 0.5 * (lo + hi);
    var res = global.MarchingTetrahedra.build(this.dens, this.nx, this.ny, this.nz, this.dx, mid);
    var vol = res.volume, tooBig = res.count > 900000;
    if (tooBig || vol > Vt) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
};

// ---------------------------------------------------------------- interactions
FluidSolver.prototype.applyImpulseSphere = function (cx, cy, cz, R, fx, fy, fz) {
  var px = this.px, py = this.py, pz = this.pz, pvx = this.pvx, pvy = this.pvy, pvz = this.pvz;
  var R2 = R * R;
  for (var p = 0; p < this.nP; p++) {
    var ex = px[p] - cx, ey = py[p] - cy, ez = pz[p] - cz;
    var d2 = ex * ex + ey * ey + ez * ez;
    if (d2 > R2) continue;
    var fall = 1 - Math.sqrt(d2) / R;
    pvx[p] += fx * fall; pvy[p] += fy * fall; pvz[p] += fz * fall;
    if (this.pflag[p] !== 0) this.pflag[p] = 0;
    this.pcool[p] = 0;
  }
};

FluidSolver.prototype.waveImpulse = function (dvx) {
  var px = this.px, py = this.py, pz = this.pz;
  var pvx = this.pvx, pvy = this.pvy, pvz = this.pvz;
  if (this.mode === 'sphere') {
    // tide: raise a bulge on one side by pushing water radially outward,
    // strongest where the surface faces the bulge direction
    var th = Math.random() * Math.PI * 2;
    var ph = Math.acos(2 * Math.random() - 1);
    var dx = Math.sin(ph) * Math.cos(th), dy = Math.cos(ph), dz = Math.sin(ph) * Math.sin(th);
    var cx = this.cx, cy = this.cy, cz = this.cz;
    for (var p = 0; p < this.nP; p++) {
      var ex = px[p] - cx, ey = py[p] - cy, ez = pz[p] - cz;
      var er = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-9;
      var pr = (ex * dx + ey * dy + ez * dz) / er;
      if (pr <= 0) continue;
      var f = pr * pr * pr * (0.7 + Math.random() * 0.3);
      pvx[p] += ex / er * dvx * f;
      pvy[p] += ey / er * dvx * f;
      pvz[p] += ez / er * dvx * f;
    }
    return;
  }
  var half = this.W * 0.4;
  for (var q = 0; q < this.nP; q++) {
    if (px[q] < half) pvx[q] += dvx * (0.7 + Math.random() * 0.3);
  }
};

// "hand" stirring: drag a sphere of water with the cursor
FluidSolver.prototype.stirAt = function (cx, cy, cz, vx, vy, vz, R, dt) {
  var px = this.px, py = this.py, pz = this.pz, pvx = this.pvx, pvy = this.pvy, pvz = this.pvz;
  var R2 = R * R, k = Math.min(1, 14 * dt);
  for (var p = 0; p < this.nP; p++) {
    var ex = px[p] - cx, ey = py[p] - cy, ez = pz[p] - cz;
    var d2 = ex * ex + ey * ey + ez * ez;
    if (d2 > R2) continue;
    var fall = 1 - Math.sqrt(d2) / R;
    pvx[p] += (vx * 1.25 - pvx[p]) * k * fall;
    pvy[p] += (vy * 1.25 - pvy[p]) * k * fall;
    pvz[p] += (vz * 1.25 - pvz[p]) * k * fall;
    this.pflag[p] = 0;
  }
};

FluidSolver.prototype.addBall = function (x, y, z, r, rho) {
  this.balls.push({ x: x, y: y, z: z, vx: 0, vy: 0, vz: 0, r: r, rho: rho, submerged: 0 });
};

FluidSolver.prototype.kineticEnergy = function () {
  var e = 0, mp = 1000 * this.particleVolume; // fluid mass per particle
  for (var p = 0; p < this.nP; p++) {
    var v2 = this.pvx[p] * this.pvx[p] + this.pvy[p] * this.pvy[p] + this.pvz[p] * this.pvz[p];
    e += 0.5 * mp * v2;
  }
  return e;
};

global.FluidSolver = FluidSolver;
if (typeof module !== 'undefined' && module.exports) module.exports = FluidSolver;
})(typeof window !== 'undefined' ? window : globalThis);
