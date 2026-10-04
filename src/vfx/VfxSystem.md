# VFX module — integration notes

Procedural, pooled, allocation-free effects for the game loop: impacts, decals,
tracers, muzzle flash, shells, blood, dust, explosions and the screen flash.
Everything is generated at runtime (geometry, canvas textures, no assets).

## Files

| File | Role |
| --- | --- |
| `VfxSystem.ts` | Entry point: public API, event wiring, per-frame update |
| `VfxMath.ts` | Pure math/pool-safety helpers (no three.js, no DOM) |
| `ShaderPatches.ts` | `onBeforeCompile` patches (per-instance UV rect / alpha / point size) |
| `Textures.ts` | Procedural canvas textures (soft particle, smoke, muzzle, decal atlas) |
| `Decals.ts` | Decal atlas, ring buffer (192) and its single `InstancedMesh` |
| `Tracers.ts` | Tracer ring buffer (24) and its additive `InstancedMesh` |
| `Casings.ts` | Shell ring buffer (48) + pure ballistic stepper |
| `Muzzle.ts` | Muzzle-flash pool (8) + additive billboard `InstancedMesh` |
| `Particles.ts` | Spark/soft `Points` clouds and the billboarded smoke `InstancedMesh` |
| `Impacts.ts` | Material/impact recipes (which particles a concrete wall throws) |
| `Explosions.ts` | Blast pool (6), additive sphere, smoke emission, scorch decal |

## Wiring (three calls)

```ts
import { bus } from '../core/events';
import { createVfx } from './vfx/VfxSystem';

const vfx = createVfx({ scene, camera, world }); // world optional
vfx.attach(bus);                                 // subscribes itself; detach() is idempotent

// in the render loop, AFTER the camera has been moved:
camera.updateMatrixWorld(true);                  // update() reads camera.matrixWorld
vfx.update(dt, camera);                          // dt in seconds, clamped internally
hud.setFlash(vfx.flashAmount);                   // 0..1 screen flash, read every frame
pointLight.intensity = vfx.flashlightIntensity;  // optional muzzle light
pointLight.position.copy(vfx.flashlightPosition);
```

- `update(dt, camera)` is safe with `dt = 0`, `NaN` or a multi-second tab-switch
  delta (clamped to 0.5 s), and does nothing at all when no effect is live.
  Passing the camera is optional — it defaults to the one from the options.
