// =============================================================================
// ai/navigation.ts — bot navigation graph, A* pathfinding and steering helpers.
//
// Bots need three things from navigation: "where am I on the graph", "how do I
// get to X", and "what do I walk at right now". This module owns all three and
// nothing else — it is pure data with no DOM, no Three.js and no randomness, so
// it can be unit-tested and run inside the simulation tick.
//
// The graph is the map's `NavNode` list: nodes are walkable points, `links` are
// bidirectional edges, and `area` / `choke` / `site` carry the tactical meaning
// the bot behaviours need. Everything here is deterministic: the same inputs
// always produce the same path, which keeps replays and tests stable.
// =============================================================================

import { clamp, distance, distanceSq, v3 } from '../core/math';
import type { MapData, NavNode, Team, Vec3 } from '../core/types';
import type { World } from '../world/world';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** A resolved path through the navigation graph. */
export interface NavPath {
  /** Node ids from start to goal, inclusive, NOT including the start node when the start was snapped. */
  nodes: number[];
  /** Smoothed waypoints in world space, ready to be steered to directly. */
  points: Vec3[];
  /** Total world-space length of `points`, in units. */
  length: number;
  /** Node ids the path passes through that carry `choke === true`. */
  chokes: number[];
  /** Summed cost (see NavigationOptions.costFor). */
  cost: number;
  /** True when no path exists (empty nodes/points). */
  empty: boolean;
}

/** Tuning for the graph's A* search. All fields optional. */
export interface NavigationOptions {
  /** Extra cost multiplier for nodes with `choke === true` (bots prefer to avoid chokes unless needed). */
  chokePenalty?: number;
  /** Extra cost multiplier applied per node for the given area name (danger avoidance). */
  areaPenalty?: (area: string, team: Team) => number;
  /** Heuristic weight; 1 = admissible A*, >1 = faster/greedier. Default 1.15. */
  heuristicWeight?: number;
  /** Max node expansion before giving up (safety valve). Default 6000. */
  maxExpansions?: number;
}

/** A cursor walking a `NavPath`, consumed by `followPath`. */
export interface PathFollower {
  /** Current waypoint index. */
  index: number;
  path: NavPath;
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Spatial-hash cell size for `nearestNode`; ~256 units keeps a cell to a handful of nodes. */
const CELL_SIZE = 256;
/** Default probe radius for `nearestNode` when the caller does not care. */
const DEFAULT_MAX_NODE_DISTANCE = 512;
/** Default pop radius for `followPath`. Two player radii: reachable without precise aiming. */
const DEFAULT_ARRIVE_RADIUS = 48;
/** Default waypoint lookahead for `followPath`; 3 kills most of the node-to-node stair-stepping. */
const DEFAULT_LOOKAHEAD = 3;
/** Default sampling stride for `smoothPath`; caps smoothing at O(points * step). */
const DEFAULT_SMOOTH_STEP = 32;
/** Player half-width used by `nudgeIntoFreeSpace` (re-exported PLAYER.radius value). */
const NUDGE_RADIUS = 16;
/**
 * How far above a node the solid-geometry probe is taken. Nav nodes rest on brush
 * tops and `isSolidPoint` uses a +/-0.5 box, so the probe must clear 0.5 units at
 * minimum; 2 keeps a full unit of slack on top of that.
 */
const SOLID_PROBE_LIFT = 2;

/**
 * How far a blocked start/goal node may be re-snapped to find a standable one.
 * Generous on purpose: the nearest walkable node next to a buried sample is
 * usually one grid cell (192 units) away, and failing to snap means the caller
 * falls back to beelining at a point inside a wall.
 */
const BLOCKED_SNAP_DISTANCE = 600;

// ---------------------------------------------------------------------------
// Internal: binary min-heap
// ---------------------------------------------------------------------------

/**
 * Binary min-heap over (key, node id) pairs with preallocated backing arrays.
 *
 * Written by hand rather than sorting the open list: A* pushes thousands of
 * entries per query and `Array.prototype.sort` on every pop would dominate the
 * frame. Keys are stored as a parallel `Float64Array` so a push is two stores
 * and a sift-up, and the arrays are grown geometrically so steady-state queries
 * never allocate.
 */
class MinHeap {
  private keys: Float64Array;
  private ids: Int32Array;
  private count = 0;

  constructor(capacity: number) {
    const cap = Math.max(16, capacity | 0);
    this.keys = new Float64Array(cap);
    this.ids = new Int32Array(cap);
  }

  /** Drop all entries without reallocating. */
  clear(): void {
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }

  private grow(): void {
    const cap = this.keys.length * 2;
    const keys = new Float64Array(cap);
    const ids = new Int32Array(cap);
    keys.set(this.keys);
    ids.set(this.ids);
    this.keys = keys;
    this.ids = ids;
  }

