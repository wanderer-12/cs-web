// =============================================================================
// world/maps/mapBuilder.ts — authoring toolkit shared by the map modules.
//
// `de_dust2_lite.ts` hand-rolls all of this inline (it predates this file); the
// duel arena builds on it instead. Everything here is map-authoring-time only:
// none of it runs during a match, so the small caches and helper objects are
// free.
//
// The two hard rules this file encodes, both learned the hard way in dust2:
//   1. Physics is AABB-only (no sloped planes). Every height change is a step,
//      so a "ramp" is a staircase whose riser stays <= PLAYER.stepHeight. A
//      riser taller than that is a wall the player cannot climb, and the nav
//      bake will (correctly) refuse to link across it.
//   2. The nav bake must never keep a floating island. Crate tops are reachable
//      by grid sampling but not by walking, so nodes are flood-filled from
//      explicit seed points and everything not reachable from a seed is thrown
//      away.
// =============================================================================

import { PLAYER } from '../../core/config';
import type {
  AABB,
  BombSiteRegion,
  Brush,
  MapData,
  NavNode,
  PaintZone,
  SpawnPoint,
  SurfaceMaterial,
  Team,
  Vec3,
} from '../../core/types';

/** Extra brush fields a call site may set (id/pos/size/material are positional). */
export type BrushExtra = Partial<Omit<Brush, 'id' | 'pos' | 'size' | 'material'>>;

/** A hand-placed nav polyline, sampled densely and merged into the grid bake. */
export interface NavLane {
  /** Coarse region label carried onto every node sampled along the lane. */
  area: string;
  pts: readonly (readonly [number, number, number])[];
  choke?: boolean;
}

export interface GridNavOptions {
  /** Grid spacing in units (X and Z). Smaller = denser but slower to bake. */
  step: number;
  /**
   * Highest surface a grid sample may stand on. Pass something above the
   * tallest walkable deck: crate tops are sampled too, then discarded by the
   * reachability flood fill.
   */
  ceiling: number;
  /** Extra hand-placed polylines (ramps, thin lanes the grid would straddle). */
  lanes?: readonly NavLane[];
  /** Nodes within `seedRadius` of these points start the reachability fill. */
  seeds: readonly Vec3[];
  seedRadius?: number;
  /** Max 3D distance between linked nodes. */
  maxLink?: number;
  /** Max height difference between linked nodes (step-up budget). */
  maxRise?: number;
  /** Region label for a node; defaults to 'Mid'. */
  areaAt?: (p: Vec3) => string;
  /** Chokepoint flag for a node; defaults to false. */
  chokeAt?: (p: Vec3) => boolean;
}

export interface FinishOptions {
  name: string;
  spawns: SpawnPoint[];
  /** Nav baked by {@link MapBuilder.gridNav}. */
  nav?: NavNode[];
  sites?: BombSiteRegion[];
  callouts?: Record<string, Vec3>;
  buyZones?: { team: Team; min: Vec3; max: Vec3 }[];
  /** District floor paint; a map without zones keeps the legacy dust2 table. */
  paint?: readonly PaintZone[];
}

const SOLID_EPS = 0.05;
const FLOAT_TOLERANCE = 40;

/**
 * The one box helper: x/y/z is the box CENTER, sx/sy/sz are full extents.
 * Records the brush as well as returning it, so a call site may ignore the
 * result (`b.box(...)` as a statement) or keep the handle.
 */
export function box(
  brushes: Brush[],
  nextId: () => number,
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
    id: nextId(),
    pos: { x, y, z },
    size: { x: sx, y: sy, z: sz },
    yaw: 0,
    material,
    ...extra,
  };
  brushes.push(brush);
  return brush;
}

