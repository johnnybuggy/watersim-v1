/*
 * Phase-change substates of the evaporated particle:
 *   steam (2) → cloud (3)   needs cold AND dense surrounding steam, above cloud base
 *   steam (2) → rain (4)    colder than the rain point AND airborne ≥ rainLiftAge
 *                           (fresh parcels get a lift-off window before they
 *                           may re-condense; the drop sheds its wind speed)
 *   water (0)/rain (4) → snow (5)  below the snow point; melts back when warmed
 *   cloud (3) → steam (2)   warmed past the burn-off point
 * Threshold ordering is clamped (snow ≤ rain − 0.02 ≤ cloud − 0.04).
 * Evaporation: any liquid above the freezing point may leave, with a
 * per-second probability  p(T) = intensity · sun · exp(3.5·(T − T_freeze))
 * (capped at certainty) — the intensity is the coefficient of that formula.
 * Airborne rain (4) trades heat with the AIR (night floor 0.06), not with
 * deep space — it lands as rain unless it genuinely chills below the snow
 * point while falling.
 * Runs the real solver headlessly (box mode — no terrain needed).
 */
'use strict';
const assert = require('node:assert/strict');
const S = require('../js/solver.js');

function mk(overrides) {
  const o = Object.assign({
    nx: 16, ny: 16, nz: 16, dx: 0.25, targetParticles: 8000
  }, overrides || {});
  return new S(o);
}

// ---- 1. steam colder than the rain point rains out ---------------------------
{
  const s = mk();
  s.resetWater(0.5);
  // one particle high above the sea, cold steam, airborne long enough to pass
  // the lift gate (a fresh parcel below rainLiftAge keeps its lift-off window)
  const p = 0;
  s.pflag[p] = 2; s.pT[p] = 0.1;   // ≤ rainT (0.22)
  s.px[p] = s.cx; s.py[p] = s.cy + s.oceanR + 0.8 * s.atmosphereH; s.pz[p] = s.cz;
  s.pvx[p] = 0.1; s.pvy[p] = 0; s.pvz[p] = 0;
  s.pAir[p] = s.rainLiftAge + 0.1;
  s._updatePhaseChanges();
  assert.equal(s.pflag[p], 4, 'cold airborne steam → rain');
  assert.equal(s.pvx[p], 0, 'rain-out sheds the wind speed (free-fall)');
  s.disableMultithreading && s.disableMultithreading();
}

// ---- 1b. freshly lifted steam does NOT rain out before the lift window -------
{
  const s = mk();
  s.resetWater(0.5);
  const p = 0;
  s.pflag[p] = 2; s.pT[p] = 0.1;   // ≤ rainT (0.22) — born cold (cold night sea)
  s.px[p] = s.cx; s.py[p] = s.cy + s.oceanR + 0.8 * s.atmosphereH; s.pz[p] = s.cz;
  s.pAir[p] = 0;                   // just evaporated: inside the lift window
  s._updatePhaseChanges();
  assert.equal(s.pflag[p], 2, 'fresh cold steam keeps its lift-off window');
  s.disableMultithreading && s.disableMultithreading();
}

// ---- 2. cloud formation needs cold AND dense steam AND altitude --------------
{
  const s = mk();
  s.resetWater(0.5);
  const target = 3;   // the candidate particle
  s.px[target] = s.cx; s.pz[target] = s.cz;
  // altitude: cloud base = oceanR + 0.3·atmosphereH → put it above
  s.py[target] = s.cy + s.oceanR + 0.5 * s.atmosphereH;
  s.pT[target] = s.cloudT - 0.05;   // cold enough, not rain-cold
  s.pflag[target] = 2;

  // (a) sparse steam: stays steam
  s._steamCnt.fill(0);
  s._updatePhaseChanges();
  assert.equal(s.pflag[target], 2, 'cold but sparse steam stays steam');

  // (b) dense steam around it: condenses to cloud
  // place 40 steam particles in the same cell (count/27 ≥ cloudP 0.35 → 10)
  const cellX = Math.floor(s.cx / s.dx), cellY = Math.floor(s.py[target] / s.dx), cellZ = Math.floor(s.cz / s.dx);
  for (let q = 1; q <= 40 && q < s.nP; q++) {
    if (q === target) continue;
    s.pflag[q] = 2;
    s.px[q] = (cellX + 0.5) * s.dx; s.py[q] = (cellY + 0.5) * s.dx; s.pz[q] = (cellZ + 0.5) * s.dx;
    s.pT[q] = s.cloudT - 0.05;
  }
  s._updatePhaseChanges();
  assert.equal(s.pflag[target], 3, 'cold + dense steam condenses to cloud');

  // (c) warmed cloud burns off back to steam
  s.pT[target] = s.cloudT + 0.05 + 0.01;
  s._updatePhaseChanges();
  assert.equal(s.pflag[target], 2, 'warmed cloud burns off to steam');
}

