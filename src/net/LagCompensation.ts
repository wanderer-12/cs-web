// =============================================================================
// src/net/LagCompensation.ts — server-side rewind history (phase 3).
//
// When a client fires, the shot must be tested against the world as *that
// client* saw it: it was playing 100 ms behind the server plus one way of network
// latency. The server therefore keeps the last second of every actor's pose and
// rewinds the hitboxes to the client's reported time before resolving the shot.
//
// Implemented and unit tested now because it is a pure ring buffer over poses.
// The phase-3 server will feed it after each authoritative tick and call
// `rewind()` from its fire handler; nothing in the single-player build imports
// it.
// =============================================================================

import { LAG_COMP_HISTORY_SECONDS } from './Protocol';

/** A rewound pose in the shape the hitbox code wants (feet position + angles). */
export interface ActorPose {
  actorId: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** Duck amount, because the hitbox height depends on it. */
  duckAmount: number;
  onGround: boolean;
  alive: boolean;
}

interface PosedFrame {
  timeMs: number;
  poses: ActorPose[];
}

export class PositionHistory {
  private readonly frames: PosedFrame[] = [];
  private readonly capacity: number;

  constructor(framesPerSecond = 20) {
    // One second of history at the snapshot rate, plus one frame of slack so a
    // request for exactly `now - 1s` still finds a bracketing pair.
    this.capacity = Math.ceil(LAG_COMP_HISTORY_SECONDS * framesPerSecond) + 1;
  }

  get length(): number {
    return this.frames.length;
  }

  clear(): void {
    this.frames.length = 0;
  }

  record(timeMs: number, poses: readonly ActorPose[]): void {
    this.frames.push({
      timeMs,
      poses: poses.map((pose) => ({ ...pose })),
    });
    if (this.frames.length > this.capacity) this.frames.shift();
  }

  /**
   * Poses as of `timeMs`. Returns the newest frame at or before it - never an
   * interpolation between frames, because a hitbox is a discrete box and blending
   * two of them would create a box nobody actually occupied. Requests older than
   * the history clamp to the oldest frame; that is the maximum rewind the server
   * is willing to grant, which is what bounds the "shot me behind a wall"
   * advantage a high-ping client can buy.
   */
  rewind(timeMs: number, actorId?: number): ActorPose[] {
    if (this.frames.length === 0) return [];
    let frame = this.frames[0];
    for (const candidate of this.frames) {
      if (candidate.timeMs <= timeMs) frame = candidate;
      else break;
    }
    const poses = frame.poses;
    return actorId === undefined ? poses.map((p) => ({ ...p })) : poses.filter((p) => p.actorId === actorId);
  }

  /** Oldest timestamp still available, so the server can clamp a rewind request. */
  oldestTimeMs(): number {
    return this.frames.length === 0 ? 0 : this.frames[0].timeMs;
  }
}