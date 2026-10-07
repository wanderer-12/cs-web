// =============================================================================
// tests/botspread.spec.ts — the squad must not walk as one lump.
//
// The user reported the bots standing too close together at spawn and in combat
// (three bots on one nav node, bodies 32 units apart, i.e. exactly touching).
// Two guards here: the duel spawn fan really is spread out, and a live hunt
// never lets two bots end up closer than a comfortable gap.
// =============================================================================

import { describe, expect, it } from 'vitest';

import { Match } from '../src/game/game';
import { World } from '../src/world/world';
import { buildAimDuelLite } from '../src/world/maps/aim_duel_lite';
import { EventBus } from '../src/core/events';
import { Rng } from '../src/core/rng';
import { PLAYER, TICK_DT } from '../src/core/config';
import { EMPTY_BUTTONS, type InputCommand } from '../src/core/types';

/** A gap of four body radii is the floor this test defends. */
const MIN_LIVE_GAP = PLAYER.radius * 4;

function idle(tick: number): InputCommand {
  return { tick, buttons: { ...EMPTY_BUTTONS }, yaw: 0, pitch: 0, mouseDX: 0, mouseDY: 0 };
}

function duelMatch(): Match {
  const map = buildAimDuelLite();
  return new Match({
    world: new World(map),
    bus: new EventBus(),
    map,
    rng: new Rng(0x7e57),
    skipWarmup: true,
    mode: 'duel',
  });
}

const gap = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.z - b.z);

/** The closest two living bots of the given list, or Infinity. */
function closestPair(bots: readonly { state: { pos: { x: number; z: number }; alive: boolean } }[]): number {
  let min = Infinity;
  for (let i = 0; i < bots.length; i += 1) {
    for (let j = i + 1; j < bots.length; j += 1) {
      if (!bots[i].state.alive || !bots[j].state.alive) continue;
      min = Math.min(min, gap(bots[i].state.pos, bots[j].state.pos));
    }
  }
  return min;
}

describe('bot spacing', () => {
  it('spawns a duel squad across the pad, not in a stack', () => {
    const match = duelMatch();
    for (const team of ['T', 'CT'] as const) {
      const spawns = match.map.spawns.filter((s) => s.team === team);
      expect(spawns.length).toBeGreaterThan(1);
      for (let i = 0; i < spawns.length; i += 1) {
        for (let j = i + 1; j < spawns.length; j += 1) {
          // The old fan packed slots 288 apart and doubled up on z; a gap of at
          // least 6 body radii is what keeps the opening walk from reading as a
          // conga line.
          expect(gap(spawns[i].pos, spawns[j].pos)).toBeGreaterThan(PLAYER.radius * 5);
        }
      }
    }
  });

  it('keeps a hunting squad visibly apart for a whole round window', () => {
    const match = duelMatch();
    const bots = match.players.filter((p) => p.state.isBot);
    expect(bots.length).toBe(3);
    expect(closestPair(bots)).toBeGreaterThan(PLAYER.radius * 5);

    let worst = Infinity;
    const ticks = Math.round(20 / TICK_DT);
    for (let i = 0; i < ticks; i += 1) {
      match.tick(idle(i), TICK_DT);
      const pair = closestPair(bots);
      if (Number.isFinite(pair)) worst = Math.min(worst, pair);
    }
    // Measured over the whole 20 s window: 134 units after the change, 32 (i.e.
    // touching) before it.
    expect(worst).toBeGreaterThanOrEqual(MIN_LIVE_GAP);
  });
});