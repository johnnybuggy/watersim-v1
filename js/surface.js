/*
 * WaterSim — isosurface extraction via Marching Tetrahedra.
 *
 * The particle density field (splatting) is contoured at `iso` to produce the
 * visible water surface. Marching tets (6 tets per cell, consistent
 * decomposition around the 0–6 body diagonal) yields a watertight triangle
 * mesh without large lookup tables. Vertex normals come from the density
 * gradient (central differences), giving smooth shading. Signed tet volumes
 * accumulate to the mesh volume, used to auto-calibrate `iso` so the rendered
 * surface conserves the water volume.
 */
(function (global) {
'use strict';

// cube corners: v0..v7 with bit i -> corner (i&1, (i>>2)&1? no — explicit below)
// 0:(0,0,0) 1:(1,0,0) 2:(1,1,0) 3:(0,1,0) 4:(0,0,1) 5:(1,0,1) 6:(1,1,1) 7:(0,1,1)
var CORNERS = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]
];
// 6-tet decomposition sharing the 0–6 diagonal (watertight across cells)
var TETS = [
  [0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6],
  [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]
];
// tet edge table: e0=(0,1) e1=(1,2) e2=(2,0) e3=(0,3) e4=(1,3) e5=(2,3)
var EDGES = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];
// case table: bit i set = corner i above iso; each row lists triangles as 3 edge ids
var CASES = [
  [],                    // 0
  [[0, 2, 3]],           // 1  {0}
  [[0, 1, 4]],           // 2  {1}
  [[2, 3, 4], [2, 4, 1]],// 3  {0,1}
  [[2, 1, 5]],           // 4  {2}
  [[0, 3, 5], [0, 5, 1]],// 5  {0,2}
  [[0, 4, 5], [0, 5, 2]],// 6  {1,2}
  [[3, 5, 4]],           // 7  {0,1,2}
  [[3, 4, 5]],           // 8  {3}
  [[0, 2, 5], [0, 5, 4]],// 9  {0,3}
  [[0, 1, 5], [0, 5, 3]],// 10 {1,3}
  [[2, 1, 5]],           // 11 {0,1,3}
  [[2, 1, 4], [2, 4, 3]],// 12 {2,3}
  [[0, 1, 4]],           // 13 {0,2,3}
  [[0, 2, 3]],           // 14 {1,2,3}
  []                     // 15
];

var cap = 0, pos = null, nrm = null;
// per-triangle scratch (avoid per-triangle allocation)
var px3 = [0, 0, 0], py3 = [0, 0, 0], pz3 = [0, 0, 0];
var nx3 = [0, 0, 0], ny3 = [0, 0, 0], nz3 = [0, 0, 0];

function ensure(n) {
  if (cap >= n) return;
  var c = cap || 32768;
  while (c < n) c *= 2;
  var p = new Float32Array(c * 3);
  if (pos) p.set(pos.subarray(0, cap * 3));
  pos = p;
  var nn = new Float32Array(c * 3);
  if (nrm) nn.set(nrm.subarray(0, cap * 3));
  nrm = nn;
  cap = c;
}

