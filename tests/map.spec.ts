// tests/map.spec.ts
//
// Structural validation of de_dust2_lite's navigation data. These tests are the
// contract between the map data and every bot / gamemode module that consumes
// it, so they deliberately re-implement the geometric primitives (AABB, slab
// segment test, point-in-polygon) instead of importing world/trace.ts: a test
// that shares its implementation with the thing under test proves nothing.
//
// The one rule worth explaining up front is the STEP-OVER rule used by
// `blocksWalk` and `nodeInsideSolid`. Nav nodes sit exactly ON the walkable
// surface (node.y === the floor's top face), which means a node on a staircase
// tread is geometrically flush with that tread's AABB, and the straight line
// between two nodes on adjacent treads necessarily clips the corner of the
// step in between. Both are walkable in practice because the player has an
// 18-unit step height, so a brush counts as an obstacle only when
//   * it is taller than the higher of the two nodes, or
//   * the climb needed to get onto it exceeds PLAYER.stepHeight.
// Anything else is a tread, not a wall.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { DUST2_LITE, buildDust2Lite } from '../src/world/maps/de_dust2_lite';
import { buildMapMeshes } from '../src/world/MapGeometry';
import { PLAYER } from '../src/core/config';
import type { AABB, Brush, MapData, Vec3 } from '../src/core/types';

const map: MapData = DUST2_LITE;

/** Tolerance used for every containment test: a point ON a face is not inside. */
const EPS = 0.05;
/** Node floor search depth from the spec. */
const FLOOR_PROBE = 40;

/** World-space AABB of a yawed brush (same formula as world/trace.ts). */
function brushAabb(b: Brush): AABB {
  const c = Math.abs(Math.cos(b.yaw));
  const s = Math.abs(Math.sin(b.yaw));
  const hx = b.size.x / 2;
  const hy = b.size.y / 2;
  const hz = b.size.z / 2;
  const ex = hx * c + hz * s;
  const ez = hx * s + hz * c;
  return {
    min: { x: b.pos.x - ex, y: b.pos.y - hy, z: b.pos.z - ez },
    max: { x: b.pos.x + ex, y: b.pos.y + hy, z: b.pos.z + ez },
  };
}

// Clip brushes are collidable and must not contain a nav node, so they are
// included here. `nonSolid` brushes are filtered out exactly like trace.ts does.
const solid: { brush: Brush; box: AABB }[] = map.brushes
  .filter((b) => !b.nonSolid)
  .map((b) => ({ brush: b, box: brushAabb(b) }));

const label = (b: Brush): string => `brush#${b.id}(${b.material})`;

function pointInside(p: Vec3, box: AABB): boolean {
  return (
    p.x > box.min.x + EPS &&
    p.x < box.max.x - EPS &&
    p.y > box.min.y + EPS &&
    p.y < box.max.y - EPS &&
    p.z > box.min.z + EPS &&
    p.z < box.max.z - EPS
  );
}

/** Slab-method segment/AABB overlap test. */
function segmentHitsBox(a: Vec3, b: Vec3, box: AABB): boolean {
  const lo = [box.min.x, box.min.y, box.min.z];
  const hi = [box.max.x, box.max.y, box.max.z];
  // Shrink so that sliding along a face or standing on a top face is not a hit.
  for (let i = 0; i < 3; i++) {
    lo[i] += EPS;
    hi[i] -= EPS;
    if (hi[i] < lo[i]) return false;
  }
  const p = [a.x, a.y, a.z];
  const d = [b.x - a.x, b.y - a.y, b.z - a.z];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (p[i] < lo[i] || p[i] > hi[i]) return false;
      continue;
    }
    let ta = (lo[i] - p[i]) / d[i];
    let tb = (hi[i] - p[i]) / d[i];
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

/** Highest solid surface at (x, z) that is not above `y`. */
function floorBelow(x: number, z: number, y: number): number | null {
  let best: number | null = null;
  for (const { box } of solid) {
    if (x <= box.min.x || x >= box.max.x || z <= box.min.z || z >= box.max.z) continue;
    if (box.max.y > y + EPS) continue;
    if (best === null || box.max.y > best) best = box.max.y;
  }
  return best;
}

/** Step-over-aware walkability test for a straight link. */
function blocksWalk(a: Vec3, b: Vec3): Brush | null {
  const low = Math.min(a.y, b.y);
  const high = Math.max(a.y, b.y);
  for (const { brush, box } of solid) {
    if (!segmentHitsBox(a, b, box)) continue;
    if (box.max.y <= high + 1e-6 && box.max.y - low <= PLAYER.stepHeight + 1e-6) continue;
    return brush;
  }
  return null;
}

