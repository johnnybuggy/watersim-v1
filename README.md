# WaterSim 3D — Navier–Stokes planet ocean simulation

An interactive, self-contained 3D water simulation of an **ocean planet** —
a **voxel terrain globe with eroded continents and ocean basins** (roughly
27 % of the surface above sea level), **gravity pointing at the planet's
center**, water that sloshes, pours between basins, laps against the rock and
splashes over beaches — built on a real fluid-dynamics solver: the
**incompressible Navier–Stokes equations** solved on an Eulerian staggered
(MAC) grid, with the liquid volume carried by **FLIP particles**, the free
surface extracted by **marching tetrahedra**, and rigid balls coupled to the
fluid through **Archimedes' buoyancy** and moving-solid boundary conditions.
The planet itself is **gouraud-shaded** (per-vertex lighting on the voxel
mesh) and tinted by a **color picker** (dark brown by default).

Everything runs locally in the browser — no build step, no network needed.

## Run it

Open `index.html` in any modern browser (double-clicking works — all assets
are local, and Three.js r128 is vendored in `vendor/`).

Optionally serve it instead:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

**Interactions**

| Input | Action |
|---|---|
| Left-drag / wheel | Orbit / zoom camera |
| **Alt + drag** | Stir the water with a virtual hand |
| Buttons | Pause · Reset water · Clear balls |
| Keys | `Space` pause · `R` reset · `S` splash · `B` ball · `V` velocity vectors · `P` particles |

## The physics

### 1. Governing equations

Momentum (Navier–Stokes) and mass conservation (continuity) for an
incompressible, variable-viscosity fluid with gravity:

```
∂u/∂t + (u · ∇) u = −(1/ρ) ∇p + ν ∇²u + g        (momentum)
∇ · u = 0                                        (incompressibility)
```

with the free-surface dynamic condition `p = p_atm` (Dirichlet, implemented
as `φ = 0` on air cells) and the no-flow condition `u · n = u_solid` on the
terrain rock and ball surfaces (Neumann for pressure).

Each substep is operator-split:

1. **Rasterize** particles → cell types (air / fluid / solid): on the planet
   a cell is solid where the **voxel terrain** is rock (plus the closed
   domain shell). Ball cells become *moving solids* with the ball's velocity.
2. **Particle→grid (P2G)**: trilinear splat of particle momenta onto the
   staggered velocity grid (`u` on x-faces, `v` on y-faces, `w` on z-faces).
3. **Boundary conditions**: wall faces get the solid velocity (0 on rock,
   ball velocity for floating bodies).
4. **Body forces**: optional kinematic viscosity `ν` (explicit diffusion,
   stability-clamped). On the planet, radial inverse-square **gravity is
   applied to grid faces *after* the FLIP snapshot** — inside the same
   substep's projection (see "Gravity on a planet" below); droplets and
   balls fly under true inverse-square gravity.
5. **Pressure projection** — the heart of incompressibility:
   ```
   ∇²φ = ∇ · u        (7-point Poisson, SOR Gauss-Seidel, warm-started)
   u ← u − ∇φ
   ```
   After projection `∇·u = 0` to machine-visible accuracy (the stats panel
   and the calm water surface show it). Dirichlet `φ = 0` at air = free
   surface; Neumann at solids.
6. **Grid→particle (G2P)**: FLIP update `vₚ += u_new − u_old` blended with
   PIC (`vₚ = u_new`) by the *PIC blend* slider — pure FLIP is lively but
   noisy, pure PIC is smooth but viscous.
7. **Advection**: particles move through the divergence-free field with
   RK2 (RK1 for slow particles). Droplets whose cells are fully surrounded
   by air detach and fly **ballistically** (gravity + air drag at terminal
   speed + wall restitution) until they splash back in, where they deposit
   only part of their momentum — as real droplets do when they fragment and
   merge. This is the spray you see.
8. **Ocean dynamics** (planet): *vorticity confinement* re-injects the
   small-scale swirl the coarse grid numerically diffuses away
   (`f = ε (N̂ × ω)`, N̂ pointing at each vorticity maximum), and slow
   *subsurface currents* relax the deep water toward a wandering,
   analytically divergence-free curl-noise field — tangential streams
   under a glassy surface.
