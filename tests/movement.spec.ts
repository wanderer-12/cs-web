// =============================================================================
// tests/movement.spec.ts — the hand-written movement model.
//
// This locks the numbers the whole game feel is built on (250 run / 130 walk /
// 85 crouch / 30 air cap / ~45-unit jump) and the two behaviours that break
// silently:
//
//   * step-up must probe with the WISH delta, not the post-collision one. A box
//     already pressed against a tread has ~0 measured movement, so the old probe
//     never carried it over the edge and players *and* bots ground on stair
//     mouths forever (this is asserted below so it cannot come back).
//   * friction must actually bring a runner to a standstill.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { Brush, InputButtons, InputCommand, MapData } from '../src/core/types';
import { EMPTY_BUTTONS } from '../src/core/types';
import { MOVE, PLAYER, TICK_DT } from '../src/core/config';
import { World } from '../src/world/world';
import { createMoveState, stepMovement, unstuck, type MoveState } from '../src/player/movement';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Authored the way the map files do it: min/max corners, yaw 0. */
function box(
  id: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): Brush {
  return {
    id,
    pos: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 },
    size: { x: x1 - x0, y: y1 - y0, z: z1 - z0 },
    yaw: 0,
    material: 'sand',
  };
}

function makeWorld(brushes: Brush[]): World {
  const map: MapData = {
    name: 'movement-fixture',
    bounds: { min: { x: -1024, y: -512, z: -1024 }, max: { x: 1024, y: 512, z: 1024 } },
    brushes,
    spawns: [],
    nav: [],
    sites: [],
    callouts: {},
    radar: { originX: 0, originZ: 0, scale: 1 },
    buyZones: [],
  };
  return new World(map);
}

/** A 1000-unit floor whose top face sits exactly on y = 0. */
const FLOOR = box(0, -1000, -64, -1000, 1000, 0, 1000);

/** yaw 0 looks down -Z (north); this one looks down +X (east). */
const EAST = -Math.PI / 2;

function press(over: Partial<InputButtons> = {}, yaw = 0): InputCommand {
  return { tick: 0, buttons: { ...EMPTY_BUTTONS, ...over }, yaw, pitch: 0, mouseDX: 0, mouseDY: 0 };
}

function run(
  world: World,
  state: MoveState,
  ticks: number,
  make: () => InputCommand,
  wishSpeedMul = 1,
): MoveState {
  for (let i = 0; i < ticks; i++) stepMovement(world, state, make(), TICK_DT, wishSpeedMul);
  return state;
}

function speed(state: MoveState): number {
  return Math.hypot(state.vel.x, state.vel.z);
}

// ---------------------------------------------------------------------------
// Ground movement
// ---------------------------------------------------------------------------

describe('ground movement', () => {
  it('accelerates to the 250 u/s run speed along the yaw direction', () => {
    const world = makeWorld([FLOOR]);
    const state = createMoveState({ x: 0, y: 0, z: 0 });

    run(world, state, 256, () => press({ forward: true }, 0));

    expect(speed(state)).toBeGreaterThan(245);
    expect(speed(state)).toBeLessThan(MOVE.maxSpeed + 0.5);
    expect(state.onGround).toBe(true);
    expect(state.pos.y).toBeCloseTo(0, 1);
    // yaw 0 is -Z, and the wish direction is pure forward so X must not drift.
    expect(state.pos.z).toBeLessThan(-300);
    expect(Math.abs(state.pos.x)).toBeLessThan(0.5);
  });

  it('clamps the wish speed to walk (shift) and crouch', () => {
    const world = makeWorld([FLOOR]);

    const walker = createMoveState({ x: 0, y: 0, z: 0 });
    run(world, walker, 256, () => press({ forward: true, walk: true }, 0));
    expect(speed(walker)).toBeCloseTo(MOVE.walkSpeed, 0);

    const croucher = createMoveState({ x: 0, y: 0, z: 0 });
    run(world, croucher, 256, () => press({ forward: true, crouch: true }, 0));
    expect(croucher.duckAmount).toBeGreaterThan(0.99);
    expect(croucher.crouching).toBe(true);
    expect(speed(croucher)).toBeCloseTo(MOVE.crouchSpeed, 0);
  });

  it('applies the back and strafe speed multipliers', () => {
    const world = makeWorld([FLOOR]);

    const back = createMoveState({ x: 0, y: 0, z: 0 });
    run(world, back, 256, () => press({ back: true }, 0));
    expect(speed(back)).toBeCloseTo(MOVE.maxSpeed * MOVE.backSpeedMul, 0);

    const strafe = createMoveState({ x: 0, y: 0, z: 0 });
    run(world, strafe, 256, () => press({ right: true }, 0));
    expect(speed(strafe)).toBeCloseTo(MOVE.maxSpeed * MOVE.sideSpeedMul, 0);
    // yaw 0 means right is +X.
    expect(strafe.pos.x).toBeGreaterThan(300);
  });

  it('friction brings a runner to a full stop', () => {
    const world = makeWorld([FLOOR]);
    const state = createMoveState({ x: 0, y: 0, z: 0 });
    run(world, state, 256, () => press({ forward: true }, 0));
    const fast = speed(state);
    expect(fast).toBeGreaterThan(245);

    run(world, state, 32, () => press({}, 0));
    expect(speed(state)).toBeLessThan(fast * 0.75);

    run(world, state, 32, () => press({}, 0));
    expect(speed(state)).toBe(0);
  });

  it('slides along a wall instead of sticking to it', () => {
    // A wall on the +X side of the player, running the whole corridor in Z.
    const world = makeWorld([FLOOR, box(1, 0, -64, -400, 64, 128, 400)]);
    const state = createMoveState({ x: -100, y: 0, z: 100 });

    run(world, state, 128, () => press({ forward: true, right: true }, 0));

    expect(state.pos.z).toBeLessThan(0); // kept moving north
    expect(state.pos.x).toBeLessThan(-14); // but never entered the wall
    expect(speed(state)).toBeGreaterThan(120);
  });

  it('refuses a step taller than PLAYER.stepHeight', () => {
    const world = makeWorld([FLOOR, box(1, 0, -64, -400, 400, 30, 400)]);
    const state = createMoveState({ x: -80, y: 0, z: 0 });

    run(world, state, 192, () => press({ forward: true }, EAST));

    expect(state.pos.y).toBeLessThan(1);
    expect(state.pos.x).toBeLessThan(-14); // box flush against the face
  });
});