// ---- 3. below the cloud base no cloud forms (fog guard) ----------------------
{
  const s = mk();
  s.resetWater(0.5);
  const p = 1;
  s.pflag[p] = 2; s.pT[p] = s.cloudT - 0.05;
  s.px[p] = s.cx; s.pz[p] = s.cz;
  s.py[p] = s.waterTopY + 0.05;   // above the sea, below the cloud base
  // dense surroundings anyway
  const cellX = Math.floor(s.cx / s.dx), cellY = Math.floor(s.py[p] / s.dx), cellZ = Math.floor(s.cz / s.dx);
  for (let q = 2; q < 42 && q < s.nP; q++) {
    s.pflag[q] = 2;
    s.px[q] = (cellX + 0.5) * s.dx; s.py[q] = (cellY + 0.5) * s.dx; s.pz[q] = (cellZ + 0.5) * s.dx;
    s.pT[q] = s.cloudT - 0.05;
  }
  s._updatePhaseChanges();
  assert.notEqual(s.pflag[p], 3, 'steam below the cloud base never condenses to cloud');
  s.disableMultithreading && s.disableMultithreading();
}

// ---- 4. water → snow below the snow point; melt-back -------------------------
{
  const s = mk();
  s.resetWater(0.5);
  const p = 0;
  s.pflag[p] = 0; s.pT[p] = s.snowT - 0.02;   // below snow point
  s._updatePhaseChanges();
  assert.equal(s.pflag[p], 5, 'cold water freezes to snow');
  assert.equal(s.pvx[p], 0, 'frozen snow does not move');

  // melt-back: in a FLUID cell → water; in air → rain droplet
  s.pT[p] = s.snowT + 0.07;
  s.px[p] = s.cx; s.py[p] = s.waterTopY - 0.1; s.pz[p] = s.cz;   // under the surface
  const i = Math.floor(s.px[p] / s.dx), j = Math.floor(s.py[p] / s.dx), k = Math.floor(s.pz[p] / s.dx);
  s.cellType[(k * s.ny + j) * s.nx + i] = 1;   // FLUID (resetWater leaves cells unmarked)
  s._updatePhaseChanges();
  assert.equal(s.pflag[p], 0, 'melted snow inside the sea returns to water');

  s.pflag[p] = 5; s.pT[p] = s.snowT + 0.07;
  s.py[p] = s.waterTopY + 1.0;   // clearly in the air
  const i2 = Math.floor(s.px[p] / s.dx), j2 = Math.floor(s.py[p] / s.dx), k2 = Math.floor(s.pz[p] / s.dx);
  s.cellType[(k2 * s.ny + j2) * s.nx + i2] = 0;   // AIR
  s._updatePhaseChanges();
  assert.equal(s.pflag[p], 4, 'melted snow in the air falls as rain droplet');
  s.disableMultithreading && s.disableMultithreading();
}

// ---- 5. rain → snow -----------------------------------------------------------
{
  const s = mk();
  s.resetWater(0.5);
  const p = 0;
  s.pflag[p] = 4; s.pT[p] = s.snowT - 0.01;
  s._updatePhaseChanges();
  assert.equal(s.pflag[p], 5, 'freezing rain becomes snow');
  s.disableMultithreading && s.disableMultithreading();
}

