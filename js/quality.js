/* Frame-budget policy, shared by the browser and deterministic Node tests. */
(function (global) {
'use strict';
var levels = [
  { key: 'eco', label: 'Eco', nx: 18, target: 10000, pixelRatio: 0.8, shadowSize: 512 },
  { key: 'tiny', label: 'Tiny', nx: 22, target: 18000, pixelRatio: 1, shadowSize: 512 },
  { key: 'balanced', label: 'Balanced', nx: 26, target: 25000, pixelRatio: 1.1, shadowSize: 1024 },
  { key: 'low', label: 'Low', nx: 30, target: 36000, pixelRatio: 1.15, shadowSize: 1024 },
  { key: 'medium', label: 'Medium', nx: 40, target: 65000, pixelRatio: 1.35, shadowSize: 1024 },
  { key: 'high', label: 'High', nx: 50, target: 100000, pixelRatio: 1.5, shadowSize: 2048 },
  { key: 'ultra', label: 'Ultra', nx: 62, target: 160000, pixelRatio: 1.75, shadowSize: 2048 },
  { key: 'extreme', label: 'Extreme', nx: 72, target: 220000, pixelRatio: 2, shadowSize: 2048 }
];
function percentile(samples, fraction) {
  if (!samples.length) return Infinity;
  var sorted = samples.slice().sort(function (a, b) { return a - b; });
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}
function fits(samples, fps) {
  // Leave 20% for compositing, UI, vapor growth and timing variability.
  return percentile(samples, 0.9) <= 1000 / fps * 0.8;
}
function Controller(fps, maxRatio) {
  this.fps = fps;
  this.maxRatio = maxRatio;
  this.ratio = maxRatio;
  this.elapsed = 0;
  this.samples = [];
  this.goodWindows = 0;
}
Controller.prototype.observe = function (frameMs, workMs, active) {
  if (!active || !isFinite(frameMs) || frameMs <= 0 || frameMs > 1000) {
    this.elapsed = 0; this.samples.length = 0; this.goodWindows = 0;
    return null;
  }
  this.elapsed += frameMs;
  this.samples.push(Math.max(frameMs, workMs));
  if (this.elapsed < 2000) return null;
  var cost = percentile(this.samples, 0.8), budget = 1000 / this.fps;
  this.elapsed = 0; this.samples.length = 0;
  var prev = this.ratio;
  if (cost > budget * 1.12) {
    this.ratio = Math.max(0.65, this.ratio - 0.1);
    this.goodWindows = 0;
  } else if (cost < budget * 0.9) {
    if (++this.goodWindows >= 3) {
      this.ratio = Math.min(this.maxRatio, this.ratio + 0.05);
      this.goodWindows = 0;
    }
  } else this.goodWindows = 0;
  return Math.abs(prev - this.ratio) > 0.001 ? this.ratio : null;
};
var api = { levels: levels, percentile: percentile, fits: fits, Controller: Controller };
global.AdaptiveQuality = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
