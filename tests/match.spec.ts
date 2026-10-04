// =============================================================================
// tests/match.spec.ts — headless integration test for the whole simulation.
//
// This is the test that would have caught every wiring mistake the unit specs
// cannot see: bots that never move because no one feeds them senses, rounds
// that never end because the death events are not accounted for, players whose
// positions go NaN after a respawn, an economy that can buy a rifle for 0.
//
// It runs the real `Match` on the real map with the real bots — no DOM, no
// WebGL, no Three.js renderer — for minutes of simulated time.
// =============================================================================

import { describe, expect, it } from 'vitest';

import { Match } from '../src/game/game';
import { World } from '../src/world/world';
import { buildDust2Lite } from '../src/world/maps/de_dust2_lite';
import { EventBus } from '../src/core/events';
import { Rng } from '../src/core/rng';
import { TICK_DT } from '../src/core/config';
import { EMPTY_BUTTONS, type InputCommand, type Vec3 } from '../src/core/types';

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

function walkCommand(tick: number, yaw = 0): InputCommand {
  const cmd = idleCommand(tick);
  cmd.buttons.forward = true;
  cmd.yaw = yaw;
  return cmd;
}

function makeMatch(opts: { seed?: number; skipWarmup?: boolean; botsPerTeam?: number } = {}) {
  const map = buildDust2Lite();
  const world = new World(map);
  const bus = new EventBus();
  const match = new Match({
    world,
    bus,
    map,
    rng: new Rng(opts.seed ?? 1234),
    skipWarmup: opts.skipWarmup ?? true,
    botsPerTeam: opts.botsPerTeam ?? 4,
  });
  return { map, world, bus, match };
}

/** Advance the match `seconds` of simulated time at the fixed 128 Hz rate. */
function run(
  match: Match,
  seconds: number,
  cmdFor: (tick: number) => InputCommand = idleCommand,
  hooks: { onTick?: (tick: number) => void } = {},
): number {
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i += 1) {
    match.tick(cmdFor(i), TICK_DT);
    hooks.onTick?.(i);
  }
  return ticks;
}

function finite(p: Vec3): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

