// =============================================================================
// vfx/VfxSystem.ts — the VFX entry point the engine talks to.
//
// This file is the only part of the layer that knows about game events. It owns
// every pool, wires the event bus to the recipes in Impacts.ts / Explosions.ts,
// and drives each renderer once per frame.
//
// Design rules that explain most of the code below:
//   * The pools are created once, here, and never grow. Every event handler only
//     overwrites preallocated records, so a firing-range session cannot leak.
//   * `update()` is written to be free when nothing is on screen: it keeps an
//     `anyActive` summary from the previous frame plus a "something spawned since
//     the last update" flag, and returns before touching any pool when both are
//     false. `dt <= 0` also returns immediately.
//   * Nothing here relies on the camera the engine passed at construction: the
//     per-frame camera refreshes the billboard basis, so a camera swap (spectator,
//     demo playback) needs no re-construction.
// =============================================================================

import type { PerspectiveCamera, Scene, Texture } from 'three';
import { PERF, PLAYER } from '../core/config';
import type { EventBus } from '../core/events';
import { Rng } from '../core/rng';
import type { GameEventMap, SurfaceMaterial, Vec3 } from '../core/types';
import { CasingPool, CasingRenderer } from './Casings';
import { createDecalAtlasTexture, DecalPool, DecalRenderer } from './Decals';
import {
  ExplosionPool,
  ExplosionRenderer,
  emitExplosionParticles,
  spawnExplosionVisual,
} from './Explosions';
import {
  spawnBloodPuff,
  spawnImpact,
  spawnLandDust,
  spawnMuzzleSmoke,
  type ImpactContext,
} from './Impacts';
import { MUZZLE_LIFE_MAX, MUZZLE_LIFE_MIN, MuzzlePool, MuzzleRenderer } from './Muzzle';
import {
  ParticlePool,
  ParticleRenderer,
  SMOKE_CAPACITY,
  SOFT_CAPACITY,
  SPARK_CAPACITY,
  SmokeRenderer,
} from './Particles';
import { createMuzzleTexture, createSmokeTexture, createSoftParticleTexture } from './Textures';
import { TRACER_LIFE, TracerPool, TracerRenderer } from './Tracers';
import { createCameraBasis, clampDt, isFiniteVec, safeDir, type CameraBasis } from './VfxMath';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The collision query the VFX layer may use. Deliberately structural instead of
 * importing `RaycastOptions`: the engine's world satisfies it as-is, and a test
 * double only has to provide this one method.
 */
export interface VfxWorld {
  raycast(start: Vec3, dir: Vec3, maxDist: number, opts?: unknown): {
    hit: boolean;
    point: Vec3;
    normal: Vec3;
    material: SurfaceMaterial;
    distance: number;
  };
}

export interface VfxOptions {
  scene: Scene;
  camera: PerspectiveCamera;
  /** Optional collision query, used only to place explosion scorch marks. */
  world?: VfxWorld;
  /** Cap on the device pixel ratio used for point-size clamping (default PERF). */
  maxPixelRatio?: number;
}

/** Diagnostic counters; only `stats()` allocates (it builds a fresh object). */
export interface VfxStats {
  decals: number;
  tracers: number;
  casings: number;
  muzzle: number;
  sparks: number;
  particles: number;
  smoke: number;
  explosions: number;
  flashAmount: number;
  flashlight: number;
}

const TAU = Math.PI * 2;

/** Muzzle offset from the eye: ahead of it, slightly right and below the sights. */
const MUZZLE_FORWARD = 11;
const MUZZLE_RIGHT = 3;
const MUZZLE_DOWN = 4;
/** Flash size in world units, unsilenced vs suppressed. */
const MUZZLE_SIZE = 46;
const MUZZLE_SILENCED_SIZE = 20;

/** A tracer is a fixed-length streak: the impact event marks the actual wall. */
const TRACER_LENGTH = 1400;
const TRACER_WIDTH = 2.2;
/** Radians; alternated per shot so co-planar streaks cannot z-fight. */
const TRACER_ROLL = 0.5;

