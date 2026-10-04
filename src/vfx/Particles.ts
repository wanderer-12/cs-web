// =============================================================================
// vfx/Particles.ts — sparks, dust, blood, debris and smoke.
//
// Two THREE.Points clouds and one instanced smoke cloud, all fed from fixed-size
// ring buffers of the plain `Particle` record from VfxMath.ts. The Points clouds
// are PACKED every frame (live particles are written to the front of the shared
// attribute arrays and the draw range is set to the live count), which is why a
// firing range does not slowly fill a 500-particle buffer with dead slots.
//
// Per-particle size is a world-space radius carried in an `aSize` attribute and
// spliced into three's own point-size line (ShaderPatches.pointSizePatch). three
// already multiplies material.size by the device pixel ratio, so `material.size`
// stays 1 and a particle's world size is exactly its `aSize` — no HiDPI fudge.
//
// Per-particle colour is a 4-component vertex colour, which three's points
// shader consumes as vec4 (`vertexAlphas`) — that is how sparks go from white to
// red as they cool and dust fades out without a second material.
// =============================================================================

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicMaterial,
  NormalBlending,
  PlaneGeometry,
  Points,
  PointsMaterial,
  type Scene,
  type Texture,
} from 'three';
import type { Vec3 } from '../core/types';
import {
  RENDER_ORDER,
  createParticle,
  createCameraBasis,
  particleT,
  stepParticle,
  writeHiddenMatrix,
  writeQuadMatrix,
  type CameraBasis,
  type Particle,
} from './VfxMath';
import { applyPatches, instancedAlphaPatch } from './ShaderPatches';

/** Spark capacity: one 12-spark impact per frame for ~30 frames without reuse. */
export const SPARK_CAPACITY = 384;
/** Dust / blood / debris capacity (soft, non-additive). */
export const SOFT_CAPACITY = 384;
/** Billboarded smoke puffs (explosions, wall dust). */
export const SMOKE_CAPACITY = 96;

// ---------------------------------------------------------------------------
// Spawn description (one reusable struct — never allocate per impact)
// ---------------------------------------------------------------------------

export interface ParticleSpawn {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  sizeStart: number;
  sizeEnd: number;
  r: number; g: number; b: number;
  alphaStart: number;
  alphaEnd: number;
  gravity: number;
  drag: number;
  angle: number;
  spin: number;
  /** Bounce plane (sparks, debris); ignored when `plane` is false. */
  plane: boolean;
  pnx: number; pny: number; pnz: number; pd: number;
  restitution: number;
  friction: number;
  maxBounces: number;
}

export function createParticleSpawn(): ParticleSpawn {
  return {
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    life: 1,
    sizeStart: 1, sizeEnd: 1,
    r: 1, g: 1, b: 1,
    alphaStart: 1, alphaEnd: 0,
    gravity: -800, drag: 0,
    angle: 0, spin: 0,
    plane: false,
    pnx: 0, pny: 1, pnz: 0, pd: 0,
    restitution: 0.35, friction: 0.45, maxBounces: 1,
  };
}

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

/**
 * Fixed-capacity particle ring. Oldest particle is overwritten on wrap; nothing
 * is ever allocated, resized or sorted, so thousands of spawns cost no memory.
 */
export class ParticlePool {
  readonly capacity: number;
  readonly records: Particle[];
  cursor = 0;
  count = 0;
  spawned = 0;
  /** Spawns that overwrote a still-live particle (diagnostic only). */
  overflows = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.records = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.records[i] = createParticle();
  }

  spawn(opts: ParticleSpawn): Particle {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.spawned++;

    const p = this.records[index];
    if (p.active) this.overflows++;
    p.active = true;
    p.px = opts.x; p.py = opts.y; p.pz = opts.z;
    p.vx = opts.vx; p.vy = opts.vy; p.vz = opts.vz;
    p.age = 0;
    p.life = opts.life > 0 ? opts.life : 0.001;
    p.sizeStart = opts.sizeStart;
    p.sizeEnd = opts.sizeEnd;
    p.r = opts.r; p.g = opts.g; p.b = opts.b;
    p.alphaStart = opts.alphaStart;
    p.alphaEnd = opts.alphaEnd;
    p.gravity = opts.gravity;
    p.drag = opts.drag;
    p.angle = opts.angle;
    p.spin = opts.spin;
    p.plane = opts.plane;
    p.pnx = opts.pnx; p.pny = opts.pny; p.pnz = opts.pnz; p.pd = opts.pd;
    p.restitution = opts.restitution;
    p.friction = opts.friction;
    p.maxBounces = opts.maxBounces;
    p.bounces = 0;
    return p;
  }

  releaseAll(): void {
    for (let i = 0; i < this.capacity; i++) this.records[i].active = false;
    this.cursor = 0;
    this.count = 0;
  }

  get liveCount(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (this.records[i].active) n++;
    return n;
  }
}

// ---------------------------------------------------------------------------
// Points renderer
// ---------------------------------------------------------------------------

