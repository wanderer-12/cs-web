// =============================================================================
// tests/navigation.spec.ts — synthetic-map tests for src/ai/navigation.ts
//
// The real map (src/world/maps/de_dust2_lite.ts) is owned by another workstream
// and may still be in flight, so every test here builds its own MapData by hand.
// That also lets us assert exact lengths: the main grid is 5x5 with 256-unit
// spacing, so a straight run of four edges is exactly 1024 units.
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  NavGraph,
  createFollower,
  followPath,
  nudgeIntoFreeSpace,
  pathLength,
  smoothPath,
} from '../src/ai/navigation';
import type { Brush, MapData, NavNode, Vec3 } from '../src/core/types';
import { v3, distance } from '../src/core/math';
import { World } from '../src/world/world';

// ---------------------------------------------------------------------------
// Synthetic map
// ---------------------------------------------------------------------------

const GRID = 5;
/** Distance between adjacent grid nodes, in CS units. */
const SPACING = 256;
/** Node ids on the main grid, row-major: id = row * GRID + col. */
const gridId = (row: number, col: number): number => row * GRID + col;
/** Node 12 is the middle of the grid: both main routes from corner to corner pass it. */
const CHOKE = gridId(2, 2);
/** A disconnected island, never linked to the grid. */
const ISLAND_ID = GRID * GRID;
const ISLAND_POS: Vec3 = { x: 5120, y: 0, z: 5120 };

/** Node id for an (x, z) position on the main grid. Coordinates are 1-based. */
function idAt(x: number, z: number): number {
  return gridId(z / SPACING - 1, x / SPACING - 1);
}

function navNode(id: number, x: number, y: number, z: number, area: string, extra: Partial<NavNode> = {}): NavNode {
  return { id, pos: { x, y, z }, links: [], area, ...extra };
}

function brush(id: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, material: Brush['material'] = 'concrete'): Brush {
  return { id, pos: { x, y, z }, size: { x: sx, y: sy, z: sz }, yaw: 0, material };
}

/**
 * Build the synthetic map.
 *
 * Lay-out (X grows east, Z grows south, nodes on the ground plane y = 0):
 *   - 5x5 grid of nodes 256 units apart, rows/cols 256..1280.
 *   - Columns 0..1 are area 'West' (A site), columns 2..4 are area 'East' (B site).
 *   - One choke node in the centre.
 *   - A disconnected island far east-south.
 *   - A wall straddling x = 768, spanning z 512..1024, which severs line of sight
 *     across the centre of the map but leaves the graph links intact — the
 *     classic "walk around the wall" nav case.
 */
function makeMap(): MapData {
  const nav: NavNode[] = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const id = gridId(row, col);
      const area = col <= 1 ? 'West' : 'East';
      const site: 'A' | 'B' = col <= 1 ? 'A' : 'B';
      const extra: Partial<NavNode> = { site };
      if (id === CHOKE) extra.choke = true;
      nav.push(navNode(id, SPACING * (col + 1), 0, SPACING * (row + 1), area, extra));
    }
  }
  nav.push(navNode(ISLAND_ID, ISLAND_POS.x, 0, ISLAND_POS.z, 'Yard'));

  // Bidirectional links: right/down orthogonal neighbours plus the down-right
  // diagonal. The diagonals matter: without them the corner-to-corner route is a
  // staircase of orthogonals, the centre choke is never on a shortest path, and
  // choke avoidance cannot be observed at all.
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const id = gridId(row, col);
      if (col + 1 < GRID) {
        const right = gridId(row, col + 1);
        nav[id].links.push(right);
        nav[right].links.push(id);
      }
      if (row + 1 < GRID) {
        const down = gridId(row + 1, col);
        nav[id].links.push(down);
        nav[down].links.push(id);
      }
      if (row + 1 < GRID && col + 1 < GRID) {
        const diag = gridId(row + 1, col + 1);
        nav[id].links.push(diag);
        nav[diag].links.push(id);
      }
    }
  }

  return {
    name: 'synthetic_nav_grid',
    bounds: { min: { x: 0, y: -64, z: 0 }, max: { x: 1536, y: 384, z: 1536 } },
    brushes: [brush(0, 768, 0, 768, 32, 128, 512)],
    spawns: [
      { pos: { x: 256, y: 0, z: 256 }, yaw: 0, team: 'T', index: 0 },
      { pos: { x: 1280, y: 0, z: 1280 }, yaw: Math.PI, team: 'CT', index: 0 },
    ],
    nav,
    sites: [
      { site: 'A', poly: [[256, 256], [512, 256], [512, 512]], y: 0, spots: [{ x: 256, y: 0, z: 256 }] },
      { site: 'B', poly: [[1024, 1024], [1280, 1024], [1280, 1280]], y: 0, spots: [{ x: 1280, y: 0, z: 1280 }] },
    ],
    callouts: { Mid: { x: 768, y: 0, z: 768 } },
    radar: { originX: 0, originZ: 0, scale: 1 / 1536 },
    buyZones: [],
  };
}

