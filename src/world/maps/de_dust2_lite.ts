// =============================================================================
// world/maps/de_dust2_lite.ts — hand-authored, structurally faithful but
// deliberately SIMPLIFIED de_dust2 in CS units (1 unit ~= 1.9 cm).
//
// Layout (Y up, outside terrain at y = 0, +Z is toward T spawn):
//
//     z=+2400   T spawn  -----------------------------> long doors
//                  |     \                                  |
//     z=+ 600      |      mid ....................... long A
//                  |        |          catwalk              |
//     z=  -300   B doors   mid doors                        |
//                  |        |                               |
//     z= -1300  upper tun. mid                        pit (y=-48)
//                  |        |                               |
//     z= -1950  back plat   |  CT retake ramp >  A site (y=128)
//                  |        |                               |
//     z= -2400   B site -- CT spawn ------------------------
//
// Design constraints that shaped every number below:
//
//  * Collision is AABB-only and brushes may only yaw (see core/types.ts and
//    world/trace.ts). There is no sloped plane, so EVERY height change is a
//    staircase with rise <= PLAYER.stepHeight (18): long A -> A site, the CT
//    retake ramp, mid -> catwalk, the upper tunnel and the back plat.
//  * The player is a 16-radius, 72-tall box with an 18 step, so every doorway is
//    >= 48 wide (mid doors) and every corridor is >= 200 wide.
//  * Nav nodes sit ON the walkable surface (node.y == floor top). A node on a
//    step therefore touches that step's AABB, and the straight line between two
//    nodes on adjacent treads necessarily cuts the step corner. Both the linker
//    here and tests/map.spec.ts use the same "step-over" rule: a brush does not
//    block a link when its top is at or below the higher node AND the climb from
//    the lower node is <= stepHeight. That is exactly what makes a tread
//    walkable rather than a wall, and it is the only rule under which a stair
//    link can ever be valid.
//
// Brush ids come from one monotonic counter, so they are always sequential from
// 1 (hand-numbering ~150 brushes reliably produces duplicates).
// =============================================================================

import { PLAYER } from '../../core/config';
import type {
  AABB,
  BombSiteRegion,
  Brush,
  MapData,
  NavNode,
  SpawnPoint,
  SurfaceMaterial,
  Vec3,
} from '../../core/types';

// ---------------------------------------------------------------------------
// Brush authoring helpers
// ---------------------------------------------------------------------------

/** Tints split the map into a handful of merged meshes (one per material+tint). */
const TINT = {
  ground: 0xd8c7a1,
  floor: 0xcdbd9c,
  plate: 0xb3a17f,
  wall: 0xbfae8e,
  wallDark: 0x9d8d72,
  concrete: 0xb9b3a6,
  crate: 0x9a6c3c,
  crateDark: 0x7d5730,
  metal: 0x8d939c,
  rail: 0x8f8574,
} as const;

/**
 * Extra brush fields a call site may set. `yaw` is deliberately kept in the
 * allowed set: a handful of brushes (door leaves, the B-site car) are rotated,
 * and dropping the rotation would silently flatten them.
 */
type BrushExtra = Partial<Omit<Brush, 'id' | 'pos' | 'size' | 'material'>>;

/** Every brush of the map, in authoring order. */
const brushes: Brush[] = [];

let nextBrushId = 1;

/**
 * The one box helper: x/y/z is the box CENTER, sx/sy/sz are full extents.
 * It records the brush as well as returning it, so a call site may ignore the
 * result (`box(...)` as a statement) or keep the handle.
 */
function box(
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  material: SurfaceMaterial,
  extra?: BrushExtra,
): Brush {
  const brush: Brush = {
    id: nextBrushId++,
    pos: { x, y, z },
    size: { x: sx, y: sy, z: sz },
    yaw: 0,
    material,
    ...extra,
  };
  brushes.push(brush);
  return brush;
}

/**
 * Bounds-flavoured wrapper around `box`. Authoring ~150 walls and slabs as
 * center+size triples by hand is a bug farm, so those are written as min/max
 * corners and converted here.
 */
function slab(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  material: SurfaceMaterial,
  tint: number,
  extra?: BrushExtra,
): Brush {
  return box(
    (x0 + x1) / 2,
    (y0 + y1) / 2,
    (z0 + z1) / 2,
    x1 - x0,
    y1 - y0,
    z1 - z0,
    material,
    { tint, ...extra },
  );
}

