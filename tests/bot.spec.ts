// =============================================================================
// tests/bot.spec.ts — the bot decision core, driven with a fully synthetic map.
//
// Everything the bot needs is hand-built here: a `MapData` with a 5x5 nav grid and
// a couple of brushes, a real `World`, a real `NavGraph`, and minimal `ActorState`
// objects. No game loop, no renderer, no timers — which is the whole point of the
// `Bot.ts` / `BotController.ts` split.
//
// GEOMETRY NOTE. The actor helpers below place feet at y = -64 so that standing
// eye height (PLAYER.standEye = 64) lands exactly on y = 0. Every ray in these
// tests is therefore a flat line at a known height, which makes "does this wall
// block this shot" arithmetic something a reader can check by eye.
//
// WHAT IS DELIBERATELY NOT TESTED HERE (needs the real game loop, so it belongs in
// an integration/playtest harness):
//   * whether `cmd.buttons.use` actually plants or defuses — the bot only expresses
//     intent; combat/player code resolves it;
//   * whether the resulting movement wins a fight, or whether the walk/crouch
//     modifiers produce the intended *in-game* noise and accuracy outcomes;
//   * grenade usage, buy logic, and economy — outside this module's contract;
//   * camera view punch interacting with the bot's spray compensation (the bot
//     pre-compensates in `cmd.yaw`; the punch on top of it is the player/camera
//     layer's business);
//   * multi-bot team coordination and the strategy layer that derives `BotObjective`.
// =============================================================================

import { describe, expect, it } from 'vitest';

import {
  AWP,
  AK47,
  M4A4,
  MP9,
  NOVA,
  weaponById,
} from '../src/combat/weaponDefs';
import { AK47_PATTERN, patternAt } from '../src/combat/recoil';
import { CAMERA, PLAYER } from '../src/core/config';
import { Rng } from '../src/core/rng';
import {
  angleToDirSafe,
  createBotCommand,
  createBotSenses,
  createBotMemory,
  pickGoalNode,
  preferredRange,
  sprayCompensation,
  aimAngles,
  chooseGoal,
  perceive,
  think,
  BOT_SKILLS,
} from '../src/ai/Bot';
import type {
  BotContext,
  BotGoal,
  BotObjective,
  BotSenses,
  BotSkill,
} from '../src/ai/Bot';
import { BotController } from '../src/ai/BotController';
import { NavGraph } from '../src/ai/navigation';
import { World } from '../src/world/world';
import type { ActorState, Brush, MapData, NavNode, Team, Vec3, WeaponDef } from '../src/core/types';

// ---------------------------------------------------------------------------
// Synthetic map
// ---------------------------------------------------------------------------

/**
 * Nav layout: a 5x5 grid at 256-unit spacing, index === node id.
 *
 *   z
 *  1024 | 20(B) 21  22  23  24(A)
 *   768 | 15    16  17  18  19
 *   512 | 10    11  12* 13  14      (* = choke)
 *   256 |  5     6   7   8   9
 *     0 |  0(T)  1   2   3   4
 *      +----------------------- x
 *          0   256 512 768 1024
 */
const GRID_ROUTES: readonly (readonly number[])[] = [
  [1, 5], [0, 2, 6], [1, 3, 7], [2, 4, 8], [3, 9],
  [0, 6, 10], [1, 5, 7, 11], [2, 6, 8, 12], [3, 7, 9, 13], [4, 8, 14],
  [5, 11, 15], [6, 10, 12, 16], [7, 11, 13, 17], [8, 12, 14, 18], [9, 13, 19],
  [10, 16, 20], [11, 15, 17, 21], [12, 16, 18, 22], [13, 17, 19, 23], [14, 18, 24],
  [15, 21], [16, 20, 22], [17, 21, 23], [18, 22, 24], [19, 23],
];

/** The node at grid column `x`, row `z` (both 0..4). */
function nodeId(col: number, row: number): number {
  return row * 5 + col;
}

/** World position of a grid cell. */
function nodePos(col: number, row: number): Vec3 {
  return { x: col * 256, y: 0, z: row * 256 };
}

/** Area label for a grid cell, used by the graph's area bookkeeping. */
function areaOf(col: number, row: number): string {
  if (row === 0) return 'T';
  if (row === 4 && col >= 3) return 'ASite';
  if (row === 0 && col >= 4) return 'BSite';
  if (row >= 3) return 'CT';
  return col >= 3 ? 'BSite' : 'Mid';
}

/** Build the synthetic map. `extraBrushes` are appended after the ground plane. */
function makeMap(extraBrushes: Brush[] = []): MapData {
  const nav: NavNode[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      const id = nodeId(col, row);
      const node: NavNode = {
        id,
        pos: nodePos(col, row),
        links: [...GRID_ROUTES[id]],
        area: areaOf(col, row),
      };
      // One choke in the middle of the map, and one node per bomb site.
      if (id === nodeId(2, 2)) node.choke = true;
      if (id === nodeId(4, 4)) node.site = 'A';
      if (id === nodeId(0, 4)) node.site = 'B';
      nav.push(node);
    }
  }

  // Ground: brushes are centre + size, so the top face sits at -472 + 400 = -72.
  // Actor feet are at y = -64 and the low rays in these tests are at y = -18, so
  // everything stays clear of the floor without the eye-to-eye ray at y = 0
  // grazing a face and registering a spurious hit at distance 0.
  const ground: Brush = {
    id: 9000,
    pos: { x: 0, y: -472, z: 0 },
    size: { x: 2800, y: 800, z: 2800 },
    yaw: 0,
    material: 'concrete',
  };

  return {
    name: 'bot_test_grid',
    bounds: { min: { x: -1400, y: -64, z: -1400 }, max: { x: 1400, y: 400, z: 1400 } },
    brushes: [ground, ...extraBrushes],
    spawns: [
      { pos: { x: 0, y: 0, z: 0 }, yaw: 0, team: 'T', index: 0 },
      { pos: { x: 1024, y: 0, z: 1024 }, yaw: Math.PI, team: 'CT', index: 0 },
    ],
    nav,
    sites: [
      { site: 'A', poly: [[900, 900], [1150, 900], [1150, 1150], [900, 1150]], y: 0, spots: [nodePos(4, 4)] },
      { site: 'B', poly: [[-100, 900], [150, 900], [150, 1150], [-100, 1150]], y: 0, spots: [nodePos(0, 4)] },
    ],
    callouts: { A: nodePos(4, 4), B: nodePos(0, 4), Mid: nodePos(2, 2) },
    radar: { originX: 0, originZ: 0, scale: 0.1 },
    buyZones: [{ team: 'T', min: { x: -300, y: -64, z: -300 }, max: { x: 300, y: 400, z: 300 } }],
  };
}

