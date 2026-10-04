// =============================================================================
// render/Signs.ts — the world names its own places.
//
// WHY: an audit of `world/maps/de_dust2_lite.ts` measured that 99.5% of the
// walkable floor shares ONE tint, 12 of 18 named areas have an identical floor
// colour, there are zero roofs, and 4 of 5 spawns stare at a 7.3 m blank
// concrete wall. Nothing in the 3D view ever said "this is Mid" or "that is B" —
// only the radar had labels, and even those were hidden by a radar bug. Result:
// the map reads as an undifferentiated maze.
//
// WHAT: one merged, textless-in-code sign layer. Every callout gets a floor
// label, the two bomb sites get a big letter on the floor, and each team's spawn
// gets a placard bolted to the wall it faces. All of it is a single
// `MeshBasicMaterial` atlas (one canvas, one texture, one draw call, no lights
// needed) so the perf budget (§README: < 80 draw calls) does not notice it.
//
// The functions are split so the maths stays testable under node: `planSigns`
// and `buildSignGeometry` are pure, and only `createSignAtlas` needs a browser
// canvas.
// =============================================================================

import * as THREE from 'three';
import type { AABB, BombSiteRegion, MapData, PaintZone, Vec3 } from '../core/types';
import { brushToAabb } from '../world/trace';
import { calloutLabel } from '../ui/pure';
import { mergeParts } from './parts';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Atlas tile edge in pixels. Every sign is a SQUARE so no tile is stretched. */
export const SIGN_TILE_PX = 256;
export const SIGN_ATLAS_COLS = 4;
export const SIGN_ATLAS_ROWS = 7;
/** Tiles the atlas can hold (21 callouts + 2 site letters + 2 spawn signs = 25). */
export const SIGN_TILE_CAPACITY = SIGN_ATLAS_COLS * SIGN_ATLAS_ROWS;

/** Floor label sizes in world units (1 m = 52.49 u, so 300 u ≈ 5.7 m). */
export const SIGN_CALLOUT_SIZE = 300;
export const SIGN_SITE_SIZE = 420;
export const SIGN_SPAWN_SIZE = 320;
/** How opaque a district wash is at its centre (multiplied by the tile alpha). */
export const SIGN_PAINT_ALPHA = 0.34;

/** Lift above the floor so the label never z-fights with the ground slab. */
export const SIGN_LIFT = 0.6;
/** Gap between a wall placard and the wall it hangs on. */
export const SIGN_WALL_OFFSET = 3;
/** Ray height (above the spawn floor) used to find that wall. */
export const SIGN_WALL_RAY_HEIGHT = 100;
/** Height of the placard's bottom edge above the floor. */
export const SIGN_WALL_BOTTOM = 24;
/** How far a spawn ray searches for a wall before giving up. */
export const SIGN_RAY_RANGE = 1400;
/** Hits landing within this distance of each other are the same wall. */
export const SIGN_SPAWN_DEDUPE = 24;
/** At most this many placards per team (spawns are lined up in pairs). */
export const SIGN_SPAWN_MAX_PLACARDS = 4;

/** Colours are ABSOLUTE (multiplied with the white atlas text). */
export const SIGN_COLOR_CALLOUT = 0xdbe6f2;
export const SIGN_COLOR_SITE = 0xffd08a;
export const SIGN_COLOR_T = 0xff9d63;
export const SIGN_COLOR_CT = 0x7fb4ff;

/**
 * Drawn before every VFX layer (`VfxMath.RENDER_ORDER.decals` is 4) and before
 * the actor rims (5), but after the opaque map: floor paint belongs to the world.
 */
export const SIGN_RENDER_ORDER = 2;

export type SignKind = 'callout' | 'site' | 'spawn' | 'paint';

export interface SignPlan {
  /** Text drawn into the atlas tile. Empty for paint. */
  label: string;
  kind: SignKind;
  /** Atlas key: entries sharing a key share one tile. */
  key: string;
  x: number;
  y: number;
  z: number;
  /** `0` reads for a viewer looking toward -Z; a wall sign faces its spawn. */
  yaw: number;
  /** Square edge length in world units (X extent for paint). */
  size: number;
  color: number;
  /** True for a vertical placard, false for paint flat on the floor. */
  upright: boolean;
  /**
   * Z extent for stretched quads (district paint). Defaults to `size`, i.e. a
   * square. Only paint stretches, and its tile is a soft-edged plain wash, so
   * stretching cannot distort anything readable.
   */
  stretch?: number;
}

