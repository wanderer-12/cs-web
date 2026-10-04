// =============================================================================
// tests/duelmap.spec.ts — the duel arena contract.
//
// The arena is the one map where a broken nav bake or a missed mirror is not
// cosmetic: it is a 1v1 map, so an unreachable deck or an asymmetric crate is a
// gameplay bug. These tests lock the geometry invariants (180-degree symmetry,
// walkable staircases), the nav reachability (decks reachable from both spawns)
// and the authoring contract that `buildAimDuelLite()` hands out its own copy.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { AIM_DUEL_LITE, buildAimDuelLite } from '../src/world/maps/aim_duel_lite';
import { drawnBrushCount, validateMap } from '../src/world/maps/mapBuilder';
import type { MapData, NavNode, Vec3 } from '../src/core/types';

function navIndexNearest(nav: readonly NavNode[], p: Vec3): number {
  let best = -1;
  let bestDist = Infinity;
  nav.forEach((n, i) => {
    const d = Math.hypot(n.pos.x - p.x, n.pos.y - p.y, n.pos.z - p.z);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

function reachableFrom(nav: readonly NavNode[], start: number): Set<number> {
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const i = queue.pop();
    if (i === undefined) break;
    for (const j of nav[i].links) {
      if (seen.has(j)) continue;
      seen.add(j);
      queue.push(j);
    }
  }
  return seen;
}

function areasOf(nav: readonly NavNode[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of nav) out.set(n.area, (out.get(n.area) ?? 0) + 1);
  return out;
}

/** Key for the 180-degree mirror of a brush (rounded, since sizes are exact). */
function mirrorKey(x: number, y: number, z: number, sx: number, sy: number, sz: number): string {
  return [x, y, z, sx, sy, sz].map((v) => Math.round(v * 100) / 100).join(':');
}

describe('duel arena — geometry', () => {
  it('is sealed by its shell and sits inside the declared bounds', () => {
    const map = buildAimDuelLite();
    expect(map.name).toBe('aim_duel_lite');
    expect(map.brushes.length).toBeGreaterThanOrEqual(30);
    expect(drawnBrushCount(map)).toBe(map.brushes.length);

    for (const brush of map.brushes) {
      expect(brush.pos.x - brush.size.x / 2).toBeGreaterThanOrEqual(map.bounds.min.x - 0.01);
      expect(brush.pos.z - brush.size.z / 2).toBeGreaterThanOrEqual(map.bounds.min.z - 0.01);
      expect(brush.pos.x + brush.size.x / 2).toBeLessThanOrEqual(map.bounds.max.x + 0.01);
      expect(brush.pos.z + brush.size.z / 2).toBeLessThanOrEqual(map.bounds.max.z + 0.01);
    }

    // Brush ids start at 1 and never skip, which the renderer relies on for
    // deterministic material grouping.
    expect(map.brushes.map((b) => b.id)).toEqual(map.brushes.map((_, i) => i + 1));
  });

  it('is 180-degree rotationally symmetric, so neither side gets better cover', () => {
    const map = buildAimDuelLite();
    const keys = new Set(
      map.brushes.map((b) => mirrorKey(b.pos.x, b.pos.y, b.pos.z, b.size.x, b.size.y, b.size.z)),
    );
    const missing: string[] = [];
    for (const b of map.brushes) {
      const mirrored = mirrorKey(-b.pos.x, b.pos.y, -b.pos.z, b.size.x, b.size.y, b.size.z);
      if (!keys.has(mirrored)) missing.push(`brush ${b.id} at (${b.pos.x}, ${b.pos.z})`);
    }
    expect(missing).toEqual([]);
  });

  it('builds crates for cover and staircases the player can actually climb', () => {
    const map = buildAimDuelLite();
    const cover = map.brushes.filter(
      (b) => (b.material === 'wood' || b.material === 'metal') && b.size.y >= 60 && b.size.y <= 288,
    );
    expect(cover.length).toBeGreaterThanOrEqual(10);

    // 8 treads per ramp, 2 ramps: every riser must stay under PLAYER.stepHeight
    // (18) or the ramp is a wall for both the player and the nav bake.
    const treads = map.brushes.filter(
      (b) => b.material === 'concrete' && b.size.y > 0 && b.size.y <= 128 && b.size.y % 16 === 0 && b.pos.y > 0,
    );
    expect(treads.length).toBeGreaterThanOrEqual(16);
    for (let i = 1; i <= 8; i++) {
      const top = i * 16;
      const found = treads.filter((b) => Math.abs(b.pos.y - top / 2) < 0.01);
      expect(found.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('starts each team on its own pad, facing the arena', () => {
    const map = buildAimDuelLite();
    const t = map.spawns.filter((s) => s.team === 'T');
    const ct = map.spawns.filter((s) => s.team === 'CT');
    expect(t).toHaveLength(4);
    expect(ct).toHaveLength(4);
    expect(t.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(ct.map((s) => s.index)).toEqual([0, 1, 2, 3]);

    for (const s of t) {
      expect(s.pos.y).toBe(8);
      expect(s.pos.z).toBeGreaterThan(1000);
      expect(s.yaw).toBe(0);
    }
    for (const s of ct) {
      expect(s.pos.y).toBe(8);
      expect(s.pos.z).toBeLessThan(-1000);
      expect(s.yaw).toBeCloseTo(Math.PI, 6);
    }

    // Each spawn is inside its own buy zone (the pad the mode buys from).
    for (const team of ['T', 'CT'] as const) {
      const zone = map.buyZones.find((z) => z.team === team);
      expect(zone).toBeDefined();
      for (const s of map.spawns.filter((sp) => sp.team === team)) {
        expect(s.pos.x).toBeGreaterThan(zone!.min.x);
        expect(s.pos.x).toBeLessThan(zone!.max.x);
        expect(s.pos.z).toBeGreaterThan(zone!.min.z);
        expect(s.pos.z).toBeLessThan(zone!.max.z);
      }
    }
  });

  it('has no bomb sites and no clip brushes', () => {
    const map = buildAimDuelLite();
    expect(map.sites).toEqual([]);
    expect(map.brushes.some((b) => b.clip === true || b.nonSolid === true)).toBe(false);
  });

  it('maps the whole arena into [0, 1] radar space', () => {
    const map = buildAimDuelLite();
    const project = (v: number, origin: number): number => (v - origin) * map.radar.scale;
    for (const x of [map.bounds.min.x, map.bounds.max.x]) {
      const u = project(x, map.radar.originX);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
    }
    for (const z of [map.bounds.min.z, map.bounds.max.z]) {
      const v = project(z, map.radar.originZ);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('duel arena — navigation', () => {
  it('bakes a dense nav mesh with no floating or dangling nodes', () => {
    const map = buildAimDuelLite();
    expect(map.nav.length).toBeGreaterThanOrEqual(80);
    expect(validateMap(map)).toEqual([]);

    for (const node of map.nav) {
      expect(node.links).not.toContain(node.id);
      expect(new Set(node.links).size).toBe(node.links.length);
      expect(node.site).toBeNull();
      for (const link of node.links) {
        const other = map.nav[link];
        const d = Math.hypot(
          other.pos.x - node.pos.x,
          other.pos.y - node.pos.y,
          other.pos.z - node.pos.z,
        );
        // Mirrors the dust2 contract: no link may teleport across the map.
        expect(d).toBeLessThanOrEqual(320);
      }
    }
  });

  it('labels the lanes a bot needs to tell apart', () => {
    const map = buildAimDuelLite();
    const areas = areasOf(map.nav);
    for (const area of ['TSpawn', 'CTSpawn', 'Mid', 'WestLane', 'EastLane', 'TDeck', 'CTDeck']) {
      expect(areas.get(area) ?? 0).toBeGreaterThan(0);
    }
    expect(map.nav.some((n) => n.choke)).toBe(true);
  });

  it('reaches both decks from both spawns, so the staircases are walkable', () => {
    const map = buildAimDuelLite();
    const spawnT = { x: 0, y: 8, z: 1184 };
    const spawnCT = { x: 0, y: 8, z: -1184 };

    for (const spawn of [spawnT, spawnCT]) {
      const start = navIndexNearest(map.nav, spawn);
      const seen = reachableFrom(map.nav, start);
      const reachableAreas = new Set([...seen].map((i) => map.nav[i].area));
      expect(reachableAreas.has('TDeck')).toBe(true);
      expect(reachableAreas.has('CTDeck')).toBe(true);
      expect(reachableAreas.has('WestLane')).toBe(true);
      expect(reachableAreas.has('EastLane')).toBe(true);
    }
  });

  it('keeps every spawn within reach of the mesh', () => {
    const map = buildAimDuelLite();
    for (const spawn of map.spawns) {
      const near = map.nav.some(
        (n) => Math.hypot(n.pos.x - spawn.pos.x, n.pos.z - spawn.pos.z) <= 160,
      );
      expect(near).toBe(true);
    }
  });
});

describe('duel arena — module contract', () => {
  it('hands out an editable copy and leaves the frozen map alone', () => {
    const frozenNavLength = AIM_DUEL_LITE.nav.length;
    const a = buildAimDuelLite();
    const b = buildAimDuelLite();
    expect(a).not.toBe(b);
    a.brushes[0].pos.x += 512;
    a.nav.length = 0;
    expect(b.brushes[0].pos.x).toBe(AIM_DUEL_LITE.brushes[0].pos.x);
    expect(AIM_DUEL_LITE.nav.length).toBe(frozenNavLength);
  });

  it('keeps the arena small enough for a duel and the AWP lane long enough to matter', () => {
    const map = buildAimDuelLite();
    const spanX = map.bounds.max.x - map.bounds.min.x;
    const spanZ = map.bounds.max.z - map.bounds.min.z;
    // ~40 x 53 m: one screen-ish wide, one AWP lane long.
    expect(spanX).toBeGreaterThan(1800);
    expect(spanX).toBeLessThan(2600);
    expect(spanZ).toBeGreaterThan(2600);
    expect(spanZ).toBeLessThan(3400);
    // A duel map is a fraction of dust2 (6144 x 6144): this one is ~16%.
    expect(spanX * spanZ).toBeLessThan(6144 * 6144 * 0.2);
  });
});

/** Exported for the map-data type test below. */
export type { MapData };