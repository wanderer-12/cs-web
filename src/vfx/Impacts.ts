// =============================================================================
// vfx/Impacts.ts — impact recipes: bullet holes, sparks, dust, blood, landing.
//
// This module is deliberately free of three.js: it only pushes records into the
// pools from Decals.ts / Particles.ts, so every recipe here is plain arithmetic
// over preallocated slots. One reusable ParticleSpawn struct plus a few scratch
// vectors carry all the per-burst parameters, which is what keeps a firing range
// (thousands of rounds) allocation-free.
//
// Surface look is data, not code branches: MATERIAL_PROFILE holds one row per
// SurfaceMaterial and a switch-free lookup then drives every emitter. Adding a
// material is one table row, and the table is `as const`, so it costs nothing at
// runtime and cannot grow per shot.
// =============================================================================

import type { HitGroup, SurfaceMaterial, Vec3 } from '../core/types';
import type { DecalPool } from './Decals';
import type { ParticlePool } from './Particles';
import { createParticleSpawn } from './Particles';
import {
  buildDecalBasis,
  createBasis,
  createPlane,
  planeFromPointNormal,
  randomConeDir,
  safeDir,
  type Plane,
  type RngLike,
} from './VfxMath';

/** How long a bullet hole lives before it fades (seconds). */
export const IMPACT_DECAL_LIFE = 26;

/** Hit-payload geometry plus the rng — everything an impact recipe needs. */
export interface ImpactContext {
  decals: DecalPool;
  /** Additive cloud: sparks and other hot fragments. */
  sparks: ParticlePool;
  /** Soft cloud: dust, dirt, chips, blood. */
  soft: ParticlePool;
  /** Billboarded puffs: smoke and dust clouds. */
  smoke: ParticlePool;
  rng: RngLike;
}

interface MaterialProfile {
  /** Spark count; sparks bounce once off the impact plane. */
  sparks: number;
  /** Fastest spark (units/s); the slowest is 0.35x this. */
  sparkSpeed: number;
  dust: number;
  dustR: number;
  dustG: number;
  dustB: number;
  /** Largest dust mote radius; the smallest is 0.35x this. */
  dustSize: number;
  /** Billboarded smoke puffs. */
  smoke: number;
  /** Solid chips/splinters/shards (soft cloud, they bounce). */
  debris: number;
  debrisR: number;
  debrisG: number;
  debrisB: number;
  /** Upward bias added to the burst (water splashes a lot). */
  rise: number;
}

const NO_PROFILE: MaterialProfile = {
  sparks: 0, sparkSpeed: 0,
  dust: 0, dustR: 1, dustG: 1, dustB: 1, dustSize: 1,
  smoke: 0,
  debris: 0, debrisR: 1, debrisG: 1, debrisB: 1,
  rise: 0,
};

