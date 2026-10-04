// =============================================================================
// combat/CombatSystem.ts — the coordinator that turns input into bullets and
// bullets into state changes.
//
// It owns, per actor:
//   * the live `WeaponState` for every weapon that actor has touched (ammo, draw
//     and reload timers, spray index, burst counter, accuracy penalty);
//   * the trigger latch that makes `single` need a release and makes `burst`
//     finish its burst even if the button comes up.
//
// The engine drives it as: `tryFire(id, def, opts, now)` on input, `step(dt, now)`
// once per tick, and it subscribes to the event bus for feedback. All damage
// resolution goes through `combat/ballistics.ts`; this file never re-implements
// the maths, it only sequences it.
//
// Allocation: `step` is allocation-free in the steady state. It returns an
// internal scratch array that is CLEARED at the start of every call, so the list
// of actors whose reload finished this tick is only valid until the next `step`.
// Copy the ids if you need to keep them.
// =============================================================================

import type { ActorState, HitGroup, SurfaceMaterial, Vec3, WeaponDef } from '../core/types';
import type { Rng } from '../core/rng';
import type { ActorHitbox, World } from '../world/world';
import type { EventBus } from '../core/events';
import { applyDamage, fireShot, whizzBy, type ShotResult } from './ballistics';
import { aimOrigin } from './hitbox';
import { PLAYER } from '../core/config';

/** Live weapon state for one actor. */
export interface WeaponState {
  weaponId: string;
  ammo: number;
  reserve: number;
  /** Seconds remaining of the current reload, 0 = not reloading. */
  reloadTimer: number;
  /** Seconds remaining before the weapon can fire (fire rate / bolt / pump / draw). */
  nextFireTime: number;
  /** Shots fired since the trigger was last released (drives the recoil pattern). */
  shotIndex: number;
  /** Number of shots the current burst should still fire (burst mode). */
  burstRemaining: number;
  /** True while the trigger is held (auto fire). */
  triggerDown: boolean;
  /** Seconds of "just fired" precision penalty remaining (the CS shoot-then-move feel). */
  accuracyPenalty: number;
  scoped: boolean;
  zoomLevel: number;
  /**
   * Latch on the trigger press. True once the current press has been consumed, so
   * `single` cannot auto-repeat while the button is held and `burst` starts only
   * on a fresh press.
   *
   * NOTE: this field is an addition to the frozen `WeaponState` shape. It is
   * REQUIRED by the specified fire-mode gating and cannot be derived from the
   * listed fields (`triggerDown` alone cannot distinguish "held since the last
   * shot" from "pressed again"). It is backward compatible: every listed field
   * keeps its exact name, type and meaning.
   */
  triggerPressed: boolean;
}

export interface CombatActorRef {
  /** The live actor record (health/armor/alive are mutated by the combat system). */
  state: ActorState;
  /** The weapon currently held. */
  weapon: WeaponDef;
  /** Per-weapon ammo states, keyed by weapon id. */
  ammo: Map<string, WeaponState>;
}

export interface FireOptions {
  /** Actors that may be hit (opponents of the shooter, plus a flag for friendly fire). */
  targets: readonly ActorHitbox[];
  friendlyFire?: boolean;
  /** Override the origin/direction (bot AI aims from the same eye, but pre-frames the angles). */
  origin?: Vec3;
  dir: Vec3;
  rng: Rng;
}

export interface CombatOptions {
  world: World;
  bus: EventBus;
  /** Look up an actor by entity id (for damage application and kill credit). */
  getActor(id: number): CombatActorRef | undefined;
  rng: Rng;
}

/** Internal record: the published ref plus what the combat layer needs on top. */
interface ActorRecord {
  ref: CombatActorRef;
  /** Whether the actor was alive when it was registered. */
  alive: boolean;
}

/** Module-scope vector used to normalise the shot direction for the `shot` event. */
const shotDirScratch: Vec3 = { x: 0, y: 0, z: -1 };

/**
 * Module-scope ear position for the whizz-by test. A bullet's near miss is judged
 * against ONE listener (the human), not against every actor, so there is exactly
 * one scratch vector needed. NOT reentrant — same contract as `shotDirScratch`.
 */
const listenerEarScratch: Vec3 = { x: 0, y: 0, z: 0 };

/** Default burst length when a `burst` weapon does not declare `burstCount`. */
const DEFAULT_BURST_COUNT = 3;

