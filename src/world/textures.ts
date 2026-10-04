// =============================================================================
// world/textures.ts — procedural CS:GO-era Source-engine surface textures.
//
// Everything here is drawn at runtime with the 2D canvas API: the project ships
// zero image assets, so a tile of "sandstone" is deterministic float noise turned
// into pixels. `mulberry32` is the only source of randomness, which means a given
// (name, seed) always produces byte-identical pixels.
//
// SEAMLESSNESS — the one rule that matters in this file
// -----------------------------------------------------
// Every texture must tile without a visible seam. Two techniques are used:
//
//  1. NOISE-DRIVEN variation (per-pixel grain, grain streaks, bedding bands,
//     ripples, panel seams) comes from `makePeriodicNoise`, which wraps lattice
//     coordinates with `mod(..., period)`: sampling at x and x+period yields the
//     identical value, so the field itself has no seam. Modulation that only
//     varies along one axis (a row tint) is trivially seamless in the other.
//
//  2. STAMPED features (pits, knots, aggregate dots, rivets, cracks, cloud
//     blobs) are position-dependent blobs, so each one is drawn up to FOUR times
//     at the wrapped offsets {(0,0), (+size,0), (0,+size), (+size,+size)} about
//     its modulo-wrapped position. A blob that overhangs the right edge therefore
//     reappears on the left edge and the pixels match across the tile boundary.
//     `paintWrapped`, `strokeWrapped` and `strokeLineWrapped` implement that rule;
//     nothing else in this file strokes or arcs into the context.
//
//     Shape features that live on the tile border (the crate frame, the panel
//     seam, plank edge gaps, brick mortar) are placed so they coincide with the
//     border and are continuous when tiles are laid next to each other: the crate
//     frame becomes one long beam, the plank gap becomes one continuous groove.
//
// Lighting (the directional sun) is NOT baked in: what little contrast exists
// here is ambient-occlusion darkening in crevices plus albedo variation, and
// Three.js does the shading. Textures are authored around mid-grey and keep
// their highlights modest.
// =============================================================================

import * as THREE from 'three';
import type { SurfaceMaterial } from '../core/types';
import { mulberry32 } from '../core/rng';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProcTextureName =
  | SurfaceMaterial
  | 'radar'
  | 'metalPanel'
  | 'woodPlank'
  | 'crate'
  | 'brickSand';

/** `repeatUnits` = world units covered by one tile edge of this texture. */
export interface TextureRecipe {
  size: number;
  repeatUnits: number;
}

// ---------------------------------------------------------------------------
// Recipe table — the per-material "character" of the source surfaces.
//
// `size` is a power of two (mipmaps + NPOT-safe on every GL backend); 256 is
// plenty of detail for a gritty Source look at ~256KB RGBA per material. A few
// materials use 264 instead: 264 is an exact multiple of their feature periods
// (4 brick courses of 66, 4 plank gaps of 66, 6 rows of 44), which keeps the
// stamped brick/plank layout periodic and therefore seamless. Such sizes are
// only used for non-mipmap-critical material maps.
// ---------------------------------------------------------------------------

export const TEXTURE_RECIPES: Record<ProcTextureName, TextureRecipe> = {
  // Dust2's dominant surface: warm tan, fine grain, dark irregular pitting.
  sandstone: { size: 256, repeatUnits: 128 },
  // Cool mid-grey, coarse speckle, aggregate dots and hairline cracks.
  concrete: { size: 256, repeatUnits: 160 },
  // Long vertical grain streaks with knots and plank-edge darkening.
  wood: { size: 256, repeatUnits: 96 },
  // Brushed steel: fine horizontal streaks, slight blue-grey, scratches.
  metal: { size: 256, repeatUnits: 80 },
  // Pale yellow, very fine high-frequency noise, large soft blotches.
  sand: { size: 256, repeatUnits: 180 },
  // Near-white with a faint blue tint and a few thin scratches.
  glass: { size: 128, repeatUnits: 96 },
  // Not used on world geometry (VFX blood decals at most).
  flesh: { size: 64, repeatUnits: 24 },
  // Dark blue-green with soft ripple bands.
  water: { size: 256, repeatUnits: 220 },
  // Wooden crate face: plank + frame + brace, distinctly darker than `wood`.
  crate: { size: 256, repeatUnits: 96 },
  // Sandy brick courses with mortar (B site / tunnel walls).
  brickSand: { size: 264, repeatUnits: 132 },
  // Industrial panel: rivets in the corners, recessed seam at the tile border.
  metalPanel: { size: 256, repeatUnits: 112 },
  // `wood` with a visible plank gap every quarter tile.
  woodPlank: { size: 264, repeatUnits: 96 },
  // Transparent radar base (the HUD overlays the real map brushes on top).
  radar: { size: 1024, repeatUnits: 1 },
};

export function textureRecipe(name: ProcTextureName): TextureRecipe {
  return TEXTURE_RECIPES[name];
}

// ---------------------------------------------------------------------------
// UV tiling contract (pure data, unit-testable without a canvas)
//
// The map renderer merges hundreds of brushes into ONE mesh per material, so one
// texture object is shared by brushes of wildly different sizes. Three.js keeps a
// single `map.repeat` per texture, which therefore CANNOT express per-brush
// tiling. The resolution: the geometry builder owns tiling and bakes it into the
// vertex UVs,
//
//     uv *= worldSize / uvTileFactor(worldSize, brush.texScale)
//
// and `map.repeat` is pinned to (1, 1) forever (see materials.ts).
// ---------------------------------------------------------------------------

/**
 * Effective world units per texture tile.
 * `texScale` is the per-brush hint: 0 / undefined / non-finite / negative all
 * fall back to the recipe default, so a map author may leave the field out.
 */
export function resolveTexScale(texScale: number | undefined, recipe: TextureRecipe): number {
  return typeof texScale === 'number' && Number.isFinite(texScale) && texScale > 0
    ? texScale
    : recipe.repeatUnits;
}

