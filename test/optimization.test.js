'use strict';
const assert=require('node:assert/strict'), S=require('../js/solver');
function solver(k){const s=new S({nx:8,ny:8,nz:8,dx:.25,targetParticles:100});s.mode='sphere';s.heatK=k;s.gravity=0;s._allocParticles(100);s.nP=100;
for(let p=0;p<100;p++){s.px[p]=.4+(p%5)*.2;s.py[p]=.4+(Math.floor(p/5)%5)*.2;s.pz[p]=.6+Math.floor(p/25)*.2;s.pT[p]=p%2?.2:.8;}return s;}
const a=solver(0),b=solver(1);
a._updateHeat(.04);b._updateHeat(.04);
let sumA=0,sumB=0;for(let p=0;p<100;p++){sumA+=a.pT[p];sumB+=b.pT[p];assert(b.pT[p]>=.19&&b.pT[p]<=.81);}
assert(Math.abs(sumA-sumB)<1e-5,'conduction conserves total heat relative to identical radiation');
const s=solver(0);s.coreR=.4;s.resetWater(.4);assert(s.nP>0,'interpolation invariant has real particles');s._rasterize();s._p2g();s._applyBC();s._g2p(.01);
for(let p=0;p<s.nP;p++)if(s.pflag[p]===0){const v=s.sampleVel(s.px[p],s.py[p],s.pz[p]);assert.equal(v[0],s._advU[p]);assert.equal(v[1],s._advV[p]);assert.equal(v[2],s._advW[p]);}
s.gravity=0;s._buildPlanetGravity();s._gRamp=2;s.u.fill(0);s.v.fill(0);s.w.fill(0);s._applyPlanetGravity(.01);
assert(s.u.every(v=>v===0)&&s.v.every(v=>v===0)&&s.w.every(v=>v===0),'gravity slider zero applies to cached geometry');
s.gravity=9.81;s._applyPlanetGravity(.01);
assert(s.u.some(v=>v!==0)||s.v.some(v=>v!==0)||s.w.some(v=>v!==0),'gravity slider restores cached radial force');
const sampleSolver=new S({nx:9,ny:7,nz:8,dx:.2,targetParticles:20});
[sampleSolver.u,sampleSolver.v,sampleSolver.w].forEach((arr,c)=>{for(let i=0;i<arr.length;i++)arr[i]=Math.sin(i*.37+c);});
for(let p=0;p<100;p++) {
 const x=(p%11)*.19-.1,y=(p%7)*.23-.1,z=(p%9)*.21-.1;
 const v=sampleSolver.sampleVel(x,y,z);
 [sampleSolver.u,sampleSolver.v,sampleSolver.w].forEach((arr,c)=>{
  const pair=sampleSolver._sampleFacePair(arr,arr,c,x,y,z);
  assert.equal(v[c],pair[0],'fused velocity sampler matches independent face-pair reference');
  assert.equal(sampleSolver._sampleFace(arr,c,x,y,z),pair[0]);
 });
}
console.log('ALL OPTIMIZATION INVARIANT TESTS PASSED');
