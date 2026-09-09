/*
 * WaterSim GPU — WGSL compute shaders for the particle/fluid solver.
 * A faithful GPU port of js/solver.js (MAC FLIP): rasterize, P2G, BC, gravity,
 * red-black SOR pressure, projection, vorticity confinement, extrapolation,
 * G2P, advection (fluid / spray / vapor), thermal conduction, evaporation,
 * currents, vapor collisions, embedded rescue, impulses and density splat.
 *
 * Determinism notes (documented divergence from the CPU solver):
 *  - PRNG streams are per-particle (PCG32 hash of particle index + frame), so
 *    results are order-independent; runs on the same GPU are reproducible.
 *  - Pressure uses red-black SOR (same omega / iteration count), not the CPU
 *    sequential SOR; viscosity and extrapolation run Jacobi instead of the
 *    CPU's in-place Gauss-Seidel ordering.
 *  - P2G / density / thermal sums accumulate in u32 fixed point (scale 2^-16).
 *
 * Memory map: ALL mutable state lives in one atomic<u32> storage buffer `B`
 * (f32 via bitcast); static data in `S`; parameters in the `U` struct; buffer
 * word offsets in the `O` table (uniform, index k -> O[k/4][k%4]).
 *
 * O table (fixed contract with gpusim.js):
 *   0 pos  1 vel  2 adv  3 T   4 air  5 flag 6 cool 7 type
 *   8 uF   9 vF  10 wF  11 sv  12 uO  13 vO  14 wO
 *  15 uW  16 vW  17 wW  18 uAcc 19 vAcc 20 wAcc 21 uAccW 22 vAccW 23 wAccW
 *  24 gu* 25 gv* 26 gw* 27 validU 28 validV 29 validW
 *  30 rhs 31 diag 32 q  33 vcx 34 vcy 35 vcz 36 ox 37 oy 38 oz
 *  39 stat* 40 voxS* 41 voxR* 42 dens 43 densAcc
 *  44 hCnt 45 hSum 47 headC 48 nextP 49 cnt 50 curr* (SRC waves base)
 *  51 eaX 52 eaY 53 eaZ (B) 54 currLatt (B) 55 unused
 *            (* = offset into S, the rest into B)
 */
