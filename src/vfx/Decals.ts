// =============================================================================
// vfx/Decals.ts — bullet holes, scorch marks and the surface atlas they share.
//
// One atlas canvas holds every decal look (6 tiles) and ONE InstancedMesh draws
// all 192 of them. A material per decal was the obvious alternative and is
// rejected: 192 materials would each get their own program/uniform set and the
// transparent pass would sort 192 objects per frame. Instead every decal carries
// its tile as an instanced UV rect (`aUvRect`) and its fade as an instanced
// scalar (`aAlpha`) — see ShaderPatches.ts.
//
// The ring buffer (`DecalPool`) holds no three.js objects at all, which is what
// makes the wrap-around testable without a WebGL context.
// =============================================================================

import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Scene,
  type Texture,
} from 'three';
import { PERF } from '../core/config';
import { mulberry32 } from '../core/rng';
import type { SurfaceMaterial, Vec3 } from '../core/types';
import {
  DECAL_ATLAS_COLS,
  DECAL_ATLAS_ROWS,
  DECAL_TILE_COUNT,
  DECAL_QUAD_SIZE,
  RENDER_ORDER,
  buildDecalBasis,
  createBasis,
  decalTileUvRect,
  materialDecalTile,
  writeHiddenMatrix,
  writeQuadMatrix,
} from './VfxMath';
import { applyPatches, instancedAlphaPatch, instancedUvPatch } from './ShaderPatches';
import { createCanvas, textureFromCanvas } from './Textures';

/** Distance to lift a decal off its surface, in world units (~1 cm). */
export const DECAL_NORMAL_OFFSET = 0.5;

const ATLAS_TILE = 128;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Atlas (painted once, in tile-local coordinates; the caller translates)
// ---------------------------------------------------------------------------

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, w: number, stroke: string): void {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.stroke();
}