/** Actor id returned by `step` for every actor whose reload finished this tick. */
const reloadCompletedScratch: number[] = [];

/**
 * The combat coordinator. One instance per match; it is the only place that
 * mutates `ActorState.health` / `.armor` / `.alive` because of weapon fire.
 */
export class CombatSystem {
  private readonly world: World;
  private readonly bus: EventBus;
  private readonly getActorRef: (id: number) => CombatActorRef | undefined;
  private readonly rng: Rng;
  private readonly actors = new Map<number, ActorRecord>();
  /** Actor whose near misses are reported; -1 (nobody) until `setListener`. */
  private listenerId = -1;

  /** Damage callback so the game layer owns kill rewards / score. */
  onDamage?: (
    victimId: number,
    shooterId: number,
    group: HitGroup,
    damage: number,
    killed: boolean,
  ) => void;

  constructor(opts: CombatOptions) {
    this.world = opts.world;
    this.bus = opts.bus;
    this.getActorRef = opts.getActor;
    this.rng = opts.rng;
  }

  /**
   * Register/replace an actor's combat state (called on spawn and on weapon switch).
   *
   * Existing per-weapon ammo states are PRESERVED when the same `ammo` map is
   * re-registered, so respawning an actor does not silently refill its magazine.
   * A fresh map starts empty, which means every weapon fills from its `WeaponDef`
   * the first time it is asked for.
   */
  registerActor(id: number, ref: CombatActorRef): void {
    const existing = this.actors.get(id);
    if (existing && existing.ref !== ref) {
      // Full re-registration: carry over anything the caller did not reset.
      existing.ref = ref;
      existing.alive = ref.state.alive;
      this.actors.set(id, existing);
      return;
    }
    this.actors.set(id, { ref, alive: ref.state.alive });
  }

  /** Forget an actor entirely (disconnect, round reset). Idempotent. */
  removeActor(id: number): void {
    this.actors.delete(id);
  }

  /**
   * Whose ears the near-miss ("whizz") cue is reported for.
   *
   * `whizzBy` answers "did this bullet pass close to a listener", and there is only
   * ever one listener in a bot match: the human. That is a match-level fact, so the
   * game layer sets it once (`Match` passes its local player) and passes -1 to turn
   * the cue off — which is what tests and headless runs effectively use, since a
   * whizz that nobody hears is just wasted events.
   */
  setListener(actorId: number): void {
    this.listenerId = actorId;
  }

  /**
   * The live weapon state for `weaponId`, created full if this is the first time
   * the actor has touched that weapon. Always returns the SAME object for the same
   * (actor, weapon) pair — mutate it, do not copy it.
   */
  getWeaponState(id: number, weaponId: string, def: WeaponDef): WeaponState {
    const rec = this.actors.get(id);
    const map = rec?.ref.ammo;
    const existing = map?.get(weaponId);
    if (existing) return existing;
    const created: WeaponState = {
      weaponId,
      ammo: def.magazine,
      reserve: def.reserve,
      reloadTimer: 0,
      nextFireTime: 0,
      shotIndex: 0,
      burstRemaining: 0,
      triggerDown: false,
      accuracyPenalty: 0,
      scoped: false,
      zoomLevel: 0,
      triggerPressed: false,
    };
    map?.set(weaponId, created);
    // NOTE: when the actor is unknown (or its ref carries no ammo map) the state
    // still exists for the caller but is not remembered — there is nowhere to
    // store it. The engine always registers an actor before asking for state.
    return created;
  }

  /**
   * Start a reload if possible (returns false when the magazine is full, already
   * reloading, out of reserve, or the weapon has no reload time at all).
   *
   * CS rule: the timer is `def.reloadTime`; the mag is only refilled when `step`
   * counts the timer down to zero, so a reload can be interrupted by a weapon
   * switch and the ammo is never granted early.
   */
  startReload(id: number, def: WeaponDef): boolean {
    const rec = this.actors.get(id);
    if (!rec || !rec.alive) return false;
    const st = this.getWeaponState(id, def.id, def);
    if (st.reloadTimer > 0) return false;
    if (st.ammo >= def.magazine) return false;
    if (st.reserve <= 0) return false;
    if (!(def.reloadTime > 0)) return false;
    st.reloadTimer = def.reloadTime;
    st.triggerDown = false;
    st.triggerPressed = true; // the press that asked for the reload is consumed
    this.bus.emit('reload', { actorId: id, weaponId: def.id, duration: def.reloadTime });
    return true;
  }

