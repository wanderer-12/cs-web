// =============================================================================
// render/parts.ts — the two primitives every hand-built model in `render/` uses.
//
// The game ships no model files: no glTF, no OBJ, no asset pipeline. An actor
// body and a first-person weapon are therefore *assemblies of boxes*, and a
// "part" is a BoxGeometry whose vertices carry a baked shade (three multiplies
// that with the material colour and, for instances, the per-instance colour).
// Merging the parts gives one geometry per model, which is what keeps the actor
// layer at three draw calls no matter how many players exist.
//
// Shading convention: 1.0 = the model's colour, < 1 darkens that part (straps,
// boots, helmets, gun furniture), so a single material colour is enough for a
// whole body. Values above 1 are allowed and read as "bright accent".
// =============================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** World units of texture one UV tile covers on a hand-built part. */
export const PART_TILE_SIZE = 12;
export const MIN_SHADE = 0.05;
export const MAX_SHADE = 1.35;

function shade(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return value < MIN_SHADE ? MIN_SHADE : value > MAX_SHADE ? MAX_SHADE : value;
}

/**
 * One box centred at (x, y, z) with baked vertex shading.
 *
 * UVs are scaled to roughly `size / PART_TILE_SIZE` tiles so a 40-unit barrel
 * does not stretch a single texture tile across its whole length (only the
 * first-person weapon is textured today, but a part stays texture-ready).
 */
export function shadedBox(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  value = 1,
  uvTiles = 0,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);

  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const tiles = uvTiles > 0 ? uvTiles : Math.max(w, h, d) / PART_TILE_SIZE;
  const s = tiles < 0.35 ? 0.35 : tiles > 4 ? 4 : tiles;
  for (let i = 0; i < uv.count; i += 1) {
    uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s);
  }

  geo.translate(x, y, z);

  const tint = shade(value);
  const count = geo.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = tint;
    colors[i * 3 + 1] = tint;
    colors[i * 3 + 2] = tint;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  return geo;
}

/**
 * Merge parts into a single geometry. Throws with a label instead of returning
 * null so a broken model fails loudly at construction time, not silently as an
 * invisible actor (which is exactly the bug this module exists to fix).
 */
export function mergeParts(parts: THREE.BufferGeometry[], label: string): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  if (!merged) {
    throw new Error(`[render] mergeParts failed for ${label}`);
  }
  for (const part of parts) part.dispose();
  return merged;
}