// ---- 6. threshold ordering is clamped ----------------------------------------
{
  const s = mk({ cloudT: 0.2, rainT: 0.5, snowT: 0.5 });   // inverted on purpose
  // effective rainT ≤ cloudT − 0.02, snowT ≤ rainT − 0.02 — steam at a
  // temperature between the raw rainT and cloudT must NOT rain out
  s.resetWater(0.5);
  const p = 0;
  s.pflag[p] = 2; s.pT[p] = Math.min(s.rainT, s.cloudT - 0.03);   // below effective rainT → rain
  s.pAir[p] = 1;                                   // airborne past the lift window
  s._updatePhaseChanges();
  assert.equal(s.pflag[p], 4, 'ordering clamp still routes cold steam to rain');
  // a particle between effective thresholds stays steam
  const q = 1;
  s.pflag[q] = 2; s.pAir[q] = 1;
  s.pT[q] = (Math.min(s.rainT, s.cloudT - 0.02) + s.cloudT) / 2;   // between rain and cloud
  s.px[q] = s.cx; s.py[q] = s.cy + s.oceanR + 0.5 * s.atmosphereH; s.pz[q] = s.cz;
  s._updatePhaseChanges();
  assert.notEqual(s.pflag[q], 4, 'steam between rain and cloud points never rains out');
  s.disableMultithreading && s.disableMultithreading();
}

