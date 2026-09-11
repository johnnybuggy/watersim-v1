/*
 * Headless checks for the scene FX added with motion blur + starfield:
 *   - setMotionBlur clamps and allocates/frees the blend buffers
 *   - render() routes through scene-RT → blend → screen and ping-pongs history
 *   - setStars visibility/brightness paths
 * Real GL is not available headlessly; a minimal THREE stub records the
 * render-target sequence instead. The fake derives from the real prototype so
 * internal this._method() calls resolve.
 */
'use strict';
const assert = require('node:assert/strict');
const g = (typeof window !== 'undefined') ? window : globalThis;

// ---- minimal THREE stub (only what these code paths touch) -------------------
class BufferAttribute { constructor(arr, n) { this.array = arr; this.itemSize = n; } }
class BufferGeometry {
  constructor() { this.attrs = {}; }
  setAttribute(name, a) { this.attrs[name] = a; return this; }
  setIndex() { return this; }
}
class RawShaderMaterial { constructor(o) { Object.assign(this, o); } }
class WebGLRenderTarget {
  constructor(w, h, o) { this.width = w; this.height = h; this.opts = o || {}; this.texture = { encoding: null }; this.disposed = false; }
  dispose() { this.disposed = true; }
}
class SceneStub { add() {} }
class Mesh { constructor() { this.frustumCulled = true; } }
class OrthographicCamera {}

g.THREE = Object.assign(g.THREE || {}, {
  BufferAttribute, BufferGeometry, RawShaderMaterial, WebGLRenderTarget,
  Scene: SceneStub, Mesh, OrthographicCamera,
  LinearFilter: 1006, RGBAFormat: 1023, sRGBEncoding: 3001
});
const WaterScene = require('../js/scene.js');

function fakeScene() {
  const rtLog = [];   // render(scene) entries: {scene: 'main'|'quad'}
  return Object.assign(Object.create(WaterScene.prototype), {
    rtLog,
    renderer: {
      domElement: { width: 800, height: 600 },
      setRenderTarget(rt) { rtLog.target = rt; },
      render(sceneArg) { rtLog.push({ scene: sceneArg.isMain ? 'main' : 'quad' }); }
    },
    scene: { isMain: true }, camera: {}, time: 0,
    orbit: { update() {} }, _waterTime: { value: 0 },
    _starGroup: { visible: true }, _starBrightness: 1, _starsOn: true,
    _starLayers: [
      { mat: { opacity: 0.5, color: { setScalar(v) { this.s = v; } } }, base: 0.5, phase: 0, speed: 1, tw: 0.12 }
    ]
  });
}

// 1. blur lifecycle: clamping + lazy allocation / disposal
const s = fakeScene();
s._initBlur();
assert.ok(s._blur && s._blur.amount === 0, 'blur starts off');
s.setMotionBlur(2.5);
assert.equal(s._blur.amount, 0.95, 'damp clamps to 0.95');
assert.equal(s._blur.rtScene, null, 'buffers stay free while off');
s.setMotionBlur(-1);
assert.equal(s._blur.amount, 0, 'negative clamps to off');
s.setMotionBlur(0.7);
assert.equal(s._blur.amount, 0.7, 'damp stored');

// 2. render() routing + history ping-pong
s.render(1 / 60);
assert.equal(s.rtLog.length, 3, 'three render passes when blur on');
assert.equal(s.rtLog[0].scene, 'main', 'pass 1 renders the main scene');
assert.equal(s.rtLog[1].scene, 'quad', 'pass 2 is the blend quad');
assert.equal(s.rtLog[2].scene, 'quad', 'pass 3 blits history to screen');
assert.ok(s._blur.rtScene, 'buffers allocated on first blurred frame');
const A1 = s._blur.rtA, B1 = s._blur.rtB;
s.render(1 / 60);
assert.equal(s._blur.rtA, B1, 'history ping-pongs (B becomes A)');
assert.equal(s._blur.rtB, A1, 'old A becomes the write target');

// 3. buffer rebuild on resize
s.renderer.domElement.width = 1024;
s.render(1 / 60);
assert.equal(s._blur.rtScene.width, 1024, 'buffers rebuild at new size');

// 4. disable frees buffers and drops back to a single direct pass
const old = [s._blur.rtScene, s._blur.rtA, s._blur.rtB];
s.setMotionBlur(0);
old.forEach(rt => assert.ok(rt.disposed, 'buffers disposed on disable'));
s.rtLog.length = 0;
s.render(1 / 60);
assert.equal(s.rtLog.length, 1, 'off → exactly one pass');
assert.equal(s.rtLog[0].scene, 'main', 'off → direct main-scene render');

// 5. starfield visibility + brightness
s.setStars(false, 1.4);
assert.equal(s._starGroup.visible, false, 'stars hide');
assert.equal(s._starLayers[0].mat.color.s, 1.4, 'brightness multiplies color');
s.setStars(true, 5);
assert.equal(s._starLayers[0].mat.color.s, 2, 'brightness clamps to 2');
assert.equal(s._starGroup.visible, true, 'stars show again');

