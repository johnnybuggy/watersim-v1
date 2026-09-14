/*
 * WaterSim — Three.js planet scene: gouraud-shaded voxel terrain globe
 * (color from the UI picker), atmosphere halo, starfield, gradient sky with
 * environment lighting, dynamic water isosurface mesh, spray particles,
 * velocity-vector overlay, lightning, floating balls, stir handle.
 * Requires three.min.js and js/controls.js loaded first.
 */
(function (global) {
'use strict';

// -------------------------------------------------------- procedural textures
function makePlanetTexture() {
  // procedural rocky/icy core surface: blotchy two-tone noise
  var c = document.createElement('canvas');
  c.width = c.height = 512;
  var g = c.getContext('2d');
  g.fillStyle = '#274a56';
  g.fillRect(0, 0, 512, 512);
  var tones = ['#31586a', '#1e3a46', '#3b6b5c', '#274a56', '#52707a', '#44636b'];
  for (var i = 0; i < 900; i++) {
    var x = Math.random() * 512, y = Math.random() * 512;
    var rr = 4 + Math.random() * 42;
    g.globalAlpha = 0.12 + Math.random() * 0.25;
    g.fillStyle = tones[(Math.random() * tones.length) | 0];
    g.beginPath();
    g.arc(x, y, rr, 0, 6.2832);
    g.fill();
  }
  g.globalAlpha = 1;
  var tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  return tex;
}

function makeSpriteTexture() {
  // solid droplet sprite: a hard-edged uniform disc (no radial gradient) so
  // every particle reads as a flat, evenly transparent dot
  var c = document.createElement('canvas');
  c.width = c.height = 64;
  var g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,1.0)';
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fill();
  return new THREE.CanvasTexture(c);
}

function makeBeadTexture() {
  // glossy water-bead sprite: sphere shading (cool dark limb, bright body)
  // plus an off-centre specular hotspot, so beads read as little glass balls.
  // Mostly neutral so the water-color picker (vertex colors) does the tinting.
  var c = document.createElement('canvas');
  c.width = c.height = 64;
  var g = c.getContext('2d');
  var shade = g.createRadialGradient(26, 24, 2, 32, 32, 30);
  shade.addColorStop(0, 'rgba(255,255,255,1.0)');
  shade.addColorStop(0.4, 'rgba(215,232,250,0.98)');
  shade.addColorStop(0.75, 'rgba(130,165,210,0.94)');
  shade.addColorStop(0.95, 'rgba(45,75,125,0.6)');
  shade.addColorStop(1, 'rgba(25,45,85,0)');
  g.fillStyle = shade;
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fill();
  var spec = g.createRadialGradient(24, 21, 0, 24, 21, 9);
  spec.addColorStop(0, 'rgba(255,255,255,0.95)');
  spec.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = spec;
  g.beginPath();
  g.arc(24, 21, 9, 0, Math.PI * 2);
  g.fill();
  return new THREE.CanvasTexture(c);
}

function makeCloudTexture() {
  var c = document.createElement('canvas'); c.width = c.height = 64;
  var g = c.getContext('2d');
  var gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,0.65)');
  gradient.addColorStop(0.3, 'rgba(255,255,255,0.38)');
  gradient.addColorStop(0.65, 'rgba(255,255,255,0.10)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gradient; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------- particle sprite atlas
// All five particle sprites live in ONE 3×2 tile atlas so a single Points
// draw call can render every airborne class (liquid beads, glossy spray,
// vapor cloudlets, cloud puffs, snow). Tile ids match the CLS_* constants.
var ATLAS_COLS = 3, ATLAS_ROWS = 2, ATLAS_TILE = 64;
function makeParticleAtlas() {
  var tiles = [
    makeSpriteTexture(),      // 0 flat disc (liquid body, beads mode)
    makeBeadTexture(),        // 1 glossy droplet (spray / rain)
    makeCloudTexture(),       // 2 vapor cloudlet
    makeCloudPuffTexture(),   // 3 cloud puff
    makeSnowTexture()         // 4 snow grain
  ];
  var c = document.createElement('canvas');
  c.width = ATLAS_COLS * ATLAS_TILE; c.height = ATLAS_ROWS * ATLAS_TILE;
  var g = c.getContext('2d');
  var painted = false;
  for (var i = 0; i < tiles.length; i++) {
    var tx = (i % ATLAS_COLS) * ATLAS_TILE, ty = ((i / ATLAS_COLS) | 0) * ATLAS_TILE;
    if (g.drawImage) { g.drawImage(tiles[i].image, tx, ty); painted = true; }
  }
  if (!painted) {
    // headless canvas stub: single-sprite fallback (same flipY contract as
    // the atlas so tests assert one consistent sampling orientation)
    tiles[0].flipY = false;
    return tiles[0];
  }
  var tex = new THREE.CanvasTexture(c);
  // CanvasTexture defaults to flipY=true, which mirrors the upload — the
  // aSprite → atlas-cell mapping in the shader (uv.y = (row + pc)/rows) then
  // samples the MIRRORED cell (snow got the glossy bead, vapor the empty
  // cell). Keep the canvas row-major layout intact.
  tex.flipY = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

function makeSunTexture() {
  // glowing sun billboard: hot core, warm falloff
  var c = document.createElement('canvas');
  c.width = c.height = 128;
  var g = c.getContext('2d');
  var grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0.0, 'rgba(255,252,235,1)');
  grd.addColorStop(0.12, 'rgba(255,240,190,1)');
  grd.addColorStop(0.3, 'rgba(255,200,110,0.45)');
  grd.addColorStop(1.0, 'rgba(255,170,60,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// ------------------------------------------------------- voxel terrain mesh
// Build a gouraud-shaded mesh from the solver's voxel terrain: exposed rock
// faces only, vertex normals averaged at shared corners (the soft, eroded
// look), per-vertex brightness by elevation — wet dark rock in the ocean
// basins, lighter stone ashore — multiplied by the user's planet color.
// ------------------------------------------------ terrain surface palette
// Natural planet skin colors: dark brown-grey rock under water, green at the
// waterline, the UI rock hue through the mid slopes, snow white on the peaks.
var _TERR_SNOW = { r: 0.93, g: 0.94, b: 0.96 };
var _TERR_OUT = { r: 0, g: 0, b: 0 };
function terrainShade(rr, Rsl, spanHi, base, out, latitude, variation) {
  latitude = Math.abs(latitude || 0);
  variation = variation || 0;
  if (rr < Rsl) {
    // submerged rock: the hue darkened and pulled toward grey-brown
    var dR = base.r * 0.5, dG = base.g * 0.5, dB = base.b * 0.5;
    out.r = dR + (0.30 - dR) * 0.55;
    out.g = dG + (0.29 - dG) * 0.55;
    out.b = dB + (0.27 - dB) * 0.55;
    return out;
  }
  var t = Math.max(0, (rr - Rsl) / Math.max(spanHi, 0.02));
  var beach = Math.max(0, 1 - t / 0.09);
  var rock = Math.max(0, Math.min(1, (t - 0.3 + variation * 0.12) / 0.42));
  var snow = Math.max(0, Math.min(1, (t + latitude * 0.25 - 0.72) / 0.32));
  var greenR = 0.12 + variation * 0.025, greenG = 0.27 + variation * 0.04, greenB = 0.09;
  out.r = greenR + (base.r - greenR) * rock;
  out.g = greenG + (base.g - greenG) * rock;
  out.b = greenB + (base.b - greenB) * rock;
  out.r += (0.58 - out.r) * beach; out.g += (0.49 - out.g) * beach; out.b += (0.29 - out.b) * beach;
  out.r += (_TERR_SNOW.r - out.r) * snow;
  out.g += (_TERR_SNOW.g - out.g) * snow;
  out.b += (_TERR_SNOW.b - out.b) * snow;
  return out;
}

// Rewrite the terrain mesh's vertex colors for a new planet hue (the color
// picker drives the palette's rock tone; geometry stays untouched).
function recolorTerrainMesh(mesh, colorHex) {
  var terrain = mesh.userData.terrain;
  if (!terrain) return;
  var base = new THREE.Color(colorHex || '#654321');
  var posA = mesh.geometry.getAttribute('position');
  var colA = mesh.geometry.getAttribute('color');
  var n = terrain.n, dv = terrain.dv, ctr = n * dv * 0.5;
  var spanHi = Math.max(terrain.Rhi - terrain.Rsl, 0.02);
  for (var v = 0; v < posA.count; v++) {
    var rr = Math.sqrt((posA.getX(v) - ctr) * (posA.getX(v) - ctr) +
      (posA.getY(v) - ctr) * (posA.getY(v) - ctr) +
      (posA.getZ(v) - ctr) * (posA.getZ(v) - ctr));
    var x = posA.getX(v) - ctr, y = posA.getY(v) - ctr, z = posA.getZ(v) - ctr;
    var variation = Math.sin(x * 3.1 + z * 1.8) * Math.sin(y * 4.3 - z * 2.1);
    var sh = terrainShade(rr, terrain.Rsl, spanHi, base, _TERR_OUT, y / (rr || 1), variation);
    var shade = 0.94 + 0.06 * variation;
    colA.setXYZ(v, sh.r * shade, sh.g * shade, sh.b * shade);
  }
  colA.needsUpdate = true;
}

// ---------------------------------------------- terrain detail (procedural)
// High-detail rock texture for the planet terrain, injected into the terrain
// material's Phong shader via onBeforeCompile (the same patch pattern as the
// water material above). Fully procedural — no image assets, no new
// dependencies:
//   • multi-octave VALUE-noise fbm albedo variation (~±16% around the palette)
//   • a second, higher-frequency grain octave (±4%)
//   • a gentle slope tint (cliffs up to 10% darker) and a warm "dust" tint on
//     flats vs a cool tint in crevices (±4.5% per channel)
//   • a cheap tangent-free normal perturbation: the SAME fbm acts as the
//     height field and dFdx/dFdy provide the screen-space slope (three's own
//     perturbNormalArb math — no extra noise taps, no UVs, no tangent frame)
// WORLD-SCALE INVARIANCE: the terrain mesh is built in solver METRES
// (MarchingTetrahedra emits lattice·dv and the planet group carries no scale),
// so sampling the noise at the LOCAL surface position with fixed PER-METRE
// frequencies keeps the texture density constant per metre for every planet
// radius (0.5–25 m). The frequencies are 1/TERRAIN_*_METRES — derived from a
// metre constant, never from pixels, dv or grid resolution. True 3D noise is
// seamless in all three axes, so no triplanar blend is needed (that trick is
// only required for 2D textures); the sampling is UV-less by construction.
// The modulation is multiplicative around the vertex palette (beach/green/
// rock/snow bands + the picker's hue), so the color picker keeps full control.
// Setup is deterministic and once-per-build (uniform objects + a closure);
// runtime cost is per-fragment only, like any texture fetch. WebGL1 needs the
// derivatives extension for dFdx — enabled below; WebGL2 has it as core.
var TERRAIN_DETAIL_METRES = 0.85;   // base fbm cell size (metres)
var TERRAIN_GRAIN_METRES = 0.21;    // fine grain cell size (metres)
var TERRAIN_DETAIL_BUMP = 0.14;     // normal-perturb strength (0 = albedo only)

// GLSL prelude prepended to the fragment shader (outside main): uniforms,
// varyings and the noise primitives.
var _TERR_DETAIL_GLSL = [
  'uniform float uTerrFreq;',       // base fbm frequency, cells per metre
  'uniform float uTerrGrain;',      // grain frequency, cells per metre
  'uniform float uTerrBump;',       // derivative-bump strength
  'uniform vec3 uTerrCenter;',      // planet centre, local metres
  'varying vec3 vTerrPos;',         // local surface position (metres)
  'varying vec3 vTerrNrm;',         // local smooth (gouraud) normal
  'float tHash(vec3 p) {',
  '  p = fract(p * 0.31831 + vec3(0.71, 0.113, 0.419));',
  '  p *= 17.0;',
  '  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));',
  '}',
  'float tNoise(vec3 x) {',
  '  vec3 i = floor(x); vec3 f = fract(x);',
  '  f = f * f * (3.0 - 2.0 * f);',
  '  float n00 = tHash(i);',
  '  float n10 = tHash(i + vec3(1.0, 0.0, 0.0));',
  '  float n01 = tHash(i + vec3(0.0, 1.0, 0.0));',
  '  float n11 = tHash(i + vec3(1.0, 1.0, 0.0));',
  '  float n02 = tHash(i + vec3(0.0, 0.0, 1.0));',
  '  float n12 = tHash(i + vec3(1.0, 0.0, 1.0));',
  '  float n03 = tHash(i + vec3(0.0, 1.0, 1.0));',
  '  float n13 = tHash(i + vec3(1.0, 1.0, 1.0));',
  '  return mix(mix(mix(n00, n10, f.x), mix(n01, n11, f.x), f.y),',
  '             mix(mix(n02, n12, f.x), mix(n03, n13, f.x), f.y), f.z);',
  '}',
  'float tFbm(vec3 p) {',
  '  float s = 0.0; float a = 0.52;',
  '  for (int o = 0; o < 4; o++) {',              // constant bound: WebGL1-safe
  '    s += a * tNoise(p);',
  '    p = p * 2.13 + vec3(31.4, 17.7, 11.3);',
  '    a *= 0.5;',
  '  }',
  '  return s / 0.975;',                          // octave weights → 0..1
  '}'
].join('\n');

// Wire the detail into a terrain material. The closure runs once per program
// compile (three caches it by onBeforeCompile.toString(), so terrain rebuilds
// reuse the compiled program); it never touches per-frame state.
function applyTerrainDetail(mat, ctr) {
  mat.onBeforeCompile = function (shader) {
    shader.uniforms.uTerrFreq = { value: 1 / TERRAIN_DETAIL_METRES };
    shader.uniforms.uTerrGrain = { value: 1 / TERRAIN_GRAIN_METRES };
    shader.uniforms.uTerrBump = { value: TERRAIN_DETAIL_BUMP };
    shader.uniforms.uTerrCenter = { value: new THREE.Vector3(ctr, ctr, ctr) };
    shader.vertexShader = 'varying vec3 vTerrPos;\nvarying vec3 vTerrNrm;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', [
      '#include <begin_vertex>',
      'vTerrPos = position; vTerrNrm = normal;'
    ].join('\n'));
    shader.fragmentShader = _TERR_DETAIL_GLSL + '\n' + shader.fragmentShader;
    // albedo: modulate the palette BEFORE lighting so sun/shadows stay correct
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', [
      '#include <color_fragment>',
      'vec3 tTerrC = vTerrPos - uTerrCenter;',
      'float tTerrRad = max(length(tTerrC), 1e-4);',
      'float tTerrCliff = 1.0 - clamp(dot(normalize(vTerrNrm), tTerrC / tTerrRad), 0.0, 1.0);',
      'vec3 tTerrP = vTerrPos * uTerrFreq;',                          // metres → noise cells
      'float tTerrH = tFbm(tTerrP);',                                 // 0..1 base relief
      'float tTerrGrain = tNoise(vTerrPos * uTerrGrain + 9.3) - 0.5;', // fine grain octave
      'float tTerrDust = tNoise(tTerrP * 0.23 + 4.7);',               // ~3.7 m dust patches
      'vec3 tTerrShade = vec3(1.0 + (tTerrH - 0.5) * 0.32 + tTerrGrain * 0.08 - tTerrCliff * 0.10)',
      '  * mix(vec3(0.962, 0.968, 1.0), vec3(1.045, 1.0, 0.925),',
      '        smoothstep(0.4, 0.78, tTerrDust) * (1.0 - tTerrCliff));',
      'diffuseColor.rgb *= tTerrShade;'
    ].join('\n'));
    // cheap normal perturbation: tangent-free screen-space derivative bump
    // over the SAME fbm the albedo uses, mirroring three's perturbNormalArb
    // (faceDirection comes from <normal_fragment_begin> above this point)
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', [
      '#include <normal_fragment_maps>',
      'vec3 tSgX = vec3(dFdx(-vViewPosition.x), dFdx(-vViewPosition.y), dFdx(-vViewPosition.z));',
      'vec3 tSgY = vec3(dFdy(-vViewPosition.x), dFdy(-vViewPosition.y), dFdy(-vViewPosition.z));',
      'vec3 tR1 = cross(tSgY, normal);',
      'vec3 tR2 = cross(normal, tSgX);',
      'float tDet = dot(tSgX, tR1) * faceDirection;',
      'vec3 tGrad = sign(tDet) * (dFdx(tTerrH) * tR1 + dFdy(tTerrH) * tR2);',
      'normal = normalize(abs(tDet) * normal - uTerrBump * tGrad);'
    ].join('\n'));
  };
  if (!mat.extensions) mat.extensions = {};
  mat.extensions.derivatives = true;   // WebGL1: emit the dFdx extension line
  // headless/test observability: the compiled GLSL can only be exercised by a
  // real renderer, so mirror the patch config in userData (tests assert this)
  mat.userData.terrainDetail = {
    patched: true,
    freqPerMetre: 1 / TERRAIN_DETAIL_METRES,
    grainPerMetre: 1 / TERRAIN_GRAIN_METRES,
    metresPerCell: TERRAIN_DETAIL_METRES,
    grainMetresPerCell: TERRAIN_GRAIN_METRES,
    bump: TERRAIN_DETAIL_BUMP,
    center: ctr
  };
}