const map = makeMap();
const world = new World(map);
/** Graph without collision: raw node chains, unsmoothed points. */
const graph = new NavGraph(map);
/** Graph with collision attached: `findPath` smooths its waypoints against the wall. */
const graphWithWorld = new NavGraph(map);
graphWithWorld.attachWorld(world);

const CORNER_NW = gridId(0, 0); // (256, 0, 256)
const CORNER_SE = gridId(4, 4); // (1280, 0, 1280)
const CENTRE = CHOKE;

function expectClose(actual: number, expected: number, tol = 1e-6): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

/**
 * Reference shortest-path search used as an independent oracle for the cost
 * model. It is a plain O(n^2) Dijkstra over the node array with the same cost
 * definition the spec gives: `distance(a, b) + chokePenalty + areaPenalty`.
 * `NavGraph` is free to be greedier than this (its heuristic weight defaults to
 * 1.15, exactly like a real navmesh A*), so callers that want to compare node
 * lists must construct the graph with `heuristicWeight: 1`.
 *
 * Where two routes cost exactly the same, `NavGraph` breaks the tie on node id
 * while this oracle breaks it on array order, so tests should compare costs and
 * route *properties* rather than the raw node list.
 */
function referenceShortestPath(
  nav: readonly NavNode[],
  start: number,
  goal: number,
  chokePenalty = 0,
  areaPenalty: (area: string) => number = () => 0,
): { cost: number; nodes: number[] } {
  const n = nav.length;
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  dist[start] = 0;
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    if (u < 0 || u === goal) break;
    done[u] = true;
    for (const v of nav[u].links) {
      if (v < 0 || v >= n || done[v]) continue;
      const step =
        distance(nav[u].pos, nav[v].pos) +
        (nav[v].choke === true ? chokePenalty : 0) +
        areaPenalty(nav[v].area);
      if (dist[u] + step < dist[v]) {
        dist[v] = dist[u] + step;
        prev[v] = u;
      }
    }
  }
  const nodes: number[] = [];
  for (let c = goal; c >= 0; c = prev[c]) {
    nodes.push(c);
    if (c === start) break;
  }
  nodes.reverse();
  return { cost: dist[goal], nodes };
}

// ---------------------------------------------------------------------------

