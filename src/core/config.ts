// =============================================================================
// core/config.ts — CS-like constants and movement tuning.
// All movement values are in CS units (1 unit ~= 1.9 cm) and CS seconds.
// =============================================================================

export const TICK_RATE = 128;
export const TICK_DT = 1 / TICK_RATE;
/** Max simulation steps per rendered frame before we drop time (spiral guard). */
export const MAX_CATCHUP_STEPS = 5;

export const UNITS_PER_METER = 52.49; // CS: ~52.49 units per metre

/** Player collision box (half-extents in XZ, full height). */
export const PLAYER = {
  radius: 16,
  standHeight: 72,
  crouchHeight: 54,
  /** Eye offset from the feet. */
  standEye: 64,
  crouchEye: 46,
  /** Step-up height. */
  stepHeight: 18,
  /** Max slope the player can stand on (radians). */
  maxSlope: (46 * Math.PI) / 180,
  /** Distance to peer forward when testing step-up. */
  stepForward: 4,
  /** Pressure applied when two players overlap (units/s). */
  pushSpeed: 40,
} as const;

/**
 * Quake/CS style ground movement.
 * Source engine defaults: sv_accelerate 5.5, sv_friction 5.2, sv_airaccelerate 12,
 * sv_gravity 800, sv_jump_impulse 268 (approx; CS uses ~268.3 for a 56u jump).
 */
export const MOVE = {
  maxSpeed: 250,
  /** Speed cap while walking (shift). */
  walkSpeed: 130,
  /** Duck speed. */
  crouchSpeed: 85,
  /** Modifier applied to the backwards / sideways wishspeed. */
  backSpeedMul: 0.92,
  sideSpeedMul: 0.92,
  /** Ground acceleration. */
  accelerate: 5.5,
  /** Air acceleration. */
  airAccelerate: 12,
  /** Air speed cap applied to the wish direction contribution (the "30 unit" rule). */
  airWishSpeedCap: 30,
  /** Ground friction. */
  friction: 5.2,
  /**
   * Friction stop speed floor.
   * While the player is slower than this, friction is computed as if they were
   * moving at it, so below the floor the speed decays linearly (`stopSpeed *
   * friction * dt` = 3.25 u/s per tick) instead of exponentially. CS:GO uses 80;
   * never raise it to 100 as Source 2013 does: the per-tick friction drop would
   * become `100 * 5.2 * dt` (4.06) and outrun the crouch-walk acceleration
   * `5.5 * 85 * dt` (3.65), pinning a crouching player at ~3.6 u/s forever.
   */
  stopSpeed: 80,
  /** Gravity. */
  gravity: 800,
  /** Jump impulse (units/s upward). */
  jumpImpulse: 268.3,
  /** Bunnyhop: auto-jump while jump is held (auto-hop). */
  autoHop: true,
  /**
   * Friction multiplier for the one grounded tick of a bunny hop (1 = exactly
   * the friction of running). Speed is preserved by the friction/acceleration
   * balance on that tick, not by lowering friction - see `movement.ts`.
   */
  hopFriction: 1.0,
  /** Max horizontal speed ever attainable (safety clamp for airstrafe abuse). */
  hardSpeedCap: 1000,
  /** View height interpolation speed (units/s) for crouch transitions. */
  duckSpeed: 180,
  /** Terminal fall speed. */
  maxFallSpeed: 2000,
} as const;