/**
 * World units per tile for a brush of the given world size (one axis).
 * `texScale: 0` falls back to the recipe default rather than producing a
 * division by zero or a degenerate tiling.
 */
export function uvTileFactor(
  brushSize: number,
  texScale: number | undefined,
  recipe: TextureRecipe,
): number {
  const unit = resolveTexScale(texScale, recipe);
  // A zero-size brush has no surface, but must still yield a finite factor.
  return Number.isFinite(brushSize) && brushSize > 0 ? brushSize / unit : 0;
}

/** Per-axis UV multiplication factors; currently isotropic (U and V share a unit). */
export function uvScalePair(
  sizeU: number,
  sizeV: number,
  texScale: number | undefined,
  recipe: TextureRecipe,
): [number, number] {
  return [uvTileFactor(sizeU, texScale, recipe), uvTileFactor(sizeV, texScale, recipe)];
}

// ---------------------------------------------------------------------------
// Canvas access
// ---------------------------------------------------------------------------

let cachedDoc: Document | null | undefined;

function getDocument(): Document | null {
  if (cachedDoc === undefined) {
    cachedDoc = typeof document !== 'undefined' ? document : null;
  }
  return cachedDoc;
}

/**
 * Structural type for a 2-D drawing context. Both
 * `HTMLCanvasElement.getContext('2d')` and
 * `OffscreenCanvas.getContext('2d')` are assignable to it, which keeps the
 * helpers below free of `any`.
 */
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// ---------------------------------------------------------------------------
// Wrapping helpers — "draw each feature up to 4 times at the wrapped offsets".
// ---------------------------------------------------------------------------

/** Wraps a possibly out-of-range coordinate into the [0, size) tile. */
function wrapPos(p: number, size: number): number {
  return ((p % size) + size) % size;
}

/**
 * Draws one feature four times: at the wrapped position and offset by (0,0),
 * (+size,0), (0,+size), (+size,+size). Features that overhang an edge are also
 * painted on the opposite edge, so the tile closes seamlessly.
 */
function paintWrapped(
  ctx: Ctx2D,
  size: number,
  x: number,
  y: number,
  draw: (cx: number, cy: number) => void,
): void {
  const wx = wrapPos(x, size);
  const wy = wrapPos(y, size);
  for (let oy = 0; oy <= 1; oy++) {
    for (let ox = 0; ox <= 1; ox++) {
      draw(wx + ox * size, wy + oy * size);
    }
  }
}

/** Same four-offset rule, but for a polyline: the path is rebuilt per offset. */
function strokeWrapped(
  ctx: Ctx2D,
  size: number,
  points: readonly (readonly number[])[],
  stroke: () => void,
): void {
  let minX = Infinity;
  let minY = Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
  }
  const dx0 = -wrapPos(minX, size);
  const dy0 = -wrapPos(minY, size);
  for (let oy = 0; oy <= 1; oy++) {
    for (let ox = 0; ox <= 1; ox++) {
      const dx = dx0 + ox * size;
      const dy = dy0 + oy * size;
      ctx.beginPath();
      ctx.moveTo(points[0][0] + dx, points[0][1] + dy);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0] + dx, points[i][1] + dy);
      stroke();
    }
  }
}