  /** Insert `id` with priority `key` (smaller key = popped first). */
  push(id: number, key: number): void {
    if (this.count === this.keys.length) this.grow();
    let i = this.count++;
    this.keys[i] = key;
    this.ids[i] = id;
    // Sift up, keeping the tie-break on node id so equal-cost nodes pop in a
    // stable order (deterministic paths).
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!MinHeap.before(this.keys[i], this.ids[i], this.keys[parent], this.ids[parent])) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  /** Remove and return the smallest-keyed node id, or -1 when empty. */
  pop(): number {
    if (this.count === 0) return -1;
    const topId = this.ids[0];
    this.count--;
    if (this.count > 0) {
      this.keys[0] = this.keys[this.count];
      this.ids[0] = this.ids[this.count];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= this.count) break;
        const r = l + 1;
        let best = l;
        if (r < this.count && MinHeap.before(this.keys[r], this.ids[r], this.keys[l], this.ids[l])) best = r;
        if (!MinHeap.before(this.keys[best], this.ids[best], this.keys[i], this.ids[i])) break;
        this.swap(i, best);
        i = best;
      }
    }
    return topId;
  }

  /** `true` when (ka, ia) orders before (kb, ib): lower key wins, ties break on lower id. */
  private static before(ka: number, ia: number, kb: number, ib: number): boolean {
    return ka < kb || (ka === kb && ia < ib);
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
    const id = this.ids[a];
    this.ids[a] = this.ids[b];
    this.ids[b] = id;
  }
}

// ---------------------------------------------------------------------------
// Internal: spatial hash
// ---------------------------------------------------------------------------

/**
 * Uniform grid over the map's XZ bounds, mapping cell -> node ids.
 *
 * `nearestNode` is called several times per second per bot and a 200-node
 * linear scan per call is wasted work; the grid narrows it to one or two
 * neighbouring cells in the common case. Cell size is derived from the map
 * bounds so a small test map and the real map both end up with a sane grid.
 */
class NodeGrid {
  readonly cellSize: number;
  readonly minX: number;
  readonly minZ: number;
  readonly dimX: number;
  readonly dimZ: number;
  private readonly buckets: number[][] = [];

  constructor(bounds: { min: Vec3; max: Vec3 }) {
    const spanX = Math.abs(bounds.max.x - bounds.min.x);
    const spanZ = Math.abs(bounds.max.z - bounds.min.z);
    const span = Math.max(spanX, spanZ);
    // ~256-unit cells, never finer than 128 (tiny maps) nor coarser than 512.
    this.cellSize = span > 0 ? clamp(span / 32, 128, 512) : CELL_SIZE;
    // One cell of padding on every side: no length-XZ query can land outside.
    this.minX = bounds.min.x - this.cellSize;
    this.minZ = bounds.min.z - this.cellSize;
    this.dimX = Math.max(1, Math.ceil(spanX / this.cellSize) + 3);
    this.dimZ = Math.max(1, Math.ceil(spanZ / this.cellSize) + 3);
    this.buckets.length = this.dimX * this.dimZ;
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
  }

  private cellIndex(x: number, z: number): number {
    let cx = Math.floor((x - this.minX) / this.cellSize);
    let cz = Math.floor((z - this.minZ) / this.cellSize);
    // clamp() also folds NaN (degenerate node positions) onto the grid edge
    // instead of indexing the bucket array with NaN.
    cx = clamp(cx, 0, this.dimX - 1);
    cz = clamp(cz, 0, this.dimZ - 1);
    return cx * this.dimZ + cz;
  }

  insert(nodeId: number, pos: Vec3): void {
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return;
    this.buckets[this.cellIndex(pos.x, pos.z)].push(nodeId);
  }

  /** Node ids in one cell; empty array when the cell is off-grid or vacant. */
  at(cx: number, cz: number): readonly number[] {
    if (cx < 0 || cx >= this.dimX || cz < 0 || cz >= this.dimZ) return EMPTY_IDS;
    return this.buckets[cx * this.dimZ + cz];
  }

  /** Cell coordinates of a world position (unclamped; may be negative). */
  cellOf(pos: Vec3): { cx: number; cz: number } {
    return {
      cx: Math.floor((pos.x - this.minX) / this.cellSize),
      cz: Math.floor((pos.z - this.minZ) / this.cellSize),
    };
  }
}

/** Shared empty bucket, so `NodeGrid.at` never allocates for a vacant cell. */
const EMPTY_IDS: readonly number[] = [];

/** Scratch point for `nearestNode`'s lifted solid probe; the sim is single-threaded. */
const probePoint: Vec3 = { x: 0, y: 0, z: 0 };

// ---------------------------------------------------------------------------
// NavGraph
// ---------------------------------------------------------------------------

/**
 * A* pathfinder over a map's nav graph.
 *
 * The scratch state (`gScore`, `fScore`, `cameFrom`, `closed`, the open heap and
 * the BFS queue) is allocated once in the constructor, because node counts are
 * known up front. Per-node validity is tracked with a `visitedEpoch` stamp
 * instead of clearing the arrays on every query — the standard trick that makes
 * a 2000-query benchmark finish in milliseconds rather than seconds.
 */
export class NavGraph {
  readonly map: MapData;
  readonly nodes: NavNode[];

