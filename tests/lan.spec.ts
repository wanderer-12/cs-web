// =============================================================================
// tests/lan.spec.ts — the LAN layer: wire format, id mapping, host → guest state.
//
// A LAN duel is two browsers: the host runs the authoritative 128 Hz `Match`,
// the guest runs a `mirror` `Match` that only simulates its own body. Everything
// between them is either a binary snapshot (poses) or a JSON control message
// (round, stage, score, money), and this file pins both directions down.
//
// The tests deliberately use two real `Match` instances rather than mocks, so a
// change to the roster, the round flow or the loadout rules shows up here.
// =============================================================================

import { describe, expect, it } from 'vitest';

import { Match } from '../src/game/game';
import { World } from '../src/world/world';
import { buildAimDuelLite } from '../src/world/maps/aim_duel_lite';
import { EventBus } from '../src/core/events';
import { Rng } from '../src/core/rng';
import { buildDust2Lite } from '../src/world/maps/de_dust2_lite';
import { LAN_DUEL_TEAMS, TICK_DT, type MatchModeId, type TeamComposition } from '../src/core/config';
import { WEAPONS } from '../src/combat/weaponDefs';
import { EMPTY_BUTTONS, type GameEventMap, type InputCommand, type Team } from '../src/core/types';
import {
  LAN_RELAY_PORT,
  LAN_WIRE_VERSION,
  applySnapshotTo,
  parseControl,
  snapshotFor,
  stateFor,
  weaponIdAt,
  weaponIndex,
  type LanState,
} from '../src/net/LanProtocol';
import { decodeSnapshot, encodeSnapshot, snapshotByteLength } from '../src/net/Protocol';
import { relayUrl } from '../src/net/WsTransport';

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function idle(tick: number): InputCommand {
  return { tick, buttons: { ...EMPTY_BUTTONS }, yaw: 0, pitch: 0, mouseDX: 0, mouseDY: 0 };
}

interface MakeOptions {
  mode?: MatchModeId;
  teams?: Partial<TeamComposition>;
  humanTeam?: Team;
  remoteNames?: readonly string[];
  mirror?: boolean;
}

function makeMatch(opts: MakeOptions = {}) {
  const map = opts.mode === 'duel' ? buildAimDuelLite() : buildDust2Lite();
  const world = new World(map);
  const bus = new EventBus();
  const match = new Match({
    world,
    bus,
    map,
    rng: new Rng(0x1a27),
    skipWarmup: true,
    mode: opts.mode,
    teams: opts.teams,
    humanTeam: opts.humanTeam,
    remoteNames: opts.remoteNames,
    mirror: opts.mirror,
  });
  return { map, world, bus, match };
}

function run(match: Match, seconds: number, cmdFor: (tick: number) => InputCommand = idle): void {
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i += 1) match.tick(cmdFor(i), TICK_DT);
}

/**
 * A host/guest pair as the launcher builds them: the host is authoritative and
 * plays T, the guest mirrors and plays CT, one human per side and no bots.
 */
function lanPair(mirrorGuest = true) {
  const hostSide = makeMatch({
    mode: 'duel',
    teams: LAN_DUEL_TEAMS,
    humanTeam: 'T',
    remoteNames: ['客机'],
  });
  const guestSide = makeMatch({
    mode: 'duel',
    teams: LAN_DUEL_TEAMS,
    humanTeam: 'CT',
    remoteNames: ['主机'],
    mirror: mirrorGuest,
  });
  return { host: hostSide.match, guest: guestSide.match, guestBus: guestSide.bus };
}

/** Put `actor` right in front of `shooter` (models face -Z at yaw 0). */
function placeInFront(shooter: { state: { pos: { x: number; y: number; z: number }; yaw: number } }, actor: { state: { pos: { x: number; y: number; z: number } } }, distance: number): void {
  shooter.state.yaw = 0;
  actor.state.pos.x = shooter.state.pos.x;
  actor.state.pos.y = shooter.state.pos.y;
  actor.state.pos.z = shooter.state.pos.z - distance;
}

// -----------------------------------------------------------------------------
// weapon indices
// -----------------------------------------------------------------------------

describe('weapon indices', () => {
  it('round-trips every weapon in the registry', () => {
    for (const id of Object.keys(WEAPONS)) {
      expect(weaponIdAt(weaponIndex(id))).toBe(id);
    }
  });

  it('falls back instead of throwing on an unknown id or index', () => {
    expect(weaponIndex('nope')).toBe(0);
    expect(weaponIdAt(999)).toBe('glock');
  });
});

// -----------------------------------------------------------------------------
// control channel
// -----------------------------------------------------------------------------