9. **Rigid bodies**: each ball integrates
   ```
   F = ρ_water · V_submerged · g  −  m g  −  ½ ρ C_d A |v_rel| v_rel
   ```
   i.e. **Archimedes' buoyancy** (submerged volume computed as a spherical
   cap against the local free-surface height sampled from particles in a
   far-field annulus), quadratic drag vs. the local fluid velocity, and
   added mass (0.5 ρ V_sub). Two-way coupling: the ball's cells act as
   moving solids in the projection, so pushing a ball makes waves.

### 2. The voxel planet & gravity

**Terrain.** `generateTerrain(seed, seaLevel)` builds an eroded naturalistic
planet from seeded 3D value noise: domain-warped fbm **continents** (4
octaves), ridged **mountain ranges** (3 octaves, weighted 0.45 ×
*bumpiness*) and fine detail (0.14 × *bumpiness*), shaped by a power curve
into rolling hills and sharp crests. A binary-searched offset tunes the
height field so **~27 % of directions clear sea level** at the default ocean
depth — continents and archipelagos surrounding real basins. The field is
sampled onto a **voxel lattice** (half the grid spacing) that stores both a
rock/no-rock flag and the continuous radius; the fluid grid marks a cell
SOLID iff the voxel at its center is rock, and every particle placement /
push-out uses the *same cell rule*, so the water and the rasterized world
always agree — fill day has nothing to fix and the ocean starts
mirror-calm. Placement itself carries a **generation guarantee**: every
fill candidate is rejected if it lands inside a rock cell *or inside a
solid terrain voxel* (the drawn mesh is the voxel surface, finer than the
cell rule), so no water particle is ever born inside the planet. Seeded
jitter and Monte-Carlo volume measurement make every
reset byte-reproducible (and the terrain itself is cached by `(coreR,
seaLevel, seed, bumpiness)`).

The shape sliders are **decoupled**: *Planet radius* sizes the whole globe
across a wide **0.5–25 m** range (shipped default **11 m**). The world is
**self-similar**: sea level
sits at 0.3·radius above the rock, the domain margin spans 0.4·radius,
terrain relief scales with the ocean depth, and the balls, drop height,
splash/stir radii, camera near/far, shadow frustum, starfield, sky and zoom
limits all scale with it — while the app drives gravity with a **Froude
correction** (`g_eff = g · 1.5/R`, velocities staying absolute), so
splashes, waves and hydrostatics look proportionally identical at every
planet size. *Ocean volume* scales how much water fills the globe — a
×0.1–×50 multiplier on
the active detail preset's particle count (the default ×3 is the shipped
ocean). Sea level stays put; the ocean adapts instead: particle spacing
coarsens or refines with the count (`s = ∛(V/N)`) and the auto-calibrated
iso-threshold keeps the meshed volume equal to the true water volume at any
count. *Bumpiness* (0–2, shipped default 0.25) scales all relief: near 0 the
planet morphs into an **almost perfect voxel sphere** wrapped in a uniform
shallow sea (rock surface within one voxel step of the sphere radius), from
~0.3 up the ridge/erosion octaves open it into continents — smooth sill to
jagged alpine at 2.

**Gravity.** The planet feels Newton's inverse-square gravity toward the
center — surface gravity exactly `g` at the ocean surface. Radial gravity is
applied as a **grid body force after the FLIP snapshot**, inside the same
substep's pressure projection: each fluid-adjacent face gets its precomputed
radial acceleration, so the projection balances gravity *within the substep*
and the FLIP delta cancels at rest — a hydrostatic ocean is an exact fixed
point. A short ramp-in on reset eases the force up so the fresh fill never
rings. What remains on the stairstep boundary is not a bug but the desired
physics: residual downslope flow that makes puddles seek basins, beaches
drain, and splash water run back down the slopes. A shallow stack of
dissipation tames the coarseness: a radial dashpot on near-surface particles
(kills radial slosh, leaves swirl untouched), mild bulk drag on grid-coupled
water, bottom friction within a cell of the rock, and inelastic
terrain contact for both particles and balls.

