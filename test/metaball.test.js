/*
 * Headless checks for the metaball water display:
 *   - Metaballs.build contours the particle field with the marching-tets
 *     mesher: watertight triangles, finite positions/normals, deterministic
 *   - tension drives the kernel radius: higher tension merges/swells the
 *     skin (monotone volume growth) and lifts the contour level
 *   - the optional detail argument (tessellation slider) scales the metaball
 *     field's OWN corner lattice: omitted/NaN/non-positive === detail 1 is
 *     bit-for-bit today's build; 0.6 marches fewer verts, 1.4 more, with the
 *     volume conserved; absurd values clamp to the sane 0.5..1.6 range
 *   - the field ignores non-liquid particles (pflag !== 0)
 *   - empty / tiny solvers produce an empty mesh, not a crash
 *   - scene integration: setMetaballs toggles mesh visibility + hides the
 *     water surface, updateMetaballs rebinds draw ranges, liquid beads are
 *     suppressed while metaballs are on
 * Real GL is not available headlessly; the scene is exercised on the real
 * prototype with minimal mesh stubs (see scene_fx.test.js for the pattern).
 */
'use strict';
const assert = require('node:assert/strict');
const g = (typeof window !== 'undefined') ? window : globalThis;

const Surface = require('../js/surface.js');
const Metaballs = Surface.Metaballs;
assert.ok(Metaballs && Metaballs.build && Metaballs.iso, 'surface.js exports Metaballs');

// -------------------------------------------------------------- field checks
// A 16³ solver stub with the solver's real particle/grid ratio: liquid
// particles packed at one-particle-spacing intervals (spacing = dx/4 here,
// like the shipped presets' ~3.8 particles per cell).
const n = 16, dx = 1 / n, sp = dx * 0.25;
function stubSolver(px, py, pz, flag) {
  const nP = px.length;
  return {
    nx: n, ny: n, nz: n, dx: dx, W: n * dx, H: n * dx, D: n * dx,
    spacing: sp, nP: nP,
    px: Float32Array.from(px), py: Float32Array.from(py), pz: Float32Array.from(pz),
    pflag: Int8Array.from(flag || new Int8Array(nP).fill(0))
  };
}
// 7³ block of particles centred in the domain, one spacing apart
const part = [];
for (let k = 0; k < 7; k++) for (let j = 0; j < 7; j++) for (let i = 0; i < 7; i++) {
  part.push((0.5 - 3 * sp) + i * sp, (0.5 - 3 * sp) + j * sp, (0.5 - 3 * sp) + k * sp);
}
const solver = stubSolver(...[0, 1, 2].map(i => part.filter((_, q) => q % 3 === i)));

const low = Metaballs.build(solver, 0);
assert.ok(low.count > 0 && low.count % 3 === 0, 'metaball mesh has triangles');
assert.ok(low.volume > 0, 'metaball mesh encloses volume');
for (let v = 0; v < low.count * 3; v++) assert(Number.isFinite(low.pos[v]) && Number.isFinite(low.nrm[v]), 'finite vertices');
for (let v = 0; v < low.count; v++) {
  const p = v * 3;
  assert(Math.abs(Math.hypot(low.nrm[p], low.nrm[p + 1], low.nrm[p + 2]) - 1) < 1e-5, 'unit normals');
  // normals point outward from the field gradient (away from the blob centre)
  assert((low.pos[p] - 0.5) * low.nrm[p] + (low.pos[p + 1] - 0.5) * low.nrm[p + 1] + (low.pos[p + 2] - 0.5) * low.nrm[p + 2] > -0.5, 'outward normals');
}
const again = Metaballs.build(solver, 0);
assert.equal(again.count, low.count, 'deterministic build');
assert.equal(again.pos, low.pos, 'mesher scratch reused');

// tension swells the metaball (kernel radius drives merging + skin thickness)
let prev = -1;
for (const t of [0, 0.25, 0.5, 0.75, 1]) {
  const m = Metaballs.build(solver, t);
  assert.ok(m.volume > 0, 'mesh exists at tension ' + t);
  assert.ok(m.volume > prev, 'volume grows with tension (' + t + '): ' + m.volume + ' > ' + prev);
  prev = m.volume;
}
// the contour level itself rises with tension (documented mapping)
assert.ok(Metaballs.iso(0) < Metaballs.iso(0.5) && Metaballs.iso(0.5) < Metaballs.iso(1), 'iso rises with tension');
assert.equal(Metaballs.iso(1), Metaballs.iso(2), 'tension clamps above 1');
assert.equal(Metaballs.iso(0), Metaballs.iso(-1), 'tension clamps below 0');

