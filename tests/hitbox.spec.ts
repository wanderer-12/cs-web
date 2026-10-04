// =============================================================================
// tests/hitbox.spec.ts — actor hit boxes: band proportions, crouch, aim origin.
//
// The point of these tests is to lock the CS proportions down. If someone "tidies"
// HITBOX_BANDS the crouch head height or the standing chest line will silently
// drift, and every headshot in the game changes difficulty.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { ActorState, Brush, MapData, Vec3 } from '../src/core/types';
import { PLAYER } from '../src/core/config';
import { World, type ActorHitbox } from '../src/world/world';
import {
  HITBOX_BANDS,
  HEAD_HALF_WIDTH,
  actorDistance,
  actorsOverlap,
  aimOrigin,
  buildActorHitbox,
  buildAllHitboxes,
  hitGroupAtPoint,
  hitGroupMultiplier,
} from '../src/combat/hitbox';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function emptyMap(brushes: Brush[]): MapData {
  return {
    name: 'hitbox-fixture',
    bounds: { min: { x: -1024, y: -512, z: -1024 }, max: { x: 1024, y: 512, z: 1024 } },
    brushes,
    spawns: [],
    nav: [],
    sites: [],
    callouts: {},
    radar: { originX: 0, originZ: 0, scale: 1 },
    buyZones: [],
  };
}

function makeWorld(brushes: Brush[] = []): World {
  return new World(emptyMap(brushes));
}