  private readonly chokePenalty: number;
  private readonly heuristicWeight: number;
  private readonly maxExpansions: number;
  private readonly areaPenalty: ((area: string, team: Team) => number) | undefined;

  private readonly grid: NodeGrid;

  // --- A* scratch (sized to the node count) --------------------------------
  private readonly gScore: Float64Array;
  private readonly fScore: Float64Array;
  private readonly cameFrom: Int32Array;
  private readonly closed: Uint8Array;
  /** Epoch stamp per node: scratch arrays are valid only where epoch[i] === visitedEpoch. */
  private readonly visitedEpoch: Int32Array;
  /** Path reconstruction buffer, reused by every `findPath` call. */
  private readonly pathScratch: Int32Array;
  private readonly open: MinHeap;
  private epoch = 0;

  // --- BFS scratch ---------------------------------------------------------
  private readonly bfsQueue: Int32Array;
  private readonly bfsSeen: Int32Array;
  private bfsEpoch = 0;

  // --- area penalty memo (per query) --------------------------------------
  private readonly areaPenaltyCache: Float64Array;
  private readonly areaPenaltyStamp: Int32Array;

  /** Optional world used to reject nodes buried inside solid geometry. */
  private world: World | null = null;

  /**
   * 1 for every node whose body slot is filled by map geometry, 0 otherwise.
   *
   * Nav data is a sampled grid, so it inevitably lands some samples inside walls
   * (this map buries two nodes in the CT spawn wall). Those nodes cannot be walked
   * to: a path that hops through one makes the bot grind against the wall until the
   * round ends. Sampling is done once per `attachWorld` — the map is static — and
   * every query skips them.
   */
  private blocked: Uint8Array | null = null;

  constructor(map: MapData, opts?: NavigationOptions) {
    this.map = map;
    this.nodes = map.nav;
    this.chokePenalty = opts?.chokePenalty ?? 0;
    this.heuristicWeight = opts?.heuristicWeight ?? 1.15;
    this.maxExpansions = opts?.maxExpansions ?? 6000;
    this.areaPenalty = opts?.areaPenalty;

    const n = this.nodes.length;
    this.grid = new NodeGrid(map.bounds);
    for (let i = 0; i < n; i++) {
      const node = this.nodes[i];
      if (!node) continue;
      this.grid.insert(i, node.pos);
    }

    this.gScore = new Float64Array(n);
    this.fScore = new Float64Array(n);
    this.cameFrom = new Int32Array(n);
    this.closed = new Uint8Array(n);
    this.visitedEpoch = new Int32Array(n);
    this.pathScratch = new Int32Array(n + 1);
    this.open = new MinHeap(Math.max(16, n * 2));

    this.bfsQueue = new Int32Array(Math.max(1, n));
    this.bfsSeen = new Int32Array(n);

    this.areaPenaltyCache = new Float64Array(n);
    this.areaPenaltyStamp = new Int32Array(n);
  }

  /**
   * Attach the collision world so `nearestNode` can reject nodes that sit inside
   * solid geometry. Optional: the constructor signature stays as specified, and
   * when no world is attached the map authoring is trusted (see `validateGraph`).
   */
  attachWorld(world: World): void {
    this.world = world;
    this.sampleBlockedNodes();
  }

  /**
   * Sample every node once against the world and remember which ones are buried.
   * Uses the same lifted probe as `nearestNode`, so it inherits the same fix for
   * nodes standing on a brush surface.
   */
  private sampleBlockedNodes(): void {
    const count = this.nodes.length;
    if (this.blocked === null || this.blocked.length !== count) this.blocked = new Uint8Array(count);
    this.blocked.fill(0);
    const world = this.world;
    if (world === null) return;
    for (let i = 0; i < count; i++) {
      const pos = this.nodes[i].pos;
      probePoint.x = pos.x;
      probePoint.y = pos.y + SOLID_PROBE_LIFT;
      probePoint.z = pos.z;
      if (world.isSolidPoint(probePoint)) this.blocked[i] = 1;
    }
  }

  /** True when map geometry fills the slot a node stands in. */
  isNodeBlocked(id: number): boolean {
    return this.blocked !== null && id >= 0 && id < this.blocked.length && this.blocked[id] === 1;
  }

