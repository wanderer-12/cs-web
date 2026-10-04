// =============================================================================
// vfx/Casings.ts — ejected shell casings.
//
// 48 casings, one InstancedMesh of small brass boxes, and a pure ballistic
// stepper (`stepCasing`) that owns all of the motion: gravity, one bounce off
// the floor plane, then rolling friction until the case stops.
//
// The floor plane is a plain height (`restY`) rather than a raycast: a casing
// lives for a second and lands within arm's reach of the shooter, so querying
// the world per case per frame would cost far more than the visual is worth.
// VfxSystem derives `restY` from the shot origin (eye height above the level
// floor) and exposes `setCasingFloorY()` for levels whose floor is elsewhere.
// =============================================================================

import {
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  BoxGeometry,
  Quaternion,
  Vector3,
  type Scene,
} from 'three';
import { PERF } from '../core/config';
import type { Vec3 } from '../core/types';
import { RENDER_ORDER, writeHiddenMatrix } from './VfxMath';

/** Matches MOVE.gravity in core/config.ts: casings share the world's gravity. */
export const CASING_GRAVITY = -800;
/** Speed below which a bouncing casing is considered at rest (~0.5 m/s). */
const CASING_REST_SPEED = 26;

export interface CasingRecord {
  active: boolean;
  dirty: boolean;
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  /** Unit tumble axis (perpendicular to the ejection velocity). */
  ax: number; ay: number; az: number;
  /** Tumble rate, rad/s. */
  spin: number;
  /** Accumulated tumble angle, rad. */
  angle: number;
  age: number;
  life: number;
  /** Floor height the case bounces on and finally rests at. */
  restY: number;
  settled: boolean;
  /** Fully at rest: skips its matrix write entirely (see update()). */
  rested: boolean;
  red: number; green: number; blue: number;
  /** Colour multiplier; casings fade out instead of popping away. */
  brightness: number;
}

function createRecord(): CasingRecord {
  return {
    active: false, dirty: true,
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    ax: 1, ay: 0, az: 0,
    spin: 0, angle: 0,
    age: 0, life: 2.5, restY: -60, settled: false, rested: false,
    red: 0.82, green: 0.65, blue: 0.24, brightness: 1,
  };
}

/**
 * Advance one casing. Pure (no three.js, no globals) so the ballistics can be
 * unit tested: `p += v*dt + a*dt²/2; v += a*dt` is the exact constant
 * acceleration form, which keeps trajectories identical across frame rates.
 */
export function stepCasing(rec: CasingRecord, dt: number): boolean {
  if (!rec.active) return false;
  if (!(dt > 0)) return true;
  rec.age += dt;
  if (rec.age >= rec.life) {
    rec.active = false;
    rec.dirty = true;
    rec.brightness = 0;
    return false;
  }

  if (!rec.settled) {
    rec.px += rec.vx * dt;
    rec.py += rec.vy * dt + 0.5 * CASING_GRAVITY * dt * dt;
    rec.pz += rec.vz * dt;
    rec.vy += CASING_GRAVITY * dt;
    rec.angle += rec.spin * dt;

    if (rec.py <= rec.restY) {
      rec.py = rec.restY;
      if (rec.vy < 0) {
        rec.vy = -rec.vy * 0.3;
        rec.vx *= 0.5;
        rec.vz *= 0.5;
        rec.spin *= 0.55;
        if (rec.vy < CASING_REST_SPEED) {
          rec.vy = 0;
          rec.settled = true;
        }
      }
    }
  } else {
    const drag = Math.exp(-6 * dt);
    rec.vx *= drag;
    rec.vz *= drag;
    rec.px += rec.vx * dt;
    rec.pz += rec.vz * dt;
    rec.angle += rec.spin * dt;
    rec.spin *= Math.exp(-3 * dt);
    rec.py = rec.restY;
    // Snap the tail of the decay to zero so a resting case stops costing a
    // matrix write every frame (see CasingRenderer.update).
    if (Math.abs(rec.vx) + Math.abs(rec.vz) < 0.02 && Math.abs(rec.spin) < 0.01) {
      rec.vx = 0;
      rec.vz = 0;
      rec.spin = 0;
      rec.rested = true;
    }
  }
  return true;
}

/** Fixed-capacity casing ring (`PERF.casings` = 48). */
export class CasingPool {
  readonly capacity: number;
  readonly records: CasingRecord[];
  cursor = 0;
  count = 0;
  spawned = 0;