/** Per-surface impact look. Tuned to read at CS distances, not to be physical. */
export const MATERIAL_PROFILE: Readonly<Record<SurfaceMaterial, MaterialProfile>> = {
  // Concrete breaks up into grey dust with a few sparks off the aggregate.
  concrete: {
    sparks: 10, sparkSpeed: 520,
    dust: 8, dustR: 0.62, dustG: 0.60, dustB: 0.57, dustSize: 9,
    smoke: 1, debris: 0, debrisR: 0.5, debrisG: 0.5, debrisB: 0.5, rise: 0.15,
  },
  // Sandstone is softer and lighter: more dust, fewer sparks.
  sandstone: {
    sparks: 7, sparkSpeed: 420,
    dust: 10, dustR: 0.74, dustG: 0.63, dustB: 0.45, dustSize: 11,
    smoke: 1, debris: 0, debrisR: 0.6, debrisG: 0.5, debrisB: 0.35, rise: 0.2,
  },
  // Metal throws the brightest, fastest spark shower.
  metal: {
    sparks: 20, sparkSpeed: 720,
    dust: 2, dustR: 0.55, dustG: 0.55, dustB: 0.58, dustSize: 5,
    smoke: 0, debris: 2, debrisR: 0.62, debrisG: 0.62, debrisB: 0.66, rise: 0,
  },
  // Wood splinters along the grain: brown chips and a warm dust ring.
  wood: {
    sparks: 3, sparkSpeed: 380,
    dust: 4, dustR: 0.52, dustG: 0.38, dustB: 0.23, dustSize: 7,
    smoke: 0, debris: 7, debrisR: 0.44, debrisG: 0.28, debrisB: 0.13, rise: 0,
  },
  // Sand does not spark at all; it blooms.
  sand: {
    sparks: 0, sparkSpeed: 0,
    dust: 14, dustR: 0.62, dustG: 0.55, dustB: 0.38, dustSize: 12,
    smoke: 0, debris: 0, debrisR: 0.5, debrisG: 0.45, debrisB: 0.3, rise: 0.3,
  },
  // Glass shatters into bright shards plus a fine sparkle.
  glass: {
    sparks: 14, sparkSpeed: 620,
    dust: 3, dustR: 0.80, dustG: 0.86, dustB: 0.90, dustSize: 6,
    smoke: 0, debris: 10, debrisR: 0.86, debrisG: 0.93, debrisB: 0.96, rise: 0.1,
  },
  // Flesh never gets a decal or sparks: `hit` drives the blood puff instead.
  flesh: NO_PROFILE,
  // Water splashes upward and leaves no mark.
  water: {
    sparks: 0, sparkSpeed: 0,
    dust: 12, dustR: 0.68, dustG: 0.78, dustB: 0.85, dustSize: 8,
    smoke: 0, debris: 0, debrisR: 0.7, debrisG: 0.8, debrisB: 0.9, rise: 0.8,
  },
};

/** Blood droplet counts per hit group (headshots are dramatic on purpose). */
const BLOOD_COUNT: Readonly<Record<HitGroup, number>> = {
  head: 16,
  chest: 9,
  stomach: 9,
  arm: 5,
  leg: 4,
  generic: 7,
};

// ---------------------------------------------------------------------------
// Scratch state (single-threaded, consumed synchronously — never retained)
// ---------------------------------------------------------------------------

const spawn: ReturnType<typeof createParticleSpawn> = createParticleSpawn();
const dirScratch: Vec3 = { x: 0, y: 1, z: 0 };
const pointScratch: Vec3 = { x: 0, y: 0, z: 0 };
const basisScratch = createBasis();
const planeScratch: Plane = createPlane();

/** Write the current `spawn` scratch into `pool` (copies, never retains it). */
function emit(pool: ParticlePool): void {
  pool.spawn(spawn);
}

/**
 * Bullet impact: decal + sparks + dust + chips, with `dustOnly` reserved for
 * footsteps, ricochets and other events where the engine knows a hole would be
 * wrong. Sparks bounce once off the actual surface plane (`n · p = d`), so a
 * shot into a wall sprays along the wall instead of through it.
 */