  /**
   * A blocked node id replaced by the nearest standable node, so a plan naming a
   * buried node as start or goal still produces a usable route. Unusable ids and
   * ids with no replacement nearby are returned unchanged.
   */
  private snapToUnblocked(id: number): number {
    if (!this.isNodeBlocked(id)) return id;
    const alt = this.nearestNode(this.nodes[id].pos, BLOCKED_SNAP_DISTANCE);
    return alt >= 0 ? alt : id;
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  /**
   * Nearest node to a world position, or -1 when the best candidate is farther
   * than `maxDistance` (default 512).
   *
   * Walks the spatial hash outward one ring of cells at a time and stops at the
   * first ring that yields a candidate, so a query in the middle of the map
   * touches one bucket instead of every node.
   */
  nearestNode(pos: Vec3, maxDistance = DEFAULT_MAX_NODE_DISTANCE): number {
    const n = this.nodes.length;
    if (n === 0 || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return -1;

    const { cx, cz } = this.grid.cellOf(pos);
    const maxDistSq = maxDistance * maxDistance;
    const rings = Math.ceil(maxDistance / this.grid.cellSize) + 1;
    let best = -1;
    let bestSq = Infinity;

    for (let r = 0; r <= rings; r++) {
      let hasCandidate = false;
      const x0 = cx - r;
      const x1 = cx + r;
      const z0 = cz - r;
      const z1 = cz + r;
      for (let gx = x0; gx <= x1; gx++) {
        for (let gz = z0; gz <= z1; gz++) {
          // Interior of the ring was visited by a smaller radius.
          if (r > 0 && gx !== x0 && gx !== x1 && gz !== z0 && gz !== z1) continue;
          const bucket = this.grid.at(gx, gz);
          for (let k = 0; k < bucket.length; k++) {
            const id = bucket[k];
            const node = this.nodes[id];
            if (!node) continue;
            // A node buried in a wall is not a place a bot can stand, so it is not
            // a snap target: skipping it lets the lookup fall through to the real
            // walkable node next door instead of reporting -1 for the whole area.
            if (this.blocked !== null && this.blocked[id] === 1) continue;
            const d2 = distanceSq(node.pos, pos);
            if (d2 <= maxDistSq && d2 < bestSq) {
              bestSq = d2;
              best = id;
              hasCandidate = true;
            }
          }
        }
      }
      if (hasCandidate) break;
    }

    if (best >= 0 && this.world !== null) {
      const bestPos = this.nodes[best].pos;
      // Probe a couple of units ABOVE the node, never at its feet. Nav nodes stand
      // on brush surfaces, and `World.isSolidPoint` tests a +/-0.5 box with strict
      // overlap, so a point flush with a brush's top face counts as "inside": asking
      // at the feet rejected 311 of this map's 312 nodes and made every lookup
      // return -1, which silently disabled pathfinding for every bot. Lifting the
      // probe keeps the real check (a node buried in geometry is still solid two
      // units up) without the surface false positive.
      probePoint.x = bestPos.x;
      probePoint.y = bestPos.y + SOLID_PROBE_LIFT;
      probePoint.z = bestPos.z;
      if (this.world.isSolidPoint(probePoint)) {
        // Too deep in geometry to trust; the caller should snap somewhere else.
        return -1;
      }
    }
    return best;

    // Linear-scan fallback kept for clarity: with a correct grid this is never
    // needed, but if the grid is ever rebuilt for a moving agent the equivalent
    // query is a plain minimum over `this.nodes`, which is O(n) and up to ~200
    // nodes on the real map — acceptable for a one-off, wasteful per tick.
  }

  // -------------------------------------------------------------------------
  // A*
  // -------------------------------------------------------------------------

  /**
   * A* between two node ids. Reuses the internal scratch buffers.
   *
   * Returns `empty: true` for unknown/out-of-range ids, for unreachable nodes
   * and when the expansion cap is hit. `start === goal` yields a path with no
   * nodes and a single point at the goal position.
   */
  findPath(startNode: number, goalNode: number, team: Team): NavPath {
    const n = this.nodes.length;
    if (startNode < 0 || startNode >= n || goalNode < 0 || goalNode >= n) {
      return this.emptyPath();
    }
    // Samples buried in geometry cannot be walked to or from; re-snap them first.
    startNode = this.snapToUnblocked(startNode);
    goalNode = this.snapToUnblocked(goalNode);
    if (startNode === goalNode) {
      return this.trivialPath(startNode);
    }

    const epoch = this.nextEpoch();
    const g = this.gScore;
    const f = this.fScore;
    const from = this.cameFrom;
    const closed = this.closed;
    const stamp = this.visitedEpoch;
    const open = this.open;
    const goalPos = this.nodes[goalNode].pos;
    const hw = this.heuristicWeight;

    open.clear();
    g[startNode] = 0;
    f[startNode] = distance(this.nodes[startNode].pos, goalPos) * hw;
    from[startNode] = -1;
    stamp[startNode] = epoch;
    closed[startNode] = 0;
    open.push(startNode, f[startNode]);

    let found = false;
    let expansions = 0;

    while (open.size > 0) {
      const current = open.pop();
      if (current < 0) break;
      if (stamp[current] !== epoch || closed[current] === 1) continue; // stale heap entry
      closed[current] = 1;
      if (current === goalNode) {
        found = true;
        break;
      }
      if (++expansions > this.maxExpansions) break;

      const links = this.nodes[current].links;
      const gCurrent = g[current];
      for (let i = 0; i < links.length; i++) {
        const next = links[i];
        // Malformed map data must never throw: skip dangling links silently.
        if (next < 0 || next >= n || next === current) continue;
        // Never route through a node that is inside geometry: the bot would walk
        // into the wall and stall out there for the rest of the round. The goal is
        // exempt — a buried goal has already been re-snapped when a standable node
        // was near enough, and refusing it here would turn the whole path empty and
        // send the bot beelining into a wall instead.
        if (next !== goalNode && this.blocked !== null && this.blocked[next] === 1) continue;
        if (stamp[next] === epoch && closed[next] === 1) continue;
        const tentative = gCurrent + this.edgeCost(current, next, team);
        if (stamp[next] !== epoch) {
          // First sighting this query: initialise the scratch slot.
          stamp[next] = epoch;
          closed[next] = 0;
          g[next] = tentative;
          from[next] = current;
          f[next] = tentative + distance(this.nodes[next].pos, goalPos) * hw;
          open.push(next, f[next]);
        } else if (tentative < g[next]) {
          g[next] = tentative;
          from[next] = current;
          f[next] = tentative + distance(this.nodes[next].pos, goalPos) * hw;
          open.push(next, f[next]);
        }
      }
    }

    if (!found) return this.emptyPath();

    // Reconstruct: walk `cameFrom` back to the start into the reusable scratch
    // buffer, then reverse into the (freshly allocated) result array.
    let count = 0;
    let cursor = goalNode;
    while (cursor >= 0 && count < n + 1) {
      if (stamp[cursor] !== epoch) return this.emptyPath(); // inconsistent chain: refuse partial garbage
      this.pathScratch[count++] = cursor;
      if (cursor === startNode) break;
      cursor = from[cursor];
    }
    if (count === 0 || this.pathScratch[count - 1] !== startNode) return this.emptyPath();

    const nodes = new Array<number>(count);
    for (let i = 0; i < count; i++) nodes[i] = this.pathScratch[count - 1 - i];
    return this.buildPath(nodes, g[goalNode]);
  }

  /** Convenience: nearest nodes for both positions then `findPath`. */
  findPathBetween(from: Vec3, to: Vec3, team: Team): NavPath {
    const startNode = this.nearestNode(from);
    const goalNode = this.nearestNode(to);
    // A failed snap produces no waypoints at all, which callers treat the same
    // way they treat an unreachable goal.
    if (startNode < 0 || goalNode < 0) return this.emptyPath();
    if (startNode === goalNode) return this.trivialPath(goalNode);
    return this.findPath(startNode, goalNode, team);
  }

  // -------------------------------------------------------------------------
  // Graph queries
  // -------------------------------------------------------------------------

  /** Nodes whose `site` matches, for plant/defend behaviours. */
  siteNodes(site: 'A' | 'B'): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.nodes[i].site === site) out.push(i);
    }
    return out;
  }

  /** Nodes carrying `choke === true`. */
  chokeNodes(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.nodes[i].choke === true) out.push(i);
    }
    return out;
  }

  /** Nodes in an area by name (case-insensitive). */
  nodesInArea(area: string): number[] {
    const needle = area.toLowerCase();
    const out: number[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.nodes[i].area.toLowerCase() === needle) out.push(i);
    }
    return out;
  }

  /**
   * All node ids reachable from `start` (BFS). Iterative with a preallocated
   * queue, so a 200-node map never recurses. Returns `[]` for a bad start.
   */
  reachableFrom(start: number): number[] {
    const n = this.nodes.length;
    if (start < 0 || start >= n) return [];
    const epoch = this.nextBfsEpoch();
    const seen = this.bfsSeen;
    const queue = this.bfsQueue;
    const out: number[] = [];

    let head = 0;
    let tail = 0;
    seen[start] = epoch;
    queue[tail++] = start;
    while (head < tail) {
      const current = queue[head++];
      out.push(current);
      const links = this.nodes[current].links;
      for (let i = 0; i < links.length; i++) {
        const next = links[i];
        if (next < 0 || next >= n) continue; // dangling link: ignore
        if (seen[next] === epoch) continue;
        seen[next] = epoch;
        queue[tail++] = next;
      }
    }
    out.sort((a, b) => a - b);
    return out;
  }

  /** True when every node is reachable from node 0 (map connectivity sanity check). */
  isFullyConnected(): boolean {
    const n = this.nodes.length;
    if (n <= 1) return true;
    return this.reachableFrom(0).length === n;
  }

  /** Areas, in a stable order (alphabetical), with the node count of each. */
  areaSummary(): { area: string; count: number; sites: ('A' | 'B')[] }[] {
    const counts = new Map<string, number>();
    const sites = new Map<string, Set<'A' | 'B'>>();
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const area = node.area;
      counts.set(area, (counts.get(area) ?? 0) + 1);
      if (node.site === 'A' || node.site === 'B') {
        let set = sites.get(area);
        if (!set) {
          set = new Set<'A' | 'B'>();
          sites.set(area, set);
        }
        set.add(node.site);
      }
    }
    const areas = [...counts.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return areas.map((area) => {
      const set = sites.get(area);
      const list: ('A' | 'B')[] = [];
      if (set) {
        if (set.has('A')) list.push('A');
        if (set.has('B')) list.push('B');
      }
      return { area, count: counts.get(area) ?? 0, sites: list };
    });
  }

  /**
   * Human-readable data problems, empty when the graph is clean.
   *
   * Another workstream asserts the real map reports none of these, so the
   * messages are stable and greppable, e.g. `node 37 links to missing node 999`.
   */
  validateGraph(): string[] {
    const out: string[] = [];
    const n = this.nodes.length;
    const bounds = this.map.bounds;

    // 1. Duplicate ids.
    const byId = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const id = this.nodes[i].id;
      const first = byId.get(id);
      if (first === undefined) byId.set(id, i);
      else out.push(`duplicate node id ${id}`);
    }

    // 2. Nodes outside the map bounds.
    for (let i = 0; i < n; i++) {
      const p = this.nodes[i].pos;
      if (
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        !Number.isFinite(p.z) ||
        p.x < bounds.min.x ||
        p.x > bounds.max.x ||
        p.y < bounds.min.y ||
        p.y > bounds.max.y ||
        p.z < bounds.min.z ||
        p.z > bounds.max.z
      ) {
        out.push(`node ${this.nodes[i].id} at (${p.x},${p.y},${p.z}) is outside map bounds`);
      }
    }

    // 3. Dangling links, collected per node so the message names the offender.
    const dangling: boolean[] = new Array<boolean>(n).fill(false);
    for (let i = 0; i < n; i++) {
      const links = this.nodes[i].links;
      const id = this.nodes[i].id;
      for (let k = 0; k < links.length; k++) {
        const target = links[k];
        if (target < 0 || target >= n || !this.nodes[target]) {
          dangling[i] = true;
          out.push(`node ${id} links to missing node ${target}`);
        }
      }
    }

    // 4. Non-bidirectional links (reported once per ordered pair). The scan starts
    // at node index 0 — the first node's own links are as likely to be asymmetric
    // as any other's, and skipping it would hide a one-way edge from node 0.
    for (let link = 0; link < n; link++) {
      const links = this.nodes[link].links;
      for (let k = 0; k < links.length; k++) {
        const a = links[k];
        if (a < 0 || a >= n || a === link) continue;
        const back = this.nodes[a].links;
        let hasBack = false;
        for (let b = 0; b < back.length; b++) {
          if (back[b] === link) {
            hasBack = true;
            break;
          }
        }
        // Name the link in the direction it is authored: owner -> target.
        if (!hasBack) out.push(`link ${this.nodes[link].id} -> ${this.nodes[a].id} is not bidirectional`);
      }
    }

    // 5. Zero-length edges are degenerate: the bot gains a waypoint with no travel.
    for (let i = 0; i < n; i++) {
      const links = this.nodes[i].links;
      for (let k = 0; k < links.length; k++) {
        const target = links[k];
        if (target <= i || target < 0 || target >= n || !this.nodes[target]) continue; // pair once
        if (distance(this.nodes[i].pos, this.nodes[target].pos) < 1e-3) {
          out.push(`node ${this.nodes[i].id} -> ${this.nodes[target].id} is a zero-length edge`);
        }
      }
    }

    // 6. Isolated nodes: no usable link in either direction.
    const hasEdge = new Array<boolean>(n).fill(false);
    for (let i = 0; i < n; i++) {
      const links = this.nodes[i].links;
      for (let k = 0; k < links.length; k++) {
        const target = links[k];
        if (target < 0 || target >= n || target === i) continue;
        hasEdge[i] = true;
        hasEdge[target] = true;
      }
    }
    for (let i = 0; i < n; i++) {
      if (!hasEdge[i]) out.push(`node ${this.nodes[i].id} is isolated`);
    }

    return out;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Cost of stepping from `a` to `b`: world-space edge length plus the tactical
   * surcharges charged for entering `b` (`chokePenalty`, then `areaPenalty`).
   */
  private edgeCost(a: number, b: number, team: Team): number {
    let cost = distance(this.nodes[a].pos, this.nodes[b].pos);
    if (this.chokePenalty !== 0 && this.nodes[b].choke === true) cost += this.chokePenalty;
    if (this.areaPenalty) cost += this.areaPenaltyAt(b, team);
    return cost;
  }

  /**
   * `areaPenalty` is an arbitrary caller callback and can be expensive, so memo
   * it per query with the same epoch trick used for the search scratch.
   */
  private areaPenaltyAt(b: number, team: Team): number {
    if (this.areaPenaltyStamp[b] === this.epoch) return this.areaPenaltyCache[b];
    this.areaPenaltyStamp[b] = this.epoch;
    const value = this.areaPenalty!(this.nodes[b].area, team);
    this.areaPenaltyCache[b] = Number.isFinite(value) ? value : 0;
    return this.areaPenaltyCache[b];
  }

  /** Bump the query epoch, resetting the stamps on the (extremely unlikely) wrap. */
  private nextEpoch(): number {
    this.epoch++;
    if (this.epoch >= 2147483000) {
      this.visitedEpoch.fill(0);
      this.areaPenaltyStamp.fill(0);
      this.epoch = 1;
    }
    return this.epoch;
  }

  private nextBfsEpoch(): number {
    this.bfsEpoch++;
    if (this.bfsEpoch >= 2147483000) {
      this.bfsSeen.fill(0);
      this.bfsEpoch = 1;
    }
    return this.bfsEpoch;
  }

  /** `start === goal` (or a snap that lands on one node): one waypoint, no travel. */
  private trivialPath(node: number): NavPath {
    const pos = { ...this.nodes[node].pos };
    const path: NavPath = {
      nodes: [node],
      points: [pos],
      length: 0,
      chokes: this.nodes[node].choke === true ? [node] : [],
      cost: 0,
      empty: false,
    };
    return path;
  }

  /** Canonical "no path" result. Fresh object so callers can mutate safely. */
  private emptyPath(): NavPath {
    return { nodes: [], points: [], length: 0, chokes: [], cost: 0, empty: true };
  }

  /**
   * Turn a node chain into the public `NavPath`: copies positions, applies
   * any-angle smoothing when a world is attached, then measures the result.
   */
  private buildPath(ids: number[], cost: number): NavPath {
    const count = ids.length;
    const raw = new Array<Vec3>(count);
    for (let i = 0; i < count; i++) raw[i] = { ...this.nodes[ids[i]].pos };

    const chokes: number[] = [];
    for (let i = 0; i < count; i++) {
      if (this.nodes[ids[i]].choke === true) chokes.push(ids[i]);
    }

    let points: Vec3[] = raw;
    if (this.world !== null && count > 2) {
      points = this.smoothNodeChain(ids, raw, this.world);
    }

    return {
      nodes: ids,
      points,
      length: pathLength(points),
      chokes,
      cost,
      empty: false,
    };
  }

  /** Greedy any-angle smoothing over a node chain without materialising line segments. */
  private smoothNodeChain(ids: number[], raw: Vec3[], world: World): Vec3[] {
    const count = ids.length;
    const out: Vec3[] = [];
    const step = DEFAULT_SMOOTH_STEP;
    let anchor = 0;
    out.push(raw[0]);
    while (anchor < count - 1) {
      const max = Math.min(count - 1, anchor + step);
      let best = -1;
      for (let i = max; i > anchor; i--) {
        if (world.isVisible(raw[anchor], raw[i])) {
          best = i;
          break;
        }
      }
      if (best === -1) best = anchor + 1; // blocked: fall back to the adjacent node
      out.push(raw[best]);
      anchor = best;
      if (out.length > count) break; // paranoia: never exceed the input length
    }
    if (out[out.length - 1] !== raw[count - 1]) out.push(raw[count - 1]);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Stealth exports: navigation helpers
// ---------------------------------------------------------------------------

/** Create a follower positioned at the start of `path`. */
export function createFollower(path: NavPath): PathFollower {
  return { index: 0, path };
}

/**
 * Advance a follower toward the next waypoint.
 *
 * Pops every waypoint inside `arriveRadius` (default 48), then skips ahead up to
 * `lookahead` waypoints (default 3) to the farthest one still visible from
 * `pos` — that skip is what stops bots from walking node-to-node like robots on
 * a ruler. Returns the world point to steer at, or null when the path is done.
 */
export function followPath(
  follower: PathFollower,
  pos: Vec3,
  world: World,
  arriveRadius = DEFAULT_ARRIVE_RADIUS,
  lookahead = DEFAULT_LOOKAHEAD,
): Vec3 | null {
  const points = follower.path.points;
  const count = points.length;
  // Exhausted (or empty) paths answer null: `follower.index` can legitimately sit at
  // or past the end after the last waypoint is consumed, and indexing there would
  // throw on `points[index].x`.
  if (count === 0 || follower.index >= count) return null;

  const radiusSq = arriveRadius * arriveRadius;
  while (follower.index < count && distanceSq(points[follower.index], pos) <= radiusSq) {
    follower.index++;
  }
  if (follower.index >= count) return null;

  let target = follower.index;
  if (lookahead > 1) {
    const max = Math.min(count - 1, follower.index + lookahead - 1);
    for (let i = max; i > follower.index; i--) {
      if (world.isVisible(pos, points[i])) {
        target = i;
        break;
      }
    }
  }
  return points[target];
}

/** How far a follower may be re-seated forward when its head goes stale. */
const RESEAT_WINDOW = 8;

/**
 * Re-anchor a follower whose head the actor has walked past.
 *
 * `followPath` can only pop `points[follower.index]`, while the lookahead steers the
 * actor several points ahead of it. A follower therefore goes stale the moment the
 * actor walks on: the head point is never approached again, so it is never popped,
 * the lookahead keeps resolving to the same point, and the bot parks beside it for
 * the rest of the round. Searching forward from the current index (never backwards)
 * puts the head back on the part of the path the actor is actually standing on.
 *
 * The index only moves when a later point is at least twice as close, which is what
 * stops a switchback from re-seating the follower onto a lane it never walked.
 */
export function reseatFollower(follower: PathFollower, pos: Vec3, window = RESEAT_WINDOW): void {
  const points = follower.path.points;
  const count = points.length;
  if (count === 0 || follower.index >= count) return;

  const headSq = distanceSq(points[follower.index], pos);
  const limit = Math.min(count - 1, follower.index + window);
  let best = follower.index;
  let bestSq = headSq;
  for (let i = follower.index + 1; i <= limit; i += 1) {
    const d = distanceSq(points[i], pos);
    if (d < bestSq) {
      bestSq = d;
      best = i;
    }
  }
  if (bestSq < headSq * 0.5) follower.index = best;
}

/** Length of a polyline through world-space points. */
export function pathLength(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distance(points[i - 1], points[i]);
  }
  return total;
}

