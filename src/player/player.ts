// =============================================================================
// player/player.ts — one actor: movement + camera + weapons + economy.
//
// A Player is the only thing that owns an ActorState. The game layer owns WHEN
// players think (a fixed 128 Hz tick) and the render loop asks for a camera
// compose; everything in between lives here.
//
// Two hard rules this file exists to enforce:
//   1. `state.yaw/pitch` is the TRUE aim. Recoil is never folded back into it —
//      it lives on the camera rig as `punch`, and bullets are fired along
//      `true aim + punch`. That is what makes pulling down through a spray the
//      correct answer instead of a fight against the input code.
//   2. Nothing here calls Date.now(). The clock is injected so the whole
//      simulation is deterministic and testable.
// =============================================================================

import { CombatSystem, type CombatActorRef, type WeaponState } from '../combat/CombatSystem';
import { fallDamage } from '../combat/ballistics';
import { weaponById } from '../combat/weaponDefs';
import { CAMERA, MOVE, PLAYER, RULES } from '../core/config';
import { anglesToDir, clamp, distanceXZ, v3 } from '../core/math';
import type { Rng } from '../core/rng';
import type { EventBus } from '../core/events';
import {
  EMPTY_BUTTONS,
  type ActorState,
  type InputCommand,
  type SurfaceMaterial,
  type Team,
  type Vec3,
  type WeaponDef,
  type WeaponSlot,
} from '../core/types';
import type { ActorHitbox, World } from '../world/world';
import { CameraRig } from './cameraRig';
import type { InputSystem } from './input';
import { createMoveState, stepMovement, type MoveResult, type MoveState } from './movement';

/**
 * The shot bookkeeping the game layer owns. A Player cannot know who its
 * opponents are (that is match state), so the game layer filters the hitbox list
 * per shooter each tick and hands it back through this seam.
 */
export interface PlayerShotContext {
  /** Hitboxes of the actors this shooter is allowed to hit, refreshed each tick. */
  targetsFor(shooterId: number, team: Team): readonly ActorHitbox[];
  /** Deterministic spread source shared by the whole match. */
  rng: Rng;
}

const NO_TARGETS: readonly ActorHitbox[] = [];

/** Distance (units) between two footstep sounds while grounded. */
const FOOTSTEP_DISTANCE = 190;
/** Distance (units) between two footstep sounds while walking (Shift). */
const FOOTSTEP_DISTANCE_WALK = 300;

/** Slots a player can hold, in fallback priority order (highest first). */
const SLOT_PRIORITY: readonly WeaponSlot[] = ['primary', 'secondary', 'knife', 'c4', 'grenade'];

/** The four buyable slots, in the order the buy menu enumerates them. */
const BUYABLE_SLOTS: readonly WeaponSlot[] = ['primary', 'secondary', 'grenade', 'knife'];

export interface PlayerOptions {
  id: number;
  name: string;
  team: Team;
  isBot: boolean;
  /** Spawn position (feet). */
  pos: Vec3;
  displayName?: string;
}

/** Result of a buy attempt, so the game layer can play the right UI sound. */
export interface BuyResult {
  ok: boolean;
  reason?: 'money' | 'already-owned' | 'slot-full' | 'not-buy-time' | 'unknown' | 'dead';
  price?: number;
}

export class Player {
  readonly id: number;
  /** Mutable exactly once per match: the MR12 half-time side swap. */
  team: Team;
  readonly isBot: boolean;
  readonly state: ActorState;
  readonly moveState: MoveState;
  /** First-person camera layers. Bots never compose one, but the rig is cheap. */
  readonly rig: CameraRig;

  readonly ammo = new Map<string, WeaponState>();
  /**
   * The stable reference handed to the CombatSystem. It must be the SAME object
   * for the lifetime of the player: `registerActor` keys ammo maps by identity,
   * and a fresh object per call would drop every magazine on the floor.
   */
  readonly combatRef: CombatActorRef;

