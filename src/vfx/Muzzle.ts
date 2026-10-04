// =============================================================================
// vfx/Muzzle.ts — the muzzle flash itself.
//
// Eight additive billboard quads, one InstancedMesh, one procedurally drawn star
// texture. Each flash is billboarded against the camera basis *at spawn time*:
// the effect lives 40-70 ms, far too short for the player's view to turn enough
// for a frozen billboard to look wrong, and freezing it removes a per-flash
// orientation solve from the frame path.
//
// Every flash gets a random roll, and unsilenced shots also get a longer, wider
// quad than silenced ones — the event's `silenced` flag is the only difference
// between the two, so the two must differ visibly.
// =============================================================================

import {
  AdditiveBlending,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Scene,
  type Texture,
} from 'three';
import type { Vec3 } from '../core/types';
import { RENDER_ORDER, writeHiddenMatrix, writeQuadMatrix } from './VfxMath';

/** Flashes alive at once. Firing is ~10/s and a flash lasts 70 ms, so 8 is generous. */
export const MUZZLE_SLOTS = 8;

/** Flash lifetime, s: the spec's 0.04-0.07 window. */
export const MUZZLE_LIFE_MIN = 0.04;
export const MUZZLE_LIFE_MAX = 0.07;

export interface MuzzleRecord {
  active: boolean;
  dirty: boolean;
  px: number; py: number; pz: number;
  /** Quad local +X (camera right at spawn). */
  rx: number; ry: number; rz: number;
  /** Quad local +Y (camera up at spawn). */
  ux: number; uy: number; uz: number;
  /** Quad local +Z (toward the camera at spawn). */
  vx: number; vy: number; vz: number;
  size: number;
  /** Roll about the view axis, stored pre-trig'd. */
  cr: number;
  sr: number;
  red: number; green: number; blue: number;
  brightness: number;
  age: number;
  life: number;
}

function createRecord(): MuzzleRecord {
  return {
    active: false, dirty: true,
    px: 0, py: 0, pz: 0,
    rx: 1, ry: 0, rz: 0,
    ux: 0, uy: 1, uz: 0,
    vx: 0, vy: 0, vz: -1,
    size: 14, cr: 1, sr: 0,
    red: 1, green: 0.86, blue: 0.6,
    brightness: 0, age: 0, life: MUZZLE_LIFE_MAX,
  };
}

export class MuzzlePool {
  readonly capacity: number;
  readonly records: MuzzleRecord[];
  cursor = 0;
  count = 0;
  spawned = 0;

  constructor(capacity: number = MUZZLE_SLOTS) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.records = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.records[i] = createRecord();
  }

  spawn(
    pos: Vec3,
    right: Vec3,
    up: Vec3,
    viewN: Vec3,
    size: number,
    roll: number,
    life: number,
    red: number,
    green: number,
    blue: number,
  ): MuzzleRecord {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.spawned++;

    const rec = this.records[index];
    rec.active = true;
    rec.dirty = true;
    rec.px = pos.x; rec.py = pos.y; rec.pz = pos.z;
    rec.rx = right.x; rec.ry = right.y; rec.rz = right.z;
    rec.ux = up.x; rec.uy = up.y; rec.uz = up.z;
    rec.vx = viewN.x; rec.vy = viewN.y; rec.vz = viewN.z;
    rec.size = Number.isFinite(size) && size > 0 ? size : 14;
    rec.cr = Math.cos(roll);
    rec.sr = Math.sin(roll);
    rec.red = red; rec.green = green; rec.blue = blue;
    rec.brightness = 0;
    rec.age = 0;
    rec.life = Number.isFinite(life) && life > 0 ? life : MUZZLE_LIFE_MAX;
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
}

export class MuzzleRenderer {
  readonly mesh: InstancedMesh;
  readonly material: MeshBasicMaterial;
  private readonly geometry: PlaneGeometry;
  private readonly color = new Color();
  private readonly m: Float32Array;
  private live = 0;

  constructor(scene: Scene, readonly pool: MuzzlePool, texture: Texture) {
    this.geometry = new PlaneGeometry(1, 1);
    this.material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      // A flash is light: keep it out of tone mapping so it still reads as white-hot.
      toneMapped: false,
    });
    // No shader patches here: additive brightness is carried entirely by the
    // instance colour, which three multiplies in without any extra attribute.

    this.mesh = new InstancedMesh(this.geometry, this.material, pool.capacity);
    this.mesh.name = 'vfx.muzzle';
    this.mesh.renderOrder = RENDER_ORDER.muzzle;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);

    this.m = new Float32Array(16);
    writeHiddenMatrix(this.m);
    for (let i = 0; i < pool.capacity; i++) {
      this.mesh.instanceMatrix.set(this.m, i * 16);
      this.mesh.setColorAt(i, BLACK);
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

      if (dt > 0) rec.age += dt;
      if (rec.age >= rec.life) {
        rec.active = false;
        rec.dirty = true;
        rec.brightness = 0;
        writeHiddenMatrix(this.m);
        this.mesh.instanceMatrix.set(this.m, i * 16);
        this.mesh.setColorAt(i, BLACK);
        rec.dirty = false;
        matrixDirty = true;
        colorDirty = true;
        continue;
      }

      live++;
      const t = rec.age / rec.life;
      // Attack over the first 18% of the life, then a steep fall-off: a flash
      // that ramps linearly reads as a fading lamp, not a detonation.
      const brightness = t < 0.18 ? t / 0.18 : 1 - (t - 0.18) / 0.82;
      if (!rec.dirty && brightness === rec.brightness) continue;

      // The star grows a little as it dies, which sells the expanding gas.
      const scale = rec.size * (0.72 + 0.5 * t);
      writeQuadMatrix(
        this.m,
        (rec.rx * rec.cr + rec.ux * rec.sr) * scale,
        (rec.ry * rec.cr + rec.uy * rec.sr) * scale,
        (rec.rz * rec.cr + rec.uz * rec.sr) * scale,
        (-rec.rx * rec.sr + rec.ux * rec.cr) * scale,
        (-rec.ry * rec.sr + rec.uy * rec.cr) * scale,
        (-rec.rz * rec.sr + rec.uz * rec.cr) * scale,
        rec.vx, rec.vy, rec.vz,
        rec.px, rec.py, rec.pz,
      );
      this.mesh.instanceMatrix.set(this.m, i * 16);
      const b = brightness < 0 ? 0 : brightness;
      this.color.setRGB(rec.red * b, rec.green * b, rec.blue * b);
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

const BLACK = new Color(0, 0, 0);