// ------------------------------------------ metaball material (editor-driven)
// The metaball skin carries its OWN material instance (scene.metaballMat) so
// the Metaball material editor can restyle the liquid blobs without touching
// the sea surface. Three editing axes live here:
//   • shading model — 'physical' (MeshPhysicalMaterial, the water look) |
//     'matte' (MeshLambertMaterial, diffuse only) | 'unlit' (MeshBasicMaterial,
//     flat). Swapping rebuilds the material instance, carries over the current
//     color/opacity/texture/gloss state and disposes the old instance.
//   • texture type — fully PROCEDURAL (no image assets, no UVs — the marching-
//     tets mesh has none): 'none' | 'noise' (multi-octave albedo grain) |
//     'caustic' (bright drifting filaments) | 'stripes' (soft diagonal bands).
//     All three layers ship in ONE shader patch, each gated by a 0/1 uniform
//     (uMblaNoise/uMblaCaustic/uMblaStripes) — uniform-gating was chosen over
//     re-patching per type because three r128 caches programs by
//     onBeforeCompile.toString(): re-patching with a different captured mode
//     would silently reuse the old program, while a uniform flip costs
//     nothing. Uniform-gated branches are cheap (no texture taps when off)
//     and the layers modulate AROUND the picked color (multiplicative shades
//     near 1.0), never replacing it.
//   • glossiness — gloss g maps to roughness = 1 − g and clearcoat = g on the
//     physical variant (matte/unlit have no specular state; the requested
//     gloss is kept in scene.metaballGloss and re-applied on a later swap).
// The patch also carries the water look's two shader behaviours: the animated
// ripple normal perturbation (lit per-fragment materials only — r128
// meshlambert_frag lights per-vertex and has no <normal_fragment_maps> chunk
// to anchor on, and basic is unlit) and the alpha pre-boost (see the waterMat
// patch below for the r128 chunk-anchor fix). Like the terrain detail, the
// patch config is mirrored into mat.userData.metaballPatch for headless tests.
// Everything is deterministic — fixed constants, no Math.random.
var _MBLA_TEX_TYPES = { none: 1, noise: 1, caustic: 1, stripes: 1 };

// GLSL prelude shared by every metaball material variant: the uniform gates
// plus the value-noise primitives (same technique as the terrain detail —
// 3D value noise is seamless in all axes and needs no UVs/tangent frame).
var _MBLA_TEX_GLSL = [
  'uniform float uMblaNoise;',     // 0/1 gate: albedo grain layer
  'uniform float uMblaCaustic;',   // 0/1 gate: bright filament layer
  'uniform float uMblaStripes;',   // 0/1 gate: directional band layer
  'float mHash(vec3 p) {',
  '  p = fract(p * 0.31831 + vec3(0.31, 0.217, 0.613));',
  '  p *= 17.0;',
  '  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));',
  '}',
  'float mNoise(vec3 x) {',
  '  vec3 i = floor(x); vec3 f = fract(x);',
  '  f = f * f * (3.0 - 2.0 * f);',
  '  float n00 = mHash(i);',
  '  float n10 = mHash(i + vec3(1.0, 0.0, 0.0));',
  '  float n01 = mHash(i + vec3(0.0, 1.0, 0.0));',
  '  float n11 = mHash(i + vec3(1.0, 1.0, 0.0));',
  '  float n02 = mHash(i + vec3(0.0, 0.0, 1.0));',
  '  float n12 = mHash(i + vec3(1.0, 0.0, 1.0));',
  '  float n03 = mHash(i + vec3(0.0, 1.0, 1.0));',
  '  float n13 = mHash(i + vec3(1.0, 1.0, 1.0));',
  '  return mix(mix(mix(n00, n10, f.x), mix(n01, n11, f.x), f.y),',
  '             mix(mix(n02, n12, f.x), mix(n03, n13, f.x), f.y), f.z);',
  '}',
  'float mFbm(vec3 p) {',
  '  float s = 0.0; float a = 0.53;',
  '  for (int o = 0; o < 3; o++) {',               // constant bound: WebGL1-safe
  '    s += a * mNoise(p);',
  '    p = p * 2.17 + vec3(19.3, 7.1, 23.7);',
  '    a *= 0.5;',
  '  }',
  '  return s / 0.925;',                           // octave weights → 0..1
  '}'
].join('\n');

// Wire the editor patch into a metaball material. `sc` is the WaterScene
// whose shared uniform objects (time + texture gates) this material binds —
// flipping the gate .value after a texture switch re-skins without a recompile.
function applyMetaballPatch(mat, sc) {
  var waterTime = sc._waterTime;
  var texU = sc._mblaTexU;
  mat.onBeforeCompile = function (shader) {
    shader.uniforms.uWaterTime = waterTime;
    shader.uniforms.uMblaNoise = texU.uMblaNoise;
    shader.uniforms.uMblaCaustic = texU.uMblaCaustic;
    shader.uniforms.uMblaStripes = texU.uMblaStripes;
    shader.vertexShader = 'varying vec3 vWaterPosition;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\nvWaterPosition = position;');
    shader.fragmentShader = 'uniform float uWaterTime;\nuniform float uMblaNoise;\n' +
      'uniform float uMblaCaustic;\nuniform float uMblaStripes;\n' +
      'varying vec3 vWaterPosition;\n' + _MBLA_TEX_GLSL + '\n' + shader.fragmentShader;
    // procedural texture layers modulate the albedo BEFORE lighting, around
    // the picked color (multiplicative, centred on 1.0 — never a replacement)
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', [
      '#include <color_fragment>',
      'vec3 mP = vWaterPosition;',
      'float mShade = 1.0;',
      'if (uMblaNoise > 0.5) {',
      '  mShade *= 1.0 + (mFbm(mP * 1.35) - 0.5) * 0.24 + (mNoise(mP * 3.1 + 9.3) - 0.5) * 0.10;',
      '}',
      'if (uMblaCaustic > 0.5) {',
      '  float mR = 1.0 - abs(2.0 * mFbm(mP * 2.3 + vec3(0.0, uWaterTime * 0.4, 0.0)) - 1.0);',
      '  mShade *= (1.0 + pow(mR, 5.0) * 0.6) * 0.90;',
      '}',
      'if (uMblaStripes > 0.5) {',
      '  float mB = sin(dot(mP, vec3(0.86, 1.42, 0.74)) * 2.6);',
      '  mShade *= 1.0 + (smoothstep(-0.9, 0.9, mB) - 0.5) * 0.16;',
      '}',
      'diffuseColor.rgb *= mShade;'
    ].join('\n'));
    // animated ripple — the water look's normal perturbation. Only the
    // physical variant carries it: r128 meshlambert_frag has no
    // <normal_fragment_maps> include (its lighting is per-vertex) and basic
    // is unlit, so there is no per-fragment normal to perturb in either.
    if (mat.isMeshPhysicalMaterial) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', [
        '#include <normal_fragment_maps>',
        'vec3 ripple = vec3(cos(vWaterPosition.z*29.0+uWaterTime*1.1), sin(vWaterPosition.x*31.0-uWaterTime*1.3), cos(vWaterPosition.y*27.0+uWaterTime));',
        'normal = normalize(normal + mat3(viewMatrix) * ripple * 0.045);'
      ].join('\n'));
    }
    // alpha pre-boost — anchored on <dithering_fragment>, the FINAL chunk of
    // every r128 lit/unlit template (verified in vendor/three.min.js:
    // meshphysical/meshlambert/meshbasic all end with it). The old
    // <output_fragment> anchor does NOT exist in r128 (chunks were renamed),
    // which made the replace a silent no-op. Placing the boost after
    // tonemapping + sRGB encoding compensates exactly what the alpha blend
    // composites (the framebuffer holds encoded values).
    shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', [
      'gl_FragColor.rgb *= min(1.0 / max(gl_FragColor.a, 0.001), 2.1);',
      '#include <dithering_fragment>'
    ].join('\n'));
  };
  if (!mat.extensions) mat.extensions = {};
  mat.extensions.derivatives = true;   // WebGL1: emit the dFdx extension line
  // headless/test observability: mirror the patch config in userData (tests
  // assert this — the compiled GLSL needs a real renderer)
  mat.userData.metaballPatch = {
    patched: true,
    shading: sc._mblaShading,
    ripple: !!mat.isMeshPhysicalMaterial,
    texture: sc._mblaTex,
    alphaBoost: true,
    boostAnchor: 'dithering_fragment',
    gloss: sc.metaballGloss
  };
}

// Build the terrain surface as a marching-tetrahedra isosurface of the
// solver's radius field: field[c] = R(c) − |c − centre| (positive inside the
// rock). The contoured surface IS the physics surface (terrainRadiusAt), so
// the drawn slopes match every collision query exactly — no voxel steps, and
// the Laplacian-smoothed field gives smooth rolling slopes. Per-vertex
// palette identical to the old voxel mesh (beach/green/rock/snow bands), plus
// a procedural high-detail texture patched into the material's shader.
function buildVoxelTerrainMesh(terrain, colorHex) {
  var n = terrain.n, dv = terrain.dv;
  var Rsl = terrain.Rsl, Rlo = terrain.Rlo, Rhi = terrain.Rhi;
  var baseCol = new THREE.Color(colorHex || '#654321');   // rock hue (picker)
  var field = terrain.field;
  // contour the field (corner lattice — the same convention the water
  // surface uses for its density grid); resolve the mesher via the module
  // global (window/globalThis) like every other cross-file reference
  var MT = global.MarchingTetrahedra || (typeof MarchingTetrahedra !== 'undefined' ? MarchingTetrahedra : null);
  if (!MT || !field) return null;          // headless stub or missing field
  var m = MT.build(field, n, n, n, dv, 0);
  var vcount = m.count;
  var geo = new THREE.BufferGeometry();
  var ctr = n * dv * 0.5;
  var spanHi = Math.max(Rhi - Rsl, 0.02);
  var colA = new Float32Array(vcount * 3);
  for (var v = 0; v < vcount; v++) {
    var rx = m.pos[v * 3] - ctr, ry = m.pos[v * 3 + 1] - ctr, rz = m.pos[v * 3 + 2] - ctr;
    var rr = Math.sqrt(rx * rx + ry * ry + rz * rz);
    var variation = Math.sin(rx * 3.1 + rz * 1.8) * Math.sin(ry * 4.3 - rz * 2.1);
    var sh = terrainShade(rr, Rsl, spanHi, baseCol, _TERR_OUT, ry / (rr || 1), variation);
    var spk = 0.94 + 0.06 * variation;
    colA[v * 3] = Math.min(sh.r * spk, 1);
    colA[v * 3 + 1] = Math.min(sh.g * spk, 1);
    colA[v * 3 + 2] = Math.min(sh.b * spk, 1);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.pos.subarray(0, vcount * 3)), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(m.nrm.subarray(0, vcount * 3)), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colA, 3));
  var mat = new THREE.MeshPhongMaterial({
    color: 0xffffff,                    // vertex colors carry the full palette
    vertexColors: true,
    shininess: 8,                       // matte soil and weathered stone
    specular: 0x0b1010
  });
  // procedural high-detail rock texture (see the block comment above) —
  // patched into this material's Phong shader, modulating around the palette
  applyTerrainDetail(mat, ctr);
  var mesh = new THREE.Mesh(geo, mat);
  mesh.userData.vcount = vcount;
  return mesh;
}

function makeSky() {
  // vertical gradient sky dome (BackSide): space-dark zenith, subtle blue band
  var geo = new THREE.SphereGeometry(70, 24, 16);
  var mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: [
      'varying vec3 vP;',
      'void main(){ vP = position;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
    ].join('\n'),
    fragmentShader: [
      'varying vec3 vP;',
      'void main(){',
      '  float h = normalize(vP).y;',
      '  vec3 top = vec3(0.005, 0.007, 0.016);',   // deep space (50% darker)
      '  vec3 mid = vec3(0.0225, 0.0425, 0.085);', // upper band (50% darker)
      '  vec3 hor = vec3(0.075, 0.105, 0.155);',   // horizon glow (50% darker)
      '  vec3 c = mix(hor, mid, smoothstep(0.0, 0.25, h));',
      '  c = mix(c, top, smoothstep(0.25, 0.7, h));',
      '  gl_FragColor = vec4(c, 1.0);',
      '}'
    ].join('\n')
  });
  var m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  return m;
}

