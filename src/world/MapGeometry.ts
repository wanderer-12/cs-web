/**
 * MapGeometry — turns a `MapData` brush list into a handful of merged meshes.
 *
 * WHY merge: the map is authored as ~140 axis-aligned boxes. Drawing them
 * one-by-one would cost ~140 draw calls for geometry the GPU could batch in ten,
 * and the browser prototype is draw-call bound long before it is triangle bound.
 * Every brush is therefore baked into the geometry of one mesh per
 * (material, tint) pair, which is what keeps the whole map around ten meshes.
 *
 * WHAT IS NOT HERE: textures. The merged meshes carry plain `MeshStandardMaterial`
 * with `map` left unset; `src/world/textures.ts` attaches procedural textures
 * afterwards and relies on `mesh.name === 'mt-<material>'` plus
 * `mesh.userData.material` / `.tint` / `.texScale` to find the right surface.
 * UVs are baked here (the geometry owns tiling), so that pass must leave
 * `map.repeat` at (1, 1).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Brush, MapData, SurfaceMaterial } from '../core/types';

/**
 * World units covered by one texture tile, per surface material. A face whose
 * UVs run 0..(size / tile) keeps the texel density identical on a crate and on a
 * 4000-unit ground plane, instead of stretching one texture across the map.
 */
export const MATERIAL_TILE_SIZE: Readonly<Record<SurfaceMaterial, number>> = {
  sandstone: 128,
  concrete: 128,
  wood: 96,
  metal: 96,
  sand: 256,
  glass: 128,
  flesh: 96,
  water: 128,
};

/** Fallback for a material that somehow is not in the table above. */
const DEFAULT_TILE_SIZE = 128;

export interface MapMeshOptions {
  /**
   * Whether the map casts shadows into the shadow map. Defaults to true: a
   * static map is exactly the geometry worth pre-rendering into a shadow map.
   * `receiveShadow` is always on, since the map is where every other shadow lands.
   */
  shadows?: boolean;
}

export interface MapMeshStats {
  /** One per merged mesh; this is the number of draw calls the map costs. */
  drawCalls: number;
  triangles: number;
  /** Brushes that were merged. `clip` and `nonSolid` brushes are never drawn. */
  brushes: number;
}

export interface MapMeshes {
  group: THREE.Group;
  stats: MapMeshStats;
}

/** Tile size for a brush, letting an authored `texScale` override the default. */
function tileSizeFor(brush: Brush): number {
  if (brush.texScale !== undefined && brush.texScale > 0) return brush.texScale;
  return MATERIAL_TILE_SIZE[brush.material] ?? DEFAULT_TILE_SIZE;
}

/**
 * A box whose UVs are pre-scaled per face so the texture tiles at a fixed world
 * scale. `BoxGeometry` emits its six faces in a fixed order — +X, -X, +Y, -Y,
 * +Z, -Z — with four vertices each, and every face's own UVs run 0..1, so the
 * per-face repeat is just the face's world size divided by the tile size.
 * Grouping is dropped because the whole merged mesh shares a single material.
 */
function tiledBoxGeometry(w: number, h: number, d: number, tile: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(w, h, d);
  const uv = geometry.getAttribute('uv');
  if (!(uv instanceof THREE.BufferAttribute)) {
    throw new Error('[MapGeometry] BoxGeometry without a plain uv attribute');
  }

  // Per-face (uScale, vScale): side faces span Z x Y, caps span X x Z, ends span X x Y.
  const faces: readonly (readonly [number, number])[] = [
    [d / tile, h / tile], // +X
    [d / tile, h / tile], // -X
    [w / tile, d / tile], // +Y (top)
    [w / tile, d / tile], // -Y (bottom)
    [w / tile, h / tile], // +Z
    [w / tile, h / tile], // -Z
  ];

  for (let face = 0; face < faces.length; face++) {
    const [su, sv] = faces[face];
    for (let corner = 0; corner < 4; corner++) {
      const i = face * 4 + corner;
      uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    }
  }
  uv.needsUpdate = true;
  geometry.clearGroups();
  return geometry;
}