const CASING_LIFE = 2.5;
/** Blood burst multiplier for a death (the `hit` that caused it is the anchor). */
const BLOOD_BURST_SCALE = 2.4;
/** A death this recent may still use its last hit position. */
const HIT_MEMORY_TIME = 1.5;
const FOOTSTEP_MEMORY_SLOTS = 24;
const HIT_MEMORY_SLOTS = 32;
/** Flashbang range falloff: nothing beyond this distance flashes the screen. */
const FLASH_MAX_RANGE = 2600;
/** C4: `bombExploded` carries only a site, so the radius is a constant here. */
const BOMB_BLAST_RADIUS = 2200;
/** Muzzle light decay, 1/s (an exponential falls to ~5% in 100 ms). */
const FLASHLIGHT_DECAY = 30;
/** GPU point-size clamp (device pixels) so a close puff cannot hit the driver cap. */
const MAX_POINT_PIXELS = 512;

/** Jump-dust ring: the engine's `land` event carries no position. */
interface ActorSpot {
  actorId: number;
  x: number;
  y: number;
  z: number;
  t: number;
}
/** Last hit per victim, so `death` (which also carries no position) can bleed. */
interface HitSpot {
  victimId: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  t: number;
}
/** Bomb plant per site, so `bombExploded` can be placed. */
interface SiteSpot {
  valid: boolean;
  x: number;
  y: number;
  z: number;
}

export class VfxSystem {
  /** Screen-space flash overlay (0..1). The HUD reads this every frame. */
  get flashAmount(): number {
    return this._flashAmount;
  }

  /** Muzzle light intensity (0..1) for the renderer's point light, if it uses it. */
  get flashlightIntensity(): number {
    return this._flashlightIntensity;
  }

  /**
   * Where that light should sit (the last muzzle). The returned vector is the
   * system's own scratch object: read it, do not keep or mutate it.
   */
  get flashlightPosition(): Vec3 {
    return this._flashlightPos;
  }

  private readonly scene: Scene;
  private camera: PerspectiveCamera;
  private readonly world: VfxWorld | undefined;
  private readonly rng = new Rng(0x5eed1a7);
  private readonly camBasis: CameraBasis = createCameraBasis();

  // Pools (fixed size, created once) and their renderers.
  private readonly decals: DecalPool;
  private readonly decalRenderer: DecalRenderer;
  private readonly tracers: TracerPool;
  private readonly tracerRenderer: TracerRenderer;
  private readonly casings: CasingPool;
  private readonly casingRenderer: CasingRenderer;
  private readonly muzzle: MuzzlePool;
  private readonly muzzleRenderer: MuzzleRenderer;
  private readonly sparks: ParticlePool;
  private readonly sparkRenderer: ParticleRenderer;
  private readonly soft: ParticlePool;
  private readonly softRenderer: ParticleRenderer;
  private readonly smoke: ParticlePool;
  private readonly smokeRenderer: SmokeRenderer;
  private readonly explosions: ExplosionPool;
  private readonly explosionRenderer: ExplosionRenderer;

  private readonly ctx: ImpactContext;
  /** Second, blast-shaped view of the same pools (no per-frame allocation). */
  private readonly blastCtx: {
    explosions: ExplosionPool;
    decals: DecalPool;
    smoke: ParticlePool;
    soft: ParticlePool;
    rng: Rng;
  };
  private readonly textures: Texture[] = [];

  private readonly actors: ActorSpot[] = [];
  private readonly actorCursor = { value: 0 };
  private readonly hits: HitSpot[] = [];
  private readonly hitCursor = { value: 0 };
  private readonly sites: SiteSpot[] = [
    { valid: false, x: 0, y: 0, z: 0 },
    { valid: false, x: 0, y: 0, z: 0 },
  ];

  private unsubs: Array<() => void> = [];
  private time = 0;
  private spawnedSinceUpdate = false;
  private anyActive = false;
  private tracerRollSign = 1;

  private _flashAmount = 0;
  private flashDecay = 0;
  private _flashlightIntensity = 0;
  private flashlightExternal = false;
  private readonly _flashlightPos: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly maxPixelRatio: number;

