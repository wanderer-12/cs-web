// =============================================================================
// src/net/Protocol.ts — the wire format for phase 3 (online play).
//
// This file is the *only* part of src/net/ that is fully implemented today: a
// pure encode/decode pair with no I/O, no sockets and no game-state coupling, so
// it can be unit tested and frozen now. Everything else in src/net/ is an
// interface for the future authoritative server (see Net.md).
//
// Layout (all little-endian-free: DataView defaults to network order, big
// endian, which is deterministic on both ends):
//
//   snapshot header   12 B   version u8 | entities u8 | tick u16 | serverTime u32 | ackedInputTick u32
//   entity record     15 B   id u8 | x,y,z i16 (1/4 unit) | yaw,pitch i16 (1/10000 rad)
//                            flags u8 | health u8 | armor u8 | weapon u8
//   input message     16 B   version u8 | tick u16 | clientTime u32 | buttons 3 B
//                            | yaw,pitch i16 | 2 B reserved
//
// 30 entities is 12 + 30*15 = 462 B per snapshot, which is the ~400 B/snapshot
// budget from PLAN.md; at 20 Hz that is ~9 kB/s down per client.
//
// Quantisation: 0.25 units of position and 0.0001 rad of angle. Both are far
// below what interpolation and lag compensation need (the interp buffer only
// has to place a target smoothly, and the rewind window is 1 s wide), and they
// are what keep a snapshot 15 bytes per actor.
// =============================================================================

import type { InputButtons, InputCommand } from '../core/types';

/** Bumped whenever the byte layout below changes; mismatched peers drop the link. */
export const NET_PROTOCOL_VERSION = 1;

/** Server snapshot rate. Clients simulate at the full 128 Hz (`TICK_DT`). */
export const SNAPSHOT_HZ = 20;

/** Client-side playout delay: render the world 100 ms in the past. */
export const INTERP_BUFFER_SECONDS = 0.1;

/** How much position history the server keeps for lag compensation. */
export const LAG_COMP_HISTORY_SECONDS = 1.0;

export const SNAPSHOT_HEADER_BYTES = 12;
export const ENTITY_RECORD_BYTES = 15;
export const INPUT_MESSAGE_BYTES = 16;

/** Position is stored in quarter units. */
const POS_SCALE = 4;
/** Angles are stored in 1/10000 rad, which covers +-PI inside an int16. */
const ANGLE_SCALE = 10000;

/** Per-actor state bits. */
export const EntityFlags = {
  Alive: 1 << 0,
  OnGround: 1 << 1,
  Crouched: 1 << 2,
  Scoped: 1 << 3,
  HasBomb: 1 << 4,
  Reloading: 1 << 5,
  Planting: 1 << 6,
  Defusing: 1 << 7,
} as const;

export interface EntitySnapshot {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Absolute view angles in radians (what `Player.applyLook` consumes). */
  yaw: number;
  pitch: number;
  /** Bit mask of `EntityFlags`. */
  flags: number;
  health: number;
  armor: number;
  /** Index into the shared weapon table, not a weapon id string. */
  weapon: number;
}

export interface Snapshot {
  /** Wrapping 16-bit server tick. */
  tick: number;
  /** Milliseconds since the session started; the interp/rewind clock. */
  serverTimeMs: number;
  /** Last input tick the server consumed from this client (for reconciliation). */
  ackedInputTick: number;
  entities: EntitySnapshot[];
}

export interface ClientInput {
  /** Wrapping 16-bit input tick. */
  tick: number;
  clientTimeMs: number;
  buttons: InputButtons;
  yaw: number;
  pitch: number;
}

/** Button order on the wire. Keep in sync with `InputButtons` (17 bits). */
const BUTTON_NAMES = [
  'forward',
  'back',
  'left',
  'right',
  'jump',
  'crouch',
  'walk',
  'attack',
  'attack2',
  'reload',
  'use',
  'drop',
  'slot1',
  'slot2',
  'slot3',
  'slot4',
  'slot5',
] as const satisfies readonly (keyof InputButtons)[];

export function packButtons(buttons: InputButtons): number {
  let mask = 0;
  for (let i = 0; i < BUTTON_NAMES.length; i += 1) {
    if (buttons[BUTTON_NAMES[i]]) mask |= 1 << i;
  }
  return mask;
}

export function unpackButtons(mask: number, out: InputButtons): InputButtons {
  for (let i = 0; i < BUTTON_NAMES.length; i += 1) {
    out[BUTTON_NAMES[i]] = (mask & (1 << i)) !== 0;
  }
  return out;
}

function writeButtons(view: DataView, at: number, mask: number): void {
  view.setUint8(at, mask & 0xff);
  view.setUint8(at + 1, (mask >>> 8) & 0xff);
  view.setUint8(at + 2, (mask >>> 16) & 0xff);
}

function readButtons(view: DataView, at: number): number {
  return view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
}

