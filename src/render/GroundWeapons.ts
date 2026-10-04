// =============================================================================
// render/GroundWeapons.ts — the guns lying on the floor.
//
// WHY THIS FILE EXISTS: a dropped weapon is a world entity (`GroundWeapon` in
// `core/types.ts`), and before this file existed the match could carry one but
// nothing ever drew it - a team-mate's rifle on the ground was invisible.
//
// WHAT IT DRAWS: one small pile of boxes per weapon kind, lying on its side the
// way a dropped gun does - gun height along local X, thickness along local Y,
// barrel along local Z - so a plain rotation about Y lays it flat in the world.
// The mesh is created the first time that kind actually reaches the floor, which
// keeps a match with no drops at zero cost, and reused after that.
//
// COST: one draw call per kind that is present (bounded by the 9 weapon kinds),
// independent of how many guns are lying around, because every gun of a kind is
// an instance. Same shape as `Characters.ts`: `count` is the number of live
// instances, `frustumCulled = false`, and nothing allocates per frame.
//
// The yaw of each gun is derived from its entity id (a golden-angle scatter), so
// guns in a pile do not lie perfectly parallel and the arrangement is stable
// frame to frame without storing an orientation in the sim.
// =============================================================================

import * as THREE from 'three';
import type { GroundWeapon, WeaponKind } from '../core/types';
import { RENDER_ORDER_BODIES } from './Characters';
import { mergeParts, shadedBox } from './parts';

/** Instances per kind. 24 guns on the floor is the match's own cap. */
export const GROUND_SLOTS_PER_KIND = 8;
/** Height above the floor (units) at which a gun body rests. */
export const GROUND_LIFT = 1;
/** Golden-angle scatter (radians) applied per entity id. */
const GROUND_YAW_STEP = 2.399963;

export interface GroundShape {
  /** Barrel length: the long axis, along local Z. */
  length: number;
  /** The gun's own height, which becomes the horizontal axis once it is lying. */
  wide: number;
  /** How high the pile stands off the floor. */
  thick: number;
  /** Magazine box size, or 0 when the weapon has none to stick out. */
  magazine: number;
  /** Receiver colour, tinted per kind so a rifle never reads as a pistol. */
  color: number;
}

/**
 * Silhouette per kind, in world units (52.49 u = 1 m, so an AK-47 is ~44 u of
 * barrel and 15 u of stock-to-sight height). Only the primary and secondary
 * slots ever reach the floor, but the table is total so a new droppable slot
 * cannot silently draw nothing.
 */
export const GROUND_SHAPE: Readonly<Record<WeaponKind, GroundShape>> = {
  rifle: { length: 44, wide: 15, thick: 6, magazine: 8, color: 0x53483c },
  smg: { length: 30, wide: 12, thick: 5.5, magazine: 9, color: 0x4a4a4e },
  pistol: { length: 14, wide: 8, thick: 4, magazine: 6, color: 0x4f5257 },
  sniper: { length: 48, wide: 13, thick: 6, magazine: 6, color: 0x33383d },
  shotgun: { length: 40, wide: 13, thick: 6, magazine: 0, color: 0x5c4436 },
  mg: { length: 46, wide: 16, thick: 7, magazine: 12, color: 0x45464a },
  knife: { length: 12, wide: 6, thick: 2.5, magazine: 0, color: 0x9aa2ac },
  grenade: { length: 7, wide: 7, thick: 6, magazine: 0, color: 0x4a5a3a },
  c4: { length: 14, wide: 9, thick: 4, magazine: 0, color: 0x6a6152 },
};

/**
 * One gun lying on its side: receiver, stock, a barrel stub past the handguard,
 * the magazine that was in it, and a scope when the weapon has one.
 */