**Interaction.** Water physically meets the rock: particles are walked out of
any cell that rasterizes solid (killing the inward velocity component),
droplets that hit dry land beach into puddles that gravity pulls back
downhill, heavy balls settle onto the sea floor (voxel-AABB contact), light
balls float in the basins, and sunlight is **shadowed by the terrain itself**
— the ray to the sun now marches the voxel rock, so mountains cast real
shade across the water.

### 3. Sunlight & heat

The sun is **fixed**. The planet **revolves around it** — one "year" every
20 minutes by default (*Year — orbit around the Sun* slider) — and **spins
about its vertical axis**, one "day" every 5 minutes by default (*Day —
spin about its axis* slider). The spin axis can be **tilted against the
orbital axis** (*Axial tilt* slider, 0–45°, shipped default 30°): the tilt
is applied as a fixed
world-space lean on a group wrapping the spinning planet, so — exactly like
Earth — the axis keeps pointing at the same patch of sky while the planet
orbits, and the year brings **seasons**: each hemisphere leans into the Sun
on opposite sides of the orbit, shifting where evaporation, melt and snow
happen. At 0° the classic upright spin is restored exactly. The spin sweeps
the day/night terminator
across the surface while the year slowly changes the sun's azimuth; at zero
tilt the sun's elevation above the horizon stays constant (~22°). The
*Time scale* slider scales the whole simulation clock — physics steps AND the
orbital/spin motion alike — so speeding up time spins the planet faster too.
Together they
drive a per-particle thermal model:

- **Shadows**: a particle is lit only if the ray from it to the sun clears
  the planet — marched against the **voxel terrain**, so peaks and plateaus
  cast real shade — *and* is not buried: optical depth is accumulated by
  marching the density field toward the sun, and each water layer attenuates
  the light (`exp(-od)`). The same per-particle exposure value is mirrored to
  the renderer (`pLight`), so water, rain and vapor all **render shaded
  wherever they see no sun**.
- **Heating & dissipation**: the **Sun activity** slider (0–2 in fine 0.01
  steps, shipped default 0.23) scales how strongly lit particles warm toward saturation; all
  particles radiate back toward the ambient ocean temperature — and water out
  of the sun (the night side, or buried deep) radiates faster, so darkness
  actively cools. The same knob drives evaporation (below), so sun activity
  is the single dial for the whole water cycle.
- **Conduction** ("Heat conductivity" slider): conservative cell-aggregate
  diffusion with equal/opposite neighboring-cell energy flux and intra-cell
  relaxation. It replaces dense particle-pair scans with O(particles + cells)
  work; conduction alone preserves total heat. This is a grid-scale model.
- **Convection**: warm water is buoyant — a radial push outward for hot
  particles, inward for cold ones — so the heated band rises while cooler
  water sinks beneath it (measured: the hot quarter of the ocean floats
  ~7 cm above the cold quarter).
- **Colors**: water keeps its selected aquatic hue rather than turning
  orange with heat. Spray highlights brighten droplets; vapor has a subtle
  blue-white scattering tint. Particles render **shaded wherever they do not
  see the Sun**: the solver's per-particle exposure (night hemisphere, terrain
  shadow, burial under optically thick water) drives the rendering, with only
  a faint floor so the night side stays barely readable.

#### The atmosphere — evaporation & condensation

A particle **status**, not a separate system: a fluid particle whose cell has
no fluid above it (along local "up") can **evaporate** — it leaves the liquid
(`pflag = 2`) with a **Maxwell–Boltzmann kick**: three independent Gaussian
velocity components (Box–Muller from the seeded LCG — deterministic), giving
the thermal escape spectrum `f(v) ∝ v²·exp(−v²/2σ²)` whose per-component
spread σ grows with the normalized heat (`σ ∝ √T` — warmer water kicks
harder). Mirroring the radial component above the local horizon keeps fresh
vapor leaving the water and, being a pure sign flip, preserves the MB speed
distribution exactly. Free parcels then feel only **slight atmospheric
gravity**, so the thermal escape spectrum settles into a **bottom-heavy
barometric height profile** — vapor is densest just above the sea and thins
exponentially toward the ceiling (measured: ≈50 % of all vapor in the lowest
fifth of the atmosphere, ≈0.1 % in the top tenth). It then relaxes toward
**coherent zonal winds plus an upper day-to-night current** (the wind speeds
are capped by the solver speed limit, so giant planets get strong — yet
physical — circulation instead of proportional gales; the winds act on the
tangential velocity only, leaving the barometric radial structure intact). A
buoyant floor reflector at the sea surface bounces descending parcels back up
— elastically, with a small seeded fraction sticking and condensing — which
keeps the population aloft long enough to cross the terminator rather than
immediately falling back into its source basin. This is a stylized parcel
circulation model, not a compressible atmosphere solver. Vapor condenses on
liquid contact and rains out when cold.

