// =============================================================================
// vfx/Explosions.ts — fireballs, blast smoke and scorch marks.
//
// An explosion is three things that age differently: an additive sphere that is
// blinding for 0.12 s and then collapses (~0.55 s), a slow rolling smoke cloud
// (2-4 s), and a permanent-ish scorch decal on the ground. They are kept in one
// record so a second grenade cannot desynchronise them, and the record is a plain
// preallocated struct in a small ring (EXPLOSION_SLOTS), so no part of a blast
// allocates.
//
// The fireball is a single instanced sphere, not a light: the engine keeps
// ownership of actual lights (VfxSystem only exposes a flashlight intensity), and
// an emissive sphere reads correctly for a blast that must not relight the map.
// =============================================================================

import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  MeshBasicMaterial,
  SphereGeometry,
  type Scene,
} from 'three';
import type { Vec3 } from '../core/types';
import { DECAL_TILE_SCORCH, RENDER_ORDER, writeHiddenMatrix } from './VfxMath';
import { createParticleSpawn, type ParticlePool } from './Particles';
import type { DecalPool } from './Decals';
import type { RngLike } from './VfxMath';

/** Concurrent blasts. Six is far more than a CS round ever needs. */
export const EXPLOSION_SLOTS = 6;
/** The fireball is at full brightness for this long (spec: a bright 0.12 s). */
export const EXPLOSION_FLASH_TIME = 0.12;

export interface ExplosionProfile {
  /** Fireball colour and peak brightness. */
  r: number; g: number; b: number;
  peak: number;
  /** Fireball radius multiplier and lifetime. */
  radiusScale: number;
  life: number;
  /** Ground scorch decal; smoke grenades leave none. */
  scorch: boolean;
  scorchScale: number;
  /** Billboarded puffs still to emit, and the interval between them. */
  smoke: number;
  smokeInterval: number;
  /** Dust kicked outward along the ground. */
  groundDust: number;
}

/** Fallback = high explosive (HE grenade). */
const HE_PROFILE: ExplosionProfile = {
  r: 1, g: 0.62, b: 0.22, peak: 2.4,
  radiusScale: 1, life: 0.55,
  scorch: true, scorchScale: 1.5,
  smoke: 14, smokeInterval: 0.03,
  groundDust: 18,
};

const C4_PROFILE: ExplosionProfile = {
  r: 1, g: 0.72, b: 0.34, peak: 3.0,
  radiusScale: 1.25, life: 0.7,
  scorch: true, scorchScale: 2.4,
  smoke: 20, smokeInterval: 0.03,
  groundDust: 24,
};

const FLASH_PROFILE: ExplosionProfile = {
  // Near-white and much brighter: a flashbang is a light source, not fire.
  r: 1, g: 0.97, b: 0.9, peak: 4.0,
  radiusScale: 0.8, life: 0.45,
  scorch: false, scorchScale: 0,
  smoke: 6, smokeInterval: 0.04,
  groundDust: 8,
};

const SMOKE_PROFILE: ExplosionProfile = {
  r: 0.7, g: 0.7, b: 0.72, peak: 0.0,
  radiusScale: 1.1, life: 0.9,
  scorch: false, scorchScale: 0,
  smoke: 34, smokeInterval: 0.06,
  groundDust: 6,
};

/** Map a grenade `kind` string to a look. Unknown kinds fall back to HE. */
export function explosionProfileFor(kind: string): ExplosionProfile {
  switch (kind) {
    case 'flash':
    case 'flashbang':
      return FLASH_PROFILE;
    case 'smoke':
      return SMOKE_PROFILE;
    case 'c4':
    case 'bomb':
      return C4_PROFILE;
    default:
      return HE_PROFILE;
  }
}