/** Bounds-flavoured wrapper around {@link box} (min/max corners). */
export function slab(
  brushes: Brush[],
  nextId: () => number,
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
    brushes,
    nextId,
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

/** Axis-aligned bounds of a yaw-rotated brush (same math as `world/trace.ts`). */
export function brushAabb(b: Brush): AABB {
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
 * Slab-method segment/AABB test. Only the HI faces are pulled in by
 * SOLID_EPS: a link that runs along a wall's base or a tread's top must not
 * count as a hit, but a wall standing ON the floor (its `min.y` flush with the
 * ground the link travels at) MUST block the link.
 */
export function segmentHitsBox(a: Vec3, b: Vec3, boxAabb: AABB): boolean {
  let t0 = 0;
  let t1 = 1;
  const lo = [boxAabb.min.x, boxAabb.min.y, boxAabb.min.z];
  const hi = [boxAabb.max.x - SOLID_EPS, boxAabb.max.y - SOLID_EPS, boxAabb.max.z - SOLID_EPS];
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

/** Highest supporting surface at (x, z) that is not above `y`. */
function floorTopAtBoxes(solids: readonly AABB[], x: number, z: number, y: number): number | null {
  let best: number | null = null;
  for (const b of solids) {
    if (x <= b.min.x || x >= b.max.x || z <= b.min.z || z >= b.max.z) continue;
    const top = b.max.y;
    if (top > y + SOLID_EPS) continue;
    if (best === null || top > best) best = top;
  }
  return best;
}

/**
 * Walkability test for a straight link: a brush blocks it unless it is
 * steppable — its top is at or below the higher endpoint AND the climb from the
 * lower endpoint is within the player's step height. That is what turns a
 * staircase tread into "walkable" instead of "a wall".
 */
function blocksLinkBoxes(solids: readonly AABB[], a: Vec3, b: Vec3): boolean {
  const low = Math.min(a.y, b.y);
  const high = Math.max(a.y, b.y);
  for (const solid of solids) {
    if (!segmentHitsBox(a, b, solid)) continue;
    if (solid.max.y <= high + 1e-6 && solid.max.y - low <= PLAYER.stepHeight + 1e-6) continue;
    return true;
  }
  return false;
}

/**
 * Incremental map authoring. One instance per map module; call `finish()` once
 * at the end to get the frozen `MapData`.
 */
export class MapBuilder {
  readonly brushes: Brush[] = [];
  private nextBrushId = 1;
  private solidsCache: AABB[] | null = null;

  private nextId = (): number => this.nextBrushId++;

  box(
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    material: SurfaceMaterial,
    extra?: BrushExtra,
  ): Brush {
    this.solidsCache = null;
    return box(this.brushes, this.nextId, x, y, z, sx, sy, sz, material, extra);
  }

  slab(
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
    this.solidsCache = null;
    return slab(this.brushes, this.nextId, x0, y0, z0, x1, y1, z1, material, tint, extra);
  }

  /** Every non-marker brush as an axis-aligned box. Cached. */
  solidBoxes(): readonly AABB[] {
    if (this.solidsCache === null) {
      this.solidsCache = this.brushes.filter((b) => !b.nonSolid).map(brushAabb);
    }
    return this.solidsCache;
  }

  /** Complement of `gaps` inside [a, b]: every doorway becomes a real hole. */
  spans(a: number, b: number, gaps: readonly [number, number][]): [number, number][] {
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

  /** Wall running along X inside the Z band [z0, z1], doorways punched out. */
  wallX(
    z0: number,
    z1: number,
    xa: number,
    xb: number,
    gaps: readonly [number, number][],
    material: SurfaceMaterial,
    tint: number,
    height = 384,
  ): void {
    for (const [a, b] of this.spans(xa, xb, gaps)) {
      this.slab(a, 0, z0, b, height, z1, material, tint);
    }
  }

  /** Wall running along Z inside the X band [x0, x1], doorways punched out. */
  wallZ(
    x0: number,
    x1: number,
    za: number,
    zb: number,
    gaps: readonly [number, number][],
    material: SurfaceMaterial,
    tint: number,
    height = 384,
  ): void {
    for (const [a, b] of this.spans(za, zb, gaps)) {
      this.slab(x0, 0, a, x1, height, b, material, tint);
    }
  }

  /**
   * Staircase climbing along X from `xLow` (tread 1, top = rise) to `xHigh`
   * (tread `steps`, top = steps * rise). Works in both directions, which is how
   * the same helper builds mirrored ramps on opposite sides of the arena.
   *
   * `rise` MUST stay <= PLAYER.stepHeight or the bake treats the ramp as a wall.
   */
  stairsX(
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
      const b = xLow + ((k * (xHigh - xLow)) / steps);
      this.slab(Math.min(a, b), 0, z0, Math.max(a, b), rise * k, z1, material, tint);
    }
  }

  /** Staircase climbing along Z (same contract as {@link stairsX}). */
  stairsZ(
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
      const b = zLow + ((k * (zHigh - zLow)) / steps);
      this.slab(x0, 0, Math.min(a, b), x1, rise * k, Math.max(a, b), material, tint);
    }
  }

  /**
   * Bake a nav mesh: a regular XZ grid plus hand-placed lanes, linked by a
   * straight-line walkability test, then filtered down to the component that is
   * actually reachable from the seed points. Nodes standing on crate tops are
   * sampled and then dropped, because no walk link ever reaches them.
   */
  gridNav(opts: GridNavOptions): NavNode[] {
    const solids = this.solidBoxes();
    const maxLink = opts.maxLink ?? 300;
    const maxRise = opts.maxRise ?? 24;
    const seedRadius = opts.seedRadius ?? 240;
    const areaAt = opts.areaAt ?? ((): string => 'Mid');
    const chokeAt = opts.chokeAt ?? ((): boolean => false);

    interface Raw {
      pos: Vec3;
      area: string;
      choke: boolean;
    }

    const byKey = new Map<string, Raw>();
    const emit = (pos: Vec3, area: string, choke: boolean): void => {
      const key = `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;
      if (!byKey.has(key)) byKey.set(key, { pos, area, choke });
    };

    const floorAt = (x: number, z: number): number | null =>
      floorTopAtBoxes(solids, x, z, opts.ceiling);

    // 1: grid samples.
    const minX = Math.min(...this.brushes.map((b) => b.pos.x - b.size.x * 0.5));
    const maxX = Math.max(...this.brushes.map((b) => b.pos.x + b.size.x * 0.5));
    const minZ = Math.min(...this.brushes.map((b) => b.pos.z - b.size.z * 0.5));
    const maxZ = Math.max(...this.brushes.map((b) => b.pos.z + b.size.z * 0.5));
    const startX = Math.ceil(minX / opts.step) * opts.step;
    const startZ = Math.ceil(minZ / opts.step) * opts.step;
    for (let x = startX; x <= maxX; x += opts.step) {
      for (let z = startZ; z <= maxZ; z += opts.step) {
        const y = floorAt(x, z);
        if (y === null) continue;
        const pos = { x, y, z };
        if (solids.some((b) => pointInBox(pos, b))) continue;
        emit(pos, areaAt(pos), chokeAt(pos));
      }
    }

    // 2: hand-placed lanes, subdivided so no two samples are further apart than
    // half the link limit.
    const laneStep = maxLink * 0.5;
    for (const lane of opts.lanes ?? []) {
      for (let i = 0; i < lane.pts.length - 1; i++) {
        const from = lane.pts[i];
        const to = lane.pts[i + 1];
        const dx = to[0] - from[0];
        const dy = to[1] - from[1];
        const dz = to[2] - from[2];
        const segs = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / laneStep));
        for (let s = 0; s < segs; s++) {
          const t = s / segs;
          emit({ x: from[0] + dx * t, y: from[1] + dy * t, z: from[2] + dz * t }, lane.area, lane.choke === true);
        }
      }
    }

    // 3: drop nodes buried in geometry or floating above their floor.
    const alive: Raw[] = [];
    for (const node of byKey.values()) {
      if (solids.some((b) => pointInBox(node.pos, b))) continue;
      const top = floorTopAtBoxes(solids, node.pos.x, node.pos.z, node.pos.y);
      if (top === null || node.pos.y - top > FLOAT_TOLERANCE) continue;
      alive.push(node);
    }

    // 4: proximity links validated by the walk test.
    const links: number[][] = alive.map(() => []);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i].pos;
        const b = alive[j].pos;
        if (Math.abs(a.y - b.y) > maxRise) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (d > maxLink || d < 1e-3) continue;
        if (blocksLinkBoxes(solids, a, b)) continue;
        links[i].push(j);
        links[j].push(i);
      }
    }

    // 5: keep only what a seed point can actually reach (flood fill). This is
    // what removes crate-top islands: they link to each other, but never to the
    // floor.
    const reachable = new Set<number>();
    const queue: number[] = [];
    for (const seed of opts.seeds) {
      let bestIndex = -1;
      let bestDist = Infinity;
      for (let i = 0; i < alive.length; i++) {
        const p = alive[i].pos;
        const d = Math.hypot(p.x - seed.x, p.y - seed.y, p.z - seed.z);
        if (d < bestDist) {
          bestDist = d;
          bestIndex = i;
        }
      }
      if (bestIndex >= 0 && bestDist <= seedRadius && !reachable.has(bestIndex)) {
        reachable.add(bestIndex);
        queue.push(bestIndex);
      }
    }
    while (queue.length > 0) {
      const i = queue.pop();
      if (i === undefined) break;
      for (const j of links[i]) {
        if (reachable.has(j)) continue;
        reachable.add(j);
        queue.push(j);
      }
    }

    // 6: renumber.
    const keep = alive.map((_, i) => i).filter((i) => reachable.has(i) && links[i].length > 0);
    const remap = new Map<number, number>();
    keep.forEach((old, idx) => remap.set(old, idx));
    return keep.map((old, idx) => {
      const node = alive[old];
      return {
        id: idx,
        pos: node.pos,
        links: links[old].filter((n) => remap.has(n)).map((n) => remap.get(n) ?? -1),
        area: node.area,
        site: null,
        choke: node.choke,
      } satisfies NavNode;
    });
  }

  /** Bounds derived from the brushes, so they cannot drift. */
  computeBounds(): { min: Vec3; max: Vec3 } {
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const b of this.brushes) {
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
   * Radar transform: one uniform scale for X and Z (separate scales would
   * distort the map) plus a 0.2% margin so float rounding can never push a
   * corner outside [0, 1].
   */
  computeRadar(b: { min: Vec3; max: Vec3 }): { originX: number; originZ: number; scale: number } {
    const spanX = b.max.x - b.min.x;
    const spanZ = b.max.z - b.min.z;
    const span = Math.max(spanX, spanZ) * 1.002;
    return {
      originX: b.min.x - (span - spanX) / 2,
      originZ: b.min.z - (span - spanZ) / 2,
      scale: 1 / span,
    };
  }

  /** Freeze the authored geometry into a `MapData`. */
  finish(opts: FinishOptions): MapData {
    const bounds = this.computeBounds();
    return {
      name: opts.name,
      bounds,
      brushes: this.brushes,
      spawns: opts.spawns,
      nav: opts.nav ?? [],
      sites: opts.sites ?? [],
      callouts: opts.callouts ?? {},
      radar: this.computeRadar(bounds),
      buyZones: opts.buyZones ?? [],
      paint: opts.paint ?? [],
    };
  }
}

/** Deep copy of a map so callers can mutate their own working set freely. */
export function cloneMapData(map: MapData): MapData {
  if (typeof structuredClone === 'function') return structuredClone(map);
  return manualClone(map);
}

function manualClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => manualClone(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = manualClone(v);
    return out as unknown as T;
  }
  return value;
}

/**
 * Authoring-time sanity report: a map that fails any of these plays badly (an
 * invisible wall, a spawn inside a crate, a bot that cannot path anywhere).
 * Tests call it; nothing at runtime does.
 */
export function validateMap(map: MapData): string[] {
  const problems: string[] = [];
  const solids = map.brushes.filter((b) => !b.nonSolid).map(brushAabb);

  if (map.nav.length === 0) problems.push('nav mesh is empty');

  const reachableByNav = (p: Vec3): boolean =>
    map.nav.some((n) => Math.hypot(n.pos.x - p.x, n.pos.z - p.z) <= 240);

  for (const spawn of map.spawns) {
    if (solids.some((b) => pointInBox(spawn.pos, b))) {
      problems.push(`spawn ${spawn.team}#${spawn.index} is inside solid geometry`);
    }
    const top = floorTopAtBoxes(solids, spawn.pos.x, spawn.pos.z, spawn.pos.y);
    if (top === null) {
      problems.push(`spawn ${spawn.team}#${spawn.index} has no floor`);
    } else if (Math.abs(top - spawn.pos.y) > SOLID_EPS) {
      problems.push(`spawn ${spawn.team}#${spawn.index} floats ${(spawn.pos.y - top).toFixed(1)} above its floor`);
    }
    if (!reachableByNav(spawn.pos)) {
      problems.push(`spawn ${spawn.team}#${spawn.index} is far from the nav mesh`);
    }
  }

  for (const node of map.nav) {
    const top = floorTopAtBoxes(solids, node.pos.x, node.pos.z, node.pos.y);
    if (top === null || node.pos.y - top > FLOAT_TOLERANCE) {
      problems.push(`nav node ${node.id} floats above its floor`);
    }
    for (const link of node.links) {
      if (link < 0 || link >= map.nav.length) {
        problems.push(`nav node ${node.id} links to a missing node ${link}`);
      }
    }
  }

  return problems;
}

/** Convenience: all non-clip brushes of a map, for tests that scan coverage. */
export function drawnBrushCount(map: MapData): number {
  return map.brushes.filter((b) => b.clip !== true).length;
}