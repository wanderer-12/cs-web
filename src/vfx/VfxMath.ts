// =============================================================================
// vfx/VfxMath.ts — pure math + shared constants for the VFX layer.
//
// Deliberately free of three.js and of the DOM. Everything the pools and the
// renderers need to agree on lives here as plain numbers, so the ring-buffer,
// atlas and particle integration logic can be unit-tested with no WebGL context
// (tests/vfx.spec.ts). The sibling modules only turn these numbers into
// instance matrices.
// =============================================================================

import type { SurfaceMaterial, Vec3 } from '../core/types';

// ---------------------------------------------------------------------------
// Draw order contract
// ---------------------------------------------------------------------------
/**
 * `renderOrder` values for the transparent pass. three renders opaque objects
 * first, then transparent ones sorted back-to-front; these orders only have to
 * keep VFX after the opaque world and before the view model, which the renderer
 * (not VFX) owns. The view model is expected to use a value >= 20 — see
 * VfxSystem.md.
 */
export const RENDER_ORDER = {
  /** Bullet holes / scorch marks sit on the world surface. */
  decals: 4,
  /** Tracers and additive sparks. */
  tracers: 10,
  sparks: 11,
  /** Soft (non-additive) dust, blood and debris. */
  particles: 12,
  smoke: 13,
  explosions: 14,
  muzzle: 15,
} as const;

// ---------------------------------------------------------------------------
// Decal atlas
// ---------------------------------------------------------------------------
/**
 * Six tiles in ONE atlas canvas (see Decals.ts). The tile is selected per
 * instance through an instanced UV rect, so all decals share one material.
 */
export const DECAL_TILE_CONCRETE = 0;
export const DECAL_TILE_METAL = 1;
export const DECAL_TILE_WOOD = 2;
export const DECAL_TILE_SAND = 3;
export const DECAL_TILE_GLASS = 4;
/** Explosion scorch mark; only Explosions.ts spawns it. */
export const DECAL_TILE_SCORCH = 5;
export const DECAL_ATLAS_COLS = 6;
export const DECAL_ATLAS_ROWS = 1;
export const DECAL_TILE_COUNT = DECAL_ATLAS_COLS * DECAL_ATLAS_ROWS;

/** Quad size in world units per tile, scaled by the caller for variety. */
export const DECAL_QUAD_SIZE: readonly number[] = [13, 11, 13, 17, 15, 240];

/**
 * Which atlas tile a surface material leaves behind, or -1 when the material
 * leaves no decal at all: flesh bleeds (a puff, not a hole) and water splashes.
 */
export function materialDecalTile(material: SurfaceMaterial): number {
  switch (material) {
    case 'concrete':
    case 'sandstone':
      return DECAL_TILE_CONCRETE;
    case 'metal':
      return DECAL_TILE_METAL;
    case 'wood':
      return DECAL_TILE_WOOD;
    case 'sand':
      return DECAL_TILE_SAND;
    case 'glass':
      return DECAL_TILE_GLASS;
    case 'flesh':
    case 'water':
      return -1;
    default:
      // Unknown material (map data is data, not a closed set at runtime).
      return DECAL_TILE_CONCRETE;
  }
}

/** UV rect of one atlas tile, written as [u0, v0, du, dv] into `out`. */
export function decalTileUvRect(tile: number, out: number[]): number[] {
  const t = Math.max(0, Math.min(DECAL_TILE_COUNT - 1, Math.floor(tile)));
  const col = t % DECAL_ATLAS_COLS;
  const row = Math.floor(t / DECAL_ATLAS_COLS);
  out[0] = col / DECAL_ATLAS_COLS;
  out[1] = row / DECAL_ATLAS_ROWS;
  out[2] = 1 / DECAL_ATLAS_COLS;
  out[3] = 1 / DECAL_ATLAS_ROWS;
  return out;
}

// ---------------------------------------------------------------------------
// Basis construction
// ---------------------------------------------------------------------------

export interface Basis {
  /** Tangent (decal local +X). */
  t: Vec3;
  /** Bitangent (decal local +Y). */
  b: Vec3;
  /** Surface normal (decal local +Z). */
  n: Vec3;
}

export function createBasis(): Basis {
  return { t: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 0, z: -1 }, n: { x: 0, y: 1, z: 0 } };
}