/** The exact same nav, but with nothing but a single node (degenerate-graph tests). */
function makeSingleNodeMap(): MapData {
  const map = makeMap();
  map.nav = [{ id: 0, pos: { x: 0, y: 0, z: 0 }, links: [], area: 'Mid' }];
  return map;
}

/** A chest-height wall centred on the +X axis, wide and tall enough to block. */
function blockingWall(atX: number, thickness = 64, width = 400, height = 200): Brush {
  return {
    id: 8000 + atX,
    pos: { x: atX, y: 0, z: 0 },
    size: { x: thickness, y: height, z: width },
    yaw: 0,
    material: 'concrete',
  };
}

// ---------------------------------------------------------------------------
// Actors and contexts
// ---------------------------------------------------------------------------

/** Minimal but complete `ActorState`, with feet at y = -64 (so the eye is at y = 0). */
function makeActor(overrides: Partial<ActorState> = {}): ActorState {
  return {
    id: 1,
    name: 'bot',
    team: 'T',
    isBot: true,
    pos: { x: 0, y: -64, z: 0 },
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
    ...overrides,
  };
}

/** Empty objective used when a test does not care about the strategy layer. */
function noObjective(): BotObjective {
  return { kind: 'attack', goalNode: -1, site: null };
}

function makeObjective(kind: BotObjective['kind'], site: BotObjective['site'] = null, goalNode = -1): BotObjective {
  return { kind, site, goalNode };
}

interface ContextOptions {
  self?: ActorState;
  actors?: ActorState[];
  team?: Team;
  weapon?: WeaponDef;
  ammo?: number;
  reserve?: number;
  magazineFull?: boolean;
  reloading?: boolean;
  canShoot?: boolean;
  now?: number;
  objective?: BotObjective;
  map?: MapData;
  memory?: BotContext['memory'];
  follower?: BotContext['follower'];
}

interface Built {
  ctx: BotContext;
  nav: NavGraph;
  world: World;
}

/** Build a complete `BotContext` over a fresh world/graph. */
function makeContext(options: ContextOptions = {}): Built {
  const map = options.map ?? makeMap();
  const world = new World(map);
  const nav = new NavGraph(map);
  nav.attachWorld(world);
  const self = options.self ?? makeActor();
  const ctx: BotContext = {
    self,
    actors: options.actors ?? [],
    team: options.team ?? self.team,
    weapon: options.weapon ?? AK47,
    ammo: options.ammo ?? 30,
    reserve: options.reserve ?? 30,
    magazineFull: options.magazineFull ?? true,
    reloading: options.reloading ?? false,
    canShoot: options.canShoot ?? true,
    now: options.now ?? 0,
    nav,
    world,
    memory: options.memory ?? createBotMemory(),
    follower: options.follower ?? null,
    objective: options.objective ?? noObjective(),
    cmd: createBotCommand(),
  };
  return { ctx, nav, world };
}

/** The bot's eye position (feet at y = -64, standing). */
const BOT_EYE: Vec3 = { x: 0, y: 0, z: 0 };

/** The bot's chest position for the helper bot above (height 72, band centre 0.76). */
const BOT_CHEST: Vec3 = { x: 0, y: -64 + 72 * 0.76, z: 0 };

/** Drive one think tick directly, advancing `ctx.now`. */
function tick(built: Built, senses: BotSenses, skill: BotSkill, rng: Rng, now: number): void {
  built.ctx.now = now;
  perceive(built.ctx, senses, skill, rng);
  think(built.ctx, senses, skill, rng);
}

// ---------------------------------------------------------------------------
// aimAngles
// ---------------------------------------------------------------------------