function makeCloudPuffTexture() {
  // cloud droplet: light grey, ALMOST solid — soft rim only
  var c = document.createElement('canvas');
  c.width = c.height = 64;
  var g = c.getContext('2d');
  var grd = g.createRadialGradient(32, 32, 4, 32, 32, 31);
  grd.addColorStop(0.0, 'rgba(226,229,236,1)');
  grd.addColorStop(0.7, 'rgba(210,214,224,0.96)');
  grd.addColorStop(0.92, 'rgba(196,202,214,0.55)');
  grd.addColorStop(1.0, 'rgba(190,198,212,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function makeSnowTexture() {
  // snow grain: solid white disc, slight radial transparency along the edge
  var c = document.createElement('canvas');
  c.width = c.height = 64;
  var g = c.getContext('2d');
  var grd = g.createRadialGradient(32, 32, 0, 32, 32, 31);
  grd.addColorStop(0.0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.78, 'rgba(255,255,255,1)');
  grd.addColorStop(0.93, 'rgba(255,255,255,0.72)');
  grd.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function makeStarTexture() {
  // soft round star sprite for the bright layer (additive glow falloff)
  var c = document.createElement('canvas');
  c.width = c.height = 64;
  var g = c.getContext('2d');
  var grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0.0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.6, 'rgba(210,225,255,0.14)');
  grd.addColorStop(1.0, 'rgba(200,220,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// --------------------------------------------------------------------- scene
function WaterScene(container, W, H, D, opts) {
  opts = opts || {};
  this.coreR = opts.coreR || 0;
  this.oceanR = opts.oceanR || 0;
  this.W = W; this.H = H; this.D = D;
  this.time = 0;
  this.container = container;

  var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);
  this.renderer = renderer;

  var scene = new THREE.Scene();
  this.scene = scene;

  // Everything that belongs to the planet (rock, ocean, spray, vapor, balls,
  // vector arrows, stir handle) lives in one transform group that revolves
  // around the FIXED sun ("year") and spins about its vertical axis ("day").
  // The sky, starfield and the sun itself stay in world space.
  this.planetGroup = new THREE.Group();
  // Axial tilt: the planet spins about an axis tilted by `_tiltRad` against
  // the orbital (vertical) axis. tiltGroup carries the FIXED tilt (a world
  // direction, like Earth's axis pointing at a fixed star) while the planet
  // group spins inside it and the pair revolves around the Sun — which is
  // what produces seasons as the orbit progresses.
  this.tiltGroup = new THREE.Group();
  this.tiltGroup.add(this.planetGroup);
  scene.add(this.tiltGroup);
  // orbit / rotation state: angles in radians, periods in seconds
  this.yearPeriod = 300;                       // one revolution = 5 minutes
  this.spinPeriod = 120;                       // one axial turn  = 2 minutes
  this.orbitAngle = 1.1;                       // start where the old sun started
  this.spinAngle = 0;
  this._tiltRad = 0;                           // axial tilt against the orbital axis
  this._planetWorld = new THREE.Vector3(W * 0.5, H * 0.5, D * 0.5);
  this._sunDirLocal = new THREE.Vector3(1, 0.45, 0).normalize();
  this.sunLocal = new THREE.Vector3(W * 1.5, H * 0.95, D);   // sun as a solver-frame point

  var camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.05, 220);
  this.camera = camera;

  this.orbit = new global.OrbitMini(camera, renderer.domElement,
    new THREE.Vector3(W * 0.5, H * 0.38, D * 0.5));

  // sky + image-based lighting
  this._sky = makeSky();
  scene.add(this._sky);
  try {
    var pmrem = new THREE.PMREMGenerator(renderer);
    var envScene = new THREE.Scene();
    envScene.add(makeSky());
    this.envRT = pmrem.fromScene(envScene, 0.05);
    scene.environment = this.envRT.texture;
    pmrem.dispose();
  } catch (e) { /* reflections are optional */ }

  // lights
  var sun = new THREE.DirectionalLight(0xfff2dd, 1.25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 40;
  sun.shadow.bias = -0.0004;
  this.sun = sun;
  sun.target.position.set(W * 0.5, H * 0.5, D * 0.5);   // planet center, local coords
  scene.add(sun);
  this.planetGroup.add(sun.target);   // shadow target rides along with the planet
  scene.add(new THREE.AmbientLight(0x223344, 0.07));   // near-dark night side
  this._hemi = new THREE.HemisphereLight(0x8fb8d8, 0x1a1d22, 0.14);
  scene.add(this._hemi);

  // visible sun: glowing billboard at a FIXED world position (placed once per
  // world build — the planet now moves around it). depthTest stays ON so the
  // planet occludes its own sun — no shine-through.
  this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeSunTexture(), color: 0xffffff, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true
  }));
  this.sunSprite.renderOrder = 9;
  scene.add(this.sunSprite);
  this.sunPos = new THREE.Vector3(W * 3, H * 2, D);

  // starfield: three layers (fine dust, mid stars, a few bright glows) with
  // per-star color temperature — sits inside the sky dome (r=70) and is
  // rescaled with the world so giant planets keep their sky
  this._starGroup = new THREE.Group();
  this._starLayers = [];
  (function (self, brightTex) {
    // star temperature palette (weighted): white / blue-white / warm / amber
    var palette = [
      [1, 1, 1], [1, 1, 1], [1, 1, 1],            // white — 43%
      [0.80, 0.88, 1], [0.80, 0.88, 1],           // blue-white — 29%
      [1, 0.92, 0.78],                            // warm — 14%
      [1, 0.82, 0.62]                             // amber — 14%
    ];
    function makeLayer(n, size, opacity, additive, useTex) {
      var pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
      for (var i = 0; i < n; i++) {
        var th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
        var rr = 52 + Math.random() * 12;
        pos[i * 3] = rr * Math.sin(ph) * Math.cos(th);
        pos[i * 3 + 1] = rr * Math.cos(ph);
        pos[i * 3 + 2] = rr * Math.sin(ph) * Math.sin(th);
        var c = palette[(Math.random() * palette.length) | 0];
        var b = 0.7 + Math.random() * 0.3;   // per-star luminance spread (bright floor)
        col[i * 3] = c[0] * b; col[i * 3 + 1] = c[1] * b; col[i * 3 + 2] = c[2] * b;
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      var mat = new THREE.PointsMaterial({
        size: size, sizeAttenuation: true, vertexColors: true,
        transparent: true, opacity: opacity, depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
      });
      if (useTex) mat.map = brightTex;
      var pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      self._starGroup.add(pts);
      self._starLayers.push({ mat: mat, base: opacity,
        phase: Math.random() * Math.PI * 2, speed: 0.3 + Math.random() * 0.9, tw: 0.12 });
    }
    makeLayer(2200, 0.22, 0.75, false, false);  // dust field — denser, brighter
    makeLayer(420, 0.38, 0.95, false, false);   // mid field
    makeLayer(120, 0.8, 1.0, true, true);       // bright glows (additive sprite)
  })(this, makeStarTexture());
  scene.add(this._starGroup);
  this._starBrightness = 1.25;   // prominent default (slider 0–2)

  // world structure (rebuildable — pool deck or ocean planet)
  this._poolMeshes = [];
  this._buildWorld(W, H, D, opts);

  // ---------------- dynamic water mesh
  this.waterColor = new THREE.Color('#9fd4ee');   // UI picker (surface + particles)
  this.waterMat = new THREE.MeshPhysicalMaterial({
    color: 0x9fd4ee,                    // light blue
    roughness: 0.05,                    // mirror-glossy
    metalness: 0,
    transparent: true,
    opacity: 0.25,                      // shipped default (the UI slider overrides)
    side: THREE.FrontSide,
    depthWrite: false,
    // dim self-tint of the water color: the sky environment is near-black, so
    // without it the translucent body reads as "transparent black" against
    // space and on the night side — the emissive keeps the sea always blue
    emissive: new THREE.Color(0x9fd4ee).multiplyScalar(0.24),
    envMapIntensity: 0.9,               // environment reflections
    clearcoat: 1.0,                     // wet clearcoat layer
    clearcoatRoughness: 0.08
  });
  this._waterTime = { value: 0 };
  var waterTime = this._waterTime;
  this.waterMat.onBeforeCompile = function (shader) {
    shader.uniforms.uWaterTime = waterTime;
    shader.vertexShader = 'varying vec3 vWaterPosition;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterPosition = position;');
    shader.fragmentShader = 'uniform float uWaterTime; varying vec3 vWaterPosition;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', [
      '#include <normal_fragment_maps>',
      'vec3 ripple = vec3(cos(vWaterPosition.z*29.0+uWaterTime*1.1), sin(vWaterPosition.x*31.0-uWaterTime*1.3), cos(vWaterPosition.y*27.0+uWaterTime));',
      'normal = normalize(normal + mat3(viewMatrix) * ripple * 0.045);'
    ].join('\n'));
    // Alpha blending against the black of space multiplies the water body by
    // its opacity — the sea reads "transparent black". Pre-compensate (with a
    // cap so thin settings do not blow out) so the water always shows its own
    // blue at full strength over dark backgrounds. Anchor: <dithering_fragment>
    // is the FINAL chunk of the r128 meshphysical template (verified in
    // vendor/three.min.js). The old <output_fragment> anchor does NOT exist in
    // r128 (chunks were renamed) — that replace was a silent no-op. Boosting
    // after tonemapping + sRGB encoding acts on the exact value the alpha
    // blend composites (the framebuffer holds encoded values).
    shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', [
      'gl_FragColor.rgb *= min(1.0 / max(gl_FragColor.a, 0.001), 2.1);',
      '#include <dithering_fragment>'
    ].join('\n'));
  };
  this.waterGeo = new THREE.BufferGeometry();
  this.waterGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  this.waterGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
  this.waterMesh = new THREE.Mesh(this.waterGeo, this.waterMat);
  this.waterMesh.frustumCulled = false;
  // the surface film composites OVER the particles (see renderOrder notes
  // below) — spray behind the water reads as seen through the surface
  this.waterMesh.renderOrder = 4;
  this.planetGroup.add(this.waterMesh);
  this.waterMesh.visible = !this.beadsMode;   // beads mode hides the surface

  // ---------------- metaball water mesh (checkbox display mode) -------------
  // The water particles' Blinn-style metaball skin (field + march in
  // surface.js) renders with its OWN material instance (metaballMat) so the
  // Metaball material editor can restyle the blobs without touching the sea
  // surface. The instance is SEEDED to match waterMat — same type, color,
  // opacity, roughness/clearcoat and the same ripple + alpha pre-boost shader
  // patches — so with no editor input the skin is indistinguishable from the
  // water. NOTE: Material.clone() does NOT copy onBeforeCompile in r128
  // (verified in vendor/three.min.js), so the seed is written out explicitly
  // and applyMetaballPatch attaches the shader patch instead of relying on
  // waterMat.clone(). Sync rule: the skin's color FOLLOWS the water picker
  // (setWaterColor keeps both in sync) until the user picks a color in the
  // editor — setMetaballMaterial({ color }) flips _mblaFollowWater off and the
  // skin's color stays independent for good. Opacity is NOT synced: the editor
  // owns the skin's opacity through its own slider (both ship at 0.25).
  this.metaballMode = false;
  this._mblaShading = 'physical';    // 'physical' | 'matte' | 'unlit'
  this._mblaTex = 'none';            // 'none' | 'noise' | 'caustic' | 'stripes'
  this._mblaFollowWater = true;      // color still follows the water picker
  this._mblaOpacity = 0.25;          // shipped water opacity (editor slider)
  this.metaballGloss = 0.95;         // gloss seed = 1 − waterMat.roughness (0.05)
  this._mblaColor = new THREE.Color(0x9fd4ee);   // the skin's own color state
  this._mblaTexU = {                 // shared texture-gate uniform objects
    uMblaNoise: { value: 0 },
    uMblaCaustic: { value: 0 },
    uMblaStripes: { value: 0 }
  };
  this.metaballMat = this._seedMetaballMaterial();
  this.metaballGeo = new THREE.BufferGeometry();
  this.metaballGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  this.metaballGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
  this.metaballMesh = new THREE.Mesh(this.metaballGeo, this.metaballMat);
  this.metaballMesh.frustumCulled = false;
  this.metaballMesh.renderOrder = 4;   // composites over particles like the surface film
  this.metaballMesh.visible = false;
  this.planetGroup.add(this.metaballMesh);

  // ---------------- particles: ONE combined, camera-sorted Points system ----
  // Every airborne class (liquid beads, glossy spray, vapor, cloud, snow)
  // shares a single draw call with a per-particle sprite tile, size and
  // alpha. Each frame the particle list is bucket-sorted by squared distance
  // from the camera (far → near, O(n) counting sort) so a far vapor cloudlet
  // or cloud puff can never paint over a nearer water bead or snow grain —
  // particles only ever composite front-to-back correctly, in every order.
  // depthTest stays on (terrain still occludes the far side); depthWrite
  // stays off (no particle hides another through depth).
  this.allGeo = new THREE.BufferGeometry();
  this.allPos = new Float32Array(27);
  this.allCol = new Float32Array(27);
  this.allAlpha = new Float32Array(9);
  this.allSize = new Float32Array(9);
  this.allSprite = new Float32Array(9);
  this.allGeo.setAttribute('position', new THREE.BufferAttribute(this.allPos, 3).setUsage(THREE.DynamicDrawUsage));
  this.allGeo.setAttribute('aCol', new THREE.BufferAttribute(this.allCol, 3).setUsage(THREE.DynamicDrawUsage));
  this.allGeo.setAttribute('aAlpha', new THREE.BufferAttribute(this.allAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  this.allGeo.setAttribute('aSize', new THREE.BufferAttribute(this.allSize, 1).setUsage(THREE.DynamicDrawUsage));
  this.allGeo.setAttribute('aSprite', new THREE.BufferAttribute(this.allSprite, 1).setUsage(THREE.DynamicDrawUsage));
  this.atlasTex = makeParticleAtlas();
  this.allMat = new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: this.atlasTex },
      uTiles: { value: new THREE.Vector2(ATLAS_COLS, ATLAS_ROWS) },
      uPointScale: { value: 300 }
    },
    vertexShader: [
      'attribute vec3 aCol;',
      'attribute float aAlpha;',
      'attribute float aSize;',
      'attribute float aSprite;',
      'uniform float uPointScale;',
      'varying vec3 vCol;',
      'varying float vA;',
      'varying float vT;',
      'void main() {',
      '  vCol = aCol; vA = aAlpha; vT = aSprite;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  gl_PointSize = aSize * (uPointScale / max(0.15, -mv.z));',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D uAtlas;',
      'uniform vec2 uTiles;',
      'varying vec3 vCol;',
      'varying float vA;',
      'varying float vT;',
      'void main() {',
      '  float tile = floor(vT + 0.5);',
      '  float tx = mod(tile, uTiles.x);',
      '  float ty = floor(tile / uTiles.x);',
      '  vec2 uv = (vec2(tx, ty) + clamp(gl_PointCoord, 0.03, 0.97)) / uTiles;',
      '  vec4 tex = texture2D(uAtlas, uv);',
      '  float a = tex.a * vA;',
      '  if (a < 0.02) discard;',
      '  gl_FragColor = vec4(vCol * tex.rgb, a);',
      '}'
    ].join('\n'),
    transparent: true,
    depthWrite: false,
    depthTest: true
  });
  this.allPts = new THREE.Points(this.allGeo, this.allMat);
  this.allPts.frustumCulled = false;
  this.allPts.renderOrder = 2;         // under the water surface film (4)
  this.allPts.visible = false;         // draw range set by updateParticles
  this.planetGroup.add(this.allPts);
  // per-class staging (same names the sorting pass reads back)
  this.pPos = new Float32Array(27); this.pCol = new Float32Array(27);   // spray/rain
  this.vPos = new Float32Array(27); this.vCol = new Float32Array(27);   // vapor
  this.cPos = new Float32Array(27); this.cCol = new Float32Array(27);   // cloud
  this.sPos = new Float32Array(27); this.sCol = new Float32Array(27);   // snow
  this.bPos = new Float32Array(27); this.bCol = new Float32Array(27);   // liquid beads
  this._classCounts = { beads: 0, spray: 0, vapor: 0, cloud: 0, snow: 0 };
  // sort scratch (allocation-free, sized in _ensureParticles)
  this._d2 = new Float32Array(9);
  this._ord = new Uint32Array(9);
  this._bkt = new Int32Array(65);
  this._hist = new Int32Array(64);
  this._camLocal = new THREE.Vector3(0, 0, 0);
  this._invPlanet = new THREE.Matrix4();
  this._tmpV3 = new THREE.Vector3();
  this.pOpa = 1;                       // user transparency multiplier (spray/vapor)
  this.waterOpa = 0.25;                // water-surface opacity (drives liquid beads)
  this.beadsMode = false;              // water as droplet particles, no surface mesh

  // ---------------- balls
  this.ballGroup = new THREE.Group();
  this.planetGroup.add(this.ballGroup);
  this._ballMeshes = [];

  // stir handle
  this.handle = new THREE.Mesh(
    new THREE.SphereGeometry(0.45, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xbfe9ff, wireframe: true, transparent: true, opacity: 0.35 })
  );
  this.handle.visible = false;
  this.planetGroup.add(this.handle);

  // ---------------- lightning over dense vapor (decorative)
  // Short additive flashes sparkling where evaporated particles crowd —
  // storm light above the densest vapor pockets — plus a bright blue bolt
  // channel drawn from the pocket down to the terrain beneath it. Small
  // sprite pool with a fast attack / flicker-decay envelope; never touches
  // the simulation.
  this._BOLT_PTS = 9;                  // points along one bolt channel
  this._flashes = [];
  // soft radial glow texture for the flash (a SpriteMaterial without a map
  // renders as an untextured white square — always give it the gradient)
  var flashTex = makeCloudTexture();
  for (var li = 0; li < 10; li++) {
    var lSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flashTex, color: 0xdcecff, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending
    }));
    lSprite.visible = false;
    lSprite.renderOrder = 8;
    this.planetGroup.add(lSprite);
    var bGeo = new THREE.BufferGeometry();
    bGeo.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(this._BOLT_PTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
    bGeo.setDrawRange(0, 0);
    var bolt = new THREE.Line(bGeo, new THREE.LineBasicMaterial({
      color: 0x8fd4ff,                 // bright blue channel
      transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending
    }));
    bolt.visible = false;
    bolt.frustumCulled = false;
    bolt.renderOrder = 9;
    this.planetGroup.add(bolt);
    this._flashes.push({ sprite: lSprite, bolt: bolt, age: 0, life: 0, seed: 0, scale: 1 });
  }

  // ---------------- water velocity vectors (Display checkbox)
  // One line per sampled water particle: from the particle along its velocity,
  // length proportional to speed, color ramping calm blue → white with speed.
  this._VEC_MAX = 9000;
  var vecGeo = new THREE.BufferGeometry();
  this.vVecPos = new Float32Array(this._VEC_MAX * 6);
  this.vVecCol = new Float32Array(this._VEC_MAX * 6);
  vecGeo.setAttribute('position', new THREE.BufferAttribute(this.vVecPos, 3).setUsage(THREE.DynamicDrawUsage));
  vecGeo.setAttribute('color', new THREE.BufferAttribute(this.vVecCol, 3).setUsage(THREE.DynamicDrawUsage));
  vecGeo.setDrawRange(0, 0);
  this.vecLines = new THREE.LineSegments(vecGeo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.9,
    depthWrite: false, blending: THREE.AdditiveBlending
  }));
  this.vecLines.frustumCulled = false;
  this.vecLines.visible = false;
  this.vecLines.renderOrder = 8;
  this.planetGroup.add(this.vecLines);

  this._bindResize(container);
}

