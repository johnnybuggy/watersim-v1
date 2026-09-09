'use strict';
var assert = require('node:assert/strict');
var Q = require('../js/quality.js');
assert(Q.fits([10, 11, 12, 14, 15], 50));
assert(!Q.fits([15, 16, 17, 19, 23], 50));
assert(Q.fits([15, 16, 17, 19, 23], 25));
assert(!Q.fits([], 50));
for (var i = 1; i < Q.levels.length; i++) {
  assert(Q.levels[i].nx > Q.levels[i - 1].nx);
  assert(Q.levels[i].target > Q.levels[i - 1].target);
}
var c = new Q.Controller(50, 1.5);
for (i = 0; i < 100; i++) c.observe(30, 26, true);
assert(c.ratio < 1.5, 'sustained overload reduces render scale');
var ratio = c.ratio;
for (i = 0; i < 100; i++) c.observe(60, 50, false);
assert.equal(c.ratio, ratio, 'paused frames never alter detail');
for (i = 0; i < 600; i++) c.observe(16, 12, true);
assert(c.ratio > ratio, 'sustained headroom cautiously restores detail');
for (i = 0; i < 1000; i++) c.observe(50, 40, true);
assert(c.ratio >= 0.65 && c.ratio <= 1.5);
var slow = new Q.Controller(25, 1.5);
for (i = 0; i < 20; i++) slow.observe(300, 280, true);
assert(slow.ratio < 1.5, 'sustained very slow frames still trigger adaptation');
console.log('ALL QUALITY POLICY TESTS PASSED');
