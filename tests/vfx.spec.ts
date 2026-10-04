// =============================================================================
// tests/vfx.spec.ts — VFX unit tests.
//
// Everything under test here is deliberately WebGL-free and DOM-free: the pools
// (Decals/Tracers/Casings/Particles/Explosions) are plain ring buffers, the math
// in VfxMath.ts is pure, and the impact recipes only push records into those
// pools. Constructing a VfxSystem would build canvases, so no test does that:
// what is covered is exactly the part that must be provably correct — ring
// wraparound, atlas mapping, ballistic integration and orientation math.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { PERF } from '../src/core/config';
import { Rng } from '../src/core/rng';
import type { SurfaceMaterial, Vec3 } from '../src/core/types';
import { CasingPool, stepCasing } from '../src/vfx/Casings';
import { DecalPool } from '../src/vfx/Decals';
import {
  EXPLOSION_SLOTS,
  ExplosionPool,
  explosionProfileFor,
  spawnExplosionVisual,
} from '../src/vfx/Explosions';
import { spawnBloodPuff, spawnImpact, spawnLandDust } from '../src/vfx/Impacts';
import { ParticlePool, createParticleSpawn } from '../src/vfx/Particles';
import { TRACER_LIFE, TracerPool } from '../src/vfx/Tracers';
import {
  DECAL_ATLAS_COLS,
  DECAL_QUAD_SIZE,
  DECAL_TILE_CONCRETE,
  DECAL_TILE_GLASS,
  DECAL_TILE_METAL,
  DECAL_TILE_SAND,
  DECAL_TILE_SCORCH,
  DECAL_TILE_WOOD,
  buildDecalBasis,
  clampDt,
  createCameraBasis,
  createParticle,
  createPlane,
  decalTileUvRect,
  materialDecalTile,
  particleT,
  planeFromPointNormal,
  randomConeDir,
  resetParticle,
  safeDir,
  stepParticle,
  writeHiddenMatrix,
  writeQuadMatrix,
} from '../src/vfx/VfxMath';

const POINT: Vec3 = { x: 0, y: 0, z: 0 };
const UP: Vec3 = { x: 0, y: 1, z: 0 };
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

function makeCtx() {
  return {
    decals: new DecalPool(),
    sparks: new ParticlePool(32),
    soft: new ParticlePool(32),
    smoke: new ParticlePool(8),
    rng: new Rng(0x1234),
  };
}