function clampInt16(value: number): number {
  const rounded = Math.round(value);
  if (rounded > 32767) return 32767;
  if (rounded < -32768) return -32768;
  return rounded;
}

function clampUint8(value: number): number {
  const rounded = Math.round(value);
  if (rounded > 255) return 255;
  if (rounded < 0) return 0;
  return rounded;
}

export function snapshotByteLength(entityCount: number): number {
  return SNAPSHOT_HEADER_BYTES + entityCount * ENTITY_RECORD_BYTES;
}

export function encodeSnapshot(snapshot: Snapshot, out?: ArrayBuffer): ArrayBuffer {
  const buf = out ?? new ArrayBuffer(snapshotByteLength(snapshot.entities.length));
  const view = new DataView(buf);
  view.setUint8(0, NET_PROTOCOL_VERSION);
  view.setUint8(1, snapshot.entities.length);
  view.setUint16(2, snapshot.tick & 0xffff);
  view.setUint32(4, snapshot.serverTimeMs >>> 0);
  view.setUint32(8, snapshot.ackedInputTick >>> 0);

  let at = SNAPSHOT_HEADER_BYTES;
  for (const entity of snapshot.entities) {
    view.setUint8(at, entity.id);
    view.setInt16(at + 1, clampInt16(entity.x * POS_SCALE));
    view.setInt16(at + 3, clampInt16(entity.y * POS_SCALE));
    view.setInt16(at + 5, clampInt16(entity.z * POS_SCALE));
    view.setInt16(at + 7, clampInt16(entity.yaw * ANGLE_SCALE));
    view.setInt16(at + 9, clampInt16(entity.pitch * ANGLE_SCALE));
    view.setUint8(at + 11, clampUint8(entity.flags));
    view.setUint8(at + 12, clampUint8(entity.health));
    view.setUint8(at + 13, clampUint8(entity.armor));
    view.setUint8(at + 14, clampUint8(entity.weapon));
    at += ENTITY_RECORD_BYTES;
  }
  return buf;
}

export function decodeSnapshot(buf: ArrayBuffer): Snapshot {
  const view = new DataView(buf);
  const version = view.getUint8(0);
  if (version !== NET_PROTOCOL_VERSION) {
    throw new Error(`net: protocol version mismatch (got ${version}, want ${NET_PROTOCOL_VERSION})`);
  }
  const count = view.getUint8(1);
  const entities: EntitySnapshot[] = [];
  let at = SNAPSHOT_HEADER_BYTES;
  for (let i = 0; i < count; i += 1) {
    entities.push({
      id: view.getUint8(at),
      x: view.getInt16(at + 1) / POS_SCALE,
      y: view.getInt16(at + 3) / POS_SCALE,
      z: view.getInt16(at + 5) / POS_SCALE,
      yaw: view.getInt16(at + 7) / ANGLE_SCALE,
      pitch: view.getInt16(at + 9) / ANGLE_SCALE,
      flags: view.getUint8(at + 11),
      health: view.getUint8(at + 12),
      armor: view.getUint8(at + 13),
      weapon: view.getUint8(at + 14),
    });
    at += ENTITY_RECORD_BYTES;
  }
  return {
    tick: view.getUint16(2),
    serverTimeMs: view.getUint32(4),
    ackedInputTick: view.getUint32(8),
    entities,
  };
}

/**
 * Serialise one input command. `mouseDX/mouseDY` stay client-side: they only
 * drive view punch and sway, which are cosmetic and must not affect the
 * authoritative position (the same reason the engine never reads them back into
 * `state.yaw/pitch`).
 */
export function encodeInput(
  cmd: InputCommand,
  clientTimeMs: number,
  out?: ArrayBuffer,
): ArrayBuffer {
  const buf = out ?? new ArrayBuffer(INPUT_MESSAGE_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, NET_PROTOCOL_VERSION);
  view.setUint16(1, cmd.tick & 0xffff);
  view.setUint32(3, clientTimeMs >>> 0);
  writeButtons(view, 7, packButtons(cmd.buttons));
  view.setInt16(10, clampInt16(cmd.yaw * ANGLE_SCALE));
  view.setInt16(12, clampInt16(cmd.pitch * ANGLE_SCALE));
  return buf;
}

export function decodeInput(buf: ArrayBuffer, outButtons: InputButtons): ClientInput {
  const view = new DataView(buf);
  const version = view.getUint8(0);
  if (version !== NET_PROTOCOL_VERSION) {
    throw new Error(`net: protocol version mismatch (got ${version}, want ${NET_PROTOCOL_VERSION})`);
  }
  return {
    tick: view.getUint16(1),
    clientTimeMs: view.getUint32(3),
    buttons: unpackButtons(readButtons(view, 7), outButtons),
    yaw: view.getInt16(10) / ANGLE_SCALE,
    pitch: view.getInt16(12) / ANGLE_SCALE,
  };
}