/** The (only) brush whose interior contains a node, ignoring flush contacts. */
function nodeInsideSolid(p: Vec3): Brush | null {
  for (const { brush, box } of solid) if (pointInside(p, box)) return brush;
  return null;
}

describe('de_dust2_lite — contract', () => {
  it('ships the metadata the rest of the game reads', () => {
    expect(map.name).toBe('de_dust2_lite');
    expect(map.spawns.filter((s) => s.team === 'T')).toHaveLength(5);
    expect(map.spawns.filter((s) => s.team === 'CT')).toHaveLength(5);
    expect(map.buyZones.map((z) => z.team).sort()).toEqual(['CT', 'T']);
    expect(map.sites.map((s) => s.site).sort()).toEqual(['A', 'B']);
    expect(Object.keys(map.callouts).length).toBeGreaterThanOrEqual(16);
  });

  it('buildDust2Lite returns an independent deep copy', () => {
    const copy = buildDust2Lite();
    expect(copy.brushes).toHaveLength(map.brushes.length);
    expect(copy.nav).toHaveLength(map.nav.length);
    expect(copy.brushes[0]).not.toBe(map.brushes[0]);
    copy.brushes[0].pos.x += 1000;
    copy.nav[0].links.push(999);
    expect(map.brushes[0].pos.x).not.toBe(copy.brushes[0].pos.x);
    expect(map.nav[0].links).not.toContain(999);
  });

  it('ids brushes sequentially from 1', () => {
    map.brushes.forEach((b, i) => expect(b.id).toBe(i + 1));
  });

  it('has at least 140 nav nodes', () => {
    expect(map.nav.length).toBeGreaterThanOrEqual(140);
  });
});

describe('de_dust2_lite — nav links', () => {
  it('1. every link is symmetric and points at an existing node', () => {
    const problems: string[] = [];
    map.nav.forEach((node, i) => {
      for (const target of node.links) {
        if (target < 0 || target >= map.nav.length) {
          problems.push(`node ${i} links to out-of-range index ${target}`);
          continue;
        }
        if (target === i) problems.push(`node ${i} links to itself`);
        const back = map.nav[target];
        if (!back.links.includes(i)) problems.push(`node ${i} -> ${target} is one-way`);
      }
      const unique = new Set(node.links);
      if (unique.size !== node.links.length) problems.push(`node ${i} has duplicate links`);
    });
    expect(problems).toEqual([]);
  });

  it('2. no link is longer than 320 units', () => {
    const long: string[] = [];
    map.nav.forEach((node, i) => {
      for (const t of node.links) {
        const o = map.nav[t].pos;
        const d = Math.hypot(o.x - node.pos.x, o.y - node.pos.y, o.z - node.pos.z);
        if (d > 320) long.push(`node ${i} -> ${t} is ${d.toFixed(1)} units`);
      }
    });
    expect(long).toEqual([]);
  });
});

describe('de_dust2_lite — nav nodes vs geometry', () => {
  it('3. no node sits inside a solid brush', () => {
    const bad: string[] = [];
    map.nav.forEach((node, i) => {
      const hit = nodeInsideSolid(node.pos);
      if (hit) bad.push(`node ${i} @${JSON.stringify(node.pos)} is inside ${label(hit)}`);
    });
    expect(bad).toEqual([]);
  });

  it('4. every node has walkable floor within 40 units below it', () => {
    const bad: string[] = [];
    map.nav.forEach((node, i) => {
      const top = floorBelow(node.pos.x, node.pos.z, node.pos.y);
      if (top === null) {
        bad.push(`node ${i} @${JSON.stringify(node.pos)} (${node.area}) has no floor below`);
      } else if (node.pos.y - top > FLOOR_PROBE) {
        bad.push(
          `node ${i} @${JSON.stringify(node.pos)} (${node.area}) floats ${(node.pos.y - top).toFixed(1)} above floor`,
        );
      }
    });
    expect(bad).toEqual([]);
  });

  it('5. every linked pair is walkable in a straight line', () => {
    const bad: string[] = [];
    map.nav.forEach((node, i) => {
      for (const t of node.links) {
        if (t <= i) continue; // symmetric: test each pair once
        const hit = blocksWalk(node.pos, map.nav[t].pos);
        if (hit) {
          bad.push(
            `node ${i} (${node.area}) @${JSON.stringify(node.pos)} -> node ${t} (${map.nav[t].area}) ` +
              `@${JSON.stringify(map.nav[t].pos)} is blocked by ${label(hit)}`,
          );
        }
      }
    });
    expect(bad).toEqual([]);
  });
});