function vecLength(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

// ---------------------------------------------------------------------------
// Decals: ring buffer + atlas mapping
// ---------------------------------------------------------------------------

describe('decal ring buffer', () => {
  it('sizes itself from PERF and starts empty', () => {
    const pool = new DecalPool();
    expect(PERF.decals).toBe(192);
    expect(pool.capacity).toBe(192);
    expect(pool.records.length).toBe(192);
    expect(pool.count).toBe(0);
    expect(pool.liveCount).toBe(0);
  });

  it('fills to capacity, then wraps without ever growing or losing a slot', () => {
    const pool = new DecalPool();
    for (let i = 0; i < 192; i++) {
      const rec = pool.spawn(POINT, UP, 'concrete', 13, 26, 0);
      expect(rec).not.toBeNull();
      expect(rec?.active).toBe(true);
    }
    expect(pool.count).toBe(192);
    expect(pool.cursor).toBe(0);
    expect(pool.liveCount).toBe(192);

    // Keep firing: the ring must wrap, never allocate, never exceed capacity.
    for (let i = 0; i < 1000; i++) pool.spawn(POINT, UP, 'metal', 11, 26, 0);
    expect(pool.capacity).toBe(192);
    expect(pool.records.length).toBe(192);
    expect(pool.count).toBe(192);
    expect(pool.liveCount).toBe(192);
    expect(pool.spawned).toBe(1192);
    expect(pool.cursor).toBe(1000 % 192);
    // Every record is still a valid, finite template for an instance matrix.
    for (const rec of pool.records) {
      expect(Number.isFinite(rec.px + rec.py + rec.pz)).toBe(true);
      expect(Number.isFinite(rec.tx + rec.ty + rec.tz)).toBe(true);
    }
  });

  it('maps every surface material to a valid atlas tile', () => {
    const all: SurfaceMaterial[] = ['sandstone', 'concrete', 'wood', 'metal', 'sand', 'glass', 'flesh', 'water'];
    for (const material of all) {
      const tile = materialDecalTile(material);
      expect(tile).toBeGreaterThanOrEqual(-1);
      expect(tile).toBeLessThan(DECAL_ATLAS_COLS);
    }
    expect(materialDecalTile('concrete')).toBe(DECAL_TILE_CONCRETE);
    expect(materialDecalTile('sandstone')).toBe(DECAL_TILE_CONCRETE);
    expect(materialDecalTile('metal')).toBe(DECAL_TILE_METAL);
    expect(materialDecalTile('wood')).toBe(DECAL_TILE_WOOD);
    expect(materialDecalTile('sand')).toBe(DECAL_TILE_SAND);
    expect(materialDecalTile('glass')).toBe(DECAL_TILE_GLASS);
    // Flesh bleeds and water splashes: no decal tile, particles instead.
    expect(materialDecalTile('flesh')).toBe(-1);
    expect(materialDecalTile('water')).toBe(-1);
  });

  it('stores the tile of the material and skips decals for flesh/water', () => {
    const pool = new DecalPool();
    expect(pool.spawn(POINT, UP, 'wood', 0, 26, 0)?.tile).toBe(DECAL_TILE_WOOD);
    expect(pool.spawn(POINT, UP, 'glass', 0, 26, 0)?.tile).toBe(DECAL_TILE_GLASS);
    expect(pool.spawn(POINT, UP, 'flesh', 0, 26, 0)).toBeNull();
    expect(pool.spawn(POINT, UP, 'water', 0, 26, 0)).toBeNull();
    // Zero/invalid size falls back to the tile's authored quad size.
    expect(pool.spawn(POINT, UP, 'wood', 0, 26, 0)?.size).toBe(DECAL_QUAD_SIZE[DECAL_TILE_WOOD]);
    expect(pool.spawnTile(POINT, UP, DECAL_TILE_SCORCH, 0, 45, 0).size).toBe(DECAL_QUAD_SIZE[DECAL_TILE_SCORCH]);
  });

  it('lays the atlas tiles out inside [0,1] without overlapping', () => {
    const out: number[] = [];
    let previousEnd = -1;
    for (let tile = 0; tile < DECAL_ATLAS_COLS; tile++) {
      decalTileUvRect(tile, out);
      const [u0, v0, du, dv] = out;
      expect(u0).toBeCloseTo(tile / DECAL_ATLAS_COLS, 9);
      expect(u0).toBeGreaterThanOrEqual(0);
      expect(u0 + du).toBeLessThanOrEqual(1 + 1e-9);
      expect(u0).toBeGreaterThanOrEqual(previousEnd - 1e-9);
      expect(du).toBeCloseTo(1 / DECAL_ATLAS_COLS, 9);
      expect(v0).toBe(0);
      expect(dv).toBe(1);
      previousEnd = u0 + du;
    }
    expect(previousEnd).toBeCloseTo(1, 9);
    // Out-of-range tiles clamp instead of producing a bogus rect.
    decalTileUvRect(-5, out);
    expect(out[0]).toBeCloseTo(0, 9);
    decalTileUvRect(99, out);
    expect(out[0]).toBeCloseTo((DECAL_ATLAS_COLS - 1) / DECAL_ATLAS_COLS, 9);
  });
});

// ---------------------------------------------------------------------------
// Tracers / casings / particles: ring buffers
// ---------------------------------------------------------------------------

describe('tracer ring buffer', () => {
  it('wraps after PERF.tracers without growing', () => {
    const pool = new TracerPool();
    expect(PERF.tracers).toBe(24);
    expect(pool.capacity).toBe(24);
    for (let i = 0; i < 24; i++) pool.spawn(POINT, { x: 0, y: 0, z: -1 }, { x: 1, y: 0, z: 0 }, UP, 100, 2, TRACER_LIFE, 0);
    expect(pool.count).toBe(24);
    expect(pool.liveCount).toBe(24);
    expect(pool.cursor).toBe(0);

    for (let i = 0; i < 30; i++) pool.spawn(POINT, { x: 0, y: 0, z: -1 }, { x: 1, y: 0, z: 0 }, UP, 100, 2, TRACER_LIFE, 0);
    expect(pool.capacity).toBe(24);
    expect(pool.records.length).toBe(24);
    expect(pool.count).toBe(24);
    expect(pool.spawned).toBe(54);
    expect(pool.cursor).toBe(30 % 24);
  });
});

describe('particle ring buffer', () => {
  it('saturates at capacity and reports overwrites instead of growing', () => {
    const pool = new ParticlePool(8);
    const spawn = createParticleSpawn();
    spawn.life = 5;
    for (let i = 0; i < 8; i++) pool.spawn(spawn);
    expect(pool.count).toBe(8);
    expect(pool.overflows).toBe(0);
    for (let i = 0; i < 8; i++) pool.spawn(spawn);
    expect(pool.capacity).toBe(8);
    expect(pool.records.length).toBe(8);
    expect(pool.count).toBe(8);
    expect(pool.liveCount).toBe(8);
    expect(pool.overflows).toBe(8);
    expect(pool.cursor).toBe(0);
  });
});

describe('casings', () => {
  it('wraps after PERF.casings and settles on the ground plane', () => {
    const pool = new CasingPool();
    expect(PERF.casings).toBe(48);
    expect(pool.capacity).toBe(48);
    const origin: Vec3 = { x: 0, y: 40, z: 0 };
    const velocity: Vec3 = { x: 60, y: 100, z: 0 };
    const axis: Vec3 = { x: 0, y: 0, z: 1 };
    for (let i = 0; i < 60; i++) pool.spawn(origin, velocity, axis, 12, 4, 2.5);
    expect(pool.capacity).toBe(48);
    expect(pool.records.length).toBe(48);
    expect(pool.count).toBe(48);
    expect(pool.spawned).toBe(60);

    // Long life so the case can finish bouncing *and* finish rolling: the
    // `rested` flag is what stops the renderer writing its matrix every frame.
    const rec = pool.spawn(origin, velocity, axis, 12, 4, 300);
    let steps = 0;
    while (stepCasing(rec, 1 / 128) && !rec.rested && steps < 10000) steps++;
    expect(rec.active).toBe(true);
    expect(rec.settled).toBe(true);
    expect(rec.rested).toBe(true);
    expect(rec.vy).toBe(0);
    expect(rec.py).toBeCloseTo(rec.restY, 6);
    expect(rec.py).toBeGreaterThanOrEqual(rec.restY - 0.001);
    expect(Number.isFinite(rec.px + rec.py + rec.pz)).toBe(true);
    // Fully at rest: a further step must not move it any more.
    const restX = rec.px;
    const restZ = rec.pz;
    stepCasing(rec, 1 / 128);
    expect(rec.px).toBe(restX);
    expect(rec.pz).toBe(restZ);
  });

  it('never produces NaN for a huge or zero delta', () => {
    const pool = new CasingPool();
    const rec = pool.spawn(POINT, { x: 10, y: 10, z: 0 }, UP, 5, -5, 2.5);
    stepCasing(rec, 0);
    stepCasing(rec, 1000);
    expect(Number.isFinite(rec.px + rec.py + rec.pz)).toBe(true);
    expect(Number.isFinite(rec.vx + rec.vy + rec.vz)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Particle integration: pure stepper
// ---------------------------------------------------------------------------

describe('particle integration', () => {
  it('reaches the analytic apex height for a known initial velocity', () => {
    const p = createParticle();
    resetParticle(p);
    p.py = 0;
    p.vy = 300;
    p.gravity = -800;
    p.drag = 0;
    p.plane = false;
    p.life = 10;

    // Exact constant-acceleration integration: one step of v0/|g| seconds must
    // land on v0^2/(2|g|) with the vertical velocity at zero.
    const apexTime = 300 / 800;
    const expectedApex = (300 * 300) / (2 * 800);
    expect(stepParticle(p, apexTime)).toBe(true);
    expect(p.py).toBeCloseTo(expectedApex, 6);
    expect(p.vy).toBeCloseTo(0, 6);
    expect(p.age).toBeCloseTo(apexTime, 9);
  });

  it('integrates gravity over many small steps without gaining energy', () => {
    const p = createParticle();
    resetParticle(p);
    p.py = 0;
    p.vy = 300;
    p.gravity = -800;
    p.life = 10;
    const dt = 1 / 128;
    let t = 0;
    while (t < 0.375 - dt / 2) {
      stepParticle(p, dt);
      t += dt;
    }
    const analytic = 300 * t - 0.5 * 800 * t * t;
    expect(p.py).toBeCloseTo(analytic, 4);
  });

  it('deactivates at the end of its lifetime and reports progress in [0,1]', () => {
    const p = createParticle();
    resetParticle(p);
    p.life = 0.1;
    p.vy = 40;
    p.py = 5;
    p.gravity = -800;
    let steps = 0;
    while (stepParticle(p, 0.03) && steps < 100) steps++;
    expect(p.active).toBe(false);
    expect(p.age).toBeGreaterThanOrEqual(p.life);
    expect(particleT(p)).toBe(1);
    expect(steps).toBeLessThan(10);
  });

  it('treats dt = 0 and dt = NaN as no-ops and clamps long frames', () => {
    const p = createParticle();
    resetParticle(p);
    p.vy = 100;
    p.gravity = -800;
    p.py = 10;
    expect(stepParticle(p, 0)).toBe(true);
    expect(p.py).toBe(10);
    expect(p.vy).toBe(100);
    expect(stepParticle(p, Number.NaN)).toBe(true);
    expect(p.py).toBe(10);

    expect(clampDt(0)).toBe(0);
    expect(clampDt(-1)).toBe(0);
    expect(clampDt(Number.NaN)).toBe(0);
    expect(clampDt(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampDt(0.016)).toBeCloseTo(0.016, 9);
    expect(clampDt(4)).toBe(0.5);
  });

  it('bounces a spark once off the surface plane and then removes it', () => {
    const p = createParticle();
    resetParticle(p);
    p.py = 2;
    p.vy = -100;
    p.gravity = -800;
    p.plane = true;
    p.pnx = 0; p.pny = 1; p.pnz = 0; p.pd = 0;
    p.restitution = 0.5;
    p.friction = 0.5;
    p.maxBounces = 1;
    p.life = 10;
    stepParticle(p, 0.05);
    expect(p.bounces).toBe(1);
    expect(p.active).toBe(true);
    // Reflections flip the normal component and shrink it by restitution.
    expect(p.vy).toBeGreaterThan(0);
    expect(p.vy).toBeLessThan(100);
    expect(Number.isFinite(p.px + p.py + p.pz)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Orientation math
// ---------------------------------------------------------------------------

describe('decal basis', () => {
  const normals: Array<[string, Vec3]> = [
    ['up', { x: 0, y: 1, z: 0 }],
    ['down', { x: 0, y: -1, z: 0 }],
    ['+x', { x: 1, y: 0, z: 0 }],
    ['-x', { x: -1, y: 0, z: 0 }],
    ['+z', { x: 0, y: 0, z: 1 }],
    ['-z', { x: 0, y: 0, z: -1 }],
    ['diagonal', { x: 0.3, y: -0.7, z: 0.5 }],
    ['tiny', { x: 1e-12, y: 1e-12, z: 1e-12 }],
    ['zero', { x: 0, y: 0, z: 0 }],
    ['nan', { x: Number.NaN, y: 0, z: 0 }],
  ];

  it('produces an orthonormal, non-NaN basis for every input', () => {
    for (const [label, normal] of normals) {
      const basis = buildDecalBasis(normal);
      expect(Number.isFinite(basis.n.x + basis.n.y + basis.n.z), label).toBe(true);
      expect(Number.isFinite(basis.t.x + basis.t.y + basis.t.z), label).toBe(true);
      expect(Number.isFinite(basis.b.x + basis.b.y + basis.b.z), label).toBe(true);
      expect(vecLength(basis.n), label).toBeCloseTo(1, 6);
      expect(vecLength(basis.t), label).toBeCloseTo(1, 6);
      expect(vecLength(basis.b), label).toBeCloseTo(1, 6);
      expect(dot(basis.t, basis.b), label).toBeCloseTo(0, 6);
      expect(dot(basis.t, basis.n), label).toBeCloseTo(0, 6);
      expect(dot(basis.b, basis.n), label).toBeCloseTo(0, 6);
      // Right-handed: t x b = n (the quad winding must not flip).
      const cx = basis.t.y * basis.b.z - basis.t.z * basis.b.y;
      const cy = basis.t.z * basis.b.x - basis.t.x * basis.b.z;
      const cz = basis.t.x * basis.b.y - basis.t.y * basis.b.x;
      expect(cx * basis.n.x + cy * basis.n.y + cz * basis.n.z, label).toBeCloseTo(1, 6);
    }
  });

  it('matches the given normal, and falls back to world up for a zero vector', () => {
    const b = buildDecalBasis({ x: 0, y: -1, z: 0 });
    expect(b.n.x).toBeCloseTo(0, 9);
    expect(b.n.y).toBeCloseTo(-1, 9);
    expect(b.n.z).toBeCloseTo(0, 9);

    const zero = buildDecalBasis(ZERO);
    expect(zero.n.x).toBeCloseTo(0, 9);
    expect(zero.n.y).toBeCloseTo(1, 9);
    expect(zero.n.z).toBeCloseTo(0, 9);
  });

  it('agrees with three.js Matrix4 on the same normal', () => {
    // Guards against a transposed or left-handed basis: build the quad the way
    // three would and compare the resulting corner positions.
    const normal = new Vector3(0.2, 0.9, -0.35).normalize();
    const basis = buildDecalBasis({ x: normal.x, y: normal.y, z: normal.z });
    const m = new Float32Array(16);
    writeQuadMatrix(
      m,
      basis.t.x, basis.t.y, basis.t.z,
      basis.b.x, basis.b.y, basis.b.z,
      basis.n.x, basis.n.y, basis.n.z,
      10, 20, 30,
    );
    const m4 = new Matrix4().fromArray(Array.from(m));
    const corner = new Vector3(0.5, 0.5, 0).applyMatrix4(m4);
    const expected = new Vector3(10, 20, 30)
      .addScaledVector(new Vector3(basis.t.x, basis.t.y, basis.t.z), 0.5)
      .addScaledVector(new Vector3(basis.b.x, basis.b.y, basis.b.z), 0.5);
    expect(corner.x).toBeCloseTo(expected.x, 6);
    expect(corner.y).toBeCloseTo(expected.y, 6);
    expect(corner.z).toBeCloseTo(expected.z, 6);
  });

  it('writes a camera basis and a hidden matrix that cannot be degenerate', () => {
    const cam = createCameraBasis();
    expect(vecLength({ x: cam.rx, y: cam.ry, z: cam.rz })).toBeCloseTo(1, 9);
    expect(vecLength({ x: cam.ux, y: cam.uy, z: cam.uz })).toBeCloseTo(1, 9);
    expect(vecLength({ x: cam.fx, y: cam.fy, z: cam.fz })).toBeCloseTo(1, 9);

    const m = new Float32Array(16);
    writeHiddenMatrix(m);
    // Hidden = zero scale (no degenerate NaN inverse) pushed below the world.
    expect(m[0]).toBe(0);
    expect(m[5]).toBe(0);
    expect(m[10]).toBe(0);
    expect(m[15]).toBe(1);
    expect(m[13]).toBeLessThan(-1000);
    expect(m.every((v) => Number.isFinite(v))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Impact recipes: allocation-free, no crash on degenerate input
// ---------------------------------------------------------------------------

describe('impact recipes', () => {
  it('spawns a decal plus particles for a normal hit', () => {
    const ctx = makeCtx();
    spawnImpact(ctx, { x: 1, y: 2, z: 3 }, UP, 'concrete');
    expect(ctx.decals.liveCount).toBe(1);
    expect(ctx.sparks.liveCount).toBeGreaterThan(0);
    expect(ctx.soft.liveCount).toBeGreaterThan(0);
  });

  it('does not throw or emit NaN for a zero normal, and respects dustOnly', () => {
    const ctx = makeCtx();
    expect(() => spawnImpact(ctx, POINT, ZERO, 'metal')).not.toThrow();
    expect(() => spawnImpact(ctx, POINT, ZERO, 'sand', true)).not.toThrow();
    expect(() => spawnImpact(ctx, { x: Number.NaN, y: 0, z: 0 }, UP, 'concrete')).not.toThrow();
    expect(ctx.decals.liveCount).toBe(2);
    for (const p of ctx.sparks.records) {
      if (!p.active) continue;
      expect(Number.isFinite(p.px + p.py + p.pz + p.vx + p.vy + p.vz)).toBe(true);
    }
    // dustOnly suppresses the spark shower entirely.
    const dusted = makeCtx();
    spawnImpact(dusted, POINT, UP, 'metal', true);
    expect(dusted.sparks.liveCount).toBe(0);
  });

  it('spawns blood instead of a decal on flesh, sized by hit group', () => {
    const head = makeCtx();
    const leg = makeCtx();
    spawnBloodPuff(head, POINT, UP, 'head');
    spawnBloodPuff(leg, POINT, UP, 'leg');
    expect(head.decals.liveCount).toBe(0);
    expect(head.soft.liveCount).toBeGreaterThan(leg.soft.liveCount);
    expect(() => spawnBloodPuff(head, POINT, ZERO, 'chest', 3)).not.toThrow();
  });

  it('spawns landing dust for a speed value, including zero', () => {
    const ctx = makeCtx();
    expect(() => spawnLandDust(ctx, POINT, 250)).not.toThrow();
    const fast = ctx.soft.liveCount;
    expect(fast).toBeGreaterThan(0);
    expect(() => spawnLandDust(ctx, POINT, 0)).not.toThrow();
    expect(ctx.smoke.liveCount).toBeGreaterThan(0);
  });

  it('keeps every particle inside the pool after thousands of shots', () => {
    const ctx = makeCtx();
    const decals = new DecalPool();
    const sparks = new ParticlePool(64);
    const soft = new ParticlePool(64);
    const smoke = new ParticlePool(16);
    const rng = new Rng(0xbeef);
    const volume = { decals, sparks, soft, smoke, rng };
    const materials: SurfaceMaterial[] = ['concrete', 'metal', 'wood', 'sand', 'glass', 'sandstone', 'flesh', 'water'];
    for (let i = 0; i < 3000; i++) {
      const material = materials[i % materials.length];
      spawnImpact(volume, { x: i, y: 0, z: -i }, UP, material, i % 5 === 0);
      spawnBloodPuff(volume, { x: i, y: 1, z: 0 }, UP, i % 2 ? 'head' : 'chest');
    }
    expect(decals.records.length).toBe(PERF.decals);
    expect(decals.liveCount).toBeLessThanOrEqual(PERF.decals);
    expect(sparks.records.length).toBe(64);
    expect(sparks.liveCount).toBeLessThanOrEqual(64);
    expect(soft.liveCount).toBeLessThanOrEqual(64);
    expect(smoke.liveCount).toBeLessThanOrEqual(16);
  });
});

// ---------------------------------------------------------------------------
// Explosions
// ---------------------------------------------------------------------------

describe('explosions', () => {
  it('wraps after EXPLOSION_SLOTS and leaves a scorch decal', () => {
    const decals = new DecalPool();
    const smoke = new ParticlePool(16);
    const soft = new ParticlePool(16);
    const explosions = new ExplosionPool();
    const rng = new Rng(7);
    const ctx = { explosions, decals, smoke, soft, rng };
    for (let i = 0; i < 10; i++) spawnExplosionVisual(ctx, { x: i, y: 0, z: 0 }, 180, 'he', 0);
    expect(EXPLOSION_SLOTS).toBe(6);
    expect(explosions.capacity).toBe(6);
    expect(explosions.records.length).toBe(6);
    expect(explosions.count).toBe(6);
    expect(explosions.spawned).toBe(10);
    expect(explosions.cursor).toBe(4);
    expect(decals.liveCount).toBe(10); // pooled separately, wraps at PERF.decals
  });

  it('ages blasts out and deactivates them', () => {
    const explosions = new ExplosionPool();
    const rec = explosions.spawn({ x: 0, y: 0, z: 0 }, 180, explosionProfileFor('he'), 0);
    expect(explosions.liveCount).toBe(1);
    explosions.update(0);
    expect(explosions.liveCount).toBe(1);
    explosions.update(10);
    expect(explosions.liveCount).toBe(0);
    expect(rec.active).toBe(false);
    expect(rec.dirty).toBe(true);
  });

  it('gives flash and smoke grenades distinct looks and no scorch', () => {
    expect(explosionProfileFor('flash').peak).toBeGreaterThan(explosionProfileFor('he').peak);
    expect(explosionProfileFor('smoke').scorch).toBe(false);
    expect(explosionProfileFor('smoke').smoke).toBeGreaterThan(explosionProfileFor('he').smoke);
    expect(explosionProfileFor('anything-else')).toBe(explosionProfileFor('he'));

    const decals = new DecalPool();
    const ctx = {
      explosions: new ExplosionPool(),
      decals,
      smoke: new ParticlePool(16),
      soft: new ParticlePool(16),
      rng: new Rng(9),
    };
    spawnExplosionVisual(ctx, POINT, 200, 'smoke', 0);
    expect(decals.liveCount).toBe(0);
    spawnExplosionVisual(ctx, POINT, 200, 'he', 0);
    expect(decals.liveCount).toBe(1);
  });

  it('clamps a bogus radius and NaN position instead of propagating them', () => {
    const explosions = new ExplosionPool();
    const rec = explosions.spawn(
      { x: Number.NaN, y: 3, z: 0 },
      Number.NaN,
      explosionProfileFor('he'),
      Number.NaN,
    );
    expect(Number.isFinite(rec.px + rec.py + rec.pz)).toBe(true);
    expect(Number.isFinite(rec.radius)).toBe(true);
    expect(rec.radius).toBeGreaterThan(0);
    expect(Number.isFinite(rec.groundY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Misc math used by the layers above
// ---------------------------------------------------------------------------

describe('misc math', () => {
  it('keeps safeDir and randomConeDir unit-length and inside the cone', () => {
    const out: Vec3 = { x: 0, y: 0, z: 0 };
    safeDir(out, ZERO);
    expect(vecLength(out)).toBeCloseTo(1, 9);
    expect(out.y).toBe(1);

    const rng = new Rng(3);
    // A zero direction falls back to the world-up axis instead of collapsing the
    // sample to a near-zero vector.
    for (let i = 0; i < 50; i++) {
      randomConeDir(rng, out, ZERO, 0.5);
      expect(vecLength(out)).toBeCloseTo(1, 9);
      expect(Number.isFinite(out.x + out.y + out.z)).toBe(true);
      expect(out.y).toBeGreaterThan(Math.cos(0.5) - 1e-9);
    }
    const axis: Vec3 = { x: 0, y: 1, z: 0 };
    let minDot = 1;
    for (let i = 0; i < 200; i++) {
      randomConeDir(rng, out, axis, 1.2);
      expect(vecLength(out)).toBeCloseTo(1, 9);
      minDot = Math.min(minDot, dot(out, axis));
    }
    // Every sample must respect the cone half-angle...
    expect(minDot).toBeGreaterThanOrEqual(Math.cos(1.2) - 1e-9);
    // ...and at least one must be well inside it (uniform over the cap, not the rim).
    expect(minDot).toBeLessThan(Math.cos(0.3));
    // Degenerate spread never produces NaN.
    randomConeDir(rng, out, axis, Number.NaN);
    expect(Number.isFinite(out.x + out.y + out.z)).toBe(true);
    expect(vecLength(out)).toBeCloseTo(1, 9);
  });

  it('builds a plane through a point with a normalized normal', () => {
    const plane = createPlane();
    planeFromPointNormal(plane, { x: 0, y: 4, z: 0 }, { x: 0, y: 9, z: 0 });
    expect(plane.ny).toBeCloseTo(1, 9);
    expect(plane.d).toBeCloseTo(4, 9);
    planeFromPointNormal(plane, POINT, ZERO);
    expect(plane.ny).toBeCloseTo(1, 9);
    expect(plane.d).toBeCloseTo(0, 9);
  });

  it('maps a local quad uv into the first atlas tile', () => {
    // The shader computes vMapUv = rect.xy + uv * rect.zw, so a quad centre must
    // land in the middle of tile 0 and inside [0,1] in both axes.
    const rect: number[] = [];
    decalTileUvRect(0, rect);
    const uv = new Vector3(0.5, 0.5, 0);
    uv.multiply(new Vector3(rect[2], rect[3], 1)).add(new Vector3(rect[0], rect[1], 0));
    expect(uv.x).toBeCloseTo(1 / 12, 9);
    expect(uv.y).toBeCloseTo(0.5, 9);

    decalTileUvRect(DECAL_TILE_SCORCH, rect);
    const edge = new Vector3(1, 1, 0);
    edge.multiply(new Vector3(rect[2], rect[3], 1)).add(new Vector3(rect[0], rect[1], 0));
    expect(edge.x).toBeCloseTo(1, 9);
    expect(edge.y).toBeCloseTo(1, 9);
  });
});
