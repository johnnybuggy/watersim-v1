'use strict';
const assert = require('node:assert/strict');
const S = require('../js/solver');
const M = require('../js/surface');
global.MarchingTetrahedra = M;
const s = new S({nx:22,ny:22,nz:22,dx:5.1/22,targetParticles:10000,mode:'sphere',coreR:1.5,bumpiness:.65,evaporation:.6,atmosphereH:1});
s.resetWater(.45);
const terrain = s.terrain; s.resetWater(.45);
assert.equal(s.terrain, terrain, 'reset reuses terrain');
s._rasterize(); const types = new Uint8Array(s.cellType); s._rasterize();
assert.deepEqual(s.cellType, types, 'cached raster matches first raster');
// A cohort born on the day side: no teleports, no new vapor sources. Measure
// actual transport before condensation with the same heat/advection functions.
s.sunPos = [s.cx + 9, s.cy, s.cz]; s.sunActivity = 0;
s.nP = 160;
for (let p=0;p<s.nP;p++) {
  const latitude = (p % 16 - 7.5) * .07, longitude = (Math.floor(p/16)-4.5)*.12;
  const r=s.oceanR+.18, cy=Math.sin(latitude), h=Math.cos(latitude);
  s.px[p]=s.cx+r*h*Math.cos(longitude);s.py[p]=s.cy+r*cy;s.pz[p]=s.cz+r*h*Math.sin(longitude);
  s.pflag[p]=2;s.pT[p]=.7;s.pAir[p]=0;s.pvx[p]=s.pvy[p]=s.pvz[p]=0;
}
s.cellType.fill(0);s.dens.fill(0);
const reached = new Set(); let maxNight=0;
for(let frame=0;frame<720;frame++) {
  if(frame%3===0)s._updateHeat(.05);
  s._advect(1/60); s._vaporCollisions();
  let night=0;
  for(let p=0;p<s.nP;p++) {
    assert(Number.isFinite(s.px[p]) && Number.isFinite(s.pT[p]));
    if(s.pflag[p]===2 && s.px[p]<s.cx) {reached.add(p);night++;}
  }
  maxNight=Math.max(maxNight,night);
}
console.log('Day-origin cohort reached shade:', reached.size+'/'+s.nP, 'peak night vapor:',maxNight);
assert(reached.size>=s.nP*.4,'at least 40% of day-origin parcels reach night side as vapor');
assert(maxNight>=s.nP*.2,'a substantial simultaneous night-side atmosphere persists');
s.sunPos=null; s.sunActivity=0;
for(let frame=0;frame<900;frame++) { if(frame%3===0)s._updateHeat(.05);s._advect(1/60); }
let remaining=0;for(let p=0;p<s.nP;p++)if(s.pflag[p]===2)remaining++;
assert(remaining<s.nP*.1,'vapor still condenses after global nightfall');
assert.equal(s.nP,160,'phase changes conserve particle mass');
// Every phase is rescued after collision separation, not just fluid.
for(let p=0;p<3;p++){s.pflag[p]=p;s.px[p]=s.cx+.3;s.py[p]=s.cy;s.pz[p]=s.cz;}
s._pushSurfaceParticles();
for(let p=0;p<3;p++)assert(!s._rockCellAt(s.px[p],s.py[p],s.pz[p]),'terrain rescue applies to phase '+p);
// airborne water is contained by the ATMOSPHERE ceiling, not the domain shell
s.pflag[3]=2;s.px[3]=s.cx+s.oceanR+s.atmosphereH+.05;s.py[3]=s.cy;s.pz[3]=s.cz;
s._pushSurfaceParticles();
assert(Math.hypot(s.px[3]-s.cx,s.py[3]-s.cy,s.pz[3]-s.cz)<=s.oceanR+s.atmosphereH+1e-6,'post-collision rescue contains vapor at the atmosphere ceiling');
// grid-coupled fluid is still clamped to the domain shell
s.pflag[4]=0;s.px[4]=s.cx+s.domainR+.02;s.py[4]=s.cy;s.pz[4]=s.cz;
s._pushSurfaceParticles();
assert(Math.hypot(s.px[4]-s.cx,s.py[4]-s.cy,s.pz[4]-s.cz)<=s.domainR,'post-collision rescue still enforces the domain on fluid');
console.log('ALL ATMOSPHERE TRANSPORT TESTS PASSED');