/**
 * Drop intermediate points that are in line of sight of each other (any-angle
 * smoothing).
 *
 * Greedy: from the current anchor, look forward at most `step` points (default
 * 32) and keep the farthest one the world can see; if none is visible, step one
 * point and retry. Keeping the last point is unconditional, and the result
 * never runs shorter than two points for a multi-point input.
 *
 * `step` bounds the work at O(points * step) instead of O(points^2) — a 200-node
 * map with the default step does ~6400 visibility tests worst case, and far
 * fewer in practice because a successful long jump consumes many indices.
 */
export function smoothPath(points: readonly Vec3[], world: World, step = DEFAULT_SMOOTH_STEP): Vec3[] {
  const count = points.length;
  if (count <= 2) return points.map((p) => ({ ...p }));

  const stride = Math.max(1, Math.floor(step));
  const out: Vec3[] = [{ ...points[0] }];
  let anchor = 0;
  while (anchor < count - 1) {
    const max = Math.min(count - 1, anchor + stride);
    let best = -1;
    for (let i = max; i > anchor; i--) {
      if (world.isVisible(points[anchor], points[i])) {
        best = i;
        break;
      }
    }
    if (best === -1) best = anchor + 1; // fully blocked: keep the adjacent node
    out.push({ ...points[best] });
    anchor = best;
    if (out.length > count) break; // paranoia: never grow the path
  }
  if (out.length < 2) out.push({ ...points[count - 1] });
  return out;
}

