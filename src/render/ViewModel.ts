// =============================================================================
// render/ViewModel.ts — the first-person weapon.
//
// WHY ITS OWN SCENE: the gun lives ~10-45 units from the eye, and a map wall can
// be closer than that. Drawing it in the world scene means the barrel pokes
// through walls and the map's depth test clips the muzzle while you are hugging
// a corner. A second pass clears the depth buffer and draws ONE small scene with
// the same camera, which is what Counter-Strike and Quake do; the world above is
// already in the colour buffer, so the gun composites on top without ever
// intersecting geometry.
//
// It also makes the model trivially cheap to light: the scene carries its own
// hemisphere + sun rig mirroring `world/sky.ts` (whose sun constants are module
// private there), so the gun is lit like the world without touching the world's
// shadow pipeline.
//
// Everything is authored in CAMERA space: -Z forward, +X right, -Y down, the eye
// at the origin. `CAMERA.near` is 1.5, so no part may sit closer than that.
// `muzzleOffset` tells `vfx/VfxSystem` where the barrel tip is in the same space
// so the flash and the point light land on the barrel instead of on the eye.
// =============================================================================

import * as THREE from 'three';
import { CAMERA } from '../core/config';
import type { WeaponKind } from '../core/types';
import { DEFAULT_SUN_DIRECTION } from '../world/sky';
import { mergeParts, shadedBox } from './parts';

/** Mirrors sky.ts (hemisphere sky/ground colours and its private sun values). */
export const VIEW_HEMI_SKY = 0xbcd6ff;
export const VIEW_HEMI_GROUND = 0x9a8560;
export const VIEW_HEMI_INTENSITY = 0.55;
export const VIEW_SUN_COLOR = 0xfff2d6;
export const VIEW_SUN_INTENSITY = 1.15;

/** Gun kick per radian of view punch, and sway follow. */
export const VIEW_PUNCH_KICK = 1.35;
export const VIEW_SWAY_FOLLOW = 0.8;
export const VIEW_SWAY_ROLL = -0.5;
/**
 * Bob follow: the gun swings WIDER than the camera bounce (±0.62 u at a full
 * sprint) because the camera only takes 35% of it (`cameraRig` eye height), and
 * because the step rate is now ~2-3 Hz (`CAMERA.bobFreq`) the extra travel
 * reads as walking rather than the ~14 Hz vibration it used to be.
 */
export const VIEW_BOB_X = 1.2;
export const VIEW_BOB_Y = 1.3;
export const VIEW_DIP_FOLLOW = 0.6;
/** Idle breathing, so a standing player's gun is not frozen. */
export const VIEW_IDLE_AMPLITUDE = 0.18;
export const VIEW_IDLE_RATE = 1.6;
/**
 * Knife swing, driven by `pose.swing` (1 = the hit just landed, 0 = idle). The
 * blade sweeps across the view while thrusting forward and rolling through the
 * arc: melee has no muzzle flash and a flat recoil pattern, so this is the only
 * feedback a swing gets.
 */
export const VIEW_SWING_SWEEP = 1.25;
export const VIEW_SWING_PULL = 0.6;
export const VIEW_SWING_ACROSS = 10;
export const VIEW_SWING_PUSH = 7;
export const VIEW_SWING_DIP = 1.6;
export const VIEW_SWING_ROLL = 0.55;
/** Raise (weapon switch) and reload animation shapes. */
export const VIEW_RAISE_DROP = 7;
export const VIEW_RAISE_PITCH = 0.8;
export const VIEW_RELOAD_DROP = 5;
export const VIEW_RELOAD_PITCH = 0.55;
export const VIEW_RELOAD_ROLL = 0.35;
export const VIEW_MIN_DT = 1 / 30;
/**
 * Clearance kept between the rearmost gun part and the camera plane. The near
 * plane is at 1.5, so 2.5 leaves a margin and the stock is never sliced open.
 */
export const VIEW_REAR_GAP = 2.5;