// ---- 6b. particle rotation: seeding, friction coupling, momentum conservation
{
  const s = mk();
  s.resetWater(0.5);
  s.spinOn = true;
  // (a) fresh steam gets a deterministic thermal spin seed
  const p = 0;
  s.pflag[p] = 2; s.pT[p] = 0.5; s.pAir[p] = 0;
  s.px[p] = s.cx; s.py[p] = s.cy + s.oceanR + 0.5 * s.atmosphereH; s.pz[p] = s.cz;
  const t0 = s._simTime;
  s._updatePhaseChanges(1 / 60);
  const w0 = Math.sqrt(s.pWx[p] ** 2 + s.pWy[p] ** 2 + s.pWz[p] ** 2);
  assert.ok(w0 > 0.1, 'fresh steam seeds a thermal spin (|w|=' + w0.toFixed(2) + ')');
  // determinism: identical state → identical spin
  const s2 = mk(); s2.resetWater(0.5); s2.spinOn = true;
  s2.pflag[p] = 2; s2.pT[p] = 0.5; s2.pAir[p] = 0;
  s2.px[p] = s.px[p]; s2.py[p] = s.py[p]; s2.pz[p] = s.pz[p];
  s2._simTime = t0;
  s2._updatePhaseChanges(1 / 60);
  assert.equal(s2.pWx[p], s.pWx[p], 'spin seed is deterministic');
  // (b) friction: spinning pair couples — linear KE drains, momentum conserved
  s.pflag[0] = 0;   // isolate the pair from the seeded probe particle
  const i = 1, j = 2;
  s.pflag[i] = 2; s.pflag[j] = 2;
  s.px[i] = s.cx - 0.02; s.py[i] = s.py[p]; s.pz[i] = s.cz;
  s.px[j] = s.cx + 0.02; s.py[j] = s.py[p]; s.pz[j] = s.cz;
  s.pvx[i] = 0.6; s.pvy[i] = 0; s.pvz[i] = 0;
  s.pvx[j] = -0.6; s.pvy[j] = 0; s.pvz[j] = 0;
  s.pWx[i] = 0; s.pWy[i] = 8; s.pWz[i] = 0;      // fast spin on i
  s.pWx[j] = 0; s.pWy[j] = 0; s.pWz[j] = 0;
  s.pAir[i] = 1; s.pAir[j] = 1;                   // not fresh → no reseed
  const mBefore = s.pvx[i] + s.pvx[j];
  const I = 0.4 * (s.spacing * 0.3) ** 2;
  const keRot = () => 0.5 * I * (s.pWx[i] ** 2 + s.pWy[i] ** 2 + s.pWz[i] ** 2 + s.pWx[j] ** 2 + s.pWy[j] ** 2 + s.pWz[j] ** 2);
  const keLin = () => 0.5 * (s.pvx[i] ** 2 + s.pvx[j] ** 2 + s.pvy[i] ** 2 + s.pvy[j] ** 2 + s.pvz[i] ** 2 + s.pvz[j] ** 2);
  s._vaporCollisions();
  assert.equal(s.pvx[i] + s.pvx[j], mBefore, 'friction impulse conserves momentum');
  assert.ok(keRot() < 0.5 * I * 64, 'fast spin drains at contact');
  // (b2) friction never adds mechanical energy: same contact with rotation
  // disabled (pure elastic + separation) vs enabled — the spin-on run must
  // end at ≤ the spin-off mechanical energy
  s.pvx[i] = 0.6; s.pvx[j] = -0.6; s.pvy[i] = s.pvy[j] = 0; s.pvz[i] = s.pvz[j] = 0;
  s.px[i] = s.cx - 0.02; s.py[i] = s.py[p]; s.pz[i] = s.cz;
  s.px[j] = s.cx + 0.02; s.py[j] = s.py[p]; s.pz[j] = s.cz;
  s.pWx[i] = 0; s.pWy[i] = 8; s.pWz[i] = 0;
  s.pWx[j] = 0; s.pWy[j] = 0; s.pWz[j] = 0;
  s.spinOn = false;
  s._vaporCollisions();
  const keOff = keLin() + keRot();
  s.pvx[i] = 0.6; s.pvx[j] = -0.6; s.pvy[i] = s.pvy[j] = 0; s.pvz[i] = s.pvz[j] = 0;
  s.px[i] = s.cx - 0.02; s.py[i] = s.py[p]; s.pz[i] = s.cz;
  s.px[j] = s.cx + 0.02; s.py[j] = s.py[p]; s.pz[j] = s.cz;
  s.pWx[i] = 0; s.pWy[i] = 8; s.pWz[i] = 0;
  s.pWx[j] = 0; s.pWy[j] = 0; s.pWz[j] = 0;
  s.spinOn = true;
  s._vaporCollisions();
  assert.ok(keLin() + keRot() <= keOff + 1e-9, 'friction never adds mechanical energy (' +
    (keLin() + keRot()).toFixed(5) + ' <= ' + keOff.toFixed(5) + ')');
  // (b2) linear-dominant contact: tangential slip spins the pair up
  s.px[i] = s.cx - 0.02; s.py[i] = s.py[p] - 0.01; s.pz[i] = s.cz;
  s.px[j] = s.cx + 0.02; s.py[j] = s.py[p] + 0.01; s.pz[j] = s.cz;
  s.pvx[i] = 0.6; s.pvx[j] = -0.6;
  s.pWx[i] = 0; s.pWy[i] = 0; s.pWz[i] = 0;
  s.pWx[j] = 0; s.pWy[j] = 0; s.pWz[j] = 0;
  s._vaporCollisions();
  const wAfter = Math.sqrt(s.pWx[i] ** 2 + s.pWy[i] ** 2 + s.pWz[i] ** 2);
  assert.ok(wAfter > 0.5, 'tangential slip spins the pair up (|w|=' + wAfter.toFixed(2) + ')');
  // (c) spin off → no friction, pure elastic exchange
  s.spinOn = false;
  s.pvx[i] = 0.6; s.pvx[j] = -0.6;
  s.pWx[i] = 0; s.pWy[i] = 8; s.pWz[i] = 0;
  s._vaporCollisions();
  assert.equal(s.pWy[i], 8, 'spin untouched with rotation disabled');
  s.disableMultithreading && s.disableMultithreading();
}