**Evaporation probability grows exponentially between the planet's coldest and
hottest water temperatures**: every thermal tick scans the liquid's Tmin/Tmax,
and a surface parcel at temperature T leaves with probability
`rate · e^{5(τ−1)}` where `τ = (T−Tmin)/(Tmax−Tmin)` — the sun-warmed day side
boils off briskly while the night side and deep shade evaporate too, just far
more slowly. The **Sun activity** slider scales the rate (and the heating).

Vapor parcels **collide and repel each other** — overlapping pairs swap
normal velocity components and get pushed apart with a short repulsion
impulse, so the atmosphere occupies volume instead of interpenetrating —
**bounce off terrain** (inward radial motion reflects outward, damped), and
**reflect from the atmosphere ceiling stochastically**: the higher the parcel,
the more likely it bounces. The *Vapor ceiling reflection* curve is chosen by
a **picker hidden in the panel** — *linear* (0 at sea level, 1 at the
ceiling) is always active unless changed programmatically; *quadratic* and
*exponential* remain wired. The hard ceiling (clamp + reflect
at **sea level + atmosphere height**, terrain-following over mountains) is the
containment backstop — and that height is the *real* one: the *Atmosphere
height* slider sets exactly how far above sea level evaporated particles and
falling droplets can reach, unclamped by the simulation shell (the shell only
has to contain the ocean and its terrain). Collision
candidates use a sorted spatial sweep instead of a quadratic all-pairs pass
with a 4,000-particle cutoff. Where vapor crowds far above the atmosphere-wide
mean density, **lightning strikes**: a bright blue bolt channel runs from the
dense vapor pocket down to the terrain beneath it (sea level over open water,
the rock surface over land), flickering in sync with a sharp-attack /
flicker-decay cloud flash (decorative additive sprites — never touching the
simulation). The
*Thunderstorm intensity* slider scales how easily storms fire: a logarithmic
**×0.01–×10** multiplier (shipped default **×0.1**) that raises the spark
chance and lowers the density threshold together — from rare single bolts to
frequent widespread storms. Vapor
renders as **broad, low-opacity Gaussian cloudlets**, softly overlapping into
atmospheric wisps.

Airborne water sheds heat fast: its ambient is the sky — mild by day,
near-freezing in shade and after sundown. When it cools below the dew point
it **condenses**: the droplet sheds its vapor motion entirely (speed drops to
zero) and free-falls onto the planet, where the existing spray rules take
over — gravity, terrain contact, beaching into puddles that run downhill to
the ocean or pool into lakes. Water mass is conserved across all three
statuses (fluid / droplet / vapor).

### 4. Ocean dynamics — subsurface streams & whirling

Two additions keep the ocean alive between splashes (both have sliders,
both default-on in the UI, off in the headless library):

- **Vorticity confinement** (the swirl keeper): a coarse MAC grid diffuses
  small eddies away — the finer the churn, the faster it dies. After each
  projection the solver measures the surviving vorticity `ω = ∇×u`, points
  `N̂` at each vorticity maximum (`∇|ω|` normalized) and adds
  `f = ε (N̂ × ω)`, swirling fluid *around* eddy cores: shear layers roll up
  into whirlpools, splash crowns curl, stir wakes persist for seconds. The
  force is double-gated — interior fluid cells only, and only where `|ω|`
  exceeds noise level — so it amplifies real eddies but can never feed on
  free-surface shear or numerical noise (20 s unattended runs stay flat),
  and it carries a hard acceleration cap under gravity.
