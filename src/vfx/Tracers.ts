// =============================================================================
// vfx/Tracers.ts — the thin bright streak a bullet leaves in the air.
//
// One additive InstancedMesh draws all 24 tracers. The quad is built in world
// space: its local +Y runs along the shot, its local +X is the camera-right
// component of the tracer direction, so the streak stays edge-on to the eye at
// every angle. Each shot also gets a random roll about its own axis, which is
// what stops several tracers fired down the same line from z-fighting into one
// flat band.
//
// Brightness is the instance colour (additive blending makes colour and opacity
// the same thing), so the fade needs no extra shader patch.
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
} from 'three';
import { PERF } from '../core/config';
import type { Vec3 } from '../core/types';
import { RENDER_ORDER, writeHiddenMatrix, writeQuadMatrix } from './VfxMath';

/** Default tracer lifetime; the fade is stretched over exactly this window. */
export const TRACER_LIFE = 0.07;

/** Fully faded instance colour (additive: black contributes nothing). */
const BLACK = new Color(0, 0, 0);

export interface TracerRecord {
  active: boolean;
  dirty: boolean;
  /** Quad centre (origin + dir * length/2). */
  px: number; py: number; pz: number;
  /** Unit shot direction (quad local +Y). */
  dx: number; dy: number; dz: number;
  /** Unit camera-facing right (quad local +X). */
  rx: number; ry: number; rz: number;
  /** Unit view normal (quad local +Z). */
  vx: number; vy: number; vz: number;
  length: number;
  width: number;
  /** Roll about the tracer axis, stored pre-trig'd for the update path. */
  cr: number;
  sr: number;
  red: number; green: number; blue: number;
  /** Current colour multiplier, 0 when spent. */
  brightness: number;
  age: number;
  life: number;
}

function createRecord(): TracerRecord {
  return {
    active: false, dirty: true,
    px: 0, py: 0, pz: 0,
    dx: 0, dy: 0, dz: -1,
    rx: 1, ry: 0, rz: 0,
    vx: 0, vy: 1, vz: 0,
    length: 100, width: 4, cr: 1, sr: 0,
    red: 1, green: 0.86, blue: 0.5,
    brightness: 0, age: 0, life: TRACER_LIFE,
  };
}

/** Fixed-capacity tracer ring; `PERF.tracers` (24) streaks at most, ever. */
export class TracerPool {
  readonly capacity: number;
  readonly records: TracerRecord[];
  cursor = 0;
  count = 0;
  spawned = 0;

  constructor(capacity: number = PERF.tracers) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.records = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.records[i] = createRecord();
  }

  /**
   * `origin` is the muzzle, `dir` the unit shot direction, `right`/`viewN` the
   * camera-facing quad frame and `roll` a per-shot angle about the tracer axis.
   */
  spawn(
    origin: Vec3,
    dir: Vec3,
    right: Vec3,
    viewN: Vec3,
    length: number,
    width: number,
    life: number,
    roll: number,
  ): TracerRecord {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.spawned++;

    const rec = this.records[index];
    const len = Number.isFinite(length) && length > 0 ? length : 100;
    rec.active = true;
    rec.dirty = true;
    rec.px = origin.x + dir.x * len * 0.5;
    rec.py = origin.y + dir.y * len * 0.5;
    rec.pz = origin.z + dir.z * len * 0.5;
    rec.dx = dir.x; rec.dy = dir.y; rec.dz = dir.z;
    rec.rx = right.x; rec.ry = right.y; rec.rz = right.z;
    rec.vx = viewN.x; rec.vy = viewN.y; rec.vz = viewN.z;
    rec.length = len;
    rec.width = Number.isFinite(width) && width > 0 ? width : 4;
    rec.cr = Math.cos(roll);
    rec.sr = Math.sin(roll);
    rec.brightness = 1;
    rec.age = 0;
    rec.life = Number.isFinite(life) && life > 0 ? life : TRACER_LIFE;
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

export class TracerRenderer {
  readonly mesh: InstancedMesh;
  readonly material: MeshBasicMaterial;
  private readonly geometry: PlaneGeometry;
  private readonly color = new Color();
  private readonly m: Float32Array;
  private live = 0;

  constructor(scene: Scene, readonly pool: TracerPool) {
    this.geometry = new PlaneGeometry(1, 1);
    this.material = new MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      // Additive streaks are light, not surface: keep them out of tone mapping
      // so a muzzle-adjacent tracer still reads as bright.
      toneMapped: false,
    });
    this.mesh = new InstancedMesh(this.geometry, this.material, pool.capacity);
    this.mesh.name = 'vfx.tracers';
    this.mesh.renderOrder = RENDER_ORDER.tracers;
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
      // Fast rise, slow tail: an instantly bright line reads as a laser.
      const brightness = t < 0.18 ? t / 0.18 : 1 - (t - 0.18) / 0.82;
      if (!rec.dirty && brightness === rec.brightness) continue;

      const scale = rec.width;
      writeQuadMatrix(
        this.m,
        (rec.rx * rec.cr + rec.vx * rec.sr) * scale,
        (rec.ry * rec.cr + rec.vy * rec.sr) * scale,
        (rec.rz * rec.cr + rec.vz * rec.sr) * scale,
        rec.dx * rec.length,
        rec.dy * rec.length,
        rec.dz * rec.length,
        -rec.rx * rec.sr + rec.vx * rec.cr,
        -rec.ry * rec.sr + rec.vy * rec.cr,
        -rec.rz * rec.sr + rec.vz * rec.cr,
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