// ------------------------------------------------------------------- world
// Build pool or planet visuals for the current solver domain.
WaterScene.prototype._buildWorld = function (W, H, D, opts) {
  opts = opts || {};
  this.coreR = opts.coreR || 0;
  this.oceanR = opts.oceanR || 0;
  // planet mode lights particles by sun exposure (real dark hemisphere)
  this._planetLit = (this.oceanR > 0);
  this._buildSphere(W, H, D, opts);
};

// Resize the world (called after the solver is rebuilt).
WaterScene.prototype.setWorld = function (W, H, D, opts) {
  this._buildWorld(W, H, D, opts);
};

// Place the sun (billboard + directional light) at its FIXED world position —
// called once per world build. The per-frame planet pose, halo direction and
// the sun expressed in the planet's rotating frame are handled by
// updatePlanetMotion() below.
WaterScene.prototype.setSun = function (x, y, z) {
  this.sunPos.set(x, y, z);
  this.sun.position.set(x, y, z);
  this.sunSprite.position.set(x, y, z);
  var d = this._sunDist || this.sunPos.length();   // apparent size ~ 1/planet-sun distance
  var s = Math.max(2.2, d * 0.5);
  this.sunSprite.scale.set(s, s, 1);
};

// ------------------------------------------------- orbit & rotation motion
// The sun is FIXED; the planet revolves around it on a horizontal circle
// (one "year") while spinning about its own vertical axis (one "day"). The
// sun sits IN the orbital-plane centre (elevation 0): with axial tilt 0 the
// planet→sun vector stays exactly in the equatorial plane so both poles get
// symmetric grazing irradiation; with tilt ≠ 0 the sun's latitude over the
// planet oscillates ±tilt over a year (seasons).

// Periods are in seconds; values <= 0 (or non-finite) freeze that motion.
WaterScene.prototype.setYearPeriod = function (sec) {
  this.yearPeriod = (sec > 0 && isFinite(sec)) ? sec : Infinity;
};
// Axial tilt in DEGREES against the orbital (ecliptic) axis. Applied as a
// fixed world-space rotZ on the tilt group; 0 keeps the classic upright spin.
WaterScene.prototype.setTilt = function (deg) {
  this._tiltRad = (isFinite(deg) ? deg : 0) * Math.PI / 180;
};

WaterScene.prototype.setSpinPeriod = function (sec) {
  this.spinPeriod = (sec > 0 && isFinite(sec)) ? sec : Infinity;
};

// Advance the orbit ("year") and axial spin ("day") by dt seconds — dt = 0
// freezes the angles but still refreshes the pose — then update everything
// that depends on the planet's motion: the group transform, the halo's sun
// direction, the camera target, and the sun expressed in the planet's
// rotating frame (sunLocal / _sunDirLocal) used by the solver and the
// particle day/night lighting.
WaterScene.prototype.updatePlanetMotion = function (dt) {
  if (dt > 0) {
    // proper modulo wrap so even huge dt steps (calibration, tab stalls)
    // keep the angles canonical
    this.orbitAngle = (this.orbitAngle + dt * Math.PI * 2 / this.yearPeriod) % (Math.PI * 2);
    this.spinAngle = (this.spinAngle + dt * Math.PI * 2 / this.spinPeriod) % (Math.PI * 2);
  }
  var cx = this.W * 0.5, cy = this.H * 0.5, cz = this.D * 0.5;
  var R = this._orbitR || 0, ca = Math.cos(this.orbitAngle), sa = Math.sin(this.orbitAngle);
  // planet centre, world frame: horizontal circle around the sun's axis
  var px = cx + R * ca, py = cy, pz = cz + R * sa;
  this._planetWorld.set(px, py, pz);
  // Group transform: a local domain point d must land at
  // planetWorld + rotY(spin)·(d − c), so with the group rotating by `spin`
  // its position is planetWorld − rotY(spin)·c.
  var cs = Math.cos(this.spinAngle), sn = Math.sin(this.spinAngle);
  var rcx = cx * cs + cz * sn, rcz = -cx * sn + cz * cs;
  // Tilted two-group transform: tiltGroup sits at the planet centre carrying
  // the fixed axial tilt; the spinning planet group hangs at −centre inside
  // it. A local point d lands at planetWorld + rotZ(tilt)·rotY(spin)·(d − c).
  this.tiltGroup.position.set(px, py, pz);
  this.tiltGroup.rotation.z = this._tiltRad || 0;
  this.planetGroup.rotation.y = this.spinAngle;
  this.planetGroup.position.set(-rcx, -cy, -rcz);
  // sun direction: world (planet→sun), then back into the tilted+spinning
  // frame — undo the fixed tilt (rotZ) first, then the daily spin (rotY)
  var wx = this.sunPos.x - px, wy = this.sunPos.y - py, wz = this.sunPos.z - pz;
  if (this._haloSun) this._haloSun.value.set(wx, wy, wz).normalize();
  var t = this._tiltRad || 0, ct = Math.cos(t), st = Math.sin(t);
  var ux = wx * ct + wy * st, uy = -wx * st + wy * ct, uz = wz;
  var lx = ux * cs - uz * sn, ly = uy, lz = ux * sn + uz * cs;
  var ll = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
  this._sunDirLocal.set(lx / ll, ly / ll, lz / ll);
  var dist = this._sunDist || ll;
  this.sunLocal.set(cx + this._sunDirLocal.x * dist,
    cy + this._sunDirLocal.y * dist,
    cz + this._sunDirLocal.z * dist);
  // the camera follows the planet around its orbit
  if (this.orbit) this.orbit.target.copy(this._planetWorld);
};

// Convert a world-space point into the planet's local (solver) frame,
// undoing both the orbital translation and the axial spin. Used by the stir
// raycast so the hand stays glued to the moving, spinning ocean.
WaterScene.prototype.planetToLocal = function (out, x, y, z) {
  var dx = x - this._planetWorld.x, dy = y - this._planetWorld.y, dz = z - this._planetWorld.z;
  // undo the fixed axial tilt (rotZ), then the daily spin (rotY)
  var t = this._tiltRad || 0, ct = Math.cos(t), st = Math.sin(t);
  var ux = dx * ct + dy * st, uy = -dx * st + dy * ct, uz = dz;
  var cs = Math.cos(this.spinAngle), sn = Math.sin(this.spinAngle);
  out.set(ux * cs - uz * sn + this.W * 0.5,
    uy + this.H * 0.5,
    ux * sn + uz * cs + this.D * 0.5);
  return out;
};

// --------------------------------- ocean planet: solid core + atmosphere
WaterScene.prototype._buildSphere = function (W, H, D, opts) {
  opts = opts || {};
  this.W = W; this.H = H; this.D = D;
  this._disposeWorldMeshes();
  var self = this;
  function add(m) { self._poolMeshes.push(m); self.planetGroup.add(m); return m; }

  var cx = W / 2, cy = H / 2, cz = D / 2;
  var coreR = this.coreR, oceanR = this.oceanR;

  var core = new THREE.Mesh(
    new THREE.SphereGeometry(coreR - 0.02, 48, 32),
    new THREE.MeshStandardMaterial({
      map: makePlanetTexture(), roughness: 0.72, metalness: 0.06
    })
  );
  core.position.set(cx, cy, cz);
  core.castShadow = true;
  core.receiveShadow = true;
  core.userData.corePlaceholder = true;   // swapped out by buildTerrain()
  add(core);

  // atmosphere halo: back-face additive shell that only glows on the sunlit
  // limb — the night side of the atmosphere goes dark with the planet.
  // A thin optical scattering layer hugs the globe; individual cloudlets
  // can travel higher, up to the solver's atmosphere ceiling.
  // (Currently HIDDEN — see halo.visible below.)
  var atmH = opts.atmosphereH || 0.35;
  this._terrainRhi = opts.terrainRhi || oceanR;
  // the halo shows the atmosphere the slider promises: thickness = the full
  // atmosphere height (the physical ceiling matches — see solver), rim
  // offsets scale with the world
  var wS0 = Math.max(oceanR / 1.95, 0.05);
  var thick0 = Math.max(atmH, 0.02);
  var haloR = Math.max(oceanR + thick0 * 0.28 + 0.04 * wS0, this._terrainRhi + 0.05 * wS0);
  var haloMat = new THREE.ShaderMaterial({
    uniforms: { uSun: { value: new THREE.Vector3(0.5, 0.8, 0.2) } },
    vertexShader: [
      'varying vec3 vN; varying vec3 vView;',
      'void main(){',
      '  vN = normalize(mat3(modelMatrix) * normal);',
      '  vView = cameraPosition - (modelMatrix * vec4(position,1.0)).xyz;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uSun;',
      'varying vec3 vN; varying vec3 vView;',
      'void main(){',
      '  float d = dot(normalize(vN), normalize(uSun));',
      '  float limb = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 3.0);',
      '  float daylight = smoothstep(-0.24, 0.5, d);',
      '  float a = limb * (0.018 + daylight * 0.22);',
      '  vec3 tint = mix(vec3(0.35,0.20,0.13), vec3(0.20,0.48,0.92), daylight);',
      '  gl_FragColor = vec4(tint, a);',
      '}'
    ].join('\n'),
    side: THREE.BackSide, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false
  });
  this._haloSun = haloMat.uniforms.uSun;
  var halo = new THREE.Mesh(
    new THREE.SphereGeometry(haloR, 40, 26),
    haloMat
  );
  halo.position.set(cx, cy, cz);
  this._haloMesh = halo; this._haloRadius = haloR;
  halo.renderOrder = 6;
  add(halo);
  // the limb halo is hidden per spec: the atmosphere stays physical (vapor,
  // ceiling, lighting) but renders no additive glow shell around the planet.
  // Kept in the graph so setAtmosphereHeight and the sun-uniform bookkeeping
  // keep working; flip visible back on to restore the glow.
  halo.visible = false;

  // fixed sun + shadow frustum: the sun sits IN the centre of the orbital
  // plane (elevation 0) at distance oceanR * 3.4; the planet revolves around
  // it, so with axial tilt 0 the sun latitude stays 0 (symmetric poles) and
  // with tilt > 0 it oscillates ±tilt over a year (seasons).
  var sunDist = oceanR * 3.4;
  this._sunDist = sunDist;
  this._orbitR = sunDist;
  this._sunHeight = 0;
  this.setSun(cx, cy, cz);
  var ext = Math.max(6, oceanR * 2.2);
  this.sun.shadow.camera.left = -ext; this.sun.shadow.camera.right = ext;
  this.sun.shadow.camera.top = ext; this.sun.shadow.camera.bottom = -ext;
  // world scale relative to the default planet (oceanR 1.95) — everything
  // scene-sized hangs off it so radius 0.5 m … 25 m all frame correctly
  var wScale = Math.max(oceanR / 1.95, 0.05);
  this._wScale = wScale;
  this.sun.shadow.camera.near = Math.max(0.5, sunDist - oceanR * 2);
  this.sun.shadow.camera.far = sunDist + oceanR * 3;
  this.sun.shadow.bias = -0.0004 * Math.max(1, wScale);
  this.sun.shadow.camera.updateProjectionMatrix();
  this.sun.target.position.set(cx, cy, cz);   // local planet centre (group child)

  // camera + sky + stars scale with the world (defaults keep the shipped look)
  this.camera.near = 0.05 * Math.max(1, wScale);
  this.camera.far = Math.max(220, 130 * wScale);
  this.camera.updateProjectionMatrix();
  if (this._sky) this._sky.scale.setScalar(Math.max(1, wScale));
  if (this._starGroup) this._starGroup.scale.setScalar(Math.max(1, wScale));
  if (this.handle) this.handle.scale.setScalar(Math.max(0.05, wScale));

  if (this.orbit) {
    this.orbit.target.set(cx, cy, cz);
    var fit = oceanR * 3.6;
    // zoom limits scale with the world: classic min 2.2 / max 16 at oceanR
    // 1.95 (min = oceanR·1.128 keeps the camera out of the planet at 25 m,
    // and lets it come close on a 0.5 m one)
    this.orbit.minRadius = oceanR * (2.2 / 1.95);
    this.orbit.maxRadius = Math.max(16, fit * 1.8);
    this.orbit.tRadius = Math.max(this.orbit.minRadius, Math.min(this.orbit.maxRadius, fit));
  }
  // place the planet on its orbit for this world size; refreshes the pose,
  // halo sun direction and the sun in the planet's rotating frame
  this.updatePlanetMotion(0);
};

