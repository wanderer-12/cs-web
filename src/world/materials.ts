// =============================================================================
// world/materials.ts — brush material + tint -> one shared MeshLambertMaterial.
//
// THE DRAW-CALL CONTRACT
// ----------------------
// The map is ~600 brushes and the budget is <= 14 draw calls for the whole map,
// which only works if the geometry builder merges every brush that resolves to
// the same material into a single mesh. That in turn requires this module to hand
// out ONE shared material object per (material, tint, texScale) triple — never a
// fresh material per brush. `getMaterial` is therefore a pure cache lookup.
//
// THE UV CONTRACT (read this before changing anything here)
// --------------------------------------------------------
// A `THREE.Texture` is shared by every brush that uses its material, and Three.js
// stores tiling in exactly one place: `texture.repeat`. One texture therefore
// cannot carry per-brush tiling — a 512-unit wall and an 80-unit crate would be
// forced to share a tiling factor and one of them would look stretched or
// minified into mush.
//
// The resolution: `map.repeat` is pinned to (1, 1) and the GEOMETRY BUILDER owns
// tiling by baking it into the vertex UVs:
//
//     const factor = uvTileFactor(worldSize, brush.texScale, textureRecipe(name));
//     uv.setXY(i, u * factor, v * factor);
//
// `applyMaterialToMesh` re-asserts `repeat = (1, 1)` for exactly this reason, so
// no future code can quietly reintroduce texture-level repeat and stretch the map.
// =============================================================================

import * as THREE from 'three';
import type { SurfaceMaterial } from '../core/types';
import { getTexture, type ProcTextureName } from './textures';

export interface MaterialOptions {
  /** 0xRRGGBB multiplier applied to the material colour. */
  tint?: number;
  /** World units per texture tile; 0/undefined = the texture recipe default. */
  texScale?: number;
}

/**
 * Base albedo used when a texture is unavailable (and as `material.color`, which
 * Three.js multiplies with the map). Values match the procedural texture bases so
 * a missing map degrades to a plausible flat colour instead of black.
 */
export const MATERIAL_ALBEDO: Record<SurfaceMaterial, number> = {
  sandstone: 0xc2a678,
  concrete: 0x9a9a97,
  wood: 0x8a5f38,
  metal: 0xa9adb3,
  sand: 0xd8c98a,
  glass: 0xdfeaf2,
  flesh: 0xa94a44,
  water: 0x22454a,
};

/** True for materials that must be rendered with an alpha-blended material. */
export function isTransparent(material: SurfaceMaterial): boolean {
  return material === 'glass';
}

/** `glass` is the only translucent surface in the game today. */
export const TRANSPARENT_MATERIALS: readonly SurfaceMaterial[] = ['glass'];

/** Slight render-order fix so glass does not fight with opaque geometry. */
const TRANSPARENT_OPACITY = 0.28;

/**
 * Cache key for `getMaterial`. Pure and canvas-free so the contract is testable.
 * `texScale` is part of the key even though it does not change the material right
 * now: a texture is one tiling, so a different texScale is a different visual
 * result and must not silently reuse another brush's material.
 */
export function materialCacheKey(material: SurfaceMaterial, opts?: MaterialOptions): string {
  return `${material}|${opts?.tint ?? 'none'}|${opts?.texScale ?? 0}`;
}

/**
 * Cache key for `getViewMaterial`. View-model props get their own entry so the
 * slightly different response below cannot leak into the world materials.
 */
export function viewMaterialCacheKey(material: SurfaceMaterial, opts?: MaterialOptions): string {
  return `view:${materialCacheKey(material, opts)}`;
}

const materialCache = new Map<string, THREE.MeshLambertMaterial>();

/** Set by `disposeMaterials`; a disposed material must never be handed out again. */
let cacheLocked = false;

function build(
  material: SurfaceMaterial,
  opts: MaterialOptions | undefined,
  forView: boolean,
): THREE.MeshLambertMaterial {
  const base = MATERIAL_ALBEDO[material];
  const mat = new THREE.MeshLambertMaterial({
    color: opts?.tint ?? base,
    transparent: isTransparent(material),
    opacity: isTransparent(material) ? TRANSPARENT_OPACITY : 1,
  });

  const tex = getTexture(material as ProcTextureName);
  // (1,1) forever: the geometry builder bakes tiling into the UVs (see header).
  tex.repeat.set(1, 1);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  mat.map = tex;

  if (forView) {
    // The view model is close to the eye and lit by the same sun, so it needs a
    // little extra bounce to read; properties rather than a second texture keep
    // this free and keep the two caches in lock-step.
    mat.color.multiplyScalar(1.06);
    mat.toneMapped = true;
  }

  // The material name is how a merged mesh keeps a human-readable identity, and
  // `userData.material` / `userData.tint` / `userData.texScale` below carry the
  // structured version for the renderer and tools.
  mat.name = `${forView ? 'vm' : 'mt'}-${material}`;
  if (opts?.tint !== undefined) {
    mat.userData.tint = opts.tint;
    mat.userData.tinted = true;
  }
  if (opts?.texScale !== undefined && opts.texScale > 0) {
    mat.userData.texScale = opts.texScale;
  }
  return mat;
}