// ---- 6c. ice adhesion: free grains stick to the pack and to each other -------
{
  const s = mk();
  s.resetWater(0.5);
  const i = 0, j = 1, k = 2;
  // stuck pack grain + free grain within contact radius
  s.pflag[i] = 5; s.pAir[i] = 1; s.px[i] = s.cx; s.py[i] = s.cy + s.oceanR + 0.6 * s.atmosphereH; s.pz[i] = s.cz;
  s.pflag[j] = 5; s.pAir[j] = 0; s.px[j] = s.px[i] + s.spacing * 0.3; s.py[j] = s.py[i]; s.pz[j] = s.pz[i];
  s.pvy[j] = -0.5;
  // a second free pair falling together (inelastic pairing)
  s.pflag[k] = 5; s.pAir[k] = 0; s.px[k] = s.px[i] + 2; s.py[k] = s.py[i]; s.pz[k] = s.pz[i];
  const l = 3;
  s.pflag[l] = 5; s.pAir[l] = 0; s.px[l] = s.px[k] + s.spacing * 0.2; s.py[l] = s.py[k]; s.pz[l] = s.pz[k];
  s.pvy[k] = -0.9; s.pvy[l] = -0.3;
  s._iceContacts();
  assert.equal(s.pAir[j], 1, 'free grain sticks to the pack');
  assert.equal(s.pvy[j], 0, 'stuck grain holds position');
  assert.equal(s.pvy[k], s.pvy[l], 'free pair adopts the mean velocity');
  assert.ok(Math.abs(s.pvy[k] + 0.6) < 1e-5, 'mean of −0.9 and −0.3');
  s.disableMultithreading && s.disableMultithreading();
}

// ---- 6d. free snow falls, sticks on terrain contact --------------------------
{
  const s = mk({ mode: 'sphere', coreR: 0.5, targetParticles: 8000 });
  s.resetWater(0.4); s.sunPos = [1, 2, 1];
  // find a rock position above sea level to land on (terrain lives in the
  // continuous surface, not the per-frame cellType raster)
  let landX = 0, landY = 0, landZ = 0, found = false;
  for (let a = 2; a < s.nx - 2 && !found; a++) for (let b = 2; b < s.ny - 2 && !found; b++) for (let c = 2; c < s.nz - 2 && !found; c++) {
    const x = (a + 0.5) * s.dx, y = (b + 0.5) * s.dx, z = (c + 0.5) * s.dx;
    const r = Math.sqrt((x - s.cx) ** 2 + (y - s.cy) ** 2 + (z - s.cz) ** 2);
    if (r > s.oceanR + 0.1 && r < s.oceanR + s.atmosphereH * 0.5 && s._rockCellAt(x, y, z)) {
      landX = x; landY = y; landZ = z; found = true;
    }
  }
  assert.ok(found, 'test planet has terrain');
  const p = 0;
  s.pflag[p] = 5; s.pAir[p] = 0; s.pT[p] = 0.05;   // frozen rain, mid-air
  s.px[p] = landX; s.py[p] = landY + s.dx * 0.8; s.pz[p] = landZ;
  s.pvx[p] = 0; s.pvy[p] = 0; s.pvz[p] = 0;
  for (let f = 0; f < 40 && s.pAir[p] !== 1; f++) s.step(1 / 60);
  assert.equal(s.pAir[p], 1, 'falling ice sticks on terrain contact');
  assert.equal(s.pvx[p], 0, 'stuck ice does not move');
  s.disableMultithreading && s.disableMultithreading();
}