// ------------------------------------------------- tessellation detail slider
// build's optional third argument scales the metaball field's OWN corner
// lattice around the solver lattice; kernel radius and iso are expressed in
// world units, so the skin's shape carries over and only the discretization
// moves. Omitted / NaN / non-positive detail is EXACTLY today's build.
const omitted = Metaballs.build(solver, 0.5);
const d1 = Metaballs.build(solver, 0.5, 1);
assert.equal(d1.count, omitted.count, 'explicit detail 1 matches the 2-argument build');
assert.equal(d1.volume, omitted.volume, 'explicit detail 1 volume is bit-identical');
for (const bad of [undefined, NaN, 0, -2, null, 'x']) {
  const m = Metaballs.build(solver, 0.5, bad);
  assert.equal(m.count, omitted.count, 'detail ' + String(bad) + ' falls back to 1');
  assert.equal(m.volume, omitted.volume, 'detail ' + String(bad) + ' volume bit-identical to detail 1');
}

// Coarse vs fine on a fuller body (11³ block ≈ 70% of the domain, tension 1
// fattens the sub-cell kernels so even the coarse lattice still sees them):
// the coarse lattice marches fewer cells, the fine one more, while both keep
// the factor-1.0 volume (the field is a point sample of one continuous
// field — coarse lattices undersample it, hence the ±15% band).
const bigPart = [];
for (let k = 0; k < 11; k++) for (let j = 0; j < 11; j++) for (let i = 0; i < 11; i++) {
  bigPart.push((0.5 - 5 * sp) + i * sp, (0.5 - 5 * sp) + j * sp, (0.5 - 5 * sp) + k * sp);
}
const ocean = stubSolver(...[0, 1, 2].map(i => bigPart.filter((_, q) => q % 3 === i)));
const body1 = Metaballs.build(ocean, 1, 1);
const coarse = Metaballs.build(ocean, 1, 0.6);
const fine = Metaballs.build(ocean, 1, 1.4);
assert.ok(coarse.count > 0 && coarse.count < body1.count,
  'coarse detail marches fewer verts: ' + coarse.count + ' < ' + body1.count);
assert.ok(Math.abs(coarse.volume - body1.volume) / body1.volume < 0.15,
  'coarse detail conserves volume (±15%): ' + (100 * coarse.volume / body1.volume).toFixed(1) + '%');
assert.ok(fine.count > body1.count,
  'fine detail adds verts: ' + fine.count + ' > ' + body1.count);
assert.ok(Math.abs(fine.volume - body1.volume) / body1.volume < 0.15,
  'fine detail conserves volume (±15%): ' + (100 * fine.volume / body1.volume).toFixed(1) + '%');
assert.equal(fine.count % 3, 0, 'fine mesh is whole triangles');
for (let v = 0; v < fine.count; v++) {
  const p = v * 3;
  assert(Number.isFinite(fine.pos[p]) && Number.isFinite(fine.nrm[p]) &&
    Math.abs(Math.hypot(fine.nrm[p], fine.nrm[p + 1], fine.nrm[p + 2]) - 1) < 1e-5,
    'fine-lattice mesh stays finite with unit normals');
}
const fineAgain = Metaballs.build(ocean, 1, 1.4);
assert.equal(fineAgain.count, fine.count, 'fine-lattice build is deterministic');
assert.equal(fineAgain.pos, fine.pos, 'fine-lattice build reuses the mesher scratch');

// clamping: absurd slider values fold onto the sane 0.5..1.6 range instead of
// exploding the corner lattice (corner memory grows with mdims³)
const clampedHi = Metaballs.build(solver, 0.5, 999);
const atMax = Metaballs.build(solver, 0.5, 1.6);
assert.equal(clampedHi.count, atMax.count, 'detail 999 clamps to the 1.6 ceiling');
assert.equal(clampedHi.volume, atMax.volume, 'clamped ceiling reproduces factor 1.6');
const clampedLo = Metaballs.build(solver, 0.5, 0.01);
const atMin = Metaballs.build(solver, 0.5, 0.5);
assert.equal(clampedLo.count, atMin.count, 'detail 0.01 clamps to the 0.5 floor');
assert.equal(clampedLo.volume, atMin.volume, 'clamped floor reproduces factor 0.5');

