// =============================================================================
// src/net/Prediction.ts — client prediction + reconciliation (phase 3).
//
// The client never waits for the server to move: it applies each locally sampled
// input immediately (128 Hz) and keeps the unacknowledged commands. When a
// snapshot arrives, the local actor is snapped back to the authoritative pose and
// every input newer than `ackedInputTick` is replayed. Positions therefore stay
// server-authoritative while the camera stays latency-free.
//
// `InputHistory` and the tick arithmetic are implemented and tested here; the
// re-simulation loop itself needs a world the client can rewind, which is the
// phase-3 work (`PredictedWorld` below is the seam it will implement).
// =============================================================================

import type { InputCommand } from '../core/types';
import type { Snapshot } from './Protocol';
import type { ActorPose } from './LagCompensation';

/** Input ticks are 16-bit on the wire and wrap; compare them the wrapped way. */
export const INPUT_TICK_WRAP = 0x10000;

/**
 * Signed distance from `from` to `to` on a wrapping 16-bit tick counter, so a
 * plain `>` does not break once the counter rolls over (after ~8.5 minutes at
 * 128 Hz).
 */
export function ticksAhead(to: number, from: number): number {
  const delta = (to - from) & (INPUT_TICK_WRAP - 1);
  return delta >= INPUT_TICK_WRAP / 2 ? delta - INPUT_TICK_WRAP : delta;
}

/** The client's own simulation, as much as prediction needs of it. */
export interface PredictedWorld {
  /** Apply one input command to the local actor for one tick. */
  applyInput(cmd: InputCommand, dt: number): void;
  /** Restore the local actor to an authoritative pose before replaying. */
  resetLocalTo(pose: ActorPose, serverTimeMs: number): void;
  /** Current predicted pose of the local actor, for the camera and rendering. */
  localPose(): ActorPose;
}

export interface Reconciler {
  /** Record a locally sampled input (called every tick). */
  pushInput(cmd: InputCommand): void;
  /**
   * Adopt an authoritative snapshot, then replay every unacknowledged input.
   * Returns the number of ticks re-simulated, which is a useful health metric:
   * a stable link replays roughly `latency * 128` ticks, a spike replays much
   * more and is visible in `NetStats.inputsReplayed`.
   */
  reconcile(snapshot: Snapshot, localActorId: number): number;
  /** Dropped inputs older than this are never replayed again. */
  clear(): void;
}

/**
 * Ring of unacknowledged input commands, keyed by input tick. Bounded: a client
 * that has been disconnected for a while must not replay a minute of stale
 * inputs into the world when the link returns.
 */
export class InputHistory {
  private readonly commands: InputCommand[] = [];
  private readonly capacity: number;

  constructor(capacity = 256) {
    this.capacity = Math.max(1, capacity);
  }

  get length(): number {
    return this.commands.length;
  }

  push(cmd: InputCommand): void {
    this.commands.push(cmd);
    while (this.commands.length > this.capacity) this.commands.shift();
  }

  /** Drop every command the server has already consumed. */
  ack(ackedInputTick: number): void {
    while (this.commands.length > 0) {
      const head = this.commands[0];
      if (ticksAhead(head.tick, ackedInputTick) <= 0) this.commands.shift();
      else break;
    }
  }

  /** Unacknowledged commands, oldest first. */
  pending(): readonly InputCommand[] {
    return this.commands;
  }

  clear(): void {
    this.commands.length = 0;
  }
}