export type ParticleMode = 'additive' | 'soft';

/**
 * One Points cloud over one ring buffer. `mode` decides the blend: sparks are
 * additive light, everything else is soft matter that must be shaded like the
 * world around it (and therefore stays in tone mapping, unlike the sparks).
 */
export class ParticleRenderer {
  readonly points: Points;
  readonly material: PointsMaterial;
  private readonly geometry: BufferGeometry;
  private readonly position: BufferAttribute;
  private readonly color: BufferAttribute;
  private readonly size: BufferAttribute;
  private live = 0;

  constructor(
    scene: Scene,
    readonly pool: ParticlePool,
    mode: ParticleMode,
    texture: Texture,
    /** Hardware point-size clamp, in device pixels (see pointSizePatchLocal). */
    maxPointPixels = 512,
  ) {
    const capacity = pool.capacity;
    this.geometry = new BufferGeometry();
    this.position = new BufferAttribute(new Float32Array(capacity * 3), 3);
    this.color = new BufferAttribute(new Float32Array(capacity * 4), 4);
    this.size = new BufferAttribute(new Float32Array(capacity), 1);
    for (const attr of [this.position, this.color, this.size]) {
      attr.setUsage(DynamicDrawUsage);
    }
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('color', this.color);
    this.geometry.setAttribute('aSize', this.size);
    this.geometry.setDrawRange(0, 0);

    this.material = new PointsMaterial({
      // In world units, but scaled by tan(fov/2): three divides by the distance
      // only, so `setWorldScale` keeps a particle of radius r exactly r units
      // across at any field of view (fov 90, the game default, is scale 1).
      size: 1,
      sizeAttenuation: true,
      map: texture,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      // NormalBlending is passed explicitly: `undefined` would make three warn.
      blending: mode === 'additive' ? AdditiveBlending : NormalBlending,
      toneMapped: mode !== 'additive',
    });
    applyPatches(this.material, pointSizePatchLocal(maxPointPixels));

    this.points = new Points(this.geometry, this.material);
    this.points.name = mode === 'additive' ? 'vfx.sparks' : 'vfx.particles';
    this.points.renderOrder = mode === 'additive' ? RENDER_ORDER.sparks : RENDER_ORDER.particles;
    // Particles move far outside any bounding sphere we could keep in sync.
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
    this.points.visible = false;
    scene.add(this.points);
  }

  update(dt: number): void {
    const records = this.pool.records;
    const capacity = this.pool.capacity;
    const pos = this.position.array as Float32Array;
    const col = this.color.array as Float32Array;
    const siz = this.size.array as Float32Array;
    const additive = this.material.blending === AdditiveBlending;
    let n = 0;

    for (let i = 0; i < capacity; i++) {
      const p = records[i];
      if (!p.active) continue;
      stepParticle(p, dt);
      if (!p.active) continue;

      const t = particleT(p);
      const alpha = p.alphaStart + (p.alphaEnd - p.alphaStart) * t;
      const size = p.sizeStart + (p.sizeEnd - p.sizeStart) * t;
      const o3 = n * 3;
      const o4 = n * 4;
      pos[o3] = p.px; pos[o3 + 1] = p.py; pos[o3 + 2] = p.pz;
      if (additive) {
        // Additive blending multiplies by alpha as well, so folding alpha into
        // RGB here keeps the fade identical whether or not the shader path
        // honours the 4th component.
        col[o4] = p.r * alpha; col[o4 + 1] = p.g * alpha; col[o4 + 2] = p.b * alpha;
      } else {
        col[o4] = p.r; col[o4 + 1] = p.g; col[o4 + 2] = p.b;
      }
      col[o4 + 3] = alpha;
      siz[n] = size;
      n++;
    }

    this.live = n;
    if (n === 0) {
      // Idle: no draw call at all. The attribute contents are stale but the
      // draw range is empty, and the next spawn overwrites from index 0.
      this.points.visible = false;
      return;
    }

    this.points.visible = true;
    this.geometry.setDrawRange(0, n);
    // Upload only the packed prefix, not the whole capacity.
    this.position.clearUpdateRanges();
    this.position.addUpdateRange(0, n * 3);
    this.position.needsUpdate = true;
    this.color.clearUpdateRanges();
    this.color.addUpdateRange(0, n * 4);
    this.color.needsUpdate = true;
    this.size.clearUpdateRanges();
    this.size.addUpdateRange(0, n);
    this.size.needsUpdate = true;
  }

  get liveCount(): number {
    return this.live;
  }

