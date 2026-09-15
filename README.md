# WaterSim 3D — Navier–Stokes planet ocean simulation

An interactive, self-contained 3D water simulation of an **ocean planet**. It features a voxel terrain globe with eroded continents, planet-centric gravity, and an incompressible Navier–Stokes fluid-dynamics solver on an Eulerian staggered (MAC) grid. Liquid volume is carried by FLIP particles, with the free surface extracted by marching tetrahedra, and rigid bodies coupled via Archimedes' buoyancy. 

Everything runs locally in the browser without a build step.

## Run it

Open `index.html` in any modern browser, or serve it locally:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

The physics engine runs **on the CPU, single threaded**.

**Interactions**

| Input | Action |
|---|---|
| Left-drag / wheel | Orbit / zoom camera |
| **Alt + drag** | Stir the water with a virtual hand |
| Buttons | Pause · Reset water · Clear balls · 🌍 Earth mode |
| Keys | `Space` pause · `R` reset · `S` splash · `B` ball · `V` velocity vectors · `P` particles |

The control panel is a fully collapsible pane with tabs for *Physics*, *Display*, *Planet*, *Orbit*, and *Climate*.

## Visualization controls

*   **Motion blur:** Frame-blend (0–95%) for decaying motion trails.
*   **Particle temperature chart:** Live log10 histogram showing the share of five phase classes (water, vapor, ice, rain, cloud).
*   **Stars:** Scalable, three-layer twinkling starfield.
*   **Cloud sprite:** Replaces procedural circle clouds with a soft image texture.

## The physics

### 1. Governing equations
Momentum and mass conservation for an incompressible fluid with gravity, solved using operator-split substeps:
1. Rasterize particles to cell types.
2. Particle→grid (P2G) momentum splatting.
3. Boundary conditions (no-flow on solids).
4. Body forces (gravity and optional viscosity).
5. Pressure projection (`∇·u = 0`).
6. Grid→particle (G2P) update (FLIP/PIC blend).
7. Advection (including ballistic droplets).
8. Ocean dynamics (vorticity and subsurface currents).
9. Rigid bodies (Archimedes' buoyancy and quadratic drag).

### 2. The voxel planet & gravity
Built from 3D value noise, Laplacian-smoothed into a voxel lattice (~27% landmass). Applies radial inverse-square gravity. Water physically interacts with the rock terrain.

### 3. Sunlight & heat
The planet orbits a fixed sun and spins on a tilted axis, creating seasons and a day/night cycle. 
*   **Atmosphere:** Surface liquid evaporates via an exponential thermal law. Vapor gets a velocity kick, feels atmospheric gravity, and collides with terrain/parcels.
*   **Clouds, rain & snow:** Steam condenses into clouds when cold. Cold steam falls as rain. Water/rain chilling below the snow point becomes adhesive snow or floating ice.
*   **Earth mode:** Auto-tunes thermal knobs (Sun activity, Evaporation/Snow points) to maintain a 100:10:1 (liquid:ice:vapor) ratio.

### 4. Ocean dynamics
Includes vorticity confinement to maintain small-scale swirling and analytical divergence-free subsurface currents.

### 5. Rendering the planet
*   **Terrain:** Contoured via marching tetrahedra and shaded by elevation.
*   **Water:** Semi-transparent physical surface with animated ripples. Alternative modes include flat blue "Water beads" or a continuous "Metaball" skin.
*   **Particles:** All phases (spray, rain, steam, cloud, snow) render in a single, camera-sorted atlas pass.

### 6. Surface reconstruction
Auto-calibrated marching tetrahedra precisely matches the meshed volume to the true water volume.

### 7. Stability
Dynamic CFL-based substeps and an absolute 3.2 m/s speed clamp prevent numerical explosions.

## Deploying & Troubleshooting
Run with any static file server (no special headers needed). Use the `Recalibrate target` button in the UI if frame rates drop to find a stable hardware preset.

## Architecture

```text
index.html          UI shell
css/style.css       Styling
js/solver.js        Navier–Stokes FLIP solver
js/surface.js       Marching-tetrahedra isosurface
js/controls.js      Orbit camera
js/scene.js         Three.js planet scene
js/main.js          App loop, UI, climate controller
js/quality.js       Render-scale controller
vendor/three.min.js Three.js r128 
serve.py            Static dev server 
test/               Node test suite 
```

## Tests
Includes a robust headless node test suite validating pool-mode density, surface volume conservation, buoyancy, scaling, ocean dynamics, and the atmosphere cycle. Run via `node test/[name].test.js`.

## Performance notes
Features an auto-detail calibrator that targets 50 FPS or 25 FPS based on real-time browser capability, scaling from 10k to 220k target particles.

## References
- J. Stam, *Stable Fluids* (1999)
- R. Bridson, *Fluid Simulation for Computer Graphics*
- Y. Zhu & R. Bridson, *Animating Sand as a Fluid* (2005)
- M. Müller et al., *FLIP for graph-based fluid simulation*
- Marching tetrahedra: Paul Bourke's geometry notes