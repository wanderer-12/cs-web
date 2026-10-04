// =============================================================================
// ai/Bot.ts — the pure bot decision core.
//
// A bot is four numbers plus a memory blob. `BotSkill` carries the only knobs the
// design doc exposes (reaction time, aim error, spray control, pre-aim quality);
// everything else — turn rate, fire-discipline tolerance, spray compensation
// strength, retreat thresholds — is derived from those four, so tuning difficulty
// is a four-line change instead of a hunt through hidden constants.
//
// The module is deliberately PURE and STATELESS across ticks: `perceive`,
// `chooseGoal` and `think` receive all of their state through `BotContext` +
// `BotMemory` + `BotSenses`. That is what makes a replay reproducible (same seed,
// same inputs, same commands) and what lets `tests/bot.spec.ts` drive the whole
// decision surface with hand-built actors and a synthetic nav graph.
//
// Contract with the game layer:
//   - `think` is called EXACTLY ONCE per simulation tick (TICK_RATE = 128 Hz).
//   - it writes into the caller's `InputCommand`: `cmd.tick`, `cmd.mouseDX` and
//     `cmd.mouseDY` belong to the caller and are never touched here.
//   - `cmd.buttons` is mutated FIELD BY FIELD, never replaced, because the caller
//     may hold a reference to it (a buffered input queue does).
//   - `cmd.yaw` / `cmd.pitch` are ABSOLUTE view angles. The simulation adds view
//     punch on top of them, which is why recoil compensation is SUBTRACTED from
//     the desired aim rather than added — see `sprayCompensation`.
//
// No DOM, no Three.js, no timers, no `Math.random()`, no `Date.now()`: every
// random draw comes from the injected `Rng` and every timestamp from `ctx.now`.
//
// Allocation: the steady-state per-tick path allocates nothing except when a path
// genuinely has to be rebuilt (a fresh `NavPath` from the graph). All vector
// scratch is module-scope and reused; the only per-tick object literal is the
// two-field spray-compensation result, deliberately kept as a value because it is
// immediately consumed and never retained.
// =============================================================================

import type { ActorState, InputButtons, InputCommand, Team, Vec3, WeaponDef } from '../core/types';
import type { Rng } from '../core/rng';
import type { World } from '../world/world';
import type { NavGraph, PathFollower } from './navigation';

import { CAMERA, PLAYER } from '../core/config';
import { anglesTo, anglesToDir, clamp, copy, deg, distance, set, sub, v3 } from '../core/math';
import { EMPTY_BUTTONS } from '../core/types';
import { computeInaccuracy, damageAtDistance } from '../combat/ballistics';
import { patternAt } from '../combat/recoil';
import { createFollower, followPath, reseatFollower } from './navigation';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Contacts older than this are forgotten (roughly how long a CS radar blip lasts). */
export const CONTACT_MEMORY_SECONDS = 6;
/** A goal cannot change more often than this, unless it stops being valid at all. */
export const GOAL_HYSTERESIS_SECONDS = 2;
/** Aim error is redrawn (from the injected rng) on an interval inside this range. */
export const AIM_ERROR_MIN_PERIOD = 0.2;
export const AIM_ERROR_MAX_PERIOD = 0.5;
/** Two consecutive shots closer together than this belong to one burst. */
export const BURST_GAP_SECONDS = 0.4;
/** Half-angle of the "teammate is in front of me" cone, in radians (~2 degrees). */
const TEAMMATE_CONE = deg(2);
/** Enemies within this distance count as "close" for survival decisions. */
const CLOSE_ENEMY_DISTANCE = 700;
/**
 * A visible enemy closer than this postpones a plant or a defuse.
 *
 * Planting is how T wins a round and defusing is how CT saves one, so an on-site bot
 * takes the objective action even while a firefight is running further out: a carrier
 * that treats every visible enemy as a reason to advance never plants at all, and a
 * round with no plant is a lost round. Only an enemy this close (about 5.7 m, ~1.2 s
 * of walking) can actually reach the bot before its 3.2 s plant finishes.
 */
const PLANT_THREAT_DISTANCE = 300;
/** How close to a node carrying `choke` counts as "approaching a corner". */
const CHOKE_NEAR_DISTANCE = 200;
/** Within this distance of the planted bomb the bot can defuse it. */
const DEFUSE_REACH = 80;
/** A retreat destination closer to the threat than this is useless. */
const RETREAT_MIN_CLEARANCE = 512;
/** Health at or below which the bot breaks contact (absolute HP, CS armour aside). */
const LOW_HEALTH_HP = 30;
/** Aim tolerance is never tighter than this (an "impossible" shot is not taken). */
const MIN_FIRE_TOLERANCE = deg(0.35);
/** Extra tolerance past the chest box: a shot is worth taking just outside it. */
const FIRE_TOLERANCE_SLACK = 1.4;

/** Half-width of the chest hitbox in units (`combat/hitbox.ts` uses `PLAYER.radius`). */
const CHEST_HALF_WIDTH = PLAYER.radius;
/** World height of the standing chest-band centre: 0.4 + (0.88 - 0.4) / 2 = 0.64. */
const CHEST_BAND_CENTRE_FRACTION = 0.64;
/** World height of the standing head-band centre: 0.88 + (1.0 - 0.88) / 2 = 0.94. */
const HEAD_BAND_CENTRE_FRACTION = 0.94;

/** A sane aim must be at least this long before normalising. */
const MIN_AIM_LENGTH = 1e-3;
/** Pitch beyond this (radians) is not somewhere a player would look. */
const SANE_PITCH_LIMIT = deg(80);
/** How far ahead `isSaneAim` probes for geometry. */
const SANE_AIM_PROBE = 48;
/** Two hundred units of waypoint travel is close enough to stop pushing. */
const WAYPOINT_ARRIVE = 40;
/**
 * Arrival radius used for the last few units onto a bomb site.
 *
 * Zero: the carrier walks right onto the site node instead of stopping a radius short
 * of it. The site polygon ends at the nav nodes that carry the site tag, so ANY fixed
 * radius can park the carrier just outside the polygon, where `Match.tryPlant` finds no
 * site under it and silently resets the progress bar — a full round can pass with the
 * carrier standing on the site doing nothing. What actually ends the walk is
 * `senses.insideSite`, the game layer's exact polygon test: it flips the goal to
 * `plant`, and `think` stops the actor for that goal.
 */
const PLANT_ARRIVE = 0;
/** Within this range of the objective site node the carrier walks the tight final leg. */
const PLANT_FINAL_LEG = 320;
/**
 * A choke further than this from what is being defended is not a defence: the map's
 * choke list may simply not cover the attacked site, and holding the nearest choke
 * hundreds of units away leaves the site itself completely open.
 */
const DEFEND_CHOKE_RANGE = 900;
/** Look-ahead hop count for pre-aiming a corner with no contact. */
const PREAIM_HOPS = 3;
/** Peek angles are re-chosen on this interval while holding. */
const PEEK_PERIOD = 1.5;

/**
 * Wall-slide rescue. A bot whose wish direction points almost straight into
 * geometry can only creep along it: the tangential part of the acceleration is
 * (`accel * wishSpeed * dt`) * cos(angle) ~= 1 u/s per tick while friction takes
 * `stopSpeed * friction * dt` ~= 4 u/s per tick, so the slid speed never builds
 * up. (Rotated props are collided as their yaw-expanded AABB, so a 45-degree
 * railing blocks a body-wide box that a point-based path can walk straight
 * through.) Adding a lateral component makes the wish direction oblique, which
 * builds real tangential speed and walks the actor out of the pinch.
 */
/** Horizontal progress under this many units per tick counts as no progress. */
const STUCK_STEP = 0.5;
/** Ticks of zero progress before the rescue fires (~0.2 s at 128 Hz). */
const STUCK_TICKS = 24;
/** How long a rescue sidestep lasts before normal steering resumes. */
const UNSTUCK_TIME = 0.6;
/** Sideways probe distance when picking which way to slide out. */
const UNSTUCK_PROBE = 96;

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

/** The four difficulty knobs from the game design doc. Everything else is derived. */
export interface BotSkill {
  /** Reaction time in seconds before a newly seen enemy is engaged (0.45 easy -> 0.12 expert). */
  reactionTime: number;
  /** Aim error cone half-angle in radians (deg(3) easy -> deg(0.4) expert). */
  aimError: number;
  /** 0 = cannot control recoil at all, 1 = perfect counter-spray. */
  sprayControl: number;
  /** 0 = walks into walls, 1 = peeks angles with correct pre-aim. */
  preaimQuality: number;
}

export type BotDifficulty = 'easy' | 'normal' | 'hard' | 'expert';

/**
 * The four difficulty presets.
 *
 * `reactionTime` and `aimError` are the two knobs a player *feels*; `sprayControl`
 * and `preaimQuality` are the two that decide whether a bot wins fights it should
 * lose. Expert spray control is deliberately below 1: a perfect counter-spray is
 * not a thing humans do and reads as cheating.
 */
export const BOT_SKILLS: Record<BotDifficulty, BotSkill> = {
  easy: { reactionTime: 0.45, aimError: deg(3.0), sprayControl: 0.15, preaimQuality: 0.2 },
  normal: { reactionTime: 0.3, aimError: deg(1.6), sprayControl: 0.4, preaimQuality: 0.45 },
  hard: { reactionTime: 0.2, aimError: deg(0.9), sprayControl: 0.65, preaimQuality: 0.7 },
  expert: { reactionTime: 0.12, aimError: deg(0.4), sprayControl: 0.85, preaimQuality: 0.9 },
};