describe('NavGraph — shortest paths', () => {
  it('finds the straight run along a row with the expected node count and length', () => {
    const path = graph.findPath(gridId(0, 0), gridId(0, 4), 'T');
    expect(path.empty).toBe(false);
    expect(path.nodes).toEqual([gridId(0, 0), gridId(0, 1), gridId(0, 2), gridId(0, 3), gridId(0, 4)]);
    expectClose(path.length, SPACING * 4, 1e-6);
    expectClose(pathLength(path.points), path.length, 1e-6);
    expect(path.cost).toBeGreaterThanOrEqual(path.length);
  });

  it('routes through the choke when the penalty is cheap', () => {
    // `heuristicWeight: 1` makes A* admissible, so the node list is the unique
    // optimum and can be compared against the reference search verbatim.
    const cheap = new NavGraph(map, { chokePenalty: 100, heuristicWeight: 1 });
    const path = cheap.findPath(CORNER_NW, CORNER_SE, 'T');
    expect(path.empty).toBe(false);
    expect(path.nodes).toContain(CENTRE);
    expect(path.chokes).toEqual([CENTRE]);
    // Four diagonal edges: 4 * 256 * sqrt(2) — the centre choke is unavoidable
    // on the corner-to-corner diagonal, which is what makes it a choke.
    expectClose(path.length, 4 * SPACING * Math.SQRT2, 1e-6);
    expectClose(path.cost, path.length + 100, 1e-6);
    const reference = referenceShortestPath(map.nav, CORNER_NW, CORNER_SE, 100);
    expectClose(path.cost, reference.cost, 1e-6);
    expect(path.nodes[0]).toBe(CORNER_NW);
    expect(path.nodes[path.nodes.length - 1]).toBe(CORNER_SE);
  });

  it('routes around the choke when the penalty exceeds the detour', () => {
    const cheap = new NavGraph(map, { chokePenalty: 100, heuristicWeight: 1 }).findPath(CORNER_NW, CORNER_SE, 'T');
    const expensive = new NavGraph(map, { chokePenalty: 2000, heuristicWeight: 1 });
    const path = expensive.findPath(CORNER_NW, CORNER_SE, 'T');
    expect(path.empty).toBe(false);
    expect(path.chokes).toEqual([]);
    // A 2000-unit surcharge is far more than the ~150-unit detour it buys.
    expect(path.nodes).not.toContain(CHOKE);
    expect(path.nodes.length).toBeGreaterThan(cheap.nodes.length); // longer route, but cheaper overall
    // The reference search agrees on the price of the route it settles on. The
    // node lists can differ where two routes tie exactly, so compare costs.
    const reference = referenceShortestPath(map.nav, CORNER_NW, CORNER_SE, 2000);
    expectClose(path.cost, reference.cost, 1e-6);
    expect(path.cost).toBeGreaterThan(cheap.cost);
    expect(path.nodes[0]).toBe(CORNER_NW);
    expect(path.nodes[path.nodes.length - 1]).toBe(CORNER_SE);
  });

  it('honours the area penalty callback when choosing a route', () => {
    // Columns 2..4 are 'East'. Going straight down column 2 from (0,2) to (4,2)
    // enters four East nodes; dropping one column west and coming back enters only
    // the goal. The surcharge has to be big enough to buy that detour.
    const penalty = (area: string): number => (area === 'East' ? 5000 : 0);
    const graph1 = new NavGraph(map, { areaPenalty: penalty, heuristicWeight: 1 });
    const path = graph1.findPath(gridId(0, 2), gridId(4, 2), 'T');
    expect(path.empty).toBe(false);
    expect(path.nodes).not.toContain(gridId(1, 2));
    expect(path.nodes).not.toContain(gridId(3, 2));
    expect(path.nodes[path.nodes.length - 1]).toBe(gridId(4, 2));
    const reference = referenceShortestPath(map.nav, gridId(0, 2), gridId(4, 2), 0, penalty);
    expectClose(path.cost, reference.cost, 1e-6);
    // Without the surcharge the direct column is the shortest path, which is what
    // makes the avoidance above a real effect of the callback.
    const free = new NavGraph(map, { heuristicWeight: 1 }).findPath(gridId(0, 2), gridId(4, 2), 'T');
    expectClose(free.length, SPACING * 4, 1e-6);
    expect(path.length).toBeGreaterThan(free.length);
    // The penalty only ever raises the price of an edge; a penalised graph can
    // never find a cheaper route than the unpenalised one.
    expect(path.cost).toBeGreaterThan(free.cost);
  });

  it('returns an empty path for an unreachable node, without throwing', () => {
    const path = graph.findPath(CORNER_NW, ISLAND_ID, 'T');
    expect(path.empty).toBe(true);
    expect(path.nodes).toEqual([]);
    expect(path.points).toEqual([]);
    expect(path.length).toBe(0);
    expect(path.chokes).toEqual([]);
  });

  it('returns an empty path for unknown node ids', () => {
    for (const [a, b] of [[-1, 0], [0, -1], [999, 0], [0, 999], [999, 999]] as const) {
      const path = graph.findPath(a, b, 'T');
      expect(path.empty).toBe(true);
      expect(path.nodes).toEqual([]);
      expect(path.points).toEqual([]);
    }
  });

  it('returns one waypoint and zero length when start === goal', () => {
    const path = graph.findPath(CENTRE, CENTRE, 'T');
    expect(path.empty).toBe(false);
    expect(path.points).toHaveLength(1);
    expect(path.points[0]).toEqual(map.nav[CENTRE].pos);
    expect(path.length).toBe(0);
    expect(path.chokes).toEqual([CENTRE]);
  });

  it('is deterministic across repeated queries', () => {
    const first = graph.findPath(CORNER_NW, CENTRE, 'T').nodes.slice();
    for (let i = 0; i < 50; i++) {
      expect(graph.findPath(CORNER_NW, CENTRE, 'T').nodes).toEqual(first);
    }
    // A penalty graph has a much larger set of near-ties to break deterministically.
    const penalised = new NavGraph(map, { chokePenalty: 300, areaPenalty: () => 40 });
    const other = penalised.findPath(CORNER_NW, CORNER_SE, 'CT').nodes.slice();
    for (let i = 0; i < 50; i++) {
      expect(penalised.findPath(CORNER_NW, CORNER_SE, 'CT').nodes).toEqual(other);
    }
  });

  it('enforces the expansion cap instead of running away', () => {
    const capped = new NavGraph(map, { maxExpansions: 1 });
    const path = capped.findPath(CORNER_NW, CORNER_SE, 'T');
    // Two corner nodes are four hops apart, so a cap of 1 expansion cannot reach it.
    expect(path.empty).toBe(true);
    expect(path.nodes).toEqual([]);
  });

  it('finds a path between world positions and snaps the endpoints', () => {
    const path = graphWithWorld.findPathBetween({ x: 256, y: 0, z: 256 }, { x: 1280, y: 0, z: 1280 }, 'T');
    expect(path.empty).toBe(false);
    expect(path.nodes[0]).toBe(CORNER_NW);
    expect(path.nodes[path.nodes.length - 1]).toBe(CORNER_SE);
    expect(path.length).toBeGreaterThan(0);
  });

  it('returns an empty path when a position cannot be snapped to the graph', () => {
    const path = graph.findPathBetween({ x: 5000, y: 0, z: 5000 }, { x: 256, y: 0, z: 256 }, 'T');
    expect(path.empty).toBe(true);
    expect(path.points).toEqual([]);
  });
});