/**
 * Legacy district paint for de_dust2_lite, kept as the fallback for any map that
 * does not carry its own `paint` zones. Wash a whole area's floor in its own
 * hue. The audit measured 99.5% of the walkable floor sharing one tint (`sand`
 * 0xd8c7a1) with 12 of 18 named areas identical, which is most of why the map
 * reads as one maze. Paint is a flat, translucent quad at floor level: it is
 * occluded by walls the way any floor decal is, and it touches no brush, no
 * baked nav node and no collision volume, so movement and the green test suite
 * are untouched.
 *
 * Rectangles stay inside each area's walls (they may safely overrun — the wall
 * base hides the spill — but there is no reason to).
 */
export const SIGN_ZONES: readonly PaintZone[] = [
  { name: 'TSpawn', minX: -515, minZ: 2065, maxX: 515, maxZ: 2855, floorY: 0, color: 0xb8a17a },
  { name: 'CTSpawn', minX: -515, minZ: -2855, maxX: 515, maxZ: -2065, floorY: 0, color: 0x8f9ab8 },
  { name: 'Mid', minX: -215, minZ: -440, maxX: 215, maxZ: 1990, floorY: 0, color: 0x86a9bd },
  { name: 'LongA', minX: 1565, minZ: -260, maxX: 2035, maxZ: 2330, floorY: 0, color: 0xc2a05c },
  { name: 'Tunnels', minX: -1915, minZ: -1240, maxX: -1505, maxZ: 2040, floorY: 0, color: 0x93a06a },
  { name: 'ASite', minX: 1355, minZ: -1995, maxX: 2145, maxZ: -1055, floorY: 128, color: 0xd7bd6e },
  { name: 'BSite', minX: -1745, minZ: -2055, maxX: -1365, maxZ: -1205, floorY: 0, color: 0x6fae9c },
];

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

export function polyCentroid(poly: readonly [number, number][]): { x: number; z: number } {
  if (poly.length === 0) return { x: 0, z: 0 };
  let x = 0;
  let z = 0;
  for (const p of poly) {
    x += p[0];
    z += p[1];
  }
  return { x: x / poly.length, z: z / poly.length };
}

const scratchAabb: AABB = {
  min: { x: 0, y: 0, z: 0 },
  max: { x: 0, y: 0, z: 0 },
};

/**
 * Distance to the first solid brush along an axis-aligned ray, or null when
 * nothing is hit inside `maxDist`. Uses the same yaw-expanded AABB the collision
 * system uses (`world/trace.ts`), and skips clip / non-solid brushes because the
 * spawn wall a player sees is a real brush.
 */
