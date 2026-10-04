// =============================================================================
// net/LanProtocol.ts — everything that goes over a LAN wire, in one place.
//
// Two channels ride the same socket:
//
//  * **snapshots** (binary, 20 Hz) — `Protocol.encodeSnapshot`, the existing
//    actor-transform format: id, quarter-unit position, 1/10000 rad angles,
//    flags, health, armor, weapon index. Poses only, so it stays small.
//  * **control** (JSON text, 10 Hz + on every change) — the things a snapshot
//    cannot carry: round number, stage name, round clock, score, who is still
//    alive in the round, and the two players the host can see.
//
// The split is deliberate: the binary path moves poses fast and never changes
// shape, the JSON path carries anything the rules layer grows later.
// =============================================================================

import { WEAPONS } from '../combat/weaponDefs';
import type { MatchModeId } from '../core/config';
import type { RoundPhase, Team, Vec3 } from '../core/types';
import type { Match } from '../game/game';
import { EntityFlags, type EntitySnapshot, type Snapshot } from './Protocol';

/** Default relay room: one duel at a time is all a 1v1 needs. */
export const LAN_ROOM_DEFAULT = 'duel';
/** Port `server/lan-relay.mjs` listens on unless `LAN_RELAY_PORT` says otherwise. */
export const LAN_RELAY_PORT = 5175;

/** How often the host publishes poses / match state, and the guest sends input. */
export const LAN_SNAPSHOT_HZ = 20;
export const LAN_STATE_HZ = 10;
export const LAN_INPUT_HZ = 30;

export type LanRole = 'host' | 'guest';

/** Wire format version; bumped whenever `LanControl` changes shape. */
export const LAN_WIRE_VERSION = 1;

// -----------------------------------------------------------------------------
// Weapon indices
//
// The binary snapshot stores an index into the weapon table, not a string. Both
// ends build the same table from the same registry, so the indices agree.
// -----------------------------------------------------------------------------

const WEAPON_ORDER: readonly string[] = Object.keys(WEAPONS);

export function weaponIndex(id: string): number {
  const index = WEAPON_ORDER.indexOf(id);
  return index < 0 ? 0 : index;
}

export function weaponIdAt(index: number): string {
  return WEAPON_ORDER[index] ?? 'glock';
}

// -----------------------------------------------------------------------------
// Control messages
// -----------------------------------------------------------------------------

/** One player as the host sees them. */
export interface LanPlayerState {
  id: number;
  name: string;
  team: Team;
  alive: boolean;
  hp: number;
  armor: number;
  money: number;
  weapon: string;
  /** Last authoritative pose, so a client can place a body before any snapshot. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** Host → guest, sent once when the room pairs up. */
export interface LanHello {
  t: 'hello';
  version: number;
  name: string;
  /** The team the *host* is on; the guest takes the other one. */
  team: Team;
  mode: MatchModeId;
  map: string;
  /** `hostId` and `guestId` are the host's own player ids, used to map poses. */
  hostId: number;
  guestId: number;
}

/** Host → guest, 10 Hz: everything the guest's HUD and round flow need. */
export interface LanState {
  t: 'state';
  round: number;
  phase: RoundPhase;
  timeLeft: number;
  scoreT: number;
  scoreCT: number;
  matchOver: boolean;
  winner: Team | null;
  phaseLabel: string;
  phaseIndex: number;
  hostId: number;
  guestId: number;
  /** The guest's own body, as the host simulates it. */
  local: LanPlayerState;
  /** The host's body (the body the guest renders as its opponent). */
  remote: LanPlayerState;
}

/** Guest → host: "I bought this". The host owns the wallet, so it decides. */
export interface LanBuy {
  t: 'buy';
  itemId: string;
}

/** Relay → peer and peer → peer control messages. */
export type LanControl =
  | LanHello
  | LanState
  | LanBuy
  | { t: 'welcome'; role: LanRole; room: string; version: number }
  | { t: 'peer'; role: LanRole; name: string }
  | { t: 'peer-gone'; role: LanRole; name: string }
  | { t: 'replaced'; role: LanRole }
  | { t: 'relay-down' };

export function parseControl(raw: string): LanControl | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const tag = (value as { t?: unknown }).t;
  if (typeof tag !== 'string') return null;
  // Every message this module knows about is identified by its tag alone; the
  // rest of the shape is checked at the point of use, where the types are known.
  return value as LanControl;
}

// -----------------------------------------------------------------------------
// Snapshots
// -----------------------------------------------------------------------------

/** The slice of `Match` the wire needs, so this module stays import-light. */
export interface LanActor {
  readonly id: number;
  readonly state: {
    name: string;
    team: Team;
    pos: Vec3;
    yaw: number;
    pitch: number;
    health: number;
    armor: number;
    alive: boolean;
    onGround: boolean;
    crouching: boolean;
    hasBomb: boolean;
  };
  readonly weapon: { id: string };
}