// ------------------------------------------------- voxel terrain (gouraud)
// Swap the smooth placeholder core for the solver's voxel terrain mesh.
// The same terrain object rebuilds are skipped (reset refills water, not rock).
WaterScene.prototype.buildTerrain = function (terrain, colorHex) {
  if (!terrain || typeof THREE === 'undefined') return;
  if (colorHex) this.planetColor = colorHex;
  if (this._terrainMesh && this._terrainMesh.userData.terrain === terrain) {
    return;                                  // unchanged rock — keep the mesh
  }
  var group = this.planetGroup;
  if (this._terrainMesh) {
    group.remove(this._terrainMesh);
    var ti = this._poolMeshes.indexOf(this._terrainMesh);
    if (ti >= 0) this._poolMeshes.splice(ti, 1);
    this._terrainMesh.geometry.dispose();
    if (this._terrainMesh.material.map) this._terrainMesh.material.map.dispose();
    this._terrainMesh.material.dispose();
    this._terrainMesh = null;
  }
  // drop the placeholder smooth core
  for (var pi = this._poolMeshes.length - 1; pi >= 0; pi--) {
    var pm = this._poolMeshes[pi];
    if (pm.userData && pm.userData.corePlaceholder) {
      group.remove(pm);
      if (pm.geometry) pm.geometry.dispose();
      if (pm.material) {
        if (pm.material.map) pm.material.map.dispose();
        pm.material.dispose();
      }
      this._poolMeshes.splice(pi, 1);
    }
  }
  var mesh = buildVoxelTerrainMesh(terrain, this.planetColor || '#654321');
  if (!mesh) return;                       // headless stub: keep the placeholder core
  mesh.userData.terrain = terrain;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  this._terrainMesh = mesh;
  this._poolMeshes.push(mesh);
  group.add(mesh);
};

// Planet surface color from the UI color picker (dark brown by default).
// The picker drives the rock hue of the vertex palette; the geometry and the
// green waterline / white snow bands stay fixed.
WaterScene.prototype.setPlanetColor = function (hex) {
  this.planetColor = hex;
  if (this._terrainMesh) recolorTerrainMesh(this._terrainMesh, hex);
};

// dispose every world mesh (shared by pool and planet rebuilds)
WaterScene.prototype._disposeWorldMeshes = function () {
  for (var di = 0; di < this._poolMeshes.length; di++) {
    var old = this._poolMeshes[di];
    this.planetGroup.remove(old);
    if (old.geometry) old.geometry.dispose();
    if (old.material) {
      if (old.material.map) old.material.map.dispose();
      old.material.dispose();
    }
  }
  if (this.caus2) { this.caus2.dispose(); this.caus2 = null; }
  this._terrainMesh = null;
  this._poolMeshes.length = 0;
};

// ------------------------------------------------------------------- pool
// (Re)build every piece of pool geometry for the current W/H/D. Old meshes,
// geometries, materials and textures are disposed so the pool can be resized
// from the UI without leaking GPU memory.
// ---------------------------------------------------------------- water mesh
WaterScene.prototype.updateWater = function (pos, nrm, count) {
  var geo = this.waterGeo;
  var pa = geo.getAttribute('position');
  var na = geo.getAttribute('normal');
  if (!pa || pa.array !== pos) {
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage));
  } else {
    pa.needsUpdate = true;
    na.needsUpdate = true;
  }
  pa = geo.getAttribute('position'); na = geo.getAttribute('normal');
  pa.updateRange.offset = na.updateRange.offset = 0;
  pa.updateRange.count = na.updateRange.count = count * 3;
  geo.setDrawRange(0, count);
};

// Metaball skin buffers — same refill pattern as updateWater; both display
// passes feed from the mesher's shared scratch arrays (only one runs/frame).
WaterScene.prototype.updateMetaballs = function (pos, nrm, count) {
  var geo = this.metaballGeo;
  var pa = geo.getAttribute('position');
  var na = geo.getAttribute('normal');
  if (!pa || pa.array !== pos) {
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage));
  } else {
    pa.needsUpdate = true;
    na.needsUpdate = true;
  }
  pa = geo.getAttribute('position'); na = geo.getAttribute('normal');
  pa.updateRange.offset = na.updateRange.offset = 0;
  pa.updateRange.count = na.updateRange.count = count * 3;
  geo.setDrawRange(0, count);
};

// ------------------------------------------------- metaball material editor
// Seed material for the metaball skin: a MeshPhysicalMaterial written out
// with the water surface's EXACT parameters (type, color, opacity, roughness,
// clearcoat, emissive rule) plus the metaball shader patch. Material.clone()
// does NOT copy onBeforeCompile in r128 (verified in vendor/three.min.js), so
// the seed is explicit rather than waterMat.clone(); with no editor input the
// skin is visually indistinguishable from the water surface.
WaterScene.prototype._seedMetaballMaterial = function () {
  var mat = new THREE.MeshPhysicalMaterial({
    color: 0x9fd4ee,                    // seeded to waterMat's shipped look
    roughness: 0.05,
    metalness: 0,
    transparent: true,
    opacity: 0.25,
    side: THREE.FrontSide,
    depthWrite: false,
    emissive: new THREE.Color(0x9fd4ee).multiplyScalar(0.24),
    envMapIntensity: 0.9,
    clearcoat: 1.0,
    clearcoatRoughness: 0.08
  });
  applyMetaballPatch(mat, this);
  return mat;
};

// Build a fresh material instance for the current editor state (_mblaShading,
// _mblaColor, _mblaOpacity, metaballGloss, _mblaTex). Used by the shading-model
// swap in setMetaballMaterial (material class changes require a new instance);
// the constructed material always gets the metaball shader patch so the
// texture layers + alpha pre-boost carry over to every variant.
WaterScene.prototype._buildMetaballMaterial = function () {
  var shade = this._mblaShading || 'physical';
  var col = this._mblaColor || new THREE.Color(0x9fd4ee);
  var opa = this._mblaOpacity !== undefined ? this._mblaOpacity : 0.25;
  var gloss = this.metaballGloss !== undefined ? this.metaballGloss : 0.95;
  var mat;
  if (shade === 'matte') {
    // diffuse-only lambert: no roughness/clearcoat state, emissive keeps the
    // same self-tint trick the water uses so blobs never read black in shade
    mat = new THREE.MeshLambertMaterial({
      color: col.clone(),
      emissive: col.clone().multiplyScalar(0.24),
      transparent: true,
      opacity: opa,
      side: THREE.FrontSide,
      depthWrite: false
    });
  } else if (shade === 'unlit') {
    // flat basic: color only (basic has no emissive), still alpha-blended
    mat = new THREE.MeshBasicMaterial({
      color: col.clone(),
      transparent: true,
      opacity: opa,
      side: THREE.FrontSide,
      depthWrite: false
    });
  } else {
    // physical: the water look with the editor's gloss mapping
    mat = new THREE.MeshPhysicalMaterial({
      color: col.clone(),
      roughness: 1 - gloss,               // gloss g → roughness 1−g
      metalness: 0,
      transparent: true,
      opacity: opa,
      side: THREE.FrontSide,
      depthWrite: false,
      emissive: col.clone().multiplyScalar(0.24),
      envMapIntensity: 0.9,
      clearcoat: gloss,                   // gloss g → clearcoat g
      clearcoatRoughness: 0.08
    });
  }
  applyMetaballPatch(mat, this);
  return mat;
};

// Push the current editor state onto the LIVE material (no rebuild): color /
// emissive from _mblaColor, opacity (+ transparent — the skin always composites
// over the particle pass), gloss on the physical variant, texture-gate
// uniforms. Safe to call repeatedly; also refreshes the patch userData.
WaterScene.prototype._applyMetaballMaterialState = function () {
  var m = this.metaballMat;
  if (!m) return;
  if (m.color && this._mblaColor) {
    m.color.set(this._mblaColor);
    if (m.emissive) m.emissive.set(this._mblaColor).multiplyScalar(0.24);
  }
  if (this._mblaOpacity !== undefined) {
    m.opacity = this._mblaOpacity;
    m.transparent = true;   // depthWrite false + renderOrder 4: must stay in the sorted transparent pass
  }
  if (m.isMeshPhysicalMaterial) {
    var g = this.metaballGloss !== undefined ? this.metaballGloss : 0.95;
    m.roughness = 1 - g;
    m.clearcoat = g;
  }
  if (this._mblaTexU) {
    this._mblaTexU.uMblaNoise.value = this._mblaTex === 'noise' ? 1 : 0;
    this._mblaTexU.uMblaCaustic.value = this._mblaTex === 'caustic' ? 1 : 0;
    this._mblaTexU.uMblaStripes.value = this._mblaTex === 'stripes' ? 1 : 0;
  }
  if (m.userData && m.userData.metaballPatch) {
    m.userData.metaballPatch.texture = this._mblaTex;
    m.userData.metaballPatch.shading = this._mblaShading;
    m.userData.metaballPatch.gloss = this.metaballGloss;
  }
};

// Metaball material editor entry point. Granular, order-independent options
// (any subset in one call; unlisted properties keep their current state):
//   color     — '#rrggbb' | hex number: sets the skin's color + emissive
//               (emissive = color·0.24, like the water) and marks the color
//               user-owned: setWaterColor stops syncing it (_mblaFollowWater
//               = false — documented sync rule, see the constructor block).
//   shading   — 'physical' (default, the water look) | 'matte' (Lambert) |
//               'unlit' (Basic). Rebuilds the material instance, carries the
//               color/opacity/gloss/texture state over, disposes the old
//               instance and repoints metaballMesh.material at the new one.
//   texture   — 'none' | 'noise' | 'caustic' | 'stripes': flips the uniform
//               gates of the single patched shader (no rebuild, no recompile).
//   opacity   — 0..1: material.opacity (material stays transparent; the skin
//               always alpha-blends over the particle pass).
//   gloss     — 0..1: roughness = 1−gloss and clearcoat = gloss (physical;
//               stored for matte/unlit and re-applied on a later swap).
// Returns the live material. Material-only edits never need a mesh rebuild.
WaterScene.prototype.setMetaballMaterial = function (opts) {
  opts = opts || {};
  if (!this._mblaColor) this._mblaColor = new THREE.Color(0x9fd4ee);
  if (!this._mblaTexU) {
    this._mblaTexU = { uMblaNoise: { value: 0 }, uMblaCaustic: { value: 0 }, uMblaStripes: { value: 0 } };
  }
  if (this._mblaOpacity === undefined) this._mblaOpacity = 0.25;
  if (this.metaballGloss === undefined) this.metaballGloss = 0.95;
  if (!this._mblaShading) this._mblaShading = 'physical';
  if (!this._mblaTex) this._mblaTex = 'none';
  var rebuild = false;
  if (opts.shading !== undefined) {
    var s = String(opts.shading);
    if ((s === 'physical' || s === 'matte' || s === 'unlit') && s !== this._mblaShading) {
      this._mblaShading = s;
      rebuild = true;
    }
  }
  if (opts.color !== undefined && opts.color !== null && opts.color !== '') {
    this._mblaFollowWater = false;      // the user owns the color from now on
    this._mblaColor.set(opts.color);
  }
  if (opts.opacity !== undefined && isFinite(opts.opacity)) {
    this._mblaOpacity = Math.min(1, Math.max(0, Number(opts.opacity)));
  }
  if (opts.gloss !== undefined && isFinite(opts.gloss)) {
    this.metaballGloss = Math.min(1, Math.max(0, Number(opts.gloss)));
  }
  if (opts.texture !== undefined && _MBLA_TEX_TYPES[opts.texture]) {
    this._mblaTex = String(opts.texture);
  }
  if (rebuild) {
    var old = this.metaballMat;
    this.metaballMat = this._buildMetaballMaterial();
    if (this.metaballMesh) this.metaballMesh.material = this.metaballMat;   // always the live instance
    if (old && old !== this.metaballMat && old.dispose) old.dispose();      // free the old program/state
  }
  this._applyMetaballMaterialState();
  return this.metaballMat;
};

WaterScene.prototype.setWaterOpacity = function (o) {
  this.waterOpa = o;
  this.waterMat.opacity = o;
  // In beads mode the liquid body IS the water surface — the flat blue
  // circles inherit this slider instead of the spray/atmosphere opacity
  // (baked per particle by the next updateParticles call).
};