describe('NavGraph — nearestNode', () => {
  it('returns the exact node for an on-node position', () => {
    for (let id = 0; id < GRID * GRID; id++) {
      expect(graph.nearestNode(map.nav[id].pos)).toBe(id);
    }
  });

  it('returns the nearest node, not merely the first in the cell', () => {
    const near = { x: map.nav[CENTRE].pos.x + 40, y: 0, z: map.nav[CENTRE].pos.z + 40 };
    expect(graph.nearestNode(near)).toBe(CENTRE);
  });

  it('returns -1 when the nearest node is beyond maxDistance', () => {
    const far = { x: 5000, y: 0, z: 5000 };
    expect(graph.nearestNode(far)).toBe(-1);
    expect(graph.nearestNode(far, 64)).toBe(-1);
    // 600 units east of the centre choke the closest graph node is (2,4) at
    // (1280, 768) — 88 units away, so the default 512-unit probe finds it.
    expect(graph.nearestNode({ x: map.nav[CENTRE].pos.x + 600, y: 0, z: map.nav[CENTRE].pos.z })).toBe(gridId(2, 4));
    // Far enough from every node (512+ units) that the default probe must miss.
    expect(graph.nearestNode({ x: 256, y: 0, z: -1024 })).toBe(-1);
    expect(graph.nearestNode({ x: 12000, y: 0, z: 12000 })).toBe(-1);
  });

  it('works near a map corner and outside the bounds without throwing', () => {
    expect(graph.nearestNode({ x: 256, y: 0, z: 256 })).toBe(CORNER_NW);
    expect(graph.nearestNode({ x: 0, y: 0, z: 0 })).toBe(CORNER_NW);
    expect(graph.nearestNode({ x: -100000, y: 0, z: -100000 })).toBe(-1);
    expect(graph.nearestNode({ x: 100000, y: 0, z: 100000 })).toBe(-1);
    expect(graph.nearestNode({ x: Number.NaN, y: 0, z: 0 })).toBe(-1);
  });

  it('rejects a node buried in solid geometry once a world is attached', () => {
    const buried: NavNode = navNode(0, 768, 0, 640, 'West');
    const buriedMap: MapData = { ...map, nav: [buried] };
    const plain = new NavGraph(buriedMap);
    expect(plain.nearestNode({ x: 768, y: 0, z: 640 })).toBe(0);
    const aware = new NavGraph(buriedMap);
    aware.attachWorld(world);
    expect(aware.nearestNode({ x: 768, y: 0, z: 640 })).toBe(-1);
  });

  it('handles an empty graph', () => {
    const empty = new NavGraph({ ...map, nav: [] });
    expect(empty.nearestNode({ x: 256, y: 0, z: 256 })).toBe(-1);
    expect(empty.findPath(0, 1, 'T').empty).toBe(true);
    expect(empty.isFullyConnected()).toBe(true);
  });
});