function build(dens, nx, ny, nz, dx, iso) {
  var sj = nx + 1, sk = (ny + 1) * sj;
  var want = 1500; ensure(want);
  var vcount = 0, volume = 0;
  var cv = [0, 0, 0, 0, 0, 0, 0, 0];        // corner densities
  var gx = [0, 0, 0, 0, 0, 0, 0, 0];        // corner gradient x
  var gy = [0, 0, 0, 0, 0, 0, 0, 0];
  var gz = [0, 0, 0, 0, 0, 0, 0, 0];
  var tv = [0, 0, 0, 0];
  var i, j, k, e, t;

  function cornerVal(ci, i, j, k) {
    return dens[k * sk + j * sj + i];
  }
  function grad(ci, i, j, k) {
    var ip = Math.min(i + 1, nx), im = Math.max(i - 1, 0);
    var jp = Math.min(j + 1, ny), jm = Math.max(j - 1, 0);
    var kp = Math.min(k + 1, nz), km = Math.max(k - 1, 0);
    gx[ci] = (dens[k * sk + j * sj + ip] - dens[k * sk + j * sj + im]) / (2 * dx);
    gy[ci] = (dens[k * sk + jp * sj + i] - dens[k * sk + jm * sj + i]) / (2 * dx);
    gz[ci] = (dens[kp * sk + j * sj + i] - dens[km * sk + j * sj + i]) / (2 * dx);
  }

  for (k = 0; k < nz; k++) {
    for (j = 0; j < ny; j++) {
      for (i = 0; i < nx; i++) {
        var minv = Infinity, maxv = -Infinity;
        for (var c = 0; c < 8; c++) {
          var ci = CORNERS[c];
          var val = cornerVal(c, i + ci[0], j + ci[1], k + ci[2]);
          cv[c] = val;
          if (val < minv) minv = val;
          if (val > maxv) maxv = val;
        }
        if (maxv < iso || minv > iso) continue; // fully inside or outside

        for (c = 0; c < 8; c++) {
          var cc = CORNERS[c];
          grad(c, i + cc[0], j + cc[1], k + cc[2]);
        }

        for (t = 0; t < 6; t++) {
          var tet = TETS[t];
          var code = 0;
          for (c = 0; c < 4; c++) {
            tv[c] = cv[tet[c]];
            if (tv[c] > iso) code |= (1 << c);
          }
          var tris = CASES[code];
          if (tris.length === 0) continue;

          // emit triangles (positions + gradient normals)
          for (e = 0; e < tris.length; e++) {
            var tri = tris[e];
            for (var vi = 0; vi < 3; vi++) {
              var ed = EDGES[tri[vi]];
              var a = tet[ed[0]], b = tet[ed[1]];
              var va = cv[a], vb = cv[b];
              var den = vb - va;
              var tt = den !== 0 ? (iso - va) / den : 0.5;
              if (tt < 0) tt = 0; else if (tt > 1) tt = 1;
              var pa = CORNERS[a], pb = CORNERS[b];
              var wxx = (i + pa[0]) + (pb[0] - pa[0]) * tt;
              var wyy = (j + pa[1]) + (pb[1] - pa[1]) * tt;
              var wzz = (k + pa[2]) + (pb[2] - pa[2]) * tt;
              px3[vi] = wxx * dx; py3[vi] = wyy * dx; pz3[vi] = wzz * dx;
              // normal = -grad (outward = toward lower density), lerped on edge
              var nxx = -(gx[a] + (gx[b] - gx[a]) * tt);
              var nyy = -(gy[a] + (gy[b] - gy[a]) * tt);
              var nzz = -(gz[a] + (gz[b] - gz[a]) * tt);
              var nl = Math.sqrt(nxx * nxx + nyy * nyy + nzz * nzz) || 1;
              nx3[vi] = nxx / nl; ny3[vi] = nyy / nl; nz3[vi] = nzz / nl;
            }

            // orient triangle outward (consistent winding for the volume integral)
            var ux = px3[1] - px3[0], uy = py3[1] - py3[0], uz = pz3[1] - pz3[0];
            var vx2 = px3[2] - px3[0], vy2 = py3[2] - py3[0], vz2 = pz3[2] - pz3[0];
            var fnx = uy * vz2 - uz * vy2, fny = uz * vx2 - ux * vz2, fnz = ux * vy2 - uy * vx2;
            // centroid gradient sign:
            var cgx = 0, cgy = 0, cgz = 0;
            for (vi = 0; vi < 3; vi++) { cgx += nx3[vi]; cgy += ny3[vi]; cgz += nz3[vi]; }
            var dot = fnx * cgx + fny * cgy + fnz * cgz;
            if (dot < 0) {
              var tmpx = px3[2], tmpy = py3[2], tmpz = pz3[2];
              px3[2] = px3[1]; py3[2] = py3[1]; pz3[2] = pz3[1];
              px3[1] = tmpx; py3[1] = tmpy; pz3[1] = tmpz;
              var tn = nx3[2]; nx3[2] = nx3[1]; nx3[1] = tn;
              tn = ny3[2]; ny3[2] = ny3[1]; ny3[1] = tn;
              tn = nz3[2]; nz3[2] = nz3[1]; nz3[1] = tn;
            }
            // signed volume of this triangle fan (divergence theorem)
            volume += (px3[0] * (py3[1] * pz3[2] - py3[2] * pz3[1]) -
                       py3[0] * (px3[1] * pz3[2] - px3[2] * pz3[1]) +
                       pz3[0] * (px3[1] * py3[2] - px3[2] * py3[1])) / 6;

            if (vcount + 3 > cap) { ensure(cap * 2); }
            var o = vcount * 3;
            pos[o] = px3[0]; pos[o + 1] = py3[0]; pos[o + 2] = pz3[0];
            pos[o + 3] = px3[1]; pos[o + 4] = py3[1]; pos[o + 5] = pz3[1];
            pos[o + 6] = px3[2]; pos[o + 7] = py3[2]; pos[o + 8] = pz3[2];
            nrm[o] = nx3[0]; nrm[o + 1] = ny3[0]; nrm[o + 2] = nz3[0];
            nrm[o + 3] = nx3[1]; nrm[o + 4] = ny3[1]; nrm[o + 5] = nz3[1];
            nrm[o + 6] = nx3[2]; nrm[o + 7] = ny3[2]; nrm[o + 8] = nz3[2];
            vcount += 3;
          }
        }
      }
    }
  }

  return { count: vcount, volume: Math.abs(volume), pos: pos, nrm: nrm };
}

global.MarchingTetrahedra = { build: build };
if (typeof module !== 'undefined' && module.exports) module.exports = { build: build };
})(typeof window !== 'undefined' ? window : globalThis);