  primaryId: string | null = null;
  secondaryId: string | null = null;
  readonly grenades: string[] = [];
  hasKnife = true;
  hasBomb = false;
  hasDefuseKit = false;
  activeSlot: WeaponSlot = 'secondary';
  /** Weapon the player is switching to; the switch completes when it draws. */
  pendingSlot: WeaponSlot | null = null;

  /** Seconds of scope transition remaining (0 = fully scoped in/out). */
  scopeTimer = 0;
  zoomLevel = 0;

  /** Whether this actor's life is already accounted for (death event fired). */
  private deathReported = false;

  /**
   * True while the `use` button is held. The game layer owns what `use` MEANS
   * (plant the bomb, defuse it, open a door); the player only reports the key.
   */
  useHeld = false;

  /** Accumulated horizontal distance since the last footstep sound. */
  private stepAccum = 0;
  private lastLandingSpeed = 0;

  /** Scratch vectors (this class is single-threaded per instance). */
  private readonly tmpDir = v3();
  private readonly tmpEye = v3();
  private readonly tmpPunchDir = v3();

  private input: InputSystem | null = null;
  private world: World;
  private combat: CombatSystem;
  private bus: EventBus;
  /** Set by the game layer; without it a player simply cannot hit anyone. */
  private shotContext: PlayerShotContext | null = null;
  /** Result of the last movement step (footstep cadence + landing dip). */
  private lastMove: MoveResult = {
    horizontalSpeed: 0,
    landingSpeed: 0,
    jumped: false,
    landed: false,
    tookOff: false,
    groundMaterial: 'concrete',
  };

  constructor(
    opts: PlayerOptions,
    world: World,
    combat: CombatSystem,
    bus: EventBus,
    rig?: CameraRig,
  ) {
    this.id = opts.id;
    this.team = opts.team;
    this.isBot = opts.isBot;
    this.world = world;
    this.combat = combat;
    this.bus = bus;
    this.rig = rig ?? new CameraRig(16 / 9);

    this.state = {
      id: opts.id,
      name: opts.displayName ?? opts.name,
      team: opts.team,
      isBot: opts.isBot,
      pos: { x: opts.pos.x, y: opts.pos.y, z: opts.pos.z },
      vel: v3(),
      yaw: opts.team === 'T' ? 0 : Math.PI,
      pitch: 0,
      onGround: false,
      crouching: false,
      duckAmount: 0,
      health: 100,
      armor: 0,
      helmet: false,
      alive: true,
      hasBomb: false,
      hasDefuseKit: false,
      speedFactor: 1,
    };

    this.moveState = createMoveState(this.state.pos);
    this.combatRef = { state: this.state, weapon: this.weapon, ammo: this.ammo };
    this.registerCombat();
  }

  // ---------------------------------------------------------------------------
  // combat wiring
  // ---------------------------------------------------------------------------

  /**
   * Install the shot bookkeeping (opponent hitboxes + the match RNG). The game
   * layer calls this once, right after constructing the match.
   */
  setShotContext(ctx: PlayerShotContext | null): void {
    this.shotContext = ctx;
  }

  private registerCombat(): void {
    this.combatRef.weapon = this.weapon;
    this.combat.registerActor(this.id, this.combatRef);
  }

  /** Read the InputSystem that drives this player, if it is human-controlled. */
  setInputSystem(input: InputSystem | null): void {
    this.input = input;
  }

  // ---------------------------------------------------------------------------
  // loadout
  // ---------------------------------------------------------------------------

  /** The currently held weapon definition. Always resolves (falls back to knife). */
  get weapon(): WeaponDef {
    const id = this.weaponIdForSlot(this.activeSlot);
    return weaponById(id ?? 'knife') ?? weaponById('knife')!;
  }

  /** Weapon id stored in a slot, or null. */
  weaponIdForSlot(slot: WeaponSlot): string | null {
    switch (slot) {
      case 'primary':
        return this.primaryId;
      case 'secondary':
        return this.secondaryId;
      case 'knife':
        return this.hasKnife ? 'knife' : null;
      case 'c4':
      case 'bomb':
        return this.hasBomb ? 'c4' : null;
      case 'grenade':
        return this.grenades.length > 0 ? this.grenades[0] : null;
      default:
        return null;
    }
  }

