// =============================================================================
// combat/ballistics.ts — hitscan bullets: spread, distance falloff, armour,
// hit groups and wall penetration.
//
// This file is the single implementation of the CS damage model. Bots call
// `damageAtDistance` to predict how many shots they need, the combat system calls
// `fireShot` to resolve a trigger pull, and the tests in tests/ballistics.spec.ts
// pin the numbers down.
//
// Determinism: every random draw comes from an injected `Rng`. `Math.random()` is
// never called, so a replay that resupplies the same seed reproduces the same
// bullet paths exactly.
//
// Allocation: the hot path (`fireBullet`) writes its result into a module-scope
// scratch object and returns it. It is NOT reentrant — finish with a result
// before firing the next bullet.
// =============================================================================

import type { HitGroup, RayHit, SurfaceMaterial, Team, Vec3, WeaponDef } from '../core/types';
import type { Rng } from '../core/rng';
import type { ActorHitbox, World } from '../world/world';
import { COMBAT, MOVE } from '../core/config';
import { clamp, lerp, normalize } from '../core/math';
import { patternAt } from './recoil';

// ---------------------------------------------------------------------------
// Spread / inaccuracy
// ---------------------------------------------------------------------------

export interface SpreadInput {
  weapon: WeaponDef;
  /** Horizontal speed of the shooter in units/s (only the ground-plane speed matters). */
  horizontalSpeed: number;
  /** 0..1 crouch blend. */
  duckAmount: number;
  onGround: boolean;
  /** Number of shots already fired in the current burst, for the weapon's inaccuracy table. */
  shotIndex: number;
}

/**
 * Hard ceiling on the cone half-angle (~20 degrees). CS effectively never lets a
 * bullet leave the screen even while jumping, and an uncapped cone would make
 * `NOt` spread wide enough that a shotgun pellet could leave through the back of
 * the player's own head. Clamped rather than scaled so the shape of the
 * speed->inaccuracy curve is unchanged at sane speeds.
 */
export const MAX_INACCURACY = 0.35;

/** Degrees -> radians, for the weapon tables in `weaponDefs.ts`. */
const DEG = Math.PI / 180;

/**
 * Cone half-angle in radians for this shot.
 *
 * CS rule, term by term:
 *  - `base` is the weapon's standing-still cone, replaced by
 *    `crouchInaccuracy` in proportion to how far the player has ducked.
 *  - Moving on the ground grows the cone by `moveInaccuracy` scaled by
 *    `(speed / MOVE.maxSpeed)^1.25`. The exponent > 1 is the whole reason
 *    counter-strafing works: the penalty is nearly flat at walking pace and
 *    explodes as you approach 250 u/s, so a player who stops is instantly
 *    accurate while one who holds W is not.
 *  - Airborne is dramatically worse: at minimum `airInaccuracy`, and never less
 *    than the grounded moving term (so a fast airstrafe cannot be more accurate
 *    than a fast run).
 *  - Finally the weapon's deterministic spray table adds its per-shot inaccuracy,
 *    which is what makes a spray "walk up" the pattern.
 *
 * The result is clamped to [`base`, MAX_INACCURACY] so no input can widen the
 * cone past sanity or narrow it below the weapon's own floor.
 */
export function computeInaccuracy(i: SpreadInput): number {
  const w = i.weapon;
  const duck = clamp(i.duckAmount, 0, 1);
  // Weapon inaccuracy tables are authored in DEGREES (`weaponDefs.ts`: AK base 0.42,
  // move 9.6, AWP move 140) while this function's contract is radians. The rotation
  // pattern's own `inaccuracy` is already radians (see recoil.ts), so only the three
  // weapon fields are converted here.
  const baseDeg = duck > 0 ? lerp(w.baseInaccuracy, w.crouchInaccuracy, duck) : w.baseInaccuracy;
  const base = (Number.isFinite(baseDeg) ? baseDeg : 0) * DEG;

  // Speed ratio against the CS ground speed cap. Negative / NaN speeds are ignored.
  const speed = Number.isFinite(i.horizontalSpeed) ? Math.max(0, i.horizontalSpeed) : 0;
  const ratio = speed / MOVE.maxSpeed;
  const moveTerm = (Number.isFinite(w.moveInaccuracy) ? w.moveInaccuracy : 0) * DEG * Math.pow(ratio, 1.25);

  let cone: number;
  if (i.onGround) {
    cone = base + moveTerm;
  } else {
    const air = (Number.isFinite(w.airInaccuracy) ? w.airInaccuracy : 0) * DEG;
    cone = Math.max(air, base + moveTerm);
  }

  const spray = patternAt(w.pattern, i.shotIndex).inaccuracy;
  if (Number.isFinite(spray) && spray > 0) cone += spray;

  if (!Number.isFinite(cone)) return Math.max(base, 0);
  return clamp(cone, base, MAX_INACCURACY);
}