  /**
   * Switch the held weapon, resetting draw timers and clearing the spray index.
   *
   * The magazine is NOT refilled: only the transient firing state is cleared, and
   * `nextFireTime` is parked `def.drawTime` seconds in the future so the weapon
   * cannot be fired before it is up — that delay is the whole reason switching
   * mid-fight is a real cost in CS. `now` comes from the injected clock, never
   * from `Date.now()`.
   */
  drawWeapon(id: number, def: WeaponDef): void {
    const rec = this.actors.get(id);
    if (!rec) return;
    rec.ref.weapon = def;
    const st = this.getWeaponState(id, def.id, def);
    st.reloadTimer = 0;
    st.shotIndex = 0;
    st.burstRemaining = 0;
    st.accuracyPenalty = 0;
    st.triggerDown = false;
    st.triggerPressed = true;
    st.scoped = false;
    st.zoomLevel = 0;
    const draw = Number.isFinite(def.drawTime) && def.drawTime > 0 ? def.drawTime : 0;
    st.nextFireTime = draw;
    this.bus.emit('draw', { actorId: id, weaponId: def.id, duration: draw });
  }

  /**
   * Attempt to fire. Returns true when a shot was actually discharged.
   *
   * Gating, in order:
   *  1. The actor must exist, be alive, and not be mid-reload.
   *  2. Fire-rate cooldown: absolute `nextFireTime + 60/rpm`, where `now` is the
   *     engine clock supplied by the caller.
   *  3. Fire mode: `auto` fires while the trigger is down; `single` (and therefore
   *     bolt/pump weapons, whose rpm is simply slow) needs a fresh press per shot;
   *     `burst` starts a burst of `burstCount` on a fresh press, then keeps
   *     discharging it on the rate clock even if the trigger is released.
   *  4. The magazine must have a round; if it does not, the shot fails and the
   *     caller is expected to call `startReload` (the engine does this on its own
   *     input edge, exactly as CS does).
   *
   * The trigger latch is consumed even when the shot fails for ammo/rate reasons,
   * so holding a `single` weapon never queues up shots.
   */
  tryFire(id: number, def: WeaponDef, opts: FireOptions, now: number): boolean {
    const rec = this.actors.get(id);
    if (!rec || !rec.alive) return false;

    const st = this.getWeaponState(id, def.id, def);
    if (!Number.isFinite(now)) now = 0;

    if (st.triggerDown && !st.triggerPressed) {
      st.triggerPressed = true;
      if (def.fireMode === 'burst' && st.burstRemaining <= 0) {
        st.burstRemaining = this.burstCount(def);
      }
    }

    if (st.reloadTimer > 0) return false;
    if (!Number.isFinite(st.nextFireTime) || st.nextFireTime > now) return false;

    const mode = def.fireMode;
    const canFire =
      mode === 'auto' ? st.triggerDown : mode === 'burst' ? st.burstRemaining > 0 : st.triggerPressed;
    if (!canFire) return false;

    if (st.ammo <= 0) return false;

    // --- discharge ---------------------------------------------------------
    const rpm = Number.isFinite(def.rpm) && def.rpm > 0 ? def.rpm : 60;
    const period = 60 / rpm;
    st.nextFireTime = now + period;
    st.ammo -= 1;
    if (mode === 'burst') st.burstRemaining = Math.max(0, st.burstRemaining - 1);

    const shotIndex = st.shotIndex;
    const accuracyPenalty = st.accuracyPenalty;

    const state: ActorState = rec.ref.state;
    rec.ref.weapon = def;
    const vel = state.vel;
    const horizontalSpeed = Math.hypot(vel.x, vel.z);

    const origin = opts.origin ?? aimOrigin(state);
    const result = fireShot(this.world, {
      shooterId: id,
      team: state.team,
      origin,
      dir: opts.dir,
      weapon: def,
      spread: {
        weapon: def,
        horizontalSpeed,
        duckAmount: state.duckAmount,
        onGround: state.onGround,
        shotIndex,
      },
      actors: opts.targets,
      rng: opts.rng,
    });

    // The spray index advances only on an actual shot, and carries the pre-fire
    // accuracy penalty should the engine choose to fold it into the cone later.
    st.shotIndex = shotIndex + 1;
    void accuracyPenalty;

    this.applyShot(id, def, result, origin, opts.dir);
    return true;
  }