/**
 * Push a world position `radius` units off any solid brush it is inside and
 * return a safe point. Searches a square spiral of offsets out to ~5 cells of
 * `radius*2` (160 units at the player radius) and returns the original position
 * unchanged when nothing free is found — never NaN, never an infinite loop.
 *
 * The probe is a player-sized box (XZ) whose floor sits at `pos.y`, so a walkable
 * point is never "rescued" upward onto a crate top, and a grounded point stays
 * grounded. Points above the ground can still be nudged out of a wall's side.
 */
export function nudgeIntoFreeSpace(pos: Vec3, world: World, radius = NUDGE_RADIUS): Vec3 {
  if (!pointInSolidBox(pos, world, radius)) return { ...pos };

  const step = Math.max(1, radius * 2);
  const maxRing = 5;
  for (let ring = 1; ring <= maxRing; ring++) {
    const d = ring * step;
    // Perimeter of the ring, corners included; order is deterministic.
    for (let a = -ring; a <= ring; a++) {
      const b = ring;
      if (tryNudge(pos, d, a, b, world, radius)) return nudgedPoint(pos, d, a, b);
      if (tryNudge(pos, d, a, -b, world, radius)) return nudgedPoint(pos, d, a, -b);
    }
    for (let b = -ring + 1; b <= ring - 1; b++) {
      if (tryNudge(pos, d, ring, b, world, radius)) return nudgedPoint(pos, d, ring, b);
      if (tryNudge(pos, d, -ring, b, world, radius)) return nudgedPoint(pos, d, -ring, b);
    }
  }
  return { ...pos };
}