describe('smoothPath', () => {
  it('reduces the point count on an unobstructed straight corridor', () => {
    // The corridor runs along z = 256, clear of the wall (which spans z 512..768).
    const corridor: Vec3[] = [];
    for (let x = 256; x <= 10240; x += 256) corridor.push({ x, y: 0, z: 256 });
    const smoothed = smoothPath(corridor, world, 8);
    expect(smoothed.length).toBeLessThan(corridor.length);
    expect(smoothed[0]).toEqual(corridor[0]);
    expect(smoothed[smoothed.length - 1]).toEqual(corridor[corridor.length - 1]);
    for (let i = 1; i < smoothed.length; i++) {
      expect(world.isVisible(smoothed[i - 1], smoothed[i])).toBe(true);
    }
  });

  it('never returns fewer than two points for a multi-node path', () => {
    const straight = [v3(256, 0, 256), v3(512, 0, 256), v3(768, 0, 256)];
    expect(smoothPath(straight, world).length).toBeGreaterThanOrEqual(2);
    const single = [v3(256, 0, 256)];
    expect(smoothPath(single, world)).toEqual(single);
    expect(smoothPath([], world)).toEqual([]);
  });

  it('does not invent a shortcut through the synthetic wall', () => {
    // The wall spans x 752..784, z 512..1024. Both of these points sit on the line
    // z = 700 that the wall blocks, so the hop between them is genuinely opaque.
    const west: Vec3 = v3(500, 0, 700);
    const east: Vec3 = v3(900, 0, 700);
    expect(world.isVisible(west, east)).toBe(false);

    // A route that goes up and over the north end of the wall.
    const raw: Vec3[] = [v3(500, 0, 300), west, v3(500, 0, 900), east];
    const smoothed = smoothPath(raw, world);
    expect(smoothed[0]).toEqual(raw[0]);
    expect(smoothed[smoothed.length - 1]).toEqual(raw[raw.length - 1]);
    // Smoothing may only merge hops the world agrees are visible; a blocked hop
    // that is actually part of the raw chain must survive untouched. Compare by
    // value: smoothPath emits copies, so identity comparison would never match.
    const same = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
    const blocked = (a: Vec3, b: Vec3): boolean => {
      for (let i = 1; i < raw.length; i++) {
        if (same(raw[i - 1], a) && same(raw[i], b)) return true;
      }
      return false;
    };
    let sawBlockedHop = false;
    for (let i = 1; i < smoothed.length; i++) {
      const a = smoothed[i - 1];
      const b = smoothed[i];
      const visible = world.isVisible(a, b);
      if (!visible) sawBlockedHop = true;
      expect(visible || blocked(a, b)).toBe(true);
    }
    // The wall is unavoidable at the end of this chain, so the blocked hop must
    // still be there rather than being smoothed away.
    expect(sawBlockedHop).toBe(true);
  });

  it('drops intermediate points on a findPath result when a world is attached', () => {
    // Row 0 runs along z = 256, well clear of the wall, so every hop merges and
    // the five collinear waypoints collapse to the two ends.
    const raw = graph.findPath(CORNER_NW, gridId(0, 4), 'T');
    const smoothed = graphWithWorld.findPath(CORNER_NW, gridId(0, 4), 'T');
    expect(smoothed.nodes).toEqual(raw.nodes);
    expect(smoothed.points[0]).toEqual(raw.points[0]);
    expect(smoothed.points[smoothed.points.length - 1]).toEqual(raw.points[raw.points.length - 1]);
    expect(smoothed.points.length).toBeLessThan(raw.points.length);
    for (let i = 1; i < smoothed.points.length; i++) {
      expect(world.isVisible(smoothed.points[i - 1], smoothed.points[i])).toBe(true);
    }
  });
});