export interface MuzzleOffset {
  /** Distance along the camera's forward axis (positive = in front of the eye). */
  readonly forward: number;
  /** Distance along the camera's right axis. */
  readonly right: number;
  /** Distance along the camera's -up axis. */
  readonly down: number;
}

interface WeaponModel {
  readonly group: THREE.Group;
  readonly muzzle: MuzzleOffset;
}

export const KNIFE_MUZZLE: MuzzleOffset = { forward: 10, right: 6, down: 6.2 };

/**
 * The models. `kind` is `WeaponKind` from `core/types.ts`, so every weapon the
 * sim can hand the player has something to look at - including knife, grenade
 * and C4, which have no muzzle flash (their offsets are unused).
 */
export function buildWeaponModel(kind: WeaponKind): WeaponModel {
  const parts: THREE.BufferGeometry[] = [];
  const add = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    shade: number,
  ): void => {
    parts.push(shadedBox(w, h, d, x, y, z, shade));
  };
  const hand = (x: number, y: number, z: number, shade = 0.28): void => {
    add(4.2, 4.4, 5.2, x, y, z, shade);
  };

  let muzzle: MuzzleOffset = KNIFE_MUZZLE;

  switch (kind) {
    case 'rifle': {
      add(4.2, 4.6, 20, 7, -6, -14, 0.5); // receiver
      add(3.4, 3.6, 12, 7, -5.6, -25, 0.45); // handguard
      add(1.6, 1.6, 12, 7, -5.2, -36, 0.35); // barrel
      add(2.2, 2.2, 3, 7, -5.2, -42.5, 0.3); // brake
      add(3, 8, 5, 7, -11.5, -13, 0.32); // magazine
      add(2.8, 6.5, 3.4, 7, -10.2, -5.5, 0.3); // grip
      add(3.2, 4.2, 8, 7, -6.6, 0, 0.45); // stock
      add(2.2, 2, 1.4, 7, -3.4, -8, 0.25); // rear sight
      add(1.2, 2.6, 1.2, 7, -3.6, -33, 0.25); // front sight
      hand(7.4, -8.4, -4);
      hand(6.6, -7.6, -23);
      muzzle = { forward: 44, right: 7, down: 5.2 };
      break;
    }
    case 'smg': {
      add(3.8, 4.2, 14, 7, -6, -11, 0.5);
      add(3, 3, 8, 7, -5.4, -18, 0.45);
      add(1.4, 1.4, 8, 7, -5, -25, 0.35);
      add(2.6, 7, 4, 7, -11, -9, 0.32);
      add(2.6, 6, 3.2, 7, -10, -3.5, 0.3);
      add(2.8, 3.4, 6, 7, -6.4, 1.5, 0.45);
      hand(7.4, -8.2, -2.5);
      hand(6.6, -7.6, -16);
      muzzle = { forward: 29, right: 7, down: 5 };
      break;
    }
    case 'pistol': {
      add(2.8, 3.4, 10, 6, -5.8, -8, 0.5); // slide
      add(2.4, 2.2, 7, 6, -8, -7.5, 0.4); // frame
      add(1.4, 1.4, 2, 6, -5.4, -13.5, 0.35); // muzzle
      add(2.4, 6.5, 3.2, 6, -10.6, -4.5, 0.3); // grip
      hand(6.2, -9.4, -3.5);
      muzzle = { forward: 14.5, right: 6, down: 5.4 };
      break;
    }
    case 'sniper': {
      add(4, 4.4, 22, 7, -6, -15, 0.5);
      add(2.8, 2.8, 13, 7, -3.2, -16, 0.25); // scope
      add(1.2, 1.6, 2, 7, -4.6, -12, 0.3); // mount
      add(1.2, 1.6, 2, 7, -4.6, -20, 0.3); // mount
      add(1.8, 1.8, 18, 7, -5.2, -33, 0.35); // barrel
      add(3, 5, 4, 7, -10, -12, 0.32);
      add(2.8, 6, 3.4, 7, -10, -5, 0.3);
      add(3.4, 4.4, 10, 7, -6.8, 1, 0.45);
      add(1.4, 1.4, 4, 8.6, -5, -12, 0.35); // bolt
      hand(7.4, -8.4, -4);
      hand(6.6, -7.6, -24);
      muzzle = { forward: 42, right: 7, down: 5.2 };
      break;
    }
    case 'shotgun': {
      add(4, 4.4, 16, 7, -6, -12, 0.45);
      add(2.4, 2.4, 14, 7, -5.4, -26, 0.4);
      add(3.4, 3.4, 8, 7, -6, -22, 0.3); // pump
      add(2, 2, 12, 7, -7.8, -26, 0.25); // tube
      add(3.4, 4.4, 9, 7, -6.6, 0.5, 0.45);
      hand(7.4, -8.6, 0);
      hand(6.6, -8, -22);
      muzzle = { forward: 33, right: 7, down: 5.4 };
      break;
    }
    case 'mg': {
      add(5, 5.4, 24, 7, -6.4, -16, 0.45);
      add(2.2, 2.2, 16, 7, -5.6, -34, 0.35);
      add(5, 6, 7, 7, -11, -13, 0.3); // ammo box
      add(1.2, 8, 1.2, 4.6, -10, -28, 0.25); // bipod
      add(1.2, 8, 1.2, 9.4, -10, -28, 0.25); // bipod
      add(2.8, 6, 3.4, 7, -10.6, -5, 0.3);
      add(3.4, 4.6, 9, 7, -7, 1, 0.45);
      hand(7.6, -8.8, -4);
      hand(6.4, -8, -24);
      muzzle = { forward: 42, right: 7, down: 5.6 };
      break;
    }
    case 'knife': {
      add(1, 2.6, 11, 6, -6, -14, 1.15); // blade
      add(3, 1.2, 1.4, 6, -6, -8.5, 0.4); // guard
      add(2, 2, 5, 6, -6.2, -5, 0.25); // handle
      hand(6.2, -7.4, -3.6);
      muzzle = KNIFE_MUZZLE;
      break;
    }
    case 'grenade': {
      add(3.4, 4.2, 3.4, 6, -8, -11, 0.45);
      add(1.6, 1.6, 1.6, 6, -5.6, -11, 0.3); // fuse cap
      hand(6.2, -9, -8);
      muzzle = KNIFE_MUZZLE;
      break;
    }
    case 'c4': {
      add(7, 3.2, 10, 6, -8.5, -12, 0.5);
      add(3, 0.8, 3, 6, -6.7, -13, 0.3); // keypad
      add(1.2, 1.2, 1.2, 8.4, -8, -13, 1.2); // status light
      hand(6.4, -10, -8);
      muzzle = KNIFE_MUZZLE;
      break;
    }
    default: {
      add(4.2, 4.6, 18, 7, -6, -13, 0.5);
      hand(7.4, -8.4, -4);
      muzzle = { forward: 34, right: 7, down: 5.2 };
      break;
    }
  }

  const geometry = mergeParts(parts, `weapon ${kind}`);
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.name = `view-${kind}`;

  // Keep the whole gun in FRONT of the near plane. A rifle stock otherwise ends
  // up behind the eye (z > -1.5), where the near plane slices it open; shifting
  // the geometry forward and moving the muzzle by the same amount keeps the
  // flash on the real barrel tip instead of inside the receiver.
  geometry.computeBoundingBox();
  const rear = (geometry.boundingBox?.max.z ?? 0) + VIEW_REAR_GAP;
  if (rear > 0) {
    geometry.translate(0, 0, -rear);
    muzzle = { forward: muzzle.forward + rear, right: muzzle.right, down: muzzle.down };
  }

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `render.viewmodel.${kind}`;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // The gun never wants the world's fog, and it is drawn in its own pass.
  mesh.frustumCulled = false;

  const group = new THREE.Group();
  group.name = `view-model.${kind}`;
  group.add(mesh);
  return { group, muzzle };
}