- **Subsurface currents**: a vector potential of drifting sine waves (three
  octaves: planet-scale gyres λ≈4 m, streams λ≈1.6 m, fine whorls λ≈0.7 m,
  each wandering at its own rate) is curled *analytically*, so the field is
  divergence-free by construction and never fights the pressure projection.
  Sub-surface particles relax toward the local current, tangentially only
  (radial drift stays an order of magnitude smaller), with the topmost layer
  excluded so the free surface stays glassy while the water beneath wanders
  like thermohaline circulation. The thermal model rides on top: the
  subsolar hot band is stretched and folded into streaks by the streams.

### 5. Rendering the planet — natural voxels, glossy water

The rock is meshed directly from the voxel field: only faces between rock and
air are emitted, and each mesh **corner averages the normals of every face
touching it** (degenerate corners — where opposing faces cancel — fall back
to the radial direction, so no vertex ever renders black) — the classic
gouraud trick that melts the voxel staircase into soft, eroded-looking hills
while the collision below stays exactly voxel. The skin is
`MeshPhongMaterial` (matte, weathered rather than plastic) with
per-vertex **elevation palette** measured from the planet's center:

- **under water** — the rock hue darkened and pulled to a brown-grey;
- **the waterline belt** — warm sand beaches, then green lowlands;
- **mid slopes** — the **Planet color picker** hue (dark brown `#654321` by
  default — the picker recolors the palette in place, geometry untouched);
- **high ground** — bleaching to snow white on the peaks.

Coherent spatial color variation and latitude-dependent snow keep the palette
natural while all geometry remains on the voxel lattice. The night side is
dim. A small night fill keeps transported clouds perceptible.
The atmosphere-height slider (shipped default **1.65 m**, spanning up to
**20 m**) sets the physical ceiling without rebuilding terrain; the ceiling
is honored even above the simulation shell (the shell only has to contain
the ocean and its terrain). The additive limb **halo is hidden** — the
atmosphere reads through its vapor and lighting alone.

Water is a **continuous semi-transparent physical-material surface**, with
low roughness, environment reflections, clearcoat and subtle animated normal
ripples — and two anti-"transparent black" measures: an **emissive
self-tint at 0.24 × the water color**, plus a shader **alpha pre-boost**
(`rgb ×= min(1/α, 2.1)`) that cancels the dimming of alpha blending against
the near-black sky, so the translucent body always renders as a saturated
blue. The water-opacity slider (shipped default **25 %**) is independent of
spray/cloud opacity. Only detached droplets and vapor draw as particles: the
liquid body no longer looks like overlapping beads. The rain/spray droplets
themselves are clearly visible at every size — glossy sphere-shaded sprites
with a baked specular hotspot, a higher default opacity (50 %) and a faint
night-side floor (12 % of full brightness) keep them readable without
glowing in the dark. The
**Water beads** checkbox (**enabled by default**) flips to a separate display
mode where the liquid body renders *exclusively* as **flat blue circles** — a
hard-edged, evenly transparent disc sprite with no gradients, and no
isosurface mesh (the marching-tets pass is skipped entirely): pure display
switch, physics untouched. Every circle is tinted with the water color and
darkened by the solver's per-particle sun exposure, so the night side falls
into **true planet shadow** instead of glowing. In that
mode the circles ARE the water surface, so their
transparency follows the *Water surface opacity* slider on its own draw call,
while the detached **glossy rain droplets** (⅓ the circle diameter) and
vapor keep following the spray/atmosphere slider. Night side, terrain shade
and underwater depth all render dim.
The water picker tints
both surface and rain. The **Water velocity vectors** checkbox overlays
arrows on grid-coupled water particles showing the **moving average of the
last 5 simulation steps** (a 5-slot per-particle velocity ring in the scene,
re-keyed whenever the solver is rebuilt; stride-sampled, capped at 9,000
lines): direction = averaged velocity,
length ∝ averaged speed, color ramping calm blue → white with speed. This
uses alpha translucency, not expensive
screen-space refraction, and transparent cloudlets use approximate layer
ordering rather than full volumetric rendering. The sun and particles
depth-test against the terrain.

### 6. Surface reconstruction

The visible water surface is the iso-surface of a particle density field
(each particle splats a smooth kernel onto grid corners). The iso-threshold
is **auto-calibrated at fill time by binary search so the meshed volume
equals the true water volume** (volume conservation you can see). Meshing is
*marching tetrahedra* — a watertight 6-tet decomposition per cell, vertex
normals from the density gradient.