describe('aimAngles', () => {
  const origin: Vec3 = { x: 0, y: 0, z: 0 };

  it('points forward along +X for a target on +X', () => {
    const { yaw, pitch } = aimAngles(origin, { x: 100, y: 0, z: 0 });
    // anglesTo uses atan2(-dx, -dz): +X is yaw = -PI/2 (the CS convention where
    // yaw 0 looks down -Z).
    expect(yaw).toBeCloseTo(-Math.PI / 2, 10);
    expect(pitch).toBeCloseTo(0, 10);
    const dir = angleToDirSafe(yaw, pitch);
    expect(dir.x).toBeCloseTo(1, 10);
    expect(dir.y).toBeCloseTo(0, 10);
    expect(dir.z).toBeCloseTo(0, 10);
  });

  it('clamps a straight-up target to the camera pitch limit', () => {
    const { yaw, pitch } = aimAngles(origin, { x: 0, y: 100, z: 0 });
    expect(Number.isFinite(yaw)).toBe(true);
    expect(pitch).toBeCloseTo(CAMERA.maxPitch, 10);
    expect(Math.abs(pitch)).toBeLessThan(Math.PI / 2);
    expect(pitch * (180 / Math.PI)).toBeLessThan(89.0001);
  });

  it('points backward along -X', () => {
    const { yaw, pitch } = aimAngles(origin, { x: -100, y: 0, z: 0 });
    expect(yaw).toBeCloseTo(Math.PI / 2, 10);
    const dir = angleToDirSafe(yaw, pitch);
    expect(dir.x).toBeCloseTo(-1, 10);
  });

  it('round-trips +Z and produces a finite yaw', () => {
    const { yaw, pitch } = aimAngles(origin, { x: 0, y: 0, z: 100 });
    expect(Number.isFinite(yaw)).toBe(true);
    expect(pitch).toBeCloseTo(0, 10);
    const dir = angleToDirSafe(yaw, pitch);
    expect(dir.x).toBeCloseTo(0, 10);
    expect(dir.z).toBeCloseTo(1, 10);
  });

  it('round-trips an arbitrary direction within the pitch limit', () => {
    for (const target of [
      { x: 100, y: 100, z: 0 },
      { x: 100, y: -100, z: 0 },
      { x: -50, y: 20, z: 300 },
      { x: 0, y: -0.001, z: -400 },
    ]) {
      const { yaw, pitch } = aimAngles(origin, target);
      expect(Number.isFinite(yaw)).toBe(true);
      expect(Number.isFinite(pitch)).toBe(true);
      expect(Math.abs(pitch)).toBeLessThanOrEqual(CAMERA.maxPitch + 1e-12);
      const dir = angleToDirSafe(yaw, pitch);
      const len = Math.hypot(target.x, target.y, target.z);
      expect(dir.x).toBeCloseTo(target.x / len, 8);
      expect(dir.y).toBeCloseTo(target.y / len, 8);
      expect(dir.z).toBeCloseTo(target.z / len, 8);
    }
  });

  it('is deterministic for identical input', () => {
    const a = aimAngles({ x: 1, y: 2, z: 3 }, { x: 400, y: 12, z: -77 });
    const b = aimAngles({ x: 1, y: 2, z: 3 }, { x: 400, y: 12, z: -77 });
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// preferredRange
// ---------------------------------------------------------------------------

describe('preferredRange', () => {
  it('orders sniper > rifle > smg > shotgun', () => {
    const sniper = preferredRange(AWP);
    const rifle = preferredRange(AK47);
    const smg = preferredRange(MP9);
    const shotgun = preferredRange(NOVA);
    expect(sniper).toBeGreaterThan(shotgun);
    expect(rifle).toBeGreaterThan(smg);
    expect(smg).toBeGreaterThan(shotgun);
    expect(sniper).toBeGreaterThan(rifle);
  });

  it('never returns a non-positive range for a broken weapon', () => {
    const broken = { ...AK47, effectiveRange: 0 } as WeaponDef;
    expect(preferredRange(broken)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// sprayCompensation
// ---------------------------------------------------------------------------

describe('sprayCompensation', () => {
  const expert: BotSkill = { ...BOT_SKILLS.expert };

  it('returns exactly zero for the first shot of a burst', () => {
    // Every real pattern has a non-zero punch at index 0 (AK-47 = 0.55 degrees up),
    // so this is the interesting case: nothing has kicked yet, so nothing is
    // compensated.
    expect(patternAt(AK47_PATTERN, 0).y).not.toBe(0);
    expect(sprayCompensation(AK47, 0, expert)).toEqual({ yaw: 0, pitch: 0 });
    expect(sprayCompensation(AK47, -3, expert)).toEqual({ yaw: 0, pitch: 0 });
  });

  it('opposes the pattern punch once the spray is running', () => {
    for (const shot of [1, 3, 6, 9, 14, 20]) {
      const punch = patternAt(AK47_PATTERN, shot - 1);
      const comp = sprayCompensation(AK47, shot, expert);
      // The compensation is the negative of the punch, scaled by sprayControl.
      expect(Math.sign(comp.yaw)).toBe(-Math.sign(punch.x));
      expect(Math.sign(comp.pitch)).toBe(-Math.sign(punch.y));
      expect(comp.pitch).toBeLessThan(0); // the gun climbs, so the bot pulls down
      expect(Math.abs(comp.pitch)).toBeCloseTo(Math.abs(punch.y) * expert.sprayControl, 10);
    }
  });

  it('gives exactly zero when sprayControl is 0', () => {
    const hopeless: BotSkill = { ...expert, sprayControl: 0 };
    for (const shot of [0, 1, 5, 12, 29, 100]) {
      expect(sprayCompensation(AK47, shot, hopeless)).toEqual({ yaw: 0, pitch: 0 });
    }
  });

  it('scales compensation with sprayControl', () => {
    const low: BotSkill = { ...expert, sprayControl: 0.25 };
    const high: BotSkill = { ...expert, sprayControl: 1 };
    const a = sprayCompensation(M4A4, 8, low).pitch;
    const b = sprayCompensation(M4A4, 8, high).pitch;
    expect(Math.abs(a)).toBeLessThan(Math.abs(b));
    expect(Math.abs(b / a)).toBeCloseTo(4, 6);
  });

  it('never returns NaN for absurd indices', () => {
    for (const shot of [Number.NaN, Number.POSITIVE_INFINITY, 1e9, -1e9]) {
      const comp = sprayCompensation(AK47, shot, expert);
      expect(Number.isFinite(comp.yaw)).toBe(true);
      expect(Number.isFinite(comp.pitch)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// perceive
// ---------------------------------------------------------------------------

describe('perceive', () => {
  const skill = BOT_SKILLS.normal;

  it('sees an enemy with clear line of sight and targets it', () => {
    const bot = makeActor({ id: 1, pos: { x: 0, y: -64, z: 0 } });
    const enemy = makeActor({ id: 2, team: 'CT', pos: { x: 800, y: -64, z: 0 } });
    const { ctx } = makeContext({ self: bot, actors: [enemy] });
    const senses = createBotSenses();
    const rng = new Rng(1);

    perceive(ctx, senses, skill, rng);

    expect(senses.visibleEnemies.length).toBe(1);
    expect(senses.visibleEnemies[0].id).toBe(2);
    expect(senses.targetId).toBe(2);
    expect(senses.lastKnownEnemyPos).not.toBeNull();
    expect(senses.timeSinceSeen).toBe(0);
    const contact = ctx.memory.contacts.get(2);
    expect(contact).toBeDefined();
    // Contacts are remembered at chest height, not at the feet.
    expect(contact!.pos.y).toBeGreaterThan(bot.pos.y);
    expect(contact!.time).toBe(0);
  });

  it('does not see an enemy behind a wall', () => {
    const bot = makeActor({ id: 1, pos: { x: 0, y: -64, z: 0 } });
    const enemy = makeActor({ id: 2, team: 'CT', pos: { x: 600, y: -64, z: 0 } });
    const { ctx, world } = makeContext({ self: bot, actors: [enemy], map: makeMap([blockingWall(300)]) });

    // Sanity-check the fixture itself: the wall really is on the eye-to-eye line.
    const eye = { x: 0, y: 0, z: 0 };
    const otherEye = { x: 600, y: 0, z: 0 };
    expect(world.isVisible(eye, otherEye)).toBe(false);

    const senses = createBotSenses();
    perceive(ctx, senses, skill, new Rng(1));
    expect(senses.visibleEnemies.length).toBe(0);
    expect(senses.targetId).toBe(-1);
    expect(ctx.memory.contacts.size).toBe(0);
  });

  it('never targets a teammate, and ignores dead actors', () => {
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 0, y: -64, z: 0 } });
    const mate = makeActor({ id: 2, team: 'T', pos: { x: 200, y: -64, z: 0 } });
    const corpse = makeActor({ id: 3, team: 'CT', alive: false, pos: { x: 300, y: -64, z: 0 } });
    const { ctx } = makeContext({ self: bot, actors: [mate, corpse] });
    const senses = createBotSenses();

    perceive(ctx, senses, skill, new Rng(1));

    expect(senses.visibleEnemies.length).toBe(0);
    expect(senses.targetId).toBe(-1);
    expect(ctx.memory.contacts.size).toBe(0);
  });

  it('picks the most dangerous visible enemy deterministically', () => {
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 0, y: -64, z: 0 } });
    const healthy = makeActor({ id: 7, team: 'CT', health: 100, pos: { x: 300, y: -64, z: 0 } });
    const hurt = makeActor({ id: 9, team: 'CT', health: 20, pos: { x: 900, y: -64, z: 0 } });
    const { ctx } = makeContext({ self: bot, actors: [healthy, hurt] });
    const senses = createBotSenses();

    perceive(ctx, senses, skill, new Rng(1));
    // Lowest health wins even though it is farther away.
    expect(senses.targetId).toBe(9);

    // Two identical enemies: the lower actor id breaks the tie.
    const a = makeActor({ id: 4, team: 'CT', health: 100, pos: { x: 400, y: -64, z: 0 } });
    const b = makeActor({ id: 5, team: 'CT', health: 100, pos: { x: 400, y: -64, z: 20 } });
    const second = makeContext({ self: bot, actors: [b, a] });
    const secondSenses = createBotSenses();
    perceive(second.ctx, secondSenses, skill, new Rng(1));
    expect(secondSenses.targetId).toBe(4);
  });

  it('ages contacts out after 6 seconds and reports the time since last seen', () => {
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 0, y: -64, z: 0 } });
    const enemy = makeActor({ id: 2, team: 'CT', pos: { x: 800, y: -64, z: 0 } });
    const { ctx } = makeContext({ self: bot, actors: [enemy] });
    const senses = createBotSenses();
    const rng = new Rng(1);

    ctx.now = 0;
    perceive(ctx, senses, skill, rng);
    expect(senses.targetId).toBe(2);
    expect(ctx.memory.contacts.size).toBe(1);

    // Five seconds in, the enemy is STILL visible, so the clock keeps resetting.
    ctx.now = 5;
    perceive(ctx, senses, skill, rng);
    expect(ctx.memory.contacts.size).toBe(1);
    expect(senses.timeSinceSeen).toBe(0);
    expect(senses.visibleEnemies.length).toBe(1);

    // The enemy breaks off. Two seconds later the sighting is stale but remembered:
    // 6 seconds is the memory window, not a tick timeout.
    ctx.actors = [];
    ctx.now = 7;
    perceive(ctx, senses, skill, rng);
    expect(ctx.memory.contacts.size).toBe(1);
    expect(senses.timeSinceSeen).toBe(2);
    expect(senses.targetId).toBe(2);
    expect(senses.lastKnownEnemyPos).not.toBeNull();

    // Past the window the contact ages out and the bot forgets where the enemy was.
    ctx.now = 12;
    perceive(ctx, senses, skill, rng);
    expect(ctx.memory.contacts.size).toBe(0);
    expect(senses.visibleEnemies.length).toBe(0);
    expect(senses.targetId).toBe(-1);
    expect(senses.lastKnownEnemyPos).toBeNull();
    expect(senses.timeSinceSeen).toBe(7); // last seen at t = 5
  });

  it('survives a missing enemy list and does not throw', () => {
    const { ctx } = makeContext({ self: makeActor(), actors: [] });
    const senses = createBotSenses();
    expect(() => perceive(ctx, senses, skill, new Rng(1))).not.toThrow();
    expect(senses.targetId).toBe(-1);
    expect(senses.timeSinceSeen).toBe(Number.POSITIVE_INFINITY);
  });
});

// ---------------------------------------------------------------------------
// chooseGoal
// ---------------------------------------------------------------------------

describe('chooseGoal', () => {
  const skill = BOT_SKILLS.normal;
  const rng = () => new Rng(7);

  it('sends a CT onto a planted bomb to defuse', () => {
    const bot = makeActor({ id: 1, team: 'CT', pos: { x: 512, y: 0, z: -256 } });
    const { ctx } = makeContext({
      self: bot,
      team: 'CT',
      objective: makeObjective('post_plant', 'B'),
    });
    const senses = createBotSenses();
    senses.bombPlanted = true;
    senses.bombPos = { x: 512, y: 0, z: -256 };
    expect(chooseGoal(ctx, senses, skill, rng())).toBe('defuse');
  });

  it('makes a T holding the bomb inside the A site plant it', () => {
    const bot = makeActor({ id: 1, team: 'T', hasBomb: true, pos: { x: 1024, y: 0, z: 1024 } });
    const { ctx } = makeContext({
      self: bot,
      objective: makeObjective('attack', 'A', nodeId(4, 4)),
    });
    const senses = createBotSenses();
    // Site membership is the game layer's exact polygon test, not a nav approximation.
    senses.insideSite = true;
    expect(chooseGoal(ctx, senses, skill, rng())).toBe('plant');
  });

  it('does not commit to a plant while standing just outside the site polygon', () => {
    // The carrier that "arrives" a few units short of the polygon must keep advancing:
    // committing to 'plant' there stops it dead and the plant progress never starts,
    // because `tryPlant` looks up the site under the carrier and finds none.
    const bot = makeActor({ id: 1, team: 'T', hasBomb: true, pos: { x: 1024, y: 0, z: 1024 } });
    const { ctx } = makeContext({
      self: bot,
      objective: makeObjective('attack', 'A', nodeId(4, 4)),
    });
    const senses = createBotSenses();
    senses.insideSite = false;
    expect(chooseGoal(ctx, senses, skill, rng())).toBe('advance');
  });

  it('advances on a visible enemy', () => {
    const bot = makeActor({ id: 1, pos: { x: 0, y: -64, z: 0 } });
    const enemy = makeActor({ id: 2, team: 'CT', pos: { x: 700, y: -64, z: 0 } });
    const { ctx } = makeContext({ self: bot, actors: [enemy], objective: makeObjective('defend', 'A') });
    const senses = createBotSenses();
    perceive(ctx, senses, skill, rng());
    const goal = chooseGoal(ctx, senses, skill, rng());
    expect(['advance', 'push', 'retreat']).toContain(goal);
    expect(goal === 'advance').toBe(true);
  });

  it('holds when defending with no information', () => {
    const bot = makeActor({ id: 1, team: 'CT', pos: { x: 512, y: 0, z: 512 } });
    const { ctx } = makeContext({
      self: bot,
      team: 'CT',
      objective: makeObjective('defend', 'A', nodeId(2, 2)),
    });
    const senses = createBotSenses();
    expect(chooseGoal(ctx, senses, skill, rng())).toBe('hold');
  });

  it('keeps planting when a distant enemy is visible', () => {
    // A carrier that breaks off at every visible enemy never plants, and a T round
    // without a plant is a lost round: the objective action outranks a distant
    // firefight. The fire logic still shoots while planting — the goal only decides
    // whether the bot walks to the objective or at the enemy.
    const bot = makeActor({ id: 1, team: 'T', hasBomb: true, pos: { x: 0, y: -64, z: 0 } });
    const enemy = makeActor({ id: 2, team: 'CT', pos: { x: 900, y: -64, z: 0 } });
    const { ctx } = makeContext({
      self: bot,
      actors: [enemy],
      objective: makeObjective('attack', 'A', nodeId(4, 4)),
    });
    const senses = createBotSenses();
    perceive(ctx, senses, skill, rng());
    senses.insideSite = true;
    expect(senses.visibleEnemies.length).toBe(1);
    expect(chooseGoal(ctx, senses, skill, rng())).toBe('plant');
  });

  it('fights first when the enemy is in its face', () => {
    // Inside PLANT_THREAT_DISTANCE the enemy can be on top of the bot before a 3.2 s
    // plant completes, so the firefight wins for once.
    const bot = makeActor({ id: 1, team: 'T', hasBomb: true, pos: { x: 0, y: -64, z: 0 } });
    const enemy = makeActor({ id: 2, team: 'CT', pos: { x: 200, y: -64, z: 0 } });
    const { ctx } = makeContext({
      self: bot,
      actors: [enemy],
      objective: makeObjective('attack', 'A', nodeId(4, 4)),
    });
    const senses = createBotSenses();
    perceive(ctx, senses, skill, rng());
    senses.insideSite = true;
    expect(chooseGoal(ctx, senses, skill, rng())).toBe('advance');
  });

  it('retreats when hurt and out of its weapon range', () => {
    const bot = makeActor({ id: 1, team: 'T', health: 12, pos: { x: 0, y: -64, z: 0 } });
    const enemy = makeActor({ id: 2, team: 'CT', pos: { x: 3000, y: -64, z: 0 } });
    const { ctx } = makeContext({
      self: bot,
      actors: [enemy],
      weapon: weaponById('mp9') ?? AK47,
    });
    const senses = createBotSenses();
    const rng = new Rng(2);
    perceive(ctx, senses, skill, rng);
    expect(senses.visibleEnemies.length).toBe(1);

    // A disengage needs the reaction time to have elapsed first: shooting back is
    // only abandoned once the bot has actually registered the threat.
    ctx.now = skill.reactionTime + 0.1;
    perceive(ctx, senses, skill, rng);
    expect(chooseGoal(ctx, senses, skill, rng)).toBe('retreat');
  });

  it('investigates a fresh sound when nothing is visible', () => {
    const bot = makeActor({ id: 1, team: 'CT', pos: { x: 512, y: 0, z: 512 } });
    const { ctx } = makeContext({ self: bot, team: 'CT', objective: makeObjective('defend', 'A') });
    const senses = createBotSenses();
    senses.heardAt = { x: 1024, y: 0, z: 1024 };
    expect(chooseGoal(ctx, senses, skill, rng())).toBe('investigate');
  });

  it('treats a moving objective node as a rotation', () => {
    const bot = makeActor({ id: 1, team: 'CT', pos: { x: 512, y: 0, z: 512 } });
    const { ctx } = makeContext({ self: bot, team: 'CT', objective: makeObjective('defend', 'A', nodeId(4, 4)) });
    const senses = createBotSenses();
    // The bot was pathing to the B site and now the team calls the A site.
    ctx.memory.pathGoalNode = nodeId(0, 4);
    expect(chooseGoal(ctx, senses, skill, rng())).toBe('rotate');
  });

  it('does not flip goals inside the hysteresis window', () => {
    const bot = makeActor({ id: 1, team: 'CT', pos: { x: 512, y: 0, z: 512 } });
    const enemy = makeActor({ id: 2, team: 'T', pos: { x: 600, y: -64, z: 512 } });
    const { ctx } = makeContext({ self: bot, team: 'CT', objective: makeObjective('defend', 'A') });
    const senses = createBotSenses();
    const realRng = new Rng(3);

    ctx.now = 0;
    expect(chooseGoal(ctx, senses, skill, realRng)).toBe('hold');

    // Same inputs but an enemy now visible, one second later: the window holds the
    // original decision.
    ctx.actors = [enemy];
    ctx.now = 1;
    perceive(ctx, senses, skill, realRng);
    expect(senses.visibleEnemies.length).toBe(1);
    expect(chooseGoal(ctx, senses, skill, realRng)).toBe('hold');

    // Past the window the new information wins.
    ctx.now = 2.2;
    perceive(ctx, senses, skill, realRng);
    expect(chooseGoal(ctx, senses, skill, realRng)).toBe('advance');
  });

  it('is deterministic for the same inputs', () => {
    const build = () => {
      const bot = makeActor({ id: 1, team: 'T', hasBomb: true, pos: { x: 256, y: 0, z: 256 } });
      const { ctx } = makeContext({ self: bot, objective: makeObjective('attack', 'A', nodeId(2, 2)) });
      return ctx;
    };
    const a = build();
    const b = build();
    const ga = chooseGoal(a, createBotSenses(), skill, new Rng(11));
    const gb = chooseGoal(b, createBotSenses(), skill, new Rng(11));
    expect(ga).toBe(gb);
  });
});

// ---------------------------------------------------------------------------
// think — aim, reaction, fire discipline
// ---------------------------------------------------------------------------

describe('think — engagement', () => {
  it('does not fire before the reaction time, then fires once it elapses', () => {
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 0, y: -64, z: 0 } });
    const enemy = makeActor({ id: 2, team: 'CT', pos: { x: 800, y: -64, z: 0 } });
    const built = makeContext({ self: bot, actors: [enemy], weapon: AK47 });
    const senses = createBotSenses();
    const rng = new Rng(5);
    const skill = BOT_SKILLS.expert;

    // First sighting: the reaction clock starts here and no shot is taken.
    tick(built, senses, skill, rng, 0);
    expect(senses.visibleEnemies.length).toBe(1);
    expect(built.ctx.cmd.buttons.attack).toBe(false);

    // Still inside the reaction window.
    tick(built, senses, skill, rng, skill.reactionTime * 0.5);
    expect(built.ctx.cmd.buttons.attack).toBe(false);

    // Well past it, with the aim settled, the shot goes out.
    tick(built, senses, skill, rng, 0.5);
    expect(built.ctx.cmd.buttons.attack).toBe(true);
    expect(Number.isFinite(built.ctx.cmd.yaw)).toBe(true);
    expect(Number.isFinite(built.ctx.cmd.pitch)).toBe(true);

    // Aim really is on the enemy: the yaw matches the exact angle to the target.
    const want = aimAngles(BOT_EYE, { x: 800, y: -64 + 72 * 0.94, z: 0 });
    expect(Math.abs(built.ctx.cmd.yaw - want.yaw)).toBeLessThan(0.09);
    expect(Math.abs(built.ctx.cmd.pitch - want.pitch)).toBeLessThan(0.09);
  });

  it('requests a reload instead of firing with an empty magazine', () => {
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 0, y: -64, z: 0 } });
    const enemy = makeActor({ id: 2, team: 'CT', pos: { x: 500, y: -64, z: 0 } });
    const built = makeContext({ self: bot, actors: [enemy], ammo: 0, magazineFull: false });
    const senses = createBotSenses();
    const rng = new Rng(5);
    const skill = BOT_SKILLS.expert;

    tick(built, senses, skill, rng, 0);
    tick(built, senses, skill, rng, 0.5);
    expect(built.ctx.cmd.buttons.attack).toBe(false);
    expect(built.ctx.cmd.buttons.reload).toBe(true);
  });

  it('switches to the knife when magazine and reserve are both empty', () => {
    // A dry bot cannot shoot and a reload is a no-op, so requesting one leaves it
    // standing until the round ends — observed in a real match as the bomb carrier
    // holding `deagle 0/0` on the A site and never planting. The knife cannot win a
    // duel, but the bot can still walk the objective and plant or defuse.
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 0, y: -64, z: 0 } });
    const enemy = makeActor({ id: 2, team: 'CT', pos: { x: 500, y: -64, z: 0 } });
    const built = makeContext({ self: bot, actors: [enemy], ammo: 0, reserve: 0, magazineFull: false });
    const senses = createBotSenses();
    const rng = new Rng(5);
    const skill = BOT_SKILLS.expert;

    tick(built, senses, skill, rng, 0);
    tick(built, senses, skill, rng, 0.5);
    expect(built.ctx.cmd.buttons.attack).toBe(false);
    expect(built.ctx.cmd.buttons.reload).toBe(false);
    expect(built.ctx.cmd.buttons.slot3).toBe(true);
  });

  it('does not shoot through a teammate standing in front of it', () => {
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 0, y: -64, z: 0 } });
    const mate = makeActor({ id: 3, team: 'T', pos: { x: 100, y: -64, z: 0 } });
    const enemy = makeActor({ id: 2, team: 'CT', pos: { x: 800, y: -64, z: 0 } });
    const built = makeContext({ self: bot, actors: [mate, enemy], weapon: AK47 });
    const senses = createBotSenses();
    const rng = new Rng(5);
    const skill = BOT_SKILLS.expert;

    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      tick(built, senses, skill, rng, t);
      expect(built.ctx.cmd.buttons.attack).toBe(false);
    }
    // The enemy was genuinely visible the whole time — it is the teammate, not LOS.
    expect(senses.visibleEnemies.length).toBe(1);
    expect(senses.targetId).toBe(2);
  });

  it('does not shoot an enemy behind chest-height cover', () => {
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 0, y: -64, z: 0 } });
    const enemy = makeActor({ id: 2, team: 'CT', pos: { x: 600, y: -64, z: 0 } });
    // The bot is crouched (eye at y = -18) so the eye-to-eye ray clears the wall,
    // while the chest-height ray does not: visible, but not shootable.
    const crouched = makeActor({ id: 1, team: 'T', duckAmount: 1, crouching: true, pos: { x: 0, y: -64, z: 0 } });
    const built = makeContext({ self: crouched, actors: [enemy], map: makeMap([blockingWall(300)]) });
    const senses = createBotSenses();
    const rng = new Rng(5);
    const skill = BOT_SKILLS.expert;

    // Sanity: the wall spans y ∈ [-100, 100] and x = 300, so the eye at y = -18 is
    // below it while the chest at y ≈ -9 is behind it.
    expect(built.world.isVisible({ x: 0, y: -18, z: 0 }, { x: 600, y: -18, z: 0 })).toBe(false);
    expect(bot.pos.x).toBe(0);

    for (const t of [0, 0.3, 0.6, 1.0]) tick(built, senses, skill, rng, t);
    expect(built.ctx.cmd.buttons.attack).toBe(false);
  });

  it('keeps yaw and pitch finite across a long engagement', () => {
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 0, y: -64, z: 0 } });
    const enemy = makeActor({ id: 2, team: 'CT', pos: { x: 400, y: -64, z: 400 } });
    const built = makeContext({ self: bot, actors: [enemy] });
    const senses = createBotSenses();
    const rng = new Rng(9);
    for (let i = 0; i < 120; i++) {
      tick(built, senses, BOT_SKILLS.hard, rng, i / 64);
      expect(Number.isFinite(built.ctx.cmd.yaw)).toBe(true);
      expect(Number.isFinite(built.ctx.cmd.pitch)).toBe(true);
      expect(Math.abs(built.ctx.cmd.pitch)).toBeLessThanOrEqual(CAMERA.maxPitch + 1e-9);
    }
  });
});