export function buildGroundWeaponGeometry(kind: WeaponKind): THREE.BufferGeometry {
  const s = GROUND_SHAPE[kind];
  const parts: THREE.BufferGeometry[] = [];

  parts.push(shadedBox(s.wide, s.thick, s.length, 0, 0, 0, 0.62));
  parts.push(shadedBox(s.wide * 0.72, s.thick * 0.85, s.length * 0.22, 0, 0, s.length * 0.55, 0.78));
  parts.push(
    shadedBox(s.thick * 0.45, s.thick * 0.45, s.length * 0.22, 0, s.thick * 0.2, -s.length * 0.55, 0.42),
  );
  if (s.magazine > 0) {
    parts.push(
      shadedBox(s.magazine, s.magazine * 0.9, s.magazine * 0.7, s.wide * 0.26, -s.thick * 0.5, s.length * 0.06, 0.88),
    );
  }
  if (kind === 'sniper') {
    parts.push(shadedBox(s.thick * 0.6, s.thick * 0.6, s.length * 0.3, 0, s.thick * 0.55, -s.length * 0.08, 0.34));
  }

  return mergeParts(parts, `ground-weapon:${kind}`);
}

/**
 * The floor layer: `sync(match.groundWeapons)` once per frame, nothing else.
 */
export class GroundWeaponRenderer {
  readonly group = new THREE.Group();

  private readonly meshes = new Map<WeaponKind, THREE.InstancedMesh>();
  private readonly counts = new Map<WeaponKind, number>();
  private readonly matrix = new THREE.Matrix4();
  private drawnInstances = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'render.ground-weapons';
    scene.add(this.group);
  }

  /** Guns currently drawn (debug / stats aid). */
  get drawn(): number {
    return this.drawnInstances;
  }

  /** Draw calls this layer costs right now: one per kind actually on the floor. */
  get drawCalls(): number {
    let calls = 0;
    for (const mesh of this.meshes.values()) if (mesh.count > 0) calls += 1;
    return calls;
  }

  /** Kinds that have ever been dropped this match (meshes are never freed). */
  get kinds(): number {
    return this.meshes.size;
  }

  /**
   * Place every gun on the floor for this frame. Allocates nothing after the
   * first frame that shows a given kind; a kind that has been seen keeps its
   * mesh and is simply drawn zero times when it has nothing on the floor.
   */
  sync(items: readonly GroundWeapon[]): void {
    this.drawnInstances = 0;
    for (const kind of this.meshes.keys()) this.counts.set(kind, 0);

    for (const gun of items) {
      const kind = gun.kind;
      const slot = this.counts.get(kind) ?? 0;
      if (slot >= GROUND_SLOTS_PER_KIND) continue;
      const mesh = this.meshFor(kind);
      const shape = GROUND_SHAPE[kind];

      this.matrix.makeRotationY(gun.id * GROUND_YAW_STEP);
      this.matrix.setPosition(gun.pos.x, gun.pos.y + GROUND_LIFT + shape.thick * 0.5, gun.pos.z);
      mesh.setMatrixAt(slot, this.matrix);
      mesh.instanceMatrix.needsUpdate = true;

      this.counts.set(kind, slot + 1);
      this.drawnInstances += 1;
    }

    for (const [kind, mesh] of this.meshes) {
      mesh.count = this.counts.get(kind) ?? 0;
    }
  }

  /** Drop every gun from the frame without freeing the meshes (round reset). */
  clear(): void {
    for (const mesh of this.meshes.values()) mesh.count = 0;
    this.drawnInstances = 0;
  }

  private meshFor(kind: WeaponKind): THREE.InstancedMesh {
    const existing = this.meshes.get(kind);
    if (existing) return existing;

    const geometry = buildGroundWeaponGeometry(kind);
    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      color: GROUND_SHAPE[kind].color,
      emissive: 0x0b0d11,
      emissiveIntensity: 1,
    });
    material.name = `ground-weapon-${kind}`;

    const mesh = new THREE.InstancedMesh(geometry, material, GROUND_SLOTS_PER_KIND);
    mesh.name = `render.ground-${kind}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Guns are spread over the whole map and the geometry is one gun small, so
    // its own bounding sphere would cull the mesh as soon as the player looked
    // away - same reason the actor layer opts out.
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.renderOrder = RENDER_ORDER_BODIES;
    mesh.count = 0;
    mesh.instanceMatrix.needsUpdate = true;

    this.group.add(mesh);
    this.meshes.set(kind, mesh);
    this.counts.set(kind, 0);
    return mesh;
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.meshes.clear();
    this.counts.clear();
    this.drawnInstances = 0;
  }
}