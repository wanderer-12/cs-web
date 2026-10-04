// =============================================================================
// tests/perf.spec.ts — the simulation performance budget, measured for real.
//
// The design budget (PLAN.md) is a sim tick of 0.6 ms at 128 Hz: a 7.8 ms frame
// then leaves ~7 ms for the renderer. These tests deliberately do NOT assert that
// number. A loaded CI machine can be several times slower than a desktop, and a
// test that goes red when the machine is busy is worse than a loose bound — the
// exact measured values are printed here and copied into README.md instead.
//
// What is asserted is a gross-regression ceiling, ~5x the design budget, so a
// change that makes the tick ten times slower still fails.
//
// Rendering is not measured: that needs a GPU and a browser, and this suite has
// no Playwright. Use `?stats=` / F3 in the running game for draw calls and
// triangles (see README.md).
// =============================================================================

import { describe, expect, it } from 'vitest';

import { Match } from '../src/game/game';
import { World } from '../src/world/world';
import { buildDust2Lite } from '../src/world/maps/de_dust2_lite';
import { EventBus } from '../src/core/events';
import { Rng } from '../src/core/rng';
import { TICK_DT } from '../src/core/config';
import { createMoveState, stepMovement } from '../src/player/movement';
import { EMPTY_BUTTONS, type InputCommand } from '../src/core/types';

function idleCommand(tick: number): InputCommand {
  return { tick, buttons: { ...EMPTY_BUTTONS }, yaw: 0, pitch: 0, mouseDX: 0, mouseDY: 0 };
}

function makeMatch(opts: { seed?: number } = {}) {
  const map = buildDust2Lite();
  const world = new World(map);
  const bus = new EventBus();
  const match = new Match({
    world,
    bus,
    map,
    rng: new Rng(opts.seed ?? 4242),
    skipWarmup: true,
    botsPerTeam: 4,
  });
  return { map, world, bus, match };
}

interface Stats {
  label: string;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/**
 * Summarise a set of per-call timings and print one line for the report.
 */
function summarise(label: string, times: number[]): Stats {
  const sorted = [...times].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const stats: Stats = {
    label,
    avgMs: sorted.length > 0 ? sum / sorted.length : 0,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
  console.log(
    `[perf] ${label}: avg ${stats.avgMs.toFixed(4)} ms | p50 ${stats.p50Ms.toFixed(4)} | ` +
      `p95 ${stats.p95Ms.toFixed(4)} | max ${stats.maxMs.toFixed(4)} (${sorted.length} samples)`,
  );
  return stats;
}

/**
 * Time `samples` runs of `fn`, discarding a warm-up pass so the JIT and any
 * first-touch allocations (path cache, brush AABB build) do not land in the
 * numbers.
 */
function measure(label: string, samples: number, fn: (i: number) => void): Stats {
  for (let i = 0; i < Math.max(8, samples >> 3); i += 1) fn(i);

  const times: number[] = new Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const t0 = performance.now();
    fn(i);
    times[i] = performance.now() - t0;
  }
  return summarise(label, times);
}

/** Advance the match by `seconds` of simulated time with a still human. */
function advance(match: Match, seconds: number): void {
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i += 1) match.tick(idleCommand(i), TICK_DT);
}

describe('performance budget', () => {
  it('ticks a live 10-actor round far inside the frame budget', () => {
    const { match, bus } = makeMatch();
    let shots = 0;
    let hits = 0;
    let shotsThisTick = 0;
    bus.on('shot', () => {
      shots += 1;
      shotsThisTick += 1;
    });
    bus.on('hit', () => {
      hits += 1;
    });

    // Six seconds first: warm the JIT and let the two teams run into each other,
    // because the expensive ticks are the ones with bots aiming, firing and
    // tracing bullets, not the opening pathfinding.
    advance(match, 6);

    // Bucket the ticks by whether a shot resolved in them: a tick that traces
    // bullets is the honest worst case, and it is hidden inside the average.
    const measured = 2560; // 20 s of game time
    const quiet: number[] = [];
    const fighting: number[] = [];
    for (let i = 0; i < measured; i += 1) {
      shotsThisTick = 0;
      const t0 = performance.now();
      match.tick(idleCommand(i), TICK_DT);
      const ms = performance.now() - t0;
      (shotsThisTick > 0 ? fighting : quiet).push(ms);
    }

    const all = summarise('Match.tick (10 actors, live round)', [...quiet, ...fighting]);
    summarise(`Match.tick, ticks with a shot (${fighting.length}/${measured})`, fighting);
    console.log(
      `[perf] window: ${shots} shots, ${hits} hits over ${measured} ticks ` +
        `(${Math.round(measured * TICK_DT)} s of game time)`,
    );

    // We must have timed a firefight, otherwise the numbers are meaningless.
    expect(shots).toBeGreaterThan(0);

    // Ceiling, not the design budget: 3 ms per tick is 38% of a 7.8 ms frame.
    expect(all.avgMs).toBeLessThan(3);
    expect(all.p95Ms).toBeLessThan(6);
  });

  it('steps the player box cheaply enough for ten actors', () => {
    const world = new World(buildDust2Lite());
    // Mid, a known-clear spot on de_dust2_lite.
    const state = createMoveState({ x: 0, y: 0, z: 600 });
    const cmd = idleCommand(0);
    cmd.buttons.forward = true;

    const stats = measure('stepMovement (1 actor, real map)', 2000, () =>
      stepMovement(world, state, cmd, TICK_DT),
    );

    // Ten actors moving every tick is the per-tick movement cost of the match.
    console.log(
      `[perf] extrapolated: 10 actors x 128 Hz = ${(stats.avgMs * 10).toFixed(4)} ms/tick`,
    );
    expect(stats.avgMs).toBeLessThan(0.3);
  });

  it('plans and follows bot routes without a per-tick spike', () => {
    const { match } = makeMatch();
    const nav = match.nav;

    // 32 is the CT spawn node, 153 the first A-site node (see navigation.spec.ts).
    const path = measure('nav.findPath (CT spawn -> A site)', 200, () => {
      const p = nav.findPath(32, 153, 'CT');
      if (p.nodes.length === 0) throw new Error('no path');
    });
    const nearest = measure('nav.nearestNode', 500, () => nav.nearestNode({ x: 0, y: 0, z: 600 }));

    // A bot re-plans at most once per waypoint, so even the p95 must fit in a tick.
    expect(path.p95Ms).toBeLessThan(2);
    expect(nearest.p95Ms).toBeLessThan(0.5);
  });
});