export function spawnImpact(
  ctx: ImpactContext,
  point: Vec3,
  normal: Vec3,
  material: SurfaceMaterial,
  dustOnly = false,
): void {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
    return;
  }
  const profile = MATERIAL_PROFILE[material] ?? NO_PROFILE;
  const rng = ctx.rng;

  // Decal: one atlas tile, roll-randomised so repeated hits do not stamp.
  ctx.decals.spawn(point, normal, material, 0, IMPACT_DECAL_LIFE, rng.float() * Math.PI * 2);

  const basis = buildDecalBasis(normal, basisScratch);
  const n = basis.n;
  safeDir(dirScratch, n);
  planeFromPointNormal(planeScratch, point, n);
  const sparks = dustOnly ? 0 : profile.sparks;
  const debris = dustOnly ? 0 : profile.debris;
  const dust = dustOnly ? Math.max(2, profile.dust >> 1) : profile.dust;

  // --- sparks (additive, hot, one bounce) --------------------------------
  for (let i = 0; i < sparks; i++) {
    randomConeDir(rng, dirScratch, n, 0.95);
    const speed = profile.sparkSpeed * (0.35 + 0.65 * rng.float());
    const heat = rng.float();
    spawn.x = point.x; spawn.y = point.y; spawn.z = point.z;
    spawn.vx = dirScratch.x * speed;
    spawn.vy = dirScratch.y * speed + profile.rise * speed * 0.4;
    spawn.vz = dirScratch.z * speed;
    spawn.life = 0.18 + rng.float() * 0.32;
    spawn.sizeStart = 2.4; spawn.sizeEnd = 0.5;
    // White-hot to orange, so the shower cools as it falls.
    spawn.r = 1; spawn.g = 0.72 + 0.28 * heat; spawn.b = 0.30 + 0.45 * heat;
    spawn.alphaStart = 1; spawn.alphaEnd = 0;
    spawn.gravity = -800; spawn.drag = 0.6;
    spawn.angle = 0; spawn.spin = 0;
    spawn.plane = true;
    spawn.pnx = planeScratch.nx; spawn.pny = planeScratch.ny;
    spawn.pnz = planeScratch.nz; spawn.pd = planeScratch.d;
    spawn.restitution = 0.4; spawn.friction = 0.5; spawn.maxBounces = 1;
    emit(ctx.sparks);
  }

  // --- debris (soft, bounces, reads as chips/shards) ---------------------
  for (let i = 0; i < debris; i++) {
    randomConeDir(rng, dirScratch, n, 0.8);
    const speed = 90 + rng.float() * 260;
    spawn.x = point.x; spawn.y = point.y; spawn.z = point.z;
    spawn.vx = dirScratch.x * speed;
    spawn.vy = dirScratch.y * speed + profile.rise * speed * 0.4;
    spawn.vz = dirScratch.z * speed;
    spawn.life = 0.6 + rng.float() * 0.7;
    spawn.sizeStart = 1.2 + rng.float() * 1.8; spawn.sizeEnd = spawn.sizeStart * 0.8;
    spawn.r = profile.debrisR; spawn.g = profile.debrisG; spawn.b = profile.debrisB;
    spawn.alphaStart = 1; spawn.alphaEnd = 0.15;
    spawn.gravity = -800; spawn.drag = 0.2;
    spawn.angle = rng.float() * 6.283; spawn.spin = (rng.float() - 0.5) * 12;
    spawn.plane = true;
    spawn.pnx = planeScratch.nx; spawn.pny = planeScratch.ny;
    spawn.pnz = planeScratch.nz; spawn.pd = planeScratch.d;
    spawn.restitution = 0.25; spawn.friction = 0.6; spawn.maxBounces = 1;
    emit(ctx.soft);
  }

  // --- dust (soft, expanding, drags to a stop) ---------------------------
  for (let i = 0; i < dust; i++) {
    randomConeDir(rng, dirScratch, n, 1.15);
    const speed = 30 + rng.float() * 90;
    const size = profile.dustSize * (0.35 + 0.65 * rng.float());
    spawn.x = point.x; spawn.y = point.y; spawn.z = point.z;
    spawn.vx = dirScratch.x * speed;
    spawn.vy = Math.abs(dirScratch.y) * speed + profile.rise * 60;
    spawn.vz = dirScratch.z * speed;
    spawn.life = 0.5 + rng.float() * 0.9;
    spawn.sizeStart = size; spawn.sizeEnd = size * 2.2;
    spawn.r = profile.dustR; spawn.g = profile.dustG; spawn.b = profile.dustB;
    spawn.alphaStart = 0.34; spawn.alphaEnd = 0;
    spawn.gravity = -50; spawn.drag = 2.2;
    spawn.angle = rng.float() * 6.283; spawn.spin = (rng.float() - 0.5) * 3;
    spawn.plane = false;
    emit(ctx.soft);
  }

  // --- smoke puffs (billboarded, rise and expand) ------------------------
  for (let i = 0; i < profile.smoke; i++) {
    randomConeDir(rng, dirScratch, n, 0.9);
    const size = 5 + rng.float() * 6;
    spawn.x = point.x + dirScratch.x * 3;
    spawn.y = point.y + dirScratch.y * 3;
    spawn.z = point.z + dirScratch.z * 3;
    spawn.vx = dirScratch.x * (10 + rng.float() * 25);
    spawn.vy = 12 + rng.float() * 22;
    spawn.vz = dirScratch.z * (10 + rng.float() * 25);
    spawn.life = 1.1 + rng.float() * 1.2;
    spawn.sizeStart = size; spawn.sizeEnd = size * 3.4;
    spawn.r = profile.dustR * 0.9; spawn.g = profile.dustG * 0.9; spawn.b = profile.dustB * 0.9;
    spawn.alphaStart = 0.30; spawn.alphaEnd = 0;
    spawn.gravity = 25; spawn.drag = 1.4;
    spawn.angle = rng.float() * 6.283; spawn.spin = (rng.float() - 0.5) * 1.6;
    spawn.plane = false;
    emit(ctx.smoke);
  }
}

