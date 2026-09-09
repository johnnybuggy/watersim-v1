'use strict';
var assert = require('node:assert/strict');
var MT = require('../js/surface.js');
var n = 18, dx = 1 / n, d = new Float32Array((n + 1) ** 3);
for (var k = 0; k <= n; k++) for (var j = 0; j <= n; j++) for (var i = 0; i <= n; i++) {
  d[(k * (n + 1) + j) * (n + 1) + i] = 0.3 - Math.hypot(i * dx - 0.5, j * dx - 0.5, k * dx - 0.5);
}
var mesh = MT.build(d, n, n, n, dx, 0);
assert(mesh.count > 0 && mesh.count % 3 === 0);
assert(Math.abs(mesh.volume - 4 / 3 * Math.PI * 0.3 ** 3) < 0.006);
for (i = 0; i < mesh.count * 3; i++) assert(Number.isFinite(mesh.pos[i]) && Number.isFinite(mesh.nrm[i]));
for (i = 0; i < mesh.count; i++) {
  var p = i * 3;
  assert(Math.abs(Math.hypot(mesh.nrm[p], mesh.nrm[p + 1], mesh.nrm[p + 2]) - 1) < 1e-5);
  assert((mesh.pos[p] - 0.5) * mesh.nrm[p] + (mesh.pos[p + 1] - 0.5) * mesh.nrm[p + 1] + (mesh.pos[p + 2] - 0.5) * mesh.nrm[p + 2] > 0);
}
var buffer = mesh.pos;
mesh = MT.build(d, n, n, n, dx, 0);
assert.equal(mesh.pos, buffer, 'mesher reuses capacity');
d.fill(-1);
assert.equal(MT.build(d, n, n, n, dx, 0).count, 0);
console.log('ALL SURFACE TESTS PASSED');
