// =============================================================================
// player/cameraRig.ts — the layered first-person camera.
//
// Order matters and is the whole point:
//   base(yaw,pitch) -> view punch (recoil) -> sway (mouse inertia)
//   -> bob (walking) -> landing dip -> eye height (crouch)
// Punch is applied on top of the *player's* aim but never fed back into it: the
// player's yaw/pitch stays the true aim, so recovering from a spray is a matter
// of pulling the mouse down exactly as far as the pattern pushed you up.
// =============================================================================

import * as THREE from 'three';
import { CAMERA } from '../core/config';
import { MOVE } from '../core/config';
import { approach, clamp, clamp01, deg } from '../core/math';
import { playerEyeHeight } from './movement';
import type { Vec3 } from '../core/types';

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  /** Recoil-induced view offset, in radians. Decays toward zero. */
  punchYaw = 0;
  punchPitch = 0;
  /** Sway offsets in radians, driven by mouse velocity. */
  swayYaw = 0;
  swayPitch = 0;
  /** Landing dip, in units (applied to eye height). */
  dip = 0;
  /** Bob phase accumulator. */
  bobPhase = 0;
  /** Smoothed bob amplitude (units): ramps the bob in and out instead of popping. */
  bobAmountSmooth = 0;
  /** Melee swing timer in seconds; restarted by `startSwing` on every knife hit. */
  private swingTimer = 0;
  /** Extra vertical shake used by explosions. */
  shake = 0;
  /** Screen-shake rotational component. */
  shakeYaw = 0;
  shakePitch = 0;

  /** FOV target; scoping changes this. */
  baseFov: number = CAMERA.fov;
  fov: number = CAMERA.fov;
  private fovTarget: number = CAMERA.fov;

  /** Debug capture of the last composed transform. */
  readonly debug = { punchYaw: 0, punchPitch: 0, swayYaw: 0, swayPitch: 0, bobY: 0, dip: 0, eye: 0 };

  /**
   * The last composed pose, for whoever else has to follow the camera. The
   * first-person weapon reads this every frame (`render/ViewModel`), so unlike
   * `debug` it is written unconditionally, in release builds too.
   */
  readonly viewPose = {
    bobX: 0,
    bobY: 0,
    dip: 0,
    punchYaw: 0,
    punchPitch: 0,
    swayYaw: 0,
    swayPitch: 0,
    eye: 0,
    /** Melee swing phase: 1 the instant a knife fires, decaying to 0. */
    swing: 0,
  };

  private smoothedMouseDX = 0;
  private smoothedMouseDY = 0;
  private shakeRngState = 0x2545f491;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, aspect, CAMERA.near, CAMERA.far);
    this.camera.rotation.order = 'YXZ';
    this.camera.matrixAutoUpdate = true;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Add recoil to the view. `amount` is in radians. */
  addPunch(dx: number, dy: number): void {
    this.punchYaw += dx;
    this.punchPitch += dy;
    // Hard cap so a full magazine cannot flip the camera upside down.
    this.punchYaw = clamp(this.punchYaw, -0.5, 0.5);
    this.punchPitch = clamp(this.punchPitch, -0.45, 0.45);
  }

  /** Add a screen shake impulse (explosions, bomb). */
  addShake(amount: number): void {
    this.shake = Math.min(1.4, this.shake + amount);
  }

  /** Immediately clear punch (used when a weapon is drawn or the player dies). */
  clearPunch(): void {
    this.punchYaw = 0;
    this.punchPitch = 0;
  }

  setFov(fov: number, snap = false): void {
    this.fovTarget = fov;
    if (snap) {
      this.fov = fov;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Compose the camera for rendering.
   * @param aimYaw   true aim (player yaw)
   * @param aimPitch true aim (player pitch)
   * @param feet     player feet position
   * @param duck     0..1
   * @param vel      player velocity (bob is driven by horizontal speed)
   * @param onGround used to stop bob mid-air
   * @param frameDt  render delta, used for exponential smoothing
   */
  update(
    aimYaw: number,
    aimPitch: number,
    feet: Vec3,
    duck: number,
    vel: Vec3,
    onGround: boolean,
    frameDt: number,
    mouseDX: number,
    mouseDY: number,
  ): void {
    const dt = Math.min(frameDt, 1 / 30);

    // --- sway: follows mouse velocity with a slow return -------------------
    const mouseK = 0.0016;
    this.smoothedMouseDX += (mouseDX - this.smoothedMouseDX) * approach(26, dt);
    this.smoothedMouseDY += (mouseDY - this.smoothedMouseDY) * approach(26, dt);
    const targetSwayYaw = clamp(this.smoothedMouseDX * mouseK, -CAMERA.swayMax, CAMERA.swayMax);
    const targetSwayPitch = clamp(-this.smoothedMouseDY * mouseK, -CAMERA.swayMax, CAMERA.swayMax);
    this.swayYaw += (targetSwayYaw - this.swayYaw) * approach(CAMERA.swaySmooth, dt);
    this.swayPitch += (targetSwayPitch - this.swayPitch) * approach(CAMERA.swaySmooth, dt);

    // --- punch recovery ----------------------------------------------------
    // Recovery is proportional to the current punch so big spikes settle fast
    // without overshooting: exactly the "rubber band back" feel of a spray.
    const punchDecay = approach(CAMERA.punchDecay, dt);
    this.punchYaw -= this.punchYaw * punchDecay;
    this.punchPitch -= this.punchPitch * punchDecay;

    // --- bob ---------------------------------------------------------------
    const speed = Math.hypot(vel.x, vel.z);
    const speedNorm = clamp01(speed / MOVE.maxSpeed);
    if (onGround && speedNorm > 0.05) {
      this.bobPhase += dt * CAMERA.bobFreq * (0.55 + speedNorm);
    } else {
      // Settle the phase toward a zero-crossing so stopping does not freeze
      // the weapon at an odd offset.
      this.bobPhase += dt * 2.0;
    }
    const bobTarget = CAMERA.bobAmount * speedNorm * (onGround ? 1 : 0.15);
    // Smooth the amplitude so starting/stopping and landing do not pop the
    // weapon: the raw target jumps to full the instant `onGround` flips.
    this.bobAmountSmooth += (bobTarget - this.bobAmountSmooth) * approach(CAMERA.bobSmooth, dt);
    const bobAmount = this.bobAmountSmooth;
    const bobY = Math.sin(this.bobPhase * Math.PI * 2) * bobAmount;
    const bobX = Math.cos(this.bobPhase * Math.PI * 1) * bobAmount * 0.55;

    // --- melee swing -------------------------------------------------------
    // A knife swing is a view animation, not recoil: the knife's recoil pattern
    // is flat, so without this a melee hit would have no feedback at all. The
    // phase peaks mid-swing for the camera roll and decays to 0 on its own.
    if (this.swingTimer > 0) this.swingTimer = Math.max(0, this.swingTimer - dt);
    const swing = CAMERA.meleeSwingTime > 0 ? this.swingTimer / CAMERA.meleeSwingTime : 0;
    const swingRoll =
      swing > 0 ? -CAMERA.meleeSwingRoll * Math.sin((1 - swing) * Math.PI) : 0;

    // --- landing dip -------------------------------------------------------
    this.dip -= this.dip * approach(CAMERA.landingDipRecover, dt);

    // --- shake -------------------------------------------------------------
    if (this.shake > 0.0005) {
      this.shakeRngState = (this.shakeRngState * 1664525 + 1013904223) >>> 0;
      const r1 = (this.shakeRngState / 4294967296) * 2 - 1;
      this.shakeRngState = (this.shakeRngState * 1664525 + 1013904223) >>> 0;
      const r2 = (this.shakeRngState / 4294967296) * 2 - 1;
      this.shakeYaw = r1 * this.shake * 0.02;
      this.shakePitch = r2 * this.shake * 0.02;
      this.shake -= this.shake * approach(6.5, dt);
    } else {
      this.shake = 0;
      this.shakeYaw = 0;
      this.shakePitch = 0;
    }

    // --- fov ---------------------------------------------------------------
    if (Math.abs(this.fov - this.fovTarget) > 0.01) {
      this.fov += (this.fovTarget - this.fov) * approach(18, dt);
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    // --- compose -----------------------------------------------------------
    const eye = playerEyeHeight(duck) + bobY * 0.35 + this.dip;
    this.camera.position.set(feet.x + bobX * 0.06, feet.y + eye, feet.z);
    this.camera.rotation.set(
      clamp(aimPitch + this.punchPitch + this.swayPitch + this.shakePitch, -Math.PI / 2, Math.PI / 2),
      aimYaw + this.punchYaw + this.swayYaw + this.shakeYaw,
      swingRoll,
    );

    if (import.meta.env?.DEV) {
      this.debug.punchYaw = this.punchYaw;
      this.debug.punchPitch = this.punchPitch;
      this.debug.swayYaw = this.swayYaw;
      this.debug.swayPitch = this.swayPitch;
      this.debug.bobY = bobY;
      this.debug.dip = this.dip;
      this.debug.eye = eye;
    }

    // --- view model pose ---------------------------------------------------
    // Same values the camera just used, handed to the weapon layer. Deliberately
    // outside the DEV guard above: the gun swings in release builds too.
    const pose = this.viewPose;
    pose.bobX = bobX;
    pose.bobY = bobY;
    pose.dip = this.dip;
    pose.punchYaw = this.punchYaw;
    pose.punchPitch = this.punchPitch;
    pose.swayYaw = this.swayYaw;
    pose.swayPitch = this.swayPitch;
    pose.eye = eye;
    pose.swing = swing;
  }

  /** Start a melee (knife) swing: the view model sweeps and the camera rolls. */
  startSwing(): void {
    this.swingTimer = CAMERA.meleeSwingTime;
  }

  /** Trigger the landing dip from a landing speed (units/s). */
  land(vSpeed: number): void {
    const amount = Math.min(CAMERA.landingDipMax, vSpeed * CAMERA.landingDipPerSpeed);
    this.dip = -amount;
  }

  get fovDegrees(): number {
    return this.fov;
  }
}

export { deg };