// ------------------------------------------------------------------ particles
WaterScene.prototype._ensureParticles = function (n) {
  if (this.pPos.length >= n * 3) return;
  // per-class staging
  this.pPos = new Float32Array(n * 3); this.pCol = new Float32Array(n * 3);
  this.bPos = new Float32Array(n * 3); this.bCol = new Float32Array(n * 3);
  this.vPos = new Float32Array(n * 3); this.vCol = new Float32Array(n * 3);
  this.cPos = new Float32Array(n * 3); this.cCol = new Float32Array(n * 3);
  this.sPos = new Float32Array(n * 3); this.sCol = new Float32Array(n * 3);
  // combined sorted attributes
  this.allPos = new Float32Array(n * 3);
  this.allCol = new Float32Array(n * 3);
  this.allAlpha = new Float32Array(n);
  this.allSize = new Float32Array(n);
  this.allSprite = new Float32Array(n);
  this.allGeo.setAttribute('position', new THREE.BufferAttribute(this.allPos, 3).setUsage(THREE.DynamicDrawUsage));
  this.allGeo.setAttribute('aCol', new THREE.BufferAttribute(this.allCol, 3).setUsage(THREE.DynamicDrawUsage));
  this.allGeo.setAttribute('aAlpha', new THREE.BufferAttribute(this.allAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  this.allGeo.setAttribute('aSize', new THREE.BufferAttribute(this.allSize, 1).setUsage(THREE.DynamicDrawUsage));
  this.allGeo.setAttribute('aSprite', new THREE.BufferAttribute(this.allSprite, 1).setUsage(THREE.DynamicDrawUsage));
  // sort scratch
  this._d2 = new Float32Array(n);
  this._ord = new Uint32Array(n);
};

WaterScene.prototype.updateParticles = function (solver, show) {
  // Liquid droplets (beads mode) answer to the WATER-SURFACE opacity — the
  // droplet cloud IS the water surface in that mode. Rain/spray droplets and
  // vapor keep answering to the spray/atmosphere opacity slider. Metaball
  // mode replaces the circles with the fused metaball skin, so the liquid
  // class draws nothing there (it is inside the metaball surface).
  var showBeads = !!(show && this.beadsMode && this.waterOpa > 0.01 && !this.metaballMode);
  var showSpray = !!(show && this.pOpa > 0.01);
  var anyShow = showBeads || showSpray;
  this.allPts.visible = anyShow;
  this._classCounts.beads = this._classCounts.spray = this._classCounts.vapor =
    this._classCounts.cloud = this._classCounts.snow = 0;
  if (!anyShow) {
    this.allGeo.setDrawRange(0, 0);
    return;
  }
  var n = solver.nP;
  this._ensureParticles(n);
  var px = solver.px, py = solver.py, pz = solver.pz;
  var fl = solver.pflag;
  var T = solver.pT, hasT = T && T.length >= n;
  // per-particle sun exposure computed by the solver's thermal tick (terrain
  // shade + water-column optical depth + night side). Missing (first frame)
  // → hemispheric fallback.
  var pLight = solver.pLight, hasLight = pLight && pLight.length >= n;
  // per-particle water-overhead count mirrored by the solver's thermal tick:
  // 0 = at/above the local surface … 4 = deep interior (beads cull)
  var pDepth = solver.pDepth, hasDepth = pDepth && pDepth.length >= n;
  // per-class staging + counts
  var pPos = this.pPos, pCol = this.pCol, bPos = this.bPos, bCol = this.bCol;
  var vPos = this.vPos, vCol = this.vCol, cPos = this.cPos, cCol = this.cCol;
  var sPos = this.sPos, sCol = this.sCol;
  var nW = 0, nV = 0, nB = 0, nC = 0, nS = 0;
  // planet centre (local) + sun direction for the day/night dimming. Particle
  // coordinates live in the solver frame, which spins with the planet, so the
  // sun must be the local-frame direction: the terminator sweeps with the spin.
  var pPh = solver.pPh, spinCue = !!(solver.spinOn && pPh && pPh.length >= n);
  // spin-velocity color mode (chkSpinColor): every particle's color becomes
  // its spin angular-velocity vector ω = (ωx, ωy, ωz), each component
  // normalized to 0…1 across ALL particles in the simulation (global
  // per-component min/max, so the palette is one consistent scale — min → 0,
  // max → 1, zero spin → 0.5 grey; degenerate all-equal component → mid).
  var spinCol = !!this.spinColor;
  var wRx = 0, wRy = 0, wRz = 0, wMx = 0, wMy = 0, wMz = 0;
  if (spinCol) {
    var pWxs = solver.pWx, pWys = solver.pWy, pWzs = solver.pWz, nAll = solver.nP;
    if (pWxs && pWys && pWzs && pWxs.length >= nAll) {
      var loX = Infinity, loY = Infinity, loZ = Infinity, hiX = -Infinity, hiY = -Infinity, hiZ = -Infinity;
      for (var q = 0; q < nAll; q++) {
        var wxq = pWxs[q], wyq = pWys[q], wzq = pWzs[q];
        if (wxq < loX) loX = wxq; if (wxq > hiX) hiX = wxq;
        if (wyq < loY) loY = wyq; if (wyq > hiY) hiY = wyq;
        if (wzq < loZ) loZ = wzq; if (wzq > hiZ) hiZ = wzq;
      }
      wMx = loX; wMy = loY; wMz = loZ;
      wRx = (hiX > loX) ? 1 / (hiX - loX) : 0; wRy = (hiY > loY) ? 1 / (hiY - loY) : 0; wRz = (hiZ > loZ) ? 1 / (hiZ - loZ) : 0;
    } else {
      spinCol = false;   // no spin mirror yet → keep the class colors
    }
  }
  var pcx = this.W * 0.5, pcy = this.H * 0.5, pcz = this.D * 0.5;
  var sdx = this._sunDirLocal.x, sdy = this._sunDirLocal.y, sdz = this._sunDirLocal.z;
  var sln = 1;
  for (var p = 0; p < n; p++) {
    // Sun shading: a particle that does not see the sun renders shaded —
    // solver exposure when available (real terrain shadow, depth under
    // water, night side), hemispheric estimate otherwise. The 0.12 floor
    // keeps particles barely visible in full darkness instead of glowing.
    var expo = 1;
    if (this._planetLit) {
      if (hasLight) {
        expo = pLight[p];
        if (!(expo > 0)) expo = 0; else if (expo > 1) expo = 1;
      } else {
        var exn = px[p] - pcx, eyn = py[p] - pcy, ezn = pz[p] - pcz;
        var eln = Math.sqrt(exn * exn + eyn * eyn + ezn * ezn) || 1e-6;
        expo = (exn * sdx + eyn * sdy + ezn * sdz) / (eln * sln);
        if (expo < 0) expo = 0;
      }
    }
    var br = 0.12 + 0.88 * expo;
    var i3;
    var sunnyBead = false;   // day-hemisphere liquid bead (draws normal color)
    // spin-velocity color: R/G/B = the globally normalized ω components
    // (a degenerate — all-equal — component reads mid-grey)
    var sR = 0.5, sG = 0.5, sB = 0.5;
    if (spinCol) {
      sR = wRx ? (pWxs[p] - wMx) * wRx : 0.5;
      sG = wRy ? (pWys[p] - wMy) * wRy : 0.5;
      sB = wRz ? (pWzs[p] - wMz) * wRz : 0.5;
    }
    if (fl[p] === 3) {
      if (!showSpray) continue;
      // cloud droplets: light grey, almost solid — brighter than steam and
      // rendered from their own near-opaque sprite
      i3 = nC * 3; nC++;
      cPos[i3] = px[p]; cPos[i3 + 1] = py[p]; cPos[i3 + 2] = pz[p];
      if (spinCol) { cCol[i3] = sR; cCol[i3 + 1] = sG; cCol[i3 + 2] = sB; }
      else {
        var cl = 0.30 + 0.70 * br;
        if (spinCue) cl *= 0.9 + 0.1 * Math.cos(pPh[p]);
        cCol[i3] = 0.88 * cl; cCol[i3 + 1] = 0.90 * cl; cCol[i3 + 2] = 0.93 * cl;
      }
      continue;
    }
    if (fl[p] === 5) {
      if (!showSpray) continue;
      // snow: solid white disc, slight edge transparency; the exposure only
      // nudges brightness so snow stays white on the night side
      i3 = nS * 3; nS++;
      sPos[i3] = px[p]; sPos[i3 + 1] = py[p]; sPos[i3 + 2] = pz[p];
      if (spinCol) { sCol[i3] = sR; sCol[i3 + 1] = sG; sCol[i3 + 2] = sB; }
      else {
        var sw = 0.62 + 0.38 * br;
        sCol[i3] = sw; sCol[i3 + 1] = sw; sCol[i3 + 2] = sw;
      }
      continue;
    }
    if (fl[p] === 2) {
      if (!showSpray) continue;
      // Atmospheric parcels overlap into wisps rather than hard motes.
      i3 = nV * 3; nV++;
      vPos[i3] = px[p]; vPos[i3 + 1] = py[p]; vPos[i3 + 2] = pz[p];
      if (spinCol) { vCol[i3] = sR; vCol[i3 + 1] = sG; vCol[i3 + 2] = sB; }
      else {
        var cloudLight = 0.22 + 0.78 * br;
        if (spinCue) cloudLight *= 0.85 + 0.15 * Math.cos(pPh[p]);   // spin twinkle
        vCol[i3] = 0.76 * cloudLight; vCol[i3 + 1] = 0.85 * cloudLight; vCol[i3 + 2] = cloudLight;
      }
      continue;
    }
    if (fl[p] === 0) {
      // The liquid body is the continuous isosurface, not a droplet cloud —
      // EXCEPT in beads mode, where water renders exclusively as flat blue
      // circles whose transparency follows the water-surface opacity slider.
      if (!showBeads) continue;
      // Sunny-side water is NEVER "interior": on the day hemisphere every
      // liquid particle draws, with its normal color — the sun lights the
      // whole column and there is no dark speckle to hide. The depth cull
      // and the exposure darkening only shape the NIGHT side, where they
      // form the true planet shadow.
      var sunny = !this._planetLit;
      if (!sunny) {
        var sx0 = px[p] - pcx, sy0 = py[p] - pcy, sz0 = pz[p] - pcz;
        var sl0 = Math.sqrt(sx0 * sx0 + sy0 * sy0 + sz0 * sz0) || 1e-6;
        sunny = (sx0 * sdx + sy0 * sdy + sz0 * sdz) / (sl0 * sln) > 0;
      }
      if (!sunny && hasDepth && pDepth[p] > 1) continue;
      sunnyBead = sunny;
      i3 = nB * 3; nB++;
      bPos[i3] = px[p]; bPos[i3 + 1] = py[p]; bPos[i3 + 2] = pz[p];
    } else {
      if (!showSpray) continue;
      i3 = nW * 3; nW++;
      pPos[i3] = px[p]; pPos[i3 + 1] = py[p]; pPos[i3 + 2] = pz[p];
    }
    // Water keeps the selected hue; temperature only subtly changes
    // brightness, never turns the water into orange droplets. Rain is
    // brightened so droplets read against the body. The sun exposure
    // (`br`) darkens every class — flat circles, rain and vapor alike.
    var t = hasT ? T[p] : 0.32; if (t < 0) t = 0; else if (t > 1) t = 1;
    var w = Math.pow(t, 1.4);
    var cr = this.waterColor.r * (0.9 + 0.1 * w);
    var cg = this.waterColor.g;
    var cb = this.waterColor.b;
    if (fl[p] === 1 || fl[p] === 4) {   // rain stays bright, keeps its heat tint
      cr = cr * 0.45 + 0.55; cg = cg * 0.45 + 0.55; cb = cb * 0.45 + 0.55;
    }
    if (fl[p] === 0) {   // flat circles: hue × exposure shading — but a
      // sunny-side bead keeps its NORMAL color (no exposure darkening);
      // spin-color mode replaces the hue with the normalized ω vector
      if (spinCol) { bCol[i3] = sR; bCol[i3 + 1] = sG; bCol[i3 + 2] = sB; }
      else {
        var brr = sunnyBead ? 1 : br;
        bCol[i3] = cr * brr; bCol[i3 + 1] = cg * brr; bCol[i3 + 2] = cb * brr;
      }
    } else {             // rain + vapor sprites: hue × exposure shading
      if (spinCol) { pCol[i3] = sR; pCol[i3 + 1] = sG; pCol[i3 + 2] = sB; }
      else { pCol[i3] = cr * br; pCol[i3 + 1] = cg * br; pCol[i3 + 2] = cb * br; }
    }
  }
  this._classCounts.beads = nB; this._classCounts.spray = nW;
  this._classCounts.vapor = nV; this._classCounts.cloud = nC; this._classCounts.snow = nS;
  var total = nB + nW + nV + nC + nS;
  var allPos = this.allPos, allCol = this.allCol, allAlpha = this.allAlpha;
  var allSize = this.allSize, allSprite = this.allSprite;
  this.allGeo.setDrawRange(0, total);
  if (!total) return;
  // per-class size + alpha (world units; the shader scales by camera distance)
  var spSz = solver.spacing;
  if (!(isFinite(spSz) && spSz > 0.02)) spSz = 0.06;
  var wS = this._wScale || 1;
  var beadSz = spSz * 3.4;                       // water circle diameter
  var spraySz = spSz * 3.4 / 3;                  // glossy rain: 3× smaller
  var vapSz = Math.max(0.18 * wS, Math.min(0.4 * wS, spSz * 5));
  var cloudSz = Math.max(0.30 * wS, Math.min(0.62 * wS, spSz * 6.5));
  var snowSz = spSz * 3.4;                       // snow: same disc size as water
  var beadA = Math.min(1, Math.max(0, this.waterOpa));
  var sprayA = Math.min(1, 0.95 * this.pOpa);
  var vapA = 0.23 * Math.sqrt(this.pOpa);
  var cloudA = Math.min(1, 0.88 * this.pOpa);
  var snowA = 1;                                 // ice is opaque: never follows the spray/atmosphere opacity slider
  // ---- camera-relative depth (planet-local frame) --------------------------
  // Particles live in the planetGroup's local (solver) frame; the camera is
  // somewhere else entirely (world). Pull the camera into that frame once,
  // then bucket-sort every particle far → near so painter order matches
  // physical depth across ALL classes: nothing farther may paint over a
  // nearer particle, whatever the class pair.
  var camL = this._camLocal, sortOn = false;
  if (this.planetGroup && this.planetGroup.matrixWorld && this.camera &&
      this.camera.matrixWorld) {
    this._tmpV3.setFromMatrixPosition(this.camera.matrixWorld);
    this._invPlanet.copy(this.planetGroup.matrixWorld).invert();
    camL.copy(this._tmpV3).applyMatrix4(this._invPlanet);
    sortOn = true;
  } else {
    camL.set(pcx, pcy, pcz);   // fallback: sort by radius from the center
  }
  var clx = camL.x, cly = camL.y, clz = camL.z;
  var d2 = this._d2, ord = this._ord;
  var offB = 0, offP = nB, offV = offP + nW, offC = offV + nV, offS = offC + nC;
  var e, x2, y2, z2, dx2, dy2, dz2;
  for (e = 0; e < nB; e++) {
    i3 = e * 3;
    dx2 = bPos[i3] - clx; dy2 = bPos[i3 + 1] - cly; dz2 = bPos[i3 + 2] - clz;
    d2[offB + e] = dx2 * dx2 + dy2 * dy2 + dz2 * dz2;
  }
  for (e = 0; e < nW; e++) {
    i3 = e * 3;
    dx2 = pPos[i3] - clx; dy2 = pPos[i3 + 1] - cly; dz2 = pPos[i3 + 2] - clz;
    d2[offP + e] = dx2 * dx2 + dy2 * dy2 + dz2 * dz2;
  }
  for (e = 0; e < nV; e++) {
    i3 = e * 3;
    dx2 = vPos[i3] - clx; dy2 = vPos[i3 + 1] - cly; dz2 = vPos[i3 + 2] - clz;
    d2[offV + e] = dx2 * dx2 + dy2 * dy2 + dz2 * dz2;
  }
  for (e = 0; e < nC; e++) {
    i3 = e * 3;
    dx2 = cPos[i3] - clx; dy2 = cPos[i3 + 1] - cly; dz2 = cPos[i3 + 2] - clz;
    d2[offC + e] = dx2 * dx2 + dy2 * dy2 + dz2 * dz2;
  }
  for (e = 0; e < nS; e++) {
    i3 = e * 3;
    dx2 = sPos[i3] - clx; dy2 = sPos[i3 + 1] - cly; dz2 = sPos[i3 + 2] - clz;
    d2[offS + e] = dx2 * dx2 + dy2 * dy2 + dz2 * dz2;
  }
  // ---- bucket sort far → near (64 buckets, allocation-free) ---------------
  if (sortOn && total > 1) {
    var hist = this._hist, bkt = this._bkt;
    var lo = Infinity, hi = -Infinity;
    for (e = 0; e < total; e++) {
      var dvv = d2[e];
      if (dvv < lo) lo = dvv;
      if (dvv > hi) hi = dvv;
    }
    var NB = 64, inv = hi > lo ? (NB - 1) / (hi - lo + 1e-9) : 0;
    for (e = 0; e < NB; e++) hist[e] = 0;
    for (e = 0; e < total; e++) {
      var bk = ((d2[e] - lo) * inv) | 0;
      if (bk < 0) bk = 0; else if (bk >= NB) bk = NB - 1;
      hist[bk]++;
    }
    var acc = 0;                          // far buckets first → start offsets
    for (bk = NB - 1; bk >= 0; bk--) { bkt[bk] = acc; acc += hist[bk]; }
    for (e = 0; e < total; e++) {
      bk = ((d2[e] - lo) * inv) | 0;
      if (bk < 0) bk = 0; else if (bk >= NB) bk = NB - 1;
      ord[bkt[bk]++] = e;
    }
  } else {
    for (e = 0; e < total; e++) ord[e] = e;
  }
  // ---- write the sorted draw list ------------------------------------------
  for (var k = 0; k < total; k++) {
    e = ord[k];
    var ax, ay, az, rC, gC, bC, al, sz, sp;
    if (e < offP) {                     // liquid beads
      i3 = e * 3;
      ax = bPos[i3]; ay = bPos[i3 + 1]; az = bPos[i3 + 2];
      rC = bCol[i3]; gC = bCol[i3 + 1]; bC = bCol[i3 + 2];
      al = beadA; sz = beadSz; sp = 0;
    } else if (e < offV) {
      i3 = (e - offP) * 3;
      ax = pPos[i3]; ay = pPos[i3 + 1]; az = pPos[i3 + 2];
      rC = pCol[i3]; gC = pCol[i3 + 1]; bC = pCol[i3 + 2];
      al = sprayA; sz = spraySz; sp = 1;
    } else if (e < offC) {
      i3 = (e - offV) * 3;
      ax = vPos[i3]; ay = vPos[i3 + 1]; az = vPos[i3 + 2];
      rC = vCol[i3]; gC = vCol[i3 + 1]; bC = vCol[i3 + 2];
      al = vapA; sz = vapSz; sp = 2;
    } else if (e < offS) {
      i3 = (e - offC) * 3;
      ax = cPos[i3]; ay = cPos[i3 + 1]; az = cPos[i3 + 2];
      rC = cCol[i3]; gC = cCol[i3 + 1]; bC = cCol[i3 + 2];
      al = cloudA; sz = cloudSz; sp = 3;
    } else {
      i3 = (e - offS) * 3;
      ax = sPos[i3]; ay = sPos[i3 + 1]; az = sPos[i3 + 2];
      rC = sCol[i3]; gC = sCol[i3 + 1]; bC = sCol[i3 + 2];
      al = snowA; sz = snowSz; sp = 4;
    }
    i3 = k * 3;
    allPos[i3] = ax; allPos[i3 + 1] = ay; allPos[i3 + 2] = az;
    allCol[i3] = rC; allCol[i3 + 1] = gC; allCol[i3 + 2] = bC;
    allAlpha[k] = al; allSize[k] = sz; allSprite[k] = sp;
  }
  var pa = this.allGeo.getAttribute('position');
  var ca = this.allGeo.getAttribute('aCol');
  pa.updateRange.offset = ca.updateRange.offset = 0;
  pa.updateRange.count = ca.updateRange.count = total * 3;
  pa.needsUpdate = ca.needsUpdate = true;
  var aa = this.allGeo.getAttribute('aAlpha');
  var sa = this.allGeo.getAttribute('aSize');
  var ta = this.allGeo.getAttribute('aSprite');
  aa.updateRange.offset = sa.updateRange.offset = ta.updateRange.offset = 0;
  aa.updateRange.count = sa.updateRange.count = ta.updateRange.count = total;
  aa.needsUpdate = sa.needsUpdate = ta.needsUpdate = true;
};

WaterScene.prototype.setParticlesOpacity = function (o) {
  // o in [0,1]: 1 = the default soft semi-transparent look, 0 = hidden.
  // Governs spray droplets and vapor only — the liquid beads follow the
  // water-surface opacity slider (see setWaterOpacity). The per-class
  // alphas are baked per particle by the next updateParticles call.
  this.pOpa = o;
};

// Beads mode: render the liquid body EXCLUSIVELY as flat blue circles — the
// isosurface mesh is hidden and the marching-tets pass is skipped by the app.
// Purely a display switch; physics is untouched. The circles' transparency
// follows the Water surface opacity slider.
WaterScene.prototype.setBeadsMode = function (on) {
  this.beadsMode = !!on;
  if (this.waterMesh) this.waterMesh.visible = !this.beadsMode && !this.metaballMode;
};

// Metaball mode: the liquid body renders as a blended metaball skin built
// from the water particles (Blinn field + marching tets in surface.js). It
// replaces BOTH other water-body renderings — the isosurface mesh stays
// hidden (like beads mode) and the liquid bead circles are suppressed in
// updateParticles — while spray / vapor / cloud / snow keep drawing. The skin
// carries its OWN material (metaballMat, see the constructor block), seeded to
// match the water and editable through the Metaball material editor.
WaterScene.prototype.setMetaballs = function (on) {
  this.metaballMode = !!on;
  if (this.metaballMesh) {
    this.metaballMesh.visible = this.metaballMode;
    if (!this.metaballMode && this.metaballGeo) {
      // the mesher scratch buffers are shared with the isosurface path —
      // never let a stale metaball draw range show another pass's vertices
      this.metaballGeo.setDrawRange(0, 0);
    }
  }
  if (this.waterMesh) this.waterMesh.visible = !this.beadsMode && !this.metaballMode;
};

// Water hue from the UI color picker tints the surface and detached spray.
// Metaball editor sync rule: the metaball skin's color FOLLOWS this picker
// until the user picks a color in the Metaball material editor
// (setMetaballMaterial({ color }) sets _mblaFollowWater = false) — after that
// the skin's color stays independent of the water picker for good.
WaterScene.prototype.setWaterColor = function (hex) {
  this.waterColor.set(hex);
  this.waterMat.color.set(hex);
  this.waterMat.emissive.set(hex).multiplyScalar(0.24);
  if (this._mblaFollowWater) {
    if (!this._mblaColor) this._mblaColor = new THREE.Color(hex);
    else this._mblaColor.set(hex);
    if (this.metaballMat) this._applyMetaballMaterialState();
  }
};

// --------------------------------------------------- water velocity vectors
WaterScene.prototype.setVectorsEnabled = function (on) {
  this.vecLines.visible = !!on;
  if (!on) this.vecLines.geometry.setDrawRange(0, 0);
};

// Rebuild vector arrows from live solver state: grid-coupled water particles
// are strided so at most _VEC_MAX arrows are drawn. Each arrow shows the
// MOVING AVERAGE velocity over the last 5 simulation steps (a 5-slot ring of
// per-particle snapshots; one updateVectors call = one sim step), so arrows
// read as steady flow instead of per-frame jitter. Direction = averaged
// velocity direction, length ∝ averaged speed, color ramps calm blue → white.
WaterScene.prototype.updateVectors = function (solver) {
  var geo = this.vecLines.geometry;
  if (!this.vecLines.visible || !solver || !(solver.nP > 0)) { geo.setDrawRange(0, 0); return; }
  var nP = solver.nP;
  var RING_P_MAX = 400000;                       // ~24 MB of history; beyond this, instantaneous
  var ringN = Math.min(nP, RING_P_MAX);
  // ring of the last 5 velocity snapshots, keyed by particle index;
  // reallocated when the solver is rebuilt or grows
  if (this._vRingSolver !== solver || this._vRingCap < ringN) {
    this._vRingSolver = solver;
    this._vRingCap = Math.max(ringN, 4096);
    this._vRing = new Float32Array(this._vRingCap * 3 * 5);
    this._vRingHead = 0;
    this._vRingFill = 0;
  }
  var ring = this._vRing, cap = this._vRingCap;
  var pvx = solver.pvx, pvy = solver.pvy, pvz = solver.pvz;
  var slot = this._vRingHead * cap * 3, q;
  for (q = 0; q < ringN; q++) {
    ring[slot + q * 3] = pvx[q];
    ring[slot + q * 3 + 1] = pvy[q];
    ring[slot + q * 3 + 2] = pvz[q];
  }
  this._vRingHead = (this._vRingHead + 1) % 5;
  if (this._vRingFill < 5) this._vRingFill++;
  var fill = this._vRingFill, inv = 1 / fill, head = this._vRingHead;

  var px = solver.px, py = solver.py, pz = solver.pz;
  var fl = solver.pflag;
  var pos = this.vVecPos, col = this.vVecCol;
  var kLen = 0.4 * (this._wScale || 1);          // arrow length per m/s, world-scaled
  var vRef = solver.maxSpeed || 3.2;
  var nW = 0, p;
  for (p = 0; p < nP; p++) if (fl[p] === 0) nW++;
  if (nW === 0) { geo.setDrawRange(0, 0); return; }
  var stride = Math.max(1, Math.ceil(nW / this._VEC_MAX));
  var m = 0, seen = 0;
  for (p = 0; p < nP && m < this._VEC_MAX; p++) {
    if (fl[p] !== 0) continue;
    if ((seen++ % stride) !== 0) continue;
    var vx, vy, vz;
    if (p < ringN) {
      vx = vy = vz = 0;
      for (var h = 0; h < fill; h++) {
        var s0 = ((head - 1 - h + 5) % 5) * cap * 3 + p * 3;
        vx += ring[s0]; vy += ring[s0 + 1]; vz += ring[s0 + 2];
      }
      vx *= inv; vy *= inv; vz *= inv;
    } else { vx = pvx[p]; vy = pvy[p]; vz = pvz[p]; }
    var sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    var o = m * 6;
    pos[o] = px[p]; pos[o + 1] = py[p]; pos[o + 2] = pz[p];
    pos[o + 3] = px[p] + vx * kLen;
    pos[o + 4] = py[p] + vy * kLen;
    pos[o + 5] = pz[p] + vz * kLen;
    var t = sp / vRef; if (t > 1) t = 1;
    col[o] = 0.12 + 0.85 * t; col[o + 1] = 0.42 + 0.55 * t; col[o + 2] = 1.0;
    col[o + 3] = col[o]; col[o + 4] = col[o + 1]; col[o + 5] = col[o + 2];
    m++;
  }
  geo.setDrawRange(0, m * 2);
  geo.attributes.position.needsUpdate = true;
  geo.attributes.color.needsUpdate = true;
};

// ------------------------------------------------------- lightning flashes
// Spark short lightning strikes above pockets where evaporated (vapor)
// particles crowd well above the atmosphere-wide mean density: bin airborne
// particles on a coarse grid, pick dense cells, run a fast attack / flicker
// decay envelope on the additive sprite pool — and draw a bright blue bolt
// channel from the pocket down to the terrain beneath it, flickering in sync.
// dt = 0 freezes the show (pause).
// intensity: storm-rate multiplier (×0.01…×10 from the UI log slider, default
// ×0.1). Raises the spark chance and lowers the density threshold together,
// so ×10 gives frequent widespread bolts and ×0.01 leaves only the very
// densest pockets sparkling.
WaterScene.prototype.updateLightning = function (solver, dt, enabled, intensity) {
  intensity = (intensity === undefined || !isFinite(intensity)) ? 0.1 : Math.max(0.01, Math.min(10, intensity));
  var pool = this._flashes, i, f;
  if (!enabled) {
    for (i = 0; i < pool.length; i++) {
      pool[i].sprite.visible = false;
      if (pool[i].bolt) pool[i].bolt.visible = false;
      pool[i].life = 0;
    }
    return;
  }
  var active = 0;
  for (i = 0; i < pool.length; i++) {
    f = pool[i];
    if (f.life <= 0) continue;
    active++;
    if (dt <= 0) continue;                     // paused: hold the flash as-is
    f.age += dt;
    var t = f.age / f.life;
    if (t >= 1) {
      f.sprite.visible = false;
      if (f.bolt) f.bolt.visible = false;
      f.life = 0; active--; continue;
    }
    // sharp attack, flickering decay (thunder-like double blink)
    var flick = 0.5 + 0.5 * Math.sin(t * Math.PI * (3 + (f.seed % 3)) + f.seed);
    var env = t < 0.1 ? t / 0.1 : (1 - t) / 0.9;
    var opa = Math.min(1, env * flick * 1.6);
    f.sprite.material.opacity = opa;
    if (f.bolt) f.bolt.material.opacity = opa;   // the bolt flickers with the flash
    var sc = f.scale * (0.75 + 0.5 * t);
    f.sprite.scale.set(sc, sc, 1);
  }
  if (dt <= 0 || !solver || !(solver.oceanR > 0) || active >= 4) return;
  // bin vapor particles on a coarse grid covering the WHOLE atmosphere (the
  // physical ceiling can reach beyond the simulation box on tall settings)
  var atmH = Math.max(solver.atmosphereH || 0.35, 0.05);
  var side = 2 * (solver.oceanR + atmH) + 1;
  var cs = Math.max(0.5, side / 64);
  var gx = Math.ceil(side / cs), gy = gx, gz = gx;
  var bcx = this.W * 0.5, bcy = this.H * 0.5, bcz = this.D * 0.5;
  var nG = gx * gy * gz;
  if (!this._flCnt || this._flCnt.length !== nG) {
    this._flCnt = new Int32Array(nG);
    this._flSx = new Float32Array(nG);
    this._flSy = new Float32Array(nG);
    this._flSz = new Float32Array(nG);
  }
  this._flCnt.fill(0); this._flSx.fill(0); this._flSy.fill(0); this._flSz.fill(0);
  var fl = solver.pflag, px = solver.px, py = solver.py, pz = solver.pz;
  var nV = 0;
  for (var p = 0; p < solver.nP; p++) {
    if (fl[p] !== 2) continue;
    var ix = ((px[p] - bcx) / cs + gx / 2) | 0,
        iy = ((py[p] - bcy) / cs + gy / 2) | 0,
        iz = ((pz[p] - bcz) / cs + gz / 2) | 0;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= gx || iy >= gy || iz >= gz) continue;
    var c = (iz * gy + iy) * gx + ix;
    this._flCnt[c]++; nV++;
    this._flSx[c] += px[p]; this._flSy[c] += py[p]; this._flSz[c] += pz[p];
  }
  if (nV < 24) return;
  // density threshold: comfortably above the atmosphere-wide mean, lowered
  // as storm intensity rises (×10 → ~0.8·mean, ×0.1 → ~8·mean,
  // ×0.01 → ~26·mean)
  var shellV = 4.18879 * (Math.pow(solver.oceanR + atmH, 3) - solver.oceanR * solver.oceanR * solver.oceanR);
  var mean = nV * (cs * cs * cs) / Math.max(shellV, 1e-3);
  var thresh = Math.max(10, mean * 2.6 / Math.sqrt(intensity));
  // spark: walk dense cells with a small per-cell chance → occasional bolts
  for (var cc = 0; cc < nG && active < 4; cc++) {
    if (this._flCnt[cc] < thresh) continue;
    if (Math.random() >= dt * Math.min(30, 3 * intensity)) continue;
    var slot = -1;
    for (i = 0; i < pool.length; i++) if (pool[i].life <= 0) { slot = i; break; }
    if (slot < 0) break;
    f = pool[slot];
    var cntC = this._flCnt[cc];
    var pkx = this._flSx[cc] / cntC, pky = this._flSy[cc] / cntC, pkz = this._flSz[cc] / cntC;
    f.sprite.position.set(pkx, pky, pkz);
    f.age = 0;
    f.life = 0.13 + Math.random() * 0.14;
    f.seed = (Math.random() * 97) | 0;
    f.scale = cs * (1.2 + Math.min(cntC / Math.max(thresh, 1), 2));
    f.sprite.scale.set(f.scale * 0.6, f.scale * 0.6, 1);
    f.sprite.material.opacity = 0;
    f.sprite.visible = true;
    // bright blue bolt channel: from the vapor pocket to the ground under it
    this._strikeBolt(f, pkx, pky, pkz, solver);
    active++;
  }
};

// Fill a flash's bolt channel: a jagged bright-blue line running from the
// vapor pocket straight down the local gravity well to the terrain beneath
// it (sea level over open water, the rock surface over land). Pure display —
// re-picked per strike, never touching the simulation.
WaterScene.prototype._strikeBolt = function (f, sx, sy, sz, solver) {
  var posAttr = f.bolt.geometry.getAttribute('position');
  var pos = posAttr.array, N = this._BOLT_PTS;
  var cx = this.W * 0.5, cy = this.H * 0.5, cz = this.D * 0.5;
  var ex = sx - cx, ey = sy - cy, ez = sz - cz;
  var r = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-6;
  var ux = ex / r, uy = ey / r, uz = ez / r;
  // ground under the pocket: the rock surface, or sea level in open water
  var rEnd = (solver.oceanR || 0) > 0 ? solver.oceanR : r * 0.5;
  if (typeof solver.terrainRadiusAt === 'function') {
    rEnd = Math.max(solver.terrainRadiusAt(sx, sy, sz), solver.oceanR || 0);
  }
  if (!(rEnd > 0) || rEnd >= r * 0.95) rEnd = r * 0.6;    // degenerate fallback
  rEnd += 0.02 * (solver.oceanR || 1);                    // skim just above the mesh
  // jagged offsets in the plane perpendicular to the radial direction
  var ax, ay, az;
  if (Math.abs(uy) < 0.9) { ax = -uz; ay = 0; az = ux; }  // u × (0,1,0)
  else { ax = 0; ay = uz; az = -uy; }                     // u × (1,0,0)
  var al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
  ax /= al; ay /= al; az /= al;
  var bx = uy * az - uz * ay, by = uz * ax - ux * az, bz = ux * ay - uy * ax;  // u × a
  var amp = 0.14 * (r - rEnd);
  for (var i = 0; i < N; i++) {
    var t = i / (N - 1);
    var rr = r + (rEnd - r) * t;
    var off = Math.sin(Math.PI * t) * amp;
    var j1 = (Math.random() - 0.5) * 2, j2 = (Math.random() - 0.5) * 2;
    pos[i * 3] = cx + ux * rr + (ax * j1 + bx * j2) * off;
    pos[i * 3 + 1] = cy + uy * rr + (ay * j1 + by * j2) * off;
    pos[i * 3 + 2] = cz + uz * rr + (az * j1 + bz * j2) * off;
  }
  posAttr.needsUpdate = true;
  f.bolt.geometry.setDrawRange(0, N);
  f.bolt.visible = true;
};

// ---------------------------------------------------------------------- balls
WaterScene.prototype.syncBalls = function (balls) {
  var group = this.ballGroup;
  while (this._ballMeshes.length < balls.length) {
    var mat = new THREE.MeshPhysicalMaterial({ roughness: 0.25, metalness: 0.1, clearcoat: 0.8 });
    var mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), mat);
    mesh.castShadow = true;
    group.add(mesh);
    this._ballMeshes.push(mesh);
  }
  for (var i = 0; i < this._ballMeshes.length; i++) {
    var m = this._ballMeshes[i];
    if (i < balls.length) {
      var b = balls[i];
      mesh = this._ballMeshes[i];
      mesh.visible = true;
      mesh.scale.set(b.r, b.r, b.r);
      mesh.position.set(b.x, b.y, b.z);
      var c = b.rho < 800 ? 0xff8c42 : (b.rho < 1600 ? 0x3ddc97 : 0x5a6570);
      mat = mesh.material;
      mat.color.setHex(c);
    } else {
      this._ballMeshes[i].visible = false;
    }
  }
};