/** Complement of `gaps` inside [a, b]: every doorway becomes a real hole. */
function spans(a: number, b: number, gaps: readonly [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let cursor = a;
  for (const [g0, g1] of [...gaps].sort((p, q) => p[0] - q[0])) {
    const lo = Math.max(a, Math.min(g0, g1));
    const hi = Math.min(b, Math.max(g0, g1));
    if (hi <= cursor) continue;
    if (lo > cursor) out.push([cursor, lo]);
    cursor = hi;
  }
  if (cursor < b) out.push([cursor, b]);
  return out;
}

/** Wall running along X inside the Z band [z0, z1], with doorways punched out. */
function wallX(
  z0: number,
  z1: number,
  xa: number,
  xb: number,
  gaps: readonly [number, number][],
  material: SurfaceMaterial,
  tint: number,
  height = 384,
): void {
  for (const [a, b] of spans(xa, xb, gaps)) slab(a, 0, z0, b, height, z1, material, tint);
}

/** Wall running along Z inside the X band [x0, x1], with doorways punched out. */
function wallZ(
  x0: number,
  x1: number,
  za: number,
  zb: number,
  gaps: readonly [number, number][],
  material: SurfaceMaterial,
  tint: number,
  height = 384,
): void {
  for (const [a, b] of spans(za, zb, gaps)) slab(x0, 0, a, x1, height, b, material, tint);
}

/**
 * Staircase climbing along X from xLow (tread 1, top = rise) to xHigh
 * (tread `steps`, top = steps * rise). `min/max` keeps it valid for either
 * direction, which is what makes the same helper build both the long A climb
 * and the CT retake ramp (they climb in opposite directions).
 */
function stairsX(
  xLow: number,
  xHigh: number,
  z0: number,
  z1: number,
  steps: number,
  rise: number,
  material: SurfaceMaterial,
  tint: number,
): void {
  for (let k = 1; k <= steps; k++) {
    const a = xLow + ((k - 1) * (xHigh - xLow)) / steps;
    const b = xLow + (k * (xHigh - xLow)) / steps;
    slab(Math.min(a, b), 0, z0, Math.max(a, b), rise * k, z1, material, tint);
  }
}

/** Staircase climbing along Z (same contract as {@link stairsX}). */
function stairsZ(
  zLow: number,
  zHigh: number,
  x0: number,
  x1: number,
  steps: number,
  rise: number,
  material: SurfaceMaterial,
  tint: number,
): void {
  for (let k = 1; k <= steps; k++) {
    const a = zLow + ((k - 1) * (zHigh - zLow)) / steps;
    const b = zLow + (k * (zHigh - zLow)) / steps;
    slab(x0, 0, Math.min(a, b), x1, rise * k, Math.max(a, b), material, tint);
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

// --- terrain -----------------------------------------------------------------
// The floor is four flat slabs plus a sunken pit floor: a single big slab has no
// way to be concave, so the pit has to be a genuine hole in the ground.
slab(-3072, -64, -3072, 1080, 0, 3072, 'sand', TINT.ground, { texScale: 512 });
slab(1560, -64, -3072, 3072, 0, 3072, 'sand', TINT.ground, { texScale: 512 });
slab(1080, -64, -3072, 1560, 0, 460, 'sand', TINT.ground, { texScale: 512 });
slab(1080, -64, 880, 1560, 0, 3072, 'sand', TINT.ground, { texScale: 512 });
// Pit floor, 48 below the surrounding ground.
slab(1080, -112, 460, 1560, -48, 880, 'sandstone', TINT.floor);
// Pit exit: three treads climbing east (3 x 16 = 48) so the pit spills back into
// long A at y = 0 instead of into dead space outside the nav graph.
slab(1360, -48, 560, 1427, -32, 880, 'sandstone', TINT.wall);
slab(1427, -48, 560, 1494, -16, 880, 'sandstone', TINT.wall);
slab(1494, -48, 560, 1560, 0, 880, 'sandstone', TINT.wall);

// --- A site platform ---------------------------------------------------------
// Four boxes around a rectangular hole: the "goose" dip is 16 deep so a player
// can step in and out of it without a special ramp.
slab(1350, 0, -2000, 1750, 128, -1050, 'sandstone', TINT.plate);
slab(1950, 0, -2000, 2150, 128, -1050, 'sandstone', TINT.plate);
slab(1750, 0, -2000, 1950, 128, -1500, 'sandstone', TINT.plate);
slab(1750, 0, -1300, 1950, 128, -1050, 'sandstone', TINT.plate);
slab(1750, 0, -1500, 1950, 112, -1300, 'sandstone', TINT.floor);
// Cover. Deliberately centred between nav grid lines so no nav node ends up
// buried inside a crate.
slab(1608, 128, -1458, 1724, 244, -1342, 'wood', TINT.crate);
slab(1608, 244, -1458, 1724, 360, -1342, 'wood', TINT.crate);
slab(1782, 128, -1818, 1898, 244, -1702, 'wood', TINT.crate);
slab(1608, 128, -1728, 1724, 244, -1612, 'wood', TINT.crate);

// --- long A, catwalk ---------------------------------------------------------
// Long A climbs 128 onto the platform: 8 treads x 16 rise = 128 over 384 units.
stairsZ(-666, -1050, 1600, 2000, 8, 16, 'sandstone', TINT.floor);
// Mid -> catwalk: 12 treads x 16 = 192 over 576 units.
stairsX(220, 796, -460, -300, 12, 16, 'sandstone', TINT.floor);
slab(796, 0, -460, 1250, 192, -300, 'sandstone', TINT.floor);
slab(1090, 0, -1200, 1190, 192, -300, 'sandstone', TINT.floor);
// Catwalk -> A platform: four treads down, 192 -> 128.
slab(1190, 0, -1250, 1230, 176, -1090, 'sandstone', TINT.floor);
slab(1230, 0, -1250, 1270, 160, -1090, 'sandstone', TINT.floor);
slab(1270, 0, -1250, 1310, 144, -1090, 'sandstone', TINT.floor);
slab(1310, 0, -1250, 1350, 128, -1090, 'sandstone', TINT.floor);
// Catwalk parapets. Without them a player who slips off a 192-high ledge lands
// in the dead space between the corridors and is stranded outside the nav graph.
slab(348, 0, -300, 796, 240, -268, 'sandstone', TINT.rail);
slab(348, 0, -492, 796, 240, -460, 'sandstone', TINT.rail);
slab(796, 0, -300, 1250, 240, -268, 'sandstone', TINT.rail);
// The south parapet is split around the P2 strip (X 1058..1222) so it never
// crosses the mid -> P2 -> A walkway; the strip has its own rails on both sides.
slab(796, 0, -492, 1058, 240, -460, 'sandstone', TINT.rail);
slab(1222, 0, -492, 1250, 240, -460, 'sandstone', TINT.rail);
slab(1250, 0, -460, 1282, 240, -300, 'sandstone', TINT.rail);
// The P2 strip's rails stop at Z -460 (P1's south edge) rather than Z -300:
// running them any further north would swallow the two Catwalk row nodes at
// X 1210 and cut the only link between P1 and the P2 walkway.
slab(1058, 0, -1200, 1090, 240, -460, 'sandstone', TINT.rail);
slab(1190, 0, -1090, 1222, 240, -460, 'sandstone', TINT.rail);
slab(1058, 0, -1232, 1190, 240, -1200, 'sandstone', TINT.rail);

// --- A platform retaining walls (they also act as parapets) ------------------
slab(1350, 0, -1050, 1600, 256, -1018, 'sandstone', TINT.wall);
slab(2000, 0, -1050, 2150, 256, -1018, 'sandstone', TINT.wall);
slab(2150, 0, -2000, 2182, 256, -1050, 'sandstone', TINT.wall);
// The west retaining wall of A stops either side of the catwalk landing. The four
// descent treads above (Z -1250 .. -1090) land at X 1310-1350 with their top at Y 128,
// i.e. strictly INSIDE this wall's volume. A wall running the full Z span buried that
// landing inside itself: the bake dropped the landing's nav node as "inside solid", the
// catwalk became a dead-end branch off mid, and every CT rotation walked the whole map
// north through the T side and back down Long A (40+ nodes, 60 s) instead of ~15 nodes
// down the catwalk. The gap is the A-short entrance and is laid exactly over the treads.
slab(1318, 0, -1840, 1350, 256, -1250, 'sandstone', TINT.wall);
slab(1318, 0, -1090, 1350, 256, -1050, 'sandstone', TINT.wall);
slab(1350, 0, -2032, 2150, 256, -2000, 'sandstone', TINT.wall);

// --- CT retake ramp onto A ---------------------------------------------------
stairsX(966, 1350, -2060, -1840, 8, 16, 'sandstone', TINT.floor);

// --- B site, back plat -------------------------------------------------------
slab(-2150, 0, -2050, -1750, 160, -1400, 'sandstone', TINT.plate);
slab(-2182, 0, -2050, -2150, 256, -1400, 'sandstone', TINT.wall);
slab(-2150, 0, -1400, -1920, 256, -1368, 'sandstone', TINT.wall);
// Back plat (160) down to the B site floor: 9 treads x 16.
// `stairsX` puts tread 1 (the 16-unit one) at `xLow`, so the low end must be the
// B-site side (-1390) and the high end the plat side (-1750); passing them the
// other way round builds a 144-unit wall across the middle of the descent.
stairsX(-1390, -1750, -1950, -1750, 9, 16, 'sandstone', TINT.floor);
// B site cover: a diagonally parked car plus two crates. The 45-degree yaw is
// the one rotated brush that is genuinely rotated; it is far enough from every
// lane that its enlarged AABB cannot swallow a nav node.
box(-1560, 45, -1450, 220, 90, 110, 'wood', { tint: TINT.crateDark, yaw: Math.PI / 4 });
slab(-1480, 0, -1300, -1400, 88, -1220, 'wood', TINT.crateDark);
slab(-1600, 0, -1390, -1520, 88, -1310, 'wood', TINT.crateDark);

// --- tunnels -----------------------------------------------------------------
// Upper tunnel: a 192-high walkway along the west wall of the tunnel, fed by a
// 12-tread stair from the tunnel floor and dropping onto the back plat.
slab(-1920, 0, -1250, -1760, 192, 924, 'sandstone', TINT.floor);
stairsZ(1500, 924, -1920, -1760, 12, 16, 'sandstone', TINT.floor);
slab(-1920, 0, -1300, -1760, 176, -1250, 'sandstone', TINT.floor);
slab(-1920, 0, -1350, -1760, 160, -1300, 'sandstone', TINT.floor);

// --- walls -------------------------------------------------------------------
// T spawn room: X [-520, 520], Z [2060, 2860].
wallX(1932, 2060, -520, 520, [[-220, 220]], 'concrete', TINT.concrete);
wallX(2860, 2988, -648, 648, [], 'concrete', TINT.concrete);
wallZ(-648, -520, 2060, 2860, [[2150, 2350]], 'concrete', TINT.concrete);
wallZ(520, 648, 2060, 2860, [[2150, 2350]], 'concrete', TINT.concrete);

// CT spawn room: X [-520, 520], Z [-2760, -2060]. The side walls stop at the
// room's north edge, so the NE / NW corners are the two separate site routes.
// The north wall keeps only its EAST half (X >= 220): the whole west half is the
// doorway onto the CT-mid corridor that runs to B. Walling that west half (the
// wall used to span X [-520, -220] as well) left the B corridor reachable only by
// walking out of mid, all the way north past the T side and back down through the
// tunnels — a 45-node rotation the bots never survived. It also buried the two
// inner CT-mid lane nodes inside solid geometry, so they were dropped by the bake.
wallX(-2060, -1932, -520, 520, [[-520, 220]], 'concrete', TINT.concrete);
wallX(-2888, -2760, -648, 648, [], 'concrete', TINT.concrete);
wallZ(-648, -520, -2760, -2060, [], 'concrete', TINT.concrete);
wallZ(520, 648, -2760, -2060, [], 'concrete', TINT.concrete);

// Mid corridor: X [-220, 220]. The east wall opens onto the catwalk stair.
wallZ(-348, -220, -1932, 1932, [], 'sandstone', TINT.wall);
wallZ(220, 348, -1932, 1932, [[-460, -300]], 'sandstone', TINT.wall);
// Mid doors: a 96-wide cover block in the middle of the corridor, 172-wide passes
// either side of it. They were two 48-wide gaps, then 96 — both still jammed the
// bots, which steer at a waypoint behind the wall and pin themselves on the gap
// edge (measured: the whole T team parked at X 95..203, Z -220..-374 for 100 s, and
// a 48-wide gap is a 16-unit squeeze for the 32-wide player anyway). The wider
// passes keep the mid sightline broken without being a bot trap.
wallX(-364, -236, -220, 220, [[-220, -48], [48, 220]], 'sandstone', TINT.wall);

// T-side long corridor (Z [2130, 2370]) plus the long A corridor shell. The west
// wall is split by the pit so long A spills into (and out of) the pit.
wallX(2066, 2130, 580, 1560, [], 'sandstone', TINT.wall);
wallX(2370, 2434, 580, 2100, [], 'sandstone', TINT.wall);
wallZ(2040, 2104, -1050, 2434, [], 'sandstone', TINT.wall);
wallZ(1496, 1560, -1050, 2130, [[460, 880]], 'sandstone', TINT.wall);
// Long doors: a single 128-wide doorway.
wallX(1950, 2078, 1560, 2040, [[1736, 1864]], 'sandstone', TINT.wall);

// T-side B corridor (Z [2130, 2370]) plus the tunnel shell.
wallX(2066, 2130, -1436, -580, [], 'sandstone', TINT.wall);
wallX(2370, 2434, -2040, -580, [], 'sandstone', TINT.wall);
wallZ(-2040, -1970, 2066, 2434, [], 'sandstone', TINT.wall);
wallZ(-1970, -1920, -1300, 2130, [], 'sandstone', TINT.wall);
wallZ(-1500, -1436, -1300, 2130, [], 'sandstone', TINT.wall);
// B doors: a 128-wide doorway near the tunnel mouth.
wallX(1700, 1828, -1900, -1500, [[-1780, -1652]], 'sandstone', TINT.wall);
// Tunnels are left open to the sky on purpose (a roof would make them unreadable
// at this scale). An invisible clip lid still guarantees the volume is sealed.
slab(-1970, 384, -1300, -1436, 448, 2160, 'sandstone', TINT.wallDark, { clip: true });

// CT -> A and CT -> B corridors (both in the Z band [-2060, -1840]) plus the
// south wall they share with the B site and the A platform.
wallX(-1840, -1776, 648, 1000, [], 'sandstone', TINT.wall);
wallX(-1840, -1776, -1360, -648, [], 'sandstone', TINT.wall);
// The wall the two corridors share with the B site and the A platform. It runs the
// width of the map, so it MUST keep the CT spawn doorway open at X [-220, 220] —
// without that gap the spawn room is sealed shut and the whole CT team can only
// grind against its north face.
wallX(-2124, -2060, -2100, 2150, [[-220, 220]], 'sandstone', TINT.wall);

// --- doors -------------------------------------------------------------------
// Two open door leaves, yawed 45 degrees for variety. Both are placed at a jamb,
// clear of the lane that passes through the doorway.
box(1730, 128, 2050, 16, 256, 96, 'metal', { tint: TINT.metal, yaw: Math.PI / 4 });
box(-1650, 128, 1725, 16, 256, 96, 'metal', { tint: TINT.metal, yaw: -Math.PI / 4 });
// (Removed: an invisible `nonSolid` marker volume used to span the A plant here.
// Collision ignored no such flag, so the marker acted as an invisible wall across
// the whole A site and the attacking bots could never walk onto the site. The A
// site polygon in `sites` already supplies the plant spots, so it was redundant.)

// --- perimeter ---------------------------------------------------------------
slab(-3072, 0, 2944, 3072, 512, 3072, 'sandstone', TINT.wallDark);
slab(-3072, 0, -3072, 3072, 512, -2944, 'sandstone', TINT.wallDark);
slab(-3072, 0, -3072, -2944, 512, 3072, 'sandstone', TINT.wallDark);
slab(2944, 0, -3072, 3072, 512, 3072, 'sandstone', TINT.wallDark);

// ---------------------------------------------------------------------------
// Spawns, bomb sites, callouts, buy zones
// ---------------------------------------------------------------------------

const spawns: SpawnPoint[] = [
  { pos: { x: -300, y: 0, z: 2500 }, yaw: 0, team: 'T', index: 0 },
  { pos: { x: 300, y: 0, z: 2500 }, yaw: 0, team: 'T', index: 1 },
  { pos: { x: -300, y: 0, z: 2700 }, yaw: 0, team: 'T', index: 2 },
  { pos: { x: 300, y: 0, z: 2700 }, yaw: 0, team: 'T', index: 3 },
  { pos: { x: 0, y: 0, z: 2340 }, yaw: 0, team: 'T', index: 4 },
  { pos: { x: -300, y: 0, z: -2500 }, yaw: Math.PI, team: 'CT', index: 0 },
  { pos: { x: 300, y: 0, z: -2500 }, yaw: Math.PI, team: 'CT', index: 1 },
  { pos: { x: -300, y: 0, z: -2700 }, yaw: Math.PI, team: 'CT', index: 2 },
  { pos: { x: 300, y: 0, z: -2700 }, yaw: Math.PI, team: 'CT', index: 3 },
  { pos: { x: 0, y: 0, z: -2340 }, yaw: Math.PI, team: 'CT', index: 4 },
];

const sites: BombSiteRegion[] = [
  {
    site: 'A',
    y: 128,
    poly: [
      [1400, -1100],
      [2100, -1100],
      [2100, -1900],
      [1400, -1900],
    ],
    spots: [
      { x: 1550, y: 128, z: -1250 },
      { x: 2000, y: 128, z: -1700 },
      { x: 1500, y: 128, z: -1800 },
    ],
  },
  {
    site: 'B',
    y: 0,
    poly: [
      [-1360, -1200],
      [-1360, -2060],
      [-1750, -2060],
      [-1750, -1200],
    ],
    spots: [
      { x: -1690, y: 0, z: -1250 },
      { x: -1520, y: 0, z: -1700 },
      { x: -1420, y: 0, z: -2000 },
    ],
  },
];

const callouts: Record<string, Vec3> = {
  TSpawn: { x: 0, y: 0, z: 2400 },
  CTSpawn: { x: 0, y: 0, z: -2400 },
  Mid: { x: 0, y: 0, z: 600 },
  MidDoors: { x: 0, y: 0, z: -300 },
  CTMid: { x: 0, y: 0, z: -1500 },
  Catwalk: { x: 900, y: 192, z: -380 },
  LongA: { x: 1800, y: 0, z: 400 },
  LongDoors: { x: 1800, y: 0, z: 2014 },
  Pit: { x: 1320, y: -48, z: 560 },
  ASite: { x: 1750, y: 128, z: -1600 },
  ARamp: { x: 1160, y: 64, z: -1950 },
  Goose: { x: 1850, y: 112, z: -1400 },
  Tunnels: { x: -1700, y: 0, z: 900 },
  UpperTunnel: { x: -1840, y: 192, z: 200 },
  LowerTunnel: { x: -1700, y: 0, z: -600 },
  BTunnels: { x: -1700, y: 0, z: 1900 },
  BDoors: { x: -1710, y: 0, z: 1764 },
  BSite: { x: -1550, y: 0, z: -1550 },
  BPlat: { x: -1950, y: 160, z: -1750 },
  Car: { x: -1560, y: 45, z: -1450 },
};

const buyZones = [
  { team: 'T' as const, min: { x: -520, y: 0, z: 2060 }, max: { x: 520, y: 72, z: 2860 } },
  { team: 'CT' as const, min: { x: -520, y: 0, z: -2760 }, max: { x: 520, y: 72, z: -2060 } },
];

// ---------------------------------------------------------------------------
// Navigation mesh
//
// The walkable space is described as lanes (straight runs of waypoints) instead
// of ~300 hand-typed nodes. Baking then:
//   1. subdivides every lane so no consecutive pair exceeds MAX_SEG,
//   2. merges points that different lanes placed on top of each other,
//   3. drops nodes with no floor under them or with solid geometry around them,
//   4. links nodes by proximity + an explicit walkability test,
//   5. drops nodes left without a neighbour.
// Links are symmetric by construction, and a mistyped coordinate cannot produce
// a node inside a wall.
// ---------------------------------------------------------------------------

/** Longest single link produced while baking (the contract's limit is 320). */
const MAX_SEG = 240;
/** Nodes further apart than this are never linked. */
const MAX_LINK = 300;
/** Nodes further apart than this in Y are not the same walkable surface. */
const MAX_LINK_RISE = 24;
/** Tolerance for point/segment containment against a brush AABB. */
const SOLID_EPS = 0.05;

interface PtMeta {
  area?: string;
  choke?: boolean;
  site?: 'A' | 'B';
}

type Pt = readonly [number, number, number, PtMeta?];

interface LaneSpec {
  area: string;
  pts: readonly Pt[];
  choke?: boolean;
  site?: 'A' | 'B';
}

/** Horizontal run of nav points along X at a fixed Y and Z. */
function row(
  area: string,
  x0: number,
  x1: number,
  y: number,
  z: number,
  extra?: Omit<LaneSpec, 'area' | 'pts'>,
): LaneSpec {
  return { area, pts: [[x0, y, z], [x1, y, z]], ...extra };
}

/** Uniformly spaced values from a to b (inclusive), at most `step` apart. */
function spread(a: number, b: number, step: number): number[] {
  const n = Math.max(1, Math.ceil(Math.abs(b - a) / step));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
  return out;
}

/** A grid of rows: used for the two spawn rooms and the two bomb sites. */
function gridLanes(
  area: string,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y: number,
  step: number,
  extra?: Omit<LaneSpec, 'area' | 'pts'>,
): LaneSpec[] {
  return spread(z0, z1, step).map((z) => row(area, x0, x1, y, z, extra));
}

const LANES: LaneSpec[] = [
  // --- spawn rooms ----------------------------------------------------------
  ...gridLanes('TSpawn', -460, 460, 2110, 2740, 0, 220),
  ...gridLanes('CTSpwn', -460, 460, -2740, -2110, 0, 220),

  // --- mid ------------------------------------------------------------------
  {
    area: 'Mid',
    pts: [
      [-140, 0, 2010],
      [-140, 0, -100],
      [-72, 0, -150, { area: 'MidDoors', choke: true }],
      [-72, 0, -400, { area: 'MidDoors', choke: true }],
      [-72, 0, -650, { area: 'CTMid' }],
      [-140, 0, -700, { area: 'CTMid' }],
      [-140, 0, -2010, { area: 'CTMid' }],
    ],
  },
  {
    area: 'Mid',
    pts: [
      [140, 0, 2010],
      [140, 0, -100],
      [72, 0, -150, { area: 'MidDoors', choke: true }],
      [72, 0, -400, { area: 'MidDoors', choke: true }],
      [72, 0, -650, { area: 'CTMid' }],
      [140, 0, -700, { area: 'CTMid' }],
      [140, 0, -2010, { area: 'CTMid' }],
    ],
  },

  // --- pit ------------------------------------------------------------------
  row('Pit', 1180, 1440, -48, 510),
  { area: 'Pit', pts: [[1180, -48, 510], [1180, -48, 840]] },
  {
    area: 'Pit',
    pts: [
      [1350, -48, 700],
      [1393, -32, 700],
      [1460, -16, 700],
      [1527, 0, 700],
      [1640, 0, 700],
    ],
  },

  // --- T side approach to long A, long doors --------------------------------
  ...gridLanes('LongA', 700, 1900, 2200, 2330, 0, 240),
  { area: 'LongDoors', choke: true, pts: [[1800, 0, 2160], [1800, 0, 1900]] },
  { area: 'LongA', pts: [[1640, 0, 1900], [1640, 0, -620]] },
  { area: 'LongA', pts: [[1960, 0, 1900], [1960, 0, -620]] },

  // --- long A staircase onto A site ----------------------------------------
  {
    area: 'ARamp',
    pts: [
      [1700, 0, -640],
      [1700, 16, -690],
      [1700, 32, -738],
      [1700, 48, -786],
      [1700, 64, -834],
      [1700, 80, -882],
      [1700, 96, -930],
      [1700, 112, -978],
      [1700, 128, -1026],
      [1700, 128, -1100],
    ],
  },
  {
    area: 'ARamp',
    pts: [
      [1900, 0, -640],
      [1900, 16, -690],
      [1900, 32, -738],
      [1900, 48, -786],
      [1900, 64, -834],
      [1900, 80, -882],
      [1900, 96, -930],
      [1900, 112, -978],
      [1900, 128, -1026],
      [1900, 128, -1100],
    ],
  },

  // --- A site ---------------------------------------------------------------
  ...gridLanes('ASite', 1430, 2060, -1130, -1930, 128, 200, { site: 'A' }),

  // --- CT retake ramp -------------------------------------------------------
  {
    area: 'ARamp',
    pts: [
      [1400, 128, -1950],
      [1326, 128, -1950],
      [1278, 112, -1950],
      [1230, 96, -1950],
      [1182, 80, -1950],
      [1134, 64, -1950],
      [1086, 48, -1950],
      [1038, 32, -1950],
      [990, 16, -1950],
      [940, 0, -1950],
    ],
  },

  // --- catwalk --------------------------------------------------------------
  {
    area: 'Catwalk',
    pts: [
      [180, 0, -380, { area: 'Mid' }],
      [244, 16, -380],
      [292, 32, -380],
      [340, 48, -380],
      [388, 64, -380],
      [436, 80, -380],
      [484, 96, -380],
      [532, 112, -380],
      [580, 128, -380],
      [628, 144, -380],
      [676, 160, -380],
      [724, 176, -380],
      [772, 192, -380],
    ],
  },
  row('Catwalk', 830, 1210, 192, -420),
  row('Catwalk', 830, 1210, 192, -340),
  { area: 'Catwalk', pts: [[1140, 192, -380], [1140, 192, -1150]] },
  {
    area: 'Catwalk',
    pts: [
      [1140, 192, -1170],
      [1210, 176, -1170],
      [1250, 160, -1170],
      [1290, 144, -1170],
      [1330, 128, -1170],
      [1420, 128, -1170],
    ],
  },

  // --- CT -> A and CT -> B --------------------------------------------------
  // Both corridors used to stop at |X| = 700/900 and leave the 560 units next to the mid
  // column unauthored, so no link could span the hole (MAX_LINK is 300): a CT standing in
  // CT spawn reached B only by walking the entire map north through the T side and down the
  // tunnels (45 nodes, 60+ s of running), and the A retake ramp was cut off the same way.
  // The rows now run all the way in to |X| = 260, i.e. 120 units from the mid nodes.
  ...gridLanes('CTMid', 260, 900, -2010, -1890, 0, 240),
  ...gridLanes('CTMid', -1300, -260, -2010, -1890, 0, 240),

  // --- T side approach to B tunnels ----------------------------------------
  ...gridLanes('BTunnelSide', -1900, -700, 2200, 2330, 0, 240),
  { area: 'Tunnels', pts: [[-1710, 0, 2060], [-1710, 0, 1850]] },
  { area: 'BDoors', choke: true, pts: [[-1710, 0, 1850], [-1710, 0, 1600]] },
  { area: 'LowerTunnel', pts: [[-1710, 0, 1600], [-1710, 0, -1250]] },
  { area: 'BTunnelSide', pts: [[-1560, 0, 2060], [-1560, 0, 1850]] },

  // --- upper tunnel ---------------------------------------------------------
  {
    area: 'UpperTunnel',
    pts: [
      [-1840, 0, 1540],
      [-1840, 16, 1476],
      [-1840, 32, 1428],
      [-1840, 48, 1380],
      [-1840, 64, 1332],
      [-1840, 80, 1284],
      [-1840, 96, 1236],
      [-1840, 112, 1188],
      [-1840, 128, 1140],
      [-1840, 144, 1092],
      [-1840, 160, 1044],
      [-1840, 176, 996],
      [-1840, 192, 948],
      [-1840, 192, 900],
      [-1840, 192, -1200],
      [-1840, 176, -1275],
      [-1840, 160, -1325],
      [-1840, 160, -1400],
    ],
  },

  // --- back plat and B site -------------------------------------------------
  ...gridLanes('BPlat', -2060, -1840, -1430, -2030, 160, 200),
  {
    area: 'BPlat',
    pts: [
      [-1770, 160, -1850],
      [-1730, 144, -1850],
      [-1690, 128, -1850],
      [-1650, 112, -1850],
      [-1610, 96, -1850],
      [-1570, 80, -1850],
      [-1530, 64, -1850],
      [-1490, 48, -1850],
      [-1450, 32, -1850],
      [-1410, 16, -1850],
      [-1350, 0, -1850],
    ],
  },
  ...gridLanes('BSite', -1690, -1380, -1280, -1680, 0, 200, { site: 'B' }),
  { area: 'BSite', pts: [[-1375, 0, -1300], [-1375, 0, -2040]] },
];

// --- nav baking --------------------------------------------------------------

/** World-space AABB of a brush, mirroring world/trace.ts#brushToAabb. */
function brushAabb(b: Brush): AABB {
  const c = Math.abs(Math.cos(b.yaw));
  const s = Math.abs(Math.sin(b.yaw));
  const hx = b.size.x * 0.5;
  const hy = b.size.y * 0.5;
  const hz = b.size.z * 0.5;
  const ex = hx * c + hz * s;
  const ez = hx * s + hz * c;
  return {
    min: { x: b.pos.x - ex, y: b.pos.y - hy, z: b.pos.z - ez },
    max: { x: b.pos.x + ex, y: b.pos.y + hy, z: b.pos.z + ez },
  };
}

const solidBoxes: AABB[] = brushes.filter((b) => !b.nonSolid).map(brushAabb);

function pointInBox(p: Vec3, b: AABB): boolean {
  return (
    p.x > b.min.x + SOLID_EPS &&
    p.x < b.max.x - SOLID_EPS &&
    p.y > b.min.y + SOLID_EPS &&
    p.y < b.max.y - SOLID_EPS &&
    p.z > b.min.z + SOLID_EPS &&
    p.z < b.max.z - SOLID_EPS
  );
}

/**
 * Slab-method segment/AABB test.
 *
 * Only the HI faces are pulled in by SOLID_EPS: a link that runs along a wall's
 * base or a tread's top must not count as a hit, but a wall standing ON the floor
 * (its `min.y` flush with the ground the link travels at) MUST block the link.
 * Shrinking the lo faces too pulled that wall's base up by 0.05 and made every
 * floor-flush wall invisible to the bake — which is how the A site's north wall
 * looked walk-through. A box thinner than SOLID_EPS can still never block a link.
 */
function segmentHitsBox(a: Vec3, b: Vec3, box: AABB): boolean {
  let t0 = 0;
  let t1 = 1;
  const lo = [box.min.x, box.min.y, box.min.z];
  const hi = [box.max.x - SOLID_EPS, box.max.y - SOLID_EPS, box.max.z - SOLID_EPS];
  const p = [a.x, a.y, a.z];
  const d = [b.x - a.x, b.y - a.y, b.z - a.z];
  for (let i = 0; i < 3; i++) {
    if (hi[i] < lo[i]) return false;
    if (Math.abs(d[i]) < 1e-9) {
      if (p[i] < lo[i] || p[i] > hi[i]) return false;
      continue;
    }
    let ta = (lo[i] - p[i]) / d[i];
    let tb = (hi[i] - p[i]) / d[i];
    if (ta > tb) {
      const tmp = ta;
      ta = tb;
      tb = tmp;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Walkability test for a straight link. A brush blocks the link unless it is
 * steppable: its top is at or below the higher endpoint AND the climb from the
 * lower endpoint is within the player's step height. This is what makes a
 * staircase tread "walkable" instead of "a wall".
 */
function blocksLink(a: Vec3, b: Vec3): boolean {
  const low = Math.min(a.y, b.y);
  const high = Math.max(a.y, b.y);
  for (const solid of solidBoxes) {
    if (!segmentHitsBox(a, b, solid)) continue;
    if (solid.max.y <= high + 1e-6 && solid.max.y - low <= PLAYER.stepHeight + 1e-6) continue;
    return true;
  }
  return false;
}

/** Highest supporting surface at (x, z) that is not above y. */
function floorTopAt(x: number, z: number, y: number): number | null {
  let best: number | null = null;
  for (const b of solidBoxes) {
    if (x <= b.min.x || x >= b.max.x || z <= b.min.z || z >= b.max.z) continue;
    const top = b.max.y;
    if (top > y + SOLID_EPS) continue;
    if (best === null || top > best) best = top;
  }
  return best;
}

function pointInPoly(x: number, z: number, poly: readonly [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

interface RawNode {
  pos: Vec3;
  area: string;
  choke: boolean;
  site: 'A' | 'B' | null;
}

function bakeNav(): NavNode[] {
  const byKey = new Map<string, RawNode>();
  const emit = (pos: Vec3, area: string, choke: boolean, site: 'A' | 'B' | null): void => {
    const key = `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { pos, area, choke, site });
      return;
    }
    prev.choke = prev.choke || choke;
    prev.site = prev.site ?? site;
    // Doorway labels win over the corridor they belong to.
    if (area === 'MidDoors' || area === 'BDoors' || area === 'LongDoors') prev.area = area;
  };

  // 1 + 2: subdivide every lane, merging points that coincide.
  for (const lane of LANES) {
    let lastArea = lane.area;
    let lastChoke = lane.choke ?? false;
    let lastSite = lane.site ?? null;
    for (let i = 0; i < lane.pts.length - 1; i++) {
      const from = lane.pts[i];
      const to = lane.pts[i + 1];
      const meta: PtMeta = from[3] ?? {};
      const area = meta.area ?? lane.area;
      const choke = meta.choke ?? lane.choke ?? false;
      const site = meta.site ?? lane.site ?? null;
      lastArea = area;
      lastChoke = choke;
      lastSite = site;
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const dz = to[2] - from[2];
      const segs = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / MAX_SEG));
      for (let s = 0; s < segs; s++) {
        const t = s / segs;
        emit({ x: from[0] + dx * t, y: from[1] + dy * t, z: from[2] + dz * t }, area, choke, site);
      }
    }
    const end = lane.pts[lane.pts.length - 1];
    emit({ x: end[0], y: end[1], z: end[2] }, lastArea, lastChoke, lastSite);
  }

  // 3: drop nodes inside solid geometry or floating without a floor under them.
  const alive: RawNode[] = [];
  for (const node of byKey.values()) {
    if (solidBoxes.some((b) => pointInBox(node.pos, b))) continue;
    const top = floorTopAt(node.pos.x, node.pos.z, node.pos.y);
    if (top === null || node.pos.y - top > 40) continue;
    alive.push(node);
  }

  // 4: proximity links, validated by the walkability test.
  const links: number[][] = alive.map(() => []);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i].pos;
      const b = alive[j].pos;
      if (Math.abs(a.y - b.y) > MAX_LINK_RISE) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (d > MAX_LINK || d < 1e-3) continue;
      if (blocksLink(a, b)) continue;
      links[i].push(j);
      links[j].push(i);
    }
  }

  // 5: renumber, dropping isolated nodes (they could only break pathfinding).
  const keep: number[] = [];
  for (let i = 0; i < alive.length; i++) if (links[i].length > 0) keep.push(i);
  const remap = new Map<number, number>();
  keep.forEach((old, idx) => remap.set(old, idx));

  return keep.map((old, idx) => {
    const node = alive[old];
    const region = node.site ? sites.find((s) => s.site === node.site) : undefined;
    // A site tag is only valid on the site floor and inside its own polygon.
    const onSite =
      region !== undefined &&
      Math.abs(node.pos.y - region.y) <= 8 &&
      pointInPoly(node.pos.x, node.pos.z, region.poly);
    return {
      id: idx,
      pos: node.pos,
      links: links[old].filter((n) => remap.has(n)).map((n) => remap.get(n) ?? -1),
      area: node.area,
      site: onSite ? node.site : null,
      choke: node.choke,
    } satisfies NavNode;
  });
}

const nav = bakeNav();

// ---------------------------------------------------------------------------
// Bounds and radar (derived from the brushes so they cannot drift)
// ---------------------------------------------------------------------------

function computeBounds(): { min: Vec3; max: Vec3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const b of brushes) {
    const bb = brushAabb(b);
    min.x = Math.min(min.x, bb.min.x);
    min.y = Math.min(min.y, bb.min.y);
    min.z = Math.min(min.z, bb.min.z);
    max.x = Math.max(max.x, bb.max.x);
    max.y = Math.max(max.y, bb.max.y);
    max.z = Math.max(max.z, bb.max.z);
  }
  return { min, max };
}

/**
 * Radar transform: one uniform scale for X and Z (separate scales would distort
 * the map) plus a 0.2% margin so float rounding can never push a corner outside
 * [0, 1].
 */
function computeRadar(b: { min: Vec3; max: Vec3 }): { originX: number; originZ: number; scale: number } {
  const spanX = b.max.x - b.min.x;
  const spanZ = b.max.z - b.min.z;
  const span = Math.max(spanX, spanZ) * 1.002;
  return {
    originX: b.min.x - (span - spanX) / 2,
    originZ: b.min.z - (span - spanZ) / 2,
    scale: 1 / span,
  };
}

const bounds = computeBounds();

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

/** The authoritative map. Treat as read-only; use {@link buildDust2Lite} to edit. */
export const DUST2_LITE: MapData = {
  name: 'de_dust2_lite',
  bounds,
  brushes,
  spawns,
  nav,
  sites,
  callouts,
  radar: computeRadar(bounds),
  buyZones,
};

function manualClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => manualClone(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = manualClone(v);
    return out as unknown as T;
  }
  return value;
}

/** Deep copy of the map so callers can mutate their own working set freely. */
export function buildDust2Lite(): MapData {
  if (typeof structuredClone === 'function') return structuredClone(DUST2_LITE);
  return manualClone(DUST2_LITE);
}