/**
 * One bullet of a shot: a direction perturbed inside the inaccuracy cone.
 *
 * The offset is sampled in a DISC (uniform by area via `sqrt(u)` on the radius,
 * uniform in angle) rather than a square, so the bullet distribution is
 * rotationally symmetric — a square would over-represent the corners and give the
 * crosshair a subtle diagonal bias. The disc offset is applied in the plane of an
 * orthonormal basis (u, v) perpendicular to `dir`.
 *
 * `inaccuracy <= 0` (or a non-finite one) returns the input direction unchanged,
 * including any non-unit length: a perfect shot must be EXACTLY the aim direction
 * with no float drift, so the dry path is a plain scale.
 */
export function spreadDirection(dir: Vec3, inaccuracy: number, rng: Rng): Vec3 {
  const out: Vec3 = { x: 0, y: 0, z: 0 };
  if (!(inaccuracy > 0) || !Number.isFinite(inaccuracy)) {
    out.x = dir.x;
    out.y = dir.y;
    out.z = dir.z;
    return out;
  }

  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (!(len > 1e-9) || !Number.isFinite(len)) {
    // Degenerate aim (zero-length or non-finite): no basis exists, so a cone is
    // meaningless. Echo the input instead of emitting NaN — `fireBullet` turns a
    // zero-length direction into a miss at the origin, so this path is harmless.
    out.x = Number.isFinite(dir.x) ? dir.x : 0;
    out.y = Number.isFinite(dir.y) ? dir.y : 0;
    out.z = Number.isFinite(dir.z) ? dir.z : 0;
    return out;
  }
  const inv = 1 / len;
  const dx = dir.x * inv;
  const dy = dir.y * inv;
  const dz = dir.z * inv;

  // Orthonormal basis around d. Pick the world axis d is least aligned with so the
  // cross product never degenerates.
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const az = Math.abs(dz);
  let ux: number;
  let uy: number;
  let uz: number;
  if (ax <= ay && ax <= az) {
    uy = -dz;
    uz = dy;
    ux = 0;
  } else if (ay <= az) {
    ux = dz;
    uz = -dx;
    uy = 0;
  } else {
    ux = -dy;
    uy = dx;
    uz = 0;
  }
  const ulen = Math.hypot(ux, uy, uz);
  if (ulen < 1e-9) {
    // Cannot happen for a unit d, but never emit NaN.
    out.x = dir.x;
    out.y = dir.y;
    out.z = dir.z;
    return out;
  }
  const uinv = 1 / ulen;
  ux *= uinv;
  uy *= uinv;
  uz *= uinv;
  // v = u x d (already unit: u is unit and perpendicular to the unit vector d)
  const vx = uy * dz - uz * dy;
  const vy = uz * dx - ux * dz;
  const vz = ux * dy - uy * dx;

  const r = Math.sqrt(rng.float()) * inaccuracy;
  const theta = rng.float() * Math.PI * 2;
  const ox = Math.cos(theta) * r;
  const oy = Math.sin(theta) * r;

  out.x = dx + ux * ox + vx * oy;
  out.y = dy + uy * ox + vy * oy;
  out.z = dz + uz * ox + vz * oy;

  // Re-normalise. `u` and `v` are unit and perpendicular to `d`, so the offset
  // tangent has length exactly `r` and the result's length is `sqrt(1 + r^2)`;
  // one exact division removes that drift so every returned vector is a true unit
  // direction (tracers and cone tests depend on it).
  const olen = 1 / Math.sqrt(1 + r * r);
  out.x *= olen;
  out.y *= olen;
  out.z *= olen;
  return out;
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

/**
 * Damage of one bullet at a given distance before hit-group and armour, given a
 * weapon.
 *
 * CS falloff is a straight line in distance, not an exponential curve:
 *  - full `weapon.damage` below `falloffStart`;
 *  - linearly down to `falloff * damage` at `falloffEnd`;
 *  - constant `falloff * damage` beyond.
 *
 * Pure (no RNG, no world) because the bot AI calls it to decide whether a shot is
 * worth taking, and because it is the value the tests pin.
 */
export function damageAtDistance(weapon: WeaponDef, distance: number): number {
  const dmg = weapon.damage;
  const start = weapon.falloffStart;
  const end = weapon.falloffEnd;
  if (!Number.isFinite(distance) || !(distance > start)) return dmg;
  const mult = Number.isFinite(weapon.falloff) ? weapon.falloff : 1;
  const floor = dmg * mult;
  if (!(distance < end)) return floor;
  const span = end - start;
  if (!(span > 0)) return floor;
  return lerp(dmg, floor, (distance - start) / span);
}

export interface DamageInput {
  rawDamage: number;
  armorPenetration: number; // 0..1
  armor: number; // current armour value
  helmet: boolean;
  hitGroup: HitGroup;
  hitGroupMul?: Partial<Record<HitGroup, number>>;
}
export interface DamageResult {
  /** Damage applied to health. */
  health: number;
  /** Damage applied to armour value. */
  armor: number;
  /** True when the helmet absorbed a headshot (no damage reduction beyond armour). */
  helmetBlocked: boolean;
  killed: boolean;
}

/** CS default hit-group multipliers, mirroring combat/hitbox.ts. */
const DEFAULT_GROUP_MUL: Record<HitGroup, number> = {
  head: 4.0,
  chest: 1.0,
  stomach: 1.25,
  leg: 0.75,
  arm: 1.0,
  generic: 1.0,
};

function groupMultiplier(
  mul: Partial<Record<HitGroup, number>> | undefined,
  group: HitGroup,
): number {
  const own = mul?.[group];
  if (typeof own === 'number' && Number.isFinite(own)) return own;
  return DEFAULT_GROUP_MUL[group] ?? 1.0;
}

/**
 * Apply armour + hit-group multipliers. `currentHealth` is needed for `killed`.
 *
 * Derivation of the armour formula (this is the part most re-implementations get
 * wrong, so it is spelled out):
 *
 *   Let `health = d * armorPenetration` be the damage that reaches the body.
 *   Kevlar absorbed `d - health` units of kinetic energy, and in CS kevlar pays
 *   for exactly what it absorbed: `armorLoss = (d - health) * COMBAT.armorDamageRatio`
 *   with `armorDamageRatio = 0.5`. Substituting gives `armorLoss = 0.5 * d * (1 - ap)`,
 *   which reproduces the two facts players actually memorise: an AK body shot
 *   costs ~29 HP through kevlar and ~8 kevlar. The spec's looser phrasing
 *   ("absorbed at a 1:1 cost, scaled by nothing") overshoots because it ignores
 *   the `(1 - ap)` factor; the config's `armorDamageRatio` is the intended knob,
 *   so it is used, and the shipped constant matches the real game.
 *
 *   Armour runs out MID-HIT when `armorLoss > armor`. The armour absorbs what it
 *   can (`armor * 2` worth of pre-penetration damage, since only half of the
 *   absorption is charged) and the remaining damage is applied to health at the
 *   full pre-armour value — no absorption, no penetration discount.
 *
 * Special cases that must NOT go through the formula:
 *  - No armour (`armor <= 0`): full damage.
 *  - Legs: CS armour never covers legs, so a leg hit takes full damage and drains
 *    no armour even when the player is fully kevlar'd.
 *  - Headshot without a helmet: full damage, zero armour drain. Kevlar alone does
 *    not protect the head; that is what makes the AWP/Deagle one-tap work.
 *  - Headshot with a helmet: identical armour formula as a body hit, which is why
 *    a helmet turns an AK headshot into a ~111-damage killing blow but never a
 *    free save.
 */
export function applyDamage(input: DamageInput & { currentHealth: number }): DamageResult {
  const group = input.hitGroup;
  const rawMul = groupMultiplier(input.hitGroupMul, group);
  const afterGroup = (Number.isFinite(input.rawDamage) ? Math.max(0, input.rawDamage) : 0) * rawMul;

  const ap = clamp(Number.isFinite(input.armorPenetration) ? input.armorPenetration : 1, 0, 1);
  const armor = Number.isFinite(input.armor) ? Math.max(0, input.armor) : 0;
  const isHead = group === 'head';
  const helmetBlocked = isHead && armor > 0 && input.helmet;

  // Legs and un-helmeted headshots bypass kevlar entirely.
  const armorApplies = armor > 0 && group !== 'leg' && (!isHead || input.helmet);

  let healthDamage: number;
  let armorLoss: number;

  if (!armorApplies) {
    healthDamage = afterGroup;
    armorLoss = 0;
  } else {
    const absorbed = afterGroup * (1 - ap);
    const fullCost = absorbed * COMBAT.armorDamageRatio;
    if (fullCost <= armor) {
      // Armour survives the hit and eats the whole absorption charge.
      healthDamage = afterGroup - absorbed;
      armorLoss = fullCost;
    } else if (afterGroup > 0 && absorbed > 0) {
      // Armour breaks mid-hit: it absorbs what it can, the rest lands raw.
      healthDamage = afterGroup - armor / COMBAT.armorDamageRatio;
      armorLoss = armor;
    } else {
      // Fully penetrating round: nothing for the armour to absorb.
      healthDamage = afterGroup;
      armorLoss = 0;
    }
    if (healthDamage < 0) healthDamage = 0;
  }

  const currentHealth = Number.isFinite(input.currentHealth) ? input.currentHealth : 0;
  return {
    health: healthDamage,
    armor: armorLoss,
    helmetBlocked,
    killed: currentHealth - healthDamage <= 0,
  };
}

/**
 * Fall damage from a landing speed (units/s); 0 below `COMBAT.fallDamageThreshold`
 * (580 u/s — roughly a three-storey drop; a plain 56-unit jump at ~268 u/s is free).
 * Beyond the threshold the damage is linear in landing speed, so `fallDamagePerSpeed`
 * (0.1) means a 700 u/s landing costs 12 HP.
 */
export function fallDamage(landingSpeed: number): number {
  if (!Number.isFinite(landingSpeed)) return 0;
  const over = landingSpeed - COMBAT.fallDamageThreshold;
  if (!(over > 0)) return 0;
  return over * COMBAT.fallDamagePerSpeed;
}

// ---------------------------------------------------------------------------
// Bullets
// ---------------------------------------------------------------------------

export interface PenetrationLayer {
  material: SurfaceMaterial;
  /** Distance travelled inside this brush. */
  distance: number;
  /** World point where the bullet entered. */
  entry: Vec3;
  /** World point where the bullet exited. */
  exit: Vec3;
}

export interface SingleBulletResult {
  hit: boolean;
  /**
   * Where this bullet's path starts — the muzzle. A wallbang does not bend the path
   * (the re-cast after an exit plane stays on the same line), so the path is exactly
   * the segment from here to `point`; `whizzBy` needs it for a closest-approach test.
   */
  origin: Vec3;
  /** World-space end point of the bullet (impact point or max range end). */
  point: Vec3;
  normal: Vec3;
  material: SurfaceMaterial;
  entityId: number;
  hitGroup: HitGroup; // the RAW group reported by the world
  distance: number;
  damage: number;
  armorDamage: number;
  /** Layers of geometry passed through on the way to this hit (empty when direct). */
  penetrated: PenetrationLayer[];
  /** Accumulated damage multiplier from penetration, 0..1. */
  penetrationMul: number;
}

export interface BulletParams {
  shooterId: number;
  team: Team;
  origin: Vec3;
  dir: Vec3;
  weapon: WeaponDef;
  spread: SpreadInput;
  /** Enemies to test for hits (already filtered to the shooter's opponents). */
  actors: readonly ActorHitbox[];
  rng: Rng;
  /** Optional: cap the range. Defaults to COMBAT.maxRange. */
  maxRange?: number;
}

/** Hard cap on wall layers a single bullet may pass through (CS allows 3). */
const MAX_PENETRATION_LAYERS = 3;
/** Nudge used to step the re-cast origin past an exit plane so the wall is not re-hit. */
const PEN_EPSILON = 1e-3;

/** Module-scope bullet result. NOT reentrant: copy what you need before the next shot. */
const bulletScratch: SingleBulletResult = {
  hit: false,
  origin: { x: 0, y: 0, z: 0 },
  point: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 1, z: 0 },
  material: 'concrete',
  entityId: -1,
  hitGroup: 'generic',
  distance: 0,
  damage: 0,
  armorDamage: 0,
  penetrated: [],
  penetrationMul: 1,
};