/**
 * Orthonormal basis whose +Z is `normal`.
 *
 * The helper axis is the *smallest* component of the normal instead of a fixed
 * world up: that keeps |cross(helper, n)| >= 1/sqrt(3) for every input, so no
 * near-parallel case can produce a degenerate (0,0,0) tangent. Axis-aligned
 * normals — exactly the ones a box world produces the most — are therefore
 * exact, and a zero or non-finite normal falls back to the world up.
 */
export function buildDecalBasis(normal: Vec3, out: Basis = createBasis()): Basis {
  let nx = normal.x;
  let ny = normal.y;
  let nz = normal.z;
  let len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!Number.isFinite(len) || len < 1e-6) {
    nx = 0;
    ny = 1;
    nz = 0;
    len = 1;
  }
  const inv = 1 / len;
  nx *= inv;
  ny *= inv;
  nz *= inv;

  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  let hx = 0;
  let hy = 0;
  let hz = 0;
  if (ax <= ay && ax <= az) hx = 1;
  else if (ay <= az) hy = 1;
  else hz = 1;

  // t = normalize(helper x n)
  let tx = hy * nz - hz * ny;
  let ty = hz * nx - hx * nz;
  let tz = hx * ny - hy * nx;
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
  const tinv = tl > 1e-9 ? 1 / tl : 0;
  tx *= tinv;
  ty *= tinv;
  tz *= tinv;
  if (tinv === 0) {
    // Unreachable for finite normals, but never hand a NaN basis downstream.
    tx = 1;
    ty = 0;
    tz = 0;
  }

  // b = n x t (unit: n and t are orthonormal)
  const bx = ny * tz - nz * ty;
  const by = nz * tx - nx * tz;
  const bz = nx * ty - ny * tx;

  out.t.x = tx;
  out.t.y = ty;
  out.t.z = tz;
  out.b.x = bx;
  out.b.y = by;
  out.b.z = bz;
  out.n.x = nx;
  out.n.y = ny;
  out.n.z = nz;
  return out;
}

// ---------------------------------------------------------------------------
// Camera basis (billboarding)
// ---------------------------------------------------------------------------

/**
 * World-space camera frame, in plain numbers so this module stays three-free.
 * One instance is owned by VfxSystem and mutated once per update.
 */
export interface CameraBasis {
  /** Camera right (world). */
  rx: number;
  ry: number;
  rz: number;
  /** Camera up (world). */
  ux: number;
  uy: number;
  uz: number;
  /** Camera forward, i.e. the direction it looks at (world). */
  fx: number;
  fy: number;
  fz: number;
  /** Eye position. */
  px: number;
  py: number;
  pz: number;
}

export function createCameraBasis(): CameraBasis {
  return { rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, fx: 0, fy: 0, fz: -1, px: 0, py: 0, pz: 0 };
}

// ---------------------------------------------------------------------------
// Planes
// ---------------------------------------------------------------------------

/** Plane in normal form: `n · p = d`. Used for particle bounces. */
export interface Plane {
  nx: number;
  ny: number;
  nz: number;
  d: number;
}

export function createPlane(): Plane {
  return { nx: 0, ny: 1, nz: 0, d: 0 };
}

/** Plane through `point` with normal `normal` (normalized, up-fallback). */
export function planeFromPointNormal(out: Plane, point: Vec3, normal: Vec3): Plane {
  const basis = buildDecalBasis(normal, scratchBasis);
  out.nx = basis.n.x;
  out.ny = basis.n.y;
  out.nz = basis.n.z;
  out.d = out.nx * point.x + out.ny * point.y + out.nz * point.z;
  return out;
}

/** Horizontal plane at height `y`. */
export function horizontalPlane(out: Plane, y: number): Plane {
  out.nx = 0;
  out.ny = 1;
  out.nz = 0;
  out.d = y;
  return out;
}

// ---------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------

/**
 * One particle. Mutable plain record, preallocated by ParticlePool: a firing
 * range test can fire thousands of rounds without a single allocation.
 */
export interface Particle {
  active: boolean;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  sizeStart: number;
  sizeEnd: number;
  r: number;
  g: number;
  b: number;
  alphaStart: number;
  alphaEnd: number;
  /** Signed acceleration on Y, units/s^2 (negative = down). */
  gravity: number;
  /** Exponential velocity damping, 1/s. 0 = vacuum. */
  drag: number;
  /** Roll about the view axis, rad; only billboarded clouds read it. */
  angle: number;
  /** Roll rate, rad/s. */
  spin: number;
  /** Bounce plane enabled. */
  plane: boolean;
  pnx: number;
  pny: number;
  pnz: number;
  pd: number;
  restitution: number;
  friction: number;
  maxBounces: number;
  bounces: number;
}