export interface ViewModelPose {
  bobX: number;
  bobY: number;
  dip: number;
  punchYaw: number;
  punchPitch: number;
  swayYaw: number;
  swayPitch: number;
  /** Melee swing phase: 1 right after a knife hit, decaying to 0. */
  swing: number;
  /** 0..1 horizontal speed, used to calm the idle breathing while running. */
  speedNorm: number;
  alive: boolean;
  /** True while the scope is up: the model is hidden behind the optic. */
  scoped: boolean;
  reloading: boolean;
  reloadTime: number;
  drawTime: number;
  dt: number;
}

/**
 * Owns the view-model scene. The engine drives it with `setWeapon` + `update`
 * and draws it with `renderer.render(viewModel.scene, camera)` in a second pass
 * after `renderer.clearDepth()`.
 */
export class ViewModel {
  readonly scene = new THREE.Scene();
  /** False when nothing should be drawn: dead, spectating, or scoped. */
  visible = false;

  private readonly root = new THREE.Group();
  private readonly models = new Map<WeaponKind, WeaponModel>();
  private readonly camera: THREE.PerspectiveCamera;
  /**
   * The view-model scene is authored in *camera space* (x ≈ +7 right, y ≈ -6 down,
   * z ≈ -14 forward), so it must be drawn with a camera parked at the origin —
   * NOT the world camera. Rendering it with the world camera puts the gun back in
   * map coordinates near (0,0,0), thousands of units away from the player, where
   * it is invisible. Only the projection is shared.
   */
  private readonly viewCamera: THREE.PerspectiveCamera;
  private readonly projection = { fov: 0, aspect: 0, near: 0, far: 0 };
  private kind: WeaponKind | null = null;
  private muzzle: MuzzleOffset = KNIFE_MUZZLE;
  private raiseT = 1;
  private reloadT = 0;
  private reloadActive = false;
  private time = 0;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.viewCamera = camera.clone();
    this.viewCamera.name = 'view-model.camera';
    this.viewCamera.position.set(0, 0, 0);
    this.viewCamera.rotation.set(0, 0, 0);
    this.viewCamera.scale.set(1, 1, 1);
    this.viewCamera.updateMatrixWorld(true);
    this.scene.name = 'view-model';
    this.root.name = 'view-model.root';
    this.scene.add(this.root);