function lookup(
  material: SurfaceMaterial,
  opts: MaterialOptions | undefined,
  forView: boolean,
): THREE.MeshLambertMaterial | undefined {
  const key = forView ? viewMaterialCacheKey(material, opts) : materialCacheKey(material, opts);
  return materialCache.get(key);
}

/**
 * Cached material for a surface material (plus optional tint / texScale).
 * Repeated calls with the same arguments return the identical object, which is
 * what lets the geometry builder merge meshes and stay inside the draw-call
 * budget. Do not mutate the returned material.
 */
export function getMaterial(
  material: SurfaceMaterial,
  opts?: MaterialOptions,
): THREE.MeshLambertMaterial {
  const key = materialCacheKey(material, opts);
  let mat = materialCache.get(key);
  if (!mat) {
    if (cacheLocked) {
      // A caller kept a reference to a disposed material; rebuilding silently
      // would leak GPU state, so fail loudly instead.
      throw new Error(`[materials] getMaterial(${key}) after disposeMaterials(); call disposeMaterials() last`);
    }
    mat = build(material, opts, false);
    materialCache.set(key, mat);
  }
  return mat;
}

/** View-model / prop variant: same cache shape, slightly different response. */
export function getViewMaterial(
  material: SurfaceMaterial,
  opts?: MaterialOptions,
): THREE.MeshLambertMaterial {
  const key = viewMaterialCacheKey(material, opts);
  let mat = materialCache.get(key);
  if (!mat) {
    if (cacheLocked) {
      throw new Error(`[materials] getViewMaterial(${key}) after disposeMaterials()`);
    }
    mat = build(material, opts, true);
    materialCache.set(key, mat);
  }
  return mat;
}

/** A mesh's material is always a single material or an array of them. */
function materialList(mesh: THREE.Mesh): THREE.Material[] {
  const m = mesh.material;
  return Array.isArray(m) ? m : [m];
}

/**
 * Applies a material to one mesh in place, tagging it with the metadata the
 * renderer and the debug tools read:
 *   `mesh.name = 'mt-<material>'`, `mesh.userData.material`, `.tint`, `.texScale`,
 *   plus `mesh.castShadow` / `receiveShadow` defaults and `matrixAutoUpdate=false`
 *   (every world brush is static; the renderer flips `updateMatrix()` once).
 *
 * Called after `MapGeometry` has built the merged meshes.
 */
export function applyMaterialToMesh(
  mesh: THREE.Mesh,
  material: SurfaceMaterial,
  opts?: MaterialOptions,
): void {
  const mat = getMaterial(material, opts);

  // Re-assert the UV contract on every application: the geometry owns tiling.
  const map = mat.map;
  if (map) {
    map.repeat.set(1, 1);
    map.offset.set(0, 0);
  }

  // Do NOT dispose whatever the mesh pointed at before. Materials handed out
  // here are shared by every brush with the same key, so disposing one would
  // blank out every other mesh still referencing it. Teardown is
  // `disposeMaterials()` and nothing else.
  const already = materialList(mesh);
  if (already.length === 1 && already[0] === mat) return; // idempotent re-apply

  mesh.material = mat;

  mesh.name = `mt-${material}`;
  mesh.userData.material = material;
  mesh.userData.tint = opts?.tint ?? null;
  mesh.userData.texScale = opts?.texScale ?? 0;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
}

/** Diagnostics: how many distinct materials the map is actually drawing with. */
export function materialCacheSize(): number {
  return materialCache.size;
}

/**
 * Dispose every cached material (and detach the textures behind them) and lock
 * the cache. Teardown is final: asking for a material afterwards throws, because
 * handing out a disposed Three.js material leaves the renderer with orphaned
 * program/GPU state that is very hard to diagnose from a black screenshot.
 */
export function disposeMaterials(): void {
  for (const mat of materialCache.values()) {
    mat.map = null; // the texture cache owns the texture's lifetime (disposeTextures)
    mat.dispose();
  }
  materialCache.clear();
  cacheLocked = true;
}

/** True once `disposeMaterials` has been called; used by teardown assertions. */
export function materialsDisposed(): boolean {
  return cacheLocked;
}