// ---------------------------------------------------------------------------
// think — movement
// ---------------------------------------------------------------------------

describe('think — movement', () => {
  it('presses movement buttons toward a distant objective and mutates cmd in place', () => {
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 0, y: 0, z: 0 } });
    const built = makeContext({
      self: bot,
      objective: makeObjective('attack', 'A', nodeId(4, 4)),
    });
    const senses = createBotSenses();
    const rng = new Rng(2);
    const cmd = built.ctx.cmd;
    const buttons = cmd.buttons;

    for (let i = 0; i < 10; i++) tick(built, senses, BOT_SKILLS.normal, rng, i / 128);

    const moved = buttons.forward || buttons.back || buttons.left || buttons.right;
    expect(moved).toBe(true);
    // The command object and its button object are the caller's, mutated in place.
    expect(built.ctx.cmd).toBe(cmd);
    expect(built.ctx.cmd.buttons).toBe(buttons);
  });

  it('stops moving while planting', () => {
    const bot = makeActor({ id: 1, team: 'T', hasBomb: true, pos: { x: 1024, y: 0, z: 1024 } });
    const built = makeContext({ self: bot, objective: makeObjective('attack', 'A', nodeId(4, 4)) });
    const senses = createBotSenses();
    senses.insideSite = true;
    const rng = new Rng(2);

    tick(built, senses, BOT_SKILLS.normal, rng, 0);
    expect(built.ctx.cmd.buttons.use).toBe(true);
    expect(built.ctx.cmd.buttons.forward).toBe(false);
    expect(built.ctx.cmd.buttons.back).toBe(false);
    expect(built.ctx.cmd.buttons.left).toBe(false);
    expect(built.ctx.cmd.buttons.right).toBe(false);
  });

  it('stops moving while defusing a planted bomb', () => {
    const bot = makeActor({ id: 1, team: 'CT', hasDefuseKit: true, pos: { x: 1024, y: 0, z: -256 } });
    const built = makeContext({ self: bot, team: 'CT', objective: makeObjective('post_plant', 'B') });
    const senses = createBotSenses();
    senses.bombPlanted = true;
    senses.bombPos = { x: 1024, y: 0, z: -256 };
    const rng = new Rng(2);

    tick(built, senses, BOT_SKILLS.normal, rng, 0);
    expect(built.ctx.cmd.buttons.use).toBe(true);
    expect(built.ctx.cmd.buttons.forward || built.ctx.cmd.buttons.back).toBe(false);
  });

  it('walks (shift) while approaching a nearby choke', () => {
    // Node 12 at (512, 512) is the choke. Standing ON a choke is the unambiguous
    // case: `nearbyChoke` measures to the nearest nav node, so any offset position
    // risks being nearer to a plain neighbour and reading the choke as absent.
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 512, y: 0, z: 512 } });
    const built = makeContext({
      self: bot,
      objective: makeObjective('attack', 'A', nodeId(4, 4)),
    });
    const senses = createBotSenses();
    const rng = new Rng(2);
    for (let i = 0; i < 5; i++) tick(built, senses, BOT_SKILLS.normal, rng, i / 128);
    expect(built.ctx.cmd.buttons.walk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pickGoalNode
// ---------------------------------------------------------------------------

describe('pickGoalNode', () => {
  const kinds: BotObjective['kind'][] = ['attack', 'defend', 'retake', 'post_plant', 'hunt'];

  it('always returns an in-range node id or -1, for every objective kind', () => {
    for (const kind of kinds) {
      for (const site of [null, 'A', 'B'] as const) {
        for (const goalNode of [-1, 0, 24]) {
          const bot = makeActor({ id: 1, pos: { x: 512, y: 0, z: 512 } });
          const { ctx } = makeContext({ self: bot });
          const id = pickGoalNode(ctx, makeObjective(kind, site, goalNode), new Rng(1));
          expect(Number.isInteger(id)).toBe(true);
          expect(id === -1 || (id >= 0 && id < ctx.nav.nodes.length)).toBe(true);
        }
      }
    }
  });

  it('returns -1 on an empty graph', () => {
    const map = makeMap();
    map.nav = [];
    const bot = makeActor({ id: 1 });
    const { ctx } = makeContext({ self: bot, map });
    expect(pickGoalNode(ctx, makeObjective('attack', 'A', 3), new Rng(1))).toBe(-1);
  });

  it('prefers a choke node when defending', () => {
    const bot = makeActor({ id: 1, team: 'CT', pos: { x: 512, y: 0, z: 512 } });
    const { ctx, nav } = makeContext({ self: bot, team: 'CT' });
    const id = pickGoalNode(ctx, makeObjective('defend', 'A', nodeId(4, 4)), new Rng(1));
    expect(nav.chokeNodes()).toContain(id);
  });

  it('honours an explicit goal node', () => {
    const bot = makeActor({ id: 1 });
    const { ctx } = makeContext({ self: bot });
    expect(pickGoalNode(ctx, makeObjective('attack', null, 17), new Rng(1))).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// Determinism and robustness
// ---------------------------------------------------------------------------

describe('determinism', () => {
  /** Build a controller over an identical world for each run. */
  function makeController(seed: number): { controller: BotController; built: Built } {
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 0, y: 0, z: 0 } });
    const enemy = makeActor({ id: 2, team: 'CT', pos: { x: 700, y: 0, z: 200 } });
    const map = makeMap();
    const world = new World(map);
    const nav = new NavGraph(map);
    nav.attachWorld(world);
    const controller = new BotController({ id: 1, team: 'T', difficulty: 'hard', nav, world, seed });
    const built: Built = {
      nav,
      world,
      ctx: {
        self: bot,
        actors: [enemy],
        team: 'T',
        weapon: AK47,
        ammo: 30,
        reserve: 30,
        magazineFull: true,
        reloading: false,
        canShoot: true,
        now: 0,
        nav,
        world,
        memory: controller.memory,
        follower: null,
        objective: makeObjective('attack', 'A', nodeId(4, 4)),
        cmd: createBotCommand(),
      },
    };
    return { controller, built };
  }

  it('two identical contexts with identical seeds produce identical commands over 200 ticks', () => {
    const a = makeController(0xbeef);
    const b = makeController(0xbeef);
    const cmdA = createBotCommand();
    const cmdB = createBotCommand();

    for (let i = 0; i < 200; i++) {
      const now = i / 64;
      const enemyA = a.built.ctx.actors[0];
      const enemyB = b.built.ctx.actors[0];
      a.controller.update({
        self: a.built.ctx.self,
        actors: [enemyA],
        weapon: AK47,
        ammo: 30,
        reserve: 30,
        magazineFull: true,
        reloading: false,
        canShoot: true,
        now,
        objective: noObjective(),
        senses: { underFire: false, heardAt: null, bombPlanted: false, bombPos: null },
        cmd: cmdA,
      });
      b.controller.update({
        self: b.built.ctx.self,
        actors: [enemyB],
        weapon: AK47,
        ammo: 30,
        reserve: 30,
        magazineFull: true,
        reloading: false,
        canShoot: true,
        now,
        objective: noObjective(),
        senses: { underFire: false, heardAt: null, bombPlanted: false, bombPos: null },
        cmd: cmdB,
      });

      expect(cmdA.yaw).toBe(cmdB.yaw);
      expect(cmdA.pitch).toBe(cmdB.pitch);
      expect(cmdA.buttons).toEqual(cmdB.buttons);
      expect(a.controller.goal).toBe(b.controller.goal);
    }
    expect(cmdA.buttons.attack || cmdA.buttons.forward || cmdA.buttons.reload).toBe(true);
  });

  it('different seeds give a different reaction-time jitter but stay deterministic', () => {
    const one = makeController(1);
    const two = makeController(2);
    const three = makeController(1);
    expect(one.controller.skill.reactionTime).toBeCloseTo(three.controller.skill.reactionTime, 12);
    // Jitter is +/-20% around the preset; both draws stay in band.
    const base = BOT_SKILLS.hard.reactionTime;
    for (const c of [one.controller, two.controller]) {
      expect(c.skill.reactionTime).toBeGreaterThanOrEqual(base * 0.8 - 1e-12);
      expect(c.skill.reactionTime).toBeLessThanOrEqual(base * 1.2 + 1e-12);
    }
  });
});

describe('robustness', () => {
  it('survives a bot standing exactly on top of its target', () => {
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 100, y: -64, z: 100 } });
    const enemy = makeActor({ id: 2, team: 'CT', pos: { x: 100, y: -64, z: 100 } });
    const built = makeContext({ self: bot, actors: [enemy] });
    const senses = createBotSenses();
    const rng = new Rng(4);

    expect(() => {
      for (let i = 0; i < 20; i++) tick(built, senses, BOT_SKILLS.expert, rng, i / 128);
    }).not.toThrow();
    expect(Number.isFinite(built.ctx.cmd.yaw)).toBe(true);
    expect(Number.isFinite(built.ctx.cmd.pitch)).toBe(true);
  });

  it('survives a graph with a single node', () => {
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 0, y: 0, z: 0 } });
    const built = makeContext({ self: bot, map: makeSingleNodeMap() });
    const senses = createBotSenses();
    const rng = new Rng(4);
    expect(() => {
      for (let i = 0; i < 20; i++) tick(built, senses, BOT_SKILLS.normal, rng, i / 128);
    }).not.toThrow();
    expect(Number.isFinite(built.ctx.cmd.yaw)).toBe(true);
    expect(Number.isFinite(built.ctx.cmd.pitch)).toBe(true);
  });

  it('survives a null follower, zero ammo, and a null last-known position', () => {
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 0, y: 0, z: 0 } });
    const built = makeContext({ self: bot, followers: null, ammo: 0, magazineFull: false } as ContextOptions);
    const senses = createBotSenses();
    expect(built.ctx.follower).toBeNull();
    expect(() => tick(built, senses, BOT_SKILLS.normal, new Rng(4), 0)).not.toThrow();
    expect(Number.isFinite(built.ctx.cmd.yaw)).toBe(true);
    expect(Number.isFinite(built.ctx.cmd.pitch)).toBe(true);
  });

  it('produces finite angles when the bot is outside the navmesh', () => {
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 90000, y: 0, z: -90000 } });
    const built = makeContext({ self: bot, objective: makeObjective('attack', 'A', nodeId(4, 4)) });
    const senses = createBotSenses();
    expect(() => {
      for (let i = 0; i < 10; i++) tick(built, senses, BOT_SKILLS.easy, new Rng(4), i / 128);
    }).not.toThrow();
    expect(Number.isFinite(built.ctx.cmd.yaw)).toBe(true);
    expect(Number.isFinite(built.ctx.cmd.pitch)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BotController
// ---------------------------------------------------------------------------

describe('BotController', () => {
  function build(): { controller: BotController; built: Built } {
    const map = makeMap();
    const world = new World(map);
    const nav = new NavGraph(map);
    nav.attachWorld(world);
    const bot = makeActor({ id: 1, team: 'T', pos: { x: 0, y: 0, z: 0 } });
    const controller = new BotController({ id: 1, team: 'T', difficulty: 'normal', nav, world, seed: 42 });
    const built: Built = {
      nav,
      world,
      ctx: {
        self: bot,
        actors: [],
        team: 'T',
        weapon: AK47,
        ammo: 30,
        reserve: 30,
        magazineFull: true,
        reloading: false,
        canShoot: true,
        now: 0,
        nav,
        world,
        memory: controller.memory,
        follower: null,
        objective: noObjective(),
        cmd: createBotCommand(),
      },
    };
    return { controller, built };
  }

  it('returns the same command object it was handed', () => {
    const { controller, built } = build();
    const cmd = createBotCommand();
    const out = controller.update({
      self: built.ctx.self,
      actors: [],
      weapon: AK47,
      ammo: 30,
      reserve: 30,
      magazineFull: true,
      reloading: false,
      canShoot: true,
      now: 0,
      objective: noObjective(),
      senses: { underFire: false, heardAt: null, bombPlanted: false, bombPos: null },
      cmd,
    });
    expect(out).toBe(cmd);
    expect(controller.goal).toBe('advance');
  });

  it('fills cmd.tick when the caller leaves it at zero', () => {
    const { controller, built } = build();
    const cmd = createBotCommand();
    controller.update({
      self: built.ctx.self,
      actors: [],
      weapon: AK47,
      ammo: 30,
      reserve: 30,
      magazineFull: true,
      reloading: false,
      canShoot: true,
      now: 0,
      objective: noObjective(),
      senses: { underFire: false, heardAt: null, bombPlanted: false, bombPos: null },
      cmd,
    });
    expect(cmd.tick).toBeGreaterThan(0);
  });

  it('repath clears the follower so the next tick rebuilds it', () => {
    const { controller, built } = build();
    const cmd = createBotCommand();
    const args = {
      self: built.ctx.self,
      actors: [],
      weapon: AK47,
      ammo: 30,
      reserve: 30,
      magazineFull: true,
      reloading: false,
      canShoot: true,
      now: 0,
      objective: makeObjective('attack', 'A', nodeId(4, 4)),
      senses: { underFire: false, heardAt: null, bombPlanted: false, bombPos: null },
      cmd,
    };
    controller.update(args);
    expect(controller.lastContext.follower).not.toBeNull();
    controller.repath(controller.lastContext);
    expect(controller.lastContext.follower).toBeNull();
    controller.update({ ...args, now: 0.1 });
    expect(controller.lastContext.follower).not.toBeNull();
  });
});
