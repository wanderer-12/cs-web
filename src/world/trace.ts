// =============================================================================
// world/trace.ts — swept-AABB traces against static brush geometry.
//
// Why not a physics engine: Counter-Strike movement is not physical simulation,
// it is a hand-tuned integrator. We need exact, predictable, per-tick answers for
// "can I step up 18 units", "does this slope count as standable", "does this
// bullet pass through that plank" — all of which are simpler and far more
// controllable with a purpose-built AABB tracer than with Rapier/Jolt.
// =============================================================================

import { aabbOverlap, clamp01, set, v3 } from '../core/math';
import type { AABB, Brush, SurfaceMaterial, Vec3 } from '../core/types';

export interface SweepResult {
  /** True when the box collided with something. */
  hit: boolean;
  /** Fraction of the trace completed before the first hit, in [0,1]. */
  fraction: number;
  /** Surface normal at the contact. */
  normal: Vec3;
  /** World position of the contact point. */
  point: Vec3;
  /** Material of the first brush hit. */
  material: SurfaceMaterial;
  /** Id of the first brush hit, -1 when nothing was hit. */
  brushId: number;
}

export function createSweepResult(): SweepResult {
  return { hit: false, fraction: 1, normal: v3(0, 1, 0), point: v3(), material: 'concrete', brushId: -1 };
}

/**
 * Minkowski expansion sweep: segment vs the box grown by the trace box extents.
 * This is the standard AABB sweep and it is exact for axis-aligned boxes.
 */
function sweepExpanded(
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
  box: AABB,
  ex: number,
  ey: number,
  ez: number,
  out: { t: number; nx: number; ny: number; nz: number },
): boolean {
  let tmin = 0;
  let tmax = 1;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let axis = -1;
  let sign = 0;

  const resolve = (
    start: number,
    end: number,
    lo: number,
    hi: number,
    ax: number,
    ext: number,
  ): boolean => {
    const d = end - start;
    if (Math.abs(d) < 1e-9) {
      return start >= lo - ext && start <= hi + ext;
    }
    const inv = 1 / d;
    let t1 = (lo - ext - start) * inv;
    let t2 = (hi + ext - start) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = ax;
      sign = s;
    }
    if (t2 < tmax) tmax = t2;
    return tmin <= tmax;
  };

  if (!resolve(startX, endX, box.min.x, box.max.x, 0, ex)) return false;
  if (!resolve(startY, endY, box.min.y, box.max.y, 1, ey)) return false;
  if (!resolve(startZ, endZ, box.min.z, box.max.z, 2, ez)) return false;
  if (tmin < 0 || tmin > 1) return false;

  out.t = tmin;
  nx = 0;
  ny = 0;
  nz = 0;
  if (axis === 0) nx = sign;
  else if (axis === 1) ny = sign;
  else if (axis === 2) nz = sign;
  else ny = 1; // started overlapping: push out upward (never happens for static brushes)
  out.nx = nx;
  out.ny = ny;
  out.nz = nz;
  return true;
}

/** Uniform grid over brush AABBs, rebuilt whenever the world changes. */
export class BrushGrid {
  readonly cellSize: number;
  private readonly buckets = new Map<number, number[]>();
  private readonly minX: number;
  private readonly minZ: number;
  private readonly dimX: number;

  constructor(bounds: { min: Vec3; max: Vec3 }, cellSize = 96) {
    this.cellSize = cellSize;
    this.minX = bounds.min.x - cellSize;
    this.minZ = bounds.min.z - cellSize;
    this.dimX = Math.max(1, Math.ceil((bounds.max.x - this.minX + cellSize) / cellSize));
  }

  private key(ix: number, iz: number): number {
    return ix * 100003 + iz;
  }

  insert(index: number, box: AABB): void {
    const x0 = Math.floor((box.min.x - this.minX) / this.cellSize);
    const x1 = Math.floor((box.max.x - this.minX) / this.cellSize);
    const z0 = Math.floor((box.min.z - this.minZ) / this.cellSize);
    const z1 = Math.floor((box.max.z - this.minZ) / this.cellSize);
    const dimX = this.dimX;
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = ix * dimX + iz;
        let list = this.buckets.get(k);
        if (!list) {
          list = [];
          this.buckets.set(k, list);
        }
        list.push(index);
      }
    }
  }

  /** Collect candidate brush indices along a segment, expanding the AABB by `extent`. */
  query(start: Vec3, end: Vec3, extent: number, out: Set<number>): void {
    out.clear();
    const minX = Math.min(start.x, end.x) - extent;
    const maxX = Math.max(start.x, end.x) + extent;
    const minZ = Math.min(start.z, end.z) - extent;
    const maxZ = Math.max(start.z, end.z) + extent;
    const x0 = Math.floor((minX - this.minX) / this.cellSize);
    const x1 = Math.floor((maxX - this.minX) / this.cellSize);
    const z0 = Math.floor((minZ - this.minZ) / this.cellSize);
    const z1 = Math.floor((maxZ - this.minZ) / this.cellSize);
    const dimX = this.dimX;
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this.buckets.get(ix * dimX + iz);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) out.add(list[i]);
      }
    }
  }

  clear(): void {
    this.buckets.clear();
  }
}