/**
 * Blood puff for a `hit` event. The droplet count and the extra mist scale with
 * `hitGroup`, and the burst is aimed along the surface normal we were given (a
 * zero normal degrades to straight up, never NaN).
 */
export function spawnBloodPuff(
  ctx: ImpactContext,
  point: Vec3,
  normal: Vec3,
  hitGroup: HitGroup,
  scale = 1,
): void {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
    return;
  }
  const rng = ctx.rng;
  const count = Math.max(3, Math.round((BLOOD_COUNT[hitGroup] ?? 7) * (Number.isFinite(scale) && scale > 0 ? scale : 1)));

  buildDecalBasis(normal, basisScratch);
  safeDir(dirScratch, basisScratch.n);
  planeFromPointNormal(planeScratch, point, basisScratch.n);

  for (let i = 0; i < count; i++) {
    randomConeDir(rng, dirScratch, basisScratch.n, 0.55);
    const speed = 90 + rng.float() * 260;
    const size = 1.6 + rng.float() * 2.6;
    spawn.x = point.x; spawn.y = point.y; spawn.z = point.z;
    spawn.vx = dirScratch.x * speed;
    spawn.vy = dirScratch.y * speed + 30;
    spawn.vz = dirScratch.z * speed;
    spawn.life = 0.35 + rng.float() * 0.5;
    spawn.sizeStart = size; spawn.sizeEnd = size * 0.6;
    // Dark arterial red; the soft cloud is tonemapped, so it does not glow.
    spawn.r = 0.52; spawn.g = 0.035; spawn.b = 0.04;
    spawn.alphaStart = 0.95; spawn.alphaEnd = 0.1;
    spawn.gravity = -800; spawn.drag = 0.9;
    spawn.angle = 0; spawn.spin = 0;
    spawn.plane = true;
    spawn.pnx = planeScratch.nx; spawn.pny = planeScratch.ny;
    spawn.pnz = planeScratch.nz; spawn.pd = planeScratch.d;
    spawn.restitution = 0.15; spawn.friction = 0.7; spawn.maxBounces = 1;
    emit(ctx.soft);
  }

  // A short-lived mist that reads as a smear of blood in the air.
  const mist = Math.max(2, count >> 1);
  for (let i = 0; i < mist; i++) {
    randomConeDir(rng, dirScratch, basisScratch.n, 0.7);
    spawn.x = point.x; spawn.y = point.y; spawn.z = point.z;
    spawn.vx = dirScratch.x * 40;
    spawn.vy = dirScratch.y * 40 + 20;
    spawn.vz = dirScratch.z * 40;
    spawn.life = 0.5 + rng.float() * 0.5;
    spawn.sizeStart = 5 + rng.float() * 6; spawn.sizeEnd = spawn.sizeStart * 2.0;
    spawn.r = 0.42; spawn.g = 0.03; spawn.b = 0.035;
    spawn.alphaStart = 0.35; spawn.alphaEnd = 0;
    spawn.gravity = -60; spawn.drag = 2.4;
    spawn.angle = rng.float() * 6.283; spawn.spin = (rng.float() - 0.5) * 2;
    spawn.plane = false;
    emit(ctx.soft);
  }
}

/**
 * Jump/land dust ring. The engine's `land` event carries no position, so
 * VfxSystem remembers the last `footstep` per actor and calls this with the
 * cached spot; the public method also lets the engine place it exactly.
 */