(function (global) {
'use strict';

var PRELUDE = `
struct SimU {
  dims    : vec4<u32>,   // nx, ny, nz, nP
  counts  : vec4<u32>,   // uN, vN, wN, CP
  sizes   : vec4<f32>,   // dx, W, H, D
  center  : vec4<f32>,   // cx, cy, cz, dt
  forces  : vec4<f32>,   // gravity, maxSpeed, pic, vcap
  world   : vec4<f32>,   // oceanR, coreR, domainR, atmosphereH
  limits  : vec4<f32>,   // skyHi, domHi, gScale, gRamp
  sun     : vec4<f32>,   // sunPos xyz, on
  wind    : vec4<f32>,   // windS xyz, len
  thermal : vec4<f32>,   // sunActivity, sunPow, Tamb, heatK
  thermal2: vec4<f32>,   // shadeCool, dissip, dtTick, alphaCond
  misc    : vec4<f32>,   // viscCoef, currents, spacing, pVol
  evap    : vec4<f32>,   // Tmin, Tmax, span, rate
  terrain : vec4<f32>,   // tvn, tvd, Rsl, Rlo
  terrain2: vec4<f32>,   // Rhi, ceilMode, hasTerr, isSphere
  times   : vec4<f32>,   // simTime, iters, omega, dtLast
  misc2   : vec4<u32>,   // frame, nBalls, impulseMode, viscOn
  poolbox : vec4<f32>,   // waterTopY, xLo, xHi, yLo
  poolbox2: vec4<f32>,   // yHi, zLo, zHi, pad
  latdims : vec4<u32>,   // gnx, gny, gnz, gN
  balls   : array<vec4<f32>, 8>, // [x,y,z,r] [vx,vy,vz,0] * 4
  impulse : vec4<f32>,   // cx, cy, cz, R
  impulse2: vec4<f32>,   // fx, fy, fz, dt
  parity  : vec4<u32>,   // parity, evapOn, thermOn, guard
};
@group(0) @binding(0) var<uniform> U: SimU;
@group(0) @binding(1) var<uniform> O: array<vec4<u32>, 16>;
@group(0) @binding(2) var<storage, read> S: array<u32>;
// two storage slabs: BP (particles + cell scalars, logical words < CUT)
// and BF (MAC face arrays, logical words >= CUT). Host injects CUT.
@group(0) @binding(3) var<storage, read_write> BP: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> BF: array<atomic<u32>>;
const CUT = __CUT__u;

fn ldF(o: u32) -> f32 {
  if (o < CUT) { return bitcast<f32>(atomicLoad(&BP[o])); }
  return bitcast<f32>(atomicLoad(&BF[o - CUT]));
}
fn stF(o: u32, v: f32) {
  if (o < CUT) { atomicStore(&BP[o], bitcast<u32>(v)); } else { atomicStore(&BF[o - CUT], bitcast<u32>(v)); }
}
fn ldU(o: u32) -> u32 {
  if (o < CUT) { return atomicLoad(&BP[o]); }
  return atomicLoad(&BF[o - CUT]);
}
fn stU(o: u32, v: u32) {
  if (o < CUT) { atomicStore(&BP[o], v); } else { atomicStore(&BF[o - CUT], v); }
}
fn adU(o: u32, v: u32) -> u32 {
  if (o < CUT) { return atomicAdd(&BP[o], v); }
  return atomicAdd(&BF[o - CUT], v);
}
fn subU(o: u32, v: u32) {
  if (o < CUT) { atomicSub(&BP[o], v); } else { atomicSub(&BF[o - CUT], v); }
}
fn orU(o: u32, v: u32) {
  if (o < CUT) { atomicOr(&BP[o], v); } else { atomicOr(&BF[o - CUT], v); }
}
fn xchU(o: u32, v: u32) -> u32 {
  if (o < CUT) { return atomicExchange(&BP[o], v); }
  return atomicExchange(&BF[o - CUT], v);
}
fn off(k: u32) -> u32 { return O[k / 4u][k % 4u]; }
fn ldSrcF(o: u32) -> f32 { return bitcast<f32>(S[o]); }

fn pPos(p: u32) -> vec3<f32> { let o = off(0u) + p * 4u; return vec3<f32>(ldF(o), ldF(o + 1u), ldF(o + 2u)); }
fn pPosW(p: u32, v: vec3<f32>) { let o = off(0u) + p * 4u; stF(o, v.x); stF(o + 1u, v.y); stF(o + 2u, v.z); }
fn pVel(p: u32) -> vec3<f32> { let o = off(1u) + p * 4u; return vec3<f32>(ldF(o), ldF(o + 1u), ldF(o + 2u)); }
fn pVelW(p: u32, v: vec3<f32>) { let o = off(1u) + p * 4u; stF(o, v.x); stF(o + 1u, v.y); stF(o + 2u, v.z); }
fn advLd(p: u32) -> vec3<f32> { let o = off(2u) + p * 4u; return vec3<f32>(ldF(o), ldF(o + 1u), ldF(o + 2u)); }
fn advW(p: u32, v: vec3<f32>) { let o = off(2u) + p * 4u; stF(o, v.x); stF(o + 1u, v.y); stF(o + 2u, v.z); }
fn pT(p: u32) -> f32 { return ldF(off(3u) + p); }
fn pTW(p: u32, v: f32) { stF(off(3u) + p, v); }
fn pAir(p: u32) -> f32 { return ldF(off(4u) + p); }
fn pAirW(p: u32, v: f32) { stF(off(4u) + p, v); }
fn pFlag(p: u32) -> u32 { return ldU(off(5u) + p); }
fn pFlagW(p: u32, v: u32) { stU(off(5u) + p, v); }
fn pCool(p: u32) -> u32 { return ldU(off(6u) + p); }
fn pCoolW(p: u32, v: u32) { stU(off(6u) + p, v); }

fn nxC() -> i32 { return i32(U.dims.x); }
fn nyC() -> i32 { return i32(U.dims.y); }
fn nzC() -> i32 { return i32(U.dims.z); }
fn dxC() -> f32 { return U.sizes.x; }
fn typeAt(c: u32) -> u32 { return ldU(off(7u) + c); }
fn cIdx(i: i32, j: i32, k: i32) -> u32 { return u32((k * nyC() + j) * nxC() + i); }

// PCG32-ish hash PRNG (per-particle; order independent)
fn pcg(st: ptr<function, u32>) -> u32 {
  *st = *st * 747796405u + 2891336453u;
  var w = ((*st >> ((*st >> 28u) + 4u)) ^ *st) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd01(st: ptr<function, u32>) -> f32 { return f32(pcg(st)) * 2.3283064365e-10; }
fn prngSeed(p: u32) -> u32 {
  var h = p * 747796405u + 2891336453u + U.misc2.x * 0x9e3779b9u;
  h = (h ^ (h >> 16u)) * 0x85ebca6bu;
  h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
  return h ^ (h >> 16u);
}

// ---- terrain --------------------------------------------------------------
fn voxSolidAt(x: f32, y: f32, z: f32) -> bool {
  let n = i32(U.terrain.x);
  let dv = U.terrain.y;
  let i = clamp(i32(x / dv), 0, n - 1);
  let j = clamp(i32(y / dv), 0, n - 1);
  let k = clamp(i32(z / dv), 0, n - 1);
  return S[off(40u) + u32((k * n + j) * n + i)] == 1u;
}
fn terrainR(x: f32, y: f32, z: f32) -> f32 {
  let n = i32(U.terrain.x);
  let dv = U.terrain.y;
  let gx = x / dv - 0.5;
  let gy = y / dv - 0.5;
  let gz = z / dv - 0.5;
  let i = clamp(i32(gx), 0, n - 2);
  let j = clamp(i32(gy), 0, n - 2);
  let k = clamp(i32(gz), 0, n - 2);
  let fx = clamp(gx - f32(i), 0.0, 1.0);
  let fy = clamp(gy - f32(j), 0.0, 1.0);
  let fz = clamp(gz - f32(k), 0.0, 1.0);
  let b0 = off(41u) + u32((k * n + j) * n + i);
  let nn = u32(n);
  let s7 = nn * nn;
  let r0 = ldSrcF(b0);              let r1 = ldSrcF(b0 + 1u);
  let r2 = ldSrcF(b0 + nn);         let r3 = ldSrcF(b0 + nn + 1u);
  let r4 = ldSrcF(b0 + s7);         let r5 = ldSrcF(b0 + s7 + 1u);
  let r6 = ldSrcF(b0 + s7 + nn);    let r7 = ldSrcF(b0 + s7 + nn + 1u);
  let a0 = r0 + (r1 - r0) * fx;
  let a1 = r2 + (r3 - r2) * fx;
  let a2 = r4 + (r5 - r4) * fx;
  let a3 = r6 + (r7 - r6) * fx;
  let b0v = a0 + (a1 - a0) * fy;
  let b1v = a2 + (a3 - a2) * fy;
  return b0v + (b1v - b0v) * fz;
}
fn rockCellAt(x: f32, y: f32, z: f32) -> bool {
  let dx = dxC();
  let ci = clamp(i32(x / dx), 1, nxC() - 2);
  let cj = clamp(i32(y / dx), 1, nyC() - 2);
  let ck = clamp(i32(z / dx), 1, nzC() - 2);
  let tvn = i32(U.terrain.x);
  let tvd = U.terrain.y;
  let vx = clamp(i32((f32(ci) + 0.5) * dx / tvd), 0, tvn - 1);
  let vy = clamp(i32((f32(cj) + 0.5) * dx / tvd), 0, tvn - 1);
  let vz = clamp(i32((f32(ck) + 0.5) * dx / tvd), 0, tvn - 1);
  return S[off(40u) + u32((vz * tvn + vy) * tvn + vx)] == 1u;
}
fn onRockBelow(x: f32, y: f32, z: f32) -> bool {
  if (U.terrain2.w < 0.5 || U.terrain2.z < 0.5) { return false; }
  let e = vec3<f32>(x, y, z) - U.center.xyz;
  let el = max(length(e), 1e-9);
  let s = dxC() * 0.9 / el;
  let q = vec3<f32>(x, y, z) - e * s;
  return rockCellAt(q.x, q.y, q.z);
}

// ---- MAC face sampling (exact port of solver._sampleVel3) ------------------
fn sampleFace(o: u32, comp: u32, x: f32, y: f32, z: f32) -> f32 {
  let dx = dxC();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  var a: f32; var b: f32; var c: f32;
  if (comp == 0u) { a = x / dx; b = y / dx - 0.5; c = z / dx - 0.5; }
  else if (comp == 1u) { a = x / dx - 0.5; b = y / dx; c = z / dx - 0.5; }
  else { a = x / dx - 0.5; b = y / dx - 0.5; c = z / dx; }
  var i0 = i32(floor(a)); var j0 = i32(floor(b)); var k0 = i32(floor(c));
  var tx: f32; var ty: f32; var tz: f32;
  if (i0 < 0) { i0 = 0; tx = 0.0; } else if (i0 > nx - 1) { i0 = nx - 1; tx = 1.0; } else { tx = a - f32(i0); }
  if (j0 < 0) { j0 = 0; ty = 0.0; } else if (j0 > ny - 2) { j0 = ny - 2; ty = 1.0; } else { ty = b - f32(j0); }
  if (k0 < 0) { k0 = 0; tz = 0.0; } else if (k0 > nz - 2) { k0 = nz - 2; tz = 1.0; } else { tz = c - f32(k0); }
  let s0 = 1.0 - tx; let s1 = tx; let t0 = 1.0 - ty; let t1 = ty; let r0 = 1.0 - tz; let r1 = tz;
  var sj = nx + 1; var sk = ny * sj; var d0 = ny;
  if (comp == 1u) { sj = nx; sk = (ny + 1) * nx; d0 = ny + 1; }
  else if (comp == 2u) { sj = nx; sk = ny * nx; d0 = ny; }
  let idx = u32((k0 * d0 + j0) * sj + i0);
  let v0 = ldF(o + idx);     let v1 = ldF(o + idx + 1u);
  let v2 = ldF(o + idx + u32(sj));  let v3 = ldF(o + idx + u32(sj) + 1u);
  let v4 = ldF(o + idx + u32(sk));  let v5 = ldF(o + idx + u32(sk) + 1u);
  let v6 = ldF(o + idx + u32(sk) + u32(sj)); let v7 = ldF(o + idx + u32(sk) + u32(sj) + 1u);
  return ((v0 * s0 + v1 * s1) * t0 + (v2 * s0 + v3 * s1) * t1) * r0
       + ((v4 * s0 + v5 * s1) * t0 + (v6 * s0 + v7 * s1) * t1) * r1;
}
fn sampleVel3(x: f32, y: f32, z: f32) -> vec3<f32> {
  return vec3<f32>(sampleFace(off(8u), 0u, x, y, z),
                   sampleFace(off(9u), 1u, x, y, z),
                   sampleFace(off(10u), 2u, x, y, z));
}
fn touch() { if (U.parity.w == 424242u) { stU(0u, S[0u]); } }
`;

var SHADERS = {

// =========================================================== rasterize base
clearRaster: `
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  if (i32(gid.x) >= nx || i32(gid.y) >= ny || i32(gid.z) >= nz) { return; }
  let i = i32(gid.x); let j = i32(gid.y); let k = i32(gid.z);
  let c = cIdx(i, j, k);
  var t = S[off(39u) + c];   // stat lives in the S buffer, not BP/BF
  var sv = vec3<f32>(0.0);
  let dx = dxC();
  for (var bi = 0u; bi < U.misc2.y; bi++) {
    let bp = U.balls[bi * 2u].xyz;
    let br = U.balls[bi * 2u].w;
    let bv = U.balls[bi * 2u + 1u].xyz;
    let d = vec3<f32>(f32(i) + 0.5, f32(j) + 0.5, f32(k) + 0.5) * dx - bp;
    if (dot(d, d) <= (br + 0.4 * dx) * (br + 0.4 * dx)) { t = 2u; sv = bv; }
  }
  stU(off(7u) + c, t);
  stF(off(11u) + c * 4u, sv.x);
  stF(off(11u) + c * 4u + 1u, sv.y);
  stF(off(11u) + c * 4u + 2u, sv.z);
}
// zero the P2G accumulators for the next substep
@compute @workgroup_size(64)
fn zeroAcc(@builtin(global_invocation_id) gid: vec3<u32>) {
  let p = gid.x;
  let uN = u32(U.counts.x); let vN = u32(U.counts.y); let wN = u32(U.counts.z);
  if (p < uN) { stU(off(18u) + p, 0u); stU(off(21u) + p, 0u); }
  if (p < vN) { stU(off(19u) + p, 0u); stU(off(22u) + p, 0u); }
  if (p < wN) { stU(off(20u) + p, 0u); stU(off(23u) + p, 0u); }
}
`,

// ================================================== mark fluid + demotions
markFluid: `
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let p = gid.x;
  if (p >= U.dims.w || pFlag(p) != 0u) { return; }
  let pos = pPos(p);
  let dx = dxC();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  let cj = clamp(i32(pos.y / dx), 0, ny - 1);
  if (U.terrain2.w > 0.5) {
    let r = length(pos - U.center.xyz);
    if (r * r > (U.world.x + 0.3) * (U.world.x + 0.3)
        && r - terrainR(pos.x, pos.y, pos.z) > 0.3 && !rockCellAt(pos.x, pos.y, pos.z)) {
      pFlagW(p, 1u); return;
    }
    if (cj >= ny - 2 && r - terrainR(pos.x, pos.y, pos.z) > 0.3) { pFlagW(p, 1u); return; }
  } else {
    if (cj >= ny - 2) { pFlagW(p, 1u); return; }
  }
  let ci = clamp(i32(pos.x / dx), 0, nx - 1);
  let ck = clamp(i32(pos.z / dx), 0, nz - 1);
  let c = cIdx(ci, cj, ck);
  if (typeAt(c) == 0u) { orU(off(7u) + c, 1u); }
}
`,

// ================================================================== P2G
p2g: `
fn scatter(oAcc: u32, oAccW: u32, comp: u32, x: f32, y: f32, z: f32, vin: f32) {
  let v = clamp(vin, -3.9, 15.0);   // fixed-point guard (u32 accumulator)
  let dx = dxC();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  var a: f32; var b: f32; var c: f32;
  if (comp == 0u) { a = x / dx; b = y / dx - 0.5; c = z / dx - 0.5; }
  else if (comp == 1u) { a = x / dx - 0.5; b = y / dx; c = z / dx - 0.5; }
  else { a = x / dx - 0.5; b = y / dx - 0.5; c = z / dx; }
  var i0 = i32(floor(a)); var j0 = i32(floor(b)); var k0 = i32(floor(c));
  var tx: f32; var ty: f32; var tz: f32;
  if (i0 < 0) { i0 = 0; tx = 0.0; } else if (i0 > nx - 1) { i0 = nx - 1; tx = 1.0; } else { tx = a - f32(i0); }
  if (j0 < 0) { j0 = 0; ty = 0.0; } else if (j0 > ny - 2) { j0 = ny - 2; ty = 1.0; } else { ty = b - f32(j0); }
  if (k0 < 0) { k0 = 0; tz = 0.0; } else if (k0 > nz - 2) { k0 = nz - 2; tz = 1.0; } else { tz = c - f32(k0); }
  let s0 = 1.0 - tx; let s1 = tx; let t0 = 1.0 - ty; let t1 = ty; let r0 = 1.0 - tz; let r1 = tz;
  var sj = nx + 1; var sk = ny * sj; var d0 = ny;
  if (comp == 1u) { sj = nx; sk = (ny + 1) * nx; d0 = ny + 1; }
  else if (comp == 2u) { sj = nx; sk = ny * nx; d0 = ny; }
  let idx = u32((k0 * d0 + j0) * sj + i0);
  let q0 = u32((v + 4.0) * 65536.0);
  let w0 = 65536.0;
  adU(oAcc + idx, u32(f32(q0) * s0 * t0 * r0));
  adU(oAccW + idx, u32(w0 * s0 * t0 * r0));
  adU(oAcc + idx + 1u, u32(f32(q0) * s1 * t0 * r0));
  adU(oAccW + idx + 1u, u32(w0 * s1 * t0 * r0));
  adU(oAcc + idx + u32(sj), u32(f32(q0) * s0 * t1 * r0));
  adU(oAccW + idx + u32(sj), u32(w0 * s0 * t1 * r0));
  adU(oAcc + idx + u32(sj) + 1u, u32(f32(q0) * s1 * t1 * r0));
  adU(oAccW + idx + u32(sj) + 1u, u32(w0 * s1 * t1 * r0));
  adU(oAcc + idx + u32(sk), u32(f32(q0) * s0 * t0 * r1));
  adU(oAccW + idx + u32(sk), u32(w0 * s0 * t0 * r1));
  adU(oAcc + idx + u32(sk) + 1u, u32(f32(q0) * s1 * t0 * r1));
  adU(oAccW + idx + u32(sk) + 1u, u32(w0 * s1 * t0 * r1));
  adU(oAcc + idx + u32(sk) + u32(sj), u32(f32(q0) * s0 * t1 * r1));
  adU(oAccW + idx + u32(sk) + u32(sj), u32(w0 * s0 * t1 * r1));
  adU(oAcc + idx + u32(sk) + u32(sj) + 1u, u32(f32(q0) * s1 * t1 * r1));
  adU(oAccW + idx + u32(sk) + u32(sj) + 1u, u32(w0 * s1 * t1 * r1));
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let p = gid.x;
  if (p >= U.dims.w || pFlag(p) != 0u) { return; }
  let pos = pPos(p);
  let vel = pVel(p);
  scatter(off(18u), off(21u), 0u, pos.x, pos.y, pos.z, vel.x);
  scatter(off(19u), off(22u), 1u, pos.x, pos.y, pos.z, vel.y);
  scatter(off(20u), off(23u), 2u, pos.x, pos.y, pos.z, vel.z);
}
`,

// =========================================================== P2G normalize
p2gNorm: `
fn norm(oAcc: u32, oAccW: u32, oF: u32, oW: u32, n: u32, g: vec3<u32>) {
  let p = g.x;
  if (p >= n) { return; }
  let aw = ldU(oAccW + p);
  if (aw >= 1u) {
    let av = ldU(oAcc + p);
    stF(oW + p, f32(aw) / 65536.0);
    stF(oF + p, (f32(av) - 4.0 * f32(aw)) / f32(aw));
  } else {
    stF(oW + p, 0.0);
    stF(oF + p, 0.0);
  }
}
@compute @workgroup_size(64) fn mainU(@builtin(global_invocation_id) g: vec3<u32>) { touch(); norm(off(18u), off(21u), off(8u), off(15u), u32(U.counts.x), g); }
@compute @workgroup_size(64) fn mainV(@builtin(global_invocation_id) g: vec3<u32>) { touch(); norm(off(19u), off(22u), off(9u), off(16u), u32(U.counts.y), g); }
@compute @workgroup_size(64) fn mainW(@builtin(global_invocation_id) g: vec3<u32>) { touch(); norm(off(20u), off(23u), off(10u), off(17u), u32(U.counts.z), g); }
`,

// ===================================================== boundary conditions
bcFaces: `
fn bc(oF: u32, comp: u32, g: vec3<u32>) {
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  var d0 = nx + 1; var d1 = ny; var d2 = nz;
  if (comp == 1u) { d0 = nx; d1 = ny + 1; }
  if (comp == 2u) { d0 = nx; d2 = nz + 1; }
  let p = i32(g.x);
  if (p >= d0 * d1 * d2) { return; }
  let i = p % d0;
  let j = (p / d0) % d1;
  let k = p / (d0 * d1);
  var boundary = false;
  if (comp == 0u) { boundary = i == 0 || i == nx; }
  else if (comp == 1u) { boundary = j == 0 || j == ny; }
  else { boundary = k == 0 || k == nz; }
  if (boundary) { stF(oF + u32(p), 0.0); return; }
  var cL: i32; var cR: i32; var sc: u32;
  if (comp == 0u) { cL = (k * ny + j) * nx + i - 1; cR = cL + 1; sc = 0u; }
  else if (comp == 1u) { cL = (k * ny + j - 1) * nx + i; cR = cL + nx; sc = 1u; }
  else { cL = ((k - 1) * ny + j) * nx + i; cR = cL + nx * ny; sc = 2u; }
  let tL = typeAt(u32(cL)); let tR = typeAt(u32(cR));
  var v = ldF(oF + u32(p));
  if (tL == 2u) { v = ldF(off(11u) + u32(cL) * 4u + sc); }
  else if (tR == 2u) { v = ldF(off(11u) + u32(cR) * 4u + sc); }
  stF(oF + u32(p), v);
}
@compute @workgroup_size(64) fn mainU(@builtin(global_invocation_id) g: vec3<u32>) { touch(); bc(off(8u), 0u, g); }
@compute @workgroup_size(64) fn mainV(@builtin(global_invocation_id) g: vec3<u32>) { touch(); bc(off(9u), 1u, g); }
@compute @workgroup_size(64) fn mainW(@builtin(global_invocation_id) g: vec3<u32>) { touch(); bc(off(10u), 2u, g); }
`,

// ================================================================ viscosity
// Jacobi form: reads the pre-projection snapshot (uO, written before this
// pass) as the old field — the CPU solver updates in place (Gauss-Seidel
// order); same equilibrium, slightly different transient.
viscosity: `
fn visc(oF: u32, oOld: u32, comp: u32, g: vec3<u32>) {
  let coef = U.misc.x;
  if (coef <= 0.0) { return; }
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  var d0 = nx + 1; var d1 = ny; var d2 = nz;
  if (comp == 1u) { d0 = nx; d1 = ny + 1; }
  if (comp == 2u) { d0 = nx; d2 = nz + 1; }
  let p = i32(g.x);
  if (p >= d0 * d1 * d2) { return; }
  let i = p % d0;
  let j = (p / d0) % d1;
  let k = p / (d0 * d1);
  var cL: i32; var cR: i32;
  if (comp == 0u) { cL = (k * ny + j) * nx + i - 1; cR = cL + 1; }
  else if (comp == 1u) { cL = (k * ny + j - 1) * nx + i; cR = cL + nx; }
  else { cL = ((k - 1) * ny + j) * nx + i; cR = cL + nx * ny; }
  if (typeAt(u32(cL)) != 1u || typeAt(u32(cR)) != 1u) { return; }
  let idx = u32(p);
  let own = ldF(oOld + idx);
  var val = own * 6.0;
  var nb: f32;
  // indices clamped: WGSL select evaluates both operands, so the rejected
  // branch must stay in bounds (clamp to a valid neighbour, never underflow)
  nb = select(own, ldF(oOld + select(idx, idx + 1u, idx == 0u) - 1u), i - 1 >= 0);          val -= nb;
  nb = select(own, ldF(oOld + idx + 1u), i + 1 <= d0 - 1);     val -= nb;
  nb = select(own, ldF(oOld + idx - u32(d0)), j - 1 >= 0);     val -= nb;
  nb = select(own, ldF(oOld + idx + u32(d0)), j + 1 <= d1 - 1); val -= nb;
  nb = select(own, ldF(oOld + idx - u32(d0) * u32(d1)), k - 1 >= 0); val -= nb;
  nb = select(own, ldF(oOld + idx + u32(d0) * u32(d1)), k + 1 <= d2 - 1); val -= nb;
  stF(oF + idx, ldF(oF + idx) + coef * val);
}
@compute @workgroup_size(64) fn mainU(@builtin(global_invocation_id) g: vec3<u32>) { touch(); visc(off(8u), off(12u), 0u, g); }
@compute @workgroup_size(64) fn mainV(@builtin(global_invocation_id) g: vec3<u32>) { touch(); visc(off(9u), off(13u), 1u, g); }
@compute @workgroup_size(64) fn mainW(@builtin(global_invocation_id) g: vec3<u32>) { touch(); visc(off(10u), off(14u), 2u, g); }
`,

// ================================================================== gravity
gravity: `
fn gravSphere(oF: u32, oG: u32, oT: u32, oTn: u32, perp: u32, g: vec3<u32>) {
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  var d0 = nx + 1; var d1 = ny; var d2 = nz;
  if (perp == 1u) { d0 = nx; d1 = ny + 1; }
  if (perp == 2u) { d0 = nx; d2 = nz + 1; }
  let p = i32(g.x);
  if (p >= d0 * d1 * d2) { return; }
  let i = p % d0;
  let j = (p / d0) % d1;
  let k = p / (d0 * d1);
  var cL: i32; var cR: i32;
  if (perp == 0u) { cL = (k * ny + j) * nx + i - 1; cR = cL + 1; }
  else if (perp == 1u) { cL = (k * ny + j - 1) * nx + i; cR = cL + nx; }
  else { cL = ((k - 1) * ny + j) * nx + i; cR = cL + nx * ny; }
  if (typeAt(u32(cL)) != 1u && typeAt(u32(cR)) != 1u) { return; }
  stF(oF + u32(p), ldF(oF + u32(p)) + ldSrcF(oG + u32(p)) * U.center.w * U.limits.z);
}
@compute @workgroup_size(64) fn mainU(@builtin(global_invocation_id) g: vec3<u32>) { touch(); gravSphere(off(8u), off(24u), 0u, 0u, 0u, g); }
@compute @workgroup_size(64) fn mainV(@builtin(global_invocation_id) g: vec3<u32>) { touch(); gravSphere(off(9u), off(25u), 0u, 0u, 1u, g); }
@compute @workgroup_size(64) fn mainW(@builtin(global_invocation_id) g: vec3<u32>) { touch(); gravSphere(off(10u), off(26u), 0u, 0u, 2u, g); }
@compute @workgroup_size(64) fn mainPoolV(@builtin(global_invocation_id) g: vec3<u32>) {
  touch();
  let p = g.x;
  if (p >= u32(U.counts.y)) { return; }
  stF(off(9u) + p, ldF(off(9u) + p) - U.forces.x * U.center.w);
}
`,

// ================================================== pressure rhs + SOR
pressureRhs: `
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  if (i32(gid.x) >= nx || i32(gid.y) >= ny || i32(gid.z) >= nz) { return; }
  let i = i32(gid.x); let j = i32(gid.y); let k = i32(gid.z);
  let c = cIdx(i, j, k);
  if (typeAt(c) != 1u) { stF(off(30u) + c, 0.0); stF(off(31u) + c, 0.0); return; }
  let nxy = nx * ny;
  var nf = 0; var na = 0;
  var nb: array<i32, 6>;
  let ci = i32(c);
  nb[0] = select(-1, ci - 1, i > 0);
  nb[1] = select(-1, ci + 1, i < nx - 1);
  nb[2] = select(-1, ci - nx, j > 0);
  nb[3] = select(-1, ci + nx, j < ny - 1);
  nb[4] = select(-1, ci - nxy, k > 0);
  nb[5] = select(-1, ci + nxy, k < nz - 1);
  for (var d = 0; d < 6; d++) {
    if (nb[d] < 0) { continue; }
    let t = typeAt(u32(nb[d]));
    if (t == 1u) { nf++; } else if (t == 0u) { na++; }
  }
  let dx = dxC();
  let sj = nx + 1;
  let div = (ldF(off(8u) + u32((k * ny + j) * sj + i + 1)) - ldF(off(8u) + u32((k * ny + j) * sj + i))
           + ldF(off(9u) + u32((k * (ny + 1) + j + 1) * nx + i)) - ldF(off(9u) + u32((k * (ny + 1) + j) * nx + i))
           + ldF(off(10u) + u32(((k + 1) * ny + j) * nx + i)) - ldF(off(10u) + u32((k * ny + j) * nx + i))) / dx;
  stF(off(30u) + c, -dx * dx * div);
  stF(off(31u) + c, f32(nf + na));
}
@compute @workgroup_size(4, 4, 4)
fn rb(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  if (i32(gid.x) >= nx || i32(gid.y) >= ny || i32(gid.z) >= nz) { return; }
  let i = i32(gid.x); let j = i32(gid.y); let k = i32(gid.z);
  if ((i + j + k) % 2 != i32(U.parity.x)) { return; }
  let c = cIdx(i, j, k);
  if (typeAt(c) != 1u) { return; }
  let ci = i32(c);
  let nxy = nx * ny;
  var sum = 0.0;
  var n: i32;
  n = select(-1, ci - 1, i > 0);        if (n >= 0 && typeAt(u32(n)) == 1u) { sum += ldF(off(32u) + u32(n)); }
  n = select(-1, ci + 1, i < nx - 1);   if (n >= 0 && typeAt(u32(n)) == 1u) { sum += ldF(off(32u) + u32(n)); }
  n = select(-1, ci - nx, j > 0);       if (n >= 0 && typeAt(u32(n)) == 1u) { sum += ldF(off(32u) + u32(n)); }
  n = select(-1, ci + nx, j < ny - 1);  if (n >= 0 && typeAt(u32(n)) == 1u) { sum += ldF(off(32u) + u32(n)); }
  n = select(-1, ci - nxy, k > 0);      if (n >= 0 && typeAt(u32(n)) == 1u) { sum += ldF(off(32u) + u32(n)); }
  n = select(-1, ci + nxy, k < nz - 1); if (n >= 0 && typeAt(u32(n)) == 1u) { sum += ldF(off(32u) + u32(n)); }
  let diag = ldF(off(31u) + c);
  let rhs = ldF(off(30u) + c);
  var q = 0.0;
  if (diag > 0.0) { q = ldF(off(32u) + c) * (1.0 - U.times.z) + (U.times.z / diag) * (rhs + sum); }
  stF(off(32u) + c, q);
}
`,

// ================================================================ projection
project: `
fn proj(oF: u32, perp: u32, g: vec3<u32>) {
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  var d0 = nx + 1; var d1 = ny; var d2 = nz;
  if (perp == 1u) { d0 = nx; d1 = ny + 1; }
  if (perp == 2u) { d0 = nx; d2 = nz + 1; }
  let p = i32(g.x);
  if (p >= d0 * d1 * d2) { return; }
  let i = p % d0;
  let j = (p / d0) % d1;
  let k = p / (d0 * d1);
  var cL: i32; var cR: i32;
  if (perp == 0u) { cL = (k * ny + j) * nx + i - 1; cR = cL + 1; }
  else if (perp == 1u) { cL = (k * ny + j - 1) * nx + i; cR = cL + nx; }
  else { cL = ((k - 1) * ny + j) * nx + i; cR = cL + nx * ny; }
  let tL = typeAt(u32(cL)); let tR = typeAt(u32(cR));
  if (tL == 2u || tR == 2u) { return; }
  let pL = select(0.0, ldF(off(32u) + u32(cL)), tL == 1u);
  let pR = select(0.0, ldF(off(32u) + u32(cR)), tR == 1u);
  stF(oF + u32(p), ldF(oF + u32(p)) - (pR - pL) / dxC());
}
@compute @workgroup_size(64) fn mainU(@builtin(global_invocation_id) g: vec3<u32>) { touch(); proj(off(8u), 0u, g); }
@compute @workgroup_size(64) fn mainV(@builtin(global_invocation_id) g: vec3<u32>) { touch(); proj(off(9u), 1u, g); }
@compute @workgroup_size(64) fn mainW(@builtin(global_invocation_id) g: vec3<u32>) { touch(); proj(off(10u), 2u, g); }
`,

// ==================================================== vorticity confinement
vorticity: `
@compute @workgroup_size(4, 4, 4)
fn velAndOmega(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  if (i32(gid.x) >= nx || i32(gid.y) >= ny || i32(gid.z) >= nz) { return; }
  let i = i32(gid.x); let j = i32(gid.y); let k = i32(gid.z);
  let c = cIdx(i, j, k);
  let ci = i32(c);
  let nxy = nx * ny;
  let sj = nx + 1;
  let cu = 0.5 * (ldF(off(8u) + u32((k * ny + j) * sj + i)) + ldF(off(8u) + u32((k * ny + j) * sj + i + 1)));
  let cv = 0.5 * (ldF(off(9u) + u32((k * (ny + 1) + j) * nx + i)) + ldF(off(9u) + u32((k * (ny + 1) + j + 1) * nx + i)));
  let cw = 0.5 * (ldF(off(10u) + c) + ldF(off(10u) + u32(ci + nxy)));
  let im = select(ci, ci - 1, i > 0); let ip = select(ci, ci + 1, i < nx - 1);
  let jm = select(ci, ci - nx, j > 0); let jp = select(ci, ci + nx, j < ny - 1);
  let km = select(ci, ci - nxy, k > 0); let kp = select(ci, ci + nxy, k < nz - 1);
  let cmx = select(cu, 0.5 * (ldF(off(8u) + u32((k * ny + jm) * sj + i)) + ldF(off(8u) + u32((k * ny + jm) * sj + i + 1))), jm != ci);
  let cmy = select(cv, 0.5 * (ldF(off(9u) + u32((k * (ny + 1) + jm) * nx + i)) + ldF(off(9u) + u32((k * (ny + 1) + jm + 1) * nx + i))), jm != ci);
  let cmz = select(cw, 0.5 * (ldF(off(10u) + u32(jm)) + ldF(off(10u) + u32(jm + nxy))), jm != ci);
  let cpx = select(cu, 0.5 * (ldF(off(8u) + u32((k * ny + jp) * sj + i)) + ldF(off(8u) + u32((k * ny + jp) * sj + i + 1))), jp != ci);
  let cpy = select(cv, 0.5 * (ldF(off(9u) + u32((k * (ny + 1) + jp) * nx + i)) + ldF(off(9u) + u32((k * (ny + 1) + jp + 1) * nx + i))), jp != ci);
  let cpz = select(cw, 0.5 * (ldF(off(10u) + u32(jp)) + ldF(off(10u) + u32(jp + nxy))), jp != ci);
  let ikx = select(cu, 0.5 * (ldF(off(8u) + u32((km * ny + j) * sj + i)) + ldF(off(8u) + u32((km * ny + j) * sj + i + 1))), km != ci);
  let iky = select(cv, 0.5 * (ldF(off(9u) + u32((km * (ny + 1) + j) * nx + i)) + ldF(off(9u) + u32((km * (ny + 1) + j + 1) * nx + i))), km != ci);
  let ikz = select(cw, 0.5 * (ldF(off(10u) + u32(km)) + ldF(off(10u) + u32(km + nxy))), km != ci);
  let ipx = select(cu, 0.5 * (ldF(off(8u) + u32((kp * ny + j) * sj + i)) + ldF(off(8u) + u32((kp * ny + j) * sj + i + 1))), kp != ci);
  let ipy = select(cv, 0.5 * (ldF(off(9u) + u32((kp * (ny + 1) + j) * nx + i)) + ldF(off(9u) + u32((kp * (ny + 1) + j + 1) * nx + i))), kp != ci);
  let ipz = select(cw, 0.5 * (ldF(off(10u) + u32(kp)) + ldF(off(10u) + u32(kp + nxy))), kp != ci);
  let cmx2 = select(cu, 0.5 * (ldF(off(8u) + u32((k * ny + j) * sj + im)) + ldF(off(8u) + u32((k * ny + j) * sj + im + 1))), im != ci);
  let cmy2 = select(cv, 0.5 * (ldF(off(9u) + u32((k * (ny + 1) + j) * nx + im)) + ldF(off(9u) + u32((k * (ny + 1) + j + 1) * nx + im))), im != ci);
  let cmz2 = select(cw, 0.5 * (ldF(off(10u) + u32(im)) + ldF(off(10u) + u32(im + nxy))), im != ci);
  let cpx2 = select(cu, 0.5 * (ldF(off(8u) + u32((k * ny + j) * sj + ip)) + ldF(off(8u) + u32((k * ny + j) * sj + ip + 1))), ip != ci);
  let cpy2 = select(cv, 0.5 * (ldF(off(9u) + u32((k * (ny + 1) + j) * nx + ip)) + ldF(off(9u) + u32((k * (ny + 1) + j + 1) * nx + ip))), ip != ci);
  let cpz2 = select(cw, 0.5 * (ldF(off(10u) + u32(ip)) + ldF(off(10u) + u32(ip + nxy))), ip != ci);
  let inv2 = 0.5 / dxC();
  let wx = (cpz - cmz - (ipy - iky)) * inv2;
  let wy = (cpx2 - cmx2 - (cpz2 - cmz2)) * inv2;
  let wz = (cpy2 - cmy2 - (cpx - cmx)) * inv2;
  stF(off(36u) + c, wx); stF(off(37u) + c, wy); stF(off(38u) + c, wz);
}
@compute @workgroup_size(4, 4, 4)
fn force(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  if (i32(gid.x) >= nx || i32(gid.y) >= ny || i32(gid.z) >= nz) { return; }
  let i = i32(gid.x); let j = i32(gid.y); let k = i32(gid.z);
  let c = cIdx(i, j, k);
  let eps = U.poolbox2.w;    // vorticity strength (poolbox2.w carries it)
  let nxy = u32(nx * ny);
  let omg = length(vec3<f32>(ldF(off(36u) + c), ldF(off(37u) + c), ldF(off(38u) + c)));
  var interior = typeAt(c) == 1u && omg >= 0.35;
  if (i <= 0 || i >= nx - 1 || j <= 0 || j >= ny - 1 || k <= 0 || k >= nz - 1) { interior = interior && false; }
  if (interior) {
    interior = typeAt(c - 1u) == 1u && typeAt(c + 1u) == 1u
           && typeAt(c - u32(nx)) == 1u && typeAt(c + u32(nx)) == 1u
           && typeAt(c - nxy) == 1u && typeAt(c + nxy) == 1u;
  }
  if (!interior) { stF(off(33u) + c, 0.0); stF(off(34u) + c, 0.0); stF(off(35u) + c, 0.0); return; }
  let omIp = length(vec3<f32>(ldF(off(36u) + select(c, c + 1u, i < nx - 1)), ldF(off(37u) + select(c, c + 1u, i < nx - 1)), ldF(off(38u) + select(c, c + 1u, i < nx - 1))));
  let omIm = length(vec3<f32>(ldF(off(36u) + select(c, c - 1u, i > 0)), ldF(off(37u) + select(c, c - 1u, i > 0)), ldF(off(38u) + select(c, c - 1u, i > 0))));
  let omJp = length(vec3<f32>(ldF(off(36u) + select(c, c + u32(nx), j < ny - 1)), ldF(off(37u) + select(c, c + u32(nx), j < ny - 1)), ldF(off(38u) + select(c, c + u32(nx), j < ny - 1))));
  let omJm = length(vec3<f32>(ldF(off(36u) + select(c, c - u32(nx), j > 0)), ldF(off(37u) + select(c, c - u32(nx), j > 0)), ldF(off(38u) + select(c, c - u32(nx), j > 0))));
  let omKp = length(vec3<f32>(ldF(off(36u) + select(c, c + nxy, k < nz - 1)), ldF(off(37u) + select(c, c + nxy, k < nz - 1)), ldF(off(38u) + select(c, c + nxy, k < nz - 1))));
  let omKm = length(vec3<f32>(ldF(off(36u) + select(c, c - nxy, k > 0)), ldF(off(37u) + select(c, c - nxy, k > 0)), ldF(off(38u) + select(c, c - nxy, k > 0))));
  let gx = omIp - omIm;
  let gy = omJp - omJm;
  let gz = omKp - omKm;
  let g2 = gx * gx + gy * gy + gz * gz;
  if (g2 < 1e-12) { stF(off(33u) + c, 0.0); stF(off(34u) + c, 0.0); stF(off(35u) + c, 0.0); return; }
  let inv = 1.0 / sqrt(g2);
  let Nx = gx * inv; let Ny = gy * inv; let Nz = gz * inv;
  let ox = ldF(off(36u) + c); let oy = ldF(off(37u) + c); let oz = ldF(off(38u) + c);
  var fx = eps * (Ny * oz - Nz * oy);
  var fy = eps * (Nz * ox - Nx * oz);
  var fz = eps * (Nx * oy - Ny * ox);
  let f2 = fx * fx + fy * fy + fz * fz;
  if (f2 > 36.0) { let fs = 6.0 / sqrt(f2); fx *= fs; fy *= fs; fz *= fs; }
  stF(off(33u) + c, fx * U.center.w);
  stF(off(34u) + c, fy * U.center.w);
  stF(off(35u) + c, fz * U.center.w);
}
@compute @workgroup_size(4, 4, 4)
fn splat(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  if (i32(gid.x) >= nx || i32(gid.y) >= ny || i32(gid.z) >= nz) { return; }
  let i = i32(gid.x); let j = i32(gid.y); let k = i32(gid.z);
  let c = cIdx(i, j, k);
  let nxy = nx * ny;
  if (typeAt(c) != 1u) { return; }
  if (i < nx - 1 && typeAt(c + 1u) == 1u) {
    let idx = u32((k * ny + j) * (nx + 1) + i + 1);
    stF(off(8u) + idx, ldF(off(8u) + idx) + 0.5 * (ldF(off(33u) + c) + ldF(off(33u) + c + 1u)));
  }
  if (j < ny - 1 && typeAt(c + u32(nx)) == 1u) {
    let idx = u32((k * (ny + 1) + j + 1) * nx + i);
    stF(off(9u) + idx, ldF(off(9u) + idx) + 0.5 * (ldF(off(34u) + c) + ldF(off(34u) + c + u32(nx))));
  }
  if (k < nz - 1 && typeAt(c + u32(nxy)) == 1u) {
    let idx = u32(((k + 1) * ny + j) * nx + i);
    stF(off(10u) + idx, ldF(off(10u) + idx) + 0.5 * (ldF(off(35u) + c) + ldF(off(35u) + c + u32(nxy))));
  }
}
`,

// ========================================================= clamp + extrap
clampGrid: `
fn clampC(oF: u32, n: u32, g: vec3<u32>) {
  let p = g.x;
  if (p >= n) { return; }
  let v = ldF(oF + p);
  let cap = U.forces.w;
  stF(oF + p, clamp(v, -cap, cap));
}
@compute @workgroup_size(64) fn mainU(@builtin(global_invocation_id) g: vec3<u32>) { touch(); clampC(off(8u), u32(U.counts.x), g); }
@compute @workgroup_size(64) fn mainV(@builtin(global_invocation_id) g: vec3<u32>) { touch(); clampC(off(9u), u32(U.counts.y), g); }
@compute @workgroup_size(64) fn mainW(@builtin(global_invocation_id) g: vec3<u32>) { touch(); clampC(off(10u), u32(U.counts.z), g); }
`,
extrapolate: `
fn mark(oF: u32, oW: u32, oV: u32, perp: u32, g: vec3<u32>) {
  let nx = nxC(); let ny = nyC(); let nz = nzC(); let nxy = nx * ny;
  var d0 = nx + 1; var d1 = ny; var d2 = nz;
  if (perp == 1u) { d0 = nx; d1 = ny + 1; }
  if (perp == 2u) { d0 = nx; d2 = nz + 1; }
  let p = i32(g.x);
  if (p >= d0 * d1 * d2) { return; }
  let i = p % d0;
  let j = (p / d0) % d1;
  let k = p / (d0 * d1);
  var solidAdj = false;
  if (perp == 0u) {
    solidAdj = i == 0 || i == nx;
    if (!solidAdj) { let cl = (k * ny + j) * nx + i - 1; solidAdj = typeAt(u32(cl)) == 2u || typeAt(u32(cl + 1)) == 2u; }
  } else if (perp == 1u) {
    solidAdj = j == 0 || j == ny;
    if (!solidAdj) { solidAdj = typeAt(u32((k * ny + j - 1) * nx + i)) == 2u || typeAt(u32((k * ny + j) * nx + i)) == 2u; }
  } else {
    solidAdj = k == 0 || k == nz;
    if (!solidAdj) { solidAdj = typeAt(u32(((k - 1) * ny + j) * nx + i)) == 2u || typeAt(u32((k * ny + j) * nx + i)) == 2u; }
  }
  let ok = ldF(oW + u32(p)) > 1e-8 || solidAdj;
  stU(oV + u32(p), select(0u, 1u, ok));
}
fn avg(oF: u32, oV: u32, perp: u32, g: vec3<u32>) {
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  var d0 = nx + 1; var d1 = ny; var d2 = nz;
  if (perp == 1u) { d0 = nx; d1 = ny + 1; }
  if (perp == 2u) { d0 = nx; d2 = nz + 1; }
  let p = i32(g.x);
  if (p >= d0 * d1 * d2) { return; }
  let i = p % d0;
  let j = (p / d0) % d1;
  let k = p / (d0 * d1);
  if (ldU(oV + u32(p)) != 0u) { return; }
  var sum = 0.0; var cnt = 0;
  if (i > 0 && ldU(oV + u32(p - 1)) != 0u) { sum += ldF(oF + u32(p - 1)); cnt++; }
  if (i < d0 - 1 && ldU(oV + u32(p + 1)) != 0u) { sum += ldF(oF + u32(p + 1)); cnt++; }
  if (j > 0 && ldU(oV + u32(p - d0)) != 0u) { sum += ldF(oF + u32(p - d0)); cnt++; }
  if (j < d1 - 1 && ldU(oV + u32(p + d0)) != 0u) { sum += ldF(oF + u32(p + d0)); cnt++; }
  let sK = d0 * d1;
  if (k > 0 && ldU(oV + u32(p - sK)) != 0u) { sum += ldF(oF + u32(p - sK)); cnt++; }
  if (k < d2 - 1 && ldU(oV + u32(p + sK)) != 0u) { sum += ldF(oF + u32(p + sK)); cnt++; }
  if (cnt > 0) { stF(oF + u32(p), sum / f32(cnt)); }
}
@compute @workgroup_size(64)
fn markU(@builtin(global_invocation_id) g: vec3<u32>) { touch(); mark(off(8u), off(15u), off(27u), 0u, g); }
@compute @workgroup_size(64)
fn markV(@builtin(global_invocation_id) g: vec3<u32>) { touch(); mark(off(9u), off(16u), off(28u), 1u, g); }
@compute @workgroup_size(64)
fn markW(@builtin(global_invocation_id) g: vec3<u32>) { touch(); mark(off(10u), off(17u), off(29u), 2u, g); }
@compute @workgroup_size(64)
fn avgU(@builtin(global_invocation_id) g: vec3<u32>) { touch(); avg(off(8u), off(27u), 0u, g); }
@compute @workgroup_size(64)
fn avgV(@builtin(global_invocation_id) g: vec3<u32>) { touch(); avg(off(9u), off(28u), 1u, g); }
@compute @workgroup_size(64)
fn avgW(@builtin(global_invocation_id) g: vec3<u32>) { touch(); avg(off(10u), off(29u), 2u, g); }
`,

// ================================================================ G2P
g2p: `
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let p = gid.x;
  if (p >= U.dims.w) { return; }
  let pic = U.forces.z;
  let dt = U.center.w;
  let pos = pPos(p);
  let x = pos.x; let y = pos.y; let z = pos.z;
  var vel = pVel(p);
  if (pFlag(p) != 0u) { adU(off(49u) + 3u, 1u); return; }   // airborne count
  if (pCool(p) > 0u) {
    // merge cooldown: skip the FLIP delta so the redirect ratchet cannot
    // re-launch fresh splash-back; gravity still integrates
    pCoolW(p, pCool(p) - 1u);
    vel.y -= U.forces.x * dt;
    let sv = sampleVel3(x, y, z);
    advW(p, sv);
    pVelW(p, vel);
    return;
  }
  let ou = sampleFace(off(12u), 0u, x, y, z);
  let nu = sampleFace(off(8u), 0u, x, y, z);
  let ov = sampleFace(off(13u), 1u, x, y, z);
  let nv = sampleFace(off(9u), 1u, x, y, z);
  let ow = sampleFace(off(14u), 2u, x, y, z);
  let nw = sampleFace(off(10u), 2u, x, y, z);
  advW(p, vec3<f32>(nu, nv, nw));
  var nx = (vel.x + nu - ou) * (1.0 - pic) + nu * pic;
  var nvy = (vel.y + nv - ov) * (1.0 - pic) + nv * pic;
  var nvz = (vel.z + nw - ow) * (1.0 - pic) + nw * pic;
  let pv2 = nx * nx + nvy * nvy + nvz * nvz;
  let ms = U.forces.y;
  if (pv2 > ms * ms) {
    let sc = ms / sqrt(pv2);
    nx *= sc; nvy *= sc; nvz *= sc;
  }
  pVelW(p, vec3<f32>(nx, nvy, nvz));
  // demote to spray when fully surrounded by air (unless resting on rock)
  let dx = dxC();
  let nxg = nxC(); let ny = nyC(); let nz = nzC();
  let nxy = nxg * ny;
  let ci = clamp(i32(x / dx), 0, nxg - 1);
  let cj = clamp(i32(y / dx), 0, ny - 1);
  let ck = clamp(i32(z / dx), 0, nz - 1);
  let c = cIdx(ci, cj, ck);
  if (typeAt(c) == 0u) {
    var fluidNbr = false;
    if (ci > 0 && typeAt(c - 1u) == 1u) { fluidNbr = true; }
    if (ci < nxg - 1 && typeAt(c + 1u) == 1u) { fluidNbr = true; }
    if (cj > 0 && typeAt(c - u32(nxg)) == 1u) { fluidNbr = true; }
    if (cj < ny - 1 && typeAt(c + u32(nxg)) == 1u) { fluidNbr = true; }
    if (ck > 0 && typeAt(c - u32(nxy)) == 1u) { fluidNbr = true; }
    if (ck < nz - 1 && typeAt(c + u32(nxy)) == 1u) { fluidNbr = true; }
    if (!fluidNbr && !onRockBelow(x, y, z)) { pFlagW(p, 1u); }
  }
}
`,

// ================================================= ball push-out (all)
pushBalls: `
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let p = gid.x;
  if (p >= U.dims.w || U.misc2.y == 0u) { return; }
  var pos = pPos(p);
  var vel = pVel(p);
  var moved = false;
  for (var bi = 0u; bi < U.misc2.y; bi++) {
    let bp = U.balls[bi * 2u].xyz;
    let br = U.balls[bi * 2u].w + 0.002;
    let bv = U.balls[bi * 2u + 1u].xyz;
    let e = pos - bp;
    let d2 = dot(e, e);
    if (d2 < br * br) {
      let d = max(sqrt(d2), 1e-9);
      let n3 = e / d;
      pos = bp + n3 * br;
      let vn = dot(vel - bv, n3);
      if (vn < 0.0) { vel = vel - n3 * vn; }
      moved = true;
    }
  }
  if (moved) { pPosW(p, pos); pVelW(p, vel); }
}
`,

// ================================================================ advection
advect: `
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let p = gid.x;
  if (p >= U.dims.w) { return; }
  let dt = U.center.w;
  let dx = dxC();
  let fl = pFlag(p);
  var pos = pPos(p);
  var vel = pVel(p);
  let sphere = U.terrain2.w > 0.5;
  let ctr = vec3<f32>(U.center.x, U.center.y, U.center.z);
  let g = U.forces.x;
  let ms = U.forces.y;
  let domHi = U.limits.y;
  let coreLo = U.world.y + dx * 1.02;
  let hasTerr = U.terrain2.z > 0.5;
  let wind3 = U.wind.xyz;
  var st = prngSeed(p);

  if (fl == 1u) {
    // ---- ballistic droplet (spray)
    if (sphere) {
      let gv = pos - ctr;
      let gr2 = dot(gv, gv);
      let grl = sqrt(gr2);
      let ga = g * U.world.x * U.world.x * dt / max(gr2 * grl, 1e-12);
      vel = vel - gv * ga;
    } else {
      vel.y = vel.y - g * dt;
    }
    let dr = max(1.0 - 2.5 * dt, 0.0);
    vel = vel * dr;
    let dsp = length(vel);
    if (dsp > ms) { vel = vel * (ms / dsp); }
    pos = pos + vel * dt;
    if (sphere) {
      let b = pos - ctr;
      let br = max(length(b), 1e-9);
      let skyHi = U.limits.x;
      if (br > skyHi) {
        pos = ctr + b * (skyHi / br);
        let vr0 = dot(vel, b) / br;
        if (vr0 > 0.0) { vel = vel - b / br * vr0 * 1.15; }
      } else if (br <= domHi) {
        var tries0 = 0;
        var q = pos;
        if (hasTerr) {
          while (rockCellAt(q.x, q.y, q.z) && tries0 < 8) {
            let rW0 = length(q - ctr);
            let stW0 = min(dx * 0.5, domHi - rW0);
            if (stW0 <= 1e-5) { tries0 = 8; break; }
            q = q + b / br * stW0;
            tries0++;
          }
        } else if (br < coreLo) {
          q = ctr + b * (coreLo / br);
          tries0 = 1;
        }
        pos = q;
        if (tries0 > 0) {
          let vr1 = dot(vel, b) / br;
          vel = vel - b / br * vr1;
          vel = vel * 0.3;
          pFlagW(p, 0u);
        }
      }
    } else {
      let xLo = U.poolbox.y; let xHi = U.poolbox.z;
      let yLo = U.poolbox.w; let yHi = U.poolbox2.x;
      let zLo = U.poolbox2.y; let zHi = U.poolbox2.z;
      if (pos.x < xLo) { pos.x = xLo; vel.x = abs(vel.x) * 0.35; }
      else if (pos.x > xHi) { pos.x = xHi; vel.x = -abs(vel.x) * 0.35; }
      if (pos.z < zLo) { pos.z = zLo; vel.z = abs(vel.z) * 0.35; }
      else if (pos.z > zHi) { pos.z = zHi; vel.z = -abs(vel.z) * 0.35; }
      if (pos.y > yHi) { pos.y = yHi; vel.y = -abs(vel.y) * 0.15; }
      if (pos.y <= yLo + 0.001) {
        pos.y = yLo; vel.y = 0.0; vel.x *= 0.3; vel.z *= 0.3; pFlagW(p, 0u);
      }
    }
    pPosW(p, pos);
    pVelW(p, vel);
    // re-entry into the liquid
    let ci2 = clamp(i32(pos.x / dx), 0, nxC() - 1);
    let cj2 = clamp(i32(pos.y / dx), 0, nyC() - 1);
    let ck2 = clamp(i32(pos.z / dx), 0, nzC() - 1);
    if (typeAt(cIdx(ci2, cj2, ck2)) == 1u) {
      vel = vel * 0.45;
      if (vel.y > 0.5) { vel.y = 0.5; }
      pCoolW(p, 2u);
      pFlagW(p, 0u);
      pVelW(p, vel);
    }
    return;
  }

  if (fl == 2u) {
    // ---- atmospheric parcel (vapor)
    let Tv = pT(p);
    pAirW(p, pAir(p) + dt);
    if (sphere) {
      let e0 = pos - ctr;
      let er = max(length(e0), 1e-9);
      let u3 = e0 / er;
      let exposure = dot(u3, wind3);
      let jet = min(U.world.x * 0.58, ms * 0.45);
      let returnFlow = min(U.world.x * 0.32, ms * 0.25);
      let ground = select(U.world.y, terrainR(pos.x, pos.y, pos.z), hasTerr);
      let height = max(ground + 0.09, U.world.x + U.world.w * 0.58);
      let vr = dot(vel, u3);
      let radial = clamp((height - er) * 3.0 - vr * 1.4, -1.5, 1.5);
      let wx = -u3.z * jet - (wind3.x - exposure * u3.x) * returnFlow;
      let wy = -(wind3.y - exposure * u3.y) * returnFlow;
      let wz = u3.x * jet - (wind3.z - exposure * u3.z) * returnFlow;
      let relax = min(1.0, dt * 1.3);
      vel = vel + (vec3<f32>(wx, wy, wz) - (vel - vr * u3)) * relax + u3 * radial * dt;
    } else {
      vel.y = vel.y - g * 0.06 * dt;
    }
    let svv = dot(vel, vel);
    if (svv > ms * ms) { vel = vel * (ms / sqrt(svv)); }
    pos = pos + vel * dt;
    var backToSea = false;
    if (sphere) {
      let vC = pos - ctr;
      let vCr = max(length(vC), 1e-9);
      var ceilR = U.world.x + U.world.w;
      if (hasTerr) {
        let RtE = terrainR(pos.x, pos.y, pos.z);
        if (RtE + 0.02 > ceilR) { ceilR = RtE + 0.02; }
      }
      if (vCr > ceilR) {
        pos = ctr + vC * (ceilR / vCr);
        let vrE = dot(vel, vC) / vCr;
        if (vrE > 0.0) { vel = vel - vC / vCr * vrE * 2.0; }
      }
      let vrC2 = dot(vel, vC) / vCr;
      if (vrC2 > 0.0 && vCr > U.world.x) {
        var hh = (vCr - U.world.x) / max(U.world.w, 1e-4);
        hh = min(hh, 1.0);
        var prf = hh;
        if (U.terrain2.y > 1.5 && U.terrain2.y < 2.5) { prf = hh * hh; }
        else if (U.terrain2.y > 2.5) { prf = (exp(3.0 * hh) - 1.0) * 0.0523957; }
        if (prf > 0.0 && rnd01(&st) < prf * dt * 4.0) {
          vel = vel - vC / vCr * vrC2 * 2.0;
        }
      }
      var triesE = 0;
      var rNow = length(pos - ctr);
      var q = pos;
      while (hasTerr && rNow < U.world.z && rockCellAt(q.x, q.y, q.z) && triesE < 8) {
        let stW3 = min(dx * 0.5, domHi - rNow);
        if (stW3 <= 1e-5) { break; }
        q = q + vC / vCr * stW3;
        rNow = length(q - ctr);
        triesE++;
      }
      pos = q;
      if (triesE > 0) {
        let vrT = dot(vel, vC) / vCr;
        if (vrT < 0.0) {
          let bT = 1.5 * vrT / vCr;
          vel = vel - vC * bT;
        }
        vel = vel * 0.92;
      }
      let ciV = clamp(i32(pos.x / dx), 0, nxC() - 1);
      let cjV = clamp(i32(pos.y / dx), 0, nyC() - 1);
      let ckV = clamp(i32(pos.z / dx), 0, nzC() - 1);
      backToSea = typeAt(cIdx(ciV, cjV, ckV)) == 1u;
      if (backToSea) {
        let b2 = pos - ctr;
        let br2 = max(length(b2), 1e-9);
        if (br2 > U.world.x + 0.25 * dx) { backToSea = false; }
        else if (dot(vel, b2) / br2 > 0.02) { backToSea = false; }
      }
    } else {
      let xLo = U.poolbox.y; let xHi = U.poolbox.z;
      let yLo = U.poolbox.w; let yHi = U.poolbox2.x;
      let zLo = U.poolbox2.y; let zHi = U.poolbox2.z;
      let ceilY = U.poolbox.x + U.world.w;
      if (pos.y > ceilY) { pos.y = ceilY; if (vel.y > 0.0) { vel.y = -vel.y; } }
      if (pos.y < yLo + 0.001) { pos.y = yLo + 0.001; if (vel.y < 0.0) { vel.y = -vel.y; } }
      if (pos.x < xLo) { pos.x = xLo; vel.x = -vel.x; }
      else if (pos.x > xHi) { pos.x = xHi; vel.x = -vel.x; }
      if (pos.z < zLo) { pos.z = zLo; vel.z = -vel.z; }
      else if (pos.z > zHi) { pos.z = zHi; vel.z = -vel.z; }
      let ciW = clamp(i32(pos.x / dx), 0, nxC() - 1);
      let cjW = clamp(i32(pos.y / dx), 0, nyC() - 1);
      let ckW = clamp(i32(pos.z / dx), 0, nzC() - 1);
      backToSea = typeAt(cIdx(ciW, cjW, ckW)) == 1u;
      if (backToSea && (vel.y > 0.02 || pos.y > U.poolbox.x + 0.25 * dx)) { backToSea = false; }
    }
    if (backToSea) {
      pVelW(p, vec3<f32>(0.0));
      pAirW(p, 0.0);
      pFlagW(p, 0u);
    } else if (Tv < 0.2 || pAir(p) > 40.0) {
      pVelW(p, vec3<f32>(0.0));
      pAirW(p, 0.0);
      pFlagW(p, 1u);
    } else {
      pVelW(p, vel);
    }
    pPosW(p, pos);
    return;
  }

  // ---- grid-coupled fluid: RK2 through the divergence-free field
  var tmp = advLd(p);            // grid velocity at the particle (fresh from G2P)
  var v2 = tmp;
  if (dot(tmp, tmp) > 0.25) {
    let mx = clamp(pos.x + 0.5 * dt * tmp.x, U.poolbox.y, U.poolbox.z);
    let my = clamp(pos.y + 0.5 * dt * tmp.y, U.poolbox.w, U.poolbox2.x);
    let mz = clamp(pos.z + 0.5 * dt * tmp.z, U.poolbox2.y, U.poolbox2.z);
    v2 = sampleVel3(mx, my, mz);
  }
  let sp2b = dot(v2, v2);
  if (sp2b > ms * ms) {
    let sc = ms / sqrt(sp2b);
    v2 = v2 * sc;
    vel = vel * sc;
  }
  pos = pos + v2 * dt;
  if (sphere) {
    let n2 = pos - ctr;
    let nr = max(length(n2), 1e-9);
    if (nr > domHi) {
      pos = ctr + n2 * (domHi / nr);
      vel.y = -abs(vel.y) * 0.1 - 0.3;
      pFlagW(p, 1u);
    }
    if (nr < domHi) {
      var tries = 0;
      var q = pos;
      if (hasTerr) {
        while (rockCellAt(q.x, q.y, q.z) && tries < 8) {
          let rW2 = length(q - ctr);
          let stW2 = min(dx * 0.5, domHi - rW2);
          if (stW2 <= 1e-5) { tries = 8; break; }
          q = q + n2 / nr * stW2;
          tries++;
        }
      }
      pos = q;
      if (tries > 0) {
        let vr2 = dot(vel, n2) / nr;
        if (vr2 < 0.0) { vel = vel - n2 / nr * vr2; }
      }
      if (hasTerr && (tries > 0 || rockCellAt(pos.x - n2.x / nr * dx, pos.y - n2.y / nr * dx, pos.z - n2.z / nr * dx))) {
        let fr0 = max(1.0 - 0.6 * dt, 0.0);
        vel = vel * fr0;
      }
    }
    let s3 = pos - ctr;
    let sr = max(length(s3), 1e-9);
    let vrad = dot(vel, s3) / sr;
    var da = min(1.0 * dt, 0.5);
    vel = vel - s3 / sr * vrad * da;
    vel = vel * max(1.0 - 0.42 * dt, 0.0);
  } else {
    let xLo = U.poolbox.y; let xHi = U.poolbox.z;
    let yLo = U.poolbox.w; let yHi = U.poolbox2.x;
    let zLo = U.poolbox2.y; let zHi = U.poolbox2.z;
    if (pos.x < xLo) { pos.x = xLo; vel.x = abs(vel.x) * 0.1; }
    else if (pos.x > xHi) { pos.x = xHi; vel.x = -abs(vel.x) * 0.1; }
    if (pos.z < zLo) { pos.z = zLo; vel.z = abs(vel.z) * 0.1; }
    else if (pos.z > zHi) { pos.z = zHi; vel.z = -abs(vel.z) * 0.1; }
    if (pos.y < yLo) { pos.y = yLo; vel.y = abs(vel.y) * 0.1; }
    else if (pos.y > yHi) { pos.y = yHi; vel.y = -abs(vel.y) * 0.1 - 0.3; pFlagW(p, 1u); }
  }
  pPosW(p, pos);
  pVelW(p, vel);
}
`,

// ================================================= embedded particle rescue
pushSurface: `
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  if (U.terrain2.w < 0.5 || U.terrain2.z < 0.5) { return; }
  let p = gid.x;
  if (p >= U.dims.w) { return; }
  let dx = dxC();
  let ctr = vec3<f32>(U.center.x, U.center.y, U.center.z);
  var pos = pPos(p);
  var vel = pVel(p);
  var e = pos - ctr;
  var er = max(length(e), 1e-9);
  var fixed = false;
  var rockFixed = false;
  let outer = U.limits.y;
  let skyHi = U.limits.x;
  if (er > skyHi) {
    pos = ctr + e / er * skyHi;
    let outward = dot(vel, e) / er;
    if (outward > 0.0) { vel = vel - e / er * outward; }
    e = pos - ctr;
    er = skyHi;
    fixed = true;
  }
  if (er <= U.world.z && rockCellAt(pos.x, pos.y, pos.z)) {
    rockFixed = true;
    var tries = 0;
    while (rockCellAt(pos.x, pos.y, pos.z) && tries < nxC() * 2) {
      pos = pos + e / er * (dx * 0.5);
      tries++;
    }
    fixed = true;
  } else if (pFlag(p) == 0u && er <= U.world.z) {
    let Rt = terrainR(pos.x, pos.y, pos.z);
    if (er < Rt - dx * 0.5) {
      rockFixed = true;
      pos = ctr + e / er * (Rt + dx * 0.05);
      var t2 = 0;
      while (rockCellAt(pos.x, pos.y, pos.z) && t2 < 8) {
        pos = pos + e / er * (dx * 0.5);
        t2++;
      }
      fixed = true;
    }
  }
  let finalR = length(pos - ctr);
  let capR = select(skyHi, outer, pFlag(p) == 0u);
  if (finalR > capR) {
    pos = ctr + (pos - ctr) * (capR / finalR);
    fixed = true;
  }
  if (fixed) {
    pPosW(p, pos);
    let er2 = max(length(e), 1e-9);
    let vr = dot(vel, e) / er2;
    if (rockFixed && vr < 0.0) { vel = vel - e / er2 * vr; }
    pVelW(p, vel);
  }
}
`,

// ========================================================= vapor collisions
vaporCollide: `
@compute @workgroup_size(4, 4, 4)
fn clearHeads(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  if (i32(gid.x) >= nx || i32(gid.y) >= ny || i32(gid.z) >= nz) { return; }
  stU(off(47u) + cIdx(i32(gid.x), i32(gid.y), i32(gid.z)), 0u);
}
@compute @workgroup_size(64)
fn build(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let p = gid.x;
  if (p >= U.dims.w || pFlag(p) != 2u) { return; }
  // vapor + night-hemisphere census (CPU-equivalent)
  adU(off(49u) + 0u, 1u);
  let sun = U.sun.xyz * U.sun.w;
  let pos = pPos(p);
  if (U.sun.w < 0.5 || dot(pos - vec3<f32>(U.center.x, U.center.y, U.center.z), sun) < 0.0) {
    adU(off(49u) + 1u, 1u);
  }
  let dx = dxC();
  let ci = clamp(i32(pos.x / dx), 0, nxC() - 1);
  let cj = clamp(i32(pos.y / dx), 0, nyC() - 1);
  let ck = clamp(i32(pos.z / dx), 0, nzC() - 1);
  let c = cIdx(ci, cj, ck);
  let prev = xchU(off(47u) + c, p + 1u);
  stU(off(48u) + p, prev);      // 0 = end of chain
}
@compute @workgroup_size(64)
fn solve(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let pi = gid.x;
  if (pi >= U.dims.w || pFlag(pi) != 2u) { return; }
  let rad = U.misc.z * 0.6;
  let rad2 = rad * rad;
  let posI = pPos(pi);
  let velI = pVel(pi);
  let dx = dxC();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  let ci = clamp(i32(posI.x / dx), 0, nx - 1);
  let cj = clamp(i32(posI.y / dx), 0, ny - 1);
  let ck = clamp(i32(posI.z / dx), 0, nz - 1);
  let nxy = nx * ny;
  var budget = 96;
  var newVel = velI;
  var newPos = posI;
  for (var dk = -1; dk <= 1; dk++) {
    for (var dj = -1; dj <= 1; dj++) {
      for (var di = -1; di <= 1; di++) {
        let ii = ci + di; let jj = cj + dj; let kk = ck + dk;
        if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) { continue; }
        var cur = ldU(off(47u) + cIdx(ii, jj, kk));
        var guard = 0;
        while (cur != 0u && guard < 64) {
          guard++;
          let q = cur - 1u;
          cur = ldU(off(48u) + q);
          if (q <= pi) { continue; }              // each pair handled once
          if (budget <= 0) { break; }
          budget--;
          let posQ = pPos(q);
          let d3 = posQ - posI;
          if (abs(d3.x) >= rad) { continue; }
          let d2 = dot(d3, d3);
          if (d2 >= rad2) { continue; }
          let d = max(sqrt(d2), 1e-9);
          let n3 = d3 / d;
          let velQ = pVel(q);
          let vRel = dot(velI - velQ, n3);
          if (vRel > 0.0) {
            // approaching: equal masses swap the normal component; each
            // thread applies its own half of the exchange
            newVel = newVel - n3 * (vRel * 0.5);
          }
          // overlapping parcels ALWAYS repel (half per thread)
          let half = (rad - d) * 0.5;
          newPos = newPos - n3 * half;
          newVel = newVel - n3 * (rad - d);
        }
      }
    }
  }
  pVelW(pi, newVel);
  pPosW(pi, newPos);
}
`,

// ============================================================ density splat
splatDens: `
@compute @workgroup_size(4, 4, 4)
fn clear(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let n = i32(U.dims.x) + 1;
  if (i32(gid.x) >= n || i32(gid.y) >= n || i32(gid.z) >= n) { return; }
  let c = u32((gid.z * u32(n) + gid.y) * u32(n) + gid.x);
  stU(off(43u) + c, 0u);
}
@compute @workgroup_size(64)
fn splat(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let p = gid.x;
  if (p >= U.dims.w || pFlag(p) != 0u) { return; }
  let pos = pPos(p);
  let dx = dxC();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  let i0 = clamp(i32(floor(pos.x / dx)), 0, nx - 1);
  let j0 = clamp(i32(floor(pos.y / dx)), 0, ny - 1);
  let k0 = clamp(i32(floor(pos.z / dx)), 0, nz - 1);
  let fx = pos.x - f32(i0) * dx;
  let fy = pos.y - f32(j0) * dx;
  let fz = pos.z - f32(k0) * dx;
  let r = 1.6 * U.misc.z;
  let r2 = r * r;
  let sj = nx + 1;
  let sk = (ny + 1) * sj;
  for (var kk = 0; kk < 2; kk++) {
    let cz = select(fz, fz - dx, kk == 1);
    for (var jj = 0; jj < 2; jj++) {
      let cy = select(fy, fy - dx, jj == 1);
      for (var ii = 0; ii < 2; ii++) {
        let cx = select(fx, fx - dx, ii == 1);
        let d2 = cx * cx + cy * cy + cz * cz;
        if (d2 >= r2) { continue; }
        var ww = 1.0 - d2 / r2;
        ww = ww * ww;
        let idx = u32((k0 + kk) * sk + (j0 + jj) * sj + (i0 + ii));
        adU(off(43u) + idx, u32(ww * 65536.0));
      }
    }
  }
}
@compute @workgroup_size(64)
fn norm(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let n = i32(U.dims.x) + 1;
  let total = u32(n * n * n);
  let p = gid.x;
  if (p >= total) { return; }
  stF(off(42u) + p, f32(ldU(off(43u) + p)) / 65536.0);
}
`,

// ================================================== thermal (heat + conduction)
thermal: `
@compute @workgroup_size(4, 4, 4)
fn clear(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  if (i32(gid.x) >= nx || i32(gid.y) >= ny || i32(gid.z) >= nz) { return; }
  let c = cIdx(i32(gid.x), i32(gid.y), i32(gid.z));
  stU(off(44u) + c, 0u);   // hCnt
  stU(off(45u) + c, 0u);   // hSum
  stU(off(47u) + c, 0u);   // headC
  stF(off(51u) + c, 0.0);  // eaX
  stF(off(52u) + c, 0.0);  // eaY
  stF(off(53u) + c, 0.0);  // eaZ
}
@compute @workgroup_size(64)
fn bin(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let p = gid.x;
  if (p >= U.dims.w) { return; }
  let pos = pPos(p);
  let dx = dxC();
  let ci = clamp(i32(pos.x / dx), 0, nxC() - 1);
  let cj = clamp(i32(pos.y / dx), 0, nyC() - 1);
  let ck = clamp(i32(pos.z / dx), 0, nzC() - 1);
  let c = cIdx(ci, cj, ck);
  let prev = xchU(off(47u) + c, p + 1u);
  stU(off(48u) + p, prev);
  adU(off(44u) + c, 1u);
  adU(off(45u) + c, u32(pT(p) * 65536.0));
}
@compute @workgroup_size(64)
fn solar(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let p = gid.x;
  if (p >= U.dims.w) { return; }
  let dx = dxC();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  let pos = pPos(p);
  let fl = pFlag(p);
  var lit = 0.0;
  if (U.sun.w > 0.5) {
    // deep-water fast path: four fluid cells stacked overhead = opaque
    let e = pos - vec3<f32>(U.center.x, U.center.y, U.center.z);
    let dwl = max(length(e), 1e-9);
    let stpU = dx / dwl;
    var above = 0;
    for (var su = 1; su <= 4; su++) {
      let q = pos + e * (stpU * f32(su));
      let qi = i32(q.x / dx); let qj = i32(q.y / dx); let qk = i32(q.z / dx);
      if (qi < 0 || qj < 0 || qk < 0 || qi >= nx || qj >= ny || qk >= nz) { break; }
      if (typeAt(cIdx(qi, qj, qk)) != 1u) { break; }
      above++;
    }
    if (above < 4) {
      let ldir = U.sun.xyz - pos;
      let ld = max(length(ldir), 1e-9);
      let dn = ldir / ld;
      lit = 1.0;
      // planet shadow (analytic core + voxel terrain march)
      let b = dot(-e, dn);
      if (U.terrain2.z > 0.5) {
        let d2c = dot(e, e) - b * b;
        if (b > 0.0 && d2c < U.terrain.z * U.terrain.z * 0.96) {
          lit = 0.0;
        } else if (b > 0.0 || d2c < U.terrain2.x * U.terrain2.x * 1.1) {
          let stp = dx * 1.5;
          var q = pos;
          let esc2 = (U.terrain2.x + 0.1) * (U.terrain2.x + 0.1);
          for (var s2 = 0; s2 < 26; s2++) {
            q = q + dn * stp;
            let re = q - vec3<f32>(U.center.x, U.center.y, U.center.z);
            if (dot(re, re) > esc2) { break; }
            if (voxSolidAt(q.x, q.y, q.z)) { lit = 0.0; break; }
          }
        }
      } else if (b > 0.0) {
        let d2c2 = dot(e, e) - b * b;
        if (d2c2 < U.world.y * U.world.y) { lit = 0.0; }
      }
      if (lit > 0.0) {
        // water-column optical depth toward the sun
        var od = 0.0;
        var q = pos;
        let half = dx;
        for (var s3 = 0; s3 < 6 && f32(s3) * half < 0.55; s3++) {
          q = q + dn * half;
          let i0 = i32(q.x / dx); let j0 = i32(q.y / dx); let k0 = i32(q.z / dx);
          if (i0 < 0 || j0 < 0 || k0 < 0 || i0 >= nx || j0 >= ny || k0 >= nz) { break; }
          let sj = nx + 1;
          let sk = (ny + 1) * sj;
          let v = ldF(off(42u) + u32(k0 * sk + j0 * sj + i0));
          od += v * half * 1.1;
          if (od > 3.5) { break; }
        }
        if (od < 3.5) { lit = exp(-od); } else { lit = 0.0; }
      }
    }
  }
  // radiative exchange with space
  var T = pT(p);
  let Tamb = U.thermal.z;
  let sunPow = U.thermal.y;
  let dt = U.thermal2.z;
  if (fl == 2u) {
    let airAmb = select(0.06, Tamb + 0.18, lit > 0.05);
    let airK = select(1.2, 0.16 + (1.0 - lit) * 0.20, U.sun.w > 0.5);
    T = T + (airAmb - T) * airK * dt;
    if (lit > 0.0) { T += sunPow * 0.6 * lit * dt; }
  } else {
    T = T + (Tamb - T) * (U.thermal2.y + (1.0 - lit) * U.thermal2.x) * dt;
    if (lit > 0.0) { T += sunPow * lit * dt; }
  }
  pTW(p, clamp(T, 0.0, 1.15));
}
@compute @workgroup_size(4, 4, 4)
fn edges(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  if (i32(gid.x) >= nx || i32(gid.y) >= ny || i32(gid.z) >= nz) { return; }
  let i = i32(gid.x); let j = i32(gid.y); let k = i32(gid.z);
  let c = cIdx(i, j, k);
  let cnt = ldU(off(44u) + c);
  if (cnt == 0u) { return; }
  let nxy = nx * ny;
  let mean = f32(ldU(off(45u) + c)) / 65536.0 / f32(cnt);
  let alpha = U.thermal2.w;
  if (i < nx - 1) {
    let nb = c + 1u;
    let cn = ldU(off(44u) + nb);
    if (cn > 0u) {
      let meanN = f32(ldU(off(45u) + nb)) / 65536.0 / f32(cn);
      stF(off(51u) + c, alpha * f32(min(cnt, cn)) * (meanN - mean));
    }
  }
  if (j < ny - 1) {
    let nb = c + u32(nx);
    let cn = ldU(off(44u) + nb);
    if (cn > 0u) {
      let meanN = f32(ldU(off(45u) + nb)) / 65536.0 / f32(cn);
      stF(off(52u) + c, alpha * f32(min(cnt, cn)) * (meanN - mean));
    }
  }
  if (k < nz - 1) {
    let nb = c + u32(nxy);
    let cn = ldU(off(44u) + nb);
    if (cn > 0u) {
      let meanN = f32(ldU(off(45u) + nb)) / 65536.0 / f32(cn);
      stF(off(53u) + c, alpha * f32(min(cnt, cn)) * (meanN - mean));
    }
  }
}
@compute @workgroup_size(64)
fn apply(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let p = gid.x;
  if (p >= U.dims.w) { return; }
  let pos = pPos(p);
  let dx = dxC();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  let nxy = nx * ny;
  let ci = clamp(i32(pos.x / dx), 0, nx - 1);
  let cj = clamp(i32(pos.y / dx), 0, ny - 1);
  let ck = clamp(i32(pos.z / dx), 0, nz - 1);
  let c = cIdx(ci, cj, ck);
  let cnt = ldU(off(44u) + c);
  if (cnt == 0u) { return; }
  var delta = ldF(off(51u) + c) + ldF(off(52u) + c) + ldF(off(53u) + c);
  if (ci > 0) { delta -= ldF(off(51u) + c - 1u); }
  if (cj > 0) { delta -= ldF(off(52u) + c - u32(nx)); }
  if (ck > 0) { delta -= ldF(off(53u) + c - u32(nxy)); }
  let alpha = U.thermal2.w;
  let mean = f32(ldU(off(45u) + c)) / 65536.0 / f32(cnt);
  var T = pT(p);
  T += alpha * (mean - T) + delta / f32(cnt);
  pTW(p, clamp(T, 0.0, 1.15));
  // convection: buoyancy along the radial (outward = "up" on a planet)
  if (pFlag(p) == 0u) {
    let e = pos - vec3<f32>(U.center.x, U.center.y, U.center.z);
    let rl = max(length(e), 1e-9);
    let ab = 3.0 * (T - U.thermal.z) * U.thermal2.z / rl;
    pVelW(p, pVel(p) + e * ab);
  }
}
`,

// ============================================================== evaporation
evaporate: `
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  if (U.parity.y == 0u) { return; }
  let p = gid.x;
  if (p >= U.dims.w || pFlag(p) != 0u) { return; }
  let pos = pPos(p);
  let T = pT(p);
  let dx = dxC();
  let nx = nxC(); let ny = nyC(); let nz = nzC();
  let ci = clamp(i32(pos.x / dx), 1, nx - 2);
  let cj = clamp(i32(pos.y / dx), 1, ny - 2);
  let ck = clamp(i32(pos.z / dx), 1, nz - 2);
  let c = cIdx(ci, cj, ck);
  if (typeAt(c) != 1u) { return; }
  // surface-top: no fluid in the neighbouring cell along local "up"
  if (U.terrain2.w > 0.5) {
    let e = pos - vec3<f32>(U.center.x, U.center.y, U.center.z);
    let el = max(length(e), 1e-9);
    let q = pos + e / el * dx;
    let qi = i32(q.x / dx); let qj = i32(q.y / dx); let qk = i32(q.z / dx);
    if (qi < 0 || qj < 0 || qk < 0 || qi >= nx || qj >= ny || qk >= nz) { return; }
    if (typeAt(cIdx(qi, qj, qk)) == 1u) { return; }
  } else if (cj + 1 <= ny - 2 && typeAt(c + u32(nx)) == 1u) {
    return;
  }
  // exponential heat-gated probability (per-particle PCG stream)
  let span = max(U.evap.z, 0.15);
  var tau = (T - U.evap.x) / span;
  tau = clamp(tau, 0.0, 1.0);
  let prob = U.evap.w * 1.6 * U.thermal2.z * exp(5.0 * (tau - 1.0));
  var st = prngSeed(p);
  if (rnd01(&st) > prob) { return; }
  // evaporate: kick of random speed AND direction, mirrored above the horizon
  pFlagW(p, 2u);
  let kth = rnd01(&st) * 6.2831853;
  let kph = rnd01(&st) * 2.0 - 1.0;
  let h = 0.73 * tau;
  let ksp = (0.22 + 0.5 * h) * (0.6 + 0.8 * rnd01(&st));
  let ksq = sqrt(max(1.0 - kph * kph, 0.0));
  var k = vec3<f32>(ksq * cos(kth), kph, ksq * sin(kth)) * ksp;
  if (U.terrain2.w > 0.5) {
    let e2 = pos - vec3<f32>(U.center.x, U.center.y, U.center.z);
    let el2 = dot(e2, e2);
    let elL = sqrt(el2);
    let kUp = dot(k, e2) / el2;
    if (kUp < 0.0) { k = k - 2.0 * kUp * e2 / elL; }
  } else if (k.y < 0.0) {
    k.y = -k.y;
  }
  pVelW(p, pVel(p) + k);
  adU(off(49u) + 2u, 1u);
}
`,

// ================================================================= currents
currents: `
// build the coarse lattice of the divergence-free current field (analytic
// curl of a drifting sum-of-sines potential; wave constants live in S)
@compute @workgroup_size(4, 4, 4)
fn build(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let gn = U.latdims.xyz;
  if (i32(gid.x) >= i32(gn.x) || i32(gid.y) >= i32(gn.y) || i32(gid.z) >= i32(gn.z)) { return; }
  let gi = u32((gid.z * gn.y + gid.y) * gn.x + gid.x);
  let sx = dxC() * 4.0;
  let pp = vec3<f32>(gid.xyz) * sx;
  let t = U.times.x;
  var ux = 0.0; var uy = 0.0; var uz = 0.0;
  for (var o = 0; o < 3; o++) {
    let base = off(50u) + u32(o) * 16u;   // SRC: wave constants (12 vec4s)
    let dph = ldSrcF(base + 15u) * t;
    let w0 = vec4<f32>(ldSrcF(base), ldSrcF(base + 1u), ldSrcF(base + 2u), ldSrcF(base + 3u));
    let w1 = vec4<f32>(ldSrcF(base + 4u), ldSrcF(base + 5u), ldSrcF(base + 6u), ldSrcF(base + 7u));
    let w2 = vec4<f32>(ldSrcF(base + 8u), ldSrcF(base + 9u), ldSrcF(base + 10u), ldSrcF(base + 11u));
    let thx = w0.x * pp.x + w0.y * pp.y + w0.z * pp.z + dph + w0.w;
    let thy = w1.x * pp.x + w1.y * pp.y + w1.z * pp.z + dph + w1.w;
    let thz = w2.x * pp.x + w2.y * pp.y + w2.z * pp.z + dph + w2.w;
    ux += w2.w * w2.y * cos(thz) - w1.w * w1.z * cos(thy);
    uy += w0.w * w0.z * cos(thx) - w2.w * w2.x * cos(thz);
    uz += w1.w * w1.x * cos(thy) - w0.w * w0.y * cos(thx);
  }
  let amp = U.misc.y * 2.0;
  let ob = off(54u) + gi * 4u;            // B: current lattice
  stF(ob, ux * amp);
  stF(ob + 1u, uy * amp);
  stF(ob + 2u, uz * amp);
  stF(ob + 3u, 0.0);
}
@compute @workgroup_size(64)
fn relax(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let p = gid.x;
  if (p >= U.dims.w || pFlag(p) != 0u) { return; }
  let pos = pPos(p);
  let ctr = vec3<f32>(U.center.x, U.center.y, U.center.z);
  let e = pos - ctr;
  let rl = max(length(e), 1e-9);
  let shell = U.world.x - U.world.y;
  if (shell <= 0.0) { return; }
  let dpt = (U.world.x - rl) / shell;
  var wgt = (dpt - 0.06) * 4.0;
  if (wgt <= 0.0) { return; }
  wgt = min(wgt, 1.0);
  let gn = vec3<i32>(U.latdims.xyz);
  let sx = dxC() * 4.0;
  let qa = pos.x / sx; let qb = pos.y / sx; let qc = pos.z / sx;
  let i0 = clamp(i32(qa), 0, gn.x - 2);
  let j0 = clamp(i32(qb), 0, gn.y - 2);
  let k0 = clamp(i32(qc), 0, gn.z - 2);
  let ta = clamp(qa - f32(i0), 0.0, 1.0);
  let tb = clamp(qb - f32(j0), 0.0, 1.0);
  let tc = clamp(qc - f32(k0), 0.0, 1.0);
  let g0 = u32((k0 * gn.y + j0) * gn.x + i0);
  let gnx = u32(gn.x);
  let gxy = u32(gn.x * gn.y);
  let a0 = 1.0 - ta; let a1 = ta; let b0 = 1.0 - tb; let b1 = tb; let c0 = 1.0 - tc; let c1 = tc;
  var comps = array<f32, 3>(0.0, 0.0, 0.0);
  for (var cmp = 0; cmp < 3; cmp++) {
    let ob = off(54u) + g0 * 4u + u32(cmp);
    let v000 = ldF(ob);
    let v100 = ldF(ob + 4u);
    let v010 = ldF(ob + gnx * 4u);
    let v110 = ldF(ob + gnx * 4u + 4u);
    let v001 = ldF(ob + gxy * 4u);
    let v101 = ldF(ob + gxy * 4u + 4u);
    let v011 = ldF(ob + gxy * 4u + gnx * 4u);
    let v111 = ldF(ob + gxy * 4u + gnx * 4u + 4u);
    comps[cmp] = (v000 * a0 + v100 * a1) * b0 * c0
               + (v010 * a0 + v110 * a1) * b1 * c0
               + (v001 * a0 + v101 * a1) * b0 * c1
               + (v011 * a0 + v111 * a1) * b1 * c1;
  }
  let Uv = vec3<f32>(comps[0], comps[1], comps[2]);
  // strip the radial part: streams flow ALONG the shell
  let ir = 1.0 / rl;
  let Ur = dot(Uv, e) * ir;
  let Tv = (Uv - e * ir * Ur) * wgt;
  var vel = pVel(p);
  let vr = dot(vel, e) * ir;
  let vT = vel - e * ir * vr;
  var dvel = (Tv - vT) * min(2.2 * U.thermal2.z, 0.35);
  let dvCap = 0.15;
  let e2 = dot(dvel, dvel);
  if (e2 > dvCap * dvCap) { dvel = dvel * (dvCap / sqrt(e2)); }
  pVelW(p, vel + dvel);
}
`,

// ============================================================== impulses
impulse: `
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let p = gid.x;
  if (p >= U.dims.w) { return; }
  let mode = U.misc2.z;
  if (mode == 0u || mode > 4u) { return; }
  var pos = pPos(p);
  var vel = pVel(p);
  var st = prngSeed(p);
  if (mode == 1u) {
    // applyImpulseSphere: radial kick inside a sphere, demote to fluid
    let e = pos - U.impulse.xyz;
    let d2 = dot(e, e);
    if (d2 > U.impulse.w * U.impulse.w) { return; }
    let fall = 1.0 - sqrt(d2) / U.impulse.w;
    vel = vel + U.impulse2.xyz * fall;
    pFlagW(p, 0u);
    pCoolW(p, 0u);
    pVelW(p, vel);
    return;
  }
  if (mode == 2u) {
    // stirAt: drag a sphere of water with the cursor
    let e = pos - U.impulse.xyz;
    let d2 = dot(e, e);
    let R = U.impulse.w;
    if (d2 > R * R) { return; }
    let fall = 1.0 - sqrt(d2) / R;
    let k = min(1.0, 14.0 * U.impulse2.w);
    vel = vel + (U.impulse2.xyz * 1.25 - vel) * k * fall;
    pFlagW(p, 0u);
    pVelW(p, vel);
    return;
  }
  if (mode == 3u) {
    // tide: radially outward bulge strongest facing the bulge direction
    let ctr = vec3<f32>(U.center.x, U.center.y, U.center.z);
    let e = pos - ctr;
    let er = max(length(e), 1e-9);
    let u1 = rnd01(&st) * 2.0 - 1.0;
    let th = rnd01(&st) * 6.2831853;
    let sq = sqrt(max(1.0 - u1 * u1, 0.0));
    let dir = vec3<f32>(sq * cos(th), u1, sq * sin(th));
    let pr = dot(e, dir) / er;
    if (pr <= 0.0) { return; }
    let f = pr * pr * pr * (0.7 + 0.3 * rnd01(&st));
    vel = vel + e / er * (U.impulse2.x * f);
    pVelW(p, vel);
    return;
  }
  if (mode == 4u) {
    // pool waveImpulse: push the -x half in +x
    if (pos.x >= U.sizes.y * 0.4) { return; }
    vel.x += U.impulse2.x * (0.7 + 0.3 * rnd01(&st));
    pVelW(p, vel);
    return;
  }
}
`,

// ======================================================== counter clear
counters: `
@compute @workgroup_size(64)
fn clear(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  if (gid.x < 6u) { stU(off(49u) + gid.x, select(0u, 0xFFFFFFFFu, gid.x == 4u)); }
}
// live water temperature range for the evaporation probability curve
@compute @workgroup_size(64)
fn evapRange(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let p = gid.x;
  if (p >= U.dims.w || pFlag(p) == 2u) { return; }
  let q = u32(clamp(pT(p), 0.0, 2.0) * 65536.0);
  let o = off(49u);
  atomicMin(&BP[o + 4u], q);
  atomicMax(&BP[o + 5u], q);
}
`,

// ============================================== snapshot old grid (FLIP)
copyOld: `
fn cp(oF: u32, oO: u32, n: u32, g: vec3<u32>) {
  let p = g.x;
  if (p >= n) { return; }
  stF(oO + p, ldF(oF + p));
}
@compute @workgroup_size(64) fn mainU(@builtin(global_invocation_id) g: vec3<u32>) { touch(); cp(off(8u), off(12u), u32(U.counts.x), g); }
@compute @workgroup_size(64) fn mainV(@builtin(global_invocation_id) g: vec3<u32>) { touch(); cp(off(9u), off(13u), u32(U.counts.y), g); }
@compute @workgroup_size(64) fn mainW(@builtin(global_invocation_id) g: vec3<u32>) { touch(); cp(off(10u), off(14u), u32(U.counts.z), g); }
`,

// ====================================================== ball velocity probe
// Fluid velocity at each ball center, for the CPU ball integrator's drag.
ballProbe: `
@compute @workgroup_size(4)
fn probe(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let b = gid.x;
  if (b >= U.misc2.y) { return; }
  let bp = U.balls[b * 2u].xyz;
  let v = sampleVel3(bp.x, bp.y, bp.z);
  let o = off(49u) + 8u + b * 4u;   // ballProbe region follows cnt (8 words)
  stF(o, v.x); stF(o + 1u, v.y); stF(o + 2u, v.z); stF(o + 3u, 0.0);
}
`,
};

global.GpuShaders = { PRELUDE: PRELUDE, PARTS: SHADERS };
if (typeof module !== 'undefined' && module.exports) module.exports = { PRELUDE: PRELUDE, PARTS: SHADERS };
})(typeof window !== 'undefined' ? window : globalThis);