function actor(over: Partial<ActorState> = {}): ActorState {
  return {
    id: 1,
    name: 'Test',
    team: 'T',
    isBot: false,
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

/**
 * Fire a horizontal ray at height `y` from far away on +Z, toward the actor at the
 * origin, and report the hit group the WORLD attributes.
 */
function rayGroupAtHeight(world: World, height: number): string {
  const start: Vec3 = { x: 0, y: height, z: 400 };
  const dir: Vec3 = { x: 0, y: 0, z: -1 };
  const hit = world.raycast(start, dir, 800, { hitActors: true });
  if (!hit.hit) return 'miss';
  return hit.hitGroup;
}

// ---------------------------------------------------------------------------
// Band geometry
// ---------------------------------------------------------------------------

describe('hitbox bands', () => {
  it('exposes the CS band fractions', () => {
    expect(HITBOX_BANDS.head).toBeCloseTo(0.88, 10);
    expect(HITBOX_BANDS.chest).toBeCloseTo(0.64, 10);
    expect(HITBOX_BANDS.stomach).toBeCloseTo(0.4, 10);
    expect(HITBOX_BANDS.leg).toBe(0);
  });

  it('lays the four bands out proportionally on a 72-unit standing body', () => {
    const a = actor();
    const hb = buildActorHitbox(a);
    const head = hb.boxes[0].box;
    // The 0.880..1.000 band is 8.64 units tall; the "12-unit head" in the spec is
    // the head's apparent SIZE once its 13-wide / 12-deep box is considered, while
    // the band heights are the CS proportions (12% head, 24% chest, 24% stomach,
    // 40% legs).
    expect(head.max.y - head.min.y).toBeCloseTo(PLAYER.standHeight * 0.12, 9);
    expect(head.min.y).toBeCloseTo(PLAYER.standHeight * 0.88, 9);
    expect(head.max.y).toBeCloseTo(PLAYER.standHeight, 9);
    // The head is narrower than the body.
    expect(head.max.x - head.min.x).toBeCloseTo(13, 9);
    // The head is narrower than the body in BOTH horizontal axes.
    expect(head.max.x - head.min.x).toBeCloseTo(HEAD_HALF_WIDTH * 2, 9);
    expect(head.max.z - head.min.z).toBeCloseTo(HEAD_HALF_WIDTH * 2, 9);
    // Body footprint is the 16 half-extent collision box.
    const chest = hb.boxes[1].box;
    expect(chest.max.x - chest.min.x).toBeCloseTo(PLAYER.radius * 2, 9);
    expect(chest.max.z - chest.min.z).toBeCloseTo(PLAYER.radius * 2, 9);
  });

  it('reports head / chest / stomach / leg for a standing actor', () => {
    const world = makeWorld();
    world.registerActors([buildActorHitbox(actor())]);

    // Bands on a 72-unit body: head 63.36-72, chest 46.08-63.36, stomach 28.8-46.08, leg 0-28.8.
    expect(rayGroupAtHeight(world, 70)).toBe('head');
    expect(rayGroupAtHeight(world, 66)).toBe('head');
    expect(rayGroupAtHeight(world, 60)).toBe('chest');
    expect(rayGroupAtHeight(world, 46.5)).toBe('chest');
    expect(rayGroupAtHeight(world, 40)).toBe('stomach');
    expect(rayGroupAtHeight(world, 10)).toBe('leg');
  });

  it('reports a miss above the head and outside the body footprint', () => {
    const world = makeWorld();
    world.registerActors([buildActorHitbox(actor())]);
    expect(rayGroupAtHeight(world, 73)).toBe('miss');
    expect(rayGroupAtHeight(world, 200)).toBe('miss');
  });

  it('reports a miss for a ray that passes beside the body', () => {
    const world = makeWorld();
    world.registerActors([buildActorHitbox(actor())]);
    const hit = world.raycast({ x: 100, y: 30, z: 400 }, { x: 0, y: 0, z: -1 }, 800, {
      hitActors: true,
    });
    expect(hit.hit).toBe(false);
  });

  it('is shorter and lower when crouched, and the world agrees', () => {
    const crouched = actor({ crouching: true, duckAmount: 1 });
    const standing = actor({ crouching: false, duckAmount: 0 });

    const chb = buildActorHitbox(crouched);
    const shb = buildActorHitbox(standing);

    expect(chb.boxes[0].box.max.y).toBeCloseTo(PLAYER.crouchHeight, 9);
    expect(chb.boxes[0].box.max.y).toBeLessThan(shb.boxes[0].box.max.y);
    // 0.88 * 54 = 47.52, versus 0.88 * 72 = 63.36 standing.
    expect(chb.boxes[0].box.min.y).toBeCloseTo(54 * 0.88, 9);
    expect(chb.boxes[0].box.min.y).toBeLessThan(shb.boxes[0].box.min.y);
    // Feet stay on the ground.
    expect(chb.boxes[3].box.min.y).toBeCloseTo(0, 9);

    const world = makeWorld();
    world.registerActors([chb]);
    // Head height for a stander is now well above the crouched head.
    expect(rayGroupAtHeight(world, 70)).toBe('miss');
    expect(rayGroupAtHeight(world, 50)).toBe('head');
    expect(rayGroupAtHeight(world, 30)).toBe('stomach');
  });

  it('blends height linearly by duckAmount', () => {
    const half = buildActorHitbox(actor({ duckAmount: 0.5 }));
    const mid = (PLAYER.standHeight + PLAYER.crouchHeight) * 0.5; // 63
    expect(half.boxes[0].box.max.y).toBeCloseTo(mid, 9);
  });
});

// ---------------------------------------------------------------------------
// hitGroupAtPoint
// ---------------------------------------------------------------------------

describe('hitGroupAtPoint', () => {
  it('classifies points inside the actor and outside it', () => {
    const a = actor();
    expect(hitGroupAtPoint(a, { x: 0, y: 66, z: 0 })).toBe('head');
    expect(hitGroupAtPoint(a, { x: 0, y: 55, z: 0 })).toBe('chest');
    expect(hitGroupAtPoint(a, { x: 0, y: 35, z: 0 })).toBe('stomach');
    expect(hitGroupAtPoint(a, { x: 0, y: 5, z: 0 })).toBe('leg');
    expect(hitGroupAtPoint(a, { x: 0, y: 90, z: 0 })).toBe('generic');
    expect(hitGroupAtPoint(a, { x: 0, y: -50, z: 0 })).toBe('generic');
    expect(hitGroupAtPoint(a, { x: 500, y: 30, z: 0 })).toBe('generic');
  });

  it('follows the actor, not the world origin', () => {
    const moved = actor({ pos: { x: 300, y: 40, z: -120 } });
    expect(hitGroupAtPoint(moved, { x: 300, y: 40 + 66, z: -120 })).toBe('head');
    expect(hitGroupAtPoint(moved, { x: 0, y: 66, z: 0 })).toBe('generic');
  });
});

// ---------------------------------------------------------------------------
// aimOrigin
// ---------------------------------------------------------------------------

describe('aimOrigin', () => {
  it('uses the CS stand/crouch eye heights and blends between them', () => {
    expect(aimOrigin(actor({ duckAmount: 0 })).y).toBeCloseTo(PLAYER.standEye, 9);
    expect(aimOrigin(actor({ duckAmount: 1 })).y).toBeCloseTo(PLAYER.crouchEye, 9);
    expect(aimOrigin(actor({ duckAmount: 0.5 })).y).toBeCloseTo(
      (PLAYER.standEye + PLAYER.crouchEye) * 0.5,
      9,
    );
  });

  it('tracks the actor position in XZ', () => {
    const o = aimOrigin(actor({ pos: { x: 12, y: 30, z: -7 } }));
    expect(o.x).toBeCloseTo(12, 9);
    expect(o.z).toBeCloseTo(-7, 9);
    expect(o.y).toBeCloseTo(30 + PLAYER.standEye, 9);
  });
});

// ---------------------------------------------------------------------------
// hitGroupMultiplier
// ---------------------------------------------------------------------------

describe('hitGroupMultiplier', () => {
  it('falls back to the CS defaults', () => {
    expect(hitGroupMultiplier(undefined, 'head')).toBe(4);
    expect(hitGroupMultiplier(undefined, 'chest')).toBe(1);
    expect(hitGroupMultiplier(undefined, 'stomach')).toBe(1.25);
    expect(hitGroupMultiplier(undefined, 'leg')).toBe(0.75);
    // arm/generic map onto chest (that is what the world reports for a body hit).
    expect(hitGroupMultiplier(undefined, 'arm')).toBe(1);
    expect(hitGroupMultiplier(undefined, 'generic')).toBe(1);
  });

  it('prefers the weapon table when it has an entry', () => {
    expect(hitGroupMultiplier({ head: 2.5 }, 'head')).toBe(2.5);
    expect(hitGroupMultiplier({ head: 2.5 }, 'leg')).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// Overlap / distance helpers
// ---------------------------------------------------------------------------

describe('actorsOverlap and actorDistance', () => {
  it('detects overlapping boxes and ignores touching ones', () => {
    const a = actor({ id: 1, pos: { x: 0, y: 0, z: 0 } });
    const b = actor({ id: 2, pos: { x: 0, y: 0, z: 0 } });
    expect(actorsOverlap(a, b)).toBe(true);

    // Exactly 32 apart on X = touching faces, not an overlap.
    const touching = actor({ id: 3, pos: { x: PLAYER.radius * 2, y: 0, z: 0 } });
    expect(actorsOverlap(a, touching)).toBe(false);

    const close = actor({ id: 4, pos: { x: 31, y: 0, z: 0 } });
    expect(actorsOverlap(a, close)).toBe(true);

    const far = actor({ id: 5, pos: { x: 500, y: 0, z: 0 } });
    expect(actorsOverlap(a, far)).toBe(false);
  });

  it('does not overlap when one stands on the other vertically', () => {
    const below = actor({ id: 1, pos: { x: 0, y: 0, z: 0 } });
    const above = actor({ id: 2, pos: { x: 0, y: 72, z: 0 } });
    expect(actorsOverlap(below, above)).toBe(false);
  });

  it('measures feet distance', () => {
    const a = actor({ pos: { x: 0, y: 0, z: 0 } });
    const b = actor({ pos: { x: 3, y: 4, z: 0 } });
    expect(actorDistance(a, b)).toBeCloseTo(5, 9);
  });
});

// ---------------------------------------------------------------------------
// Allocation-free rebuild
// ---------------------------------------------------------------------------

describe('buildAllHitboxes', () => {
  it('reuses the given array and inner objects', () => {
    const actors = [
      actor({ id: 1, pos: { x: 0, y: 0, z: 0 } }),
      actor({ id: 2, pos: { x: 100, y: 0, z: 0 } }),
    ];
    const into: ActorHitbox[] = [];
    const first = buildAllHitboxes(actors, into);
    const firstHitbox = first[0];
    const firstBox = first[0].boxes[0].box;

    actors[0].pos.x = 40;
    const second = buildAllHitboxes(actors, into);

    expect(second).toBe(first);
    expect(second.length).toBe(2);
    expect(second[0]).toBe(firstHitbox);
    expect(second[0].boxes[0].box).toBe(firstBox);
    expect(second[0].entityId).toBe(1);
    expect(second[1].entityId).toBe(2);
    expect(second[0].boxes[0].box.min.x).toBeCloseTo(40 - HEAD_HALF_WIDTH, 9);
  });

  it('shrinks the list when actors leave', () => {
    const into: ActorHitbox[] = [];
    buildAllHitboxes([actor({ id: 1 }), actor({ id: 2 }), actor({ id: 3 })], into);
    const out = buildAllHitboxes([actor({ id: 7 })], into);
    expect(out.length).toBe(1);
    expect(out[0].entityId).toBe(7);
  });

  it('produces a world-registerable array', () => {
    const world = makeWorld();
    const into: ActorHitbox[] = [];
    world.registerActors(buildAllHitboxes([actor({ id: 42 })], into));
    expect(world.getActorHitbox(42)).toBeDefined();
    const hit = world.raycast({ x: 0, y: 66, z: 200 }, { x: 0, y: 0, z: -1 }, 400, {
      hitActors: true,
    });
    expect(hit.hit).toBe(true);
    expect(hit.entityId).toBe(42);
    expect(hit.hitGroup).toBe('head');
  });
});
