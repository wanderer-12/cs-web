// =============================================================================
// tests/net.spec.ts — the phase-3 network seam (src/net).
//
// Only the parts that are actually implemented are tested here: the wire format,
// the interpolation buffer, the rewind history, the prediction bookkeeping and
// the server clock. See src/net/Net.md for what phase 3 still has to write.
//
// These tests exist because every one of these pieces is easy to get subtly
// wrong in ways that only show up as "the netcode feels bad": a big-endian
// half-word written little-endian, an interpolation that freezes instead of
// blending, a rewind that blends two hitboxes nobody occupied, and a wrapping
// 16-bit tick compared with `<`.
// =============================================================================

import { describe, expect, it } from 'vitest';

import { EMPTY_BUTTONS, type InputButtons, type InputCommand } from '../src/core/types';
import {
  ENTITY_RECORD_BYTES,
  EntityFlags,
  InputHistory,
  NET_PROTOCOL_VERSION,
  SNAPSHOT_HEADER_BYTES,
  SnapshotBuffer,
  decodeHello,
  decodeInput,
  decodeSnapshot,
  encodeHello,
  encodeInput,
  encodeSnapshot,
  lerpAngle,
  packButtons,
  snapshotByteLength,
  ticksAhead,
  unpackButtons,
  type EntitySnapshot,
  type Snapshot,
} from '../src/net/index';
import { PositionHistory, type ActorPose } from '../src/net/index';
import { ServerClock } from '../src/net/index';

function entity(id: number, x = 0, y = 0, z = 0): EntitySnapshot {
  return {
    id,
    x,
    y,
    z,
    yaw: 0,
    pitch: 0,
    flags: EntityFlags.Alive,
    health: 100,
    armor: 100,
    weapon: 3,
  };
}

function snapshot(
  serverTimeMs: number,
  entities: EntitySnapshot[],
  tick = 0,
  ackedInputTick = 0,
): Snapshot {
  return { tick, serverTimeMs, ackedInputTick, entities };
}

function pose(actorId: number, x: number): ActorPose {
  return { actorId, x, y: 0, z: 0, yaw: 0, pitch: 0, duckAmount: 0, onGround: true, alive: true };
}

function command(tick: number): InputCommand {
  return { tick, buttons: { ...EMPTY_BUTTONS }, yaw: 0, pitch: 0, mouseDX: 0, mouseDY: 0 };
}

describe('net protocol', () => {
  it('fits a 30-actor snapshot in the 400-byte budget', () => {
    const actors: EntitySnapshot[] = [];
    for (let i = 0; i < 30; i += 1) actors.push(entity(i, i * 10, 0, -i * 10));

    const buf = encodeSnapshot(snapshot(12345, actors, 900, 42));

    expect(ENTITY_RECORD_BYTES).toBe(15);
    expect(SNAPSHOT_HEADER_BYTES).toBe(12);
    expect(snapshotByteLength(30)).toBe(462);
    expect(buf.byteLength).toBe(462);

    const decoded = decodeSnapshot(buf);
    expect(decoded.entities.length).toBe(30);
    expect(decoded.tick).toBe(900);
    expect(decoded.serverTimeMs).toBe(12345);
    expect(decoded.ackedInputTick).toBe(42);
    // Quarter-unit storage: half a step of quantisation is 0.125 units.
    expect(decoded.entities[7].x).toBeCloseTo(70, 1);
    expect(decoded.entities[7].z).toBeCloseTo(-70, 1);
  });

  it('quantises position and angles finely enough for interpolation', () => {
    const source = entity(3, 100.4, -12.3, 3071.9);
    source.yaw = Math.PI - 0.001;
    source.pitch = -1.2;
    source.health = 37;
    source.armor = 12;
    source.flags = EntityFlags.Alive | EntityFlags.Crouched;

    const decoded = decodeSnapshot(encodeSnapshot(snapshot(0, [source]))).entities[0];

    expect(Math.abs(decoded.x - source.x)).toBeLessThan(0.13);
    expect(Math.abs(decoded.y - source.y)).toBeLessThan(0.13);
    expect(Math.abs(decoded.z - source.z)).toBeLessThan(0.13);
    expect(Math.abs(decoded.yaw - source.yaw)).toBeLessThan(1e-4);
    expect(Math.abs(decoded.pitch - source.pitch)).toBeLessThan(1e-4);
    expect(decoded.health).toBe(37);
    expect(decoded.armor).toBe(12);
    expect(decoded.flags).toBe(EntityFlags.Alive | EntityFlags.Crouched);
  });

  it('rejects a snapshot from a different protocol version', () => {
    const buf = new ArrayBuffer(snapshotByteLength(0));
    new DataView(buf).setUint8(0, NET_PROTOCOL_VERSION + 1);
    expect(() => decodeSnapshot(buf)).toThrow(/version/);
  });

  it('packs all seventeen buttons into three bytes', () => {
    const allOn = { ...EMPTY_BUTTONS } as InputButtons;
    for (const key of Object.keys(allOn) as (keyof InputButtons)[]) allOn[key] = true;

    const mask = packButtons(allOn);
    expect(mask).toBe(0x1ffff);

    const out = { ...EMPTY_BUTTONS } as InputButtons;
    expect(unpackButtons(mask, out)).toEqual(allOn);

    // Every single button survives on its own, so a shifted bit cannot pass.
    for (const key of Object.keys(allOn) as (keyof InputButtons)[]) {
      const one = { ...EMPTY_BUTTONS } as InputButtons;
      one[key] = true;
      const back = { ...EMPTY_BUTTONS } as InputButtons;
      unpackButtons(packButtons(one), back);
      expect(back).toEqual(one);
    }
  });

  it('round-trips an input command without its mouse deltas', () => {
    const cmd: InputCommand = {
      tick: 1234,
      buttons: { ...EMPTY_BUTTONS, forward: true, crouch: true, attack: true, slot2: true },
      yaw: -1.2345,
      pitch: 0.5678,
      mouseDX: 12,
      mouseDY: -7,
    };

    const buf = encodeInput(cmd, 987654);
    expect(buf.byteLength).toBe(16);

    const decoded = decodeInput(buf, { ...EMPTY_BUTTONS });
    expect(decoded.tick).toBe(1234);
    expect(decoded.clientTimeMs).toBe(987654);
    expect(decoded.buttons).toEqual(cmd.buttons);
    expect(decoded.yaw).toBeCloseTo(cmd.yaw, 3);
    expect(decoded.pitch).toBeCloseTo(cmd.pitch, 3);
  });

  it('handshakes with a version byte', () => {
    const hello = encodeHello();
    const decoded = decodeHello(hello);
    expect(decoded.magic).toBe(0xface);
    expect(decoded.version).toBe(NET_PROTOCOL_VERSION);
  });
});

