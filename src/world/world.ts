// =============================================================================
// world/world.ts — collision world + hitscan.
//
// The world is a list of yaw-rotated boxes ("brushes"). Everything else — walls,
// crates, ramps, stairs — is composed from them. This keeps the tracer exact,
// the renderer mergeable into a handful of meshes, and bot navigation trivial.
// =============================================================================

import { aabbFromCenter, clamp, set, v3 } from '../core/math';
import type { AABB, Brush, MapData, RayHit, TraceDesc, Vec3 } from '../core/types';
import { BrushGrid, brushToAabb, type CollisionWorld } from './trace';

export interface ActorHitbox {
  entityId: number;
  /** Boxes in world space, with the hit group they belong to. */
  boxes: { box: AABB; group: 'head' | 'chest' | 'stomach' | 'leg' }[];
}

export interface RaycastOptions {
  /** Collect every surface along the ray up to this many hits (penetration). */
  maxHits?: number;
  hitActors?: boolean;
  ignoreEntity?: number;
  /** Include brushes flagged `clip` (bots use clip brushes to path). */
  includeClip?: boolean;
  /** Only consider brushes flagged `clip`. */
  clipOnly?: boolean;
}

const tmpAabb: AABB = { min: v3(), max: v3(), };

function emptyHit(out: RayHit, start: Vec3): RayHit {
  out.hit = false;
  out.distance = Infinity;
  out.point.x = start.x;
  out.point.y = start.y;
  out.point.z = start.z;
  out.normal.x = 0;
  out.normal.y = 1;
  out.normal.z = 0;
  out.material = 'concrete';
  out.entityId = -1;
  out.hitGroup = 'generic';
  out.brushId = -1;
  return out;
}

export function createRayHit(): RayHit {
  return emptyHit(
    {
      hit: false,
      distance: 0,
      point: v3(),
      normal: v3(0, 1, 0),
      material: 'concrete',
      entityId: -1,
      hitGroup: 'generic',
      brushId: -1,
    },
    v3(),
  );
}

export class World implements CollisionWorld {
  readonly brushes: Brush[] = [];
  readonly brushAabbs: AABB[] = [];
  grid: BrushGrid;
  bounds: { min: Vec3; max: Vec3 };

  /** Registered actor hitboxes, refreshed by the game each tick. */
  private actorBoxes: ActorHitbox[] = [];
  private actorMap = new Map<number, ActorHitbox>();

  /** Optional per-material bullet-penetration thickness limit override. */
  readonly materialThickness: Partial<Record<string, number>> = {
    wood: 32,
    glass: 8,
    metal: 8,
    concrete: 0,
    sandstone: 0,
    sand: 0,
    water: 0,
  };

  constructor(map: MapData) {
    this.bounds = { min: { ...map.bounds.min }, max: { ...map.bounds.max } };
    this.grid = new BrushGrid(this.bounds, 128);
    this.addBrushes(map.brushes);
  }

  addBrushes(brushes: Brush[]): void {
    for (const b of brushes) {
      const idx = this.brushes.length;
      this.brushes.push(b);
      const box: AABB = { min: v3(), max: v3() };
      brushToAabb(b, box);
      this.brushAabbs.push(box);
      this.grid.insert(idx, box);
    }
  }

  registerActors(list: ActorHitbox[]): void {
    this.actorBoxes = list;
    this.actorMap.clear();
    for (const a of list) this.actorMap.set(a.entityId, a);
  }

  getActorHitbox(id: number): ActorHitbox | undefined {
    return this.actorMap.get(id);
  }