  /** Slots that currently hold something. */
  ownedSlots(): WeaponSlot[] {
    const out: WeaponSlot[] = [];
    for (const slot of SLOT_PRIORITY) {
      if (this.weaponIdForSlot(slot)) out.push(slot);
    }
    return out;
  }

  /**
   * Give a weapon, replacing whatever occupied its slot.
   * @returns false when the weapon id is unknown.
   */
  giveWeapon(weaponId: string, makeActive = false): boolean {
    const def = weaponById(weaponId);
    if (!def) return false;
    switch (def.slot) {
      case 'primary':
        this.primaryId = def.id;
        break;
      case 'secondary':
        this.secondaryId = def.id;
        break;
      case 'knife':
        this.hasKnife = true;
        break;
      case 'grenade':
        if (!this.grenades.includes(def.id)) this.grenades.push(def.id);
        break;
      case 'c4':
      case 'bomb':
        this.hasBomb = true;
        this.state.hasBomb = true;
        break;
      default:
        return false;
    }
    // Make sure the weapon state exists so the HUD has ammo to show, but never
    // refill a magazine the player already spent this round.
    this.combat.getWeaponState(this.id, def.id, def);
    if (makeActive || !this.weaponIdForSlot(this.activeSlot)) this.switchTo(def.slot);
    return true;
  }

  /** Remove a weapon from its slot (used when a round is lost / bomb dropped). */
  removeWeapon(weaponId: string): void {
    const def = weaponById(weaponId);
    if (!def) return;
    if (this.primaryId === def.id) this.primaryId = null;
    if (this.secondaryId === def.id) this.secondaryId = null;
    if (def.slot === 'knife') this.hasKnife = false;
    if (def.slot === 'c4' || def.slot === 'bomb') {
      this.hasBomb = false;
      this.state.hasBomb = false;
    }
    const gi = this.grenades.indexOf(def.id);
    if (gi >= 0) this.grenades.splice(gi, 1);
  }

  /** Strip everything and start a fresh round with a pistol and a knife. */
  resetRoundLoadout(pistolId: string): void {
    this.primaryId = null;
    this.secondaryId = pistolId;
    this.grenades.length = 0;
    this.hasKnife = true;
    this.hasBomb = false;
    this.state.hasBomb = false;
    this.activeSlot = 'secondary';
    this.pendingSlot = null;
    this.scopeTimer = 0;
    this.zoomLevel = 0;
    // Ammo is per-weapon and survives a round reset unless the game layer drops
    // the map; the game layer clears `ammo` explicitly when it wants a refill.
  }