/** Convenience wrapper for a single straight, wrapped stroke. */
function strokeLineWrapped(
  ctx: Ctx2D,
  size: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  style: string,
  width: number,
): void {
  if (width <= 0) return;
  ctx.save();
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  strokeWrapped(ctx, size, [[x0, y0], [x1, y1]], () => ctx.stroke());
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Linear RGB (0..1) -> `rgb()` string. */
function rgb(r: number, g: number, b: number): string {
  return `rgb(${Math.round(clamp01(r) * 255)},${Math.round(clamp01(g) * 255)},${Math.round(clamp01(b) * 255)})`;
}

/** Same but with alpha; used by every stamp (pits, cracks, rivets, glows). */
function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${Math.round(clamp01(r) * 255)},${Math.round(clamp01(g) * 255)},${Math.round(clamp01(b) * 255)},${clamp01(a)})`;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Smootheststep on the [lo, hi] edge; 0 outside, 1 inside. Used for masks. */
function boxMask(v: number, lo: number, hi: number): number {
  if (v <= lo || v >= hi) return 0;
  const t = (v - lo) / (hi - lo);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

/**
 * Seamless periodic value noise.
 *
 * Lattice coordinates are wrapped with `mod(..., grid)`, so the field has period
 * `grid`: sampling at x and x+grid returns the identical value and the texture
 * tiles. `smoothstep` on the cell fraction hides the lattice.
 */
function makePeriodicNoise(seed: number, grid = 256): (x: number, y: number) => number {
  const rnd = mulberry32(seed);
  const values = new Float32Array(grid * grid);
  for (let i = 0; i < values.length; i++) values[i] = rnd();

  function valueAt(ix: number, iy: number): number {
    const x = ((ix % grid) + grid) % grid;
    const y = ((iy % grid) + grid) % grid;
    return values[y * grid + x];
  }

  return function sample(x: number, y: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    let tx = x - x0;
    let ty = y - y0;
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    const a = valueAt(x0, y0);
    const b = valueAt(x0 + 1, y0);
    const c = valueAt(x0, y0 + 1);
    const d = valueAt(x0 + 1, y0 + 1);
    const top = a + (b - a) * tx;
    const bottom = c + (d - c) * tx;
    return top + (bottom - top) * ty;
  };
}

/** 1-D periodic value noise; used for row/column modulation (bedding, ripples). */
function makePeriodicNoise1D(seed: number, grid = 256): (x: number) => number {
  const rnd = mulberry32(seed);
  const values = new Float32Array(grid);
  for (let i = 0; i < grid; i++) values[i] = rnd();

  function at(i: number): number {
    return values[((i % grid) + grid) % grid];
  }

  return function sample(x: number): number {
    const x0 = Math.floor(x);
    let t = x - x0;
    t = t * t * (3 - 2 * t);
    const a = at(x0);
    const b = at(x0 + 1);
    return a + (b - a) * t;
  };
}

// ---------------------------------------------------------------------------
// Per-pixel albedo stages.
//
// Every painter builds a linear-RGB Float32 buffer, applies its noise stages,
// converts the buffer to 8-bit sRGB and then stamps the vector details on top.
// Keeping colour maths in float keeps it independent of the 8-bit buffer.
// ---------------------------------------------------------------------------

type RgbStage = (dst: Float32Array, size: number, seed: number) => void;

/** Fills `dst` with `base` modulated by coarse + fine periodic noise. */
function fillNoise(
  dst: Float32Array,
  size: number,
  seed: number,
  base: Rgb,
  coarsePeriod: number,
  coarseAmount: number,
  finePeriod: number,
  fineAmount: number,
): void {
  const coarse = makePeriodicNoise(seed, coarsePeriod);
  const fine = makePeriodicNoise(seed ^ 0x5bf03635, finePeriod);
  for (let y = 0; y < size; y++) {
    const cy = (y / size) * coarsePeriod;
    const fy = (y / size) * finePeriod;
    for (let x = 0; x < size; x++) {
      const cx = (x / size) * coarsePeriod;
      const fx = (x / size) * finePeriod;
      const v = 1 + (coarse(cx, cy) - 0.5) * coarseAmount + (fine(fx, fy) - 0.5) * fineAmount;
      const i = (y * size + x) * 3;
      dst[i] = base[0] * v;
      dst[i + 1] = base[1] * v;
      dst[i + 2] = base[2] * v;
    }
  }
}

/** Multiplies the albedo by a per-texel shading factor (typically ~[0.7, 1.3]). */
function modulatePixels(
  dst: Float32Array,
  size: number,
  factor: (x: number, y: number, out: Rgb) => void,
): void {
  const f: Rgb = [1, 1, 1];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      f[0] = 1;
      f[1] = 1;
      f[2] = 1;
      factor(x, y, f);
      const i = (y * size + x) * 3;
      dst[i] *= f[0];
      dst[i + 1] *= f[1];
      dst[i + 2] *= f[2];
    }
  }
}

/** Converts a linear albedo buffer to 8-bit sRGB bytes and writes it. */
function paintToCanvas(ctx: Ctx2D, size: number, dst: Float32Array): void {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let p = 0, i = 0; i < dst.length; i += 3, p += 4) {
    // Integer sRGB-ish encode: an albedo map does not need a precise transfer
    // curve, and this avoids a pow() per channel per texel.
    d[p] = clamp255(dst[i] * 255 + 0.5) | 0;
    d[p + 1] = clamp255(dst[i + 1] * 255 + 0.5) | 0;
    d[p + 2] = clamp255(dst[i + 2] * 255 + 0.5) | 0;
    d[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** Parses `#rrggbb` (or `0xrrggbb`) into linear-ish float RGB. */