  constructor(opts: VfxOptions) {
    this.scene = opts.scene;
    this.camera = opts.camera;
    this.world = opts.world;
    this.maxPixelRatio = Number.isFinite(opts.maxPixelRatio)
      ? Math.max(1, opts.maxPixelRatio as number)
      : PERF.maxPixelRatio;

    // Textures: four procedural canvases for the whole layer (atlas included).
    const atlas = createDecalAtlasTexture();
    const softTex = createSoftParticleTexture(64);
    const smokeTex = createSmokeTexture(64);
    const muzzleTex = createMuzzleTexture(128);
    this.textures.push(atlas, softTex, smokeTex, muzzleTex);

    // Pools come straight from PERF so the budget lives in one place.
    this.decals = new DecalPool(PERF.decals);
    this.tracers = new TracerPool(PERF.tracers);
    this.casings = new CasingPool(PERF.casings);
    this.muzzle = new MuzzlePool();
    this.sparks = new ParticlePool(SPARK_CAPACITY);
    this.soft = new ParticlePool(SOFT_CAPACITY);
    this.smoke = new ParticlePool(SMOKE_CAPACITY);
    this.explosions = new ExplosionPool();

    this.decalRenderer = new DecalRenderer(this.scene, this.decals, atlas);
    this.tracerRenderer = new TracerRenderer(this.scene, this.tracers);
    this.casingRenderer = new CasingRenderer(this.scene, this.casings);
    this.muzzleRenderer = new MuzzleRenderer(this.scene, this.muzzle, muzzleTex);
    this.sparkRenderer = new ParticleRenderer(this.scene, this.sparks, 'additive', softTex, this.pointPixelClamp());
    this.softRenderer = new ParticleRenderer(this.scene, this.soft, 'soft', softTex, this.pointPixelClamp());
    this.smokeRenderer = new SmokeRenderer(this.scene, this.smoke, smokeTex);
    this.explosionRenderer = new ExplosionRenderer(this.scene, this.explosions);

    this.ctx = {
      decals: this.decals,
      sparks: this.sparks,
      soft: this.soft,
      smoke: this.smoke,
      rng: this.rng,
    };
    this.blastCtx = {
      explosions: this.explosions,
      decals: this.decals,
      smoke: this.smoke,
      soft: this.soft,
      rng: this.rng,
    };

    for (let i = 0; i < FOOTSTEP_MEMORY_SLOTS; i++) {
      this.actors.push({ actorId: -1, x: 0, y: 0, z: 0, t: -1e9 });
    }
    for (let i = 0; i < HIT_MEMORY_SLOTS; i++) {
      this.hits.push({ victimId: -1, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, t: -1e9 });
    }

    this.readCameraBasis(this.camera);
    this.applyFovScale(this.camera);
    // A zero delta must not cost anything, and every pool starts empty.
    this.anyActive = false;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Subscribe to the game bus. Calling it twice re-subscribes safely (the old
   * subscriptions are dropped first), and `detach()` is always idempotent.
   */
  attach(bus: EventBus): void {
    this.detach();
    this.unsubs = [
      bus.on('shot', this.onShot),
      bus.on('impact', this.onImpact),
      bus.on('hit', this.onHit),
      bus.on('death', this.onDeath),
      bus.on('grenadeExplode', this.onGrenadeExplode),
      bus.on('bombExploded', this.onBombExploded),
      bus.on('bombPlanted', this.onBombPlanted),
      bus.on('flash', this.onFlash),
      bus.on('footstep', this.onFootstep),
      bus.on('land', this.onLand),
    ];
  }

  detach(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
  }

  dispose(): void {
    this.detach();
    this.decalRenderer.dispose();
    this.tracerRenderer.dispose();
    this.casingRenderer.dispose();
    this.muzzleRenderer.dispose();
    this.sparkRenderer.dispose();
    this.softRenderer.dispose();
    this.smokeRenderer.dispose();
    this.explosionRenderer.dispose();
    for (const texture of this.textures) texture.dispose();
    this.textures.length = 0;
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  /**
   * Advance every effect. `dt` is in seconds; a `dt` of 0, NaN or a multi-second
   * tab-switch delta is clamped rather than integrated (see `clampDt`).
   */
  update(dt: number, camera: PerspectiveCamera): void {
    if (camera) {
      this.camera = camera;
      this.readCameraBasis(camera);
      this.applyFovScale(camera);
    }
    const step = clampDt(dt);
    if (step <= 0) return;

    this.time += step;
    this.decayFlash(step);
    this.decayFlashlight(step);

    // Idle: nothing was live last frame and nothing spawned since. The overlay
    // and the flashlight were still decayed above, so nothing is skipped.
    if (!this.anyActive && !this.spawnedSinceUpdate) return;

    this.explosions.update(step);
    emitExplosionParticles(this.blastCtx, step);
    this.decalRenderer.update(step);
    this.tracerRenderer.update(step);
    this.casingRenderer.update(step);
    this.muzzleRenderer.update(step);
    this.sparkRenderer.update(step);
    this.softRenderer.update(step);
    this.smokeRenderer.update(step, this.camBasis);
    this.explosionRenderer.update();

    this.anyActive =
      this.decalRenderer.liveCount > 0 ||
      this.tracerRenderer.liveCount > 0 ||
      this.casingRenderer.liveCount > 0 ||
      this.muzzleRenderer.liveCount > 0 ||
      this.sparkRenderer.liveCount > 0 ||
      this.softRenderer.liveCount > 0 ||
      this.smokeRenderer.liveCount > 0 ||
      this.explosionRenderer.liveCount > 0;
    this.spawnedSinceUpdate = false;
  }

  // -------------------------------------------------------------------------
  // Public spawn API (also used by the event handlers)
  // -------------------------------------------------------------------------

  /** Bullet impact: decal + sparks + dust. Safe with a zero/invalid normal. */
  spawnImpact(point: Vec3, normal: Vec3, material: SurfaceMaterial, dustOnly = false): void {
    spawnImpact(this.ctx, point, normal, material, dustOnly);
    this.spawnedSinceUpdate = true;
  }

  /** Jump/land dust. Called from the `land` handler when a position is known. */
  spawnLandDust(pos: Vec3, speed: number): void {
    spawnLandDust(this.ctx, pos, speed);
    this.spawnedSinceUpdate = true;
  }

  /**
   * Explosion visuals. Exposed because `bombExploded` carries no position: the
   * engine can call this directly with the site's real coordinates. `groundY` is
   * resolved with a downward raycast against `world` when it is not supplied.
   */
  spawnExplosion(pos: Vec3, radius: number, kind = 'he', groundY?: number): void {
    if (!isFiniteVec(pos)) return;
    const gy = Number.isFinite(groundY)
      ? (groundY as number)
      : this.groundYAt(pos.x, pos.y, pos.z, radius);
    spawnExplosionVisual(
      this.blastCtx,
      pos,
      radius,
      kind,
      gy,
    );
    // A blast also lights up the screen: the HUD overlay is cheap and sells it.
    const flash = Math.min(0.85, 0.35 + radius / 6000);
    if (flash > this._flashAmount) {
      this._flashAmount = flash;
      this.flashDecay = flash / 0.45;
    }
    this.spawnedSinceUpdate = true;
  }

  /** Muzzle light for a point light the renderer may own. Marks it externally owned. */
  setFlashlightIntensity(v: number): void {
    this._flashlightIntensity = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    this.flashlightExternal = true;
  }

  /** Drop every effect (round restart, level change). Keeps the pools. */
  reset(): void {
    this.decals.releaseAll();
    this.tracers.releaseAll();
    this.casings.releaseAll();
    this.muzzle.releaseAll();
    this.sparks.releaseAll();
    this.soft.releaseAll();
    this.smoke.releaseAll();
    this.explosions.releaseAll();
    for (const spot of this.actors) { spot.actorId = -1; spot.t = -1e9; }
    for (const hit of this.hits) { hit.victimId = -1; hit.t = -1e9; }
    for (const site of this.sites) site.valid = false;
    this._flashAmount = 0;
    this.flashDecay = 0;
    this._flashlightIntensity = 0;
    this.time = 0;
    // One update must run so every instance is written away.
    this.anyActive = true;
    this.spawnedSinceUpdate = false;
  }

  /** Live counts per effect. Builds a fresh object, so do not call it per frame. */
  stats(): VfxStats {
    return {
      decals: this.decalRenderer.liveCount,
      tracers: this.tracerRenderer.liveCount,
      casings: this.casingRenderer.liveCount,
      muzzle: this.muzzleRenderer.liveCount,
      sparks: this.sparkRenderer.liveCount,
      particles: this.softRenderer.liveCount,
      smoke: this.smokeRenderer.liveCount,
      explosions: this.explosionRenderer.liveCount,
      flashAmount: this._flashAmount,
      flashlight: this._flashlightIntensity,
    };
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private onShot = (e: GameEventMap['shot']): void => {
    if (!e || !isFiniteVec(e.origin) || !isFiniteVec(e.dir)) return;
    const cam = this.camBasis;
    const dir = safeDir(tmpDir, e.dir);
    const silenced = e.silenced === true;

    // --- muzzle flash (billboarded, random roll) ---
    tmpPoint.x = e.origin.x + dir.x * MUZZLE_FORWARD + cam.rx * MUZZLE_RIGHT - cam.ux * MUZZLE_DOWN;
    tmpPoint.y = e.origin.y + dir.y * MUZZLE_FORWARD + cam.ry * MUZZLE_RIGHT - cam.uy * MUZZLE_DOWN;
    tmpPoint.z = e.origin.z + dir.z * MUZZLE_FORWARD + cam.rz * MUZZLE_RIGHT - cam.uz * MUZZLE_DOWN;
    tmpRight.x = cam.rx; tmpRight.y = cam.ry; tmpRight.z = cam.rz;
    tmpUp.x = cam.ux; tmpUp.y = cam.uy; tmpUp.z = cam.uz;
    tmpView.x = cam.fx; tmpView.y = cam.fy; tmpView.z = cam.fz;
    const life = MUZZLE_LIFE_MIN + this.rng.float() * (MUZZLE_LIFE_MAX - MUZZLE_LIFE_MIN);
    // Brightness is the instance colour: half-scale it for a suppressor.
    const tint = silenced ? 0.45 : 1;
    this.muzzle.spawn(
      tmpPoint, tmpRight, tmpUp, tmpView,
      silenced ? MUZZLE_SILENCED_SIZE : MUZZLE_SIZE,
      this.rng.float() * TAU, life,
      tint, 0.86 * tint, 0.52 * tint,
    );

    // --- muzzle smoke (light for a suppressor) ---
    spawnMuzzleSmoke(this.ctx, tmpPoint, dir, silenced ? 1 : 3);

    // --- tracer ---
    // The quad must contain the shot axis and face the eye: its local X is the
    // component of the camera's right axis orthogonal to the shot. That
    // degenerates only when the shot runs exactly along the view axis (which is
    // the common case), so the camera's own right vector is the fallback.
    crossDir(dir, cam.fx, cam.fy, cam.fz, tmpRight);
    if (!orthonormalize(tmpRight, dir)) {
      tmpRight.x = cam.rx; tmpRight.y = cam.ry; tmpRight.z = cam.rz;
      orthonormalize(tmpRight, dir);
    }
    crossRightView(tmpRight, dir, tmpView);
    // Alternate the roll so two streaks down the same lane do not z-fight.
    this.tracerRollSign = -this.tracerRollSign;
    this.tracers.spawn(
      e.origin, dir, tmpRight, tmpView,
      TRACER_LENGTH, TRACER_WIDTH,
      TRACER_LIFE,
      this.tracerRollSign * TRACER_ROLL,
    );

    // --- shell casing (not for melee or a planted charge) ---
    const weaponId = typeof e.weaponId === 'string' ? e.weaponId : '';
    if (weaponId !== 'knife' && weaponId !== 'c4') {
      tmpPoint.x = e.origin.x + cam.rx * 8 - cam.ux * 6 + dir.x * 4;
      tmpPoint.y = e.origin.y + cam.ry * 8 - cam.uy * 6 + dir.y * 4;
      tmpPoint.z = e.origin.z + cam.rz * 8 - cam.uz * 6 + dir.z * 4;
      const out = 70 + this.rng.float() * 70;
      const up = 80 + this.rng.float() * 80;
      const fwd = (this.rng.float() - 0.5) * 60;
      tmpVel.x = cam.rx * out - cam.ux * up + dir.x * fwd;
      tmpVel.y = cam.ry * out - cam.uy * up + dir.y * fwd;
      tmpVel.z = cam.rz * out - cam.uz * up + dir.z * fwd;
      tmpAxis.x = this.rng.float() - 0.5;
      tmpAxis.y = this.rng.float() - 0.5;
      tmpAxis.z = this.rng.float() - 0.5;
      safeDir(tmpAxis, tmpAxis);
      // The eye sits PLAYER.standEye above the feet: brass lands near them.
      this.casings.spawn(tmpPoint, tmpVel, tmpAxis, 14 + this.rng.float() * 18, e.origin.y - PLAYER.standEye + 1, CASING_LIFE);
    }

    // --- muzzle light ---
    this._flashlightPos.x = e.origin.x + dir.x * MUZZLE_FORWARD;
    this._flashlightPos.y = e.origin.y + dir.y * MUZZLE_FORWARD;
    this._flashlightPos.z = e.origin.z + dir.z * MUZZLE_FORWARD;
    this._flashlightIntensity = silenced ? 0.3 : 1;
    this.flashlightExternal = false;

    this.spawnedSinceUpdate = true;
  };

  private onImpact = (e: GameEventMap['impact']): void => {
    if (!e || !isFiniteVec(e.point)) return;
    spawnImpact(this.ctx, e.point, e.normal, e.material, e.dustOnly === true);
    this.spawnedSinceUpdate = true;
  };

  private onHit = (e: GameEventMap['hit']): void => {
    if (!e || !isFiniteVec(e.point)) return;
    const head = e.hitGroup === 'head';
    spawnBloodPuff(this.ctx, e.point, e.normal, e.hitGroup, head ? 1.4 : 1);
    this.rememberHit(e.targetId, e.point, e.normal);
    this.spawnedSinceUpdate = true;
  };

  private onDeath = (e: GameEventMap['death']): void => {
    if (!e) return;
    // `death` has no position: use the victim's last hit, if it is recent.
    const spot = this.findHit(e.victimId);
    if (!spot) return;
    tmpPoint.x = spot.x; tmpPoint.y = spot.y; tmpPoint.z = spot.z;
    tmpView.x = spot.nx; tmpView.y = spot.ny; tmpView.z = spot.nz;
    spawnBloodPuff(this.ctx, tmpPoint, tmpView, 'generic', BLOOD_BURST_SCALE);
    spot.victimId = -1;
    spot.t = -1e9;
    this.spawnedSinceUpdate = true;
  };

  private onGrenadeExplode = (e: GameEventMap['grenadeExplode']): void => {
    if (!e || !isFiniteVec(e.pos)) return;
    this.spawnExplosion(e.pos, e.radius, typeof e.kind === 'string' ? e.kind : 'he');
  };

  private onBombExploded = (e: GameEventMap['bombExploded']): void => {
    // The event only carries a site, so the visual needs the planted position.
    if (!e) return;
    const site = e.site === 'A' ? this.sites[0] : e.site === 'B' ? this.sites[1] : undefined;
    if (!site || !site.valid) return;
    tmpPoint.x = site.x; tmpPoint.y = site.y; tmpPoint.z = site.z;
    this.spawnExplosion(tmpPoint, BOMB_BLAST_RADIUS, 'c4');
  };

  private onBombPlanted = (e: GameEventMap['bombPlanted']): void => {
    if (!e || !isFiniteVec(e.pos)) return;
    const site = e.site === 'A' ? this.sites[0] : e.site === 'B' ? this.sites[1] : undefined;
    if (!site) return;
    site.valid = true;
    site.x = e.pos.x;
    site.y = e.pos.y;
    site.z = e.pos.z;
  };

  private onFlash = (e: GameEventMap['flash']): void => {
    if (!e) return;
    const intensity = Number.isFinite(e.intensity) ? Math.max(0, Math.min(1, e.intensity)) : 0;
    if (intensity <= 0) return;
    // Distance falloff: the VFX layer cannot test visibility (no line of sight
    // query per flash), so range is the cheap proxy. A floor of 0.2 keeps a
    // wall-blocked flash perceptible instead of silently doing nothing.
    let factor = 1;
    if (isFiniteVec(e.origin)) {
      const dx = e.origin.x - this.camBasis.px;
      const dy = e.origin.y - this.camBasis.py;
      const dz = e.origin.z - this.camBasis.pz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      factor = Math.max(0.2, 1 - dist / FLASH_MAX_RANGE);
    }
    const value = Math.max(0, Math.min(1, intensity * factor));
    if (value > this._flashAmount) this._flashAmount = value;
    const duration = Number.isFinite(e.duration) && e.duration > 0.05 ? e.duration : 1.6;
    this.flashDecay = value / duration;
  };

  private onFootstep = (e: GameEventMap['footstep']): void => {
    if (!e || !isFiniteVec(e.pos)) return;
    const index = this.actorCursor.value;
    this.actorCursor.value = (index + 1) % FOOTSTEP_MEMORY_SLOTS;
    const spot = this.actors[index];
    spot.actorId = e.actorId;
    spot.x = e.pos.x;
    spot.y = e.pos.y;
    spot.z = e.pos.z;
    spot.t = this.time;
  };

  private onLand = (e: GameEventMap['land']): void => {
    if (!e) return;
    // `land` has no position either: the last footstep of that actor is the
    // best anchor we have. If there is none, nothing is drawn (the engine may
    // still call spawnLandDust() itself with exact coordinates).
    const spot = this.findActor(e.actorId);
    if (!spot) return;
    tmpPoint.x = spot.x; tmpPoint.y = spot.y; tmpPoint.z = spot.z;
    spawnLandDust(this.ctx, tmpPoint, e.speed);
    this.spawnedSinceUpdate = true;
  };

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private decayFlash(dt: number): void {
    if (this._flashAmount <= 0) return;
    this._flashAmount -= this.flashDecay * dt;
    if (this._flashAmount < 0) this._flashAmount = 0;
  }

  private decayFlashlight(dt: number): void {
    // Externally owned values are left alone: the engine set them this frame.
    if (this.flashlightExternal || this._flashlightIntensity <= 0) return;
    this._flashlightIntensity *= Math.exp(-FLASHLIGHT_DECAY * dt);
    if (this._flashlightIntensity < 0.01) this._flashlightIntensity = 0;
  }

  private readCameraBasis(camera: PerspectiveCamera): void {
    const e = camera.matrixWorld.elements;
    const cam = this.camBasis;
    cam.rx = e[0]; cam.ry = e[1]; cam.rz = e[2];
    cam.ux = e[4]; cam.uy = e[5]; cam.uz = e[6];
    // three cameras look down local -Z.
    cam.fx = -e[8]; cam.fy = -e[9]; cam.fz = -e[10];
    cam.px = e[12]; cam.py = e[13]; cam.pz = e[14];
  }

  /** Point sprites are sized in world units divided by tan(fov/2) by three. */
  private applyFovScale(camera: PerspectiveCamera): void {
    const fov = Number.isFinite(camera.fov) && camera.fov > 1 ? camera.fov : 90;
    const scale = Math.tan((fov * Math.PI) / 360);
    this.sparkRenderer.setWorldScale(scale);
    this.softRenderer.setWorldScale(scale);
  }

  /** Device-pixel clamp for gl_PointSize, capped by the configured ratio. */
  private pointPixelClamp(): number {
    const ratio = typeof globalThis !== 'undefined' && typeof globalThis.devicePixelRatio === 'number'
      ? Math.min(globalThis.devicePixelRatio, this.maxPixelRatio)
      : 1;
    return MAX_POINT_PIXELS * Math.max(1, ratio);
  }

  /** Ground height under a blast, using `world` when the engine gave us one. */
  private groundYAt(x: number, y: number, z: number, radius: number): number {
    const fallback = y - radius * 0.25;
    if (!this.world) return fallback;
    tmpPoint.x = x; tmpPoint.y = y; tmpPoint.z = z;
    tmpDir.x = 0; tmpDir.y = -1; tmpDir.z = 0;
    try {
      const hit = this.world.raycast(tmpPoint, tmpDir, 8192, undefined);
      if (hit && hit.hit && hit.point && Number.isFinite(hit.point.y)) return hit.point.y;
    } catch {
      // A hostile or half-built world must never break a grenade.
    }
    return fallback;
  }

  private rememberHit(victimId: number, point: Vec3, normal: Vec3): void {
    const index = this.hitCursor.value;
    this.hitCursor.value = (index + 1) % HIT_MEMORY_SLOTS;
    const spot = this.hits[index];
    spot.victimId = victimId;
    spot.x = point.x; spot.y = point.y; spot.z = point.z;
    if (isFiniteVec(normal) && (normal.x !== 0 || normal.y !== 0 || normal.z !== 0)) {
      spot.nx = normal.x; spot.ny = normal.y; spot.nz = normal.z;
    } else {
      spot.nx = 0; spot.ny = 1; spot.nz = 0;
    }
    spot.t = this.time;
  }

  private findHit(victimId: number): HitSpot | null {
    for (let i = 0; i < HIT_MEMORY_SLOTS; i++) {
      const spot = this.hits[i];
      if (spot.victimId === victimId && this.time - spot.t <= HIT_MEMORY_TIME) return spot;
    }
    return null;
  }

  private findActor(actorId: number): ActorSpot | null {
    for (let i = 0; i < FOOTSTEP_MEMORY_SLOTS; i++) {
      const spot = this.actors[i];
      if (spot.actorId === actorId && this.time - spot.t <= 3) return spot;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Module scratch (single-threaded, consumed synchronously)
// ---------------------------------------------------------------------------

const tmpDir: Vec3 = { x: 0, y: 0, z: -1 };
const tmpPoint: Vec3 = { x: 0, y: 0, z: 0 };
const tmpVel: Vec3 = { x: 0, y: 0, z: 0 };
const tmpAxis: Vec3 = { x: 0, y: 1, z: 0 };
const tmpRight: Vec3 = { x: 1, y: 0, z: 0 };
const tmpUp: Vec3 = { x: 0, y: 1, z: 0 };
const tmpView: Vec3 = { x: 0, y: 0, z: -1 };

function crossDir(dir: Vec3, ax: number, ay: number, az: number, out: Vec3): Vec3 {
  out.x = dir.y * az - dir.z * ay;
  out.y = dir.z * ax - dir.x * az;
  out.z = dir.x * ay - dir.y * ax;
  return out;
}

/**
 * Make `out` a unit vector perpendicular to `dir`: normalize, remove the `dir`
 * component (the quad basis must stay orthonormal or the streak shears), then
 * normalize again. Returns false when the input is too short to be usable, so
 * the caller can substitute the camera's right axis instead of getting NaN.
 */
function orthonormalize(out: Vec3, dir: Vec3): boolean {
  let len = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
  if (!Number.isFinite(len) || len < 1e-3) return false;
  let inv = 1 / len;
  out.x *= inv; out.y *= inv; out.z *= inv;
  const dot = out.x * dir.x + out.y * dir.y + out.z * dir.z;
  out.x -= dir.x * dot;
  out.y -= dir.y * dot;
  out.z -= dir.z * dot;
  len = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
  if (!Number.isFinite(len) || len < 1e-3) return false;
  inv = 1 / len;
  out.x *= inv; out.y *= inv; out.z *= inv;
  return true;
}

/** `out = normalize(cross(right, dir))`, the tracer quad's view-axis normal. */
function crossRightView(right: Vec3, dir: Vec3, out: Vec3): Vec3 {
  const x = right.y * dir.z - right.z * dir.y;
  const y = right.z * dir.x - right.x * dir.z;
  const z = right.x * dir.y - right.y * dir.x;
  const len = Math.sqrt(x * x + y * y + z * z);
  if (!Number.isFinite(len) || len < 1e-6) {
    out.x = 0; out.y = 1; out.z = 0;
    return out;
  }
  const inv = 1 / len;
  out.x = x * inv; out.y = y * inv; out.z = z * inv;
  return out;
}

/** Engine-facing factory (the spec's `createVfx`). */
export function createVfx(opts: VfxOptions): VfxSystem {
  return new VfxSystem(opts);
}