describe('Match — headless integration', () => {
  it('builds a complete match: roster, spawns, loadouts, camera rig wiring', () => {
    const { match, map } = makeMatch();

    expect(match.players.length).toBe(10);
    expect(match.playersOf('T').length).toBe(5);
    expect(match.playersOf('CT').length).toBe(5);
    expect(match.byId.size).toBe(match.players.length);
    expect(match.local.isBot).toBe(false);

    for (const player of match.players) {
      expect(player.weaponIdForSlot('secondary')).toBeTruthy();
      expect(player.weaponIdForSlot('knife')).toBe('knife');
      expect(finite(player.state.pos)).toBe(true);
      expect(player.state.health).toBeGreaterThan(0);
      expect(player.state.alive).toBe(true);
    }

    // Every actor is registered with the combat system: asking for its weapon
    // state must hand back a live magazine rather than create a stray one.
    for (const player of match.players) {
      const ws = match.combat.getWeaponState(player.id, player.weapon.id, player.weapon);
      expect(ws.weaponId).toBe(player.weapon.id);
      expect(ws.reserve).toBeGreaterThanOrEqual(0);
    }
  });

  it('advances the round clock and lets bots actually move', () => {
    const { match } = makeMatch({ skipWarmup: true });

    const start = match.players.map((p) => ({ id: p.id, pos: { ...p.state.pos } }));
    run(match, 4);
    const moved = start.filter(({ id, pos }) => {
      const p = match.byId.get(id)!;
      return Math.hypot(p.state.pos.x - pos.x, p.state.pos.z - pos.z) > 8;
    });
    // The bots spend the first seconds running at their objective: at least half
    // the roster (the human stands still) must have covered real ground.
    expect(moved.length).toBeGreaterThanOrEqual(4);

    for (const p of match.players) expect(finite(p.state.pos)).toBe(true);
  });

  it('fires weapons, resolves damage and closes rounds on the real clock', () => {
    const { match, bus } = makeMatch({ skipWarmup: true });

    let shots = 0;
    let hits = 0;
    let deaths = 0;
    bus.on('shot', () => {
      shots += 1;
    });
    bus.on('hit', () => {
      hits += 1;
    });
    bus.on('death', () => {
      deaths += 1;
    });

    // 150 s, not 90: with `skipWarmup` the first round still runs its full 115 s clock,
    // and `checkRoundEnd` only decides it earlier when the bomb explodes (plant by
    // ~40 s + a 40 s fuse, measured ~95 s total) or a team is wiped. At 90 s the score
    // was still 0-0, which made this assertion a coin flip on bot luck. 150 s covers
    // the clock verdict (~123 s) plus the start of round 2 (~136 s).
    let phase = match.phase;
    const phases = new Set<string>([phase]);
    run(match, 150, idleCommand, {
      onTick: () => {
        if (match.phase !== phase) {
          phase = match.phase;
          phases.add(phase);
        }
      },
    });

    expect(shots).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0);
    expect(match.scoreT + match.scoreCT).toBeGreaterThan(0);
    expect(deaths).toBeGreaterThan(0);
    expect(phases.has('live')).toBe(true);
    expect(match.roundNumber).toBeGreaterThanOrEqual(2);
    // 150 s of simulated match time; ~8 s of wall clock alone, more when the whole
    // suite runs in parallel. The default 5 s timeout is not enough for this.
  }, 60_000);

  it('keeps every position finite across respawns and bomb logic', () => {
    const { match } = makeMatch({ skipWarmup: true });
    run(match, 60, (tick) => (tick % 512 < 256 ? walkCommand(tick, 0.4) : idleCommand(tick)));
    for (const p of match.players) {
      expect(finite(p.state.pos)).toBe(true);
      expect(finite(p.state.vel)).toBe(true);
      expect(Number.isFinite(p.state.yaw)).toBe(true);
      expect(Number.isFinite(p.state.pitch)).toBe(true);
      expect(p.state.health).toBeGreaterThanOrEqual(0);
      expect(p.state.health).toBeLessThanOrEqual(100);
    }
    // 60 s of simulated match time: same reasoning as the round-clock test above.
  }, 60_000);

  it('refuses purchases the player cannot afford and applies the ones it can', () => {
    const { match } = makeMatch({ skipWarmup: true });
    const local = match.local;

    // Pistol round money cannot buy an AK.
    const denied = match.buy(local.id, 'ak47');
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBeTruthy();
    expect(local.weaponIdForSlot('primary')).toBeFalsy();

    match.addMoney(local.id, 3000);
    expect(match.moneyOf(local.id)).toBeGreaterThanOrEqual(3000);

    const bought = match.buy(local.id, 'ak47');
    expect(bought.ok).toBe(true);
    expect(local.weaponIdForSlot('primary')).toBe('ak47');
    expect(match.moneyOf(local.id)).toBe(3000 + 800 - 2700);

    // Buying the same slot twice is a no-op, not a second charge.
    const again = match.buy(local.id, 'm4a4');
    expect(again.ok).toBe(false);
    expect(match.moneyOf(local.id)).toBe(1100);
  });

  it('is deterministic: the same seed replays the same match', () => {
    const a = makeMatch({ seed: 98765 });
    const b = makeMatch({ seed: 98765 });
    run(a.match, 20);
    run(b.match, 20);
    for (const p of a.match.players) {
      const other = b.match.byId.get(p.id)!;
      expect(p.state.pos.x).toBeCloseTo(other.state.pos.x, 6);
      expect(p.state.pos.y).toBeCloseTo(other.state.pos.y, 6);
      expect(p.state.pos.z).toBeCloseTo(other.state.pos.z, 6);
      expect(p.state.health).toBe(other.state.health);
    }
    expect(a.match.scoreT).toBe(b.match.scoreT);
    expect(a.match.scoreCT).toBe(b.match.scoreCT);
    // Two 20 s simulations.
  }, 60_000);

  it('disposes without leaking into the bus', () => {
    const { match, bus } = makeMatch({ skipWarmup: true });
    run(match, 6);
    match.dispose();
    // After dispose the match must have unsubscribed: emitting a fresh event
    // must not reach into a torn-down match (it would throw on a null world).
    expect(() => bus.emit('announce', { text: 'post-dispose', kind: 'info' })).not.toThrow();
    expect(() => bus.emit('roundPhase', { phase: 'live', timeLeft: 10, roundNumber: 1 })).not.toThrow();
  });
});