// ---- 6e. no-slip evaporation: fresh vapor adopts the local tangential flow ---
// Differential form: same particle, same seeded RNG kick, grid flow 0.5 vs 0 —
// the spawned velocities must differ by exactly the injected surface flow.
{
  const s = mk();
  s.resetWater(0.5);
  s.sunActivity = 50;               // intensity law: probability ≥ 1 → certain ejection
  s.evapIntensity = 1;              // (the coefficient: certainty at any T > freeze)
  s._markFluidCells(0, s.nP);       // rasterize the sea (cells start unmarked)
  // topmost fluid particle in column (i=8, k=8) — a genuine surface-top site
  let topP = -1, topJ = -1;
  for (let q = 0; q < s.nP; q++) {
    if (s.pflag[q] !== 0) continue;
    const j = Math.floor(s.py[q] / s.dx), i = Math.floor(s.px[q] / s.dx), k = Math.floor(s.pz[q] / s.dx);
    if (i === 8 && k === 8 && j > topJ) { topJ = j; topP = q; }
  }
  assert.ok(topP >= 0, 'found a surface particle in the test column');
  s.pT[topP] = 1.0;
  const vx0 = s.pvx[topP], vy0 = s.pvy[topP], vz0 = s.pvz[topP];
  // full snapshot — the evaporation set must be identical in both runs so the
  // seeded LCG sits at the same draw position when the target ejects
  const snap = {
    fl: s.pflag.slice(), vx: s.pvx.slice(), vy: s.pvy.slice(), vz: s.pvz.slice(),
    T: s.pT.slice(), air: s.pAir.slice()
  };

  const runEvap = (uFlow, wFlow) => {
    s.pflag.set(snap.fl); s.pvx.set(snap.vx); s.pvy.set(snap.vy); s.pvz.set(snap.vz);
    s.pT.set(snap.T); s.pAir.set(snap.air);
    s._evS = 0x51ab3c77;            // identical MB kick in both runs
    s.u.fill(0); s.v.fill(0); s.w.fill(0);
    s.u[(8 * s.ny + topJ) * (s.nx + 1) + 8] = uFlow;
    s.w[(8 * s.ny + topJ) * s.nx + 8] = wFlow;
    s._updateEvaporation(1 / 60);
    assert.equal(s.pflag[topP], 2, 'particle evaporated deterministically');
    return [s.pvx[topP], s.pvz[topP]];
  };
  const [ax, az] = runEvap(0.5, -0.25);
  const [bx, bz] = runEvap(0, 0);
  assert.ok(Math.abs((ax - bx) - 0.5) < 1e-6, 'tangential x adopted from the grid (' + (ax - bx).toFixed(6) + ')');
  assert.ok(Math.abs((az - bz) + 0.25) < 1e-6, 'tangential z adopted from the grid (' + (az - bz).toFixed(6) + ')');
  s.disableMultithreading && s.disableMultithreading();
}

// ---- 6f. evaporation intensity: absolute exponential law above the freeze ----
{
  const s = mk({ nx: 24, ny: 24, nz: 24, dx: 0.25, targetParticles: 8000 });
  s.resetWater(0.5);
  s._markFluidCells(0, s.nP);       // rasterize the sea (cells start unmarked)
  s.sunActivity = 2;

  // surface-top fluid particles (pool mode: no fluid in the +y neighbour)
  const tops = [];
  for (let q = 0; q < s.nP; q++) {
    if (s.pflag[q] !== 0) continue;
    const i = Math.floor(s.px[q] / s.dx), j = Math.floor(s.py[q] / s.dx), k = Math.floor(s.pz[q] / s.dx);
    if (i < 1 || i >= s.nx - 1 || j < 1 || j >= s.ny - 1 || k < 1 || k >= s.nz - 1) continue;
    if (s.cellType[(k * s.ny + j) * s.nx + i] !== 1) continue;          // FLUID
    if (s.cellType[(k * s.ny + j + 1) * s.nx + i] === 1) continue;      // covered above
    tops.push(q);
  }
  assert.ok(tops.length > 300, 'enough surface-top sites (' + tops.length + ')');

  const runEvapAt = (T, intensity) => {
    for (const q of tops) { s.pflag[q] = 0; s.pT[q] = T; }
    s.evapIntensity = intensity;
    s._evS = 0x51ab3c77;            // identical stream for every run
    s._updateEvaporation(1 / 60);
    let n = 0;
    for (const q of tops) if (s.pflag[q] === 2) n++;
    return n;
  };

  // (a) at or below the freezing point NOTHING evaporates, whatever the intensity
  const freezeT = Math.max(s.meltT, s.snowT * 1.05);
  assert.equal(runEvapAt(freezeT, 100), 0, 'water at the freezing point never evaporates');
  assert.equal(runEvapAt(freezeT - 0.02, 100), 0, 'sub-freezing water never evaporates');

  // (b) any liquid ABOVE the freezing point may leave — even at 0.30, far below
  // the old evaporation point (0.42): crank the intensity → certainty
  const warm = runEvapAt(0.30, 100);
  assert.equal(warm, tops.length, 'warm water above freezing evaporates with certainty');

  // (c) exponential growth with temperature at a moderate intensity
  const cold = runEvapAt(0.30, 1);
  const hot = runEvapAt(0.70, 1);
  assert.ok(cold > 0, 'water just above freezing still seeps some vapor');
  assert.ok(hot < tops.length, 'moderate intensity keeps hot evaporation sub-certain');
  const ratio = hot / Math.max(cold, 1);
  assert.ok(ratio > 2.2 && ratio < 7.5,
    'evaporation grows exponentially with T (ratio ' + ratio.toFixed(2) + ' ≈ e^(3.5·ΔT) = 4.1)');

  // (d) intensity 0 = dry air even on boiling water
  assert.equal(runEvapAt(1.0, 0), 0, 'intensity 0 disables evaporation entirely');
  s.disableMultithreading && s.disableMultithreading();
}