/** Module-scope ray/AABB slab outputs. NOT reentrant. */
const slabEntry = { t: 0 };
const slabExit = { t: 0 };

/**
 * Ray vs AABB slab test that reports BOTH the entry plane and the exit plane.
 *
 * `raycast` only needs the entry, but penetration needs the exit: the thickness a
 * bullet crosses is `tExit - tEntry` along its own direction, which is the only
 * quantity `COMBAT.penetrationMaxThickness` is comparable against.
 *
 * Returns false when the ray misses the box entirely. Writes entry/exit t values
 * into `slabEntry`/`slabExit` (module scratch) only on success.
 */
function rayBoxSpan(
  o: Vec3,
  d: Vec3,
  box: { min: Vec3; max: Vec3 },
  maxT: number,
): boolean {
  let tmin = 0;
  let tmax = maxT;
  for (let axis = 0; axis < 3; axis++) {
    const oa = axis === 0 ? o.x : axis === 1 ? o.y : o.z;
    const da = axis === 0 ? d.x : axis === 1 ? d.y : d.z;
    const lo = axis === 0 ? box.min.x : axis === 1 ? box.min.y : box.min.z;
    const hi = axis === 0 ? box.max.x : axis === 1 ? box.max.y : box.max.z;
    if (Math.abs(da) < 1e-9) {
      if (oa < lo || oa > hi) return false;
      continue;
    }
    const inv = 1 / da;
    let t1 = (lo - oa) * inv;
    let t2 = (hi - oa) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  slabEntry.t = tmin;
  slabExit.t = tmax;
  return true;
}

/** Reset a bullet result to a clean miss ending at `point`. */
function resetBullet(p: SingleBulletResult, origin: Vec3, point: Vec3): SingleBulletResult {
  p.hit = false;
  p.origin.x = origin.x;
  p.origin.y = origin.y;
  p.origin.z = origin.z;
  p.point.x = point.x;
  p.point.y = point.y;
  p.point.z = point.z;
  p.normal.x = 0;
  p.normal.y = 1;
  p.normal.z = 0;
  p.material = 'concrete';
  p.entityId = -1;
  p.hitGroup = 'generic';
  p.distance = Math.max(0, Math.hypot(point.x - origin.x, point.y - origin.y, point.z - origin.z));
  p.damage = 0;
  p.armorDamage = 0;
  p.penetrated.length = 0;
  p.penetrationMul = 1;
  return p;
}

/**
 * Fire ONE bullet through the world (handles wallbangs).
 *
 * Walk:
 *  1. Perturb `p.dir` by the cone (skipped entirely at zero inaccuracy).
 *  2. Cast the segment. An actor hit ends the bullet and returns the world's RAW
 *     hit group (the caller maps `arm`/`generic` onto chest).
 *  3. A static hit is tested against `world.materialThickness`: a material with
 *     thickness 0 (concrete, sandstone, sand, water) or a thickness above
 *     `COMBAT.penetrationMaxThickness` stops the bullet permanently. Otherwise the
 *     bullet records the layer, multiplies its damage by
 *     `COMBAT.penetrationDamageMul` per layer, and re-casts from just past the
 *     exit plane of that brush.
 *  4. Terminates unconditionally: at most 3 layers, and the remaining range shrinks
 *     by everything already travelled, so a bullet inside a stack of brushes
 *     always runs out of `maxRange`.
 *
 * Returns a module-scope scratch object — copy what you need before the next call.
 */
export function fireBullet(world: World, p: BulletParams): SingleBulletResult {
  const origin = p.origin;
  const out = bulletScratch;
  // Every return path below reports a path that starts at the muzzle.
  out.origin.x = origin.x;
  out.origin.y = origin.y;
  out.origin.z = origin.z;

  // --- degenerate inputs: never throw, never emit NaN -----------------------
  const dirLen = Math.hypot(p.dir.x, p.dir.y, p.dir.z);
  if (!(dirLen > 1e-9) || !Number.isFinite(dirLen)) {
    return resetBullet(out, origin, origin);
  }
  const rawRange = p.maxRange ?? COMBAT.maxRange;
  const range = Number.isFinite(rawRange) ? Math.min(rawRange, COMBAT.maxRange) : COMBAT.maxRange;
  if (!(range > 0)) return resetBullet(out, origin, origin);

  const aim = spreadDirection(p.dir, computeInaccuracy(p.spread), p.rng);
  const dLen = Math.hypot(aim.x, aim.y, aim.z);
  // NOTE: `computeInaccuracy` is evaluated once above; `spreadDirection` is given the
  // finished cone rather than re-deriving it, so the RNG stream stays 2 draws/pellet.
  const invD = 1 / dLen;
  const dx = aim.x * invD;
  const dy = aim.y * invD;
  const dz = aim.z * invD;

  const hitActors = p.actors.length > 0;
  const ignore = p.shooterId >= 0 ? p.shooterId : -1;

  let ox = origin.x;
  let oy = origin.y;
  let oz = origin.z;
  let remaining = range;
  let penetrationMul = 1;
  let layers = 0;

  for (;;) {
    const rh: RayHit = world.raycast({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz }, remaining, {
      hitActors,
      ignoreEntity: ignore,
    });

    if (!rh.hit) {
      // Nothing in the way: the bullet ends at max range.
      out.hit = false;
      out.point.x = ox + dx * remaining;
      out.point.y = oy + dy * remaining;
      out.point.z = oz + dz * remaining;
      out.normal.x = 0;
      out.normal.y = 1;
      out.normal.z = 0;
      out.material = 'concrete';
      out.entityId = -1;
      out.hitGroup = 'generic';
      out.distance = range;
      out.damage = damageAtDistance(p.weapon, range) * penetrationMul;
      out.armorDamage = 0;
      out.penetrated.length = layers;
      out.penetrationMul = penetrationMul;
      return out;
    }

    if (rh.entityId >= 0) {
      // --- actor hit: the bullet stops here --------------------------------
      const travel = Math.hypot(rh.point.x - origin.x, rh.point.y - origin.y, rh.point.z - origin.z);
      out.hit = true;
      out.point.x = rh.point.x;
      out.point.y = rh.point.y;
      out.point.z = rh.point.z;
      out.normal.x = rh.normal.x;
      out.normal.y = rh.normal.y;
      out.normal.z = rh.normal.z;
      out.material = rh.material;
      out.entityId = rh.entityId;
      out.hitGroup = rh.hitGroup;
      out.distance = travel;
      out.damage = damageAtDistance(p.weapon, travel) * penetrationMul;
      out.armorDamage = 0;
      out.penetrated.length = layers;
      out.penetrationMul = penetrationMul;
      return out;
    }

    // --- static geometry ----------------------------------------------------
    const mat = rh.material as string;
    const thickness = world.materialThickness[mat];
    if (
      typeof thickness !== 'number' ||
      !(thickness > 0) ||
      thickness > COMBAT.penetrationMaxThickness ||
      layers >= MAX_PENETRATION_LAYERS
    ) {
      // Impenetrable (or out of layers): the bullet dies on this surface.
      const travel = Math.hypot(rh.point.x - origin.x, rh.point.y - origin.y, rh.point.z - origin.z);
      out.hit = true;
      out.point.x = rh.point.x;
      out.point.y = rh.point.y;
      out.point.z = rh.point.z;
      out.normal.x = rh.normal.x;
      out.normal.y = rh.normal.y;
      out.normal.z = rh.normal.z;
      out.material = rh.material;
      out.entityId = -1;
      out.hitGroup = 'generic';
      out.distance = travel;
      out.damage = damageAtDistance(p.weapon, travel) * penetrationMul;
      out.armorDamage = 0;
      out.penetrated.length = layers;
      out.penetrationMul = penetrationMul;
      return out;
    }

    // Resolve the exit plane of the brush we hit. The world reports the brush id,
    // so the AABB is exact (including yaw-expanded boxes).
    const brushIdx = rh.brushId;
    const box = brushIdx >= 0 ? world.brushAabbs[brushIdx] : undefined;
    const entryT = Math.max(0, rh.distance);
    if (!box || !rayBoxSpan({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz }, box, remaining)) {
      // Cannot resolve a finite exit plane -> the bullet stops (never loop).
      const travel = Math.hypot(rh.point.x - origin.x, rh.point.y - origin.y, rh.point.z - origin.z);
      out.hit = true;
      out.point.x = rh.point.x;
      out.point.y = rh.point.y;
      out.point.z = rh.point.z;
      out.normal.x = rh.normal.x;
      out.normal.y = rh.normal.y;
      out.normal.z = rh.normal.z;
      out.material = rh.material;
      out.entityId = -1;
      out.hitGroup = 'generic';
      out.distance = travel;
      out.damage = damageAtDistance(p.weapon, travel) * penetrationMul;
      out.armorDamage = 0;
      out.penetrated.length = layers;
      out.penetrationMul = penetrationMul;
      return out;
    }
    const exitT = Math.max(slabExit.t, entryT);
    const crossing = exitT - entryT;

    const layer = {
      material: rh.material,
      distance: crossing,
      entry: { x: ox + dx * entryT, y: oy + dy * entryT, z: oz + dz * entryT },
      exit: { x: ox + dx * exitT, y: oy + dy * exitT, z: oz + dz * exitT },
    };
    if (out.penetrated.length > layers) out.penetrated[layers] = layer;
    else out.penetrated.push(layer);
    layers++;

    penetrationMul *= COMBAT.penetrationDamageMul;
    remaining -= exitT;
    if (!(remaining > 0)) {
      // Ran out of range inside the wall: the bullet dies at the exit plane.
      out.hit = true;
      out.point.x = layer.exit.x;
      out.point.y = layer.exit.y;
      out.point.z = layer.exit.z;
      out.normal.x = rh.normal.x;
      out.normal.y = rh.normal.y;
      out.normal.z = rh.normal.z;
      out.material = rh.material;
      out.entityId = -1;
      out.hitGroup = 'generic';
      out.distance = Math.hypot(layer.exit.x - origin.x, layer.exit.y - origin.y, layer.exit.z - origin.z);
      out.damage = damageAtDistance(p.weapon, out.distance) * penetrationMul;
      out.armorDamage = 0;
      out.penetrated.length = layers;
      out.penetrationMul = penetrationMul;
      return out;
    }

    // Step just past the exit plane so this brush cannot be hit twice.
    ox = layer.exit.x + dx * PEN_EPSILON;
    oy = layer.exit.y + dy * PEN_EPSILON;
    oz = layer.exit.z + dz * PEN_EPSILON;
  }
}

export interface ShotVictim {
  entityId: number;
  hitGroup: HitGroup;
  damage: number;
  armorDamage: number;
  point: Vec3;
  normal: Vec3;
  killed: boolean;
  wallbang: boolean;
}
export interface ShotResult {
  victims: ShotVictim[];
  /** One entry per bullet (shotguns have `weapon.pellets`). Used to draw tracers/impacts. */
  bullets: SingleBulletResult[];
}

/**
 * Fire a complete shot: 1 bullet, or `weapon.pellets` bullets for a shotgun.
 *
 * Each pellet is spread INDEPENDENTLY from the same origin, so a shotgun blast
 * can hit three different actors — that is what makes the Nova threatening in a
 * corridor and useless at range. `SingleBulletResult`s are allocated per bullet
 * here (they outlive the scratch object) and are what the caller draws tracers
 * from.
 *
 * NOTE: this function copies the module-scope bullet scratch, so it must run to
 * completion before another `fireBullet` call.
 */
export function fireShot(world: World, p: BulletParams): ShotResult {
  const bullets: SingleBulletResult[] = [];
  const victims: ShotVictim[] = [];
  const rawPellets = p.weapon.pellets;
  const pellets =
    typeof rawPellets === 'number' && Number.isFinite(rawPellets) && rawPellets >= 1
      ? Math.floor(rawPellets)
      : 1;

  for (let i = 0; i < pellets; i++) {
    const r = fireBullet(world, p);
    bullets.push({
      hit: r.hit,
      origin: { x: r.origin.x, y: r.origin.y, z: r.origin.z },
      point: { x: r.point.x, y: r.point.y, z: r.point.z },
      normal: { x: r.normal.x, y: r.normal.y, z: r.normal.z },
      material: r.material,
      entityId: r.entityId,
      hitGroup: r.hitGroup,
      distance: r.distance,
      damage: r.damage,
      armorDamage: r.armorDamage,
      penetrated: r.penetrated.map((l) => ({
        material: l.material,
        distance: l.distance,
        entry: { x: l.entry.x, y: l.entry.y, z: l.entry.z },
        exit: { x: l.exit.x, y: l.exit.y, z: l.exit.z },
      })),
      penetrationMul: r.penetrationMul,
    });

    if (r.hit && r.entityId >= 0) {
      victims.push({
        entityId: r.entityId,
        hitGroup: r.hitGroup,
        damage: r.damage,
        armorDamage: r.armorDamage,
        point: { x: r.point.x, y: r.point.y, z: r.point.z },
        normal: { x: r.normal.x, y: r.normal.y, z: r.normal.z },
        killed: false,
        wallbang: r.penetrated.length > 0,
      });
    }
  }

  return { victims, bullets };
}

// ---------------------------------------------------------------------------
// Whizz-by (suppression audio)
// ---------------------------------------------------------------------------

/** Sound event shape the engine forwards to the audio system. */
export interface BulletSound {
  kind: 'whizz';
  pos: Vec3;
  distance: number;
}

/** Default whizz-by radius in units (~1.2 m). */
export const DEFAULT_WHIZZ_RADIUS = 64;

/**
 * Whizz-by detection: a bullet passing within `radius` of a listener produces a
 * sound (the "crack" of a round going past your head, CS's main suppression cue).
 *
 * The metric is the distance from the listener to the bullet's PATH — the segment
 * from `result.origin` to `result.point` — not to its end point. That distinction is
 * the whole point of the cue: a round that misses by 20 units and then slams into a
 * wall 2000 units behind the listener must still crack past them, and a
 * distance-to-end-point test would call that silent.
 *
 * Returns null for a bullet that is far away and for a bullet that never travelled.
 * A bullet that ended ON the listener also returns null: a hit is already reported
 * as a `hit` event and treating it as a near miss would double-report it. Since
 * `SingleBulletResult` carries no victim entity id, that case is excluded with the
 * contract's `radius / 4` lower bound — a bullet whose closest approach is under a
 * quarter of the radius is treated as having hit the listener.
 *
 * The reported sound position is the listener's own ear, which is where a whizz is
 * perceived anyway; `distance` is the closest approach of the path.
 */
export function whizzBy(
  result: SingleBulletResult,
  listenerPos: Vec3,
  radius: number = DEFAULT_WHIZZ_RADIUS,
): BulletSound | null {
  const r = Number.isFinite(radius) && radius > 0 ? radius : DEFAULT_WHIZZ_RADIUS;
  const ox = result.origin.x;
  const oy = result.origin.y;
  const oz = result.origin.z;
  const ex = result.point.x;
  const ey = result.point.y;
  const ez = result.point.z;
  const travelled = result.distance;
  if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz)) return null;
  if (!Number.isFinite(ex) || !Number.isFinite(ey) || !Number.isFinite(ez)) return null;
  // A bullet that never travelled cannot whizz past anyone.
  if (!Number.isFinite(travelled) || !(travelled > 0)) return null;

  // Closest approach of the listener to the path segment: project the listener onto
  // [origin, point] and clamp, so a listener "behind" the muzzle or "past" the
  // impact point measures to that end of the segment rather than to the infinite line.
  const abx = ex - ox;
  const aby = ey - oy;
  const abz = ez - oz;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (len2 > 1e-9) {
    t = ((listenerPos.x - ox) * abx + (listenerPos.y - oy) * aby + (listenerPos.z - oz) * abz) / len2;
    t = clamp(t, 0, 1);
  }
  const dx = listenerPos.x - (ox + abx * t);
  const dy = listenerPos.y - (oy + aby * t);
  const dz = listenerPos.z - (oz + abz * t);
  const dist = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(dist)) return null;
  if (!(dist > r * 0.25) || dist > r) return null;

  return {
    kind: 'whizz',
    pos: { x: listenerPos.x, y: listenerPos.y, z: listenerPos.z },
    distance: dist,
  };
}