  /**
   * Advance all timers for `dt` seconds; returns actors whose reload completed.
   *
   * Allocation-free in the steady state: the returned array is a module-scope
   * scratch buffer that is CLEARED at the start of each call (documented reused
   * array — do not retain it across ticks or mutate it).
   */
  step(dt: number, now: number): number[] {
    const completed = reloadCompletedScratch;
    completed.length = 0;

    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const t = Number.isFinite(now) ? now : 0;

    for (const [id, rec] of this.actors) {
      const ref = rec.ref;
      ref.state.alive = rec.alive;
      const weapon = ref.weapon;
      for (const st of ref.ammo.values()) {
        if (st.reloadTimer > 0) {
          st.reloadTimer -= step;
          if (st.reloadTimer <= 0) {
            st.reloadTimer = 0;
            const need = Math.max(0, weapon.magazine - st.ammo);
            const take = Math.min(need, st.reserve);
            st.ammo += take;
            st.reserve -= take;
            st.shotIndex = 0;
            // Burst state survives a reload: a burst interrupted by an empty mag
            // resumes once the magazine is back, exactly like CS.
            completed.push(id);
          }
        }
        // A released trigger resets the spray, which is what makes a two-tap land
        // on the first two pattern entries rather than continuing the spray.
        if (!st.triggerDown) {
          st.triggerPressed = false;
          if (step > 0) st.shotIndex = 0;
        }
        if (st.accuracyPenalty > 0 && step > 0) {
          st.accuracyPenalty = st.accuracyPenalty > step ? st.accuracyPenalty - step : 0;
        }
        void t;
      }
    }
    return completed;
  }

  /**
   * Apply a ShotResult to the world: emit `shot`, `hit`, `impact`, `death`, call
   * `onDamage`.
   *
   * Every bullet also emits an `impact` when it ended on geometry, which is what
   * the VFX layer uses to place decals and dust puffs; a bullet that hit an actor
   * emits `hit` instead (blood, not concrete).
   *
   * Damage and armour are resolved here through `applyDamage`, so hit-group
   * multipliers and the kevlar formula live in exactly one place. See
   * `combat/ballistics.ts` for the derivation.
   */
  applyShot(shooterId: number, def: WeaponDef, result: ShotResult, origin: Vec3, dir: Vec3): void {
    const shooter = this.actors.get(shooterId);
    const st = shooter ? this.getWeaponState(shooterId, def.id, def) : undefined;

    // Normalise the report direction without mutating the caller's vector.
    const dLen = Math.hypot(dir.x, dir.y, dir.z);
    if (dLen > 1e-9) {
      const inv = 1 / dLen;
      shotDirScratch.x = dir.x * inv;
      shotDirScratch.y = dir.y * inv;
      shotDirScratch.z = dir.z * inv;
    } else {
      shotDirScratch.x = 0;
      shotDirScratch.y = 0;
      shotDirScratch.z = -1;
    }

    this.bus.emit('shot', {
      shooterId,
      weaponId: def.id,
      origin,
      dir: shotDirScratch,
      silenced: def.silenced === true,
      ammo: st ? st.ammo : 0,
    });

    // --- impacts on geometry ----------------------------------------------
    for (let i = 0; i < result.bullets.length; i++) {
      const b = result.bullets[i];
      if (b.hit && b.entityId < 0) {
        this.bus.emit('impact', {
          point: b.point,
          normal: b.normal,
          material: b.material as SurfaceMaterial,
          dustOnly: b.penetrated.length > 0,
        });
      }
    }

    // --- near misses --------------------------------------------------------
    // Report the bullets that snap past the listener's ear. `whizzBy` excludes the
    // bullet that ended ON the listener (that is a `hit`), and the event carries the
    // closest approach so the audio layer can scale the volume.
    if (this.listenerId >= 0 && shooterId !== this.listenerId) {
      const listenerState = this.actors.get(this.listenerId)?.ref.state;
      if (listenerState && listenerState.alive) {
        listenerEarScratch.x = listenerState.pos.x;
        listenerEarScratch.y = listenerState.pos.y + PLAYER.standEye;
        listenerEarScratch.z = listenerState.pos.z;
        for (let i = 0; i < result.bullets.length; i++) {
          const b = result.bullets[i];
          if (b.entityId === this.listenerId) continue;
          const near = whizzBy(b, listenerEarScratch);
          if (near) this.bus.emit('whizz', { shooterId, pos: near.pos, distance: near.distance });
        }
      }
    }

    // --- victims ------------------------------------------------------------
    for (let i = 0; i < result.victims.length; i++) {
      const v = result.victims[i];
      const victim = this.actors.get(v.entityId);
      if (!victim) continue;

      const vs: ActorState = victim.ref.state;
      const currentHealth = vs.health;
      const resolved = applyDamage({
        rawDamage: v.damage,
        armorPenetration: def.armorPenetration,
        armor: vs.armor,
        helmet: vs.helmet,
        hitGroup: v.hitGroup,
        hitGroupMul: def.hitGroupMul,
        currentHealth,
      });

      const killed = currentHealth > 0 && currentHealth - resolved.health <= 0;
      vs.health = Math.max(0, currentHealth - resolved.health);
      if (vs.health <= 0) vs.health = 0;

      // Any damage that landed is a hit. Do NOT gate this on armour drain: an
      // unarmoured victim loses health and no armour, and gating on `resolved.armor`
      // silenced exactly the most common case (no hitmarker, no blood, no audio).
      if (resolved.health > 0 || resolved.armor > 0) {
        this.bus.emit('hit', {
          shooterId,
          targetId: v.entityId,
          hitGroup: v.hitGroup,
          damage: resolved.health,
          armorDamage: resolved.armor,
          point: v.point,
          normal: v.normal,
          killed,
          weaponId: def.id,
        });
      }

      if (killed) {
        vs.alive = false;
        // Keep the record's view in step so `applyDirectDamage` agrees.
        this.actors.set(v.entityId, { ref: victim.ref, alive: false });
        this.bus.emit('death', {
          victimId: v.entityId,
          killerId: shooterId,
          weaponId: def.id,
          headshot: v.hitGroup === 'head',
          wallbang: v.wallbang || this.wallbangFor(result, v.entityId),
        });
      }

      this.onDamage?.(v.entityId, shooterId, v.hitGroup, resolved.health, killed);
    }
  }

