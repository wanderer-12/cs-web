// =============================================================================
// tests/separation.spec.ts — bodies must not share a spot.
//
// Bot goal nodes are shared (a whole attacking team converges on the same site
// node), so before this pass four bots stood in one coordinate and read as a
// single bot. The fix is physical: `Match.separatePlayers` pushes overlapping
// bodies apart. These tests pin the three rules that make it safe:
//
//   1. co-located bodies end up apart, horizontally only;
//   2. the human is never the one who yields;
//   3. bodies on different floors never push each other (a crate is not a body).
// =============================================================================

import { describe, expect, it } from 'vitest';

import { Match } from '../src/game/game';
import { World } from '../src/world/world';
import { buildDust2Lite } from '../src/world/maps/de_dust2_lite';
import { EventBus } from '../src/core/events';
import { Rng } from '../src/core/rng';
import { PLAYER, TICK_DT } from '../src/core/config';
import { EMPTY_BUTTONS, type InputCommand } from '../src/core/types';

function idleCommand(tick: number): InputCommand {
  return {
    tick,
    buttons: { ...EMPTY_BUTTONS },
    yaw: 0,
    pitch: 0,
    mouseDX: 0,
    mouseDY: 0,
  };
}

function makeMatch(seed = 4242) {
  const map = buildDust2Lite();
  const world = new World(map);
  const bus = new EventBus();
  const match = new Match({
    world,
    bus,
    map,
    rng: new Rng(seed),
    skipWarmup: true,
    botsPerTeam: 4,
  });
  return { map, world, bus, match };
}

/** Distance between two actors in the horizontal plane the pass works in. */
function gapXZ(a: { state: { pos: { x: number; z: number } } }, b: { state: { pos: { x: number; z: number } } }): number {
  return Math.hypot(a.state.pos.x - b.state.pos.x, a.state.pos.z - b.state.pos.z);
}

describe('body separation', () => {
  it('pushes two stacked bots apart', () => {
    const { match } = makeMatch();
    const bots = match.players.filter((p) => p !== match.local);
    const [a, b] = bots;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (!a || !b) return;

    // Stack `b` on `a`'s spawn point: a legal, open spot on the real map.
    b.state.pos.x = a.state.pos.x;
    b.state.pos.y = a.state.pos.y;
    b.state.pos.z = a.state.pos.z;
    expect(gapXZ(a, b)).toBe(0);

    const feetY = a.state.pos.y;
    match.tick(idleCommand(0), TICK_DT);

    // A single tick moves at most SEPARATION_MAX_PUSH (8 units) in total, so at a
    // full 32-unit overlap the pair is 8 apart before anything walks. Bot steering
    // can eat a couple of units; the floor here is well above zero.
    expect(gapXZ(a, b)).toBeGreaterThan(PLAYER.radius * 0.4);
    // Horizontal only: neither body was lifted onto, or through, the floor.
    expect(Math.abs(a.state.pos.y - feetY)).toBeLessThan(PLAYER.stepHeight);
    expect(Math.abs(b.state.pos.y - feetY)).toBeLessThan(PLAYER.stepHeight);
    expect(Number.isFinite(a.state.pos.x) && Number.isFinite(b.state.pos.z)).toBe(true);
  });

  it('resolves a stack without leaving anyone co-located', () => {
    const { match } = makeMatch(99);
    const bots = match.players.filter((p) => p !== match.local);
    const [a, b] = bots;
    if (!a || !b) return;
    b.state.pos.x = a.state.pos.x;
    b.state.pos.y = a.state.pos.y;
    b.state.pos.z = a.state.pos.z;
    for (let i = 0; i < 32; i += 1) match.tick(idleCommand(i), TICK_DT);
    expect(gapXZ(a, b)).toBeGreaterThan(PLAYER.radius);
  });

  it('never moves the human player', () => {
    const { match } = makeMatch();
    const bot = match.players.find((p) => p !== match.local);
    expect(bot).toBeDefined();
    if (!bot) return;

    // Stand the human exactly where the bot spawned: an open, legal spot.
    const human = match.local;
    human.state.pos.x = bot.state.pos.x;
    human.state.pos.y = bot.state.pos.y;
    human.state.pos.z = bot.state.pos.z;
    const hx = human.state.pos.x;
    const hz = human.state.pos.z;

    for (let i = 0; i < 8; i += 1) match.tick(idleCommand(i), TICK_DT);

    // The player is immovable by the pass: a team-mate's elbow must never shove
    // the camera, and the player must never lose a duel to it.
    expect(human.state.pos.x).toBe(hx);
    expect(human.state.pos.z).toBe(hz);
    // ...and the bot is the side that yields.
    expect(gapXZ(human, bot)).toBeGreaterThan(0);
  });

  it('does not push bodies that stand on different floors', () => {
    const { match } = makeMatch();
    const bots = match.players.filter((p) => p !== match.local);
    const [a, b] = bots;
    if (!a || !b) return;
    b.state.pos.x = a.state.pos.x;
    b.state.pos.z = a.state.pos.z;
    // Far above: a catwalk, not a collision. Only gravity may touch it.
    b.state.pos.y = a.state.pos.y + PLAYER.standHeight * 3;

    match.tick(idleCommand(0), TICK_DT);
    expect(gapXZ(a, b)).toBeLessThan(PLAYER.radius + 4);
  });
});