export interface ExplosionRecord {
  active: boolean;
  dirty: boolean;
  px: number;
  py: number;
  pz: number;
  radius: number;
  age: number;
  life: number;
  r: number;
  g: number;
  b: number;
  peak: number;
  radiusScale: number;
  /** Ground height the scorch was placed at (also the dust ring's origin). */
  groundY: number;
  smokeLeft: number;
  smokeTimer: number;
  smokeInterval: number;
  groundDust: number;
}

export function createExplosionRecord(): ExplosionRecord {
  return {
    active: false, dirty: false,
    px: 0, py: 0, pz: 0,
    radius: 0, age: 0, life: EXPLOSION_FLASH_TIME,
    r: 1, g: 0.6, b: 0.2, peak: 1,
    radiusScale: 1,
    groundY: 0,
    smokeLeft: 0, smokeTimer: 0, smokeInterval: 0.04,
    groundDust: 0,
  };
}

/** Fixed-size blast ring (slot -> instance, so a live blast keeps its slot). */
export class ExplosionPool {
  readonly capacity: number;
  readonly records: ExplosionRecord[];
  cursor = 0;
  count = 0;
  spawned = 0;

  constructor(capacity: number = EXPLOSION_SLOTS) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.records = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.records[i] = createExplosionRecord();
  }

  spawn(
    pos: Vec3,
    radius: number,
    profile: ExplosionProfile,
    groundY: number,
  ): ExplosionRecord {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.spawned++;

    const rec = this.records[index];
    rec.active = true;
    rec.dirty = true;
    rec.px = Number.isFinite(pos.x) ? pos.x : 0;
    rec.py = Number.isFinite(pos.y) ? pos.y : 0;
    rec.pz = Number.isFinite(pos.z) ? pos.z : 0;
    rec.radius = Number.isFinite(radius) && radius > 0 ? radius : 180;
    rec.age = 0;
    rec.life = profile.life;
    rec.r = profile.r; rec.g = profile.g; rec.b = profile.b;
    rec.peak = profile.peak;
    rec.radiusScale = profile.radiusScale;
    rec.groundY = Number.isFinite(groundY) ? groundY : rec.py - rec.radius * 0.25;
    rec.smokeLeft = profile.smoke;
    rec.smokeTimer = 0;
    rec.smokeInterval = profile.smokeInterval;
    rec.groundDust = profile.groundDust;
    return rec;
  }

  /** Age every blast. Returns the number still alive. */
  update(dt: number): number {
    if (!(dt > 0)) {
      let live = 0;
      for (let i = 0; i < this.capacity; i++) if (this.records[i].active) live++;
      return live;
    }
    let live = 0;
    for (let i = 0; i < this.capacity; i++) {
      const rec = this.records[i];
      if (!rec.active) continue;
      rec.age += dt;
      if (rec.age >= rec.life) {
        rec.active = false;
        rec.dirty = true;
        continue;
      }
      live++;
    }
    return live;
  }

  releaseAll(): void {
    for (let i = 0; i < this.capacity; i++) {
      const rec = this.records[i];
      if (!rec.active) continue;
      rec.active = false;
      rec.dirty = true;
    }
    this.cursor = 0;
  }

  get liveCount(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (this.records[i].active) n++;
    return n;
  }
}

/**
 * Blast particles. Kept separate from `ExplosionPool.update` so the renderer can
 * run on an untouched record set: this function ONLY emits, purely from the
 * remaining smoke budget and timers, and it stops by itself when the budget is
 * spent (a spent blast emits nothing and costs one comparison per frame).
 */