// ---- 6g. airborne rain trades heat with the AIR, not with deep space ----------
// The old model relaxed rain to the water ambient with the night target pinned
// at 0 (radiating to space like deep water) — night rain froze mid-air almost
// every time. Rain must relax toward the sky ambient (0.06 at night) with a
// coupling between the steam's and the water's rates.
{
  const s = mk();
  s.resetWater(0.5);
  s.sunPos = null;                  // box night: everyone unlit
  // one rain droplet and one water particle, both parked high in the air
  // (air cells have no other particles → the conduction pass is inert, the
  // branch relaxation is measured alone), same starting heat
  const pR = 0, pW = 1;
  const top = (s.ny - 3) * s.dx;
  s.pflag[pR] = 4; s.pT[pR] = 0.5;
  s.px[pR] = 2 * s.dx; s.py[pR] = top; s.pz[pR] = 2 * s.dx;
  s.pflag[pW] = 0; s.pT[pW] = 0.5;
  s.px[pW] = (s.nx - 3) * s.dx; s.py[pW] = top; s.pz[pW] = (s.nz - 3) * s.dx;
  for (let t = 0; t < 25; t++) s._updateHeat(1 / 25);   // 1 simulated second
  assert.ok(s.pT[pR] > 0.15 && s.pT[pR] < 0.3,
    'night rain relaxes toward the AIR ambient (0.06), not to absolute zero (T=' + s.pT[pR].toFixed(3) + ')');
  assert.ok(s.pT[pW] > 0.42,
    'water keeps the old slow space-radiation cooling (T=' + s.pT[pW].toFixed(3) + ')');
  s.disableMultithreading && s.disableMultithreading();
}

// ---- 7. integration smoke: mixed states stay finite and contained -------------
{
  const s = mk({ mode: 'sphere', coreR: 0.5, nx: 16, targetParticles: 8000 });
  s.resetWater(0.4); s.sunPos = [1, 2, 1];
  // demote a slice of the ocean to steam at cold temps → exercise all paths
  for (let p = 0; p < s.nP; p += 7) {
    s.pflag[p] = 2; s.pT[p] = 0.05 + (p % 23) / 100;
    const ex = s.px[p] - s.cx, ey = s.py[p] - s.cy, ez = s.pz[p] - s.cz;
    const er = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-6;
    const r = s.oceanR + 0.3 * s.atmosphereH * ((p % 11) / 11 + 0.2);
    s.px[p] = s.cx + ex / er * r; s.py[p] = s.cy + ey / er * r; s.pz[p] = s.cz + ez / er * r;
  }
  for (let f = 0; f < 90; f++) s.step(1 / 60);
  let bad = 0, maxR = 0;
  const R = s.oceanR + s.atmosphereH + 0.05;
  for (let p = 0; p < s.nP; p++) {
    if (!isFinite(s.px[p]) || !isFinite(s.py[p]) || !isFinite(s.pz[p]) ||
        !isFinite(s.pvx[p]) || !isFinite(s.pvy[p]) || !isFinite(s.pvz[p])) bad++;
    const dx = s.px[p] - s.cx, dy = s.py[p] - s.cy, dz = s.pz[p] - s.cz;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (r > R) maxR = Math.max(maxR, r);
  }
  assert.equal(bad, 0, 'no NaNs after mixed-state evolution');
  assert.ok(maxR <= R, 'all particles contained (maxR=' + maxR.toFixed(3) + ' ≤ ' + R.toFixed(3) + ')');
  s.disableMultithreading && s.disableMultithreading();
}
console.log('ALL PHASE TESTS PASSED');