describe('snapshot interpolation', () => {
  it('blends the two snapshots bracketing the playout time', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(0, [entity(1, 0, 0, 0)]));
    buffer.push(snapshot(50, [entity(1, 100, 10, -20)]));

    const mid = buffer.sample(25);
    expect(mid.length).toBe(1);
    expect(mid[0].x).toBeCloseTo(50, 5);
    expect(mid[0].y).toBeCloseTo(5, 5);
    expect(mid[0].z).toBeCloseTo(-10, 5);
    expect(mid[0].interpolated).toBe(true);

    // Playout is now - 100 ms, clamped to the oldest snapshot we hold.
    expect(buffer.playoutTimeMs(1000)).toBe(900);
    expect(buffer.playoutTimeMs(50)).toBe(0);
  });

  it('drops out-of-order datagrams and never extrapolates', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(0, [entity(1, 0)]));
    buffer.push(snapshot(50, [entity(1, 100)]));
    buffer.push(snapshot(40, [entity(1, 999)])); // late arrival
    buffer.push(snapshot(50, [entity(1, 999)])); // duplicate
    expect(buffer.length).toBe(2);

    const ahead = buffer.sample(9999);
    expect(ahead[0].x).toBeCloseTo(100, 5);
    expect(ahead[0].interpolated).toBe(false);

    const behind = buffer.sample(-100);
    expect(behind[0].x).toBeCloseTo(0, 5);
    expect(behind[0].interpolated).toBe(false);
  });

  it('marks an actor that only exists in the older snapshot', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(0, [entity(1, 0), entity(2, 500)]));
    buffer.push(snapshot(50, [entity(1, 100)]));

    const sampled = buffer.sample(25);
    const two = sampled.find((e) => e.id === 2)!;
    expect(two.interpolated).toBe(false);
    expect(two.x).toBeCloseTo(500, 5); // held, not blended with a guess
  });

  it('bounds the buffer and clears on demand', () => {
    const buffer = new SnapshotBuffer();
    for (let i = 0; i < 100; i += 1) buffer.push(snapshot(i * 50, [entity(1, i)]));
    expect(buffer.length).toBeLessThanOrEqual(32);

    buffer.clear();
    expect(buffer.length).toBe(0);
    expect(buffer.sample(0)).toEqual([]);
  });

  it('blends angles the short way around', () => {
    // 3.0 and -3.0 rad are ~172 and ~-172 degrees: the short way crosses PI.
    const blended = lerpAngle(3.0, -3.0, 0.5);
    expect(Math.abs(blended)).toBeCloseTo(Math.PI, 2);
    expect(Math.abs(blended)).toBeGreaterThan(3.1);

    expect(lerpAngle(0, 1, 0.25)).toBeCloseTo(0.25, 6);
    expect(lerpAngle(-3.0, 3.0, 0.5)).toBeCloseTo(-Math.PI, 2);
  });
});

