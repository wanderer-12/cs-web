// =============================================================================
// world/maps/aim_duel_lite.ts — the 1v1 duel arena.
//
// Reference: the CS:GO/CS2 community "1v1" maps (aim_*/am_*): small, mirrored,
// crate-heavy, no bomb sites, fought over a handful of lanes with hard cover.
//
// Layout, in units (1 u ~= 1.9 cm, so the arena is roughly 36 x 51 m):
//
//          +Z  (T spawn, south)                       z = +1344 wall
//   +---------+-----[ ramp ]----+--------+
//   | T spawn pad            T deck      |   decks are 128 u up, reached by a
//   |   (x -640..640)         (x 384..832,|   16 u-riser staircase ("ramp")
//   |                          z 640..1024)
//   |  west lane   [ crates ]   east lane |   the two long lanes are the AWP
//   |  x ~ -736     (centre)    x ~ +736  |   sightlines (~2300 u, 44 m)
//   | CT deck                C T spawn pad|
//   +--------+----[ ramp ]----+-----------+
//          -Z  (CT spawn, north)                    z = -1344 wall
//
// Everything is 180-degree rotationally symmetric about the origin, which is
// what makes the side switch (if a mode ever uses one) fair; the mirror pairs
// are marked in the geometry section below.
//
// IMPORTANT — there are no sloped planes: physics is AABB only (see
// world/trace.ts), so a "ramp" here is a staircase whose riser is 16 u, under
// PLAYER.stepHeight (18 u), which is both walkable and nav-linkable. A riser of
// 18 u or more becomes a wall the player cannot climb *and* the nav bake
// refuses to link across, so do not "smooth" these by raising the riser.
// =============================================================================

import type { MapData, NavNode, SpawnPoint, Vec3 } from '../../core/types';
import { MapBuilder, cloneMapData, type NavLane } from './mapBuilder';

const TINT = {
  ground: 0x9d9a93,
  plate: 0x8a8781,
  wall: 0x8f8b84,
  wallDark: 0x77736d,
  crate: 0xa9763f,
  crateDark: 0x8a5f33,
  metal: 0x7d8288,
  rail: 0x9aa0a6,
} as const;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const b = new MapBuilder();

// --- ground and shell --------------------------------------------------------

/** Floor: one slab, x -960..960, z -1344..1344. */
b.slab(-960, -64, -1344, 960, 0, 1344, 'concrete', TINT.ground, { texScale: 512 });

// Perimeter (96 u thick, 384 u tall), no doorways: the arena is sealed.
b.slab(-1024, 0, -1440, 1024, 384, -1344, 'concrete', TINT.wall); // CT end
b.slab(-1024, 0, 1344, 1024, 384, 1440, 'concrete', TINT.wall); // T end
b.slab(-1056, 0, -1440, -960, 384, 1440, 'concrete', TINT.wallDark); // west
b.slab(960, 0, -1440, 1056, 384, 1440, 'concrete', TINT.wallDark); // east

// Spawn pads: a readable 8 u step where each team starts (and the buy zone).
b.slab(-640, 0, 1088, 640, 8, 1344, 'concrete', TINT.plate);
b.slab(-640, 0, -1344, 640, 8, -1088, 'concrete', TINT.plate);

// --- centre cluster (the main cover) ----------------------------------------
// Mirror pairs for the 180-degree rotation are listed together.

// Tall central stack: blocks the spawn-to-spawn sightline.
b.box(0, 96, 0, 224, 192, 224, 'wood', { tint: TINT.crate });
// Crate towers, mirrored: (-352, 128, -160) <-> (352, 128, 160).
b.box(-352, 128, -160, 160, 256, 160, 'wood', { tint: TINT.crateDark });
b.box(352, 128, 160, 160, 256, 160, 'wood', { tint: TINT.crateDark });
// Containers, mirrored: (352, 64, -352) <-> (-352, 64, 352).
b.box(352, 64, -352, 192, 128, 288, 'metal', { tint: TINT.metal });
b.box(-352, 64, 352, 192, 128, 288, 'metal', { tint: TINT.metal });
// Waist-high crates guarding the centre, mirrored in X (z = 0 maps to itself).
b.box(-448, 48, 0, 96, 96, 256, 'wood', { tint: TINT.crate });
b.box(448, 48, 0, 96, 96, 256, 'wood', { tint: TINT.crate });

// --- long lanes (north-south cover for the AWP duels) -----------------------

// Chest-high crates in the lane, mirrored: (-736, 48, -640) <-> (736, 48, 640).
b.box(-736, 48, -640, 128, 96, 320, 'wood', { tint: TINT.crate });
b.box(736, 48, 640, 128, 96, 320, 'wood', { tint: TINT.crate });
// Second piece further up each lane: (-736, 48, 480) <-> (736, 48, -480).
b.box(-736, 48, 480, 128, 96, 256, 'metal', { tint: TINT.metal });
b.box(736, 48, -480, 128, 96, 256, 'metal', { tint: TINT.metal });

// --- side decks, reached by staircases ("ramps") ----------------------------

const DECK_TOP = 128;
/** 224 u of run over 8 treads = 28 u per tread, 16 u per riser. */
const RAMP_STEPS = 8;
const RAMP_RISE = 16;