  /** True when the point is inside any solid brush. */
  isSolidPoint(p: Vec3): boolean {
    const probe: AABB = { min: v3(p.x - 0.5, p.y - 0.5, p.z - 0.5), max: v3(p.x + 0.5, p.y + 0.5, p.z + 0.5) };
    for (let i = 0; i < this.brushAabbs.length; i++) {
      const b = this.brushes[i];
      if (b.nonSolid) continue;
      const bb = this.brushAabbs[i];
      if (
        probe.min.x < bb.max.x &&
        probe.max.x > bb.min.x &&
        probe.min.y < bb.max.y &&
        probe.max.y > bb.min.y &&
        probe.min.z < bb.max.z &&
        probe.max.z > bb.min.z
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Cast a ray and return the first hit (or the nearest actor hit).
   * Static geometry is walked cell-by-cell through the uniform grid so a long
   * shot across a 5000-unit map does not scan 600 brushes.
   */
  raycast(start: Vec3, dir: Vec3, maxDist: number, opts: RaycastOptions = {}): RayHit {
    const out = createRayHit();
    const end: Vec3 = { x: start.x + dir.x * maxDist, y: start.y + dir.y * maxDist, z: start.z + dir.z * maxDist };
    let bestDist = maxDist;
    let bestBrush = -1;
    let bestNormal: Vec3 = v3(0, 1, 0);
    let bestPoint: Vec3 = { ...end };

    // --- static geometry ---------------------------------------------------
    const candidates = new Set<number>();
    this.grid.query(start, end, 0, candidates);
    // Also add brushes whose cell the ray's endpoints touch but whose AABB is
    // large: the grid insert already covers the full AABB, so candidates suffice.
    for (const idx of candidates) {
      const brush = this.brushes[idx];
      if (!brush) continue;
      if (opts.clipOnly ? !brush.clip : brush.clip && !opts.includeClip) continue;
      if (brush.nonSolid) continue;
      const box = this.brushAabbs[idx];
      if (brush.yaw !== 0) {
        // Rotated brush: use the yaw-expanded AABB. Slightly conservative but
        // only a handful of brushes in a map are rotated.
        brushToAabb(brush, tmpAabb);
        set(box.min, tmpAabb.min.x, tmpAabb.min.y, tmpAabb.min.z);
        set(box.max, tmpAabb.max.x, tmpAabb.max.y, tmpAabb.max.z);
      }
      const t = raySlab(start, dir, box, bestDist);
      if (t < 0 || t >= bestDist) continue;
      const nx: number = raySlabNormal.x;
      const ny: number = raySlabNormal.y;
      const nz: number = raySlabNormal.z;
      bestDist = t;
      bestBrush = idx;
      bestNormal = v3(nx, ny, nz);
      bestPoint = { x: start.x + dir.x * t, y: start.y + dir.y * t, z: start.z + dir.z * t };
    }

    // --- actors ------------------------------------------------------------
    if (opts.hitActors) {
      for (const actor of this.actorBoxes) {
        if (actor.entityId === opts.ignoreEntity) continue;
        for (const hb of actor.boxes) {
          const t = raySlab(start, dir, hb.box, bestDist);
          if (t < 0 || t >= bestDist) continue;
          bestDist = t;
          bestBrush = -1;
          out.hitGroup = hb.group;
          out.entityId = actor.entityId;
          bestNormal = v3(raySlabNormal.x, raySlabNormal.y, raySlabNormal.z);
          bestPoint = { x: start.x + dir.x * t, y: start.y + dir.y * t, z: start.z + dir.z * t };
        }
      }
    }

    if (bestBrush < 0 && out.entityId < 0) return out;

    out.hit = true;
    out.distance = bestDist;
    set(out.point, bestPoint.x, bestPoint.y, bestPoint.z);
    set(out.normal, bestNormal.x, bestNormal.y, bestNormal.z);
    if (bestBrush >= 0) {
      out.brushId = bestBrush;
      out.material = this.brushes[bestBrush].material;
    } else {
      out.brushId = -1;
      out.material = 'flesh';
    }
    return out;
  }

  /** Convenience wrapper matching the frozen `TraceDesc` contract. */
  trace(desc: TraceDesc): RayHit {
    const dx = desc.end.x - desc.start.x;
    const dy = desc.end.y - desc.start.y;
    const dz = desc.end.z - desc.start.z;
    const dist = Math.hypot(dx, dy, dz) || 1e-6;
    const dir = v3(dx / dist, dy / dist, dz / dist);
    return this.raycast(desc.start, dir, dist, {
      hitActors: desc.actors ?? false,
      ignoreEntity: desc.ignoreEntity ?? -1,
    });
  }

  /**
   * Line-of-sight test: true when nothing solid blocks the segment.
   * Used by bot perception and by the audio occlusion hook, so it ignores
   * clip brushes and thin glass would block (a glass wall hides you in CS terms
   * until it is shot out, which we do not model).
   */
  isVisible(from: Vec3, to: Vec3): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-4) return true;
    const dir = v3(dx / dist, dy / dist, dz / dist);
    const hit = this.raycast(from, dir, dist - 1, { includeClip: false });
    return !hit.hit;
  }

  /** 0 = clear line, 1 = fully blocked. Sampled along the segment for audio. */
  occlusionFactor(from: Vec3, to: Vec3): number {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-4) return 0;
    const dir = v3(dx / dist, dy / dist, dz / dist);
    const hit = this.raycast(from, dir, dist - 1, {});
    if (!hit.hit) return 0;
    // A single blocker gives partial occlusion: hearing through one wall is
    // muffled, through three is nearly silent.
    const t = clamp(hit.distance / dist, 0, 1);
    return clamp(0.55 + t * 0.25, 0, 1);
  }