WaterScene.prototype.showHandle = function (show, x, y, z) {
  this.handle.visible = show;
  if (show) this.handle.position.set(x, y, z);
};

// Absolute pixel ratio, clamped to the physical display; omitted quality
// fields keep their current value so runtime scaling never rebuilds terrain.
WaterScene.prototype.setQuality = function (opts) {
  if (opts.pixelRatio !== undefined) {
    var ratio = Math.max(0.5, Math.min(window.devicePixelRatio || 1, opts.pixelRatio));
    if (ratio !== this._pixelRatio) {
      this._pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    }
  }
  if (opts.shadowSize && opts.shadowSize !== this.sun.shadow.mapSize.x) {
    this.sun.shadow.mapSize.set(opts.shadowSize, opts.shadowSize);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    this.renderer.shadowMap.needsUpdate = true;
  }
};
WaterScene.prototype.setAtmosphereHeight = function (height) {
  if (!this._haloMesh) return;
  // the slider sets the REAL ceiling evaporated particles can reach (the
  // solver caps vapor/droplets at oceanR + atmosphereH), so the visible halo
  // follows it honestly — no domain clamping
  var thick = Math.max(height, 0.02);
  var radius = Math.max(this.oceanR + thick * 0.28 + 0.04 * Math.max(1, this._wScale || 1),
    this._terrainRhi + 0.05 * Math.max(1, this._wScale || 1));
  this._haloMesh.scale.setScalar(radius / this._haloRadius);
};