/** Radial cracks; the angle jitter keeps them from lining up across tiles. */
function spokes(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  count: number,
  r0: number,
  r1: number,
  w: number,
  stroke: string,
  rnd: () => number,
): void {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + (rnd() - 0.5) * 0.5;
    const len = r0 + (r1 - r0) * (0.55 + rnd() * 0.45);
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

/** Tile 0 — concrete / sandstone: dark hole, pale dust ring. */
function drawConcrete(ctx: CanvasRenderingContext2D, c: number, rnd: () => number): void {
  const g = ctx.createRadialGradient(c, c, 2, c, c, c * 0.5);
  g.addColorStop(0, 'rgba(206,200,188,0.5)');
  g.addColorStop(0.6, 'rgba(186,180,168,0.22)');
  g.addColorStop(1, 'rgba(170,164,152,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, c * 0.52, 0, TAU);
  ctx.fill();
  for (let i = 0; i < 34; i++) {
    const a = rnd() * TAU;
    const d = c * (0.14 + rnd() * 0.34);
    disc(ctx, c + Math.cos(a) * d, c + Math.sin(a) * d, 0.8 + rnd() * 1.8, `rgba(214,208,196,${(0.1 + rnd() * 0.3).toFixed(2)})`);
  }
  ring(ctx, c, c, c * 0.3, c * 0.06, 'rgba(200,194,182,0.28)');
  spokes(ctx, c, c, 5, c * 0.12, c * 0.42, c * 0.035, 'rgba(30,28,26,0.7)', rnd);
  disc(ctx, c, c, c * 0.2, 'rgba(24,22,20,0.9)');
  disc(ctx, c, c, c * 0.11, 'rgba(10,9,8,0.95)');
}

/** Tile 1 — metal: bright, spark-scarred hole. */
function drawMetal(ctx: CanvasRenderingContext2D, c: number, rnd: () => number): void {
  ring(ctx, c, c, c * 0.32, c * 0.05, 'rgba(186,192,200,0.22)');
  disc(ctx, c, c, c * 0.19, 'rgba(20,20,24,0.9)');
  spokes(ctx, c, c, 9, c * 0.1, c * 0.46, c * 0.03, 'rgba(226,232,240,0.5)', rnd);
  for (let i = 0; i < 26; i++) {
    const a = rnd() * TAU;
    const d = c * (0.12 + rnd() * 0.32);
    disc(ctx, c + Math.cos(a) * d, c + Math.sin(a) * d, 0.7 + rnd() * 1.5, `rgba(255,246,222,${(0.35 + rnd() * 0.5).toFixed(2)})`);
  }
  disc(ctx, c, c, c * 0.07, 'rgba(255,252,238,0.85)');
}

/** Tile 2 — wood: splintered brown ring, grain-aligned wedges. */
function drawWood(ctx: CanvasRenderingContext2D, c: number, rnd: () => number): void {
  ctx.save();
  ctx.translate(c, c);
  for (let i = 0; i < 12; i++) {
    const a = rnd() * TAU;
    const len = c * (0.3 + rnd() * 0.5);
    const w = 1.5 + rnd() * 4;
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(128,88,50,0.55)' : 'rgba(74,48,26,0.5)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a + 0.06) * len, Math.sin(a + 0.06) * len);
    ctx.lineTo(
      Math.cos(a - 0.06) * len + Math.cos(a + Math.PI / 2) * w,
      Math.sin(a - 0.06) * len + Math.sin(a + Math.PI / 2) * w,
    );
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  disc(ctx, c, c, c * 0.17, 'rgba(38,22,12,0.9)');
  disc(ctx, c, c, c * 0.08, 'rgba(14,8,4,0.95)');
}

/** Tile 3 — sand: soft crater, deliberately no ring. */
function drawSand(ctx: CanvasRenderingContext2D, c: number, rnd: () => number): void {
  const g = ctx.createRadialGradient(c, c, 1, c, c, c * 0.62);
  g.addColorStop(0, 'rgba(58,44,30,0.62)');
  g.addColorStop(0.45, 'rgba(74,58,40,0.3)');
  g.addColorStop(1, 'rgba(88,70,48,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, c * 0.64, 0, TAU);
  ctx.fill();
  ring(ctx, c, c, c * 0.4, c * 0.07, 'rgba(212,190,150,0.12)');
  for (let i = 0; i < 30; i++) {
    const a = rnd() * TAU;
    const d = c * (0.2 + rnd() * 0.36);
    disc(ctx, c + Math.cos(a) * d, c + Math.sin(a) * d, 0.6 + rnd() * 1.4, `rgba(104,84,58,${(0.12 + rnd() * 0.3).toFixed(2)})`);
  }
}

/** Tile 4 — glass: white crack star. */
function drawGlass(ctx: CanvasRenderingContext2D, c: number, rnd: () => number): void {
  spokes(ctx, c, c, 8, c * 0.06, c * 0.78, c * 0.022, 'rgba(238,246,255,0.75)', rnd);
  spokes(ctx, c, c, 14, c * 0.08, c * 0.36, c * 0.014, 'rgba(214,230,248,0.5)', rnd);
  ctx.strokeStyle = 'rgba(246,250,255,0.6)';
  ctx.lineWidth = c * 0.014;
  for (let i = 0; i < 7; i++) {
    const a = rnd() * TAU;
    const r = c * (0.24 + rnd() * 0.2);
    const a0 = rnd() * TAU;
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * r, c + Math.sin(a) * r, c * (0.06 + rnd() * 0.12), a0, a0 + 1);
    ctx.stroke();
  }
  disc(ctx, c, c, c * 0.11, 'rgba(226,238,252,0.6)');
  disc(ctx, c, c, c * 0.05, 'rgba(255,255,255,0.85)');
}

/** Tile 5 — explosion scorch: soot with radial blast streaks. */
function drawScorch(ctx: CanvasRenderingContext2D, c: number, rnd: () => number): void {
  const g = ctx.createRadialGradient(c, c, 2, c, c, c * 0.92);
  g.addColorStop(0, 'rgba(10,9,8,0.88)');
  g.addColorStop(0.32, 'rgba(20,17,15,0.72)');
  g.addColorStop(0.66, 'rgba(34,29,25,0.34)');
  g.addColorStop(1, 'rgba(40,34,28,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, ATLAS_TILE, ATLAS_TILE);
  for (let i = 0; i < 26; i++) {
    const a = rnd() * TAU;
    const d = c * (0.1 + rnd() * 0.7);
    disc(ctx, c + Math.cos(a) * d, c + Math.sin(a) * d, c * (0.04 + rnd() * 0.14), `rgba(8,7,6,${(0.1 + rnd() * 0.25).toFixed(2)})`);
  }
  spokes(ctx, c, c, 16, c * 0.2, c * 0.95, c * 0.03, 'rgba(14,12,10,0.3)', rnd);
  disc(ctx, c, c, c * 0.24, 'rgba(6,5,4,0.5)');
}

/**
 * Paint the six-tile decal atlas. Tile order is exactly what the constants in
 * VfxMath.ts promise: concrete/sandstone, metal, wood, sand, glass, scorch.
 * Deterministic — the seam between tiles matters, so it must not shuffle
 * between runs.
 */
export function createDecalAtlasCanvas(): HTMLCanvasElement {
  const { canvas, ctx } = createCanvas(ATLAS_TILE * DECAL_ATLAS_COLS, ATLAS_TILE * DECAL_ATLAS_ROWS);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const rnd = mulberry32(0x51decafe);
  const c = ATLAS_TILE / 2;
  for (let tile = 0; tile < DECAL_TILE_COUNT; tile++) {
    ctx.save();
    ctx.translate((tile % DECAL_ATLAS_COLS) * ATLAS_TILE, Math.floor(tile / DECAL_ATLAS_COLS) * ATLAS_TILE);
    // Clip so no tile can bleed into its neighbour through a soft gradient.
    ctx.beginPath();
    ctx.rect(0, 0, ATLAS_TILE, ATLAS_TILE);
    ctx.clip();
    switch (tile) {
      case 0: drawConcrete(ctx, c, rnd); break;
      case 1: drawMetal(ctx, c, rnd); break;
      case 2: drawWood(ctx, c, rnd); break;
      case 3: drawSand(ctx, c, rnd); break;
      case 4: drawGlass(ctx, c, rnd); break;
      default: drawScorch(ctx, c, rnd); break;
    }
    ctx.restore();
  }
  return canvas;
}

/** Atlas as a texture (one per VfxSystem; disposed by the owner). */
export function createDecalAtlasTexture(): Texture {
  return textureFromCanvas(createDecalAtlasCanvas());
}

// ---------------------------------------------------------------------------
// Ring buffer (no three.js objects — unit tested without a GL context)
// ---------------------------------------------------------------------------

export interface DecalRecord {
  active: boolean;
  /** Matrix must be (re)written on the next update. */
  dirty: boolean;
  tile: number;
  px: number;
  py: number;
  pz: number;
  /** Tangent / bitangent / normal of the surface. */
  tx: number; ty: number; tz: number;
  bx: number; by: number; bz: number;
  nx: number; ny: number; nz: number;
  /** Roll about the normal, stored pre-trig'd (no sin/cos on the update path). */
  cr: number;
  sr: number;
  size: number;
  alpha: number;
  age: number;
  life: number;
  /** Age at which the fade-out tail starts. */
  fadeStart: number;
}

function createDecalRecord(): DecalRecord {
  return {
    active: false, dirty: true, tile: 0,
    px: 0, py: 0, pz: 0,
    tx: 1, ty: 0, tz: 0,
    bx: 0, by: 0, bz: 1,
    nx: 0, ny: 1, nz: 0,
    cr: 1, sr: 0,
    size: 13, alpha: 0, age: 0, life: 1, fadeStart: 1,
  };
}

/**
 * Fixed-capacity ring of decal records. Oldest bullet holes are overwritten once
 * the ring wraps, which is exactly what a firing range needs: 192 decals are on
 * screen forever, memory never grows and no allocation happens per shot.
 */
export class DecalPool {
  readonly capacity: number;
  readonly records: DecalRecord[];
  /** Next slot to overwrite. */
  cursor = 0;
  /** Slots in use, saturating at capacity (the ring never grows). */
  count = 0;
  /** Total spawns since construction (wraps past capacity, for diagnostics). */
  spawned = 0;

  constructor(capacity: number = PERF.decals) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.records = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.records[i] = createDecalRecord();
  }

  /**
   * Place one decal for a surface material. Returns the record it used, or
   * `null` when that surface leaves no mark at all (`tile < 0`: flesh bleeds and
   * water splashes, so the caller draws particles instead).
   */
  spawn(
    point: Vec3,
    normal: Vec3,
    material: SurfaceMaterial,
    size: number,
    life: number,
    roll: number,
  ): DecalRecord | null {
    const tile = materialDecalTile(material);
    if (tile < 0) return null;
    return this.spawnTile(point, normal, tile, size, life, roll);
  }

  /** Same as spawn() but with an explicit atlas tile (explosion scorch marks). */
  spawnTile(
    point: Vec3,
    normal: Vec3,
    tile: number,
    size: number,
    life: number,
    roll: number,
  ): DecalRecord {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.spawned++;

    const rec = this.records[index];
    const basis = buildDecalBasis(normal, scratchBasis);
    rec.active = true;
    rec.dirty = true;
    rec.tile = Math.max(0, Math.min(DECAL_TILE_COUNT - 1, tile | 0));
    rec.px = point.x + basis.n.x * DECAL_NORMAL_OFFSET;
    rec.py = point.y + basis.n.y * DECAL_NORMAL_OFFSET;
    rec.pz = point.z + basis.n.z * DECAL_NORMAL_OFFSET;
    rec.tx = basis.t.x; rec.ty = basis.t.y; rec.tz = basis.t.z;
    rec.bx = basis.b.x; rec.by = basis.b.y; rec.bz = basis.b.z;
    rec.nx = basis.n.x; rec.ny = basis.n.y; rec.nz = basis.n.z;
    rec.cr = Math.cos(roll);
    rec.sr = Math.sin(roll);
    rec.size = Number.isFinite(size) && size > 0 ? size : DECAL_QUAD_SIZE[rec.tile] ?? 13;
    rec.alpha = 1;
    rec.age = 0;
    rec.life = Number.isFinite(life) && life > 0 ? life : 26;
    rec.fadeStart = rec.life * 0.92;
    return rec;
  }

  /** Drop every decal (round restart). */
  releaseAll(): void {
    for (let i = 0; i < this.capacity; i++) {
      const rec = this.records[i];
      if (!rec.active) continue;
      rec.active = false;
      rec.dirty = true;
      rec.alpha = 0;
      rec.age = 0;
    }
    this.cursor = 0;
    this.count = 0;
  }

  get liveCount(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (this.records[i].active) n++;
    return n;
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Draws a DecalPool as one InstancedMesh. Slot i always maps to instance i, so
 * overwriting a wrapped slot writes exactly one matrix — no per-frame reindexing
 * and no allocation.
 */
export class DecalRenderer {
  readonly mesh: InstancedMesh;
  readonly material: MeshBasicMaterial;
  private readonly geometry: PlaneGeometry;
  private readonly uvRect: InstancedBufferAttribute;
  private readonly alpha: InstancedBufferAttribute;
  private readonly m: Float32Array;
  private live = 0;

  constructor(
    scene: Scene,
    readonly pool: DecalPool,
    atlas: Texture,
  ) {
    const capacity = pool.capacity;
    this.geometry = new PlaneGeometry(1, 1);
    this.material = new MeshBasicMaterial({
      map: atlas,
      transparent: true,
      depthWrite: false,
      // Nudge fragment depth toward the viewer so a decal cannot z-fight the
      // wall it sits on at grazing angles (depthWrite stays off regardless).
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    applyPatches(this.material, instancedUvPatch(), instancedAlphaPatch());

    this.mesh = new InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.name = 'vfx.decals';
    this.mesh.renderOrder = RENDER_ORDER.decals;
    // Instances move far outside the unit plane's bounding sphere.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);

    this.uvRect = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.uvRect.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('aUvRect', this.uvRect);
    this.alpha = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.alpha.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('aAlpha', this.alpha);

    const rect: number[] = [0, 0, 0, 0];
    decalTileUvRect(0, rect);
    this.m = new Float32Array(16);
    writeHiddenMatrix(this.m);
    for (let i = 0; i < capacity; i++) {
      this.mesh.instanceMatrix.set(this.m, i * 16);
      this.uvRect.setXYZW(i, rect[0], rect[1], rect[2], rect[3]);
      this.alpha.setX(i, 0);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.uvRect.needsUpdate = true;
    this.alpha.needsUpdate = true;
    scene.add(this.mesh);
  }

  /** Advance lifetimes, fade expiring decals and push the matrices that changed. */
  update(dt: number): void {
    const records = this.pool.records;
    const capacity = this.pool.capacity;
    let live = 0;
    let matrixDirty = false;
    let alphaDirty = false;

    for (let i = 0; i < capacity; i++) {
      const rec = records[i];

      if (!rec.active) {
        // Only pay for a hidden instance once, right after it retires.
        if (rec.dirty) {
          writeHiddenMatrix(this.m);
          this.mesh.instanceMatrix.set(this.m, i * 16);
          this.alpha.setX(i, 0);
          rec.alpha = 0;
          rec.dirty = false;
          matrixDirty = true;
          alphaDirty = true;
        }
        continue;
      }

      if (dt > 0) rec.age += dt;
      if (rec.age >= rec.life) {
        rec.active = false;
        rec.dirty = true;
        rec.alpha = 0;
        writeHiddenMatrix(this.m);
        this.mesh.instanceMatrix.set(this.m, i * 16);
        this.alpha.setX(i, 0);
        rec.dirty = false;
        matrixDirty = true;
        alphaDirty = true;
        continue;
      }

      live++;
      const fade = rec.age <= rec.fadeStart
        ? 1
        : 1 - (rec.age - rec.fadeStart) / Math.max(1e-4, rec.life - rec.fadeStart);
      const alpha = fade <= 0 ? 0 : fade > 1 ? 1 : fade;
      if (!rec.dirty && alpha === rec.alpha) continue; // holding steady: no work

      // Shrink slightly while fading: a decal that only loses alpha reads as
      // ghosting, while one that also contracts reads as dirt wearing off.
      const scale = rec.size * (alpha >= 1 ? 1 : 0.82 + 0.18 * alpha);
      writeQuadMatrix(
        this.m,
        (rec.tx * rec.cr + rec.bx * rec.sr) * scale,
        (rec.ty * rec.cr + rec.by * rec.sr) * scale,
        (rec.tz * rec.cr + rec.bz * rec.sr) * scale,
        (-rec.tx * rec.sr + rec.bx * rec.cr) * scale,
        (-rec.ty * rec.sr + rec.by * rec.cr) * scale,
        (-rec.tz * rec.sr + rec.bz * rec.cr) * scale,
        rec.nx * scale, rec.ny * scale, rec.nz * scale,
        rec.px, rec.py, rec.pz,
      );
      this.mesh.instanceMatrix.set(this.m, i * 16);
      rec.alpha = alpha;
      rec.dirty = false;
      matrixDirty = true;
      alphaDirty = true;
    }

    if (matrixDirty) this.mesh.instanceMatrix.needsUpdate = true;
    if (alphaDirty) this.alpha.needsUpdate = true;
    this.live = live;
  }

  get liveCount(): number {
    return this.live;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Shared scratch basis for spawn paths (single-threaded, never retained). */
const scratchBasis = createBasis();
