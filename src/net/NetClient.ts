// =============================================================================
// src/net/NetClient.ts — transport seam and clock for phase 3 (online play).
//
// The single-player build never imports this file: bot matches run the whole
// simulation locally (see game.ts). What lives here is the shape the online
// client must have, plus one fully implemented piece — `ServerClock`, which is
// the part everything else depends on and the part that is easy to get wrong
// (a naive `serverTime = snapshot.time` clock jitters with every packet, and an
// NTP-style best-RTT clock does not).
//
// PLAN.md phase 3: authoritative Node `ws` server, 20 Hz snapshots, 128 Hz client
// prediction, 100 ms interpolation, 1 s rewind history. `Transport` is deliberately
// transport-agnostic so the same client code can run over `WebSocket` in the
// browser and over an in-process loopback in tests.
// =============================================================================

import { NET_PROTOCOL_VERSION, type Snapshot } from './Protocol';

export interface NetStats {
  /** Smoothed round-trip time in milliseconds. */
  rttMs: number;
  /** Mean absolute deviation of the RTT estimate; the jitter the interp buffer absorbs. */
  jitterMs: number;
  snapshotsReceived: number;
  /** Input ticks replayed by the last reconciliation. */
  inputsReplayed: number;
  /** Bytes per second received / sent, for the HUD netgraph. */
  bytesIn: number;
  bytesOut: number;
}

/**
 * Anything that can carry binary messages. The browser implementation wraps
 * `WebSocket`; tests wrap a loopback pair; `NullTransport` is what the
 * single-player build would install if it ever ran this code.
 */
export interface Transport {
  send(data: ArrayBuffer): void;
  close(): void;
  onMessage(handler: (data: ArrayBuffer) => void): void;
  onClose(handler: () => void): void;
  readonly open: boolean;
}

export interface NetClient {
  readonly connected: boolean;
  readonly stats: NetStats;
  connect(): void;
  /** Called once per frame: sends queued inputs, applies snapshots, ages stats. */
  update(frameDt: number): void;
  /** Queue one locally sampled input command for the server. */
  sendInput(command: unknown): void;
  close(): void;
}

/**
 * One-way-delay-free estimate of the server clock.
 *
 * A snapshot carries the server time it was produced at plus the input tick the
 * server had consumed; the client cannot know how long the packet spent in
 * flight, so it uses the *lowest* RTT sample it has seen as its best estimate of
 * the true one-way delay (the standard trick: the minimum RTT is the least
 * queued packet, and the internet's jitter is one-sided). Everything else -
 * interpolation delay, rewind requests - is expressed relative to that clock.
 */
export class ServerClock {
  private offsetMs = 0;
  private bestRttMs = Infinity;
  private lastRttMs = 0;
  private jitterMs = 0;
  private samples = 0;

  get rttMs(): number {
    return this.lastRttMs;
  }

  get smoothedOffsetMs(): number {
    return this.offsetMs;
  }

  get jitter(): number {
    return this.jitterMs;
  }

  /**
   * Feed one snapshot. `receivedAtMs` is the client's own clock when the packet
   * landed, `sentAtMs` the client clock when the matching input was sent (both
   * from `performance.now()`, so only differences matter).
   */
  onSnapshot(snapshot: Snapshot, receivedAtMs: number, sentAtMs?: number): void {
    if (sentAtMs !== undefined) {
      const rtt = Math.max(0, receivedAtMs - sentAtMs);
      // Deviation from the *previous* sample, computed before overwriting it:
      // jitter is how much the round trip moves around, not how big it is.
      const deviation = this.samples === 0 ? 0 : Math.abs(rtt - this.lastRttMs);
      this.lastRttMs = rtt;
      if (rtt < this.bestRttMs) {
        this.bestRttMs = rtt;
        // One-way delay is at most half the best RTT; the remainder is clock
        // offset between the two machines.
        this.offsetMs = snapshot.serverTimeMs - receivedAtMs + rtt * 0.5;
      }
      this.samples += 1;
      // First-order low-pass; the interp buffer is sized for the jitter, not the average.
      this.jitterMs += (deviation - this.jitterMs) * 0.1;
    } else if (this.samples === 0) {
      // No RTT sample yet: assume the snapshot is fresh.
      this.offsetMs = snapshot.serverTimeMs - receivedAtMs;
    }
  }

  /** Best estimate of the server clock, in server milliseconds. */
  serverNowMs(clientNowMs: number): number {
    if (this.samples === 0 && this.offsetMs === 0) return clientNowMs;
    return clientNowMs + this.offsetMs;
  }
}

/** Protocol handshake bytes; phase 3 sends this before any snapshot. */
export function encodeHello(clientVersion = NET_PROTOCOL_VERSION): ArrayBuffer {
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  view.setUint16(0, 0xface); // magic
  view.setUint8(2, clientVersion);
  view.setUint8(3, 0); // reserved: requested team / role
  return buf;
}

export function decodeHello(buf: ArrayBuffer): { magic: number; version: number } {
  const view = new DataView(buf);
  return { magic: view.getUint16(0), version: view.getUint8(2) };
}