export function rayBrushDistance(
  map: MapData,
  origin: Vec3,
  dx: number,
  dz: number,
  maxDist: number,
): number | null {
  let best: number | null = null;
  for (const brush of map.brushes) {
    if (brush.clip || brush.nonSolid) continue;
    const box = brushToAabb(brush, scratchAabb);
    // The rays are horizontal, so the y slab is a plain containment test: without
    // it the huge ground slab (y -64..0) would "hit" every ray at t = 0.
    if (origin.y < box.min.y || origin.y > box.max.y) continue;
    let t0 = 0;
    let t1 = maxDist;
    // x slab
    if (Math.abs(dx) < 1e-9) {
      if (origin.x < box.min.x || origin.x > box.max.x) continue;
    } else {
      const a = (box.min.x - origin.x) / dx;
      const b = (box.max.x - origin.x) / dx;
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
    // z slab
    if (Math.abs(dz) < 1e-9) {
      if (origin.z < box.min.z || origin.z > box.max.z) continue;
    } else {
      const a = (box.min.z - origin.z) / dz;
      const b = (box.max.z - origin.z) / dz;
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
    if (t0 > t1 || t1 < 0) continue;
    const hit = t0 >= 0 ? t0 : t1;
    if (hit <= maxDist && (best === null || hit < best)) best = hit;
  }
  return best;
}

/**
 * Wall placards for a team's spawn: the walls that team's spawn points face,
 * which is exactly the blank wall players complained about. Spawns are lined up
 * in pairs, so hits are de-duplicated by where they land (2 placards per team
 * here) instead of keeping only the nearest one — a placard at x = -300 cannot be
 * read by a player who spawns at x = +300. Returns nothing when no wall is within
 * range (a floating placard would be worse than none), and nothing for a spawn
 * whose aim runs through the exit.
 */
function planSpawnSigns(map: MapData): SignPlan[] {
  const out: SignPlan[] = [];
  const seen: { x: number; z: number }[] = [];
  for (const team of ['T', 'CT'] as const) {
    const spawns = map.spawns.filter((s) => s.team === team);
    const hits: { distance: number; yaw: number; x: number; y: number; z: number }[] = [];
    for (const spawn of spawns) {
      // `core/math.ts` forward(yaw) = (-sin yaw, 0, -cos yaw).
      const dx = -Math.sin(spawn.yaw);
      const dz = -Math.cos(spawn.yaw);
      const origin = {
        x: spawn.pos.x,
        y: spawn.pos.y + SIGN_WALL_RAY_HEIGHT,
        z: spawn.pos.z,
      };
      const distance = rayBrushDistance(map, origin, dx, dz, SIGN_RAY_RANGE);
      if (distance === null) continue;
      hits.push({
        distance,
        yaw: spawn.yaw,
        x: origin.x + dx * distance,
        y: spawn.pos.y,
        z: origin.z + dz * distance,
      });
    }
    hits.sort((a, b) => a.distance - b.distance);
    let placed = 0;
    for (const hit of hits) {
      if (placed >= SIGN_SPAWN_MAX_PLACARDS) break;
      if (seen.some((p) => Math.hypot(p.x - hit.x, p.z - hit.z) < SIGN_SPAWN_DEDUPE)) continue;
      const dx = -Math.sin(hit.yaw);
      const dz = -Math.cos(hit.yaw);
      seen.push({ x: hit.x, z: hit.z });
      placed++;
      out.push({
        key: `spawn:${team}`,
        label: team === 'T' ? 'T SPAWN' : 'CT SPAWN',
        kind: 'spawn',
        x: hit.x - dx * SIGN_WALL_OFFSET,
        y: hit.y + SIGN_WALL_BOTTOM + SIGN_SPAWN_SIZE * 0.5,
        z: hit.z - dz * SIGN_WALL_OFFSET,
        // The placard faces back toward the spawn, i.e. along the spawn's aim.
        yaw: hit.yaw,
        size: SIGN_SPAWN_SIZE,
        color: team === 'T' ? SIGN_COLOR_T : SIGN_COLOR_CT,
        upright: true,
      });
    }
  }
  return out;
}

/**
 * Paint entries, drawn first so labels blend over their own district wash.
 *
 * Zones come from the map itself (`MapData.paint`) so each arena paints its own
 * districts; only a map that declares none — de_dust2_lite — falls back to the
 * legacy {@link SIGN_ZONES} table. Painting dust2's coordinates onto the duel
 * arena used to wash random 5 x 8 m patches of its floor.
 */
function planDistrictPaint(map: MapData): SignPlan[] {
  const zones = map.paint && map.paint.length > 0 ? map.paint : SIGN_ZONES;
  return zones.map((zone) => ({
    key: 'paint',
    label: '',
    kind: 'paint' as const,
    x: (zone.minX + zone.maxX) / 2,
    y: zone.floorY + SIGN_LIFT,
    z: (zone.minZ + zone.maxZ) / 2,
    yaw: 0,
    size: zone.maxX - zone.minX,
    stretch: zone.maxZ - zone.minZ,
    color: zone.color,
    upright: false,
  }));
}

/**
 * Every label the world should carry: one floor label per callout (the site
 * callouts become the big A / B letters instead), plus the spawn placards.
 * District paint comes first so the labels land on top of their own wash.
 */
export function planSigns(map: MapData): SignPlan[] {
  const out: SignPlan[] = planDistrictPaint(map);
  const siteCallouts = new Map<string, BombSiteRegion>();
  for (const site of map.sites) {
    siteCallouts.set(site.site === 'A' ? 'ASite' : 'BSite', site);
  }

  const callouts = map.callouts ?? {};
  for (const name of Object.keys(callouts)) {
    const at = callouts[name];
    if (!at) continue;
    const site = siteCallouts.get(name);
    if (site) {
      const centre = polyCentroid(site.poly);
      out.push({
        key: `site:${site.site}`,
        label: site.site,
        kind: 'site',
        x: centre.x,
        y: site.y + SIGN_LIFT,
        z: centre.z,
        yaw: 0,
        size: SIGN_SITE_SIZE,
        color: SIGN_COLOR_SITE,
        upright: false,
      });
      continue;
    }
    if (!Number.isFinite(at.x) || !Number.isFinite(at.z)) continue;
    out.push({
      key: `callout:${name}`,
      label: calloutLabel(name),
      kind: 'callout',
      x: at.x,
      y: (Number.isFinite(at.y) ? at.y : 0) + SIGN_LIFT,
      z: at.z,
      yaw: 0,
      size: SIGN_CALLOUT_SIZE,
      color: SIGN_COLOR_CALLOUT,
      upright: false,
    });
  }

  out.push(...planSpawnSigns(map));
  return out;
}

/** Unique atlas tiles for a plan, in first-seen order (one tile per key). */
export function planSignTiles(plan: readonly SignPlan[]): { key: string; label: string; kind: SignKind }[] {
  const tiles: { key: string; label: string; kind: SignKind }[] = [];
  const seen = new Set<string>();
  for (const entry of plan) {
    if (seen.has(entry.key)) continue;
    if (tiles.length >= SIGN_TILE_CAPACITY) break;
    seen.add(entry.key);
    tiles.push({ key: entry.key, label: entry.label, kind: entry.kind });
  }
  return tiles;
}

// ---------------------------------------------------------------------------
// Atlas (browser only)
// ---------------------------------------------------------------------------

export interface SignAtlas {
  canvas: HTMLCanvasElement;
  cols: number;
  rows: number;
}

/** UV corners of tile `index` inside a `cols` x `rows` grid of a flipY texture. */
export function tileUv(index: number, cols: number, rows: number): [number, number, number, number] {
  const col = index % cols;
  const row = Math.floor(index / cols);
  const u0 = col / cols;
  const u1 = (col + 1) / cols;
  // Canvas row 0 is the top row; a three.js CanvasTexture flips Y.
  const v1 = 1 - row / rows;
  const v0 = 1 - (row + 1) / rows;
  return [u0, v0, u1, v1];
}

/**
 * Paint the label atlas: transparent background, white text with a dark outline
 * so it reads on sand, concrete and metal alike.
 */
export function createSignAtlas(
  tiles: readonly { key: string; label: string; kind: SignKind }[],
  tilePx = SIGN_TILE_PX,
  cols = SIGN_ATLAS_COLS,
): SignAtlas {
  const rows = Math.max(1, Math.ceil(Math.max(1, tiles.length) / cols));
  const canvas = document.createElement('canvas');
  canvas.width = cols * tilePx;
  canvas.height = rows * tilePx;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { canvas, cols, rows };

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineJoin = 'round';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < tiles.length && i < cols * rows; i += 1) {
    const tile = tiles[i];
    const cx = (i % cols) * tilePx + tilePx * 0.5;
    const cy = Math.floor(i / cols) * tilePx + tilePx * 0.5;

    if (tile.kind === 'paint') {
      // Soft-edged wash: opaque enough to tint the sand in the middle, feathered
      // at the border so a district does not end in a hard rectangle. The hue
      // comes from the quad's vertex colour, so the tile itself is white.
      const grad = ctx.createRadialGradient(cx, cy, tilePx * 0.05, cx, cy, tilePx * 0.5);
      grad.addColorStop(0, `rgba(255,255,255,${SIGN_PAINT_ALPHA})`);
      grad.addColorStop(0.72, `rgba(255,255,255,${SIGN_PAINT_ALPHA * 0.85})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(cx - tilePx * 0.5, cy - tilePx * 0.5, tilePx, tilePx);
      continue;
    }

    if (tile.kind === 'spawn') {
      // A physical placard: dark plate + light border, so a wall sign reads as
      // an object rather than as paint that happens to be vertical.
      const inset = tilePx * 0.06;
      const r = tilePx * 0.08;
      ctx.beginPath();
      ctx.moveTo(inset + r, inset);
      ctx.arcTo(tilePx - inset, inset, tilePx - inset, tilePx - inset, r);
      ctx.arcTo(tilePx - inset, tilePx - inset, inset, tilePx - inset, r);
      ctx.arcTo(inset, tilePx - inset, inset, inset, r);
      ctx.arcTo(inset, inset, tilePx - inset, inset, r);
      ctx.closePath();
      ctx.fillStyle = 'rgba(14, 18, 26, 0.82)';
      ctx.fill();
      ctx.lineWidth = tilePx * 0.035;
      ctx.strokeStyle = 'rgba(236, 244, 255, 0.92)';
      ctx.stroke();
    }

    const start = tile.kind === 'site' ? tilePx * 0.86 : tile.kind === 'spawn' ? tilePx * 0.52 : tilePx * 0.46;
    let size = start;
    const family = '"Segoe UI", system-ui, Arial, sans-serif';
    ctx.font = `bold ${size}px ${family}`;
    while (size > 10 && ctx.measureText(tile.label).width > tilePx * 0.86) {
      size -= 2;
      ctx.font = `bold ${size}px ${family}`;
    }

    ctx.lineWidth = Math.max(3, size * 0.16);
    ctx.strokeStyle = 'rgba(16, 20, 28, 0.9)';
    ctx.strokeText(tile.label, cx, cy);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(tile.label, cx, cy);
  }

  return { canvas, cols, rows };
}

// ---------------------------------------------------------------------------
// Geometry (pure)
// ---------------------------------------------------------------------------

function tintAttribute(color: number, count: number): THREE.BufferAttribute {
  const c = new THREE.Color(color);
  const array = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    array[i * 3] = c.r;
    array[i * 3 + 1] = c.g;
    array[i * 3 + 2] = c.b;
  }
  return new THREE.BufferAttribute(array, 3);
}

/** One square sign quad, UV-mapped into its atlas tile. */
export function signQuad(
  entry: SignPlan,
  tile: number,
  cols: number,
  rows: number,
): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(entry.size, entry.stretch ?? entry.size);
  const [u0, v0, u1, v1] = tileUv(tile, cols, rows);
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i += 1) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  uv.needsUpdate = true;

  // Local text-up: +Y. Flat signs are laid down so that +Y becomes -Z, which is
  // the direction a viewer walking out of spawn is facing, then yawed.
  if (!entry.upright) geometry.rotateX(-Math.PI / 2);
  if (entry.yaw !== 0) geometry.rotateY(entry.yaw);
  geometry.translate(entry.x, entry.y, entry.z);
  geometry.setAttribute('color', tintAttribute(entry.color, geometry.getAttribute('position').count));
  return geometry;
}

/**
 * Merge a plan into one geometry. Returns null when nothing is placeable, which
 * keeps `SignLayer` from adding an empty mesh to the scene.
 */
export function buildSignGeometry(
  plan: readonly SignPlan[],
  tileIndex: ReadonlyMap<string, number>,
  cols: number,
  rows: number,
): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  for (const entry of plan) {
    const tile = tileIndex.get(entry.key);
    if (tile === undefined) continue;
    parts.push(signQuad(entry, tile, cols, rows));
  }
  if (parts.length === 0) return null;
  return mergeParts(parts, 'signs');
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/** One draw call for every label in the world. Read-only after construction. */
export class SignLayer {
  readonly group: THREE.Group;
  private mesh: THREE.Mesh | null = null;
  private material: THREE.MeshBasicMaterial | null = null;
  private texture: THREE.CanvasTexture | null = null;

  constructor(scene: THREE.Scene, map: MapData) {
    this.group = new THREE.Group();
    this.group.name = 'signs';

    const plan = planSigns(map);
    const tiles = planSignTiles(plan);
    if (tiles.length === 0) {
      scene.add(this.group);
      return;
    }

    const tileIndex = new Map<string, number>();
    for (let i = 0; i < tiles.length; i += 1) tileIndex.set(tiles[i].key, i);

    const atlas = createSignAtlas(tiles);
    const geometry = buildSignGeometry(plan, tileIndex, atlas.cols, atlas.rows);
    if (geometry) {
      this.texture = new THREE.CanvasTexture(atlas.canvas);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.anisotropy = 4;
      this.texture.needsUpdate = true;
      this.material = new THREE.MeshBasicMaterial({
        map: this.texture,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      this.mesh = new THREE.Mesh(geometry, this.material);
      this.mesh.name = 'signs.mesh';
      this.mesh.frustumCulled = false;
      this.mesh.matrixAutoUpdate = false;
      this.mesh.renderOrder = SIGN_RENDER_ORDER;
      this.mesh.updateMatrix();
      this.group.add(this.mesh);
    }

    scene.add(this.group);
  }

  /** Labels are one merged mesh, so this is 1 while anything is placeable. */
  get drawCalls(): number {
    return this.mesh ? 1 : 0;
  }

  dispose(): void {
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
    }
    this.group.removeFromParent();
  }
}