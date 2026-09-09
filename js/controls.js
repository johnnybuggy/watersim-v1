/*
 * WaterSim — minimal orbit camera (drag = rotate, wheel = zoom, damping).
 * Self-contained so the app runs from file:// with no extra dependencies.
 */
(function (global) {
'use strict';

function OrbitMini(camera, dom, target) {
  this.camera = camera;
  this.dom = dom;
  this.target = target || new THREE.Vector3(2, 1, 2);
  this.theta = 0.75;      // azimuth
  this.phi = 1.12;        // polar from +Y
  this.radius = 7.5;
  this.minRadius = 2.2;
  this.maxRadius = 16;
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
    self.tPhi = Math.max(0.18, Math.min(1.52, self.tPhi - dy * 0.005));
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
    var f = Math.exp(e.deltaY * 0.0012);
    self.tRadius = Math.max(self.minRadius, Math.min(self.maxRadius, self.tRadius * f));
  }, { passive: false });
};

OrbitMini.prototype.update = function () {
  var d = this.damping;
  this.theta += (this.tTheta - this.theta) * d;
  this.phi += (this.tPhi - this.phi) * d;
  this.radius += (this.tRadius - this.radius) * d;
  var sp = Math.sin(this.phi), cp = Math.cos(this.phi);
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
