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

function buildVoxelTerrainMesh(terrain, colorHex) {
  var n = terrain.n, dv = terrain.dv, solid = terrain.solid;
  var Rsl = terrain.Rsl, Rlo = terrain.Rlo, Rhi = terrain.Rhi;
  var baseCol = new THREE.Color(colorHex || '#654321');   // rock hue (picker)
  var nn = n + 1;                          // corners per axis
  var accN = new Float32Array(nn * nn * nn * 3);
  var accI = new Int32Array(nn * nn * nn).fill(-1);
  var positions = [], colors = [], indices = [];
  var nVerts = 0;
  var normals = null;                      // filled after accumulation (below)

  function corner(ci, cj, ck, fnx, fny, fnz) {
    var key = ci + cj * nn + ck * nn * nn;
    var vi = accI[key];
    if (vi < 0) {
      vi = nVerts++;
      accI[key] = vi;
      positions.push(ci * dv, cj * dv, ck * dv);
      // surface palette, measured from the planet centre (lattice middle)
      var ctr = n * dv * 0.5;
      var rx = ci * dv - ctr, ry = cj * dv - ctr, rz = ck * dv - ctr;
      var rr = Math.sqrt(rx * rx + ry * ry + rz * rz);
      var variation = Math.sin(rx * 3.1 + rz * 1.8) * Math.sin(ry * 4.3 - rz * 2.1);
      var sh = terrainShade(rr, Rsl, Rhi - Rsl, baseCol, _TERR_OUT, ry / (rr || 1), variation);
      var spk = 0.94 + 0.06 * variation;
      colors.push(Math.min(sh.r * spk, 1), Math.min(sh.g * spk, 1), Math.min(sh.b * spk, 1));
    }
    accN[key * 3] += fnx; accN[key * 3 + 1] += fny; accN[key * 3 + 2] += fnz;
    return vi;
  }
  function quad(a, b, c, d, fnx, fny, fnz) {   // CCW corners, outward normal
    var va = corner(a[0], a[1], a[2], fnx, fny, fnz);
    var vb = corner(b[0], b[1], b[2], fnx, fny, fnz);
    var vc = corner(c[0], c[1], c[2], fnx, fny, fnz);
    var vd = corner(d[0], d[1], d[2], fnx, fny, fnz);
    indices.push(va, vb, vc, va, vc, vd);
  }

  for (var k = 0; k < n; k++) {
    for (var j = 0; j < n; j++) {
      var rowB = (k * n + j) * n;
      for (var i = 0; i < n; i++) {
        if (!solid[rowB + i]) continue;
        // 6 neighbours; emit a face wherever the rock meets air/space
        if (i === 0 || !solid[rowB + i - 1])
          quad([i, j, k], [i, j, k + 1], [i, j + 1, k + 1], [i, j + 1, k], -1, 0, 0);
        if (i === n - 1 || !solid[rowB + i + 1])
          quad([i + 1, j, k], [i + 1, j + 1, k], [i + 1, j + 1, k + 1], [i + 1, j, k + 1], 1, 0, 0);
        if (j === 0 || !solid[rowB + i - n])
          quad([i, j, k], [i + 1, j, k], [i + 1, j, k + 1], [i, j, k + 1], 0, -1, 0);
        if (j === n - 1 || !solid[rowB + i + n])
          quad([i, j + 1, k], [i, j + 1, k + 1], [i + 1, j + 1, k + 1], [i + 1, j + 1, k], 0, 1, 0);
        if (k === 0 || !solid[rowB + i - n * n])
          quad([i, j, k], [i, j + 1, k], [i + 1, j + 1, k], [i + 1, j, k], 0, 0, -1);
        if (k === n - 1 || !solid[rowB + i + n * n])
          quad([i, j, k + 1], [i + 1, j, k + 1], [i + 1, j + 1, k + 1], [i, j + 1, k + 1], 0, 0, 1);
      }
    }
  }
  // copy accumulated corner normals into vertex order: accN is keyed by
  // corner position, vertices were numbered in creation order — mixing the
  // two left most vertices with zero normals (the planet rendered black)
  normals = new Float32Array(nVerts * 3);
  var nKeys = nn * nn * nn;
  for (var ck2 = 0; ck2 < nKeys; ck2++) {
    var vi2 = accI[ck2];
    if (vi2 < 0) continue;
    var nx0 = accN[ck2 * 3], ny0 = accN[ck2 * 3 + 1], nz0 = accN[ck2 * 3 + 2];
    var nl = Math.sqrt(nx0 * nx0 + ny0 * ny0 + nz0 * nz0);
    if (nl < 0.5) {
      // degenerate corner (opposing faces cancel): fall back to the radial
      // direction so the vertex still catches light instead of rendering black
      var ex2 = positions[vi2 * 3] - nn * dv * 0.5,
          ey2 = positions[vi2 * 3 + 1] - nn * dv * 0.5,
          ez2 = positions[vi2 * 3 + 2] - nn * dv * 0.5;
      nl = Math.sqrt(ex2 * ex2 + ey2 * ey2 + ez2 * ez2) || 1;
      normals[vi2 * 3] = ex2 / nl; normals[vi2 * 3 + 1] = ey2 / nl; normals[vi2 * 3 + 2] = ez2 / nl;
    } else {
      normals[vi2 * 3] = nx0 / nl; normals[vi2 * 3 + 1] = ny0 / nl; normals[vi2 * 3 + 2] = nz0 / nl;
    }
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.setIndex(indices);
  var mat = new THREE.MeshPhongMaterial({
    color: 0xffffff,                    // vertex colors carry the full palette
    vertexColors: true,
    shininess: 8,                       // matte soil and weathered stone
    specular: 0x0b1010
  });
  return new THREE.Mesh(geo, mat);
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

  // starfield (fits both the dusk pool and the ocean planet)
  (function () {
    var n = 1100, pos = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      var rr = 52 + Math.random() * 12;
      pos[i * 3] = rr * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = rr * Math.cos(ph);
      pos[i * 3 + 2] = rr * Math.sin(ph) * Math.sin(th);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var stars = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xdfe9ff, size: 0.16, sizeAttenuation: true,
      transparent: true, opacity: 0.425, depthWrite: false   // 50% darker space
    }));
    scene.add(stars);
    this._stars = stars;   // rescaled with the world so giant planets keep their sky
  }.bind(this))();

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
    // blue at full strength over dark backgrounds.
    shader.fragmentShader = shader.fragmentShader.replace('#include <output_fragment>', [
      '#include <output_fragment>',
      'gl_FragColor.rgb *= min(1.0 / max(gl_FragColor.a, 0.001), 2.1);'
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

  // ---------------- spray particles (soft round sprites)
  this.pGeo = new THREE.BufferGeometry();
  this.pPos = new Float32Array(9);
  this.pCol = new Float32Array(9);
  this.pGeo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
  this.pGeo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
  this.pSprite = makeSpriteTexture();
  this.beadSprite = makeBeadTexture();
  this.beadsMode = false;              // water as droplet particles, no surface mesh
  // Rain / spray droplets (detached airborne water): GLOSSY sprite droplets —
  // the sphere-shaded specular texture — drawn 3× smaller than the liquid
  // droplets. Transparency follows the spray & atmosphere opacity slider.
  this.pMat = new THREE.PointsMaterial({
    size: 0.06, vertexColors: true, map: this.beadSprite, color: 0xffffff,
    transparent: true, opacity: 0.85, depthWrite: false, sizeAttenuation: true
  });

  // ---------------- liquid body (beads mode): flat blue circles
  // The water body as flat, evenly transparent discs — the hard-edged uniform
  // circle sprite, no gradients — tinted per particle with the water color
  // and darkened by the solver's sun exposure, so the night side renders
  // dark while the day side is flat bright blue. Transparency follows the
  // WATER-SURFACE opacity slider (the circles ARE the surface in this mode).
  this.beadsGeo = new THREE.BufferGeometry();
  this.bPos = new Float32Array(9);
  this.bCol = new Float32Array(9);
  this.beadsGeo.setAttribute('position', new THREE.BufferAttribute(this.bPos, 3).setUsage(THREE.DynamicDrawUsage));
  this.beadsGeo.setAttribute('color', new THREE.BufferAttribute(this.bCol, 3).setUsage(THREE.DynamicDrawUsage));
  this.beadMat = new THREE.PointsMaterial({
    size: 0.2, vertexColors: true, map: this.pSprite, color: 0xffffff,
    transparent: true, opacity: 0.25, depthWrite: false, sizeAttenuation: true
  });

  // ---------------- evaporated vapor: broad, soft low-opacity cloudlets
  this.vGeo = new THREE.BufferGeometry();
  this.vPos = new Float32Array(9);
  this.vCol = new Float32Array(9);
  this.vGeo.setAttribute('position', new THREE.BufferAttribute(this.vPos, 3).setUsage(THREE.DynamicDrawUsage));
  this.vGeo.setAttribute('color', new THREE.BufferAttribute(this.vCol, 3).setUsage(THREE.DynamicDrawUsage));
  this.cloudSprite = makeCloudTexture();
  this.vMat = new THREE.PointsMaterial({
    size: 0.26, vertexColors: true, map: this.cloudSprite, color: 0xffffff,
    transparent: true, opacity: 0.23, depthWrite: false, sizeAttenuation: true
  });
  this.vapor = new THREE.Points(this.vGeo, this.vMat);
  this.vapor.frustumCulled = false;
  this.vapor.renderOrder = 5;
  this.planetGroup.add(this.vapor);
  this.pOpa = 1;                       // user transparency multiplier (spray/vapor)
  this.waterOpa = 0.25;                // water-surface opacity (drives liquid beads)
  this.points = new THREE.Points(this.pGeo, this.pMat);
  this.points.frustumCulled = false;
  this.points.renderOrder = 2;
  this.planetGroup.add(this.points);
  this.beadsPoints = new THREE.Points(this.beadsGeo, this.beadMat);
  this.beadsPoints.frustumCulled = false;
  this.beadsPoints.renderOrder = 1;    // the liquid body composites UNDER spray
  this.beadsPoints.visible = false;    // beads mode only
  this.planetGroup.add(this.beadsPoints);

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
  for (var li = 0; li < 10; li++) {
    var lSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.cloudSprite, color: 0xdcecff, transparent: true, opacity: 0,
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
// sun hovers above the orbital-plane centre so its elevation above the
// planet's horizon stays constant (~22°, the old moving-sun tilt), and its
// azimuth now sweeps because the planet travels instead of the sun.

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

  // fixed sun + shadow frustum: the sun hovers above the centre of the
  // orbital circle at the elevation the old moving sun had (0.38 rad) and
  // keeps its old distance (oceanR * 3.4); the planet revolves around it.
  var sunDist = oceanR * 3.4, tilt = 0.38;
  this._sunDist = sunDist;
  this._orbitR = sunDist * Math.cos(tilt);
  this._sunHeight = sunDist * Math.sin(tilt);
  this.setSun(cx, cy + this._sunHeight, cz);
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
  if (this._stars) this._stars.scale.setScalar(Math.max(1, wScale));
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

WaterScene.prototype.setWaterOpacity = function (o) {
  this.waterOpa = o;
  this.waterMat.opacity = o;
  // In beads mode the liquid body IS the water surface — the flat blue
  // circles inherit this slider instead of the spray/atmosphere opacity.
  if (this.beadMat) {
    this.beadMat.opacity = Math.min(1, Math.max(0, o));
  }
};

// ------------------------------------------------------------------ particles
WaterScene.prototype._ensureParticles = function (n) {
  if (this.pPos.length >= n * 3) return;
  this.pPos = new Float32Array(n * 3);
  this.pCol = new Float32Array(n * 3);
  this.pGeo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
  this.pGeo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
  this.bPos = new Float32Array(n * 3);
  this.bCol = new Float32Array(n * 3);
  this.beadsGeo.setAttribute('position', new THREE.BufferAttribute(this.bPos, 3).setUsage(THREE.DynamicDrawUsage));
  this.beadsGeo.setAttribute('color', new THREE.BufferAttribute(this.bCol, 3).setUsage(THREE.DynamicDrawUsage));
  this.vPos = new Float32Array(n * 3);
  this.vCol = new Float32Array(n * 3);
  this.vGeo.setAttribute('position', new THREE.BufferAttribute(this.vPos, 3).setUsage(THREE.DynamicDrawUsage));
  this.vGeo.setAttribute('color', new THREE.BufferAttribute(this.vCol, 3).setUsage(THREE.DynamicDrawUsage));
};

WaterScene.prototype.updateParticles = function (solver, show) {
  // Liquid droplets (beads mode) answer to the WATER-SURFACE opacity — the
  // droplet cloud IS the water surface in that mode. Rain/spray droplets and
  // vapor keep answering to the spray/atmosphere opacity slider.
  var showBeads = !!(show && this.beadsMode && this.waterOpa > 0.01);
  var showSpray = !!(show && this.pOpa > 0.01);
  this.beadsPoints.visible = showBeads;
  this.points.visible = showSpray;
  this.vapor.visible = showSpray;
  if (!showBeads && !showSpray) return;
  var n = solver.nP;
  this._ensureParticles(n);
  var px = solver.px, py = solver.py, pz = solver.pz;
  var fl = solver.pflag;
  var pos = this.pPos, col = this.pCol, vpos = this.vPos, vcol = this.vCol;
  var bpos = this.bPos, bcol = this.bCol;
  var T = solver.pT, hasT = T && T.length >= n;
  // per-particle sun exposure computed by the solver's thermal tick (terrain
  // shade + water-column optical depth + night side). Missing (GPU path or
  // first frame) → hemispheric fallback.
  var pLight = solver.pLight, hasLight = pLight && pLight.length >= n;
  var nW = 0, nV = 0, nB = 0;
  // planet centre (local) + sun direction for the day/night dimming. Particle
  // coordinates live in the solver frame, which spins with the planet, so the
  // sun must be the local-frame direction: the terminator sweeps with the spin.
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
    if (fl[p] === 2) {
      if (!showSpray) continue;
      // Atmospheric parcels overlap into wisps rather than hard motes.
      i3 = nV * 3; nV++;
      vpos[i3] = px[p]; vpos[i3 + 1] = py[p]; vpos[i3 + 2] = pz[p];
      var cloudLight = 0.22 + 0.78 * br;
      vcol[i3] = 0.76 * cloudLight; vcol[i3 + 1] = 0.85 * cloudLight; vcol[i3 + 2] = cloudLight;
      continue;
    }
    if (fl[p] === 0) {
      // The liquid body is the continuous isosurface, not a droplet cloud —
      // EXCEPT in beads mode, where water renders exclusively as flat blue
      // circles whose transparency follows the water-surface opacity slider.
      if (!showBeads) continue;
      i3 = nB * 3; nB++;
      bpos[i3] = px[p]; bpos[i3 + 1] = py[p]; bpos[i3 + 2] = pz[p];
    } else {
      if (!showSpray) continue;
      i3 = nW * 3; nW++;
      pos[i3] = px[p]; pos[i3 + 1] = py[p]; pos[i3 + 2] = pz[p];
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
    if (fl[p] === 1) {   // rain stays bright, but keeps its heat tint
      cr = cr * 0.45 + 0.55; cg = cg * 0.45 + 0.55; cb = cb * 0.45 + 0.55;
    }
    if (fl[p] === 0) {   // flat circles: hue × exposure shading
      bcol[i3] = cr * br; bcol[i3 + 1] = cg * br; bcol[i3 + 2] = cb * br;
    } else {             // rain + vapor sprites: hue × exposure shading
      col[i3] = cr * br; col[i3 + 1] = cg * br; col[i3 + 2] = cb * br;
    }
  }
  var geometries = [this.beadsGeo, this.pGeo, this.vGeo], counts = [nB, nW, nV];
  for (var g = 0; g < 3; g++) {
    var pa = geometries[g].getAttribute('position'), ca = geometries[g].getAttribute('color');
    pa.updateRange.offset = ca.updateRange.offset = 0;
    pa.updateRange.count = ca.updateRange.count = counts[g] * 3;
    if (counts[g]) { pa.needsUpdate = true; ca.needsUpdate = true; }
    geometries[g].setDrawRange(0, counts[g]);
  }
  var spSz = solver.spacing;
  if (isFinite(spSz) && spSz > 0.02) {
    this.beadMat.size = spSz * 3.4;                   // water circle diameter
    this.pMat.size = spSz * 3.4 / 3;                  // glossy rain: 3× smaller
    // vapor cloudlet size scales with the world (the old absolute 0.18–0.4
    // clamp shrank cloudlets to invisibility on giant planets)
    var wS = this._wScale || 1;
    this.vMat.size = Math.max(0.18 * wS, Math.min(0.4 * wS, solver.spacing * 5));
  }
};

WaterScene.prototype.setParticlesOpacity = function (o) {
  // o in [0,1]: 1 = the default soft semi-transparent look, 0 = hidden.
  // Governs spray droplets and vapor only — the liquid beads follow the
  // water-surface opacity slider (see setWaterOpacity).
  this.pOpa = o;
  this.pMat.opacity = Math.min(1, 0.95 * o);
  this.vMat.opacity = 0.23 * Math.sqrt(o);
};

// Beads mode: render the liquid body EXCLUSIVELY as flat blue circles — the
// isosurface mesh is hidden and the marching-tets pass is skipped by the app.
// Purely a display switch; physics is untouched. The circles' transparency
// follows the Water surface opacity slider.
WaterScene.prototype.setBeadsMode = function (on) {
  this.beadsMode = !!on;
  if (this.waterMesh) this.waterMesh.visible = !this.beadsMode;
  if (this.beadsPoints) {
    this.beadsPoints.visible = this.beadsMode;   // draw range set by updateParticles
    var op = Math.min(1, Math.max(0, this.waterOpa === undefined ? 0.25 : this.waterOpa));
    this.beadMat.opacity = op;
  }
};

// Water hue from the UI color picker tints the surface and detached spray.
WaterScene.prototype.setWaterColor = function (hex) {
  this.waterColor.set(hex);
  this.waterMat.color.set(hex);
  this.waterMat.emissive.set(hex).multiplyScalar(0.24);
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
  // drifting caustics
  var t = this.time;
  this.renderer.render(this.scene, this.camera);
};

global.WaterScene = WaterScene;
if (typeof module !== 'undefined' && module.exports) module.exports = WaterScene;
})(typeof window !== 'undefined' ? window : globalThis);