// ---------------------------------------------------------------------------
// Stairs
// ---------------------------------------------------------------------------

describe('stairs', () => {
  it('climbs a 16-unit tread while running (step-up uses the wish delta)', () => {
    const world = makeWorld([FLOOR, box(1, 0, -64, -400, 400, 16, 400)]);
    const state = createMoveState({ x: -80, y: 0, z: 0 });

    run(world, state, 96, () => press({ forward: true }, EAST));

    // On top of the tread, still running: this is the catwalk-mouth regression.
    expect(state.pos.y).toBeGreaterThan(PLAYER.stepHeight - 2);
    expect(state.pos.y).toBeLessThan(PLAYER.stepHeight + 1);
    expect(state.pos.x).toBeGreaterThan(0);
    expect(speed(state)).toBeGreaterThan(150);
  });

  it('climbs a flight of stairs without losing speed', () => {
    // Four 16-unit treads, each 24 units deep - the de_dust2_lite catwalk shape -
    // plus the platform at the top, so a finished flight does not step straight
    // off the last tread and fall back to the floor.
    const world = makeWorld([
      FLOOR,
      box(1, 0, -64, -400, 24, 16, 400),
      box(2, 24, -64, -400, 48, 32, 400),
      box(3, 48, -64, -400, 72, 48, 400),
      box(4, 72, -64, -400, 96, 64, 400),
      box(5, 96, -64, -400, 800, 64, 400),
    ]);
    const state = createMoveState({ x: -60, y: 0, z: 0 });

    // Four 16-unit treads of 24 units each is 96 units of travel from x = -60
    // while being blocked on every riser, so this needs more than a second of
    // simulated time to finish the flight and settle on the top tread.
    run(world, state, 192, () => press({ forward: true }, EAST));

    expect(state.pos.y).toBeGreaterThan(60);
    expect(state.pos.y).toBeLessThan(65);
    expect(state.pos.x).toBeGreaterThan(96);
    expect(speed(state)).toBeGreaterThan(150);
  });
});

// ---------------------------------------------------------------------------
// Air
// ---------------------------------------------------------------------------

