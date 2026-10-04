// =============================================================================
// combat/hitbox.ts — actor hit boxes (head / chest / stomach / leg).
//
// Counter-Strike does not do capsule-vs-mesh hit detection: an actor is a
// vertical stack of four axis-aligned boxes whose heights are FIXED FRACTIONS of
// the actor's collision height. That is why crouching moves the head down and
// why a shot at a fixed world height stops being a headshot when the player
// ducks — a proportion the whole "duck behind the box" game is built on.
//
// This module is the single source of truth for those boxes. The engine calls
// `buildAllHitboxes` once per tick and hands the returned array to
// `World.registerActors`, so every raycast the world performs reports an
// accurate `hitGroup`.
//
// Allocation contract: `buildAllHitboxes` runs 128 times per second for up to
// 10 actors, so it must NOT allocate in the steady state. It reuses the `into`
// array, the `ActorHitbox` wrappers and the inner `AABB` objects (and even the
// `Vec3`s inside those AABBs) across calls. Give it a stable array and it will
// keep mutating that same memory forever.
// =============================================================================

import type { ActorState, AABB, HitGroup, Vec3 } from '../core/types';
import { clamp, distance } from '../core/math';
import { PLAYER } from '../core/config';
import type { ActorHitbox } from '../world/world';

/**
 * Fraction of height at which each band ENDS, measured from the feet, for a
 * STANDING player (CS proportions on a 72-unit body):
 *
 *   head    0.880 .. 1.000  ->  63.36 .. 72.00  (a 12-unit tall box)
 *   chest   0.640 .. 0.880  ->  46.08 .. 63.36
 *   stomach 0.400 .. 0.640  ->  28.80 .. 46.08
 *   legs    0.000 .. 0.400  ->   0.00 .. 28.80
 *
 * The same fractions are re-applied to the crouched height (54), so ducking
 * shrinks every band in the same proportion rather than truncating only the head.
 */
export const HITBOX_BANDS = {
  /** Top of the legs / bottom of the stomach. */
  leg: 0.0,
  /** Top of the stomach / bottom of the chest. */
  stomach: 0.4,
  /** Top of the chest / bottom of the head. */
  chest: 0.64,
  /** Top of the head: always 1.0 (the top of the collision box). */
  head: 0.88,
} as const;

/**
 * Standing head box half-width. The head is deliberately NARROWER than the body
 * (16 half-extents): this is what makes a headshot harder than a bodyshot even
 * when the crosshair is at head height, and it is the reason a head glitch behind
 * cover works in CS.
 */
export const HEAD_HALF_WIDTH = 6.5;

/**
 * Feet-to-top height for an actor, blended from `PLAYER.standHeight` (72) to
 * `PLAYER.crouchHeight` (54) by `duckAmount`. This is the same blend the
 * movement code applies to the collision box, so the hitboxes and the movement
 * box never disagree.
 */
function actorHeight(actor: ActorState): number {
  const duck = clamp(actor.duckAmount, 0, 1);
  return PLAYER.standHeight + (PLAYER.crouchHeight - PLAYER.standHeight) * duck;
}

/** Fill one band box: `minFrac`/`maxFrac` are fractions of `height` from the feet. */
function writeBand(
  out: AABB,
  pos: Vec3,
  minFrac: number,
  maxFrac: number,
  halfWidth: number,
  halfDepth: number,
  height: number,
): void {
  out.min.x = pos.x - halfWidth;
  out.max.x = pos.x + halfWidth;
  out.min.z = pos.z - halfDepth;
  out.max.z = pos.z + halfDepth;
  out.min.y = pos.y + height * minFrac;
  out.max.y = pos.y + height * maxFrac;
}

/**
 * Build the four boxes for one actor, in world space, honouring crouch
 * (`duckAmount`) and height.
 *
 * Pass `out` to avoid allocating: the existing `ActorHitbox` — including its
 * `boxes` entries and their `AABB`s — is mutated in place and returned. A fresh
 * object graph is only allocated when `out` is omitted or too small.
 *
 * Not reentrant with respect to a single `out` argument; that is intentional.
 */
export function buildActorHitbox(actor: ActorState, out?: ActorHitbox): ActorHitbox {
  const boxes = out?.boxes;
  if (!out || !boxes || boxes.length < 4) {
    const fresh: ActorHitbox = {
      entityId: actor.id,
      boxes: [
        { box: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, group: 'head' },
        { box: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, group: 'chest' },
        { box: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, group: 'stomach' },
        { box: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, group: 'leg' },
      ],
    };
    return fillActorHitbox(actor, fresh);
  }
  return fillActorHitbox(actor, out);
}

/** Mutate an existing hitbox record in place. Shared by both branches above. */
function fillActorHitbox(actor: ActorState, out: ActorHitbox): ActorHitbox {
  const pos = actor.pos;
  const height = actorHeight(actor);
  const hw = PLAYER.radius;
  const boxes = out.boxes;

  out.entityId = actor.id;
  writeBand(boxes[0].box, pos, HITBOX_BANDS.head, 1.0, HEAD_HALF_WIDTH, HEAD_HALF_WIDTH, height);
  writeBand(boxes[1].box, pos, HITBOX_BANDS.chest, HITBOX_BANDS.head, hw, hw, height);
  writeBand(boxes[2].box, pos, HITBOX_BANDS.stomach, HITBOX_BANDS.chest, hw, hw, height);
  writeBand(boxes[3].box, pos, HITBOX_BANDS.leg, HITBOX_BANDS.stomach, hw, hw, height);

  boxes[0].group = 'head';
  boxes[1].group = 'chest';
  boxes[2].group = 'stomach';
  boxes[3].group = 'leg';
  return out;
}