  /** Suggest a surface normal aligned away from the shooter for decal placement. */
  orientedNormal(hit: RayHit, dir: Vec3): Vec3 {
    const n = hit.normal;
    const facing = n.x * dir.x + n.y * dir.y + n.z * dir.z;
    if (facing > 0) return v3(-n.x, -n.y, -n.z);
    return v3(n.x, n.y, n.z);
  }
}

// ---------------------------------------------------------------------------
// Ray/AABB slab test with module-level outputs (the hot path allocates nothing;
// callers copy what they need immediately).
// ---------------------------------------------------------------------------

const raySlabNormal = { x: 0, y: 1, z: 0 };

/**
 * Standard slab test for a ray with direction `d` launched from `o`.
 * `maxT` is the current best distance so far: anything farther is not returned.
 * Returns the entry distance, or -1 when the ray misses or only hits past maxT.
 */
function raySlab(o: Vec3, d: Vec3, box: AABB, maxT: number): number {
  let tmin = 0;
  let tmax = maxT;
  let nx = 0;
  let ny = 1;
  let nz = 0;

  // X slab
  if (Math.abs(d.x) < 1e-9) {
    if (o.x < box.min.x || o.x > box.max.x) return -1;
  } else {
    const inv = 1 / d.x;
    let t1 = (box.min.x - o.x) * inv;
    let t2 = (box.max.x - o.x) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      nx = s;
      ny = 0;
      nz = 0;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  // Y slab
  if (Math.abs(d.y) < 1e-9) {
    if (o.y < box.min.y || o.y > box.max.y) return -1;
  } else {
    const inv = 1 / d.y;
    let t1 = (box.min.y - o.y) * inv;
    let t2 = (box.max.y - o.y) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      nx = 0;
      ny = s;
      nz = 0;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  // Z slab
  if (Math.abs(d.z) < 1e-9) {
    if (o.z < box.min.z || o.z > box.max.z) return -1;
  } else {
    const inv = 1 / d.z;
    let t1 = (box.min.z - o.z) * inv;
    let t2 = (box.max.z - o.z) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      nx = 0;
      ny = 0;
      nz = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  // A ray starting inside the box has no meaningful entry normal; push out along
  // the axis of least penetration instead of reporting a bogus zero-length hit.
  if (tmin === 0 && nx === 0 && ny === 1 && nz === 0 && o.y > box.min.y && o.y < box.max.y) {
    return 0;
  }

  raySlabNormal.x = nx;
  raySlabNormal.y = ny;
  raySlabNormal.z = nz;
  return tmin;
}

/** Build an AABB from a centre and size (re-exported for callers building hitboxes). */
export { aabbFromCenter };