describe('followPath', () => {
  const from = map.nav[CORNER_NW].pos;
  const to = map.nav[gridId(0, 4)].pos;

  it('rides out an exhausted path without throwing', () => {
    const path = graph.findPath(CORNER_NW, gridId(0, 4), 'T');
    const follower = createFollower(path);
    const targets: Vec3[] = [];
    let pos: Vec3 = { ...from };
    for (let guard = 0; guard < 100; guard++) {
      const target = followPath(follower, pos, world, 1, 1);
      if (target === null) break;
      targets.push(target);
      pos = { ...target };
    }
    // Waypoint 0 is the start itself and is popped immediately, so the first
    // steering target is the second waypoint and the last one is the goal.
    expect(targets.length).toBe(path.points.length - 1);
    expect(targets[0]).toEqual(path.points[1]);
    expect(targets[targets.length - 1]).toEqual(to);
    expect(followPath(follower, pos, world, 1, 1)).toBeNull();
    expect(follower.index).toBeGreaterThanOrEqual(follower.path.points.length);
  });

  it('skips a visible waypoint using lookahead', () => {
    const path = graph.findPath(CORNER_NW, gridId(0, 4), 'T');
    // Standing between waypoint 0 and 1, on the row the whole path follows.
    const pos: Vec3 = { x: 450, y: 0, z: 256 };
    const near = followPath(createFollower(path), pos, world, 48, 1)!;
    const far = followPath(createFollower(path), pos, world, 48, 3)!;
    expect(near).toEqual(path.points[0]);
    expect(far).toEqual(path.points[2]); // full lookahead, nothing blocks the row

    // Blocked lookahead falls back to the immediate waypoint: the wall (x ~768,
    // z 512..1024) hides the farther waypoint from here.
    const wallA = v3(500, 0, 700);
    const wallB = v3(900, 0, 700);
    expect(world.isVisible(wallA, wallB)).toBe(false);
    const wallPath = { nodes: [0, 1], points: [wallB, { x: 900, y: 0, z: 1100 }], length: 0, chokes: [], cost: 0, empty: false };
    expect(followPath(createFollower(wallPath), wallA, world, 1, 3)).toEqual(wallB);
  });

  it('returns null for an exhausted follower without throwing', () => {
    const follower = createFollower(graph.findPath(CORNER_NW, gridId(0, 1), 'T'));
    follower.index = follower.path.points.length + 5;
    expect(followPath(follower, from, world)).toBeNull();
    expect(followPath(createFollower(graph.findPath(CORNER_NW, ISLAND_ID, 'T')), from, world)).toBeNull();
  });

  it('pops waypoints that are already within the arrive radius', () => {
    // Straight run east: nodes (256,256) -> (512,256) -> (768,256).
    const path = graph.findPath(CORNER_NW, gridId(0, 2), 'T');
    expect(path.points).toEqual([map.nav[gridId(0, 0)].pos, map.nav[gridId(0, 1)].pos, map.nav[gridId(0, 2)].pos]);

    // Start part-way along: waypoint 0 is inside the radius, waypoint 1 is not.
    const follower = createFollower(path);
    const nearStart: Vec3 = { x: 256, y: 0, z: 300 };
    expect(followPath(follower, nearStart, world, 48, 1)).toEqual(map.nav[gridId(0, 1)].pos);
    expect(follower.index).toBe(1);

    // Now sit on waypoint 1: it pops, waypoint 2 becomes the target.
    expect(followPath(follower, { x: 512, y: 0, z: 256 }, world, 48, 1)).toEqual(map.nav[gridId(0, 2)].pos);
    expect(follower.index).toBe(2);

    // The final waypoint is popped too, then the path is done.
    expect(followPath(follower, { x: 768, y: 0, z: 256 }, world, 48, 1)).toBeNull();
  });
});