describe('air', () => {
  it('jumps to the design apex and lands back on the floor', () => {
    const world = makeWorld([FLOOR]);
    const state = createMoveState({ x: 0, y: 0, z: 0 });

    let apex = 0;
    for (let i = 0; i < 24; i++) {
      stepMovement(world, state, press({ jump: true }), TICK_DT);
      apex = Math.max(apex, state.pos.y);
    }
    expect(state.onGround).toBe(false);

    let landed = 0;
    for (let i = 0; i < 128; i++) {
      const r = stepMovement(world, state, press({}, 0), TICK_DT);
      apex = Math.max(apex, state.pos.y);
      if (r.landed) landed += 1;
    }

    // jumpImpulse^2 / (2 * gravity) = 268.3^2 / 1600 = 44.99.
    expect(apex).toBeGreaterThan(42);
    expect(apex).toBeLessThan(47);
    expect(landed).toBe(1);
    expect(state.onGround).toBe(true);
    expect(state.pos.y).toBeCloseTo(0, 1);
  });

  it('caps straight-line air acceleration at 30 u/s', () => {
    const world = makeWorld([FLOOR]);
    const state = createMoveState({ x: 0, y: 300, z: 0 });
    state.onGround = false;

    run(world, state, 80, () => press({ forward: true }, 0));

    expect(state.onGround).toBe(false); // still falling (0.87 s drop from 300)
    expect(speed(state)).toBeGreaterThan(25);
    expect(speed(state)).toBeLessThan(MOVE.airWishSpeedCap + 0.5);
  });

  it('auto-hop preserves the speed of a running player but never runs away', () => {
    const world = makeWorld([FLOOR]);
    const state = createMoveState({ x: 0, y: 0, z: 0 });

    // Run up to speed on the ground first. A hop only accelerates on its single
    // grounded tick, so a player who starts hopping from a standstill is *meant*
    // to stay slow - that is the classic "bunny hop off the spawn" behaviour.
    run(world, state, 96, () => press({ forward: true }, 0));
    expect(speed(state)).toBeGreaterThan(245);

    let peak = 0;
    let jumped = 0;
    for (let i = 0; i < 320; i++) {
      const r = stepMovement(world, state, press({ forward: true, jump: true }, 0), TICK_DT);
      if (r.jumped) jumped += 1;
      peak = Math.max(peak, speed(state));
    }

    expect(jumped).toBeGreaterThanOrEqual(3);
    // Neither bleeds speed (the landing-tick friction drop of 10.2 u/s is handed
    // back by the 10.7 u/s of ground acceleration) nor gains any: it sits at 250.
    expect(peak).toBeLessThan(MOVE.maxSpeed * 1.02);
    expect(speed(state)).toBeGreaterThan(215);
    expect(Number.isFinite(state.pos.z)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Crouch clearance
// ---------------------------------------------------------------------------

describe('crouch clearance', () => {
  // An overhang whose underside is at y = 58: a crouched box (54) fits, a
  // standing box (72) does not.
  const OVERHANG = box(1, 0, 58, -400, 32, 400, 400);

  it('lets a crouched player through a gap that blocks a standing one', () => {
    const world = makeWorld([FLOOR, OVERHANG]);

    const standing = createMoveState({ x: -120, y: 0, z: 0 });
    run(world, standing, 256, () => press({ forward: true }, EAST));
    expect(standing.pos.x).toBeLessThan(-14);

    const ducked = createMoveState({ x: -120, y: 0, z: 0 });
    run(world, ducked, 384, () => press({ forward: true, crouch: true }, EAST));
    expect(ducked.pos.x).toBeGreaterThan(48);
    expect(ducked.pos.y).toBeLessThan(0.5);
  });

  it('keeps the player ducked under the overhang and stands back up in the open', () => {
    const world = makeWorld([FLOOR, OVERHANG]);
    const state = createMoveState({ x: 16, y: 0, z: 0 });
    state.duckAmount = 1;
    state.crouching = true;

    run(world, state, 64, () => press({}, 0));
    expect(state.duckAmount).toBeGreaterThan(0.5); // no headroom to stand
    expect(state.duckAmount).toBeLessThan(0.95);

    state.pos.x = 300;
    run(world, state, 64, () => press({}, 0));
    expect(state.duckAmount).toBe(0);
    expect(state.crouching).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Recovery and robustness
// ---------------------------------------------------------------------------

describe('recovery', () => {
  it('unstuck lifts a player out of a thin solid and gives up on a deep one', () => {
    const shallow = makeWorld([FLOOR, box(1, -200, 0, -200, 200, 6, 200)]);
    const a = createMoveState({ x: 0, y: 0, z: 0 });
    expect(unstuck(shallow, a)).toBe(true);
    expect(a.pos.y).toBeGreaterThan(6);

    const deep = makeWorld([FLOOR, box(1, -200, 0, -200, 200, 400, 200)]);
    const b = createMoveState({ x: 0, y: 0, z: 0 });
    expect(unstuck(deep, b)).toBe(false);
  });

  it('stays finite, grounded and inside the map over a long mixed run', () => {
    const world = makeWorld([FLOOR]);
    const state = createMoveState({ x: 0, y: 0, z: 0 });
    const pattern = [
      press({ forward: true }, 0),
      press({ forward: true, jump: true }, 0.7),
      press({ right: true, walk: true }, -1.2),
      press({ back: true, crouch: true }, 2.4),
      press({ left: true }, Math.PI),
      press({}, 0.3),
    ];

    for (let i = 0; i < 512; i++) {
      const r = stepMovement(world, state, pattern[i % pattern.length], TICK_DT);
      expect(Number.isFinite(r.horizontalSpeed)).toBe(true);
    }

    // 512 % 6 === 2, so the run ends one tick into the jump entry: fall back
    // down (and come to rest) before asserting the settled state.
    run(world, state, 64, () => press({}, 0.3));

    expect(Number.isFinite(state.pos.x)).toBe(true);
    expect(Number.isFinite(state.pos.y)).toBe(true);
    expect(Number.isFinite(state.pos.z)).toBe(true);
    expect(state.onGround).toBe(true);
    expect(state.pos.y).toBeCloseTo(0, 1);
    expect(Math.abs(state.pos.x)).toBeLessThan(1000);
    expect(Math.abs(state.pos.z)).toBeLessThan(1000);
  });
});