### 7. Stability

Substep size obeys the **CFL condition** `dt ≤ CFL·dx/max|u|` and an
absolute cap (1/100 s); additional micro-substeps are inserted automatically
during violent motion, which is why splashes stay stable while the resting
ocean costs almost nothing. Two scene-scale safety constants keep the
discretization honest: a particle speed clamp (3.2 m/s — a splash crown of
~0.5 m on the classic 2 m-radius reference world; the clamp stays absolute at every
planet size, consistent with the Froude-scaled gravity) and a matching grid
velocity
ceiling after projection, so pressure-solve overshoot can never re-launch
splash into an endless fountain. Floating balls additionally clamp their
drag reaction below gravity, so drag damps motion but buoyancy alone
decides how a ball floats (verified: the light ball settles at 35 %
submerged = ρ_ball/ρ_water exactly).

### 8. Other laws that "just happen"

- Hydrostatics: leave the ocean alone — the field settles and every basin
  holds its water at sea level (v_rms ≈ 1 cm/s on the eroded terrain, and
  glassy-calm in the pool world). `p = ρ g depth` holds down each column.
- Mass conservation: particle count is fixed; mean surface height drifts
  < 0.5 mm over minutes in the headless test.
- Wave reflection/focusing, sloshing modes, vortex formation — all emerge
  from the equations, nothing is keyframed.