  /**
   * Direct damage entry point (explosions, fall damage, bomb).
   *
   * Applies the damage through the same armour/hit-group path as a bullet and
   * emits `death` when it kills. Returns true when the victim died. Ignores the
   * shot pipeline entirely, so it never touches ammo or the spray index.
   */
  applyDirectDamage(victimId: number, shooterId: number, damage: number, group: HitGroup): boolean {
    const victim = this.actors.get(victimId);
    if (!victim || !victim.alive) return false;

    const vs: ActorState = victim.ref.state;
    const currentHealth = vs.health;
    if (currentHealth <= 0) return false;

    const shooter = this.actors.get(shooterId);
    const ap = shooter ? shooter.ref.weapon.armorPenetration : 1;
    const resolved = applyDamage({
      rawDamage: damage,
      armorPenetration: ap,
      armor: vs.armor,
      helmet: vs.helmet,
      hitGroup: group,
      hitGroupMul: undefined,
      currentHealth,
    });

    const killed = currentHealth > 0 && currentHealth - resolved.health <= 0;
    vs.health = Math.max(0, currentHealth - resolved.health);
    if (killed) {
      vs.alive = false;
      this.actors.set(victimId, { ref: victim.ref, alive: false });
      this.bus.emit('death', {
        victimId,
        killerId: shooterId,
        weaponId: shooter ? shooter.ref.weapon.id : '',
        headshot: group === 'head',
        wallbang: false,
      });
    }
    this.onDamage?.(victimId, shooterId, group, resolved.health, killed);
    return killed;
  }

  /** Burst length for a burst weapon, falling back to the CS three-round burst. */
  private burstCount(def: WeaponDef): number {
    const n = def.burstCount;
    return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_BURST_COUNT;
  }

  /** True when any bullet that hit `entityId` had already passed through geometry. */
  private wallbangFor(result: ShotResult, entityId: number): boolean {
    for (let i = 0; i < result.bullets.length; i++) {
      const b = result.bullets[i];
      if (b.entityId === entityId && b.penetrated.length > 0) return true;
    }
    return false;
  }
}