- All positions/vectors are plain `{x,y,z}` (the project's `Vec3`); callers may
  pass a `THREE.Vector3` since it is structurally compatible.
- `world.raycast` is used only to place explosion scorch marks and ground dust;
  leaving `world` undefined degrades to a heuristic `pos.y - radius * 0.25`.
- `dispose()` removes every mesh from the scene and frees the textures.
  `reset()` (round restart) empties the pools without recreating anything.

## Events consumed

| Event | Effect |
| --- | --- |
| `shot` | Muzzle flash (billboard, random roll, 0.04–0.07 s, smaller+dimmer when `silenced`), muzzle smoke, tracer from `origin` along `dir`, shell casing ejected to the right of the camera, muzzle light pulse |
| `impact` | `spawnImpact(point, normal, material, dustOnly)` — decal + sparks + dust/smoke |
| `hit` | Blood puff at `point` scaled by `hitGroup` (head 1.4x); remembered for `death` |
| `death` | Larger blood burst (`2.4x`) at the victim's last `hit` if it happened <1.5 s ago |
| `grenadeExplode` | Explosion at `pos` with `radius`, kind read from `kind` (`he`/`flash`/`smoke`) |
| `bombPlanted` | Caches the plant position per site (A/B) |
| `bombExploded` | Explosion at the cached plant position, `c4` profile |
| `flash` | Drives `flashAmount` toward `intensity` (range falloff, no line of sight), decaying over `duration` |
| `footstep` | Caches the last known position per actor (used by `land`) |
| `land` | Jump dust at the actor's last cached footstep position |

### Events that carry no position

`types.ts` gives `land`, `death` and `bombExploded` no position, so the system
caches anchors instead of skipping the effect: last `footstep` per actor (24-slot
ring), last `hit` per victim (32-slot ring, 1.5 s window), planted position per
site (2 slots). Exact placement is also available directly:

```ts
vfx.spawnLandDust(pos, speed);              // the engine knows where the player is
vfx.spawnExplosion(pos, radius, 'he');      // any kind string; 'c4'/'flash'/'smoke' have profiles
```

A casing's `restY` is derived as `shot.origin.y - PLAYER.standEye + 1`, i.e. it
assumes the shot came from eye height over a roughly flat floor. Over a void the
case simply keeps falling until its 2.5 s life expires.

## Transparency / render order

The VFX meshes are all `transparent: true` with `depthWrite: false` for the soft
and additive layers, and use these `renderOrder` values (`RENDER_ORDER` in
`VfxMath.ts`): decals 4, tracers 10, sparks 11, particles 12, smoke 13,
explosions 14, muzzle 15. **Any further transparent object drawn on top of the
world — the view model above all — must use a higher `renderOrder` (≥ 20).**
Casings are opaque and share the decal slot; decals additionally use a polygon
offset so a decal never z-fights the wall it lies on.

Every VFX mesh sets `frustumCulled = false`: an `InstancedMesh` is culled by its
geometry bounding sphere, which sits at the origin and would make effects pop out
of view. Do not re-enable it.

## Budgets

- Fixed capacities, all from `PERF`/module constants: 192 decals, 48 casings,
  24 tracers, 8 muzzle flashes, 384 sparks, 384 soft particles, 96 smoke puffs,
  6 explosions. Nothing is created after construction: no geometry, material,
  texture or matrix is allocated per shot (`instanceMatrix` arrays are written in
  place, hidden slots get a zero-scale matrix instead of `visible = false`).
- Inactive slots cost nothing: decals/tracers/casings/smoke keep a fixed
  slot→instance mapping and are only rewritten while fading, particles are packed
  to the front and uploaded with `setDrawRange` + `addUpdateRange` for the live
  prefix only, and `update()` returns before touching any renderer when no pool
  is live.
- No per-frame allocations at all: spawn paths write into preallocated record
  arrays and `instanceMatrix` buffers, and the only object ever allocated after
  construction is the one `stats()` (diagnostics) returns — do not call it per
  frame.

## Deviations from the task spec (with reasons)

1. **`flesh` and `water` produce no decal** — blood puffs / droplets instead. The
   atlas has exactly 6 tiles (concrete, metal, wood, sand, glass, scorch); flesh
   would need a 7th and per-instance blood decals read as paint splatter.
2. **Muzzle smoke is extra work** beyond the spec's flash/tracer/casing: a
   suppressor with no smoke reads as a broken gun.
3. **Extra public members** used by nothing in the spec but needed by the game:
   `spawnExplosion`, `flashlightIntensity`, `flashlightPosition`, `reset()`,
   `stats()`. The required API (`attach`/`detach`/`update`/`spawnImpact`/
   `spawnLandDust`/`flashAmount`/`setFlashlightIntensity`/`dispose`/`createVfx`)
   is exactly as specified.
4. **`MAX_POINT_PIXELS` clamp**: three multiplies `material.size` by the device
   pixel ratio for `gl_PointSize`, and drivers cap point size, so a puff close to
   the eye would otherwise pop. The patch clamps it and `maxPixelRatio` only
   affects that clamp.
5. **Muzzle flash and tracer billboards are frozen at spawn** (camera basis
   captured then): they live 40–70 ms, so re-billboarding every frame would cost
   more than it can visibly improve. Tracers *are* rebuilt per frame during their
   life because their fade is the visible part.
6. **`randomConeDir` samples uniformly inside the cone** (cos θ uniform over
   `[cos h, 1]`) and substitutes the world-up axis for a degenerate direction.
   The first implementation put every sample on the cone rim and collapsed to a
   near-zero vector for a zero `dir` — caught by `tests/vfx.spec.ts`.
7. **`PERF.casings` is 48** (the design doc `PLAN.md` mentioned 64); `PERF` wins,
   as the budget should live in one place.

## Tests

`pnpm vitest run tests/vfx.spec.ts` — 30 tests, no WebGL and no DOM canvas:
ring wraparound and capacity (decals 192, tracers 24, casings 48, particles,
explosions 6), atlas tile mapping + UV rect layout/clamping, the exact
constant-acceleration particle stepper (analytic apex `v0²/2g`), lifetime and
bounce behaviour, `clampDt`, orthonormal non-NaN decal bases for axis-aligned,
tiny, zero and NaN normals (right-handedness included), zero-normal/NaN/`dt = 0`
robustness through the real impact recipes, and pool bounds after 3000 shots.
Visual output itself is not covered — it needs a real renderer.