  /**
   * Scale every particle so a world radius renders as that many world units at
   * the current field of view: `tan(fov / 2)`. The engine's default fov is 90
   * (scale 1); a scoped camera narrows it and points must shrink with it.
   */
  setWorldScale(scale: number): void {
    const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
    if (this.material.size !== s) this.material.size = s;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Splice a per-particle world size into three's own point-size line, and clamp
 * it: GPUs cap gl_PointSize (often at 1024 device pixels), and a dust puff right
 * in front of the eye would otherwise hit that cap and pop. `maxPixels` is baked
 * in as a literal, so the clamp costs a single `min` in the vertex shader.
 */
function pointSizePatchLocal(maxPixels: number) {
  const clamp = Math.max(16, Math.floor(maxPixels));
  return (shader: { vertexShader: string }) => {
    shader.vertexShader = `attribute float aSize;\n${shader.vertexShader}`;
    if (shader.vertexShader.includes('gl_PointSize = size;')) {
      shader.vertexShader = shader.vertexShader.replace(
        'gl_PointSize = size;',
        `gl_PointSize = min( size * aSize, ${clamp}.0 );`,
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Smoke (billboarded instanced puffs)
// ---------------------------------------------------------------------------

/**
 * Smoke needs to face the camera and expand over time, which is more than a
 * Points sprite can express, so puffs are instanced quads. Unlike the Points
 * clouds these keep a FIXED slot mapping (no packing): 96 slots is small, and a
 * fixed mapping means a puff that is still alive never has its matrix rewritten
 * from a different slot.
 */
export class SmokeRenderer {
  readonly mesh: InstancedMesh;
  readonly material: MeshBasicMaterial;
  private readonly geometry: PlaneGeometry;
  private readonly alpha: InstancedBufferAttribute;
  private readonly color = new Color();
  private readonly m: Float32Array;
  private cam: CameraBasis = createCameraBasis();
  private live = 0;

  constructor(scene: Scene, readonly pool: ParticlePool, texture: Texture) {
    const capacity = pool.capacity;
    this.geometry = new PlaneGeometry(1, 1);
    this.material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    applyPatches(this.material, instancedAlphaPatch());

    this.mesh = new InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.name = 'vfx.smoke';
    this.mesh.renderOrder = RENDER_ORDER.smoke;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);

    this.alpha = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.alpha.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('aAlpha', this.alpha);

    this.m = new Float32Array(16);
    writeHiddenMatrix(this.m);
    for (let i = 0; i < capacity; i++) {
      this.mesh.instanceMatrix.set(this.m, i * 16);
      this.mesh.setColorAt(i, BLACK);
      this.alpha.setX(i, 0);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.setUsage(DynamicDrawUsage);
      this.mesh.instanceColor.needsUpdate = true;
    }
    this.alpha.needsUpdate = true;
    scene.add(this.mesh);
  }

  /** `cam` must already hold this frame's camera basis (VfxSystem keeps it). */
  update(dt: number, cam: CameraBasis): void {
    this.cam = cam;
    const records = this.pool.records;
    const capacity = this.pool.capacity;
    let live = 0;
    let matrixDirty = false;
    let alphaDirty = false;

    for (let i = 0; i < capacity; i++) {
      const p = records[i];
      if (!p.active) {
        // Hide once; a spent puff costs nothing until its slot is reused.
        if (this.alpha.getX(i) !== 0) {
          writeHiddenMatrix(this.m);
          this.mesh.instanceMatrix.set(this.m, i * 16);
          this.alpha.setX(i, 0);
          matrixDirty = true;
          alphaDirty = true;
        }
        continue;
      }

      stepParticle(p, dt);
      if (!p.active) {
        writeHiddenMatrix(this.m);
        this.mesh.instanceMatrix.set(this.m, i * 16);
        this.alpha.setX(i, 0);
        this.mesh.setColorAt(i, BLACK);
        matrixDirty = true;
        alphaDirty = true;
        continue;
      }

      live++;
      const t = particleT(p);
      const alpha = p.alphaStart + (p.alphaEnd - p.alphaStart) * t;
      const size = p.sizeStart + (p.sizeEnd - p.sizeStart) * t;
      const cr = Math.cos(p.angle);
      const sr = Math.sin(p.angle);
      // Billboard with a roll about the view axis: the quad's own basis is the
      // camera's, so the puff faces the eye no matter where it drifts.
      writeQuadMatrix(
        this.m,
        (this.cam.rx * cr + this.cam.ux * sr) * size,
        (this.cam.ry * cr + this.cam.uy * sr) * size,
        (this.cam.rz * cr + this.cam.uz * sr) * size,
        (-this.cam.rx * sr + this.cam.ux * cr) * size,
        (-this.cam.ry * sr + this.cam.uy * cr) * size,
        (-this.cam.rz * sr + this.cam.uz * cr) * size,
        this.cam.fx * size, this.cam.fy * size, this.cam.fz * size,
        p.px, p.py, p.pz,
      );
      this.mesh.instanceMatrix.set(this.m, i * 16);
      this.alpha.setX(i, alpha);
      this.color.setRGB(p.r, p.g, p.b);
      this.mesh.setColorAt(i, this.color);
      matrixDirty = true;
      alphaDirty = true;
    }

    if (matrixDirty) this.mesh.instanceMatrix.needsUpdate = true;
    if (alphaDirty) this.alpha.needsUpdate = true;
    if (matrixDirty && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
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