export function spawnLandDust(ctx: ImpactContext, pos: Vec3, speed: number): void {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
    return;
  }
  const rng = ctx.rng;
  const amount = Math.max(3, Math.min(14, Math.round((Number.isFinite(speed) ? speed : 0) / 45) + 3));

  for (let i = 0; i < amount; i++) {
    // A horizontal ring: dust is kicked outward, not at the camera.
    const phi = rng.float() * 6.283;
    const radial = 0.35 + 0.65 * Math.sqrt(rng.float());
    const outward = 22 + (Number.isFinite(speed) ? Math.min(speed, 320) : 0) * 0.16;
    const size = 4 + rng.float() * 9;
    spawn.x = pos.x + Math.cos(phi) * radial * 6;
    spawn.y = pos.y + 2;
    spawn.z = pos.z + Math.sin(phi) * radial * 6;
    spawn.vx = Math.cos(phi) * outward * radial;
    spawn.vy = 14 + rng.float() * 34;
    spawn.vz = Math.sin(phi) * outward * radial;
    spawn.life = 0.5 + rng.float() * 0.7;
    spawn.sizeStart = size; spawn.sizeEnd = size * 2.4;
    spawn.r = 0.60; spawn.g = 0.56; spawn.b = 0.47;
    spawn.alphaStart = 0.36; spawn.alphaEnd = 0;
    spawn.gravity = -60; spawn.drag = 2.0;
    spawn.angle = rng.float() * 6.283; spawn.spin = (rng.float() - 0.5) * 2;
    spawn.plane = false;
    emit(ctx.soft);
  }

  for (let i = 0; i < 2; i++) {
    const size = 6 + rng.float() * 6;
    spawn.x = pos.x; spawn.y = pos.y + 1; spawn.z = pos.z;
    spawn.vx = (rng.float() - 0.5) * 26;
    spawn.vy = 8 + rng.float() * 14;
    spawn.vz = (rng.float() - 0.5) * 26;
    spawn.life = 0.7 + rng.float() * 0.8;
    spawn.sizeStart = size; spawn.sizeEnd = size * 3.2;
    spawn.r = 0.58; spawn.g = 0.55; spawn.b = 0.48;
    spawn.alphaStart = 0.26; spawn.alphaEnd = 0;
    spawn.gravity = 18; spawn.drag = 1.6;
    spawn.angle = rng.float() * 6.283; spawn.spin = (rng.float() - 0.5) * 1.2;
    spawn.plane = false;
    emit(ctx.smoke);
  }
}

/** Vertical muzzle-smoke wisp after a shot (small, additive cloud only). */
export function spawnMuzzleSmoke(ctx: ImpactContext, pos: Vec3, dir: Vec3, amount = 3): void {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;
  const rng = ctx.rng;
  safeDir(dirScratch, dir);
  for (let i = 0; i < amount; i++) {
    const size = 1.6 + rng.float() * 2.4;
    pointScratch.x = pos.x + dirScratch.x * 4;
    pointScratch.y = pos.y + dirScratch.y * 4 + 1;
    pointScratch.z = pos.z + dirScratch.z * 4;
    spawn.x = pointScratch.x; spawn.y = pointScratch.y; spawn.z = pointScratch.z;
    spawn.vx = dirScratch.x * 26 + (rng.float() - 0.5) * 12;
    spawn.vy = 12 + rng.float() * 16;
    spawn.vz = dirScratch.z * 26 + (rng.float() - 0.5) * 12;
    spawn.life = 0.4 + rng.float() * 0.5;
    spawn.sizeStart = size; spawn.sizeEnd = size * 4;
    spawn.r = 0.62; spawn.g = 0.60; spawn.b = 0.56;
    spawn.alphaStart = 0.22; spawn.alphaEnd = 0;
    spawn.gravity = -20; spawn.drag = 1.8;
    spawn.angle = rng.float() * 6.283; spawn.spin = (rng.float() - 0.5) * 2;
    spawn.plane = false;
    emit(ctx.smoke);
  }
}
