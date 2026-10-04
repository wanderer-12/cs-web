// =============================================================================
// render/Characters.ts — the visible bodies of every actor in the match.
//
// WHY THIS FILE EXISTS: until now nothing in the repo ever created a mesh for a
// player, so an enemy was visible only as a muzzle spark and a 70 ms tracer -
// the "I cannot see the enemies" report. A body is built HERE out of exactly the
// boxes `combat/hitbox.ts` uses for damage, so what you see is what you can hit:
// legs 0..28.80, stomach 28.80..46.08, chest 46.08..63.36, head 63.36..72.00 on
// a standing 72-unit body (the head box is 13 wide, the hitbox's own
// HEAD_HALF_WIDTH * 2, and the helmet stays inside it).
//
// COST: three InstancedMeshes for the whole match - living bodies, corpses and
// the team-coloured silhouette rim - i.e. 3 draw calls plus 2 in the shadow
// pass, independent of how many actors exist. Geometry is built once; the
// per-frame path writes matrices (and a colour only when a team actually
// changed) into the instance buffers, with the same zero-allocation shape as the
// VFX pool renderers.
//
// FACING: the sim's forward(yaw) is (-sin yaw, 0, -cos yaw) (`core/math.ts`), so
// every box is authored front-toward -Z and placed with a plain rotation.y =
// yaw, exactly what three.js expects. Bodies lean with pitch so an actor aiming
// up or down reads as aiming, not as standing still.
// =============================================================================

import * as THREE from 'three';
import { HITBOX_BANDS, HEAD_HALF_WIDTH } from '../combat/hitbox';
import { MOVE, PLAYER } from '../core/config';
import type { ActorState, Team } from '../core/types';
import { mergeParts, shadedBox } from './parts';

/** Instanced slots. 5v5 with a human per side is 10; 16 leaves headroom. */
export const ACTOR_SLOTS = 16;

/**
 * Body colour per team: dark enough to read against the sand palette the map
 * uses (ground 0xd8c7a1, wall 0xbfae8e, floor 0xcdbd9c) and close to the radar
 * colours in `ui/pure.ts` (T #ffb14d, CT #5aa9ff).
 */
export const TEAM_BODY_COLOR: Readonly<Record<Team, number>> = {
  T: 0xe2603a,
  CT: 0x3f86e8,
  // Only reachable if a spectator state ever gets an actor slot; grey, like a corpse.
  SPEC: 0x8f8b96,
};
/** Rim colour per team; mates get a dimmed instance colour instead of a 4th mesh. */
export const TEAM_RIM_COLOR: Readonly<Record<Team, number>> = {
  T: 0xffa06a,
  CT: 0x9fd0ff,
  SPEC: 0xd8d4de,
};
/** Dead bodies are deliberately team-less grey so a corpse is never a target. */
export const CORPSE_COLOR = 0x6a6772;

/** Outline thickness: the rim hull is the body hull scaled up by this. */
export const RIM_SCALE = 1.055;
export const RIM_OPACITY = 0.55;
/** Mates' rim colour is multiplied by this (one mesh, two intensities). */
export const MATE_RIM_DIM = 0.32;

/** World pass is 3; VFX decals sit at 4 and tracers at 10 (`vfx/VfxMath.ts`). */
export const RENDER_ORDER_BODIES = 3;
export const RENDER_ORDER_RIMS = 5;

/** Vertical bounce while running, in units, and phase per unit travelled. */
export const BOB_LIFT = 1.6;
export const BOB_RATE = 0.055;
/** How much of the aim pitch a body leans by, and its cap. */
export const LEAN_PER_PITCH = 0.25;
export const MAX_LEAN = 0.6;
/** Crouching squashes the body vertically by up to this fraction. */
export const DUCK_SQUASH = 0.25;
/** Corpses are flattened to this fraction of their height. */
export const CORPSE_SQUASH = 0.7;

/**
 * The standing body. Every part stays inside the hitbox bands it represents;
 * when `flatShade` is given all parts get that shade instead of their own,
 * which is what the rim hull wants (a uniform outline, not a shaded one).
 */
