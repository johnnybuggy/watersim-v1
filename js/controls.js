/*
 * WaterSim — minimal orbit camera (drag = rotate, wheel = zoom, damping).
 * Self-contained so the app runs from file:// with no extra dependencies.
 * Full polar freedom: phi runs from a hair above the north pole (0) to a
 * hair under the south pole (π), so the planet can be viewed from directly
 * underneath — the tiny POLAR_EPS margin keeps the spherical basis away from
 * the degenerate axis (no flip, no NaN at either pole).
 */
(function (global) {
'use strict';

// Polar epsilon: the camera stops 0.01 rad (≈0.57°) short of the exact axis
// so sin(phi) never degenerates the position basis and lookAt never has to
// resolve an up-vector parallel to the view direction.
var POLAR_EPS = 0.01;

function OrbitMini(camera, dom, target) {
  this.camera = camera;
  this.dom = dom;
  this.target = target || new THREE.Vector3(2, 1, 2);
  this.theta = 0.75;      // azimuth (unrestricted)
  this.phi = 1.12;        // polar from +Y (0 = north pole, π = south pole)
  this.radius = 7.5;
  this.minRadius = 2.2;   // zoom limits (scene.js rescales both per world so
  this.maxRadius = 16;    // they track the 0.5–25 m planet-radius range)
  this.minPhi = POLAR_EPS;            // just under the north pole
  this.maxPhi = Math.PI - POLAR_EPS;  // just under the south pole — look up from below
  this.damping = 0.14;
  this.tTheta = this.theta;
  this.tPhi = this.phi;
  this.tRadius = this.radius;
  this.dragging = false;
  this.lastX = 0;
  this.lastY = 0;
  this.enabled = true;
  this._bind();
}

OrbitMini.prototype._bind = function () {
  var self = this;
  var dom = this.dom;

  dom.addEventListener('pointerdown', function (e) {
    if (!self.enabled) return;
    if (e.button !== 0) return;
    self.dragging = true;
    self.lastX = e.clientX;
    self.lastY = e.clientY;
    dom.setPointerCapture && dom.setPointerCapture(e.pointerId);
  });

  dom.addEventListener('pointermove', function (e) {
    if (!self.dragging || !self.enabled) return;
    var dx = e.clientX - self.lastX;
    var dy = e.clientY - self.lastY;
    self.lastX = e.clientX;
    self.lastY = e.clientY;
    self.tTheta -= dx * 0.0055;
    // Full polar range: a hair above the north pole (0) down to a hair under
    // the south pole (π) — the epsilon keeps sin(phi) non-degenerate, so the
    // camera may pass the equator and look at the planet from underneath.
    self.tPhi = Math.max(self.minPhi, Math.min(self.maxPhi, self.tPhi - dy * 0.005));
  });

  function endDrag(e) {
    self.dragging = false;
  }
  dom.addEventListener('pointerup', function () { self.dragging = false; });
  dom.addEventListener('pointercancel', function () { self.dragging = false; });
  dom.addEventListener('pointerleave', function () { self.dragging = false; });

  dom.addEventListener('wheel', function (e) {
    if (!self.enabled) return;
    e.preventDefault();
    var dy = isFinite(e.deltaY) ? e.deltaY : 0;   // a NaN wheel delta must not poison the state
    var f = Math.exp(dy * 0.0012);
    var lo = Math.min(self.minRadius, self.maxRadius);
    var hi = Math.max(self.minRadius, self.maxRadius);
    self.tRadius = Math.max(lo, Math.min(hi, self.tRadius * f));
  }, { passive: false });
};

OrbitMini.prototype.update = function () {
  var d = this.damping;
  this.theta += (this.tTheta - this.theta) * d;
  this.phi += (this.tPhi - this.phi) * d;
  this.radius += (this.tRadius - this.radius) * d;
  // Keep the damped state inside the legal band (targets are already clamped,
  // but external code — world rebuilds, the console — may poke tPhi/tRadius
  // or set degenerate limits): damping still converges, never locks up.
  this.phi = Math.max(Math.min(this.minPhi, this.maxPhi),
                      Math.min(Math.max(this.minPhi, this.maxPhi), this.phi));
  var lo = Math.min(this.minRadius, this.maxRadius);
  var hi = Math.max(this.minRadius, this.maxRadius);
  this.radius = Math.max(lo, Math.min(hi, this.radius));
  // Effective polar angle stays POLAR_EPS off the exact axis (even if the
  // limits were widened to 0/π externally) so sin(phi) ≥ ~eps: the position
  // math never degenerates and lookAt never flips or NaNs at the poles.
  var phi = Math.max(POLAR_EPS, Math.min(Math.PI - POLAR_EPS, this.phi));
  var sp = Math.sin(phi), cp = Math.cos(phi);
  this.camera.position.set(
    this.target.x + this.radius * sp * Math.sin(this.theta),
    this.target.y + this.radius * cp,
    this.target.z + this.radius * sp * Math.cos(this.theta)
  );
  this.camera.lookAt(this.target);
};

global.OrbitMini = OrbitMini;
if (typeof module !== 'undefined' && module.exports) module.exports = OrbitMini;
})(typeof window !== 'undefined' ? window : globalThis);
