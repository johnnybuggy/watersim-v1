/*
 * WaterSim GPU — WebGPU host for the compute-shader solver (js/gpu/shaders.js).
 *
 * The FluidSolver class stays the single source of truth for world geometry:
 * terrain voxelization, the seeded water fill and every scalar the GUI edits
 * live on the CPU solver object exactly as before. GpuSim takes over ONLY the
 * per-frame dynamics: particle state is uploaded once (and after every
 * resetWater), all substeps run as WebGPU compute passes, and the particle
 * arrays + density field are read back into the same solver typed arrays the
 * scene renderer already consumes — so main.js / scene.js need no knowledge
 * of where the physics ran.
 *
 * Readback budget per frame: ~9 words per particle + the density field
 * (copied by DMA into one staging buffer, mapped once). Counters (vapor /
 * night / evap / airborne / evaporation temperature range) ride a 48-byte
 * staging buffer.
 */
(function (global) {
'use strict';

var SH = (typeof GpuShaders !== 'undefined') ? GpuShaders
  : (typeof require !== 'undefined' ? require('./shaders.js') : null);

var NU = 3;              // uniform buffer ring (substeps within a frame)
var MAX_BALLS = 4;

// logical word offsets — MUST match the O-table contract in shaders.js
var K = {
  pos: 0, vel: 1, adv: 2, T: 3, air: 4, flag: 5, cool: 6, type: 7,
  uF: 8, vF: 9, wF: 10, uO: 12, vO: 13, wO: 14,
  uW: 15, vW: 16, wW: 17,
  validU: 27, validV: 28, validW: 29,
  rhs: 30, diag: 31, q: 32,
  dens: 42, densAcc: 43, hCnt: 44, hSum: 45, headC: 47,
  nextP: 48, cnt: 49, currLatt: 54
};

function GpuSim(device) {
  this.device = device;
  this.ready = false;
}

// ------------------------------------------------------------------ setup
GpuSim.create = async function () {
  if (!navigator.gpu) return null;
  var adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  var device = await adapter.requestDevice();
  return new GpuSim(device);
};

GpuSim.prototype.initFromSolver = async function (s, params) {
  this.ready = false;                 // block steps against half-built buffers
  this._gen = (this._gen || 0) + 1;   // abort in-flight steps from the old world
  this.solver = s;
  this.params = params;
  var nx = s.nx, ny = s.ny, nz = s.nz;
  var CP = s.capacity, NC = s.nCells;
  var uN = s.uN, vN = s.vN, wN = s.wN;
  var DN = (nx + 1) * (ny + 1) * (nz + 1);
  var gnx = ((nx / 4) | 0) + 2, gny = ((ny / 4) | 0) + 2, gnz = ((nz / 4) | 0) + 2;
  var gN = gnx * gny * gnz;
  this.CP = CP; this.NC = NC; this.uN = uN; this.vN = vN; this.wN = wN;
  this.DN = DN; this.gnx = gnx; this.gny = gny; this.gnz = gnz; this.gN = gN;

  // ---- physical layout: BP (particles + cell scalars), BF (face arrays)
  var o = 0;
  function seg(words) { var r = o; o += words; return r; }
  var P = {};
  P.pos = seg(4 * CP); P.vel = seg(4 * CP); P.adv = seg(4 * CP);
  P.T = seg(CP); P.air = seg(CP); P.flag = seg(CP); P.cool = seg(CP);
  P.type = seg(NC);
  P.rhs = seg(NC); P.diag = seg(NC); P.q = seg(NC);
  P.dens = seg(DN); P.densAcc = seg(DN);
  P.hCnt = seg(NC); P.hSum = seg(NC); P.headC = seg(NC);
  P.nextP = seg(CP); P.cnt = seg(8); P.ballProbe = seg(4 * MAX_BALLS);
  P.currLatt = seg(4 * gN);
  var cut = o;                       // BP word count = face-region base
  var F = {};
  F.uF = 0; F.vF = uN; F.wF = uN + vN;
  F.uO = F.wF + wN; F.vO = F.uO + uN; F.wO = F.vO + vN;
  F.uW = F.wO + wN; F.vW = F.uW + uN; F.wW = F.vW + vN;
  F.validU = F.wW + wN; F.validV = F.validU + uN; F.validW = F.validV + vN;
  var faceWords = F.validW + wN;
  this.cut = cut; this.faceWords = faceWords;
  this.P = P; this.F = F;

  // logical → physical map for the O uniform (indexes match shaders.js)
  var logical = new Array(56).fill(0);
  var map = {
    0: P.pos, 1: P.vel, 2: P.adv, 3: P.T, 4: P.air, 5: P.flag, 6: P.cool,
    7: P.type, 8: cut + F.uF, 9: cut + F.vF, 10: cut + F.wF,
    12: cut + F.uO, 13: cut + F.vO, 14: cut + F.wO,
    15: cut + F.uW, 16: cut + F.vW, 17: cut + F.wW,
    18: cut + F.uF, 19: cut + F.vF, 20: cut + F.wF,
    21: cut + F.uW, 22: cut + F.vW, 23: cut + F.wW,
    27: cut + F.validU, 28: cut + F.validV, 29: cut + F.validW,
    30: P.rhs, 31: P.diag, 32: P.q,
    33: P.rhs, 34: P.diag, 35: P.densAcc,          // vcx/vcy/vcz aliases
    36: P.hCnt, 37: P.hSum, 38: P.headC,           // ox/oy/oz aliases
    42: P.dens, 43: P.densAcc,
    44: P.hCnt, 45: P.hSum, 47: P.headC,
    48: P.nextP, 49: P.cnt,
    51: cut + F.uO, 52: cut + F.vO, 53: cut + F.wO, // eaX/eaY/eaZ aliases
    54: P.currLatt
  };
  for (var kk in map) logical[kk] = map[kk];

  // ---- static source buffer S
  if (!s._staticTypes) s._rasterize();   // CPU builds cell types lazily in step(); bake them for the GPU
  var t = s.terrain;
  var tvn = t ? t.n : 1;
  var statOff = 0, voxSOff = NC, voxROff = NC + tvn * tvn * tvn;
  var guOff = voxROff + tvn * tvn * tvn;
  var gvOff = guOff + uN, gwOff = gvOff + vN;
  var wavesOff = gwOff + wN;
  var sWords = wavesOff + 48;
  var sData = new Uint32Array(sWords);
  if (s._staticTypes) sData.set(s._staticTypes, statOff);
  if (t) {
    sData.set(t.solid, voxSOff);
    sData.set(new Uint32Array(t.R.buffer, 0, t.R.length), voxROff);
  }
  if (s._gu) {
    sData.set(new Uint32Array(s._gu.buffer, 0, uN), guOff);
    sData.set(new Uint32Array(s._gv.buffer, 0, vN), gvOff);
    sData.set(new Uint32Array(s._gw.buffer, 0, wN), gwOff);
  }
  // current-field wave constants (3 octaves × 16 words: w0 xyzA, w1, w2, pad, drift)
  var waves = buildWaves();
  sData.set(waves, wavesOff);
  this.sOff = { stat: statOff, voxS: voxSOff, voxR: voxROff, gu: guOff, gv: gvOff, gw: gwOff, waves: wavesOff };

  logical[24] = guOff; logical[25] = gvOff; logical[26] = gwOff;
  logical[39] = statOff; logical[40] = voxSOff; logical[41] = voxROff; logical[50] = wavesOff;

  var oTab = new Uint32Array(64);
  for (var i = 0; i < 56; i++) oTab[i] = logical[i] | 0;

  // ---- GPU buffers
  var d = this.device;
  var STOR = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  this.bp = d.createBuffer({ size: align4(cut * 4), usage: STOR });
  this.bf = d.createBuffer({ size: align4(faceWords * 4), usage: STOR });
  this.src = d.createBuffer({ size: align4(sWords * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  this.ubuf = [];
  for (i = 0; i < NU; i++) this.ubuf.push(d.createBuffer({ size: 496, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  this.oBuf = d.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(this.oBuf, 0, oTab);
  d.queue.writeBuffer(this.src, 0, sData);
  this.uArr = new Float32Array(124);
  this.u32 = new Uint32Array(this.uArr.buffer);
  this.smallStaging = d.createBuffer({ size: 96, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  var rbWords = 11 * CP + DN + 8 + MAX_BALLS * 4;
  this.staging = d.createBuffer({ size: align4(rbWords * 4), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  this.rbView = null;
  this._gRamp = 0;
  this._heatAcc = 0;
  this._simTime = 0;
  this._frame = 0;
  this._evapT = { min: 0, max: 1, span: 0.15 };
  this._impulse = null;
  this.umax = 0;

  this._makePipelines(cut);
  this._makeBindGroups();
  await this.uploadAll();
  this.ready = true;
};

function align4(n) { return (n + 3) & ~3; }

function buildWaves() {
  var seed = 1234567;
  function rnd() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
  var oct = [
    { K: 1.5, amp: 0.10, drift: 0.021 },
    { K: 4.0, amp: 0.085, drift: 0.05 },
    { K: 9.0, amp: 0.05, drift: 0.11 }
  ];
  var out = new Uint32Array(48);
  var f32 = new Float32Array(out.buffer);
  for (var oo = 0; oo < 3; oo++) {
    var base = oo * 16;
    for (var cmp = 0; cmp < 3; cmp++) {
      var rx = rnd() * 2 - 1, ry = rnd() * 2 - 1, rz = rnd() * 2 - 1;
      var L = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
      var w = base + cmp * 4;
      f32[w] = rx / L * oct[oo].K;
      f32[w + 1] = ry / L * oct[oo].K;
      f32[w + 2] = rz / L * oct[oo].K;
      f32[w + 3] = oct[oo].amp / oct[oo].K;
    }
    f32[base + 15] = oct[oo].drift;
  }
  return out;
}

GpuSim.prototype._makePipelines = function (cut) {
  var d = this.device;
  var prelude = SH.PRELUDE.replace('__CUT__u', String(cut) + 'u');
  var code = prelude;
  this._entrySuffix = {};
  var renameRe = /(@compute\s+@workgroup_size\([^)]*\)\s*(?:\n\s*)?)fn\s+(\w+)\s*\(/g;
  for (var part in SH.PARTS) {
    var src = SH.PARTS[part];
    // WGSL is one namespace: suffix every entry point with its part name
    var suffix = '__' + part.replace(/[^A-Za-z0-9]/g, '_');
    this._entrySuffix[part] = suffix;
    src = src.replace(renameRe, function (mm, attr, fnName) { return attr + 'fn ' + fnName + suffix + '('; });
    code += src;
  }
  this.module = d.createShaderModule({ code: code, label: 'watersim-compute' });
  this.bgl = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
    ]
  });
  var pl = d.createPipelineLayout({ bindGroupLayouts: [this.bgl] });
  this.pipes = {};
  var discRe = /@compute @workgroup_size\([^)]*\)\s*(?:\n\s*)?fn\s+(\w+)\s*\(/g, m;
  for (part in SH.PARTS) {
    var src2 = SH.PARTS[part];
    var entrySuffix = this._entrySuffix[part];
    while ((m = discRe.exec(src2))) {
      var entry = m[1];
      var key = part + '/' + entry;
      this.pipes[key] = d.createComputePipeline({
        layout: pl,
        compute: { module: this.module, entryPoint: entry + entrySuffix },
        label: key
      });
    }
  }
};

GpuSim.prototype._makeBindGroups = function () {
  var d = this.device;
  this.bgs = [];
  for (var i = 0; i < NU; i++) {
    this.bgs.push(d.createBindGroup({
      layout: this.bgl,
      entries: [
        { binding: 0, resource: { buffer: this.ubuf[i] } },
        { binding: 1, resource: { buffer: this.oBuf } },
        { binding: 2, resource: { buffer: this.src } },
        { binding: 3, resource: { buffer: this.bp } },
        { binding: 4, resource: { buffer: this.bf } }
      ]
    }));
  }
};

// ------------------------------------------------------------- uniform fill
GpuSim.prototype._fillUniform = function (slot, dt, opts) {
  var s = this.solver, u = this.uArr, u32 = this.u32;
  var p = this.params;
  var dx = s.dx;
  u32[0] = s.nx; u32[1] = s.ny; u32[2] = s.nz; u32[3] = s.nP;
  u32[4] = this.uN; u32[5] = this.vN; u32[6] = this.wN; u32[7] = this.CP;
  u[8] = dx; u[9] = s.W; u[10] = s.H; u[11] = s.D;
  u[12] = s.cx; u[13] = s.cy; u[14] = s.cz; u[15] = dt;
  u[16] = s.gravity; u[17] = s.maxSpeed; u[18] = s.pic; u[19] = s.maxSpeed * 1.1;
  u[20] = s.oceanR; u[21] = s.coreR; u[22] = s.domainR; u[23] = s.atmosphereH;
  u[24] = s.oceanR + s.atmosphereH;                       // skyHi
  u[25] = s.domainR - dx * 0.02;                          // domHi
  u[26] = Math.min(this._gRamp / 1.5, 1) * s.gravity;     // gScale
  u[27] = 0;
  var sun = s.sunPos;
  if (sun) { u[28] = sun[0]; u[29] = sun[1]; u[30] = sun[2]; u[31] = 1; }
  else { u[28] = 1; u[29] = 0; u[30] = 0; u[31] = 0; }
  var wx = 1, wy = 0, wz = 0;
  if (sun) {
    wx = sun[0] - s.cx; wy = sun[1] - s.cy; wz = sun[2] - s.cz;
    var wl = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
    wx /= wl; wy /= wl; wz /= wl;
  }
  u[32] = wx; u[33] = wy; u[34] = wz; u[35] = 1;
  u[36] = s.sunActivity; u[37] = s.sunActivity / 3; u[38] = s.Tamb; u[39] = 0;
  u[40] = s.shadeCool; u[41] = 0.045; u[42] = opts.dtTick || 0; u[43] = opts.alphaCond || 0;
  u[44] = opts.viscCoef || 0; u[45] = s.currents; u[46] = s.spacing; u[47] = s.particleVolume;
  u[48] = this._evapT.min; u[49] = this._evapT.max; u[50] = this._evapT.span; u[51] = s.sunActivity;
  u[52] = s.terrain ? s.terrain.n : 1; u[53] = s.terrain ? s.terrain.dv : 1; u[54] = s.terrain ? s.terrain.Rlo : 0; u[55] = 0;
  u[56] = s.terrain ? s.terrain.Rhi : 0;
  u[57] = s.ceilReflect === 'quadratic' ? 2 : s.ceilReflect === 'exponential' ? 3 : 1;
  u[58] = s.terrain ? 1 : 0; u[59] = s.mode === 'sphere' ? 1 : 0;
  u[60] = this._simTime; u[61] = s.pressureIters; u[62] = s.omega; u[63] = s.dtLast || 0;
  u32[64] = this._frame; u32[65] = Math.min(MAX_BALLS, s.balls.length); u32[66] = opts.impulseMode || 0; u32[67] = 0;
  u[68] = s.waterTopY; u[69] = dx * 1.02; u[70] = s.W - dx * 1.02; u[71] = dx * 1.02;      // poolbox
  u[72] = s.H - dx * 1.02; u[73] = dx * 1.02; u[74] = s.D - dx * 1.02; u[75] = s.vorticity; // poolbox2 (.w = vorticity)
  u32[76] = this.gnx; u32[77] = this.gny; u32[78] = this.gnz; u32[79] = this.gN;           // latdims
  var nb = Math.min(MAX_BALLS, s.balls.length);
  for (var b = 0; b < MAX_BALLS; b++) {
    var src = b < nb ? s.balls[b] : null;
    u[80 + b * 8] = src ? src.x : 0; u[81 + b * 8] = src ? src.y : 0;
    u[82 + b * 8] = src ? src.z : 0; u[83 + b * 8] = src ? src.r : 0;
    u[84 + b * 8] = src ? src.vx : 0; u[85 + b * 8] = src ? src.vy : 0;
    u[86 + b * 8] = src ? src.vz : 0; u[87 + b * 8] = 0;
  }
  var im = this._impulse;
  u[112] = im ? im.cx : 0; u[113] = im ? im.cy : 0; u[114] = im ? im.cz : 0; u[115] = im ? im.R : 0;
  u[116] = im ? im.fx : 0; u[117] = im ? im.fy : 0; u[118] = im ? im.fz : 0; u[119] = im ? im.dt : 0;
  u32[120] = this._frame % 2;               // red-black parity
  u32[121] = (s.sunActivity > 0 && s.mode === 'sphere') ? 1 : 0;  // evapOn
  u32[122] = 0;                             // thermOn (host controls ticks)
  u32[123] = 0;
  this.device.queue.writeBuffer(this.ubuf[slot], 0, this.uArr.buffer, 0, 496);
};

// ---------------------------------------------------------------- dispatch
GpuSim.prototype._run = function (pass, key, gx, gy, gz, slot) {
  var pipe = this.pipes[key];
  if (!pipe) throw new Error('missing pipeline ' + key);
  pass.setPipeline(pipe);
  pass.setBindGroup(0, this.bgs[slot]);
  pass.dispatchWorkgroups(gx, gy || 1, gz || 1);
};
GpuSim.prototype._ceil = function (n, wg) { return Math.max(1, Math.ceil(n / wg)); };
GpuSim.prototype._gridGroups = function () {
  return [this._ceil(this.solver.nx, 4), this._ceil(this.solver.ny, 4), this._ceil(this.solver.nz, 4)];
};

// ------------------------------------------------------------------ stepping
GpuSim.prototype.step = async function (dtFrame) {
  var s = this.solver;
  if (!this.ready || s.nP < 1) return;
  if (this._busy) return;                 // previous readback still pending
  this._busy = true;
  var gen = this._gen || 0;
  try {
    await this._stepInner(dtFrame, gen);
  } finally {
    this._busy = false;
  }
};

GpuSim.prototype._stepInner = async function (dtFrame, gen) {
  var s = this.solver;
  if (!this.ready || s.nP < 1) return;
  this._simTime += dtFrame;
  this._frame++;

  // ---- thermal / evaporation / currents tick (~25 Hz, sphere worlds)
  var dtTick = 0;
  if (s.mode === 'sphere') {
    this._heatAcc += dtFrame;
    if (this._heatAcc >= 1 / 25) {
      dtTick = Math.min(this._heatAcc, 1 / 12);
      this._heatAcc = 0;
    }
  }
  var d = this.device;
  if (dtTick > 0) {
    var alphaCond = Math.min(s.heatK * dtTick * 0.15, 0.14);
    this._fillUniform(0, dtTick, { dtTick: dtTick, alphaCond: alphaCond });
    var gg = this._gridGroups();
    var enc = d.createCommandEncoder();
    var pass = enc.beginComputePass();
    this._run(pass, 'thermal/clear', gg[0], gg[1], gg[2], 0);
    this._run(pass, 'thermal/bin', this._ceil(s.nP, 64), 1, 1, 0);
    this._run(pass, 'thermal/solar', this._ceil(s.nP, 64), 1, 1, 0);
    this._run(pass, 'thermal/edges', gg[0], gg[1], gg[2], 0);
    this._run(pass, 'thermal/apply', this._ceil(s.nP, 64), 1, 1, 0);
    if (s.currents > 0) {
      this._run(pass, 'currents/build', this._ceil(this.gnx, 4), this._ceil(this.gny, 4), this._ceil(this.gnz, 4), 0);
      this._run(pass, 'currents/relax', this._ceil(s.nP, 64), 1, 1, 0);
    }
    if (s.sunActivity > 0) {
      // reset the min/max accumulators, then reduce the live water range
      var init = new Uint32Array(2);
      init[0] = 0xFFFFFFFF; init[1] = 0;
      d.queue.writeBuffer(this.bp, (this.P.cnt + 4) * 4, init);
      this._run(pass, 'counters/evapRange', this._ceil(s.nP, 64), 1, 1, 0);
    }
    pass.end();
    d.queue.submit([enc.finish()]);
    await d.queue.onSubmittedWorkDone();
    await this._readSmall();
    // evaporation runs after the tick's temperature range is known
    if (s.sunActivity > 0) {
      this._fillUniform(0, dtTick, { dtTick: dtTick, alphaCond: alphaCond });
      var encE = d.createCommandEncoder();
      var passE = encE.beginComputePass();
      this._run(passE, 'evaporate/main', this._ceil(s.nP, 64), 1, 1, 0);
      passE.end();
      d.queue.submit([encE.finish()]);
    }
  }

  // ---- queued impulse (splash / stir / wave), once per frame
  var impulseMode = 0;
  if (this._impulse) {
    impulseMode = this._impulse.mode;
    this._fillUniform(0, dtTick || dtFrame, { impulseMode: impulseMode });
    var encI = d.createCommandEncoder();
    var passI = encI.beginComputePass();
    this._run(passI, 'impulse/main', this._ceil(s.nP, 64), 1, 1, 0);
    passI.end();
    d.queue.submit([encI.finish()]);
    this._impulse = null;
  }

  // ---- substeps (CFL-adaptive, same law as the CPU solver)
  var remaining = dtFrame, guard = 0, nSub = 0;
  var base = dtFrame / Math.max(1, s.substeps);
  var gScale0 = this._gRamp;
  while (remaining > 1e-6 && guard < 8) {
    var dt = Math.min(base, (s.cfl * s.dx) / Math.max(this.umax, 0.08), 1 / 100);
    if (dt < 1e-5) dt = 1e-5;
    var slot = guard % NU;
    var viscCoef = Math.min(s.viscosity * dt / (s.dx * s.dx), 0.24);
    this._fillUniform(slot, dt, { viscCoef: viscCoef });
    var gg2 = this._gridGroups();
    var cp = this._ceil(s.nP, 64);
    var e2 = d.createCommandEncoder();
    var p2 = e2.beginComputePass();
    this._run(p2, 'counters/clear', 1, 1, 1, slot);
    this._run(p2, 'clearRaster/main', gg2[0], gg2[1], gg2[2], slot);
    this._run(p2, 'clearRaster/zeroAcc', this._ceil(Math.max(this.uN, this.vN, this.wN), 64), 1, 1, slot);
    this._run(p2, 'markFluid/main', cp, 1, 1, slot);
    this._run(p2, 'pushBalls/main', cp, 1, 1, slot);
    this._run(p2, 'p2g/main', cp, 1, 1, slot);
    this._run(p2, 'p2gNorm/mainU', this._ceil(this.uN, 64), 1, 1, slot);
    this._run(p2, 'p2gNorm/mainV', this._ceil(this.vN, 64), 1, 1, slot);
    this._run(p2, 'p2gNorm/mainW', this._ceil(this.wN, 64), 1, 1, slot);
    this._run(p2, 'bcFaces/mainU', this._ceil(this.uN, 64), 1, 1, slot);
    this._run(p2, 'bcFaces/mainV', this._ceil(this.vN, 64), 1, 1, slot);
    this._run(p2, 'bcFaces/mainW', this._ceil(this.wN, 64), 1, 1, slot);
    this._run(p2, 'copyOld/mainU', this._ceil(this.uN, 64), 1, 1, slot);
    this._run(p2, 'copyOld/mainV', this._ceil(this.vN, 64), 1, 1, slot);
    this._run(p2, 'copyOld/mainW', this._ceil(this.wN, 64), 1, 1, slot);
    if (viscCoef > 0) {
      this._run(p2, 'viscosity/mainU', this._ceil(this.uN, 64), 1, 1, slot);
      this._run(p2, 'viscosity/mainV', this._ceil(this.vN, 64), 1, 1, slot);
      this._run(p2, 'viscosity/mainW', this._ceil(this.wN, 64), 1, 1, slot);
    }
    if (s.mode === 'sphere') {
      this._run(p2, 'gravity/mainU', this._ceil(this.uN, 64), 1, 1, slot);
      this._run(p2, 'gravity/mainV', this._ceil(this.vN, 64), 1, 1, slot);
      this._run(p2, 'gravity/mainW', this._ceil(this.wN, 64), 1, 1, slot);
    } else {
      this._run(p2, 'gravity/mainPoolV', this._ceil(this.vN, 64), 1, 1, slot);
    }
    this._run(p2, 'bcFaces/mainU', this._ceil(this.uN, 64), 1, 1, slot);
    this._run(p2, 'bcFaces/mainV', this._ceil(this.vN, 64), 1, 1, slot);
    this._run(p2, 'bcFaces/mainW', this._ceil(this.wN, 64), 1, 1, slot);
    this._run(p2, 'pressureRhs/main', gg2[0], gg2[1], gg2[2], slot);
    for (var it = 0; it < s.pressureIters; it++) {
      this._run(p2, 'pressureRhs/rb', gg2[0], gg2[1], gg2[2], slot);
    }
    this._run(p2, 'project/mainU', this._ceil(this.uN, 64), 1, 1, slot);
    this._run(p2, 'project/mainV', this._ceil(this.vN, 64), 1, 1, slot);
    this._run(p2, 'project/mainW', this._ceil(this.wN, 64), 1, 1, slot);
    if (s.vorticity > 0) {
      this._run(p2, 'vorticity/velAndOmega', gg2[0], gg2[1], gg2[2], slot);
      this._run(p2, 'vorticity/force', gg2[0], gg2[1], gg2[2], slot);
      this._run(p2, 'vorticity/splat', gg2[0], gg2[1], gg2[2], slot);
    }
    this._run(p2, 'clampGrid/mainU', this._ceil(this.uN, 64), 1, 1, slot);
    this._run(p2, 'clampGrid/mainV', this._ceil(this.vN, 64), 1, 1, slot);
    this._run(p2, 'clampGrid/mainW', this._ceil(this.wN, 64), 1, 1, slot);
    this._run(p2, 'extrapolate/markU', this._ceil(this.uN, 64), 1, 1, slot);
    this._run(p2, 'extrapolate/markV', this._ceil(this.vN, 64), 1, 1, slot);
    this._run(p2, 'extrapolate/markW', this._ceil(this.wN, 64), 1, 1, slot);
    this._run(p2, 'extrapolate/avgU', this._ceil(this.uN, 64), 1, 1, slot);
    this._run(p2, 'extrapolate/avgV', this._ceil(this.vN, 64), 1, 1, slot);
    this._run(p2, 'extrapolate/avgW', this._ceil(this.wN, 64), 1, 1, slot);
    this._run(p2, 'g2p/main', cp, 1, 1, slot);
    this._run(p2, 'advect/main', cp, 1, 1, slot);
    this._run(p2, 'pushBalls/main', cp, 1, 1, slot);
    p2.end();
    d.queue.submit([e2.finish()]);
    remaining -= dt;
    guard++; nSub++;
    this._dtLast = dt;
    this._gRamp += dt;
  }
  s.substepsLast = nSub;
  s.dtLast = this._dtLast || 0;

  // ---- frame-end: vapor collisions, rescue, density field
  this._fillUniform(0, this._dtLast || dtFrame, {});
  var gg3 = this._gridGroups();
  var cp3 = this._ceil(s.nP, 64);
  var e3 = d.createCommandEncoder();
  var p3 = e3.beginComputePass();
  this._run(p3, 'vaporCollide/clearHeads', gg3[0], gg3[1], gg3[2], 0);
  this._run(p3, 'vaporCollide/build', cp3, 1, 1, 0);
  this._run(p3, 'vaporCollide/solve', cp3, 1, 1, 0);
  this._run(p3, 'pushSurface/main', cp3, 1, 1, 0);
  this._run(p3, 'splatDens/clear', this._ceil(s.nx + 1, 4), this._ceil(s.ny + 1, 4), this._ceil(s.nz + 1, 4), 0);
  this._run(p3, 'splatDens/splat', cp3, 1, 1, 0);
  this._run(p3, 'splatDens/norm', this._ceil(this.DN, 64), 1, 1, 0);
  // ball fluid-velocity probes for the CPU ball integrator
  var nb = Math.min(MAX_BALLS, s.balls.length);
  if (nb > 0) {
    var pipeProbe = this.pipes['ballProbe/probe'];
    if (pipeProbe) {
      p3.setPipeline(pipeProbe);
      p3.setBindGroup(0, this.bgs[0]);
      p3.dispatchWorkgroups(1, 1, 1);
    }
  }
  p3.end();
  d.queue.submit([e3.finish()]);

  if ((this._gen || 0) !== gen || this.solver !== s) return;  // world swapped mid-step
  await this._readBack();

  // CPU ball integration (few balls; histogram over the fresh readback)
  if (s.balls.length > 0) {
    if (this._ballVelF) {
      var self = this;
      s.sampleVel = function (x, y, z, out) {
        var b = Math.min(self._ballIdx, MAX_BALLS - 1);
        self._ballIdx++;
        out[0] = self._ballVelF[b * 4]; out[1] = self._ballVelF[b * 4 + 1]; out[2] = self._ballVelF[b * 4 + 2];
        return out;
      };
      this._ballIdx = 0;
    }
    try { s._updateBalls(dtFrame); }
    finally { delete s.sampleVel; }
  }
};

GpuSim.prototype._readSmall = async function () {
  var d = this.device;
  if (this._smallMapped) return;          // a small readback is already in flight
  var e = d.createCommandEncoder();
  e.copyBufferToBuffer(this.bp, this.P.cnt * 4, this.smallStaging, 0, 32);
  d.queue.submit([e.finish()]);
  this._smallMapped = true;
  var v;
  try {
    await d.queue.onSubmittedWorkDone();   // copies must land before mapping
    await this.smallStaging.mapAsync(GPUMapMode.READ);
    v = new Uint32Array(this.smallStaging.getMappedRange().slice(0));
  } finally {
    try { this.smallStaging.unmap(); } catch (err) {}
    this._smallMapped = false;
  }
  var s = this.solver;
  this._lastCounts = v;
  this._evapT.min = v[4] / 65536;
  this._evapT.max = v[5] / 65536;
  var span = this._evapT.max - this._evapT.min;
  this._evapT.span = span < 0.15 ? 0.15 : span;
  s.vaporCount = v[0]; s.nightVaporCount = v[1]; s.evapCount = v[2];
};

// fresh water fill: re-upload particle state, restart gravity ramp
GpuSim.prototype.reset = async function () {
  this._gRamp = 0;
  this._heatAcc = 0;
  this._evapT = { min: 0, max: 1, span: 0.15 };
  this.umax = 0;
  await this.uploadAll();
};

// DMA the particle state + density field back into the solver arrays.
// Staging layout (words): pos 0..4CP, vel 4CP..8CP, T 8CP..9CP, flag 9CP..10CP,
// cool 10CP..11CP, dens 11CP..11CP+DN.
GpuSim.prototype._readBack = async function () {
  var d = this.device, s = this.solver, P = this.P, CP = this.CP, DN = this.DN;
  var e = d.createCommandEncoder();
  e.copyBufferToBuffer(this.bp, P.pos * 4, this.staging, 0, CP * 16);
  e.copyBufferToBuffer(this.bp, P.vel * 4, this.staging, CP * 16, CP * 16);
  e.copyBufferToBuffer(this.bp, P.T * 4, this.staging, CP * 32, CP * 4);
  e.copyBufferToBuffer(this.bp, P.flag * 4, this.staging, CP * 36, CP * 4);
  e.copyBufferToBuffer(this.bp, P.cool * 4, this.staging, CP * 40, CP * 4);
  e.copyBufferToBuffer(this.bp, P.dens * 4, this.staging, CP * 44, DN * 4);
  e.copyBufferToBuffer(this.bp, P.cnt * 4, this.staging, CP * 44 + DN * 4, 32);
  e.copyBufferToBuffer(this.bp, P.ballProbe * 4, this.staging, CP * 44 + DN * 4 + 32, MAX_BALLS * 16);
  d.queue.submit([e.finish()]);
  this._bigMapped = true;
  try {
    await d.queue.onSubmittedWorkDone();   // copies must land before mapping
    await this.staging.mapAsync(GPUMapMode.READ);
    var bigRaw = this.staging.getMappedRange();
    var bigCopy = bigRaw.slice(0);
    var bigF = new Float32Array(bigCopy);
    var bigU = new Uint32Array(bigCopy);
  } finally {
    try { this.staging.unmap(); } catch (err) {}
    this._bigMapped = false;
  }
  var small = bigU.subarray(CP * 11 + DN);

  var nP = s.nP, i, o;
  var px = s.px, py = s.py, pz = s.pz;
  var pvx = s.pvx, pvy = s.pvy, pvz = s.pvz;
  var fl = s.pflag, pcool = s.pcool, pT = s.pT;
  var um = 0;
  for (i = 0; i < nP; i++) {
    o = i * 4;
    px[i] = bigF[o]; py[i] = bigF[o + 1]; pz[i] = bigF[o + 2];
    var o2 = CP * 4 + o;
    pvx[i] = bigF[o2]; pvy[i] = bigF[o2 + 1]; pvz[i] = bigF[o2 + 2];
    var sp = pvx[i] * pvx[i] + pvy[i] * pvy[i] + pvz[i] * pvz[i];
    if (sp > um) um = sp;
    pT[i] = bigF[CP * 8 + i];
    fl[i] = bigU[CP * 9 + i];
    pcool[i] = bigU[CP * 10 + i];
  }
  this.umax = Math.sqrt(um);
  s.umax = this.umax;
  s.airborneCount = small[3];
  s.vaporCount = small[0]; s.nightVaporCount = small[1]; s.evapCount = small[2];
  this._evapT.min = small[4] / 65536;
  this._evapT.max = small[5] / 65536;
  var span = this._evapT.max - this._evapT.min;
  this._evapT.span = span < 0.15 ? 0.15 : span;
  this._ballVel = small.slice(8, 8 + MAX_BALLS * 4);
  this._ballVelF = new Float32Array(this._ballVel.buffer);
  var dens = s.dens;
  var densOff = CP * 11;
  for (i = 0; i < DN; i++) dens[i] = bigF[densOff + i];
};

// --------------------------------------------------------------- state I/O
GpuSim.prototype.uploadAll = async function () {
  var d = this.device, s = this.solver, P = this.P, CP = this.CP;
  var pack4 = function (ax, ay, az) {
    var out = new Float32Array(CP * 4);
    for (var i = 0; i < CP; i++) {
      out[i * 4] = ax[i]; out[i * 4 + 1] = ay[i]; out[i * 4 + 2] = az[i]; out[i * 4 + 3] = 0;
    }
    return out;
  };
  d.queue.writeBuffer(this.bp, P.pos * 4, pack4(s.px, s.py, s.pz));
  d.queue.writeBuffer(this.bp, P.vel * 4, pack4(s.pvx, s.pvy, s.pvz));
  d.queue.writeBuffer(this.bp, P.T * 4, s.pT, 0, CP);
  d.queue.writeBuffer(this.bp, P.air * 4, s.pAir, 0, CP);
  var flag32 = new Uint32Array(CP), cool32 = new Uint32Array(CP);
  for (var i = 0; i < CP; i++) { flag32[i] = s.pflag[i]; cool32[i] = s.pcool[i]; }
  d.queue.writeBuffer(this.bp, P.flag * 4, flag32);
  d.queue.writeBuffer(this.bp, P.cool * 4, cool32);
  d.queue.writeBuffer(this.bp, P.dens * 4, s.dens);
  var zeros = new Float32Array(Math.max(CP * 4, this.NC));
  d.queue.writeBuffer(this.bp, P.adv * 4, zeros, 0, CP * 4);
  d.queue.writeBuffer(this.bp, P.q * 4, zeros, 0, this.NC);
  d.queue.writeBuffer(this.bp, P.nextP * 4, zeros, 0, CP);
  d.queue.writeBuffer(this.bp, P.cnt * 4, new Uint32Array(8));
  await d.queue.onSubmittedWorkDone();
};

GpuSim.prototype.queueImpulse = function (mode, cx, cy, cz, R, fx, fy, fz, dt) {
  this._impulse = { mode: mode, cx: cx, cy: cy, cz: cz, R: R, fx: fx, fy: fy, fz: fz, dt: dt };
};

GpuSim.prototype.destroy = function () {
  var self = this;
  ['bp', 'bf', 'src', 'oBuf', 'staging', 'smallStaging'].forEach(function (k) {
    if (self[k]) { try { self[k].destroy(); } catch (e) {} }
  });
  this.ubuf.forEach(function (b) { try { b.destroy(); } catch (e) {} });
  this.ready = false;
};

global.GpuSim = GpuSim;
if (typeof module !== 'undefined' && module.exports) module.exports = GpuSim;
})(typeof window !== 'undefined' ? window : globalThis);