function hexToRgb(hex: string): Rgb {
  const v = parseInt(hex.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/**
 * Warm, desaturated Dust palettes in the #c2a678 family. Declared as hex so the
 * colours are greppable and comparable against the spec.
 */
const PALETTE = {
  sandstone: hexToRgb('#c2a678'),
  concrete: hexToRgb('#9a9a97'),
  wood: hexToRgb('#8a5f38'),
  metal: hexToRgb('#a9adb3'),
  sand: hexToRgb('#d8c98a'),
  glass: hexToRgb('#dfeaf2'),
  flesh: hexToRgb('#a94a44'),
  water: hexToRgb('#22454a'),
  crate: hexToRgb('#75512e'),
  woodPlank: hexToRgb('#82592f'),
  brickSand: hexToRgb('#c4a878'),
  metalPanel: hexToRgb('#9ba1a7'),
} as const;

// ---------------------------------------------------------------------------
// Material character stages
// ---------------------------------------------------------------------------

/** Fine-grained tan stone: sand grain + cement matrix variety. */
const stageSandstone: RgbStage = (dst, size, seed) => {
  const fine = makePeriodicNoise(seed ^ 0x9e3779b9, 256);
  const medium = makePeriodicNoise(seed ^ 0x85ebca6b, 64);
  modulatePixels(dst, size, (x, y, f) => {
    const a = fine((x / size) * 256, (y / size) * 256) - 0.5;
    const b = medium((x / size) * 64, (y / size) * 64) - 0.5;
    const v = 1 + a * 0.3 + b * 0.22;
    f[0] = v;
    f[1] = v * (1 + b * 0.05); // the matrix reads a touch cooler than the grain
    f[2] = v * (1 + b * 0.02);
  });
};

/** Cool mid-grey: coarse speckle plus broader patches. */
const stageConcrete: RgbStage = (dst, size, seed) => {
  const grain = makePeriodicNoise(seed ^ 0x27d4eb2f, 256);
  const patch = makePeriodicNoise(seed ^ 0x165667b1, 32);
  modulatePixels(dst, size, (x, y, f) => {
    const a = grain((x / size) * 256, (y / size) * 256) - 0.5;
    const b = patch((x / size) * 32, (y / size) * 32) - 0.5;
    const v = 1 + a * 0.34 + b * 0.26;
    f[0] = v;
    f[1] = v * 0.995;
    f[2] = v * 0.985;
  });
};

/** Long vertical grain streaks: high frequency in X, slow in Y. */
const stageWood: RgbStage = (dst, size, seed) => {
  const streak = makePeriodicNoise(seed ^ 0x2545f491, 128);
  const fine = makePeriodicNoise(seed ^ 0x94d049bb, 256);
  modulatePixels(dst, size, (x, y, f) => {
    const a = streak((x / size) * 128, (y / size) * 4) - 0.5;
    const b = fine((x / size) * 256, (y / size) * 256) - 0.5;
    const v = 1 + a * 0.44 + b * 0.1;
    f[0] = v;
    f[1] = v * 0.97;
    f[2] = v * 0.93;
  });
};

/** Brushed steel: very high frequency in X, almost constant in Y. */
const stageMetal: RgbStage = (dst, size, seed) => {
  const brush = makePeriodicNoise(seed ^ 0x7feb352d, 256);
  const patch = makePeriodicNoise(seed ^ 0x846ca68b, 16);
  modulatePixels(dst, size, (x, y, f) => {
    const a = brush((x / size) * 256, (y / size) * 3) - 0.5;
    const b = patch((x / size) * 16, (y / size) * 16) - 0.5;
    const v = 1 + a * 0.16 + b * 0.1;
    f[0] = v * 0.99;
    f[1] = v;
    f[2] = v * 1.03;
  });
};

/** Pale sand: very fine high-frequency grain plus large gentle blotches. */
const stageSand: RgbStage = (dst, size, seed) => {
  const grain = makePeriodicNoise(seed ^ 0x1b873593, 256);
  const blotch = makePeriodicNoise(seed ^ 0xcc9e2d51, 8);
  modulatePixels(dst, size, (x, y, f) => {
    const a = grain((x / size) * 256, (y / size) * 256) - 0.5;
    const b = blotch((x / size) * 8, (y / size) * 8) - 0.5;
    const v = 1 + a * 0.22 + b * 0.26;
    f[0] = v;
    f[1] = v * 0.99;
    f[2] = v * 0.95;
  });
};

/** Flat flesh tone with a faint mottle; VFX-only, never world geometry. */
const stageFlesh: RgbStage = (dst, size, seed) => {
  const mottle = makePeriodicNoise(seed ^ 0x4cf5ad43, 16);
  modulatePixels(dst, size, (x, y, f) => {
    const b = mottle((x / size) * 16, (y / size) * 16) - 0.5;
    const v = 1 + b * 0.1;
    f[0] = v;
    f[1] = v * 0.96;
    f[2] = v * 0.96;
  });
};

/** Dark blue-green water with soft ripple bands (rows only -> seamless in X). */
const stageWater: RgbStage = (dst, size, seed) => {
  const ripple = makePeriodicNoise1D(seed ^ 0x9e3779b1, 64);
  const noise = makePeriodicNoise(seed ^ 0xc2b2ae35, 64);
  modulatePixels(dst, size, (x, y, f) => {
    const r = ripple((y / size) * 6) * 0.5 + ripple((y / size) * 17 + 3) * 0.28;
    const n = noise((x / size) * 32, (y / size) * 32) - 0.5;
    const v = (1 + (r - 0.39) * 0.34) * (1 + n * 0.14);
    f[0] = v * 0.97;
    f[1] = v;
    f[2] = v * 1.02;
  });
};

/** Darker crate plank face, before the frame and braces are stamped. */
const stageCrateFace: RgbStage = (dst, size, seed) => {
  const plank = makePeriodicNoise(seed ^ 0x2545f493, 128);
  const fine = makePeriodicNoise(seed ^ 0x94d049bd, 256);
  modulatePixels(dst, size, (x, y, f) => {
    // 4 horizontal planks, each a slightly different tone (deterministic).
    const row = Math.min(3, Math.floor((y / size) * 4));
    const t = 0.88 + 0.05 * (row % 3);
    const a = plank((x / size) * 128, (y / size) * 8) - 0.5;
    const b = fine((x / size) * 256, (y / size) * 256) - 0.5;
    const v = (1 + a * 0.28 + b * 0.12) * t;
    f[0] = v;
    f[1] = v * 0.96;
    f[2] = v * 0.9;
  });
};

/** Vertical planks with a visible gap every quarter tile (4 divides the tile). */
const stageWoodPlank: RgbStage = (dst, size, seed) => {
  const streak = makePeriodicNoise(seed ^ 0x2545f497, 128);
  const fine = makePeriodicNoise(seed ^ 0x94d049bf, 256);
  modulatePixels(dst, size, (x, y, f) => {
    const a = streak((x / size) * 128, (y / size) * 4) - 0.5;
    const b = fine((x / size) * 256, (y / size) * 256) - 0.5;
    const v = 1 + a * 0.4 + b * 0.12;
    f[0] = v;
    f[1] = v * 0.97;
    f[2] = v * 0.92;
  });
};

/**
 * Sandy brick courses with mortar lines.
 * Periods (4 courses of 66, 2 bricks of 132 with a half-brick stagger on even
 * rows) divide the 264 tile exactly, so both the courses and the stagger wrap.
 */
const stageBrickSand: RgbStage = (dst, size, seed) => {
  const brick = makePeriodicNoise(seed ^ 0x11fe1b3d, 32);
  const grain = makePeriodicNoise(seed ^ 0x6b43a9b5, 256);
  modulatePixels(dst, size, (x, y, f) => {
    const rowH = size / 4; // 4 courses
    const brickW = size / 2; // 2 bricks per course
    const row = Math.floor((y / rowH) % 4);
    const bx = x + (row % 2) * (brickW / 2);
    // Distance to the nearest mortar line, as a fraction of the period.
    const dyl = Math.abs((((y % rowH) + rowH) % rowH) - rowH / 2);
    const lineH = ((rowH / 2 - dyl) / rowH) * 2;
    const dxl = Math.abs((((bx % brickW) + brickW) % brickW) - brickW / 2);
    const lineV = ((brickW / 2 - dxl) / brickW) * 2;
    const mortar = boxMask(Math.max(lineH, lineV), 0.02, 0.19);
    const bv = 1 + (brick((bx / size) * 32, (y / size) * 32) - 0.5) * 0.24;
    const gv = 1 + (grain((x / size) * 256, (y / size) * 256) - 0.5) * 0.2;
    // Mortar is a flatter, greyer, darker tone than the brick.
    const brickV = bv * gv;
    f[0] = brickV * (1 - mortar) + 0.62 * mortar;
    f[1] = brickV * 0.99 * (1 - mortar) + 0.6 * mortar;
    f[2] = brickV * 0.95 * (1 - mortar) + 0.56 * mortar;
  });
};

/** Industrial panel: the recessed seam at the tile border is a generated mask. */
const stageMetalPanel: RgbStage = (dst, size, seed) => {
  const brush = makePeriodicNoise(seed ^ 0x7feb352d, 256);
  const patch = makePeriodicNoise(seed ^ 0x846ca68b, 32);
  modulatePixels(dst, size, (x, y, f) => {
    const a = brush((x / size) * 256, (y / size) * 3) - 0.5;
    const b = patch((x / size) * 32, (y / size) * 32) - 0.5;
    // Distance to the tile border, normalised: the seam is a border band, so it
    // is continuous when panels are laid side by side.
    const u = Math.min(x, y, size - 1 - x, size - 1 - y) / size;
    const seam = 1 - boxMask(u, 0.055, 0.1) * 0.34 - boxMask(u, 0, 0.012) * 0.16;
    const v = (1 + a * 0.14 + b * 0.14) * seam;
    f[0] = v * 0.99;
    f[1] = v;
    f[2] = v * 1.03;
  });
};

// ---------------------------------------------------------------------------
// Stamped details (cracks, pits, knots, rivets, braces, radar grid)
// ---------------------------------------------------------------------------

/** Dark irregular pitting with a soft AO falloff. */
function stampSandstonePits(ctx: Ctx2D, size: number, rnd: () => number): void {
  const count = Math.round(size * 0.9);
  for (let i = 0; i < count; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 0.7 + rnd() * 2.4;
    const a = 0.1 + rnd() * 0.2;
    paintWrapped(ctx, size, x, y, (cx, cy) => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, rgba(0.16, 0.12, 0.07, a));
      g.addColorStop(0.65, rgba(0.22, 0.17, 0.1, a * 0.55));
      g.addColorStop(1, rgba(0.22, 0.17, 0.1, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

/** Sparse dark aggregate dots for concrete. */
function stampAggregate(ctx: Ctx2D, size: number, rnd: () => number): void {
  const count = Math.round(size * 0.22);
  for (let i = 0; i < count; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 0.8 + rnd() * 2.0;
    const tone = 0.1 + rnd() * 0.16;
    const a = 0.55 + rnd() * 0.3;
    paintWrapped(ctx, size, x, y, (cx, cy) => {
      ctx.fillStyle = rgba(tone, tone, tone * 0.98, a);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

/** Hairline cracks as short random walks, stroked at the 4 wrapped offsets. */
function stampCracks(
  ctx: Ctx2D,
  size: number,
  rnd: () => number,
  count: number,
  width: number,
  alpha: number,
): void {
  for (let c = 0; c < count; c++) {
    let x = rnd() * size;
    let y = rnd() * size;
    const steps = 5 + Math.floor(rnd() * 7);
    let a = rnd() * Math.PI * 2;
    const pts: number[][] = [[x, y]];
    for (let s = 0; s < steps; s++) {
      a += (rnd() - 0.5) * 1.5;
      x += Math.cos(a) * (size / 18);
      y += Math.sin(a) * (size / 18);
      pts.push([x, y]);
    }
    ctx.save();
    ctx.strokeStyle = rgba(0.08, 0.08, 0.08, alpha);
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokeWrapped(ctx, size, pts, () => ctx.stroke());
    ctx.restore();
  }
}

/** Wood knots: a dark core with concentric grain rings. */
function stampKnots(ctx: Ctx2D, size: number, rnd: () => number, count: number, dark: Rgb): void {
  for (let i = 0; i < count; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = size * (0.018 + rnd() * 0.035);
    paintWrapped(ctx, size, x, y, (cx, cy) => {
      ctx.fillStyle = rgba(dark[0] * 0.6, dark[1] * 0.6, dark[2] * 0.6, 0.6);
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * 1.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(dark[0] * 0.4, dark[1] * 0.4, dark[2] * 0.4, 0.5);
      ctx.lineWidth = Math.max(1, size / 256);
      for (let k = 1; k <= 3; k++) {
        ctx.beginPath();
        ctx.ellipse(cx, cy, r * (0.45 + k * 0.28), r * (0.7 + k * 0.42), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  }
}

/** Fine, roughly horizontal metal scratches (bright and dark). */
function stampScratches(ctx: Ctx2D, size: number, rnd: () => number, count: number): void {
  for (let i = 0; i < count; i++) {
    const x0 = rnd() * size;
    const y0 = rnd() * size;
    const len = size * (0.05 + rnd() * 0.3);
    const ang = (rnd() - 0.5) * 0.18;
    const bright = rnd() < 0.5;
    const style = bright
      ? rgba(0.95, 0.96, 0.98, 0.1 + rnd() * 0.22)
      : rgba(0.06, 0.06, 0.07, 0.1 + rnd() * 0.2);
    strokeLineWrapped(ctx, size, x0, y0, x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len, style, 0.6 + rnd() * 1.1);
  }
}

/** Long faint glass scratches in every direction. */
function stampGlassScratches(ctx: Ctx2D, size: number, rnd: () => number): void {
  for (let i = 0; i < 26; i++) {
    const x0 = rnd() * size;
    const y0 = rnd() * size;
    const len = size * (0.12 + rnd() * 0.5);
    const ang = rnd() * Math.PI * 2;
    const bright = rnd() < 0.6;
    const style = bright
      ? rgba(1, 1, 1, 0.16 + rnd() * 0.18)
      : rgba(0.55, 0.62, 0.68, 0.1 + rnd() * 0.12);
    strokeLineWrapped(ctx, size, x0, y0, x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len, style, 0.5 + rnd() * 0.9);
  }
}

/** Plank gaps every quarter tile: a pure column mask, seamless by construction. */
function stampWoodPlankGaps(ctx: Ctx2D, size: number, rnd: () => number): void {
  const gap = Math.max(2, size / 64);
  for (let i = 0; i < 4; i++) {
    const x = (i / 4) * size;
    paintWrapped(ctx, size, x - gap / 2, 0, (cx) => {
      ctx.fillStyle = rgba(0.04, 0.03, 0.02, 0.72);
      ctx.fillRect(cx, 0, gap, size);
    });
    // Light bevel on the other side of the groove.
    paintWrapped(ctx, size, x + gap / 2, 0, (cx) => {
      ctx.fillStyle = rgba(0.85, 0.75, 0.6, 0.16);
      ctx.fillRect(cx, 0, 1.5, size);
    });
    // Random nicks along the gap so it is not a perfectly clean line.
    for (let k = 0; k < 6; k++) {
      const y = rnd() * size;
      const w = gap * 1.4;
      const h = 1 + rnd() * 2;
      paintWrapped(ctx, size, x, y, (cx, cy) => {
        ctx.fillStyle = rgba(0.05, 0.04, 0.03, 0.4);
        ctx.fillRect(cx - gap / 2, cy, w, h);
      });
    }
  }
}

/**
 * Crate frame + braces + nail heads. The frame sits exactly on the tile border,
 * so a wall of crate brushes shows one continuous frame and no tiling seam.
 */
function stampCrateFrame(ctx: Ctx2D, size: number, rnd: () => number): void {
  const frame = Math.max(4, size * 0.075);
  ctx.fillStyle = rgba(0.14, 0.085, 0.045, 0.85);
  ctx.fillRect(0, 0, size, frame);
  ctx.fillRect(0, size - frame, size, frame);
  ctx.fillRect(0, 0, frame, size);
  ctx.fillRect(size - frame, 0, frame, size);
  // Bevel inside the frame.
  ctx.strokeStyle = rgba(0.72, 0.55, 0.34, 0.22);
  ctx.lineWidth = Math.max(1, size / 192);
  ctx.strokeRect(frame * 0.55, frame * 0.55, size - frame * 1.1, size - frame * 1.1);
  // Diagonal braces, drawn wrapped so they run corner to corner across the tile.
  ctx.save();
  ctx.strokeStyle = rgba(0.2, 0.125, 0.065, 0.6);
  ctx.lineWidth = frame * 0.8;
  ctx.lineCap = 'butt';
  strokeWrapped(ctx, size, [[0, 0], [size, size]], () => ctx.stroke());
  strokeWrapped(ctx, size, [[size, 0], [0, size]], () => ctx.stroke());
  ctx.restore();
  // Nail heads: a couple on each of the top and bottom frame beams.
  for (let i = 0; i < 8; i++) {
    const x = rnd() * size;
    const y = rnd() < 0.5 ? frame * 0.5 : size - frame * 0.5;
    const r = Math.max(1, size / 160);
    paintWrapped(ctx, size, x, y, (cx, cy) => {
      ctx.fillStyle = rgba(0.1, 0.09, 0.08, 0.75);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

/** Rivets in the four panel corners, each with a shadowed countersink. */
function stampPanelRivets(ctx: Ctx2D, size: number): void {
  const inset = size * 0.085;
  const r = Math.max(2, size * 0.022);
  const spots: [number, number][] = [
    [inset, inset],
    [size - inset, inset],
    [inset, size - inset],
    [size - inset, size - inset],
  ];
  for (const [x, y] of spots) {
    paintWrapped(ctx, size, x, y, (cx, cy) => {
      const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r * 1.6);
      g.addColorStop(0, rgba(0.82, 0.84, 0.87, 0.95));
      g.addColorStop(0.55, rgba(0.46, 0.48, 0.51, 0.95));
      g.addColorStop(1, rgba(0.12, 0.13, 0.14, 0.9));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(0.05, 0.05, 0.06, 0.6);
      ctx.lineWidth = Math.max(1, size / 256);
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.25, 0, Math.PI * 2);
      ctx.stroke();
    });
  }
}

/** Soft water ripple bands. Kept subtle: the wet look comes from the material. */
function stampWaterRipples(ctx: Ctx2D, size: number): void {
  for (let i = 0; i < 3; i++) {
    const y = ((i + 0.5) / 3) * size;
    const h = size * 0.055;
    ctx.fillStyle = rgba(0.62, 0.76, 0.78, 0.07);
    ctx.fillRect(0, y - h / 2, size, h);
  }
}

/** Large soft blotches for sand (no visible lattice edges). */
function stampSandBlotches(ctx: Ctx2D, size: number, rnd: () => number): void {
  for (let i = 0; i < 26; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = size * (0.06 + rnd() * 0.18);
    const dark = rnd() < 0.55;
    paintWrapped(ctx, size, x, y, (cx, cy) => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      if (dark) {
        g.addColorStop(0, rgba(0.52, 0.46, 0.3, 0.16));
        g.addColorStop(1, rgba(0.52, 0.46, 0.3, 0));
      } else {
        g.addColorStop(0, rgba(0.98, 0.94, 0.78, 0.14));
        g.addColorStop(1, rgba(0.98, 0.94, 0.78, 0));
      }
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

/** Radar base: transparent background, a light floor tone and a subtle grid. */
function stampRadarBase(ctx: Ctx2D, size: number): void {
  const step = size / 16; // 16 divisions, a divisor of `size`, so it is seamless
  const floor = ctx.createLinearGradient(0, 0, 0, size);
  floor.addColorStop(0, 'rgba(146,136,112,0.34)');
  floor.addColorStop(1, 'rgba(126,116,96,0.34)');
  ctx.fillStyle = floor;
  ctx.fillRect(0, 0, size, size);
  // Minor grid: +0.5 keeps a 1px line on a pixel centre instead of two.
  ctx.strokeStyle = 'rgba(206,196,168,0.16)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 16; i++) {
    const p = i * step + 0.5;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
  // Major 4x4 grid.
  ctx.strokeStyle = 'rgba(214,204,176,0.24)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    const p = i * step * 4;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Tile painters — one per ProcTextureName
// ---------------------------------------------------------------------------

interface PaintSpec {
  base: Rgb;
  coarsePeriod: number;
  coarseAmount: number;
  finePeriod: number;
  fineAmount: number;
  stage?: RgbStage;
  stamp?: (ctx: Ctx2D, rnd: () => number) => void;
  /** Called last for hand-written vector work that is not a simple stamp. */
  finish?: (ctx: Ctx2D, rnd: () => number) => void;
}

/** Runs the whole opaque-material pipeline for one tile. */
function paintOpaque(canvas: HTMLCanvasElement, size: number, seed: number, spec: PaintSpec): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`[textures] 2D canvas context unavailable (size ${size})`);
  const px = new Float32Array(size * size * 3);
  fillNoise(px, size, seed, spec.base, spec.coarsePeriod, spec.coarseAmount, spec.finePeriod, spec.fineAmount);
  if (spec.stage) spec.stage(px, size, seed);
  paintToCanvas(ctx, size, px);
  const rnd = mulberry32(seed ^ 0x1d872b41);
  if (spec.stamp) spec.stamp(ctx, rnd);
  if (spec.finish) spec.finish(ctx, rnd);
}

const PAINTERS: Record<ProcTextureName, (canvas: HTMLCanvasElement, size: number, seed: number) => void> = {
  sandstone: (canvas, size, seed) => {
    paintOpaque(canvas, size, seed, {
      base: PALETTE.sandstone,
      coarsePeriod: 64,
      coarseAmount: 0.22,
      finePeriod: 256,
      fineAmount: 0.3,
      stage: stageSandstone,
      stamp: (ctx, rnd) => {
        stampSandstonePits(ctx, size, rnd);
      },
      finish: (ctx) => {
        // Faint horizontal bedding: a 1-D periodic noise varying by row only, so
        // the left and right edges match exactly.
        const bed = makePeriodicNoise1D(seed ^ 0x2f4b1f37, 64);
        for (let y = 0; y < size; y++) {
          const a = Math.max(0, (bed((y / size) * 12) - 0.66) / 0.34);
          if (a <= 0.01) continue;
          ctx.fillStyle = rgba(0.42, 0.33, 0.21, a * 0.42);
          ctx.fillRect(0, y, size, 1);
        }
      },
    });
  },

  concrete: (canvas, size, seed) => {
    paintOpaque(canvas, size, seed, {
      base: PALETTE.concrete,
      coarsePeriod: 32,
      coarseAmount: 0.26,
      finePeriod: 256,
      fineAmount: 0.34,
      stage: stageConcrete,
      stamp: (ctx, rnd) => {
        stampAggregate(ctx, size, rnd);
        stampCracks(ctx, size, rnd, 5, Math.max(1, size / 320), 0.3);
      },
    });
  },

  wood: (canvas, size, seed) => {
    paintOpaque(canvas, size, seed, {
      base: PALETTE.wood,
      coarsePeriod: 64,
      coarseAmount: 0.16,
      finePeriod: 256,
      fineAmount: 0.14,
      stage: stageWood,
      stamp: (ctx, rnd) => {
        stampKnots(ctx, size, rnd, 2 + Math.floor(rnd() * 2), PALETTE.wood);
      },
      finish: (ctx) => {
        // Plank-edge darkening on the tile border: column 0 and column size-1
        // coincide once tiled, so it reads as the seam between two boards.
        const edge = Math.max(2, size * 0.03);
        const g = ctx.createLinearGradient(0, 0, edge, 0);
        g.addColorStop(0, 'rgba(24,15,8,0.55)');
        g.addColorStop(1, 'rgba(24,15,8,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, edge, size);
        // Mirrored copy on the far edge (drawn directly, not wrapped: this is
        // deliberate edge treatment, not a feature that must bleed across).
        ctx.save();
        ctx.translate(size, 0);
        ctx.scale(-1, 1);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, edge, size);
        ctx.restore();
      },
    });
  },

  metal: (canvas, size, seed) => {
    paintOpaque(canvas, size, seed, {
      base: PALETTE.metal,
      coarsePeriod: 16,
      coarseAmount: 0.1,
      finePeriod: 256,
      fineAmount: 0.16,
      stage: stageMetal,
      stamp: (ctx, rnd) => {
        stampScratches(ctx, size, rnd, 22);
      },
    });
  },

  sand: (canvas, size, seed) => {
    paintOpaque(canvas, size, seed, {
      base: PALETTE.sand,
      coarsePeriod: 8,
      coarseAmount: 0.26,
      finePeriod: 256,
      fineAmount: 0.22,
      stage: stageSand,
      stamp: (ctx, rnd) => {
        stampSandBlotches(ctx, size, rnd);
      },
    });
  },

  glass: (canvas, size, seed) => {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('[textures] 2D canvas context unavailable (glass)');
    ctx.clearRect(0, 0, size, size);
    // Very low alpha: the pane reads as a faint haze and the world shows through.
    const g = ctx.createLinearGradient(0, 0, size * 0.4, size);
    g.addColorStop(0, 'rgba(206,224,238,0.16)');
    g.addColorStop(0.5, 'rgba(186,208,228,0.08)');
    g.addColorStop(1, 'rgba(206,224,238,0.14)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    stampGlassScratches(ctx, size, mulberry32(seed ^ 0x51ed270b));
  },

  flesh: (canvas, size, seed) => {
    paintOpaque(canvas, size, seed, {
      base: PALETTE.flesh,
      coarsePeriod: 16,
      coarseAmount: 0.1,
      finePeriod: 64,
      fineAmount: 0.06,
      stage: stageFlesh,
      // Deliberately plain: flesh is a flat VFX colour, not a world surface.
    });
  },

  water: (canvas, size, seed) => {
    paintOpaque(canvas, size, seed, {
      base: PALETTE.water,
      coarsePeriod: 64,
      coarseAmount: 0.16,
      finePeriod: 64,
      fineAmount: 0.2,
      stage: stageWater,
      stamp: (ctx) => {
        stampWaterRipples(ctx, size);
      },
    });
  },

  crate: (canvas, size, seed) => {
    paintOpaque(canvas, size, seed, {
      base: PALETTE.crate,
      coarsePeriod: 128,
      coarseAmount: 0.2,
      finePeriod: 256,
      fineAmount: 0.14,
      stage: stageCrateFace,
      stamp: (ctx, rnd) => {
        stampCrateFrame(ctx, size, rnd);
      },
    });
  },

  brickSand: (canvas, size, seed) => {
    paintOpaque(canvas, size, seed, {
      base: PALETTE.brickSand,
      coarsePeriod: 32,
      coarseAmount: 0.22,
      finePeriod: 256,
      fineAmount: 0.2,
      stage: stageBrickSand,
      stamp: (ctx, rnd) => {
        // Small chips where mortar meets brick.
        for (let i = 0; i < 40; i++) {
          const x = rnd() * size;
          const y = rnd() * size;
          const w = 1 + rnd() * 2;
          const h = 1 + rnd() * 2;
          paintWrapped(ctx, size, x, y, (cx, cy) => {
            ctx.fillStyle = rgba(0.45, 0.4, 0.32, 0.18);
            ctx.fillRect(cx, cy, w, h);
          });
        }
      },
    });
  },

  metalPanel: (canvas, size, seed) => {
    paintOpaque(canvas, size, seed, {
      base: PALETTE.metalPanel,
      coarsePeriod: 32,
      coarseAmount: 0.14,
      finePeriod: 256,
      fineAmount: 0.14,
      stage: stageMetalPanel,
      stamp: (ctx, rnd) => {
        stampScratches(ctx, size, rnd, 8);
        stampPanelRivets(ctx, size);
      },
    });
  },

  woodPlank: (canvas, size, seed) => {
    paintOpaque(canvas, size, seed, {
      base: PALETTE.woodPlank,
      coarsePeriod: 128,
      coarseAmount: 0.18,
      finePeriod: 256,
      fineAmount: 0.12,
      stage: stageWoodPlank,
      stamp: (ctx, rnd) => {
        stampKnots(ctx, size, rnd, 3, PALETTE.woodPlank);
        stampWoodPlankGaps(ctx, size, rnd);
      },
    });
  },

  radar: (canvas, size) => {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('[textures] 2D canvas context unavailable (radar)');
    ctx.clearRect(0, 0, size, size);
    stampRadarBase(ctx, size);
  },
};

// ---------------------------------------------------------------------------
// Tile entry point
// ---------------------------------------------------------------------------

/** Per-(name, size, seed) paint cache: redrawing a 1024² radar twice is waste. */
const tileCache = new Map<string, HTMLCanvasElement>();
let generation = 0;

/** Drops the drawing cache; `getTexture` will repaint from scratch. */
export function resetTileCache(): void {
  tileCache.clear();
  generation++;
}

/**
 * Draw one tile into a fresh canvas. Deterministic for a given seed.
 *
 * Throws a clear error when there is no DOM (Node/vitest): every painter needs a
 * canvas, which is why the pure decisions (recipes, UV factors, cache keys) are
 * exported separately — the unit tests exercise only those.
 */
export function drawTextureTile(name: ProcTextureName, size: number, seed: number): HTMLCanvasElement {
  const px = Math.max(8, Math.round(size));
  const key = `${generation}|${name}|${px}|${seed}`;
  const hit = tileCache.get(key);
  if (hit) return hit;

  const doc = getDocument();
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error(
      `[textures] cannot draw "${name}": no document/canvas available (Node?). ` +
        'Only textureRecipe / uvTileFactor / materialCacheKey are canvas-free.',
    );
  }
  const canvas = doc.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  PAINTERS[name](canvas, px, seed);
  tileCache.set(key, canvas);
  return canvas;
}

/** Diagnostics: how many painted canvases are cached. */
export function tileCacheSize(): number {
  return tileCache.size;
}

// ---------------------------------------------------------------------------
// THREE.CanvasTexture layer
// ---------------------------------------------------------------------------

/** Default seed for every texture; exported so callers can reuse the same one. */
export const DEFAULT_TEXTURE_SEED = 1337;

const textureCache = new Map<string, THREE.Texture>();

function textureKey(name: ProcTextureName, seed: number): string {
  return `${name}|${seed}`;
}

/**
 * Cached `THREE.CanvasTexture` per (name, seed).
 *
 * `map.repeat` is pinned to (1, 1): a texture is shared by every brush using its
 * material, so per-brush tiling cannot live on the texture. The geometry builder
 * bakes tiling into the vertex UVs instead (`uv *= size / uvTileFactor(...)`);
 * see materials.ts for the full contract.
 */
export function getTexture(name: ProcTextureName, seed = DEFAULT_TEXTURE_SEED): THREE.Texture {
  const key = textureKey(name, seed);
  const hit = textureCache.get(key);
  if (hit) return hit;

  const recipe = TEXTURE_RECIPES[name];
  const canvas = drawTextureTile(name, recipe.size, seed);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1); // geometry UVs own tiling — never change this here
  tex.anisotropy = 4;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  textureCache.set(key, tex);
  return tex;
}

/** Number of live textures; used by diagnostics. */
export function textureCacheSize(): number {
  return textureCache.size;
}

/**
 * Drop every cached texture and painted canvas. Materials holding these textures
 * must be disposed too (see `disposeMaterials`), otherwise their GPU uploads stay
 * alive.
 */
export function disposeTextures(): void {
  for (const tex of textureCache.values()) tex.dispose();
  textureCache.clear();
  resetTileCache();
}