// ------------------------------------------------------------------ rendering
// Motion blur — a frame-blend (afterimage) pass: the scene renders into an
// offscreen buffer that is composited with last frame's composite
// (history = max(current, previous * damp)), then blitted to screen. damp 0
// disables the pass entirely (default — normal MSAA rendering). The trails
// give fast orbit moves, spray and swirl a cinematic smear.
WaterScene.prototype._initBlur = function () {
  var quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  quadGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  quadGeo.setIndex([0, 1, 2, 0, 2, 3]);
  var mat = new THREE.RawShaderMaterial({
    uniforms: { tCur: { value: null }, tPrev: { value: null }, damp: { value: 0 } },
    vertexShader: [
      'precision highp float;',
      'attribute vec3 position; attribute vec2 uv;',
      'varying vec2 vUv;',
      'void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'
    ].join('\n'),
    fragmentShader: [
      'precision highp float;',
      'uniform sampler2D tCur; uniform sampler2D tPrev; uniform float damp;',
      'varying vec2 vUv;',
      'void main(){',
      '  vec3 c = texture2D(tCur, vUv).rgb;',
      '  vec3 p = texture2D(tPrev, vUv).rgb * damp;',
      // max-blend: bright movers leave decaying trails, the current frame is
      // never dimmed by history, and the feedback converges (no blow-up)
      '  gl_FragColor = vec4(max(c, p), 1.0);',
      '}'
    ].join('\n'),
    depthTest: false, depthWrite: false
  });
  var quadScene = new THREE.Scene();
  var quad = new THREE.Mesh(quadGeo, mat);
  quad.frustumCulled = false;
  quadScene.add(quad);
  this._blur = {
    amount: 0, rtScene: null, rtA: null, rtB: null, w: 0, h: 0,
    quadScene: quadScene, quadCam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), mat: mat
  };
};

// (re)allocate the blend buffers at the current drawing-buffer size — called
// from render() when active, so resize and pixel-ratio changes are picked up
WaterScene.prototype._syncBlurRT = function () {
  var b = this._blur;
  var w = this.renderer.domElement.width, h = this.renderer.domElement.height;
  if (b.rtScene && b.w === w && b.h === h) return;
  if (b.rtScene) { b.rtScene.dispose(); b.rtA.dispose(); b.rtB.dispose(); }
  var self = this;
  function mk(depth) {
    var rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, depthBuffer: depth, stencilBuffer: false
    });
    // scene shaders must keep writing sRGB-encoded values into the buffer
    rt.texture.encoding = THREE.sRGBEncoding;
    return rt;
  }
  b.rtScene = mk(true);    // scene pass needs depth
  b.rtA = mk(false);       // history ping
  b.rtB = mk(false);       // history pong
  b.w = w; b.h = h;
};

WaterScene.prototype.setMotionBlur = function (amount) {
  if (!this._blur) this._initBlur();
  var b = this._blur;
  b.amount = Math.max(0, Math.min(0.95, Number(amount) || 0));
  if (b.amount <= 0.001 && b.rtScene) {
    b.rtScene.dispose(); b.rtA.dispose(); b.rtB.dispose();
    b.rtScene = b.rtA = b.rtB = null; b.w = b.h = 0;   // buffers freed while off
  }
};

// starfield visibility + brightness (multiplies the per-star vertex colors)
WaterScene.prototype.setStars = function (on, brightness) {
  this._starsOn = !!on;
  if (brightness !== undefined) this._starBrightness = Math.max(0, Math.min(2, brightness));
  if (this._starGroup) this._starGroup.visible = this._starsOn;
  if (this._starLayers) {
    for (var i = 0; i < this._starLayers.length; i++) {
      this._starLayers[i].mat.color.setScalar(this._starBrightness);
    }
  }
};

WaterScene.prototype._bindResize = function (container) {
  var self = this;
  window.addEventListener('resize', function () {
    var w = container.clientWidth, h = container.clientHeight;
    self.renderer.setSize(w, h);
    self.camera.aspect = w / h;
    self.camera.updateProjectionMatrix();
  });
};

WaterScene.prototype.resize = function () {
  var w = this.container.clientWidth, h = this.container.clientHeight;
  this.renderer.setSize(w, h);
  this.camera.aspect = w / h;
  this.camera.updateProjectionMatrix();
};

WaterScene.prototype.render = function (dt) {
  this.time += dt;
  this._waterTime.value = this.time;
  this.orbit.update();
  // point-sprite attenuation matches the old PointsMaterial convention:
  // gl_PointSize = worldSize · (0.5 · drawingBufferHeight) / viewDepth
  if (this.allMat && this.renderer && this.renderer.domElement) {
    this.allMat.uniforms.uPointScale.value = this.renderer.domElement.height * 0.5;
  }
  // subtle star twinkle (per-layer uniform opacity — one sin() per layer)
  if (this._starLayers && this._starGroup && this._starGroup.visible) {
    for (var si = 0; si < this._starLayers.length; si++) {
      var L = this._starLayers[si];
      L.mat.opacity = Math.min(1, L.base * (1 - L.tw + L.tw * (0.5 + 0.5 * Math.sin(this.time * L.speed + L.phase))));
    }
  }
  var b = this._blur;
  if (b && b.amount > 0.001) {
    this._syncBlurRT();
    var r = this.renderer;
    r.setRenderTarget(b.rtScene);                    // 1. scene → offscreen
    r.render(this.scene, this.camera);
    b.mat.uniforms.tCur.value = b.rtScene.texture;
    b.mat.uniforms.tPrev.value = b.rtA.texture;
    b.mat.uniforms.damp.value = b.amount;
    r.setRenderTarget(b.rtB);                        // 2. blend with history
    r.render(b.quadScene, b.quadCam);
    b.mat.uniforms.tCur.value = b.rtB.texture;
    r.setRenderTarget(null);                         // 3. history → screen
    r.render(b.quadScene, b.quadCam);
    var tswap = b.rtA; b.rtA = b.rtB; b.rtB = tswap; // ping-pong
  } else {
    this.renderer.render(this.scene, this.camera);
  }
};

global.WaterScene = WaterScene;
if (typeof module !== 'undefined' && module.exports) module.exports = WaterScene;
})(typeof window !== 'undefined' ? window : globalThis);
