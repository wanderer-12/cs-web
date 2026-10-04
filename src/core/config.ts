// =============================================================================
// core/config.ts — CS-like constants and movement tuning.
// All movement values are in CS units (1 unit ~= 1.9 cm) and CS seconds.
// =============================================================================

import type { WeaponKind } from './types';

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
  /**
   * Hard range cap for melee (knife) in units — about 1.4 m, i.e. arm plus
   * blade.
   *
   * The knife is a hitscan like every other weapon, so without this it traced
   * out to `maxRange` (156 m) and a swing killed a player standing anywhere on
   * the map: the reported "匕首无视攻击距离" bug. The knife's damage falloff
   * cannot express this (its falloff is authored flat at 1.0), so the reach is
   * enforced as a range cap instead — the same mechanism a bullet uses.
   */
  meleeRange: 72,
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

// =============================================================================
// Match modes
// `RULES` above is the classic (MR12, bombs, economy) ruleset. A mode is the
// full set of numbers one *kind* of match runs on, so `Match` reads its clock,
// win target and round phases from the mode instead of the global block. The
// classic entry mirrors RULES field for field, so switching to it cannot change
// how the game plays today.
// =============================================================================

export type MatchModeId = 'classic' | 'duel';

/** Headcount per side, as humans + bots. */
export interface TeamComposition {
  /** Humans on the human player's side, that player included. Always >= 1. */
  ownHumans: number;
  ownBots: number;
  /** Humans on the far side: LAN peers, simulated by the host. */
  enemyHumans: number;
  enemyBots: number;
}

/** One weapon-restricted stage of a match; a duel runs three of them. */
export interface PhaseRule {
  /** Rounds the stage lasts (a final stage absorbs any leftover rounds). */
  rounds: number;
  /** Shown to the player, e.g. 手枪局. */
  label: string;
  /** Weapon kinds the buy menu may offer during the stage (`WEAPONS[id].kind`). */
  buy: readonly WeaponKind[];
  /**
   * Free gun every player on that team starts each round of the stage with, on
   * top of the pistol. `null` means the pistol is the whole loadout.
   */
  starter: { readonly T: string; readonly CT: string } | null;
}

export interface ModeRules {
  id: MatchModeId;
  label: string;
  /** Map this mode is authored for. */
  mapName: string;
  /** Bomb/C4 rules on (classic) or off (duel, which is pure elimination). */
  bomb: boolean;
  roundsToWin: number;
  maxRounds: number;
  /** Swap sides at the halfway point: MR12 does, a duel does not. */
  halfTimeSwap: boolean;
  freezeTime: number;
  roundTime: number;
  /** Buy window, measured from the start of the round (freeze included). */
  buyTime: number;
  warmupTime: number;
  roundEndDelay: number;
  startMoney: number;
  maxMoney: number;
  /** Pistol every player respawns with; the classic team pistols. */
  pistols: { readonly T: string; readonly CT: string };
  /** Default headcount offline; a LAN session overrides it via MatchOptions. */
  solo: TeamComposition;
  phases: readonly PhaseRule[];
}

/** Every weapon kind the buy menu can stock. */
const ALL_WEAPON_KINDS: readonly WeaponKind[] = [
  'pistol',
  'smg',
  'rifle',
  'shotgun',
  'sniper',
  'mg',
];

export const MODES: Record<MatchModeId, ModeRules> = {
  classic: {
    id: 'classic',
    label: '经典模式',
    mapName: 'de_dust2_lite',
    bomb: true,
    roundsToWin: RULES.roundsToWin,
    maxRounds: RULES.maxRounds,
    halfTimeSwap: true,
    freezeTime: RULES.freezeTime,
    roundTime: RULES.roundTime,
    buyTime: RULES.buyTime,
    warmupTime: RULES.warmupTime,
    roundEndDelay: RULES.roundEndDelay,
    startMoney: RULES.startMoney,
    maxMoney: RULES.maxMoney,
    pistols: { T: 'glock', CT: 'usp' },
    solo: {
      ownHumans: 1,
      ownBots: RULES.botsPerTeam,
      enemyHumans: 0,
      // The human side is bots + 1, the far side is that many bots: today's 5v5.
      enemyBots: RULES.botsPerTeam + 1,
    },
    phases: [
      {
        rounds: RULES.maxRounds,
        label: '全枪械',
        buy: ALL_WEAPON_KINDS,
        starter: null,
      },
    ],
  },

  /**
   * Duel: one small arena, no bomb, no economy friction, free guns that escalate
   * per phase, and a first-to-17 race over exactly 8 + 15 + 10 rounds. Offline the
   * lone human faces three bots; on a LAN each side is one human.
   */
  duel: {
    id: 'duel',
    label: '单挑模式',
    mapName: 'aim_duel_lite',
    bomb: false,
    roundsToWin: 17,
    maxRounds: 33,
    halfTimeSwap: false,
    freezeTime: 5,
    roundTime: 90,
    buyTime: 15,
    warmupTime: 10,
    roundEndDelay: 4,
    // Money is never the limiter here; the phase whitelist is.
    startMoney: 16000,
    maxMoney: 16000,
    pistols: { T: 'glock', CT: 'usp' },
    solo: { ownHumans: 1, ownBots: 0, enemyHumans: 0, enemyBots: 3 },
    phases: [
      {
        rounds: 8,
        label: '手枪局',
        buy: ['pistol'],
        starter: null,
      },
      {
        rounds: 15,
        label: '步枪局',
        buy: ['pistol', 'rifle'],
        starter: { T: 'ak47', CT: 'm4a4' },
      },
      {
        rounds: 10,
        label: '狙击局',
        buy: ['pistol', 'sniper'],
        starter: { T: 'awp', CT: 'awp' },
      },
    ],
  },
};

/** A LAN duel puts one human on each side instead of the bots. */
export const LAN_DUEL_TEAMS: TeamComposition = {
  ownHumans: 1,
  ownBots: 0,
  enemyHumans: 1,
  enemyBots: 0,
};

/** Mode by id, defaulting to classic for anything unknown. */
export function modeById(id: string | null | undefined): ModeRules {
  return id === 'duel' ? MODES.duel : MODES.classic;
}

/** 0-based index of the phase a 1-based round number falls in. */
export function phaseIndexForRound(mode: ModeRules, roundNumber: number): number {
  let passed = 0;
  for (let i = 0; i < mode.phases.length; i++) {
    passed += mode.phases[i].rounds;
    if (roundNumber <= passed) return i;
  }
  return mode.phases.length - 1;
}

/** Phase rule for a 1-based round number. */
export function phaseForRound(mode: ModeRules, roundNumber: number): PhaseRule {
  return mode.phases[phaseIndexForRound(mode, roundNumber)];
}

/** May this weapon kind be bought in this phase of this mode? */
export function phaseAllowsKind(
  mode: ModeRules,
  roundNumber: number,
  kind: WeaponKind,
): boolean {
  return phaseForRound(mode, roundNumber).buy.includes(kind);
}

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