  constructor(capacity: number = PERF.casings) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.records = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.records[i] = createRecord();
  }

  spawn(
    origin: Vec3,
    velocity: Vec3,
    axis: Vec3,
    spin: number,
    restY: number,
    life: number,
  ): CasingRecord {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.spawned++;

    const rec = this.records[index];
    rec.active = true;
    rec.dirty = true;
    rec.px = origin.x; rec.py = origin.y; rec.pz = origin.z;
    rec.vx = velocity.x; rec.vy = velocity.y; rec.vz = velocity.z;
    rec.ax = axis.x; rec.ay = axis.y; rec.az = axis.z;
    rec.spin = spin;
    rec.angle = 0;
    rec.age = 0;
    rec.life = Number.isFinite(life) && life > 0 ? life : 2.5;
    rec.restY = Number.isFinite(restY) ? restY : origin.y - 60;
    rec.settled = false;
    rec.brightness = 1;
    return rec;
  }

  releaseAll(): void {
    for (let i = 0; i < this.capacity; i++) {
      const rec = this.records[i];
      if (!rec.active) continue;
      rec.active = false;
      rec.dirty = true;
      rec.brightness = 0;
    }
    this.cursor = 0;
    this.count = 0;
  }

  get liveCount(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (this.records[i].active) n++;
    return n;
  }
}

export class CasingRenderer {
  readonly mesh: InstancedMesh;
  readonly material: MeshBasicMaterial;
  private readonly geometry: BoxGeometry;
  private readonly color = new Color();
  private readonly position = new Vector3();
  private readonly axis = new Vector3();
  private readonly quaternion = new Quaternion();
  private readonly scale = new Vector3(1, 1, 1);
  private readonly matrix = new Matrix4();
  private readonly m: Float32Array;
  private live = 0;

  constructor(scene: Scene, readonly pool: CasingPool) {
    // A 5.56 case is ~5.7 mm x 45 mm; at 52.49 units/m that is 0.3 x 2.36 units.
    this.geometry = new BoxGeometry(0.3, 2.4, 0.3);
    this.material = new MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new InstancedMesh(this.geometry, this.material, pool.capacity);
    this.mesh.name = 'vfx.casings';
    this.mesh.renderOrder = RENDER_ORDER.decals;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);

    this.m = new Float32Array(16);
    writeHiddenMatrix(this.m);
    for (let i = 0; i < pool.capacity; i++) {
      this.mesh.instanceMatrix.set(this.m, i * 16);
      this.mesh.setColorAt(i, BLACK_COLOR);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.setUsage(DynamicDrawUsage);
      this.mesh.instanceColor.needsUpdate = true;
    }
    scene.add(this.mesh);
  }

  update(dt: number): void {
    const records = this.pool.records;
    const capacity = this.pool.capacity;
    let live = 0;
    let matrixDirty = false;
    let colorDirty = false;

    for (let i = 0; i < capacity; i++) {
      const rec = records[i];

      if (!rec.active) {
        if (rec.dirty) {
          writeHiddenMatrix(this.m);
          this.mesh.instanceMatrix.set(this.m, i * 16);
          rec.brightness = 0;
          rec.dirty = false;
          matrixDirty = true;
        }
        continue;
      }

      stepCasing(rec, dt);
      if (!rec.active) {
        writeHiddenMatrix(this.m);
        this.mesh.instanceMatrix.set(this.m, i * 16);
        this.mesh.setColorAt(i, BLACK_COLOR);
        matrixDirty = true;
        colorDirty = true;
        continue;
      }

      live++;
      // Fade over the last fifth of the lifetime; a casing that winks out while
      // in the corner of the eye is more noticeable than 48 live instances.
      const fadeT = (rec.age - rec.life * 0.8) / (rec.life * 0.2);
      const brightness = fadeT <= 0 ? 1 : fadeT >= 1 ? 0 : 1 - fadeT;
      // A settled case stops moving entirely (rested), so it only needs a write
      // when its fade advances — that is what keeps 48 idle cases nearly free.
      if (rec.rested && !rec.dirty && brightness === rec.brightness) continue;

      this.position.set(rec.px, rec.py, rec.pz);
      this.axis.set(rec.ax, rec.ay, rec.az);
      this.quaternion.setFromAxisAngle(this.axis, rec.angle);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.mesh.instanceMatrix.set(this.matrix.elements, i * 16);
      this.color.setRGB(rec.red * brightness, rec.green * brightness, rec.blue * brightness);
      this.mesh.setColorAt(i, this.color);
      rec.brightness = brightness;
      rec.dirty = false;
      matrixDirty = true;
      colorDirty = true;
    }

    if (matrixDirty) this.mesh.instanceMatrix.needsUpdate = true;
    if (colorDirty && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.live = live;
  }

  get liveCount(): number {
    return this.live;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

const BLACK_COLOR = new Color(0, 0, 0);