describe('nudgeIntoFreeSpace', () => {
  it('leaves a free point untouched', () => {
    const free: Vec3 = { x: 300, y: 0, z: 300 };
    expect(world.isSolidPoint(free)).toBe(false);
    const nudged = nudgeIntoFreeSpace(free, world);
    expectClose(nudged.x, free.x, 1e-6);
    expectClose(nudged.y, free.y, 1e-6);
    expectClose(nudged.z, free.z, 1e-6);
  });

  it('moves a point out of the wall and lands somewhere free', () => {
    const inside: Vec3 = { x: 768, y: 0, z: 640 };
    expect(world.isSolidPoint(inside)).toBe(true);
    const nudged = nudgeIntoFreeSpace(inside, world, 16);
    expect(world.isSolidPoint(nudged)).toBe(false);
    expect(Math.hypot(nudged.x - inside.x, nudged.z - inside.z)).toBeGreaterThan(0);
    expect(Number.isFinite(nudged.x) && Number.isFinite(nudged.y) && Number.isFinite(nudged.z)).toBe(true);
    expect(nudged.y).toBe(inside.y); // stays grounded
  });

  it('returns the original point when the whole neighbourhood is solid', () => {
    const slab = new World({ ...map, brushes: [brush(0, 0, 0, 0, 4000, 256, 4000)] });
    const deep: Vec3 = { x: 123, y: 0, z: 456 };
    const nudged = nudgeIntoFreeSpace(deep, slab, 16);
    expect(nudged).toEqual(deep);
  });
});

describe('NavGraph — graph queries', () => {
  it('lists site nodes', () => {
    const a = graph.siteNodes('A');
    const b = graph.siteNodes('B');
    expect(a).toHaveLength(10);
    expect(b).toHaveLength(15);
    expect(a).toContain(CORNER_NW);
    expect(b).toContain(CORNER_SE);
    expect(a).not.toContain(CORNER_SE);
  });

  it('lists choke nodes', () => {
    expect(graph.chokeNodes()).toEqual([CHOKE]);
  });

  it('finds nodes in an area, case-insensitively', () => {
    expect(graph.nodesInArea('West')).toHaveLength(10);
    expect(graph.nodesInArea('west')).toEqual(graph.nodesInArea('West'));
    expect(graph.nodesInArea('nope')).toEqual([]);
  });

  it('reaches the whole grid but not the island', () => {
    const reachable = graph.reachableFrom(CORNER_NW);
    expect(reachable).toHaveLength(GRID * GRID); // 25 grid nodes
    expect(reachable).not.toContain(ISLAND_ID);
    expect(graph.reachableFrom(ISLAND_ID)).toEqual([ISLAND_ID]);
    expect(graph.reachableFrom(-1)).toEqual([]);
    expect(graph.reachableFrom(9999)).toEqual([]);
  });

  it('detects connectivity and reports the cut link', () => {
    expect(graph.isFullyConnected()).toBe(false); // the island is deliberate
    const islandless = new NavGraph({ ...map, nav: map.nav.slice(0, GRID * GRID) });
    expect(islandless.isFullyConnected()).toBe(true);

    // Cut one link of the grid: the graph stays whole, the property still holds.
    // Use the island-free slice so the deliberate island does not mask the result.
    const cutNav = map.nav.slice(0, GRID * GRID).map((n) => ({ ...n, links: n.links.slice() }));
    cutNav[gridId(0, 0)].links = cutNav[gridId(0, 0)].links.filter((l) => l !== gridId(0, 1));
    cutNav[gridId(0, 1)].links = cutNav[gridId(0, 1)].links.filter((l) => l !== gridId(0, 0));
    expect(new NavGraph({ ...map, nav: cutNav }).isFullyConnected()).toBe(true);

    // ...but severing a whole column does disconnect it. Every crossing link must
    // go — including the diagonals, which also skip across the column boundary.
    const splitNav = map.nav.map((n) => ({ ...n, links: n.links.slice() }));
    const westOfCut = new Set<number>();
    const eastOfCut = new Set<number>();
    for (let row = 0; row < GRID; row++) {
      westOfCut.add(gridId(row, 1));
      eastOfCut.add(gridId(row, 2));
    }
    for (const left of westOfCut) {
      splitNav[left].links = splitNav[left].links.filter((l) => !eastOfCut.has(l));
    }
    for (const right of eastOfCut) {
      splitNav[right].links = splitNav[right].links.filter((l) => !westOfCut.has(l));
    }
    expect(new NavGraph({ ...map, nav: splitNav }).isFullyConnected()).toBe(false);
  });

  it('summarises areas with counts and sites, in a stable order', () => {
    const summary = graph.areaSummary();
    expect(summary.map((s) => s.area)).toEqual(['East', 'West', 'Yard']);
    expect(summary[0]).toEqual({ area: 'East', count: 15, sites: ['B'] });
    expect(summary[1]).toEqual({ area: 'West', count: 10, sites: ['A'] });
    expect(summary[2]).toEqual({ area: 'Yard', count: 1, sites: [] });
    const again = graph.areaSummary();
    expect(again).toEqual(summary);
  });
});