    const sun = new THREE.DirectionalLight(VIEW_SUN_COLOR, VIEW_SUN_INTENSITY);
    sun.position.copy(DEFAULT_SUN_DIRECTION).multiplyScalar(100);
    sun.name = 'view-sun';
    this.scene.add(sun);

    const hemi = new THREE.HemisphereLight(VIEW_HEMI_SKY, VIEW_HEMI_GROUND, VIEW_HEMI_INTENSITY);
    hemi.name = 'view-hemi';
    this.scene.add(hemi);
  }

  /** Where the barrel tip is in camera space; feed it to `VfxSystem`. */
  get muzzleOffset(): MuzzleOffset {
    return this.muzzle;
  }

  get weapon(): WeaponKind | null {
    return this.kind;
  }

  /** Switch the shown model. Starts the raise animation on every change. */
  setWeapon(kind: WeaponKind): void {
    if (this.kind === kind) return;
    const model = this.model(kind);
    for (const other of this.models.values()) other.group.visible = false;
    model.group.visible = true;
    this.kind = kind;
    this.muzzle = model.muzzle;
    this.raiseT = 0;
    this.reloadT = 0;
    this.reloadActive = false;
  }

  /**
   * Compose the model for this frame. Cheap: a handful of scalar writes into one
   * small group transform, no allocation, no per-object matrices.
   */
  update(pose: ViewModelPose): void {
    const dt = Math.min(pose.dt, VIEW_MIN_DT);
    this.time += dt;

    if (!pose.alive) {
      this.visible = false;
      return;
    }

    this.raiseT = Math.min(1, this.raiseT + dt / Math.max(0.05, pose.drawTime));

    if (pose.reloading) {
      this.reloadT = Math.min(1, this.reloadT + dt / Math.max(0.1, pose.reloadTime));
      this.reloadActive = true;
    } else if (this.reloadActive) {
      // Interrupted or finished: collapse the wave instead of snapping it.
      this.reloadT = Math.max(0, this.reloadT - dt * 3);
      if (this.reloadT <= 0) this.reloadActive = false;
    }

    const idle = Math.sin(this.time * VIEW_IDLE_RATE) * VIEW_IDLE_AMPLITUDE * (1 - pose.speedNorm);
    this.root.position.set(pose.bobX * VIEW_BOB_X, pose.bobY * VIEW_BOB_Y + pose.dip * VIEW_DIP_FOLLOW + idle, 0);
    this.root.rotation.set(
      pose.punchPitch * VIEW_PUNCH_KICK + pose.swayPitch * VIEW_SWAY_FOLLOW,
      pose.punchYaw * VIEW_PUNCH_KICK + pose.swayYaw * VIEW_SWAY_FOLLOW,
      pose.swayYaw * VIEW_SWAY_ROLL,
    );

    const reloadWave = Math.sin(Math.PI * this.reloadT);
    if (reloadWave > 0) {
      this.root.position.y -= reloadWave * VIEW_RELOAD_DROP;
      this.root.rotation.x += reloadWave * VIEW_RELOAD_PITCH;
      this.root.rotation.z += reloadWave * VIEW_RELOAD_ROLL;
    }

    const raise = 1 - this.raiseT;
    if (raise > 0) {
      this.root.position.y -= raise * VIEW_RAISE_DROP;
      this.root.rotation.x += raise * VIEW_RAISE_PITCH;
    }

    const swing = Math.max(0, Math.min(1, pose.swing));
    if (swing > 0) {
      // `phase` runs 0 -> 1 over the swing; `thrust` peaks at the halfway point,
      // which is where the blade crosses the middle of the screen.
      const phase = 1 - swing;
      const thrust = Math.sin(phase * Math.PI);
      this.root.position.x += (0.5 - phase) * VIEW_SWING_ACROSS;
      this.root.position.y -= thrust * VIEW_SWING_DIP;
      this.root.position.z -= thrust * VIEW_SWING_PUSH;
      this.root.rotation.y += VIEW_SWING_SWEEP * phase - VIEW_SWING_PULL;
      this.root.rotation.z += (1 - phase * 2) * VIEW_SWING_ROLL;
    }

    this.visible = !pose.scoped;
  }

  /**
   * The camera this pass must be rendered with: at the origin, sharing only the
   * world camera's projection (so a scoped/zoomed fov or a resize stays in step).
   */
  get renderCamera(): THREE.PerspectiveCamera {
    const src = this.camera;
    const cam = this.viewCamera;
    if (
      this.projection.fov !== src.fov ||
      this.projection.aspect !== src.aspect ||
      this.projection.near !== src.near ||
      this.projection.far !== src.far
    ) {
      this.projection.fov = src.fov;
      this.projection.aspect = src.aspect;
      this.projection.near = src.near;
      this.projection.far = src.far;
      cam.fov = src.fov;
      cam.aspect = src.aspect;
      cam.near = src.near;
      cam.far = src.far;
      cam.updateProjectionMatrix();
    }
    return cam;
  }

  private model(kind: WeaponKind): WeaponModel {
    let model = this.models.get(kind);
    if (!model) {
      model = buildWeaponModel(kind);
      model.group.visible = false;
      this.models.set(kind, model);
      this.root.add(model.group);
    }
    return model;
  }

  dispose(): void {
    for (const model of this.models.values()) {
      model.group.removeFromParent();
      model.group.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) for (const m of material) m.dispose();
        else material?.dispose();
      });
    }
    this.models.clear();
    this.root.removeFromParent();
    this.scene.clear();
  }
}

/** Kept next to the camera constants so a future near-plane change is visible. */
export const VIEW_NEAR_LIMIT = CAMERA.near;