export function createParticle(): Particle {
  const p: Particle = {
    active: false,
    px: 0,
    py: 0,
    pz: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    age: 0,
    life: 0,
    sizeStart: 1,
    sizeEnd: 1,
    r: 1,
    g: 1,
    b: 1,
    alphaStart: 1,
    alphaEnd: 1,
    gravity: -800,
    drag: 0,
    angle: 0,
    spin: 0,
    plane: false,
    pnx: 0,
    pny: 1,
    pnz: 0,
    pd: 0,
    restitution: 0.35,
    friction: 0.45,
    maxBounces: 1,
    bounces: 0,
  };
  return p;
}

/** Reset a record to its spawn defaults (keeps the object identity). */
export function resetParticle(p: Particle): Particle {
  p.active = true;
  p.px = 0;
  p.py = 0;
  p.pz = 0;
  p.vx = 0;
  p.vy = 0;
  p.vz = 0;
  p.age = 0;
  p.life = 1;
  p.sizeStart = 1;
  p.sizeEnd = 1;
  p.r = 1;
  p.g = 1;
  p.b = 1;
  p.alphaStart = 1;
  p.alphaEnd = 1;
  p.gravity = -800;
  p.drag = 0;
  p.angle = 0;
  p.spin = 0;
  p.plane = false;
  p.pnx = 0;
  p.pny = 1;
  p.pnz = 0;
  p.pd = 0;
  p.restitution = 0.35;
  p.friction = 0.45;
  p.maxBounces = 1;
  p.bounces = 0;
  return p;
}