describe('validateGraph', () => {
  /** The hand-built map has one wall brush only, so it should validate clean. */
  it('reports nothing for a clean graph', () => {
    // The island is isolated by design in `map`, so the clean check needs it removed.
    const clean = new NavGraph({ ...map, nav: map.nav.slice(0, GRID * GRID) });
    expect(clean.validateGraph()).toEqual([]);
  });

  it('reports an isolated node', () => {
    const problems = graph.validateGraph();
    expect(problems.some((p) => p.includes('isolated') && p.includes(String(ISLAND_ID)))).toBe(true);
  });

  it('reports a dangling link', () => {
    const nav = map.nav.map((n) => ({ ...n, links: n.links.slice() }));
    nav[0].links.push(999);
    const problems = new NavGraph({ ...map, nav }).validateGraph();
    expect(problems.some((p) => p.includes(`node 0 links to missing node 999`))).toBe(true);
  });

  it('reports a non-bidirectional link', () => {
    const nav = map.nav.map((n) => ({ ...n, links: n.links.slice() }));
    nav[gridId(0, 1)].links = nav[gridId(0, 1)].links.filter((l) => l !== gridId(0, 0));
    const problems = new NavGraph({ ...map, nav }).validateGraph();
    expect(
      problems.some((p) => p.includes(`link ${gridId(0, 0)} -> ${gridId(0, 1)} is not bidirectional`)),
    ).toBe(true);
  });

  it('reports a duplicate node id', () => {
    const nav = map.nav.map((n) => ({ ...n, links: n.links.slice() }));
    nav[gridId(1, 1)].id = nav[gridId(1, 0)].id;
    const problems = new NavGraph({ ...map, nav }).validateGraph();
    expect(problems.some((p) => p.includes(`duplicate node id ${nav[gridId(1, 0)].id}`))).toBe(true);
  });

  it('reports a node outside the map bounds', () => {
    const nav = map.nav.map((n) => ({ ...n, links: n.links.slice() }));
    nav[gridId(2, 2)] = { ...nav[gridId(2, 2)], pos: { x: 99999, y: 0, z: 0 } };
    const problems = new NavGraph({ ...map, nav }).validateGraph();
    const id = nav[gridId(2, 2)].id;
    const message = problems.find((p) => p.includes(`node ${id} at (99999,0,0) is outside map bounds`));
    expect(message).toBeTruthy();
  });

  it('reports a zero-length edge', () => {
    const nav = map.nav.map((n) => ({ ...n, links: n.links.slice() }));
    nav[gridId(1, 1)] = { ...nav[gridId(1, 1)], pos: { ...nav[gridId(1, 0)].pos } };
    const problems = new NavGraph({ ...map, nav }).validateGraph();
    expect(
      problems.some(
        (p) => p.includes(`${nav[gridId(1, 0)].id} -> ${nav[gridId(1, 1)].id} is a zero-length edge`),
      ),
    ).toBe(true);
  });
});

describe('performance', () => {
  it('runs 2000 whole-grid queries in well under two seconds', () => {
    // A full corner-to-corner search on the cheap (start === goal) graph is the
    // absolute worst case for the epoch arrays: if `findPath` cleared its scratch
    // per call this loop would be several times slower.
    const start = performance.now();
    let sink = 0;
    for (let i = 0; i < 2000; i++) {
      const path = graph.findPath(CORNER_NW, CORNER_SE, 'T');
      sink += path.nodes.length;
    }
    const elapsed = performance.now() - start;
    expect(sink).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2000);
  });
});