export const CAMERA = {
  fov: 90,
  near: 1.5,
  far: 12000,
  /** Pitch clamp. */
  maxPitch: (89 * Math.PI) / 180,
  /** Degrees of view rotation per mouse count at sensitivity 1 (CS default ~0.022). */
  baseSensitivity: 0.022,
  /** View punch recovery rate (rad/s). */
  punchDecay: 9.0,
  /** Fraction of the recoil punch applied to the camera (rest goes to bullet). */
  punchToView: 0.72,
  /** Sway follows mouse velocity; larger = slower follow. */
  swaySmooth: 7.5,
  /** Max sway displacement in radians. */
  swayMax: 0.045,
  /**
   * Weapon bob amplitude (units) and step rate at full speed.
   *
   * `bobFreq` is a STEP RATE in cycles per second, not an angular frequency:
   * the rig advances `bobPhase` by `bobFreq * (0.55 + speedNorm)` cycles per
   * second and only then multiplies by 2*PI. At 1.9 a full sprint bobs at
   * ~2.95 Hz and a walk at ~2.0 Hz, which reads as footsteps. (It used to be
   * 9.2, i.e. ~14 Hz: the view itself barely moved - the eye only takes 35% of
   * `bobY` - but the view model 30-80 u from the eye amplified it into a
   * visible shake.)
   */
  bobAmount: 0.62,
  bobFreq: 1.9,
  /** Bob amplitude smoothing (approach rate, 1/s): ramps the bob in and out. */
  bobSmooth: 14,
  /** Landing camera dip: units of vertical offset per (u/s) of landing speed. */
  landingDipPerSpeed: 0.0016,
  landingDipMax: 9,
  landingDipRecover: 9.5,
  /** Melee (knife) swing length in seconds. */
  meleeSwingTime: 0.3,
  /** Camera roll (radians) at the middle of a melee swing. */
  meleeSwingRoll: 0.05,
} as const;

export const COMBAT = {
  /** Damage multiplier applied by armour absorption (CS: 50%). */
  armorAbsorb: 0.5,
  /** Fraction of post-absorption damage that also eats armour value. */
  armorDamageRatio: 0.5,
  /** Max range of any hitscan in units. */
  maxRange: 8192,
  /** Bullet penetration: base damage loss per penetration. */
  penetrationDamageMul: 0.6,
  /** Max wall thickness a bullet may pass (units). */
  penetrationMaxThickness: 20,
  /** Fall damage: damage per (u/s) over the threshold. */
  fallDamagePerSpeed: 0.1,
  /** Landing speeds below this deal no damage. */
  fallDamageThreshold: 580,
  /** Kill awards. */
  defaultKillReward: 300,
} as const;

export const RULES = {
  /** MR12: first to 13 rounds. */
  roundsToWin: 13,
  maxRounds: 24,
  /** Freeze/buy time at round start. */
  freezeTime: 8,
  /** Round length after freeze. */
  roundTime: 115,
  /** Buy time window (from round start, includes freeze). */
  buyTime: 20,
  /** C4 fuse. */
  bombTimer: 40,
  /** Defuse duration with/without kit. */
  defuseTime: 5.0,
  defuseTimeNoKit: 10.0,
  /** Warmup duration before the first round. */
  warmupTime: 20,
  /** Starting money. */
  startMoney: 800,
  maxMoney: 16000,
  /** Round end awards. */
  winReward: 3250,
  winRewardBombPlant: 3500,
  lossRewardBase: 1400,
  lossRewardStep: 500,
  lossRewardMax: 3400,
  bombPlantReward: 300,
  bombPlantTeamReward: 800,
  defuseReward: 300,
  /** Time between rounds. */
  roundEndDelay: 5,
  /** Bots per team for the default single-player setup. */
  botsPerTeam: 4,
} as const;

export const MATCH = {
  playerName: 'PLAYER',
  botNamesT: ['Ivan', 'Boris', 'Yuri', 'Dmitri', 'Sergei', 'Nikolai', 'Viktor', 'Anton'],
  botNamesCT: ['Jones', 'Miller', 'Davis', 'Ward', 'Kelly', 'Reed', 'Simms', 'Hale'],
} as const;

export const PERF = {
  /** Decal pool size. */
  decals: 192,
  casings: 48,
  tracers: 24,
  /** Radar texture resolution. */
  radarSize: 512,
  shadowMapSize: 2048,
  maxPixelRatio: 1.5,
} as const;