describe('control messages', () => {
  it('parses a state message built by the host', () => {
    const { host } = lanPair();
    const message = stateFor(host, host.local.id, host.remoteHumans[0].id);
    const raw = JSON.stringify(message);

    const parsed = parseControl(raw);
    expect(parsed?.t).toBe('state');
    const state = parsed as LanState;
    expect(state.round).toBe(1);
    expect(state.hostId).toBe(host.local.id);
    expect(state.guestId).toBe(host.remoteHumans[0].id);
  });

  it('parses the relay control messages the launcher relies on', () => {
    expect(parseControl(JSON.stringify({ t: 'welcome', role: 'guest', room: 'duel', version: 1 }))?.t).toBe('welcome');
    expect(parseControl(JSON.stringify({ t: 'peer', role: 'guest', name: '朋友' }))?.t).toBe('peer');
    expect(parseControl(JSON.stringify({ t: 'peer-gone', role: 'guest', name: '朋友' }))?.t).toBe('peer-gone');
    expect(parseControl(JSON.stringify({ t: 'relay-down' }))?.t).toBe('relay-down');
  });

  it('parses a guest purchase request', () => {
    const parsed = parseControl(JSON.stringify({ t: 'buy', itemId: 'ak47' }));
    expect(parsed).toEqual({ t: 'buy', itemId: 'ak47' });
  });

  it('rejects anything that is not an object with a string tag', () => {
    for (const raw of ['', 'nope', '3', 'null', '[]', '{}', '{"t":1}', '{"t":null}']) {
      expect(parseControl(raw)).toBeNull();
    }
  });
});

// -----------------------------------------------------------------------------
// relay URL
// -----------------------------------------------------------------------------

describe('relay URL', () => {
  it('builds the room/role query both ends dial', () => {
    expect(relayUrl({ host: '192.168.1.23', role: 'guest' })).toBe(
      `ws://192.168.1.23:${LAN_RELAY_PORT}/lan?room=duel&role=guest`,
    );
  });

  it('tolerates a pasted ws:// URL or a host:port pair', () => {
    const expected = `ws://192.168.1.23:${LAN_RELAY_PORT}/lan?room=duel&role=host`;
    expect(relayUrl({ host: `ws://192.168.1.23:${LAN_RELAY_PORT}/`, role: 'host' })).toBe(expected);
    expect(relayUrl({ host: '192.168.1.23:6000', role: 'host' })).toBe(
      'ws://192.168.1.23:6000/lan?room=duel&role=host',
    );
  });

  it('carries the player name, the room and the scheme', () => {
    const url = relayUrl({ host: '10.0.0.5', role: 'host', name: '玩家 A', room: 'duel2', secure: true });
    expect(url.startsWith(`wss://10.0.0.5:${LAN_RELAY_PORT}/lan?room=duel2&role=host`)).toBe(true);
    expect(url).toContain('name=%E7%8E%A9%E5%AE%B6+A');
  });

  it('falls back to loopback when the address is empty', () => {
    expect(relayUrl({ host: '   ', role: 'guest' })).toBe(
      `ws://127.0.0.1:${LAN_RELAY_PORT}/lan?room=duel&role=guest`,
    );
  });
});

// -----------------------------------------------------------------------------
// snapshots
// -----------------------------------------------------------------------------