// ---------------------------------------------------------------------------
// Goals, senses, memory, context
// ---------------------------------------------------------------------------

/** What the bot is currently trying to do. Used by tests and by the HUD for debug text. */
export type BotGoal =
  | 'idle'
  | 'rotate'
  | 'advance'
  | 'hold'
  | 'push'
  | 'plant'
  | 'defuse'
  | 'retreat'
  | 'investigate';

export interface BotSenses {
  /** Enemies the bot can currently SEE (line of sight verified by the caller or by `perceive`). */
  visibleEnemies: ActorState[];
  /** Best known position of the most recent enemy sighting, or null. */
  lastKnownEnemyPos: Vec3 | null;
  /** Seconds since the last sighting. */
  timeSinceSeen: number;
  /** The currently targeted enemy id, -1 when none. */
  targetId: number;
  /** True when the bot is taking fire from an unseen source. */
  underFire: boolean;
  /** Position the bot heard something at (gunfire, footsteps), or null. */
  heardAt: Vec3 | null;
  /** True when the bomb is planted. */
  bombPlanted: boolean;
  /** Where the bomb is (planted or carried by a teammate), or null. */
  bombPos: Vec3 | null;
  /**
   * True when the bot's own feet are inside the polygon of the site it is attacking
   * or defending. The game layer answers this exactly (it owns the site polygons);
   * the nav graph can only say "a site node is nearby", which is not the same test
   * that `tryPlant`/`tryDefuse` apply.
   */
  insideSite: boolean;
}

/** One remembered enemy sighting. */
export interface BotContact {
  /** Position the enemy was last seen at, at that enemy's chest height. */
  pos: Vec3;
  /** `ctx.now` of the most recent sighting. */
  time: number;
  /** Enemy health at the time of the sighting. */
  health: number;
  /** `ctx.now` when this enemy was first seen during the current continuous sighting. */
  firstSeenAt: number;
  /** True when the enemy was visible during the most recent `perceive` tick. */
  visible: boolean;
}

export interface BotMemory {
  /** Per-enemy last-known data, keyed by actor id. */
  contacts: Map<number, BotContact>;
  /** Recent positions the bot has heard something at. */
  sounds: { pos: Vec3; time: number }[];
  /** The bot's own last firing time. */
  lastShotAt: number;
  /** Time the bot last had a visible enemy. */
  lastSeenAt: number;
  /** Consecutive shots fired in the current burst, for the weapon's spray pattern. */
  shotBurstCount: number;
  /** The goal chosen last tick. */
  currentGoal: BotGoal;
  /** Time the current goal was chosen (goal hysteresis). */
  lastGoalChange: number;
  /** Node id the current follower was built for, so a goal change can repath. */
  pathGoalNode: number;
  /** Node id currently used as the retreat destination, -1 when none. */
  retreatNode: number;
  /** Time the retreat destination was computed. */
  retreatComputedAt: number;
  /** Persistent aim-error offset, redrawn every 0.2-0.5 s. */
  aimErrorYaw: number;
  aimErrorPitch: number;
  /** Time the aim error was last redrawn, and when it is due next. */
  aimErrorAt: number;
  aimErrorNextAt: number;
  /** Which of the neighbouring approach angles the bot is currently holding. */
  peekIndex: number;
  /** Time of the last peek-angle switch. */
  peekChangedAt: number;
  /** Time of the most recent processed tick (`ctx.now` of the previous `think`). */
  lastThinkAt: number;
  /** Feet position observed on the previous tick, for progress tracking. */
  lastPosX: number;
  lastPosZ: number;
  /** Consecutive ticks spent travelling without making real progress. */
  stuckTicks: number;
  /** Until this time the bot keeps sidestepping to slide around the obstacle. */
  unstuckUntil: number;
  /** Which way it sidesteps while unsticking; flips on each new snag. */
  unstickSign: number;
}

export interface BotObjective {
  /** Overall task for this round. */
  kind: 'attack' | 'defend' | 'retake' | 'post_plant' | 'hunt';
  /** Where the team is expected to go (a nav node id), or -1. */
  goalNode: number;
  /** Bomb site the objective concerns, or null. */
  site: 'A' | 'B' | null;
}