export interface CollisionWorld {
  readonly brushAabbs: AABB[];
  readonly brushes: Brush[];
  readonly grid: BrushGrid;
  bounds: { min: Vec3; max: Vec3 };
}

/** Compute the world-space AABB of a (yaw-rotated) box brush. */
export function brushToAabb(brush: Brush, out: AABB): AABB {
  const c = Math.abs(Math.cos(brush.yaw));
  const s = Math.abs(Math.sin(brush.yaw));
  const hx = brush.size.x * 0.5;
  const hy = brush.size.y * 0.5;
  const hz = brush.size.z * 0.5;
  const ex = hx * c + hz * s;
  const ez = hx * s + hz * c;
  out.min.x = brush.pos.x - ex;
  out.min.y = brush.pos.y - hy;
  out.min.z = brush.pos.z - ez;
  out.max.x = brush.pos.x + ex;
  out.max.y = brush.pos.y + hy;
  out.max.z = brush.pos.z + ez;
  return out;
}

const tmpSweep = { t: 0, nx: 0, ny: 0, nz: 0 };
const candidateSet = new Set<number>();

/**
 * Sweep a box of half-extents (ex,ey,ez) centred on the segment start, from start
 * to end. Returns the earliest blocking brush.
 */
export function sweepBox(
  world: CollisionWorld,
  start: Vec3,
  end: Vec3,
  ex: number,
  ey: number,
  ez: number,
  out: SweepResult,
  ignoreClip = false,
): SweepResult {
  out.hit = false;
  out.fraction = 1;
  out.brushId = -1;
  set(out.normal, 0, 1, 0);

  const extent = Math.max(ex, ez);
  world.grid.query(start, end, extent, candidateSet);

  let bestT = 1;
  let bestBrush = -1;
  let bnx = 0;
  let bny = 1;
  let bnz = 0;

  for (const idx of candidateSet) {
    const brush = world.brushes[idx];
    if (!brush) continue;
    if (brush.nonSolid) continue; // never collided: see `Brush.nonSolid`
    if (ignoreClip && brush.clip) continue;
    const box = world.brushAabbs[idx];
    if (
      !sweepExpanded(start.x, start.y, start.z, end.x, end.y, end.z, box, ex, ey, ez, tmpSweep)
    ) {
      continue;
    }
    if (tmpSweep.t < bestT) {
      bestT = tmpSweep.t;
      bestBrush = idx;
      bnx = tmpSweep.nx;
      bny = tmpSweep.ny;
      bnz = tmpSweep.nz;
    }
  }

  if (bestBrush >= 0) {
    out.hit = true;
    out.fraction = clamp01(bestT);
    out.brushId = bestBrush;
    set(out.normal, bnx, bny, bnz);
    out.material = world.brushes[bestBrush].material;
    set(
      out.point,
      start.x + (end.x - start.x) * bestT,
      start.y + (end.y - start.y) * bestT,
      start.z + (end.z - start.z) * bestT,
    );
  }
  return out;
}

/** True when a box centred at `pos` with half extents overlaps any solid brush. */
export function boxOverlapsWorld(
  world: CollisionWorld,
  pos: Vec3,
  ex: number,
  ey: number,
  ez: number,
  ignoreClip = false,
  ignoreBrush = -1,
): boolean {
  const probe: AABB = {
    min: v3(pos.x - ex, pos.y - ey, pos.z - ez),
    max: v3(pos.x + ex, pos.y + ey, pos.z + ez),
  };
  const start = pos;
  const end = pos;
  world.grid.query(start, end, Math.max(ex, ez), candidateSet);
  for (const idx of candidateSet) {
    if (idx === ignoreBrush) continue;
    const brush = world.brushes[idx];
    if (!brush) continue;
    if (brush.nonSolid) continue; // never collided: see `Brush.nonSolid`
    if (ignoreClip && brush.clip) continue;
    if (aabbOverlap(probe, world.brushAabbs[idx])) return true;
  }
  return false;
}