// tension monotonicity survives on a non-default tessellation lattice
prev = -1;
for (const t of [0, 0.25, 0.5, 0.75, 1]) {
  const m = Metaballs.build(solver, t, 1.4);
  assert.ok(m.volume > prev, 'volume grows with tension at detail 1.4 (' + t + '): ' + m.volume + ' > ' + prev);
  prev = m.volume;
}

// non-liquid particles contribute nothing
const mixed = stubSolver(...[0, 1, 2].map(i => part.filter((_, q) => q % 3 === i)),
  part.length / 3 === 343 ? new Int8Array(343) : null);
const flag = new Int8Array(solver.nP).fill(2);   // all vapor
const vaporOnly = Metaballs.build(stubSolver(solver.px, solver.py, solver.pz, flag), 0.5);
assert.equal(vaporOnly.count, 0, 'vapor/spray never enter the metaball field');
const half = Int8Array.from(solver.pflag);
for (let p = 0; p < half.length; p++) half[p] = p % 2 ? 2 : 0;
const halfMesh = Metaballs.build(stubSolver(solver.px, solver.py, solver.pz, half), 0);
assert.ok(halfMesh.count > 0, 'half-liquid field still contours');
assert.ok(halfMesh.volume < low.volume, 'dropping half the liquid shrinks the metaball');

// empty solver → empty mesh
const empty = Metaballs.build(stubSolver([], [], []), 0.5);
assert.equal(empty.count, 0, 'no particles → no triangles');
// particles outside the lattice clamp safely instead of corrupting memory
const strays = stubSolver([5 * dx, -3 * dx, n * dx * 2], [5 * dx, 5 * dx, 5 * dx], [5 * dx, 5 * dx, 5 * dx]);
const strayMesh = Metaballs.build(strays, 0.5);
for (let v = 0; v < strayMesh.count * 3; v++) assert(Number.isFinite(strayMesh.pos[v]), 'stray-particle build stays finite');