/** Normalized age in [0,1]. */
export function particleT(p: Particle): number {
  if (p.life <= 0) return 1;
  const t = p.age / p.life;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Advance one particle. Returns `p.active` (false once its lifetime is spent).
 *
 * Acceleration is integrated with the exact constant-acceleration form
 * `p += v*dt + a*dt^2/2; v += a*dt` rather than semi-implicit Euler: at
 * `dt = v0/|g|` this lands *exactly* on the analytic apex `v0^2/(2g)` (asserted
 * in tests/vfx.spec.ts) and it cannot gain energy over a long lifetime.
 */
export function stepParticle(p: Particle, dt: number): boolean {
  if (!(dt > 0)) return p.active;
  p.age += dt;
  if (p.age >= p.life) {
    p.active = false;
    return false;
  }

  if (p.drag > 0) {
    const k = Math.exp(-p.drag * dt);
    p.vx *= k;
    p.vy *= k;
    p.vz *= k;
  }

  p.px += p.vx * dt;
  p.py += p.vy * dt + 0.5 * p.gravity * dt * dt;
  p.pz += p.vz * dt;
  p.vy += p.gravity * dt;
  p.angle += p.spin * dt;

  if (p.plane) collideParticlePlane(p);
  return p.active;
}

/**
 * Bounce/slide against the particle's plane. Sparks are meant to bounce exactly
 * once ("roughly off the surface plane"), so the first contact reflects with
 * restitution while every later contact just slides along the plane — that is
 * what keeps a shower of sparks from rattling forever.
 */
function collideParticlePlane(p: Particle): void {
  const dist = p.pnx * p.px + p.pny * p.py + p.pnz * p.pz - p.pd;
  if (dist >= 0) return;
  let vn = p.pnx * p.vx + p.pny * p.vy + p.pnz * p.vz;

  // Never leave a particle inside the surface, even when it is only sliding.
  p.px -= p.pnx * dist;
  p.py -= p.pny * dist;
  p.pz -= p.pnz * dist;

  if (vn < 0) {
    if (p.bounces < p.maxBounces) {
      const j = -(1 + p.restitution) * vn;
      p.vx += p.pnx * j;
      p.vy += p.pny * j;
      p.vz += p.pnz * j;
      const vnNew = vn + j;
      // Kill residual micro-bounces so a resting particle does not jitter.
      if (Math.abs(vnNew) < 12) p.maxBounces = p.bounces + 1;
      p.bounces++;
    } else {
      // Sliding contact: drop the into-plane component.
      p.vx -= p.pnx * vn;
      p.vy -= p.pny * vn;
      p.vz -= p.pnz * vn;
      vn = 0;
    }

    // Tangential friction, applied in both the bounce and the slide case.
    const tangentScale = 1 - p.friction;
    const vnNow = p.pnx * p.vx + p.pny * p.vy + p.pnz * p.vz;
    let tx = p.vx - p.pnx * vnNow;
    let ty = p.vy - p.pny * vnNow;
    let tz = p.vz - p.pnz * vnNow;
    tx *= tangentScale;
    ty *= tangentScale;
    tz *= tangentScale;
    p.vx = tx + p.pnx * vnNow;
    p.vy = ty + p.pny * vnNow;
    p.vz = tz + p.pnz * vnNow;
  }
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a frame delta into the range the VFX layer is willing to simulate.
 * A tab switch hands us multi-second deltas; integrating those would fling
 * every particle across the map (and `dt = NaN` from a bad clock would poison
 * every matrix in the pools).
 */
export function clampDt(dt: number): number {
  if (!Number.isFinite(dt) || dt <= 0) return 0;
  return dt > 0.5 ? 0.5 : dt;
}

export interface RngLike {
  float(): number;
}

/**
 * Random unit vector in a cone of half-angle `spread` around `dir`.
 * Reuses an internal basis scratch, so it is allocation-free and synchronous.
 */
export function randomConeDir(rng: RngLike, out: Vec3, dir: Vec3, spread: number): Vec3 {
  // buildDecalBasis normalizes `dir` into `basis.n` and substitutes world up for a
  // zero/non-finite axis, so a degenerate direction still yields a valid cone
  // (deriving the axis from `dir` directly would collapse the sample to a
  // near-zero vector instead).
  const basis = buildDecalBasis(dir, scratchBasis);
  const half = !Number.isFinite(spread) ? 0 : spread < 0 ? 0 : spread > Math.PI ? Math.PI : spread;
  const cosSpread = Math.cos(half);
  // Sample cos(theta) uniformly over [cos(half), 1]: a fixed cos(half) would put
  // every direction on the cone *surface*, and the sampled radius keeps the
  // result an exact unit vector, so callers can scale it by a speed directly.
  const cosTheta = 1 - rng.float() * (1 - cosSpread);
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const phi = rng.float() * Math.PI * 2;
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  out.x = basis.n.x * cosTheta + (basis.t.x * cp + basis.b.x * sp) * sinTheta;
  out.y = basis.n.y * cosTheta + (basis.t.y * cp + basis.b.y * sp) * sinTheta;
  out.z = basis.n.z * cosTheta + (basis.t.z * cp + basis.b.z * sp) * sinTheta;
  return out;
}

/**
 * Write an orientation+translation 4x4 into `out` (16 floats, three's
 * column-major element layout) so instance matrices can be filled straight into
 * an InstancedBufferAttribute: no Matrix4 object, no allocation, no copy.
 */
export function writeQuadMatrix(
  out: Float32Array,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  px: number, py: number, pz: number,
): Float32Array {
  out[0] = ax; out[1] = ay; out[2] = az; out[3] = 0;
  out[4] = bx; out[5] = by; out[6] = bz; out[7] = 0;
  out[8] = cx; out[9] = cy; out[10] = cz; out[11] = 0;
  out[12] = px; out[13] = py; out[14] = pz; out[15] = 1;
  return out;
}

/** Translate-only 4x4: scales a dummy record away to nothing without a matrix. */
export function writeHiddenMatrix(out: Float32Array): Float32Array {
  out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = 0; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = 0; out[11] = 0;
  out[12] = 0; out[13] = -1e6; out[14] = 0; out[15] = 1;
  return out;
}

/** Length-1 copy of `dir`, falling back to +Y for a zero/non-finite vector. */
export function safeDir(out: Vec3, dir: Vec3): Vec3 {
  const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  if (!Number.isFinite(len) || len < 1e-9) {
    out.x = 0;
    out.y = 1;
    out.z = 0;
    return out;
  }
  const inv = 1 / len;
  out.x = dir.x * inv;
  out.y = dir.y * inv;
  out.z = dir.z * inv;
  return out;
}

/** True when every component is finite (cheap guard before touching matrices). */
export function isFiniteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Module-level scratch basis; only used by synchronous helpers above. */
const scratchBasis: Basis = createBasis();