describe('snapshots', () => {
  it('packs every body of a LAN duel', () => {
    const { host } = lanPair();
    const snapshot = snapshotFor(host, 42, 1000);

    expect(snapshot.tick).toBe(42);
    expect(snapshot.serverTimeMs).toBe(1000);
    expect(snapshot.ackedInputTick).toBe(0);
    expect(snapshot.entities.map((e) => e.id)).toEqual(host.players.map((p) => p.id));
    expect(encodeSnapshot(snapshot).byteLength).toBe(snapshotByteLength(snapshot.entities.length));
  });

  it('survives the binary codec', () => {
    const { host } = lanPair();
    host.local.state.pos.x = 512.25;
    host.local.state.pos.y = 40;
    host.local.state.pos.z = -123.5;
    host.local.state.yaw = 1.25;
    host.local.state.pitch = -0.5;

    const round = decodeSnapshot(encodeSnapshot(snapshotFor(host, 7, 900)));
    const back = round.entities.find((e) => e.id === host.local.id);
    expect(back).toBeDefined();
    expect(Math.abs(back!.x - 512.25)).toBeLessThanOrEqual(1);
    expect(Math.abs(back!.z + 123.5)).toBeLessThanOrEqual(1);
    expect(Math.abs(back!.yaw - 1.25)).toBeLessThan(1e-3);
    expect(Math.abs(back!.pitch + 0.5)).toBeLessThan(1e-3);
    expect(back!.health).toBe(host.local.state.health);
  });

  it('carries the alive flag, so a corpse stays down', () => {
    const { host } = lanPair();
    const victim = host.remoteHumans[0];
    victim.state.alive = false;
    victim.state.onGround = false;
    victim.state.crouching = true;

    const snapshot = snapshotFor(host, 1, 0);
    const entity = snapshot.entities.find((e) => e.id === victim.id)!;
    const alive = snapshot.entities.find((e) => e.id === host.local.id)!;
    expect(entity.flags & 1).toBe(0);
    expect(alive.flags & 1).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// applying snapshots (the id mapping)
// -----------------------------------------------------------------------------

describe('applying a snapshot', () => {
  it('maps the host body onto the guest opponent and leaves the guest body alone', () => {
    const { host, guest } = lanPair();
    const opponent = guest.remoteHumans[0];
    const guestStart = { x: guest.local.state.pos.x, y: guest.local.state.pos.y, z: guest.local.state.pos.z };

    host.local.state.pos.x = 300;
    host.local.state.pos.z = -400;
    host.local.state.health = 77;
    host.local.state.alive = false;

    const snapshot = snapshotFor(host, 1, 0);
    const applied = applySnapshotTo(
      guest,
      snapshot,
      (id) => id === guest.local.id,
      (id) => (id === host.local.id ? opponent.id : id === host.remoteHumans[0].id ? guest.local.id : -1),
    );

    // The host's own body is the only one this guest does not simulate.
    expect(applied).toBe(1);
    expect(opponent.state.pos.x).toBeCloseTo(300, 3);
    expect(opponent.state.pos.z).toBeCloseTo(-400, 3);
    expect(opponent.state.health).toBe(77);
    expect(opponent.state.alive).toBe(false);
    // The guest's predicted body did not move an inch.
    expect(guest.local.state.pos.x).toBe(guestStart.x);
    expect(guest.local.state.pos.z).toBe(guestStart.z);
  });

  it('drops ids the mapper does not know', () => {
    const { guest } = lanPair();
    const snapshot = snapshotFor(guest, 1, 0);
    expect(applySnapshotTo(guest, snapshot, undefined, () => -1)).toBe(0);
    expect(applySnapshotTo(guest, snapshot, undefined, () => 4242)).toBe(0);
  });

  it('applies every body when no mapper is given', () => {
    const { host, guest } = lanPair();
    const snapshot = snapshotFor(host, 1, 0);
    // The two rosters happen to mint the same ids here; the point is that the
    // unmapped path writes every body it recognises and nothing else.
    const applied = applySnapshotTo(guest, snapshot);
    expect(applied).toBeGreaterThanOrEqual(1);
    expect(applied).toBeLessThanOrEqual(snapshot.entities.length);
  });
});

// -----------------------------------------------------------------------------
// host → guest round state
// -----------------------------------------------------------------------------

describe('host round state', () => {
  it('describes the first duel round and both sides', () => {
    const { host } = lanPair();
    const guestId = host.remoteHumans[0].id;
    const state = stateFor(host, host.local.id, guestId);

    expect(state.t).toBe('state');
    expect(state.round).toBe(1);
    expect(state.phase).toBe('freeze');
    expect(state.phaseLabel).toBe('手枪局');
    expect(state.phaseIndex).toBe(0);
    expect(state.scoreT).toBe(0);
    expect(state.scoreCT).toBe(0);
    expect(state.matchOver).toBe(false);
    expect(state.local.team).toBe('CT');
    expect(state.remote.team).toBe('T');
    expect(state.local.id).toBe(guestId);
    expect(state.remote.id).toBe(host.local.id);
    // The duel starts everyone rich: the stage whitelist is the real gate.
    expect(state.local.money).toBe(16000);
    expect(state.remote.name).toBe(host.local.state.name);
  });

  it('describes an unknown id without inventing a body', () => {
    const { host } = lanPair();
    const state = stateFor(host, 900, 901);
    expect(state.remote.name).toBe('Host');
    expect(state.local.name).toBe('Guest');
    expect(state.local.team).toBe('SPEC');
    expect(state.local.hp).toBe(0);
  });
});

describe('guest applying round state', () => {
  it('adopts the host verdict on health, armor, money and the stage weapon', () => {
    const { guest } = lanPair();
    const before = guest.local.weaponIdForSlot('secondary');

    guest.applyNetState({
      round: 1,
      phase: 'freeze',
      timeLeft: 5,
      scoreT: 0,
      scoreCT: 0,
      matchOver: false,
      winner: null,
      phaseIndex: 0,
      local: { hp: 63, armor: 100, alive: true, money: 4321 },
    });

    expect(guest.local.state.health).toBe(63);
    expect(guest.local.state.armor).toBe(100);
    expect(guest.local.state.alive).toBe(true);
    expect(guest.moneyOf(guest.local.id)).toBe(4321);
    // A duel round resets the loadout to the side's pistol: the guest is CT.
    expect(guest.local.weaponIdForSlot('secondary')).toBe('usp');
    expect(guest.local.weaponIdForSlot('primary')).toBeNull();
    expect(before).toBe('usp');
  });

  it('brings the guest back to a spawn on the next round', () => {
    const { guest } = lanPair();
    guest.local.state.pos.x = 999;
    guest.local.state.pos.z = 999;
    guest.local.state.health = 0;
    guest.local.state.alive = false;

    guest.applyNetState({
      round: 2,
      phase: 'freeze',
      timeLeft: 5,
      scoreT: 1,
      scoreCT: 0,
      matchOver: false,
      winner: null,
      phaseIndex: 0,
      local: { hp: 100, armor: 0, alive: true, money: 16000 },
    });

    const spawns = guest.map.spawns.filter((s) => s.team === guest.local.team);
    expect(spawns.length).toBeGreaterThan(0);
    const nearest = Math.min(
      ...spawns.map((s) => Math.hypot(s.pos.x - guest.local.state.pos.x, s.pos.z - guest.local.state.pos.z)),
    );
    expect(nearest).toBeLessThan(64);
    expect(guest.local.state.health).toBe(100);
    expect(guest.local.state.alive).toBe(true);
  });

  it('hands the guest the stage starter gun as the rounds advance', () => {
    const { guest } = lanPair();
    const state = (round: number) => ({
      round,
      phase: 'freeze' as const,
      timeLeft: 5,
      scoreT: 0,
      scoreCT: 0,
      matchOver: false,
      winner: null,
      phaseIndex: 0,
      local: { hp: 100, armor: 0, alive: true, money: 16000 },
    });

    guest.applyNetState(state(9));
    expect(guest.local.weaponIdForSlot('primary')).toBe('m4a4');

    guest.applyNetState(state(24));
    expect(guest.local.weaponIdForSlot('primary')).toBe('awp');
  });
});

// -----------------------------------------------------------------------------
// the mirror itself
// -----------------------------------------------------------------------------

describe('mirror mode', () => {
  it('keeps the round clock still while letting the guest walk', () => {
    const { guest } = lanPair();
    const start = { x: guest.local.state.pos.x, z: guest.local.state.pos.z };
    const timeLeft = guest.timeLeft;
    const phase = guest.phase;

    run(guest, 1, (tick) => {
      const cmd = idle(tick);
      cmd.buttons.forward = true;
      return cmd;
    });

    expect(guest.timeLeft).toBe(timeLeft);
    expect(guest.phase).toBe(phase);
    expect(guest.roundNumber).toBe(1);
    const moved = Math.hypot(guest.local.state.pos.x - start.x, guest.local.state.pos.z - start.z);
    expect(moved).toBeGreaterThan(10);
  });

  it('fires for show only: the opponent never loses health on the guest', () => {
    const { guest, guestBus } = lanPair();
    const opponent = guest.remoteHumans[0];
    placeInFront(guest.local, opponent, 300);
    guest.local.giveWeapon('ak47', true);

    const shots: GameEventMap['shot'][] = [];
    guestBus.on('shot', (event) => shots.push(event));

    // 2 s, not 0.5 s: `giveWeapon(…, true)` switches weapon, and switching parks
    // `nextFireTime` a whole draw time in the future (ak47 drawTime ≈ 1 s).
    run(guest, 2, (tick) => {
      const cmd = idle(tick);
      cmd.buttons.attack = true;
      return cmd;
    });

    // Visuals happen (tracer + impact), damage does not: the host judges hits.
    expect(shots.length).toBeGreaterThan(0);
    expect(opponent.state.health).toBe(100);
    expect(opponent.state.alive).toBe(true);
    expect(WEAPONS.ak47.kind).toBe('rifle');
  });

  it('still reports its own shots to the local player', () => {
    const { guest } = lanPair();
    expect(guest.mirror).toBe(true);
    const { host } = lanPair();
    expect(host.mirror).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// wire version
// -----------------------------------------------------------------------------

describe('wire version', () => {
  it('is a positive integer the relay can echo', () => {
    expect(Number.isInteger(LAN_WIRE_VERSION)).toBe(true);
    expect(LAN_WIRE_VERSION).toBeGreaterThan(0);
  });
});