export function buildActorGeometry(flatShade = 0): THREE.BufferGeometry {
  const height = PLAYER.standHeight;
  const halfWidth = PLAYER.radius;
  const legTop = height * HITBOX_BANDS.stomach;
  const stomachTop = height * HITBOX_BANDS.chest;
  const chestTop = height * HITBOX_BANDS.head;
  const headHalf = HEAD_HALF_WIDTH;

  const legW = 12;
  const legX = halfWidth - legW / 2 - 1;
  const bootH = 8;
  const shade = (part: number): number => (flatShade > 0 ? flatShade : part);

  const parts: THREE.BufferGeometry[] = [];
  const box = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    part: number,
  ): void => {
    parts.push(shadedBox(w, h, d, x, y, z, shade(part)));
  };

  // --- legs (0 .. legTop) --------------------------------------------------
  for (const side of [-1, 1]) {
    box(legW, bootH, 20, side * legX, bootH / 2, -2, 0.3); // boot
    box(legW, legTop - bootH, 16, side * legX, (bootH + legTop) / 2, 0, 0.45); // shin
  }

  // --- hips and vest (legTop .. chestTop) ---------------------------------
  box(28, stomachTop - legTop, 22, 0, (legTop + stomachTop) / 2, -1, 0.78);
  box(30, chestTop - stomachTop, 24, 0, (stomachTop + chestTop) / 2, -1, 1.0);

  // --- shoulders and arms: reach the hitbox edge (halfWidth), never past it
  for (const side of [-1, 1]) {
    box(7, 9, 15, side * (halfWidth - 3.5), chestTop - 4, 0, 0.92);
    box(6.5, 22, 11, side * (halfWidth - 3.5), 50, 2, 0.62);
  }

  // --- head (chestTop .. height) and helmet -------------------------------
  box(headHalf * 2, height - chestTop, headHalf * 2, 0, (chestTop + height) / 2, 0, 1.05);
  box(headHalf * 2 + 0.4, 5, headHalf * 2 + 0.4, 0, height - 2.5, 0, 0.26);
  box(9, 2.6, 1.4, 0, height - 7.4, -headHalf - 0.4, 0.12); // visor

  // --- backpack and slung rifle -------------------------------------------
  // Both stay inside the +-16 hitbox depth: a rifle hanging past the chest would
  // be a visible part no bullet can hit.
  box(10, 12, 5, 0, 54, 11.5, 0.55);
  box(3.6, 4, 13, 7, 49, -9, 0.22);
  box(2.8, 6, 3.6, 7, 44.5, -8, 0.18);

  return mergeParts(parts, 'actor body');
}

/** The same body, toppled: rotated flat, squashed and dropped onto y = 0. */
export function buildCorpseGeometry(): THREE.BufferGeometry {
  const geo = buildActorGeometry();
  geo.rotateX(Math.PI / 2);
  geo.scale(1, CORPSE_SQUASH, 1);
  geo.computeBoundingBox();
  const minY = geo.boundingBox?.min.y ?? 0;
  geo.translate(0, -minY, 0);
  return geo;
}

export interface CharacterSyncOptions {
  /** Actor id the camera is inside of (local player, or the spectate target). */
  hiddenId: number;
  /** Viewer team, so mates get a dimmer rim than enemies. */
  viewerTeam: Team | null;
  /** Render delta, for the walk bounce. */
  dt: number;
}

/**
 * Draws every actor in the match from `ActorState` list. Call `sync` once per
 * rendered frame with the full actor list (`Match.actorStates()`), after the
 * camera has been composed and before the map/VFX draw.
 */
export class CharacterRenderer {
  readonly group = new THREE.Group();

  private readonly bodies: THREE.InstancedMesh;
  private readonly corpses: THREE.InstancedMesh;
  private readonly rims: THREE.InstancedMesh;
  private readonly capacity: number;
  private readonly bodyGeom: THREE.BufferGeometry;
  private readonly corpseGeom: THREE.BufferGeometry;
  private readonly rimGeom: THREE.BufferGeometry;
  private readonly bodyMat: THREE.MeshLambertMaterial;
  private readonly corpseMat: THREE.MeshLambertMaterial;
  private readonly rimMat: THREE.MeshBasicMaterial;

  private readonly mat4 = new THREE.Matrix4();
  private readonly rimMat4 = new THREE.Matrix4();
  /** Zero-scale matrix: parks a slot so its instance draws nothing at all. */
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly vec = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly rimScale = new THREE.Vector3(1, 1, 1);
  private readonly color = new THREE.Color();