export function emitExplosionParticles(ctx: {
  explosions: ExplosionPool;
  smoke: ParticlePool;
  soft: ParticlePool;
  rng: RngLike;
}, dt: number): void {
  const rng = ctx.rng;
  const spawn = spawnScratch;
  for (let i = 0; i < ctx.explosions.capacity; i++) {
    const rec = ctx.explosions.records[i];
    if (!rec.active) continue;

    // Ground dust belongs to the first ~0.15 s only.
    if (rec.groundDust > 0 && rec.age < 0.15) {
      const n = rec.groundDust;
      rec.groundDust = 0;
      for (let k = 0; k < n; k++) {
        const phi = rng.float() * 6.283;
        const radial = 0.4 + 0.6 * Math.sqrt(rng.float());
        const speed = rec.radius * (0.9 + rng.float() * 0.9);
        const size = 6 + rng.float() * 14;
        spawn.x = rec.px + Math.cos(phi) * radial * 8;
        spawn.y = rec.groundY + 2;
        spawn.z = rec.pz + Math.sin(phi) * radial * 8;
        spawn.vx = Math.cos(phi) * speed * radial;
        spawn.vy = 40 + rng.float() * 140;
        spawn.vz = Math.sin(phi) * speed * radial;
        spawn.life = 0.7 + rng.float() * 1.1;
        spawn.sizeStart = size; spawn.sizeEnd = size * 2.6;
        spawn.r = 0.58; spawn.g = 0.54; spawn.b = 0.46;
        spawn.alphaStart = 0.45; spawn.alphaEnd = 0;
        spawn.gravity = -60; spawn.drag = 1.6;
        spawn.angle = rng.float() * 6.283; spawn.spin = (rng.float() - 0.5) * 2;
        spawn.plane = false;
        ctx.soft.spawn(spawn);
      }
    }

    if (rec.smokeLeft <= 0) continue;
    rec.smokeTimer -= dt;
    // Emit at most a few per frame: a blast cloud must roll, not pop.
    let budget = 3;
    while (rec.smokeLeft > 0 && rec.smokeTimer <= 0 && budget-- > 0) {
      rec.smokeLeft--;
      rec.smokeTimer += rec.smokeInterval;
      const phi = rng.float() * 6.283;
      const radial = Math.sqrt(rng.float()) * rec.radius * 0.55;
      const size = rec.radius * (0.16 + rng.float() * 0.16);
      spawn.x = rec.px + Math.cos(phi) * radial;
      spawn.y = rec.groundY + 4 + rng.float() * rec.radius * 0.5;
      spawn.z = rec.pz + Math.sin(phi) * radial;
      spawn.vx = Math.cos(phi) * (12 + rng.float() * 45);
      spawn.vy = 26 + rng.float() * 60;
      spawn.vz = Math.sin(phi) * (12 + rng.float() * 45);
      spawn.life = 1.4 + rng.float() * 1.8;
      spawn.sizeStart = size; spawn.sizeEnd = size * (2.6 + rng.float());
      // Darken the puffs toward the end so the cloud looks like it cooled.
      spawn.r = 0.34; spawn.g = 0.33; spawn.b = 0.32;
      spawn.alphaStart = 0.5; spawn.alphaEnd = 0;
      spawn.gravity = 30; spawn.drag = 1.1;
      spawn.angle = rng.float() * 6.283; spawn.spin = (rng.float() - 0.5) * 1.4;
      spawn.plane = false;
      ctx.smoke.spawn(spawn);
    }
  }
}

/**
 * Fire the whole visual: pool record + scorch decal + ground dust + smoke.
 * `groundY` is resolved by VfxSystem (a downward raycast against `world` when it
 * was provided) so the scorch lands on the floor rather than mid-air.
 */
export function spawnExplosionVisual(ctx: {
  explosions: ExplosionPool;
  decals: DecalPool;
  smoke: ParticlePool;
  soft: ParticlePool;
  rng: RngLike;
}, pos: Vec3, radius: number, kind: string, groundY?: number): ExplosionRecord {
  const profile = explosionProfileFor(kind);
  const r = Number.isFinite(radius) && radius > 0 ? radius : 180;
  // No ground query available: assume the blast is near the floor it lit.
  const gy = Number.isFinite(groundY) ? (groundY as number) : pos.y - r * 0.25;
  if (profile.scorch) {
    const size = Math.max(40, Math.min(700, r * profile.scorchScale));
    scorchPoint.x = pos.x;
    scorchPoint.y = gy;
    scorchPoint.z = pos.z;
    ctx.decals.spawnTile(scorchPoint, UP, DECAL_TILE_SCORCH, size, 45, ctx.rng.float() * 6.283);
  }
  return ctx.explosions.spawn(pos, r, profile, gy);
}

