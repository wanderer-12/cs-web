// =============================================================================
// vfx/Textures.ts — procedurally drawn canvas textures for the VFX layer.
//
// The build ships no image assets (see PLAN.md), so every sprite is painted at
// construction time into one small canvas and wrapped in a CanvasTexture. Each
// texture is ~64-128 px: these are soft additive glows and mottled smoke, so
// mipmaps cost memory and buy nothing — the filter is Linear and the wrap mode
// is clamped (a wrapped sprite bleeds the opposite edge into the glow).
//
// Nothing here is on the per-frame path: all of it runs once, from a
// constructor. VfxSystem.dispose() destroys what this module hands out.
// =============================================================================

import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearFilter,
  NoColorSpace,
  SRGBColorSpace,
} from 'three';

const TAU = Math.PI * 2;

export interface Canvas2D {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/**
 * Canvas + 2D context. Throws rather than returning null: every visual in this
 * module is procedural, so a missing 2D context is a broken environment, not a
 * condition the pools could work around.
 */
export function createCanvas(width: number, height: number): Canvas2D {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[vfx] 2D canvas context unavailable (procedural VFX textures)');
  return { canvas, ctx };
}

export interface TextureOptions {
  /** Color textures (decals, smoke, muzzle glow) are authored in sRGB. */
  srgb?: boolean;
}

/** Wrap a canvas in a texture with the settings every VFX sprite wants. */
export function textureFromCanvas(source: HTMLCanvasElement, opts: TextureOptions = {}): CanvasTexture {
  const tex = new CanvasTexture(source);
  tex.colorSpace = opts.srgb === false ? NoColorSpace : SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Round soft particle: white RGB with a radial alpha ramp. Used by the spark /
 * dust / blood Points clouds under AdditiveBlending, where alpha is what shapes
 * the glow and RGB only carries the tint.
 */
export function createSoftParticleTexture(size = 64): CanvasTexture {
  const { canvas, ctx } = createCanvas(size, size);
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.82)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.26)');
  g.addColorStop(0.82, 'rgba(255,255,255,0.05)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return textureFromCanvas(canvas);
}

/**
 * Mottled smoke puff for the instanced smoke cloud (NormalBlending, so alpha
 * matters here). Several offset radial blobs are painted and then masked with a
 * radial destination-in ramp, which keeps the silhouette soft while giving the
 * interior enough structure that overlapping puffs do not read as one flat
 * circle. Deterministic (fixed seed) so the look cannot drift between runs.
 */
export function createSmokeTexture(size = 64, seed = 0x5f3a1c): CanvasTexture {
  const { canvas, ctx } = createCanvas(size, size);
  const c = size / 2;
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = 0; i < 14; i++) {
    const a = rnd() * TAU;
    const d = rnd() * c * 0.5;
    const r = c * (0.22 + rnd() * 0.34);
    const x = c + Math.cos(a) * d;
    const y = c + Math.sin(a) * d;
    const v = 0.35 + rnd() * 0.45;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${v.toFixed(3)})`);
    g.addColorStop(0.6, `rgba(255,255,255,${(v * 0.4).toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }

  // Soft circular mask: without it the outer blobs leave a hard square edge.
  ctx.globalCompositeOperation = 'destination-in';
  const mask = ctx.createRadialGradient(c, c, c * 0.1, c, c, c * 0.98);
  mask.addColorStop(0, 'rgba(255,255,255,1)');
  mask.addColorStop(0.7, 'rgba(255,255,255,0.85)');
  mask.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';

  return textureFromCanvas(canvas);
}

/**
 * Muzzle flash: an additive star on black (black contributes nothing once the
 * material blends additively, so the shape lives entirely in RGB). A white-hot
 * core, warm bloom and six uneven spikes; the per-shot roll and non-uniform
 * instance scale in Muzzle.ts supply the variety, so one texture is enough.
 */
export function createMuzzleTexture(size = 128, seed = 0x2b1f77): CanvasTexture {
  const { canvas, ctx } = createCanvas(size, size);
  const c = size / 2;
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  ctx.fillStyle = 'rgba(0,0,0,1)';
  ctx.fillRect(0, 0, size, size);

  // Warm bloom around the muzzle.
  const bloom = ctx.createRadialGradient(c, c, 0, c, c, c * 0.72);
  bloom.addColorStop(0.0, 'rgba(255,236,196,0.95)');
  bloom.addColorStop(0.3, 'rgba(255,176,86,0.55)');
  bloom.addColorStop(0.72, 'rgba(190,96,28,0.16)');
  bloom.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, size, size);

  // Spikes: long thin wedges, longest roughly along the barrel (local +X).
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + rnd() * 0.35;
    const len = c * (0.5 + rnd() * 0.48) * (i === 0 ? 1.35 : 1);
    const w = size * (0.02 + rnd() * 0.035);
    const g = ctx.createLinearGradient(c, c, c + Math.cos(a) * len, c + Math.sin(a) * len);
    g.addColorStop(0, 'rgba(255,248,226,0.95)');
    g.addColorStop(0.45, 'rgba(255,196,110,0.5)');
    g.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
    ctx.lineTo(c + Math.cos(a + Math.PI / 2) * w, c + Math.sin(a + Math.PI / 2) * w);
    ctx.lineTo(c + Math.cos(a - Math.PI / 2) * w, c + Math.sin(a - Math.PI / 2) * w);
    ctx.closePath();
    ctx.fill();
  }

  // White-hot core.
  const core = ctx.createRadialGradient(c, c, 0, c, c, c * 0.26);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.55, 'rgba(255,244,214,0.8)');
  core.addColorStop(1, 'rgba(255,210,150,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(c, c, c * 0.26, 0, TAU);
  ctx.fill();

  ctx.globalCompositeOperation = 'source-over';
  return textureFromCanvas(canvas);
}
