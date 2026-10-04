# Bot navigation (`src/ai/navigation.ts`)

Integration notes for the bot behaviours. Navigation is **pure data**: no DOM, no
Three.js, no timers, no randomness. The same inputs always produce the same path,
so replays and tests stay stable.

## Units and sizes

Everything is in world units (1 unit ≈ 1 cm at the usual Source scale) and seconds.

| Thing | Value |
| --- | --- |
| `PLAYER.radius` | 16 (the footprint used by `nudgeIntoFreeSpace` and the solid probe) |
| Nav node spacing (map convention) | ~256 units; the real map's nodes are authored at corners and chokepoints |
| Spatial-hash cell (`CELL_SIZE`) | 256 units, one grid over `map.bounds` |
| `nearestNode` probe radius | 512 units (`maxDistance`) |
| `followPath` arrive radius | 48 units (`2 × PLAYER.radius`) |
| `followPath` lookahead | 3 waypoints |
| `smoothPath` step | 32 (max points advanced per merge attempt) |

## Cost model

`findPath` is A* over the nav graph. The cost of an edge `u → v` is:

```
distance(nodes[u].pos, nodes[v].pos)                 // true world-space length
  + (nodes[v].choke ? chokePenalty : 0)              // chokes cost extra
  + areaPenalty(nodes[v].area, team)                 // per-area danger surcharge
```

- The y difference counts: `distance` is plain 3D Euclidean, so a drop is cheaper
  than the same horizontal run on the flat.
- **The penalty is charged on entering `v`** — never for the start node, always
  for the goal. An area penalty therefore also prices *standing* in a bad area.
- The heuristic is `distance(node, goal) × heuristicWeight`, default
  `heuristicWeight = 1.15`. A weight above 1 is a deliberate trade: the search is
  faster and greedier, so the returned path is optimal only up to a factor of
  `heuristicWeight`. Pass `{ heuristicWeight: 1 }` when a caller needs the exact
  optimum (tests and any "cheapest route" UI do this).
- `chokePenalty` and `areaPenalty` are ordinary option values, so bots can retune
  them per team, per round or per behaviour without rebuilding the graph.
- `maxExpansions` (default 6000) is a safety valve: a pathological graph gives up
  and returns `empty: true` rather than stalling the frame.

`NavPath.cost` is the summed edge cost; `NavPath.length` is the world-space length
of the **smoothed** polyline, so the two differ. `path.chokes` lists the choke
nodes actually used, and `path.empty` is the only "no path" signal to test.

## Repathing

A* is cheap here (preallocated typed-array scratch, hand-written binary heap, no
per-query clearing), but it is not free, so do not repath every tick:

- Repath **at most once every 500 ms** per bot.
- Repath **immediately** when the goal moves more than 256 units (a target
  rounding a corner is not a new destination).
- Repath when the current path goes stale in a way a follower cannot fix: the
  actor has left `maxDistance` of the path, the goal changed team/site, or the
  path is `empty`.
- Otherwise keep steering the existing `PathFollower`; `followPath` is allocation
  free and safe to call every tick.

Recommended shape:

```ts
const graph = new NavGraph(map, { chokePenalty: 150, areaPenalty: dangerByArea, heuristicWeight: 1.15 });
graph.attachWorld(world);                    // optional: rejects nodes inside solids

const start = graph.nearestNode(bot.pos);    // -1 when the bot is off-graph
const goal  = graph.nearestNode(target);
const path  = graph.findPath(start, goal, bot.team);
if (!path.empty) follower = createFollower(path);
```

`nearestNode` returns `-1` rather than throwing. A bot with no node under it is
off-graph: nudge it back with `nudgeIntoFreeSpace` before retrying.

## Steering: why `followPath` has lookahead

`followPath(follower, pos, world)` pops any waypoint already within 48 units of
`pos`, then looks up to 3 waypoints ahead and returns the **farthest one still
visible** from `pos`. That single rule is what stops the "robot on rails" look:

- A bot on a straight corridor ignores the intermediate nodes and walks the
  corridor, instead of snapping to each node in turn.
- When a wall blocks the lookahead, the bot falls back to the next node and
  rounds the corner properly.
- Because the target is recomputed from the live position every tick, the bot
  cuts corners smoothly instead of orbiting waypoints.

The returned point is a *steering target*, not a teleport: pass it to the normal
movement code (look-at/accelerate) and ignore `y` if movement is 2D. `null` means
the path is exhausted — clear the follower and pick a new goal. It never indexes
out of range, so calling it again after `null` is harmless.

## Smoothing and safety

- `smoothPath` is greedy any-angle: from an anchor it keeps the farthest point
  still `world.isVisible` from it, then repeats, and it always keeps the last
  point. Every waypoint it emits is a copy of an input point — it never
  interpolates — so it can neither leave `map.bounds` nor invent a position the
  graph did not supply. If every candidate is blocked it keeps the
  adjacent point — so a smoothed chain can contain a hop the raycast calls
  opaque (a node is a *walkable* point, not necessarily in line of sight of its
  neighbour). Do not use a smoothed polyline as a visibility proof.
- **`world.isVisible` shortens the ray by 1 unit**, so an endpoint lying exactly
  on a brush face reports visible. Author nav nodes off the geometry, not on it.
- `nudgeIntoFreeSpace(pos, world, radius)` box-probes the player footprint and
  spirals outward to ~5 cells of `radius × 2`; if nothing is free it returns the
  original position (never NaN, never an infinite loop).
- `reachableFrom` / `isFullyConnected` are iterative BFS over a preallocated
  queue. `isFullyConnected()` is true when every node is reachable from node 0 —
  an empty graph is trivially connected.
- `attachWorld(world)` is optional and exists because the constructor signature is
  frozen. With a world attached, `nearestNode` also rejects nodes sitting inside
  solid geometry; without one, map authoring is trusted.

## Map authoring contract

`validateGraph()` returns human-readable problems (empty array = clean) and is
meant to be run against a real map in tests: dangling link ids, non-bidirectional
links, nodes outside `map.bounds`, isolated nodes, duplicate ids and zero-length
edges. Malformed link ids are skipped silently during search — a broken map
degrades to a shorter path, it never throws mid-round.