  /** Fill every owned magazine from reserve (called at spawn). */
  refillAllAmmo(): void {
    for (const slot of SLOT_PRIORITY) {
      const wid = this.weaponIdForSlot(slot);
      if (!wid) continue;
      const def = weaponById(wid);
      if (!def) continue;
      const st = this.combat.getWeaponState(this.id, def.id, def);
      st.ammo = def.magazine;
      st.reserve = def.reserve;
      st.reloadTimer = 0;
      st.shotIndex = 0;
      st.nextFireTime = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // weapon switching
  // ---------------------------------------------------------------------------

  /**
   * Begin switching to a slot. The switch is applied immediately (the draw timer
   * is what keeps the player from firing), matching CS: the old weapon is gone
   * the instant you press the key.
   */
  switchTo(slot: WeaponSlot): boolean {
    if (slot === this.activeSlot && !this.pendingSlot) return false;
    if (!this.weaponIdForSlot(slot)) return false;
    this.activeSlot = slot;
    this.pendingSlot = null;
    this.scopeTimer = 0;
    this.zoomLevel = 0;
    const def = this.weapon;
    this.combat.drawWeapon(this.id, def);
    if (this.rig) this.rig.clearPunch();
    return true;
  }

  /** Next weapon in the fallback priority order (CS `invnext`). */
  cycleWeapon(direction: 1 | -1): boolean {
    const owned = this.ownedSlots();
    if (owned.length < 2) return false;
    let idx = owned.indexOf(this.activeSlot);
    if (idx < 0) idx = 0;
    const next = owned[(idx + direction + owned.length) % owned.length];
    return this.switchTo(next);
  }

  /**
   * Convenience for UI/tests: the price of the item the player asked to buy, and
   * whether they can afford it right now.
   */
  canAfford(price: number, money: number): boolean {
    return money >= price;
  }

  // ---------------------------------------------------------------------------
  // the tick
  // ---------------------------------------------------------------------------

  /**
   * Fold this tick's absolute view angles into the actor state.
   *
   * Both command sources already carry absolute yaw/pitch (`InputSystem.sample`
   * for humans, `BotController.update` for bots), and this is the only place that
   * turns them into `state.yaw/pitch` — the true aim the rest of the simulation
   * reads (movement wish direction, `aimDirection()`, hitbox facing). Recoil is
   * untouched here: it stays on the rig as `punch` and is layered on top when a
   * bullet leaves the muzzle.
   */
  private applyLook(cmd: InputCommand): void {
    if (Number.isFinite(cmd.yaw)) this.state.yaw = cmd.yaw;
    if (Number.isFinite(cmd.pitch)) {
      this.state.pitch = clamp(cmd.pitch, -CAMERA.maxPitch, CAMERA.maxPitch);
    }
  }

  /**
   * Advance this player one simulation tick.
   *
   * @param cmd   input command for this tick. For humans this comes from
   *              `InputSystem.sample`, for bots from `BotController.update`.
   *              Both already carry absolute yaw/pitch.
   * @param dt    tick length in seconds.
   * @param now   monotonic simulation clock (seconds).
   * @param money current money, so this player's purchases were already applied
   *              by the game layer; unused here but kept in the signature so the
   *              game layer can hand the same command to human and bot alike.
   */
  step(cmd: InputCommand, dt: number, now: number, money = 0): void {
    void money;

    if (!this.state.alive) {
      // Motionless dead actor: keep gravity applying so a corpse settles on the
      // floor instead of hovering where it died.
      this.state.vel.x = 0;
      this.state.vel.z = 0;
      stepMovement(this.world, this.moveState, EMPTY_CMD, dt);
      this.syncFromMove();
      return;
    }

    this.applyCrouch(cmd, dt);
    this.applyLook(cmd);

    if (this.isBot) {
      // Bots are never rendered, so no render frame advances their camera rig.
      // Tick its recoil recovery here: otherwise a spraying bot's punch would
      // accumulate forever and drag `aimDirection()` (= state.yaw + punch) off the
      // target it is aiming at. Humans get the richer per-frame path via
      // `updateCamera`, which also composes the visible camera.
      this.rig.update(
        this.state.yaw,
        this.state.pitch,
        this.state.pos,
        this.state.duckAmount,
        this.state.vel,
        this.state.onGround,
        dt,
        0,
        0,
      );
    }

    this.applyWeaponSwitch(cmd);
    this.useHeld = cmd.buttons.use;

    const wishMul = this.wishSpeedMultiplier();
    if (!this.state.alive) {
      // Movement may have killed this actor (fall damage is applied by the game
      // layer, but a corpse must still settle): fall through to the death check.
      this.syncFromMove();
      this.reportDeath(-1, '', false);
      return;
    }
    this.lastMove = stepMovement(this.world, this.moveState, cmd, dt, wishMul);
    this.syncFromMove();

    if (this.lastMove.landed && this.lastMove.landingSpeed > 0) {
      const fallDmg = fallDamage(this.lastMove.landingSpeed);
      this.rig.land(this.lastMove.landingSpeed);
      this.bus.emit('land', { actorId: this.id, speed: this.lastMove.landingSpeed, damage: fallDmg });
      if (fallDmg > 0) this.applyDirectDamage(fallDmg, 'leg');
    }
    if (this.lastMove.tookOff) {
      this.bus.emit('jump', { actorId: this.id });
    }

    this.updateScope(cmd, dt);
    this.handleReload(cmd);
    this.handleFire(cmd, now);
    this.updateFootsteps(dt);

    // Timers (reload, draw, fire-rate) advance for every actor here. Reload
    // completion needs no event: the HUD reads the magazine every frame.
    this.combat.step(dt, now);

    if (!this.state.alive) this.reportDeath(-1, '', false);
  }

  private applyCrouch(cmd: InputCommand, dt: number): void {
    const want = cmd.buttons.crouch;
    const rate = MOVE.duckSpeed / Math.max(1, PLAYER.standHeight - PLAYER.crouchHeight);
    const target = want ? 1 : 0;
    const stepAmount = rate * dt;
    if (this.state.duckAmount < target) {
      this.state.duckAmount = Math.min(target, this.state.duckAmount + stepAmount);
    } else if (this.state.duckAmount > target) {
      this.state.duckAmount = Math.max(target, this.state.duckAmount - stepAmount);
    }
    this.state.crouching = want || this.state.duckAmount > 0.5;
  }

  private applyWeaponSwitch(cmd: InputCommand): void {
    const b = cmd.buttons;
    if (b.slot1) this.switchTo('primary');
    if (b.slot2) this.switchTo('secondary');
    if (b.slot3) this.switchTo('knife');
    if (b.slot4) this.switchTo(this.grenades.length > 0 ? 'grenade' : 'c4');
    if (b.slot5) this.switchTo('c4');
    // There is no dedicated cycle binding in the frozen InputButtons contract, so
    // switching is slot-based (1-5) exactly like the default CS layout.
    void this.cycleWeapon;
  }

  /** Speed multiplier from the held weapon plus the scope penalty. */
  private wishSpeedMultiplier(): number {
    // `WeaponDef.moveSpeed` is an absolute CS speed (e.g. 215 for an AK-47, 240
    // for a pistol), not a factor: express it as a fraction of the run speed.
    let mul = this.weapon.moveSpeed / MOVE.maxSpeed;
    if (!Number.isFinite(mul) || mul <= 0) mul = 1;
    if (this.zoomLevel > 0) mul *= 0.4;
    else if (this.scopeTimer > 0) mul *= 0.6;
    return mul;
  }

  private updateScope(cmd: InputCommand, dt: number): void {
    const def = this.weapon;
    const canZoom = !!def.zoomFov && def.zoomFov.length > 0;
    if (!canZoom) {
      if (this.zoomLevel !== 0) {
        this.zoomLevel = 0;
        this.scopeTimer = 0;
        this.rig.setFov(CAMERA.fov);
      }
      return;
    }
    const wantZoom = cmd.buttons.attack2;
    const wasZoomed = this.zoomLevel > 0;
    if (wantZoom !== wasZoomed) {
      this.zoomLevel = wantZoom ? 1 : 0;
      this.scopeTimer = def.zoomTime ?? 0.3;
      this.rig.setFov(wantZoom ? (def.zoomFov![0] ?? CAMERA.fov) : CAMERA.fov);
    }
    if (this.scopeTimer > 0) this.scopeTimer = Math.max(0, this.scopeTimer - dt);
  }

  private handleReload(cmd: InputCommand): void {
    const def = this.weapon;
    if (this.pendingSlot !== null) return;
    const st = this.combat.getWeaponState(this.id, def.id, def);
    const wantReload = cmd.buttons.reload || st.ammo <= 0;
    if (!wantReload) return;
    this.combat.startReload(this.id, def);
  }

  private handleFire(cmd: InputCommand, now: number): void {
    const def = this.weapon;
    if (def.slot === 'knife' || def.slot === 'c4') return;
    if (this.scopeTimer > 0) return; // mid scope transition: no firing
    const st = this.combat.getWeaponState(this.id, def.id, def);
    if (st.reloadTimer > 0) return;

    const ctx = this.shotContext;
    const targets = ctx ? ctx.targetsFor(this.id, this.team) : NO_TARGETS;
    const rng = ctx ? ctx.rng : null;
    if (!rng) return; // no match context installed: firing is impossible, not silent

    // The trigger edge lives in the weapon state: `tryFire` distinguishes an auto
    // weapon's held trigger from a `single` weapon's fresh press with this flag.
    st.triggerDown = cmd.buttons.attack;

    const fired = this.combat.tryFire(
      this.id,
      def,
      { dir: this.aimDirection(this.tmpPunchDir), targets, rng },
      now,
    );
    if (!fired) return;
    this.debug.shotsFired++;
    this.debug.lastFiredAt = now;

    // View punch: the pattern entry for THIS shot is the offset of the view from
    // the true aim. It is deliberately NOT folded into `state.pitch`, so pulling
    // down through the spray is the correct answer rather than a fight with the
    // input code.
    const shot = Math.max(0, st.shotIndex - 1);
    const off = this.recoilOffset(def, shot);
    this.rig.addPunch(off.x, off.y);
  }

  /** Recoil offset for shot `shotIndex` of `def`, in radians. */
  private recoilOffset(def: WeaponDef, shotIndex: number): { x: number; y: number } {
    const p = def.pattern;
    if (!p || !p.punch || p.punch.length === 0) return { x: 0, y: 0 };
    const i = Math.min(Math.max(0, shotIndex), p.punch.length - 1);
    return p.punch[i];
  }

  /**
   * The direction a bullet actually leaves the barrel: TRUE aim plus the current
   * view punch. Kept public so the game layer can draw tracers from the same
   * vector the shot used.
   */
  aimDirection(out: Vec3 = v3()): Vec3 {
    return anglesToDir(out, this.state.yaw + this.rig.punchYaw, this.state.pitch + this.rig.punchPitch);
  }

  /** Eye position in world space (feet + eye height for the current duck). */
  eyePosition(out: Vec3 = this.tmpEye): Vec3 {
    const eye = PLAYER.standEye + (PLAYER.crouchEye - PLAYER.standEye) * this.state.duckAmount;
    out.x = this.state.pos.x;
    out.y = this.state.pos.y + eye;
    out.z = this.state.pos.z;
    return out;
  }

  private syncFromMove(): void {
    const ms = this.moveState;
    this.state.pos.x = ms.pos.x;
    this.state.pos.y = ms.pos.y;
    this.state.pos.z = ms.pos.z;
    this.state.vel.x = ms.vel.x;
    this.state.vel.y = ms.vel.y;
    this.state.vel.z = ms.vel.z;
    this.state.onGround = ms.onGround;
  }

  private updateFootsteps(dt: number): void {
    const horiz = Math.hypot(this.state.vel.x, this.state.vel.z);
    if (!this.state.onGround || horiz < 20) {
      // Airborne (or standing still): keep the accumulator primed just short of a
      // step so the first stride after landing is immediate, not a fresh count-up.
      this.stepAccum = Math.min(this.stepAccum, FOOTSTEP_DISTANCE_WALK * 0.9);
      return;
    }
    this.stepAccum += horiz * dt;
    const walking = this.state.crouching || horiz < MOVE.walkSpeed * 1.05;
    const threshold = walking ? FOOTSTEP_DISTANCE_WALK : FOOTSTEP_DISTANCE;
    if (this.stepAccum >= threshold) {
      this.stepAccum = 0;
      // `volume` is the *world* loudness of the step, which is what the audio
      // layer attenuates by distance. Crouching and walking are near-silent.
      const volume = this.state.crouching ? 0.18 : walking ? 0.4 : 1;
      this.bus.emit('footstep', {
        actorId: this.id,
        pos: { ...this.state.pos },
        material: this.lastMove.groundMaterial as SurfaceMaterial,
        volume,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // damage / death
  // ---------------------------------------------------------------------------

  /** Apply damage that did NOT come from a weapon (fall, bomb, fire). */
  applyDirectDamage(damage: number, group: 'head' | 'chest' | 'stomach' | 'leg' = 'chest'): boolean {
    const killed = this.combat.applyDirectDamage(this.id, this.id, damage, group);
    if (killed) this.reportDeath(-1, '', false);
    return killed;
  }

  /** Called by the game layer when the CombatSystem reports a kill. */
  reportDeath(killerId: number, weaponId: string, headshot: boolean, wallbang = false): void {
    if (this.deathReported) return;
    this.deathReported = true;
    this.state.alive = false;
    this.state.health = 0;
    this.bus.emit('death', {
      victimId: this.id,
      killerId,
      weaponId,
      headshot,
      wallbang,
    });
  }

  /** Respawn / round-start reset. */
  respawn(pos: Vec3, health = 100, armor = 0, helmet = false): void {
    this.state.pos.x = pos.x;
    this.state.pos.y = pos.y;
    this.state.pos.z = pos.z;
    this.state.vel.x = 0;
    this.state.vel.y = 0;
    this.state.vel.z = 0;
    this.state.health = health;
    this.state.armor = armor;
    this.state.helmet = helmet;
    this.state.alive = true;
    this.state.duckAmount = 0;
    this.state.crouching = false;
    this.state.onGround = false;
    this.moveState.pos = this.state.pos;
    this.moveState.vel = this.state.vel;
    this.moveState.onGround = false;
    this.deathReported = false;
    this.scopeTimer = 0;
    this.zoomLevel = 0;
    this.stepAccum = 0;
    this.rig.clearPunch();
    this.rig.setFov(CAMERA.fov, true);
    this.registerCombat();
  }

  // ---------------------------------------------------------------------------
  // render-side
  // ---------------------------------------------------------------------------

  /**
   * Compose the first-person camera from the current state. Called once per
   * rendered frame (never per tick) so bob/sway stay frame-rate independent.
   *
   * @param frameDt render delta in seconds.
   * @param mouseDX raw mouse delta accumulated this frame (already scaled by the
   *                InputSystem for aim; here it only drives sway).
   */
  updateCamera(frameDt: number, mouseDX = 0, mouseDY = 0): void {
    this.rig.update(
      this.state.yaw,
      this.state.pitch,
      this.state.pos,
      this.state.duckAmount,
      this.state.vel,
      this.state.onGround,
      frameDt,
      mouseDX,
      mouseDY,
    );
  }

  /** Distance to another actor, used by the AI and the HUD. */
  distanceTo(otherPos: Vec3): number {
    return distanceXZ(this.state.pos, otherPos);
  }

  /** Effective sprint factor for the HUD/debug. */
  get speedFactor(): number {
    return this.state.speedFactor;
  }

  /** Total rounds left in the magazine of the held weapon. */
  get magazineAmmo(): number {
    const def = this.weapon;
    const st = this.ammo.get(def.id);
    return st ? st.ammo : def.magazine;
  }

  /** Reserve rounds for the held weapon. */
  get reserveAmmo(): number {
    const def = this.weapon;
    const st = this.ammo.get(def.id);
    return st ? st.reserve : def.reserve;
  }

  /** True while the held weapon is mid-reload. */
  get isReloading(): boolean {
    const def = this.weapon;
    const st = this.ammo.get(def.id);
    return !!st && st.reloadTimer > 0;
  }

  /** Money-independent buy-eligibility helper for the HUD. */
  ownsSlotItem(slot: WeaponSlot): boolean {
    return this.weaponIdForSlot(slot) !== null;
  }

  /** Whether the player is inside a buy zone; the game layer answers this. */
  canBuyNow: boolean = true;

  /** Round the player is in; the game layer keeps it in sync. */
  get buyWindowOpen(): boolean {
    return this.canBuyNow;
  }

  /** Remaining freeze time, for UI only. */
  get maxBuyPrice(): number {
    return RULES.maxMoney;
  }

  /** All buyable slots, for menu generation. */
  static get buyableSlots(): readonly WeaponSlot[] {
    return BUYABLE_SLOTS;
  }

  /** Debug: where the last shot was aimed. */
  readonly debug = { lastFiredAt: 0, shotsFired: 0 };
}

/** Minimal empty command reused for dead players (gravity only). */
const EMPTY_CMD: InputCommand = {
  tick: 0,
  buttons: { ...EMPTY_BUTTONS },
  yaw: 0,
  pitch: 0,
  mouseDX: 0,
  mouseDY: 0,
};
