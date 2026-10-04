// =============================================================================
// src/net/Interpolation.ts — client-side playout buffer (phase 3).
//
// The authoritative server ticks at 20 Hz but the client renders at display
// rate, so snapshots are pushed into a ring buffer and sampled 100 ms behind the
// newest one. Rendering that far in the past means the client always has two
// snapshots to interpolate between, which turns 20 Hz updates into smooth
// motion without predicting anything.
//
// Implemented and unit tested now because it is pure arithmetic: it takes
// decoded `Snapshot`s, not sockets, and ignores entities that appear in only one
// of the two bracketing snapshots (spawn/despawn) rather than guessing.
// =============================================================================

import { INTERP_BUFFER_SECONDS, type EntitySnapshot, type Snapshot } from './Protocol';

/** How many snapshots to retain: 1 s of history is plenty for a 100 ms delay. */
export const INTERP_BUFFER_CAPACITY = 32;

export interface InterpolatedEntity extends EntitySnapshot {
  /** True when the entity was present in both bracketing snapshots. */
  interpolated: boolean;
}

export class SnapshotBuffer {
  private readonly snapshots: Snapshot[] = [];

  /** Drop everything (level change, reconnect). */
  clear(): void {
    this.snapshots.length = 0;
  }

  push(snapshot: Snapshot): void {
    const last = this.snapshots[this.snapshots.length - 1];
    // Out-of-order or duplicate datagrams are dropped: the newest snapshot wins.
    if (last && snapshot.serverTimeMs <= last.serverTimeMs) return;
    this.snapshots.push(snapshot);
    if (this.snapshots.length > INTERP_BUFFER_CAPACITY) this.snapshots.shift();
  }

  get length(): number {
    return this.snapshots.length;
  }

  /**
   * Server timestamp the client should render right now: `nowMs` (the client's
   * estimate of server time) minus the playout delay. Clamped to the oldest
   * snapshot we hold so a stalled link freezes instead of extrapolating.
   */
  playoutTimeMs(nowMs: number): number {
    const oldest = this.snapshots[0];
    if (!oldest) return nowMs - INTERP_BUFFER_SECONDS * 1000;
    const target = nowMs - INTERP_BUFFER_SECONDS * 1000;
    return Math.max(target, oldest.serverTimeMs);
  }

  /** Entities to draw at `playoutMs`, smoothly blended between the bracket pair. */
  sample(playoutMs: number): InterpolatedEntity[] {
    if (this.snapshots.length === 0) return [];

    // Older than everything we hold (or exactly on the oldest frame): hold the
    // oldest pose. Never extrapolate a player through a wall.
    const first = this.snapshots[0];
    if (playoutMs <= first.serverTimeMs) {
      return first.entities.map((e) => ({ ...e, interpolated: false }));
    }

    const [before, after] = this.bracket(playoutMs);

    if (!after) {
      // Past the newest snapshot: hold the last known pose (a stalled link
      // freezes rather than guessing where everyone went).
      return before.entities.map((e) => ({ ...e, interpolated: false }));
    }

    // `after.serverTimeMs > before.serverTimeMs` is guaranteed by push().
    const span = after.serverTimeMs - before.serverTimeMs;
    const t = span > 0 ? Math.min(1, Math.max(0, (playoutMs - before.serverTimeMs) / span)) : 1;

    const out: InterpolatedEntity[] = [];
    for (const a of before.entities) {
      const b = after.entities.find((candidate) => candidate.id === a.id);
      if (!b) {
        out.push({ ...a, interpolated: false });
        continue;
      }
      out.push({
        id: a.id,
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        yaw: lerpAngle(a.yaw, b.yaw, t),
        pitch: a.pitch + (b.pitch - a.pitch) * t,
        flags: t < 1 ? a.flags : b.flags,
        health: t < 1 ? a.health : b.health,
        armor: t < 1 ? a.armor : b.armor,
        weapon: t < 1 ? a.weapon : b.weapon,
        interpolated: true,
      });
    }
    return out;
  }

  private bracket(playoutMs: number): [Snapshot, Snapshot | null] {
    let before = this.snapshots[0];
    for (const snapshot of this.snapshots) {
      if (snapshot.serverTimeMs <= playoutMs) before = snapshot;
      else return [before, snapshot];
    }
    return [before, null];
  }
}

/** Shortest-path blend so a 179 -> -179 degree turn does not spin the model. */
export function lerpAngle(a: number, b: number, t: number): number {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}