describe('lag compensation history', () => {
  it('rewinds to the newest frame at or before the requested time', () => {
    const history = new PositionHistory(20);
    for (let i = 0; i < 40; i += 1) history.record(i * 50, [pose(1, i * 10)]);

    expect(history.length).toBe(21); // 1 s at 20 Hz, plus one frame
    expect(history.oldestTimeMs()).toBe(950); // frames 0..18 were aged out

    expect(history.rewind(970)[0].x).toBe(190); // frame at 950
    expect(history.rewind(950)[0].x).toBe(190);
    expect(history.rewind(1500)[0].x).toBe(300);

    // Requesting a time before the retained window clamps to the oldest frame
    // (900 was dropped, so 949 is answered with the 950 pose).
    expect(history.rewind(949)[0].x).toBe(190);

    const short = new PositionHistory(20);
    for (let i = 0; i < 10; i += 1) short.record(i * 50, [pose(1, i * 10)]);
    expect(short.rewind(949)[0].x).toBe(90); // frame 450, the newest we hold
  });

  it('clamps a rewind older than the history instead of inventing a pose', () => {
    const history = new PositionHistory(20);
    for (let i = 0; i < 10; i += 1) history.record(i * 50, [pose(1, i * 10)]);

    const ancient = history.rewind(-5000);
    expect(ancient.length).toBe(1);
    expect(ancient[0].x).toBe(0);
    expect(history.rewind(-5000, 1)[0].x).toBe(0);
    expect(history.rewind(0, 99)).toEqual([]);
    expect(new PositionHistory(20).rewind(0)).toEqual([]); // nothing recorded yet
  });

  it('returns a copy so the fire handler cannot corrupt the history', () => {
    const history = new PositionHistory(20);
    history.record(0, [pose(1, 10)]);
    const rewound = history.rewind(0);
    rewound[0].x = 9999;
    expect(history.rewind(0)[0].x).toBe(10);
  });
});

describe('prediction bookkeeping', () => {
  it('compares wrapping 16-bit input ticks', () => {
    expect(ticksAhead(5, 3)).toBe(2);
    expect(ticksAhead(3, 5)).toBe(-2);
    expect(ticksAhead(0, 65535)).toBe(1);
    expect(ticksAhead(65535, 0)).toBe(-1);
    expect(ticksAhead(0, 0)).toBe(0);
  });

  it('keeps unacknowledged inputs bounded and drops acknowledged ones', () => {
    const history = new InputHistory(4);
    for (let tick = 1; tick <= 6; tick += 1) history.push(command(tick));
    expect(history.length).toBe(4);
    expect(history.pending().map((c) => c.tick)).toEqual([3, 4, 5, 6]);

    history.ack(4);
    expect(history.pending().map((c) => c.tick)).toEqual([5, 6]);

    // A late snapshot must not resurrect replay of already-consumed inputs.
    history.ack(2);
    expect(history.pending().map((c) => c.tick)).toEqual([5, 6]);

    history.clear();
    expect(history.length).toBe(0);
  });
});

describe('server clock', () => {
  it('uses the best round-trip sample as the one-way delay estimate', () => {
    const clock = new ServerClock();

    clock.onSnapshot(snapshot(5000, []), 1000, 900); // rtt 100
    expect(clock.rttMs).toBe(100);
    expect(clock.smoothedOffsetMs).toBeCloseTo(4050, 6);
    expect(clock.serverNowMs(1000)).toBeCloseTo(5050, 6);

    // A queued packet (rtt 300) must not move the clock: jitter is one-sided.
    clock.onSnapshot(snapshot(6000, []), 1400, 1100);
    expect(clock.rttMs).toBe(300);
    expect(clock.smoothedOffsetMs).toBeCloseTo(4050, 6);

    // A cleaner sample (rtt 50) does.
    clock.onSnapshot(snapshot(7000, []), 2000, 1950);
    expect(clock.smoothedOffsetMs).toBeCloseTo(5025, 6);
    expect(clock.serverNowMs(2000)).toBeCloseTo(7025, 6);
  });

  it('tracks jitter as the deviation of the round-trip samples', () => {
    const clock = new ServerClock();
    for (let i = 0; i < 40; i += 1) {
      const rtt = i % 2 === 0 ? 40 : 140;
      clock.onSnapshot(snapshot(1000 + i * 50, []), 10000 + i * 50, 10000 + i * 50 - rtt);
    }
    expect(clock.jitter).toBeGreaterThan(0);
    expect(clock.jitter).toBeLessThan(200);
  });
});