// ---------------------------------------------------- scene integration
// Minimal THREE stubs (only what these code paths touch), real prototype.
class BufferAttribute {
  constructor(arr, i) { this.array = arr; this.itemSize = i; this.updateRange = { offset: 0, count: 0 }; }
  setUsage() { return this; }
}
class BufferGeometry {
  constructor() { this.attrs = {}; this._draw = [0, Infinity]; }
  setAttribute(n, a) { this.attrs[n] = a; return this; }
  getAttribute(n) { return this.attrs[n]; }
  setDrawRange(o, c) { this._drawRange = [o, c]; return this; }
}
class Mesh { constructor(geo, mat) { this.geometry = geo; this.material = mat; this.visible = true; this.frustumCulled = true; } }
// value-carrying Color so the editor's color/emissive math is observable
class Color {
  constructor(v) { this.set(v === undefined ? 0 : v); }
  set(v) {
    if (v && typeof v === 'object') { this.r = v.r; this.g = v.g; this.b = v.b; }
    else if (typeof v === 'number') {
      this.r = ((v >> 16) & 255) / 255; this.g = ((v >> 8) & 255) / 255; this.b = (v & 255) / 255;
    } else if (typeof v === 'string') { this.set(parseInt(v.replace('#', ''), 16) || 0); }
    return this;
  }
  multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; }
  clone() { return new Color(0).set(this); }
  copy(c) { return this.set(c); }
  getHex() {
    return (Math.round(this.r * 255) << 16) | (Math.round(this.g * 255) << 8) | Math.round(this.b * 255);
  }
}
class MaterialStub {
  constructor(o) {
    Object.assign(this, o || {});
    this.userData = {}; this.disposed = 0;
    // mirror real three: numeric constructor params are coerced into Colors
    if (typeof this.color === 'number') this.color = new Color(this.color);
    if (typeof this.emissive === 'number') this.emissive = new Color(this.emissive);
  }
  dispose() { this.disposed++; }
}
class MeshPhysicalMaterial extends MaterialStub { constructor(o) { super(o); this.isMeshPhysicalMaterial = true; this.type = 'MeshPhysicalMaterial'; } }
class MeshLambertMaterial extends MaterialStub { constructor(o) { super(o); this.isMeshLambertMaterial = true; this.type = 'MeshLambertMaterial'; } }
class MeshBasicMaterial extends MaterialStub { constructor(o) { super(o); this.isMeshBasicMaterial = true; this.type = 'MeshBasicMaterial'; } }
g.THREE = Object.assign(g.THREE || {}, {
  BufferAttribute, BufferGeometry, Mesh, Color,
  MeshPhysicalMaterial, MeshLambertMaterial, MeshBasicMaterial,
  DynamicDrawUsage: 1
});
const WaterScene = require('../js/scene.js');
const fs = fakeScene();
function fakeScene() {
  const group = { add() {}, remove() {} };
  const s = Object.assign(Object.create(WaterScene.prototype), {
    planetGroup: group,
    waterColor: new THREE.Color(0x9fd4ee),
    waterMat: new THREE.MeshPhysicalMaterial({
      opacity: 0.25, color: new THREE.Color(0x9fd4ee),
      emissive: new THREE.Color(0x9fd4ee).multiplyScalar(0.24),
      roughness: 0.05, clearcoat: 1.0
    }),
    waterGeo: new THREE.BufferGeometry(),
    waterMesh: new THREE.Mesh(new THREE.BufferGeometry()),
    _waterTime: { value: 0 },
    // editor state exactly as the WaterScene constructor seeds it
    _mblaShading: 'physical', _mblaTex: 'none', _mblaFollowWater: true,
    _mblaOpacity: 0.25, metaballGloss: 0.95,
    _mblaColor: new THREE.Color(0x9fd4ee),
    _mblaTexU: { uMblaNoise: { value: 0 }, uMblaCaustic: { value: 0 }, uMblaStripes: { value: 0 } }
  });
  // the constructor's seed path: the scene's own seeding method (water's
  // exact parameters + the metaball shader patch attached)
  s.metaballMat = s._seedMetaballMaterial();
  return s;
}
// constructor-style creation of the metaball pair without a real renderer:
fs.metaballMode = false;
fs.metaballGeo = new THREE.BufferGeometry();
fs.metaballMesh = new THREE.Mesh(fs.metaballGeo, fs.metaballMat);
assert.notEqual(fs.metaballMesh.material, fs.waterMat, 'metaball skin has its own material instance (not waterMat)');
assert.equal(fs.metaballMesh.material.isMeshPhysicalMaterial, true, 'seeded skin material is a MeshPhysicalMaterial');
assert.equal(fs.metaballMat.color.getHex(), fs.waterMat.color.getHex(), 'seeded skin color matches the water');
assert.equal(fs.metaballMat.opacity, fs.waterMat.opacity, 'seeded skin opacity matches the water');
assert.equal(fs.metaballMat.roughness, fs.waterMat.roughness, 'seeded skin roughness matches the water');
assert.equal(fs.metaballMat.clearcoat, fs.waterMat.clearcoat, 'seeded skin clearcoat matches the water');
assert.ok(fs.metaballMat.userData.metaballPatch && fs.metaballMat.userData.metaballPatch.patched,
  'seeded skin material carries the metaball shader patch (userData observability)');
fs.waterMesh = fs.metaballMesh;   // reuse one stub mesh to observe visibility routing

fs.setBeadsMode(true);
assert.equal(fs.waterMesh.visible, false, 'beads mode alone hides the surface mesh');
fs.setMetaballs(true);
assert.equal(fs.metaballMode, true, 'metaball mode stored');
assert.equal(fs.waterMesh.visible, false, 'metaball mode keeps the isosurface mesh hidden');
fs.updateMetaballs(low.pos, low.nrm, 3);
assert.deepEqual(fs.metaballGeo._drawRange, [0, 3], 'metaball draw range follows the build');
fs.setMetaballs(false);
assert.equal(fs.waterMesh.visible, false, 'leaving metaball mode returns to beads mode (surface still hidden)');
assert.deepEqual(fs.metaballGeo._drawRange, [0, 0], 'stale metaball draw range is cleared');
fs.setBeadsMode(false);
assert.equal(fs.waterMesh.visible, true, 'metaball off + beads off shows the surface again');
fs.setMetaballs(true);
assert.equal(fs.waterMesh.visible, false, 're-enabling metaballs hides the surface');
fs.setBeadsMode(false);   // beads flag must not fight metaball visibility
assert.equal(fs.waterMesh.visible, false, 'surface stays hidden in metaball mode regardless of beads');

