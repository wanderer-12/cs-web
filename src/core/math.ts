// =============================================================================
// core/math.ts — allocation-free vector helpers over the Vec3 shape.
// The simulation uses plain {x,y,z} objects so state can be snapshotted cheaply.
// =============================================================================

import type { AABB, Vec3 } from './types';

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const copy = (out: Vec3, a: Vec3): Vec3 => {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
};
export const set = (out: Vec3, x: number, y: number, z: number): Vec3 => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};
export const add = (out: Vec3, a: Vec3, b: Vec3): Vec3 => set(out, a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (out: Vec3, a: Vec3, b: Vec3): Vec3 => set(out, a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (out: Vec3, a: Vec3, s: number): Vec3 => set(out, a.x * s, a.y * s, a.z * s);
export const addScaled = (out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 =>
  set(out, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (out: Vec3, a: Vec3, b: Vec3): Vec3 =>
  set(out, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const lengthSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const length = (a: Vec3): number => Math.sqrt(lengthSq(a));
export const lengthXZ = (a: Vec3): number => Math.hypot(a.x, a.z);
export const lengthSqXZ = (a: Vec3): number => a.x * a.x + a.z * a.z;
export const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const distanceSq = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};
export const distanceXZ = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

export function normalize(out: Vec3, a: Vec3): Vec3 {
  const len = length(a);
  if (len < 1e-9) return set(out, 0, 0, 0);
  const inv = 1 / len;
  return set(out, a.x * inv, a.y * inv, a.z * inv);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
/** Frame-rate independent exponential approach factor for a rate per second. */
export const approach = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

export const deg = (d: number): number => (d * Math.PI) / 180;
export const rad2deg = (r: number): number => (r * 180) / Math.PI;

/** Direction vector from yaw/pitch, matching three.js camera convention. */
export function anglesToDir(out: Vec3, yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return set(out, -Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

/** Forward/right vectors on the horizontal plane from a yaw angle. */
export function yawToForward(out: Vec3, yaw: number): Vec3 {
  return set(out, -Math.sin(yaw), 0, -Math.cos(yaw));
}
export function yawToRight(out: Vec3, yaw: number): Vec3 {
  return set(out, Math.cos(yaw), 0, -Math.sin(yaw));
}

/** yaw/pitch that points from `from` to `to`. */
export function anglesTo(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const horiz = Math.hypot(dx, dz);
  return {
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.atan2(dy, horiz),
  };
}

// ---------------------------------------------------------------------------
// AABB helpers
// ---------------------------------------------------------------------------

export function aabbFromCenter(out: AABB, pos: Vec3, size: Vec3): AABB {
  const hx = size.x * 0.5;
  const hy = size.y * 0.5;
  const hz = size.z * 0.5;
  out.min.x = pos.x - hx;
  out.min.y = pos.y - hy;
  out.min.z = pos.z - hz;
  out.max.x = pos.x + hx;
  out.max.y = pos.y + hy;
  out.max.z = pos.z + hz;
  return out;
}

export function aabbContainsPoint(b: AABB, p: Vec3): boolean {
  return (
    p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z
  );
}

export function aabbOverlap(a: AABB, b: AABB): boolean {
  return (
    a.min.x < b.max.x &&
    a.max.x > b.min.x &&
    a.min.y < b.max.y &&
    a.max.y > b.min.y &&
    a.min.z < b.max.z &&
    a.max.z > b.min.z
  );
}

export function boxTrace(start: Vec3, end: Vec3, a: AABB, out?: { t: number; normal: Vec3 }): number {
  // Slab method. Returns entry t in [0,1] or -1 when no hit.
  const res = out ?? { t: 0, normal: v3() };
  let tmin = 0;
  let tmax = 1;
  const axes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
  let hitAxis: 'x' | 'y' | 'z' = 'x';
  let hitSign = 1;
  for (const ax of axes) {
    const d = end[ax] - start[ax];
    const lo = a.min[ax];
    const hi = a.max[ax];
    if (Math.abs(d) < 1e-9) {
      if (start[ax] < lo || start[ax] > hi) return -1;
      continue;
    }
    const inv = 1 / d;
    let t1 = (lo - start[ax]) * inv;
    let t2 = (hi - start[ax]) * inv;
    let sign = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      hitAxis = ax;
      hitSign = sign;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  res.t = tmin;
  set(res.normal, 0, 0, 0);
  res.normal[hitAxis] = hitSign;
  if (out === undefined) {
    // Caller only wanted the scalar; normal discarded.
  }
  return tmin;
}

/** Inclusive min/max expansion. */
export function aabbExpand(out: AABB, a: AABB, amount: number): AABB {
  out.min.x = a.min.x - amount;
  out.min.y = a.min.y - amount;
  out.min.z = a.min.z - amount;
  out.max.x = a.max.x + amount;
  out.max.y = a.max.y + amount;
  out.max.z = a.max.z + amount;
  return out;
}