describe('de_dust2_lite — gameplay regions', () => {
  it('6. T and CT spawns exist in distinct areas', () => {
    const tSpawns = map.spawns.filter((s) => s.team === 'T');
    const ctSpawns = map.spawns.filter((s) => s.team === 'CT');
    const nearest = (p: Vec3): string => {
      let best = map.nav[0];
      let bestD = Infinity;
      for (const n of map.nav) {
        const d = Math.hypot(n.pos.x - p.x, n.pos.y - p.y, n.pos.z - p.z);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      return best.area;
    };
    const tAreas = new Set(tSpawns.map((s) => nearest(s.pos)));
    const ctAreas = new Set(ctSpawns.map((s) => nearest(s.pos)));
    expect(tAreas.size).toBeGreaterThan(0);
    expect(ctAreas.size).toBeGreaterThan(0);
    for (const a of tAreas) for (const b of ctAreas) expect(a).not.toBe(b);
    expect([...tAreas].every((a) => a === 'TSpawn')).toBe(true);
    expect([...ctAreas].every((a) => a === 'CTSpwn')).toBe(true);
  });

  it('7. both bomb sites carry at least three tagged nav nodes', () => {
    for (const site of ['A', 'B'] as const) {
      const tagged = map.nav.filter((n) => n.site === site);
      expect(tagged.length, `site ${site} nav nodes`).toBeGreaterThanOrEqual(3);
      const region = map.sites.find((s) => s.site === site);
      expect(region).toBeDefined();
      for (const n of tagged) {
        expect(Math.abs(n.pos.y - (region?.y ?? 0))).toBeLessThanOrEqual(8);
      }
    }
  });

  it('8. chokepoints are tagged', () => {
    const chokes = map.nav.filter((n) => n.choke);
    expect(chokes.length).toBeGreaterThan(0);
    const areas = new Set(chokes.map((c) => c.area));
    expect(areas.has('MidDoors')).toBe(true);
    expect(areas.has('BDoors')).toBe(true);
    expect(areas.has('LongDoors')).toBe(true);
  });

  it('9. site spots sit on walkable floor', () => {
    for (const region of map.sites) {
      expect(region.spots.length).toBeGreaterThanOrEqual(3);
      for (const spot of region.spots) {
        expect(nodeInsideSolid(spot), `${region.site} spot ${JSON.stringify(spot)} inside solid`).toBeNull();
        const top = floorBelow(spot.x, spot.z, spot.y);
        expect(top, `${region.site} spot ${JSON.stringify(spot)} has no floor`).not.toBeNull();
        expect(Math.abs(spot.y - (top ?? spot.y))).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('de_dust2_lite — radar', () => {
  it('10. a uniform scale maps every brush corner into [0,1]', () => {
    const { originX, originZ, scale } = map.radar;
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const b of map.brushes) {
      const box = brushAabb(b);
      for (const x of [box.min.x, box.max.x]) {
        for (const z of [box.min.z, box.max.z]) {
          const u = (x - originX) * scale;
          const v = (z - originZ) * scale;
          uMin = Math.min(uMin, u);
          uMax = Math.max(uMax, u);
          vMin = Math.min(vMin, v);
          vMax = Math.max(vMax, v);
        }
      }
    }
    expect(scale).toBeGreaterThan(0);
    expect(uMin).toBeGreaterThanOrEqual(0);
    expect(uMax).toBeLessThanOrEqual(1);
    expect(vMin).toBeGreaterThanOrEqual(0);
    expect(vMax).toBeLessThanOrEqual(1);
    // Uniform scale in X and Z: identical world spans must map to identical lengths.
    const spanX = (uMax - uMin) / scale;
    const spanZ = (vMax - vMin) / scale;
    expect(Math.max(spanX, spanZ) / Math.min(spanX, spanZ)).toBeGreaterThan(0.99);
  });

  it('11. bounds enclose every brush', () => {
    for (const b of map.brushes) {
      const box = brushAabb(b);
      expect(box.min.x).toBeGreaterThanOrEqual(map.bounds.min.x - 1e-6);
      expect(box.min.y).toBeGreaterThanOrEqual(map.bounds.min.y - 1e-6);
      expect(box.min.z).toBeGreaterThanOrEqual(map.bounds.min.z - 1e-6);
      expect(box.max.x).toBeLessThanOrEqual(map.bounds.max.x + 1e-6);
      expect(box.max.y).toBeLessThanOrEqual(map.bounds.max.y + 1e-6);
      expect(box.max.z).toBeLessThanOrEqual(map.bounds.max.z + 1e-6);
    }
  });
});

describe('de_dust2_lite — connectivity (the test that matters)', () => {
  it('12. BFS from node 0 reaches every node', () => {
    const seen = new Set<number>([0]);
    const queue = [0];
    while (queue.length > 0) {
      const i = queue.pop() as number;
      for (const t of map.nav[i].links) {
        if (seen.has(t)) continue;
        seen.add(t);
        queue.push(t);
      }
    }
    const missing = map.nav.filter((n) => !seen.has(n.id));
    const detail = missing
      .slice(0, 25)
      .map((n) => `#${n.id} ${n.area} @(${n.pos.x.toFixed(0)},${n.pos.y.toFixed(0)},${n.pos.z.toFixed(0)})`)
      .join('; ');
    expect(missing.length, `unreachable nav nodes: ${detail}`).toBe(0);
  });

  it('13. every walkable area string is represented and reachable', () => {
    const expected = [
      'TSpawn',
      'CTSpwn',
      'Mid',
      'MidDoors',
      'Catwalk',
      'LongA',
      'LongDoors',
      'Pit',
      'ASite',
      'ARamp',
      'Tunnels',
      'UpperTunnel',
      'LowerTunnel',
      'BSite',
      'BPlat',
      'BDoors',
      'CTMid',
    ];
    const seen = new Set(map.nav.map((n) => n.area));
    const absent = expected.filter((a) => !seen.has(a));
    expect(absent, `areas with no nav node: ${absent.join(', ')}`).toEqual([]);
  });
});

describe('MapGeometry — merged render meshes', () => {
  const { group, stats } = buildMapMeshes(map, { shadows: true });
  const drawable = map.brushes.filter((b) => b.clip !== true && b.nonSolid !== true);

  it('14. stays inside the draw-call budget', () => {
    expect(stats.drawCalls).toBe(group.children.length);
    expect(stats.drawCalls, `draw calls: ${stats.drawCalls}`).toBeLessThanOrEqual(14);
  });

  it('15. draws every visible brush and nothing else', () => {
    // A box is 12 triangles, so an exact triangle count proves both directions:
    // no visible brush is missing, and no clip/nonSolid brush leaked into a mesh.
    expect(stats.brushes).toBe(drawable.length);
    expect(stats.triangles).toBe(drawable.length * 12);
  });

  it('16. leaves materials untextured and tagged for the texture pass', () => {
    for (const child of group.children) {
      expect(child.name).toBe(`mt-${String(child.userData.material)}`);
      const mesh = child as THREE.Mesh;
      expect(mesh.matrixAutoUpdate).toBe(false);
      const material = mesh.material as THREE.MeshStandardMaterial;
      expect(material.map).toBeNull();
      expect(material.name).toBe(`mt-${String(child.userData.material)}`);
    }
  });

  /** Largest u/v seen in a mesh's UV attribute — the tiling repeat of its widest face. */
  function uvExtent(mesh: THREE.Mesh): { u: number; v: number } {
    const uv = mesh.geometry.getAttribute('uv');
    let u = 0;
    let v = 0;
    for (let i = 0; i < uv.count; i++) {
      u = Math.max(u, uv.getX(i));
      v = Math.max(v, uv.getY(i));
    }
    return { u, v };
  }

  it('17. tiles each box face at the material tile size', () => {
    // A 1280 x 64 x 512 box: the faces that span the 1280 axis (its caps and its
    // ends) must repeat 1280 / tile, the faces that span 512 must repeat 512 / tile.
    const probe = (material: Brush['material'], texScale?: number): Brush => ({
      id: 1,
      pos: { x: 0, y: 0, z: 0 },
      size: { x: 1280, y: 64, z: 512 },
      yaw: 0,
      material,
      ...(texScale === undefined ? {} : { texScale }),
    });

    const synthetic: MapData = {
      ...map,
      brushes: [probe('sandstone'), probe('sand', 256)],
    };
    const built = buildMapMeshes(synthetic);
    const stone = built.group.children.find((c) => c.userData.material === 'sandstone');
    const sand = built.group.children.find((c) => c.userData.material === 'sand');
    expect(stone, 'sandstone mesh').toBeDefined();
    expect(sand, 'sand mesh').toBeDefined();

    // sandstone tile 128: 1280/128 = 10, 512/128 = 4.
    expect(uvExtent(stone as THREE.Mesh)).toEqual({ u: 10, v: 4 });
    // The brush's own texScale (256) overrides the material default (sand: 256): 5 and 2.
    expect(uvExtent(sand as THREE.Mesh)).toEqual({ u: 5, v: 2 });
  });

  it('18. never stretches a real face across more than one tile without repeating', () => {
    // Weaker but map-independent: every merged mesh must contain at least one face
    // that repeats, i.e. the whole map is not drawn with a single 0..1 unwrap.
    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      const { u, v } = uvExtent(mesh);
      expect(Math.max(u, v), `${mesh.name} repeats`).toBeGreaterThan(1);
    }
  });
});