// 6. blend math sanity (mirrors the fragment shader): max(cur, prev*damp)
let prev = 1.0, cur = 0.0;
for (let i = 0; i < 200; i++) { prev = Math.max(cur, prev * 0.9); }
assert.ok(prev < 1e-6, 'trail decays to zero (no feedback blow-up)');
const cur2 = 0.5;
assert.ok(Math.max(cur2, prev * 0.9) >= cur2, 'current frame never dimmed by history');

// 7. combined sorted particle system: all classes share one camera-sorted
//    draw list with per-particle sprite tiles; rain (4) joins the spray path;
//    far particles are drawn BEFORE near ones regardless of class
{
  // tiny math stubs for the camera-space depth computation
  if (!g.THREE.Vector3) {
    g.THREE.Vector3 = class { setFromMatrixPosition(m) { this.x = m.elements[12]; this.y = m.elements[13]; this.z = m.elements[14]; return this; }
      copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
      applyMatrix4(m) { this.x += m.elements[12]; this.y += m.elements[13]; this.z += m.elements[14]; return this; } };
    g.THREE.Matrix4 = class { copy(m) { this.elements = m.elements; return this; } invert() { return this; } };
  }
  const mkGeo = () => ({
    attrs: {},
    setAttribute(name, a) { this.attrs[name] = a; return this; },
    getAttribute(name) { return this.attrs[name] || (this.attrs[name] = { updateRange: {}, needsUpdate: false }); },
    setDrawRange(a, b) { this.dr = [a, b]; },
    dr: [0, 0]
  });
  const fs = Object.create(WaterScene.prototype);
  fs.beadsMode = false; fs.waterOpa = 0.5; fs.pOpa = 1;
  fs.allGeo = mkGeo();
  const CAP = 6;
  fs.allPos = new Float32Array(CAP * 3); fs.allCol = new Float32Array(CAP * 3);
  fs.allAlpha = new Float32Array(CAP); fs.allSize = new Float32Array(CAP);
  fs.allSprite = new Float32Array(CAP);
  fs.pPos = new Float32Array(CAP * 3); fs.pCol = new Float32Array(CAP * 3);
  fs.vPos = new Float32Array(CAP * 3); fs.vCol = new Float32Array(CAP * 3);
  fs.bPos = new Float32Array(CAP * 3); fs.bCol = new Float32Array(CAP * 3);
  fs.cPos = new Float32Array(CAP * 3); fs.cCol = new Float32Array(CAP * 3);
  fs.sPos = new Float32Array(CAP * 3); fs.sCol = new Float32Array(CAP * 3);
  fs._classCounts = { beads: 0, spray: 0, vapor: 0, cloud: 0, snow: 0 };
  fs._d2 = new Float32Array(CAP); fs._ord = new Uint32Array(CAP);
  fs._hist = new Int32Array(64); fs._bkt = new Int32Array(65);
  fs._camLocal = new THREE.Vector3(); fs._invPlanet = new THREE.Matrix4();
  fs._tmpV3 = new THREE.Vector3();
  fs.planetGroup = { matrixWorld: { elements: new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]) } };
  fs.camera = { matrixWorld: { elements: new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 30,0,0,1]) } };
  fs.waterColor = { r: 0.2, g: 0.5, b: 0.9 };
  fs._sunDirLocal = { x: 0, y: 1, z: 0 }; fs._planetLit = false; fs._wScale = 1;
  fs.pOpa = 1; fs.waterOpa = 0.5; fs.beadsMode = false;
  fs.allPts = { visible: false };
  const solver = {
    nP: CAP, spacing: 0.2,
    px: new Float32Array([1, 2, 3, 4, 5, 6]), py: new Float32Array(CAP), pz: new Float32Array(CAP),
    pflag: new Int8Array([0, 1, 2, 3, 4, 5]),
    pT: new Float32Array([0.3, 0.3, 0.3, 0.3, 0.3, 0.3]),
    pLight: null
  };
  // camera at x=30: the far particle (x=1, distance 29) must draw FIRST,
  // the near one (x=6, distance 24) LAST — across classes, not per class
  fs.updateParticles(solver, true);
  assert.ok(fs.allPts.visible, 'combined system visible');
  assert.deepEqual(fs.allGeo.dr, [0, 5], 'all airborne classes routed (fl 0 stays on the surface mesh)');
  const cnt = fs._classCounts;
  assert.deepEqual([cnt.beads, cnt.spray, cnt.vapor, cnt.cloud, cnt.snow], [0, 2, 1, 1, 1],
    'fl 0 stays on the surface mesh; fl 1+4 spray, fl 2 vapor, fl 3 cloud, fl 5 snow');
  // sprite mapping by depth order: fl order is x=1 liquid(skipped), x=2 spray,
  // x=3 steam, x=4 cloud, x=5 rain, x=6 snow; camera at x=30 → far→near is
  // x=2(784), x=3(729), x=4(676), x=5(625), x=6(576)
  const spriteOf = Array.from(fs.allSprite.slice(0, 5));
  assert.deepEqual(spriteOf, [1, 2, 3, 1, 4], 'sorted far→near with per-class sprite tiles');
  assert.ok(spriteOf.indexOf(2) !== -1 && spriteOf.indexOf(3) !== -1 && spriteOf.indexOf(4) !== -1,
    'vapor tile 2, cloud tile 3, snow tile 4 present');
  // alpha per class: spray 0.95, vapor 0.23, cloud 0.88, snow OPAQUE (1.0 —
  // ice never follows the spray/atmosphere opacity slider)
  assert.ok(fs.allAlpha.some((a, i) => fs.allSprite[i] === 2 && Math.abs(a - 0.23) < 1e-6),
    'vapor alpha = 0.23·√pOpa');
  assert.ok(fs.allAlpha.every((a, i) => (fs.allSprite[i] === 3 ? Math.abs(a - 0.88) < 1e-6 : true)), 'cloud alpha 0.88');
  assert.ok(fs.allAlpha.every((a, i) => (fs.allSprite[i] === 4 ? a === 1 : true)),
    'snow alpha stays 1 (opaque)');
  // sizes: snow disc = water bead size (spacing·3.4), spray 3× smaller, cloud > vapor
  const sizeOf = (tile) => { const i = Array.from(fs.allSprite.slice(0, 5)).indexOf(tile); return fs.allSize[i]; };
  assert.ok(Math.abs(sizeOf(4) - 0.2 * 3.4) < 1e-6, 'snow disc = water droplet size');
  assert.ok(sizeOf(3) > sizeOf(2), 'cloud puffs larger than steam cloudlets');
  // far → near painter order: the farthest drawn particle is the x=1 steam,
  // the nearest is the x=6 snow
  assert.ok(Math.abs(fs.allPos[0] - 2) < 1e-6,
    'first drawn particle is the farthest airborne one (x=2)');
  assert.ok(Math.abs(fs.allPos[12] - 6) < 1e-6, 'last drawn particle is the nearest (x=6)');

  // beads mode: the liquid particle draws as a bead (tile 0, waterOpa alpha)
  fs.beadsMode = true;
  fs.updateParticles(solver, true);
  assert.deepEqual(fs.allGeo.dr, [0, 6], 'beads mode: fl 0 joins the draw list');
  assert.equal(fs._classCounts.beads, 1, 'one liquid bead');
  const beadI = Array.from(fs.allSprite.slice(0, 6)).indexOf(0);
  assert.ok(beadI !== -1 && Math.abs(fs.allAlpha[beadI] - 0.5) < 1e-6,
    'bead sprite tile 0 with waterOpa alpha');
  fs.beadsMode = false;

  // interior-water cull, split by hemisphere: with the solver's
  // overhead-water mirror present, beads for water 2+ cells below the local
  // surface are culled ONLY on the night side (they rendered as
  // semi-transparent dark speckle through the body); a bead on the sunny
  // side is never considered interior and keeps its normal color
  fs.beadsMode = true;
  fs._planetLit = true;
  fs.W = 6; fs.H = 6; fs.D = 6;                    // planet centre (3,3,3)
  solver.pDepth = new Uint8Array([4, 4, 4, 4, 0, 2]);   // the bead itself is deep
  // bead at x=1 → centre-relative (−2,−3,−3); sun toward +x ⇒ night side
  fs._sunDirLocal = { x: 1, y: 0, z: 0 };
  fs.updateParticles(solver, true);
  assert.equal(fs._classCounts.beads, 0, 'interior bead on the night side is culled');
  // same deep particle on the sunny side: never interior, normal color
  fs._sunDirLocal = { x: -1, y: 0, z: 0 };
  fs.updateParticles(solver, true);
  assert.equal(fs._classCounts.beads, 1, 'sunny-side bead is never culled');
  const beadJ = Array.from(fs.allSprite.slice(0, 5)).indexOf(0);
  assert.ok(beadJ !== -1, 'sunny bead present in the draw list');
  // full water hue (T=0.3 → cr = 0.2·(0.9+0.1·0.3^1.4) ≈ 0.1837) — no
  // exposure darkening (which would be ×0.12 for this unlit particle)
  assert.ok(Math.abs(fs.allCol[beadJ * 3] - 0.2 * (0.9 + 0.1 * Math.pow(0.3, 1.4))) < 0.01,
    'sunny-side bead renders with its normal color, not exposure-darkened');
  delete solver.pDepth;                            // fallback: no mirror → draw all
  fs.updateParticles(solver, true);
  assert.equal(fs._classCounts.beads, 1, 'missing pDepth falls back to drawing beads');
  fs._planetLit = false;
  fs.beadsMode = false;

  // hidden when the spray opacity is 0
  fs.pOpa = 0;
  fs.updateParticles(solver, true);
  assert.ok(!fs.allPts.visible, 'combined system hides with spray opacity 0');
  assert.deepEqual(fs.allGeo.dr, [0, 0], 'draw range cleared');
}

console.log('ALL SCENE FX TESTS PASSED');