/**
 * Additive blast sphere. One sphere for every kind of explosion: the profile's
 * colours and brightness decide whether it reads as fire, light or nothing
 * (a smoke grenade is `peak: 0`, so it never draws).
 */
export class ExplosionRenderer {
  readonly mesh: InstancedMesh;
  readonly material: MeshBasicMaterial;
  private readonly geometry: BufferGeometry;
  private readonly color = new Color();
  private readonly m: Float32Array;
  private live = 0;

  constructor(scene: Scene, readonly pool: ExplosionPool) {
    this.geometry = new SphereGeometry(1, 16, 12);
    this.material = new MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
    });

    this.mesh = new InstancedMesh(this.geometry, this.material, pool.capacity);
    this.mesh.name = 'vfx.explosions';
    this.mesh.renderOrder = RENDER_ORDER.explosions;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);

    this.m = new Float32Array(16);
    for (let i = 0; i < pool.capacity; i++) {
      writeHiddenMatrix(this.m);
      this.mesh.instanceMatrix.set(this.m, i * 16);
      this.mesh.setColorAt(i, BLACK);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.setUsage(DynamicDrawUsage);
      this.mesh.instanceColor.needsUpdate = true;
    }
    scene.add(this.mesh);
  }

  /** Reads the pool (already stepped this frame); writes matrices and colours. */
  update(): void {
    let live = 0;
    let dirty = false;
    for (let i = 0; i < this.pool.capacity; i++) {
      const rec = this.pool.records[i];
      if (!rec.active) {
        if (rec.dirty) {
          rec.dirty = false;
          writeHiddenMatrix(this.m);
          this.mesh.instanceMatrix.set(this.m, i * 16);
          this.mesh.setColorAt(i, BLACK);
          dirty = true;
        }
        continue;
      }
      live++;
      const t = rec.life > 0 ? Math.min(1, rec.age / rec.life) : 1;
      // Full brightness for the flash, then a fast collapse.
      const flashT = rec.life > 0 ? EXPLOSION_FLASH_TIME / rec.life : 1;
      let bright: number;
      if (t <= flashT) bright = rec.peak;
      else {
        const k = (t - flashT) / Math.max(1e-4, 1 - flashT);
        bright = rec.peak * (1 - k) * (1 - k);
      }
      const grow = 0.25 + 0.95 * (1 - (1 - t) * (1 - t));
      const scale = rec.radius * rec.radiusScale * grow;
      writeQuadMatrixLocal(this.m, scale, rec.px, rec.py, rec.pz);
      this.mesh.instanceMatrix.set(this.m, i * 16);
      this.color.setRGB(rec.r * bright, rec.g * bright, rec.b * bright);
      this.mesh.setColorAt(i, this.color);
      dirty = true;
    }
    if (dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
    this.live = live;
  }

  get liveCount(): number {
    return this.live;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Module scratch
// ---------------------------------------------------------------------------

const spawnScratch = createParticleSpawn();
const scorchPoint: Vec3 = { x: 0, y: 0, z: 0 };
const UP: Vec3 = { x: 0, y: 1, z: 0 };
const BLACK = new Color(0, 0, 0);

/** Uniform-scale instance matrix, written in place (no Matrix4 allocation). */
function writeQuadMatrixLocal(out: Float32Array, s: number, px: number, py: number, pz: number): void {
  out[0] = s; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = s; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = s; out[11] = 0;
  out[12] = px; out[13] = py; out[14] = pz; out[15] = 1;
}