// ---------------------------------------------------------------------------
// nudgeIntoFreeSpace internals
// ---------------------------------------------------------------------------

/** Candidate test shared by the spiral: does (pos + d*(a,b) on XZ) fit the player box? */
function tryNudge(pos: Vec3, d: number, a: number, b: number, world: World, radius: number): boolean {
  const x = pos.x + a * d;
  const z = pos.z + b * d;
  return !boxOverlapsSolid(world, x, pos.y, z, radius);
}

function nudgedPoint(pos: Vec3, d: number, a: number, b: number): Vec3 {
  return v3(pos.x + a * d, pos.y, pos.z + b * d);
}

/** True when a player-footprint box at (x, y, z) overlaps solid geometry. */
function boxOverlapsSolid(world: World, x: number, y: number, z: number, radius: number): boolean {
  const boxes = world.brushAabbs;
  const brushes = world.brushes;
  for (let i = 0; i < boxes.length; i++) {
    const brush = brushes[i];
    if (!brush || brush.nonSolid) continue;
    const b = boxes[i];
    if (y >= b.max.y || y + 64 <= b.min.y) continue;
    if (x + radius <= b.min.x || x - radius >= b.max.x) continue;
    if (z + radius <= b.min.z || z - radius >= b.max.z) continue;
    return true;
  }
  return false;
}

/** `world.isSolidPoint` first (cheap), then the player-footprint probe. */
function pointInSolidBox(pos: Vec3, world: World, radius: number): boolean {
  if (world.isSolidPoint(pos)) return true;
  return boxOverlapsSolid(world, pos.x, pos.y, pos.z, radius);
}