  private readonly lastBodyHex: Int32Array;
  private readonly lastRimHex: Int32Array;
  private readonly bobPhase: Float32Array;

  private visibleBodies = 0;
  private visibleCorpses = 0;

  constructor(scene: THREE.Scene, capacity: number = ACTOR_SLOTS) {
    this.capacity = Math.max(1, capacity);

    this.bodyGeom = buildActorGeometry();
    this.corpseGeom = buildCorpseGeometry();
    this.rimGeom = buildActorGeometry(1);

    // Lambert, not Standard: instances only need diffuse, and the palette is
    // flat by design. The tiny emissive keeps a body from going pure black in
    // shadow, which is what makes silhouettes readable indoors.
    this.bodyMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      emissive: 0x0b0d11,
      emissiveIntensity: 1,
    });
    this.bodyMat.name = 'actor-body';

    this.corpseMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      color: CORPSE_COLOR,
      emissive: 0x0b0d11,
      emissiveIntensity: 1,
    });
    this.corpseMat.name = 'actor-corpse';

    this.rimMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: RIM_OPACITY,
      side: THREE.BackSide,
      depthWrite: false,
      toneMapped: false,
    });
    this.rimMat.name = 'actor-rim';

    this.bodies = new THREE.InstancedMesh(this.bodyGeom, this.bodyMat, this.capacity);
    this.bodies.name = 'render.actor-bodies';
    this.corpses = new THREE.InstancedMesh(this.corpseGeom, this.corpseMat, this.capacity);
    this.corpses.name = 'render.actor-corpses';
    this.rims = new THREE.InstancedMesh(this.rimGeom, this.rimMat, this.capacity);
    this.rims.name = 'render.actor-rims';

    for (const mesh of [this.bodies, this.corpses, this.rims]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Instances are spread across the whole map, so the geometry's own
      // bounding sphere would cull the mesh the moment the player looks away.
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.count = 0;
    }
    this.bodies.castShadow = true;
    this.bodies.receiveShadow = true;
    this.bodies.renderOrder = RENDER_ORDER_BODIES;
    this.corpses.castShadow = true;
    this.corpses.receiveShadow = true;
    this.corpses.renderOrder = RENDER_ORDER_BODIES;
    this.rims.castShadow = false;
    this.rims.receiveShadow = false;
    this.rims.renderOrder = RENDER_ORDER_RIMS;

    // Park every slot on the hidden matrix (scale 0), then give the two
    // coloured meshes a defined instance colour so nothing starts black.
    this.mat4.makeScale(0, 0, 0);
    this.color.setRGB(0, 0, 0);
    for (let i = 0; i < this.capacity; i += 1) {
      this.bodies.setMatrixAt(i, this.mat4);
      this.corpses.setMatrixAt(i, this.mat4);
      this.rims.setMatrixAt(i, this.mat4);
      this.bodies.setColorAt(i, this.color);
      this.rims.setColorAt(i, this.color);
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.corpses.instanceMatrix.needsUpdate = true;
    this.rims.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    if (this.rims.instanceColor) this.rims.instanceColor.needsUpdate = true;

    this.lastBodyHex = new Int32Array(this.capacity).fill(-1);
    this.lastRimHex = new Int32Array(this.capacity).fill(-1);
    this.bobPhase = new Float32Array(this.capacity);

    this.group.name = 'render.characters';
    this.group.add(this.bodies);
    this.group.add(this.corpses);
    this.group.add(this.rims);
    scene.add(this.group);
  }

  /** Living bodies currently drawn (debug/stats aid). */
  get drawn(): number {
    return this.visibleBodies + this.visibleCorpses;
  }

  get drawnBodies(): number {
    return this.visibleBodies;
  }

  get drawnCorpses(): number {
    return this.visibleCorpses;
  }

  /**
   * Place every actor for this frame. Allocates nothing; the actor list is
   * `Match.actorStates()` in live-sim order, and slot i always belongs to
   * actors[i] so a slot never changes meaning between frames.
   */
  sync(actors: readonly ActorState[], opts: CharacterSyncOptions): void {
    const n = Math.min(actors.length, this.capacity);
    let bodies = 0;
    let corpses = 0;
    let matrixDirty = false;
    let bodyColorDirty = false;
    let rimColorDirty = false;

    this.bodies.count = n;
    this.corpses.count = n;
    this.rims.count = n;

    for (let i = 0; i < n; i += 1) {
      const a = actors[i];
      const hidden = a.id === opts.hiddenId;

      if (a.alive && !hidden) {
        // --- living body, bounced by travel and leaned by aim --------------
        const speed = Math.hypot(a.vel.x, a.vel.z);
        const speedNorm = Math.min(1, speed / MOVE.maxSpeed);
        this.bobPhase[i] = (this.bobPhase[i] + opts.dt * speed * BOB_RATE) % (Math.PI * 2);
        const lift = a.onGround ? Math.abs(Math.sin(this.bobPhase[i])) * BOB_LIFT * speedNorm : 0;
        const lean = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, a.pitch)) * LEAN_PER_PITCH;

        this.euler.set(lean, a.yaw, 0);
        this.quat.setFromEuler(this.euler);
        this.vec.set(a.pos.x, a.pos.y + lift, a.pos.z);
        const squash = 1 - DUCK_SQUASH * Math.max(0, Math.min(1, a.duckAmount));
        this.scale.set(1, squash, 1);
        this.mat4.compose(this.vec, this.quat, this.scale);
        this.rimScale.set(RIM_SCALE, RIM_SCALE * squash, RIM_SCALE);
        this.rimMat4.compose(this.vec, this.quat, this.rimScale);

        this.bodies.setMatrixAt(i, this.mat4);
        this.rims.setMatrixAt(i, this.rimMat4);
        this.corpses.setMatrixAt(i, this.hidden);
        matrixDirty = true;
        bodies += 1;

        const bodyHex = TEAM_BODY_COLOR[a.team];
        if (this.lastBodyHex[i] !== bodyHex) {
          this.color.setHex(bodyHex);
          this.bodies.setColorAt(i, this.color);
          this.lastBodyHex[i] = bodyHex;
          bodyColorDirty = true;
        }

        // Mates get a dimmed rim: one mesh, two intensities, zero extra calls.
        const mate = opts.viewerTeam !== null && a.team === opts.viewerTeam;
        const rimHex = TEAM_RIM_COLOR[a.team];
        const rimKey = mate ? -rimHex : rimHex;
        if (this.lastRimHex[i] !== rimKey) {
          this.color.setHex(rimHex);
          if (mate) this.color.multiplyScalar(MATE_RIM_DIM);
          this.rims.setColorAt(i, this.color);
          this.lastRimHex[i] = rimKey;
          rimColorDirty = true;
        }
      } else if (!a.alive) {
        // --- corpse: flat on the ground, team-less grey -------------------
        this.euler.set(0, a.yaw, 0);
        this.quat.setFromEuler(this.euler);
        this.vec.set(a.pos.x, a.pos.y, a.pos.z);
        this.scale.set(1, 1, 1);
        this.mat4.compose(this.vec, this.quat, this.scale);
        this.corpses.setMatrixAt(i, this.mat4);
        this.bodies.setMatrixAt(i, this.hidden);
        this.rims.setMatrixAt(i, this.hidden);
        matrixDirty = true;
        corpses += 1;
      } else {
        // --- the actor we are looking through: draw nothing ---------------
        this.corpses.setMatrixAt(i, this.hidden);
        this.bodies.setMatrixAt(i, this.hidden);
        this.rims.setMatrixAt(i, this.hidden);
        matrixDirty = true;
      }
    }

    this.visibleBodies = bodies;
    this.visibleCorpses = corpses;

    if (matrixDirty) {
      this.bodies.instanceMatrix.needsUpdate = true;
      this.corpses.instanceMatrix.needsUpdate = true;
      this.rims.instanceMatrix.needsUpdate = true;
    }
    if (bodyColorDirty && this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    if (rimColorDirty && this.rims.instanceColor) this.rims.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of [this.bodies, this.corpses, this.rims]) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    this.group.removeFromParent();
    this.bodyGeom.dispose();
    this.corpseGeom.dispose();
    this.rimGeom.dispose();
    this.bodyMat.dispose();
    this.corpseMat.dispose();
    this.rimMat.dispose();
  }

  }