export interface LanMatchView {
  readonly players: readonly LanActor[];
}

/** Pack every actor of a match into one snapshot. */
export function snapshotFor(match: LanMatchView, tick: number, serverTimeMs: number): Snapshot {
  const entities: EntitySnapshot[] = [];
  for (const player of match.players) {
    const state = player.state;
    let flags = 0;
    if (state.alive) flags |= EntityFlags.Alive;
    if (state.onGround) flags |= EntityFlags.OnGround;
    if (state.crouching) flags |= EntityFlags.Crouched;
    if (state.hasBomb) flags |= EntityFlags.HasBomb;
    entities.push({
      id: player.id,
      x: state.pos.x,
      y: state.pos.y,
      z: state.pos.z,
      yaw: state.yaw,
      pitch: state.pitch,
      flags,
      health: state.health,
      armor: state.armor,
      weapon: weaponIndex(player.weapon.id),
    });
  }
  return { tick, serverTimeMs, ackedInputTick: 0, entities };
}

/**
 * Copy a snapshot onto the local bodies.
 *
 * `skip` names actors the caller simulates itself (the guest's own player):
 * overwriting a predicted body with a 50 ms-old pose would rubber-band it, so a
 * client leaves its own body alone and lets the host's authority reach it
 * through health and round state instead.
 *
 * `map` translates a host-side actor id into the body it means *here*, because
 * the two rosters are minted independently — id 1 is "the host" on one machine
 * and "me" on the other. Mapping happens before `skip`, so both hooks speak the
 * local id space, and an id the mapper rejects (-1) is dropped.
 */
export function applySnapshotTo(
  match: LanMatchView,
  snapshot: Snapshot,
  skip?: (actorId: number) => boolean,
  map?: (actorId: number) => number,
): number {
  let applied = 0;
  for (const entity of snapshot.entities) {
    const id = map ? map(entity.id) : entity.id;
    if (id < 0) continue;
    if (skip?.(id)) continue;
    const player = match.players.find((p) => p.id === id);
    if (!player) continue;
    const state = player.state;
    state.pos.x = entity.x;
    state.pos.y = entity.y;
    state.pos.z = entity.z;
    state.yaw = entity.yaw;
    state.pitch = entity.pitch;
    state.health = entity.health;
    state.armor = entity.armor;
    state.onGround = (entity.flags & EntityFlags.OnGround) !== 0;
    // `alive` travels too: the guest's opponent is a body it never simulates, so
    // without this a corpse the host killed would keep standing on the client.
    // The guest's own body is excluded by `skip`, so its authority still comes
    // from the round-state channel.
    state.alive = (entity.flags & EntityFlags.Alive) !== 0;
    applied += 1;
  }
  return applied;
}

// -----------------------------------------------------------------------------
// Building control messages out of a match
// -----------------------------------------------------------------------------

/** Host → guest: the whole rules state plus both players. */
export function stateFor(host: Match, hostId: number, guestId: number): LanState {
  const describe = (id: number): LanPlayerState => {
    const player = host.players.find((p) => p.id === id);
    if (!player) {
      return {
        id,
        name: id === hostId ? 'Host' : 'Guest',
        team: 'SPEC',
        alive: false,
        hp: 0,
        armor: 0,
        money: 0,
        weapon: '',
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
      };
    }
    const state = player.state;
    return {
      id: player.id,
      name: state.name,
      team: state.team,
      alive: state.alive,
      hp: state.health,
      armor: state.armor,
      money: host.moneyOf(player.id),
      weapon: player.weapon.id,
      x: state.pos.x,
      y: state.pos.y,
      z: state.pos.z,
      yaw: state.yaw,
      pitch: state.pitch,
    };
  };

  const phase = host.phaseRule;
  return {
    t: 'state',
    round: host.roundNumber,
    phase: host.phase,
    timeLeft: host.timeLeft,
    scoreT: host.scoreT,
    scoreCT: host.scoreCT,
    matchOver: host.matchOver,
    winner: host.winner,
    phaseLabel: phase.label,
    phaseIndex: phaseIndex(host),
    hostId,
    guestId,
    local: describe(guestId),
    remote: describe(hostId),
  };
}

/** The stage index, derived from the phase rules the host is running. */
function phaseIndex(host: Match): number {
  let index = 0;
  let round = 0;
  for (let i = 0; i < host.mode.phases.length; i++) {
    round += host.mode.phases[i].rounds;
    if (host.roundNumber <= round) {
      index = i;
      break;
    }
    index = i;
  }
  return index;
}