export interface BotContext {
  self: ActorState;
  /** Every other actor in the match (both teams), for perception and threat checks. */
  actors: readonly ActorState[];
  /** The bot's team. */
  team: Team;
  /** The weapon the bot is holding (determines preferred engagement range). */
  weapon: WeaponDef;
  /** Ammo in the magazine; 0 triggers a reload request. */
  ammo: number;
  /** Rounds left in reserve; 0 with `ammo === 0` means a reload cannot replenish. */
  reserve: number;
  /** True when the bot's magazine is full (a reload would be wasted). */
  magazineFull: boolean;
  /** True while a reload animation is running. */
  reloading: boolean;
  /** True when the bot is allowed to shoot (buy time is over and the round is live). */
  canShoot: boolean;
  /** Current match time in seconds; monotonic. */
  now: number;
  /** The navigation graph for the current map. */
  nav: NavGraph;
  /** Collision world for line-of-sight and aim verification. */
  world: World;
  /** Level geometry/physics queries needed for grenades and peeking are available through `world`. */
  /** This bot's persistent memory (the caller owns it; create with `createBotMemory()`). */
  memory: BotMemory;
  /** This bot's own path following state, or null. The bot sets it. */
  follower: PathFollower | null;
  /** Objective the bot's team is pursuing this round (derived by the game layer). */
  objective: BotObjective;
  /** Bot-authored commands: the bot writes into these. */
  cmd: InputCommand;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** A fresh, empty bot memory. `createBotMemory` is the only supported way to make one. */
export function createBotMemory(): BotMemory {
  return {
    contacts: new Map<number, BotContact>(),
    sounds: [],
    lastShotAt: Number.NEGATIVE_INFINITY,
    lastSeenAt: Number.NEGATIVE_INFINITY,
    shotBurstCount: 0,
    currentGoal: 'idle',
    lastGoalChange: Number.NEGATIVE_INFINITY,
    pathGoalNode: -1,
    retreatNode: -1,
    retreatComputedAt: Number.NEGATIVE_INFINITY,
    aimErrorYaw: 0,
    aimErrorPitch: 0,
    aimErrorAt: Number.NEGATIVE_INFINITY,
    aimErrorNextAt: Number.NEGATIVE_INFINITY,
    peekIndex: 0,
    peekChangedAt: Number.NEGATIVE_INFINITY,
    lastThinkAt: Number.NEGATIVE_INFINITY,
    lastPosX: Number.NaN,
    lastPosZ: Number.NaN,
    stuckTicks: 0,
    unstuckUntil: Number.NEGATIVE_INFINITY,
    unstickSign: 1,
  };
}

/** Reset a memory blob for a new round without allocating a new one. */
export function resetBotMemory(memory: BotMemory): BotMemory {
  memory.contacts.clear();
  memory.sounds.length = 0;
  memory.lastShotAt = Number.NEGATIVE_INFINITY;
  memory.lastSeenAt = Number.NEGATIVE_INFINITY;
  memory.shotBurstCount = 0;
  memory.currentGoal = 'idle';
  memory.lastGoalChange = Number.NEGATIVE_INFINITY;
  memory.pathGoalNode = -1;
  memory.retreatNode = -1;
  memory.retreatComputedAt = Number.NEGATIVE_INFINITY;
  memory.aimErrorYaw = 0;
  memory.aimErrorPitch = 0;
  memory.aimErrorAt = Number.NEGATIVE_INFINITY;
  memory.aimErrorNextAt = Number.NEGATIVE_INFINITY;
  memory.peekIndex = 0;
  memory.peekChangedAt = Number.NEGATIVE_INFINITY;
  memory.lastThinkAt = Number.NEGATIVE_INFINITY;
  memory.lastPosX = Number.NaN;
  memory.lastPosZ = Number.NaN;
  memory.stuckTicks = 0;
  memory.unstuckUntil = Number.NEGATIVE_INFINITY;
  memory.unstickSign = 1;
  return memory;
}

/** Fresh, reusable input command with every button false. */
export function createBotCommand(): InputCommand {
  return { tick: 0, buttons: { ...EMPTY_BUTTONS }, yaw: 0, pitch: 0, mouseDX: 0, mouseDY: 0 };
}

/** A fresh senses record for a newly spawned bot. */
export function createBotSenses(): BotSenses {
  return {
    visibleEnemies: [],
    lastKnownEnemyPos: null,
    timeSinceSeen: Number.POSITIVE_INFINITY,
    targetId: -1,
    underFire: false,
    heardAt: null,
    bombPlanted: false,
    bombPos: null,
    insideSite: false,
  };
}

// ---------------------------------------------------------------------------
// Module scratch — reused every tick, never handed out to callers
// ---------------------------------------------------------------------------

const selfEye = v3();
const otherEye = v3();
const chestPoint = v3();
const headPoint = v3();
const aimPos = v3();
const dirTmp = v3();
const probeTmp = v3();
const waypoint = v3();
const teammateEye = v3();
const threatTmp = v3();
const preAimTmp = v3();
/** Scratch for the wall-slide rescue: ray start and the two sideways directions. */
const unstickOrigin = v3();
const unstickDir = v3();

/** Reusable list of nearby node ids (module scope: peeking must not allocate). */
const nearbyNodes: number[] = [];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Feet-to-eye offset for an actor, honouring `duckAmount` (the player's own blend). */
export function eyeHeight(duckAmount: number): number {
  const duck = clamp(duckAmount, 0, 1);
  return PLAYER.standEye + (PLAYER.crouchEye - PLAYER.standEye) * duck;
}

/** Feet-to-top collision height for an actor, blended by `duckAmount`. */
function actorHeightOf(actor: ActorState): number {
  const duck = clamp(actor.duckAmount, 0, 1);
  return PLAYER.standHeight + (PLAYER.crouchHeight - PLAYER.standHeight) * duck;
}

/** Write `actor`'s eye position (where bullets leave and sight lines start) into `out`. */
function actorEye(out: Vec3, actor: ActorState): Vec3 {
  return set(out, actor.pos.x, actor.pos.y + eyeHeight(actor.duckAmount), actor.pos.z);
}

/** Write `actor`'s chest-hitbox centre into `out`. */
function actorChest(out: Vec3, actor: ActorState): Vec3 {
  return set(out, actor.pos.x, actor.pos.y + actorHeightOf(actor) * CHEST_BAND_CENTRE_FRACTION, actor.pos.z);
}

/** Write `actor`'s head-hitbox centre into `out`. */
function actorHead(out: Vec3, actor: ActorState): Vec3 {
  return set(out, actor.pos.x, actor.pos.y + actorHeightOf(actor) * HEAD_BAND_CENTRE_FRACTION, actor.pos.z);
}

/** The nav node at `id`, or null when the id is out of range (malformed objective). */
function navNodeAt(ctx: BotContext, id: number) {
  if (!Number.isInteger(id) || id < 0 || id >= ctx.nav.nodes.length) return null;
  return ctx.nav.nodes[id] ?? null;
}

/** Finite-or-fallback guard used before anything reaches `cmd.yaw` / `cmd.pitch`. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Angular half-size (radians) of a box of half-width `halfWidth` at `dist` units. */
function angularHalfSize(halfWidth: number, dist: number): number {
  return Math.atan2(halfWidth, Math.max(dist, 1e-3));
}

/** Wrap an angle difference into [-PI, PI]. */
function angleDelta(target: number, current: number): number {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Horizontal speed of an actor (0 when the caller supplied no velocity). */
function horizontalSpeedOf(actor: ActorState): number {
  const v = actor.vel;
  if (!v) return 0;
  const s = Math.hypot(v.x, v.z);
  return Number.isFinite(s) ? s : 0;
}

/** True when the bot is on the ground with a usable motion state. */
function grounded(actor: ActorState): boolean {
  return actor.onGround === true;
}

/** True when the bot is badly hurt and should stop taking fair fights. */
function isLowHealth(ctx: BotContext): boolean {
  return ctx.self.health > 0 && ctx.self.health <= LOW_HEALTH_HP;
}

/** True when the team's bomb is live (planted) according to this bot's senses. */
function bombIsPlanted(senses: BotSenses): boolean {
  return senses.bombPlanted === true;
}

// ---------------------------------------------------------------------------
// Public API: aim / range / spray
// ---------------------------------------------------------------------------

/** Turn a world point into the yaw/pitch the bot should aim with (pre-aim + error). */
export function aimAngles(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const a = anglesTo(from, to);
  return {
    yaw: finiteOr(a.yaw, 0),
    pitch: clamp(finiteOr(a.pitch, 0), -CAMERA.maxPitch, CAMERA.maxPitch),
  };
}

/**
 * Safe wrapper around `anglesToDir`: clamps the pitch into the camera's legal range,
 * replaces non-finite angles with zero, and normalises the result so callers always
 * get a unit vector.
 *
 * `anglesToDir` is a bare trigonometry helper with no bounds checking, so a `NaN`
 * yaw (which is what a broken caller upstream produces) yields a `NaN` direction
 * that then propagates through every subsequent dot product. This is the guard at
 * the boundary, and it is what the aim-sanity and pre-aim paths use.
 */
export function angleToDirSafe(yaw: number, pitch: number): Vec3 {
  const safeYaw = finiteOr(yaw, 0);
  const safePitch = clamp(finiteOr(pitch, 0), -CAMERA.maxPitch, CAMERA.maxPitch);
  anglesToDir(dirTmp, safeYaw, safePitch);
  const len = Math.hypot(dirTmp.x, dirTmp.y, dirTmp.z);
  if (!Number.isFinite(len) || !(len > MIN_AIM_LENGTH)) return { x: 0, y: 0, z: 1 };
  return { x: dirTmp.x / len, y: dirTmp.y / len, z: dirTmp.z / len };
}

/**
 * Counter-spray offset: how much the bot pulls down/left to counter recoil for the
 * current shot index.
 *
 * THE RECOIL CONTRACT (matches `player/player.ts` exactly). Recoil in this game is a
 * pure VIEW effect: when a shot fires, `player.ts` reads `def.pattern.punch[i]` and
 * calls `camRig.addPunch(off.x, off.y)`. The punch is never folded into the actor's
 * true `yaw`/`pitch`, and `BotContext.cmd.yaw`/`cmd.pitch` ARE the true aim that
 * `Player.step` consumes directly. So the rendered view is:
 *
 *     view = trueAim + viewPunch          (viewPunch.x right, viewPunch.y up)
 *
 * A bot that wants its bullets to land where it is looking must therefore move its
 * TRUE aim the other way before the punch lands — exactly what a human does by
 * dragging the mouse down-left through a spray. This function returns that
 * correction as a value to be ADDED to the true aim:
 *
 *     cmd.yaw   = desiredYaw   + sprayCompensation(weapon, shotIndex, skill).yaw
 *     cmd.pitch = desiredPitch + sprayCompensation(weapon, shotIndex, skill).pitch
 *
 * which yields `cmd.yaw + punch.x ≈ desiredYaw` once the camera applies the kick.
 * The same `patternAt` table the player uses is the source of truth; there is no
 * separate bot recoil curve.
 *
 * `sprayControl` 0 returns exactly zero (the bot never fights the climb, so its
 * shots walk up the pattern); 1 returns the full inverse of the pattern.
 *
 * INDEXING — `shotIndex` is 0-based and counts shots ALREADY fired: index 0 asks
 * "I am about to fire my first shot, what should I pre-compensate?" The answer must
 * be zero, because a first shot has nothing to compensate for. Every real pattern
 * in `combat/recoil.ts` has a non-zero punch at index 0 (AK-47 = 0.55° up), so the
 * pattern is sampled at `shotIndex - 1`: the compensation ramps in from the second
 * shot onward, exactly as a player's wrist does.
 */
export function sprayCompensation(
  weapon: WeaponDef,
  shotIndex: number,
  skill: BotSkill,
): { yaw: number; pitch: number } {
  const control = clamp(skill.sprayControl, 0, 1);
  if (!(control > 0)) return { yaw: 0, pitch: 0 };
  const pattern = weapon.pattern;
  if (!pattern) return { yaw: 0, pitch: 0 };
  const fired = Math.floor(Number.isFinite(shotIndex) ? shotIndex : 0);
  if (fired <= 0) return { yaw: 0, pitch: 0 };
  const punch = patternAt(pattern, fired - 1);
  // ADD this to the true aim: it is the inverse of the punch the camera is about to
  // add, so the two cancel.
  return { yaw: -punch.x * control, pitch: -punch.y * control };
}

/**
 * The best engagement distance for the weapon (used to decide push/retreat).
 *
 * Derived from `effectiveRange` rather than a per-weapon table so a new weapon only
 * has to declare its range: snipers hold long angles, shotguns and SMGs want to be
 * inside knife range. Falls back to a rifle-ish 2000 for a missing/zero range.
 */
export function preferredRange(weapon: WeaponDef): number {
  const range = Number.isFinite(weapon.effectiveRange) && weapon.effectiveRange > 0 ? weapon.effectiveRange : 2000;
  const mul =
    weapon.kind === 'sniper'
      ? 0.8
      : weapon.kind === 'shotgun'
        ? 0.35
        : weapon.kind === 'smg'
          ? 0.6
          : weapon.kind === 'pistol'
            ? 0.6
            : weapon.kind === 'mg'
              ? 0.85
              : 0.75;
  return range * mul;
}

// ---------------------------------------------------------------------------
// Public API: perception
// ---------------------------------------------------------------------------

/**
 * Recompute perception from scratch (mutates senses + memory). Call once per think tick.
 *
 * Line of sight is verified from the bot's EYE to each enemy's EYE: a chest-level
 * test would declare a crouching enemy behind a crate invisible while their head is
 * plainly over it. A visible enemy is remembered at CHEST height, because that is
 * where the bot should aim.
 *
 * `targetId` is the most dangerous visible enemy — lowest health first, nearest as
 * the tie-break, actor id as the final tie-break so the pick is deterministic even
 * for two identical enemies. When nothing is visible the id falls back to the
 * freshest contact in memory, so a bot that just lost sight keeps facing the corner
 * instead of forgetting where the enemy went.
 *
 * Contacts older than `CONTACT_MEMORY_SECONDS` are dropped. Teammates are never
 * targets, and neither are dead actors or spectators.
 */
export function perceive(ctx: BotContext, senses: BotSenses, skill: BotSkill, rng: Rng): void {
  void skill;
  void rng;

  const memory = ctx.memory;
  const now = ctx.now;
  actorEye(selfEye, ctx.self);

  senses.visibleEnemies.length = 0;

  let bestEnemy: ActorState | null = null;
  let bestHealth = Number.POSITIVE_INFINITY;
  let bestDist = Number.POSITIVE_INFINITY;
  let bestId = Number.POSITIVE_INFINITY;
  let bestChest: Vec3 | null = null;

  for (let i = 0; i < ctx.actors.length; i++) {
    const other = ctx.actors[i];
    if (other.id === ctx.self.id) continue;
    if (other.team === ctx.team) continue; // a teammate is never a target
    if (other.team === 'SPEC') continue;
    if (!other.alive) continue;

    actorEye(otherEye, other);
    const eyeDist = distance(otherEye, selfEye);

    if (!ctx.world.isVisible(selfEye, otherEye)) {
      const stale = memory.contacts.get(other.id);
      if (stale) stale.visible = false;
      continue;
    }

    senses.visibleEnemies.push(other);

    actorChest(chestPoint, other);
    const visibleDist = Math.max(eyeDist, 1e-3);
    const health = Number.isFinite(other.health) ? other.health : Number.POSITIVE_INFINITY;

    if (
      health < bestHealth ||
      (health === bestHealth && visibleDist < bestDist) ||
      (health === bestHealth && visibleDist === bestDist && other.id < bestId)
    ) {
      bestHealth = health;
      bestDist = visibleDist;
      bestId = other.id;
      bestEnemy = other;
      bestChest = chestPoint;
    }

    const previous = memory.contacts.get(other.id);
    if (previous) {
      previous.pos.x = chestPoint.x;
      previous.pos.y = chestPoint.y;
      previous.pos.z = chestPoint.z;
      previous.time = now;
      previous.health = other.health;
      previous.visible = true;
    } else {
      // First sighting of this enemy: the reaction clock starts now.
      memory.contacts.set(other.id, {
        pos: { x: chestPoint.x, y: chestPoint.y, z: chestPoint.z },
        time: now,
        health: other.health,
        firstSeenAt: now,
        visible: true,
      });
    }
  }

  // --- memory upkeep ---------------------------------------------------------
  const expiry = now - CONTACT_MEMORY_SECONDS;
  for (const [id, contact] of memory.contacts) {
    if (contact.time < expiry) memory.contacts.delete(id);
  }
  if (memory.sounds.length > 8) memory.sounds.splice(0, memory.sounds.length - 8);
  memory.retreatComputedAt = memory.retreatComputedAt; // touched by `retreatTarget`

  // --- target selection ------------------------------------------------------
  if (bestEnemy !== null) {
    senses.targetId = bestEnemy.id;
    senses.lastKnownEnemyPos = bestChest;
    memory.lastSeenAt = now;
  } else {
    let newestId = -1;
    let newestTime = Number.NEGATIVE_INFINITY;
    for (const [id, contact] of memory.contacts) {
      if (contact.time > newestTime || (contact.time === newestTime && id < newestId)) {
        newestTime = contact.time;
        newestId = id;
      }
    }
    const freshest = newestId >= 0 ? memory.contacts.get(newestId) : undefined;
    if (freshest) {
      senses.targetId = newestId;
      senses.lastKnownEnemyPos = freshest.pos;
    } else {
      senses.targetId = -1;
      senses.lastKnownEnemyPos = null;
    }
  }

  senses.timeSinceSeen =
    memory.lastSeenAt === Number.NEGATIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.max(0, now - memory.lastSeenAt);

  // --- sound log -------------------------------------------------------------
  // The caller sets `heardAt`; we keep a short history so a bot walking toward a
  // noise still has something to investigate after the caller clears the field.
  if (senses.heardAt) {
    const h = senses.heardAt;
    const last = memory.sounds.length > 0 ? memory.sounds[memory.sounds.length - 1] : null;
    if (!last || last.time !== now || last.pos.x !== h.x || last.pos.y !== h.y || last.pos.z !== h.z) {
      memory.sounds.push({ pos: { x: h.x, y: h.y, z: h.z }, time: now });
      if (memory.sounds.length > 8) memory.sounds.shift();
    }
  }
}

// ---------------------------------------------------------------------------
// Public API: goal selection
// ---------------------------------------------------------------------------

/** True when `now - mark` is inside the hysteresis window (and the mark is real). */
function withinHysteresis(now: number, mark: number): boolean {
  return Number.isFinite(mark) && now - mark < GOAL_HYSTERESIS_SECONDS;
}

/** True when the objective itself is a place to go (as opposed to a post to hold). */
function objectiveNeedsTravel(ctx: BotContext, senses: BotSenses): boolean {
  switch (objectiveGoal(ctx, senses)) {
    case 'advance':
    case 'defuse':
    case 'push':
      return true;
    default:
      return false;
  }
}

/** The goal the objective alone would produce (the "nothing is happening" branch). */
function objectiveGoal(ctx: BotContext, senses: BotSenses): BotGoal {
  switch (ctx.objective.kind) {
    case 'defend':
      return 'hold';
    case 'post_plant':
      return ctx.team === 'T' ? 'hold' : 'defuse';
    case 'retake':
      return 'push';
    case 'attack':
    case 'hunt':
      return 'advance';
    default:
      return bombIsPlanted(senses) ? 'hold' : 'idle';
  }
}

/** True when the bot is inside a bomb site matching its objective. */
function isOnObjectiveSite(ctx: BotContext, senses: BotSenses): boolean {
  const site = ctx.objective.site;
  if (!site) return false;
  // The exact polygon test from the game layer, not "a site node is within 200 units":
  // the nav heuristic is true for a bot standing just outside the polygon, which made
  // the carrier commit to the plant goal while `tryPlant` saw no site at all.
  return senses.insideSite;
}

/** True when the bot holds the bomb and is standing on the objective site. */
function plantReady(ctx: BotContext, senses: BotSenses): boolean {
  if (!ctx.self.hasBomb) return false;
  if (bombIsPlanted(senses)) return false;
  if (!ctx.objective.site) return false;
  return isOnObjectiveSite(ctx, senses);
}

/** True when the bomb is down, the bot is CT, and it is standing on the bomb. */
function defuseReady(ctx: BotContext, senses: BotSenses): boolean {
  if (!bombIsPlanted(senses)) return false;
  if (ctx.team !== 'CT') return false;
  if (!senses.bombPos) return false;
  return distance(senses.bombPos, ctx.self.pos) <= DEFUSE_REACH;
}

/** Survival check used when nothing is visible: hurt and hunted becomes a retreat. */
function retreatWarranted(ctx: BotContext, senses: BotSenses): boolean {
  if (!isLowHealth(ctx)) return false;
  if (!senses.lastKnownEnemyPos) return false;
  if (senses.timeSinceSeen > CONTACT_MEMORY_SECONDS) return false;
  return distance(senses.lastKnownEnemyPos, ctx.self.pos) <= CLOSE_ENEMY_DISTANCE;
}

/** True when the objective names a goal node the bot is not already pathing to. */
function objectiveMoved(ctx: BotContext): boolean {
  const goalNode = ctx.objective.goalNode;
  if (navNodeAt(ctx, goalNode) === null) return false;
  const memory = ctx.memory;
  return memory.pathGoalNode >= 0 && memory.pathGoalNode !== goalNode;
}

/** Resolve `senses.targetId` back to a visible actor. */
function targetActor(ctx: BotContext, senses: BotSenses): ActorState | null {
  if (senses.targetId < 0) return null;
  for (let i = 0; i < senses.visibleEnemies.length; i++) {
    if (senses.visibleEnemies[i].id === senses.targetId) return senses.visibleEnemies[i];
  }
  return null;
}

/** True once the bot has watched its current target for `skill.reactionTime` seconds. */
function reactionElapsed(ctx: BotContext, senses: BotSenses, skill: BotSkill): boolean {
  if (senses.visibleEnemies.length === 0) return false;
  const contact = senses.targetId >= 0 ? ctx.memory.contacts.get(senses.targetId) : undefined;
  if (!contact || !contact.visible || !Number.isFinite(contact.firstSeenAt)) return false;
  return ctx.now - contact.firstSeenAt >= skill.reactionTime;
}

/** True when the enemy is inside the range the held weapon is good at. */
function inEngageRange(ctx: BotContext, target: ActorState, weapon: WeaponDef): boolean {
  return distance(target.pos, ctx.self.pos) <= preferredRange(weapon) * 1.35;
}

/** Distance to the closest visible enemy, or +Infinity when the bot sees none. */
function nearestVisibleEnemyDistance(ctx: BotContext, senses: BotSenses): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < senses.visibleEnemies.length; i++) {
    const d = distance(senses.visibleEnemies[i].pos, ctx.self.pos);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Choose the goal for this tick from the current senses + objective. Deterministic
 * given the same inputs and rng state.
 *
 * The cascade is a readable priority list, first match wins:
 *   1. objective   — plant when on site with the bomb, defuse when on the bomb; only
 *                    an enemy inside `PLANT_THREAT_DISTANCE` postpones it
 *   2. engage      — a visible enemy; retreat only when hurt AND out of weapon range,
 *                    and keep the objective posture for a distant enemy on defence
 *   3. survive     — a hurt bot that lost sight still runs
 *   4. investigate — a fresh sound, or the objective's goal node moving
 *   5. hold/push   — the objective's resting posture
 *
 * Objective actions outrank the firefight on purpose: a carrier that advances at every
 * visible enemy never plants, and a round without a plant is a lost round for T. Goals
 * never flip faster than `GOAL_HYSTERESIS_SECONDS`, EXCEPT when the current goal stops
 * being valid at all (a bomb that is no longer under the bot's feet, a disarmed
 * objective) — refusing to leave an impossible goal would be worse than a flicker.
 */
export function chooseGoal(ctx: BotContext, senses: BotSenses, skill: BotSkill, rng: Rng): BotGoal {
  void rng;

  const memory = ctx.memory;
  const now = ctx.now;
  const enemyVisible = senses.visibleEnemies.length > 0;
  const reactElapsed = reactionElapsed(ctx, senses, skill);
  const visibleNearest = nearestVisibleEnemyDistance(ctx, senses);
  // An enemy this close can be on top of the bot before a plant or a defuse completes.
  const enemyInFace = visibleNearest <= PLANT_THREAT_DISTANCE;

  let closeEnemy = false;
  if (senses.lastKnownEnemyPos && senses.timeSinceSeen <= CONTACT_MEMORY_SECONDS) {
    closeEnemy = distance(senses.lastKnownEnemyPos, ctx.self.pos) <= CLOSE_ENEMY_DISTANCE;
  }

  let candidate: BotGoal;

  if (!enemyInFace && plantReady(ctx, senses)) {
    candidate = 'plant';
  } else if (!enemyInFace && defuseReady(ctx, senses)) {
    candidate = 'defuse';
  } else if (enemyVisible) {
    // Engage, but a hurt bot that is out of its weapon's comfort zone disengages.
    const target = targetActor(ctx, senses);
    const outOfRange = target ? !inEngageRange(ctx, target, ctx.weapon) : false;
    if (isLowHealth(ctx) && outOfRange && reactElapsed) {
      candidate = 'retreat';
    } else if (objectiveGoal(ctx, senses) === 'hold' && visibleNearest > CLOSE_ENEMY_DISTANCE) {
      // Defending a site is a job: a distant enemy is something to shoot at (the fire
      // logic does that on its own), not a reason to leave the post. Charging it pulled
      // the whole CT team off the site to chase a single visible T across mid.
      candidate = 'hold';
    } else {
      candidate = 'advance';
    }
  } else if (retreatWarranted(ctx, senses)) {
    candidate = 'retreat';
  } else if (isLowHealth(ctx) && closeEnemy) {
    candidate = 'retreat';
  } else if (senses.heardAt !== null && now - memory.lastSeenAt > 1.5 && !objectiveNeedsTravel(ctx, senses)) {
    // An errand outranks a noise. A bot on its way to the site or to the bomb has
    // somewhere to be, and with bots walking around almost every tick produces a
    // footstep, so this branch used to fire for the whole round: measured, a bomb
    // planted on B with four CTs 650 units away, every one of them `goal=investigate`
    // until the fuse burned out, none of them ever walking over to defuse. A defender
    // told to hold a post still investigates — that is what holding is.
    candidate = 'investigate';
  } else if (objectiveMoved(ctx)) {
    candidate = 'rotate';
  } else {
    candidate = objectiveGoal(ctx, senses);
  }

  const previous = memory.currentGoal;
  if (candidate === previous) return previous;
  if (withinHysteresis(now, memory.lastGoalChange) && stillValid(previous, ctx, senses)) return previous;

  memory.currentGoal = candidate;
  memory.lastGoalChange = now;
  return candidate;
}

/** A previous goal that is still meaningful may keep the bot inside the hysteresis window. */
function stillValid(goal: BotGoal, ctx: BotContext, senses: BotSenses): boolean {
  switch (goal) {
    case 'defuse':
      return defuseReady(ctx, senses);
    case 'plant':
      return plantReady(ctx, senses);
    default:
      return true; // advance/hold/retreat are always permissible
  }
}

// ---------------------------------------------------------------------------
// Public API: goal nodes
// ---------------------------------------------------------------------------

/**
 * Pick the navigation unit's next goal node for an objective; -1 when nothing sensible.
 *
 * - `defend` prefers the chokepoints nearest the defended site: that is where a CT
 *   actually wants to be standing, and it is cheap because `chokeNodes` is a scan
 *   over a small node list.
 * - `attack` / `hunt` / `retake` walk the objective node, falling back to the site's
 *   own nodes and finally to the node nearest the bot.
 * - `post_plant` for T holds the plant (which is where the bot already is); for CT
 *   it walks the bomb to retake it.
 *
 * Never returns an out-of-range index: every candidate is validated before it is
 * returned, so a malformed objective degrades to `-1` rather than a crash.
 */
export function pickGoalNode(ctx: BotContext, objective: BotObjective, rng: Rng): number {
  void rng;
  const nav = ctx.nav;
  if (nav.nodes.length === 0) return -1;

  if (objective.kind === 'defend') {
    const choke = bestChokeNearObjective(ctx, objective);
    if (choke >= 0) return choke;
  }

  if (objective.kind === 'defend' && objective.site) {
    const nodes = nav.siteNodes(objective.site);
    const usable: number[] = [];
    for (let i = 0; i < nodes.length; i += 1) {
      const id = nodes[i];
      if (navNodeAt(ctx, id) === null) continue;
      if (nav.isNodeBlocked(id)) continue;
      usable.push(id);
    }
    if (usable.length > 0) {
      // Spread the squad across the site instead of stacking all four defenders on one
      // node. The index comes from the bot id, so it is stable from tick to tick — an
      // unstable choice would rebuild the path (and re-aim) every single tick.
      return usable[Math.abs(ctx.self.id) % usable.length];
    }
  }

  if (navNodeAt(ctx, objective.goalNode) !== null) return objective.goalNode;

  if (objective.site) {
    const nodes = nav.siteNodes(objective.site);
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    const reference = objectiveReference(ctx, objective);
    for (let i = 0; i < nodes.length; i++) {
      const id = nodes[i];
      if (navNodeAt(ctx, id) === null) continue;
      // A post-plant job wants *a* site node, not the nearest one to the bomb: the
      // bomb is already there. Every other kind wants the closest approach.
      const d = objective.kind === 'post_plant' ? 0 : distance(nav.nodes[id].pos, reference);
      if (d < bestDist) {
        bestDist = d;
        best = id;
      }
    }
    if (best >= 0) return best;
  }

  if (objective.kind === 'post_plant') {
    const near = nav.nearestNode(objectiveReference(ctx, objective));
    if (navNodeAt(ctx, near) !== null) return near;
  }

  const fallback = nav.nearestNode(ctx.self.pos);
  return navNodeAt(ctx, fallback) !== null ? fallback : -1;
}

/** Where an objective "is" in world space when it names no usable node. */
function objectiveReference(ctx: BotContext, objective: BotObjective): Vec3 {
  if (objective.kind === 'post_plant' && ctx.objective === objective) return ctx.self.pos;
  if (objective.site) {
    const nodes = ctx.nav.siteNodes(objective.site);
    const node = nodes.length > 0 ? navNodeAt(ctx, nodes[0]) : null;
    if (node) return node.pos;
  }
  return ctx.self.pos;
}

/** Nearest choke node whose world position is closest to what is being defended. */
function bestChokeNearObjective(ctx: BotContext, objective: BotObjective): number {
  const nav = ctx.nav;
  const chokes = nav.chokeNodes();
  if (chokes.length === 0) return -1;

  let anchor: Vec3 | null = null;
  if (objective.site) {
    const site = nav.siteNodes(objective.site);
    const node = site.length > 0 ? navNodeAt(ctx, site[0]) : null;
    if (node) anchor = node.pos;
  }
  if (!anchor) {
    const goal = navNodeAt(ctx, objective.goalNode);
    if (goal) anchor = goal.pos;
  }
  if (!anchor) anchor = ctx.self.pos;

  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < chokes.length; i++) {
    const node = navNodeAt(ctx, chokes[i]);
    if (!node) continue;
    const d = distance(node.pos, anchor);
    if (d < bestDist) {
      bestDist = d;
      best = chokes[i];
    }
  }
  // A choke that far from the objective is not a defence of it. The map's choke list
  // does not necessarily cover every site, and returning the "least distant" choke
  // anyway parked the whole CT squad on mid while the attackers walked onto A.
  return bestDist <= DEFEND_CHOKE_RANGE ? best : -1;
}

// ---------------------------------------------------------------------------
// Public API: aim sanity
// ---------------------------------------------------------------------------

/**
 * Validate a candidate aim direction: is this a sensible place to look for enemies?
 *
 * Rejects non-finite and degenerate vectors, near-vertical stares, and directions
 * buried in solid geometry within ~48 units of the muzzle. The short probe is
 * deliberate: a player DOES check a corridor that is boarded up at the far end, so
 * only geometry immediately in front of the bot disqualifies an angle.
 */
export function isSaneAim(ctx: BotContext, dir: Vec3): boolean {
  if (!dir) return false;
  if (!Number.isFinite(dir.x) || !Number.isFinite(dir.y) || !Number.isFinite(dir.z)) return false;
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (!(len > MIN_AIM_LENGTH)) return false;

  const nx = dir.x / len;
  const ny = dir.y / len;
  const nz = dir.z / len;
  const pitch = Math.asin(clamp(ny, -1, 1));
  if (Math.abs(pitch) > SANE_PITCH_LIMIT) return false;

  actorEye(selfEye, ctx.self);
  set(probeTmp, selfEye.x + nx * SANE_AIM_PROBE, selfEye.y + ny * SANE_AIM_PROBE, selfEye.z + nz * SANE_AIM_PROBE);
  return ctx.world.isVisible(selfEye, probeTmp);
}

// ---------------------------------------------------------------------------
// Public API: the tick
// ---------------------------------------------------------------------------

/**
 * Write movement + aim + fire buttons into `ctx.cmd` for this tick.
 * THE MAIN ENTRY POINT: the game layer calls exactly this once per simulation tick.
 *
 * Stages, in order, each able to short-circuit the ones after it:
 *   1. timing  — `dt` from the previous think, clamped so a stalled frame cannot
 *                teleport the aim.
 *   2. plan    — the goal is (re)chosen and goal-driven state is latched in memory.
 *   3. aim     — steered toward the target (or the pre-aim point) with a capped turn
 *                rate, a slow-wandering error, and recoil pre-compensation.
 *   4. move    — movement buttons from the waypoint, decoupled from the aim when an
 *                enemy is visible: the body faces the enemy, the legs strafe.
 *   5. fire    — `attack` / `reload` only when the shot has actually been earned.
 *
 * Every button is cleared first, so a caller reusing one `InputCommand` never sees a
 * stale press. `cmd.buttons` itself is never replaced.
 */
export function think(ctx: BotContext, senses: BotSenses, skill: BotSkill, rng: Rng): void {
  const cmd = ctx.cmd;
  const buttons = cmd.buttons;
  const now = ctx.now;
  const memory = ctx.memory;

  // --- 1. timing -------------------------------------------------------------
  const last = memory.lastThinkAt;
  const dt = Number.isFinite(last) && now > last ? Math.min(now - last, 0.1) : 0;
  memory.lastThinkAt = now;

  // --- 2. plan ---------------------------------------------------------------
  const goal = chooseGoal(ctx, senses, skill, rng);
  if (memory.shotBurstCount > 0 && now - memory.lastShotAt > BURST_GAP_SECONDS) memory.shotBurstCount = 0;
  updateAimError(ctx, skill, rng, now);

  clearButtons(buttons);

  const self = ctx.self;
  const weapon = ctx.weapon;
  // Short version: a bot may shoot at anything it can see, whatever its goal is.
  // `shouldFire` needs a resolved target, so restricting `target` to the 'advance'
  // goal made every DEFENDING bot unable to fire at all — the defender stood on its
  // angle and let the enemy walk past. Only the two stationary jobs (plant, defuse)
  // suppress engagement, because firing cancels them.
  const canEngage = goal !== 'plant' && goal !== 'defuse' && goal !== 'idle';
  const target = canEngage ? targetActor(ctx, senses) : null;
  const reactElapsed = reactionElapsed(ctx, senses, skill);
  const goalNode = pickGoalNode(ctx, ctx.objective, rng);

  // --- 3. aim ----------------------------------------------------------------
  actorEye(selfEye, self);
  let haveAim = false;

  const headshot =
    target !== null &&
    skill.preaimQuality > 0.7 &&
    distance(target.pos, self.pos) <= Math.max(weapon.effectiveRange, 1) &&
    memory.shotBurstCount === 0;

  if (target && reactElapsed) {
    if (headshot) {
      actorHead(headPoint, target);
      copy(aimPos, headPoint);
    } else {
      actorChest(chestPoint, target);
      copy(aimPos, chestPoint);
    }
    haveAim = true;
  } else if (senses.lastKnownEnemyPos && senses.timeSinceSeen <= CONTACT_MEMORY_SECONDS && goal !== 'idle') {
    copy(aimPos, senses.lastKnownEnemyPos);
    haveAim = true;
  } else if (goal === 'plant') {
    copy(aimPos, plantAimPosition(ctx, senses));
    haveAim = true;
  } else if (goal === 'defuse') {
    copy(aimPos, defuseAimPosition(ctx, senses));
    haveAim = true;
  } else if (goal !== 'idle') {
    const pre = preAimPosition(ctx, goalNode);
    if (pre) {
      copy(aimPos, pre);
      haveAim = true;
    }
  }

  if (!haveAim) {
    const peek = peekPosition(ctx, now);
    if (peek) {
      copy(aimPos, peek);
      haveAim = true;
    }
  }

  let desiredYaw = finiteOr(cmd.yaw, 0);
  let desiredPitch = clamp(finiteOr(cmd.pitch, 0), -CAMERA.maxPitch, CAMERA.maxPitch);

  if (haveAim) {
    const want = aimAngles(selfEye, aimPos);
    desiredYaw = want.yaw;
    desiredPitch = want.pitch;
  }

  // Recoil: recoil is a pure VIEW punch in this game (player.ts calls
  // `camRig.addPunch(punch.x, punch.y)` and never touches the true yaw/pitch), while
  // cmd.yaw/cmd.pitch ARE the true aim. So the bot adds the inverse of the kick it is
  // about to receive, and `trueAim + viewPunch` lands back on the target — the same
  // thing a human does by dragging the mouse down-left through a spray.
  if (memory.shotBurstCount > 0 && now - memory.lastShotAt <= BURST_GAP_SECONDS) {
    // `shotBurstCount` counts shots already fired, so it IS the 0-based index of the
    // shot being pre-compensated here.
    const comp = sprayCompensation(weapon, memory.shotBurstCount, skill);
    desiredYaw += comp.yaw;
    desiredPitch += comp.pitch;
  }

  // Slow-wandering aim error: a persistent offset that survives many ticks.
  desiredYaw += memory.aimErrorYaw;
  desiredPitch += memory.aimErrorPitch;

  const yaw = finiteOr(applyTurnRate(cmd.yaw, desiredYaw, skill, dt), finiteOr(cmd.yaw, 0));
  const pitch = applyTurnRate(cmd.pitch, desiredPitch, skill, dt, true);
  cmd.yaw = finiteOr(yaw, 0);
  cmd.pitch = clamp(finiteOr(pitch, 0), -CAMERA.maxPitch, CAMERA.maxPitch);

  // --- 4. movement -----------------------------------------------------------
  let travelling = false;
  if (goal === 'plant' || goal === 'defuse') {
    // Planting and defusing are stationary jobs: any movement cancels the progress.
    stopMovement(buttons);
    buttons.use = true;
  } else if (goal === 'idle') {
    stopMovement(buttons);
  } else {
    // Every other goal is POSITIONAL, 'hold' included. A hold point is a place on
    // the map, not a stance: a defender must walk to its site/choke and only settle
    // once the waypoint is reached. Treating 'hold' as "stop here" left the whole CT
    // team parked on its spawn for the entire round.
    //
    // The bomb carrier walks the last leg onto its site with a tight radius: the
    // ordinary radius stops it a few units short of the polygon, where the plant
    // silently cannot happen.
    let arrive = WAYPOINT_ARRIVE;
    if (self.hasBomb && !bombIsPlanted(senses) && ctx.objective.site !== null && !senses.insideSite) {
      const siteNode = navNodeAt(ctx, goalNode);
      if (
        siteNode !== null &&
        siteNode.site === ctx.objective.site &&
        distance(siteNode.pos, self.pos) <= PLANT_FINAL_LEG
      ) {
        arrive = PLANT_ARRIVE;
      }
    }
    const point = ensureWaypoint(ctx, goalNode, now, goal, arrive);
    if (point) {
      steerToward(ctx, buttons, point, arrive);
      // `steerToward` stops the actor itself once inside the arrival radius, so read
      // the buttons back instead of assuming the waypoint meant real movement.
      travelling = buttons.forward || buttons.back || buttons.left || buttons.right;
    } else {
      stopMovement(buttons);
    }
  }

  // Rescue a bot that is grinding against geometry. `ctx.self.pos` is the position
  // sampled at the start of this tick, so the delta against the previous tick is the
  // distance actually covered while the previous command was held.
  const progressSq = (self.pos.x - memory.lastPosX) ** 2 + (self.pos.z - memory.lastPosZ) ** 2;
  memory.lastPosX = self.pos.x;
  memory.lastPosZ = self.pos.z;
  // `progressSq` is the ground covered since the previous tick, so `stuckTicks` must count
  // the ticks where it stayed UNDER the step threshold. Inverted here once before, with the
  // spectacular result that a bot grinding against a wall reset its own counter every tick
  // (`stuck=0` forever, mid doorway) while a bot running freely accumulated one and got
  // yanked sideways mid-stride.
  if (!travelling || progressSq >= STUCK_STEP * STUCK_STEP) {
    memory.stuckTicks = 0;
  } else {
    memory.stuckTicks += 1;
  }
  if (memory.stuckTicks >= STUCK_TICKS) {
    memory.stuckTicks = 0;
    memory.unstuckUntil = now + UNSTUCK_TIME;
    memory.unstickSign = pickUnstickSign(ctx);
    // Re-anchor the route to where the bot actually is. A bot that drifted off its
    // lane can end up with a next waypoint behind a wall, and walking straight at it
    // is a trap the side-step alone cannot escape (measured: a T bot pinned on the
    // mid corridor's east wall for the rest of the round, waypoint invisible, 260
    // units away on the far side). Dropping the follower makes `ensureWaypoint` build
    // a fresh path from `nav.nearestNode(self.pos)`.
    ctx.follower = null;
    memory.pathGoalNode = -1;
  }
  if (travelling && now < memory.unstuckUntil) {
    // The side-step is authoritative. Setting only one of the two lateral keys leaves the
    // other one set by `steerToward`, and left+right cancels out to zero lateral input:
    // the bot then pushes straight ahead into the same wall with `forward+left+right` and
    // never moves (measured: three CTs frozen on the B site edge for a whole round).
    buttons.left = memory.unstickSign < 0;
    buttons.right = memory.unstickSign >= 0;
    buttons.walk = false;
  }

  // --- 5. posture and fire ---------------------------------------------------
  const chokeNear = nearbyChoke(ctx, self.pos);
  buttons.walk =
    !(goal === 'hold' || goal === 'idle') &&
    ((chokeNear !== null && goal !== 'push') || (skill.preaimQuality > 0.5 && senses.timeSinceSeen < 2));

  const willFire = shouldFire(ctx, senses, skill, target, reactElapsed, haveAim);
  const rangeToTarget = target ? distance(target.pos, self.pos) : Number.POSITIVE_INFINITY;
  buttons.crouch =
    (willFire && rangeToTarget > 1500) ||
    (goal === 'hold' && !travelling && (chokeNear !== null || self.crouching)) ||
    (chokeNear !== null && skill.preaimQuality > 0.5);

  if (willFire) {
    buttons.attack = true;
    memory.lastShotAt = now;
    memory.shotBurstCount += 1;
  } else if (ctx.ammo <= 0 && ctx.reserve <= 0 && weapon.kind !== 'knife' && weapon.kind !== 'c4') {
    // Completely dry — empty magazine AND empty reserve — so a reload is a no-op and a
    // bot that keeps requesting one stands still until the round ends (observed: the
    // carrier holding the bomb standing on A with `deagle 0/0`, never planting).
    // Fall back to the knife: it cannot win a duel, but the bot can still walk the
    // objective and plant or defuse, which is what actually decides the round.
    buttons.slot3 = true;
  } else if (
    !ctx.reloading &&
    !ctx.magazineFull &&
    weapon.kind !== 'knife' &&
    weapon.kind !== 'c4' &&
    weapon.kind !== 'grenade' &&
    ((ctx.ammo <= 0 && !willFire) ||
      (senses.visibleEnemies.length === 0 && ctx.ammo / Math.max(1, weapon.magazine) < 0.2))
  ) {
    // Reload when dry, or when there is nothing to shoot at and the magazine is
    // getting thin. Never voluntarily reload in the middle of a firefight.
    buttons.reload = true;
  }

  // High-quality bots scope in with snipers while holding a long angle.
  buttons.attack2 = skill.preaimQuality > 0.7 && weapon.kind === 'sniper' && target === null && !willFire;
}

// ---------------------------------------------------------------------------
// think internals
// ---------------------------------------------------------------------------

/** Clear every button in place (the object identity must survive). */
function clearButtons(buttons: InputButtons): void {
  buttons.forward = false;
  buttons.back = false;
  buttons.left = false;
  buttons.right = false;
  buttons.jump = false;
  buttons.crouch = false;
  buttons.walk = false;
  buttons.attack = false;
  buttons.attack2 = false;
  buttons.reload = false;
  buttons.use = false;
  buttons.drop = false;
  buttons.slot1 = false;
  buttons.slot2 = false;
  buttons.slot3 = false;
  buttons.slot4 = false;
  buttons.slot5 = false;
}

/** Stop all translation but keep looking. */
function stopMovement(buttons: InputButtons): void {
  buttons.forward = false;
  buttons.back = false;
  buttons.left = false;
  buttons.right = false;
}

/** Draw a new persistent aim-error offset when its timer expires. */
function updateAimError(ctx: BotContext, skill: BotSkill, rng: Rng, now: number): void {
  const memory = ctx.memory;
  if (now < memory.aimErrorNextAt) return;
  const magnitude = Number.isFinite(skill.aimError) ? Math.max(0, skill.aimError) : 0;
  memory.aimErrorYaw = magnitude > 0 ? (rng.float() * 2 - 1) * magnitude : 0;
  memory.aimErrorPitch = magnitude > 0 ? (rng.float() * 2 - 1) * magnitude * 0.5 : 0;
  memory.aimErrorAt = now;
  memory.aimErrorNextAt = now + rng.range(AIM_ERROR_MIN_PERIOD, AIM_ERROR_MAX_PERIOD);
}

/**
 * Rotate toward `desired` at a capped angular velocity.
 *
 * The cap is what makes a bot legible as a bot: instant snapping reads as an aimbot
 * no matter how large the aim error is. Easy bots turn at roughly 3.4 rad/s (about
 * a slow human wrist), expert bots at 9 rad/s, and a bot that is already aimed
 * leaves the angle alone so the error offset is preserved instead of jittering.
 */
function applyTurnRate(current: number, desired: number, skill: BotSkill, dt: number, isPitch = false): number {
  const cur = finiteOr(isPitch ? clamp(current, -CAMERA.maxPitch, CAMERA.maxPitch) : current, 0);
  const want = finiteOr(desired, cur);
  const maxRate = 3.0 + 6.0 * clamp(skill.preaimQuality, 0, 1) + 1.5 * (1 - clamp(skill.aimError / deg(3), 0, 1));
  const maxDelta = maxRate * Math.max(dt, 0);
  const delta = angleDelta(want, cur);
  if (maxDelta <= 0 || Math.abs(delta) <= maxDelta) return want;
  return cur + Math.sign(delta) * maxDelta;
}

/** Where the bot should look while planting: the bomb spot in front of it. */
function plantAimPosition(ctx: BotContext, senses: BotSenses): Vec3 {
  if (senses.bombPos) return senses.bombPos;
  return ctx.self.pos;
}

/** Where the bot should look while defusing: down at the bomb. */
function defuseAimPosition(ctx: BotContext, senses: BotSenses): Vec3 {
  if (senses.bombPos) return senses.bombPos;
  return ctx.self.pos;
}

/**
 * Pre-aim point: a node a few hops ahead along the current path rather than the
 * corridor centre. Returns null when there is no path to look along, in which case
 * `think` falls back to the peek/objective angles.
 */
function preAimPosition(ctx: BotContext, goalNode: number): Vec3 | null {
  const follow = ctx.follower;
  if (follow) {
    const nodes = follow.path.nodes;
    const idx = Math.min(nodes.length - 1, follow.index + PREAIM_HOPS);
    for (let i = idx; i >= follow.index; i--) {
      const node = navNodeAt(ctx, nodes[i]);
      if (node && distance(node.pos, ctx.self.pos) > 64) {
        return set(preAimTmp, node.pos.x, node.pos.y + PLAYER.standEye, node.pos.z);
      }
    }
  }
  const goal = navNodeAt(ctx, goalNode);
  if (!goal) return null;
  if (distance(goal.pos, ctx.self.pos) < 64) return null;
  return set(preAimTmp, goal.pos.x, goal.pos.y + PLAYER.standEye, goal.pos.z);
}

/**
 * An angle worth holding: alternating between two neighbouring nodes every
 * `PEEK_PERIOD`, which is the cheap stand-in for a player checking both approaches
 * to a choke while holding it.
 */
function peekPosition(ctx: BotContext, now: number): Vec3 | null {
  const memory = ctx.memory;
  if (now - memory.peekChangedAt >= PEEK_PERIOD) {
    memory.peekIndex = (memory.peekIndex + 1) & 1;
    memory.peekChangedAt = now;
  }
  const here = navNodeAt(ctx, ctx.nav.nearestNode(ctx.self.pos));
  if (!here) return null;
  const links = here.links;
  if (links.length === 0) return here.pos;
  const pick = links[memory.peekIndex % links.length];
  const node = navNodeAt(ctx, pick);
  return node ? node.pos : here.pos;
}

/** Nearest node carrying `choke` within `CHOKE_NEAR_DISTANCE`, or null. */
function nearbyChoke(ctx: BotContext, pos: Vec3): Vec3 | null {
  const node = navNodeAt(ctx, ctx.nav.nearestNode(pos, CHOKE_NEAR_DISTANCE));
  return node && node.choke === true ? node.pos : null;
}

/** Choose (and remember) a node far away from the last known enemy. */
function retreatTarget(ctx: BotContext, now: number): number {
  const memory = ctx.memory;
  if (
    memory.retreatNode >= 0 &&
    navNodeAt(ctx, memory.retreatNode) !== null &&
    now - memory.retreatComputedAt < 1.0
  ) {
    return memory.retreatNode;
  }

  const threat = freshestContact(ctx);
  if (threat) copy(threatTmp, threat);
  else set(threatTmp, ctx.self.pos.x, ctx.self.pos.y, ctx.self.pos.z);

  const start = ctx.nav.nearestNode(ctx.self.pos);
  const reachable = start >= 0 ? ctx.nav.reachableFrom(start) : [];
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < reachable.length; i++) {
    const node = navNodeAt(ctx, reachable[i]);
    if (!node) continue;
    const threatDist = distance(node.pos, threatTmp);
    if (threatDist < RETREAT_MIN_CLEARANCE) continue;
    // Prefer far from the threat, then not too far from where the bot already is:
    // running the length of the map to escape one enemy is not a retreat.
    const score = threatDist - distance(node.pos, ctx.self.pos) * 0.25;
    if (score > bestScore) {
      bestScore = score;
      best = reachable[i];
    }
  }
  if (best < 0 && navNodeAt(ctx, start) !== null) best = start;
  memory.retreatNode = best;
  memory.retreatComputedAt = now;
  return best;
}

/** Most recent remembered enemy position, or null. */
function freshestContact(ctx: BotContext): Vec3 | null {
  let best: BotContact | null = null;
  for (const contact of ctx.memory.contacts.values()) {
    if (!best || contact.time > best.time) best = contact;
  }
  return best ? best.pos : null;
}

/**
 * Repath when needed, then advance the follower. Returns the world point to steer
 * at, or null when there is nowhere useful to go.
 *
 * The follower is rebuilt when the goal node changed, and invalidated when the path
 * runs out. A null path from the graph is not fatal: the bot walks straight at the
 * goal node when it is more than `WAYPOINT_ARRIVE` units away, which is what lets a
 * bot recover on a map whose graph is broken.
 */
function ensureWaypoint(
  ctx: BotContext,
  goalNode: number,
  now: number,
  goal: BotGoal,
  arrive = WAYPOINT_ARRIVE,
): Vec3 | null {
  const nav = ctx.nav;
  const memory = ctx.memory;
  if (nav.nodes.length === 0) return null;

  const wanted = goal === 'retreat' ? retreatTarget(ctx, now) : goalNode;
  const valid = navNodeAt(ctx, wanted) !== null;

  if (valid && (ctx.follower === null || memory.pathGoalNode !== wanted)) {
    const start = nav.nearestNode(ctx.self.pos);
    const path = start >= 0 ? nav.findPath(start, wanted, ctx.team) : nav.findPathBetween(ctx.self.pos, nav.nodes[wanted].pos, ctx.team);
    ctx.follower = path.empty ? null : createFollower(path);
    memory.pathGoalNode = path.empty ? -1 : wanted;
  } else if (!valid && ctx.follower === null) {
    memory.pathGoalNode = -1;
  }

  if (ctx.follower) {
    // The path's head is where the follower was built, not where the bot is now: by
    // the time the bot has taken a few steps the head is behind it, and only a
    // re-seat lets `followPath` pop it. Without this the bot parks on the first
    // lookahead point it can see and never advances for the rest of the round.
    reseatFollower(ctx.follower, ctx.self.pos);
    const point = followPath(ctx.follower, ctx.self.pos, ctx.world);
    if (point) {
      copy(waypoint, point);
      return waypoint;
    }
    ctx.follower = null;
    memory.pathGoalNode = -1;
  }

  const goalId = goal === 'retreat' ? memory.retreatNode : goalNode;
  const node = navNodeAt(ctx, goalId);
  if (node && distance(node.pos, ctx.self.pos) > arrive) {
    set(waypoint, node.pos.x, ctx.self.pos.y, node.pos.z);
    return waypoint;
  }
  return null;
}

/**
 * Turn a world point into movement buttons.
 *
 * The body is decoupled from the legs: the bot keeps its yaw wherever the aim
 * controller pointed it and translates in the body frame, which is how a player walks
 * a corner while holding an angle. Every direction is available, `back` included, so a
 * bot whose waypoint is behind it always has a way to get there — see the comment on
 * `buttons.back` below for why that matters.
 */
function steerToward(
  ctx: BotContext,
  buttons: InputButtons,
  point: Vec3,
  arrive = WAYPOINT_ARRIVE,
): void {
  const yaw = finiteOr(ctx.cmd.yaw, 0);
  sub(dirTmp, point, ctx.self.pos);
  dirTmp.y = 0;
  const dist = Math.hypot(dirTmp.x, dirTmp.z);
  if (dist < arrive) {
    stopMovement(buttons);
    return;
  }
  const nx = dirTmp.x / dist;
  const nz = dirTmp.z / dist;

  // Project the waypoint direction onto the body frame. `yawToForward` is
  // (-sin yaw, -cos yaw) and `yawToRight` is (cos yaw, -sin yaw), matching
  // player/movement.ts, so these are the exact wish-direction components.
  const forward = nx * -Math.sin(yaw) + nz * -Math.cos(yaw);
  const right = nx * Math.cos(yaw) + nz * -Math.sin(yaw);

  const dead = 0.2;
  buttons.forward = forward > dead;
  // Backpedal whenever the waypoint is behind — even with an enemy in front. The old
  // `&& !faceTarget` guard made a bot that was holding an angle unable to move at all:
  // with the waypoint dead behind it (forward ≈ -1) and no component clearing the
  // strafe dead zone, it fell through to the diagonal fallback below, pressed a pure
  // sideways input, and orbited its waypoint forever. That is the A-site bomb carrier
  // circling at z=-1084 with the site 47 units to the south and the round never ending.
  buttons.back = forward < -dead;
  buttons.right = right > dead;
  buttons.left = right < -dead;

  if (!buttons.forward && !buttons.back && !buttons.left && !buttons.right) {
    // The waypoint sits almost exactly on the body-frame diagonal, so no component
    // cleared the dead zone. Commit to the dominant axis instead of stalling: any
    // movement beats standing still, which is what stalls the whole round.
    if (forward >= Math.abs(right)) buttons.forward = true;
    else if (right > 0) buttons.right = true;
    else buttons.left = true;
  }
}

/**
 * Which way should a snagged bot sidestep? Probe sideways from the chest and pick
 * the more open side. A tie (or both blocked) still returns a direction: the point
 * of the rescue is to give the wish direction a lateral component, which is what
 * lets the tangential speed beat friction, and the choice flips next time anyway.
 * `yawToRight` is `(cos yaw, -sin yaw)`, matching `steerToward`.
 */
function pickUnstickSign(ctx: BotContext): number {
  const yaw = finiteOr(ctx.cmd.yaw, 0);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  unstickOrigin.x = ctx.self.pos.x;
  unstickOrigin.y = ctx.self.pos.y + eyeHeight(ctx.self.duckAmount);
  unstickOrigin.z = ctx.self.pos.z;

  unstickDir.x = rx;
  unstickDir.y = 0;
  unstickDir.z = rz;
  const rightClear = ctx.world.raycast(unstickOrigin, unstickDir, UNSTUCK_PROBE).distance;

  unstickDir.x = -rx;
  unstickDir.z = -rz;
  const leftClear = ctx.world.raycast(unstickOrigin, unstickDir, UNSTUCK_PROBE).distance;

  if (rightClear > leftClear + 1) return 1;
  if (leftClear > rightClear + 1) return -1;
  return ctx.memory.unstickSign >= 0 ? -1 : 1;
}

/**
 * Fire discipline. A shot is earned only when ALL of these hold:
 *   - an enemy is visible, targeted, and its reaction time has elapsed;
 *   - the round is live (`canShoot`) and there is a round in the magazine;
 *   - the world actually lets a bullet reach the chest from the eye;
 *   - the current angular error is inside the chest box at this distance (plus a
 *     little slack), which is the difference between "shooting at" and "shooting";
 *   - the weapon still does damage at this range;
 *   - no teammate is inside a ~2-degree cone in front (see `teammateInLine`).
 */
function shouldFire(
  ctx: BotContext,
  senses: BotSenses,
  skill: BotSkill,
  target: ActorState | null,
  reactElapsed: boolean,
  haveAim: boolean,
): boolean {
  void skill;
  if (!ctx.canShoot) return false;
  if (!target || !haveAim || !reactElapsed) return false;
  if (senses.visibleEnemies.length === 0) return false;
  if (ctx.ammo <= 0 || ctx.reloading) return false;

  actorEye(selfEye, ctx.self);
  actorChest(chestPoint, target);
  const dist = Math.max(distance(chestPoint, selfEye), 1e-3);

  // Eye-to-eye visibility was checked in `perceive`; this catches a body behind the
  // crate that the head is peeking over.
  if (!ctx.world.isVisible(selfEye, chestPoint)) return false;

  const want = anglesTo(selfEye, chestPoint);
  const chestHalfAngle = angularHalfSize(CHEST_HALF_WIDTH, dist);
  const tolerance = Math.max(MIN_FIRE_TOLERANCE, chestHalfAngle * FIRE_TOLERANCE_SLACK);
  if (Math.abs(angleDelta(want.yaw, ctx.cmd.yaw)) > tolerance) return false;
  if (Math.abs(angleDelta(want.pitch, ctx.cmd.pitch)) > tolerance) return false;

  // The whole cone the bullet may leave in must still overlap the chest: this is
  // what stops a bot spraying a full-auto weapon while sprinting from wasting the
  // burst, and it is why `computeInaccuracy` is used at all down here.
  const spread = computeInaccuracy({
    weapon: ctx.weapon,
    horizontalSpeed: horizontalSpeedOf(ctx.self),
    duckAmount: clamp(ctx.self.duckAmount, 0, 1),
    onGround: grounded(ctx.self),
    shotIndex: Math.max(0, ctx.memory.shotBurstCount),
  });
  if (Number.isFinite(spread) && spread > chestHalfAngle * FIRE_TOLERANCE_SLACK * 1.5) return false;

  if (ctx.weapon.effectiveRange > 0 && dist > ctx.weapon.effectiveRange * 1.6) return false;
  if (damageAtDistance(ctx.weapon, dist) <= 0) return false;

  return !teammateInLine(ctx, target.id, dist);
}

/**
 * True when a living teammate sits inside a ~2-degree cone in front of the bot,
 * closer than the enemy being shot at.
 *
 * This is the single most important safety check in the file: a bot team that fires
 * through its own point man wipes itself, and no amount of aim quality fixes it.
 */
function teammateInLine(ctx: BotContext, targetId: number, targetDist: number): boolean {
  const self = ctx.self;
  actorEye(selfEye, self);
  const yaw = finiteOr(ctx.cmd.yaw, 0);
  const pitch = clamp(finiteOr(ctx.cmd.pitch, 0), -CAMERA.maxPitch, CAMERA.maxPitch);
  const cp = Math.cos(pitch);
  const fx = -Math.sin(yaw) * cp;
  const fy = Math.sin(pitch);
  const fz = -Math.cos(yaw) * cp;
  const cosCone = Math.cos(TEAMMATE_CONE);

  for (let i = 0; i < ctx.actors.length; i++) {
    const other = ctx.actors[i];
    if (other.id === self.id || other.id === targetId) continue;
    if (other.team !== ctx.team || !other.alive) continue;
    actorEye(teammateEye, other);
    const dx = teammateEye.x - selfEye.x;
    const dy = teammateEye.y - selfEye.y;
    const dz = teammateEye.z - selfEye.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) continue; // exactly overlapping: `distance` decides, not a NaN
    if (len >= targetDist) continue; // beyond the enemy: the enemy is hit first
    const dot = clamp((dx * fx + dy * fy + dz * fz) / len, -1, 1);
    if (dot >= cosCone) return true;
  }
  return false;
}

// `nearbyNodes` is reserved for a future triangulation-based peek search; keeping
// the reference here documents that peeking currently uses graph neighbours only.
void nearbyNodes;