/**
 * Rebuild (in place) the hitbox for every actor and return the shared array the
 * World should register.
 *
 * Reuses `into` and every inner `ActorHitbox`/`AABB` it already holds, then
 * truncates the array to `actors.length`. Dead actors (or actors whose boxes are
 * otherwise irrelevant) are simply not passed in by the caller — an actor that
 * must not be hit should be omitted rather than zeroed, because a zeroed box at
 * the origin is a valid target.
 *
 * NOTE: the returned array is the SAME array object every call (when `into` is
 * supplied). Do not hold a snapshot of it across ticks.
 */
export function buildAllHitboxes(actors: readonly ActorState[], into?: ActorHitbox[]): ActorHitbox[] {
  const list: ActorHitbox[] = into ?? [];
  const n = actors.length;
  for (let i = 0; i < n; i++) {
    while (list.length <= i) {
      list.push({
        entityId: -1,
        boxes: [
          { box: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, group: 'head' },
          { box: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, group: 'chest' },
          { box: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, group: 'stomach' },
          { box: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, group: 'leg' },
        ],
      });
    }
    fillActorHitbox(actors[i], list[i]);
  }
  if (list.length > n) list.length = n;
  return list;
}

/**
 * Which hit group a world-space point falls in for a given actor; `'generic'`
 * when outside every band.
 *
 * Boxes are tested head-first, which also covers the (impossible in practice)
 * case of overlapping bands without silently returning `'leg'`.
 */
export function hitGroupAtPoint(actor: ActorState, point: Vec3): HitGroup {
  const hb = buildActorHitbox(actor, scratchHitbox);
  const boxes = hb.boxes;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i].box;
    if (
      point.x >= b.min.x && point.x <= b.max.x &&
      point.y >= b.min.y && point.y <= b.max.y &&
      point.z >= b.min.z && point.z <= b.max.z
    ) {
      return boxes[i].group;
    }
  }
  return 'generic';
}

/**
 * The eye/aim origin for an actor (where bullets originate).
 *
 * Standing eye height is `PLAYER.standEye` (64), crouched is `PLAYER.crouchEye`
 * (46); the value is linearly blended by `duckAmount` so the muzzle travels
 * smoothly during a duck instead of snapping. This is the aim origin for BOTH the
 * player and the bots — bots pre-frame the same eye so their shots are
 * physically identical to a human's.
 */
export function aimOrigin(actor: ActorState): Vec3 {
  const duck = clamp(actor.duckAmount, 0, 1);
  const eye = PLAYER.standEye + (PLAYER.crouchEye - PLAYER.standEye) * duck;
  return { x: actor.pos.x, y: actor.pos.y + eye, z: actor.pos.z };
}

/**
 * Default CS hit-group multipliers, applied when a weapon does not override them.
 * head x4, chest x1.0, stomach x1.25, legs x0.75.
 * `arm` and `generic` have no CS equivalent and are treated as a chest hit.
 */
const DEFAULT_GROUP_MUL: Record<HitGroup, number> = {
  head: 4.0,
  chest: 1.0,
  stomach: 1.25,
  leg: 0.75,
  arm: 1.0,
  generic: 1.0,
};

/**
 * Damage multiplier for a hit group: the weapon's own `hitGroupMul` entry when it
 * has one, otherwise the CS default above. `arm`/`generic` collapse onto chest,
 * matching what the world's raycast can actually report for a body hit.
 */
export function hitGroupMultiplier(
  mul: Partial<Record<HitGroup, number>> | undefined,
  group: HitGroup,
): number {
  const own = mul?.[group];
  if (typeof own === 'number' && Number.isFinite(own)) return own;
  return DEFAULT_GROUP_MUL[group] ?? 1.0;
}

// ---------------------------------------------------------------------------
// Scratch state for the allocation-free helpers.
// NOT reentrant: do not call `actorsOverlap` from inside itself, and do not hold
// the returned values (there are none) across calls.
// ---------------------------------------------------------------------------

const scratchHitbox: ActorHitbox = {
  entityId: -1,
  boxes: [
    { box: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, group: 'head' },
    { box: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, group: 'chest' },
    { box: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, group: 'stomach' },
    { box: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, group: 'leg' },
  ],
};

/**
 * True when the two actors' full collision boxes overlap (player-vs-player
 * pushing). Player collision is a BOX with half-extents 16 in X and Z (not a
 * cylinder), so this is a plain interval test per axis — no allocation.
 *
 * `aabbOverlap` semantics are used deliberately: touching faces do not count as
 * an overlap, otherwise two players standing adjacent would push forever.
 */
export function actorsOverlap(a: ActorState, b: ActorState): boolean {
  const ha = actorHeight(a) * 0.5;
  const hb = actorHeight(b) * 0.5;
  const acx = a.pos.x;
  const acy = a.pos.y + ha;
  const acz = a.pos.z;
  const bcx = b.pos.x;
  const bcy = b.pos.y + hb;
  const bcz = b.pos.z;
  return (
    Math.abs(acx - bcx) < PLAYER.radius * 2 &&
    Math.abs(acy - bcy) < ha + hb &&
    Math.abs(acz - bcz) < PLAYER.radius * 2
  );
}

/**
 * Distance in units between the two actors' feet (plain point distance, not
 * horizontal-only): used for push falloff and for bot spacing decisions.
 */
export function actorDistance(a: ActorState, b: ActorState): number {
  return distance(a.pos, b.pos);
}