/** Physically-plausible-enough surface response; no textures involved. */
function makeMaterial(material: SurfaceMaterial, tint: number | undefined): THREE.MeshStandardMaterial {
  const metallic = material === 'metal' || material === 'water';
  const mat = new THREE.MeshStandardMaterial({
    color: tint ?? 0xffffff,
    roughness: metallic ? 0.55 : 0.92,
    metalness: metallic ? 0.35 : 0.02,
  });
  // The name is how the texture pass finds the surface for this mesh.
  mat.name = `mt-${material}`;
  return mat;
}

/**
 * Builds the merged, untextured map meshes.
 *
 * Brush yaw is applied as a real Y rotation so the mesh matches what
 * `brushToAabb` in `src/world/trace.ts` collides against (that helper expands a
 * yawed brush into its enclosing axis-aligned box).
 */
export function buildMapMeshes(map: MapData, opts?: MapMeshOptions): MapMeshes {
  interface Bucket {
    material: SurfaceMaterial;
    tint: number | undefined;
    parts: THREE.BufferGeometry[];
    triangles: number;
  }

  const buckets = new Map<string, Bucket>();
  let drawnBrushes = 0;

  for (const brush of map.brushes) {
    // Nothing invisible is drawn: `clip` is collision-only, `nonSolid` is a
    // trigger/marker volume. Both would otherwise cost fill rate for no pixels.
    if (brush.clip === true || brush.nonSolid === true) continue;

    const geometry = tiledBoxGeometry(
      brush.size.x,
      brush.size.y,
      brush.size.z,
      tileSizeFor(brush),
    );
    if (brush.yaw !== 0) geometry.rotateY(brush.yaw); // also rotates the normals
    geometry.translate(brush.pos.x, brush.pos.y, brush.pos.z);

    const key = `${brush.material}|${brush.tint ?? 0}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { material: brush.material, tint: brush.tint, parts: [], triangles: 0 };
      buckets.set(key, bucket);
    }
    const index = geometry.getIndex();
    const positions = geometry.getAttribute('position');
    bucket.triangles += index ? index.count / 3 : positions.count / 3;
    bucket.parts.push(geometry);
    drawnBrushes++;
  }

  const group = new THREE.Group();
  group.name = 'map-geometry';
  const castShadows = opts?.shadows !== false;
  let triangles = 0;

  for (const [key, bucket] of buckets) {
    const merged = mergeGeometries(bucket.parts, false);
    // A null here means the parts disagreed on their attribute layout, which can
    // only be a bug in this module — failing loudly beats a silently missing wall.
    if (!merged) throw new Error(`[MapGeometry] mergeGeometries failed for group ${key}`);

    // The merged attribute buffers are copies, so the per-brush temporaries can go.
    for (const part of bucket.parts) part.dispose();

    merged.computeBoundingSphere();
    merged.computeBoundingBox();

    const mesh = new THREE.Mesh(merged, makeMaterial(bucket.material, bucket.tint));
    mesh.name = `mt-${bucket.material}`;
    mesh.userData.material = bucket.material;
    mesh.userData.tint = bucket.tint ?? null;
    // `texScale` is authored per brush and already baked into the UVs, so a merged
    // mesh (many brushes, possibly several texScales) reports null rather than a
    // value that would only be true for one of its parts.
    mesh.userData.texScale = null;
    mesh.castShadow = castShadows;
    mesh.receiveShadow = true;
    // The map never moves, so its world matrix is built once here and skipped by
    // the renderer on every subsequent frame.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
    triangles += bucket.triangles;
  }

  return {
    group,
    stats: { drawCalls: group.children.length, triangles, brushes: drawnBrushes },
  };
}

/**
 * Releases the merged geometries of a mesh group built by `buildMapMeshes`.
 * Materials are deliberately left alone: `src/world/materials.ts` owns the
 * material cache and disposes it in one place.
 */
export function disposeMapMeshes(group: THREE.Group): void {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) child.geometry.dispose();
  });
  group.clear();
}