- Momentum exchange with floating bodies (Newton's 3rd law) via the
  moving-solid BC + particle push-out.
- **No particle below the surface**: a frame-end sweep walks any particle
  sitting in a rasterized-solid cell out of the rock and lifts particles
  more than half a cell under the continuous surface back to it (inward
  velocity killed — a pure correction, never an energy source). Rock
  walk-outs never push past the domain shell: on very tall peaks a bead
  pinned at the shell lands instead of ping-ponging through the clamp.
- **No blinking on the summits**: beads resting on mountain tops stay
  grid-coupled — both demotion paths (the "flying sea" rain-down rule and
  the airborne-droplet rule) exempt particles resting on terrain, so
  summit water no longer flaps between spray and puddle every substep.
- **Dry-land census**: ~1200 voxel rays classify the surface every 10 s of
  sim time; the dry percentage (land with no water sitting on it — beached
  puddles count as wet) shows in the stats panel.

## Architecture

```
index.html          UI shell (control panel, stats, help)
css/style.css       dark glass styling
js/solver.js        the Navier–Stokes FLIP solver (no dependencies)
js/surface.js       marching-tetrahedra isosurface + volume integral
js/controls.js      minimal orbit camera
js/scene.js         Three.js planet scene (voxel terrain, atmosphere, starfield, lights)
js/main.js          loop, UI wiring, stir/splash interactions, hardware calibration
js/quality.js       frame-budget policy and adaptive render-scale controller
vendor/three.min.js Three.js r128 (vendored, works offline)
test/solver.test.js headless physics tests (node)
```

## Tests

```bash
node test/solver.test.js
node test/atmosphere.test.js
node test/optimization.test.js
node test/scene.smoke.js
node test/surface.test.js
node test/quality.test.js
node test/main.test.js
node test/performance.js    # CPU step + surface benchmark, three presets
node test/browser.test.js   # optional: local Chrome, real WebGL + screenshots
```

Validates the solver headlessly, in both its domains: pool-mode fill
density, 2 s stability (no NaN, in-bounds), hydrostatic settling (KE decay,
mean height preserved < 4 cm), surface-volume conservation (< 1.5 % error),
splash dissipation, buoyancy (light ball floats at ≈ ρ_ball/ρ_water
submerged fraction, heavy ball sinks) — and planet-mode checks: ~27 % of the
planet above sea level (voxel-measured), **no water inside the rock** at fill
(zero particles in rock cells *or* solid terrain voxels — the generation
guarantee)
or after a splash, every basin filled to sea level, a calm hydrostatic settle
(v_rms ≈ 1 cm/s), nothing escaping the domain, splash containment + sea
level re-forming, a light ball floating in a basin (35 % submerged = the
density ratio) and a heavy ball resting on the sea floor; **world scaling**:
0.5 m and 25 m planets fill clean (no embedded spawns), stay contained, keep
the speed clamp and show proportional land after 2 s of scaled dynamics; the
thermal model:
subsolar heating, terrain-shadow darkness on the night side, hot water rising
above cold (deep-water census), and conduction/dissipation after sundown;
the ocean dynamics: darkness cooling the ocean faster than baseline
dissipation, subsurface streams flowing through the mid-column (tangentially
dominant), and confinement that measurably retains splash vorticity
(enstrophy ~1.7× the unconfined run at 1 s) while still decaying — with a
20 s combined run at shipped defaults proving no energy ratchet; the
bumpiness slider: 0 collapses the terrain to a voxel sphere inside one voxel
step; and the **atmosphere cycle**: warm surface water evaporating into
levitating vapor, vapor held under the atmosphere ceiling, water mass
conserved across the fluid/droplet/vapor statuses, night-side vapor chilling
and raining out (rock stays dry, nothing escapes), embedded particles
rescued above the surface, and the dry-land census tracking the land above
water. All checks pass (see the suite banner for the current count).

## Performance notes

The principal optimizations inline hot grid transfers and samplers, reuse
exact G2P grid samples for advection, cache
static terrain cell classifications, reuse terrain on water reset, and replace
dense pairwise heat exchange with conservative cell-aggregate diffusion.
Pressure iteration counts, the 10 ms maximum substep, CFL limits and FLIP/PIC
transfer remain intact. A larger timestep was evaluated but rejected after
stability regressions.

Measured with Node 26 on this machine (`test/performance.js`, 30 warmup + 90
steps, 1/60 s simulated per step; timings are CPU work, **not FPS**):

| Preset | Particles | Original mean step | Optimized mean step |
|---|---:|---:|---:|
| Tiny | 17,427 | 15.24 ms | 9.16 ms |
| Low | 32,762 | 28.50 ms | 16.75 ms |
| Medium | 60,149 | 54.92 ms | 32.89 ms |

These are representative local results; use the benchmark to remeasure on
your hardware. Surface extraction and GPU work are additional costs. A real
headless-Chrome run selected Tiny (22³) for the 50 FPS target, running near
60 FPS, and Balanced (26³) for the 25 FPS target. Selection varies between
runs; each slower displayed frame also needs more physics substeps. The run
had 4,110 vapor parcels, 2,538 on the night hemisphere
after roughly 16 seconds. A deterministic day-origin cohort test also checks
transport before condensation and eventual rain-out after global nightfall.
Browser tests compile shaders and capture screenshots, but screenshot visual
inspection was unavailable in this agent session.

Manual presets ship as the default (**Medium — 40³**). **Auto detail —
50 FPS / 25 FPS** measures increasing tiers on your own
browser, from Eco (18³ / 10k target particles) through Extreme (72³ / 220k).
Each tier includes terrain, particle simulation, surface reconstruction,
render scale and shadows. After eight warmup frames, 24 samples measure a
full simulation + mesh + completed GPU render; the 90th-percentile cost must
fit within 80% of a refresh-aware budget. Twelve idle RAF intervals estimate
the display cadence; on 60 Hz, the 50 FPS target budgets for 60 FPS and the
25 FPS target for 30 FPS (13.3 / 26.7 ms with the reserve). This avoids
selecting a nominal 20 ms workload that actually presents at 30 FPS.
Calibration stops at the first failing tier and selects the highest passing
one. This is the highest **tested preset**, not an exhaustive hardware optimum.
If even Eco misses, the detail status explicitly reports the exceeded budget.

Calibration refills the ocean and blocks controls while measuring. Afterward,
the physics grid stays fixed so waves, water mass and balls are not reset by
an automatic quality change. Sustained overload reduces render scale; six
seconds of headroom gradually restore it. Use **Recalibrate target** after
changing physics settings or window size. This deliberately does not lower
pressure accuracy or skip simulation work to manufacture an FPS number.
GPU synchronization is used only during calibration, never during normal play.

FPS reports actual, unclamped frame intervals (including below 30 FPS).
Only simulation time is capped after long stalls. Paused water reuses its
surface geometry. Water/spray GPU uploads use their live draw ranges instead
of entire oversized backing arrays. `window.waterSimPerformance` exposes
calibration results and `window.waterSimStats` exposes current timing.

Targets are not guarantees: display refresh, thermal throttling, other apps,
vapor growth, splashes and high time scales can change the budget. Manual
resolution presets remain available; the 25 FPS mode typically permits more
detail but also simulates more substeps per displayed frame.

## GPU solver — WebGPU compute

The physics solver itself can run as WebGPU compute (the WebGL renderer is
untouched). `js/gpu/shaders.js` is a hand-written WGSL port of the CPU solver
pipeline; `js/gpu/gpusim.js` is the host. **GPU Solver** ships **disabled**
and is flagged *experimental yet* in the panel; when enabled, it runs wherever
WebGPU is available and the simulation silently falls back to the CPU
solver (`js/solver.js`) otherwise — on unsupported browsers, on device loss,
or if any GPU step fails. The toggle (`GPU solver` in the panel) forces either
backend. An **explicit badge** (bottom-left of the viewport) always states
what is actually integrating the solver this frame: `Physics: GPU · WebGPU
compute`, or `Physics: CPU fallback · <reason>` (WebGPU unavailable, init/step
failure with details on the console, or toggled off in the panel); the stats
panel's *physics solver* row mirrors it tersely.

Structure of one GPU step mirrors the CPU one: thermal/evaporation/currents
tick (~25 Hz), rasterize, P2G scatter, normalization, boundary conditions,
viscosity, gravity, pressure (red-black SOR), projection, vorticity confinement,
clamp, extrapolation, G2P, advection, ball coupling; frame-end passes run
vapor condensation, surface census, density splat and ball velocity probes.
State lives in two GPU storage slabs — particles + cell scalars (`BP`) and
MAC face arrays (`BF`) — plus a read-only static buffer (`S`) for voxel
terrain, planet gravity faces and current wave constants. A small uniform
table (`O`) maps logical solver fields onto those slabs; the field map and
documented aliases are listed at the top of `shaders.js`. Uniforms are a
triple-buffered ring so substeps never serialize on the host. Each frame ends
with one bulk readback (positions, velocities, temperature, flags, cooling,
density, counters, ball probes); the solver's JS arrays stay authoritative for
rendering and statistics.

Documented divergences from the CPU path (behavior-faithful, not bit-identical):

- **Randomness**: the GPU uses a per-particle PCG32 hash stream seeded by
  particle index + frame, so evaporation/droplet jitter is statistically
  equivalent but numerically different from the CPU LCG.
- **Pressure**: red-black SOR (ω=1.55, warm-started `q`) instead of the CPU's
  in-place iteration order — same equilibrium, slightly different transients.
- **Viscosity**: Jacobi form reading the pre-projection snapshot, while the
  CPU updates in place (Gauss-Seidel order).
- **Vapor/evaporation**: the thermal tick uses the GPU's fixed-point min/max
  temperature range accumulator; vapor populations track the CPU scale but
  individual counts differ frame to frame. The GPU ejection kick is still the
  legacy heat-scaled scheme — the CPU's Maxwell–Boltzmann escape spectrum and
  barometric buoyancy refactor (floor reflector) are not yet ported, so GPU
  vapor rides slightly higher than CPU vapor.
- **Ball velocity probes** are sampled on GPU; integration stays on the host.

Substep scheduling (CFL + 10 ms cap), particle caps, containment (sky-high
ceiling), and mass bookkeeping are all enforced identically on both paths, and
the round-4 verification invariants (paused determinism, night-side rain-out,
containment) hold on either backend. The node suite always exercises the CPU
solver unchanged; GPU-specific probes live in the smoke/parity scripts.

## References

- J. Stam, *Stable Fluids* (1999) — semi-Lagrangian advection + projection.
- R. Bridson, *Fluid Simulation for Computer Graphics*, 2nd ed.
- Y. Zhu & R. Bridson, *Animating Sand as a Fluid* (2005) — FLIP/PIC blend.
- M. Müller et al., *FLIP for graph-based fluid simulation* — hybrid blends.
- Marching tetrahedra: see Paul Bourke's geometry notes.

Enjoy the ocean. 🌊