// CT deck, mirrored to the T deck (x -832..-384, z -1024..-640 -> +x, +z).
b.slab(-832, 0, -1024, -384, DECK_TOP, -640, 'concrete', TINT.plate);
b.slab(384, 0, 640, 832, DECK_TOP, 1024, 'concrete', TINT.plate);
// Deck lips: a 64 u parapet so the deck is not a free sniping ramp.
b.slab(-832, DECK_TOP, -1024, -384, DECK_TOP + 64, -960, 'concrete', TINT.wall);
b.slab(384, DECK_TOP, 960, 832, DECK_TOP + 64, 1024, 'concrete', TINT.wall);

// CT ramp climbs west (x -160 -> -384), T ramp climbs east (x 160 -> 384).
b.stairsX(-160, -384, -928, -736, RAMP_STEPS, RAMP_RISE, 'concrete', TINT.plate);
b.stairsX(160, 384, 736, 928, RAMP_STEPS, RAMP_RISE, 'concrete', TINT.plate);

// ---------------------------------------------------------------------------
// Spawns, callouts, buy zones
// ---------------------------------------------------------------------------

/** Spawn points sit 8 u up, on top of their spawn pad. */
function duelSpawns(): SpawnPoint[] {
  const south: [number, number][] = [
    [-288, 1184],
    [0, 1248],
    [288, 1184],
    [576, 1248],
  ];
  const out: SpawnPoint[] = [];
  south.forEach(([x, z], i) => {
    out.push({ pos: { x, y: 8, z }, yaw: 0, team: 'T', index: i });
    // 180-degree mirror of the same slot, facing back down the arena.
    out.push({ pos: { x: -x, y: 8, z: -z }, yaw: Math.PI, team: 'CT', index: i });
  });
  return out;
}

const callouts: Record<string, Vec3> = {
  TSpawn: { x: 0, y: 8, z: 1200 },
  CTSpawn: { x: 0, y: 8, z: -1200 },
  Mid: { x: 0, y: 0, z: 0 },
  WestLane: { x: -736, y: 0, z: 0 },
  EastLane: { x: 736, y: 0, z: 0 },
  TDeck: { x: 608, y: DECK_TOP, z: 832 },
  CTDeck: { x: -608, y: DECK_TOP, z: -832 },
  TRamp: { x: 288, y: 64, z: 832 },
  CTRamp: { x: -288, y: 64, z: -832 },
};

const buyZones = [
  { team: 'T' as const, min: { x: -672, y: 0, z: 1056 }, max: { x: 672, y: 384, z: 1376 } },
  { team: 'CT' as const, min: { x: -672, y: 0, z: -1376 }, max: { x: 672, y: 384, z: -1056 } },
];

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Region label per node; also the label bots use to pick a lane. */
function areaAt(p: Vec3): string {
  if (p.y > DECK_TOP - 8 && p.z < -600) return 'CTDeck';
  if (p.y > DECK_TOP - 8 && p.z > 600) return 'TDeck';
  if (p.z > 960) return 'TSpawn';
  if (p.z < -960) return 'CTSpawn';
  if (p.x < -560) return 'WestLane';
  if (p.x > 560) return 'EastLane';
  if (p.z < -400) return 'CTMid';
  if (p.z > 400) return 'TMid';
  return 'Mid';
}

/** True around the centre cluster: bots hold rather than push through it. */
function chokeAt(p: Vec3): boolean {
  return Math.abs(p.z) < 400 && Math.abs(p.x) < 520;
}

/**
 * The two staircases need explicit lanes: a 96 u grid straddles 28 u treads and
 * would either miss them or link two treads 32 u apart in height (over the
 * 24 u rise budget), which silently made the decks unreachable.
 */
function rampLanes(): NavLane[] {
  const ct: [number, number, number][] = [];
  const t: [number, number, number][] = [];
  for (let k = 1; k <= RAMP_STEPS; k++) {
    // Centre of tread k, at its own top: the CT ramp runs west, the T ramp east.
    const x = 160 + (k - 1) * 28 + 14;
    ct.push([-x, RAMP_RISE * k, -832]);
    t.push([x, RAMP_RISE * k, 832]);
  }
  ct.push([-480, DECK_TOP, -832]); // step off onto the deck
  t.push([480, DECK_TOP, 832]);
  return [
    { area: 'CTRamp', pts: ct, choke: true },
    { area: 'TRamp', pts: t, choke: true },
  ];
}

const nav: NavNode[] = b.gridNav({
  step: 96,
  ceiling: 320,
  lanes: rampLanes(),
  seeds: [
    { x: 0, y: 8, z: 1184 },
    { x: 0, y: 8, z: -1184 },
    { x: 0, y: 0, z: 0 },
  ],
  areaAt,
  chokeAt,
});

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

/** The authoritative arena. Treat as read-only; use {@link buildAimDuelLite}. */
export const AIM_DUEL_LITE: MapData = b.finish({
  name: 'aim_duel_lite',
  spawns: duelSpawns(),
  nav,
  callouts,
  buyZones,
});

/** Deep copy of the map so callers can mutate their own working set freely. */
export function buildAimDuelLite(): MapData {
  return cloneMapData(AIM_DUEL_LITE);
}