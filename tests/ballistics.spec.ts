// =============================================================================
// tests/ballistics.spec.ts — the CS damage model, pinned.
//
// These tests are the contract for the numbers players feel: how many AK rounds
// a kevlar chest survives, that a wood plank stops a bullet while a window pane
// does not, that a shotgun pellet cone is round rather than square. Every random
// path uses a seeded Rng so a failure is reproducible.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type {
  ActorState,
  Brush,
  GameEventMap,
  HitGroup,
  MapData,
  SurfaceMaterial,
  Vec3,
} from '../src/core/types';
import { COMBAT, MOVE, PLAYER, UNITS_PER_METER } from '../src/core/config';
import { EventBus } from '../src/core/events';
import { Rng } from '../src/core/rng';
import { World } from '../src/world/world';
import { buildActorHitbox } from '../src/combat/hitbox';
import { AK47, KNIFE, NOVA } from '../src/combat/weaponDefs';
import { CombatSystem, type CombatActorRef } from '../src/combat/CombatSystem';
import {
  MAX_INACCURACY,
  applyDamage,
  computeInaccuracy,
  damageAtDistance,
  fallDamage,
  fireBullet,
  fireShot,
  spreadDirection,
  whizzBy,
  type BulletParams,
  type SingleBulletResult,
  type SpreadInput,
} from '../src/combat/ballistics';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FLOOR_BRUSH: Brush = {
  id: 0,
  pos: { x: 0, y: -64, z: 0 },
  size: { x: 4000, y: 128, z: 4000 },
  yaw: 0,
  material: 'sandstone',
};

function brick(id: number, material: SurfaceMaterial, z: number, thickness: number): Brush {
  return {
    id,
    pos: { x: 0, y: 64, z },
    size: { x: 1024, y: 1024, z: thickness },
    yaw: 0,
    material,
  };
}

/**
 * A tiny synthetic world: a huge sand floor plus the supplied wall brushes.
 * Bounds must contain every brush or the uniform grid will not bucket it.
 */
function makeWorld(walls: Brush[] = []): World {
  const map: MapData = {
    name: 'ballistics-fixture',
    bounds: { min: { x: -2048, y: -512, z: -2048 }, max: { x: 2048, y: 1024, z: 2048 } },
    brushes: [FLOOR_BRUSH, ...walls],
    spawns: [],
    nav: [],
    sites: [],
    callouts: {},
    radar: { originX: 0, originZ: 0, scale: 1 },
    buyZones: [],
  };
  return new World(map);
}

function actor(over: Partial<ActorState> = {}): ActorState {
  return {
    id: 7,
    name: 'Target',
    team: 'CT',
    isBot: true,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    onGround: true,
    crouching: false,
    duckAmount: 0,
    health: 100,
    armor: 0,
    helmet: false,
    alive: true,
    hasBomb: false,
    hasDefuseKit: false,
    speedFactor: 1,
    ...over,
  };
}

function spread(over: Partial<SpreadInput> = {}): SpreadInput {
  return {
    weapon: AK47,
    horizontalSpeed: 0,
    duckAmount: 0,
    onGround: true,
    shotIndex: 0,
    ...over,
  };
}

/** A weapon whose cone is exactly zero, so geometry tests are not perturbed. */
const PERFECT_AK47 = {
  ...AK47,
  baseInaccuracy: 0,
  moveInaccuracy: 0,
  airInaccuracy: 0,
  crouchInaccuracy: 0,
  // The recoil pattern contributes its own per-shot inaccuracy on top of those
  // fields, so zeroing the weapon alone still leaves a 0.2 deg first-shot cone
  // (and a 0.219-unit lateral drift over 500 units — enough to break a geometry
  // assertion). Zero the table too, or this fixture lies about its own name.
  pattern: { punch: AK47.pattern.punch, inaccuracy: [0] },
};