// liquid beads are suppressed while the metaball skin draws (updateParticles)
{
  const fs2 = fakeScene();
  fs2.metaballMode = true;
  // minimal particle system attrs used by updateParticles
  fs2.allPts = { visible: false };
  fs2.allGeo = new THREE.BufferGeometry();
  fs2.allGeo.setDrawRange(0, 0);
  fs2._classCounts = { beads: 0, spray: 0, vapor: 0, cloud: 0, snow: 0 };
  fs2.pPos = new Float32Array(0);
  fs2.waterColor = new THREE.Color('#9fd4ee');
  fs2._sunDirLocal = { x: 0, y: 1, z: 0 };
  fs2._camLocal = { set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
  fs2._planetLit = false; fs2.W = 1; fs2.H = 1; fs2.D = 1;
  fs2.waterOpa = 0.25; fs2.beadsMode = true; fs2.pOpa = 0;
  const one = stubSolver([0.5], [0.5], [0.5]);   // one liquid particle
  fs2.updateParticles(one, true);
  assert.equal(fs2.allPts.visible, false, 'metaball mode suppresses liquid bead circles');
  fs2.metaballMode = false;
  fs2.updateParticles(one, true);
  assert.equal(fs2.allPts.visible, true, 'beads return when metaballs switch off');
}

// ------------------------------------------------- metaball material editor
// setMetaballMaterial drives the skin's OWN material; waterMat is untouched.
{
  const fs3 = fakeScene();
  fs3.metaballMode = false;
  fs3.metaballGeo = new THREE.BufferGeometry();
  fs3.metaballMesh = new THREE.Mesh(fs3.metaballGeo, fs3.metaballMat);
  const wm = fs3.waterMat;
  const wmHex = wm.color.getHex(), wmOpa = wm.opacity;

  // color / emissive / opacity / gloss round-trip on the live instance
  fs3.setMetaballMaterial({ color: '#ff8800', opacity: 0.7, gloss: 0.25 });
  assert.equal(fs3.metaballMat.color.getHex(), 0xff8800, 'editor color lands on the skin');
  // emissive = color · 0.24 (the water's self-tint rule): r 255·0.24 = 0.24,
  // g 136·0.24 ≈ 0.128, b 0
  assert.ok(Math.abs(fs3.metaballMat.emissive.r - 0.24) < 1e-9 &&
            Math.abs(fs3.metaballMat.emissive.g - 136 / 255 * 0.24) < 1e-9 &&
            Math.abs(fs3.metaballMat.emissive.b) < 1e-9, 'emissive follows color·0.24');
  assert.equal(fs3.metaballMat.opacity, 0.7, 'editor opacity lands on the skin');
  assert.equal(fs3.metaballMat.transparent, true, 'skin stays alpha-blended');
  assert.ok(Math.abs(fs3.metaballMat.roughness - 0.75) < 1e-9 &&
            Math.abs(fs3.metaballMat.clearcoat - 0.25) < 1e-9, 'gloss maps to roughness=1−g, clearcoat=g');
  assert.equal(fs3.metaballGloss, 0.25, 'gloss state is stored for shading swaps');
  // clamping: out-of-range editor values fold onto 0..1
  fs3.setMetaballMaterial({ opacity: 5, gloss: -3 });
  assert.equal(fs3.metaballMat.opacity, 1, 'opacity clamps to 1');
  assert.equal(fs3.metaballGloss, 0, 'gloss clamps to 0');
  // unknown texture type falls back to none, known ones gate their layer
  fs3.setMetaballMaterial({ texture: 'caustic' });
  assert.equal(fs3._mblaTexU.uMblaCaustic.value, 1, 'caustic gate flips');
  assert.equal(fs3._mblaTexU.uMblaNoise.value, 0, 'noise gate stays off');
  assert.equal(fs3._mblaTexU.uMblaStripes.value, 0, 'stripe gate stays off');
  fs3.setMetaballMaterial({ texture: 'wat' });
  assert.equal(fs3._mblaTex, 'caustic', 'unknown texture type is ignored (current type kept)');
  assert.equal(fs3._mblaTexU.uMblaCaustic.value, 1, 'ignored type leaves the gates unchanged');
  fs3.setMetaballMaterial({ texture: 'none' });
  assert.equal(fs3._mblaTexU.uMblaCaustic.value, 0, 'none clears the gates');

  // follow-water rule: color follows the picker until the user picks one
  const fs4 = fakeScene();
  fs4.metaballGeo = new THREE.BufferGeometry();
  fs4.metaballMesh = new THREE.Mesh(fs4.metaballGeo, fs4.metaballMat);
  fs4.setWaterColor('#123456');
  assert.equal(fs4.metaballMat.color.getHex(), 0x123456, 'skin follows setWaterColor while unfollowed-by-editor');
  assert.equal(fs4.waterMat.color.getHex(), 0x123456, 'water picker still drives waterMat');
  fs4.setMetaballMaterial({ color: '#00ff00' });   // user pick → detach
  fs4.setWaterColor('#0000ff');
  assert.equal(fs4.metaballMat.color.getHex(), 0x00ff00, 'picked skin color survives water picker changes');
  assert.equal(fs4.waterMat.color.getHex(), 0x0000ff, 'water surface keeps following the picker');

  // the editor never touches the water surface material
  fs3.setMetaballMaterial({ color: '#abcdef', opacity: 0.11, gloss: 0.5 });
  assert.equal(wm.color.getHex(), wmHex, 'editor color calls leave waterMat untouched');
  assert.equal(wm.opacity, wmOpa, 'editor opacity calls leave waterMat untouched');
  assert.equal(wm.roughness, 0.05, 'editor gloss calls leave waterMat untouched');

  // shading-model swaps: right class, state carried, old instance disposed
  const phys = fs3.metaballMat;
  fs3.setMetaballMaterial({ shading: 'matte' });
  assert.equal(fs3.metaballMat.isMeshLambertMaterial, true, 'matte swap produces MeshLambertMaterial');
  assert.equal(fs3.metaballMesh.material, fs3.metaballMat, 'mesh points at the swapped-in material');
  assert.ok(phys.disposed >= 1, 'swapped-out physical material is disposed');
  assert.equal(fs3.metaballMat.color.getHex(), 0xabcdef, 'swap carries the editor color over');
  assert.equal(fs3.metaballMat.opacity, 0.11, 'swap carries the opacity over');
  assert.equal(fs3.metaballGloss, 0.5, 'gloss state survives the swap');
  fs3.setMetaballMaterial({ shading: 'unlit' });
  assert.equal(fs3.metaballMat.isMeshBasicMaterial, true, 'unlit swap produces MeshBasicMaterial');
  fs3.setMetaballMaterial({ shading: 'physical' });
  assert.equal(fs3.metaballMat.isMeshPhysicalMaterial, true, 'swap back produces MeshPhysicalMaterial');
  assert.ok(Math.abs(fs3.metaballMat.roughness - 0.5) < 1e-9 &&
            Math.abs(fs3.metaballMat.clearcoat - 0.5) < 1e-9, 'stored gloss re-applies on the physical swap');
  assert.equal(fs3.metaballMat.userData.metaballPatch.ripple, true, 'ripple patch returns with physical');
  assert.equal(fs3._mblaShading, 'physical', 'shading state stored');

  // unknown shading values are ignored (material keeps its class)
  const keep = fs3.metaballMat;
  fs3.setMetaballMaterial({ shading: 'glossy' });
  assert.equal(fs3.metaballMat, keep, 'unknown shading value keeps the live material');
  assert.equal(fs3._mblaShading, 'physical', 'unknown shading value is not stored');

  // the mesh stays buildable after editor + swap churn
  fs3.setBeadsMode(true);
  fs3.setMetaballs(true);
  fs3.updateMetaballs(low.pos, low.nrm, 3);
  assert.deepEqual(fs3.metaballGeo._drawRange, [0, 3], 'metaball build feeds the skin after editor churn');
  fs3.setMetaballs(false);
}

console.log('ALL METABALL TESTS PASSED');