function bulletParams(over: Partial<BulletParams> = {}): BulletParams {
  return {
    shooterId: 1,
    team: 'T',
    origin: { x: 0, y: 64, z: 0 },
    dir: { x: 0, y: 0, z: -1 },
    weapon: AK47,
    // Zero cone: these tests are about damage and geometry, not spread.
    spread: spread({ weapon: PERFECT_AK47 }),
    actors: [],
    rng: new Rng(0xc0ffee),
    maxRange: 4096,
    ...over,
  };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// ---------------------------------------------------------------------------
// damageAtDistance
// ---------------------------------------------------------------------------

describe('damageAtDistance', () => {
  it('matches the AK-47 table (36 damage, 4500 -> 9000, 0.72)', () => {
    expect(AK47.damage).toBe(36);
    expect(AK47.falloffStart).toBe(4500);
    expect(AK47.falloffEnd).toBe(9000);
    expect(AK47.falloff).toBe(0.72);

    expect(damageAtDistance(AK47, 0)).toBeCloseTo(36, 9);
    expect(damageAtDistance(AK47, AK47.falloffStart)).toBeCloseTo(36, 9);
    // Exactly halfway: 36 -> 25.92, so 30.96.
    expect(damageAtDistance(AK47, 6750)).toBeCloseTo(30.96, 9);
    expect(damageAtDistance(AK47, AK47.falloffEnd)).toBeCloseTo(36 * 0.72, 9);
    expect(damageAtDistance(AK47, 9001)).toBeCloseTo(36 * 0.72, 9);
    expect(damageAtDistance(AK47, 1e6)).toBeCloseTo(36 * 0.72, 9);
  });

  it('is monotonic non-increasing in distance', () => {
    let prev = Infinity;
    for (let d = 0; d <= 12000; d += 250) {
      const v = damageAtDistance(AK47, d);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });

  it('stays flat below falloffStart', () => {
    for (const d of [0, 1, 500, 2000, 4499]) {
      expect(damageAtDistance(AK47, d)).toBe(36);
    }
  });

  it('collapses to the floor for a weapon with an instant falloff', () => {
    expect(damageAtDistance(NOVA, 0)).toBe(26);
    expect(damageAtDistance(NOVA, NOVA.falloffEnd)).toBeCloseTo(26 * 0.35, 9);
    expect(damageAtDistance(NOVA, 5000)).toBeCloseTo(26 * 0.35, 9);
  });

  it('has the documented unit scale', () => {
    expect(UNITS_PER_METER).toBeGreaterThan(50);
    expect(UNITS_PER_METER).toBeLessThan(55);
  });
});

// ---------------------------------------------------------------------------
// applyDamage — armour and hit groups
// ---------------------------------------------------------------------------

describe('applyDamage', () => {
  it('applies full damage with no armour', () => {
    const r = applyDamage({
      rawDamage: 36,
      armorPenetration: 0.775,
      armor: 0,
      helmet: false,
      hitGroup: 'chest',
      currentHealth: 100,
    });
    expect(r.health).toBeCloseTo(36, 9);
    expect(r.armor).toBe(0);
    expect(r.helmetBlocked).toBe(false);
    expect(r.killed).toBe(false);
  });

  it('applies the armour formula to a chest hit', () => {
    // health = 36 * 0.775 = 27.9; armourLoss = 0.5 * 36 * (1 - 0.775) = 4.05.
    const r = applyDamage({
      rawDamage: 36,
      armorPenetration: 0.775,
      armor: 100,
      helmet: false,
      hitGroup: 'chest',
      currentHealth: 100,
    });
    expect(r.health).toBeCloseTo(27.9, 9);
    expect(r.armor).toBeCloseTo(4.05, 9);
    expect(r.helmetBlocked).toBe(false);
    expect(r.killed).toBe(false);
  });

  it('multiplies the stomach by 1.25 before armour', () => {
    const r = applyDamage({
      rawDamage: 36,
      armorPenetration: 0.775,
      armor: 100,
      helmet: false,
      hitGroup: 'stomach',
      currentHealth: 100,
    });
    // 36 * 1.25 = 45 -> 34.875 health, 5.0625 armour.
    expect(r.health).toBeCloseTo(34.875, 9);
    expect(r.armor).toBeCloseTo(5.0625, 9);
  });

  it('gives a headshot WITHOUT a helmet full damage and no armour drain', () => {
    const r = applyDamage({
      rawDamage: 36,
      armorPenetration: 0.775,
      armor: 100,
      helmet: false,
      hitGroup: 'head',
      currentHealth: 100,
    });
    expect(r.health).toBeCloseTo(144, 9);
    expect(r.armor).toBe(0);
    expect(r.helmetBlocked).toBe(false);
    expect(r.killed).toBe(true);
  });

  it('gives a headshot WITH a helmet reduced damage and an armour drain', () => {
    const r = applyDamage({
      rawDamage: 36,
      armorPenetration: 0.775,
      armor: 100,
      helmet: true,
      hitGroup: 'head',
      currentHealth: 200,
    });
    expect(r.health).toBeCloseTo(144 * 0.775, 9);
    expect(r.armor).toBeCloseTo(0.5 * 144 * (1 - 0.775), 9);
    expect(r.helmetBlocked).toBe(true);
    expect(r.killed).toBe(false);
  });

  it('lets legs bypass armour completely', () => {
    const r = applyDamage({
      rawDamage: 36,
      armorPenetration: 0.775,
      armor: 100,
      helmet: true,
      hitGroup: 'leg',
      currentHealth: 100,
    });
    expect(r.health).toBeCloseTo(36 * 0.75, 9);
    expect(r.armor).toBe(0);
  });

  it('breaks armour mid-hit and applies the remainder raw', () => {
    // Chest: absorbed = 8.1 (fully absorbed); leg: 27 must come out of 20 armour.
    const chest = applyDamage({
      rawDamage: 36,
      armorPenetration: 0.775,
      armor: 20,
      helmet: false,
      hitGroup: 'chest',
      currentHealth: 100,
    });
    expect(chest.health).toBeCloseTo(27.9, 9);
    expect(chest.armor).toBeCloseTo(4.05, 9);

    const leg = applyDamage({
      rawDamage: 36,
      armorPenetration: 0.775,
      armor: 20,
      helmet: false,
      hitGroup: 'leg',
      currentHealth: 100,
    });
    // Legs ignore armour: full 27 damage, zero drain, armour untouched by us.
    expect(leg.health).toBeCloseTo(27, 9);
    expect(leg.armor).toBe(0);

    // A big torso hit that cannot be fully absorbed: absorbed = 27 * (1 - 0.9) = 2.7,
    // cost 1.35, so 2 armour is enough here. Use 1 armour to force the break.
    const broke = applyDamage({
      rawDamage: 30,
      armorPenetration: 0.1,
      armor: 1,
      helmet: false,
      hitGroup: 'chest',
      currentHealth: 100,
    });
    // absorbed = 27, full cost 13.5 > 1 -> health = 30 - 1/0.5 = 28, armour 1 consumed.
    expect(broke.armor).toBe(1);
    expect(broke.health).toBeCloseTo(28, 9);
  });

  it('reports a kill through armour when health runs out', () => {
    const r = applyDamage({
      rawDamage: 36,
      armorPenetration: 0.775,
      armor: 100,
      helmet: false,
      hitGroup: 'chest',
      currentHealth: 20,
    });
    expect(r.health).toBeCloseTo(27.9, 9);
    expect(r.killed).toBe(true);
  });

  it('honours a weapon hit-group override and drains nothing at 0 penetration', () => {
    const head = applyDamage({
      rawDamage: 50,
      armorPenetration: 1,
      armor: 100,
      helmet: false,
      hitGroup: 'head',
      hitGroupMul: { head: 2 },
      currentHealth: 100,
    });
    expect(head.health).toBeCloseTo(100, 9);
    expect(head.killed).toBe(true);

    const full = applyDamage({
      rawDamage: 40,
      armorPenetration: 1,
      armor: 100,
      helmet: false,
      hitGroup: 'chest',
      currentHealth: 100,
    });
    expect(full.health).toBeCloseTo(40, 9);
    expect(full.armor).toBe(0);
  });

  it('never returns negative values for hostile input', () => {
    const r = applyDamage({
      rawDamage: -100,
      armorPenetration: Number.NaN,
      armor: -5,
      helmet: true,
      hitGroup: 'head',
      currentHealth: Number.NaN,
    });
    expect(Number.isFinite(r.health)).toBe(true);
    expect(r.health).toBeGreaterThanOrEqual(0);
    expect(r.armor).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// fallDamage
// ---------------------------------------------------------------------------

describe('fallDamage', () => {
  it('is zero at or below the threshold', () => {
    expect(COMBAT.fallDamageThreshold).toBe(580);
    expect(fallDamage(0)).toBe(0);
    expect(fallDamage(300)).toBe(0);
    expect(fallDamage(COMBAT.fallDamageThreshold)).toBe(0);
  });

  it('scales linearly above the threshold', () => {
    expect(fallDamage(600)).toBeCloseTo(2, 9);
    expect(fallDamage(700)).toBeCloseTo(12, 9);
    expect(fallDamage(1000)).toBeCloseTo(42, 9);
  });

  it('is monotonic and finite for hostile input', () => {
    let prev = -1;
    for (let s = 0; s <= 3000; s += 50) {
      const v = fallDamage(s);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(fallDamage(Number.NaN)).toBe(0);
    expect(fallDamage(Number.NEGATIVE_INFINITY)).toBe(0);
    // Non-finite input is rejected rather than propagated into the HUD.
    expect(fallDamage(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeInaccuracy
// ---------------------------------------------------------------------------

describe('computeInaccuracy', () => {
  // The weapon tables in weaponDefs.ts are authored in DEGREES; the function's
  // contract is radians.
  const DEG = Math.PI / 180;

  it('is the weapon base plus the first-shot pattern term when standing still', () => {
    // The spray table widens the cone on EVERY shot, index 0 included: AK 0.42 deg
    // base + 0.2 deg first-shot pattern = 0.62 deg standing. (See the crouch and
    // NaN-speed tests below — they pin the same additive term.)
    expect(computeInaccuracy(spread())).toBeCloseTo(
      AK47.baseInaccuracy * DEG + (0.2 * Math.PI) / 180,
      9,
    );
    // Sanity-check the authored unit: 0.42 must read as a fraction of a degree,
    // not 0.42 radians (24 degrees) of standing cone.
    expect(AK47.baseInaccuracy * DEG).toBeLessThan(0.01);
    expect(computeInaccuracy(spread())).toBeLessThan(0.02);
  });

  it('grows monotonically with speed', () => {
    let prev = -1;
    for (const speed of [0, 25, 50, 100, 150, 200, 250]) {
      const v = computeInaccuracy(spread({ horizontalSpeed: speed }));
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });

  it('is far wider than the base at full ground speed', () => {
    // patternAt(AK47, 0).inaccuracy = 0.2 deg = 0.00349 rad.
    const moving = computeInaccuracy(spread({ horizontalSpeed: MOVE.maxSpeed }));
    const expected = (AK47.baseInaccuracy + AK47.moveInaccuracy) * DEG + (0.2 * Math.PI) / 180;
    expect(moving).toBeCloseTo(expected, 9);
    // 0.62 deg standing vs 10.22 deg running is a 16.5x counter-strafe gap; the
    // 0.2 deg first-shot pattern term dilutes it (see the standing test above). The
    // move penalty on its own is a 24x jump over the base cone, which is the number
    // that makes counter-strafing worth learning.
    expect(moving / computeInaccuracy(spread())).toBeGreaterThan(15);
    expect(AK47.moveInaccuracy / AK47.baseInaccuracy).toBeGreaterThan(20);
  });

  it('is dramatically worse airborne than grounded', () => {
    const grounded = computeInaccuracy(spread({ horizontalSpeed: MOVE.maxSpeed, onGround: true }));
    const airStanding = computeInaccuracy(spread({ onGround: false }));
    // The AK's airborne cone (34 deg) is past the sanity ceiling on its own, so the
    // clamped result is the ceiling; what matters is that it dwarfs the grounded one.
    expect(airStanding).toBe(MAX_INACCURACY);
    expect(AK47.airInaccuracy * DEG).toBeGreaterThan(MAX_INACCURACY);
    // 20 deg of ceiling against a 10.2 deg full-speed run is ~2x, and against a
    // 0.62 deg standing shot it is ~32x. NOTE: the 3x-of-a-full-speed-run form this
    // test used to assert (30.7 deg) is arithmetically impossible — the ceiling is
    // 20 deg (pinned below), so the ratio asserted here is the one it can deliver.
    expect(MAX_INACCURACY / ((AK47.baseInaccuracy + AK47.moveInaccuracy) * DEG + (0.2 * Math.PI) / 180)).toBeGreaterThan(1.9);
    expect(airStanding).toBeGreaterThan(grounded * 1.5);
    expect(airStanding).toBeGreaterThan(computeInaccuracy(spread()) * 25);

    // Airborne is never better than a fast run.
    const airFast = computeInaccuracy(spread({ onGround: false, horizontalSpeed: MOVE.maxSpeed }));
    expect(airFast).toBeGreaterThanOrEqual(grounded);
  });

  it('keeps a jump inside a sane cone for weapons whose air cone is sane', () => {
    // An M4A1-S-class weapon: 30 deg of air cone would also clamp, so use the
    // pre-clamp arithmetic on a weapon that stays under the ceiling.
    const sane = { ...AK47, airInaccuracy: 12 };
    const air = computeInaccuracy(spread({ weapon: sane, onGround: false }));
    expect(air).toBeCloseTo(12 * DEG + (0.2 * Math.PI) / 180, 9);
    expect(air).toBeLessThan(MAX_INACCURACY);
  });

  it('blends toward the crouch cone as duckAmount rises', () => {
    const standing = computeInaccuracy(spread({ duckAmount: 0 }));
    const crouched = computeInaccuracy(spread({ duckAmount: 1 }));
    const half = computeInaccuracy(spread({ duckAmount: 0.5 }));
    // In this weapon table crouchInaccuracy (0.5) exceeds baseInaccuracy (0.42),
    // so crouching is marginally WIDER while ducked; what matters is the lerp.
    expect(half).toBeCloseTo((standing + crouched) / 2, 9);
    expect(half).toBeGreaterThan(Math.min(standing, crouched));
    expect(half).toBeLessThan(Math.max(standing, crouched));
  });

  it('uses the crouch cone at duckAmount 1', () => {
    const c = computeInaccuracy(spread({ duckAmount: 1 }));
    expect(c).toBeCloseTo(AK47.crouchInaccuracy * DEG + (0.2 * Math.PI) / 180, 9);
  });

  it('adds the recoil pattern inaccuracy per shot index', () => {
    const first = computeInaccuracy(spread({ shotIndex: 0 }));
    const tenth = computeInaccuracy(spread({ shotIndex: 9 }));
    const beyond = computeInaccuracy(spread({ shotIndex: 9999 }));
    expect(tenth).toBeGreaterThan(first);
    expect(beyond).toBeGreaterThan(tenth);
    expect(beyond).toBeLessThanOrEqual(MAX_INACCURACY);
  });

  it('clamps absurd weapons and inputs to the sanity ceiling', () => {
    const wild = { ...AK47, moveInaccuracy: 1000 };
    expect(computeInaccuracy(spread({ weapon: wild, horizontalSpeed: 5000 }))).toBe(MAX_INACCURACY);
    expect(MAX_INACCURACY).toBeCloseTo(0.35, 9);
    // NaN speed is treated as zero speed, not propagated.
    expect(computeInaccuracy(spread({ horizontalSpeed: Number.NaN }))).toBeCloseTo(
      AK47.baseInaccuracy * DEG + (0.2 * Math.PI) / 180,
      9,
    );
    // Negative speed is ignored rather than shrinking the cone.
    expect(computeInaccuracy(spread({ horizontalSpeed: -500 }))).toBeCloseTo(
      AK47.baseInaccuracy * DEG + (0.2 * Math.PI) / 180,
      9,
    );
  });

  it('never drops below the weapon base', () => {
    const noRecoil = { ...AK47, pattern: { punch: [{ x: 0, y: 0 }], inaccuracy: [0] } };
    expect(computeInaccuracy(spread({ weapon: noRecoil, duckAmount: 0 }))).toBeCloseTo(
      AK47.baseInaccuracy * DEG,
      9,
    );
  });
});

// ---------------------------------------------------------------------------
// spreadDirection
// ---------------------------------------------------------------------------

describe('spreadDirection', () => {
  it('returns the input direction exactly at zero inaccuracy', () => {
    const dir: Vec3 = { x: 0.3, y: -0.2, z: -0.9 };
    const out = spreadDirection(dir, 0, new Rng(1));
    expect(out.x).toBe(dir.x);
    expect(out.y).toBe(dir.y);
    expect(out.z).toBe(dir.z);
  });

  it('keeps every sample inside the cone with unit length', () => {
    const dir: Vec3 = { x: 0, y: 0, z: -1 };
    const cone = 0.05;
    const rng = new Rng(0x5eed);
    const cosLimit = Math.cos(cone) - 1e-6;

    for (let i = 0; i < 2000; i++) {
      const s = spreadDirection(dir, cone, rng);
      const len = Math.hypot(s.x, s.y, s.z);
      expect(len).toBeCloseTo(1, 6);
      const cos = (s.x * dir.x + s.y * dir.y + s.z * dir.z) / len;
      expect(cos).toBeGreaterThanOrEqual(cosLimit);
    }
  });

  it('is unbiased across all four quadrants', () => {
    const dir: Vec3 = { x: 0, y: 0, z: -1 };
    const cone = 0.2;
    const rng = new Rng(0xabcdef);
    let pp = 0;
    let pn = 0;
    let np = 0;
    let nn = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const s = spreadDirection(dir, cone, rng);
      if (s.x >= 0 && s.y >= 0) pp++;
      else if (s.x >= 0) pn++;
      else if (s.y >= 0) np++;
      else nn++;
    }
    for (const q of [pp, pn, np, nn]) {
      expect(q).toBeGreaterThan(N * 0.2);
      expect(q).toBeLessThan(N * 0.3);
    }
  });

  it('stays within the cone regardless of the aim direction', () => {
    const rng = new Rng(99);
    const dirs: Vec3[] = [
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0.577, y: 0.577, z: -0.577 },
    ];
    const cone = 0.1;
    for (const dir of dirs) {
      const n = Math.hypot(dir.x, dir.y, dir.z);
      const nx = dir.x / n;
      const ny = dir.y / n;
      const nz = dir.z / n;
      for (let i = 0; i < 500; i++) {
        const s = spreadDirection(dir, cone, rng);
        const len = Math.hypot(s.x, s.y, s.z);
        const cos = (s.x * nx + s.y * ny + s.z * nz) / len;
        expect(cos).toBeGreaterThanOrEqual(Math.cos(cone) - 1e-6);
      }
    }
  });

  it('is deterministic for a given seed', () => {
    const a = spreadDirection({ x: 0, y: 0, z: -1 }, 0.05, new Rng(7));
    const b = spreadDirection({ x: 0, y: 0, z: -1 }, 0.05, new Rng(7));
    expect(a).toEqual(b);
  });

  it('never produces NaN for hostile directions', () => {
    const s = spreadDirection({ x: 0, y: 0, z: 0 }, 0.05, new Rng(3));
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Number.isFinite(s.y)).toBe(true);
    expect(Number.isFinite(s.z)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fireBullet / fireShot — geometry, wallbangs, robustness
// ---------------------------------------------------------------------------

describe('fireBullet', () => {
  it('misses cleanly at max range when nothing is in the way', () => {
    const world = makeWorld();
    const r = fireBullet(world, bulletParams({ maxRange: 1000 }));
    expect(r.hit).toBe(false);
    expect(r.entityId).toBe(-1);
    expect(r.distance).toBeCloseTo(1000, 6);
    expect(r.point.z).toBeCloseTo(-1000, 3);
    expect(r.damage).toBeCloseTo(damageAtDistance(AK47, 1000), 9);
    expect(r.penetrationMul).toBe(1);
    expect(r.penetrated.length).toBe(0);
  });

  it('hits an actor and reports the raw hit group', () => {
    const world = makeWorld();
    const target = actor({ id: 7, pos: { x: 0, y: 0, z: -600 } });
    world.registerActors([buildActorHitbox(target)]);

    const r = fireBullet(
      world,
      bulletParams({
        origin: { x: 0, y: 66, z: 0 },
        actors: [buildActorHitbox(target)],
        maxRange: 4096,
      }),
    );
    expect(r.hit).toBe(true);
    expect(r.entityId).toBe(7);
    expect(r.hitGroup).toBe('head');
    expect(r.distance).toBeGreaterThan(590);
    expect(r.distance).toBeLessThan(602);
    expect(r.damage).toBeCloseTo(damageAtDistance(AK47, r.distance), 6);
    expect(r.penetrated.length).toBe(0);
  });

  it('reports a chest hit for the mid body', () => {
    const world = makeWorld();
    const target = actor({ id: 7, pos: { x: 0, y: 0, z: -600 } });
    world.registerActors([buildActorHitbox(target)]);
    const r = fireBullet(
      world,
      bulletParams({ origin: { x: 0, y: 55, z: 0 }, actors: [buildActorHitbox(target)] }),
    );
    expect(r.entityId).toBe(7);
    expect(r.hitGroup).toBe('chest');
  });

  it('stops dead on impenetrable concrete', () => {
    const world = makeWorld([brick(1, 'concrete', -100, 16)]);
    const r = fireBullet(world, bulletParams());
    expect(r.hit).toBe(true);
    expect(r.entityId).toBe(-1);
    expect(r.material).toBe('concrete');
    expect(r.penetrated.length).toBe(0);
    expect(r.penetrationMul).toBe(1);
    // Entry face of a 16-thick block centred at z=-100.
    expect(r.point.z).toBeCloseTo(-92, 4);
  });

  it('stops at sandstone, sand and water too', () => {
    for (const material of ['sandstone', 'sand', 'water'] as const) {
      const world = makeWorld([brick(1, material, -100, 8)]);
      const r = fireBullet(world, bulletParams());
      expect(r.penetrated.length).toBe(0);
      expect(r.point.z).toBeCloseTo(-96, 4);
    }
  });

  it('stops at a wood wall thicker than the penetration limit', () => {
    expect(COMBAT.penetrationMaxThickness).toBe(20);
    const world = makeWorld([brick(1, 'wood', -100, 32)]);
    const r = fireBullet(world, bulletParams());
    expect(r.material).toBe('wood');
    expect(r.penetrated.length).toBe(0);
    expect(r.penetrationMul).toBe(1);
    expect(r.point.z).toBeCloseTo(-84, 4);
  });

  it('passes through a thin glass pane and keeps going to a target behind it', () => {
    const world = makeWorld([brick(1, 'glass', -100, 8)]);
    const target = actor({ id: 7, pos: { x: 0, y: 0, z: -600 } });
    const targetBox = buildActorHitbox(target);
    world.registerActors([targetBox]);

    const r = fireBullet(
      world,
      bulletParams({ origin: { x: 0, y: 55, z: 0 }, actors: [targetBox] }),
    );

    // The pane is 8 thick, entered at z=-96 and exited at z=-104.
    expect(r.penetrated.length).toBe(1);
    expect(r.penetrated[0].material).toBe('glass');
    expect(r.penetrated[0].distance).toBeCloseTo(8, 4);
    expect(r.penetrated[0].entry.z).toBeCloseTo(-96, 4);
    expect(r.penetrated[0].exit.z).toBeCloseTo(-104, 4);
    expect(r.penetrationMul).toBeCloseTo(COMBAT.penetrationDamageMul, 9);

    // ... and then hits the target behind the pane.
    expect(r.entityId).toBe(7);
    expect(r.hitGroup).toBe('chest');
    expect(r.damage).toBeCloseTo(damageAtDistance(AK47, r.distance) * 0.6, 6);
    expect(r.damage).toBeLessThan(damageAtDistance(AK47, r.distance));
  });

  it('passes through thin metal as well', () => {
    const world = makeWorld([brick(1, 'metal', -100, 8)]);
    const r = fireBullet(world, bulletParams());
    expect(r.penetrated.length).toBe(1);
    expect(r.penetrated[0].material).toBe('metal');
    expect(r.hit).toBe(false);
    expect(r.penetrationMul).toBeCloseTo(0.6, 9);
  });

  it('caps penetration at 3 layers and never hangs on a stack of 5 walls', () => {
    const walls = [
      brick(1, 'glass', -100, 1),
      brick(2, 'glass', -106, 1),
      brick(3, 'glass', -112, 1),
      brick(4, 'glass', -118, 1),
      brick(5, 'glass', -124, 1),
      brick(6, 'concrete', -160, 4),
    ];
    const world = makeWorld(walls);
    const r = fireBullet(world, bulletParams());

    expect(r.penetrated.length).toBe(3);
    expect(r.penetrationMul).toBeCloseTo(Math.pow(COMBAT.penetrationDamageMul, 3), 9);
    expect(r.material).toBe('glass');
    // Reached the fourth wall (entry z=-117.5) but could not pass it.
    expect(r.entityId).toBe(-1);
    expect(r.point.z).toBeGreaterThan(-125);
    expect(r.point.z).toBeLessThan(-117);
  });

  it('scales damage with each layer on the way to a far target', () => {
    const walls = [brick(1, 'glass', -100, 8), brick(2, 'glass', -200, 8)];
    const world = makeWorld(walls);
    const target = actor({ id: 9, pos: { x: 0, y: 0, z: -600 } });
    const targetBox = buildActorHitbox(target);
    world.registerActors([targetBox]);
    const r = fireBullet(world, bulletParams({ origin: { x: 0, y: 55, z: 0 }, actors: [targetBox] }));
    expect(r.penetrated.length).toBe(2);
    expect(r.entityId).toBe(9);
    expect(r.penetrationMul).toBeCloseTo(0.36, 9);
    expect(r.damage).toBeCloseTo(damageAtDistance(AK47, r.distance) * 0.36, 6);
  });

  it('treats a zero-length direction as a miss at the origin instead of NaN', () => {
    const world = makeWorld();
    const r = fireBullet(world, bulletParams({ dir: { x: 0, y: 0, z: 0 } }));
    expect(r.hit).toBe(false);
    expect(r.distance).toBe(0);
    expect(Number.isFinite(r.point.x)).toBe(true);
    expect(Number.isFinite(r.point.y)).toBe(true);
    expect(Number.isFinite(r.point.z)).toBe(true);
    expect(r.point.x).toBeCloseTo(0, 9);
    expect(r.point.z).toBeCloseTo(0, 9);
  });

  it('treats a non-normalised direction as a unit direction', () => {
    const world = makeWorld();
    const r = fireBullet(world, bulletParams({ dir: { x: 0, y: 0, z: -500 }, maxRange: 100 }));
    // The bullet must not travel 500x100 units; it stops at maxRange along the unit dir.
    expect(r.distance).toBeCloseTo(100, 6);
    expect(r.point.z).toBeCloseTo(-100, 4);
  });

  it('misses immediately at maxRange 0', () => {
    const world = makeWorld([brick(1, 'concrete', -10, 4)]);
    const r = fireBullet(world, bulletParams({ maxRange: 0 }));
    expect(r.hit).toBe(false);
    expect(r.distance).toBe(0);
    expect(r.damage).toBe(0);
  });

  it('excludes the shooter from actor hits', () => {
    const world = makeWorld();
    const self = actor({ id: 1, pos: { x: 0, y: 0, z: -50 } });
    const other = actor({ id: 2, pos: { x: 0, y: 0, z: -400 } });
    world.registerActors([buildActorHitbox(self), buildActorHitbox(other)]);
    const r = fireBullet(
      world,
      bulletParams({
        shooterId: 1,
        origin: { x: 0, y: 55, z: 0 },
        actors: [buildActorHitbox(other)],
      }),
    );
    expect(r.entityId).toBe(2);
  });

  it('never throws for degenerate params', () => {
    const world = makeWorld();
    expect(() =>
      fireBullet(world, bulletParams({ maxRange: Number.NaN, spread: spread({ weapon: { ...AK47, baseInaccuracy: Number.NaN } }) })),
    ).not.toThrow();
    expect(() => fireBullet(world, bulletParams({ maxRange: -5 }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// fireShot
// ---------------------------------------------------------------------------

describe('fireShot', () => {
  it('fires one bullet for a rifle', () => {
    const world = makeWorld();
    const result = fireShot(world, bulletParams());
    expect(result.bullets.length).toBe(1);
    expect(result.victims.length).toBe(0);
  });

  it('fires one bullet per pellet for a shotgun, spread apart', () => {
    const world = makeWorld([brick(1, 'concrete', -500, 16)]);
    const result = fireShot(
      world,
      bulletParams({
        weapon: NOVA,
        // The Nova's first-shot pattern cone is only 0.2 deg, which is ~1.7 units
        // across at 500 units. Moving is what makes a shotgun pellet cone visible.
        spread: spread({ weapon: NOVA, horizontalSpeed: 200 }),
      }),
    );
    expect(NOVA.pellets).toBe(9);
    expect(result.bullets.length).toBe(9);
    for (const b of result.bullets) {
      expect(b.hit).toBe(true);
    }
    // The pellets must be spread out, not stacked on the same point.
    expect(new Set(result.bullets.map((b) => b.point.x.toFixed(2))).size).toBeGreaterThan(1);
    expect(new Set(result.bullets.map((b) => b.point.y.toFixed(2))).size).toBeGreaterThan(1);
    // ... and all of them must stay within the pellet cone of the aim direction
    // (which is -Z from the origin at y=64).
    const cone = computeInaccuracy(spread({ weapon: NOVA, horizontalSpeed: 200 }));
    for (const b of result.bullets) {
      const px = b.point.x;
      const py = b.point.y - 64;
      const pz = b.point.z;
      const len = Math.hypot(px, py, pz);
      const cos = -pz / len;
      expect(cos).toBeGreaterThanOrEqual(Math.cos(cone) - 1e-6);
    }
  });

  it('collects each victim separately with a seeded rng', () => {
    const world = makeWorld([brick(1, 'concrete', -900, 16)]);
    const a = actor({ id: 11, pos: { x: -120, y: 0, z: -300 } });
    const b = actor({ id: 12, pos: { x: 120, y: 0, z: -300 } });
    const boxes = [buildActorHitbox(a), buildActorHitbox(b)];
    world.registerActors(boxes);

    const result = fireShot(
      world,
      bulletParams({
        weapon: NOVA,
        dir: { x: 0, y: 0, z: -1 },
        spread: spread({ weapon: NOVA }),
        actors: boxes,
        rng: new Rng(0xfeed),
      }),
    );
    expect(result.bullets.length).toBe(9);
    // Whatever it hit, every bullet and victim must be internally consistent.
    for (const v of result.victims) {
      const hitBullet = result.bullets.find(
        (bu) => bu.entityId === v.entityId && Math.abs(bu.distance - distance(bu.point, { x: 0, y: 64, z: 0 })) < 1,
      );
      expect(hitBullet).toBeDefined();
      expect(v.damage).toBeCloseTo(hitBullet!.damage, 9);
      expect(v.killed).toBe(false);
    }
  });

  it('is reproducible for the same seed', () => {
    const world = makeWorld();
    const mk = () =>
      fireShot(world, bulletParams({ spread: spread({ horizontalSpeed: 150 }), rng: new Rng(1234) }));
    const a = mk();
    const b = mk();
    expect(a.bullets.map((x) => x.point)).toEqual(b.bullets.map((x) => x.point));
  });
});

// ---------------------------------------------------------------------------
// whizzBy
// ---------------------------------------------------------------------------

describe('whizzBy', () => {
  it('is quiet for a listener far from the bullet', () => {
    const world = makeWorld();
    const r = fireBullet(world, bulletParams({ origin: { x: 0, y: 64, z: 0 }, maxRange: 500 }));
    expect(whizzBy(r, { x: 2000, y: 64, z: 0 })).toBeNull();
  });

  it('fires for a listener stood beside the bullet path end point', () => {
    const world = makeWorld();
    const r = fireBullet(world, bulletParams({ origin: { x: 0, y: 64, z: 0 }, maxRange: 500 }));
    const s = whizzBy(r, { x: 20, y: 64, z: -500 });
    expect(s).not.toBeNull();
    expect(s!.kind).toBe('whizz');
    // The metric is distance to the end point; the sound is heard at the ear.
    expect(s!.distance).toBeCloseTo(20, 6);
    expect(s!.pos).toEqual({ x: 20, y: 64, z: -500 });
    expect(s!.distance).toBeGreaterThan(64 * 0.25);
  });

  it('uses the default 64-unit radius and allows an override', () => {
    const world = makeWorld();
    const r = fireBullet(world, bulletParams({ origin: { x: 0, y: 64, z: 0 }, maxRange: 500 }));
    // 24 units off the middle of the flight path: inside the 64-unit default radius,
    // outside an 8-unit one, and far outside the radius/4 "ended on them" exclusion.
    const near: Vec3 = { x: 24, y: 64, z: -430 };
    expect(whizzBy(r, near)).not.toBeNull();
    expect(whizzBy(r, near, 8)).toBeNull();
    expect(whizzBy(r, { x: 100, y: 64, z: -500 })).toBeNull();
    // The metric is the closest approach to the PATH, not to its end point: a round
    // that flies past the listener and slams into a far wall still cracks past them.
    expect(whizzBy(r, near)!.distance).toBeCloseTo(24, 6);
    // The suppression cue that matters most: a round passing the head mid-flight,
    // 20 units to the side, 70 units before it buries itself in the far wall.
    expect(whizzBy(r, { x: 20, y: 64, z: -430 })!.distance).toBeCloseTo(20, 6);
  });

  it('is silent when the bullet ended on the listener', () => {
    const world = makeWorld();
    const r = fireBullet(world, bulletParams({ origin: { x: 0, y: 64, z: 0 }, maxRange: 500 }));
    expect(whizzBy(r, { x: 0, y: 64, z: -500 })).toBeNull();
  });

  it('is silent for a bullet that never travelled', () => {
    const world = makeWorld();
    const r = fireBullet(world, bulletParams({ dir: { x: 0, y: 0, z: 0 } }));
    expect(whizzBy(r, { x: 10, y: 0, z: 0 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sanity: the numbers a player actually feels
// ---------------------------------------------------------------------------

describe('AK-47 time-to-kill sanity', () => {
  it('one-taps an unhelmeted head and takes 4 kevlar body shots', () => {
    const head = applyDamage({
      rawDamage: damageAtDistance(AK47, 500),
      armorPenetration: AK47.armorPenetration,
      armor: 100,
      helmet: false,
      hitGroup: 'head',
      currentHealth: 100,
    });
    expect(head.killed).toBe(true);

    let health = 100;
    let armor = 100;
    let shots = 0;
    while (health > 0 && shots < 20) {
      const d = damageAtDistance(AK47, 500);
      const r = applyDamage({
        rawDamage: d,
        armorPenetration: AK47.armorPenetration,
        armor,
        helmet: true,
        hitGroup: 'chest',
        currentHealth: health,
      });
      health = Math.max(0, health - r.health);
      armor = Math.max(0, armor - r.armor);
      shots++;
    }
    expect(shots).toBe(4);
    expect(armor).toBeGreaterThan(0);
  });

  it('treats armour as a percentage of the base damage, not of the health damage', () => {
    const hitGroup: HitGroup = 'chest';
    const r = applyDamage({
      rawDamage: 100,
      armorPenetration: 0.5,
      armor: 1000,
      helmet: false,
      hitGroup,
      currentHealth: 1000,
    });
    expect(r.health).toBeCloseTo(50, 9);
    expect(r.armor).toBeCloseTo(25, 9);
  });
});

// ---------------------------------------------------------------------------
// Keeps the unused-import warnings honest for the material type helper
// ---------------------------------------------------------------------------

describe('module surface', () => {
  it('exports the documented symbols', () => {
    expect(typeof damageAtDistance).toBe('function');
    expect(typeof applyDamage).toBe('function');
    expect(typeof computeInaccuracy).toBe('function');
    expect(typeof spreadDirection).toBe('function');
    expect(typeof fireBullet).toBe('function');
    expect(typeof fireShot).toBe('function');
    expect(typeof fallDamage).toBe('function');
    expect(typeof whizzBy).toBe('function');
    expect(COMBAT.armorAbsorb).toBe(0.5);
    expect(COMBAT.penetrationDamageMul).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// melee: the knife is a weapon, not a one-shot prop
// ---------------------------------------------------------------------------

describe('melee (knife)', () => {
  function makeMelee() {
    const world = makeWorld();
    const bus = new EventBus();
    const refs = new Map<number, CombatActorRef>();
    const combat = new CombatSystem({
      world,
      bus,
      getActor: (id) => refs.get(id),
      rng: new Rng(0x2b17),
    });
    for (const id of [1, 2]) {
      const ref: CombatActorRef = {
        state: actor({ id, name: id === 1 ? 'Knifer' : 'Target', pos: { x: 0, y: 0, z: 0 } }),
        weapon: id === 1 ? KNIFE : AK47,
        ammo: new Map(),
      };
      refs.set(id, ref);
      combat.registerActor(id, ref);
    }
    return { combat };
  }

  /** One fresh trigger press, exactly as `Player.handleFire` presents it. */
  function swing(combat: CombatSystem, now: number): boolean {
    const st = combat.getWeaponState(1, KNIFE.id, KNIFE);
    st.triggerDown = true;
    st.triggerPressed = false;
    return combat.tryFire(
      1,
      KNIFE,
      { dir: { x: 0, y: 0, z: -1 }, targets: [], rng: new Rng(1) },
      now,
    );
  }

  it('keeps swinging and never runs out of ammo', () => {
    const { combat } = makeMelee();
    const st = combat.getWeaponState(1, KNIFE.id, KNIFE);

    // The knife is authored as a magazine of one, no reserve and no reload, so
    // the generic "spend a round" path made it a single-use weapon: one swing
    // per round, then dead. Melee must not consume ammo at all.
    expect(KNIFE.magazine).toBe(1);
    expect(KNIFE.reserve).toBe(0);
    expect(KNIFE.reloadTime).toBe(0);

    let now = 0;
    for (let i = 0; i < 4; i++) {
      now += 60 / KNIFE.rpm + 0.001;
      expect(swing(combat, now), `swing ${i + 1}`).toBe(true);
    }
    expect(st.ammo).toBe(1);

    // Still rate-limited by `rpm`: a second press inside the same period fails.
    expect(swing(combat, now + 0.001)).toBe(false);
  });

  it('reaches only as far as an arm: the swing is capped at melee range', () => {
    // The knife is a hitscan with a flat damage falloff, so before the cap it
    // traced out to COMBAT.maxRange and one swing killed anyone on the map.
    expect(COMBAT.meleeRange).toBeGreaterThan(0);
    expect(COMBAT.meleeRange).toBeLessThan(COMBAT.maxRange / 10);

    /**
     * One knifer (id 1) facing a single target at `distance` units on -Z, set up
     * exactly the way `Match` does it: the target's hitbox is registered with the
     * world (that is what the trace tests against) and listed as a target.
     */
    function standoff(distance: number) {
      const world = makeWorld();
      const bus = new EventBus();
      const refs = new Map<number, CombatActorRef>();
      const combat = new CombatSystem({
        world,
        bus,
        getActor: (id) => refs.get(id),
        rng: new Rng(0x2b17),
      });
      const knifer = actor({ id: 1, name: 'Knifer', pos: { x: 0, y: 0, z: 0 } });
      const target = actor({ id: 2, name: 'Target', pos: { x: 0, y: 0, z: -distance } });

      refs.set(1, { state: knifer, weapon: KNIFE, ammo: new Map() });
      combat.registerActor(1, refs.get(1)!);
      refs.set(2, { state: target, weapon: AK47, ammo: new Map() });
      combat.registerActor(2, refs.get(2)!);
      world.registerActors([buildActorHitbox(target)]);

      const hits: number[] = [];
      bus.on('hit', (e: GameEventMap['hit']) => hits.push(e.damage));

      const swing = (now: number): boolean => {
        const st = combat.getWeaponState(1, KNIFE.id, KNIFE);
        st.triggerDown = true;
        st.triggerPressed = false;
        return combat.tryFire(
          1,
          KNIFE,
          {
            origin: { x: 0, y: 55, z: 0 },
            dir: { x: 0, y: 0, z: -1 },
            targets: [buildActorHitbox(target)],
            rng: new Rng(1),
          },
          now,
        );
      };
      return { swing, hits };
    }

    // Inside the reach: a normal swing connects.
    const near = standoff(40);
    expect(near.swing(60 / KNIFE.rpm + 0.001)).toBe(true);
    expect(near.hits).toHaveLength(1);
    expect(near.hits[0]).toBeGreaterThan(0);

    // Four times the reach: the swing still happens, it just cannot land.
    const far = standoff(COMBAT.meleeRange * 4);
    expect(far.swing(60 / KNIFE.rpm + 0.001)).toBe(true);
    expect(far.hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// whizz-by events (CombatSystem -> bus)
// ---------------------------------------------------------------------------

/**
 * A bullet result carrying only what `applyShot` and `whizzBy` read. Defaults to a
 * path that runs along +X at (y 64, z 100), i.e. 100 units from an ear at the
 * origin — outside the 64-unit whizz band, so each test opts in explicitly.
 */
function bulletResult(over: Partial<SingleBulletResult> = {}): SingleBulletResult {
  return {
    hit: false,
    origin: { x: -200, y: 64, z: 100 },
    point: { x: 200, y: 64, z: 100 },
    normal: { x: 0, y: 1, z: 0 },
    material: 'sandstone',
    entityId: -1,
    hitGroup: 'chest',
    distance: 400,
    damage: 0,
    armorDamage: 0,
    penetrated: [],
    penetrationMul: 1,
    ...over,
  };
}

describe('whizz-by events', () => {
  function makeCombat(listenerId: number) {
    const world = makeWorld();
    const bus = new EventBus();
    const refs = new Map<number, CombatActorRef>();
    const combat = new CombatSystem({
      world,
      bus,
      getActor: (id) => refs.get(id),
      rng: new Rng(0x51ab),
    });
    for (const id of [1, 2]) {
      const ref: CombatActorRef = {
        state: actor({ id, name: id === 2 ? 'Listener' : 'Shooter', pos: { x: 0, y: 0, z: 0 } }),
        weapon: AK47,
        ammo: new Map(),
      };
      refs.set(id, ref);
      combat.registerActor(id, ref);
    }
    combat.setListener(listenerId);
    const heard: GameEventMap['whizz'][] = [];
    bus.on('whizz', (e) => heard.push(e));
    return { combat, heard, refs };
  }

  /** Fire `bullets` as actor 1 at listener 2 (who stands at the world origin). */
  function fireAt(
    combat: CombatSystem,
    bullets: SingleBulletResult[],
    shooterId = 1,
  ): void {
    combat.applyShot(
      shooterId,
      AK47,
      { victims: [], bullets },
      { x: 0, y: PLAYER.standEye, z: 100 },
      { x: 1, y: 0, z: 0 },
    );
  }

  it('reports the closest approach for a bullet that snaps past the ear', () => {
    const { combat, heard } = makeCombat(2);
    // Path at z = 40, ear at (0, 64, 0): 40 units away, inside the 64-unit band.
    fireAt(combat, [bulletResult({ origin: { x: -200, y: 64, z: 40 }, point: { x: 200, y: 64, z: 40 } })]);
    expect(heard.length).toBe(1);
    expect(heard[0]?.shooterId).toBe(1);
    expect(heard[0]?.distance).toBeCloseTo(40, 6);
    // The cue is reported at the listener's own ear: that is where it is heard.
    expect(heard[0]?.pos.y).toBeCloseTo(PLAYER.standEye, 6);
    expect(heard[0]?.pos.z).toBeCloseTo(0, 6);
  });

  it('stays silent for a bullet that passes wide', () => {
    const { combat, heard } = makeCombat(2);
    fireAt(combat, [bulletResult()]); // 100 units out
    expect(heard.length).toBe(0);
  });

  it('stays silent for the bullet that actually hits the listener', () => {
    const { combat, heard } = makeCombat(2);
    fireAt(combat, [
      bulletResult({
        entityId: 2,
        hit: true,
        origin: { x: -200, y: 64, z: 0 },
        point: { x: 0, y: 64, z: 0 },
      }),
    ]);
    expect(heard.length).toBe(0);
  });

  it("stays silent for the listener's own shots and for a dead listener", () => {
    const own = makeCombat(2);
    fireAt(own.combat, [bulletResult({ origin: { x: -200, y: 64, z: 40 }, point: { x: 200, y: 64, z: 40 } })], 2);
    expect(own.heard.length).toBe(0);

    const dead = makeCombat(2);
    const listener = dead.refs.get(2);
    if (listener) listener.state.alive = false;
    fireAt(dead.combat, [bulletResult({ origin: { x: -200, y: 64, z: 40 }, point: { x: 200, y: 64, z: 40 } })]);
    expect(dead.heard.length).toBe(0);
  });

  it('stays silent when no listener is set', () => {
    const { combat, heard } = makeCombat(-1);
    fireAt(combat, [bulletResult({ origin: { x: -200, y: 64, z: 40 }, point: { x: 200, y: 64, z: 40 } })]);
    expect(heard.length).toBe(0);
  });
});
